/**
 * Local Vector Memory — barrel export.
 *
 * All public APIs for the vector memory engine and session retrospective.
 */
export {
  // Vector engine core
  searchMemory,
  addChunks,
  removeChunksById,
  removeChunksByTaskId,
  removeChunksByProjectId,
  clearProjectMemory,
  clearAllMemory,
  clearNamespace,
  getChunksByNamespace,
  getChunkCount,
  hasChunk,
  embed,
  embedBatch,
  isEmbeddingReady,
  preWarmEmbeddings,
  // Types
  type MemoryNamespace,
  type MemoryChunk,
  type ChunkMetadata,
  type SearchResult,
  type SearchMemoryOptions,
} from './vectorEngine';

export {
  // Session retrospective
  runSessionRetrospective,
  migrateAgentContextToMemory,
  // Types
  type Learning,
  type LearningCategory,
  type RetrospectiveInput,
} from './sessionRetrospective';
