import React, { useCallback, useEffect } from 'react';
import { type TaskItem as TaskItemType } from '../types';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Link from '@tiptap/extension-link';
import Typography from '@tiptap/extension-typography';
import { Markdown } from 'tiptap-markdown';

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, Selection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { canJoin } from '@tiptap/pm/transform';
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

  // Scan children: find where paragraph ends and if a bulletList already exists
  let insertAfterParagraph = listItemPos + 1;
  let existingBulletEnd: number | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  liveNode.forEach((child: any, offset: number) => {
    if (child.type.name === 'paragraph') {
      insertAfterParagraph = listItemPos + 1 + offset + child.nodeSize;
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
    // Create a fresh bulletList with one empty item, placed right after the paragraph
    const newBullet = bulletList.create(null, listItem.create(null, paragraph.create(null)));
    tr.insert(insertAfterParagraph, newBullet);
    focusPos = insertAfterParagraph + 3;
  }

  const clampedPos = Math.min(focusPos, tr.doc.content.size - 1);
  tr.setSelection(Selection.near(tr.doc.resolve(clampedPos)));
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
  tr.scrollIntoView();
  view.dispatch(tr);
  view.focus();
}

// Helper: compute 1-based top-level card index from document position
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getTaskIndexAtPos(doc: any, pos: number): number | null {
  const resolved = doc.resolve(pos);
  for (let d = resolved.depth; d > 0; d--) {
    const node = resolved.node(d);
    if (node.type.name === 'listItem') {
      const parent = resolved.node(d - 1);
      if (parent.type.name === 'orderedList') {
        const itemPos = resolved.before(d);
        let count = 0;
        let found = 0;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        doc.descendants((n: any, p: number) => {
          if (n.type.name === 'listItem') {
            const r = doc.resolve(p);
            if (r.parent.type.name === 'orderedList' && (r.depth < 2 || r.node(r.depth - 2)?.type.name !== 'listItem')) {
              count++;
              if (p === itemPos) {
                found = count;
              }
            }
          }
        });
        return found || 1;
      }
    }
  }
  return null;
}

// Extension: Auto-join adjacent ordered lists and remove empty paragraphs between them
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
          const paragraphType = schema.nodes.paragraph;
          if (!orderedListType) return null;

          const tr = newState.tr;
          let changed = false;

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const isParagraphEmpty = (node: any) => {
            if (!node || node.type !== paragraphType) return false;
            return node.textContent.trim() === '';
          };

          let iterations = 0;
          while (iterations < 10) {
            iterations++;
            let localChanged = false;
            const currentDoc = tr.doc;

            let pos = 0;
            for (let i = 0; i < currentDoc.childCount; i++) {
              const child = currentDoc.child(i);
              const childSize = child.nodeSize;

              if (child.type === orderedListType) {
                let nextIdx = i + 1;
                let emptyRangeEnd = pos + childSize;
                let hasEmptyParagraphs = false;

                while (nextIdx < currentDoc.childCount && isParagraphEmpty(currentDoc.child(nextIdx))) {
                  hasEmptyParagraphs = true;
                  emptyRangeEnd += currentDoc.child(nextIdx).nodeSize;
                  nextIdx++;
                }

                if (nextIdx < currentDoc.childCount && currentDoc.child(nextIdx).type === orderedListType) {
                  const joinAt = pos + childSize;
                  if (hasEmptyParagraphs) {
                    tr.delete(joinAt, emptyRangeEnd);
                  }
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

// Extension: H1 → ordered list on Enter; Shift+Enter inside card → add subtask; Backspace on empty card → clean delete
const AutoCardListExtension = Extension.create({
  name: 'autoCardList',
  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        if (editor.isActive('heading', { level: 1 })) {
          const { $from } = editor.state.selection;
          if ($from.parentOffset === $from.parent.content.size) {
            return editor.chain().splitBlock().toggleOrderedList().run();
          }
        }
        return false;
      },
      'Shift-Enter': ({ editor }) => {
        // When inside an ordered list card, Shift+Enter adds a subtask bullet
        if (!editor.isActive('orderedList')) return false;
        const { $from } = editor.state.selection;
        for (let depth = $from.depth; depth > 0; depth--) {
          const node = $from.node(depth);
          if (node.type.name === 'listItem') {
            const parentNode = $from.node(depth - 1);
            if (parentNode.type.name === 'orderedList') {
              insertSubtaskAtCardPos(editor, $from.before(depth));
              return true;
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
              parent.type.name === 'orderedList' &&
              (depth < 2 || $from.node(depth - 2)?.type.name !== 'listItem');

            if (isTopLevelCard) {
              const cardStartPos = $from.start(depth);
              const cardBeforePos = $from.before(depth);
              const cardAfterPos = $from.after(depth);

              // Check if card is empty
              let isCardEmpty = true;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              node.forEach((child: any) => {
                if (child.type.name === 'paragraph' && child.textContent.trim() !== '') {
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
  onSelectTask?: (taskId: number) => void;
  onOpenDraftModal: () => void;
  onMarkdownChange: (newMarkdown: string) => void;
}

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

// Set of collapsed card keys (persists across decoration rebuilds)
const collapsedCardsState = new Set<string>();

// ── Main component ──────────────────────────────────────────────
export const TaskPane: React.FC<TaskPaneProps> = ({
  rawMarkdown,
  tasks,
  selectedTaskId,
  onSelectTask,
  onOpenDraftModal,
  onMarkdownChange,
}) => {
  // ProseMirror decoration extension for UI Checkboxes, Add Subtask, and Active Card highlighting
  const TaskCheckboxDecorationExtension = Extension.create({
    name: 'taskCheckboxDecoration',
    addProseMirrorPlugins() {
      const editor = this.editor;
      return [
        new Plugin({
          key: new PluginKey('taskCheckboxDecorationPlugin'),
          props: {
            decorations(state) {
              const decorations: Decoration[] = [];
              const { doc, schema } = state;
              const strikeMarkType = schema.marks.strike;
              let currentCardIndex = 0;

              doc.descendants((node, pos) => {
                if (node.type.name !== 'listItem') return;
                const resolved = doc.resolve(pos);
                const parent = resolved.parent;
                const isTopLevelCard =
                  parent.type.name === 'orderedList' &&
                  (resolved.depth < 2 || resolved.node(resolved.depth - 2)?.type.name !== 'listItem');

                if (isTopLevelCard) {
                  currentCardIndex++;
                  const cardTaskId = tasks[currentCardIndex - 1]?.id || currentCardIndex;
                  const isSelected = selectedTaskId === cardTaskId;

                  // Find first paragraph in this card (parent task title)
                  let firstParagraphPos: number | null = null;
                  let firstParagraphNode: any = null;

                  node.forEach((child: any, offset: number) => {
                    const childPos = pos + 1 + offset;
                    if (child.type.name === 'paragraph' && firstParagraphPos === null) {
                      firstParagraphPos = childPos;
                      firstParagraphNode = child;
                    }
                  });

                  const isParentChecked = firstParagraphNode ? isNodeChecked(firstParagraphNode) : false;

                  // Set of collapsed card keys (using node content or position key)
                  const cardKey = `card-${pos}-${firstParagraphNode?.textContent?.slice(0, 30) || ''}`;
                  const isCollapsed = collapsedCardsState.has(cardKey);

                  // 1. Add active-card, card-done, and card-collapsed class decoration
                  const cardClasses = [
                    isSelected ? 'is-active-card' : '',
                    isParentChecked ? 'is-card-done' : '',
                    isCollapsed ? 'card-collapsed' : '',
                  ]
                    .filter(Boolean)
                    .join(' ');

                  if (cardClasses) {
                    decorations.push(
                      Decoration.node(pos, pos + node.nodeSize, {
                        class: cardClasses,
                      })
                    );
                  }

                  // 2. Add Parent Task Checkbox Widget at pos + 1
                  const parentCheckboxWidget = Decoration.widget(
                    pos + 1,
                    (view, getPos) => {
                      const container = document.createElement('div');
                      container.className = `task-card-checkbox-wrapper ${isParentChecked ? 'is-checked' : ''}`;
                      container.setAttribute('contenteditable', 'false');
                      container.title = isParentChecked ? 'Mark task as incomplete' : 'Mark task as completed';

                      const checkbox = document.createElement('button');
                      checkbox.type = 'button';
                      checkbox.className = `task-ui-checkbox parent-checkbox ${isParentChecked ? 'checked' : ''}`;
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

                        let liveFirstPPos: number | null = null;
                        let liveFirstPNode: any = null;
                        const liveSubtaskPs: { pos: number; node: any }[] = [];

                        liveNode.forEach((child: any, offset: number) => {
                          const childPos: number = listItemPos + 1 + offset;
                          if (child.type.name === 'paragraph' && liveFirstPPos === null) {
                            liveFirstPPos = childPos;
                            liveFirstPNode = child;
                          } else if (child.type.name === 'bulletList' || child.type.name === 'orderedList') {
                            child.forEach((nestedItem: any, nestedOffset: number) => {
                              const nestedItemPos: number = childPos + 1 + nestedOffset;
                              if (nestedItem.type.name === 'listItem') {
                                nestedItem.forEach((nestedChild: any, nOffset: number) => {
                                  if (nestedChild.type.name === 'paragraph') {
                                    liveSubtaskPs.push({
                                      pos: nestedItemPos + 1 + nOffset,
                                      node: nestedChild,
                                    });
                                  }
                                });
                              }
                            });
                          }
                        });

                        if (!liveFirstPNode || liveFirstPPos === null) return;

                        const shouldCheck = !isNodeChecked(liveFirstPNode);
                        const tr = view.state.tr;
                        const fromPos: number = Number(liveFirstPPos);
                        const toPos: number = fromPos + Number(liveFirstPNode.nodeSize);

                        if (shouldCheck) {
                          // Strikethrough parent task
                          tr.addMark(fromPos, toPos, strikeMarkType.create());
                          // Cascade: check and strikethrough all children subtasks
                          liveSubtaskPs.forEach((sp) => {
                            const spFrom: number = Number(sp.pos);
                            const spTo: number = spFrom + Number(sp.node.nodeSize);
                            tr.addMark(spFrom, spTo, strikeMarkType.create());
                          });
                        } else {
                          // Uncheck parent task
                          tr.removeMark(fromPos, toPos, strikeMarkType);
                          // Cascade: uncheck and remove strikethrough from all children subtasks
                          liveSubtaskPs.forEach((sp) => {
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

                  // 4. Add Card Action Buttons Widget (Add Subtask + Delete Task) at pos + 1 (right side)
                  const cardActionsWidget = Decoration.widget(
                    pos + 1,
                    (view, getPos) => {
                      const container = document.createElement('div');
                      container.className = 'card-actions-wrapper';
                      container.setAttribute('contenteditable', 'false');

                      // Add subtask button
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
                        if (onSelectTask) {
                          onSelectTask(cardTaskId);
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
                      return container;
                    },
                    { side: 1, stopEvent: () => true }
                  );
                  decorations.push(cardActionsWidget);

                } else {
                  // Subtask list item (nested under a card or bullet list item)
                  let subPPos: number | null = null;
                  let subPNode: any = null;

                  node.forEach((child: any, offset: number) => {
                    if (child.type.name === 'paragraph' && subPPos === null) {
                      subPPos = pos + 1 + offset;
                      subPNode = child;
                    }
                  });

                  if (subPNode && subPPos !== null) {
                    const isSubChecked = isNodeChecked(subPNode);

                    const subtaskCheckboxWidget = Decoration.widget(
                      pos + 1,
                      (view, getPos) => {
                        const container = document.createElement('div');
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

                          let livePPos: number | null = null;
                          let livePNode: any = null;
                          liveNode.forEach((child: any, offset: number) => {
                            if (child.type.name === 'paragraph' && livePPos === null) {
                              livePPos = itemPos + 1 + offset;
                              livePNode = child;
                            }
                          });

                          if (!livePNode || livePPos === null) return;

                          const shouldCheck = !isNodeChecked(livePNode);
                          const tr = view.state.tr;
                          const fromPos: number = Number(livePPos);
                          const toPos: number = fromPos + Number(livePNode.nodeSize);

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

              return DecorationSet.create(doc, decorations);
            },
          },
        }),
      ];
    },
  });

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Strike is included; disable heading keyboard shortcut interference
        heading: { levels: [1, 2, 3, 4] },
        code: {},
        codeBlock: {},
        blockquote: {},
        horizontalRule: {},
      }),
      Placeholder.configure({
        placeholder: '# My Task List\n\nStart typing in markdown — **bold**, *italic*, `code`, headings, lists…',
      }),
      Link.configure({ openOnClick: false }),
      Typography,
      AutoCardListExtension,
      AutoJoinListsExtension,
      TaskCheckboxDecorationExtension,
      Markdown.configure({
        html: false,
        transformPastedText: true,
        transformCopiedText: true,
      }),
    ],
    content: rawMarkdown,
    autofocus: false,
    onSelectionUpdate({ editor }) {
      if (!onSelectTask) return;
      const pos = editor.state.selection.from;
      const itemIndex = getTaskIndexAtPos(editor.state.doc, pos);
      if (itemIndex !== null) {
        const targetTask = tasks[itemIndex - 1];
        const targetId = targetTask ? targetTask.id : itemIndex;
        onSelectTask(targetId);
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
    const current = (editor as unknown as WithMarkdownStorage).storage.markdown.getMarkdown();
    // Only reset if content meaningfully diverges (avoids caret jump on every keystroke)
    if (current.trim() !== rawMarkdown.trim()) {
      editor.commands.setContent(rawMarkdown);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawMarkdown, editor]);

  // Re-dispatch transaction when selectedTaskId changes to update active card decoration
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const tr = editor.state.tr.setMeta('selectedCardSync', true);
    editor.view.dispatch(tr);
  }, [selectedTaskId, editor]);

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
      </div>

      {/* ── Formatting Toolbar ── */}
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
          <Plus size={20} />
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
