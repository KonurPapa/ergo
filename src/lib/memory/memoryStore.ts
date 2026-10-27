/**
 * Ergo vector memory — the bridge's on-disk store (Node only; imported by vite.config.ts, never by the app).
 *
 * Layout (`<storage root>/.ergo/memory/`):
 *   chunks.json  — `{ version, dim, count, vectorsChecksum, chunks: [{ id, namespace, text, metadata, createdAt, hash }] }`
 *                  in row order
 *   vectors.f32  — Float32 matrix (little-endian), `count × 384`, rows aligned with `chunks`
 * Both are written atomically (tmp + rename), debounced ~500 ms; the bridge calls `flushSync()` on exit.
 *
 * Embeddings come from `@huggingface/transformers` (node build, loaded with a dynamic import so Vite never bundles
 * it): `Xenova/all-MiniLM-L6-v2`, fp32, mean pooling, normalized — identical to the old in-browser engine, so
 * migrated vectors stay comparable. Search is a brute-force dot product over the pre-normalized matrix.
 *
 * This file is also type-checked by the app's tsconfig (no Node types there), so every Node API it needs is
 * injected through `MemoryStoreIo` instead of being imported.
 */

import {
  HIDDEN_MEMORY_NAMESPACES,
  type AgentNoteKind,
  type ChunkMetadata,
  type InsightApplyResponse,
  type InsightChange,
  type InsightOp,
  type InsightScope,
  type InsightSource,
  type MemoryChunkDTO,
  type MemoryNamespace,
  type MemorySearchRequest,
  type ProjectInsight,
  type RelatedNoteCandidate,
  type RelatedTaskCandidate,
  type RelatedTasksRequest,
  type RelatedTasksResponse,
  type WorkspaceIndexItem,
  type WorkspaceSyncResponse,
  cleanWorkspaceText,
} from './types.ts';

export const MEMORY_EMBEDDING_DIM = 384;
export const MEMORY_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
export const MEMORY_NAMESPACES: readonly MemoryNamespace[] = ['learnings', 'tasks', 'code-map', 'agent-notes', 'workspace', 'insights'];
export const AGENT_NOTE_KINDS: readonly AgentNoteKind[] = ['completion', 'worker', 'verifier', 'plan', 'note', 'artifact'];

const DIM = MEMORY_EMBEDDING_DIM;
const STORE_VERSION = 1;
const WRITE_DEBOUNCE_MS = 500;
/** Max chars per document chunk (MiniLM truncates at ~256 tokens; longer chunks lose meaning). */
export const DOC_CHUNK_MAX_CHARS = 900;
/** Embedding input cap: the tokenizer truncates at 512 tokens anyway; don't tokenize megabytes for nothing. */
const EMBED_INPUT_MAX_CHARS = 4_000;
const EMBED_BATCH = 8;
const PREVIEW_DIMS = 8;

/** Node APIs the store needs, injected by the bridge (keeps this file free of Node imports / types). */
export interface MemoryStoreIo {
  /** null when the file does not exist. */
  readText(file: string): Promise<string | null>;
  readBytes(file: string): Promise<Uint8Array | null>;
  /** Atomic write (tmp file + rename), creating the parent dir. */
  writeAtomic(file: string, data: string | Uint8Array): Promise<void>;
  writeAtomicSync(file: string, data: string | Uint8Array): void;
}

export interface MemoryStoreOptions {
  /** `<storage root>/.ergo/memory` */
  dir: string;
  chunksFile: string;
  vectorsFile: string;
  /** `<storage root>/.ergo/models` — transformers.js cache dir. */
  modelsDir: string;
  io: MemoryStoreIo;
  log?: (msg: string, err?: unknown) => void;
}

export interface MemoryChunkInput {
  id: string;
  namespace: MemoryNamespace;
  text: string;
  metadata?: ChunkMetadata;
}

export interface MemoryImportInput extends MemoryChunkInput {
  createdAt?: number;
  embedding?: number[] | null;
}

export type MemoryRemoveRequest =
  | { ids: string[] }
  | { taskId: string | number; projectId?: string }
  | { projectId: string }
  | { namespace: MemoryNamespace }
  | { all: true };

export interface MemoryListFilter {
  namespace?: MemoryNamespace;
  projectId?: string;
  includeHidden?: boolean;
}

export interface MemorySearchHit {
  chunk: MemoryChunkDTO;
  similarity: number;
}

interface Row {
  id: string;
  namespace: MemoryNamespace;
  text: string;
  metadata: ChunkMetadata;
  createdAt: number;
  /** Hash of the embedding input; unchanged hash → vector reused. */
  hash: string;
  /** `String(metadata.taskId)` (or null), precomputed for the search filters. */
  taskKey: string | null;
}

interface PersistedFile {
  version: number;
  dim: number;
  count: number;
  vectorsChecksum: string;
  chunks: Array<Omit<Row, 'taskKey'>>;
}

// ─── Embedding model (shared by every store; single-flight load, one serialized queue) ─────────────────────────

let pipelinePromise: Promise<any> | null = null;
let pipelineLoaded = false;

function loadPipeline(modelsDir: string, log: (msg: string, err?: unknown) => void): Promise<any> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const started = Date.now();
      const mod: any = await import('@huggingface/transformers');
      const env = mod.env;
      if (env) {
        env.cacheDir = modelsDir;
        env.allowLocalModels = false;
      }
      const pipe = await mod.pipeline('feature-extraction', MEMORY_MODEL_ID, { dtype: 'fp32' });
      pipelineLoaded = true;
      log(`Embedding model ready (${MEMORY_MODEL_ID}, ${DIM}-dim) in ${Date.now() - started} ms`);
      return pipe;
    })().catch((err) => {
      pipelinePromise = null;
      log('Loading the embedding model failed', err);
      throw err;
    });
  }
  return pipelinePromise;
}

/**
 * Embeds with the memory model outside any store (the code index). Needs the models dir once, for the first load;
 * every caller shares the one model and queue.
 */
export function embedWithMemoryModel(texts: string[], priority: EmbedPriority, modelsDir: string): Promise<Float32Array[]> {
  if (!embedModelsDir) embedModelsDir = modelsDir;
  return embedTexts(texts, priority);
}

export function isMemoryModelLoaded(): boolean {
  return pipelineLoaded;
}

interface EmbedJob {
  texts: string[];
  resolve: (v: Float32Array[]) => void;
  reject: (e: unknown) => void;
}

const embedQueue: EmbedJob[] = [];
const priorityQueue: EmbedJob[] = [];
/** Bulk work nobody is waiting on (code indexing): runs only when the other two queues are empty. */
const backgroundQueue: EmbedJob[] = [];
let embedWorkerRunning = false;
let embedModelsDir = '';
let embedLog: (msg: string, err?: unknown) => void = () => {};

async function runEmbedWorker() {
  if (embedWorkerRunning) return;
  embedWorkerRunning = true;
  try {
    while (priorityQueue.length > 0 || embedQueue.length > 0 || backgroundQueue.length > 0) {
      const job = (priorityQueue.shift() ?? embedQueue.shift() ?? backgroundQueue.shift())!;
      try {
        const pipe = await loadPipeline(embedModelsDir, embedLog);
        const out = await pipe(job.texts, { pooling: 'mean', normalize: true });
        const data: Float32Array = out.data;
        const result: Float32Array[] = [];
        for (let i = 0; i < job.texts.length; i++) result.push(data.slice(i * DIM, (i + 1) * DIM));
        job.resolve(result);
      } catch (err) {
        job.reject(err);
      }
    }
  } finally {
    embedWorkerRunning = false;
  }
}

/** Which queue an embedding waits in: search queries first, then memory ingestion, then background indexing. */
export type EmbedPriority = 'query' | 'normal' | 'background';

/** Embeds texts through the one serialized queue (`priority`: search queries jump ahead of bulk ingestion). */
async function embedTexts(texts: string[], priority: boolean | EmbedPriority = false): Promise<Float32Array[]> {
  const queue = priority === true || priority === 'query' ? priorityQueue : priority === 'background' ? backgroundQueue : embedQueue;
  if (texts.length === 0) return [];
  const inputs = texts.map((t) => {
    const s = String(t ?? '').trim();
    return s.length > EMBED_INPUT_MAX_CHARS ? s.slice(0, EMBED_INPUT_MAX_CHARS) : s || ' ';
  });
  const jobs: Promise<Float32Array[]>[] = [];
  for (let i = 0; i < inputs.length; i += EMBED_BATCH) {
    const batch = inputs.slice(i, i + EMBED_BATCH);
    jobs.push(
      new Promise<Float32Array[]>((resolve, reject) => {
        queue.push({ texts: batch, resolve, reject });
      })
    );
  }
  void runEmbedWorker();
  return (await Promise.all(jobs)).flat();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────

/** FNV-1a (two 32-bit lanes) → 16 hex chars. Only used to detect unchanged text. */
export function textHash(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) ^ (h2 >>> 15);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

function checksumVectors(vectors: Float32Array, count: number): string {
  const words = new Uint32Array(vectors.buffer, vectors.byteOffset, count * DIM);
  let h = 0x811c9dc5 ^ count;
  for (let i = 0; i < words.length; i++) h = Math.imul(h ^ words[i], 0x01000193);
  return `${count}:${(h >>> 0).toString(16)}`;
}

function taskKeyOf(meta: ChunkMetadata): string | null {
  return meta.taskId === undefined || meta.taskId === null || meta.taskId === '' ? null : String(meta.taskId);
}

function normalizeInPlace(v: Float32Array) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (n > 0 && Math.abs(n - 1) > 1e-4) for (let i = 0; i < v.length; i++) v[i] /= n;
}

