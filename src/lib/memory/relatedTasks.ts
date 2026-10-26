/**
 * Related tasks — browser client for the bridge's workspace index (`/api/memory/workspace-sync`) and stage-1
 * related-task search (`/api/memory/related`), plus the compact prompt / context renderings agents get.
 *
 * Stage 1 (bridge, zero tokens): centered multi-vector retrieval returns ~10 candidates (recall first).
 * Stage 2 (the Summary step's LLM call): picks the genuinely useful ones (`relatedTaskIds`).
 * Both calls fail soft: an offline bridge means "no related tasks", never a failed run.
 */

import { bridgeClient } from '../bridgeClient';
import type {
  RelatedNoteCandidate,
  RelatedTaskCandidate,
  RelatedTasksRequest,
  RelatedTasksResponse,
  WorkspaceSyncRequest,
  WorkspaceSyncResponse,
} from './types';

const PROMPT_CAP = 6_000;
const SELECTED_CAP = 2_000;

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

/** Re-indexes the project's workspace on the bridge (only changed items are embedded). Never throws. */
export async function syncWorkspaceIndex(req: WorkspaceSyncRequest): Promise<WorkspaceSyncResponse> {
  try {
    return await postJson<WorkspaceSyncResponse>('/api/memory/workspace-sync', req);
  } catch (err) {
    console.warn('[RelatedTasks] workspace sync failed:', err instanceof Error ? err.message : err);
    return { success: false, embedded: 0, removed: 0, total: 0 };
  }
}

/** Stage-1 related-task candidates for a task. Never throws (`success: false` and empty lists on failure). */
export async function findRelatedTasks(req: RelatedTasksRequest): Promise<RelatedTasksResponse> {
  try {
    const json = await postJson<RelatedTasksResponse>('/api/memory/related', req);
    return {
      success: true,
      candidates: Array.isArray(json.candidates) ? json.candidates : [],
      notes: Array.isArray(json.notes) ? json.notes : [],
      searched: Number(json.searched) || 0,
      // The project's learned rules (bridge protocol ≥ 5).
      ...(Array.isArray(json.insights) ? { insights: json.insights } : {}),
    };
  } catch (err) {
    console.warn('[RelatedTasks] related search failed:', err instanceof Error ? err.message : err);
    return { success: false, candidates: [], notes: [], searched: 0 };
  }
}

// ─── Rendering ──────────────────────────────────────────────────────────────

/**
 * How the overview call should use the related tasks it selects. Tested on deliberately vague tasks: "never copy
 * their requirements" made the overview, and then the manager, declare the related open work out of scope.
 */
export const RELATED_INTERPRETATION_GUIDANCE =
  'RELATED TASKS: select only the candidates (tasks or notes) that are genuinely useful context for this task. ' +
  'When this task is sparse or vague, it was most likely written as shorthand for work described elsewhere in the project, so use the selected ones to infer what it means: ' +
  'open subtasks of an in-progress task it names are probably its scope; open bug reports in the same area are probably the symptom; ' +
  'done tasks show existing code to reuse; notes and pending tasks give constraints and conflicts (e.g. something that must not be removed yet). ' +
  'Write that inferred scope into what you write, citing the task id. Do not pull in work from tasks in a different area.';

/** One line of at most `max` chars; markdown links keep only their text (`[AGENTS.md](http://AGENTS.md)` → `AGENTS.md`). */
function clip(text: string | undefined, max: number): string {
  const s = String(text ?? '').replace(/\[([^\]]+)\]\([^)\s]*\)/g, '$1').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** Short status label: done / in progress / not started / partly done / archived / note. */
export function relatedStatusLabel(c: Pick<RelatedTaskCandidate, 'status' | 'isDone' | 'source' | 'kind'>): string {
  if (c.kind === 'note') return 'note';
  if (c.isDone || c.status === 'done') return 'done';
  if (c.status) return c.status.replace(/_/g, ' ');
  return c.source === 'archive' ? 'archived' : 'open';
}

