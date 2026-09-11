/**
 * Local Vector Memory Engine — Zero-token, in-browser semantic search.
 *
 * Uses @huggingface/transformers (WASM/ONNX) to generate 384-dim embeddings
 * from `all-MiniLM-L6-v2` and stores them in IndexedDB for persistence across
 * sessions. Replaces the monolithic AGENT_CONTEXT.md dump with a queryable,
 * namespace-partitioned vector store.
 *
 * Namespaces:
 *   - `learnings`  — Durable project knowledge (architectural decisions, gotchas, patterns)
 *   - `tasks`      — Completed task summaries and acceptance criteria
 *   - `code-map`   — High-level file/component index (future)
 *
 * All operations are local, zero API-token cost, and async-safe.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type MemoryNamespace = 'learnings' | 'tasks' | 'code-map';

export interface MemoryChunk {
  id: string;
  namespace: MemoryNamespace;
  text: string;
  embedding: Float32Array;
  metadata: ChunkMetadata;
  createdAt: number;
}

export interface ChunkMetadata {
  taskId?: string | number;
  taskTitle?: string;
  category?: string;
  projectId?: string;
  /** Free-form tags for filtering (e.g. 'architecture', 'gotcha', 'pattern') */
  tags?: string[];
  /** Source of the chunk (e.g. 'session-retrospective', 'migration', 'manual') */
  source?: string;
}

export interface SearchResult {
  chunk: MemoryChunk;
  similarity: number;
}

/** Serializable form for IndexedDB storage (Float32Array → number[]). */
interface StoredChunk {
  id: string;
  namespace: MemoryNamespace;
  text: string;
  embedding: number[];
  metadata: ChunkMetadata;
  createdAt: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DB_NAME = 'ergo-vector-memory';
const DB_VERSION = 1;
const STORE_NAME = 'chunks';
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const EMBEDDING_DIM = 384;

// ─── Embedding Pipeline (lazy singleton) ────────────────────────────────────

let pipelinePromise: Promise<any> | null = null;
let pipelineReady = false;

/**
 * Lazily initializes the embedding pipeline. The ONNX/WASM model is downloaded
 * and cached by the browser on first use (~25MB). Subsequent loads are instant.
 */
async function getEmbeddingPipeline(): Promise<any> {
  if (pipelinePromise) return pipelinePromise;

  pipelinePromise = (async () => {
    try {
      // Dynamic import so the ~2MB transformers.js bundle is only loaded when needed
      const { pipeline, env } = await import('@huggingface/transformers');

      // Use WASM backend (no WebGPU required, works everywhere)
      env.backends.onnx.wasm.numThreads = 1;

      const pipe = await pipeline('feature-extraction', MODEL_ID, {
        dtype: 'fp32',
        device: 'wasm',
      });
      pipelineReady = true;
      console.log('[VectorEngine] Embedding pipeline ready (all-MiniLM-L6-v2, 384-dim, WASM)');
      return pipe;
    } catch (err) {
      pipelinePromise = null;
      console.error('[VectorEngine] Failed to initialize embedding pipeline:', err);
      throw err;
    }
  })();

  return pipelinePromise;
}

/** Returns true if the embedding model has been loaded and is ready. */
export function isEmbeddingReady(): boolean {
  return pipelineReady;
}

/**
 * Generate a 384-dim embedding for a text string.
 * Returns null if the pipeline is not available (graceful degradation).
 */
export async function embed(text: string): Promise<Float32Array | null> {
  try {
    const pipe = await getEmbeddingPipeline();
    const output = await pipe(text, { pooling: 'mean', normalize: true });
    // output.data is a Float32Array of shape [1, 384]
    return new Float32Array(output.data);
  } catch (err) {
    console.warn('[VectorEngine] Embedding failed, returning null:', err);
    return null;
  }
}

/**
 * Batch-embed multiple texts. More efficient than calling embed() in a loop
 * because the pipeline can batch internally.
 */
export async function embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
  if (texts.length === 0) return [];
  try {
    const pipe = await getEmbeddingPipeline();
    const results: (Float32Array | null)[] = [];
    // Process sequentially to avoid WASM memory pressure in-browser
    for (const text of texts) {
      const output = await pipe(text, { pooling: 'mean', normalize: true });
      results.push(new Float32Array(output.data));
    }
    return results;
  } catch (err) {
    console.warn('[VectorEngine] Batch embedding failed:', err);
    return texts.map(() => null);
  }
}