function cleanMetadata(meta: unknown): ChunkMetadata {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta as Record<string, unknown>)) if (v !== undefined) out[k] = v;
  return out as ChunkMetadata;
}

/** Embedding input for a document chunk: the title gives short chunks their context. */
function docEmbedInput(text: string, title?: string): string {
  return title ? `${title}\n\n${text}` : text;
}

/**
 * Splits a document into chunks of ≤ `max` chars, preferring Markdown heading boundaries, then paragraphs, then
 * sentences (hard split on whitespace as a last resort). Small neighbouring pieces are packed together.
 */
export function splitDocument(text: string, max = DOC_CHUNK_MAX_CHARS): string[] {
  const src = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!src) return [];
  if (src.length <= max) return [src];

  // 1. Sections at headings.
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of src.split('\n')) {
    if (/^#{1,6}\s/.test(line) && current.join('\n').trim()) {
      sections.push(current.join('\n').trim());
      current = [];
    }
    current.push(line);
  }
  if (current.join('\n').trim()) sections.push(current.join('\n').trim());

  // 2. Atomic pieces ≤ max: paragraphs, then sentences, then words.
  const pieces: Array<{ text: string; heading: boolean }> = [];
  const hardSplit = (s: string) => {
    let rest = s;
    while (rest.length > max) {
      let cut = rest.lastIndexOf(' ', max);
      if (cut < max * 0.5) cut = max;
      pieces.push({ text: rest.slice(0, cut).trim(), heading: false });
      rest = rest.slice(cut).trim();
    }
    if (rest) pieces.push({ text: rest, heading: false });
  };
  for (const section of sections) {
    const isHeading = /^#{1,6}\s/.test(section);
    if (section.length <= max) {
      pieces.push({ text: section, heading: isHeading });
      continue;
    }
    let first = true;
    for (const para of section.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)) {
      const heading = first && isHeading;
      first = false;
      if (para.length <= max) {
        pieces.push({ text: para, heading });
        continue;
      }
      const sentences = para.split(/(?<=[.!?])\s+|\n(?=\s*[-*+]\s|\s*\d+[.)]\s)/).filter((s) => s.trim());
      let buf = '';
      let bufHeading = heading;
      for (const sentence of sentences) {
        if (sentence.length > max) {
          if (buf) pieces.push({ text: buf.trim(), heading: bufHeading });
          buf = '';
          bufHeading = false;
          hardSplit(sentence.trim());
          continue;
        }
        if (buf && buf.length + 1 + sentence.length > max) {
          pieces.push({ text: buf.trim(), heading: bufHeading });
          buf = '';
          bufHeading = false;
        }
        buf = buf ? `${buf} ${sentence}` : sentence;
      }
      if (buf.trim()) pieces.push({ text: buf.trim(), heading: bufHeading });
    }
  }

  // 3. Pack pieces greedily; a heading starts a new chunk once the current one has some substance.
  const chunks: string[] = [];
  let acc = '';
  for (const piece of pieces) {
    if (!acc) {
      acc = piece.text;
      continue;
    }
    const joined = `${acc}\n\n${piece.text}`;
    if (joined.length > max || (piece.heading && acc.length >= max * 0.35)) {
      chunks.push(acc);
      acc = piece.text;
    } else {
      acc = joined;
    }
  }
  if (acc) chunks.push(acc);
  return chunks;
}

// ─── Workspace index (namespace `workspace`) ─────────────────────────────────────────────────────────────────
//
// Every active task becomes one chunk for its title (`ws:<projectId>:<itemId>#t`) plus one per subtask, embedded as
// `"<title>: <subtask>"` (`#s<n>`), so umbrella tasks match on their parts. Freeform notes are split with
// splitDocument (`#p<n>`). Related-task search scores a candidate as the MAX over (query vector × candidate vector)
// after centering every vector on the project centroid — on real workspaces everything is "about tasks / AI", and
// raw cosine ranks unrelated pairs above true relations (see RELATED_SPEC evaluation: recall@10 0.84 vs raw).

export const WORKSPACE_MAX_ITEMS = 5_000;
export const WORKSPACE_MAX_SUBTASKS = 80;
const WS_TITLE_MAX = 400;
const WS_SUBTASK_MAX = 600;
/** Task summary note folded into the title chunk. */
const WS_SUMMARY_MAX = 600;
const WS_NOTE_MAX = 40_000;
const RELATED_MAX_QUERY_SUBTASKS = 12;
const RELATED_QUERY_TEXT_MAX = 600;
const RELATED_MIN_Z = 0.5;
const RELATED_NOTE_MIN_Z = 1.5;
const RELATED_NOTES_MAX = 3;
/** Below this many workspace items centering is meaningless: raw cosine with a fixed floor instead. */
const RELATED_MIN_ITEMS_FOR_CENTERING = 5;
const RELATED_RAW_MIN_SIMILARITY = 0.35;
const RELATED_SUBTASKS_SHOWN = 5;
const RELATED_SUBTASK_CHARS = 120;
const RELATED_SUMMARY_CHARS = 300;

interface WorkspaceChunkPlan {
  id: string;
  text: string;
  /** What is embedded (notes: title + part). */
  embedInput: string;
  hash: string;
  metadata: ChunkMetadata;
}

/** Normalized item (bridge-side defensive cleanup of what the app sent). Null when unusable. */
function normalizeWorkspaceItem(raw: WorkspaceIndexItem): WorkspaceIndexItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' || typeof raw.id === 'number' ? String(raw.id).trim().slice(0, 300) : '';
  if (!id) return null;
  const kind: 'task' | 'note' = raw.kind === 'note' ? 'note' : 'task';
  const title = cleanWorkspaceText(raw.title).slice(0, WS_TITLE_MAX);
  const category = cleanWorkspaceText(raw.category).slice(0, 200) || undefined;
  const status = typeof raw.status === 'string' && raw.status.trim() ? raw.status.trim().slice(0, 40) : undefined;
  const isDone = typeof raw.isDone === 'boolean' ? raw.isDone : undefined;
  if (kind === 'note') {
    // Notes keep their line structure (the splitter uses paragraphs); only trailing / repeated blank space goes.
    const text = String(raw.text ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, WS_NOTE_MAX);
    if (!text) return null;
    return { id, kind, title: title || category || 'Notes', category, text, status, isDone };
  }
  if (!title) return null;
  const subtasks = (Array.isArray(raw.subtasks) ? raw.subtasks : [])
    .map((s) => cleanWorkspaceText(s).slice(0, WS_SUBTASK_MAX))
    .filter(Boolean)
    .slice(0, WORKSPACE_MAX_SUBTASKS);
  const text = cleanWorkspaceText(raw.text).slice(0, WS_SUMMARY_MAX) || undefined;
  return { id, kind, title, category, subtasks, text, status, isDone };
}

/** Content hash of an item: what its vectors depend on (status / done flag excluded on purpose). */
export function workspaceItemHash(item: WorkspaceIndexItem): string {
  return textHash(JSON.stringify([item.kind, item.title, item.category || '', item.subtasks || [], item.text || '']));
}

function workspaceItemMeta(projectId: string, item: WorkspaceIndexItem, hash: string, part: number): ChunkMetadata {
  return cleanMetadata({
    projectId,
    ...(item.kind === 'task' ? { taskId: item.id } : { kind: 'note' as const }),
    taskTitle: item.title,
    category: item.category,
    source: 'workspace-index',
    status: item.status,
    isDone: item.isDone,
    wsItemId: item.id,
    wsItemKind: item.kind,
    wsHash: hash,
    wsPart: part,
  });
}

/** Chunks of one (normalized) workspace item. */
export function planWorkspaceChunks(projectId: string, item: WorkspaceIndexItem): WorkspaceChunkPlan[] {
  const hash = workspaceItemHash(item);
  const base = `ws:${projectId}:${item.id}`;
  const out: WorkspaceChunkPlan[] = [];
  if (item.kind === 'note') {
    splitDocument(item.text || '').forEach((part, n) => {
      const embedInput = docEmbedInput(part, item.title);
      out.push({ id: `${base}#p${n}`, text: part, embedInput, hash: textHash(embedInput), metadata: workspaceItemMeta(projectId, item, hash, n) });
    });
    return out;
  }
  const titleText = item.text ? `${item.title} — ${item.text}` : item.title;
  out.push({ id: `${base}#t`, text: titleText, embedInput: titleText, hash: textHash(titleText), metadata: workspaceItemMeta(projectId, item, hash, -1) });
  (item.subtasks || []).forEach((sub, n) => {
    const text = `${item.title}: ${sub}`;
    out.push({ id: `${base}#s${n}`, text, embedInput: text, hash: textHash(text), metadata: workspaceItemMeta(projectId, item, hash, n) });
  });
  return out;
}

