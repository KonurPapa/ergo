import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import {
  type TaskItem as TaskItemType,
  type ProjectData,
  type AIProviderConfig,
  type MCPServer,
  type HumanAiAssistantResult,
  type HumanInputPrompt,
  type SwimLaneDoc
} from '../types';
import { useEditor, EditorContent } from '@tiptap/react';
import ListItem from '@tiptap/extension-list-item';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Link from '@tiptap/extension-link';
import Typography from '@tiptap/extension-typography';
import { Markdown } from 'tiptap-markdown';
import { stripHeaderComments, parseSwimLaneMarkdown } from '../lib/parser';
import { HumanAiAssistantModal } from './HumanAiAssistantModal';
import { MarkdownRenderer } from './MarkdownRenderer';

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, Selection, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { canJoin } from '@tiptap/pm/transform';
import { MARKDOWN_WRAPPER_PAIRS } from '../lib/markdownEditorUtils';

const CustomListItem = ListItem.extend({
  content: 'block+',
});

import {
  Plus,
  FileText,
  Sparkles,
  Bold,
  Italic,
  Strikethrough,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Code,
  FileCode,
  Quote,
  Minus,
  Link as LinkIcon,
  Undo2,
  Redo2,
  Type,
  ChevronDown,
  Archive,
  Trash2,
  RotateCcw,
  AlertTriangle,
  AlertCircle,
  X,
  Edit2,
  Columns,
  MoreHorizontal
} from 'lucide-react';

interface WithMarkdownStorage {
  storage: {
    markdown: {
      getMarkdown: () => string;
    };
  };
}

// Module-level persistent Set to remember collapsed cards across re-renders
const collapsedCardsState = new Set<string>();

// Helper: check if a node (paragraph) is marked as done via strikethrough
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isNodeChecked(node: any): boolean {
  if (!node) return false;
  let hasText = false;
  let allTextStruck = true;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  node.descendants((child: any) => {
    if (child.isText) {
      hasText = true;
      const isStruck = child.marks.some((m: any) => m.type.name === 'strike');
      if (!isStruck) {
        allTextStruck = false;
      }
    }
  });

  return hasText && allTextStruck;
}

// Helper: insert a bullet subtask inside the listItem card at the given position
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function insertSubtaskAtCardPos(editorInstance: any, listItemPos: number) {
  if (!editorInstance) return;
  const { schema, doc } = editorInstance.state;
  const bulletList = schema.nodes.bulletList;
  const listItem = schema.nodes.listItem;
  const paragraph = schema.nodes.paragraph;
  if (!bulletList || !listItem || !paragraph) return;

  const liveNode = doc.nodeAt(listItemPos);
  if (!liveNode || liveNode.type.name !== 'listItem') return;

  let insertAfterContent = listItemPos + 1;
  let existingBulletEnd: number | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  liveNode.forEach((child: any, offset: number) => {
    if (child.type.name !== 'bulletList' && child.type.name !== 'orderedList') {
      insertAfterContent = listItemPos + 1 + offset + child.nodeSize;
    }
    if (child.type.name === 'bulletList') {
      existingBulletEnd = listItemPos + 1 + offset + child.nodeSize - 1;
    }
  });

  const tr = editorInstance.state.tr;
  let focusPos: number;

  if (existingBulletEnd !== null) {
    const newItem = listItem.create(null, paragraph.create(null));
    tr.insert(existingBulletEnd, newItem);
    focusPos = existingBulletEnd + 2;
  } else {
    const newBullet = bulletList.create(null, listItem.create(null, paragraph.create(null)));
    tr.insert(insertAfterContent, newBullet);
    focusPos = insertAfterContent + 3;
  }

  const clampedPos = Math.min(focusPos, tr.doc.content.size - 1);
  tr.setSelection(Selection.near(tr.doc.resolve(clampedPos)));
  tr.setStoredMarks([]);
  editorInstance.view.dispatch(tr);
  editorInstance.view.focus();
}

// Helper: robustly append a new task card to the existing ordered list
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleAddNewCard(editorInstance: any) {
  if (!editorInstance) return;
  const { state, view } = editorInstance;
  const { doc, schema } = state;
  const listItem = schema.nodes.listItem;
  const paragraph = schema.nodes.paragraph;
  const orderedList = schema.nodes.orderedList;
  if (!listItem || !paragraph || !orderedList) return;

  let lastOrderedListPos: number | null = null;
  let lastOrderedListNode: any = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  doc.descendants((node: any, pos: number) => {
    if (node.type === orderedList) {
      const resolved = doc.resolve(pos);
      if (resolved.depth === 0 || (resolved.depth === 1 && resolved.parent.type.name === 'doc')) {
        lastOrderedListPos = pos;
        lastOrderedListNode = node;
      }
    }
  });

  const tr = state.tr;
  let focusPos: number;

  if (lastOrderedListPos !== null && lastOrderedListNode !== null) {
    const insertPos = Number(lastOrderedListPos) + lastOrderedListNode.nodeSize - 1;
    const newItem = listItem.create(null, paragraph.create(null));
    tr.insert(insertPos, newItem);
    focusPos = insertPos + 2;
  } else {
    const newList = orderedList.create(null, listItem.create(null, paragraph.create(null)));
    const endPos = doc.content.size;
    tr.insert(endPos, newList);
    focusPos = endPos + 3;
  }

  const clampedPos = Math.min(focusPos, tr.doc.content.size - 1);
  tr.setSelection(Selection.near(tr.doc.resolve(clampedPos)));
  tr.setStoredMarks([]);
  tr.scrollIntoView();
  view.dispatch(tr);
  view.focus();
}

// Helper: determines whether the listItem node at pos is a top-level task card
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isTopLevelListItemNode(doc: any, pos: number): boolean {
  const resolved = doc.resolve(pos);
  const parent = resolved.parent;
  if (parent.type.name !== 'orderedList' && parent.type.name !== 'bulletList') {
    return false;
  }
  for (let d = resolved.depth; d >= 0; d--) {
    if (resolved.node(d).type.name === 'listItem') {
      return false;
    }
  }
  return true;
}

// Helper: computes which 1-based top-level task index corresponds to a given cursor/click pos
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getTaskIndexAtPos(doc: any, pos: number): number | null {
  const resolved = doc.resolve(pos);
  let topLevelItemPos: number | null = null;

  for (let d = resolved.depth; d > 0; d--) {
    const node = resolved.node(d);
    if (node.type.name === 'listItem') {
      const itemPos = resolved.before(d);
      if (isTopLevelListItemNode(doc, itemPos)) {
        topLevelItemPos = itemPos;
        break;
      }
    }
  }

  if (topLevelItemPos === null) return null;

  let count = 0;
  let found: number | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  doc.descendants((n: any, p: number) => {
    if (n.type.name === 'listItem' && isTopLevelListItemNode(doc, p)) {
      count++;
      if (p === topLevelItemPos) {
        found = count;
      }
    }
  });

  return found;
}

// Extension: Auto-join directly adjacent ordered lists and bullet lists
const AutoJoinListsExtension = Extension.create({
  name: 'autoJoinLists',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('autoJoinOrderedListsPlugin'),
        appendTransaction(transactions, _oldState, newState) {
          if (!transactions.some((t) => t.docChanged)) return null;

          const { schema } = newState;
          const orderedListType = schema.nodes.orderedList;
          const bulletListType = schema.nodes.bulletList;
          if (!orderedListType && !bulletListType) return null;

          const tr = newState.tr;
          let changed = false;

          let iterations = 0;
          while (iterations < 10) {
            iterations++;
            let localChanged = false;
            const currentDoc = tr.doc;

            let pos = 0;
            for (let i = 0; i < currentDoc.childCount; i++) {
              const child = currentDoc.child(i);
              const childSize = child.nodeSize;

              if (child.type === orderedListType || child.type === bulletListType) {
                const nextIdx = i + 1;
                if (nextIdx < currentDoc.childCount && currentDoc.child(nextIdx).type === child.type) {
                  const joinAt = pos + childSize;
                  if (canJoin(tr.doc, joinAt)) {
                    tr.join(joinAt);
                    localChanged = true;
                    changed = true;
                    break;
                  }
                }
              }
              pos += childSize;
            }
            if (!localChanged) break;
          }

          return changed ? tr : null;
        },
      }),
    ];
  },
});

