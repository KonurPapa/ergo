import React, { useState, useCallback, useEffect } from 'react';
import { type TaskItem as TaskItemType } from '../types';
import { useEditor, EditorContent } from '@tiptap/react';
import ListItem from '@tiptap/extension-list-item';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Link from '@tiptap/extension-link';
import Typography from '@tiptap/extension-typography';
import { Markdown } from 'tiptap-markdown';
import { stripHeaderComments } from '../lib/parser';

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
} from 'lucide-react';

interface WithMarkdownStorage {
  storage: {
    markdown: {
      getMarkdown: () => string;
    };
  };
}

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

  // Read the LIVE listItem node from the current doc
  const liveNode = doc.nodeAt(listItemPos);
  if (!liveNode || liveNode.type.name !== 'listItem') return;

  // Scan children: find where content blocks end and if a bulletList already exists
  let insertAfterContent = listItemPos + 1;
  let existingBulletEnd: number | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  liveNode.forEach((child: any, offset: number) => {
    if (child.type.name !== 'bulletList' && child.type.name !== 'orderedList') {
      insertAfterContent = listItemPos + 1 + offset + child.nodeSize;
    }
    if (child.type.name === 'bulletList') {
      // Position just before the bulletList closing tag — insert new items here
      existingBulletEnd = listItemPos + 1 + offset + child.nodeSize - 1;
    }
  });

  const tr = editorInstance.state.tr;
  let focusPos: number;

  if (existingBulletEnd !== null) {
    // Append another bullet item to the existing nested list
    const newItem = listItem.create(null, paragraph.create(null));
    tr.insert(existingBulletEnd, newItem);
    focusPos = existingBulletEnd + 2;
  } else {
    // Create a fresh bulletList with one empty item, placed right after the content block
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
// (i.e. direct child of an orderedList or bulletList, and not nested inside any other listItem)
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

// Helper: compute 1-based top-level card index from document position
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

// Extension: Auto-join directly adjacent ordered lists and bullet lists (preserving intervening paragraphs)
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

// Extension: H1 → ordered list on Enter; Enter on blank card → exit to generic text editor; Shift+Enter inside card → add subtask; Backspace on empty card → clean delete
const AutoCardListExtension = Extension.create({
  name: 'autoCardList',
  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        // 1. If at the end of top-level H1 (outside list items), Enter creates an ordered list
        if (editor.isActive('heading', { level: 1 }) && !editor.isActive('listItem')) {
          const { $from } = editor.state.selection;
          if ($from.parentOffset === $from.parent.content.size) {
            const res = editor.chain().splitBlock().toggleOrderedList().unsetMark('strike').run();
            editor.view.dispatch(editor.state.tr.setStoredMarks([]));
            return res;
          }
        }

        // 2. If inside a top-level blank card, Enter exits to generic text editor mode
        const { state } = editor;
        const { selection } = state;
        const { $from, empty } = selection;

        if (empty) {
          for (let depth = $from.depth; depth > 0; depth--) {
            const node = $from.node(depth);
            if (node.type.name === 'listItem') {
              const parent = $from.node(depth - 1);
              const isTopLevelCard =
                (parent.type.name === 'orderedList' || parent.type.name === 'bulletList') &&
                (depth < 2 || $from.node(depth - 2)?.type.name !== 'listItem');

              if (isTopLevelCard) {
                // Check if card is empty (blank task)
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
                  // Exit the task list and switch to generic text editor mode (outside of cards)
                  return editor.chain().focus().liftListItem('listItem').run();
                }
              }
              break;
            }
          }
        }

        // 3. If inside a blockquote inside a listItem, allow empty block to lift out of blockquote
        if (editor.isActive('blockquote')) {
          if ($from.parent.textContent.trim() === '') {
            return false;
          }
        }

        // 4. If inside a listItem (card or subtask), split and always clear strike marks from the new item
        if (editor.isActive('listItem')) {
          const wasHeading = editor.isActive('heading');
          const res = editor.chain().splitListItem('listItem').unsetMark('strike').run();
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
        // 1. When inside an existing non-blank top-level task (ordered or bullet), Tab adds a subtask
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
                // Check if card has content (not blank)
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

        // 2. When typing a plain text line outside a list, Tab elevates the line into a task item
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
        // When inside a top-level task card, Shift+Enter adds a subtask bullet
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

              // Check if card is empty
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
                // Directly delete the listItem to prevent liftListItem splitting the list into orphans
                const tr = state.tr;
                tr.delete(cardBeforePos, cardAfterPos);
                const targetPos = Math.max(1, Math.min(cardBeforePos, tr.doc.content.size - 1));
                tr.setSelection(Selection.near(tr.doc.resolve(targetPos)));
                view.dispatch(tr);
                return true;
              }

              // At start of non-empty card: avoid liftListItem splitting list
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

interface TaskPaneProps {
  rawMarkdown: string;
  tasks: TaskItemType[];
  selectedTaskId?: number | null;
  runningTaskIds?: number[];
  onSelectTask?: (taskId: number) => void;
  onMarkdownChange: (newMarkdown: string) => void;
  onOpenDraftModal: () => void;
}

// Module-level persistent Set to remember collapsed cards across re-renders
const collapsedCardsState = new Set<string>();

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

// ── Toolbar separator ───────────────────────────────────────────
const Sep = () => <div className="tiptap-toolbar-sep" />;

// ── Main component ──────────────────────────────────────────────
export const TaskPane: React.FC<TaskPaneProps> = ({
  rawMarkdown,
  tasks,
  selectedTaskId,
  runningTaskIds = [],
  onSelectTask,
  onMarkdownChange,
  onOpenDraftModal,
}) => {
  const selectedTaskIdRef = React.useRef(selectedTaskId);
  selectedTaskIdRef.current = selectedTaskId;

  const runningTaskIdsRef = React.useRef(runningTaskIds);
  runningTaskIdsRef.current = runningTaskIds;

  const tasksRef = React.useRef(tasks);
  tasksRef.current = tasks;

  const onSelectTaskRef = React.useRef(onSelectTask);
  onSelectTaskRef.current = onSelectTask;

  // ProseMirror decoration extension for UI Checkboxes, Add Subtask, and Active Card highlighting
  const TaskCheckboxDecorationExtension = Extension.create({
    name: 'taskCheckboxDecoration',
    addProseMirrorPlugins() {
      const editor = this.editor;
      return [
        new Plugin({
          key: new PluginKey('taskCheckboxDecorationPlugin'),
          appendTransaction(_transactions, _oldState, newState) {
            const { selection, storedMarks, schema } = newState;
            const strikeMark = schema.marks.strike;
            if (!strikeMark) return null;

            if (storedMarks && storedMarks.some((m) => m.type === strikeMark)) {
              const { $from, empty } = selection;
              if (empty && $from.parent.content.size === 0) {
                for (let d = $from.depth; d > 0; d--) {
                  if ($from.node(d).type.name === 'listItem') {
                    const tr = newState.tr;
                    tr.setStoredMarks(storedMarks.filter((m) => m.type !== strikeMark));
                    return tr;
                  }
                }
              }
            }
            return null;
          },
          props: {
            handleClick(view, pos) {
              if (onSelectTaskRef.current) {
                const itemIndex = getTaskIndexAtPos(view.state.doc, pos);
                if (itemIndex !== null) {
                  const targetTask = tasksRef.current[itemIndex - 1];
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
              const currentTasks = tasksRef.current;
              if (!strikeMarkType) return DecorationSet.empty;

              let globalCardIndex = 0;
              let sectionCardIndex = 0;

              // Track sections to reset sectionCardIndex per heading / hr
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              doc.descendants((node: any, pos: number) => {
                if (node.type.name === 'heading' || node.type.name === 'horizontalRule') {
                  const resolved = doc.resolve(pos);
                  if (resolved.depth === 0 || (resolved.depth === 1 && resolved.parent.type.name === 'doc')) {
                    sectionCardIndex = 0;
                  }
                }

                if (node.type.name !== 'listItem') return;

                const isTopLevelCard = isTopLevelListItemNode(doc, pos);

                if (isTopLevelCard) {
                  const resolved = doc.resolve(pos);
                  const parent = resolved.parent;
                  globalCardIndex++;
                  sectionCardIndex++;
                  const isUnordered = parent.type.name === 'bulletList';
                  const cardTaskId = currentTasks[globalCardIndex - 1]?.id || globalCardIndex;
                  const isSelected = currentSelectedTaskId === cardTaskId;
                  const isRunning = currentRunningTaskIds.includes(cardTaskId);

                  // Find primary content block in this card (parent task title)
                  let firstBlockPos: number | null = null;
                  let firstBlockNode: any = null;

                  let hasSubtasks = false;
                  node.forEach((child: any, offset: number) => {
                    const childPos = pos + 1 + offset;
                    if (child.type.name !== 'bulletList' && child.type.name !== 'orderedList') {
                      if (firstBlockPos === null) {
                        firstBlockPos = childPos;
                        firstBlockNode = child;
                      }
                    } else if (child.childCount > 0) {
                      hasSubtasks = true;
                    }
                  });

                  const isParentChecked = firstBlockNode ? isNodeChecked(firstBlockNode) : false;

                  // Set of collapsed card keys (using node content or position key)
                  const cardKey = `card-${pos}-${firstBlockNode?.textContent?.slice(0, 30) || ''}`;
                  const isCollapsed = hasSubtasks && collapsedCardsState.has(cardKey);

                  // 1. Add active-card, card-running, card-done, card-collapsed, and digit-count class decoration
                  const numDigits = String(sectionCardIndex).length;
                  const cardClasses = [
                    isSelected ? 'is-active-card' : '',
                    isRunning ? 'is-card-running' : '',
                    isParentChecked ? 'is-card-done' : '',
                    isCollapsed ? 'card-collapsed' : '',
                    isUnordered ? 'card-unordered' : `card-digits-${numDigits}`,
                  ]
                    .filter(Boolean)
                    .join(' ');

                  decorations.push(
                    Decoration.node(pos, pos + node.nodeSize, {
                      class: cardClasses,
                      style: isUnordered ? undefined : `--card-digits: ${numDigits};`,
                    })
                  );

                  // 2. Add Parent Task Checkbox Widget at pos + 1
                  const parentCheckboxWidget = Decoration.widget(
                    pos + 1,
                    (view, getPos) => {
                      const container = document.createElement('div');
                      container.className = `task-card-checkbox-wrapper ${isParentChecked ? 'is-checked' : ''} ${isRunning ? 'is-running' : ''}`;
                      container.setAttribute('contenteditable', 'false');
                      container.title = isParentChecked ? 'Mark task as incomplete' : 'Mark task as completed';

                      const checkbox = document.createElement('button');
                      checkbox.type = 'button';
                      checkbox.className = `task-ui-checkbox parent-checkbox ${isParentChecked ? 'checked' : ''} ${isRunning ? 'running' : ''}`;
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

                        liveNode.forEach((child: any, offset: number) => {
                          const childPos: number = listItemPos + 1 + offset;
                          if (child.type.name !== 'bulletList' && child.type.name !== 'orderedList') {
                            if (liveFirstBlockPos === null) {
                              liveFirstBlockPos = childPos;
                              liveFirstBlockNode = child;
                            }
                          } else if (child.type.name === 'bulletList' || child.type.name === 'orderedList') {
                            child.forEach((nestedItem: any, nestedOffset: number) => {
                              const nestedItemPos: number = childPos + 1 + nestedOffset;
                              if (nestedItem.type.name === 'listItem') {
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
                          // Strikethrough parent task
                          tr.addMark(fromPos, toPos, strikeMarkType.create());
                          // Cascade: check and strikethrough all children subtasks
                          liveSubtaskBlocks.forEach((sp) => {
                            const spFrom: number = Number(sp.pos);
                            const spTo: number = spFrom + Number(sp.node.nodeSize);
                            tr.addMark(spFrom, spTo, strikeMarkType.create());
                          });
                        } else {
                          // Uncheck parent task
                          tr.removeMark(fromPos, toPos, strikeMarkType);
                          // Cascade: uncheck and remove strikethrough from all children subtasks
                          liveSubtaskBlocks.forEach((sp) => {
                            const spFrom: number = Number(sp.pos);
                            const spTo: number = spFrom + Number(sp.node.nodeSize);
                            tr.removeMark(spFrom, spTo, strikeMarkType);
                          });
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

                  // 3. Add Collapse / Expand Toggle Button Widget at pos + 1 (left side beside item number)
                  // Only show collapse/expand chevron if the card has subtask items
                  if (hasSubtasks) {
                    const collapseWidget = Decoration.widget(
                      pos + 1,
                      (view) => {
                        const collapseBtn = document.createElement('button');
                        collapseBtn.className = `card-collapse-btn ${isCollapsed ? 'is-collapsed' : ''}`;
                        collapseBtn.setAttribute('contenteditable', 'false');
                        collapseBtn.type = 'button';
                        collapseBtn.title = isCollapsed ? 'Expand card' : 'Collapse card';
                        collapseBtn.setAttribute('aria-label', isCollapsed ? 'Expand card' : 'Collapse card');
                        collapseBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="collapse-chevron"><polyline points="6 9 12 15 18 9"></polyline></svg>`;

                        collapseBtn.addEventListener('mousedown', (e) => {
                          e.preventDefault();
                          e.stopPropagation();
                        });

                        collapseBtn.addEventListener('click', (e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (collapsedCardsState.has(cardKey)) {
                            collapsedCardsState.delete(cardKey);
                          } else {
                            collapsedCardsState.add(cardKey);
                          }
                          const tr = view.state.tr.setMeta('cardCollapseToggle', true);
                          view.dispatch(tr);
                        });

                        return collapseBtn;
                      },
                      { side: -1, stopEvent: () => true }
                    );
                    decorations.push(collapseWidget);
                  }

                  // 4. Add Card Action Buttons Widget (Add Subtask + Delete Task) at pos + 1 (right side)
                  // Only show 'add subtask' and 'delete' buttons on the currently-selected card
                  if (isSelected || isRunning) {
                    const cardActionsWidget = Decoration.widget(
                      pos + 1,
                      (view, getPos) => {
                        const container = document.createElement('div');
                        container.className = 'card-actions-wrapper';
                        container.setAttribute('contenteditable', 'false');

                        // Running live pill indicator
                        if (isRunning) {
                          const runningBadge = document.createElement('span');
                          runningBadge.className = 'task-running-badge-pill';
                          runningBadge.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="spin-animate"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg><span>Working</span>`;
                          container.appendChild(runningBadge);
                        }

                        // Add subtask & delete card buttons (only on selected card)
                        if (isSelected) {
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
                            // Auto-expand if collapsed when adding a subtask
                            if (collapsedCardsState.has(cardKey)) {
                              collapsedCardsState.delete(cardKey);
                            }
                            const widgetPos = typeof getPos === 'function' ? getPos() : pos + 1;
                            if (widgetPos == null) return;
                            const listItemPos = Number(widgetPos) - 1;
                            insertSubtaskAtCardPos(editor, listItemPos);
                            if (onSelectTaskRef.current) {
                              onSelectTaskRef.current(cardTaskId);
                            }
                          });

                          // Delete task card button
                          const deleteBtn = document.createElement('button');
                          deleteBtn.className = 'card-action-btn card-delete-task-btn';
                          deleteBtn.setAttribute('contenteditable', 'false');
                          deleteBtn.type = 'button';
                          deleteBtn.title = 'Delete task';
                          deleteBtn.setAttribute('aria-label', 'Delete task');
                          deleteBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>`;

                          deleteBtn.addEventListener('mousedown', (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                          });

                          deleteBtn.addEventListener('click', (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            collapsedCardsState.delete(cardKey);
                            const widgetPos = typeof getPos === 'function' ? getPos() : pos + 1;
                            if (widgetPos == null) return;
                            const listItemPos = Number(widgetPos) - 1;

                            const liveDoc = view.state.doc;
                            const liveNode = liveDoc.nodeAt(listItemPos);
                            if (!liveNode || liveNode.type.name !== 'listItem') return;

                            const tr = view.state.tr;
                            tr.delete(listItemPos, listItemPos + liveNode.nodeSize);
                            view.dispatch(tr);
                            view.focus();
                          });

                          container.appendChild(addBtn);
                          container.appendChild(deleteBtn);
                        }

                        return container;
                      },
                      { side: 1, stopEvent: () => true }
                    );
                    decorations.push(cardActionsWidget);
                  }

                } else {
                  // Subtask list item (nested under a card or bullet list item)
                  let subBlockPos: number | null = null;
                  let subBlockNode: any = null;

                  node.forEach((child: any, offset: number) => {
                    if (child.type.name !== 'bulletList' && child.type.name !== 'orderedList' && subBlockPos === null) {
                      subBlockPos = pos + 1 + offset;
                      subBlockNode = child;
                    }
                  });

                  if (subBlockNode && subBlockPos !== null) {
                    const isSubChecked = isNodeChecked(subBlockNode);

                    const subtaskCheckboxWidget = Decoration.widget(
                      pos + 1,
                      (view, getPos) => {
                        const container = document.createElement('span');
                        container.className = `subtask-checkbox-wrapper ${isSubChecked ? 'is-checked' : ''}`;
                        container.setAttribute('contenteditable', 'false');
                        container.title = isSubChecked ? 'Mark subtask as incomplete' : 'Mark subtask as completed';

                        const checkbox = document.createElement('button');
                        checkbox.type = 'button';
                        checkbox.className = `task-ui-checkbox subtask-checkbox ${isSubChecked ? 'checked' : ''}`;
                        checkbox.setAttribute('aria-checked', String(isSubChecked));
                        checkbox.setAttribute('role', 'checkbox');
                        checkbox.setAttribute('aria-label', isSubChecked ? 'Completed subtask' : 'Incomplete subtask');

                        if (isSubChecked) {
                          checkbox.innerHTML = `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
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

              // Add inline decorations to hide backslash escaping before formatting characters when not directly adjacent to the cursor
              const cursor = state.selection.from;
              doc.descendants((node: any, pos: number) => {
                if (node.isText && node.text) {
                  const text = node.text;
                  const escapeRegex = /\\([*~_`#\[\]()>+\-.!])/g;
                  let match: RegExpExecArray | null;
                  while ((match = escapeRegex.exec(text)) !== null) {
                    const slashPos = pos + match.index;
                    // If cursor is not immediately touching the backslash, hide it
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
    name: 'autoSurround',
    addProseMirrorPlugins() {
      const editorInstance = this.editor;
      return [
        new Plugin({
          key: new PluginKey('autoSurround'),
          props: {
            handleTextInput(view, from, to, text) {
              if (from === to) return false;
              const { state } = view;
              const { selection } = state;
              if (selection.empty) return false;

              // Format marks directly so they render visually and serialize cleanly to markdown without backslash escaping
              if (text === '`') {
                editorInstance.chain().focus().toggleCode().run();
                return true;
              }

              if (text === '*' || text === '_') {
                if (editorInstance.isActive('italic') && !editorInstance.isActive('bold')) {
                  // Move from italic to bold (*text* -> **text**)
                  editorInstance.chain().focus().toggleItalic().toggleBold().run();
                } else if (editorInstance.isActive('bold') && !editorInstance.isActive('italic')) {
                  // Add italic for bold + italic (***text***)
                  editorInstance.chain().focus().toggleItalic().run();
                } else {
                  // Default: apply italic
                  editorInstance.chain().focus().toggleItalic().run();
                }
                return true;
              }

              if (text === '~') {
                editorInstance.chain().focus().toggleStrike().run();
                return true;
              }

              // For punctuation, quotes, brackets: wrap the text
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
        listItem: false,
        heading: { levels: [1, 2, 3, 4] },
        code: {},
        codeBlock: {},
        blockquote: {},
        horizontalRule: {},
      }),
      CustomListItem,
      Placeholder.configure({
        placeholder: '# My Task List\n\nStart typing in markdown — **bold**, *italic*, `code`, headings, lists…',
      }),
      Link.configure({ openOnClick: false }),
      Typography,
      AutoCardListExtension,
      AutoJoinListsExtension,
      TaskCheckboxDecorationExtension,
      AutoSurroundExtension,
      Markdown.configure({
        html: false,
        transformPastedText: true,
        transformCopiedText: true,
      }),
    ],
    content: stripHeaderComments(rawMarkdown),
    autofocus: false,
    onSelectionUpdate({ editor }) {
      if (!editor.isFocused) return;
      if (!onSelectTaskRef.current) return;
      const pos = editor.state.selection.from;
      const itemIndex = getTaskIndexAtPos(editor.state.doc, pos);
      if (itemIndex !== null) {
        const targetTask = tasksRef.current[itemIndex - 1];
        const targetId = targetTask ? targetTask.id : itemIndex;
        if (selectedTaskIdRef.current !== targetId) {
          onSelectTaskRef.current(targetId);
        }
      }
    },
    onUpdate({ editor }) {
      // Serialize back to markdown on every change
      const md = (editor as unknown as WithMarkdownStorage).storage.markdown.getMarkdown();
      onMarkdownChange(md);
    },
  });

  // Sync content if the project changes externally
  useEffect(() => {
    if (!editor) return;
    const cleanRaw = stripHeaderComments(rawMarkdown);
    const current = (editor as unknown as WithMarkdownStorage).storage.markdown.getMarkdown();
    // Only reset if content meaningfully diverges (avoids caret jump on every keystroke)
    if (current.trim() !== cleanRaw.trim()) {
      editor.commands.setContent(cleanRaw, { emitUpdate: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawMarkdown, editor]);

  // Re-dispatch transaction when selectedTaskId or runningTaskIds changes to update active card & running card decorations
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const tr = editor.state.tr.setMeta('selectedCardSync', true);
    editor.view.dispatch(tr);
  }, [selectedTaskId, runningTaskIds, editor]);

  const [showStyles, setShowStyles] = useState(false);

  const setLink = useCallback(() => {
    if (!editor) return;
    const prev = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt('Enter URL', prev ?? 'https://');
    if (url === null) return;
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
    } else {
      editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    }
  }, [editor]);

  const doneTasks = tasks.filter((t) => t.isDone).length;

  return (
    <div className="pane pane-left obsidian-pane">
      {/* ── Header ── */}
      <div className="pane-header obsidian-header">
        <div className="pane-title">
          <FileText size={17} color="var(--accent-cyan)" />
          <span>Human Workspace</span>
          <span className="pane-subtitle">{doneTasks}/{tasks.length} done</span>
        </div>

        <div style={{ display: 'flex', gap: '0.45rem', alignItems: 'center' }}>
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
        </div>
      </div>

      {/* ── Formatting Toolbar ── */}
      {showStyles && (
        <div className="tiptap-toolbar">
          {/* History */}
          <ToolbarBtn title="Undo" onClick={() => editor?.chain().focus().undo().run()} disabled={!editor?.can().undo()}>
            <Undo2 size={14} />
          </ToolbarBtn>
          <ToolbarBtn title="Redo" onClick={() => editor?.chain().focus().redo().run()} disabled={!editor?.can().redo()}>
            <Redo2 size={14} />
          </ToolbarBtn>

          <Sep />

          {/* Text styles */}
          <ToolbarBtn title="Bold (Ctrl+B)" active={editor?.isActive('bold')} onClick={() => editor?.chain().focus().toggleBold().run()}>
            <Bold size={14} />
          </ToolbarBtn>
          <ToolbarBtn title="Italic (Ctrl+I)" active={editor?.isActive('italic')} onClick={() => editor?.chain().focus().toggleItalic().run()}>
            <Italic size={14} />
          </ToolbarBtn>
          <ToolbarBtn title="Strikethrough" active={editor?.isActive('strike')} onClick={() => editor?.chain().focus().toggleStrike().run()}>
            <Strikethrough size={14} />
          </ToolbarBtn>
          <ToolbarBtn title="Inline Code" active={editor?.isActive('code')} onClick={() => editor?.chain().focus().toggleCode().run()}>
            <Code size={14} />
          </ToolbarBtn>

          <Sep />

          {/* Headings */}
          <ToolbarBtn title="Heading 1" active={editor?.isActive('heading', { level: 1 })} onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}>
            <Heading1 size={14} />
          </ToolbarBtn>
          <ToolbarBtn title="Heading 2" active={editor?.isActive('heading', { level: 2 })} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}>
            <Heading2 size={14} />
          </ToolbarBtn>
          <ToolbarBtn title="Heading 3" active={editor?.isActive('heading', { level: 3 })} onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}>
            <Heading3 size={14} />
          </ToolbarBtn>

          <Sep />

          {/* Lists */}
          <ToolbarBtn title="Bullet List" active={editor?.isActive('bulletList')} onClick={() => editor?.chain().focus().toggleBulletList().run()}>
            <List size={14} />
          </ToolbarBtn>
          <ToolbarBtn title="Numbered List" active={editor?.isActive('orderedList')} onClick={() => editor?.chain().focus().toggleOrderedList().run()}>
            <ListOrdered size={14} />
          </ToolbarBtn>

          <Sep />

          {/* Block elements */}
          <ToolbarBtn title="Blockquote" active={editor?.isActive('blockquote')} onClick={() => editor?.chain().focus().toggleBlockquote().run()}>
            <Quote size={14} />
          </ToolbarBtn>
          <ToolbarBtn title="Code Block" active={editor?.isActive('codeBlock')} onClick={() => editor?.chain().focus().toggleCodeBlock().run()}>
            <FileCode size={14} />
          </ToolbarBtn>
          <ToolbarBtn title="Horizontal Rule" onClick={() => editor?.chain().focus().setHorizontalRule().run()}>
            <Minus size={14} />
          </ToolbarBtn>
          <ToolbarBtn title="Link" active={editor?.isActive('link')} onClick={setLink}>
            <LinkIcon size={14} />
          </ToolbarBtn>
        </div>
      )}

      {/* ── Editor canvas ── */}
      <div className="obsidian-body tiptap-body" style={{ position: 'relative' }}>
        <EditorContent editor={editor} className="tiptap-editor-root" />
      </div>

      {/* ── Fixed Footer at Bottom of Screen ── */}
      <div className="task-pane-footer">
        <button
          type="button"
          className="new-card-btn"
          onClick={() => handleAddNewCard(editor)}
        >
          <Plus size={16} />
          <span>New Task</span>
        </button>
        <button
          type="button"
          className="new-task-btn"
          onClick={onOpenDraftModal}
        >
          <Sparkles size={16} />
          <span>Generate Task</span>
        </button>
      </div>
    </div>
  );
};
