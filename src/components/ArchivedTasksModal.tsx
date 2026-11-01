import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  Archive,
  Bot,
  Brain,
  X,
  Search,
  Trash2,
  Edit3,
  Save,
  RotateCcw,
  Copy,
  Check,
  Plus,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  NotebookPen,
  Tag,
  Clock,
  User,
} from 'lucide-react';
import {
  type MemoryChunk,
  getAllChunks,
  getChunksByNamespace,
  updateChunk,
  removeChunksById,
  isHiddenNamespace,
} from '../lib/memory';
import { applyInsightOps, insightsSupported, listInsights, onInsightsChanged } from '../lib/memory/insights';
import { type TaskItem } from '../types';
import { MarkdownRenderer } from './MarkdownRenderer';
import { LearnedRulesSection } from './LearnedRulesSection';
import { Button, Dialog, EmptyState, Field, IconButton, Input, MenuButton, SegmentedControl, Tabs } from './ui';

/** The kinds of saved information the screen lists, one tab each. */
export type ArchiveTab = 'human' | 'ai' | 'rules' | 'notes';

const TABS: Array<{ id: ArchiveTab; label: string; color: string; icon: React.ReactNode; empty: string }> = [
  {
    id: 'human',
    label: 'Human Workspace',
    color: 'var(--accent-text)',
    icon: <User size={13} />,
    empty: 'Tasks you archive from the human workspace show up here.',
  },
  {
    id: 'ai',
    label: 'AI Workspace',
    color: 'var(--success)',
    icon: <Bot size={13} />,
    empty: 'Execution cards you archive from the AI workspace show up here.',
  },
  {
    id: 'rules',
    label: 'Learnings',
    color: 'var(--ink-subtle)',
    icon: <Brain size={13} />,
    empty: '',
  },
  {
    id: 'notes',
    label: 'AI Notes',
    color: 'var(--warning)',
    icon: <NotebookPen size={13} />,
    empty: "Notes the AI saves while it works (plans, reports, completion records) show up here. It reads them back on later tasks.",
  },
];

/** Cards longer than this start collapsed to a three-line preview. */
const LONG_CARD_CHARS = 280;
const LONG_CARD_LINES = 4;

const RULE_SCOPES = ['Related work', 'Every task'];

const NOTE_KIND_LABELS: Record<string, string> = {
  completion: 'Completion record',
  plan: 'Plan',
  worker: 'Worker report',
  verifier: 'Verifier report',
  note: 'Note',
  artifact: 'To-do list',
};

/** Which tab a stored record belongs on, or null for records this screen doesn't list. */
function tabOf(chunk: MemoryChunk): ArchiveTab | null {
  if (chunk.namespace === 'agent-notes') return 'notes';
  // Lessons older versions picked out of run output: listed under the rules as older notes.
  if (chunk.namespace === 'learnings' || chunk.namespace === 'code-map') return 'rules';
  if (chunk.namespace !== 'tasks') return null;
  const source = chunk.metadata.source;
  // Old per-run summaries: the bridge drops them on its next start.
  if (source === 'session-retrospective') return null;
  return source === 'ai-archive' ? 'ai' : 'human';
}

/** One card on the screen. Long AI notes are stored in several parts; they show as one card. */
interface ArchiveItem {
  key: string;
  tab: ArchiveTab;
  /** First part: the record Restore and Edit act on. */
  head: MemoryChunk;
  chunkIds: string[];
  text: string;
  category?: string;
  heading?: string;
  taskTitle?: string;
  createdAt: number;
}

function buildItems(chunks: MemoryChunk[], taskTitles: Map<string, string>): ArchiveItem[] {
  const docs = new Map<string, MemoryChunk[]>();
  const items: ArchiveItem[] = [];
  for (const c of chunks) {
    const tab = tabOf(c);
    if (!tab) continue;
    if (tab === 'notes') {
      const key = c.metadata.docId || c.id;
      docs.set(key, [...(docs.get(key) || []), c]);
      continue;
    }
    items.push({
      key: c.id,
      tab,
      head: c,
      chunkIds: [c.id],
      text: c.text,
      category: c.metadata.category,
      taskTitle: c.metadata.taskTitle,
      createdAt: c.createdAt,
    });
  }
  for (const [key, parts] of docs) {
    parts.sort((a, b) => (a.metadata.part ?? 0) - (b.metadata.part ?? 0));
    const head = parts[0];
    const taskId = head.metadata.taskId != null ? String(head.metadata.taskId) : '';
    items.push({
      key,
      tab: 'notes',
      head,
      chunkIds: parts.map((p) => p.id),
      text: parts.map((p) => p.text).join('\n\n'),
      category: NOTE_KIND_LABELS[head.metadata.kind || ''] || 'Note',
      heading: head.metadata.title,
      taskTitle: head.metadata.taskTitle || taskTitles.get(taskId),
      createdAt: Math.max(...parts.map((p) => p.createdAt)),
    });
  }
  return items;
}

/** What Restore would bring back (computed by the app, which owns the workspace). */
export interface ArchiveRestorePlan {
  title: string;
  restoresTask: boolean;
  restoresCard: boolean;
}

/** Which Settings page an embedded archive renders: archived tasks, learned rules, or the agent's notes. */
export type ArchivePage = 'archive' | 'rules' | 'memory';

export interface ArchivedTasksModalProps {
  isOpen: boolean;
  /** Render one page inline (Settings) instead of the modal. */
  embedded?: boolean;
  page?: ArchivePage;
  onClose: () => void;
  projectId?: string;
  projectName?: string;
  /** Tab shown when the screen opens. */
  initialTab?: ArchiveTab;
  /** Active tasks, to name the task an AI note belongs to. */
  tasks?: TaskItem[];
  planRestore?: (chunk: MemoryChunk) => ArchiveRestorePlan;
  onRestore?: (chunk: MemoryChunk) => Promise<boolean>;
}

