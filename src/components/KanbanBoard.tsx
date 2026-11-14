/**
 * The board view of a project's human workspace: each swim lane is a column, each top-level task in it an outlined
 * card (title, subtask progress, its heading's color, run state). Cards open into TaskCardModal to edit the task and
 * its subtasks, and drag to reorder within a column or move to another one. Every change is an edit to the lane's
 * markdown (laneTaskOps.ts); moving between lanes goes through App (onMoveTaskToLane), which carries the task's brief
 * and run history over to its new id.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AnyExtension } from '@tiptap/core';
import { Check, Edit2, ListChecks, MoreHorizontal, PanelRightOpen, Play, Plus, Square, Trash2 } from 'lucide-react';
import type { AgentContextItem, HumanInputPrompt, SpawnedSession, SwimLaneDoc, TaskItem } from '../types';
import { parseSwimLaneMarkdown } from '../lib/parser';
import { appendTask, moveTaskWithinLane, setTaskDone } from '../lib/laneTaskOps';
import { resolveHeaderColor } from '../lib/headerColors';
import { Button, IconButton, Input, MenuButton, RunState, askConfirm, askText, cx } from './ui';
import { isAgentWorking } from './AgentSessionTabs';
import { useAgentActivity, useTick } from '../hooks/useAgentActivity';
import { formatElapsed } from '../lib/agentDisplay';
import { MOD, SHIFT } from '../lib/shortcuts';
import { TaskCardModal } from './TaskCardModal';

type Id = string | number;

export interface KanbanBoardProps {
  lanes: SwimLaneDoc[];
  selectedTaskId?: Id | null;
  runningTaskIds?: Id[];
  queuedTaskIds?: Id[];
  briefs?: AgentContextItem[];
  terminalSessions?: SpawnedSession[];
  pendingHumanInputs?: Record<Id, { prompt: HumanInputPrompt; resolve: (answer: string) => void }>;
  hideDone: boolean;
  onToggleHideDone: () => void;
  onRunTask?: (task: TaskItem) => void;
  onStopTask?: (task: TaskItem) => void;
  onSelectTask?: (taskId: Id) => void;
  onOpenTaskDetail?: (taskId: Id) => void;
  onLaneMarkdownChange: (laneId: string, markdown: string) => void;
  /** Moves a task into another lane, before the task with `beforeAnchorId` (null: at the end). False if refused. */
  onMoveTaskToLane?: (taskId: Id, toLaneId: string, beforeAnchorId: string | null) => boolean;
  onAddSwimLane?: (afterLaneId?: string) => void;
  onRenameSwimLane?: (laneId: string, newTitle: string) => void;
  onDeleteSwimLane?: (laneId: string) => void;
  /** Editor behavior shared with the lane editor (list keymaps), for the card editor. */
  editorBehaviors?: AnyExtension[];
}

type RunKind = 'live' | 'waiting' | 'queued' | 'review' | 'failed';
interface CardRun {
  kind: RunKind;
  queuePos: number;
  session?: SpawnedSession;
}

export const laneDisplayName = (lane: SwimLaneDoc) => {
  const file = lane.filePath.split('/').pop() || lane.title;
  return lane.title && lane.title !== 'Human Workspace' && lane.title !== file ? lane.title : file.replace(/\.md$/i, '');
};

/** What a task's line shows at its right edge in the document, for a card (same rules as the lane editor). */
function runFor(
  task: TaskItem,
  ctx: { running: Set<string>; queued: string[]; awaiting: Set<string>; briefs: AgentContextItem[]; pending?: KanbanBoardProps['pendingHumanInputs']; live: Map<string, SpawnedSession> },
): CardRun | null {
  const id = String(task.id);
  const queuePos = ctx.queued.indexOf(id);
  if (ctx.running.has(id)) {
    const waiting = !!ctx.pending?.[task.id] || ctx.awaiting.has(id);
    return { kind: waiting ? 'waiting' : 'live', queuePos, session: ctx.live.get(id) };
  }
  if (queuePos >= 0) return { kind: 'queued', queuePos };
  if (task.isDone) return null;
  const outcome = ctx.briefs.find((b) => b.sourceTaskId != null && String(b.sourceTaskId) === id)?.lastRunOutcome?.outcome;
  if (outcome === 'failed' || outcome === 'verifier_failed') return { kind: 'failed', queuePos };
  if (outcome === 'passed' || outcome === 'completed' || outcome === 'unverified') return { kind: 'review', queuePos };
  return null;
}

