/**
 * Local Vector Memory — barrel export.
 *
 * All public APIs for the vector memory client (store and embeddings live in the local bridge) and
 * session retrospective.
 */
export {
  // Vector engine core
  searchMemory,
  addChunks,
  getAllChunks,
  updateChunk,
  upsertCustomChunk,
  deleteChunk,
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
  EMBEDDING_DIM,
  HIDDEN_MEMORY_NAMESPACES,
  isHiddenNamespace,
  // Types
  type MemoryNamespace,
  type MemoryChunk,
  type MemoryChunkDTO,
  type ChunkMetadata,
  type AgentNoteKind,
  type SearchResult,
  type SearchMemoryOptions,
} from './vectorEngine';

export {
  archiveTaskToVectorMemory,
} from './archiveRecords';

export {
  // Workspace index + related tasks (stage 1: local candidates; stage 2 is the Summary step's LLM selection)
  syncWorkspaceIndex,
  findRelatedTasks,
  formatRelatedCandidatesForPrompt,
  formatSelectedRelatedContext,
  relatedStatusLabel,
} from './relatedTasks';

export {
  cleanWorkspaceText,
  type WorkspaceIndexItem,
  type WorkspaceSyncRequest,
  type WorkspaceSyncResponse,
  type RelatedTasksRequest,
  type RelatedTasksResponse,
  type RelatedTaskCandidate,
  type RelatedNoteCandidate,
} from './types';
