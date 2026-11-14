/**
 * A board card opened: the task's own part of its lane's markdown (title line and everything nested under it) in an
 * editor with the lane editor's schema (taskEditorExtensions.ts). Edits are spliced back into the lane's markdown
 * (laneTaskOps.ts replaceTaskSlice), so the file stays the single source of truth and the task keeps its anchor.
 */
import React, { useEffect, useRef } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import type { AnyExtension } from '@tiptap/core';
import { ArrowRightLeft, Check, MoreHorizontal, Play, Square, Trash2, PanelRightOpen } from 'lucide-react';
import type { SwimLaneDoc, TaskItem } from '../types';
import { taskEditorExtensions } from '../lib/taskEditorExtensions';
import { findTaskBlocks, getTaskSlice, removeTask, replaceTaskSlice, setTaskDone } from '../lib/laneTaskOps';
import { Button, Dialog, IconButton, MenuButton, askConfirm, type MenuItem } from './ui';
import { MOD } from '../lib/shortcuts';

interface WithMarkdownStorage {
  storage: { markdown: { getMarkdown: () => string } };
}

const SAVE_DELAY_MS = 400;

export interface TaskCardModalProps {
  lane: SwimLaneDoc;
  /** The lane's other names, for "Move to". */
  lanes: SwimLaneDoc[];
  task: TaskItem;
  /** The run state shown in the header (from the board). */
  runState?: React.ReactNode;
  isRunning: boolean;
  /** Not movable while it runs or waits in the queue (its id changes with its lane). */
  canMove: boolean;
  /** Editor behavior shared with the lane editor (list keymaps), passed in by TaskPane. */
  behaviors?: AnyExtension[];
  /** The lane's markdown as last written, which may be ahead of `lane.markdown` by a render. */
  currentMarkdown: () => string;
  onLaneMarkdownChange: (laneId: string, markdown: string) => void;
  onMoveToLane?: (toLaneId: string) => void;
  onRun?: () => void;
  onStop?: () => void;
  onOpenBrief?: () => void;
  onClose: () => void;
}

