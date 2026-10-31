/**
 * Learned rules — what the user's feedback on runs teaches Ergo about how they want work done in a project.
 *
 * Write: every message the user sends a run through the prompt box (steeringLog) goes to the small cloud model with the
 * project's current rule list. It answers with changes (add / update / delete / confirm), which the bridge applies to
 * namespace `insights` (memoryStore.applyInsightOps): one call per message, reconciled on write, so the list stays
 * small and current and never needs a clean-up pass. Saving is automatic; the app shows each change with Undo.
 * Read: the related-tasks call returns the task's rules (whole list while small); every run's brief writer, manager,
 * workers and verifier get them as a PROJECT RULES block of a few hundred tokens.
 *
 * Tested against Mem0 (docs/wip/evals/insights): 14/14 rules, 0 stale, 0 noise, ~$0.0005 per message. The local
 * model is not used: it failed comparable judgement tasks (docs/wip/evals). No cloud model → nothing is learned.
 */

import { bridgeClient } from '../bridgeClient';
import { INSIGHTS_PROTOCOL } from '../bridgeProtocol';
import { callAiEngine, parseJsonLoose } from '../llmClient';
import { timeoutSignal } from '../localModel/client';
import { tinyCloudCallConfig } from '../agentPipeline/modelRouter';
import { onSteeringMessage, type SteeringMessage } from '../agentPipeline/steeringLog';
import type { AIProviderConfig } from '../../types';
import type { InsightApplyResponse, InsightChange, InsightOp, InsightSource, ProjectInsight } from './types';

export type { InsightChange, InsightOp, ProjectInsight } from './types';

/** The bridge stores learned rules (protocol 5). */
export function insightsSupported(): boolean {
  return (bridgeClient.getStatus().bridgeInfo?.protocol ?? 0) >= INSIGHTS_PROTOCOL;
}

// ─── Bridge calls ────────────────────────────────────────────────────────────

async function postJson<T>(endpoint: string, body: unknown): Promise<T> {
  const res = await bridgeClient.fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as (T & { success?: boolean; error?: string }) | null;
  if (!res.ok || !json || json.success === false) throw new Error(json?.error || `${endpoint} failed (HTTP ${res.status})`);
  return json;
}

const listeners = new Set<(projectId: string, insights: ProjectInsight[]) => void>();