const LiveState: React.FC<{ session?: SpawnedSession }> = ({ session }) => {
  const { activity } = useAgentActivity(session?.ptySessionId);
  const now = useTick(Boolean(session));
  if (!session) return <RunState state="live" label="Running" />;
  const started = Date.parse(session.session.spawnedAt) || now;
  const doing = activity?.doing || (session.status === 'starting' ? 'Starting' : 'Working');
  return <RunState state="live" label={doing} meta={formatElapsed(now - started)} title={activity?.said || doing} />;
};

const CardRunState: React.FC<{ run: CardRun }> = ({ run }) => {
  switch (run.kind) {
    case 'live':
      return <LiveState session={run.session} />;
    case 'waiting':
      return <RunState state="waiting" label="Waiting for you" />;
    case 'queued':
      return <RunState state="queued" label={`Queued ${run.queuePos + 1}`} />;
    case 'review':
      return <RunState state="review" label="Needs review" title="The agent finished. Review the work, then check the task off." />;
    default:
      return <RunState state="failed" label="Failed" />;
  }
};

interface DragInfo {
  taskId: Id;
  laneId: string;
  anchorId: string;
  /** Running or queued: it may be reordered in its lane but not moved to another (its id would change). */
  pinned: boolean;
}

export const KanbanBoard: React.FC<KanbanBoardProps> = ({
  lanes,
  selectedTaskId,
  runningTaskIds = [],
  queuedTaskIds = [],
  briefs = [],
  terminalSessions = [],
  pendingHumanInputs,
  hideDone,
  onToggleHideDone,
  onRunTask,
  onStopTask,
  onSelectTask,
  onOpenTaskDetail,
  onLaneMarkdownChange,
  onMoveTaskToLane,
  onAddSwimLane,
  onRenameSwimLane,
  onDeleteSwimLane,
  editorBehaviors,
}) => {
  const moveRef = useRef(onMoveTaskToLane);
  moveRef.current = onMoveTaskToLane;
  // Writes not yet back from App as props: a second edit right after the first builds on it, not on the stale prop.
  const pendingRef = useRef<Record<string, string>>({});
  useEffect(() => {
    pendingRef.current = {};
  }, [lanes]);
  const laneMarkdown = (lane: SwimLaneDoc) => pendingRef.current[lane.id] ?? lane.markdown;
  const writeLane = (laneId: string, markdown: string) => {
    pendingRef.current[laneId] = markdown;
    onLaneMarkdownChange(laneId, markdown);
  };

  const tasksByLane = useMemo(() => new Map(lanes.map((l) => [l.id, parseSwimLaneMarkdown(l).items])), [lanes]);

  const ctx = useMemo(() => {
    const live = new Map<string, SpawnedSession>();
    const awaiting = new Set<string>();
    for (const x of terminalSessions) {
      if (!x.session.isActive) continue;
      const key = String(x.session.taskId);
      if (x.status === 'awaiting_approval') awaiting.add(key);
      if (isAgentWorking(x.status) && (!live.has(key) || x.role === 'manager')) live.set(key, x);
    }
    return {
      running: new Set(runningTaskIds.map(String)),
      queued: queuedTaskIds.map(String),
      awaiting,
      briefs,
      pending: pendingHumanInputs,
      live,
    };
  }, [terminalSessions, runningTaskIds, queuedTaskIds, briefs, pendingHumanInputs]);

  const isPinned = (task: TaskItem) => ctx.running.has(String(task.id)) || ctx.queued.includes(String(task.id));

  // ── Drag and drop (native HTML5) ──
  const dragRef = useRef<DragInfo | null>(null);
  const [dragging, setDragging] = useState<DragInfo | null>(null);
  const [dropAt, setDropAt] = useState<{ laneId: string; before: string | null } | null>(null);

  const endDrag = () => {
    dragRef.current = null;
    setDragging(null);
    setDropAt(null);
  };

  // The card the pointer is above the middle of (the drop goes before it), or null for the end of the column.
  const dropTarget = (body: HTMLElement, clientY: number): string | null => {
    const cards = Array.from(body.querySelectorAll<HTMLElement>('[data-card-anchor]'));
    for (const el of cards) {
      const r = el.getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return el.dataset.cardAnchor || null;
    }
    return null;
  };

  const drop = (lane: SwimLaneDoc, before: string | null) => {
    const d = dragRef.current;
    endDrag();
    if (!d) return;
    if (d.laneId === lane.id) {
      if (before === d.anchorId) return;
      const md = laneMarkdown(lane);
      const next = moveTaskWithinLane(md, d.anchorId, before);
      if (next !== md) writeLane(lane.id, next);
      return;
    }
    if (d.pinned) return;
    onMoveTaskToLane?.(d.taskId, lane.id, before);
  };

  // ── The open card ──
  const [openCard, setOpenCard] = useState<{ laneId: string; anchorId: string } | null>(null);
  const openLane = openCard ? lanes.find((l) => l.id === openCard.laneId) : undefined;
  const openTask = openLane ? tasksByLane.get(openLane.id)?.find((t) => t.anchorId === openCard!.anchorId) : undefined;
  useEffect(() => {
    // The card's task is gone (deleted, or moved to another lane by something else): close it.
    if (openCard && !openTask) setOpenCard(null);
  }, [openCard, openTask]);

  const openTaskCard = (lane: SwimLaneDoc, task: TaskItem) => {
    if (!task.anchorId) return;
    onSelectTask?.(task.id);
    setOpenCard({ laneId: lane.id, anchorId: task.anchorId });
  };

  const toggleDone = (lane: SwimLaneDoc, task: TaskItem) => {
    if (!task.anchorId) return;
    const md = laneMarkdown(lane);
    const next = setTaskDone(md, task.anchorId, !task.isDone);
    if (next !== md) writeLane(lane.id, next);
  };

  // Keyboard: ⌥↑ / ⌥↓ moves a focused card within its column.
  const moveByKey = (lane: SwimLaneDoc, task: TaskItem, dir: -1 | 1) => {
    const list = tasksByLane.get(lane.id) || [];
    const visible = hideDone ? list.filter((t) => !t.isDone) : list;
    const i = visible.findIndex((t) => t.anchorId === task.anchorId);
    if (i < 0 || !task.anchorId) return;
    const before = dir < 0 ? visible[i - 1]?.anchorId : visible[i + 2]?.anchorId ?? null;
    if (dir < 0 && i === 0) return;
    if (dir > 0 && i === visible.length - 1) return;
    const md = laneMarkdown(lane);
    const next = moveTaskWithinLane(md, task.anchorId, before ?? null);
    if (next !== md) writeLane(lane.id, next);
    requestAnimationFrame(() => (document.querySelector(`[data-card-anchor="${task.anchorId}"]`) as HTMLElement | null)?.focus());
  };

  return (
    <div className="eg-board" role="list" aria-label="Board">
      {lanes.map((lane) => (
        <KanbanColumn
          key={lane.id}
          lane={lane}
          tasks={tasksByLane.get(lane.id) || []}
          totalLanes={lanes.length}
          hideDone={hideDone}
          onToggleHideDone={onToggleHideDone}
          selectedTaskId={selectedTaskId}
          runOf={(t) => runFor(t, ctx)}
          dragging={dragging}
          dropBefore={dropAt && dropAt.laneId === lane.id ? dropAt.before : undefined}
          canDropHere={!dragging || dragging.laneId === lane.id || (!dragging.pinned && !!onMoveTaskToLane)}
          onDragStartCard={(task, e) => {
            if (!task.anchorId) return e.preventDefault();
            const info: DragInfo = { taskId: task.id, laneId: lane.id, anchorId: task.anchorId, pinned: isPinned(task) };
            dragRef.current = info;
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', task.title);
            // Let the browser take its drag image before the card dims.
            requestAnimationFrame(() => setDragging(info));
          }}
          onDragEndCard={endDrag}
          onDragOverBody={(body, e) => {
            const d = dragRef.current;
            if (!d) return;
            if (d.laneId !== lane.id && (d.pinned || !onMoveTaskToLane)) {
              e.dataTransfer.dropEffect = 'none';
              setDropAt(null);
              return;
            }
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const before = dropTarget(body, e.clientY);
            setDropAt((cur) => (cur && cur.laneId === lane.id && cur.before === before ? cur : { laneId: lane.id, before }));
          }}
          onDropBody={(body, e) => {
            e.preventDefault();
            drop(lane, dropTarget(body, e.clientY));
          }}
          onOpenCard={(task) => openTaskCard(lane, task)}
          onToggleDone={(task) => toggleDone(lane, task)}
          onMoveByKey={(task, dir) => moveByKey(lane, task, dir)}
          onRunTask={onRunTask}
          onStopTask={onStopTask}
          onOpenTaskDetail={onOpenTaskDetail}
          onAddTask={(title) => {
            const { markdown } = appendTask(laneMarkdown(lane), title);
            writeLane(lane.id, markdown);
          }}
          onAddLaneAfter={onAddSwimLane ? () => onAddSwimLane(lane.id) : undefined}
          onRename={onRenameSwimLane ? (title) => onRenameSwimLane(lane.id, title) : undefined}
          onDelete={onDeleteSwimLane && lanes.length > 1 ? () => onDeleteSwimLane(lane.id) : undefined}
        />
      ))}
      {onAddSwimLane && (
        <div className="eg-board-add">
          <Button variant="ghost" size="sm" icon={Plus} onClick={() => onAddSwimLane(lanes[lanes.length - 1]?.id)}>
            Add list
          </Button>
        </div>
      )}

      {openLane && openTask && (
        <TaskCardModal
          key={`${openLane.id}|${openCard!.anchorId}`}
          lane={openLane}
          lanes={lanes}
          task={openTask}
          behaviors={editorBehaviors}
          currentMarkdown={() => laneMarkdown(lanes.find((l) => l.id === openLane.id) || openLane)}
          onLaneMarkdownChange={writeLane}
          runState={(() => {
            const run = runFor(openTask, ctx);
            return run ? <CardRunState run={run} /> : null;
          })()}
          isRunning={ctx.running.has(String(openTask.id))}
          canMove={!isPinned(openTask)}
          onMoveToLane={
            onMoveTaskToLane
              ? (toLaneId) => {
                  // After the card's last edit (just saved) is back in App's state, so the move carries it along.
                  const taskId = openTask.id;
                  setTimeout(() => {
                    if (moveRef.current?.(taskId, toLaneId, null)) setOpenCard(null);
                  }, 0);
                }
              : undefined
          }
          onRun={onRunTask ? () => onRunTask(openTask) : undefined}
          onStop={onStopTask ? () => onStopTask(openTask) : undefined}
          onOpenBrief={onOpenTaskDetail ? () => onOpenTaskDetail(openTask.id) : undefined}
          onClose={() => setOpenCard(null)}
        />
      )}
    </div>
  );
};

