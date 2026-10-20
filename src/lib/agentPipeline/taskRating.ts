/**
 * Task rating for Auto model selection: what kind of task it is and how complex / reasoning-heavy it is (1–5).
 *
 * Normally rated for free inside the overview call (the `TASK_RATING:` line of syncTaskOverviewWithAi, or the
 * Summary step's `taskRating` JSON field) and saved on the brief's overviewDocument, so reruns reuse it. When an
 * overview has no rating (saved before this existed, written by the user, or the model skipped the line), rateTask
 * asks the tiny cloud model once (8 s cap), falling back to heuristics. Never throws.
 */
import type { AIProviderConfig, TaskItem, TaskKind, TaskRating, TaskRatingScore } from '../../types';
import { callAiEngine, parseJsonLoose } from '../llmClient';
import { tinyCloudCallConfig } from './modelRouter';
import { inferTaskKind, isExplicitCodeTask } from './summary';
import { timeoutSignal } from '../localModel/client';

import { TASK_RATING_SCALES } from './autoRouter';

export { describeTaskRating, TASK_RATING_SCALES } from './autoRouter';

const TASK_KINDS: TaskKind[] = ['coding', 'writing', 'research', 'ops', 'data', 'other'];
const RATE_TIMEOUT_MS = 8_000;

function asScore(v: unknown): TaskRatingScore | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim().replace(/\s*\/\s*5$/, '')) : NaN;
  if (!Number.isFinite(n)) return undefined;
  const r = Math.round(n);
  return r >= 1 && r <= 5 && Math.abs(n - r) < 0.01 ? (r as TaskRatingScore) : undefined;
}

function asKind(v: unknown): TaskKind | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim().toLowerCase();
  if (t === 'code') return 'coding';
  return TASK_KINDS.includes(t as TaskKind) ? (t as TaskKind) : undefined;
}

/**
 * A rating from loose model output (`{ kind, complexity, reasoning }`). Undefined unless both scores are integers
 * 1–5; a missing or unknown kind becomes `fallbackKind` (default 'other').
 */
export function normalizeTaskRating(
  raw: unknown,
  source: TaskRating['source'],
  fallbackKind: TaskKind = 'other'
): TaskRating | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const complexity = asScore(o.complexity);
  const reasoning = asScore(o.reasoning);
  if (!complexity || !reasoning) return undefined;
  return { kind: asKind(o.kind) ?? fallbackKind, complexity, reasoning, source };
}

const RATING_LINE_RE = /^[ \t>*_`-]*TASK[_ ]RATING[*_`]*[ \t]*:[*_`]*[ \t]*(.*)$\n?/gim;

/**
 * Splits the overview model's `TASK_RATING: kind=coding; complexity=3; reasoning=4` line off its answer (every such
 * line is removed, the last one wins; code fences left empty by the removal go too). `rating` is undefined when the
 * line is missing or invalid.
 */
export function extractTaskRatingLine(text: string): { text: string; rating?: TaskRating; found: boolean } {
  let lastValue: string | null = null;
  const source = String(text ?? '');
  const stripped = source.replace(RATING_LINE_RE, (_line, value: string) => {
    lastValue = value;
    return '';
  });
  if (lastValue === null) return { text: source.trim(), found: false };
  const fields: Record<string, string> = {};
  for (const part of (lastValue as string).split(/[;,|]/)) {
    const m = part.match(/^\s*[*_`]*([a-z_]+)[*_`]*\s*[=:]\s*[*_`]*([^*_`]*?)[*_`]*\s*$/i);
    if (m) fields[m[1].toLowerCase()] = m[2].trim();
  }
  const rating = normalizeTaskRating(fields, 'overview');
  const cleaned = stripped
    .replace(/```[\w-]*[ \t]*\n\s*```/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: cleaned, ...(rating ? { rating } : {}), found: true };
}

// ─── Heuristic ───────────────────────────────────────────────────────────────

type RatableTask = Pick<TaskItem, 'title'> & { category?: string; subtasks?: Array<{ text: string }> };

