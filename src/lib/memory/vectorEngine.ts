/**
 * Vector Memory client — semantic project memory, stored and searched by the local Ergo bridge.
 *
 * The vector store lives on disk next to the bridge (`<storage root>/.ergo/memory/`, see memoryStore.ts) and
 * embeddings are computed there (all-MiniLM-L6-v2, 384-dim). This module is a thin REST client with the
 * same API the in-browser engine had, so the page never loads the model or holds every vector in memory.
 *
 * Namespaces: see ./types. `agent-notes` (the AI's own working memory) is hidden from searches and listings
 * that don't name a namespace unless `includeHidden` is set — the archive UI never sees it, agents do.
 *
 * Legacy data: chunks the old in-browser engine left in IndexedDB are imported into the bridge once
 * (with their embeddings), then the IndexedDB database is deleted. See ensureMigrated().
 */

import { bridgeClient } from '../bridgeClient';
import {
  HIDDEN_MEMORY_NAMESPACES,
  type AgentNoteKind,
  type ChunkMetadata,
  type MemoryChunkDTO,
  type MemoryNamespace,
  type MemorySearchRequest,
} from './types';

export {
  HIDDEN_MEMORY_NAMESPACES,
  type AgentNoteKind,
  type ChunkMetadata,
  type MemoryChunkDTO,
  type MemoryNamespace,
  type MemorySearchRequest,
} from './types';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MemoryChunk {
  id: string;
  namespace: MemoryNamespace;
  text: string;
  /**
   * The first few embedding dimensions only (for inspection); the full vector stays on the bridge.
   * Use `embeddingDim` for the real dimension.
   */
  embedding: Float32Array;
  /** Dimension of the stored embedding (384). */
  embeddingDim?: number;
  metadata: ChunkMetadata;
  createdAt: number;
}

export interface SearchResult {
  chunk: MemoryChunk;
  similarity: number;
}

export interface SearchMemoryOptions {
  namespace?: MemoryNamespace;
  namespaces?: MemoryNamespace[];
  topK?: number;
  minSimilarity?: number;
  projectId?: string;
  excludeTaskId?: string | number;
  taskId?: string | number;
  runId?: string;
  kinds?: AgentNoteKind[];
  /** Include AI-only namespaces (agent-notes) when no namespace is given. Default false. */
  includeHidden?: boolean;
}

export const EMBEDDING_DIM = 384;

export function isHiddenNamespace(namespace: string | undefined): boolean {
  return Boolean(namespace) && (HIDDEN_MEMORY_NAMESPACES as readonly string[]).includes(namespace as string);
}

// ─── REST plumbing ──────────────────────────────────────────────────────────

class MemoryBridgeError extends Error {}

async function memoryRequest<T>(endpoint: string, body?: unknown): Promise<T> {
  await ensureMigrated();
  return rawMemoryRequest<T>(endpoint, body);
}

/** One JSON request to the bridge's memory API; throws on network / HTTP / `success: false`. */
async function rawMemoryRequest<T>(endpoint: string, body?: unknown): Promise<T> {
  const init: RequestInit = body === undefined
    ? { method: 'GET' }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const res = await bridgeClient.fetch(endpoint, init);
  const json = (await res.json().catch(() => null)) as (T & { success?: boolean; error?: string }) | null;
  if (!res.ok || !json || json.success === false) {
    throw new MemoryBridgeError(json?.error || `${endpoint} failed (HTTP ${res.status})`);
  }
  return json;
}

function query(params: Record<string, string | undefined | false>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === false || v === '') continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

function fromDto(dto: MemoryChunkDTO): MemoryChunk {
  const preview = Array.isArray(dto.embeddingPreview) ? dto.embeddingPreview : [];
  return {
    id: dto.id,
    namespace: dto.namespace,
    text: dto.text,
    embedding: Float32Array.from(preview),
    embeddingDim: typeof dto.embeddingDim === 'number' ? dto.embeddingDim : undefined,
    metadata: dto.metadata || {},
    createdAt: dto.createdAt,
  };
}