export const TaskCardModal: React.FC<TaskCardModalProps> = ({
  lane,
  lanes,
  task,
  runState,
  isRunning,
  canMove,
  behaviors = [],
  currentMarkdown,
  onLaneMarkdownChange,
  onMoveToLane,
  onRun,
  onStop,
  onOpenBrief,
  onClose,
}) => {
  const anchorId = task.anchorId || '';
  const initial = useRef(getTaskSlice(currentMarkdown(), anchorId) ?? '');
  // The slice as last loaded into or written from the editor: tells a change from outside (an agent checking a
  // sub-item off) from our own write coming back.
  const syncedSliceRef = useRef(initial.current);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const propsRef = useRef({ currentMarkdown, onLaneMarkdownChange, onClose, laneId: lane.id, anchorId });
  propsRef.current = { currentMarkdown, onLaneMarkdownChange, onClose, laneId: lane.id, anchorId };

  const editor = useEditor({
    extensions: [...taskEditorExtensions({ placeholder: 'Add a subtask…' }), ...behaviors],
    content: initial.current,
    editorProps: { attributes: { class: 'tiptap', spellcheck: 'false', 'aria-label': 'Task and subtasks' } },
    onUpdate: () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flush, SAVE_DELAY_MS);
    },
  });
  const editorRef = useRef(editor);
  editorRef.current = editor;

  // Writes the editor's markdown into the task's place in the lane.
  function flush() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const ed = editorRef.current;
    if (!ed || ed.isDestroyed) return;
    const md = (ed as unknown as WithMarkdownStorage).storage.markdown?.getMarkdown();
    if (typeof md !== 'string') return;
    const p = propsRef.current;
    const laneMd = p.currentMarkdown();
    const next = replaceTaskSlice(laneMd, p.anchorId, md);
    syncedSliceRef.current = getTaskSlice(next, p.anchorId) ?? '';
    if (next !== laneMd) p.onLaneMarkdownChange(p.laneId, next);
    // Everything was deleted: the task is gone.
    if (!findTaskBlocks(next).some((b) => b.anchorId === p.anchorId)) p.onClose();
  }

  // Unmount (closing the card): save what's typed.
  useEffect(() => () => flush(), []); // eslint-disable-line react-hooks/exhaustive-deps

  // The lane changed outside the editor: show the new version unless the user is typing in it.
  useEffect(() => {
    if (!editor || editor.isDestroyed || timerRef.current) return;
    const slice = getTaskSlice(lane.markdown, anchorId);
    if (slice === null || slice === syncedSliceRef.current) return;
    if (editor.isFocused) return;
    syncedSliceRef.current = slice;
    editor.commands.setContent(slice, { emitUpdate: false });
  }, [lane.markdown, anchorId, editor]);

  const close = () => {
    flush();
    onClose();
  };

  const toggleDone = () => {
    flush();
    const laneMd = currentMarkdown();
    const next = setTaskDone(laneMd, anchorId, !task.isDone);
    if (next !== laneMd) onLaneMarkdownChange(lane.id, next);
  };

  const remove = async () => {
    const ok = await askConfirm({
      title: 'Delete this task?',
      text: 'The task and its subtasks are removed from the list. Undo isn’t available here.',
      confirmLabel: 'Delete task',
      danger: true,
    });
    if (!ok) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    const laneMd = currentMarkdown();
    const next = removeTask(laneMd, anchorId).markdown;
    syncedSliceRef.current = '';
    if (next !== laneMd) onLaneMarkdownChange(lane.id, next);
    onClose();
  };

  const laneName = (l: SwimLaneDoc) => (l.title && l.title !== 'Human Workspace' ? l.title : (l.filePath.split('/').pop() || l.title).replace(/\.md$/i, ''));
  const others = lanes.filter((l) => l.id !== lane.id);
  const moreItems: MenuItem[] = [
    ...(onMoveToLane && others.length > 0
      ? [
          { section: canMove ? 'Move to' : 'Move to (stop the run first)' } as MenuItem,
          ...others.map((l) => ({
            label: laneName(l),
            icon: ArrowRightLeft,
            disabled: !canMove,
            onSelect: () => {
              flush();
              onMoveToLane(l.id);
            },
          })),
          { separator: true } as MenuItem,
        ]
      : []),
    { label: 'Delete task', icon: Trash2, danger: true, onSelect: () => void remove() },
  ];

  return (
    <Dialog
      title={
        <span className="eg-kmodal-title">
          <span className="eg-kmodal-lane">{laneName(lane)}</span>
          {task.category && task.category !== 'Untitled' && <span className="eg-kmodal-cat">{task.category}</span>}
        </span>
      }
      onClose={close}
      width={640}
      className="eg-kmodal"
      headerActions={
        <>
          {runState}
          <Button
            variant="ghost"
            size="sm"
            icon={Check}
            aria-pressed={task.isDone}
            className={task.isDone ? 'is-pressed' : undefined}
            onClick={toggleDone}
            title={task.isDone ? 'Mark as not done' : 'Mark as done'}
          >
            {task.isDone ? 'Done' : 'Mark done'}
          </Button>
          {onOpenBrief && <IconButton icon={PanelRightOpen} size="sm" label={`Open brief (${MOD}J)`} onClick={onOpenBrief} />}
          {isRunning
            ? onStop && <IconButton icon={Square} size="sm" label="Stop run" onClick={onStop} />
            : onRun && <IconButton icon={Play} size="sm" label="Run" onClick={onRun} />}
          <MenuButton align="end" width={220} items={moreItems} trigger={(p) => <IconButton {...p} icon={MoreHorizontal} size="sm" label="More" />} />
        </>
      }
    >
      <div className="eg-kmodal-doc">
        <EditorContent editor={editor} />
      </div>
      <p className="eg-kmodal-hint">
        The first line is the task; indented lines are its subtasks. Changes save to {lane.filePath.split('/').pop()}.
      </p>
    </Dialog>
  );
};