const fieldStyle: React.CSSProperties = {
  height: '28px',
  background: 'var(--surface-1)',
  border: '1px solid var(--line)',
  borderRadius: '5px',
  color: 'var(--text-bright)',
  fontSize: '0.78rem',
  padding: '0 0.5rem',
  outline: 'none',
};

/** Category picker in the app's own dropdown style (a native <select> can't be themed). */
const CategoryDropdown: React.FC<{
  value: string;
  options: string[];
  onChange: (value: string) => void;
  allLabel?: string;
}> = ({ value, options, onChange, allLabel }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const items = allLabel ? ['all', ...options] : options;
  const labelOf = (v: string) => (v === 'all' && allLabel ? allLabel : v);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        className="archive-filter-pill"
        onClick={() => setOpen((o) => !o)}
        style={{ textTransform: 'capitalize' }}
      >
        <Tag size={13} />
        <span>{labelOf(value)}</span>
        <ChevronDown size={13} style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s ease' }} />
      </button>
      {open && (
        <div className="custom-dropdown-menu" style={{ left: 'auto', right: 0, minWidth: '180px', maxHeight: '260px', overflowY: 'auto' }}>
          {items.map((opt) => (
            <div
              key={opt}
              className={`custom-dropdown-item ${opt === value ? 'selected' : ''}`}
              style={{ textTransform: 'capitalize' }}
              onClick={() => {
                onChange(opt);
                setOpen(false);
              }}
            >
              <span>{labelOf(opt)}</span>
              {opt === value && <Check size={13} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export const ArchivedTasksModal: React.FC<ArchivedTasksModalProps> = ({
  isOpen,
  onClose,
  projectId = 'default-workspace',
  initialTab = 'human',
  tasks = [],
  planRestore,
  onRestore,
  embedded = false,
  page = 'archive',
}) => {
  const active = isOpen || embedded;
  const startTab: ArchiveTab = embedded ? (page === 'rules' ? 'rules' : page === 'memory' ? 'notes' : 'human') : initialTab;
  const [chunks, setChunks] = useState<MemoryChunk[]>([]);
  const [rulesCount, setRulesCount] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<ArchiveTab>(initialTab);
  const [selectedCategory, setSelectedCategory] = useState<string>('all');

  // Inline editing state
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [editCategory, setEditCategory] = useState('general');
  const [isSavingEdit, setIsSavingEdit] = useState(false);

  // New learning form
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [newText, setNewText] = useState('');
  const [newScope, setNewScope] = useState(RULE_SCOPES[0]);
  const [newError, setNewError] = useState<string | null>(null);
  const [isSubmittingNew, setIsSubmittingNew] = useState(false);

  // Delete / restore confirmations
  const [itemToDelete, setItemToDelete] = useState<ArchiveItem | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<{ item: ArchiveItem; plan: ArchiveRestorePlan } | null>(null);
  const [isRestoring, setIsRestoring] = useState(false);

  // Clipboard copy feedback
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Long cards start collapsed; these are the ones the user opened.
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const toggleExpanded = (key: string) =>
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // ── Load (every time the screen opens) ────────────────────────────────────
  const refreshChunks = useCallback(async () => {
    setIsLoading(true);
    try {
      // AI notes are a hidden namespace (kept out of the default listing), so they are asked for by name.
      const [visible, notes] = await Promise.all([getAllChunks(), getChunksByNamespace('agent-notes', projectId)]);
      setChunks([...visible.filter((c) => !isHiddenNamespace(c.namespace)), ...notes]);
    } catch (err) {
      console.warn('[ArchivedTasksModal] Failed to load vector chunks:', err);
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (active) {
      setActiveTab(startTab);
      setSelectedCategory('all');
      void refreshChunks();
    }
  }, [active, startTab, refreshChunks]);

  // Learned rules have their own store; only the count is needed here (the tab lists them itself).
  useEffect(() => {
    if (!active || !projectId || !insightsSupported()) return;
    let alive = true;
    listInsights(projectId)
      .then((list) => alive && setRulesCount(list.length))
      .catch(() => {});
    const off = onInsightsChanged((pid, list) => {
      if (pid === projectId) setRulesCount(list.length);
    });
    return () => {
      alive = false;
      off();
    };
  }, [active, projectId]);

  // Only the active project's records; switching projects happens in the main app.
  const items = useMemo(() => {
    const projectChunks = projectId ? chunks.filter((c) => c.metadata.projectId === projectId) : chunks;
    const taskTitles = new Map<string, string>();
    for (const c of projectChunks) {
      if (c.metadata.taskId != null && c.metadata.taskTitle) taskTitles.set(String(c.metadata.taskId), c.metadata.taskTitle);
    }
    for (const t of tasks) taskTitles.set(String(t.id), t.title);
    return buildItems(projectChunks, taskTitles);
  }, [chunks, projectId, tasks]);

  const tabItems = useMemo(() => items.filter((i) => i.tab === activeTab), [items, activeTab]);

  const counts = useMemo(() => {
    const out: Record<ArchiveTab, number> = { human: 0, ai: 0, rules: rulesCount, notes: 0 };
    for (const i of items) out[i.tab]++;
    return out;
  }, [items, rulesCount]);

  const availableCategories = useMemo(() => {
    const cats = new Set<string>();
    for (const i of tabItems) if (i.category) cats.add(i.category);
    return Array.from(cats).sort();
  }, [tabItems]);

  // Keyword search over the text, task, category and tags.
  const displayedItems = useMemo(() => {
    let candidate = tabItems;
    if (selectedCategory !== 'all') {
      candidate = candidate.filter((i) => (i.category || 'general') === selectedCategory);
    }
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      candidate = candidate.filter((i) =>
        i.text.toLowerCase().includes(q) ||
        i.heading?.toLowerCase().includes(q) ||
        i.taskTitle?.toLowerCase().includes(q) ||
        i.category?.toLowerCase().includes(q) ||
        i.head.metadata.tags?.some((t) => t.toLowerCase().includes(q))
      );
    }
    return [...candidate].sort((a, b) => b.createdAt - a.createdAt);
  }, [tabItems, selectedCategory, searchQuery]);

  const switchTab = (tab: ArchiveTab) => {
    setActiveTab(tab);
    setSelectedCategory('all');
  };

  // ── Actions ────────────────────────────────────────────────────────────────
  const handleCopy = (key: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1800);
  };

  const handleStartEdit = (item: ArchiveItem) => {
    setEditingKey(item.key);
    setEditText(item.text);
    setEditCategory(item.category || 'general');
  };

  const handleCancelEdit = () => {
    setEditingKey(null);
    setEditText('');
  };

  const handleSaveEdit = async (item: ArchiveItem) => {
    if (!editText.trim()) return;
    setIsSavingEdit(true);
    try {
      const updated = await updateChunk(item.head.id, {
        text: editText.trim(),
        // An AI note's category is its kind, which isn't editable.
        ...(item.tab === 'notes' ? {} : { metadata: { category: editCategory.trim() || 'general' } }),
      });
      if (updated) {
        setChunks((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      }
      setEditingKey(null);
    } catch (err) {
      console.error('[ArchivedTasksModal] Error saving chunk edit:', err);
    } finally {
      setIsSavingEdit(false);
    }
  };

  // New Knowledge is a rule the user writes: every run of the project gets it.
  const handleCreateNew = async () => {
    const text = newText.trim();
    if (!text) return;
    setIsSubmittingNew(true);
    setNewError(null);
    try {
      const res = await applyInsightOps(
        projectId,
        [{ op: 'add', text, scope: newScope === 'Every task' ? 'always' : 'topical' }],
        { origin: 'user' }
      );
      setRulesCount(res.insights.length);
      setNewText('');
      setIsCreatingNew(false);
      if (!embedded) switchTab('rules');
    } catch (err) {
      setNewError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmittingNew(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!itemToDelete) return;
    setIsDeleting(true);
    try {
      await removeChunksById(itemToDelete.chunkIds);
      const gone = new Set(itemToDelete.chunkIds);
      setChunks((prev) => prev.filter((c) => !gone.has(c.id)));
      setItemToDelete(null);
    } catch (err) {
      console.error('[ArchivedTasksModal] Failed to delete chunk:', err);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleConfirmRestore = async () => {
    if (!restoreTarget || !onRestore) return;
    setIsRestoring(true);
    try {
      if (await onRestore(restoreTarget.item.head)) await refreshChunks();
      setRestoreTarget(null);
    } finally {
      setIsRestoring(false);
    }
  };

  if (!active) return null;

  const currentTab = TABS.find((t) => t.id === activeTab) ?? TABS[0];
  const isRulesTab = activeTab === 'rules';

  const iconButtonStyle: React.CSSProperties = {
    width: '26px',
    height: '26px',
    borderRadius: '5px',
    background: 'var(--surface-1)',
    border: '1px solid var(--line)',
    color: 'var(--text-muted)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
  };

  let restoreMessage = '';
  if (restoreTarget) {
    const { restoresTask, restoresCard } = restoreTarget.plan;
    if (restoreTarget.item.tab === 'human') {
      restoreMessage = 'This task goes back into TODO.md and leaves the archive.';
    } else if (restoresTask && restoresCard) {
      restoreMessage =
        'Both come back: the run card returns to the run list, and the task it was made for goes back into TODO.md.';
    } else if (restoresCard) {
      restoreMessage = 'The run card goes back to the run list. Its task is already in TODO.md.';
    } else {
      restoreMessage = "This task's run card is already in the run list, so there's nothing to restore.";
    }
  }
  const canRestore = !!restoreTarget && (restoreTarget.plan.restoresTask || restoreTarget.plan.restoresCard);

  const renderCard = (item: ArchiveItem) => {
              const isEditing = editingKey === item.key;
              const restorable = (item.tab === 'human' || item.tab === 'ai') && !!planRestore && !!onRestore;
              // A note stored in several parts can't be saved back as one edit.
              const editable = item.chunkIds.length === 1;
              const showHeading = !!item.heading && item.heading !== item.category;
              const isLong = item.text.length > LONG_CARD_CHARS || item.text.split('\n').length > LONG_CARD_LINES;
              const isCollapsed = isLong && !isEditing && !expandedKeys.has(item.key);

              return (
                <div
                  key={item.key}
                  className="modal-archived-card"
                  style={{
                    background: 'var(--bg-card)',
                    border: '1px solid var(--line)',
                    borderRadius: '8px',
                    padding: '0.85rem 1rem',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.65rem',
                  }}
                >
                  {/* Card Header */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', minWidth: 0 }}>
                      {isLong && !isEditing && (
                        <button
                          type="button"
                          className="btn-icon"
                          onClick={() => toggleExpanded(item.key)}
                          title={isCollapsed ? 'Expand' : 'Collapse'}
                          aria-expanded={!isCollapsed}
                          style={{ ...iconButtonStyle, width: '22px', height: '22px' }}
                        >
                          <ChevronDown size={14} style={{ transform: isCollapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 0.15s ease' }} />
                        </button>
                      )}
                      {item.category && (
                        <span
                          style={{
                            fontSize: '0.7rem',
                            fontWeight: 600,
                            padding: '0.1rem 0.45rem',
                            borderRadius: '4px',
                            background: 'var(--surface-2)',
                            border: '1px solid var(--line)',
                            color: 'var(--text-bright)',
                            textTransform: 'capitalize',
                          }}
                        >
                          {item.category}
                        </span>
                      )}
                      {showHeading && (
                        <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-bright)' }}>{item.heading}</span>
                      )}
                      <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                        <Clock size={11} />
                        <span>{new Date(item.createdAt).toLocaleDateString()}</span>
                      </span>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                      <button
                        type="button"
                        className="btn-icon"
                        onClick={() => handleCopy(item.key, item.text)}
                        title="Copy text"
                        style={{ ...iconButtonStyle, color: copiedKey === item.key ? 'var(--success)' : 'var(--text-muted)' }}
                      >
                        {copiedKey === item.key ? <Check size={13} /> : <Copy size={13} />}
                      </button>

                      {restorable && (
                        <button
                          type="button"
                          className="btn-icon"
                          onClick={() => setRestoreTarget({ item, plan: planRestore!(item.head) })}
                          title="Put this back in the workspace"
                          style={{
                            height: '26px',
                            padding: '0 0.5rem',
                            borderRadius: '5px',
                            background: 'var(--accent-subtle)',
                            border: '1px solid var(--line-strong)',
                            color: 'var(--accent-text)',
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

                      {editable && (
                        <button
                          type="button"
                          className="btn-icon"
                          onClick={() => handleStartEdit(item)}
                          title="Edit"
                          style={{
                            ...iconButtonStyle,
                            background: isEditing ? 'var(--accent-subtle)' : iconButtonStyle.background,
                            border: isEditing ? '1px solid var(--line-control)' : iconButtonStyle.border,
                            color: isEditing ? 'var(--ink)' : 'var(--text-muted)',
                          }}
                        >
                          <Edit3 size={13} />
                        </button>
                      )}

                      <button
                        type="button"
                        className="btn-icon"
                        onClick={() => setItemToDelete(item)}
                        title="Delete"
                        style={{ ...iconButtonStyle, background: 'var(--danger-subtle)', border: '1px solid var(--line-strong)', color: 'var(--danger)' }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>

                  {/* Content or Inline Editor */}
                  {isEditing ? (
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '0.6rem',
                        padding: '0.75rem',
                        background: 'var(--surface-1)',
                        borderRadius: '6px',
                        border: '1px solid var(--line-strong)',
                      }}
                    >
                      <textarea
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        rows={5}
                        style={{
                          width: '100%',
                          padding: '0.65rem',
                          background: 'var(--surface-1)',
                          border: '1px solid var(--line-strong)',
                          borderRadius: '4px',
                          color: 'var(--text-bright)',
                          fontSize: '0.82rem',
                          lineHeight: 1.5,
                          outline: 'none',
                          resize: 'vertical',
                        }}
                      />
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                        {item.tab !== 'notes' && (
                          <>
                            <span style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>Category</span>
                            <input
                              type="text"
                              value={editCategory}
                              onChange={(e) => setEditCategory(e.target.value)}
                              style={{ ...fieldStyle, width: '140px' }}
                            />
                          </>
                        )}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', marginLeft: 'auto' }}>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={handleCancelEdit}
                            style={{ height: '28px', padding: '0 0.7rem', fontSize: '0.76rem' }}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            className="btn btn-emerald"
                            onClick={() => handleSaveEdit(item)}
                            disabled={isSavingEdit}
                            style={{ height: '28px', padding: '0 0.8rem', fontSize: '0.76rem', display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}
                          >
                            <Save size={12} />
                            <span>{isSavingEdit ? 'Saving…' : 'Save'}</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div
                      className="brief-markdown-render"
                      onClick={isCollapsed ? () => toggleExpanded(item.key) : undefined}
                      style={{
                        fontSize: '0.84rem',
                        lineHeight: 1.6,
                        color: 'var(--text-main)',
                        ...(isCollapsed
                          ? {
                              maxHeight: '4.8em',
                              overflow: 'hidden',
                              cursor: 'pointer',
                              maskImage: 'linear-gradient(to bottom, #000 40%, transparent)',
                              WebkitMaskImage: 'linear-gradient(to bottom, #000 40%, transparent)',
                            }
                          : {}),
                      }}
                    >
                      <MarkdownRenderer content={item.text} />
                    </div>
                  )}

                  {(item.tab === 'rules' || item.tab === 'notes') && item.taskTitle && (
                    <div style={{ paddingTop: '0.45rem', borderTop: '1px solid var(--line)', fontSize: '0.74rem', color: 'var(--text-muted)' }}>
                      From task: <span style={{ color: 'var(--text-main)' }}>{item.taskTitle}</span>
                    </div>
                  )}
                </div>
              );
  };

  if (embedded) {
    return (
      <EmbeddedArchive
        page={page}
        activeTab={activeTab}
        onSwitchTab={switchTab}
        counts={counts}
        isLoading={isLoading}
        items={displayedItems}
        searchQuery={searchQuery}
        onSearch={setSearchQuery}
        categories={availableCategories}
        selectedCategory={selectedCategory}
        onSelectCategory={setSelectedCategory}
        projectId={projectId}
        expandedKeys={expandedKeys}
        onToggleExpanded={toggleExpanded}
        copiedKey={copiedKey}
        onCopy={handleCopy}
        canRestore={!!planRestore && !!onRestore}
        onAskRestore={(item) => setRestoreTarget({ item, plan: planRestore!(item.head) })}
        editingKey={editingKey}
        editText={editText}
        setEditText={setEditText}
        editCategory={editCategory}
        setEditCategory={setEditCategory}
        isSavingEdit={isSavingEdit}
        onStartEdit={handleStartEdit}
        onCancelEdit={handleCancelEdit}
        onSaveEdit={handleSaveEdit}
        onAskDelete={setItemToDelete}
        newRule={{
          open: isCreatingNew,
          setOpen: setIsCreatingNew,
          text: newText,
          setText: setNewText,
          scope: newScope,
          setScope: setNewScope,
          error: newError,
          submitting: isSubmittingNew,
          onSubmit: handleCreateNew,
        }}
        restore={
          restoreTarget
            ? { title: restoreTarget.plan.title, message: restoreMessage, canRestore, busy: isRestoring, onConfirm: handleConfirmRestore, onCancel: () => setRestoreTarget(null) }
            : null
        }
        remove={
          itemToDelete
            ? { text: itemToDelete.text, busy: isDeleting, onConfirm: handleConfirmDelete, onCancel: () => setItemToDelete(null) }
            : null
        }
      />
    );
  }

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
          background: 'var(--bg-pane)',
          border: '1px solid var(--line)',
          borderRadius: '12px',
          boxShadow: 'var(--shadow-dialog)',
          overflow: 'hidden',
        }}
      >
        {/* ── Header ── */}
        <div
          className="modal-header"
          style={{
            padding: '1rem 1.5rem',
            background: 'var(--bg-darkest)',
            borderBottom: '1px solid var(--line)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '1rem',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem', minWidth: 0 }}>
            <div
              style={{
                width: '36px',
                height: '36px',
                flexShrink: 0,
                borderRadius: '8px',
                background: 'var(--warning-subtle)',
                border: '1px solid var(--line-strong)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--warning)',
              }}
            >
              <Archive size={19} />
            </div>
            <div style={{ minWidth: 0 }}>
              <h3 style={{ margin: 0, fontSize: '1.12rem', fontWeight: 600, color: 'var(--text-bright)' }}>
                Archives & Learnings
              </h3>
              <p style={{ margin: '0.2rem 0 0', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                Everything the AI remembers about this project, plus your archived tasks.
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setIsCreatingNew((prev) => !prev)}
              style={{ height: '30px', padding: '0 0.75rem', fontSize: '0.78rem', display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}
            >
              <Plus size={14} />
              <span>New Knowledge</span>
            </button>
            <button
              type="button"
              className="btn-icon"
              onClick={onClose}
              title="Close"
              style={{ ...iconButtonStyle, width: '30px', height: '30px', borderRadius: '6px', border: '1px solid var(--line)' }}
            >
              <X size={17} />
            </button>
          </div>
        </div>

        {/* ── New Knowledge Form ── */}
        {isCreatingNew && (
          <div
            style={{
              padding: '1rem 1.5rem',
              background: 'var(--surface-2)',
              borderBottom: '1px solid var(--line-strong)',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.65rem',
            }}
          >
            <div style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--ink-muted)' }}>
              Add something the AI should always follow in this project
            </div>
            <textarea
              value={newText}
              onChange={(e) => setNewText(e.target.value)}
              placeholder="e.g. Run npm test before saying a task is done."
              rows={3}
              autoFocus
              style={{
                width: '100%',
                padding: '0.65rem',
                background: 'var(--surface-1)',
                border: '1px solid var(--line)',
                borderRadius: '6px',
                color: 'var(--text-bright)',
                fontSize: '0.84rem',
                lineHeight: 1.5,
                outline: 'none',
                resize: 'vertical',
              }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>Applies to</span>
              <CategoryDropdown value={newScope} options={RULE_SCOPES} onChange={setNewScope} />
              {newError ? (
                <span style={{ fontSize: '0.74rem', color: 'var(--accent-rose)' }}>{newError}</span>
              ) : (
                <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>Saved under Learnings.</span>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', marginLeft: 'auto' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setIsCreatingNew(false)}
                  style={{ height: '28px', padding: '0 0.7rem', fontSize: '0.76rem' }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-emerald"
                  onClick={handleCreateNew}
                  disabled={isSubmittingNew || !newText.trim() || !insightsSupported()}
                  style={{ height: '28px', padding: '0 0.8rem', fontSize: '0.76rem', display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}
                >
                  <Save size={13} />
                  <span>{isSubmittingNew ? 'Saving…' : 'Save'}</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Tabs, Search & Category ── */}
        <div
          style={{
            padding: '0.85rem 1.5rem',
            background: 'var(--bg-card)',
            borderBottom: '1px solid var(--line)',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap' }}>
            {TABS.map((tab) => {
              const active = tab.id === activeTab;
              return (
                <button
                  key={tab.id}
                  type="button"
                  className={`archive-filter-pill ${active ? 'active' : ''}`}
                  onClick={() => switchTab(tab.id)}
                  style={active ? { color: tab.color, borderColor: `${tab.color}66` } : undefined}
                >
                  <span style={{ display: 'inline-flex', color: tab.color }}>{tab.icon}</span>
                  <span>{tab.label}</span>
                  <span className="pill-count">{counts[tab.id]}</span>
                </button>
              );
            })}
          </div>

          {!isRulesTab && (
            <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ position: 'relative', flex: 1, minWidth: '240px' }}>
                <Search
                  size={14}
                  style={{ position: 'absolute', left: '0.8rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }}
                />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={`Search ${currentTab.label}…`}
                  style={{ ...fieldStyle, width: '100%', height: '34px', padding: '0 2rem 0 2.3rem', fontSize: '0.82rem', borderRadius: '6px' }}
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    title="Clear search"
                    style={{ position: 'absolute', right: '0.65rem', top: '50%', transform: 'translateY(-50%)', background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 0 }}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
              {availableCategories.length > 0 && (
                <CategoryDropdown
                  value={selectedCategory}
                  options={availableCategories}
                  onChange={setSelectedCategory}
                  allLabel="All categories"
                />
              )}
            </div>
          )}
        </div>

        {/* ── List ── */}
        <div
          className="modal-body"
          style={{ flex: 1, overflowY: 'auto', padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '0.85rem' }}
        >
          {isRulesTab ? (
            <>
              <LearnedRulesSection projectId={projectId} />
              {displayedItems.length > 0 && (
                <>
                  <div style={{ marginTop: '0.75rem' }}>
                    <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-bright)' }}>Older notes</div>
                    <p style={{ margin: '0.2rem 0 0', fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.45 }}>
                      Lessons earlier versions of Ergo picked out of finished runs. The AI can still find them, but they
                      aren't rules. Delete any that are wrong or no longer useful.
                    </p>
                  </div>
                  {displayedItems.map(renderCard)}
                </>
              )}
            </>
          ) : displayedItems.length === 0 ? (
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
                  background: 'var(--surface-1)',
                  border: '1px solid var(--line)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: currentTab.color,
                }}
              >
                {currentTab.icon}
              </div>
              <h4 style={{ margin: 0, fontSize: '0.95rem', color: 'var(--text-bright)' }}>
                {isLoading ? 'Loading…' : searchQuery || selectedCategory !== 'all' ? 'No matches' : 'Nothing here yet'}
              </h4>
              {!isLoading && (
                <p style={{ margin: 0, fontSize: '0.8rem', maxWidth: '420px', lineHeight: 1.5 }}>
                  {searchQuery || selectedCategory !== 'all' ? 'Try a different search or category.' : currentTab.empty}
                </p>
              )}
            </div>
          ) : (
            displayedItems.map(renderCard)
          )}
        </div>

        {/* ── Footer ── */}
        <div
          className="modal-footer"
          style={{
            padding: '0.75rem 1.5rem',
            background: 'var(--bg-darkest)',
            borderTop: '1px solid var(--line)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            {isRulesTab
              ? `${rulesCount} ${rulesCount === 1 ? 'rule' : 'rules'}${displayedItems.length > 0 ? ` · ${displayedItems.length} older ${displayedItems.length === 1 ? 'note' : 'notes'}` : ''}`
              : `${displayedItems.length} ${displayedItems.length === 1 ? 'item' : 'items'}`}
          </span>
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

      {/* ── Restore Confirmation Dialog ── */}
      {restoreTarget && (
        <div className="modal-overlay" onClick={() => setRestoreTarget(null)} style={{ zIndex: 120 }}>
          <div className="modal-card archive-delete-modal is-archive" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--accent-text)' }}>
                <RotateCcw size={18} />
                <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>Restore?</h3>
              </div>
              <button type="button" className="btn-icon" onClick={() => setRestoreTarget(null)}>
                <X size={16} />
              </button>
            </div>
            <div className="modal-body" style={{ padding: '1rem 1.25rem', fontSize: '0.88rem', color: 'var(--text-secondary)' }}>
              <p style={{ margin: 0, marginBottom: '0.75rem' }}>
                <strong>"{restoreTarget.plan.title}"</strong>
              </p>
              <div className="archive-delete-warning-box">
                <AlertTriangle size={15} style={{ flexShrink: 0 }} />
                <span>{restoreMessage}</span>
              </div>
            </div>
            <div className="modal-footer" style={{ padding: '0.75rem 1.25rem', display: 'flex', justifyContent: 'flex-end', gap: '0.6rem' }}>
              <button type="button" className="btn btn-secondary" onClick={() => setRestoreTarget(null)}>
                {canRestore ? 'Cancel' : 'OK'}
              </button>
              {canRestore && (
                <button type="button" className="btn btn-primary" onClick={handleConfirmRestore} disabled={isRestoring}>
                  {isRestoring ? 'Restoring…' : 'Restore'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Delete Confirmation Dialog ── */}
      {itemToDelete && (
        <div className="modal-overlay" onClick={() => setItemToDelete(null)} style={{ zIndex: 120 }}>
          <div
            className="modal-content archive-delete-modal"
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth: '460px',
              background: 'var(--bg-card)',
              border: '1px solid var(--line-strong)',
              borderRadius: '10px',
              boxShadow: 'var(--shadow-dialog)',
            }}
          >
            <div className="modal-header" style={{ padding: '0.85rem 1.25rem', borderBottom: '1px solid var(--line)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--accent-rose)' }}>
                <AlertTriangle size={18} />
                <h4 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600 }}>Delete this item?</h4>
              </div>
              <button type="button" className="btn-icon" onClick={() => setItemToDelete(null)}>
                <X size={15} />
              </button>
            </div>

            <div className="modal-body" style={{ padding: '1rem 1.25rem', fontSize: '0.82rem', color: 'var(--text-main)' }}>
              <p style={{ margin: '0 0 0.75rem' }}>
                It will be deleted for good, and the AI won't be able to use it anymore. This can't be undone.
              </p>
              <div
                style={{
                  padding: '0.65rem',
                  background: 'var(--surface-1)',
                  borderRadius: '5px',
                  border: '1px solid var(--line)',
                  fontSize: '0.78rem',
                  color: 'var(--text-bright)',
                  maxHeight: '120px',
                  overflowY: 'auto',
                }}
              >
                {itemToDelete.text.slice(0, 240)}
                {itemToDelete.text.length > 240 ? '…' : ''}
              </div>
            </div>

            <div className="modal-footer" style={{ padding: '0.75rem 1.25rem', borderTop: '1px solid var(--line)' }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setItemToDelete(null)}
                style={{ height: '28px', padding: '0 0.7rem', fontSize: '0.76rem' }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={handleConfirmDelete}
                disabled={isDeleting}
                style={{ height: '28px', padding: '0 0.75rem', fontSize: '0.76rem', background: 'var(--accent-rose)', color: 'var(--ink)', border: 'none' }}
              >
                {isDeleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(modalElement, document.body) : modalElement;
};

/* ───────────── Embedded pages (Settings › Archive, Rules, Memory) ───────────── */

interface EmbeddedArchiveProps {
  page: ArchivePage;
  activeTab: ArchiveTab;
  onSwitchTab: (tab: ArchiveTab) => void;
  counts: Record<ArchiveTab, number>;
  isLoading: boolean;
  items: ArchiveItem[];
  searchQuery: string;
  onSearch: (q: string) => void;
  categories: string[];
  selectedCategory: string;
  onSelectCategory: (c: string) => void;
  projectId: string;
  expandedKeys: Set<string>;
  onToggleExpanded: (key: string) => void;
  copiedKey: string | null;
  onCopy: (key: string, text: string) => void;
  canRestore: boolean;
  onAskRestore: (item: ArchiveItem) => void;
  editingKey: string | null;
  editText: string;
  setEditText: (v: string) => void;
  editCategory: string;
  setEditCategory: (v: string) => void;
  isSavingEdit: boolean;
  onStartEdit: (item: ArchiveItem) => void;
  onCancelEdit: () => void;
  onSaveEdit: (item: ArchiveItem) => void;
  onAskDelete: (item: ArchiveItem) => void;
  newRule: {
    open: boolean;
    setOpen: (v: boolean) => void;
    text: string;
    setText: (v: string) => void;
    scope: string;
    setScope: (v: string) => void;
    error: string | null;
    submitting: boolean;
    onSubmit: () => void;
  };
  restore: { title: string; message: string; canRestore: boolean; busy: boolean; onConfirm: () => void; onCancel: () => void } | null;
  remove: { text: string; busy: boolean; onConfirm: () => void; onCancel: () => void } | null;
}

const EMBEDDED_EMPTY: Record<ArchiveTab, { title: string; text: string }> = {
  human: { title: 'No archived tasks', text: 'Tasks you archive from TODO.md show up here, ready to restore.' },
  ai: { title: 'No archived runs', text: 'Run cards you archive show up here, ready to restore.' },
  rules: { title: 'No older notes', text: '' },
  notes: { title: 'No notes yet', text: 'Plans, reports and completion records the agent saves while it works show up here. It reads them back on later tasks.' },
};

const EmbeddedArchive: React.FC<EmbeddedArchiveProps> = (p) => {
  const renderItem = (item: ArchiveItem) => {
    const isEditing = p.editingKey === item.key;
    const restorable = (item.tab === 'human' || item.tab === 'ai') && p.canRestore;
    const editable = item.chunkIds.length === 1;
    const showHeading = !!item.heading && item.heading !== item.category;
    const isLong = item.text.length > LONG_CARD_CHARS || item.text.split('\n').length > LONG_CARD_LINES;
    const isCollapsed = isLong && !isEditing && !p.expandedKeys.has(item.key);
    const meta = [item.category, new Date(item.createdAt).toLocaleDateString(), item.taskTitle && (item.tab === 'rules' || item.tab === 'notes') ? `From "${item.taskTitle}"` : null]
      .filter(Boolean)
      .join(' · ');
    return (
      <div key={item.key} className="eg-srow eg-settings-top">
        <div className="eg-srow-text">
          {showHeading && <div className="eg-srow-title">{item.heading}</div>}
          <div className="eg-srow-help">{meta}</div>
          {isEditing ? (
            <div className="eg-settings-sub">
              <textarea className="eg-input eg-settings-textarea" value={p.editText} onChange={(e) => p.setEditText(e.target.value)} rows={5} aria-label="Text" />
              <div className="eg-settings-actions">
                {item.tab !== 'notes' && (
                  <Input value={p.editCategory} onChange={(e) => p.setEditCategory(e.target.value)} aria-label="Category" placeholder="Category" style={{ width: 160 }} />
                )}
                <span className="eg-spacer" />
                <Button size="sm" variant="ghost" onClick={p.onCancelEdit}>
                  Cancel
                </Button>
                <Button size="sm" variant="primary" onClick={() => p.onSaveEdit(item)} disabled={p.isSavingEdit || !p.editText.trim()}>
                  {p.isSavingEdit ? 'Saving…' : 'Save'}
                </Button>
              </div>
            </div>
          ) : (
            <div
              className={`eg-md eg-settings-md${isCollapsed ? ' is-clamped' : ''}`}
              onClick={isCollapsed ? () => p.onToggleExpanded(item.key) : undefined}
            >
              <MarkdownRenderer content={item.text} />
            </div>
          )}
        </div>
        {!isEditing && (
          <div className="eg-settings-actions">
            {isLong && (
              <IconButton icon={isCollapsed ? ChevronDown : ChevronUp} label={isCollapsed ? 'Show all' : 'Show less'} size="sm" onClick={() => p.onToggleExpanded(item.key)} />
            )}
            <IconButton icon={p.copiedKey === item.key ? Check : Copy} label={p.copiedKey === item.key ? 'Copied' : 'Copy text'} size="sm" onClick={() => p.onCopy(item.key, item.text)} />
            {editable && <IconButton icon={Edit3} label="Edit" size="sm" onClick={() => p.onStartEdit(item)} />}
            <IconButton icon={Trash2} label="Delete" size="sm" onClick={() => p.onAskDelete(item)} />
            {restorable && (
              <Button size="sm" icon={RotateCcw} onClick={() => p.onAskRestore(item)}>
                Restore
              </Button>
            )}
          </div>
        )}
      </div>
    );
  };

  const search = (placeholder: string) => (
    <div className="eg-settings-filter">
      <Input icon={Search} value={p.searchQuery} onChange={(e) => p.onSearch(e.target.value)} placeholder={placeholder} aria-label={placeholder} style={{ flex: 1 }} />
      {p.categories.length > 0 && (
        <MenuButton
          align="end"
          items={['all', ...p.categories].map((c) => ({
            label: c === 'all' ? 'All categories' : c,
            checked: p.selectedCategory === c,
            onSelect: () => p.onSelectCategory(c),
          }))}
          trigger={(t) => (
            <button type="button" className="eg-select" {...t}>
              {p.selectedCategory === 'all' ? 'All categories' : p.selectedCategory}
              <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
            </button>
          )}
        />
      )}
    </div>
  );

  const list = (tab: ArchiveTab) => {
    if (p.items.length > 0) return <div className="eg-srows">{p.items.map(renderItem)}</div>;
    if (p.isLoading) return <p className="eg-srow-help">Loading…</p>;
    const filtered = !!p.searchQuery || p.selectedCategory !== 'all';
    return (
      <EmptyState
        icon={tab === 'notes' ? NotebookPen : Archive}
        title={filtered ? 'No matches' : EMBEDDED_EMPTY[tab].title}
        text={filtered ? 'Try a different search or category.' : EMBEDDED_EMPTY[tab].text}
        actions={
          filtered ? (
            <Button size="sm" onClick={() => { p.onSearch(''); p.onSelectCategory('all'); }}>
              Clear search
            </Button>
          ) : undefined
        }
      />
    );
  };

  const nr = p.newRule;

  return (
    <div className="eg-settings-embed">
      {p.page === 'archive' && (
        <section className="eg-sgroup">
          <Tabs
            items={[
              { id: 'human' as ArchiveTab, label: 'Tasks', count: p.counts.human },
              { id: 'ai' as ArchiveTab, label: 'Runs', count: p.counts.ai },
            ]}
            value={p.activeTab === 'ai' ? 'ai' : 'human'}
            onChange={p.onSwitchTab}
          />
          {search(p.activeTab === 'ai' ? 'Search archived runs' : 'Search archived tasks')}
          {list(p.activeTab === 'ai' ? 'ai' : 'human')}
        </section>
      )}

      {p.page === 'rules' && (
        <>
          <section className="eg-sgroup">
            <div className="eg-settings-grouphead">
              <h3 className="eg-sgroup-title">Rules</h3>
              {!nr.open && (
                <Button size="sm" icon={Plus} onClick={() => nr.setOpen(true)} disabled={!insightsSupported()}>
                  Add rule
                </Button>
              )}
            </div>
            {nr.open && (
              <div className="eg-settings-card">
                <Field label="Rule" help={nr.error ? undefined : 'Every run of this project gets it.'} error={nr.error || undefined}>
                  <textarea
                    className="eg-input eg-settings-textarea"
                    value={nr.text}
                    onChange={(e) => nr.setText(e.target.value)}
                    placeholder="Run npm test before saying a task is done."
                    rows={3}
                    autoFocus
                  />
                </Field>
                <div className="eg-settings-actions">
                  <span className="eg-srow-help">Applies to</span>
                  <SegmentedControl label="Applies to" options={RULE_SCOPES} value={nr.scope} onChange={nr.setScope} />
                  <span className="eg-spacer" />
                  <Button size="sm" variant="ghost" onClick={() => nr.setOpen(false)}>
                    Cancel
                  </Button>
                  <Button size="sm" variant="primary" onClick={nr.onSubmit} disabled={nr.submitting || !nr.text.trim() || !insightsSupported()}>
                    {nr.submitting ? 'Adding…' : 'Add rule'}
                  </Button>
                </div>
              </div>
            )}
            <LearnedRulesSection projectId={p.projectId} />
          </section>
          {p.items.length > 0 && (
            <section className="eg-sgroup">
              <h3 className="eg-sgroup-title">Older notes</h3>
              <p className="eg-settings-groupdesc">
                Lessons earlier versions of Ergo picked out of finished runs. The agent can still find them, but they aren't rules. Delete any that are wrong.
              </p>
              <div className="eg-srows">{p.items.map(renderItem)}</div>
            </section>
          )}
        </>
      )}

      {p.page === 'memory' && (
        <section className="eg-sgroup">
          <h3 className="eg-sgroup-title">Agent notes</h3>
          <p className="eg-settings-groupdesc">Plans, reports and completion records the agent saved for this project. It searches them before later tasks.</p>
          {search('Search notes')}
          {list('notes')}
        </section>
      )}

      {p.restore && (
        <Dialog
          title="Restore?"
          description={`"${p.restore.title}"`}
          onClose={p.restore.onCancel}
          width={440}
          footer={
            p.restore.canRestore ? (
              <>
                <Button variant="ghost" onClick={p.restore.onCancel}>
                  Cancel
                </Button>
                <Button variant="primary" onClick={p.restore.onConfirm} disabled={p.restore.busy}>
                  {p.restore.busy ? 'Restoring…' : 'Restore'}
                </Button>
              </>
            ) : (
              <Button onClick={p.restore.onCancel}>Close</Button>
            )
          }
        >
          <p className="eg-settings-dialogtext">{p.restore.message}</p>
        </Dialog>
      )}

      {p.remove && (
        <Dialog
          title="Delete this item?"
          description="It's deleted for good and the agent can't use it anymore."
          onClose={p.remove.onCancel}
          width={440}
          footer={
            <>
              <Button variant="ghost" onClick={p.remove.onCancel}>
                Cancel
              </Button>
              <Button variant="danger" onClick={p.remove.onConfirm} disabled={p.remove.busy}>
                {p.remove.busy ? 'Deleting…' : 'Delete'}
              </Button>
            </>
          }
        >
          <div className="eg-settings-quote">
            {p.remove.text.slice(0, 240)}
            {p.remove.text.length > 240 ? '…' : ''}
          </div>
        </Dialog>
      )}
    </div>
  );
};