const FILE_REF = /[\w./-]+\.(?:py|ts|tsx|js|jsx|mjs|cjs|sh|bash|rs|go|c|cpp|h|hpp|rb|php|java|cs|gd|tscn|tres|html|css|scss|json|ya?ml|sql|vue|svelte|md)\b/gi;
const BIG_SCOPE_RE = /\b(architect\w*|refactor\w*|migrat\w*|redesign\w*|overhaul\w*|rewrite|re-?implement\w*|integrat\w*|subsystem|framework|end[- ]to[- ]end|multi[- ]?(?:step|part|file|service))\b/i;
const HARD_REASONING_RE = /\b(debug\w*|race condition|concurren\w*|deadlock|leak\w*|performance|optimi[sz]\w*|security|vulnerab\w*|algorithm\w*|design\w*|architect\w*|investigat\w*|root cause|flaky|intermittent)\b/i;
const MECHANICAL_RE = /\b(rename|typo|spelling|reword|copy ?edit|format\w*|bump|update (?:the )?(?:text|copy|version|readme)|move|delete|remove|add (?:a )?(?:comment|link|label))\b/i;

/** Deterministic rating from subtask count, title length and keywords. */
export function heuristicTaskRating(task: RatableTask): TaskRating {
  const title = (task.title || '').replace(/\s+/g, ' ').trim();
  const subtasks = (task.subtasks || []).map((s) => (s?.text || '').trim()).filter(Boolean);
  const text = [task.category || '', title, ...subtasks].join('\n');
  const kind: TaskKind = isExplicitCodeTask(text) ? 'coding' : inferTaskKind(text);
  const n = subtasks.length;
  let complexity = n === 0 ? (title.length > 80 ? 2 : 1) : n <= 2 ? 2 : n <= 5 ? 3 : n <= 9 ? 4 : 5;
  const files = new Set((text.match(FILE_REF) || []).map((f) => f.toLowerCase()));
  if (BIG_SCOPE_RE.test(text) || files.size >= 3) complexity += 1;
  let reasoning = 2;
  if (HARD_REASONING_RE.test(text)) reasoning += 2;
  if (complexity >= 4) reasoning += 1;
  if (MECHANICAL_RE.test(title) && !HARD_REASONING_RE.test(text)) {
    complexity -= 1;
    reasoning -= 1;
  }
  const clamp = (v: number) => Math.max(1, Math.min(5, v)) as TaskRatingScore;
  return { kind, complexity: clamp(complexity), reasoning: clamp(reasoning), source: 'heuristic' };
}

// ─── Tiny model ──────────────────────────────────────────────────────────────

export const RATE_TASK_SYSTEM_PROMPT =
  'You rate a task from a project to-do list so Ergo can pick AI models for it. ' +
  `Reply with JSON {"kind": "coding" | "writing" | "research" | "ops" | "data" | "other", "complexity": 1-5, "reasoning": 1-5}. ${TASK_RATING_SCALES}`;

export function rateTaskUserPrompt(task: RatableTask, overview?: string): string {
  const subtasks = (task.subtasks || []).map((s) => (s?.text || '').replace(/\s+/g, ' ').trim().slice(0, 200)).filter(Boolean).slice(0, 12);
  const brief = (overview || '').trim().slice(0, 1500);
  return (
    `Task:\n${(task.title || '').slice(0, 400)}` +
    (subtasks.length > 0 ? `\nSubtasks:\n${subtasks.map((s) => `- ${s}`).join('\n')}` : '') +
    (brief ? `\nOverview:\n${brief}` : '')
  );
}

/**
 * Rates a task with one tiny-model JSON call (8 s cap), else heuristically. `overview` (optional) gives the model
 * more to go on. Never throws; an aborted signal returns the heuristic rating.
 */
export async function rateTask(
  task: RatableTask,
  aiConfig: AIProviderConfig | undefined | null,
  opts: { signal?: AbortSignal; overview?: string; timeoutMs?: number } = {}
): Promise<TaskRating> {
  const fallback = heuristicTaskRating(task);
  const config = tinyCloudCallConfig(aiConfig);
  if (!config || opts.signal?.aborted) return fallback;
  const timeoutMs = opts.timeoutMs ?? RATE_TIMEOUT_MS;
  const { signal, cancel } = timeoutSignal(timeoutMs, opts.signal);
  try {
    // 'autocomplete' = the light-call profile (its model is the tiny model tinyCloudCallConfig set).
    const raw = await callAiEngine(rateTaskUserPrompt(task, opts.overview), RATE_TASK_SYSTEM_PROMPT, config, 'autocomplete', 'json', signal);
    return normalizeTaskRating(parseJsonLoose(raw), 'tiny', fallback.kind) ?? fallback;
  } catch (err) {
    if (!opts.signal?.aborted) {
      const reason = (err as any)?.name === 'AbortError' ? `no answer within ${timeoutMs} ms` : err instanceof Error ? err.message : err;
      console.warn('[Task rating] Tiny model call failed, using heuristics:', reason);
    }
    return fallback;
  } finally {
    cancel();
  }
}
