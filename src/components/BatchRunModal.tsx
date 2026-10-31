import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Play, ListOrdered, Check } from 'lucide-react';
import { type TaskItem } from '../types';

export type BatchRunMode = 'sequence' | 'parallel';

interface BatchRunModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** The lane's tasks, in lane order. */
  tasks: TaskItem[];
  /** Tasks ticked when the modal opens. */
  initialSelectedIds: Array<string | number>;
  onConfirm: (selectedTasks: TaskItem[], mode: BatchRunMode) => void;
}

/**
 * Picks several tasks of a lane to run: click tasks to tick them, then run them one after another (each waits for the
 * one before it; the rest show as Queued) or all at once.
 */
export const BatchRunModal: React.FC<BatchRunModalProps> = ({ isOpen, onClose, tasks, initialSelectedIds, onConfirm }) => {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initialSelectedIds.map(String)));
  const [parallel, setParallel] = useState(false);

  if (!isOpen) return null;

  const chosen = tasks.filter((t) => selected.has(String(t.id)));
  const toggle = (id: string | number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(String(id))) next.delete(String(id));
      else next.add(String(id));
      return next;
    });
  const order = new Map(chosen.map((t, i) => [String(t.id), i + 1] as const));

  // On document.body: inside the lane the overlay would only cover the lane (its own stacking context).
  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content batch-run-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.55rem' }}>
            <ListOrdered size={17} color="var(--accent-violet)" />
            <div>
              <h3 style={{ margin: 0, fontSize: '0.98rem', fontWeight: 650, color: 'var(--text-bright)' }}>Run several tasks</h3>
              <p style={{ margin: '0.15rem 0 0', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                {parallel
                  ? 'All the ticked tasks start at once.'
                  : 'The ticked tasks run one after another, in list order. Each starts when the one before it finishes.'}
              </p>
            </div>
          </div>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="modal-body batch-run-body">
          <div className="batch-run-toolbar">
            <span>Click tasks to choose them</span>
            <button type="button" onClick={() => setSelected(new Set(tasks.filter((t) => !t.isDone).map((t) => String(t.id))))}>
              All not done
            </button>
            <button type="button" onClick={() => setSelected(new Set())}>
              None
            </button>
          </div>
          <div className="batch-run-list" role="listbox" aria-multiselectable="true">
            {tasks.map((task) => {
              const isOn = selected.has(String(task.id));
              return (
                <button
                  type="button"
                  key={String(task.id)}
                  role="option"
                  aria-selected={isOn}
                  className={`batch-run-task ${isOn ? 'is-selected' : ''} ${task.isDone ? 'is-done' : ''}`}
                  onClick={() => toggle(task.id)}
                >
                  <span className="batch-run-check">{isOn ? (parallel ? <Check size={12} /> : order.get(String(task.id))) : null}</span>
                  <span className="batch-run-title">{task.title || 'Untitled task'}</span>
                  {task.isDone && <span className="batch-run-tag">Done</span>}
                </button>
              );
            })}
          </div>
        </div>

        <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
          <label className="batch-run-parallel">
            <button
              type="button"
              className={`toggle-switch-btn ${parallel ? 'is-active' : ''}`}
              onClick={() => setParallel((p) => !p)}
              aria-label="Run all at once"
              aria-pressed={parallel}
            >
              <div className="toggle-switch-thumb" />
            </button>
            <span>All at once</span>
          </label>
          <div style={{ display: 'flex', gap: '0.6rem' }}>
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={chosen.length === 0}
              onClick={() => {
                onConfirm(chosen, parallel ? 'parallel' : 'sequence');
                onClose();
              }}
            >
              <Play size={13} />
              <span>
                {chosen.length === 0
                  ? 'Choose tasks'
                  : parallel
                    ? `Run ${chosen.length} at once`
                    : `Run ${chosen.length} in order`}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};
