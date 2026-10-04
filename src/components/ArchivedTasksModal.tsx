import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  Brain,
  X,
  Search,
  Sparkles,
  Trash2,
  Edit3,
  Save,
  RotateCcw,
  Copy,
  Check,
  Plus,
  Cpu,
  RefreshCw,
  AlertTriangle,
  Folder,
  Layers,
  ChevronDown,
  Tag,
  CheckCircle2,
  FileCode,
  Clock,
  Filter
} from 'lucide-react';
import {
  type MemoryChunk,
  type MemoryNamespace,
  type SearchResult,
  getAllChunks,
  searchMemory,
  updateChunk,
  upsertCustomChunk,
  deleteChunk,
  clearProjectMemory,
  EMBEDDING_DIM
} from '../lib/memory';
import { type TaskItem, type SwimLaneDoc, type AgentContextItem } from '../types';
import { MarkdownRenderer } from './MarkdownRenderer';

interface ArchivedTasksModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId?: string;
  projectName?: string;
  archivedTasks?: TaskItem[];
  swimLanes?: SwimLaneDoc[];
  briefs?: AgentContextItem[];
  archivedBriefs?: AgentContextItem[];
  onUnarchiveTask?: (taskId: string | number) => void;
  onDeleteArchivedTask?: (taskId: string | number) => void;
  onRestoreMemoryAsTask?: (chunk: MemoryChunk) => void;
}

