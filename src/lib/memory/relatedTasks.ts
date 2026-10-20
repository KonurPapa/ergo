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

const PROMPT_CAP = 1800;
const SELECTED_CAP = 1_500;

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
    };
  } catch (err) {
    console.warn('[RelatedTasks] related search failed:', err instanceof Error ? err.message : err);
    return { success: false, candidates: [], notes: [], searched: 0 };
  }
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function clip(text: string | undefined, max: number): string {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** Short status label: done / in progress / not started / partly done / archived. */
export function relatedStatusLabel(c: Pick<RelatedTaskCandidate, 'status' | 'isDone' | 'source'>): string {
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
 * Compact candidate list for the Summary LLM (stage 2), one line per candidate:
 *   `[<taskId>] <title> (<status>) — subtasks: a; b; c — done: <completion summary>`
 * plus matching freeform notes. Hard cap ~1800 chars (~450 tokens): room for all 10 candidates. Empty string when there is nothing.
 */
export function formatRelatedCandidatesForPrompt(candidates: RelatedTaskCandidate[], notes: RelatedNoteCandidate[] = []): string {
  const lines: string[] = [];
  for (const c of candidates || []) {
    let line = `[${c.taskId}] ${clip(c.title, 70)} (${relatedStatusLabel(c)})`;
    // The part that matched (often one subtask of a broad task) says most about why it's a candidate.
    const matched = clip(c.matchedOn, 90);
    if (matched && !c.title.toLowerCase().startsWith(matched.toLowerCase().replace(/…$/, ''))) {
      line += ` — matched: ${matched}`;
    } else {
      const subs = (c.subtasks || []).slice(0, 2).map((s) => clip(s, 45)).filter(Boolean);
      if (subs.length) line += ` — subtasks: ${subs.join('; ')}`;
    }
    if (c.completionSummary) line += ` — done: ${clip(c.completionSummary, 140)}`;
    lines.push(line);
  }
  for (const n of notes || []) lines.push(`[note] ${clip(n.title, 60)}: ${clip(n.text, 160)}`);
  return lines.length ? joinCapped(lines, PROMPT_CAP, 'candidate') : '';
}

/**
 * Context block for the agents doing the work: the SELECTED related tasks with status, subtasks and what was
 * built. Cap ~1500 chars. Empty string when nothing is selected.
 */
export function formatSelectedRelatedContext(candidates: RelatedTaskCandidate[], selectedIds: string[]): string {
  const wanted = new Set((selectedIds || []).map(String));
  if (wanted.size === 0) return '';
  const blocks: string[] = [];
  for (const c of candidates || []) {
    if (!wanted.has(String(c.taskId))) continue;
    const lines = [`- [${c.taskId}] ${clip(c.title, 120)} (${relatedStatusLabel(c)}${c.category ? `, ${clip(c.category, 40)}` : ''})`];
    const subs = (c.subtasks || []).map((s) => clip(s, 100)).filter(Boolean);
    if (subs.length) lines.push(`  Subtasks: ${subs.join('; ')}`);
    if (c.completionSummary) lines.push(`  Done: ${clip(c.completionSummary, 300)}`);
    blocks.push(lines.join('\n'));
  }
  return blocks.length ? joinCapped(blocks, SELECTED_CAP, 'related task') : '';
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