/** The `**Done:**` (older records: `**Summary:**`) line of a completion record, else its first ≤ max chars (one line). */
function completionSummaryOf(texts: string[], max = RELATED_SUMMARY_CHARS): string | undefined {
  for (const t of texts) {
    const m = t.match(/\*\*(?:Done|Summary):?\*\*:?\s*(.+)/i);
    if (m && m[1].trim()) return oneLine(m[1], max);
  }
  const first = texts.find((t) => t.trim());
  return first ? oneLine(first, max) : undefined;
}

function oneLine(text: string, max: number): string {
  const s = cleanWorkspaceText(text.replace(/^#+\s.*$/gm, ' '));
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Per-project centering data, rebuilt when the store changes (`generation`). */
interface WorkspaceProjectCache {
  generation: number;
  /** Row indices of the project's `workspace` chunks. */
  rows: number[];
  centroid: Float32Array;
  /** |c|² */
  cc: number;
  /** Per entry of `rows`: x·c and |x − c|. */
  xc: Float64Array;
  nx: Float64Array;
  /** Embedding-input hash → row index (vector reuse for queries). */
  byHash: Map<string, number>;
  /** Distinct workspace items. */
  itemCount: number;
}

// ─── Store ────────────────────────────────────────────────────────────────────────────────────────────────────

export class MemoryStore {
  readonly dir: string;
  readonly chunksFile: string;
  readonly vectorsFile: string;
  readonly modelsDir: string;
  private readonly io: MemoryStoreIo;
  private readonly log: (msg: string, err?: unknown) => void;

  private rows: Row[] = [];
  private index = new Map<string, number>();
  private vectors = new Float32Array(0);
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  /** Mutations run one after another (embedding happens inside), so reads always see a consistent state. */
  private chain: Promise<unknown> = Promise.resolve();
  private dirty = false;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> | null = null;
  /** Bumped on every change to rows / vectors (invalidates derived caches such as the workspace centroids). */
  private generation = 0;
  private wsCache = new Map<string, WorkspaceProjectCache>();

  constructor(opts: MemoryStoreOptions) {
    this.dir = opts.dir;
    this.chunksFile = opts.chunksFile;
    this.vectorsFile = opts.vectorsFile;
    this.modelsDir = opts.modelsDir;
    this.io = opts.io;
    this.log = opts.log || ((msg, err) => (err ? console.warn(`[Ergo Memory] ${msg}:`, err) : console.log(`[Ergo Memory] ${msg}`)));
    embedModelsDir = embedModelsDir || opts.modelsDir;
    embedLog = this.log;
  }

  // ── Loading / persistence ──

  isLoaded(): boolean {
    return this.loaded;
  }

  ensureLoaded(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    if (!this.loadPromise) {
      this.loadPromise = this.load().finally(() => {
        this.loaded = true;
      });
    }
    return this.loadPromise;
  }

  private async load() {
    let parsed: PersistedFile | null = null;
    try {
      const raw = await this.io.readText(this.chunksFile);
      if (raw) parsed = JSON.parse(raw);
    } catch (err) {
      this.log(`Could not read ${this.chunksFile}; starting with an empty memory`, err);
    }
    const list = Array.isArray(parsed?.chunks) ? parsed!.chunks : [];
    const rows: Row[] = [];
    for (const c of list) {
      if (!c || typeof c.id !== 'string' || typeof c.text !== 'string') continue;
      const metadata = cleanMetadata(c.metadata);
      rows.push({
        id: c.id,
        namespace: MEMORY_NAMESPACES.includes(c.namespace) ? c.namespace : 'learnings',
        text: c.text,
        metadata,
        createdAt: typeof c.createdAt === 'number' ? c.createdAt : Date.now(),
        hash: typeof c.hash === 'string' ? c.hash : textHash(c.text),
        taskKey: taskKeyOf(metadata),
      });
    }
    const vectors = new Float32Array(Math.max(16, rows.length) * DIM);
    let vectorsOk = false;
    if (rows.length > 0) {
      try {
        const bytes = await this.io.readBytes(this.vectorsFile);
        if (bytes && bytes.byteLength === rows.length * DIM * 4 && rows.length === list.length) {
          new Uint8Array(vectors.buffer).set(bytes);
          vectorsOk = !parsed?.vectorsChecksum || checksumVectors(vectors, rows.length) === parsed.vectorsChecksum;
        }
      } catch (err) {
        this.log(`Could not read ${this.vectorsFile}`, err);
      }
    } else {
      vectorsOk = true;
    }
    this.rows = rows;
    this.vectors = vectors;
    this.generation++;
    this.rebuildIndex();
    if (rows.length > 0) this.log(`Loaded ${rows.length} memory chunks from ${this.dir}`);
    // Copies of task overviews an older app wrote on every project load (ids `migrated_<project>_<task>`): stale
    // duplicates of the live workspace index, dropped once.
    if (rows.some((r) => r.id.startsWith('migrated_'))) {
      void this.mutate(async () => {
        const n = this.removeWhere((r) => r.id.startsWith('migrated_'));
        this.log(`Dropped ${n} stale overview copies (migrated_*)`);
        return n;
      }).catch((err) => this.log('Dropping stale overview copies failed', err));
    }
    // One-line run summaries an older app wrote after every run (ids `task_summary_<project>_<task>`): the run's
    // completion record in agent-notes already holds this, so they were duplicates, dropped once.
    if (rows.some((r) => r.id.startsWith('task_summary_'))) {
      void this.mutate(async () => {
        const n = this.removeWhere((r) => r.id.startsWith('task_summary_'));
        this.log(`Dropped ${n} duplicate run summaries (task_summary_*)`);
        return n;
      }).catch((err) => this.log('Dropping duplicate run summaries failed', err));
    }
    if (!vectorsOk) {
      // A crash between the two renames (or a hand-edited file): re-embed everything in the background.
      this.log(`vectors.f32 does not match chunks.json; re-embedding ${rows.length} chunks`);
      void this.mutate(async () => {
        const fresh = await embedTexts(this.rows.map((r) => r.text));
        for (let i = 0; i < fresh.length && i < this.rows.length; i++) this.vectors.set(fresh[i], i * DIM);
        this.markDirty();
      }).catch((err) => this.log('Re-embedding failed', err));
    }
  }

  private rebuildIndex() {
    this.index.clear();
    for (let i = 0; i < this.rows.length; i++) this.index.set(this.rows[i].id, i);
  }

  private markDirty() {
    this.generation++;
    this.dirty = true;
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.flush();
    }, WRITE_DEBOUNCE_MS);
  }

  private snapshot(): { json: string; bytes: Uint8Array } {
    const count = this.rows.length;
    const file: PersistedFile = {
      version: STORE_VERSION,
      dim: DIM,
      count,
      vectorsChecksum: checksumVectors(this.vectors, count),
      chunks: this.rows.map(({ id, namespace, text, metadata, createdAt, hash }) => ({ id, namespace, text, metadata, createdAt, hash })),
    };
    // Copy: the matrix may change while the async write is in flight.
    const bytes = new Uint8Array(this.vectors.buffer, this.vectors.byteOffset, count * DIM * 4).slice();
    return { json: JSON.stringify(file), bytes };
  }

  /** Writes pending changes now (async, atomic). */
  async flush(): Promise<void> {
    if (this.writing) await this.writing.catch(() => {});
    if (!this.dirty) return;
    this.dirty = false;
    const { json, bytes } = this.snapshot();
    // vectors first: a crash in between leaves a checksum mismatch, which load() repairs.
    this.writing = (async () => {
      await this.io.writeAtomic(this.vectorsFile, bytes);
      await this.io.writeAtomic(this.chunksFile, json);
    })().catch((err) => {
      this.dirty = true;
      this.log('Writing the memory store failed', err);
    });
    await this.writing;
    this.writing = null;
  }

  /** Synchronous flush for process exit. */
  flushSync() {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = null;
    if (!this.dirty || !this.loaded) return;
    try {
      const { json, bytes } = this.snapshot();
      this.io.writeAtomicSync(this.vectorsFile, bytes);
      this.io.writeAtomicSync(this.chunksFile, json);
      this.dirty = false;
    } catch (err) {
      this.log('Writing the memory store on exit failed', err);
    }
  }

  private mutate<T>(fn: () => Promise<T>): Promise<T> {
    const run = async () => {
      await this.ensureLoaded();
      return fn();
    };
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => {});
    return result;
  }

  // ── Row helpers (only called inside mutate) ──

  private ensureCapacity(rowCount: number) {
    if (this.vectors.length >= rowCount * DIM) return;
    const grown = new Float32Array(Math.max(rowCount, Math.ceil((this.vectors.length / DIM) * 1.5) + 16) * DIM);
    grown.set(this.vectors.subarray(0, this.rows.length * DIM));
    this.vectors = grown;
  }

  /** Inserts or replaces a row (by id) with the given vector. */
  private putRow(row: Row, vector: Float32Array) {
    const existing = this.index.get(row.id);
    if (existing !== undefined) {
      this.rows[existing] = row;
      this.vectors.set(vector, existing * DIM);
      return;
    }
    this.ensureCapacity(this.rows.length + 1);
    const i = this.rows.length;
    this.rows.push(row);
    this.vectors.set(vector, i * DIM);
    this.index.set(row.id, i);
  }

  /** Removes rows matching `pred`, compacting the matrix. Returns how many were removed. */
  private removeWhere(pred: (row: Row) => boolean): number {
    let w = 0;
    const before = this.rows.length;
    for (let r = 0; r < before; r++) {
      const row = this.rows[r];
      if (pred(row)) continue;
      if (w !== r) {
        this.rows[w] = row;
        this.vectors.copyWithin(w * DIM, r * DIM, (r + 1) * DIM);
      }
      w++;
    }
    this.rows.length = w;
    const removed = before - w;
    if (removed > 0) {
      this.vectors.fill(0, w * DIM, before * DIM);
      this.rebuildIndex();
      this.markDirty();
    }
    return removed;
  }

  private vectorOf(i: number): Float32Array {
    return this.vectors.slice(i * DIM, (i + 1) * DIM);
  }

  private toDTO(i: number): MemoryChunkDTO {
    const row = this.rows[i];
    return {
      id: row.id,
      namespace: row.namespace,
      text: row.text,
      metadata: row.metadata,
      createdAt: row.createdAt,
      embeddingPreview: Array.from(this.vectors.subarray(i * DIM, i * DIM + PREVIEW_DIMS)),
      embeddingDim: DIM,
    };
  }

  // ── Public API ──

  /** Same semantics as the old `addChunks`: upsert by id; returns how many were stored. */
  add(chunks: MemoryChunkInput[]): Promise<number> {
    return this.mutate(async () => {
      const valid = chunks.filter((c) => c && typeof c.id === 'string' && c.id && typeof c.text === 'string' && c.text.trim());
      if (valid.length === 0) return 0;
      const hashes = valid.map((c) => textHash(c.text));
      const need: number[] = [];
      const vecs: Array<Float32Array | null> = valid.map((c, k) => {
        const i = this.index.get(c.id);
        if (i !== undefined && this.rows[i].hash === hashes[k]) return this.vectorOf(i);
        need.push(k);
        return null;
      });
      const fresh = await embedTexts(need.map((k) => valid[k].text));
      need.forEach((k, j) => (vecs[k] = fresh[j]));
      const now = Date.now();
      valid.forEach((c, k) => {
        const metadata = cleanMetadata(c.metadata);
        this.putRow({ id: c.id, namespace: c.namespace, text: c.text, metadata, createdAt: now, hash: hashes[k], taskKey: taskKeyOf(metadata) }, vecs[k]!);
      });
      this.markDirty();
      return valid.length;
    });
  }

  /** Updates text / namespace / metadata (merged). Re-embeds only when the text changes. */
  update(id: string, updates: { text?: string; namespace?: MemoryNamespace; metadata?: Partial<ChunkMetadata> }): Promise<MemoryChunkDTO | null> {
    return this.mutate(async () => {
      const i = this.index.get(id);
      if (i === undefined) return null;
      const existing = this.rows[i];
      const hasText = typeof updates.text === 'string' && updates.text.trim() !== '';
      const hasNamespace = Boolean(updates.namespace && MEMORY_NAMESPACES.includes(updates.namespace));
      const hasMetadata = Boolean(updates.metadata && Object.keys(updates.metadata).length > 0);
      // No changes (e.g. `{ id }` only): a pure read — nothing is re-embedded or written.
      if (!hasText && !hasNamespace && !hasMetadata) return this.toDTO(i);
      const text = hasText ? updates.text!.trim() : existing.text;
      let vector: Float32Array | null = null;
      let hash = existing.hash;
      if (text !== existing.text) {
        hash = textHash(text);
        [vector] = await embedTexts([text]);
      }
      const metadata = cleanMetadata({ ...existing.metadata, ...(updates.metadata || {}) });
      const j = this.index.get(id); // still there? (mutations are serialized, but be safe)
      if (j === undefined) return null;
      this.rows[j] = {
        ...existing,
        text,
        hash,
        namespace: updates.namespace && MEMORY_NAMESPACES.includes(updates.namespace) ? updates.namespace : existing.namespace,
        metadata,
        taskKey: taskKeyOf(metadata),
      };
      if (vector) this.vectors.set(vector, j * DIM);
      this.markDirty();
      return this.toDTO(j);
    });
  }

  /**
   * Stores a document as chunks `${docId}#${n}` (metadata docId / part / parts), replacing every previous chunk of
   * that document. Chunks whose text is unchanged keep their vector (no re-embedding). Returns the chunk count.
   */
  upsertDocument(input: { docId: string; namespace: MemoryNamespace; text: string; metadata?: ChunkMetadata }): Promise<number> {
    return this.mutate(async () => {
      const docId = input.docId;
      const parts = splitDocument(input.text);
      const baseMeta = cleanMetadata(input.metadata);
      const title = typeof baseMeta.title === 'string' ? baseMeta.title : undefined;

      const oldRows = new Map<string, number>(); // hash → row index of this doc's old chunks
      for (let i = 0; i < this.rows.length; i++) {
        if (this.rows[i].metadata.docId === docId) oldRows.set(this.rows[i].hash, i);
      }
      if (parts.length === 0) {
        if (oldRows.size > 0) this.removeWhere((r) => r.metadata.docId === docId);
        return 0;
      }
      const hashes = parts.map((p) => textHash(docEmbedInput(p, title)));
      const metas = parts.map((_, n) => ({ ...baseMeta, docId, part: n, parts: parts.length }));

      // Unchanged document: same chunks in the same places → refresh metadata only.
      const unchanged =
        oldRows.size === parts.length &&
        parts.every((_, n) => {
          const i = this.index.get(`${docId}#${n}`);
          return i !== undefined && this.rows[i].hash === hashes[n] && this.rows[i].namespace === input.namespace;
        });
      if (unchanged) {
        parts.forEach((_, n) => {
          const i = this.index.get(`${docId}#${n}`)!;
          if (JSON.stringify(this.rows[i].metadata) !== JSON.stringify(metas[n])) {
            this.rows[i] = { ...this.rows[i], metadata: metas[n], taskKey: taskKeyOf(metas[n]) };
            this.markDirty();
          }
        });
        return parts.length;
      }

      const vecs: Array<Float32Array | null> = hashes.map((h) => {
        const i = oldRows.get(h);
        return i !== undefined ? this.vectorOf(i) : null;
      });
      const need = vecs.map((v, n) => (v ? -1 : n)).filter((n) => n >= 0);
      const fresh = await embedTexts(need.map((n) => docEmbedInput(parts[n], title)));
      need.forEach((n, j) => (vecs[n] = fresh[j]));

      this.removeWhere((r) => r.metadata.docId === docId || r.id.startsWith(`${docId}#`));
      const now = Date.now();
      parts.forEach((text, n) => {
        this.putRow(
          { id: `${docId}#${n}`, namespace: input.namespace, text, metadata: metas[n], createdAt: now, hash: hashes[n], taskKey: taskKeyOf(metas[n]) },
          vecs[n]!
        );
      });
      this.markDirty();
      return parts.length;
    });
  }

  /** Migration import: keeps provided 384-dim embeddings (and createdAt), embeds the rest. Upsert by id. */
  importChunks(chunks: MemoryImportInput[]): Promise<number> {
    return this.mutate(async () => {
      const valid = chunks.filter((c) => c && typeof c.id === 'string' && c.id && typeof c.text === 'string' && c.text.trim());
      const vecs: Array<Float32Array | null> = valid.map((c) => {
        if (!Array.isArray(c.embedding) || c.embedding.length !== DIM) return null;
        const v = new Float32Array(c.embedding);
        for (let i = 0; i < DIM; i++) if (!Number.isFinite(v[i])) return null;
        normalizeInPlace(v);
        return v;
      });
      const need = vecs.map((v, k) => (v ? -1 : k)).filter((k) => k >= 0);
      const fresh = await embedTexts(need.map((k) => valid[k].text));
      need.forEach((k, j) => (vecs[k] = fresh[j]));
      valid.forEach((c, k) => {
        const metadata = cleanMetadata(c.metadata);
        const namespace = MEMORY_NAMESPACES.includes(c.namespace) ? c.namespace : 'learnings';
        this.putRow(
          {
            id: c.id,
            namespace,
            text: c.text,
            metadata,
            createdAt: typeof c.createdAt === 'number' && Number.isFinite(c.createdAt) ? c.createdAt : Date.now(),
            hash: textHash(c.text),
            taskKey: taskKeyOf(metadata),
          },
          vecs[k]!
        );
      });
      if (valid.length > 0) this.markDirty();
      return valid.length;
    });
  }

  remove(req: MemoryRemoveRequest): Promise<number> {
    return this.mutate(async () => {
      if ('all' in req && req.all === true) return this.removeWhere(() => true);
      if ('ids' in req && Array.isArray(req.ids)) {
        const ids = new Set(req.ids.map(String));
        return this.removeWhere((r) => ids.has(r.id));
      }
      if ('taskId' in req && req.taskId !== undefined && req.taskId !== null && req.taskId !== '') {
        const key = String(req.taskId);
        const projectId = req.projectId;
        // The `workspace` index is owned by workspace-sync (which removes items no longer in the project); purging
        // a task's memory must not leave the live index without that task until the next workspace edit.
        return this.removeWhere(
          (r) =>
            r.taskKey === key &&
            r.namespace !== 'workspace' &&
            !(projectId && r.metadata.projectId && r.metadata.projectId !== projectId)
        );
      }
      if ('projectId' in req && req.projectId) {
        const p = String(req.projectId);
        // Learned rules are the user's own, managed in their panel: clearing a project's memory keeps them.
        return this.removeWhere((r) => r.namespace !== 'insights' && r.metadata.projectId != null && String(r.metadata.projectId) === p);
      }
      if ('namespace' in req && req.namespace) {
        const ns = req.namespace;
        return this.removeWhere((r) => r.namespace === ns);
      }
      return 0;
    });
  }

  private matchesList(row: Row, f: MemoryListFilter): boolean {
    if (f.namespace) {
      if (row.namespace !== f.namespace) return false;
    } else if (!f.includeHidden && HIDDEN_MEMORY_NAMESPACES.includes(row.namespace)) {
      return false;
    }
    if (f.projectId && row.metadata.projectId !== f.projectId) return false;
    return true;
  }

  /** Chunks (newest first). Hidden namespaces are excluded unless asked for (or named). */
  async list(filter: MemoryListFilter = {}): Promise<MemoryChunkDTO[]> {
    await this.ensureLoaded();
    const out: Array<{ i: number; at: number }> = [];
    for (let i = 0; i < this.rows.length; i++) if (this.matchesList(this.rows[i], filter)) out.push({ i, at: this.rows[i].createdAt });
    out.sort((a, b) => b.at - a.at);
    return out.map(({ i }) => this.toDTO(i));
  }

  async count(filter: MemoryListFilter = {}): Promise<number> {
    await this.ensureLoaded();
    let n = 0;
    for (const row of this.rows) if (this.matchesList(row, filter)) n++;
    return n;
  }

  async has(id: string): Promise<boolean> {
    await this.ensureLoaded();
    return this.index.has(id);
  }

  async get(id: string): Promise<MemoryChunkDTO | null> {
    await this.ensureLoaded();
    const i = this.index.get(id);
    return i === undefined ? null : this.toDTO(i);
  }

  /** Every chunk of a document, in part order. */
  async getDocument(docId: string): Promise<MemoryChunkDTO[]> {
    await this.ensureLoaded();
    const found: number[] = [];
    for (let i = 0; i < this.rows.length; i++) if (this.rows[i].metadata.docId === docId) found.push(i);
    found.sort((a, b) => (this.rows[a].metadata.part ?? 0) - (this.rows[b].metadata.part ?? 0));
    return found.map((i) => this.toDTO(i));
  }

  /** Metadata of any chunk matching `pred` (e.g. to find a run's project from its ingested notes). */
  async findMetadata(pred: (meta: ChunkMetadata) => boolean): Promise<ChunkMetadata | null> {
    await this.ensureLoaded();
    for (let i = this.rows.length - 1; i >= 0; i--) if (pred(this.rows[i].metadata)) return this.rows[i].metadata;
    return null;
  }

  /** Semantic search: brute-force dot product over the normalized matrix, with filters. */
  async search(req: MemorySearchRequest): Promise<MemorySearchHit[]> {
    await this.ensureLoaded();
    const query = String(req.query ?? '').trim();
    if (!query || this.rows.length === 0) return [];
    const topK = Math.max(1, Math.min(100, Math.floor(Number(req.topK) || 5)));
    const minSim = typeof req.minSimilarity === 'number' && Number.isFinite(req.minSimilarity) ? req.minSimilarity : 0.3;
    const [q] = await embedTexts([query], true);

    // Filters, resolved once.
    const nsSet: Set<string> | null = req.namespace
      ? new Set([req.namespace])
      : Array.isArray(req.namespaces) && req.namespaces.length > 0
        ? new Set(req.namespaces)
        : null;
    // `workspace` (the live index of the human's task list, one chunk per subtask) is only searched when named: it
    // would crowd run reports and learnings out of agents' `includeHidden` searches. Related tasks use relatedTasks().
    // `insights` (learned rules) reach every run whole through the related-tasks call, so searches skip them too.
    const hidden: Set<string> | null = !nsSet
      ? new Set<string>(req.includeHidden ? ['workspace', 'insights'] : HIDDEN_MEMORY_NAMESPACES)
      : null;
    const projectId = req.projectId || null;
    const excludeTask = req.excludeTaskId !== undefined && req.excludeTaskId !== null && req.excludeTaskId !== '' ? String(req.excludeTaskId) : null;
    const taskKey = req.taskId !== undefined && req.taskId !== null && req.taskId !== '' ? String(req.taskId) : null;
    const runId = req.runId || null;
    const kinds: Set<string> | null = Array.isArray(req.kinds) && req.kinds.length > 0 ? new Set(req.kinds) : null;

    const topIdx = new Int32Array(topK).fill(-1);
    const topSim = new Float32Array(topK).fill(-Infinity);
    let filled = 0;
    const rows = this.rows;
    const vec = this.vectors;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (nsSet !== null && !nsSet.has(row.namespace)) continue;
      if (hidden !== null && hidden.has(row.namespace)) continue;
      const meta = row.metadata;
      if (projectId !== null && meta.projectId !== projectId) continue;
      if (excludeTask !== null && row.taskKey === excludeTask) continue;
      if (taskKey !== null && row.taskKey !== taskKey) continue;
      if (runId !== null && meta.runId !== runId) continue;
      if (kinds !== null && (meta.kind === undefined || !kinds.has(meta.kind))) continue;
      let dot = 0;
      const off = i * DIM;
      for (let d = 0; d < DIM; d++) dot += q[d] * vec[off + d];
      if (dot < minSim) continue;
      if (filled < topK) {
        let p = filled++;
        while (p > 0 && topSim[p - 1] < dot) {
          topSim[p] = topSim[p - 1];
          topIdx[p] = topIdx[p - 1];
          p--;
        }
        topSim[p] = dot;
        topIdx[p] = i;
      } else if (dot > topSim[topK - 1]) {
        let p = topK - 1;
        while (p > 0 && topSim[p - 1] < dot) {
          topSim[p] = topSim[p - 1];
          topIdx[p] = topIdx[p - 1];
          p--;
        }
        topSim[p] = dot;
        topIdx[p] = i;
      }
    }
    const hits: MemorySearchHit[] = [];
    for (let k = 0; k < filled; k++) hits.push({ chunk: this.toDTO(topIdx[k]), similarity: topSim[k] });
    return hits;
  }

  // ── Workspace index ──

  /**
   * Brings a project's `workspace` index in line with `items` (the app sends the full list on autosave):
   *   - items whose content hash is unchanged cost nothing (status / done-flag changes only refresh metadata);
   *   - changed items get new chunks; a chunk whose text some existing chunk of the project already has reuses that
   *     vector (so renumbered task ids or a moved task embed nothing), the rest are embedded;
   *   - items no longer present are removed.
   */
  syncWorkspace(projectId: string, rawItems: WorkspaceIndexItem[]): Promise<WorkspaceSyncResponse> {
    return this.mutate(async () => {
      const pid = String(projectId);
      const items = new Map<string, WorkspaceIndexItem>();
      for (const raw of (Array.isArray(rawItems) ? rawItems : []).slice(0, WORKSPACE_MAX_ITEMS)) {
        const item = normalizeWorkspaceItem(raw);
        if (item) items.set(item.id, item);
      }

      const byItem = new Map<string, number[]>();
      const byHash = new Map<string, number>();
      for (let i = 0; i < this.rows.length; i++) {
        const r = this.rows[i];
        if (r.namespace !== 'workspace' || r.metadata.projectId !== pid) continue;
        const key = typeof r.metadata.wsItemId === 'string' ? r.metadata.wsItemId : `\u0000orphan:${r.id}`;
        const list = byItem.get(key);
        if (list) list.push(i);
        else byItem.set(key, [i]);
        byHash.set(r.hash, i);
      }

      const rebuild: Array<{ item: WorkspaceIndexItem; plan: WorkspaceChunkPlan[] }> = [];
      const metaOnly: Array<{ rows: number[]; item: WorkspaceIndexItem }> = [];
      for (const item of items.values()) {
        const hash = workspaceItemHash(item);
        const rows = byItem.get(item.id) || [];
        const expected = item.kind === 'task' ? 1 + (item.subtasks?.length || 0) : null;
        const same =
          rows.length > 0 &&
          rows.every((i) => this.rows[i].metadata.wsHash === hash && this.rows[i].metadata.wsItemKind === item.kind) &&
          (expected === null ? rows.length === splitDocument(item.text || '').length : rows.length === expected);
        if (!same) {
          rebuild.push({ item, plan: planWorkspaceChunks(pid, item) });
          continue;
        }
        const m = this.rows[rows[0]].metadata;
        if (m.status !== item.status || m.isDone !== item.isDone) metaOnly.push({ rows, item });
      }
      const gone = new Set([...byItem.keys()].filter((k) => !items.has(k)));
      if (rebuild.length === 0 && metaOnly.length === 0 && gone.size === 0) {
        return { success: true, embedded: 0, removed: 0, total: items.size, embeddedChunks: 0, updated: 0 };
      }

      // Vectors: reuse the project's existing vector for an identical embedding input, embed the rest.
      const vecs = new Map<string, Float32Array>();
      const need: WorkspaceChunkPlan[] = [];
      const needHashes = new Set<string>();
      for (const { plan } of rebuild) {
        for (const c of plan) {
          if (vecs.has(c.hash) || needHashes.has(c.hash)) continue;
          const i = byHash.get(c.hash);
          if (i !== undefined) vecs.set(c.hash, this.vectorOf(i));
          else {
            needHashes.add(c.hash);
            need.push(c);
          }
        }
      }
      const fresh = await embedTexts(need.map((c) => c.embedInput));
      need.forEach((c, j) => vecs.set(c.hash, fresh[j]));

      // Metadata-only refresh (before any removal shifts row indices).
      for (const { rows, item } of metaOnly) {
        for (const i of rows) {
          const metadata = cleanMetadata({ ...this.rows[i].metadata, status: item.status, isDone: item.isDone });
          this.rows[i] = { ...this.rows[i], metadata };
        }
      }
      const replaced = new Set(rebuild.map((r) => r.item.id));
      this.removeWhere((r) => {
        if (r.namespace !== 'workspace' || r.metadata.projectId !== pid) return false;
        const key = typeof r.metadata.wsItemId === 'string' ? r.metadata.wsItemId : `\u0000orphan:${r.id}`;
        return gone.has(key) || replaced.has(key);
      });
      const now = Date.now();
      let embedded = 0;
      for (const { plan } of rebuild) {
        if (plan.some((c) => needHashes.has(c.hash))) embedded++;
        for (const c of plan) {
          this.putRow(
            { id: c.id, namespace: 'workspace', text: c.text, metadata: c.metadata, createdAt: now, hash: c.hash, taskKey: taskKeyOf(c.metadata) },
            vecs.get(c.hash)!
          );
        }
      }
      this.markDirty();
      return {
        success: true,
        embedded,
        removed: [...gone].filter((k) => !k.startsWith('\u0000')).length,
        total: items.size,
        embeddedChunks: need.length,
        updated: metaOnly.length + (rebuild.length - embedded),
      };
    });
  }

  /** Centroid + per-row centering terms of a project's workspace vectors (cached until the store changes). */
  private workspaceCache(projectId: string): WorkspaceProjectCache {
    const hit = this.wsCache.get(projectId);
    if (hit && hit.generation === this.generation) return hit;
    const rows: number[] = [];
    const items = new Set<string>();
    const byHash = new Map<string, number>();
    const centroid = new Float32Array(DIM);
    const vec = this.vectors;
    for (let i = 0; i < this.rows.length; i++) {
      const r = this.rows[i];
      if (r.namespace !== 'workspace' || r.metadata.projectId !== projectId) continue;
      rows.push(i);
      if (typeof r.metadata.wsItemId === 'string') items.add(r.metadata.wsItemId);
      byHash.set(r.hash, i);
      const off = i * DIM;
      for (let d = 0; d < DIM; d++) centroid[d] += vec[off + d];
    }
    if (rows.length > 0) for (let d = 0; d < DIM; d++) centroid[d] /= rows.length;
    let cc = 0;
    for (let d = 0; d < DIM; d++) cc += centroid[d] * centroid[d];
    const xc = new Float64Array(rows.length);
    const nx = new Float64Array(rows.length);
    rows.forEach((i, k) => {
      let dot = 0;
      const off = i * DIM;
      for (let d = 0; d < DIM; d++) dot += vec[off + d] * centroid[d];
      xc[k] = dot;
      nx[k] = Math.sqrt(Math.max(1e-12, 1 - 2 * dot + cc));
    });
    const cache: WorkspaceProjectCache = { generation: this.generation, rows, centroid, cc, xc, nx, byHash, itemCount: items.size };
    if (this.wsCache.size > 32) this.wsCache.clear();
    this.wsCache.set(projectId, cache);
    return cache;
  }

  /**
   * Stage 1 of related-task selection (local, zero tokens). Query vectors: the task's own indexed chunks (or its
   * title), `"<title>: <subtask>"` per subtask (≤ 12) and the extra text. Every vector is centered on the project
   * centroid and renormalized; a candidate scores the MAX over (query × candidate) pairs, z-scored against all
   * candidates of this query. Returns the top `topK` tasks with z ≥ 0.5 (recall first: the Summary LLM picks the
   * useful ones) and up to 3 notes with z ≥ 1.5. Fewer than 5 workspace items: raw cosine ≥ 0.35 instead.
   */
  async relatedTasks(req: RelatedTasksRequest): Promise<RelatedTasksResponse> {
    await this.ensureLoaded();
    const pid = typeof req?.projectId === 'string' ? req.projectId : '';
    const empty: RelatedTasksResponse = { success: true, candidates: [], notes: [], searched: 0 };
    if (!pid) return empty;
    const ownKey = req.taskId === undefined || req.taskId === null ? '' : String(req.taskId);
    const topK = Math.max(1, Math.min(25, Math.floor(Number(req.topK) || 10)));
    const title = cleanWorkspaceText(req.title).slice(0, WS_TITLE_MAX);
    const subs = (Array.isArray(req.subtasks) ? req.subtasks : [])
      .map((s) => cleanWorkspaceText(s).slice(0, WS_SUBTASK_MAX))
      .filter(Boolean)
      .slice(0, RELATED_MAX_QUERY_SUBTASKS);
    const extra = cleanWorkspaceText(req.text).slice(0, RELATED_QUERY_TEXT_MAX);

    // ── Query vectors (stored ones reused; only unseen texts are embedded) ──
    let cache = this.workspaceCache(pid);
    const texts: string[] = [];
    if (ownKey) {
      for (const i of cache.rows) {
        const m = this.rows[i].metadata;
        if (m.wsItemKind === 'task' && m.wsItemId === ownKey) texts.push(this.rows[i].text);
      }
    }
    if (texts.length === 0 && title) texts.push(title);
    if (title) for (const s of subs) texts.push(`${title}: ${s}`);
    if (extra && !texts.some((t) => t.includes(extra.slice(0, 80)))) texts.push(extra);
    const unique = [...new Map(texts.map((t) => [textHash(t), t])).entries()];
    if (unique.length === 0) return empty;
    const queries: Float32Array[] = [];
    const missing: string[] = [];
    for (const [hash, t] of unique) {
      const i = cache.byHash.get(hash);
      if (i !== undefined) queries.push(this.vectorOf(i));
      else missing.push(t);
    }
    if (missing.length > 0) queries.push(...(await embedTexts(missing, true)));
    cache = this.workspaceCache(pid); // the store may have changed while embedding

    // ── Scoring ──
    const rows = this.rows;
    const vec = this.vectors;
    const centered = cache.itemCount >= RELATED_MIN_ITEMS_FOR_CENTERING;
    const { centroid, cc } = cache;
    const Q = queries.length;
    const qc = new Float64Array(Q);
    const nq = new Float64Array(Q);
    for (let k = 0; k < Q; k++) {
      let dot = 0;
      for (let d = 0; d < DIM; d++) dot += queries[k][d] * centroid[d];
      qc[k] = dot;
      nq[k] = Math.sqrt(Math.max(1e-12, 1 - 2 * dot + cc));
    }
    /** Best (centered) similarity of row `i` over all queries. */
    const scoreRow = (i: number, xc: number, nx: number): number => {
      const off = i * DIM;
      let best = -Infinity;
      for (let k = 0; k < Q; k++) {
        const q = queries[k];
        let raw = 0;
        for (let d = 0; d < DIM; d++) raw += q[d] * vec[off + d];
        const s = centered ? (raw - qc[k] - xc + cc) / (nq[k] * nx) : raw;
        if (s > best) best = s;
      }
      return best;
    };

    type Best = { score: number; row: number };
    const taskBest = new Map<string, Best>();
    const noteBest = new Map<string, Best>();
    const itemRows = new Map<string, number[]>();
    const activeTasks = new Set<string>();
    const ownNoteIds = new Set(ownKey ? [ownKey, `note:brief:${ownKey}`] : []);
    cache.rows.forEach((i, k) => {
      const m = rows[i].metadata;
      const itemId = m.wsItemId;
      if (typeof itemId !== 'string') return;
      const list = itemRows.get(itemId);
      if (list) list.push(i);
      else itemRows.set(itemId, [i]);
      const isTask = m.wsItemKind !== 'note';
      if (isTask) activeTasks.add(itemId);
      if (isTask ? itemId === ownKey : ownNoteIds.has(itemId)) return;
      const s = scoreRow(i, cache.xc[k], cache.nx[k]);
      const map = isTask ? taskBest : noteBest;
      const prev = map.get(itemId);
      if (!prev || s > prev.score) map.set(itemId, { score: s, row: i });
    });

    // Completed / archived history (`tasks` namespace), deduped against the active workspace by task id.
    const archiveBest = new Map<string, Best>();
    const archiveRows = new Map<string, number[]>();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.namespace !== 'tasks' || r.metadata.projectId !== pid) continue;
      const key = r.taskKey ?? `chunk:${r.id}`;
      if (key === ownKey || activeTasks.has(key)) continue;
      const list = archiveRows.get(key);
      if (list) list.push(i);
      else archiveRows.set(key, [i]);
      let xc = 0;
      const off = i * DIM;
      for (let d = 0; d < DIM; d++) xc += vec[off + d] * centroid[d];
      const s = scoreRow(i, xc, Math.sqrt(Math.max(1e-12, 1 - 2 * xc + cc)));
      const prev = archiveBest.get(key);
      if (!prev || s > prev.score) archiveBest.set(key, { score: s, row: i });
    }

    const pool: Array<{ key: string; best: Best; source: 'workspace' | 'archive' }> = [
      ...[...taskBest.entries()].map(([key, best]) => ({ key, best, source: 'workspace' as const })),
      ...[...archiveBest.entries()].map(([key, best]) => ({ key, best, source: 'archive' as const })),
    ];
    const n = pool.length;
    const mean = n > 0 ? pool.reduce((a, p) => a + p.best.score, 0) / n : 0;
    const sd = n > 1 ? Math.sqrt(pool.reduce((a, p) => a + (p.best.score - mean) ** 2, 0) / n) || 1 : 1;
    const zOf = (s: number) => (s - mean) / sd;
    const keep = (s: number, minZ: number) => (centered ? zOf(s) >= minZ : s >= RELATED_RAW_MIN_SIMILARITY);
    const round = (x: number) => Math.round(x * 1000) / 1000;

    const chosen = pool
      .filter((p) => keep(p.best.score, RELATED_MIN_Z))
      .sort((a, b) => b.best.score - a.best.score)
      .slice(0, topK);

    // Newest completion record per chosen task (agent-notes, kind completion).
    const wanted = new Set(chosen.map((p) => p.key));
    const newestDoc = new Map<string, { at: number; doc: string }>();
    const docParts = new Map<string, Array<{ part: number; text: string }>>();
    for (const r of rows) {
      if (r.namespace !== 'agent-notes' || r.metadata.kind !== 'completion' || r.taskKey === null || !wanted.has(r.taskKey)) continue;
      if (r.metadata.projectId && r.metadata.projectId !== pid) continue;
      const doc = r.metadata.docId || r.id;
      const parts = docParts.get(doc);
      const entry = { part: r.metadata.part ?? 0, text: r.text };
      if (parts) parts.push(entry);
      else docParts.set(doc, [entry]);
      const prev = newestDoc.get(r.taskKey);
      if (!prev || r.createdAt > prev.at) newestDoc.set(r.taskKey, { at: r.createdAt, doc });
    }
    const completionFor = (key: string): string | undefined => {
      const newest = newestDoc.get(key);
      if (!newest) return undefined;
      const parts = (docParts.get(newest.doc) || []).sort((a, b) => a.part - b.part).map((p) => p.text);
      return completionSummaryOf(parts);
    };

    const candidates: RelatedTaskCandidate[] = chosen.map(({ key, best, source }) => {
      const z = round(zOf(best.score));
      const score = round(best.score);
      if (source === 'workspace') {
        const list = itemRows.get(key) || [best.row];
        const headRow = rows[list.find((i) => (rows[i].metadata.wsPart ?? -1) < 0) ?? list[0]];
        const head = headRow.metadata;
        const itemTitle = head.taskTitle || '';
        const prefix = `${itemTitle}: `;
        const subOf = (i: number) => (rows[i].text.startsWith(prefix) ? rows[i].text.slice(prefix.length) : rows[i].text);
        const subtasks = list
          .filter((i) => (rows[i].metadata.wsPart ?? -1) >= 0)
          .sort((a, b) => (rows[a].metadata.wsPart ?? 0) - (rows[b].metadata.wsPart ?? 0))
          .slice(0, RELATED_SUBTASKS_SHOWN)
          .map((i) => clip(subOf(i), RELATED_SUBTASK_CHARS));
        const bm = rows[best.row].metadata;
        const out: RelatedTaskCandidate = {
          taskId: key,
          title: itemTitle,
          source,
          matchedOn: clip((bm.wsPart ?? -1) >= 0 ? subOf(best.row) : itemTitle, RELATED_SUBTASK_CHARS * 2),
          score,
          z,
        };
        if (head.category) out.category = head.category;
        if (head.status) out.status = head.status;
        if (typeof head.isDone === 'boolean') out.isDone = head.isDone;
        if (subtasks.length) out.subtasks = subtasks;
        // The head chunk embeds "title — summary note" (planWorkspaceChunks).
        const notePrefix = `${itemTitle} — `;
        if (headRow.text.startsWith(notePrefix)) out.summaryNote = clip(headRow.text.slice(notePrefix.length), RELATED_SUMMARY_CHARS);
        const done = completionFor(key);
        if (done) out.completionSummary = done;
        return out;
      }
      const list = archiveRows.get(key) || [best.row];
      const m = rows[list[0]].metadata;
      const firstLine = (t: string) => cleanWorkspaceText(t.split('\n').find((l) => l.trim()) || t);
      let subtasks: string[] = [];
      if (Array.isArray(m.subtasks)) subtasks = m.subtasks.map((s) => cleanWorkspaceText(s?.text)).filter(Boolean);
      else if (typeof m.serializedSubtasks === 'string') {
        try {
          const parsed = JSON.parse(m.serializedSubtasks);
          if (Array.isArray(parsed)) subtasks = parsed.map((s: any) => cleanWorkspaceText(s?.text ?? s)).filter(Boolean);
        } catch {}
      }
      const out: RelatedTaskCandidate = {
        taskId: m.taskId !== undefined ? String(m.taskId) : key,
        title: clip(cleanWorkspaceText(m.taskTitle) || firstLine(rows[list[0]].text), WS_TITLE_MAX),
        source,
        matchedOn: clip(firstLine(rows[best.row].text), RELATED_SUBTASK_CHARS * 2),
        score,
        z,
      };
      if (m.category) out.category = m.category;
      if (m.status) out.status = m.status;
      if (typeof m.isDone === 'boolean') out.isDone = m.isDone;
      if (subtasks.length) out.subtasks = subtasks.slice(0, RELATED_SUBTASKS_SHOWN).map((s) => clip(s, RELATED_SUBTASK_CHARS));
      const done = completionFor(key) || completionSummaryOf(list.map((i) => rows[i].text));
      if (done) out.completionSummary = done;
      return out;
    });

    const notes: RelatedNoteCandidate[] = [...noteBest.entries()]
      .filter(([, best]) => keep(best.score, RELATED_NOTE_MIN_Z))
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, RELATED_NOTES_MAX)
      .map(([id, best]) => ({
        id,
        title: rows[best.row].metadata.taskTitle || 'Notes',
        text: clip(rows[best.row].text, RELATED_QUERY_TEXT_MAX),
        score: round(best.score),
        z: round(zOf(best.score)),
      }));

    return { success: true, candidates, notes, searched: cache.itemCount };
  }

  // ── Learned rules (namespace `insights`) ──

  /** The project's rules: `always` first, then the most confirmed, then the newest. */
  async listInsights(projectId: string): Promise<ProjectInsight[]> {
    await this.ensureLoaded();
    return this.insightRows(projectId)
      .map((i) => insightOf(this.rows[i]))
      .sort(compareInsights);
  }

  /**
   * Applies changes to a project's rule list, in order. The distiller's `add` is checked against the project's rules
   * first (zero tokens): a rule within INSIGHT_DUP_SIMILARITY of an existing one confirms it instead. Ops naming a
   * rule the project doesn't have are skipped. Every change carries the op that reverts it (the app's Undo).
   */
  applyInsightOps(projectId: string, ops: InsightOp[], source: InsightSource): Promise<InsightApplyResponse> {
    return this.mutate(async () => {
      const changes: InsightChange[] = [];
      const now = Date.now();
      const sourceMeta: ChunkMetadata = {
        insightOrigin: source.origin,
        insightUpdatedAt: now,
        ...(source.taskId ? { insightTaskId: source.taskId } : {}),
        ...(source.taskTitle ? { insightTaskTitle: source.taskTitle } : {}),
        ...(source.runId ? { insightRunId: source.runId } : {}),
      };
      const find = (id: string): number | undefined => {
        const i = this.index.get(id);
        return i !== undefined && isInsightOf(this.rows[i], projectId) ? i : undefined;
      };
      const replaceRow = (i: number, row: Row, vector?: Float32Array) => {
        this.rows[i] = row;
        if (vector) this.vectors.set(vector, i * DIM);
        this.markDirty();
      };

      for (const op of ops) {
        if (op.op === 'add') {
          const text = cleanInsightText(op.text);
          if (!text) continue;
          const [v] = await embedTexts([text]);
          let best = -1;
          let bestSim = -Infinity;
          for (const i of this.insightRows(projectId)) {
            let dot = 0;
            const off = i * DIM;
            for (let d = 0; d < DIM; d++) dot += v[d] * this.vectors[off + d];
            if (dot > bestSim) [best, bestSim] = [i, dot];
          }
          if (best >= 0 && bestSim >= INSIGHT_DUP_SIMILARITY) {
            const row = this.rows[best];
            replaceRow(best, { ...row, metadata: { ...row.metadata, insightConfirms: confirmsOf(row) + 1 } });
            changes.push({ kind: 'confirmed', insight: insightOf(this.rows[best]), undo: { op: 'unconfirm', id: row.id } });
            continue;
          }
          if (this.insightRows(projectId).length >= INSIGHTS_PER_PROJECT_MAX) continue;
          const id = `insight:${projectId}:${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
          const metadata: ChunkMetadata = { projectId, insightScope: scopeOf(op.scope), insightConfirms: 1, ...sourceMeta };
          this.putRow({ id, namespace: 'insights', text, metadata, createdAt: now, hash: textHash(text), taskKey: null }, v);
          this.markDirty();
          changes.push({ kind: 'added', insight: insightOf(this.rows[this.index.get(id)!]), undo: { op: 'delete', id } });
        } else if (op.op === 'update' || op.op === 'confirm' || op.op === 'unconfirm') {
          const i = find(op.id);
          if (i === undefined) continue;
          const row = this.rows[i];
          const previous = insightOf(row);
          if (op.op === 'confirm' || op.op === 'unconfirm') {
            const confirms = Math.max(1, confirmsOf(row) + (op.op === 'confirm' ? 1 : -1));
            replaceRow(i, { ...row, metadata: { ...row.metadata, insightConfirms: confirms } });
            if (op.op === 'confirm') changes.push({ kind: 'confirmed', insight: insightOf(this.rows[i]), undo: { op: 'unconfirm', id: row.id } });
            continue;
          }
          const text = op.text === undefined ? row.text : cleanInsightText(op.text);
          if (!text) continue;
          const scope = op.scope ? scopeOf(op.scope) : previous.scope;
          if (text === row.text && scope === previous.scope) continue;
          const vector = text !== row.text ? (await embedTexts([text]))[0] : undefined;
          // Feedback that refines a rule also reinforces it; the user's own edit doesn't count as feedback.
          const confirms = confirmsOf(row) + (source.origin === 'learned' ? 1 : 0);
          const j = find(op.id);
          if (j === undefined) continue;
          replaceRow(
            j,
            { ...row, text, hash: textHash(text), metadata: { ...row.metadata, ...sourceMeta, insightScope: scope, insightConfirms: confirms } },
            vector
          );
          changes.push({ kind: 'updated', insight: insightOf(this.rows[j]), previous, undo: { op: 'put', insight: previous } });
        } else if (op.op === 'delete') {
          const i = find(op.id);
          if (i === undefined) continue;
          const previous = insightOf(this.rows[i]);
          this.removeWhere((r) => r.id === op.id);
          changes.push({ kind: 'deleted', insight: previous, previous, undo: { op: 'put', insight: previous } });
        } else if (op.op === 'put') {
          const ins = op.insight;
          const text = cleanInsightText(ins?.text);
          const id = typeof ins?.id === 'string' ? ins.id : '';
          // Only this project's ids: a put must not take over another project's (or another namespace's) row.
          if (!text || !id.startsWith(`insight:${projectId}:`)) continue;
          const existing = this.index.get(id);
          const previous = existing !== undefined && isInsightOf(this.rows[existing], projectId) ? insightOf(this.rows[existing]) : undefined;
          if (existing !== undefined && !previous) continue;
          const [v] = previous?.text === text ? [this.vectorOf(existing!)] : await embedTexts([text]);
          const metadata: ChunkMetadata = {
            projectId,
            insightScope: scopeOf(ins.scope),
            insightConfirms: Math.max(1, Math.floor(Number(ins.confirms) || 1)),
            insightOrigin: ins.origin === 'user' ? 'user' : 'learned',
            insightUpdatedAt: now,
            ...(ins.taskId ? { insightTaskId: ins.taskId } : {}),
            ...(ins.taskTitle ? { insightTaskTitle: ins.taskTitle } : {}),
          };
          const createdAt = typeof ins.createdAt === 'number' && Number.isFinite(ins.createdAt) ? ins.createdAt : now;
          this.putRow({ id, namespace: 'insights', text, metadata, createdAt, hash: textHash(text), taskKey: null }, v);
          this.markDirty();
          changes.push({
            kind: 'restored',
            insight: insightOf(this.rows[this.index.get(id)!]),
            ...(previous ? { previous } : {}),
            undo: previous ? { op: 'put', insight: previous } : { op: 'delete', id },
          });
        }
      }
      const insights = this.insightRows(projectId).map((i) => insightOf(this.rows[i])).sort(compareInsights);
      return { success: true, changes, insights };
    });
  }

  /**
   * The rules a task's run gets: the whole list while it is small (INSIGHTS_WHOLE_LIST_MAX — tested: recall 1.0 at
   * ~300 tokens), else every `always` rule plus the topical rules nearest the task, with no similarity floor (MiniLM
   * scores short task titles 0.1–0.2 against the rules they need).
   */
  async insightsForTask(projectId: string, query: string): Promise<ProjectInsight[]> {
    await this.ensureLoaded();
    const rows = this.insightRows(projectId);
    if (rows.length <= INSIGHTS_WHOLE_LIST_MAX) return rows.map((i) => insightOf(this.rows[i])).sort(compareInsights);
    const always = rows
      .filter((i) => scopeOf(this.rows[i].metadata.insightScope) === 'always')
      .map((i) => insightOf(this.rows[i]))
      .sort(compareInsights)
      .slice(0, INSIGHTS_ALWAYS_MAX);
    const q = query.trim() ? (await embedTexts([query], true))[0] : null;
    const topical = this.insightRows(projectId)
      .filter((i) => scopeOf(this.rows[i].metadata.insightScope) !== 'always')
      .map((i) => {
        let dot = 0;
        if (q) for (let d = 0, off = i * DIM; d < DIM; d++) dot += q[d] * this.vectors[off + d];
        return { insight: insightOf(this.rows[i]), score: dot };
      })
      .sort((a, b) => b.score - a.score || compareInsights(a.insight, b.insight))
      .slice(0, INSIGHTS_TOPICAL_MAX)
      .map((x) => x.insight);
    return [...always, ...topical];
  }

  /** Row indexes of a project's rules. */
  private insightRows(projectId: string): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.rows.length; i++) if (isInsightOf(this.rows[i], projectId)) out.push(i);
    return out;
  }

  /** Embeddings for arbitrary texts (REST /api/memory/embed). */
  embed(texts: string[]): Promise<Float32Array[]> {
    return embedTexts(texts, true);
  }

  /** Starts loading the store and the model in the background. */
  warm(): void {
    void this.ensureLoaded();
    loadPipeline(this.modelsDir, this.log).catch(() => {});
  }

  status() {
    return { ready: this.loaded, modelLoaded: pipelineLoaded, chunkCount: this.rows.length, storePath: this.dir };
  }
}

// ─── Learned rules (namespace `insights`) ─────────────────────────────────────────────────────────────────────
//
// One row per rule (`insight:<projectId>:<id>`), embedded as its text. The app's distiller (insights.ts) sends
// add / update / delete / confirm ops after the user's feedback on a run; reconciling on every write keeps the list
// small and free of duplicates or superseded rules, so no clean-up pass is ever needed before a run reads it.
// Evaluation (docs/wip/evals/insights): 15 rules for 23 follow-ups, 0 stale, 0 noise; Mem0 kept 20–48 with stale ones.

/** A new rule this close (cosine) to one of the project's rules is that rule restated: it confirms it instead. */
const INSIGHT_DUP_SIMILARITY = 0.9;
/** Up to this many rules, a run gets the project's whole list. */
export const INSIGHTS_WHOLE_LIST_MAX = 25;
/** Beyond it: at most this many `always` rules (most confirmed) plus this many topical rules (nearest the task). */
const INSIGHTS_ALWAYS_MAX = 8;
const INSIGHTS_TOPICAL_MAX = 6;
const INSIGHTS_PER_PROJECT_MAX = 200;
export const INSIGHT_TEXT_MAX = 400;

function isInsightOf(row: Row, projectId: string): boolean {
  return row.namespace === 'insights' && row.metadata.projectId === projectId;
}

function scopeOf(scope: unknown): InsightScope {
  return scope === 'always' ? 'always' : 'topical';
}

function confirmsOf(row: Row): number {
  return Math.max(1, Math.floor(Number(row.metadata.insightConfirms) || 1));
}

function cleanInsightText(text: unknown): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, INSIGHT_TEXT_MAX);
}

function insightOf(row: Row): ProjectInsight {
  const m = row.metadata;
  return {
    id: row.id,
    text: row.text,
    scope: scopeOf(m.insightScope),
    confirms: confirmsOf(row),
    origin: m.insightOrigin === 'user' ? 'user' : 'learned',
    createdAt: row.createdAt,
    updatedAt: typeof m.insightUpdatedAt === 'number' ? m.insightUpdatedAt : row.createdAt,
    ...(m.insightTaskId ? { taskId: String(m.insightTaskId) } : {}),
    ...(m.insightTaskTitle ? { taskTitle: String(m.insightTaskTitle) } : {}),
  };
}

function compareInsights(a: ProjectInsight, b: ProjectInsight): number {
  return (a.scope === 'always' ? 0 : 1) - (b.scope === 'always' ? 0 : 1) || b.confirms - a.confirms || b.updatedAt - a.updatedAt;
}

export function createMemoryStore(opts: MemoryStoreOptions): MemoryStore {
  return new MemoryStore(opts);
}
