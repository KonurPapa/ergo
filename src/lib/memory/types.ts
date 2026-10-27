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
 *   - `agent-notes` — the AI's own working memory: run notes (completion records, worker / verifier reports, delegation
 *                     plans), notes agents save mid-task, and CLI artifacts (e.g. Claude Code todo lists).
 *                     Searchable by agents, hidden from the archive UI.
 *   - `insights`    — the project's learned rules: the user's standing requirements, distilled from their feedback on
 *                     runs (insights.ts). Kept small and current (reconciled on every write), shown and edited in the
 *                     Learned Rules panel, and handed to every run whole. Hidden from the archive UI and agent searches.
 */
export type MemoryNamespace = 'learnings' | 'tasks' | 'code-map' | 'agent-notes' | 'workspace' | 'insights';

/** Namespaces the archive UI never lists (AI-only memory, or memory with its own UI). */
export const HIDDEN_MEMORY_NAMESPACES: readonly MemoryNamespace[] = ['agent-notes', 'workspace', 'insights'];

/** What an `agent-notes` chunk is. */
export type AgentNoteKind = 'completion' | 'worker' | 'verifier' | 'plan' | 'note' | 'artifact';

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
  /** AI-workspace archive records: the JSON-serialized execution card, so Restore brings it back whole. */
  serializedBrief?: string;
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
  // ── `insights` namespace only ──
  /** always: applies to nearly every task (package manager, verification, git); topical: only to related work. */
  insightScope?: InsightScope;
  /** How many times the user's feedback stated or reinforced the rule. */
  insightConfirms?: number;
  /** learned: distilled from feedback · user: written or edited by the user (the distiller may still refine it). */
  insightOrigin?: 'learned' | 'user';
  /** The task / run whose feedback last changed the rule (not `taskId`: purging a task's memory must keep its rules). */
  insightTaskId?: string;
  insightTaskTitle?: string;
  insightRunId?: string;
  insightUpdatedAt?: number;
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
  /** The task's own summary note, when it has one. */
  summaryNote?: string;
  /** A freeform note offered for selection alongside the tasks (relatedSelectionPool); absent for tasks. */
  kind?: 'note';
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
  /**
   * The project's learned rules for this task (bridge protocol ≥ 5; absent from older bridges): all of them while the
   * list is small, else every `always` rule plus the topical ones nearest the task.
   */
  insights?: ProjectInsight[];
}

// ─── Learned rules (namespace `insights`) ──────────────────────────────────────

export type InsightScope = 'always' | 'topical';

export interface ProjectInsight {
  id: string;
  text: string;
  scope: InsightScope;
  confirms: number;
  origin: 'learned' | 'user';
  createdAt: number;
  updatedAt: number;
  /** The task whose feedback last changed it. */
  taskId?: string;
  taskTitle?: string;
}

/**
 * One change to a project's rule list. The distiller emits add / update / delete / confirm; `put` writes an exact
 * rule (id included) with no duplicate check — undo uses it to bring back a deleted or changed rule.
 */
export type InsightOp =
  | { op: 'add'; text: string; scope?: InsightScope }
  | { op: 'update'; id: string; text?: string; scope?: InsightScope }
  | { op: 'delete'; id: string }
  | { op: 'confirm'; id: string }
  | { op: 'unconfirm'; id: string }
  | { op: 'put'; insight: Pick<ProjectInsight, 'id' | 'text' | 'scope' | 'confirms' | 'origin'> & Partial<Pick<ProjectInsight, 'createdAt' | 'taskId' | 'taskTitle'>> };

/** Where a change came from: the feedback's task / run, or the user editing the list. */
export interface InsightSource {
  origin: 'learned' | 'user';
  taskId?: string;
  taskTitle?: string;
  runId?: string;
}

/** What an op did (`add` that hit the duplicate guard reports as `confirm`), plus the op that reverts it. */
export interface InsightChange {
  kind: 'added' | 'updated' | 'deleted' | 'confirmed' | 'restored';
  insight: ProjectInsight;
  /** The rule before an update / delete. */
  previous?: ProjectInsight;
  undo: InsightOp;
}

export interface InsightApplyRequest {
  projectId: string;
  ops: InsightOp[];
  source: InsightSource;
}

export interface InsightApplyResponse {
  success: boolean;
  changes: InsightChange[];
  insights: ProjectInsight[];
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
