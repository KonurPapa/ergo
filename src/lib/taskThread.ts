/**
 * A task's timeline: the run (cycle 0) and each follow-up the user sent after it finished (cycles 1, 2 …).
 *
 *   - brief.thread holds each cycle's start / end time, the user's message (in full) and its outcome.
 *   - Steps carry `cycle`; steps saved before cycles existed are placed by their follow-up marker step.
 *   - Each cycle's completion note is its section of brief.completion (follow-ups are appended after a `---` rule
 *     under a "Follow-up" heading), so the completion log stays one short document the agents can read back.
 */
import type { AgentContextItem, ExecutionStep, RunOutcome, TaskCycle } from '../types';

/** Splits before a `---` rule that is followed by a follow-up heading (## Follow-up N … or **Follow-up (…):**). */
const CYCLE_SPLIT = /\n+---\n+(?=(?:#{1,3}\s+|\*\*)Follow-up\b)/;
const CYCLE_JOIN = '\n\n---\n\n';

/** brief.completion split into one note per cycle (index = cycle). */
export function splitCompletionByCycle(completion: string | undefined): string[] {
  const text = (completion || '').trim();
  if (!text) return [];
  return text.split(CYCLE_SPLIT).map((p) => p.trim());
}

/** The inverse of splitCompletionByCycle (after one cycle's note was edited). */
export function joinCompletionCycles(parts: string[]): string {
  return parts.map((p) => p.trim()).filter(Boolean).join(CYCLE_JOIN);
}

/** The user's message as quoted in a follow-up note or step (`_You: "…"_` / `You: "…"`), for cycles saved without a thread. */
function quotedMessage(text: string | undefined): string | undefined {
  const m = (text || '').match(/_?You: "([\s\S]*?)"_?(?:\n|$)/);
  return m ? m[1].trim() : undefined;
}

/** A cycle's note as shown under its block: the quoted message is dropped (the block shows the message itself). */
export function cycleNoteForDisplay(note: string): string {
  return note.replace(/^_You: "[\s\S]*?"_\s*\n?/m, '').trim();
}

const isFollowUpMarker = (s: ExecutionStep) => s.id.startsWith('step-followup-');

/**
 * The cycle of every step, in order. A step's own `cycle` wins; older steps belong to the latest follow-up marker
 * before them.
 */
export function stepCycles(steps: ExecutionStep[]): number[] {
  let current = 0;
  return steps.map((s) => {
    if (typeof s.cycle === 'number') {
      current = Math.max(current, s.cycle);
      return s.cycle;
    }
    if (isFollowUpMarker(s)) current += 1;
    return current;
  });
}

/** Steps grouped by cycle (index = cycle; a cycle with no steps gets an empty list). */
export function partitionStepsByCycle(steps: ExecutionStep[], cycleCount = 0): ExecutionStep[][] {
  const cycles = stepCycles(steps);
  const max = Math.max(cycleCount - 1, ...cycles, 0);
  const out: ExecutionStep[][] = Array.from({ length: max + 1 }, () => []);
  steps.forEach((s, i) => out[cycles[i]].push(s));
  return out;
}

/**
 * The task's cycles for the timeline: the saved thread, completed with cycles that only show up in the completion
 * log or the steps (saved before threads existed).
 */
export function taskCycles(brief: AgentContextItem | undefined, steps: ExecutionStep[]): TaskCycle[] {
  const saved = brief?.thread || [];
  const notes = splitCompletionByCycle(brief?.completion);
  const byStep = partitionStepsByCycle(steps);
  const hasRun = saved.length > 0 || notes.length > 0 || steps.length > 0;
  if (!hasRun) return [];
  // A saved thread is the record (old notes of an earlier run may still be on the brief while a new run starts);
  // briefs from before threads existed count their follow-up notes.
  const count = brief?.thread ? Math.max(saved.length, byStep.length, 1) : Math.max(notes.length, byStep.length, 1);
  const out: TaskCycle[] = [];
  for (let n = 0; n < count; n++) {
    const own = saved.find((c) => c.n === n);
    if (own) {
      out.push(own);
      continue;
    }
    const marker = byStep[n]?.find(isFollowUpMarker);
    out.push({
      n,
      startedAt: '',
      ...(n > 0 ? { message: quotedMessage(marker?.detail) || quotedMessage(notes[n]) } : {}),
    });
  }
  return out;
}

/** The number the next follow-up gets. */
export function nextCycleNumber(brief: AgentContextItem | undefined, steps: ExecutionStep[]): number {
  return Math.max(1, taskCycles(brief, steps).length);
}

/** The thread with cycle `n` started (cycle 0 starts a new thread: the task was run from the start). */
export function withCycleStarted(
  thread: TaskCycle[] | undefined,
  cycle: { n: number; message?: string; runId?: string; startedAt?: string }
): TaskCycle[] {
  const entry: TaskCycle = {
    n: cycle.n,
    startedAt: cycle.startedAt || new Date().toISOString(),
    ...(cycle.message ? { message: cycle.message } : {}),
    ...(cycle.runId ? { runId: cycle.runId } : {}),
  };
  if (cycle.n === 0) return [entry];
  return [...(thread || []).filter((c) => c.n < cycle.n), entry];
}

/** The thread with cycle `n` finished. Unknown cycles are left alone. */
export function withCycleEnded(thread: TaskCycle[] | undefined, n: number, outcome?: RunOutcome): TaskCycle[] | undefined {
  if (!thread || !thread.some((c) => c.n === n)) return thread;
  const endedAt = new Date().toISOString();
  return thread.map((c) => (c.n === n ? { ...c, endedAt, ...(outcome ? { outcome } : {}) } : c));
}

/** The thread without cycle `n` (a follow-up that could not start). */
export function withCycleRemoved(thread: TaskCycle[] | undefined, n: number): TaskCycle[] | undefined {
  return thread ? thread.filter((c) => c.n !== n) : thread;
}

/** Steps that are new in `next` (not in `prev`) get `cycle` unless they already carry one. */
export function stampNewSteps(prev: ExecutionStep[], next: ExecutionStep[], cycle: number): ExecutionStep[] {
  const known = new Set(prev.map((s) => s.id));
  let changed = false;
  const out = next.map((s) => {
    if (known.has(s.id) || typeof s.cycle === 'number') return s;
    changed = true;
    return { ...s, cycle };
  });
  return changed ? out : next;
}