/** Called with a project's new list after every change (the Learned Rules panel listens). */
export function onInsightsChanged(listener: (projectId: string, insights: ProjectInsight[]) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function listInsights(projectId: string): Promise<ProjectInsight[]> {
  const json = await postJson<{ insights: ProjectInsight[] }>('/api/memory/insights/list', { projectId });
  return Array.isArray(json.insights) ? json.insights : [];
}

export async function applyInsightOps(projectId: string, ops: InsightOp[], source: InsightSource): Promise<InsightApplyResponse> {
  const json = await postJson<InsightApplyResponse>('/api/memory/insights/apply', { projectId, ops, source });
  const result = { success: true, changes: json.changes || [], insights: json.insights || [] };
  for (const l of listeners) {
    try {
      l(projectId, result.insights);
    } catch (err) {
      console.warn('[Ergo rules] listener failed:', err);
    }
  }
  return result;
}

/** Reverts changes (newest first). */
export function undoInsightChanges(projectId: string, changes: InsightChange[]): Promise<InsightApplyResponse> {
  return applyInsightOps(projectId, [...changes].reverse().map((c) => c.undo), { origin: 'user' });
}

// ─── Prompt block ────────────────────────────────────────────────────────────

/**
 * The rules as agents see them. Empty string for none. A run's own protocol and the task's explicit instructions win
 * over a rule (e.g. workers never commit, whatever the project's git rule says).
 */
export function formatProjectRules(insights: ProjectInsight[] | undefined): string {
  const rules = (insights || []).map((r) => r.text.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (rules.length === 0) return '';
  return (
    "PROJECT RULES (the user's standing requirements for this project: set by them, or learned from their feedback on earlier runs). " +
    "Follow them. Where one conflicts with this task's own instructions or with this run's protocol, the task and the protocol win.\n" +
    rules.map((r) => `- ${r}`).join('\n')
  );
}

/** Context-step detail for the rules a run got (empty for none). */
export function describeProjectRules(insights: ProjectInsight[] | undefined): string {
  const n = insights?.length || 0;
  return n > 0 ? `${n} project rule${n === 1 ? '' : 's'} handed to the agents.` : '';
}

// ─── Distilling feedback into rules ──────────────────────────────────────────

/** The prompt tested in docs/wip/evals/insights (ERGO_SYSTEM), with the run context Ergo has. */
export const DISTILL_SYSTEM = `You maintain a short list of durable lessons about how the user wants work done in ONE software project. An AI agent is working on (or just finished) a task and the user sent the message below. Decide whether it reveals a lasting requirement, convention or preference that should change how FUTURE tasks in this project are done.

Save only what still applies to other tasks: tooling and commands, code conventions, architecture rules, where things live, things never to do, workflow rules (verification, git), product rules (locale, copy style).
Do NOT save: one-off changes to this task (colours, wording, chart type, layout of one screen), bug reports about this task, scope additions, approvals, questions, answers to the agent's questions about this task, or what the agent did.

Keep the list small and current. The project's existing lessons are listed with ids:
- The message repeats an existing lesson → {"op":"confirm","id"} (never add it again).
- It refines or extends an existing lesson → {"op":"update","id","text","scope"} with the full new text.
- It makes an existing lesson wrong → update it if part of it still holds, else {"op":"delete","id"}. Also update lessons that mention something the message replaced (an old tool, command or path).
- Something new and durable → {"op":"add","text","scope"}.
Lessons marked (user) were written by the user: change them only when the message clearly contradicts or refines them.
Each lesson: one imperative sentence, specific (names, paths, commands), at most 30 words.
scope: "always" if it applies to nearly every task in this project (package manager, verification steps, git workflow), else "topical".

Reply with one JSON object only: {"ops":[...]} — {"ops":[]} when nothing durable.`;

/** Rules shown to the distiller: the whole list in practice (runs get it whole up to 25). */
const DISTILL_MAX_RULES = 40;
const DISTILL_MESSAGE_CHARS = 2_000;
const DISTILL_SUMMARY_CHARS = 800;
const DISTILL_TIMEOUT_MS = 45_000;

/** Messages with nothing to learn from: skipped without a model call. */
const ACK =
  /^\s*(?:(?:ok(?:ay)?|cool|great|perfect|nice|awesome|thanks?|thank you|ty|lgtm|looks good|good job|well done|yes|yep|no|nope|go ahead|continue|proceed|done)[\s,.!]*)+\s*$/i;

export function isTrivialFeedback(text: string): boolean {
  const t = text.trim();
  return t.length < 4 || ACK.test(t) || /^[\p{Emoji}\s]+$/u.test(t);
}

export interface FeedbackContext {
  projectId: string;
  taskId: string;
  taskTitle: string;
  /** What the agent did (its completion record), when the run has one. */
  summary?: string;
  runId?: string;
  phase: SteeringMessage['phase'];
  message: string;
}

/**
 * The distiller's prompt, and the ids of the rules it shows in order. Rules are labelled R1, R2, … — the model drops
 * parts of long opaque ids (`insight:<project>:…`), and an update it can't map to a rule is lost.
 */
export function buildDistillPrompt(rules: ProjectInsight[], fb: FeedbackContext): { prompt: string; ids: string[] } {
  const shown = rules.slice(0, DISTILL_MAX_RULES);
  const summary = (fb.summary || '').replace(/<!--[\s\S]*?-->/g, '').trim();
  const prompt = [
    `EXISTING LESSONS:\n${shown.length ? shown.map((r, n) => `[R${n + 1}] (${r.scope}${r.origin === 'user' ? ', user' : ''}) ${r.text}`).join('\n') : '(none)'}`,
    `TASK: ${fb.taskTitle}` +
      // Appended logs end with the newest record: keep the tail.
      (summary ? `\nWHAT THE AGENT DID: ${summary.length > DISTILL_SUMMARY_CHARS ? `…${summary.slice(-DISTILL_SUMMARY_CHARS)}` : summary}` : '') +
      `\nWHEN: ${fb.phase === 'post-run' ? 'after the agent finished (a follow-up)' : 'while the agent was working'}`,
    `USER'S MESSAGE:\n${fb.message.trim().slice(0, DISTILL_MESSAGE_CHARS)}`,
  ].join('\n\n');
  return { prompt, ids: shown.map((r) => r.id) };
}

/** The model's answer → ops naming only rules it was shown (`ids` from buildDistillPrompt). Unparseable → none. */
export function parseDistillOps(raw: string, ids: string[]): InsightOp[] {
  // "R3" (also "[R3]", "r3"), or a full id echoed back.
  const resolveId = (ref: unknown): string => {
    const s = typeof ref === 'string' ? ref.trim() : '';
    const m = s.match(/^\[?r(\d+)\]?$/i);
    if (m) return ids[Number(m[1]) - 1] || '';
    return ids.includes(s) ? s : '';
  };
  const parsed = parseJsonLoose<{ ops?: unknown }>(raw) ?? parseJsonLoose<{ ops?: unknown }>(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  const list = Array.isArray(parsed?.ops) ? parsed!.ops : [];
  const ops: InsightOp[] = [];
  for (const o of list as any[]) {
    const scope = o?.scope === 'always' || o?.scope === 'topical' ? o.scope : undefined;
    const id = resolveId(o?.id);
    const text = typeof o?.text === 'string' ? o.text.trim() : '';
    if (o?.op === 'add' && text) ops.push({ op: 'add', text, ...(scope ? { scope } : {}) });
    else if (o?.op === 'update' && id && (text || scope)) ops.push({ op: 'update', id, ...(text ? { text } : {}), ...(scope ? { scope } : {}) });
    else if ((o?.op === 'delete' || o?.op === 'confirm') && id) ops.push({ op: o.op, id });
  }
  return ops;
}

/**
 * One message → rule changes, applied. Null when nothing was learned, nothing could be (no cloud model, old bridge),
 * or something failed (logged; never thrown).
 */
export async function distillFeedback(fb: FeedbackContext, aiConfig: AIProviderConfig | null | undefined): Promise<InsightApplyResponse | null> {
  if (!fb.projectId || isTrivialFeedback(fb.message) || !insightsSupported()) return null;
  const config = tinyCloudCallConfig(aiConfig);
  if (!config) return null;
  const { signal, cancel } = timeoutSignal(DISTILL_TIMEOUT_MS);
  try {
    const rules = await listInsights(fb.projectId);
    const { prompt, ids } = buildDistillPrompt(rules, fb);
    const raw = await callAiEngine(prompt, DISTILL_SYSTEM, config, 'autocomplete', 'json', signal);
    const ops = parseDistillOps(raw, ids);
    if (ops.length === 0) return null;
    const result = await applyInsightOps(fb.projectId, ops, { origin: 'learned', taskId: fb.taskId, taskTitle: fb.taskTitle, ...(fb.runId ? { runId: fb.runId } : {}) });
    return result.changes.length > 0 ? result : null;
  } catch (err) {
    console.warn('[Ergo rules] Learning from feedback failed:', err instanceof Error ? err.message : err);
    return null;
  } finally {
    cancel();
  }
}

/**
 * Start learning from prompt-box messages (App calls this once). `resolve` gives the message's project, task title
 * and the run's completion record (null: skip, e.g. the task is gone). `onLearned` gets each applied set of changes
 * (App shows it with Undo). Messages of one project are distilled one at a time, so each sees the last one's result.
 * Returns an unsubscribe function.
 */
export function startInsightCapture(opts: {
  getAiConfig: () => AIProviderConfig | null | undefined;
  resolve: (message: SteeringMessage) => Omit<FeedbackContext, 'message' | 'phase' | 'taskId' | 'runId'> | null;
  onLearned: (projectId: string, result: InsightApplyResponse, message: SteeringMessage) => void;
}): () => void {
  const queues = new Map<string, Promise<void>>();
  return onSteeringMessage((message) => {
    if (isTrivialFeedback(message.text)) return;
    const ctx = opts.resolve(message);
    if (!ctx?.projectId) return;
    const fb: FeedbackContext = { ...ctx, taskId: message.taskId, runId: message.runId, phase: message.phase, message: message.text };
    const prev = queues.get(ctx.projectId) ?? Promise.resolve();
    const next = prev.then(async () => {
      const result = await distillFeedback(fb, opts.getAiConfig());
      if (!result) return;
      console.log(`[Ergo rules] Learned from "${message.text.slice(0, 80)}": ${result.changes.map((c) => `${c.kind} "${c.insight.text}"`).join('; ')}`);
      opts.onLearned(ctx.projectId, result, message);
    });
    const settled = next.catch(() => {});
    queues.set(ctx.projectId, settled);
    void settled.then(() => {
      if (queues.get(ctx.projectId) === settled) queues.delete(ctx.projectId);
    });
  });
}
