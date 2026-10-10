import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
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
import Image from '@tiptap/extension-image';
import Typography from '@tiptap/extension-typography';
import { Markdown } from 'tiptap-markdown';
import { stripHeaderComments, parseSwimLaneMarkdown } from '../lib/parser';
import { storageManager } from '../lib/storageManager';
import { bridgeClient } from '../lib/bridgeClient';
import { HumanAiAssistantModal } from './HumanAiAssistantModal';
import { ArchivedTasksModal } from './ArchivedTasksModal';
import { BatchRunModal } from './BatchRunModal';
import { BetaFeature, useBeta } from '../context/BetaContext';
import { ScheduleTaskModal } from './ScheduleTaskModal';
import { getAutocompleteSuggestion } from '../lib/autocompleteService';

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
  Image as ImageIcon,
  Undo2,
  Redo2,
  Type,
  ChevronDown,
  Archive,
  Trash2,
  AlertTriangle,
  AlertCircle,
  X,
  Edit2,
  MoreHorizontal,
  CornerDownRight
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
      Enter: () => {
        // Allow default ProseMirror / StarterKit list behaviors:
        // - In regular paragraphs or headings, Enter creates a normal new line / paragraph.
        // - In list items, Enter creates a new list item; pressing Enter on an empty list item lifts out back to a regular paragraph.
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
              // Lift empty list item back into a paragraph, or remove if empty list
              if (editor.can().liftListItem('listItem')) {
                return editor.chain().focus().liftListItem('listItem').run();
              }
              const cardBeforePos = $from.before(depth);
              const cardAfterPos = $from.after(depth);
              const tr = state.tr;
              tr.delete(cardBeforePos, cardAfterPos);
              const targetPos = Math.max(0, Math.min(cardBeforePos, tr.doc.content.size));
              tr.setSelection(Selection.near(tr.doc.resolve(targetPos)));
              view.dispatch(tr);
              return true;
            }

            if (isTopLevelCard) {
              const cardStartPos = $from.start(depth);
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
      Delete: ({ editor }) => {
        const { state, view } = editor;
        const { selection } = state;
        const { $from, empty } = selection;

        if (!empty) return false;

        for (let depth = $from.depth; depth > 0; depth--) {
          const node = $from.node(depth);
          if (node.type.name === 'listItem') {
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
              const cardBeforePos = $from.before(depth);
              const cardAfterPos = $from.after(depth);
              const tr = state.tr;
              tr.delete(cardBeforePos, cardAfterPos);
              const targetPos = Math.max(0, Math.min(cardBeforePos, tr.doc.content.size));
              tr.setSelection(Selection.near(tr.doc.resolve(targetPos)));
              view.dispatch(tr);
              return true;
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
  selectedTaskId?: string | number | null;
  runningTaskIds?: (string | number)[];
  pendingHumanInputs?: Record<string | number, { prompt: HumanInputPrompt; resolve: (answer: string) => void }>;
  showStyles: boolean;
  onToggleStyles: () => void;
  onSelectTask?: (taskId: string | number) => void;
  onMarkdownChange: (laneId: string, newMarkdown: string) => void;
  onRenameSwimLane?: (laneId: string, newTitle: string) => void;
  onDeleteSwimLane?: (laneId: string) => void;
  onAddSwimLaneAfter?: (laneId: string) => void;
  onOpenArchivedTasks?: () => void;
  archivedTasksCount?: number;
  onArchiveTask?: (taskTitle: string) => void;
  assistantDrawerHeight: number;
  onEditorReady?: (laneId: string, editorInstance: any) => void;
  // Freeform text selection or task card handler to create AI task
  onCreateTaskFromSelection?: (selectedText: string, laneId: string, laneTitle: string, sourceTask?: TaskItemType) => void;
  onRunTasksSequence?: (tasks: TaskItemType[], laneId: string, laneTitle: string) => void;
  onRunTasksParallel?: (tasks: TaskItemType[], laneId: string, laneTitle: string) => void;
  onScheduleTask?: (taskId: string | number, scheduledIso: string, cronExpr?: string) => void;
  // Selected lane action drawer props
  isAssistantOpen?: boolean;
  onOpenAssistant?: () => void;
  onCloseAssistant?: () => void;
  project?: ProjectData | null;
  agentContextMarkdown?: string;
  aiConfig?: AIProviderConfig;
  mcpServers?: MCPServer[];
  onApplyAssistantResult?: (result: HumanAiAssistantResult, confirmedDeletions: boolean) => void;
  onAssistantHeightChange?: (height: number) => void;
  autocompleteSettings?: import('../types').AutocompleteSettings;
  onConfigureMcpTools?: (task: TaskItemType) => void;
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
  onToggleStyles,
  onSelectTask,
  onMarkdownChange,
  onRenameSwimLane,
  onDeleteSwimLane,
  onAddSwimLaneAfter,
  onOpenArchivedTasks,
  archivedTasksCount = 0,
  onArchiveTask,
  onCreateTaskFromSelection,
  onRunTasksSequence,
  onRunTasksParallel,
  onScheduleTask,
  assistantDrawerHeight,
  onEditorReady,
  isAssistantOpen = false,
  onOpenAssistant,
  onCloseAssistant,
  project,
  agentContextMarkdown = '',
  aiConfig,
  mcpServers = [],
  onApplyAssistantResult,
  onAssistantHeightChange,
  autocompleteSettings = { enabled: true, keybinding: 'Tab' },
  onConfigureMcpTools,
}) => {
  const onConfigureMcpToolsRef = useRef(onConfigureMcpTools);
  onConfigureMcpToolsRef.current = onConfigureMcpTools;

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

  const onCreateTaskFromSelectionRef = useRef(onCreateTaskFromSelection);
  onCreateTaskFromSelectionRef.current = onCreateTaskFromSelection;

  const { isBetaEnabled } = useBeta();
  const isBetaEnabledRef = useRef(isBetaEnabled);
  isBetaEnabledRef.current = isBetaEnabled;

  // Run-task menu modal state (batch sequence/parallel + schedule)
  const [batchModal, setBatchModal] = useState<{
    mode: 'sequence' | 'parallel';
    task: TaskItemType;
    remaining: TaskItemType[];
  } | null>(null);
  const [scheduleModalTask, setScheduleModalTask] = useState<TaskItemType | null>(null);
  const setBatchModalRef = useRef(setBatchModal);
  setBatchModalRef.current = setBatchModal;
  const setScheduleModalTaskRef = useRef(setScheduleModalTask);
  setScheduleModalTaskRef.current = setScheduleModalTask;

  // Freeform Text Selection Run Tooltip State
  const [selectionTooltip, setSelectionTooltip] = useState<{
    visible: boolean;
    text: string;
    x: number;
    y: number;
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Local parsed items for this swim lane (each gets unique lane-scoped IDs)
  const laneParsed = useMemo(() => parseSwimLaneMarkdown(lane), [lane]);
  const laneTasks = laneParsed.items;
  const laneTasksRef = useRef(laneTasks);
  laneTasksRef.current = laneTasks;

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
                  const targetId = targetTask ? targetTask.id : `${lane.id}_task_${itemIndex}`;
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
              let subtaskCounter = 0;

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
                  const cardTaskId = matchedTask ? matchedTask.id : `${lane.id}_task_${orderedItemCounter}`;

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
                    {
                      side: -1,
                      stopEvent: () => true,
                      key: `${lane.id}|pcb|${cardTaskId}|${isParentChecked}|${isCardRunning}|${isNeedsInput}`,
                    }
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
                        btn.innerHTML = `<svg class="collapse-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`;

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
                      { side: -1, stopEvent: () => true, key: `${lane.id}|chev|${cardKey}|${isCollapsed}` }
                    );
                    decorations.push(chevronWidget);
                  }

                  // 4. Add Top-Right Card Actions Widget (+ Subtask, Archive)
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


                      // Run Task button
                      const addBtn = document.createElement('button');
                      addBtn.className = 'card-action-btn card-add-task-btn card-add-subtask-btn';
                      addBtn.setAttribute('contenteditable', 'false');
                      addBtn.type = 'button';
                      addBtn.title = 'Run task...';
                      addBtn.setAttribute('aria-label', 'Run task...');
                      addBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 10 20 15 15 20"></polyline><path d="M4 4v7a4 4 0 0 0 4 4h12"></path></svg>`;

                      addBtn.addEventListener('mousedown', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      });

                      const runWrapper = document.createElement('div');
                      runWrapper.style.position = 'relative';
                      let runDropdownEl: HTMLElement | null = null;

                      const getTaskContextText = () => {
                        let taskContextText = '';
                        const currentTask = laneTasksRef.current[orderedItemCounter - 1] || matchedTask;
                        if (currentTask) {
                          taskContextText = currentTask.title;
                          if (currentTask.subtasks && currentTask.subtasks.length > 0) {
                            taskContextText += '\n' + currentTask.subtasks.map((st) => `- ${st.text}`).join('\n');
                          }
                        }
                        if (!taskContextText) {
                          const currentPos = typeof getPos === 'function' ? getPos() : null;
                          if (currentPos != null) {
                            const liveNode = view.state.doc.nodeAt(currentPos - 1);
                            if (liveNode) return liveNode.textContent.trim();
                          }
                          taskContextText = node.textContent.trim();
                        }
                        return taskContextText;
                      };

                      const closeRunMenu = () => {
                        if (runDropdownEl && runDropdownEl.parentNode) {
                          runDropdownEl.parentNode.removeChild(runDropdownEl);
                        }
                        runDropdownEl = null;
                        addBtn.classList.remove('active');
                        document.removeEventListener('mousedown', handleRunOutside);
                        document.removeEventListener('keydown', handleRunKey);
                      };
                      const handleRunOutside = (ev: MouseEvent) => {
                        if (runDropdownEl && !runWrapper.contains(ev.target as Node)) closeRunMenu();
                      };
                      const handleRunKey = (ev: KeyboardEvent) => {
                        if (ev.key === 'Escape') closeRunMenu();
                      };

                      addBtn.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();

                        if (runDropdownEl) {
                          closeRunMenu();
                          return;
                        }

                        addBtn.classList.add('active');
                        runDropdownEl = document.createElement('div');
                        runDropdownEl.className = 'card-dropdown-menu';
                        runDropdownEl.setAttribute('contenteditable', 'false');

                        const items: { label: string; tip: string; icon: string; action: () => void }[] = [
                          {
                            label: 'Single task',
                            tip: 'Run this task',
                            icon: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>`,
                            action: () => {
                              const text = getTaskContextText();
                              if (text && onCreateTaskFromSelectionRef.current) {
                                onCreateTaskFromSelectionRef.current(text, lane.id, lane.title, matchedTask);
                              }
                            },
                          },
                          ...(isBetaEnabledRef.current ? [
                            {
                              label: 'Tasks in sequence...',
                              tip: 'Run this and X number of following tasks in this list in order',
                              icon: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="10" y1="6" x2="21" y2="6"></line><line x1="10" y1="12" x2="21" y2="12"></line><line x1="10" y1="18" x2="21" y2="18"></line><path d="M4 6h1v4"></path><path d="M4 10h2"></path><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"></path></svg>`,
                              action: () => {
                                if (!matchedTask) return;
                                const idx = laneTasksRef.current.findIndex((t) => t.id === matchedTask.id);
                                setBatchModalRef.current({
                                  mode: 'sequence',
                                  task: matchedTask,
                                  remaining: idx >= 0 ? laneTasksRef.current.slice(idx + 1) : [],
                                });
                              },
                            },
                            {
                              label: 'Tasks in parallel...',
                              tip: 'Run this and X number of following tasks in this list at once',
                              icon: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="12" r="2.5"></circle><circle cx="18" cy="6" r="2"></circle><circle cx="18" cy="12" r="2"></circle><circle cx="18" cy="18" r="2"></circle><path d="M8.5 12h7.5"></path><path d="M8.5 11c3 0 5-3.5 7.5-4.5"></path><path d="M8.5 13c3 0 5 3.5 7.5 4.5"></path></svg>`,
                              action: () => {
                                if (!matchedTask) return;
                                const idx = laneTasksRef.current.findIndex((t) => t.id === matchedTask.id);
                                setBatchModalRef.current({
                                  mode: 'parallel',
                                  task: matchedTask,
                                  remaining: idx >= 0 ? laneTasksRef.current.slice(idx + 1) : [],
                                });
                              },
                            },
                          ] : []),
                          {
                            label: 'Schedule task...',
                            tip: 'Set this task to run on a schedule',
                            icon: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>`,
                            action: () => {
                              if (!matchedTask) return;
                              // Create the AI execution card first so it is visible in the AI workspace
                              const text = getTaskContextText();
                              if (text && onCreateTaskFromSelectionRef.current) {
                                onCreateTaskFromSelectionRef.current(text, lane.id, lane.title, matchedTask);
                              }
                              setScheduleModalTaskRef.current(matchedTask);
                            },
                          },
                        ];

                        for (const it of items) {
                          const btn = document.createElement('button');
                          btn.type = 'button';
                          btn.className = 'card-dropdown-item';
                          btn.title = it.tip;
                          btn.innerHTML = `${it.icon}<span>${it.label}</span>`;
                          btn.addEventListener('mousedown', (ev) => {
                            ev.preventDefault();
                            ev.stopPropagation();
                          });
                          btn.addEventListener('click', (ev) => {
                            ev.preventDefault();
                            ev.stopPropagation();
                            closeRunMenu();
                            it.action();
                          });
                          runDropdownEl.appendChild(btn);
                        }

                        runWrapper.appendChild(runDropdownEl);
                        setTimeout(() => {
                          document.addEventListener('mousedown', handleRunOutside);
                          document.addEventListener('keydown', handleRunKey);
                        }, 0);
                      });
                      runWrapper.appendChild(addBtn);

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
                              let liveTitle = '';
                              const currentPos = typeof getPos === 'function' ? getPos() : null;
                              if (currentPos != null) {
                                const liveNode = view.state.doc.nodeAt(currentPos - 1);
                                if (liveNode) {
                                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                  liveNode.forEach((child: any) => {
                                    if (!liveTitle && child.type.name !== 'bulletList' && child.type.name !== 'orderedList') {
                                      liveTitle = child.textContent?.trim() || '';
                                    }
                                  });
                                }
                              }
                              if (!liveTitle) liveTitle = firstBlockNode?.textContent?.trim() || '';
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
                      container.appendChild(runWrapper);
                      container.appendChild(menuWrapper);

                      return container;
                    },
                    {
                      side: 1,
                      stopEvent: () => true,
                      key: `${lane.id}|act|${cardKey}|${isCardRunning}`,
                    }
                  );
                  decorations.push(cardActionsWidget);

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
                      { side: -1, stopEvent: () => true, key: `${lane.id}|scb|${++subtaskCounter}|${isSubChecked}|${isHumanReviewSubtask}` }
                    );
                    decorations.push(subtaskCheckboxWidget);
                  }
                }
              });

              // Add inline decorations to hide backslash escaping before formatting characters
              const cursor = state.selection.from;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              doc.descendants((node: any, pos: number) => {
                if (node.isText && node.text && node.text.includes('\\')) {
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

  // Autocomplete ref tracking & ProseMirror extension
  const autocompleteSettingsRef = useRef(autocompleteSettings);
  autocompleteSettingsRef.current = autocompleteSettings;
  const aiConfigRef = useRef(aiConfig);
  aiConfigRef.current = aiConfig;
  const projectRef = useRef(project);
  projectRef.current = project;

  // Active ghost suggestion state
  const activeSuggestionRef = useRef<{
    pos: number;
    text: string;
    replacementRange: 'suffix' | 'line';
    fromPos: number;
    toPos: number;
  } | null>(null);

  const autocompleteTimerRef = useRef<any>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const lastKeyTypedTimeRef = useRef<number>(0);

  const clearAutocompleteTimers = () => {
    if (autocompleteTimerRef.current) clearTimeout(autocompleteTimerRef.current);
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  };

  const TaskAutocompleteExtension = Extension.create({
    name: `taskAutocomplete_${lane.id}`,
    addProseMirrorPlugins() {
      const autocompletePluginKey = new PluginKey(`taskAutocompletePlugin_${lane.id}`);
      return [
        new Plugin({
          key: autocompletePluginKey,
          props: {
            handleKeyDown(view, event) {
              const currentSettings = autocompleteSettingsRef.current;
              if (!currentSettings || !currentSettings.enabled) {
                return false;
              }

              const targetKey = currentSettings.keybinding || 'Tab';
              const suggestion = activeSuggestionRef.current;

              // Check if user hit the configured acceptance key (Tab, ArrowRight, or Enter)
              if (suggestion && suggestion.text && (event.key === targetKey)) {
                // Confirm cursor is right at the suggestion position
                const { from, empty } = view.state.selection;
                if (empty && from === suggestion.pos) {
                  event.preventDefault();
                  event.stopPropagation();

                  let tr = view.state.tr;
                  if (suggestion.replacementRange === 'line') {
                    // Replace the entire task/subtask line with the improved version
                    tr = tr.replaceWith(
                      suggestion.fromPos,
                      suggestion.toPos,
                      view.state.schema.text(suggestion.text)
                    );
                  } else {
                    // Suffix insertion at cursor pos
                    tr = tr.insertText(suggestion.text, suggestion.pos);
                  }

                  activeSuggestionRef.current = null;
                  view.dispatch(tr);
                  return true;
                }
              }

              // Any other key dismisses the current suggestion if it doesn't match
              if (event.key === 'Escape') {
                if (activeSuggestionRef.current) {
                  activeSuggestionRef.current = null;
                  view.dispatch(view.state.tr);
                  return true;
                }
              }

              return false;
            },
            decorations(state) {
              const suggestion = activeSuggestionRef.current;
              if (!suggestion || !suggestion.text) {
                return DecorationSet.empty;
              }

              // Verify suggestion is still within doc bounds
              if (suggestion.pos > state.doc.content.size) {
                return DecorationSet.empty;
              }

              const widget = Decoration.widget(
                suggestion.pos,
                () => {
                  const span = document.createElement('span');
                  span.className = 'ergo-autocomplete-ghost';
                  
                  // For whole-line rewrite vs suffix
                  const displayText = suggestion.replacementRange === 'line'
                    ? ` → ${suggestion.text}`
                    : suggestion.text;
                  span.textContent = displayText;

                  const badge = document.createElement('span');
                  badge.className = 'ergo-autocomplete-badge';
                  badge.textContent = autocompleteSettingsRef.current?.keybinding || 'Tab';
                  span.appendChild(badge);

                  return span;
                },
                { side: 1, key: 'autocomplete_ghost' }
              );

              return DecorationSet.create(state.doc, [widget]);
            },
          },
        }),
      ];
    },
  });

  const onMarkdownChangeRef = useRef(onMarkdownChange);
  onMarkdownChangeRef.current = onMarkdownChange;
  const markdownDebounceTimerRef = useRef<any>(null);
  const editorInstanceRef = useRef<any>(null);

  const flushMarkdownChange = useCallback(() => {
    if (markdownDebounceTimerRef.current) {
      clearTimeout(markdownDebounceTimerRef.current);
      markdownDebounceTimerRef.current = null;
    }
    const currentEd = editorInstanceRef.current;
    if (currentEd && !currentEd.isDestroyed) {
      const storage = (currentEd as unknown as WithMarkdownStorage).storage;
      const md = storage?.markdown?.getMarkdown();
      if (typeof md === 'string') {
        onMarkdownChangeRef.current(lane.id, md);
      }
    }
  }, [lane.id]);

  useEffect(() => {
    return () => {
      flushMarkdownChange();
    };
  }, [flushMarkdownChange]);

  const scheduleMarkdownChange = useCallback(() => {
    if (markdownDebounceTimerRef.current) {
      clearTimeout(markdownDebounceTimerRef.current);
    }
    // Debounce markdown serialization, AST parsing, and autosave until 800ms of user typing idle
    markdownDebounceTimerRef.current = setTimeout(() => {
      markdownDebounceTimerRef.current = null;
      const currentEd = editorInstanceRef.current;
      if (currentEd && !currentEd.isDestroyed) {
        const storage = (currentEd as unknown as WithMarkdownStorage).storage;
        const md = storage?.markdown?.getMarkdown();
        if (typeof md === 'string') {
          onMarkdownChangeRef.current(lane.id, md);
        }
      }
    }, 800);
  }, [lane.id]);

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
      Image.configure({
        inline: false,
        allowBase64: true,
        HTMLAttributes: {
          class: 'task-attached-image',
        },
      }),
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
      TaskAutocompleteExtension,
    ],
    content: stripHeaderComments(lane.markdown),
    editorProps: {
      attributes: {
        class: 'tiptap obsidian-editor',
        spellcheck: 'false',
      },
      handlePaste: (view, event) => {
        const items = event.clipboardData?.items;
        if (!items) return false;

        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item.type.startsWith('image/')) {
            const file = item.getAsFile();
            if (file) {
              event.preventDefault();
              const folderPath = project?.folderPath || 'projects/default-workspace';
              storageManager.saveMediaFile(folderPath, file).then((relPath) => {
                if (!view || view.isDestroyed) return;
                const src = relPath
                  ? bridgeClient.getApiUrl(`/api/media/${relPath}`)
                  : URL.createObjectURL(file); // fallback: blob URL (in-memory only)
                const { state, dispatch } = view;
                const imageNode = state.schema.nodes.image?.create({ src, alt: file.name || 'Pasted screenshot' });
                if (imageNode) {
                  const tr = state.tr.replaceSelectionWith(imageNode);
                  dispatch(tr);
                }
              }).catch(() => {
                // Fallback to base64 on any error
                const reader = new FileReader();
                reader.onload = (readerEvent) => {
                  const src = readerEvent.target?.result as string;
                  if (src && view && !view.isDestroyed) {
                    const { state, dispatch } = view;
                    const imageNode = state.schema.nodes.image?.create({ src, alt: file.name || 'Pasted screenshot' });
                    if (imageNode) {
                      const tr = state.tr.replaceSelectionWith(imageNode);
                      dispatch(tr);
                    }
                  }
                };
                reader.readAsDataURL(file);
              });
              return true;
            }
          }
        }
        return false;
      },
    },
    onFocus: () => {
      onActivate();
    },
    onUpdate: ({ editor: currentEditor }) => {
      editorInstanceRef.current = currentEditor;
      scheduleMarkdownChange();

      // ── Task Autocomplete Scheduling ──
      clearAutocompleteTimers();
      lastKeyTypedTimeRef.current = Date.now();

      // If autocomplete is globally disabled, skip
      if (!autocompleteSettingsRef.current?.enabled) {
        if (activeSuggestionRef.current) {
          activeSuggestionRef.current = null;
          currentEditor.view.dispatch(currentEditor.view.state.tr);
        }
        return;
      }

      // Check current cursor state & line
      const { state } = currentEditor;
      const { selection } = state;
      if (!selection.empty) {
        if (activeSuggestionRef.current) {
          activeSuggestionRef.current = null;
          currentEditor.view.dispatch(state.tr);
        }
        return;
      }

      const { $from } = selection;
      const parentNode = $from.parent;
      if (!parentNode || !parentNode.isTextblock) return;

      const lineText = parentNode.textContent;
      const offsetInLine = $from.parentOffset;
      const prefixText = lineText.slice(0, offsetInLine);

      // Determine if inside a top-level task or subtask
      let isSubtask = false;
      let parentTaskTitle: string | undefined = undefined;

      for (let depth = $from.depth; depth > 0; depth--) {
        const node = $from.node(depth);
        if (node.type.name === 'listItem') {
          const grandParent = depth >= 2 ? $from.node(depth - 2) : null;
          if (grandParent && grandParent.type.name === 'listItem') {
            isSubtask = true;
            // Get parent task text
            parentTaskTitle = grandParent.child(0)?.textContent?.trim();
          }
          break;
        }
      }

      // Autocomplete trigger strict lockdown:
      // 1. Task or subtask must NOT be empty.
      // 2. Cursor must be immediately preceded by a space character ' ' (user stopped typing on a space).
      // If user ends on a word, period, or anything other than ' ', autocomplete must NOT fire.
      const taskText = lineText.trim();
      const hasContent = taskText.length > 0;
      const isPrecededBySpace = prefixText.endsWith(' ');

      if (!hasContent || !isPrecededBySpace) {
        if (activeSuggestionRef.current) {
          activeSuggestionRef.current = null;
          currentEditor.view.dispatch(state.tr);
        }
        return;
      }

      const currentPos = $from.pos;
      const fromPos = $from.start();
      const toPos = $from.end();
      const suffixText = lineText.slice(offsetInLine);

      // Autocomplete debounce: fires when user stops typing for ~600ms on a space character
      autocompleteTimerRef.current = setTimeout(async () => {
        if (!currentEditor || currentEditor.isDestroyed) return;
        const { selection: sel } = currentEditor.state;
        if (sel.from !== currentPos) return;

        const controller = new AbortController();
        abortControllerRef.current = controller;

        try {
          const suggestion = await getAutocompleteSuggestion(
            {
              taskText: lineText,
              prefixText,
              suffixText,
              isSubtask,
              parentTaskTitle,
              projectId: projectRef.current?.id,
            },
            aiConfigRef.current,
            controller.signal
          );

          if (suggestion && !currentEditor.isDestroyed && currentEditor.state.selection.from === currentPos) {
            activeSuggestionRef.current = {
              pos: currentPos,
              text: suggestion.text,
              replacementRange: suggestion.replacementRange,
              fromPos,
              toPos,
            };
            currentEditor.view.dispatch(currentEditor.view.state.tr);
          }
        } catch (err) {
          console.warn('[Autocomplete] Completion error:', err);
        }
      }, 600);
    },
    onSelectionUpdate: ({ editor: currentEditor }) => {
      updateSelectionTooltip(currentEditor);

      // Autocomplete should not start if the user simply moved their cursor to another task
      if (activeSuggestionRef.current && currentEditor) {
        const { from } = currentEditor.state.selection;
        if (from !== activeSuggestionRef.current.pos) {
          activeSuggestionRef.current = null;
          currentEditor.view.dispatch(currentEditor.view.state.tr);
        }
      }
      clearAutocompleteTimers();

      if (onSelectTaskRef.current && currentEditor) {
        const { from } = currentEditor.state.selection;
        const itemIndex = getTaskIndexAtPos(currentEditor.state.doc, from);
        if (itemIndex !== null) {
          const targetTask = laneTasksRef.current[itemIndex - 1];
          const targetId = targetTask ? targetTask.id : `${lane.id}_task_${itemIndex}`;
          if (selectedTaskIdRef.current !== targetId) {
            onSelectTaskRef.current(targetId);
          }
        }
      }
    },
    onBlur: () => {
      flushMarkdownChange();
      clearAutocompleteTimers();
      if (activeSuggestionRef.current) {
        activeSuggestionRef.current = null;
      }
      setTimeout(() => {
        const activeEl = document.activeElement;
        if (!activeEl?.classList.contains('selection-run-tooltip') && !activeEl?.closest('.selection-run-tooltip')) {
          setSelectionTooltip(null);
        }
      }, 180);
    },
  });

  const updateSelectionTooltip = useCallback((currentEditor: any) => {
    if (!currentEditor || currentEditor.isDestroyed) {
      setSelectionTooltip(null);
      return;
    }
    const { from, to, empty } = currentEditor.state.selection;
    if (empty || from === to) {
      setSelectionTooltip(null);
      return;
    }

    const text = currentEditor.state.doc.textBetween(from, to, '\n').trim();
    if (!text) {
      setSelectionTooltip(null);
      return;
    }

    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (rect.width > 0 || rect.height > 0) {
        setSelectionTooltip({
          visible: true,
          text,
          x: rect.left + rect.width / 2,
          y: rect.bottom + 6,
        });
        return;
      }
    }

    try {
      const endCoords = currentEditor.view.coordsAtPos(to);
      const startCoords = currentEditor.view.coordsAtPos(from);
      setSelectionTooltip({
        visible: true,
        text,
        x: (startCoords.left + endCoords.right) / 2,
        y: Math.max(startCoords.bottom, endCoords.bottom) + 6,
      });
    } catch {
      setSelectionTooltip(null);
    }
  }, []);

  const handleRunSelection = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selectionTooltip?.text) return;

    const textToRun = selectionTooltip.text;
    setSelectionTooltip(null);

    if (editor) {
      const { to } = editor.state.selection;
      editor.commands.setTextSelection(to);
    }
    if (window.getSelection()) {
      window.getSelection()?.removeAllRanges();
    }

    onCreateTaskFromSelection?.(textToRun, lane.id, lane.title, undefined);
  }, [selectionTooltip, editor, onCreateTaskFromSelection, lane.id, lane.title]);

  useEffect(() => {
    const handleScrollOrResize = () => {
      if (editor && !editor.state.selection.empty) {
        updateSelectionTooltip(editor);
      } else {
        setSelectionTooltip(null);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectionTooltip(null);
      }
    };

    window.addEventListener('resize', handleScrollOrResize);
    window.addEventListener('scroll', handleScrollOrResize, true);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('resize', handleScrollOrResize);
      window.removeEventListener('scroll', handleScrollOrResize, true);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [editor, updateSelectionTooltip]);

  useEffect(() => {
    if (editor && onEditorReady) {
      onEditorReady(lane.id, editor);
    }
  }, [editor, lane.id, onEditorReady]);

  // Synchronize editor content when external lane.markdown changes
  useEffect(() => {
    if (editor) {
      const stripped = stripHeaderComments(lane.markdown);
      const storage = (editor as unknown as WithMarkdownStorage).storage;
      const currentMd = storage.markdown?.getMarkdown();
      if (currentMd !== stripped) {
        // If the editor is focused, check whether focus is actually inside the ProseMirror dom
        // When clicking dropdown action buttons (e.g. Archive Task), the editor may have had focus
        // but external state changes should win.
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

  const triggerImageUpload = useCallback(() => {
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  }, []);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !editor) return;

    const folderPath = project?.folderPath || 'projects/default-workspace';

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.type.startsWith('image/')) {
        const capturedEditor = editor;
        storageManager.saveMediaFile(folderPath, file).then((relPath) => {
          if (!capturedEditor || capturedEditor.isDestroyed) return;
          const src = relPath
            ? bridgeClient.getApiUrl(`/api/media/${relPath}`)
            : URL.createObjectURL(file);
          capturedEditor.chain().focus().setImage({ src, alt: file.name || 'Attached screenshot' }).run();
        }).catch(() => {
          // Fallback to base64
          const reader = new FileReader();
          reader.onload = (readerEvent) => {
            const src = readerEvent.target?.result as string;
            if (src && capturedEditor && !capturedEditor.isDestroyed) {
              capturedEditor.chain().focus().setImage({ src, alt: file.name || 'Attached screenshot' }).run();
            }
          };
          reader.readAsDataURL(file);
        });
      }
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [editor, project]);

  const laneDoneCount = laneTasks.filter((t) => t.isDone).length;

  return (
    <div
      className={`swimlane-column ${totalLanes > 1 ? 'is-multi-lane' : 'is-single-lane'} ${isActive ? 'is-active-lane' : ''}`}
      onClick={() => onActivate()}
      style={width ? { width, minWidth: '260px', flex: `0 0 ${width}` } : undefined}
    >
      {/* Column Header */}
      <div className="swimlane-column-header">
        <div className="swimlane-title-container">
          <FileText size={15} style={{ color: 'var(--accent-cyan)', flexShrink: 0 }} />
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
          <span className="swimlane-done-badge">
            {laneDoneCount}/{laneTasks.length} done
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
          {/* Styles Toolbar Toggle folded into lane header */}
          <button
            type="button"
            className={`swimlane-menu-btn ${showStyles ? 'active' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggleStyles();
            }}
            title={showStyles ? 'Hide formatting bar' : 'Show formatting bar'}
          >
            <Type size={14} />
          </button>

          {/* Lane Options Menu */}
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
                    onAddSwimLaneAfter?.(lane.id);
                  }}
                >
                  <Plus size={13} style={{ color: 'var(--accent-cyan)' }} />
                  <span>Create New Swim Lane</span>
                </button>

                <button
                  type="button"
                  className="swimlane-dropdown-item"
                  onClick={() => {
                    setIsMenuOpen(false);
                    onOpenArchivedTasks?.();
                  }}
                >
                  <Archive size={13} style={{ color: '#f59e0b' }} />
                  <span>Archived Tasks</span>
                  {archivedTasksCount > 0 && (
                    <span className="dropdown-item-badge" style={{ marginLeft: 'auto', fontSize: '0.7rem', padding: '0.05rem 0.35rem', borderRadius: '8px', background: 'rgba(245, 158, 11, 0.15)', border: '1px solid rgba(245, 158, 11, 0.35)', color: '#f59e0b', fontWeight: 600 }}>
                      {archivedTasksCount}
                    </span>
                  )}
                </button>

                <div className="swimlane-dropdown-divider" />

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

                {totalLanes > 1 && (
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
                )}
              </div>
            )}
          </div>
        </div>
      </div>

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
            <ToolbarBtn onClick={triggerImageUpload} title="Attach Image / Screenshot">
              <ImageIcon size={13} />
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
          paddingBottom: isActive ? `${(isAssistantOpen ? assistantDrawerHeight : 0) + 20}px` : '20px',
        }}
      >
        <EditorContent editor={editor} className="tiptap-editor-root" />
      </div>

      {/* ── Human AI Assistant Slide-up Bar / Drawer (rendered only within selected lane) ── */}
      {isActive && project && aiConfig && (
        <HumanAiAssistantModal
          isOpen={isAssistantOpen}
          onClose={onCloseAssistant || (() => { })}
          project={project}
          todoMarkdown={lane.markdown}
          agentContextMarkdown={agentContextMarkdown}
          aiConfig={aiConfig}
          mcpServers={mcpServers}
          onApplyAssistantResult={(result, confirmedDeletions) => {
            if (result.todoMarkdown) {
              onMarkdownChange(lane.id, result.todoMarkdown);
            }
            onApplyAssistantResult?.(result, confirmedDeletions);
          }}
          onHeightChange={onAssistantHeightChange}
        />
      )}

      {/* ── Action Buttons Footer at bottom of selected lane only (Gated behind Beta features toggle) ── */}
      {isActive && (
        <BetaFeature>
          <div className="swimlane-footer">
            <button
              type="button"
              className="new-card-btn"
              onClick={() => {
                if (editor) {
                  editor.commands.focus();
                  handleAddNewCard(editor);
                }
              }}
            >
              <Plus size={15} />
              <span>New Task</span>
            </button>
            <button
              type="button"
              className={`new-task-btn ai-assistant-footer-btn ${isAssistantOpen ? 'active' : ''}`}
              onClick={isAssistantOpen ? onCloseAssistant : onOpenAssistant}
              title={isAssistantOpen ? 'Close Task Assistant' : 'Activate Task Assistant: Task mode or Architect mode'}
            >
              {isAssistantOpen ? <ChevronDown size={15} /> : <Sparkles size={15} />}
              <span>{isAssistantOpen ? 'Hide Assistant' : 'Task Assistant'}</span>
            </button>
          </div>
        </BetaFeature>
      )}

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
                Are you sure you want to remove swim lane <strong>"{lane.title}"</strong>?
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

      {/* Hidden file input for uploading images/screenshots */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileChange}
        accept="image/*"
        multiple
        style={{ display: 'none' }}
      />

      {/* Freeform Selection "Run" & Style Controls Floating Tooltip */}
      {selectionTooltip && selectionTooltip.visible && typeof document !== 'undefined' && createPortal(
        <div
          className="selection-run-tooltip"
          style={{
            top: `${selectionTooltip.y}px`,
            left: `${selectionTooltip.x}px`,
          }}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          {/* Add Task Action */}
          <button
            type="button"
            className="selection-tooltip-run-btn"
            onClick={handleRunSelection}
            title="Add as task to AI Workspace"
          >
            <CornerDownRight size={12} strokeWidth={2.5} />
            <span>Add Task</span>
          </button>

          <div className="selection-tooltip-divider" />

          {/* Bold */}
          <button
            type="button"
            className={`selection-tooltip-btn ${editor?.isActive('bold') ? 'is-active' : ''}`}
            onClick={() => editor?.chain().focus().toggleBold().run()}
            title="Bold (**text**)"
          >
            <Bold size={13} />
          </button>

          {/* Italic */}
          <button
            type="button"
            className={`selection-tooltip-btn ${editor?.isActive('italic') ? 'is-active' : ''}`}
            onClick={() => editor?.chain().focus().toggleItalic().run()}
            title="Italic (*text*)"
          >
            <Italic size={13} />
          </button>

          {/* Strikethrough */}
          <button
            type="button"
            className={`selection-tooltip-btn ${editor?.isActive('strike') ? 'is-active' : ''}`}
            onClick={() => editor?.chain().focus().toggleStrike().run()}
            title="Strikethrough (~~text~~)"
          >
            <Strikethrough size={13} />
          </button>

          {/* Inline Code */}
          <button
            type="button"
            className={`selection-tooltip-btn ${editor?.isActive('code') ? 'is-active' : ''}`}
            onClick={() => editor?.chain().focus().toggleCode().run()}
            title="Inline Code (`code`)"
          >
            <Code size={13} />
          </button>

          {/* Link */}
          <button
            type="button"
            className={`selection-tooltip-btn ${editor?.isActive('link') ? 'is-active' : ''}`}
            onClick={setLink}
            title="Link ([text](url))"
          >
            <LinkIcon size={13} />
          </button>

          {/* Photo / Screenshot */}
          <button
            type="button"
            className="selection-tooltip-btn"
            onClick={triggerImageUpload}
            title="Attach Image / Screenshot"
          >
            <ImageIcon size={13} />
          </button>

          {/* Subtask (Bullet) */}
          <button
            type="button"
            className={`selection-tooltip-btn ${editor?.isActive('bulletList') ? 'is-active' : ''}`}
            onClick={() => editor?.chain().focus().toggleBulletList().run()}
            title="Subtask / Bullet List (- item)"
          >
            <List size={13} />
          </button>
        </div>,
        document.body
      )}

      {batchModal && (
        <BatchRunModal
          key={`${batchModal.mode}_${batchModal.task.id}`}
          isOpen
          mode={batchModal.mode}
          startTask={batchModal.task}
          remainingTasks={batchModal.remaining}
          onClose={() => setBatchModal(null)}
          onConfirm={(selected, mode) => {
            if (mode === 'sequence') onRunTasksSequence?.(selected, lane.id, lane.title);
            else onRunTasksParallel?.(selected, lane.id, lane.title);
          }}
        />
      )}
      {scheduleModalTask && (
        <ScheduleTaskModal
          isOpen
          task={scheduleModalTask}
          onClose={() => setScheduleModalTask(null)}
          onSchedule={(taskId, iso, cron) => {
            onScheduleTask?.(taskId, iso, cron);
            setScheduleModalTask(null);
          }}
        />
      )}
    </div>
  );
};

// ─── Main TaskPane Component ──────────────────────────────────────────────────
interface TaskPaneProps {
  rawMarkdown: string;
  tasks: TaskItemType[];
  archivedTasks?: TaskItemType[];
  selectedTaskId?: string | number | null;
  runningTaskIds?: (string | number)[];
  pendingHumanInputs?: Record<string | number, { prompt: HumanInputPrompt; resolve: (answer: string) => void }>;
  onSelectTask?: (taskId: string | number) => void;
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
  onUnarchiveTask?: (taskId: string | number) => void;
  onDeleteArchivedTask?: (taskId: string | number) => void;
  onRestoreMemoryAsTask?: (chunk: import('../lib/memory').MemoryChunk) => void;
  swimLanes?: SwimLaneDoc[];
  onAddSwimLane?: (afterLaneId?: string) => void;
  onRenameSwimLane?: (laneId: string, newTitle: string) => void;
  onDeleteSwimLane?: (laneId: string) => void;
  onSwimLaneMarkdownChange?: (laneId: string, newMarkdown: string) => void;
  onCreateTaskFromSelection?: (selectedText: string, laneId: string, laneTitle: string, sourceTask?: TaskItemType) => void;
  onRunTasksSequence?: (tasks: TaskItemType[], laneId: string, laneTitle: string) => void;
  onRunTasksParallel?: (tasks: TaskItemType[], laneId: string, laneTitle: string) => void;
  onScheduleTask?: (taskId: string | number, scheduledIso: string, cronExpr?: string) => void;
  autocompleteSettings?: import('../types').AutocompleteSettings;
  onUpdateTaskMcpTools?: (taskId: string | number, toolNames: string[]) => void;
}

export const TaskPane: React.FC<TaskPaneProps> = ({
  rawMarkdown,
  tasks: _tasks,
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
  onRestoreMemoryAsTask,
  swimLanes,
  onAddSwimLane,
  onRenameSwimLane,
  onDeleteSwimLane,
  onSwimLaneMarkdownChange,
  onCreateTaskFromSelection,
  onRunTasksSequence,
  onRunTasksParallel,
  onScheduleTask,
  autocompleteSettings = { enabled: true, keybinding: 'Tab' },
  onUpdateTaskMcpTools: _onUpdateTaskMcpTools,
}) => {
  const [showStyles, setShowStyles] = useState(false);
  const [assistantDrawerHeight, setAssistantDrawerHeight] = useState<number>(0);
  const [isHeaderMenuOpen, setIsHeaderMenuOpen] = useState(false);
  const [isArchiveModalOpen, setIsArchiveModalOpen] = useState(false);
  const headerMenuRef = useRef<HTMLDivElement>(null);

  // Close workspace header dropdown on outside click or Escape
  useEffect(() => {
    if (!isHeaderMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (headerMenuRef.current && !headerMenuRef.current.contains(e.target as Node)) {
        setIsHeaderMenuOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsHeaderMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isHeaderMenuOpen]);

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

  return (
    <div className="pane pane-left obsidian-pane">


      {/* ── Swim Lanes Container ── */}
      <div className={`swimlanes-wrapper ${effectiveSwimLanes.length > 1 ? 'is-multi-column' : 'is-single-column'}`}>
        {effectiveSwimLanes.map((lane) => (
          <React.Fragment key={lane.id}>
            <SwimLaneColumn
              lane={lane}
              totalLanes={effectiveSwimLanes.length}
              width={laneWidths[lane.id] ? `${laneWidths[lane.id]}px` : (effectiveSwimLanes.length > 1 ? 'calc(100vw / 3)' : undefined)}
              isActive={lane.id === activeSwimLaneId}
              onActivate={() => setActiveSwimLaneId(lane.id)}
              selectedTaskId={selectedTaskId}
              runningTaskIds={runningTaskIds}
              pendingHumanInputs={pendingHumanInputs}
              showStyles={showStyles}
              onToggleStyles={() => setShowStyles((prev) => !prev)}
              onSelectTask={onSelectTask}
              onMarkdownChange={handleLaneMarkdownChange}
              onRenameSwimLane={onRenameSwimLane}
              onDeleteSwimLane={onDeleteSwimLane}
              onAddSwimLaneAfter={(laneId) => onAddSwimLane?.(laneId)}
              onOpenArchivedTasks={() => setIsArchiveModalOpen(true)}
              archivedTasksCount={archivedTasks.length}
              onArchiveTask={onArchiveTask}
              onCreateTaskFromSelection={onCreateTaskFromSelection}
              onRunTasksSequence={onRunTasksSequence}
              onRunTasksParallel={onRunTasksParallel}
              onScheduleTask={onScheduleTask}
              assistantDrawerHeight={assistantDrawerHeight}
              onEditorReady={handleEditorReady}
              isAssistantOpen={isAssistantOpen}
              onOpenAssistant={onOpenDraftModal}
              onCloseAssistant={onCloseAssistant}
              project={project}
              agentContextMarkdown={agentContextMarkdown}
              aiConfig={aiConfig}
              mcpServers={mcpServers}
              onApplyAssistantResult={onApplyAssistantResult}
              onAssistantHeightChange={setAssistantDrawerHeight}
              autocompleteSettings={autocompleteSettings}
            />
            {/* Resizer & grab bar divider at the right edge of swim lane */}
            <div
              className={`swimlane-resizer-handle ${resizingRef.current?.laneId === lane.id ? 'is-active' : ''}`}
              onMouseDown={(e) => handleStartResize(e, lane.id)}
              title="Drag to resize swim lane width"
            >
              <div className="swimlane-resizer-line" />
            </div>
          </React.Fragment>
        ))}
      </div>

      {/* ── Archived Tasks & AI Brain Modal Window ── */}
      <ArchivedTasksModal
        isOpen={isArchiveModalOpen}
        onClose={() => setIsArchiveModalOpen(false)}
        projectId={project?.id}
        projectName={project?.name}
        archivedTasks={archivedTasks}
        swimLanes={effectiveSwimLanes}
        onUnarchiveTask={onUnarchiveTask}
        onDeleteArchivedTask={onDeleteArchivedTask}
        onRestoreMemoryAsTask={onRestoreMemoryAsTask}
      />

    </div>
  );
};
