import React, { useState } from 'react';
import { Play, Check } from 'lucide-react';
import { Button, Dialog, Switch } from './ui';
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
 * Picks several tasks of a lane to run: click tasks to check them, then run them one after another (each waits for the
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

  const notDone = tasks.filter((t) => !t.isDone).map((t) => String(t.id));

  return (
    <Dialog
      title="Run several tasks"
      description={
        parallel
          ? 'All the checked tasks start at once.'
          : 'The checked tasks run one after another, in list order. Each starts when the one before it finishes.'
      }
      onClose={onClose}
      width={520}
      className="batch-run-dialog"
      footer={
        <>
          <label className="eg-hstack" style={{ color: 'var(--ink-muted)', cursor: 'pointer' }}>
            <Switch checked={parallel} onChange={(e) => setParallel(e.target.checked)} aria-label="Run all at once" />
            <span>All at once</span>
          </label>
          <span className="eg-spacer" />
          <Button variant="ghost" size="lg" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="lg"
            icon={Play}
            disabled={chosen.length === 0}
            onClick={() => {
              onConfirm(chosen, parallel ? 'parallel' : 'sequence');
              onClose();
            }}
          >
            {chosen.length === 0 ? 'Choose tasks' : parallel ? `Run ${chosen.length} at once` : `Run ${chosen.length} in order`}
          </Button>
        </>
      }
    >
      <div className="eg-hstack" style={{ marginBottom: 'var(--space-2)', fontSize: 'calc(12px * var(--type-scale))', color: 'var(--ink-subtle)' }}>
        <span>{chosen.length} of {tasks.length} chosen</span>
        <span className="eg-spacer" />
        <Button variant="ghost" size="sm" onClick={() => setSelected(new Set(notDone))}>
          All not done
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
          None
        </Button>
      </div>
      <div className="dlg-pick-list" role="listbox" aria-multiselectable="true">
        {tasks.map((task) => {
          const id = String(task.id);
          const isOn = selected.has(id);
          return (
            <button
              type="button"
              key={id}
              role="option"
              aria-selected={isOn}
              className={`dlg-pick-row ${task.isDone ? 'is-done' : ''}`}
              onClick={() => toggle(task.id)}
            >
              <span className={`dlg-pick-mark ${isOn ? 'is-on' : ''}`} aria-hidden="true">
                {isOn ? parallel ? <Check size={10} strokeWidth={2.5} /> : order.get(id) : null}
              </span>
              <span className="dlg-pick-title">{task.title || 'Untitled task'}</span>
              {task.isDone && <span className="dlg-pick-meta">Done</span>}
            </button>
          );
        })}
      </div>
    </Dialog>
  );
};