/** Appends lines while they fit in `cap` chars; notes how many were left out. */
function joinCapped(lines: string[], cap: number, unit: string): string {
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const add = lines[i].length + (out.length ? 1 : 0);
    if (used + add > cap) {
      const rest = lines.length - i;
      out.push(`…(${rest} more ${unit}${rest === 1 ? '' : 's'} omitted)`);
      break;
    }
    out.push(lines[i]);
    used += add;
  }
  return out.join('\n');
}

/**
 * The candidates the overview call selects from: the related tasks, then the matching freeform notes as `kind: 'note'`
 * entries (their `note:<key>` id as taskId). Selection, saving, reuse and the strict fallback all work on this pool,
 * so a selected note reaches the agents like a selected task.
 */
export function relatedSelectionPool(candidates: RelatedTaskCandidate[], notes: RelatedNoteCandidate[] = []): RelatedTaskCandidate[] {
  return [
    ...(candidates || []),
    ...(notes || []).map((n): RelatedTaskCandidate => ({
      taskId: n.id,
      title: n.title,
      kind: 'note',
      source: 'workspace',
      summaryNote: n.text,
      matchedOn: n.title,
      score: n.score,
      z: n.z,
    })),
  ];
}

/**
 * Compact candidate list for the overview call (stage 2), one line per candidate:
 *   `[<taskId>] <title> (<status>) — subtasks: a; b; c — note: <summary note> — done: <completion summary>`
 * and matching freeform notes as `[note:<key>] Note "<title>": <text>`, selectable like tasks; all lines in z order. Up
 * to 5 subtasks each: a vague task's scope is often a later subtask of the task it points at. Hard cap ~6000 chars
 * (~1500 tokens, read by the tiny overview model); the lowest-ranked candidates are the ones left out. Empty string when there is nothing.
 */
export function formatRelatedCandidatesForPrompt(candidates: RelatedTaskCandidate[], notes: RelatedNoteCandidate[] = []): string {
  const ranked: Array<{ z: number; line: string }> = [];
  for (const c of candidates || []) {
    // Users often write tasks as whole sentences: titles and subtasks are kept nearly whole so the brief can carry them.
    let line = `[${c.taskId}] ${clip(c.title, 160)} (${relatedStatusLabel(c)})`;
    const subs = (c.subtasks || []).slice(0, 5).map((s) => clip(s, 120)).filter(Boolean);
    if (subs.length) line += ` — subtasks: ${subs.join('; ')}`;
    // The part that matched (often one subtask of a broad task) says most about why it's a candidate.
    const matched = clip(c.matchedOn, 160);
    const shown = `${c.title} ${subs.join(' ')}`.toLowerCase();
    if (matched && !shown.includes(matched.toLowerCase().replace(/…$/, ''))) line += ` — matched: ${matched}`;
    // Notes and completion summaries carry the facts the brief needs (paths, findings): kept nearly whole.
    if (c.summaryNote) line += ` — note: ${clip(c.summaryNote, 240)}`;
    if (c.completionSummary) line += ` — done: ${clip(c.completionSummary, 300)}`;
    ranked.push({ z: c.z, line });
  }
  for (const n of notes || []) ranked.push({ z: n.z, line: `[${n.id}] Note "${clip(n.title, 60)}": ${clip(n.text, 200)}` });
  const lines = ranked.sort((a, b) => b.z - a.z).map((r) => r.line);
  return lines.length ? joinCapped(lines, PROMPT_CAP, 'candidate') : '';
}

/**
 * Context block for the agents doing the work: the SELECTED related tasks (status, subtasks, summary note, what was
 * built) and notes from relatedSelectionPool. Cap ~2000 chars. Empty string when nothing is selected.
 */