// ─── Cosine Similarity ──────────────────────────────────────────────────────

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── IndexedDB Persistence ──────────────────────────────────────────────────

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      return reject(new Error('IndexedDB is not supported'));
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('namespace', 'namespace', { unique: false });
        store.createIndex('taskId', 'metadata.taskId', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function toStored(chunk: MemoryChunk): StoredChunk {
  return {
    ...chunk,
    embedding: Array.from(chunk.embedding),
  };
}

function fromStored(stored: StoredChunk): MemoryChunk {
  return {
    ...stored,
    embedding: new Float32Array(stored.embedding),
  };
}

// ─── In-Memory Cache ────────────────────────────────────────────────────────

/** In-memory cache of all chunks, loaded from IndexedDB on first access. */
let memoryCache: MemoryChunk[] | null = null;
let cacheLoadPromise: Promise<void> | null = null;

async function ensureCacheLoaded(): Promise<MemoryChunk[]> {
  if (memoryCache !== null) return memoryCache;
  if (cacheLoadPromise) {
    await cacheLoadPromise;
    return memoryCache!;
  }

  cacheLoadPromise = (async () => {
    try {
      const db = await openDb();
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const all: StoredChunk[] = await new Promise((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      memoryCache = all.map(fromStored);
      console.log(`[VectorEngine] Loaded ${memoryCache.length} chunks from IndexedDB`);
    } catch (err) {
      console.warn('[VectorEngine] Failed to load from IndexedDB, starting empty:', err);
      memoryCache = [];
    }
  })();

  await cacheLoadPromise;
  return memoryCache!;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Add one or more text chunks to the vector memory store.
 * Each chunk is embedded, stored in IndexedDB, and added to the in-memory cache.
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

  const cache = await ensureCacheLoaded();
  const texts = chunks.map((c) => c.text);
  const embeddings = await embedBatch(texts);

  const newChunks: MemoryChunk[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const emb = embeddings[i];
    if (!emb) continue; // Skip chunks that failed to embed

    const chunk: MemoryChunk = {
      id: chunks[i].id,
      namespace: chunks[i].namespace,
      text: chunks[i].text,
      embedding: emb,
      metadata: chunks[i].metadata || {},
      createdAt: Date.now(),
    };
    newChunks.push(chunk);
  }

  if (newChunks.length === 0) return 0;

  // Persist to IndexedDB
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    for (const chunk of newChunks) {
      store.put(toStored(chunk));
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('[VectorEngine] IndexedDB write failed (chunks cached in memory only):', err);
  }

  // Update in-memory cache (replace existing by id, append new)
  const existingIds = new Set(cache.map((c) => c.id));
  for (const chunk of newChunks) {
    if (existingIds.has(chunk.id)) {
      const idx = cache.findIndex((c) => c.id === chunk.id);
      if (idx >= 0) cache[idx] = chunk;
    } else {
      cache.push(chunk);
    }
  }

  console.log(`[VectorEngine] Added ${newChunks.length} chunks (${chunks[0].namespace})`);
  return newChunks.length;
}

/**
 * Semantic search across the vector memory store.
 *
 * @param query - Natural language search query
 * @param namespace - Optional namespace filter (e.g. 'learnings', 'tasks')
 * @param topK - Maximum number of results to return (default: 5)
 * @param minSimilarity - Minimum cosine similarity threshold (default: 0.3)
 * @returns Sorted array of search results with similarity scores
 */
export async function searchMemory(
  query: string,
  namespace?: MemoryNamespace,
  topK = 5,
  minSimilarity = 0.3
): Promise<SearchResult[]> {
  const cache = await ensureCacheLoaded();
  if (cache.length === 0) return [];

  const queryEmb = await embed(query);
  if (!queryEmb) return [];

  const candidates = namespace ? cache.filter((c) => c.namespace === namespace) : cache;

  const scored: SearchResult[] = [];
  for (const chunk of candidates) {
    const sim = cosineSimilarity(queryEmb, chunk.embedding);
    if (sim >= minSimilarity) {
      scored.push({ chunk, similarity: sim });
    }
  }

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, topK);
}

/**
 * Remove chunks by ID(s).
 */
export async function removeChunksById(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;

  const cache = await ensureCacheLoaded();
  const idSet = new Set(ids);
  const before = cache.length;

  // Remove from cache
  memoryCache = cache.filter((c) => !idSet.has(c.id));

  // Remove from IndexedDB
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    for (const id of ids) {
      store.delete(id);
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('[VectorEngine] IndexedDB delete failed:', err);
  }

  const removed = before - memoryCache.length;
  if (removed > 0) console.log(`[VectorEngine] Removed ${removed} chunks`);
  return removed;
}

/**
 * Remove all chunks associated with a specific task ID.
 */
export async function removeChunksByTaskId(taskId: string | number): Promise<number> {
  const cache = await ensureCacheLoaded();
  const matchingIds = cache
    .filter((c) => c.metadata.taskId != null && String(c.metadata.taskId) === String(taskId))
    .map((c) => c.id);
  return removeChunksById(matchingIds);
}

/**
 * Remove all chunks in a namespace.
 */
export async function clearNamespace(namespace: MemoryNamespace): Promise<number> {
  const cache = await ensureCacheLoaded();
  const matchingIds = cache.filter((c) => c.namespace === namespace).map((c) => c.id);
  return removeChunksById(matchingIds);
}

/**
 * Get all chunks in a namespace (for display/inspection without search).
 */
export async function getChunksByNamespace(namespace: MemoryNamespace): Promise<MemoryChunk[]> {
  const cache = await ensureCacheLoaded();
  return cache.filter((c) => c.namespace === namespace);
}

/**
 * Get total chunk count, optionally filtered by namespace.
 */
export async function getChunkCount(namespace?: MemoryNamespace): Promise<number> {
  const cache = await ensureCacheLoaded();
  return namespace ? cache.filter((c) => c.namespace === namespace).length : cache.length;
}

/**
 * Check if a chunk with a given ID already exists.
 */
export async function hasChunk(id: string): Promise<boolean> {
  const cache = await ensureCacheLoaded();
  return cache.some((c) => c.id === id);
}

/**
 * Pre-warm the embedding model in the background.
 * Call this early (e.g. on app mount) so the model is ready when the first
 * task execution starts. Non-blocking; failures are silently logged.
 */
export function preWarmEmbeddings(): void {
  getEmbeddingPipeline().catch((err) => {
    console.warn('[VectorEngine] Pre-warm failed (will retry on first use):', err);
  });
}