function warn(op: string, err: unknown): void {
  console.warn(`[VectorMemory] ${op} failed:`, err instanceof Error ? err.message : err);
}

// ─── Embedding status ───────────────────────────────────────────────────────

let modelLoaded = false;

/** True once the bridge reports its embedding model loaded (or an embedding / search came back). */
export function isEmbeddingReady(): boolean {
  return modelLoaded;
}

/**
 * Generate a 384-dim embedding for a text string (computed by the bridge).
 * Returns null if the bridge is unavailable (graceful degradation).
 */
export async function embed(text: string): Promise<Float32Array | null> {
  const [first] = await embedBatch([text]);
  return first ?? null;
}

/** Batch-embed multiple texts on the bridge. */
export async function embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
  if (texts.length === 0) return [];
  try {
    const json = await memoryRequest<{ embeddings: number[][] }>('/api/memory/embed', { texts });
    modelLoaded = true;
    return texts.map((_, i) => (Array.isArray(json.embeddings?.[i]) ? Float32Array.from(json.embeddings[i]) : null));
  } catch (err) {
    warn('embed', err);
    return texts.map(() => null);
  }
}

/**
 * Ask the bridge to load its embedding model in the background, and start the one-time IndexedDB
 * migration. Non-blocking; failures are logged.
 */
