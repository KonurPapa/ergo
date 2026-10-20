/**
 * Small background decisions made before a CLI run starts.
 *
 * decideRunShape answers two questions for a task: is it one focused deliverable (single → the manager does it
 * itself, no worker delegation), and does it need the independent QA verifier? CLI runs have no triage call before
 * launch, so this is it. (The in-app pipeline gets the same answers from its Summary call.)
 *
 * Fallback order — a missing local model never makes a run fail:
 *   1. the local model (mode 'local'), via the bridge;
 *   2. the tiny cloud model of the active AI profile (tier-1 of its family), one capped call;
 *   3. deterministic heuristics.
 */
import { type AIProviderConfig, type TaskItem } from '../../types';
import { callAiEngine, parseJsonLoose } from '../llmClient';
import { tinyCloudCallConfig } from '../agentPipeline/modelRouter';
import { inferTaskKind, isExplicitCodeTask } from '../agentPipeline/summary';
import { localShapeDecision, timeoutSignal } from './client';
import { getLocalModelMode } from './preference';

export interface RunShapeDecision {
  /** One focused deliverable: the manager does the work itself (no worker delegation). */
  single: boolean;
  /** Launch the QA verifier after the manager finishes (still subject to the user's QA setting). */
  needsQa: boolean;
  source: 'local' | 'cloud' | 'heuristic';
  /** The cloud model that decided (source 'cloud'; empty when the CLI's default model was used). */
  model?: string;
  /** Wall-clock time the decision took, including any failed earlier attempt. */
  ms: number;
}

export interface DecideRunShapeOptions {
  signal?: AbortSignal;
  /** Cap for the local model attempt (default 5 s). */
  localTimeoutMs?: number;
  /** Cap for the tiny cloud model call (default 8 s). */
  cloudTimeoutMs?: number;
}

const LOCAL_TIMEOUT_MS = 5_000;
const CLOUD_TIMEOUT_MS = 8_000;
const MAX_SUBTASKS = 12;

export const CLOUD_SHAPE_SYSTEM_PROMPT =
  "You triage a task from a software project's to-do list. Decide: single — true if it is one focused deliverable one person finishes in a single pass; false if it has several distinct parts better split up. needs_qa — true only for coding changes that span several parts of a codebase or carry risk (architecture, data migration, security/permissions, new subsystems); false otherwise. Reply with JSON {\"single\": boolean, \"needs_qa\": boolean}.";

type ShapeTask = Pick<TaskItem, 'title'> & { subtasks?: Array<{ text: string }> };

function taskParts(task: ShapeTask): { title: string; subtasks: string[] } {
  const title = (task.title || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  const subtasks = (task.subtasks || [])
    .map((st) => (st?.text || '').replace(/\s+/g, ' ').trim().slice(0, 200))
    .filter(Boolean)
    .slice(0, MAX_SUBTASKS);
  return { title, subtasks };
}

/** User prompt of the cloud call: `Task:\n<title>\nSubtasks:\n- …` (no Subtasks block when there are none). */
export function cloudShapeUserPrompt(task: ShapeTask): string {
  const { title, subtasks } = taskParts(task);
  return `Task:\n${title}${subtasks.length > 0 ? `\nSubtasks:\n${subtasks.map((s) => `- ${s}`).join('\n')}` : ''}`;
}

/** A non-coding kind ('writing' / 'research') when the text clearly isn't a coding task; undefined otherwise. */
export function nonCodingKindHint(text: string): string | undefined {
  if (isExplicitCodeTask(text)) return undefined;
  const kind = inferTaskKind(text);
  return kind === 'writing' || kind === 'research' ? kind : undefined;
}

const FILE_REF = /[\w./-]+\.(?:py|ts|tsx|js|jsx|mjs|cjs|sh|bash|rs|go|c|cpp|h|hpp|rb|php|java|cs|gd|tscn|tres|html|css|scss|json|ya?ml|sql|vue|svelte|md)\b/gi;

/**
 * Deterministic fallback. single: no subtasks, or ≤2 subtasks (≤3 for non-coding work) unless a coding task names
 * several files. needsQa: coding with ≥4 subtasks.
 */
export function heuristicRunShape(task: ShapeTask): { single: boolean; needsQa: boolean } {
  const { title, subtasks } = taskParts(task);
  const text = [title, ...subtasks].join('\n');
  const coding = isExplicitCodeTask(text) || inferTaskKind(text) === 'coding';
  const files = new Set((text.match(FILE_REF) || []).map((f) => f.toLowerCase()));
  const multiFile = files.size >= 2;
  const n = subtasks.length;
  const single = n === 0 || (coding ? n <= 2 && !multiFile : n <= 3);
  return { single, needsQa: coding && n >= 4 };
}

function asBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (t === 'true' || t === 'yes') return true;
    if (t === 'false' || t === 'no') return false;
  }
  return undefined;
}