// Extension: Custom keymap for list item navigation and creation
const CustomListKeymapExtension = Extension.create({
  name: 'customListKeymap',
  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        if (!editor.isActive('orderedList') && !editor.isActive('bulletList')) {
          const { state } = editor;
          const { selection } = state;
          const { $from } = selection;
          const currentLineText = $from.parent.textContent;
          const wasHeading = $from.parent.type.name === 'heading';

          if (/^\d+\.\s*/.test(currentLineText.trim())) {
            const res = editor.chain().focus().toggleOrderedList().unsetMark('strike').run();
            if (res) {
              const tr = editor.state.tr;
              tr.setStoredMarks([]);
              editor.view.dispatch(tr);
              return true;
            }
          }

          const res = editor.chain().focus().toggleOrderedList().unsetMark('strike').run();
          if (res) {
            if (wasHeading) {
              editor.chain().setNode('paragraph').run();
            }
            const tr = editor.state.tr;
            tr.setStoredMarks([]);
            const { $from: newFrom } = tr.selection;
            const parent = newFrom.parent;
            if (parent && editor.state.schema.marks.strike) {
              const startPos = newFrom.start();
              const endPos = newFrom.end();
              if (endPos > startPos) {
                tr.removeMark(startPos, endPos, editor.state.schema.marks.strike);
              }
            }
            editor.view.dispatch(tr);
            return true;
          }
        }

        return false;
      },
      Tab: ({ editor }) => {
        if (editor.isActive('orderedList') || editor.isActive('bulletList')) {
          const { state } = editor;
          const { selection } = state;
          const { $from } = selection;

          for (let depth = $from.depth; depth > 0; depth--) {
            const node = $from.node(depth);
            if (node.type.name === 'listItem') {
              const parent = $from.node(depth - 1);
              const isTopLevelCard =
                (parent.type.name === 'orderedList' || parent.type.name === 'bulletList') &&
                (depth < 2 || $from.node(depth - 2)?.type.name !== 'listItem');

              if (isTopLevelCard) {
                let hasContent = false;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                node.forEach((child: any) => {
                  if (child.textContent.trim() !== '') {
                    hasContent = true;
                  }
                });

                if (hasContent) {
                  insertSubtaskAtCardPos(editor, $from.before(depth));
                  return true;
                }
              }
              break;
            }
          }
          return false;
        }

        if (!editor.isActive('orderedList') && !editor.isActive('bulletList')) {
          const res = editor.chain().focus().toggleOrderedList().unsetMark('strike').run();
          if (res) {
            editor.view.dispatch(editor.state.tr.setStoredMarks([]));
            return true;
          }
        }

        return false;
      },
      'Shift-Enter': ({ editor }) => {
        if (!editor.isActive('orderedList') && !editor.isActive('bulletList')) return false;
        const { $from } = editor.state.selection;
        for (let depth = $from.depth; depth > 0; depth--) {
          const node = $from.node(depth);
          if (node.type.name === 'listItem') {
            const parentNode = $from.node(depth - 1);
            if (parentNode.type.name === 'orderedList' || parentNode.type.name === 'bulletList') {
              const grandParent = depth >= 2 ? $from.node(depth - 2) : null;
              if (grandParent?.type.name !== 'listItem') {
                insertSubtaskAtCardPos(editor, $from.before(depth));
                return true;
              }
            }
            break;
          }
        }
        return false;
      },
      Backspace: ({ editor }) => {
        const { state, view } = editor;
        const { selection } = state;
        const { $from, empty } = selection;

        if (!empty) return false;

        for (let depth = $from.depth; depth > 0; depth--) {
          const node = $from.node(depth);
          if (node.type.name === 'listItem') {
            const parent = $from.node(depth - 1);
            const isTopLevelCard =
              (parent.type.name === 'orderedList' || parent.type.name === 'bulletList') &&
              (depth < 2 || $from.node(depth - 2)?.type.name !== 'listItem');

            if (isTopLevelCard) {
              const cardStartPos = $from.start(depth);
              const cardBeforePos = $from.before(depth);
              const cardAfterPos = $from.after(depth);

              let isCardEmpty = true;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              node.forEach((child: any) => {
                if (child.textContent.trim() !== '') {
                  isCardEmpty = false;
                }
                if (child.type.name === 'bulletList' || child.type.name === 'orderedList') {
                  isCardEmpty = false;
                }
              });

              if (isCardEmpty) {
                const tr = state.tr;
                tr.delete(cardBeforePos, cardAfterPos);
                const targetPos = Math.max(1, Math.min(cardBeforePos, tr.doc.content.size - 1));
                tr.setSelection(Selection.near(tr.doc.resolve(targetPos)));
                view.dispatch(tr);
                return true;
              }

              if ($from.pos === cardStartPos) {
                const indexInParent = $from.index(depth - 1);
                if (indexInParent > 0) {
                  return true;
                }
              }
            }
            break;
          }
        }
        return false;
      },
    };
  },
});

// ── Toolbar button component ────────────────────────────────────
interface ToolbarBtnProps {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
}

const ToolbarBtn: React.FC<ToolbarBtnProps> = ({ onClick, active, disabled, title, children }) => (
  <button
    type="button"
    title={title}
    disabled={disabled}
    onClick={onClick}
    className={`tiptap-toolbar-btn ${active ? 'is-active' : ''}`}
  >
    {children}
  </button>
);

const Sep = () => <div className="tiptap-toolbar-sep" />;

// ── Individual SwimLane Column Component ────────────────────────
interface SwimLaneColumnProps {
  lane: SwimLaneDoc;
  totalLanes: number;
  width?: string;
  isActive: boolean;
  onActivate: () => void;
  selectedTaskId?: number | null;
  runningTaskIds?: number[];
  pendingHumanInputs?: Record<number, { prompt: HumanInputPrompt; resolve: (answer: string) => void }>;
  showStyles: boolean;
  onSelectTask?: (taskId: number) => void;
  onMarkdownChange: (laneId: string, newMarkdown: string) => void;
  onRenameSwimLane?: (laneId: string, newTitle: string) => void;
  onDeleteSwimLane?: (laneId: string) => void;
  onArchiveTask?: (taskTitle: string) => void;
  onUnarchiveTask?: (taskId: number) => void;
  onDeleteArchivedTask?: (taskId: number) => void;
  archivedTasks?: TaskItemType[];
  assistantDrawerHeight: number;
  onEditorReady?: (laneId: string, editorInstance: any) => void;
}