export function preWarmEmbeddings(): void {
  void ensureMigrated();
  void rawMemoryRequest<{ modelLoaded?: boolean; ready?: boolean }>('/api/memory/status?warm=1')
    .then((s) => {
      if (s.modelLoaded) modelLoaded = true;
    })
    .catch((err) => warn('pre-warm', err));
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Add (or replace, by id) one or more text chunks. The bridge embeds and stores them.
 * Returns the number stored (0 when the bridge is unavailable).
 */
export async function addChunks(
  chunks: Array<{
    id: string;
    namespace: MemoryNamespace;
    text: string;
    metadata?: ChunkMetadata;
  }>
): Promise<number> {
  if (chunks.length === 0) return 0;
  try {
    const json = await memoryRequest<{ added: number }>('/api/memory/add', {
      chunks: chunks.map((c) => ({ id: c.id, namespace: c.namespace, text: c.text, metadata: c.metadata || {} })),
    });
    return Number(json.added) || 0;
  } catch (err) {
    warn('addChunks', err);
    return 0;
  }
}

/**
 * Semantic search across the vector memory store.
 *
 * Supports both positional arguments and an options object:
 *   searchMemory(query, { namespace, topK, minSimilarity, projectId, excludeTaskId, includeHidden, … })
 *   searchMemory(query, namespace, topK, minSimilarity, projectId, excludeTaskId)
 *
 * Without a namespace, AI-only namespaces (agent-notes) are excluded unless `includeHidden` is true.
 * Returns [] when the bridge is unavailable.
 */
export async function searchMemory(
  queryText: string,
  namespaceOrOptions?: MemoryNamespace | SearchMemoryOptions,
  topK = 5,
  minSimilarity = 0.3,
  projectId?: string,
  excludeTaskId?: string | number
): Promise<SearchResult[]> {
  const request: MemorySearchRequest =
    typeof namespaceOrOptions === 'object' && namespaceOrOptions !== null
      ? {
          query: queryText,
          namespace: namespaceOrOptions.namespace,
          namespaces: namespaceOrOptions.namespaces,
          topK: namespaceOrOptions.topK ?? 5,
          minSimilarity: namespaceOrOptions.minSimilarity ?? 0.3,
          projectId: namespaceOrOptions.projectId,
          excludeTaskId: namespaceOrOptions.excludeTaskId,
          taskId: namespaceOrOptions.taskId,
          runId: namespaceOrOptions.runId,
          kinds: namespaceOrOptions.kinds,
          includeHidden: namespaceOrOptions.includeHidden ?? false,
        }
      : {
          query: queryText,
          namespace: namespaceOrOptions,
          topK,
          minSimilarity,
          projectId,
          excludeTaskId,
          includeHidden: false,
        };
  if (!request.query || !request.query.trim()) return [];
  // Drop undefined keys so the bridge sees only the filters actually set.
  for (const key of Object.keys(request) as Array<keyof MemorySearchRequest>) {
    if (request[key] === undefined) delete request[key];
  }
  try {
    const json = await memoryRequest<{ results: Array<{ chunk: MemoryChunkDTO; similarity: number }> }>(
      '/api/memory/search',
      request
    );
    modelLoaded = true;
    return (json.results || []).map((r) => ({ chunk: fromDto(r.chunk), similarity: r.similarity }));
  } catch (err) {
    warn('searchMemory', err);
    return [];
  }
}

async function removeWhere(body: Record<string, unknown>): Promise<number> {
  try {
    const json = await memoryRequest<{ removed: number }>('/api/memory/remove', body);
    return Number(json.removed) || 0;
  } catch (err) {
    warn('remove', err);
    return 0;
  }
}

/** Remove chunks by ID(s). */
export async function removeChunksById(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  return removeWhere({ ids });
}

/** Remove all chunks associated with a specific task ID, optionally scoped to a project. */
export async function removeChunksByTaskId(taskId: string | number, projectId?: string): Promise<number> {
  return removeWhere({ taskId: String(taskId), ...(projectId ? { projectId } : {}) });
}

/** Remove all chunks associated with a specific project ID. */
export async function removeChunksByProjectId(projectId: string): Promise<number> {
  if (!projectId) return 0;
  return removeWhere({ projectId });
}

/** Clear all chunks belonging to a project (convenience alias). */
export async function clearProjectMemory(projectId: string): Promise<number> {
  return removeChunksByProjectId(projectId);
}

/** Remove all chunks across all namespaces and projects (full reset). */
export async function clearAllMemory(): Promise<number> {
  return removeWhere({ all: true });
}

/** Remove all chunks in a namespace. */
export async function clearNamespace(namespace: MemoryNamespace): Promise<number> {
  return removeWhere({ namespace });
}

async function listChunks(params: { namespace?: MemoryNamespace; projectId?: string; includeHidden?: boolean }): Promise<MemoryChunk[]> {
  try {
    const json = await memoryRequest<{ chunks: MemoryChunkDTO[] }>(
      `/api/memory/chunks${query({ namespace: params.namespace, projectId: params.projectId, includeHidden: params.includeHidden ? '1' : undefined })}`
    );
    let chunks = (json.chunks || []).map(fromDto);
    // Belt and braces: never hand AI-only chunks to a caller that didn't ask for them.
    if (!params.namespace && !params.includeHidden) chunks = chunks.filter((c) => !isHiddenNamespace(c.namespace));
    return chunks;
  } catch (err) {
    warn('list chunks', err);
    return [];
  }
}

/** Get all chunks in a namespace (for display/inspection without search). */
export async function getChunksByNamespace(namespace: MemoryNamespace, projectId?: string): Promise<MemoryChunk[]> {
  return listChunks({ namespace, projectId });
}

/** Get the chunk count, optionally filtered by namespace and project (hidden namespaces excluded unless asked). */
export async function getChunkCount(
  namespace?: MemoryNamespace,
  projectId?: string,
  options: { includeHidden?: boolean } = {}
): Promise<number> {
  try {
    const json = await memoryRequest<{ count: number }>(
      `/api/memory/count${query({ namespace, projectId, includeHidden: options.includeHidden ? '1' : undefined })}`
    );
    return Number(json.count) || 0;
  } catch (err) {
    warn('getChunkCount', err);
    return 0;
  }
}

/** Check if a chunk with a given ID already exists. */
export async function hasChunk(id: string): Promise<boolean> {
  try {
    const json = await memoryRequest<{ exists: boolean }>(`/api/memory/has${query({ id })}`);
    return Boolean(json.exists);
  } catch (err) {
    warn('hasChunk', err);
    return false;
  }
}

/**
 * Get all chunks (newest first), optionally filtered by project. AI-only namespaces are excluded
 * unless `options.includeHidden` is true.
 */
export async function getAllChunks(projectId?: string, options: { includeHidden?: boolean } = {}): Promise<MemoryChunk[]> {
  const chunks = await listChunks({ projectId, includeHidden: options.includeHidden });
  return chunks.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Update a chunk's text, namespace, or metadata (metadata is merged). The bridge re-embeds when the
 * text changed. Returns null when the chunk doesn't exist or the bridge is unavailable.
 */
export async function updateChunk(
  id: string,
  updates: {
    text?: string;
    namespace?: MemoryNamespace;
    metadata?: Partial<ChunkMetadata>;
  }
): Promise<MemoryChunk | null> {
  try {
    const json = await memoryRequest<{ chunk: MemoryChunkDTO | null }>('/api/memory/update', {
      id,
      ...(updates.text !== undefined ? { text: updates.text.trim() } : {}),
      ...(updates.namespace ? { namespace: updates.namespace } : {}),
      ...(updates.metadata ? { metadata: updates.metadata } : {}),
    });
    return json.chunk ? fromDto(json.chunk) : null;
  } catch (err) {
    warn('updateChunk', err);
    return null;
  }
}

/** Add or overwrite a custom chunk. Returns the stored chunk, or null when nothing was stored. */
export async function upsertCustomChunk(input: {
  id?: string;
  text: string;
  namespace?: MemoryNamespace;
  metadata?: ChunkMetadata;
}): Promise<MemoryChunk | null> {
  const text = input.text.trim();
  if (!text) return null;

  const chunkId = input.id || `custom_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const namespace = input.namespace || 'learnings';
  const metadata: ChunkMetadata = {
    ...input.metadata,
    source: input.metadata?.source || 'user-custom',
  };

  const added = await addChunks([{ id: chunkId, namespace, text, metadata }]);
  if (added === 0) return null;

  // An update without changes returns the stored chunk (with its createdAt and embedding preview).
  const stored = await updateChunk(chunkId, {});
  return stored ?? { id: chunkId, namespace, text, embedding: new Float32Array(0), embeddingDim: EMBEDDING_DIM, metadata, createdAt: Date.now() };
}

/** Delete a single chunk by ID. */
export async function deleteChunk(id: string): Promise<boolean> {
  return (await removeChunksById([id])) > 0;
}

// ─── One-time migration from the old in-browser store (IndexedDB) ───────────

const LEGACY_DB_NAME = 'ergo-vector-memory';
const LEGACY_STORE_NAME = 'chunks';
export const MIGRATION_FLAG_KEY = 'ergo_memory_migrated_v1';
export const MIGRATION_BATCH_SIZE = 200;
/** After a failed attempt (e.g. bridge offline), memory calls go ahead unmigrated and retry after this long. */
const MIGRATION_RETRY_MS = 60_000;

/** A chunk as the old engine stored it in IndexedDB. */
export interface LegacyStoredChunk {
  id: string;
  namespace: MemoryNamespace;
  text: string;
  embedding?: ArrayLike<number> | null;
  metadata?: ChunkMetadata;
  createdAt?: number;
}

export interface LegacyImportChunk {
  id: string;
  namespace: MemoryNamespace;
  text: string;
  metadata: ChunkMetadata;
  createdAt: number;
  embedding?: number[];
}

export interface MigrationDeps {
  isDone(): boolean;
  markDone(): void;
  /** All legacy chunks; [] when there is no legacy database. */
  readAll(): Promise<LegacyStoredChunk[]>;
  /** POST one batch to /api/memory/import; resolves true on success. */
  importBatch(chunks: LegacyImportChunk[]): Promise<boolean>;
  deleteLegacyDb(): Promise<void>;
  batchSize?: number;
}

export type MigrationOutcome = 'already-done' | 'nothing-to-migrate' | 'migrated' | 'failed';

function toImportChunk(c: LegacyStoredChunk): LegacyImportChunk | null {
  if (!c || typeof c.id !== 'string' || typeof c.text !== 'string') return null;
  const emb = c.embedding && typeof c.embedding.length === 'number' && c.embedding.length === EMBEDDING_DIM
    ? Array.from(c.embedding)
    : undefined;
  return {
    id: c.id,
    namespace: c.namespace || 'learnings',
    text: c.text,
    metadata: { ...(c.metadata || {}) },
    createdAt: typeof c.createdAt === 'number' ? c.createdAt : Date.now(),
    ...(emb ? { embedding: emb } : {}),
  };
}

/**
 * Move legacy chunks to the bridge in batches. The flag is set and the legacy database deleted only when
 * every batch was accepted; otherwise the data stays for the next attempt (import upserts by id, so a
 * retry after a partial import is harmless).
 */
export async function migrateLegacyChunks(deps: MigrationDeps): Promise<MigrationOutcome> {
  if (deps.isDone()) return 'already-done';
  let legacy: LegacyStoredChunk[];
  try {
    legacy = await deps.readAll();
  } catch (err) {
    warn('reading legacy IndexedDB memory', err);
    return 'failed';
  }
  const chunks = legacy.map(toImportChunk).filter((c): c is LegacyImportChunk => c !== null);
  if (chunks.length > 0) {
    const size = Math.max(1, deps.batchSize ?? MIGRATION_BATCH_SIZE);
    for (let i = 0; i < chunks.length; i += size) {
      let ok = false;
      try {
        ok = await deps.importBatch(chunks.slice(i, i + size));
      } catch (err) {
        warn('importing legacy memory', err);
      }
      if (!ok) return 'failed';
    }
  }
  deps.markDone();
  try {
    await deps.deleteLegacyDb();
  } catch (err) {
    warn('deleting legacy IndexedDB memory', err);
  }
  return chunks.length > 0 ? 'migrated' : 'nothing-to-migrate';
}

function readLegacyChunks(): Promise<LegacyStoredChunk[]> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return resolve([]);
    // No version: opens whatever exists. If nothing exists, abort the creation instead of making an empty DB.
    const request = indexedDB.open(LEGACY_DB_NAME);
    let created = false;
    request.onupgradeneeded = () => {
      created = true;
      request.transaction?.abort();
    };
    request.onerror = () => {
      if (created) resolve([]);
      else reject(request.error);
    };
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(LEGACY_STORE_NAME)) {
        db.close();
        return resolve([]);
      }
      try {
        const req = db.transaction(LEGACY_STORE_NAME, 'readonly').objectStore(LEGACY_STORE_NAME).getAll();
        req.onsuccess = () => {
          db.close();
          resolve((req.result || []) as LegacyStoredChunk[]);
        };
        req.onerror = () => {
          db.close();
          reject(req.error);
        };
      } catch (err) {
        db.close();
        reject(err);
      }
    };
  });
}

function deleteLegacyDb(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve();
    const req = indexedDB.deleteDatabase(LEGACY_DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    // Another tab still holds it open: deletion completes once that tab closes it. Don't wait for that.
    req.onblocked = () => resolve();
  });
}

function readFlag(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(MIGRATION_FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

function writeFlag(): void {
  try {
    localStorage.setItem(MIGRATION_FLAG_KEY, '1');
  } catch {}
}

let migrationPromise: Promise<void> | null = null;
let migrationRetryAt = 0;

/**
 * Runs the legacy migration once per page load (memory calls await it). After a failure, calls proceed
 * without waiting and the migration is retried on a later call.
 */
function ensureMigrated(): Promise<void> {
  if (migrationPromise) return migrationPromise;
  if (Date.now() < migrationRetryAt) return Promise.resolve();
  migrationPromise = migrateLegacyChunks({
    isDone: readFlag,
    markDone: writeFlag,
    readAll: readLegacyChunks,
    importBatch: async (chunks) => {
      const json = await rawMemoryRequest<{ imported: number }>('/api/memory/import', { chunks });
      return Boolean(json);
    },
    deleteLegacyDb,
  }).then((outcome) => {
    if (outcome === 'migrated') console.log('[VectorMemory] Moved browser vector memory to the Ergo bridge.');
    if (outcome === 'failed') {
      migrationPromise = null;
      migrationRetryAt = Date.now() + MIGRATION_RETRY_MS;
    }
  });
  return migrationPromise;
}