/** Parses the cloud model's answer; null when it isn't `{ single, needs_qa }`. */
export function parseCloudShape(raw: string): { single: boolean; needsQa: boolean } | null {
  const parsed = parseJsonLoose<any>(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const single = asBool(parsed.single);
  const needsQa = asBool(parsed.needs_qa ?? parsed.needsQa);
  return single === undefined || needsQa === undefined ? null : { single, needsQa };
}

async function cloudRunShape(
  task: ShapeTask,
  aiConfig: AIProviderConfig | undefined,
  timeoutMs: number,
  parent?: AbortSignal
): Promise<{ single: boolean; needsQa: boolean; model: string } | null> {
  const config = tinyCloudCallConfig(aiConfig);
  if (!config) return null;
  const { signal, cancel } = timeoutSignal(timeoutMs, parent);
  try {
    // 'autocomplete' = the light-call profile: its model is the tiny model set above, and the CLI bridge kills a
    // subscription CLI after 12 s (the 8 s abort here also ends it: the bridge stops the process on disconnect).
    const raw = await callAiEngine(cloudShapeUserPrompt(task), CLOUD_SHAPE_SYSTEM_PROMPT, config, 'autocomplete', 'json', signal);
    const shape = parseCloudShape(raw);
    return shape ? { ...shape, model: config.autocompleteModel || config.model || '' } : null;
  } catch (err) {
    if (!parent?.aborted) {
      const reason = (err as any)?.name === 'AbortError' ? `no answer within ${timeoutMs} ms` : err instanceof Error ? err.message : err;
      console.warn('[RunShape] Tiny cloud model call failed, using heuristics:', reason);
    }
    return null;
  } finally {
    cancel();
  }
}

/**
 * Decide the shape of a CLI run: local model (mode 'local') → tiny cloud model → heuristics. Never throws; an
 * aborted signal skips the remaining attempts and returns the heuristic answer.
 */
export async function decideRunShape(
  task: ShapeTask,
  aiConfig: AIProviderConfig | undefined,
  opts: DecideRunShapeOptions = {}
): Promise<RunShapeDecision> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const { title, subtasks } = taskParts(task);
  const kindHint = nonCodingKindHint([title, ...subtasks].join('\n'));

  if (getLocalModelMode() === 'local' && !opts.signal?.aborted) {
    const res = await localShapeDecision(
      { title, subtasks, ...(kindHint ? { kindHint } : {}) },
      { signal: opts.signal, timeoutMs: opts.localTimeoutMs ?? LOCAL_TIMEOUT_MS }
    );
    if (res.success) {
      return { single: res.single, needsQa: kindHint ? false : res.needsQa, source: 'local', ms: elapsed() };
    }
    if (!opts.signal?.aborted) console.info('[RunShape] Local model unavailable, using the tiny cloud model:', res.error);
  }

  if (!opts.signal?.aborted) {
    const cloud = await cloudRunShape(task, aiConfig, opts.cloudTimeoutMs ?? CLOUD_TIMEOUT_MS, opts.signal);
    if (cloud) {
      return { single: cloud.single, needsQa: cloud.needsQa, source: 'cloud', ...(cloud.model ? { model: cloud.model } : {}), ms: elapsed() };
    }
  }

  return { ...heuristicRunShape(task), source: 'heuristic', ms: elapsed() };
}

/** One line for the manager step, e.g. "Run plan: single deliverable · QA verifier skipped — decided locally by Qwen 0.5B (110 ms)". */
export function describeRunShape(
  decision: RunShapeDecision,
  applied: { qaEnabled: boolean; maxWorkers: number }
): string {
  const plan = decision.single
    ? 'single deliverable'
    : applied.maxWorkers >= 2
      ? `several parts · up to ${applied.maxWorkers} workers`
      : 'several parts · worker delegation off in settings';
  const qa = applied.qaEnabled ? 'QA verification on' : 'QA verification off for this task';
  const by =
    decision.source === 'local'
      ? 'decided locally by Qwen 0.5B'
      : decision.source === 'cloud'
        ? `decided by ${decision.model || 'the CLI default model'}`
        : 'decided by heuristics';
  return `Run plan: ${plan} · ${qa} — ${by} (${decision.ms} ms)`;
}