// ─── One column ───────────────────────────────────────────────────────────────

interface KanbanColumnProps {
  lane: SwimLaneDoc;
  tasks: TaskItem[];
  totalLanes: number;
  hideDone: boolean;
  onToggleHideDone: () => void;
  selectedTaskId?: Id | null;
  runOf: (task: TaskItem) => CardRun | null;
  dragging: DragInfo | null;
  /** Where the dragged card would land: before this anchor, at the end (null), or not in this column (undefined). */
  dropBefore: string | null | undefined;
  canDropHere: boolean;
  onDragStartCard: (task: TaskItem, e: React.DragEvent) => void;
  onDragEndCard: () => void;
  onDragOverBody: (body: HTMLElement, e: React.DragEvent) => void;
  onDropBody: (body: HTMLElement, e: React.DragEvent) => void;
  onOpenCard: (task: TaskItem) => void;
  onToggleDone: (task: TaskItem) => void;
  onMoveByKey: (task: TaskItem, dir: -1 | 1) => void;
  onRunTask?: (task: TaskItem) => void;
  onStopTask?: (task: TaskItem) => void;
  onOpenTaskDetail?: (taskId: Id) => void;
  onAddTask: (title: string) => void;
  onAddLaneAfter?: () => void;
  onRename?: (title: string) => void;
  onDelete?: () => void;
}

