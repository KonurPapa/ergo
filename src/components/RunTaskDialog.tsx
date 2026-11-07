import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Play } from 'lucide-react';
import { Button, Dialog, Switch } from './ui';
import { MOD } from '../lib/shortcuts';
import { cleanAndUnescapeMarkdown } from '../lib/parser';
import { type TaskItem } from '../types';

/** One swim lane (a task list file) and its tasks, in document order. */
export interface RunLane {
  id: string;
  title: string;
  tasks: TaskItem[];
}

/** What the Run screen (top bar) starts. */
export type RunScreenChoice =
  | { scope: 'task'; task: TaskItem; notes: string }
  | { scope: 'lane' | 'next'; tasks: TaskItem[]; lane: RunLane; parallel: boolean; notes: string };

/** A confirm-before-run request for one task (its Run, Resume, Run again, Queue…). */
export interface RunTaskRequest {
  kind: 'task';
  task: TaskItem;
  title: string;
  confirmLabel: string;
  description?: React.ReactNode;
  onConfirm: (notes: string) => void;
}

export type RunDialogRequest = RunTaskRequest | { kind: 'screen' };

const titleOf = (t: TaskItem) => cleanAndUnescapeMarkdown(t.title || '') || 'Untitled task';

const isSubmitKey = (e: React.KeyboardEvent) => e.key === 'Enter' && (e.metaKey || e.ctrlKey);

/** The optional one-time notes box shared by both dialogs. */
export const RunNotesField: React.FC<{ value: string; onChange: (v: string) => void; several?: boolean; autoFocus?: boolean }> = ({
  value,
  onChange,
  several,
  autoFocus,
}) => {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  return (
    <label className="eg-field run-notes">
      <span className="eg-field-label">Notes for this run (optional)</span>
      <textarea
        ref={ref}
        className="eg-input run-notes-input"
        value={value}
        rows={4}
        placeholder="Anything the agent should know this time: an approach to take, files to leave alone, what to focus on…"
        onChange={(e) => onChange(e.target.value)}
      />
      <span className="eg-field-help">
        {several ? 'Every task in this run gets them' : 'The agents get them'} as extra context for this run only. They aren't saved to the
        task or its brief.
      </span>
    </label>
  );
};

/** The dialog's buttons: Cancel and the run, with ⌘↵. */
const RunFooter: React.FC<{ label: string; disabled?: boolean; onCancel: () => void; onConfirm: () => void }> = ({ label, disabled, onCancel, onConfirm }) => (
  <>
    <span className="eg-spacer" />
    <Button variant="ghost" size="lg" onClick={onCancel}>
      Cancel
    </Button>
    <Button variant="primary" size="lg" icon={Play} kbd={[MOD, '↵']} disabled={disabled} onClick={onConfirm}>
      {label}
    </Button>
  </>
);

/**
 * Asked before any task runs: Confirm runs it as it is; the notes box adds one-time context for this run.
 */
export const RunTaskDialog: React.FC<{ request: RunTaskRequest; onClose: () => void }> = ({ request, onClose }) => {
  const [notes, setNotes] = useState('');
  const confirm = () => {
    onClose();
    request.onConfirm(notes.trim());
  };
  return (
    <Dialog title={request.title} description={request.description} onClose={onClose} width={520} className="run-dialog" footer={<RunFooter label={request.confirmLabel} onCancel={onClose} onConfirm={confirm} />}>
      <div
        onKeyDown={(e) => {
          if (!isSubmitKey(e)) return;
          e.preventDefault();
          e.stopPropagation();
          confirm();
        }}
      >
        <div className="run-dialog-task">{titleOf(request.task)}</div>
        <RunNotesField value={notes} onChange={setNotes} autoFocus />
      </div>
    </Dialog>
  );
};

interface RunScreenProps {
  lanes: RunLane[];
  selectedTaskId: string | number | null;
  /** Tasks running or waiting in the queue: the lane options skip them. */
  busyIds: Set<string>;
  onClose: () => void;
  onRun: (choice: RunScreenChoice) => void;
}

/**
 * The top bar's Run screen: run the selected task, every open task of a list, or the next N tasks of a list in order,
 * with optional one-time notes for the run.
 */
