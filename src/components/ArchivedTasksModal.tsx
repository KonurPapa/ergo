import React, { useState, useMemo } from 'react';
import {
  Archive,
  X,
  Search,
  RotateCcw,
  Trash2,
  AlertTriangle,
  Columns,
  ChevronDown,
  ClipboardList,
  Wrench,
  Flag,
  FileCode
} from 'lucide-react';
import { type TaskItem, type SwimLaneDoc, type AgentContextItem } from '../types';
import { MarkdownRenderer } from './MarkdownRenderer';

interface ArchivedTasksModalProps {
  isOpen: boolean;
  onClose: () => void;
  archivedTasks: TaskItem[];
  swimLanes: SwimLaneDoc[];
  briefs?: AgentContextItem[];
  archivedBriefs?: AgentContextItem[];
  onUnarchiveTask?: (taskId: string | number) => void;
  onDeleteArchivedTask?: (taskId: string | number) => void;
}

export const ArchivedTasksModal: React.FC<ArchivedTasksModalProps> = ({
  isOpen,
  onClose,
  archivedTasks,
  swimLanes,
  briefs = [],
  archivedBriefs = [],
  onUnarchiveTask,
  onDeleteArchivedTask,
}) => {
  const [selectedLaneId, setSelectedLaneId] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [taskToDelete, setTaskToDelete] = useState<TaskItem | null>(null);
  const [expandedBriefs, setExpandedBriefs] = useState<Record<string | number, boolean>>({});

  const toggleBriefExpansion = (taskId: string | number) => {
    setExpandedBriefs((prev) => ({ ...prev, [taskId]: !prev[taskId] }));
  };

  // Map each task to its swimlane metadata
  const getLaneMeta = useMemo(() => {
    return (task: TaskItem): { id: string; title: string; fileName: string } => {
      if (task.swimLaneId) {
        const found = swimLanes.find((l) => l.id === task.swimLaneId);
        if (found) {
          const fn = found.filePath ? found.filePath.split('/').pop() || 'TODO.md' : 'TODO.md';
          return { id: found.id, title: found.title, fileName: fn };
        }
      }
      if (task.sourceFileName) {
        const found = swimLanes.find(
          (l) => l.filePath && l.filePath.endsWith(task.sourceFileName!)
        );
        if (found) {
          return { id: found.id, title: found.title, fileName: task.sourceFileName };
        }
      }
      const defaultLane = swimLanes[0] || {
        id: 'lane-default',
        title: 'Human Workspace',
        filePath: 'TODO.md',
      };
      return {
        id: defaultLane.id,
        title: defaultLane.title,
        fileName: defaultLane.filePath ? defaultLane.filePath.split('/').pop() || 'TODO.md' : 'TODO.md',
      };
    };
  }, [swimLanes]);

  // Filter tasks by search query and selected lane
  const filteredTasks = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    return archivedTasks.filter((task) => {
      const meta = getLaneMeta(task);
      if (selectedLaneId !== 'all' && meta.id !== selectedLaneId) {
        return false;
      }

      if (!query) return true;

      const titleMatch = task.title.toLowerCase().includes(query);
      const categoryMatch = task.category ? task.category.toLowerCase().includes(query) : false;
      const subtaskMatch = task.subtasks?.some((st) => st.text.toLowerCase().includes(query)) || false;
      const laneMatch = meta.title.toLowerCase().includes(query) || meta.fileName.toLowerCase().includes(query);

      return titleMatch || categoryMatch || subtaskMatch || laneMatch;
    });
  }, [archivedTasks, selectedLaneId, searchQuery, getLaneMeta]);

  // Group filtered tasks by swim lane
  const groupedTasks = useMemo(() => {
    const groups: Array<{
      laneId: string;
      laneTitle: string;
      fileName: string;
      tasks: TaskItem[];
    }> = [];

    // Ensure lanes maintain a deterministic order based on swimLanes
    const laneMap = new Map<string, { laneTitle: string; fileName: string; tasks: TaskItem[] }>();

    for (const task of filteredTasks) {
      const meta = getLaneMeta(task);
      if (!laneMap.has(meta.id)) {
        laneMap.set(meta.id, {
          laneTitle: meta.title,
          fileName: meta.fileName,
          tasks: [],
        });
      }
      laneMap.get(meta.id)!.tasks.push(task);
    }

    laneMap.forEach((val, key) => {
      groups.push({
        laneId: key,
        laneTitle: val.laneTitle,
        fileName: val.fileName,
        tasks: val.tasks,
      });
    });

    return groups;
  }, [filteredTasks, getLaneMeta]);

  // Count of archived tasks per swim lane
  const laneCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const task of archivedTasks) {
      const meta = getLaneMeta(task);
      counts[meta.id] = (counts[meta.id] || 0) + 1;
    }
    return counts;
  }, [archivedTasks, getLaneMeta]);

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content archived-tasks-modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: '920px',
          width: '95vw',
          maxHeight: '88vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 24px 60px rgba(0,0,0,0.6), 0 0 30px rgba(245, 158, 11, 0.1)',
        }}
      >
        {/* ── Modal Header ── */}
        <div className="modal-header" style={{ padding: '1rem 1.5rem', borderBottom: '1px solid var(--border-subtle)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
            <div
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '8px',
                background: 'rgba(245, 158, 11, 0.15)',
                border: '1px solid rgba(245, 158, 11, 0.3)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#f59e0b',
              }}
            >
              <Archive size={17} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-bright)' }}>
                  Archived Tasks
                </h3>
                <span className="archive-count-badge">
                  {archivedTasks.length} {archivedTasks.length === 1 ? 'task' : 'tasks'}
                </span>
              </div>
              <p style={{ margin: '0.15rem 0 0', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                View and manage archived task records across all workspace swim lanes
              </p>
            </div>
          </div>
          <button type="button" className="btn-icon" onClick={onClose} title="Close (Esc)">
            <X size={18} />
          </button>
        </div>

        {/* ── Filter & Search Toolbar ── */}
        <div
          style={{
            padding: '0.85rem 1.5rem',
            background: 'var(--bg-pane)',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem',
          }}
        >
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
            {/* Search Input */}
            <div style={{ position: 'relative', flex: 1, minWidth: '220px' }}>
              <Search
                size={14}
                style={{
                  position: 'absolute',
                  left: '0.75rem',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  color: 'var(--text-muted)',
                  pointerEvents: 'none',
                }}
              />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search archived tasks, subtasks, or tags..."
                style={{
                  width: '100%',
                  padding: '0.45rem 2rem 0.45rem 2.2rem',
                  background: 'var(--bg-input, rgba(0,0,0,0.2))',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-sm, 6px)',
                  color: 'var(--text-bright)',
                  fontSize: '0.82rem',
                  outline: 'none',
                }}
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  style={{
                    position: 'absolute',
                    right: '0.6rem',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-muted)',
                    cursor: 'pointer',
                    padding: '0.2rem',
                  }}
                  title="Clear search"
                >
                  <X size={13} />
                </button>
              )}
            </div>

            {/* Swim Lane Filter Pills */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', overflowX: 'auto', maxWidth: '100%' }}>
              <button
                type="button"
                className={`archive-filter-pill ${selectedLaneId === 'all' ? 'active' : ''}`}
                onClick={() => setSelectedLaneId('all')}
              >
                <span>All Lanes</span>
                <span className="pill-count">{archivedTasks.length}</span>
              </button>
              {swimLanes.map((lane) => {
                const count = laneCounts[lane.id] || 0;
                return (
                  <button
                    key={lane.id}
                    type="button"
                    className={`archive-filter-pill ${selectedLaneId === lane.id ? 'active' : ''}`}
                    onClick={() => setSelectedLaneId(lane.id)}
                  >
                    <span>{lane.title}</span>
                    <span className="pill-count">{count}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* ── Modal Body (Task Groups) ── */}
        <div
          className="modal-body"
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '1.25rem 1.5rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '1.5rem',
          }}
        >
          {archivedTasks.length === 0 ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '4rem 1rem',
                textAlign: 'center',
              }}
            >
              <div
                style={{
                  width: '56px',
                  height: '56px',
                  borderRadius: '50%',
                  background: 'rgba(245, 158, 11, 0.1)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#f59e0b',
                  marginBottom: '1rem',
                }}
              >
                <Archive size={26} />
              </div>
              <h4 style={{ margin: '0 0 0.4rem', fontSize: '1rem', fontWeight: 600, color: 'var(--text-bright)' }}>
                No Archived Tasks
              </h4>
              <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-muted)', maxWidth: '380px' }}>
                Tasks archived from any swim lane menu will appear here organized by their original swim lane and position.
              </p>
            </div>
          ) : filteredTasks.length === 0 ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '3rem 1rem',
                textAlign: 'center',
              }}
            >
              <Search size={32} style={{ color: 'var(--text-muted)', marginBottom: '0.75rem', opacity: 0.5 }} />
              <h4 style={{ margin: '0 0 0.35rem', fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-bright)' }}>
                No matching archived tasks
              </h4>
              <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                Try adjusting your search query or selecting another swim lane.
              </p>
            </div>
          ) : (
            groupedTasks.map((group) => (
              <div key={group.laneId} className="archived-lane-group">
                {/* Swim Lane Section Header */}
                <div
                  className="archived-lane-group-header"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '0.5rem 0.8rem',
                    background: 'rgba(99, 102, 241, 0.08)',
                    border: '1px solid rgba(99, 102, 241, 0.22)',
                    borderRadius: 'var(--radius-sm, 6px)',
                    marginBottom: '0.75rem',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.55rem' }}>
                    <Columns size={14} style={{ color: '#818cf8' }} />
                    <span style={{ fontSize: '0.86rem', fontWeight: 700, color: 'var(--text-bright)' }}>
                      {group.laneTitle}
                    </span>
                    <span className="swimlane-doc-badge" style={{ fontSize: '0.7rem' }}>
                      {group.fileName}
                    </span>
                  </div>
                  <span
                    style={{
                      fontSize: '0.72rem',
                      fontWeight: 600,
                      color: 'var(--text-muted)',
                      background: 'rgba(0, 0, 0, 0.15)',
                      padding: '0.1rem 0.45rem',
                      borderRadius: '4px',
                    }}
                  >
                    {group.tasks.length} {group.tasks.length === 1 ? 'task' : 'tasks'}
                  </span>
                </div>

                {/* Tasks List in this Lane */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                  {group.tasks.map((task) => {
                    const taskPositionNum =
                      task.listIndex ??
                      (task.archivedAtIndex != null
                        ? task.archivedAtIndex + 1
                        : typeof task.id === 'number' && task.id > 1000
                        ? task.id - 1000
                        : 1);

                    const taskBrief =
                      (task.id ? archivedBriefs.find((b) => b.sourceTaskId === task.id) : null) ||
                      archivedBriefs.find((b) => b.title.trim().toLowerCase() === task.title.trim().toLowerCase()) ||
                      (task.id ? briefs.find((b) => b.sourceTaskId === task.id) : null) ||
                      briefs.find((b) => b.title.trim().toLowerCase() === task.title.trim().toLowerCase()) ||
                      undefined;

                    const isBriefOpen = !!expandedBriefs[task.id];
                    const overviewText = taskBrief?.overview || taskBrief?.brief || '';
                    const buildText = taskBrief?.buildAndVerification || taskBrief?.built || '';
                    const completionText = taskBrief?.completion || taskBrief?.validation || taskBrief?.humanReview || taskBrief?.followUps || '';
                    const hasBriefContent = !!(overviewText || buildText || completionText);

                    return (
                      <div
                        key={task.id}
                        className="archived-task-card modal-archived-card"
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '0.65rem',
                          padding: '0.85rem 1rem',
                          background: 'var(--bg-card)',
                          border: '1px solid var(--border-subtle)',
                          borderRadius: 'var(--radius-md, 8px)',
                          boxShadow: '0 2px 6px rgba(0,0,0,0.08)',
                          transition: 'all 0.15s ease',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.85rem', width: '100%' }}>
                          {/* Task Number & Checkbox Column */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0, marginTop: '2px' }}>
                            <span
                              style={{
                                fontSize: '0.75rem',
                                fontWeight: 700,
                                fontFamily: 'var(--font-mono)',
                                color: 'var(--accent-primary)',
                                background: 'rgba(99, 102, 241, 0.12)',
                                border: '1px solid rgba(99, 102, 241, 0.25)',
                                padding: '0.1rem 0.4rem',
                                borderRadius: '4px',
                              }}
                            >
                              #{taskPositionNum}
                            </span>
                            <div
                              className={`task-ui-checkbox parent-checkbox ${task.isDone ? 'checked' : ''}`}
                              style={{ cursor: 'default', pointerEvents: 'none' }}
                            >
                              {task.isDone && (
                                <svg
                                  width="11"
                                  height="11"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="3"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                >
                                  <polyline points="20 6 9 17 4 12" />
                                </svg>
                              )}
                            </div>
                          </div>

                          {/* Task Main Content */}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                              <MarkdownRenderer
                                content={task.isDone ? `~~${task.title}~~` : task.title}
                                inline={true}
                                className={`archived-task-title ${task.isDone ? 'is-done' : ''}`}
                              />
                              {task.category && task.category !== 'Archive' && task.category !== 'Untitled' && (
                                <span className="archived-task-category-pill">{task.category}</span>
                              )}
                              {hasBriefContent && (
                                <button
                                  type="button"
                                  onClick={() => toggleBriefExpansion(task.id)}
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '0.3rem',
                                    fontSize: '0.72rem',
                                    padding: '0.15rem 0.45rem',
                                    borderRadius: '4px',
                                    border: '1px solid rgba(139, 92, 246, 0.3)',
                                    background: isBriefOpen ? 'rgba(139, 92, 246, 0.2)' : 'rgba(139, 92, 246, 0.1)',
                                    color: 'var(--accent-violet, #a78bfa)',
                                    cursor: 'pointer',
                                    transition: 'all 0.15s ease',
                                  }}
                                  title={isBriefOpen ? 'Hide AI Context Brief' : 'View AI Context Brief'}
                                >
                                  <FileCode size={11} />
                                  <span>AI Context</span>
                                  <ChevronDown size={11} style={{ transform: isBriefOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s ease' }} />
                                </button>
                              )}
                            </div>

                            {/* Subtasks List */}
                            {task.subtasks && task.subtasks.length > 0 && (
                              <div className="archived-subtasks-list" style={{ marginTop: '0.45rem' }}>
                                {task.subtasks.map((st) => (
                                  <div key={st.id} className="archived-subtask-item">
                                    <span className="archived-bullet">•</span>
                                    {st.isHumanReview && (
                                      <span
                                        className="human-review-tag"
                                        style={{
                                          fontSize: '0.68rem',
                                          padding: '0.05rem 0.35rem',
                                          borderRadius: '3px',
                                          background: 'rgba(139, 92, 246, 0.15)',
                                          color: 'var(--accent-violet)',
                                          fontWeight: 600,
                                        }}
                                      >
                                        human review
                                      </span>
                                    )}
                                    <MarkdownRenderer
                                      content={st.isDone ? `~~${st.text}~~` : st.text}
                                      inline={true}
                                      className={st.isDone ? 'is-done' : ''}
                                    />
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>

                          {/* Action Buttons */}
                          <div className="archived-task-actions" style={{ flexShrink: 0, marginTop: '2px' }}>
                            <button
                              type="button"
                              className="archived-action-btn unarchive-btn"
                              title="Restore task to active workspace"
                              onClick={() => onUnarchiveTask?.(task.id)}
                            >
                              <RotateCcw size={12} />
                              <span>Unarchive</span>
                            </button>
                            <button
                              type="button"
                              className="archived-action-btn delete-btn"
                              title="Delete task permanently"
                              onClick={() => setTaskToDelete(task)}
                            >
                              <Trash2 size={12} />
                              <span>Delete</span>
                            </button>
                          </div>
                        </div>

                        {/* Collapsible AI Context Accordion Drawer */}
                        {isBriefOpen && hasBriefContent && (
                          <div
                            style={{
                              marginTop: '0.35rem',
                              padding: '0.75rem',
                              background: 'var(--bg-darkest, rgba(0,0,0,0.25))',
                              borderRadius: 'var(--radius-sm, 6px)',
                              border: '1px solid var(--border-subtle)',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '0.6rem',
                            }}
                          >
                            {overviewText && (
                              <div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.74rem', fontWeight: 700, color: 'var(--accent-violet)', marginBottom: '0.2rem' }}>
                                  <ClipboardList size={12} />
                                  <span>Overview</span>
                                </div>
                                <div className="brief-markdown-render" style={{ fontSize: '0.8rem' }}>
                                  <MarkdownRenderer content={overviewText} />
                                </div>
                              </div>
                            )}
                            {buildText && (
                              <div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.74rem', fontWeight: 700, color: 'var(--accent-cyan)', marginBottom: '0.2rem' }}>
                                  <Wrench size={12} />
                                  <span>Build & Verification Notes</span>
                                </div>
                                <div className="brief-markdown-render" style={{ fontSize: '0.8rem' }}>
                                  <MarkdownRenderer content={buildText} />
                                </div>
                              </div>
                            )}
                            {completionText && (
                              <div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.74rem', fontWeight: 700, color: 'var(--accent-emerald)', marginBottom: '0.2rem' }}>
                                  <Flag size={12} />
                                  <span>Completion Summary</span>
                                </div>
                                <div className="brief-markdown-render" style={{ fontSize: '0.8rem' }}>
                                  <MarkdownRenderer content={completionText} />
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>

        {/* ── Modal Footer ── */}
        <div className="modal-footer" style={{ padding: '0.85rem 1.5rem' }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      {/* ── Permanent Delete Confirmation Modal ── */}
      {taskToDelete && (
        <div className="modal-overlay" onClick={() => setTaskToDelete(null)} style={{ zIndex: 110 }}>
          <div className="modal-content archive-delete-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--accent-rose)' }}>
                <AlertTriangle size={18} />
                <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>Delete Archived Task?</h3>
              </div>
              <button type="button" className="btn-icon" onClick={() => setTaskToDelete(null)}>
                <X size={16} />
              </button>
            </div>

            <div className="modal-body" style={{ padding: '1.25rem' }}>
              <div className="archive-delete-warning-box" style={{ marginBottom: '1rem' }}>
                <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: '2px' }} />
                <div>
                  This will permanently remove the archived task from the project. This action cannot be undone.
                </div>
              </div>
              <div
                style={{
                  padding: '0.75rem',
                  background: 'var(--bg-pane)',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border-subtle)',
                  fontSize: '0.85rem',
                  color: 'var(--text-bright)',
                  fontWeight: 500,
                }}
              >
                "{taskToDelete.title}"
              </div>
            </div>

            <div className="modal-footer" style={{ padding: '0.85rem 1.25rem' }}>
              <button type="button" className="btn btn-secondary" onClick={() => setTaskToDelete(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                style={{
                  background: 'var(--accent-rose, #f43f5e)',
                  color: '#fff',
                  border: 'none',
                }}
                onClick={() => {
                  onDeleteArchivedTask?.(taskToDelete.id);
                  setTaskToDelete(null);
                }}
              >
                Delete Permanently
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