const KanbanColumn: React.FC<KanbanColumnProps> = ({
  lane,
  tasks,
  hideDone,
  onToggleHideDone,
  selectedTaskId,
  runOf,
  dragging,
  dropBefore,
  canDropHere,
  onDragStartCard,
  onDragEndCard,
  onDragOverBody,
  onDropBody,
  onOpenCard,
  onToggleDone,
  onMoveByKey,
  onRunTask,
  onStopTask,
  onOpenTaskDetail,
  onAddTask,
  onAddLaneAfter,
  onRename,
  onDelete,
}) => {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const name = laneDisplayName(lane);
  const doneCount = tasks.filter((t) => t.isDone).length;
  const visible = hideDone ? tasks.filter((t) => !t.isDone) : tasks;
  const hidden = tasks.length - visible.length;

  const commit = () => {
    const title = draft.trim();
    if (!title) return;
    onAddTask(title);
    setDraft('');
  };

  const rename = async () => {
    if (!onRename) return;
    const next = await askText({ title: 'Rename list', label: 'Name', defaultValue: name, confirmLabel: 'Rename list' });
    if (next && next.trim() && next.trim() !== name) onRename(next.trim());
  };

  const remove = async () => {
    if (!onDelete) return;
    const ok = await askConfirm({
      title: `Remove ${name}?`,
      text: `The list and its ${tasks.length === 1 ? 'task' : `${tasks.length} tasks`} leave the board. Nothing is deleted: ${lane.filePath.split('/').pop()} moves to removed-lists/ in the project folder, and moving it back restores the list.`,
      confirmLabel: 'Remove list',
      danger: true,
    });
    if (ok) onDelete();
  };

  const indicator = <div className="eg-kdrop" aria-hidden="true" />;

  return (
    <section className={cx('eg-kcol', dragging && !canDropHere && 'is-no-drop')} role="listitem" aria-label={name}>
      <header className="eg-kcol-head">
        <span className="eg-kcol-name" title={lane.filePath} onDoubleClick={() => void rename()}>
          {name}
        </span>
        <span className="eg-kcol-count" title={`${tasks.length - doneCount} open · ${doneCount} done`}>
          {tasks.length - doneCount}
        </span>
        {hidden > 0 && (
          <button type="button" className="eg-hidden-chip" onClick={onToggleHideDone} title="Show done tasks">
            {hidden} {hidden === 1 ? 'task' : 'tasks'} hidden
          </button>
        )}
        <span className="eg-spacer" />
        <IconButton icon={Plus} size="sm" label="Add task" onClick={() => setAdding(true)} />
        <MenuButton
          align="end"
          width={220}
          items={[
            { label: 'Add task', icon: Plus, onSelect: () => setAdding(true) },
            { label: hideDone ? 'Show done tasks' : 'Hide done tasks', icon: ListChecks, onSelect: onToggleHideDone },
            ...(onAddLaneAfter ? [{ label: 'New list beside this one', icon: Plus, onSelect: onAddLaneAfter }] : []),
            ...(onRename ? [{ separator: true } as const, { label: 'Rename list', icon: Edit2, onSelect: () => void rename() }] : []),
            ...(onDelete ? [{ label: 'Remove list', icon: Trash2, danger: true, onSelect: () => void remove() }] : []),
          ]}
          trigger={(p) => <IconButton {...p} icon={MoreHorizontal} size="sm" label="List options" />}
        />
      </header>

      <div
        ref={bodyRef}
        className="eg-kcol-body"
        onDragOver={(e) => bodyRef.current && onDragOverBody(bodyRef.current, e)}
        onDrop={(e) => bodyRef.current && onDropBody(bodyRef.current, e)}
      >
        {visible.map((task) => (
          <React.Fragment key={String(task.id)}>
            {dropBefore != null && dropBefore === task.anchorId && indicator}
            <KanbanCard
              task={task}
              run={runOf(task)}
              selected={selectedTaskId != null && String(selectedTaskId) === String(task.id)}
              isDragging={!!dragging && dragging.anchorId === task.anchorId && dragging.laneId === lane.id}
              onDragStart={(e) => onDragStartCard(task, e)}
              onDragEnd={onDragEndCard}
              onOpen={() => onOpenCard(task)}
              onToggleDone={() => onToggleDone(task)}
              onMoveByKey={(dir) => onMoveByKey(task, dir)}
              onRun={onRunTask ? () => onRunTask(task) : undefined}
              onStop={onStopTask ? () => onStopTask(task) : undefined}
              onOpenBrief={onOpenTaskDetail ? () => onOpenTaskDetail(task.id) : undefined}
            />
          </React.Fragment>
        ))}
        {dropBefore === null && indicator}
        {visible.length === 0 && !adding && <div className="eg-kcol-empty">{hidden > 0 ? 'Every task here is done.' : 'No tasks yet.'}</div>}

        {adding ? (
          <Input
            autoFocus
            className="eg-kcol-input"
            placeholder="Task title, then Enter"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commit();
              } else if (e.key === 'Escape') {
                setDraft('');
                setAdding(false);
              }
            }}
            onBlur={() => {
              commit();
              setAdding(false);
            }}
            aria-label={`New task in ${name}`}
          />
        ) : (
          <Button variant="ghost" size="sm" icon={Plus} className="eg-kcol-add" onClick={() => setAdding(true)}>
            Add task
          </Button>
        )}
      </div>
    </section>
  );
};