const SwimLaneColumn: React.FC<SwimLaneColumnProps> = ({
  lane,
  totalLanes,
  width,
  isActive,
  onActivate,
  selectedTaskId,
  runningTaskIds = [],
  pendingHumanInputs,
  showStyles,
  onSelectTask,
  onMarkdownChange,
  onRenameSwimLane,
  onDeleteSwimLane,
  onArchiveTask,
  onUnarchiveTask,
  onDeleteArchivedTask,
  archivedTasks = [],
  assistantDrawerHeight,
  onEditorReady,
}) => {
  const selectedTaskIdRef = useRef(selectedTaskId);
  selectedTaskIdRef.current = selectedTaskId;

  const runningTaskIdsRef = useRef(runningTaskIds);
  runningTaskIdsRef.current = runningTaskIds;

  const pendingHumanInputsRef = useRef(pendingHumanInputs);
  pendingHumanInputsRef.current = pendingHumanInputs;

  const onSelectTaskRef = useRef(onSelectTask);
  onSelectTaskRef.current = onSelectTask;

  const onArchiveTaskRef = useRef(onArchiveTask);
  onArchiveTaskRef.current = onArchiveTask;

  // Local parsed items for this swim lane
  const laneParsed = useMemo(() => parseSwimLaneMarkdown(lane, 0), [lane]);
  const laneTasks = laneParsed.items;
  const laneTasksRef = useRef(laneTasks);
  laneTasksRef.current = laneTasks;

  const laneArchivedTasks = useMemo(() => {
    if (laneParsed.archivedItems && laneParsed.archivedItems.length > 0) {
      return laneParsed.archivedItems;
    }
    if (archivedTasks && archivedTasks.length > 0) {
      return archivedTasks.filter(
        (t) => t.swimLaneId === lane.id || (!t.swimLaneId && (lane.id === 'lane-default' || totalLanes === 1))
      );
    }
    return [];
  }, [laneParsed.archivedItems, archivedTasks, lane.id, totalLanes]);
  const [isArchiveOpen, setIsArchiveOpen] = useState(false);
  const [taskToDelete, setTaskToDelete] = useState<TaskItemType | null>(null);

  // Inline Title Editing State
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editedTitle, setEditedTitle] = useState(lane.title);
  const [isDeleteLaneModalOpen, setIsDeleteLaneModalOpen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsMenuOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsMenuOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isMenuOpen]);

  useEffect(() => {
    setEditedTitle(lane.title);
  }, [lane.title]);

  const handleTitleCommit = () => {
    setIsEditingTitle(false);
    if (editedTitle.trim() && editedTitle.trim() !== lane.title && onRenameSwimLane) {
      onRenameSwimLane(lane.id, editedTitle.trim());
    } else {
      setEditedTitle(lane.title);
    }
  };

  // ProseMirror decoration extension for UI Checkboxes, Add Subtask, and Active Card highlighting
  const TaskCheckboxDecorationExtension = Extension.create({
    name: `taskCheckboxDecoration_${lane.id}`,
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: new PluginKey(`taskCheckboxDecorationPlugin_${lane.id}`),
          props: {
            handleClick(view, pos) {
              if (onSelectTaskRef.current) {
                const itemIndex = getTaskIndexAtPos(view.state.doc, pos);
                if (itemIndex !== null) {
                  // Resolve matching task by index or id
                  const targetTask = laneTasksRef.current[itemIndex - 1];
                  const targetId = targetTask ? targetTask.id : itemIndex;
                  if (selectedTaskIdRef.current !== targetId) {
                    onSelectTaskRef.current(targetId);
                  }
                }
              }
              return false;
            },
            decorations(state) {
              const decorations: Decoration[] = [];
              const doc = state.doc;
              const strikeMarkType = state.schema.marks.strike;
              const currentSelectedTaskId = selectedTaskIdRef.current;
              const currentRunningTaskIds = runningTaskIdsRef.current;
              const currentTasks = laneTasksRef.current;
              if (!strikeMarkType) return DecorationSet.empty;

              let orderedItemCounter = 0;

              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              doc.descendants((node: any, pos: number) => {
                if (node.type.name !== 'listItem') return;

                const isTopLevel = isTopLevelListItemNode(doc, pos);

                if (isTopLevel) {
                  orderedItemCounter++;
                  const isOrdered = doc.resolve(pos).parent.type.name === 'orderedList';
                  const digitCount = isOrdered ? String(orderedItemCounter).length : 1;

                  const cardKey = `lane_${lane.id}_task_${orderedItemCounter}`;
                  const isCollapsed = collapsedCardsState.has(cardKey);

                  const matchedTask = currentTasks[orderedItemCounter - 1];
                  const cardTaskId = matchedTask ? matchedTask.id : orderedItemCounter;

                  const isCardActive = currentSelectedTaskId === cardTaskId;
                  const isCardRunning = currentRunningTaskIds ? currentRunningTaskIds.includes(cardTaskId) : false;
                  const isNeedsInput = !!pendingHumanInputsRef.current?.[cardTaskId];

                  let firstBlockPos: number | null = null;
                  let firstBlockNode: any = null;
                  let hasSubtasks = false;

                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  node.forEach((child: any, offset: number) => {
                    if (child.type.name !== 'bulletList' && child.type.name !== 'orderedList' && firstBlockPos === null) {
                      firstBlockPos = pos + 1 + offset;
                      firstBlockNode = child;
                    }
                    if (child.type.name === 'bulletList' || child.type.name === 'orderedList') {
                      hasSubtasks = true;
                    }
                  });

                  const isParentChecked = isNodeChecked(firstBlockNode);

                  // 1. Add active, running, done, collapsed, and digit-width classes to the top-level card
                  decorations.push(
                    Decoration.node(pos, pos + node.nodeSize, {
                      class: `${isCardActive ? 'is-active-card' : ''} ${isCardRunning ? 'is-card-running' : ''} ${isParentChecked ? 'is-card-done' : ''} ${isCollapsed ? 'card-collapsed' : ''} ${isOrdered ? `card-digits-${digitCount}` : 'card-unordered'}`,
                    })
                  );

                  // 2. Add Parent Checkbox Widget
                  const parentCheckboxWidget = Decoration.widget(
                    pos + 1,
                    (view, getPos) => {
                      const container = document.createElement('div');
                      container.className = `task-card-checkbox-wrapper ${isParentChecked ? 'is-checked' : ''} ${isCardRunning ? 'is-running' : ''} ${isNeedsInput ? 'is-needs-input' : ''}`;
                      container.setAttribute('contenteditable', 'false');
                      container.title = isParentChecked ? 'Mark task as incomplete' : 'Mark task as completed';

                      const checkbox = document.createElement('button');
                      checkbox.type = 'button';
                      checkbox.className = `task-ui-checkbox parent-checkbox ${isParentChecked ? 'checked' : ''} ${isCardRunning ? 'running' : ''} ${isNeedsInput ? 'needs-input' : ''}`;
                      checkbox.setAttribute('aria-checked', String(isParentChecked));
                      checkbox.setAttribute('role', 'checkbox');
                      checkbox.setAttribute('aria-label', isParentChecked ? 'Completed task' : 'Incomplete task');

                      if (isParentChecked) {
                        checkbox.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
                      }

                      const toggleParentTask = (e: MouseEvent) => {
                        e.preventDefault();
                        e.stopPropagation();

                        const rawPos = typeof getPos === 'function' ? getPos() : pos + 1;
                        if (rawPos == null) return;
                        const widgetPos = Number(rawPos);
                        if (isNaN(widgetPos)) return;
                        const listItemPos: number = widgetPos - 1;

                        const liveDoc = view.state.doc;
                        const liveNode = liveDoc.nodeAt(listItemPos);
                        if (!liveNode || liveNode.type.name !== 'listItem') return;

                        let liveFirstBlockPos: number | null = null;
                        let liveFirstBlockNode: any = null;
                        const liveSubtaskBlocks: { pos: number; node: any }[] = [];

                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        liveNode.forEach((child: any, offset: number) => {
                          const childPos: number = listItemPos + 1 + offset;
                          if (child.type.name !== 'bulletList' && child.type.name !== 'orderedList') {
                            if (liveFirstBlockPos === null) {
                              liveFirstBlockPos = childPos;
                              liveFirstBlockNode = child;
                            }
                          } else if (child.type.name === 'bulletList' || child.type.name === 'orderedList') {
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            child.forEach((nestedItem: any, nestedOffset: number) => {
                              const nestedItemPos: number = childPos + 1 + nestedOffset;
                              if (nestedItem.type.name === 'listItem') {
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                nestedItem.forEach((nestedChild: any, nOffset: number) => {
                                  if (nestedChild.type.name !== 'bulletList' && nestedChild.type.name !== 'orderedList') {
                                    liveSubtaskBlocks.push({
                                      pos: nestedItemPos + 1 + nOffset,
                                      node: nestedChild,
                                    });
                                  }
                                });
                              }
                            });
                          }
                        });

                        if (!liveFirstBlockNode || liveFirstBlockPos === null) return;

                        const shouldCheck = !isNodeChecked(liveFirstBlockNode);
                        const tr = view.state.tr;
                        const fromPos: number = Number(liveFirstBlockPos);
                        const toPos: number = fromPos + Number(liveFirstBlockNode.nodeSize);

                        if (shouldCheck) {
                          tr.addMark(fromPos, toPos, strikeMarkType.create());
                          liveSubtaskBlocks.forEach((sp) => {
                            const spFrom: number = Number(sp.pos);
                            const spTo: number = spFrom + Number(sp.node.nodeSize);
                            tr.addMark(spFrom, spTo, strikeMarkType.create());
                          });
                        } else {
                          tr.removeMark(fromPos, toPos, strikeMarkType);
                          liveSubtaskBlocks.forEach((sp) => {
                            const spFrom: number = Number(sp.pos);
                            const spTo: number = spFrom + Number(sp.node.nodeSize);
                            tr.removeMark(spFrom, spTo, strikeMarkType);
                          });
                        }

                        if (onSelectTaskRef.current) {
                          onSelectTaskRef.current(cardTaskId);
                        }

                        view.dispatch(tr);
                        view.focus();
                      };

                      checkbox.addEventListener('mousedown', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      });
                      checkbox.addEventListener('click', toggleParentTask);

                      container.appendChild(checkbox);
                      return container;
                    },
                    { side: -1, stopEvent: () => true }
                  );
                  decorations.push(parentCheckboxWidget);

                  // 3. Add Collapse / Expand Chevron Widget if task has subtasks
                  if (hasSubtasks) {
                    const chevronWidget = Decoration.widget(
                      pos + 1,
                      (view) => {
                        const btn = document.createElement('button');
                        btn.type = 'button';
                        btn.className = `card-collapse-btn ${isCollapsed ? 'is-collapsed' : ''}`;
                        btn.setAttribute('contenteditable', 'false');
                        btn.title = isCollapsed ? 'Expand subtasks' : 'Collapse subtasks';
                        btn.setAttribute('aria-label', isCollapsed ? 'Expand subtasks' : 'Collapse subtasks');
                        btn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`;

                        btn.addEventListener('mousedown', (e) => {
                          e.preventDefault();
                          e.stopPropagation();
                        });

                        btn.addEventListener('click', (e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (collapsedCardsState.has(cardKey)) {
                            collapsedCardsState.delete(cardKey);
                          } else {
                            collapsedCardsState.add(cardKey);
                          }
                          const tr = view.state.tr.setMeta('taskCollapseToggle', true);
                          view.dispatch(tr);
                        });

                        return btn;
                      },
                      { side: -1, stopEvent: () => true }
                    );
                    decorations.push(chevronWidget);
                  }

                  // 4. Add Top-Right Card Actions Widget (+ Subtask, Archive)
                  if (!isCollapsed) {
                    const cardActionsWidget = Decoration.widget(
                      pos + 1,
                      (view, getPos) => {
                        const container = document.createElement('div');
                        container.className = 'card-actions-wrapper';
                        container.setAttribute('contenteditable', 'false');

                        // Running status pill
                        if (isCardRunning) {
                          const runningPill = document.createElement('div');
                          runningPill.className = 'task-running-badge-pill';
                          runningPill.innerHTML = `<span class="live-pulse-dot-working"></span><span>RUNNING</span>`;
                          container.appendChild(runningPill);
                        }

                        // Add Subtask button
                        const addBtn = document.createElement('button');
                        addBtn.className = 'card-action-btn card-add-subtask-btn';
                        addBtn.setAttribute('contenteditable', 'false');
                        addBtn.type = 'button';
                        addBtn.title = 'Add subtask';
                        addBtn.setAttribute('aria-label', 'Add subtask');
                        addBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`;

                        addBtn.addEventListener('mousedown', (e) => {
                          e.preventDefault();
                          e.stopPropagation();
                        });

                        addBtn.addEventListener('click', (e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          const rawPos = typeof getPos === 'function' ? getPos() : pos + 1;
                          if (rawPos == null) return;
                          const currentPos = Number(rawPos) - 1;
                          insertSubtaskAtCardPos({ state: view.state, view }, currentPos);
                        });

                        // Task Options menu button with nested Archive functionality
                        const menuWrapper = document.createElement('div');
                        menuWrapper.style.position = 'relative';

                        const menuBtn = document.createElement('button');
                        menuBtn.className = 'card-action-btn card-menu-btn';
                        menuBtn.setAttribute('contenteditable', 'false');
                        menuBtn.type = 'button';
                        menuBtn.title = 'Task options';
                        menuBtn.setAttribute('aria-label', 'Task options');
                        menuBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="2.2"></circle><circle cx="19" cy="12" r="2.2"></circle><circle cx="5" cy="12" r="2.2"></circle></svg>`;

                        let dropdownEl: HTMLElement | null = null;

                        const closeMenu = () => {
                          if (dropdownEl && dropdownEl.parentNode) {
                            dropdownEl.parentNode.removeChild(dropdownEl);
                            dropdownEl = null;
                            menuBtn.classList.remove('active');
                          }
                          document.removeEventListener('mousedown', handleOutside);
                          document.removeEventListener('keydown', handleKey);
                        };

                        const handleOutside = (ev: MouseEvent) => {
                          if (dropdownEl && !menuWrapper.contains(ev.target as Node)) {
                            closeMenu();
                          }
                        };

                        const handleKey = (ev: KeyboardEvent) => {
                          if (ev.key === 'Escape') {
                            closeMenu();
                          }
                        };

                        menuBtn.addEventListener('mousedown', (e) => {
                          e.preventDefault();
                          e.stopPropagation();
                        });

                        menuBtn.addEventListener('click', (e) => {
                          e.preventDefault();
                          e.stopPropagation();

                          if (dropdownEl) {
                            closeMenu();
                            return;
                          }

                          menuBtn.classList.add('active');
                          dropdownEl = document.createElement('div');
                          dropdownEl.className = 'card-dropdown-menu';
                          dropdownEl.setAttribute('contenteditable', 'false');

                          if (onArchiveTaskRef.current) {
                            const archiveItem = document.createElement('button');
                            archiveItem.type = 'button';
                            archiveItem.className = 'card-dropdown-item';
                            archiveItem.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg><span>Archive Task</span>`;

                            archiveItem.addEventListener('mousedown', (ev) => {
                              ev.preventDefault();
                              ev.stopPropagation();
                            });

                            archiveItem.addEventListener('click', (ev) => {
                              ev.preventDefault();
                              ev.stopPropagation();
                              closeMenu();
                              collapsedCardsState.delete(cardKey);

                              if (onArchiveTaskRef.current) {
                                const liveTitle = firstBlockNode?.textContent?.trim() || '';
                                onArchiveTaskRef.current(liveTitle);
                              }
                            });

                            dropdownEl.appendChild(archiveItem);
                          }

                          menuWrapper.appendChild(dropdownEl);

                          setTimeout(() => {
                            document.addEventListener('mousedown', handleOutside);
                            document.addEventListener('keydown', handleKey);
                          }, 0);
                        });

                        menuWrapper.appendChild(menuBtn);
                        container.appendChild(addBtn);
                        container.appendChild(menuWrapper);

                        return container;
                      },
                      { side: 1, stopEvent: () => true }
                    );
                    decorations.push(cardActionsWidget);
                  }

                } else {
                  // Subtask list item
                  let subBlockPos: number | null = null;
                  let subBlockNode: any = null;

                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  node.forEach((child: any, offset: number) => {
                    if (child.type.name !== 'bulletList' && child.type.name !== 'orderedList' && subBlockPos === null) {
                      subBlockPos = pos + 1 + offset;
                      subBlockNode = child;
                    }
                  });

                  if (subBlockNode && subBlockPos !== null) {
                    const isSubChecked = isNodeChecked(subBlockNode);
                    const subText = (subBlockNode.textContent || '').toLowerCase();
                    const isHumanReviewSubtask = subText.includes('**human review**') || subText.includes('human review:') || subText.includes('human review -');

                    if (isHumanReviewSubtask) {
                      decorations.push(
                        Decoration.node(pos, pos + node.nodeSize, {
                          class: `task-human-review-item ${isSubChecked ? 'is-verified' : 'is-pending-review'}`,
                        })
                      );
                    }

                    const subtaskCheckboxWidget = Decoration.widget(
                      pos + 1,
                      (view, getPos) => {
                        const container = document.createElement('span');
                        container.className = `subtask-checkbox-wrapper ${isSubChecked ? 'is-checked' : ''} ${isHumanReviewSubtask ? 'is-human-review-wrapper' : ''}`;
                        container.setAttribute('contenteditable', 'false');
                        container.title = isHumanReviewSubtask
                          ? (isSubChecked ? 'Human verification completed' : 'Pending human review / verification')
                          : (isSubChecked ? 'Mark subtask as incomplete' : 'Mark subtask as completed');

                        const checkbox = document.createElement('button');
                        checkbox.type = 'button';
                        checkbox.className = `task-ui-checkbox subtask-checkbox ${isSubChecked ? 'checked' : ''} ${isHumanReviewSubtask ? 'human-review-cb' : ''}`;
                        checkbox.setAttribute('aria-checked', String(isSubChecked));
                        checkbox.setAttribute('role', 'checkbox');
                        checkbox.setAttribute('aria-label', isSubChecked ? 'Completed subtask' : 'Incomplete subtask');

                        if (isSubChecked) {
                          checkbox.innerHTML = `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
                        } else if (isHumanReviewSubtask) {
                          checkbox.innerHTML = `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
                        }

                        const toggleSubtask = (e: MouseEvent) => {
                          e.preventDefault();
                          e.stopPropagation();

                          const rawPos = typeof getPos === 'function' ? getPos() : pos + 1;
                          if (rawPos == null) return;
                          const widgetPos = Number(rawPos);
                          if (isNaN(widgetPos)) return;
                          const itemPos: number = widgetPos - 1;

                          const liveDoc = view.state.doc;
                          const liveNode = liveDoc.nodeAt(itemPos);
                          if (!liveNode || liveNode.type.name !== 'listItem') return;

                          let liveBlockPos: number | null = null;
                          let liveBlockNode: any = null;
                          // eslint-disable-next-line @typescript-eslint/no-explicit-any
                          liveNode.forEach((child: any, offset: number) => {
                            if (child.type.name !== 'bulletList' && child.type.name !== 'orderedList' && liveBlockPos === null) {
                              liveBlockPos = itemPos + 1 + offset;
                              liveBlockNode = child;
                            }
                          });

                          if (!liveBlockNode || liveBlockPos === null) return;

                          const shouldCheck = !isNodeChecked(liveBlockNode);
                          const tr = view.state.tr;
                          const fromPos: number = Number(liveBlockPos);
                          const toPos: number = fromPos + Number(liveBlockNode.nodeSize);

                          if (shouldCheck) {
                            tr.addMark(fromPos, toPos, strikeMarkType.create());
                          } else {
                            tr.removeMark(fromPos, toPos, strikeMarkType);
                          }

                          view.dispatch(tr);
                          view.focus();
                        };

                        checkbox.addEventListener('mousedown', (e) => {
                          e.preventDefault();
                          e.stopPropagation();
                        });
                        checkbox.addEventListener('click', toggleSubtask);

                        container.appendChild(checkbox);
                        return container;
                      },
                      { side: -1, stopEvent: () => true }
                    );
                    decorations.push(subtaskCheckboxWidget);
                  }
                }
              });

              // Add inline decorations to hide backslash escaping before formatting characters
              const cursor = state.selection.from;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              doc.descendants((node: any, pos: number) => {
                if (node.isText && node.text) {
                  const text = node.text;
                  const escapeRegex = /\\([*~_`#[\]()>+\-.!])/g;
                  let match: RegExpExecArray | null;
                  while ((match = escapeRegex.exec(text)) !== null) {
                    const slashPos = pos + match.index;
                    const isNearCursor = cursor >= slashPos && cursor <= slashPos + 2;
                    if (!isNearCursor) {
                      decorations.push(
                        Decoration.inline(slashPos, slashPos + 1, {
                          class: 'md-escaped-backslash-hidden',
                          style: 'display: none;',
                        })
                      );
                    }
                  }
                }
              });

              return DecorationSet.create(doc, decorations);
            },
          },
        }),
      ];
    },
  });

  const AutoSurroundExtension = Extension.create({
    name: `autoSurround_${lane.id}`,
    addProseMirrorPlugins() {
      const editorInstance = this.editor;
      return [
        new Plugin({
          key: new PluginKey(`autoSurround_${lane.id}`),
          props: {
            handleTextInput(view, from, to, text) {
              if (from === to) return false;
              const { state } = view;
              const { selection } = state;
              if (selection.empty) return false;

              if (text === '`') {
                editorInstance.chain().focus().toggleCode().run();
                return true;
              }

              if (text === '*' || text === '_') {
                if (editorInstance.isActive('italic') && !editorInstance.isActive('bold')) {
                  editorInstance.chain().focus().toggleItalic().toggleBold().run();
                } else if (editorInstance.isActive('bold') && !editorInstance.isActive('italic')) {
                  editorInstance.chain().focus().toggleItalic().run();
                } else {
                  editorInstance.chain().focus().toggleItalic().run();
                }
                return true;
              }

              if (text === '~') {
                editorInstance.chain().focus().toggleStrike().run();
                return true;
              }

              const pair = MARKDOWN_WRAPPER_PAIRS[text];
              if (pair) {
                const [open, close] = pair;
                const selectedText = state.doc.textBetween(from, to);
                if (!selectedText) return false;

                const wrapped = `${open}${selectedText}${close}`;
                const tr = state.tr.insertText(wrapped, from, to);
                const newSelection = TextSelection.create(tr.doc, from + open.length, to + open.length);
                tr.setSelection(newSelection);
                view.dispatch(tr);
                return true;
              }

              return false;
            },
          },
        }),
      ];
    },
  });

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        bulletList: { keepMarks: true, keepAttributes: false },
        orderedList: { keepMarks: true, keepAttributes: false },
        listItem: false,
      }),
      CustomListItem,
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { class: 'md-link', target: '_blank', rel: 'noopener noreferrer' },
      }),
      Placeholder.configure({
        placeholder: ({ node }) => {
          if (node.type.name === 'heading') return 'Heading...';
          return 'Add a task or click + New Task...';
        },
      }),
      Typography,
      Markdown.configure({
        html: false,
        tightLists: true,
        tightListClass: 'tight',
        bulletListMarker: '-',
        linkify: true,
        breaks: false,
        transformPastedText: true,
        transformCopiedText: true,
      }),
      AutoJoinListsExtension,
      CustomListKeymapExtension,
      TaskCheckboxDecorationExtension,
      AutoSurroundExtension,
    ],
    content: stripHeaderComments(lane.markdown),
    editorProps: {
      attributes: {
        class: 'tiptap obsidian-editor',
        spellcheck: 'false',
      },
    },
    onFocus: () => {
      onActivate();
    },
    onUpdate: ({ editor: currentEditor }) => {
      const storage = (currentEditor as unknown as WithMarkdownStorage).storage;
      const markdown = storage.markdown.getMarkdown();
      onMarkdownChange(lane.id, markdown);
    },
  });

  useEffect(() => {
    if (editor && onEditorReady) {
      onEditorReady(lane.id, editor);
    }
  }, [editor, lane.id, onEditorReady]);

  // Synchronize editor content when external lane.markdown changes
  useEffect(() => {
    if (editor && !editor.isFocused) {
      const stripped = stripHeaderComments(lane.markdown);
      const storage = (editor as unknown as WithMarkdownStorage).storage;
      const currentMd = storage.markdown?.getMarkdown();
      if (currentMd !== stripped) {
        editor.commands.setContent(stripped, { emitUpdate: false });
      }
    }
  }, [lane.markdown, editor]);

  // Toolbar action helpers
  const setLink = useCallback(() => {
    if (!editor) return;
    const previousUrl = editor.getAttributes('link').href;
    const url = window.prompt('URL', previousUrl);
    if (url === null) return;
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  }, [editor]);

  const laneDoneCount = laneTasks.filter((t) => t.isDone).length;
  const fileName = lane.filePath ? lane.filePath.split('/').pop() || lane.title : lane.title;

  return (
    <div
      className={`swimlane-column ${totalLanes > 1 ? 'is-multi-lane' : 'is-single-lane'} ${isActive ? 'is-active-lane' : ''}`}
      onClick={() => onActivate()}
      style={totalLanes > 1 && width ? { width, minWidth: '260px', flex: `0 0 ${width}` } : undefined}
    >
      {/* Column Sub-Header (Only shown in multi-swimlane mode to avoid duplicate headers in single lane mode) */}
      {totalLanes > 1 && (
        <div className="swimlane-column-header">
          <div className="swimlane-title-container">
            {isEditingTitle ? (
              <input
                type="text"
                className="swimlane-title-input"
                value={editedTitle}
                onChange={(e) => setEditedTitle(e.target.value)}
                onBlur={handleTitleCommit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleTitleCommit();
                  if (e.key === 'Escape') {
                    setEditedTitle(lane.title);
                    setIsEditingTitle(false);
                  }
                }}
                autoFocus
              />
            ) : (
              <div
                style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer', minWidth: 0 }}
                onClick={() => setIsEditingTitle(true)}
                title="Click to rename swim lane"
              >
                <span className="swimlane-title-text">{lane.title}</span>
              </div>
            )}
            <span className="pane-subtitle" style={{ fontSize: '0.75rem', whiteSpace: 'nowrap' }}>
              {laneDoneCount}/{laneTasks.length} done
            </span>
          </div>

          <div style={{ position: 'relative' }} ref={menuRef}>
            <button
              type="button"
              className={`swimlane-menu-btn ${isMenuOpen ? 'active' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                setIsMenuOpen((prev) => !prev);
              }}
              title="Swim lane options"
            >
              <MoreHorizontal size={15} />
            </button>

            {isMenuOpen && (
              <div className="swimlane-dropdown-menu" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  className="swimlane-dropdown-item"
                  onClick={() => {
                    setIsMenuOpen(false);
                    setIsEditingTitle(true);
                  }}
                >
                  <Edit2 size={13} />
                  <span>Rename Lane</span>
                </button>

                <div className="swimlane-dropdown-divider" />

                <button
                  type="button"
                  className="swimlane-dropdown-item is-danger"
                  onClick={() => {
                    setIsMenuOpen(false);
                    setIsDeleteLaneModalOpen(true);
                  }}
                >
                  <Trash2 size={13} />
                  <span>Delete Lane</span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Formatting Toolbar (when Styles is toggled) */}
      {showStyles && (
        <div className="tiptap-toolbar" style={{ flexShrink: 0 }}>
          <div className="tiptap-toolbar-group">
            <ToolbarBtn onClick={() => editor?.chain().focus().undo().run()} disabled={!editor?.can().undo()} title="Undo (Ctrl+Z)">
              <Undo2 size={13} />
            </ToolbarBtn>
            <ToolbarBtn onClick={() => editor?.chain().focus().redo().run()} disabled={!editor?.can().redo()} title="Redo (Ctrl+Y)">
              <Redo2 size={13} />
            </ToolbarBtn>
          </div>

          <Sep />

          <div className="tiptap-toolbar-group">
            <ToolbarBtn onClick={() => editor?.chain().focus().toggleBold().run()} active={editor?.isActive('bold')} title="Bold (**text**)">
              <Bold size={13} />
            </ToolbarBtn>
            <ToolbarBtn onClick={() => editor?.chain().focus().toggleItalic().run()} active={editor?.isActive('italic')} title="Italic (*text*)">
              <Italic size={13} />
            </ToolbarBtn>
            <ToolbarBtn onClick={() => editor?.chain().focus().toggleStrike().run()} active={editor?.isActive('strike')} title="Strike (~~text~~)">
              <Strikethrough size={13} />
            </ToolbarBtn>
            <ToolbarBtn onClick={() => editor?.chain().focus().toggleCode().run()} active={editor?.isActive('code')} title="Inline Code (`code`)">
              <Code size={13} />
            </ToolbarBtn>
            <ToolbarBtn onClick={setLink} active={editor?.isActive('link')} title="Link ([text](url))">
              <LinkIcon size={13} />
            </ToolbarBtn>
          </div>

          <Sep />

          <div className="tiptap-toolbar-group">
            <ToolbarBtn onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()} active={editor?.isActive('heading', { level: 1 })} title="Heading 1 (# Text)">
              <Heading1 size={13} />
            </ToolbarBtn>
            <ToolbarBtn onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()} active={editor?.isActive('heading', { level: 2 })} title="Heading 2 (## Text)">
              <Heading2 size={13} />
            </ToolbarBtn>
            <ToolbarBtn onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()} active={editor?.isActive('heading', { level: 3 })} title="Heading 3 (### Text)">
              <Heading3 size={13} />
            </ToolbarBtn>
          </div>

          <Sep />

          <div className="tiptap-toolbar-group">
            <ToolbarBtn onClick={() => editor?.chain().focus().toggleOrderedList().run()} active={editor?.isActive('orderedList')} title="Task List / Numbered List (1. Task)">
              <ListOrdered size={13} />
            </ToolbarBtn>
            <ToolbarBtn onClick={() => editor?.chain().focus().toggleBulletList().run()} active={editor?.isActive('bulletList')} title="Subtask / Bullet List (- Subtask)">
              <List size={13} />
            </ToolbarBtn>
            <ToolbarBtn onClick={() => editor?.chain().focus().toggleBlockquote().run()} active={editor?.isActive('blockquote')} title="Blockquote (> quote)">
              <Quote size={13} />
            </ToolbarBtn>
            <ToolbarBtn onClick={() => editor?.chain().focus().toggleCodeBlock().run()} active={editor?.isActive('codeBlock')} title="Code Block (```)">
              <FileCode size={13} />
            </ToolbarBtn>
            <ToolbarBtn onClick={() => editor?.chain().focus().setHorizontalRule().run()} title="Horizontal Rule (---)">
              <Minus size={13} />
            </ToolbarBtn>
          </div>
        </div>
      )}

      {/* Editor Scroll Container */}
      <div
        className="obsidian-editor-container obsidian-scroll-area"
        style={{
          flex: 1,
          overflowY: 'auto',
          paddingBottom: `${assistantDrawerHeight + 80}px`,
        }}
      >
        <EditorContent editor={editor} className="tiptap-editor-root" />
      </div>

      {/* ── Collapsible Archive Panel at bottom of swim lane ── */}
      <div className="archive-collapsible-panel" style={{ margin: '1rem 0.85rem 1.25rem', flexShrink: 0 }}>
        <button
          type="button"
          className={`archive-panel-header ${isArchiveOpen ? 'open' : ''}`}
          onClick={() => setIsArchiveOpen((prev) => !prev)}
          title={isArchiveOpen ? 'Collapse archive panel' : 'Expand archive panel'}
        >
          <div className="archive-panel-header-left">
            <Archive size={15} className="archive-icon" />
            <span className="archive-panel-title">Archived Tasks</span>
            <span className="archive-count-badge">
              {laneArchivedTasks.length} {laneArchivedTasks.length === 1 ? 'task' : 'tasks'}
            </span>
          </div>
          <ChevronDown size={15} className={`archive-chevron ${isArchiveOpen ? 'open' : ''}`} />
        </button>

        {isArchiveOpen && (
          <div className="archive-panel-content">
            {laneArchivedTasks.length === 0 ? (
              <div className="archive-empty-state">
                <span>No archived tasks in this lane</span>
              </div>
            ) : (
              <div className="archived-tasks-list">
                {laneArchivedTasks.map((task) => (
                  <div key={task.id} className="archived-task-card">
                    <div className="archived-task-checkbox-col">
                      <div
                        className={`task-ui-checkbox parent-checkbox ${task.isDone ? 'checked' : ''}`}
                        style={{ cursor: 'default', pointerEvents: 'none' }}
                      >
                        {task.isDone && (
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                      </div>
                    </div>
                    <div className="archived-task-main">
                      <div className="archived-task-title-row">
                        <MarkdownRenderer
                          content={task.isDone ? `~~${task.title}~~` : task.title}
                          inline={true}
                          className={`archived-task-title ${task.isDone ? 'is-done' : ''}`}
                        />
                        {task.category && task.category !== 'Archive' && task.category !== 'Untitled' && (
                          <span className="archived-task-category-pill">{task.category}</span>
                        )}
                      </div>
                      {task.subtasks && task.subtasks.length > 0 && (
                        <div className="archived-subtasks-list">
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
                    <div className="archived-task-actions">
                      <button
                        type="button"
                        className="archived-action-btn unarchive-btn"
                        title="Unarchive task"
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
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Swim Lane Delete Confirmation Modal */}
      {isDeleteLaneModalOpen && (
        <div className="modal-overlay" onClick={() => setIsDeleteLaneModalOpen(false)}>
          <div className="modal-card archive-delete-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--accent-rose)' }}>
                <AlertTriangle size={18} />
                <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>Delete Swim Lane?</h3>
              </div>
              <button type="button" className="btn-icon" onClick={() => setIsDeleteLaneModalOpen(false)}>
                <X size={16} />
              </button>
            </div>
            <div className="modal-body" style={{ padding: '1rem 1.25rem', fontSize: '0.88rem', color: 'var(--text-secondary)' }}>
              <p style={{ margin: 0, marginBottom: '0.75rem' }}>
                Are you sure you want to remove swim lane <strong>"{lane.title}"</strong> ({fileName})?
              </p>
              <div className="archive-delete-warning-box">
                <AlertCircle size={15} style={{ flexShrink: 0, color: 'var(--accent-rose)' }} />
                <span>The file content in this lane will no longer appear in your active workspace view.</span>
              </div>
            </div>
            <div className="modal-footer" style={{ padding: '0.75rem 1.25rem', display: 'flex', justifyContent: 'flex-end', gap: '0.6rem' }}>
              <button type="button" className="btn btn-secondary" onClick={() => setIsDeleteLaneModalOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                style={{ background: 'var(--accent-rose)', color: '#fff' }}
                onClick={() => {
                  onDeleteSwimLane?.(lane.id);
                  setIsDeleteLaneModalOpen(false);
                }}
              >
                Delete Swim Lane
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Task Permanent Deletion Context Warning Modal */}
      {taskToDelete && (
        <div className="modal-overlay" onClick={() => setTaskToDelete(null)}>
          <div className="modal-card archive-delete-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--accent-rose)' }}>
                <AlertTriangle size={18} />
                <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>Delete Task Permanently?</h3>
              </div>
              <button type="button" className="btn-icon" onClick={() => setTaskToDelete(null)}>
                <X size={16} />
              </button>
            </div>
            <div className="modal-body" style={{ padding: '1rem 1.25rem', fontSize: '0.88rem', color: 'var(--text-secondary)' }}>
              <p style={{ margin: 0, marginBottom: '0.75rem' }}>
                Are you sure you want to permanently delete <strong>"{taskToDelete.title}"</strong>?
              </p>
              <div className="archive-delete-warning-box">
                <AlertCircle size={15} style={{ flexShrink: 0, color: 'var(--accent-rose)' }} />
                <span>If you proceed with deleting this task, the AI will lose context for it.</span>
              </div>
            </div>
            <div className="modal-footer" style={{ padding: '0.75rem 1.25rem', display: 'flex', justifyContent: 'flex-end', gap: '0.6rem' }}>
              <button type="button" className="btn btn-secondary" onClick={() => setTaskToDelete(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                style={{ background: 'var(--accent-rose)', color: '#fff' }}
                onClick={() => {
                  onDeleteArchivedTask?.(taskToDelete.id);
                  setTaskToDelete(null);
                }}
              >
                Delete Task
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Main TaskPane Component ──────────────────────────────────────────────────
interface TaskPaneProps {
  rawMarkdown: string;
  tasks: TaskItemType[];
  archivedTasks?: TaskItemType[];
  selectedTaskId?: number | null;
  runningTaskIds?: number[];
  pendingHumanInputs?: Record<number, { prompt: HumanInputPrompt; resolve: (answer: string) => void }>;
  onSelectTask?: (taskId: number) => void;
  onMarkdownChange: (newMarkdown: string) => void;
  onOpenDraftModal: () => void;
  isAssistantOpen?: boolean;
  onCloseAssistant?: () => void;
  project?: ProjectData | null;
  agentContextMarkdown?: string;
  aiConfig?: AIProviderConfig;
  mcpServers?: MCPServer[];
  onApplyAssistantResult?: (result: HumanAiAssistantResult, confirmedDeletions: boolean) => void;
  onArchiveTask?: (taskTitle: string) => void;
  onUnarchiveTask?: (taskId: number) => void;
  onDeleteArchivedTask?: (taskId: number) => void;
  swimLanes?: SwimLaneDoc[];
  onAddSwimLane?: () => void;
  onRenameSwimLane?: (laneId: string, newTitle: string) => void;
  onDeleteSwimLane?: (laneId: string) => void;
  onSwimLaneMarkdownChange?: (laneId: string, newMarkdown: string) => void;
}

export const TaskPane: React.FC<TaskPaneProps> = ({
  rawMarkdown,
  tasks,
  archivedTasks = [],
  selectedTaskId,
  runningTaskIds = [],
  pendingHumanInputs,
  onSelectTask,
  onMarkdownChange,
  onOpenDraftModal,
  isAssistantOpen = false,
  onCloseAssistant = () => { },
  project,
  agentContextMarkdown = '',
  aiConfig,
  mcpServers = [],
  onApplyAssistantResult = () => { },
  onArchiveTask,
  onUnarchiveTask,
  onDeleteArchivedTask,
  swimLanes,
  onAddSwimLane,
  onRenameSwimLane,
  onDeleteSwimLane,
  onSwimLaneMarkdownChange,
}) => {
  const [showStyles, setShowStyles] = useState(false);
  const [assistantDrawerHeight, setAssistantDrawerHeight] = useState<number>(0);

  // Keep references to active editors in each lane to support global "+ New Task" button
  const editorsRef = useRef<Record<string, any>>({});
  const handleEditorReady = useCallback((laneId: string, editorInstance: any) => {
    editorsRef.current[laneId] = editorInstance;
  }, []);

  // Normalize swimLanes: fallback to 1 human view if not provided
  const effectiveSwimLanes = useMemo<SwimLaneDoc[]>(() => {
    if (swimLanes && swimLanes.length > 0) {
      return swimLanes;
    }
    return [
      {
        id: 'lane-default',
        title: 'Human Workspace',
        filePath: project?.todoFilePath || 'TODO.md',
        markdown: rawMarkdown || '',
      },
    ];
  }, [swimLanes, project?.todoFilePath, rawMarkdown]);

  const totalTasks = tasks.length;
  const totalDoneTasks = tasks.filter((t) => t.isDone).length;

  const handleLaneMarkdownChange = (laneId: string, newMarkdown: string) => {
    if (onSwimLaneMarkdownChange) {
      onSwimLaneMarkdownChange(laneId, newMarkdown);
    } else {
      onMarkdownChange(newMarkdown);
    }
  };

  // Active / Highlighted Swim Lane ID (defaults to first lane)
  const [activeSwimLaneId, setActiveSwimLaneId] = useState<string>(effectiveSwimLanes[0]?.id || 'lane-default');

  useEffect(() => {
    if (!effectiveSwimLanes.some((l) => l.id === activeSwimLaneId)) {
      setActiveSwimLaneId(effectiveSwimLanes[0]?.id || 'lane-default');
    }
  }, [effectiveSwimLanes, activeSwimLaneId]);

  const activeSwimLane = effectiveSwimLanes.find((l) => l.id === activeSwimLaneId) || effectiveSwimLanes[0];

  // Inline Title Editing for Single Swim Lane mode
  const singleLane = effectiveSwimLanes[0];
  const [isEditingSingleTitle, setIsEditingSingleTitle] = useState(false);
  const [singleTitleVal, setSingleTitleVal] = useState(singleLane?.title || 'Human Workspace');

  useEffect(() => {
    if (singleLane?.title) {
      setSingleTitleVal(singleLane.title);
    }
  }, [singleLane?.title]);

  const handleSingleTitleCommit = () => {
    setIsEditingSingleTitle(false);
    if (singleTitleVal.trim() && singleTitleVal.trim() !== singleLane?.title && onRenameSwimLane && singleLane) {
      onRenameSwimLane(singleLane.id, singleTitleVal.trim());
    } else {
      setSingleTitleVal(singleLane?.title || 'Human Workspace');
    }
  };

  // Lane widths state (in pixels) for draggable resizing in multi-swimlane mode
  const [laneWidths, setLaneWidths] = useState<Record<string, number>>({});
  const resizingRef = useRef<{ laneId: string; startX: number; startWidth: number } | null>(null);
  const [isResizingLane, setIsResizingLane] = useState(false);

  const handleStartResize = (e: React.MouseEvent, laneId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const currentWidth = laneWidths[laneId] || Math.round(window.innerWidth / 3);
    resizingRef.current = {
      laneId,
      startX: e.clientX,
      startWidth: currentWidth,
    };
    setIsResizingLane(true);
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!resizingRef.current) return;
      const { laneId, startX, startWidth } = resizingRef.current;
      const deltaX = e.clientX - startX;
      const newWidth = Math.max(260, startWidth + deltaX);
      setLaneWidths((prev) => ({ ...prev, [laneId]: newWidth }));
    };

    const handleMouseUp = () => {
      if (resizingRef.current) {
        resizingRef.current = null;
        setIsResizingLane(false);
      }
    };

    if (isResizingLane) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizingLane]);

  // Click "+ New Task" in footer creates task in highlighted / active swim lane
  const handleGlobalNewTask = () => {
    const targetLaneId = activeSwimLaneId || effectiveSwimLanes[0]?.id;
    const editor = editorsRef.current[targetLaneId];
    if (editor) {
      editor.commands.focus();
      handleAddNewCard(editor);
    }
  };

  return (
    <div className="pane pane-left obsidian-pane">
      {/* ── Main Pane Header ── */}
      <div className="pane-header obsidian-header">
        <div className="pane-title" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0, flex: 1 }}>
          <FileText size={17} color="var(--accent-cyan)" />
          {effectiveSwimLanes.length === 1 ? (
            isEditingSingleTitle ? (
              <input
                type="text"
                className="swimlane-title-input"
                style={{ maxWidth: '220px', padding: '0.15rem 0.4rem', fontSize: '0.88rem' }}
                value={singleTitleVal}
                onChange={(e) => setSingleTitleVal(e.target.value)}
                onBlur={handleSingleTitleCommit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSingleTitleCommit();
                  if (e.key === 'Escape') {
                    setSingleTitleVal(singleLane?.title || 'Human Workspace');
                    setIsEditingSingleTitle(false);
                  }
                }}
                autoFocus
              />
            ) : (
              <div
                style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', cursor: 'pointer' }}
                onClick={() => setIsEditingSingleTitle(true)}
                title="Click to rename"
              >
                <span>{singleLane?.title || 'Human Workspace'}</span>
              </div>
            )
          ) : (
            <span>Human Workspace</span>
          )}
          <span className="pane-subtitle">{totalDoneTasks}/{totalTasks} done</span>
          {effectiveSwimLanes.length > 1 && (
            <span className="swimlane-count-pill" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', padding: '0.15rem 0.45rem', borderRadius: '4px', background: 'rgba(99, 102, 241, 0.15)', color: '#818cf8', fontSize: '0.72rem', fontWeight: 600 }}>
              <Columns size={11} />
              <span>{effectiveSwimLanes.length} Lanes</span>
            </span>
          )}
        </div>

        <div style={{ display: 'flex', gap: '0.45rem', alignItems: 'center' }}>
          {/* Styles Toolbar Toggle */}
          <button
            type="button"
            className={`btn btn-secondary ${showStyles ? 'active' : ''}`}
            style={{
              padding: '0.3rem 0.65rem',
              fontSize: '0.8rem',
              borderColor: showStyles ? 'var(--accent-primary)' : undefined,
              background: showStyles ? 'rgba(99, 102, 241, 0.18)' : undefined,
              color: showStyles ? 'var(--text-bright, #fff)' : undefined,
            }}
            onClick={() => setShowStyles((prev) => !prev)}
            title={showStyles ? 'Hide markdown formatting bar' : 'Show markdown formatting bar'}
          >
            <Type size={13} />
            <span>Styles</span>
          </button>

          {/* + Add Swim Lane Button directly beside Styles */}
          <button
            type="button"
            className="btn btn-secondary add-swimlane-header-btn"
            style={{
              padding: '0.3rem 0.65rem',
              fontSize: '0.8rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem',
            }}
            onClick={onAddSwimLane}
            title="Create a new swim lane column (additional markdown document)"
          >
            <Plus size={14} />
            {/* <span>Swim Lane</span> */}
          </button>
        </div>
      </div>

      {/* ── Swim Lanes Container ── */}
      <div className={`swimlanes-wrapper ${effectiveSwimLanes.length > 1 ? 'is-multi-column' : 'is-single-column'}`}>
        {effectiveSwimLanes.map((lane, idx) => (
          <React.Fragment key={lane.id}>
            <SwimLaneColumn
              lane={lane}
              totalLanes={effectiveSwimLanes.length}
              width={effectiveSwimLanes.length > 1 ? (laneWidths[lane.id] ? `${laneWidths[lane.id]}px` : 'calc(100vw / 3)') : undefined}
              isActive={lane.id === activeSwimLaneId}
              onActivate={() => setActiveSwimLaneId(lane.id)}
              selectedTaskId={selectedTaskId}
              runningTaskIds={runningTaskIds}
              pendingHumanInputs={pendingHumanInputs}
              showStyles={showStyles}
              onSelectTask={onSelectTask}
              onMarkdownChange={handleLaneMarkdownChange}
              onRenameSwimLane={onRenameSwimLane}
              onDeleteSwimLane={onDeleteSwimLane}
              onArchiveTask={onArchiveTask}
              onUnarchiveTask={onUnarchiveTask}
              onDeleteArchivedTask={onDeleteArchivedTask}
              archivedTasks={archivedTasks}
              assistantDrawerHeight={assistantDrawerHeight}
              onEditorReady={handleEditorReady}
            />
            {effectiveSwimLanes.length > 1 && idx < effectiveSwimLanes.length - 1 && (
              <div
                className={`swimlane-resizer-handle ${resizingRef.current?.laneId === lane.id ? 'is-active' : ''}`}
                onMouseDown={(e) => handleStartResize(e, lane.id)}
                title="Drag to resize swim lane width"
              >
                <div className="swimlane-resizer-line" />
              </div>
            )}
          </React.Fragment>
        ))}
      </div>

      {/* ── Human AI Assistant Slide-up Bar / Drawer (targets highlighted active lane) ── */}
      {project && aiConfig && (
        <HumanAiAssistantModal
          isOpen={isAssistantOpen}
          onClose={onCloseAssistant}
          project={project}
          todoMarkdown={activeSwimLane?.markdown || rawMarkdown}
          agentContextMarkdown={agentContextMarkdown}
          aiConfig={aiConfig}
          mcpServers={mcpServers}
          onApplyAssistantResult={(result, confirmedDeletions) => {
            if (result.todoMarkdown && activeSwimLane) {
              handleLaneMarkdownChange(activeSwimLane.id, result.todoMarkdown);
            }
            onApplyAssistantResult?.(result, confirmedDeletions);
          }}
          onHeightChange={setAssistantDrawerHeight}
        />
      )}

      {/* ── Fixed Footer at Bottom of Screen ── */}
      <div className="task-pane-footer">
        <button
          type="button"
          className="new-card-btn"
          onClick={handleGlobalNewTask}
        >
          <Plus size={16} />
          <span>New Task</span>
        </button>
        <button
          type="button"
          className={`new-task-btn ai-assistant-footer-btn ${isAssistantOpen ? 'active' : ''}`}
          onClick={isAssistantOpen ? onCloseAssistant : onOpenDraftModal}
          title={isAssistantOpen ? 'Close Task Assistant' : 'Activate Task Assistant: Task mode or Architect mode'}
        >
          {isAssistantOpen ? <ChevronDown size={16} /> : <Sparkles size={16} />}
          <span>{isAssistantOpen ? 'Hide Assistant' : 'Task Assistant'}</span>
        </button>
      </div>
    </div>
  );
};
