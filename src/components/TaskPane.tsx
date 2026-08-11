import React, { useState } from 'react';
import { type TaskItem } from '../types';
import { CheckSquare, Play, Eye, Search, AlertCircle, Plus, Filter, Sparkles } from 'lucide-react';

interface TaskPaneProps {
  tasks: TaskItem[];
  selectedTaskId: number | null;
  onSelectTask: (task: TaskItem) => void;
  onToggleTaskDone: (taskId: number) => void;
  onToggleSubtaskDone: (taskId: number, subtaskId: string) => void;
  onExecuteTask: (task: TaskItem) => void;
  onAddNewTask: () => void;
  onOpenDraftModal: () => void;
}

export const TaskPane: React.FC<TaskPaneProps> = ({
  tasks,
  selectedTaskId,
  onSelectTask,
  onToggleTaskDone,
  onToggleSubtaskDone,
  onExecuteTask,
  onAddNewTask,
  onOpenDraftModal
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState<'all' | 'in_progress' | 'human_review' | 'done'>('all');

  // Filter tasks
  const filteredTasks = tasks.filter((t) => {
    const matchesSearch = t.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      t.subtasks.some(s => s.text.toLowerCase().includes(searchQuery.toLowerCase()));
    
    if (!matchesSearch) return false;

    if (filterStatus === 'in_progress') return t.status === 'in_progress' || (t.status === 'not_started' && !t.isDone);
    if (filterStatus === 'human_review') return t.isHumanReview || t.subtasks.some(s => s.isHumanReview);
    if (filterStatus === 'done') return t.isDone;

    return true;
  });

  // Group by categories
  const categories = Array.from(new Set(filteredTasks.map((t) => t.category || 'General TODOs')));

  return (
    <div className="pane pane-left">
      {/* Pane Header */}
      <div className="pane-header">
        <div className="pane-title">
          <CheckSquare size={18} color="var(--accent-cyan)" />
          <span>Your Tasks</span>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 500 }}>
            ({tasks.filter((t) => t.isDone).length}/{tasks.length} Done)
          </span>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <button className="btn btn-primary" style={{ padding: '0.35rem 0.65rem', fontSize: '0.8rem' }} onClick={onOpenDraftModal}>
            <Sparkles size={14} />
            <span>Draft Tasks with AI</span>
          </button>
          <button className="btn btn-secondary" style={{ padding: '0.35rem 0.65rem', fontSize: '0.8rem' }} onClick={onAddNewTask}>
            <Plus size={14} />
            <span>Add Item</span>
          </button>
        </div>
      </div>

      {/* Filter & Search Bar */}
      <div style={{ padding: '0.85rem 1.25rem', borderBottom: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
        <div style={{ position: 'relative' }}>
          <Search size={15} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input
            type="text"
            className="input-text"
            style={{ paddingLeft: '2.3rem', fontSize: '0.85rem', height: '36px' }}
            placeholder="Search tasks, sub-bullets, tags..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        <div style={{ display: 'flex', gap: '0.4rem', overflowX: 'auto', paddingBottom: '0.2rem' }}>
          {(['all', 'in_progress', 'human_review', 'done'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilterStatus(f)}
              style={{
                background: filterStatus === f ? 'var(--accent-primary)' : 'rgba(255, 255, 255, 0.05)',
                color: filterStatus === f ? '#fff' : 'var(--text-muted)',
                border: '1px solid ' + (filterStatus === f ? 'var(--accent-primary)' : 'var(--border-subtle)'),
                padding: '0.25rem 0.65rem',
                borderRadius: '14px',
                fontSize: '0.75rem',
                fontWeight: 600,
                cursor: 'pointer',
                textTransform: 'capitalize',
                whiteSpace: 'nowrap'
              }}
            >
              {f.replace('_', ' ')}
            </button>
          ))}
        </div>
      </div>

      {/* Tasks List Content */}
      <div className="pane-content">
        {filteredTasks.length === 0 ? (
          <div style={{ padding: '3rem 1rem', textAlign: 'center', color: 'var(--text-muted)' }}>
            <p style={{ fontSize: '0.95rem' }}>No matching tasks found.</p>
            <p style={{ fontSize: '0.8rem', marginTop: '0.4rem' }}>Try adjusting your search query or filter pills.</p>
          </div>
        ) : (
          categories.map((category) => {
            const catTasks = filteredTasks.filter((t) => (t.category || 'General TODOs') === category);
            return (
              <div key={category} className="category-group">
                <div className="category-title">
                  <Filter size={13} />
                  <span>{category}</span>
                </div>

                {catTasks.map((task) => {
                  const isSelected = selectedTaskId === task.id;
                  return (
                    <div
                      key={task.id}
                      className={`task-card ${isSelected ? 'active' : ''} ${task.isDone ? 'done' : ''}`}
                      onClick={() => onSelectTask(task)}
                    >
                      <div className="task-header-row">
                        <div className="task-title-group">
                          <button
                            className={`custom-checkbox ${task.isDone ? 'checked' : ''}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              onToggleTaskDone(task.id);
                            }}
                          >
                            {task.isDone && <CheckSquare size={12} />}
                          </button>
                          <span className="task-num">#{task.id}</span>
                          <span className={`task-title ${task.isDone ? 'strikethrough' : ''}`}>{task.title}</span>
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                          {task.isHumanReview && (
                            <span className="badge badge-review" title="Flagged for human verification">
                              <AlertCircle size={10} />
                              <span>human review</span>
                            </span>
                          )}
                          <span className={`badge badge-${task.status}`}>
                            {task.status.replace('_', ' ')}
                          </span>
                        </div>
                      </div>

                      {/* Subtasks checklist */}
                      {task.subtasks.length > 0 && (
                        <div className="subtasks-list">
                          {task.subtasks.map((sub) => (
                            <div
                              key={sub.id}
                              className={`subtask-item ${sub.isDone ? 'done' : ''}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                onToggleSubtaskDone(task.id, sub.id);
                              }}
                              style={{ cursor: 'pointer' }}
                            >
                              <div className={`custom-checkbox ${sub.isDone ? 'checked' : ''}`} style={{ width: 14, height: 14 }}>
                                {sub.isDone && <CheckSquare size={10} />}
                              </div>
                              <span>
                                {sub.isHumanReview && <strong style={{ color: 'var(--accent-rose)', marginRight: '0.3rem' }}>[human review]</strong>}
                                {sub.text}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Bottom Action Row */}
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '0.85rem', paddingTop: '0.65rem', borderTop: '1px dashed var(--border-subtle)' }}>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
                          {task.mcpRequired && task.mcpRequired.length > 0 ? `Tools: ${task.mcpRequired.join(', ')}` : 'Standard Execution'}
                        </span>

                        <div style={{ display: 'flex', gap: '0.4rem' }}>
                          <button
                            className="btn btn-secondary"
                            style={{ padding: '0.25rem 0.55rem', fontSize: '0.75rem' }}
                            onClick={(e) => {
                              e.stopPropagation();
                              onSelectTask(task);
                            }}
                          >
                            <Eye size={13} />
                            <span>Brief</span>
                          </button>

                          <button
                            className="btn btn-emerald"
                            style={{ padding: '0.25rem 0.65rem', fontSize: '0.75rem' }}
                            onClick={(e) => {
                              e.stopPropagation();
                              onExecuteTask(task);
                            }}
                          >
                            <Play size={13} />
                            <span>Execute Task</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