// ─── One card ─────────────────────────────────────────────────────────────────

interface KanbanCardProps {
  task: TaskItem;
  run: CardRun | null;
  selected: boolean;
  isDragging: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onOpen: () => void;
  onToggleDone: () => void;
  onMoveByKey: (dir: -1 | 1) => void;
  onRun?: () => void;
  onStop?: () => void;
  onOpenBrief?: () => void;
}

const KanbanCard: React.FC<KanbanCardProps> = ({
  task,
  run,
  selected,
  isDragging,
  onDragStart,
  onDragEnd,
  onOpen,
  onToggleDone,
  onMoveByKey,
  onRun,
  onStop,
  onOpenBrief,
}) => {
  const subDone = task.subtasks.filter((s) => s.isDone).length;
  const running = run?.kind === 'live' || run?.kind === 'waiting';
  const hasCategory = !!task.category && task.category !== 'Untitled' && task.category !== 'Archive';
  const color = hasCategory ? resolveHeaderColor(task.category, task.categoryColor).hex : undefined;
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <div
      className={cx('eg-kcard', task.isDone && 'is-done', selected && 'is-selected', run?.kind === 'review' && 'is-review', isDragging && 'is-dragging')}
      data-card-anchor={task.anchorId}
      role="button"
      tabIndex={0}
      draggable
      aria-label={`${task.title}${task.isDone ? ', done' : ''}. Enter opens it; ${'Alt'} and arrow keys move it.`}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault();
          onMoveByKey(e.key === 'ArrowUp' ? -1 : 1);
        }
      }}
    >
      <div className="eg-kcard-row">
        <button
          type="button"
          role="checkbox"
          aria-checked={task.isDone}
          aria-label={task.isDone ? 'Mark as not done' : 'Mark as done'}
          className={cx('eg-kcard-check', task.isDone && 'is-checked')}
          onClick={(e) => {
            stop(e);
            onToggleDone();
          }}
          onKeyDown={stop}
        >
          {task.isDone && <Check size={11} strokeWidth={3} aria-hidden="true" />}
        </button>
        <span className="eg-kcard-title">{task.title}</span>
      </div>

      {(hasCategory || task.subtasks.length > 0 || run) && (
        <div className="eg-kcard-meta">
          {hasCategory && (
            <span className="eg-kcard-tag" title={`Under “${task.category}”`}>
              <span className="eg-kcard-swatch" style={{ background: color }} aria-hidden="true" />
              {task.listIndex != null && (
                <span className="eg-kcard-num" style={{ color }}>
                  #{task.listIndex}
                </span>
              )}
              <span className="eg-kcard-cat">{task.category}</span>
            </span>
          )}
          {task.subtasks.length > 0 && (
            <span className={cx('eg-kcard-subs', subDone === task.subtasks.length && 'is-complete')} title={`${subDone} of ${task.subtasks.length} subtasks done`}>
              <ListChecks size={12} strokeWidth={1.75} aria-hidden="true" />
              {subDone}/{task.subtasks.length}
            </span>
          )}
          <span className="eg-spacer" />
          {run && <CardRunState run={run} />}
        </div>
      )}

      <div className="eg-kcard-acts" onClick={stop} onKeyDown={stop}>
        {onOpenBrief && <IconButton icon={PanelRightOpen} size="sm" label={`Open brief (${MOD}J)`} onClick={onOpenBrief} />}
        {running
          ? onStop && <IconButton icon={Square} size="sm" label="Stop run" onClick={onStop} />
          : onRun && !task.isDone && <IconButton icon={Play} size="sm" label={`Run (${SHIFT}${MOD}↵)`} onClick={onRun} />}
      </div>
    </div>
  );
};