export const ArchivedTasksModal: React.FC<ArchivedTasksModalProps> = ({
  isOpen,
  onClose,
  projectId = 'default-workspace',
  projectName = 'Current Project',
  onUnarchiveTask,
  onRestoreMemoryAsTask,
}) => {
  const [chunks, setChunks] = useState<MemoryChunk[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMode, setSearchMode] = useState<'semantic' | 'text'>('semantic');
  const [semanticResults, setSemanticResults] = useState<SearchResult[]>([]);
  const [isSearchingSemantic, setIsSearchingSemantic] = useState(false);

  // Filters
  const [activeNamespace, setActiveNamespace] = useState<'all' | MemoryNamespace>('all');
  const [projectScope, setProjectScope] = useState<'active' | 'all'>('active');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');

  // Inline editing state
  const [editingChunkId, setEditingChunkId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [editNamespace, setEditNamespace] = useState<MemoryNamespace>('learnings');
  const [editCategory, setEditCategory] = useState('general');
  const [editTags, setEditTags] = useState('');
  const [isSavingEdit, setIsSavingEdit] = useState(false);

  // Create new chunk drawer
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [newText, setNewText] = useState('');
  const [newNamespace, setNewNamespace] = useState<MemoryNamespace>('learnings');
  const [newCategory, setNewCategory] = useState('architecture');
  const [newTags, setNewTags] = useState('');
  const [isSubmittingNew, setIsSubmittingNew] = useState(false);

  // Delete modal state
  const [chunkToDelete, setChunkToDelete] = useState<MemoryChunk | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Clipboard copy feedback
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Expanded technical details per chunk
  const [expandedDetails, setExpandedDetails] = useState<Record<string, boolean>>({});

  // ── Load All Chunks ─────────────────────────────────────────────────────────
  const refreshChunks = useCallback(async () => {
    setIsLoading(true);
    try {
      const all = await getAllChunks();
      setChunks(all);
    } catch (err) {
      console.warn('[ArchivedTasksModal] Failed to load vector chunks:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      void refreshChunks();
    }
  }, [isOpen, refreshChunks]);

  // ── Semantic Search Debounce ────────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen || searchMode !== 'semantic') {
      setSemanticResults([]);
      setIsSearchingSemantic(false);
      return;
    }

    const trimmed = searchQuery.trim();
    if (!trimmed) {
      setSemanticResults([]);
      setIsSearchingSemantic(false);
      return;
    }

    setIsSearchingSemantic(true);
    const timer = setTimeout(async () => {
      try {
        const results = await searchMemory(trimmed, {
          topK: 40,
          minSimilarity: 0.15,
          projectId: projectScope === 'active' ? projectId : undefined,
          namespace: activeNamespace !== 'all' ? activeNamespace : undefined,
        });
        setSemanticResults(results);
      } catch (err) {
        console.warn('[ArchivedTasksModal] Semantic query failed:', err);
        setSemanticResults([]);
      } finally {
        setIsSearchingSemantic(false);
      }
    }, 280);

    return () => clearTimeout(timer);
  }, [isOpen, searchQuery, searchMode, projectScope, projectId, activeNamespace]);

  // ── Filtered Chunks List ───────────────────────────────────────────────────
  const displayedChunks = useMemo(() => {
    // If semantic search with query is active, use the scored search results
    if (searchMode === 'semantic' && searchQuery.trim().length > 0) {
      let filtered = semanticResults.map((r) => ({
        chunk: r.chunk,
        similarity: r.similarity,
      }));

      if (selectedCategory !== 'all') {
        filtered = filtered.filter(
          (item) => (item.chunk.metadata.category || 'general') === selectedCategory
        );
      }

      return filtered;
    }

    // Otherwise, text filtering over all chunks in cache
    let candidate = [...chunks];

    // Project scope
    if (projectScope === 'active' && projectId) {
      candidate = candidate.filter((c) => c.metadata.projectId === projectId);
    }

    // Namespace
    if (activeNamespace !== 'all') {
      candidate = candidate.filter((c) => c.namespace === activeNamespace);
    }

    // Category
    if (selectedCategory !== 'all') {
      candidate = candidate.filter(
        (c) => (c.metadata.category || 'general') === selectedCategory
      );
    }

    // Search query text match
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      candidate = candidate.filter((c) => {
        const textMatch = c.text.toLowerCase().includes(q);
        const titleMatch = c.metadata.taskTitle?.toLowerCase().includes(q);
        const tagMatch = c.metadata.tags?.some((t) => t.toLowerCase().includes(q));
        const idMatch = c.id.toLowerCase().includes(q);
        return textMatch || titleMatch || tagMatch || idMatch;
      });
    }

    return candidate.map((chunk) => ({ chunk, similarity: undefined }));
  }, [
    chunks,
    searchMode,
    searchQuery,
    semanticResults,
    projectScope,
    projectId,
    activeNamespace,
    selectedCategory,
  ]);

  // ── Categories List ────────────────────────────────────────────────────────
  const availableCategories = useMemo(() => {
    const cats = new Set<string>();
    for (const c of chunks) {
      if (c.metadata.category) cats.add(c.metadata.category);
    }
    return Array.from(cats);
  }, [chunks]);

  // ── Counts ─────────────────────────────────────────────────────────────────
  const counts = useMemo(() => {
    const scoped = projectScope === 'active' && projectId
      ? chunks.filter((c) => c.metadata.projectId === projectId)
      : chunks;

    const taskCount = scoped.filter((c) => c.namespace === 'tasks').length;
    const learningCount = scoped.filter((c) => c.namespace === 'learnings').length;
    return { total: scoped.length, tasks: taskCount, learnings: learningCount };
  }, [chunks, projectScope, projectId]);

  // ── Actions ────────────────────────────────────────────────────────────────
  const handleCopy = (chunkId: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(chunkId);
    setTimeout(() => setCopiedId(null), 1800);
  };

  const handleStartEdit = (chunk: MemoryChunk) => {
    setEditingChunkId(chunk.id);
    setEditText(chunk.text);
    setEditNamespace(chunk.namespace);
    setEditCategory(chunk.metadata.category || 'general');
    setEditTags(chunk.metadata.tags?.join(', ') || '');
  };

  const handleCancelEdit = () => {
    setEditingChunkId(null);
    setEditText('');
  };

  const handleSaveEdit = async () => {
    if (!editingChunkId || !editText.trim()) return;
    setIsSavingEdit(true);
    try {
      const tags = editTags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

      const updated = await updateChunk(editingChunkId, {
        text: editText.trim(),
        namespace: editNamespace,
        metadata: {
          category: editCategory,
          tags,
        },
      });

      if (updated) {
        setChunks((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      }
      setEditingChunkId(null);
    } catch (err) {
      console.error('[ArchivedTasksModal] Error saving chunk edit:', err);
    } finally {
      setIsSavingEdit(false);
    }
  };

  const handleCreateNew = async () => {
    if (!newText.trim()) return;
    setIsSubmittingNew(true);
    try {
      const tags = newTags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

      const created = await upsertCustomChunk({
        text: newText.trim(),
        namespace: newNamespace,
        metadata: {
          category: newCategory,
          projectId,
          tags,
          source: 'user-custom',
        },
      });

      if (created) {
        setChunks((prev) => [created, ...prev]);
        setNewText('');
        setNewTags('');
        setIsCreatingNew(false);
      }
    } catch (err) {
      console.error('[ArchivedTasksModal] Failed to create custom chunk:', err);
    } finally {
      setIsSubmittingNew(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!chunkToDelete) return;
    setIsDeleting(true);
    try {
      await deleteChunk(chunkToDelete.id);
      setChunks((prev) => prev.filter((c) => c.id !== chunkToDelete.id));
      setChunkToDelete(null);
    } catch (err) {
      console.error('[ArchivedTasksModal] Failed to delete chunk:', err);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleClearProjectMemory = async () => {
    if (!projectId) return;
    if (
      window.confirm(
        `Are you sure you want to clear all vector memory chunks for "${projectName}"? This removes all distilled task summaries and durable learnings for this project.`
      )
    ) {
      setIsLoading(true);
      try {
        await clearProjectMemory(projectId);
        setChunks((prev) => prev.filter((c) => c.metadata.projectId !== projectId));
      } catch (err) {
        console.error('[ArchivedTasksModal] Failed to clear project memory:', err);
      } finally {
        setIsLoading(false);
      }
    }
  };

  const handleRestoreTask = (chunk: MemoryChunk) => {
    if (onRestoreMemoryAsTask) {
      onRestoreMemoryAsTask(chunk);
    } else if (onUnarchiveTask && chunk.metadata.taskId) {
      onUnarchiveTask(chunk.metadata.taskId);
    }
  };

  const toggleDetails = (chunkId: string) => {
    setExpandedDetails((prev) => ({ ...prev, [chunkId]: !prev[chunkId] }));
  };

  if (!isOpen) return null;

  const modalElement = (
    <div className="modal-overlay" onClick={onClose} style={{ zIndex: 9999 }}>
      <div
        className="modal-content archived-tasks-modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: '1060px',
          width: '95vw',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-pane, #222427)',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          borderRadius: '12px',
          boxShadow: '0 24px 60px rgba(0,0,0,0.65), 0 0 40px rgba(99, 102, 241, 0.12)',
          overflow: 'hidden',
        }}
      >
        {/* ── Modal Header ── */}
        <div
          className="modal-header"
          style={{
            padding: '1rem 1.5rem',
            background: 'var(--bg-darkest, #191a1c)',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem' }}>
            <div
              style={{
                width: '36px',
                height: '36px',
                borderRadius: '8px',
                background: 'linear-gradient(135deg, rgba(99, 102, 241, 0.25) 0%, rgba(6, 182, 212, 0.25) 100%)',
                border: '1px solid rgba(99, 102, 241, 0.4)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#818cf8',
              }}
            >
              <Brain size={20} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                <h3 style={{ margin: 0, fontSize: '1.12rem', fontWeight: 700, color: 'var(--text-bright, #ffffff)' }}>
                  AI Brain & Vector Memory Base
                </h3>
                <span
                  style={{
                    fontSize: '0.72rem',
                    fontWeight: 600,
                    padding: '0.12rem 0.55rem',
                    borderRadius: '9999px',
                    background: 'rgba(99, 102, 241, 0.16)',
                    border: '1px solid rgba(99, 102, 241, 0.3)',
                    color: '#a5b4fc',
                  }}
                >
                  {counts.total} {counts.total === 1 ? 'Chunk' : 'Chunks'}
                </span>
                <span
                  style={{
                    fontSize: '0.7rem',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.3rem',
                    color: 'var(--text-muted, rgba(255,255,255,0.5))',
                    fontFamily: 'var(--font-mono, monospace)',
                  }}
                >
                  <Cpu size={12} color="#06b6d4" />
                  all-MiniLM-L6-v2 ({EMBEDDING_DIM}d)
                </span>
              </div>
              <p style={{ margin: '0.2rem 0 0', fontSize: '0.78rem', color: 'var(--text-muted, rgba(255,255,255,0.5))' }}>
                Inspect and curate durable learnings, retrospectives, and context retrieved by the AI agent during execution.
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={refreshChunks}
              disabled={isLoading}
              title="Refresh vector memory from storage"
              style={{
                height: '28px',
                padding: '0 0.65rem',
                fontSize: '0.76rem',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.35rem',
              }}
            >
              <RefreshCw size={13} className={isLoading ? 'spin-animation' : ''} />
              <span>Refresh</span>
            </button>
            <button
              type="button"
              className="btn-icon"
              onClick={onClose}
              title="Close (Esc)"
              style={{
                width: '30px',
                height: '30px',
                borderRadius: '6px',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(255, 255, 255, 0.04)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                color: 'var(--text-muted)',
                cursor: 'pointer',
              }}
            >
              <X size={17} />
            </button>
          </div>
        </div>

        {/* ── Search & Filter Controls ── */}
        <div
          style={{
            padding: '0.85rem 1.5rem',
            background: 'var(--bg-card, #1e2023)',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem',
          }}
        >
          {/* Top row: search input + mode toggle + new chunk button */}
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ position: 'relative', flex: 1, minWidth: '280px' }}>
              <Search
                size={14}
                style={{
                  position: 'absolute',
                  left: '0.8rem',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  color: searchMode === 'semantic' ? '#38bdf8' : 'var(--text-muted)',
                  pointerEvents: 'none',
                }}
              />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={
                  searchMode === 'semantic'
                    ? 'Query the AI brain (computes live cosine similarity & match scores)…'
                    : 'Filter text, task titles, tags, or chunk IDs…'
                }
                style={{
                  width: '100%',
                  height: '34px',
                  padding: '0 2rem 0 2.3rem',
                  background: 'rgba(0, 0, 0, 0.25)',
                  border: searchMode === 'semantic'
                    ? '1px solid rgba(56, 189, 248, 0.4)'
                    : '1px solid rgba(255, 255, 255, 0.12)',
                  borderRadius: '6px',
                  color: 'var(--text-bright, #fff)',
                  fontSize: '0.82rem',
                  outline: 'none',
                  boxShadow: searchMode === 'semantic' ? '0 0 10px rgba(56, 189, 248, 0.1)' : 'none',
                }}
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  style={{
                    position: 'absolute',
                    right: '0.65rem',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-muted)',
                    cursor: 'pointer',
                    padding: 0,
                  }}
                >
                  <X size={14} />
                </button>
              )}
            </div>

            {/* Semantic Mode Toggle */}
            <div
              style={{
                display: 'inline-flex',
                background: 'rgba(0, 0, 0, 0.3)',
                padding: '2px',
                borderRadius: '6px',
                border: '1px solid rgba(255, 255, 255, 0.08)',
              }}
            >
              <button
                type="button"
                onClick={() => setSearchMode('semantic')}
                style={{
                  height: '28px',
                  padding: '0 0.65rem',
                  borderRadius: '4px',
                  border: 'none',
                  background: searchMode === 'semantic' ? 'rgba(56, 189, 248, 0.2)' : 'transparent',
                  color: searchMode === 'semantic' ? '#38bdf8' : 'var(--text-muted)',
                  fontSize: '0.74rem',
                  fontWeight: 600,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
                title="Uses embedding cosine similarity to show how the AI matches queries"
              >
                <Sparkles size={12} />
                <span>Semantic AI Match</span>
              </button>
              <button
                type="button"
                onClick={() => setSearchMode('text')}
                style={{
                  height: '28px',
                  padding: '0 0.65rem',
                  borderRadius: '4px',
                  border: 'none',
                  background: searchMode === 'text' ? 'rgba(255, 255, 255, 0.1)' : 'transparent',
                  color: searchMode === 'text' ? '#fff' : 'var(--text-muted)',
                  fontSize: '0.74rem',
                  fontWeight: 600,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
                title="Direct keyword search across text, tags, and titles"
              >
                <Filter size={12} />
                <span>Text Search</span>
              </button>
            </div>

            {/* Add New Knowledge Chunk */}
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setIsCreatingNew((prev) => !prev)}
              style={{
                height: '32px',
                padding: '0 0.75rem',
                fontSize: '0.78rem',
                borderRadius: '6px',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.4rem',
              }}
            >
              <Plus size={14} />
              <span>{isCreatingNew ? 'Close Form' : 'New Knowledge'}</span>
            </button>
          </div>

          {/* Bottom row: Namespaces + Project Scope + Categories */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap' }}>
              {/* Namespace Filter Tabs */}
              <button
                type="button"
                className={`archive-filter-pill ${activeNamespace === 'all' ? 'active' : ''}`}
                onClick={() => setActiveNamespace('all')}
              >
                <Layers size={13} />
                <span>All Knowledge</span>
                <span className="pill-count">{counts.total}</span>
              </button>

              <button
                type="button"
                className={`archive-filter-pill ${activeNamespace === 'tasks' ? 'active' : ''}`}
                onClick={() => setActiveNamespace('tasks')}
                style={{
                  color: activeNamespace === 'tasks' ? '#38bdf8' : undefined,
                  borderColor: activeNamespace === 'tasks' ? 'rgba(56, 189, 248, 0.4)' : undefined,
                }}
              >
                <CheckCircle2 size={13} color="#38bdf8" />
                <span>Task Retrospectives</span>
                <span className="pill-count">{counts.tasks}</span>
              </button>

              <button
                type="button"
                className={`archive-filter-pill ${activeNamespace === 'learnings' ? 'active' : ''}`}
                onClick={() => setActiveNamespace('learnings')}
                style={{
                  color: activeNamespace === 'learnings' ? '#a78bfa' : undefined,
                  borderColor: activeNamespace === 'learnings' ? 'rgba(139, 92, 246, 0.4)' : undefined,
                }}
              >
                <Brain size={13} color="#a78bfa" />
                <span>Durable Learnings</span>
                <span className="pill-count">{counts.learnings}</span>
              </button>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.55rem' }}>
              {/* Category Dropdown */}
              {availableCategories.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                  <Tag size={13} style={{ color: 'var(--text-muted)' }} />
                  <select
                    value={selectedCategory}
                    onChange={(e) => setSelectedCategory(e.target.value)}
                    style={{
                      height: '26px',
                      background: 'rgba(0, 0, 0, 0.3)',
                      border: '1px solid rgba(255, 255, 255, 0.1)',
                      borderRadius: '5px',
                      color: 'var(--text-bright, #fff)',
                      fontSize: '0.74rem',
                      padding: '0 0.4rem',
                      outline: 'none',
                    }}
                  >
                    <option value="all">All Categories</option>
                    {availableCategories.map((cat) => (
                      <option key={cat} value={cat}>
                        {cat}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Scope Selector: Active Project vs All */}
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  fontSize: '0.74rem',
                  color: 'var(--text-muted)',
                }}
              >
                <Folder size={13} />
                <button
                  type="button"
                  onClick={() => setProjectScope((prev) => (prev === 'active' ? 'all' : 'active'))}
                  style={{
                    background: 'transparent',
                    border: '1px solid rgba(255, 255, 255, 0.12)',
                    borderRadius: '4px',
                    color: projectScope === 'active' ? '#a5b4fc' : 'var(--text-muted)',
                    padding: '0.15rem 0.45rem',
                    fontSize: '0.72rem',
                    cursor: 'pointer',
                  }}
                  title="Toggle between current project memory only or all projects"
                >
                  {projectScope === 'active' ? `Project: ${projectName}` : 'All Projects'}
                </button>
              </div>

              {/* Clear Project Memory Action */}
              <button
                type="button"
                onClick={handleClearProjectMemory}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--accent-rose, #f43f5e)',
                  fontSize: '0.72rem',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.25rem',
                  cursor: 'pointer',
                  padding: '0.2rem 0.4rem',
                  borderRadius: '4px',
                  opacity: 0.8,
                }}
                title="Wipe vector memory chunks for this project"
              >
                <Trash2 size={12} />
                <span>Reset Project Memory</span>
              </button>
            </div>
          </div>
        </div>

        {/* ── New Knowledge Chunk Pop-in Form ── */}
        {isCreatingNew && (
          <div
            style={{
              padding: '1rem 1.5rem',
              background: 'rgba(99, 102, 241, 0.05)',
              borderBottom: '1px solid rgba(99, 102, 241, 0.25)',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.75rem',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', color: '#a5b4fc', fontSize: '0.82rem', fontWeight: 600 }}>
                <Plus size={15} />
                <span>Add Knowledge to Local Vector Storage</span>
              </div>
              <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                Generates a local 384-dim WASM embedding automatically
              </span>
            </div>

            <textarea
              value={newText}
              onChange={(e) => setNewText(e.target.value)}
              placeholder="Enter durable architectural decision, gotcha, project convention, or task learning..."
              rows={3}
              style={{
                width: '100%',
                padding: '0.65rem',
                background: 'rgba(0, 0, 0, 0.35)',
                border: '1px solid rgba(255, 255, 255, 0.12)',
                borderRadius: '6px',
                color: '#fff',
                fontSize: '0.82rem',
                fontFamily: 'var(--font-mono, monospace)',
                lineHeight: 1.5,
                outline: 'none',
                resize: 'vertical',
              }}
            />

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.75rem' }}>
                <span style={{ color: 'var(--text-muted)' }}>Namespace:</span>
                <select
                  value={newNamespace}
                  onChange={(e) => setNewNamespace(e.target.value as MemoryNamespace)}
                  style={{
                    height: '26px',
                    background: 'rgba(0, 0, 0, 0.3)',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    borderRadius: '4px',
                    color: '#fff',
                    fontSize: '0.74rem',
                    padding: '0 0.4rem',
                  }}
                >
                  <option value="learnings">learnings (Durable Knowledge)</option>
                  <option value="tasks">tasks (Task Summaries / Retrospective)</option>
                  <option value="code-map">code-map (File Architecture)</option>
                </select>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.75rem' }}>
                <span style={{ color: 'var(--text-muted)' }}>Category:</span>
                <select
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                  style={{
                    height: '26px',
                    background: 'rgba(0, 0, 0, 0.3)',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    borderRadius: '4px',
                    color: '#fff',
                    fontSize: '0.74rem',
                    padding: '0 0.4rem',
                  }}
                >
                  <option value="architecture">architecture</option>
                  <option value="gotcha">gotcha</option>
                  <option value="convention">convention</option>
                  <option value="pattern">pattern</option>
                  <option value="dependency">dependency</option>
                  <option value="performance">performance</option>
                  <option value="general">general</option>
                </select>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.75rem', flex: 1, minWidth: '180px' }}>
                <span style={{ color: 'var(--text-muted)' }}>Tags:</span>
                <input
                  type="text"
                  value={newTags}
                  onChange={(e) => setNewTags(e.target.value)}
                  placeholder="e.g. backend, auth, fast-path"
                  style={{
                    flex: 1,
                    height: '26px',
                    background: 'rgba(0, 0, 0, 0.3)',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    borderRadius: '4px',
                    color: '#fff',
                    fontSize: '0.74rem',
                    padding: '0 0.5rem',
                  }}
                />
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', marginLeft: 'auto' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setIsCreatingNew(false)}
                  style={{ height: '26px', padding: '0 0.6rem', fontSize: '0.75rem' }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-emerald"
                  onClick={handleCreateNew}
                  disabled={isSubmittingNew || !newText.trim()}
                  style={{
                    height: '26px',
                    padding: '0 0.75rem',
                    fontSize: '0.75rem',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.35rem',
                  }}
                >
                  <Save size={13} />
                  <span>{isSubmittingNew ? 'Embedding…' : 'Save to Vector DB'}</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Main Memory Chunks List ── */}
        <div
          className="modal-body"
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '1.25rem 1.5rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.85rem',
          }}
        >
          {isSearchingSemantic && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                fontSize: '0.78rem',
                color: '#38bdf8',
                padding: '0.4rem 0.8rem',
                borderRadius: '6px',
                background: 'rgba(56, 189, 248, 0.08)',
                border: '1px solid rgba(56, 189, 248, 0.2)',
              }}
            >
              <Sparkles size={14} className="spin-animation" />
              <span>Querying local vector embeddings at 0 token cost…</span>
            </div>
          )}

          {displayedChunks.length === 0 ? (
            <div
              style={{
                textAlign: 'center',
                padding: '3rem 1.5rem',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '0.65rem',
                color: 'var(--text-muted)',
              }}
            >
              <div
                style={{
                  width: '44px',
                  height: '44px',
                  borderRadius: '12px',
                  background: 'rgba(255, 255, 255, 0.03)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--text-muted)',
                }}
              >
                <Brain size={22} />
              </div>
              <h4 style={{ margin: 0, fontSize: '0.95rem', color: 'var(--text-bright)' }}>
                No Vector Memory Chunks Found
              </h4>
              <p style={{ margin: 0, fontSize: '0.8rem', maxWidth: '420px', lineHeight: 1.5 }}>
                {searchQuery
                  ? 'No vector chunks matched your search criteria. Try a different query or switch to Text Search.'
                  : 'No memory chunks stored for this project yet. When tasks finish execution, durable lessons and summaries are stored here automatically.'}
              </p>
              {!searchQuery && (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => setIsCreatingNew(true)}
                  style={{ marginTop: '0.5rem', height: '28px', fontSize: '0.76rem' }}
                >
                  <Plus size={13} />
                  <span>Add First Memory Chunk</span>
                </button>
              )}
            </div>
          ) : (
            displayedChunks.map(({ chunk, similarity }) => {
              const isEditing = editingChunkId === chunk.id;
              const hasTaskRef = !!(chunk.metadata.taskId || chunk.metadata.taskTitle);
              const isDetailsOpen = !!expandedDetails[chunk.id];

              const namespaceColor =
                chunk.namespace === 'learnings'
                  ? '#a78bfa'
                  : chunk.namespace === 'tasks'
                  ? '#38bdf8'
                  : '#10b981';

              const matchPercent = similarity != null ? Math.round(similarity * 100) : null;

              return (
                <div
                  key={chunk.id}
                  className="modal-archived-card"
                  style={{
                    background: 'var(--bg-card, #222427)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    borderRadius: '8px',
                    padding: '0.85rem 1rem',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.65rem',
                    transition: 'all 0.15s ease',
                  }}
                >
                  {/* Card Header */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '0.5rem',
                      flexWrap: 'wrap',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                      {/* Namespace badge */}
                      <span
                        style={{
                          fontSize: '0.7rem',
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          letterSpacing: '0.04em',
                          padding: '0.12rem 0.5rem',
                          borderRadius: '4px',
                          background: `${namespaceColor}1a`,
                          border: `1px solid ${namespaceColor}40`,
                          color: namespaceColor,
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.3rem',
                        }}
                      >
                        {chunk.namespace === 'learnings' ? (
                          <Brain size={11} />
                        ) : chunk.namespace === 'tasks' ? (
                          <CheckCircle2 size={11} />
                        ) : (
                          <FileCode size={11} />
                        )}
                        <span>{chunk.namespace}</span>
                      </span>

                      {/* Category tag */}
                      {chunk.metadata.category && (
                        <span
                          style={{
                            fontSize: '0.7rem',
                            fontWeight: 600,
                            padding: '0.1rem 0.45rem',
                            borderRadius: '4px',
                            background: 'rgba(255, 255, 255, 0.05)',
                            border: '1px solid rgba(255, 255, 255, 0.1)',
                            color: 'var(--text-bright, #fff)',
                          }}
                        >
                          {chunk.metadata.category}
                        </span>
                      )}

                      {/* Semantic match percentage badge */}
                      {matchPercent !== null && (
                        <span
                          style={{
                            fontSize: '0.72rem',
                            fontWeight: 700,
                            padding: '0.12rem 0.55rem',
                            borderRadius: '9999px',
                            background:
                              matchPercent >= 75
                                ? 'rgba(16, 185, 129, 0.15)'
                                : matchPercent >= 45
                                ? 'rgba(56, 189, 248, 0.15)'
                                : 'rgba(255, 255, 255, 0.06)',
                            border:
                              matchPercent >= 75
                                ? '1px solid rgba(16, 185, 129, 0.35)'
                                : matchPercent >= 45
                                ? '1px solid rgba(56, 189, 248, 0.35)'
                                : '1px solid rgba(255, 255, 255, 0.1)',
                            color:
                              matchPercent >= 75
                                ? '#10b981'
                                : matchPercent >= 45
                                ? '#38bdf8'
                                : 'var(--text-muted)',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '0.25rem',
                          }}
                        >
                          <Sparkles size={11} />
                          <span>{matchPercent}% Match</span>
                        </span>
                      )}

                      {/* Timestamp */}
                      <span
                        style={{
                          fontSize: '0.72rem',
                          color: 'var(--text-muted)',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.25rem',
                        }}
                      >
                        <Clock size={11} />
                        <span>{new Date(chunk.createdAt).toLocaleDateString()}</span>
                      </span>
                    </div>

                    {/* Action buttons */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                      {/* Copy chunk text */}
                      <button
                        type="button"
                        className="btn-icon"
                        onClick={() => handleCopy(chunk.id, chunk.text)}
                        title="Copy chunk text"
                        style={{
                          width: '26px',
                          height: '26px',
                          borderRadius: '5px',
                          background: 'rgba(255, 255, 255, 0.04)',
                          border: '1px solid rgba(255, 255, 255, 0.08)',
                          color: copiedId === chunk.id ? '#10b981' : 'var(--text-muted)',
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          cursor: 'pointer',
                        }}
                      >
                        {copiedId === chunk.id ? <Check size={13} /> : <Copy size={13} />}
                      </button>

                      {/* Restore as Task (if task retrospective or taskId present) */}
                      {hasTaskRef && (
                        <button
                          type="button"
                          className="btn-icon"
                          onClick={() => handleRestoreTask(chunk)}
                          title="Restore this task to active workspace"
                          style={{
                            height: '26px',
                            padding: '0 0.5rem',
                            borderRadius: '5px',
                            background: 'rgba(56, 189, 248, 0.08)',
                            border: '1px solid rgba(56, 189, 248, 0.25)',
                            color: '#38bdf8',
                            fontSize: '0.72rem',
                            fontWeight: 600,
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '0.25rem',
                            cursor: 'pointer',
                          }}
                        >
                          <RotateCcw size={12} />
                          <span>Restore</span>
                        </button>
                      )}

                      {/* Edit chunk */}
                      <button
                        type="button"
                        className="btn-icon"
                        onClick={() => handleStartEdit(chunk)}
                        title="Edit chunk text & tags"
                        style={{
                          width: '26px',
                          height: '26px',
                          borderRadius: '5px',
                          background: isEditing ? 'rgba(99, 102, 241, 0.2)' : 'rgba(255, 255, 255, 0.04)',
                          border: isEditing ? '1px solid #6366f1' : '1px solid rgba(255, 255, 255, 0.08)',
                          color: isEditing ? '#fff' : 'var(--text-muted)',
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          cursor: 'pointer',
                        }}
                      >
                        <Edit3 size={13} />
                      </button>

                      {/* Delete chunk */}
                      <button
                        type="button"
                        className="btn-icon"
                        onClick={() => setChunkToDelete(chunk)}
                        title="Delete memory chunk"
                        style={{
                          width: '26px',
                          height: '26px',
                          borderRadius: '5px',
                          background: 'rgba(244, 63, 94, 0.06)',
                          border: '1px solid rgba(244, 63, 94, 0.15)',
                          color: '#f43f5e',
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          cursor: 'pointer',
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>

                  {/* Card Content or Inline Editor */}
                  {isEditing ? (
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '0.6rem',
                        padding: '0.75rem',
                        background: 'rgba(0, 0, 0, 0.25)',
                        borderRadius: '6px',
                        border: '1px solid rgba(99, 102, 241, 0.3)',
                      }}
                    >
                      <textarea
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        rows={4}
                        style={{
                          width: '100%',
                          padding: '0.65rem',
                          background: 'rgba(0, 0, 0, 0.3)',
                          border: '1px solid rgba(255, 255, 255, 0.15)',
                          borderRadius: '4px',
                          color: '#fff',
                          fontSize: '0.82rem',
                          fontFamily: 'var(--font-mono, monospace)',
                          lineHeight: 1.5,
                          outline: 'none',
                          resize: 'vertical',
                        }}
                      />

                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.74rem' }}>
                          <span style={{ color: 'var(--text-muted)' }}>Namespace:</span>
                          <select
                            value={editNamespace}
                            onChange={(e) => setEditNamespace(e.target.value as MemoryNamespace)}
                            style={{
                              height: '26px',
                              background: 'rgba(0, 0, 0, 0.3)',
                              border: '1px solid rgba(255, 255, 255, 0.1)',
                              borderRadius: '4px',
                              color: '#fff',
                              fontSize: '0.74rem',
                              padding: '0 0.3rem',
                            }}
                          >
                            <option value="learnings">learnings</option>
                            <option value="tasks">tasks</option>
                            <option value="code-map">code-map</option>
                          </select>
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.74rem' }}>
                          <span style={{ color: 'var(--text-muted)' }}>Category:</span>
                          <input
                            type="text"
                            value={editCategory}
                            onChange={(e) => setEditCategory(e.target.value)}
                            style={{
                              height: '26px',
                              background: 'rgba(0, 0, 0, 0.3)',
                              border: '1px solid rgba(255, 255, 255, 0.1)',
                              borderRadius: '4px',
                              color: '#fff',
                              fontSize: '0.74rem',
                              padding: '0 0.4rem',
                              width: '120px',
                            }}
                          />
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.74rem', flex: 1, minWidth: '160px' }}>
                          <span style={{ color: 'var(--text-muted)' }}>Tags:</span>
                          <input
                            type="text"
                            value={editTags}
                            onChange={(e) => setEditTags(e.target.value)}
                            placeholder="tag1, tag2"
                            style={{
                              flex: 1,
                              height: '26px',
                              background: 'rgba(0, 0, 0, 0.3)',
                              border: '1px solid rgba(255, 255, 255, 0.1)',
                              borderRadius: '4px',
                              color: '#fff',
                              fontSize: '0.74rem',
                              padding: '0 0.4rem',
                            }}
                          />
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', marginLeft: 'auto' }}>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={handleCancelEdit}
                            style={{ height: '26px', padding: '0 0.6rem', fontSize: '0.74rem' }}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            className="btn btn-emerald"
                            onClick={handleSaveEdit}
                            disabled={isSavingEdit}
                            style={{
                              height: '26px',
                              padding: '0 0.75rem',
                              fontSize: '0.74rem',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '0.3rem',
                            }}
                          >
                            <Save size={12} />
                            <span>{isSavingEdit ? 'Re-embedding…' : 'Save & Re-embed'}</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="brief-markdown-render" style={{ fontSize: '0.84rem', lineHeight: 1.6, color: 'var(--text-main, rgba(255,255,255,0.85))' }}>
                      <MarkdownRenderer content={chunk.text} />
                    </div>
                  )}

                  {/* Associated Task & Tags footer */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '0.5rem',
                      paddingTop: '0.45rem',
                      borderTop: '1px solid rgba(255, 255, 255, 0.05)',
                      flexWrap: 'wrap',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap' }}>
                      {chunk.metadata.taskTitle && (
                        <span
                          style={{
                            fontSize: '0.72rem',
                            color: '#38bdf8',
                            background: 'rgba(56, 189, 248, 0.08)',
                            border: '1px solid rgba(56, 189, 248, 0.2)',
                            borderRadius: '4px',
                            padding: '0.08rem 0.4rem',
                            fontWeight: 500,
                          }}
                        >
                          Task: {chunk.metadata.taskTitle}
                        </span>
                      )}

                      {chunk.metadata.tags && chunk.metadata.tags.length > 0 && (
                        chunk.metadata.tags.map((t, idx) => (
                          <span
                            key={idx}
                            style={{
                              fontSize: '0.68rem',
                              color: 'var(--text-muted)',
                              background: 'rgba(255, 255, 255, 0.04)',
                              borderRadius: '3px',
                              padding: '0.05rem 0.35rem',
                            }}
                          >
                            #{t}
                          </span>
                        ))
                      )}
                    </div>

                    {/* Toggle Technical Inspector */}
                    <button
                      type="button"
                      onClick={() => toggleDetails(chunk.id)}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--text-muted)',
                        fontSize: '0.7rem',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.25rem',
                        cursor: 'pointer',
                        padding: 0,
                      }}
                    >
                      <span>Technical Details</span>
                      <ChevronDown
                        size={12}
                        style={{
                          transform: isDetailsOpen ? 'rotate(180deg)' : 'none',
                          transition: 'transform 0.15s ease',
                        }}
                      />
                    </button>
                  </div>

                  {/* Technical Details Accordion */}
                  {isDetailsOpen && (
                    <div
                      style={{
                        padding: '0.6rem 0.75rem',
                        background: 'rgba(0, 0, 0, 0.3)',
                        borderRadius: '5px',
                        border: '1px solid rgba(255, 255, 255, 0.06)',
                        fontSize: '0.72rem',
                        fontFamily: 'var(--font-mono, monospace)',
                        color: 'var(--text-muted)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '0.3rem',
                      }}
                    >
                      <div>
                        <strong style={{ color: 'var(--text-bright)' }}>Chunk ID:</strong> {chunk.id}
                      </div>
                      <div>
                        <strong style={{ color: 'var(--text-bright)' }}>Source:</strong>{' '}
                        {chunk.metadata.source || 'default'}
                      </div>
                      <div>
                        <strong style={{ color: 'var(--text-bright)' }}>Project ID:</strong>{' '}
                        {chunk.metadata.projectId || 'global'}
                      </div>
                      <div>
                        <strong style={{ color: 'var(--text-bright)' }}>Embedding Vector:</strong>{' '}
                        Float32Array[{chunk.embedding.length}] (
                        {Array.from(chunk.embedding.slice(0, 5))
                          .map((n) => n.toFixed(4))
                          .join(', ')}
                        , …)
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* ── Modal Footer ── */}
        <div
          className="modal-footer"
          style={{
            padding: '0.75rem 1.5rem',
            background: 'var(--bg-darkest, #191a1c)',
            borderTop: '1px solid rgba(255, 255, 255, 0.08)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <span>IndexedDB Store: <code style={{ color: '#a5b4fc' }}>ergo-vector-memory</code></span>
            <span>•</span>
            <span>{displayedChunks.length} shown</span>
          </div>

          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            style={{ height: '30px', padding: '0 0.85rem', fontSize: '0.78rem' }}
          >
            Close
          </button>
        </div>
      </div>

      {/* ── Delete Confirmation Dialog ── */}
      {chunkToDelete && (
        <div className="modal-overlay" onClick={() => setChunkToDelete(null)} style={{ zIndex: 120 }}>
          <div
            className="modal-content archive-delete-modal"
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth: '460px',
              background: 'var(--bg-card, #222427)',
              border: '1px solid rgba(244, 63, 94, 0.3)',
              borderRadius: '10px',
              boxShadow: '0 20px 50px rgba(0,0,0,0.7)',
            }}
          >
            <div className="modal-header" style={{ padding: '0.85rem 1.25rem', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--accent-rose, #f43f5e)' }}>
                <AlertTriangle size={18} />
                <h4 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600 }}>Delete Knowledge Chunk?</h4>
              </div>
              <button type="button" className="btn-icon" onClick={() => setChunkToDelete(null)}>
                <X size={15} />
              </button>
            </div>

            <div className="modal-body" style={{ padding: '1rem 1.25rem', fontSize: '0.82rem', color: 'var(--text-main)' }}>
              <p style={{ margin: '0 0 0.75rem' }}>
                This will permanently delete this knowledge chunk and its 384-dimensional embedding from local vector memory. The AI will no longer access it during task execution.
              </p>
              <div
                style={{
                  padding: '0.65rem',
                  background: 'rgba(0, 0, 0, 0.3)',
                  borderRadius: '5px',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  fontSize: '0.78rem',
                  fontFamily: 'var(--font-mono, monospace)',
                  color: 'var(--text-bright)',
                  maxHeight: '120px',
                  overflowY: 'auto',
                }}
              >
                {chunkToDelete.text.slice(0, 240)}
                {chunkToDelete.text.length > 240 ? '…' : ''}
              </div>
            </div>

            <div className="modal-footer" style={{ padding: '0.75rem 1.25rem', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setChunkToDelete(null)}
                style={{ height: '28px', padding: '0 0.7rem', fontSize: '0.76rem' }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={handleConfirmDelete}
                disabled={isDeleting}
                style={{
                  height: '28px',
                  padding: '0 0.75rem',
                  fontSize: '0.76rem',
                  background: 'var(--accent-rose, #f43f5e)',
                  color: '#fff',
                  border: 'none',
                }}
              >
                {isDeleting ? 'Deleting…' : 'Delete Permanently'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(modalElement, document.body) : modalElement;
};