export const RunScreen: React.FC<RunScreenProps> = ({ lanes, selectedTaskId, busyIds, onClose, onRun }) => {
  const allTasks = useMemo(() => lanes.flatMap((l) => l.tasks), [lanes]);
  const selected = selectedTaskId == null ? undefined : allTasks.find((t) => String(t.id) === String(selectedTaskId));
  const selectedBusy = selected ? busyIds.has(String(selected.id)) : false;
  const selectedLaneId = selected ? lanes.find((l) => l.tasks.some((t) => t.id === selected.id))?.id : undefined;

  const [scope, setScope] = useState<'task' | 'lane' | 'next'>(selected && !selectedBusy && !selected.isDone ? 'task' : 'lane');
  const [laneId, setLaneId] = useState<string>(selectedLaneId || lanes[0]?.id || '');
  const [parallel, setParallel] = useState(false);
  const [count, setCount] = useState(3);
  const [notes, setNotes] = useState('');

  const lane = lanes.find((l) => l.id === laneId) || lanes[0];
  const openTasks = (lane?.tasks || []).filter((t) => !t.isDone && !busyIds.has(String(t.id)));
  const skipped = (lane?.tasks || []).filter((t) => !t.isDone && busyIds.has(String(t.id))).length;

  // "Next N": from the selected task when it's in this list (and open), else from the list's first open task.
  const startIdx = selected ? openTasks.findIndex((t) => t.id === selected.id) : -1;
  const fromTasks = startIdx >= 0 ? openTasks.slice(startIdx) : openTasks;
  const n = Math.max(1, Math.min(count || 1, fromTasks.length || 1));
  const nextTasks = fromTasks.slice(0, n);

  const chosen: TaskItem[] = scope === 'task' ? (selected ? [selected] : []) : scope === 'lane' ? openTasks : nextTasks;
  const canRun = scope === 'task' ? Boolean(selected) && !selectedBusy : chosen.length > 0;
  const label =
    scope === 'task'
      ? 'Run task'
      : chosen.length === 0
        ? 'Nothing to run'
        : scope === 'lane' && parallel
          ? `Run ${chosen.length} at once`
          : `Run ${chosen.length} ${chosen.length === 1 ? 'task' : 'tasks'}`;

  const confirm = () => {
    if (!canRun || !lane) return;
    onClose();
    const trimmed = notes.trim();
    if (scope === 'task' && selected) onRun({ scope: 'task', task: selected, notes: trimmed });
    else if (scope !== 'task') onRun({ scope, tasks: chosen, lane, parallel: scope === 'lane' && parallel, notes: trimmed });
  };

  const laneSelect =
    lanes.length > 1 ? (
      <select className="eg-input run-lane-select" value={lane?.id} onChange={(e) => setLaneId(e.target.value)} aria-label="Task list" onClick={(e) => e.stopPropagation()}>
        {lanes.map((l) => (
          <option key={l.id} value={l.id}>
            {l.title}
          </option>
        ))}
      </select>
    ) : null;

  const option = (id: typeof scope, title: string, meta: React.ReactNode, body?: React.ReactNode, disabled?: boolean) => (
    <div className={`run-option ${scope === id ? 'is-on' : ''} ${disabled ? 'is-disabled' : ''}`}>
      <button type="button" role="radio" aria-checked={scope === id} disabled={disabled} className="run-option-head" onClick={() => setScope(id)}>
        <span className="run-option-mark" aria-hidden="true" />
        <span className="run-option-title">{title}</span>
        <span className="run-option-meta">{meta}</span>
      </button>
      {scope === id && body && <div className="run-option-body">{body}</div>}
    </div>
  );

  const preview = (list: TaskItem[], numbered: boolean) => {
    if (list.length === 0) return <p className="run-option-empty">No open tasks in this list{skipped ? ' that are not already running or queued' : ''}.</p>;
    const shown = list.slice(0, 8);
    return (
      <ol className="run-preview">
        {shown.map((t, i) => (
          <li key={String(t.id)}>
            <span className="run-preview-n">{numbered ? i + 1 : '·'}</span>
            <span className="run-preview-title">{titleOf(t)}</span>
          </li>
        ))}
        {list.length > shown.length && <li className="run-preview-more">and {list.length - shown.length} more</li>}
      </ol>
    );
  };

  return (
    <Dialog
      title="Run tasks"
      description="Choose what to run. Each task runs with its own agents, the same as its Run button."
      onClose={onClose}
      width={560}
      className="run-dialog"
      footer={<RunFooter label={label} disabled={!canRun} onCancel={onClose} onConfirm={confirm} />}
    >
      <div
        onKeyDown={(e) => {
          if (!isSubmitKey(e)) return;
          e.preventDefault();
          e.stopPropagation();
          confirm();
        }}
      >
        <div className="run-options" role="radiogroup" aria-label="What to run">
          {option(
            'task',
            'Selected task',
            selected ? (selectedBusy ? 'Already running or queued' : titleOf(selected)) : 'Put the caret on a task line first',
            undefined,
            !selected || selectedBusy
          )}
          {option(
            'lane',
            'Every task in a list',
            `${openTasks.length} open${skipped ? ` · ${skipped} running or queued` : ''}`,
            <>
              <div className="eg-hstack run-option-controls">
                {laneSelect}
                <span className="eg-spacer" />
                <label className="eg-hstack run-option-switch">
                  <Switch checked={parallel} onChange={(e) => setParallel(e.target.checked)} aria-label="Run all at once" />
                  <span>All at once</span>
                </label>
              </div>
              <p className="run-option-help">
                {parallel ? 'They all start now.' : 'One after another, in list order. The ones waiting show as Queued.'}
              </p>
              {preview(openTasks, !parallel)}
            </>
          )}
          {option(
            'next',
            'Next tasks in order',
            `${nextTasks.length} of ${openTasks.length} open`,
            <>
              <div className="eg-hstack run-option-controls">
                <span>Run the next</span>
                <input
                  className="eg-input run-count-input"
                  type="number"
                  min={1}
                  max={Math.max(1, fromTasks.length)}
                  value={count}
                  onChange={(e) => setCount(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
                  aria-label="Number of tasks"
                />
                <span>{n === 1 ? 'task' : 'tasks'}</span>
                {laneSelect && <span>in</span>}
                {laneSelect}
              </div>
              <p className="run-option-help">
                {startIdx >= 0 ? `Starting at the selected task, ` : 'Starting at the first open task, '}one after another. Done tasks are skipped.
              </p>
              {preview(nextTasks, true)}
            </>
          )}
        </div>
        <RunNotesField value={notes} onChange={setNotes} several={scope !== 'task'} />
      </div>
    </Dialog>
  );
};
