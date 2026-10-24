/**
 * Memory pre-fetched for a prompt: the overview call (prior knowledge the working brief folds in) and the worker /
 * QA agents' launch prompts. Fail-soft: a failed, slow (> 1.5 s) or unscoped search yields no hits and never blocks.
 * Agent searches never include the live workspace index (related tasks cover that); they find earlier runs' notes
 * and completed or archived tasks.
 */
import type { TaskItem } from '../../types';
import { searchMemory, type SearchResult } from './vectorEngine';

const MEMORY_PREFETCH_TIMEOUT_MS = 1500;
const MEMORY_PREFETCH_QUERY_CHARS = 1500;

export interface PromptMemoryHit {
  /** Document id (works with memory_get). */
  id: string;
  label: string;
  text: string;
}

/** The memory query for a task: its title, subtasks and summary note. */
export function taskMemoryQuery(task: Pick<TaskItem, 'title' | 'subtasks' | 'summaryNote'>): string {
  return [task.title, ...(task.subtasks || []).map((s) => s.text), task.summaryNote || ''].filter(Boolean).join('\n');
}

/** Search hits → prompt entries (one per document). */
function toPromptMemoryHits(results: SearchResult[]): PromptMemoryHit[] {
  const seen = new Set<string>();
  const hits: PromptMemoryHit[] = [];
  for (const { chunk } of results) {
    const meta = chunk.metadata || {};
    const id = meta.docId || chunk.id;
    if (seen.has(id)) continue;
    seen.add(id);
    const title = meta.title || meta.taskTitle;
    hits.push({ id, label: `${meta.kind || chunk.namespace}${title ? ` · ${title}` : ''}`, text: chunk.text });
  }
  return hits;
}

export async function prefetchPromptMemory(projectId: string | undefined, query: string): Promise<PromptMemoryHit[]> {
  const q = query.replace(/\s+/g, ' ').trim().slice(0, MEMORY_PREFETCH_QUERY_CHARS);
  if (!projectId || !q) return []; // memory is project-scoped: never pre-fetch across projects
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const results = await Promise.race([
      searchMemory(q, { projectId, topK: 4, minSimilarity: 0.35, includeHidden: true }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), MEMORY_PREFETCH_TIMEOUT_MS);
      }),
    ]);
    return results ? toPromptMemoryHits(results) : [];
  } catch {
    return [];
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Hits as the overview call's PRIOR KNOWLEDGE block (empty string for none). */
export function formatPriorKnowledge(hits: PromptMemoryHit[]): string {
  return hits
    .map((h) => {
      const text = h.text.replace(/\s+/g, ' ').trim();
      return `- [${h.label.replace(/\s+/g, ' ').trim()}] ${text.length > 400 ? `${text.slice(0, 399)}…` : text}`;
    })
    .join('\n');
}