export function formatSelectedRelatedContext(candidates: RelatedTaskCandidate[], selectedIds: string[]): string {
  const wanted = new Set((selectedIds || []).map(String));
  if (wanted.size === 0) return '';
  const blocks: string[] = [];
  for (const c of candidates || []) {
    if (!wanted.has(String(c.taskId))) continue;
    if (c.kind === 'note') {
      blocks.push(`- Note "${clip(c.title, 80)}": ${clip(c.summaryNote, 400)}`);
      continue;
    }
    const lines = [`- [${c.taskId}] ${clip(c.title, 120)} (${relatedStatusLabel(c)}${c.category ? `, ${clip(c.category, 40)}` : ''})`];
    const subs = (c.subtasks || []).map((s) => clip(s, 100)).filter(Boolean);
    if (subs.length) lines.push(`  Subtasks: ${subs.join('; ')}`);
    if (c.summaryNote) lines.push(`  Note: ${clip(c.summaryNote, 300)}`);
    if (c.completionSummary) lines.push(`  Done: ${clip(c.completionSummary, 300)}`);
    blocks.push(lines.join('\n'));
  }
  return blocks.length ? joinCapped(blocks, SELECTED_CAP, 'related item') : '';
}

/**
 * One-line index of the SELECTED related items (`[#6] Onboarding wizard; Note "Security review"`): what a manager
 * keyed off a working brief gets instead of their full context, which the brief already carries.
 */
export function formatRelatedSourcesLine(candidates: RelatedTaskCandidate[], selectedIds: string[]): string {
  const wanted = new Set((selectedIds || []).map(String));
  return (candidates || [])
    .filter((c) => wanted.has(String(c.taskId)))
    .map((c) => (c.kind === 'note' ? `Note "${clip(c.title, 60)}"` : `[#${c.taskId}] ${clip(c.title, 70)}`))
    .join('; ');
}

// ─── Saved selections ───────────────────────────────────────────────────────

const titleKey = (t: string) => t.replace(/[~*`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** The selection as saved with an overview: ids plus titles (task ids are positional and shift on reorder). */
export function savedRelatedSelection(
  candidates: RelatedTaskCandidate[],
  selectedIds: string[]
): { relatedTaskIds: string[]; relatedTaskTitles: string[] } {
  const byId = new Map(candidates.map((c) => [String(c.taskId), c]));
  const ids = selectedIds.map(String).filter((id) => byId.has(id));
  return { relatedTaskIds: ids, relatedTaskTitles: ids.map((id) => byId.get(id)!.title) };
}

/**
 * Resolves a saved selection against the current candidates, matching by title when titles were saved (so a reordered
 * project still finds the same tasks), else by id. Without current candidates the saved ids are returned as they are.
 * Undefined when nothing was saved.
 */
export function resolveSavedRelatedIds(
  saved: { relatedTaskIds?: string[]; relatedTaskTitles?: string[] } | undefined | null,
  candidates: RelatedTaskCandidate[]
): string[] | undefined {
  if (!saved?.relatedTaskIds) return undefined;
  if (candidates.length === 0) return [...saved.relatedTaskIds];
  if (saved.relatedTaskTitles && saved.relatedTaskTitles.length > 0) {
    const wanted = new Set(saved.relatedTaskTitles.map(titleKey));
    return candidates.filter((c) => wanted.has(titleKey(c.title))).map((c) => String(c.taskId));
  }
  const ids = new Set(saved.relatedTaskIds.map(String));
  return candidates.filter((c) => ids.has(String(c.taskId))).map((c) => String(c.taskId));
}

/** z-score cut-off for the zero-token fallback (chosen on the user's real tasks: precision 0.59 / recall 0.53). */
export const STRICT_RELATED_Z = 2.0;

/**
 * Zero-token selection, used only when the overview call could not choose (it failed, or never answered the
 * RELATED_TASK_IDS question): the candidates that stand out clearly from the rest, at most 4.
 */
export function strictRelatedFallback(candidates: RelatedTaskCandidate[]): string[] {
  return candidates.filter((c) => c.z >= STRICT_RELATED_Z).slice(0, 4).map((c) => String(c.taskId));
}
