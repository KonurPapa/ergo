/**
 * Shared vector-memory types: used by the browser client (vectorEngine.ts) and by the bridge's on-disk store
 * (memoryStore.ts). Dependency-free so both the app and vite.config.ts can import it.
 */

/**
 * Namespaces:
 *   - `learnings`   — durable project knowledge (architectural decisions, gotchas, patterns)
 *   - `tasks`       — completed task summaries and acceptance criteria
 *   - `code-map`    — high-level file/component index (future)
 *   - `workspace`   — live index of the project's human workspace: every active task (one vector for the title and one
 *                     per subtask, so umbrella tasks match on their parts) and freeform text. Kept in sync on autosave.
 *                     Hidden from the archive UI; used to find related tasks.
 *   - `agent-notes` — the AI's own working memory: run notes (completion records, worker / QA reports, delegation
 *                     plans), notes agents save mid-task, and CLI artifacts (e.g. Claude Code todo lists).
 *                     Searchable by agents, hidden from the archive UI.
 */
export type MemoryNamespace = 'learnings' | 'tasks' | 'code-map' | 'agent-notes' | 'workspace';

/** Namespaces the archive UI never lists (AI-only memory). */
export const HIDDEN_MEMORY_NAMESPACES: readonly MemoryNamespace[] = ['agent-notes', 'workspace'];

/** What an `agent-notes` chunk is. */
export type AgentNoteKind = 'completion' | 'worker' | 'qa' | 'plan' | 'note' | 'artifact';

export interface ChunkMetadata {
  taskId?: string | number;
  taskTitle?: string;
  category?: string;
  projectId?: string;
  /** Free-form tags for filtering (e.g. 'architecture', 'gotcha', 'pattern') */
  tags?: string[];
  /** Source of the chunk (e.g. 'session-retrospective', 'migration', 'manual', 'run-signal', 'agent') */
  source?: string;
  /** Subtasks associated with this task if archived from workspace */
  subtasks?: Array<{ text: string; isDone?: boolean; isHumanReview?: boolean }>;
  /** JSON-serialized subtasks for persistent roundtripping */
  serializedSubtasks?: string;
  /** CLI task run the chunk came from. */
  runId?: string;
  /** Agent session (PTY id) that produced it. */
  sessionId?: string;
  /** agent-notes: what the chunk is. */
  kind?: AgentNoteKind;
  /** Human-readable title of the note / document the chunk belongs to. */
  title?: string;
  /** Long documents are split into chunks: the document id and this chunk's position. */
  docId?: string;
  part?: number;
  parts?: number;
  // ── `workspace` namespace only (written by /api/memory/workspace-sync) ──
  /** Workspace item the chunk belongs to (task id, or `note:<key>`). */
  wsItemId?: string;
  wsItemKind?: 'task' | 'note';
  /** Content hash of the whole item (title + category + subtasks + text): unchanged → nothing re-embedded. */
  wsHash?: string;
  /** Task chunks: -1 for the title chunk, else the subtask's 0-based index. Note chunks: the part index. */
  wsPart?: number;
  /** Task status / done flag (refreshed on sync without re-embedding). */
  status?: string;
  isDone?: boolean;
}

/** A chunk as the bridge returns it (the full embedding stays on the bridge). */
export interface MemoryChunkDTO {
  id: string;
  namespace: MemoryNamespace;
  text: string;
  metadata: ChunkMetadata;
  createdAt: number;
  /** First few embedding dimensions (for inspection in the archive UI). */
  embeddingPreview: number[];
  embeddingDim: number;
}

export interface MemorySearchRequest {
  query: string;
  namespace?: MemoryNamespace;
  namespaces?: MemoryNamespace[];
  topK?: number;
  minSimilarity?: number;
  projectId?: string;
  excludeTaskId?: string | number;
  taskId?: string | number;
  runId?: string;
  kinds?: AgentNoteKind[];
  /** Include AI-only namespaces when no namespace is given (agents: yes; archive UI: no). */
  includeHidden?: boolean;
}

// ─── Workspace index & related tasks ───────────────────────────────────────────

/** One item of the project's human workspace, as App sends it to the bridge for indexing. */
export interface WorkspaceIndexItem {
  /** Task id, or `note:<stable key>` for freeform text. */
  id: string;
  kind: 'task' | 'note';
  title: string;
  /** Lane / section heading. */
  category?: string;
  subtasks?: string[];
  /** Freeform text (notes) or the task's summary note. */
  text?: string;
  status?: string;
  isDone?: boolean;
}

export interface WorkspaceSyncRequest {
  projectId: string;
  items: WorkspaceIndexItem[];
}

export interface WorkspaceSyncResponse {
  success: boolean;
  /** Items whose text changed and were (re-)embedded. */
  embedded: number;
  removed: number;
  total: number;
  /** Chunks actually sent to the embedding model (vectors of unchanged chunk texts are reused). */
  embeddedChunks?: number;
  /** Items whose status / done flag / category label changed (metadata refreshed, nothing embedded). */
  updated?: number;
}

export interface RelatedTasksRequest {
  projectId: string;
  /** The task being run (excluded from results). */
  taskId: string;
  title: string;
  subtasks?: string[];
  /** Extra query text: summary note, freeform source content. */
  text?: string;
  /** Candidates to return (default 10). */
  topK?: number;
}

/** A candidate related task (stage 1: local, zero-token). */
export interface RelatedTaskCandidate {
  taskId: string;
  title: string;
  category?: string;
  status?: string;
  isDone?: boolean;
  /** Active workspace task, or a completed / archived one known only from memory. */
  source: 'workspace' | 'archive';
  /** Up to 5 subtasks, as short lines. */
  subtasks?: string[];
  /** What was built, when the task has run before (short: its completion summary). */
  completionSummary?: string;
  /** The part of the candidate that matched best (title or a specific subtask). */
  matchedOn: string;
  /** Centered cosine similarity of the best-matching pair, and its z-score among all candidates. */
  score: number;
  z: number;
}

export interface RelatedNoteCandidate {
  id: string;
  title: string;
  text: string;
  score: number;
  z: number;
}

export interface RelatedTasksResponse {
  success: boolean;
  candidates: RelatedTaskCandidate[];
  notes: RelatedNoteCandidate[];
  /** How many workspace items were searched. */
  searched: number;
}

/**
 * Text normalization for the workspace index (shared by the app's item builder and the bridge, so both sides hash
 * and embed the same strings): drops strike-through / bold / italic markers and backticks, collapses whitespace.
 */
export function cleanWorkspaceText(text: unknown): string {
  return String(text ?? '')
    .replace(/~~/g, '')
    .replace(/[*`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
