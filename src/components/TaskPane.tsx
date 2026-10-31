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
import Strike from '@tiptap/extension-strike';
import CodeMark from '@tiptap/extension-code';
import Placeholder from '@tiptap/extension-placeholder';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import Typography from '@tiptap/extension-typography';
import { Markdown } from 'tiptap-markdown';
import { stripHeaderComments, parseSwimLaneMarkdown } from '../lib/parser';
import { HEADER_COLORS, randomHeaderColorId, resolveHeaderColor } from '../lib/headerColors';
import { ColorHeading } from '../lib/headingColorNode';
import { Highlight, MarkdownUnderline } from '../lib/delimitedMarks';
import { TextColor } from '../lib/textColorMark';
import { LineSpacingParagraph, LINE_SPACINGS } from '../lib/lineSpacingMark';
import { storageManager } from '../lib/storageManager';
import { getPref, setPref, subscribePrefs } from '../lib/userPrefs';
import { bridgeClient } from '../lib/bridgeClient';
import { HumanAiAssistantModal } from './HumanAiAssistantModal';
import { BatchRunModal, type BatchRunMode } from './BatchRunModal';
import { ScopedRulesModal } from './ScopedRulesModal';
import { BetaFeature, useBeta } from '../context/BetaContext';
import { ScheduleTaskModal } from './ScheduleTaskModal';
import { getAutocompleteSuggestion, listContextAround } from '../lib/autocompleteService';

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, Selection, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { canJoin } from '@tiptap/pm/transform';
import { Fragment, type Node as PMNode } from '@tiptap/pm/model';
import { MARKDOWN_WRAPPER_PAIRS } from '../lib/markdownEditorUtils';
import { applyExternalMarkdown } from '../lib/editorSync';
import { createTaskCommandExtension, insertFileReferences, insertSkillCommand, type TaskCommandHandlers, type TaskCommandState } from '../lib/taskCommandExtension';
import { TaskCommandMenu, type TaskCommandMenuHandle } from './TaskCommandMenu';
import { getWorkspaceSkills, subscribeWorkspaceSkills } from '../lib/skillsManager';
import { projectWorkingFolder, skillsBySlug } from '../lib/taskReferences';

const CustomListItem = ListItem.extend({
  content: 'block+',
});

// A checked-off task is struck through as a whole, so strikethrough ranks outside every other mark. Ranked inside bold
// (StarterKit's order) it was closed around bold words, "~~one ~~**~~two~~** ~~three~~", which markdown can't read
// back: each save turned more of a checked-off task into literal, then escaped, tildes.
const OuterStrike = Strike.extend({ priority: 1000 });

// Inline code takes no other formatting, except strikethrough: a task with `code` in it has to be struck through as a
// whole to count as checked off (it never could be with code's default "excludes everything").
const StrikeableCode = CodeMark.extend({ excludes: 'bold italic underline highlight textColor link' });

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
  CornerDownRight,
  Palette,
  Underline as UnderlineIcon,
  Highlighter,
  Baseline,
  RemoveFormatting,
  IndentIncrease,
  IndentDecrease,
  Play,
  ScrollText
} from 'lucide-react';

interface WithMarkdownStorage {
  storage: {
    markdown: {
      getMarkdown: () => string;
    };
  };
}

// Module-level persistent Set to remember collapsed cards across re-renders
// Collapsed task cards, remembered across reloads. Keyed by lane file + task title (not position), so
// adding or reordering tasks doesn't move the collapsed state onto a different card.
const COLLAPSED_CARDS_KEY = 'ergo_collapsed_cards';
const collapsedCardsState: Set<string> = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(COLLAPSED_CARDS_KEY) || '[]');
    return new Set<string>(Array.isArray(saved) ? saved : []);
  } catch {
    return new Set<string>();
  }
})();
function saveCollapsedCards() {
  try {
    localStorage.setItem(COLLAPSED_CARDS_KEY, JSON.stringify([...collapsedCardsState]));
  } catch { /* storage unavailable: state just won't persist */ }
}

const FORMATTING_BAR_PREF = 'human_formatting_bar';
const readShowFormattingBar = () => getPref(FORMATTING_BAR_PREF) !== 'hidden';

// Collapsed group headers, remembered across reloads: { [lane file]: ["<level>:<header name>", ...] }.
const COLLAPSED_HEADERS_KEY = 'ergo_collapsed_headers';
function loadCollapsedHeaders(laneKey: string): Set<string> {
  try {
    const all = JSON.parse(localStorage.getItem(COLLAPSED_HEADERS_KEY) || '{}');
    return new Set(Array.isArray(all[laneKey]) ? all[laneKey] : []);
  } catch {
    return new Set();
  }
}
function saveCollapsedHeaders(laneKey: string, keys: Set<string>) {
  try {
    const all = JSON.parse(localStorage.getItem(COLLAPSED_HEADERS_KEY) || '{}');
    if (keys.size) all[laneKey] = [...keys];
    else delete all[laneKey];
    localStorage.setItem(COLLAPSED_HEADERS_KEY, JSON.stringify(all));
  } catch { /* storage unavailable: state just won't persist */ }
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

  const liveNode = doc.nodeAt(listItemPos);
  if (!liveNode || liveNode.type.name !== 'listItem') return;

  let insertAfterContent = listItemPos + 1;
  let existingBulletEnd: number | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  liveNode.forEach((child: any, offset: number) => {
    if (child.type.name !== 'bulletList' && child.type.name !== 'orderedList') {
      insertAfterContent = listItemPos + 1 + offset + child.nodeSize;
    } else {
      // Append to the card's last subtask list, numbered or not.
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

// Helper: the numbered / bullet list buttons. Unlike Tiptap's toggles, which retype the whole list the cursor is in,
// this changes only the selected items (tasks or subtasks): they're split out into a list of the other type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toggleListTypeForSelection(editorInstance: any, typeName: 'orderedList' | 'bulletList') {
  if (!editorInstance) return;
  const { state, view } = editorInstance;
  const listType = state.schema.nodes[typeName];
  const { $from, $to, from, to } = state.selection;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const range = $from.blockRange($to, (node: any) => node.type.name === 'orderedList' || node.type.name === 'bulletList');
  if (!range) {
    // Not in a list yet: make one.
    const chain = editorInstance.chain().focus();
    (typeName === 'orderedList' ? chain.toggleOrderedList() : chain.toggleBulletList()).run();
    return;
  }
  const list = range.parent;
  if (list.type === listType) {
    // Same type: take just the selected items out of the list.
    editorInstance.chain().focus().liftListItem('listItem').run();
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const before: any[] = [], selected: any[] = [], after: any[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  list.forEach((child: any, _offset: number, i: number) => {
    (i < range.startIndex ? before : i < range.endIndex ? selected : after).push(child);
  });
  const listPos = range.$from.before(range.depth);
  // Numbered items after the split-out ones keep their numbers (`3.` stays `3.` in the file, not a new `1.` list).
  const afterAttrs = list.type.name === 'orderedList'
    ? { ...list.attrs, start: (list.attrs.start ?? 1) + before.length + selected.length }
    : list.attrs;
  const pieces = [
    ...(before.length ? [list.type.create(list.attrs, before)] : []),
    listType.create(null, selected),
    ...(after.length ? [list.type.create(afterAttrs, after)] : []),
  ];
  const tr = state.tr.replaceWith(listPos, listPos + list.nodeSize, pieces);
  // The selected items moved past the close of the "before" list and the open of their own.
  const shift = before.length ? 2 : 0;
  tr.setSelection(TextSelection.create(tr.doc, from + shift, to + shift));
  view.dispatch(tr);
  view.focus();
}

// Helper: type of the innermost list the cursor is in (lights up the matching list button).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function innermostListType(editorInstance: any): string | null {
  if (!editorInstance) return null;
  const { $from } = editorInstance.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d).type.name;
    if (name === 'orderedList' || name === 'bulletList') return name;
  }
  return null;
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

// Helper: a click on a card widget's empty area (contenteditable=false) puts the caret on the text beside it, at the
// click's height. Left to the browser, the caret landed at the end of the task list.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function placeCaretBesideWidget(view: any, widget: HTMLElement, event: MouseEvent, side: 'left' | 'right') {
  event.preventDefault();
  event.stopPropagation();
  const rect = widget.getBoundingClientRect();
  const hit = view.posAtCoords({ left: side === 'left' ? rect.left - 2 : rect.right + 2, top: event.clientY });
  if (hit) view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(hit.pos))));
  view.focus();
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

// Extension: every task keeps a title line. Deleting a selection that runs from outside the list into a task's title
// merges that title into the block above and left the task's subtasks under a parent with no title (`1. - sub`).
const TitledTasksExtension = Extension.create({
  name: 'titledTasks',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('titledTasksPlugin'),
        appendTransaction(transactions, _oldState, newState) {
          if (!transactions.some((t) => t.docChanged)) return null;
          const paragraph = newState.schema.nodes.paragraph;
          const tr = newState.tr;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          newState.doc.descendants((node: any, pos: number) => {
            if (node.type.name === 'listItem' && node.firstChild && isListNode(node.firstChild)) {
              tr.insert(tr.mapping.map(pos + 1), paragraph.create());
            }
          });
          return tr.docChanged ? tr : null;
        },
      }),
    ];
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isListNode(node: any): boolean {
  return node?.type.name === 'bulletList' || node?.type.name === 'orderedList';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isCollapsedCard(view: any, itemPos: number): boolean {
  const dom = view.nodeDOM(itemPos);
  return dom instanceof HTMLElement && dom.classList.contains('card-collapsed');
}

// Helper: the end of the last line the user can see in a task: its title when the card is collapsed, otherwise its
// last line (a subtask's, when it has any).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lastVisibleLineEnd(view: any, item: any, itemPos: number): number | null {
  if (isCollapsedCard(view, itemPos) && item.firstChild?.isTextblock) return itemPos + item.firstChild.nodeSize;
  let end: number | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  item.descendants((child: any, childPos: number) => {
    if (!child.isTextblock) return true;
    end = itemPos + 1 + childPos + child.nodeSize - 1;
    return false;
  });
  return end;
}

/**
 * Removes the task (or subtask) at `itemDepth` the way deleting a line break would: its title text joins the end of
 * the line above it (the previous sibling's last visible line) and its subtasks move into that sibling's subtasks.
 * Nothing is orphaned. Returns null when the item has no previous sibling.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mergeTaskIntoPrevious(view: any, $pos: any, itemDepth: number) {
  const { state } = view;
  const index = $pos.index(itemDepth - 1);
  if (index === 0) return null;
  const item = $pos.node(itemDepth);
  const title = item.firstChild;
  if (!title?.isTextblock) return null;
  const itemPos = $pos.before(itemDepth);
  const prev = $pos.node(itemDepth - 1).child(index - 1);
  const prevPos = itemPos - prev.nodeSize;
  const joinAt = lastVisibleLineEnd(view, prev, prevPos);
  if (joinAt == null) return null;

  const rest = item.content.cut(title.nodeSize);
  const prevContentEnd = prevPos + prev.nodeSize - 1;
  const tr = state.tr.delete(itemPos, itemPos + item.nodeSize);
  if (rest.size) {
    // Subtasks join the previous task's own subtask list when it has one.
    if (isListNode(prev.lastChild) && isListNode(rest.firstChild)) {
      const remaining = rest.cut(rest.firstChild.nodeSize);
      tr.insert(prevContentEnd - 1, rest.firstChild.content);
      if (remaining.size) tr.insert(tr.mapping.map(prevContentEnd), remaining);
    } else {
      tr.insert(prevContentEnd, rest);
    }
  }
  if (title.content.size) tr.insert(joinAt, title.content);
  return tr.setSelection(TextSelection.create(tr.doc, joinAt)).scrollIntoView();
}

/**
 * Forward-delete at the end of a task's title when the next line is its first subtask: the subtask's text joins the
 * title and the subtask's own subtasks take its place in the list.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mergeFirstSubtaskIntoParent(view: any, joinAt: number, $next: any, itemDepth: number) {
  const { state } = view;
  const item = $next.node(itemDepth);
  const title = item.firstChild;
  const rest = item.content.cut(title.nodeSize);
  let children = Fragment.empty;
  let movable = true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rest.forEach((block: any) => {
    if (isListNode(block)) children = children.append(block.content);
    else movable = false;
  });
  if (!movable) return null;

  const list = $next.node(itemDepth - 1);
  const itemPos = $next.before(itemDepth);
  const tr = list.childCount === 1 && !children.size
    ? state.tr.delete($next.before(itemDepth - 1), $next.after(itemDepth - 1))
    : state.tr.replaceWith(itemPos, itemPos + item.nodeSize, children);
  if (title.content.size) tr.insert(joinAt, title.content);
  return tr.setSelection(TextSelection.create(tr.doc, joinAt)).scrollIntoView();
}

// Extension: Custom keymap for list item navigation and creation
const CustomListKeymapExtension = Extension.create({
  name: 'customListKeymap',
  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        // At the end of a collapsed task's title, start a new empty task after it. (Splitting the item, the default,
        // would hand the collapsed task's subtasks to the new one.)
        const { state, view } = editor;
        const { selection } = state;
        const { $from } = selection;
        const itemDepth = $from.depth - 1;
        if (
          selection.empty &&
          itemDepth > 0 &&
          $from.parentOffset === $from.parent.content.size &&
          $from.node(itemDepth).type.name === 'listItem' &&
          $from.index(itemDepth) === 0
        ) {
          const itemPos = $from.before(itemDepth);
          const dom = view.nodeDOM(itemPos);
          if (dom instanceof HTMLElement && dom.classList.contains('card-collapsed')) {
            const afterItem = itemPos + $from.node(itemDepth).nodeSize;
            const tr = state.tr.insert(afterItem, state.schema.nodes.listItem.create(null, state.schema.nodes.paragraph.create()));
            tr.setSelection(TextSelection.create(tr.doc, afterItem + 2));
            tr.setStoredMarks([]);
            view.dispatch(tr.scrollIntoView());
            return true;
          }
        }
        // Otherwise the default list behavior: a new list item, or out of the list from an empty one.
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
                // Nest under the previous task (its children sink one level with it).
                // The first task has no previous sibling, so Tab does nothing.
                editor.commands.sinkListItem('listItem');
                return true;
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

            const atTitleStart = $from.parentOffset === 0 && $from.depth === depth + 1 && $from.index(depth) === 0;
            // At the start of a task's title, Backspace removes the line break above it: the title joins the line
            // above and its subtasks join that task's subtasks. (Lifting it out of the list orphaned its subtasks
            // and restarted the numbering of every task below.)
            if (isTopLevelCard && atTitleStart) {
              const merged = mergeTaskIntoPrevious(view, $from, depth);
              if (merged) {
                view.dispatch(merged);
                return true;
              }
              // The list's first task has no line above in the list. Keep its subtasks attached: an empty title gives
              // way to them (they become tasks); a titled one stays a task.
              const sublist = node.childCount === 2 && isListNode(node.lastChild) ? node.lastChild : null;
              if (!isCardEmpty && $from.parent.content.size === 0 && sublist) {
                const tr = state.tr.replaceWith($from.before(depth), $from.after(depth), sublist.content);
                view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve($from.pos))).scrollIntoView());
                return true;
              }
              if (!isCardEmpty && node.childCount > 1) return true;
            }

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

        // At the end of a line, Delete removes the line break below it: the next task or subtask joins this line and
        // its subtasks stay attached (they were pulled in as a loose paragraph, or moved under the wrong task).
        if ($from.parent.isTextblock && $from.parentOffset === $from.parent.content.size) {
          const lineDepth = $from.depth - 1;
          const inTitle = lineDepth > 0 && $from.node(lineDepth).type.name === 'listItem' && $from.index(lineDepth) === 0;
          // The next line the user sees: past a collapsed card's hidden subtasks.
          const afterLine = inTitle && isCollapsedCard(view, $from.before(lineDepth)) ? $from.after(lineDepth) : $from.after();
          const $next = afterLine < state.doc.content.size ? Selection.findFrom(state.doc.resolve(afterLine), 1, true)?.$from : null;
          const nextDepth = $next ? $next.depth - 1 : 0;
          if ($next && nextDepth > 0 && $next.parentOffset === 0 && $next.node(nextDepth).type.name === 'listItem' && $next.index(nextDepth) === 0) {
            const listDepth = nextDepth - 1;
            const nestedList = listDepth > 0 && $next.node(listDepth - 1).type.name === 'listItem';
            let tr = null;
            if ($next.index(listDepth) > 0) {
              tr = mergeTaskIntoPrevious(view, $next, nextDepth);
              if (tr && tr.selection.from !== $from.pos) tr = null;
            } else if (nestedList && $next.before(listDepth) === $from.after()) {
              tr = mergeFirstSubtaskIntoParent(view, $from.pos, $next, nextDepth);
            } else if (!nestedList && $next.node(nextDepth).childCount > 1) {
              // The first task of a list, below a header or note: joining its title upward would orphan its subtasks.
              return true;
            }
            if (tr) {
              view.dispatch(tr);
              return true;
            }
          }
        }

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
  /** Run several tasks of a lane: one after another (queued) or all at once. */
  onRunTasks?: (tasks: TaskItemType[], laneId: string, laneTitle: string, mode: BatchRunMode) => void;
  onScheduleTask?: (taskId: string | number, scheduledIso: string, cronExpr?: string) => void;
  // Selected lane action drawer props
  isAssistantOpen?: boolean;
  onOpenAssistant?: () => void;
  onCloseAssistant?: () => void;
  project?: ProjectData | null;
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
  onRunTasks,
  onScheduleTask,
  assistantDrawerHeight,
  onEditorReady,
  isAssistantOpen = false,
  onOpenAssistant,
  onCloseAssistant,
  project,
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

  // Run-task menu modal state ("Several tasks…" / the lane header's Run, and schedule)
  const [batchModal, setBatchModal] = useState<{ selectedIds: Array<string | number>; openedAt: number } | null>(null);
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
  const [isRulesOpen, setIsRulesOpen] = useState(false);
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
            handleClick(view, pos, event) {
              if (onSelectTaskRef.current) {
                const itemIndex = getTaskIndexAtPos(view.state.doc, pos);
                if (itemIndex !== null) {
                  // Resolve matching task by index or id
                  const targetTask = laneTasksRef.current[itemIndex - 1];
                  const targetId = targetTask ? targetTask.id : `${lane.id}_task_${itemIndex}`;
                  if (selectedTaskIdRef.current !== targetId) {
                    // Selecting a task re-renders the lane before ProseMirror reads the caret the browser just placed,
                    // which redrew the old selection instead (often the end of the list). Commit the click first.
                    if (!event.shiftKey) {
                      view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos))));
                    }
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

                  const cardTitle = (node.firstChild?.textContent || '').trim();
                  const cardKey = `${lane.filePath || lane.id}::${cardTitle || `#${orderedItemCounter}`}`;
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
                      container.addEventListener('mousedown', (e) => placeCaretBesideWidget(view, container, e, 'right'));

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
                        btn.innerHTML = `<svg class="collapse-chevron" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`;

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
                          saveCollapsedCards();
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
                      // The buttons stay hidden until hover, but this box still covers the end of the task's first line.
                      container.addEventListener('mousedown', (e) => {
                        if (!(e.target as HTMLElement).closest('button, .card-dropdown-menu')) placeCaretBesideWidget(view, container, e, 'left');
                      });

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
                              label: 'Several tasks...',
                              tip: 'Pick tasks in this list to run one after another, or all at once',
                              icon: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="10" y1="6" x2="21" y2="6"></line><line x1="10" y1="12" x2="21" y2="12"></line><line x1="10" y1="18" x2="21" y2="18"></line><path d="M4 6h1v4"></path><path d="M4 10h2"></path><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"></path></svg>`,
                              action: () => {
                                if (!matchedTask) return;
                                // This task and the not-done ones after it, ready to trim.
                                const idx = laneTasksRef.current.findIndex((t) => t.id === matchedTask.id);
                                const after = idx >= 0 ? laneTasksRef.current.slice(idx + 1).filter((t) => !t.isDone) : [];
                                setBatchModalRef.current({ selectedIds: [matchedTask.id, ...after.map((t) => t.id)], openedAt: Date.now() });
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
                            saveCollapsedCards();

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

  // Task commands: `@` references a file, `/` runs a skill when the task executes (taskReferences.ts).
  const [taskCommand, setTaskCommand] = useState<TaskCommandState | null>(null);
  const [workspaceSkills, setWorkspaceSkills] = useState(() => getWorkspaceSkills());
  useEffect(() => subscribeWorkspaceSkills(setWorkspaceSkills), []);
  const skillSlugs = useMemo(() => new Set(skillsBySlug(workspaceSkills).keys()), [workspaceSkills]);
  const commandMenuRef = useRef<TaskCommandMenuHandle>(null);
  const taskCommandHandlersRef = useRef<TaskCommandHandlers>({
    onChange: setTaskCommand,
    onKey: (key) => commandMenuRef.current?.onKey(key) ?? false,
    skillSlugs: () => skillSlugs,
  });
  taskCommandHandlersRef.current.skillSlugs = () => skillSlugs;
  const [TaskCommandExtension] = useState(() => createTaskCommandExtension(`taskCommands_${lane.id}`, taskCommandHandlersRef));

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
  // What the app last saw of this lane: the markdown string and the document it came from. Lets the sync below tell
  // its own edits coming back from changes made outside the editor.
  const syncedMarkdownRef = useRef<string>(stripHeaderComments(lane.markdown));
  const syncedDocRef = useRef<PMNode | null>(null);

  const emitMarkdownChange = useCallback(() => {
    const currentEd = editorInstanceRef.current;
    if (currentEd && !currentEd.isDestroyed) {
      const storage = (currentEd as unknown as WithMarkdownStorage).storage;
      const md = storage?.markdown?.getMarkdown();
      if (typeof md === 'string') {
        syncedMarkdownRef.current = md;
        syncedDocRef.current = currentEd.state.doc;
        onMarkdownChangeRef.current(lane.id, md);
      }
    }
  }, [lane.id]);

  const flushMarkdownChange = useCallback(() => {
    if (markdownDebounceTimerRef.current) {
      clearTimeout(markdownDebounceTimerRef.current);
      markdownDebounceTimerRef.current = null;
    }
    emitMarkdownChange();
  }, [emitMarkdownChange]);

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
      emitMarkdownChange();
    }, 800);
  }, [emitMarkdownChange]);

  // Extension: Pop up markdown formatting characters (e.g. backticks around code) on hover,
  // allowing user to click to delete them, while keeping formatting clean the rest of the time.
  const MarkdownHoverSyntaxExtension = Extension.create({
    name: `markdownHoverSyntax_${lane.id}`,
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: new PluginKey(`markdownHoverSyntaxPlugin_${lane.id}`),
          props: {
            handleDOMEvents: {
              mouseover(view, event) {
                const target = event.target as HTMLElement | null;
                const spanEl = target?.closest('[data-md-span-id]');
                if (spanEl) {
                  const spanId = spanEl.getAttribute('data-md-span-id');
                  if (spanId) {
                    view.dom.querySelectorAll(`[data-md-span-id="${spanId}"]`).forEach((el) => {
                      el.classList.add('is-grave-active');
                    });
                  }
                }
              },
              mouseout(view, event) {
                const target = event.target as HTMLElement | null;
                const spanEl = target?.closest('[data-md-span-id]');
                if (spanEl) {
                  const spanId = spanEl.getAttribute('data-md-span-id');
                  if (spanId) {
                    view.dom.querySelectorAll(`[data-md-span-id="${spanId}"]`).forEach((el) => {
                      el.classList.remove('is-grave-active');
                    });
                  }
                }
              }
            },
            decorations(state) {
              const decorations: Decoration[] = [];
              const doc = state.doc;
              const schema = state.schema;

              // 1. Codeblocks: reveal ``` graves on hover at top & bottom with click-to-delete
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              doc.descendants((node: any, pos: number) => {
                if (node.type.name === 'codeBlock') {
                  const nodeStart = pos;
                  const nodeEnd = pos + node.nodeSize;

                  decorations.push(
                    Decoration.node(nodeStart, nodeEnd, {
                      class: 'md-hover-codeblock-node',
                    })
                  );

                  // Header widget with ``` backticks and delete action
                  decorations.push(
                    Decoration.widget(
                      nodeStart + 1,
                      (view, getPos) => {
                        const header = document.createElement('div');
                        header.className = 'md-codeblock-hover-graves-header';
                        header.setAttribute('contenteditable', 'false');
                        header.title = 'Click to delete code block backticks (```)';

                        const badge = document.createElement('span');
                        badge.className = 'md-codeblock-grave-badge';
                        badge.innerHTML = '<span class="md-grave-chars">```</span><span class="md-grave-delete-hint">delete ```</span>';

                        header.appendChild(badge);

                        header.onclick = (e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          const rawPos = typeof getPos === 'function' ? getPos() : nodeStart;
                          const currentPos = typeof rawPos === 'number' ? rawPos : nodeStart;
                          const paragraphType = view.state.schema.nodes.paragraph;
                          if (paragraphType) {
                            const tr = view.state.tr;
                            const resolved = tr.doc.resolve(Math.min(currentPos, tr.doc.content.size));
                            let depth = resolved.depth;
                            while (depth > 0 && resolved.node(depth).type.name !== 'codeBlock') {
                              depth--;
                            }
                            if (depth > 0) {
                              const blockStart = resolved.before(depth);
                              const blockNode = resolved.node(depth);
                              const textContent = blockNode.textContent;
                              const lines = textContent.split('\n');
                              const paragraphs = lines.map((line: string) =>
                                paragraphType.create(null, line ? view.state.schema.text(line) : null)
                              );
                              tr.replaceWith(blockStart, blockStart + blockNode.nodeSize, paragraphs);
                              view.dispatch(tr);
                              view.focus();
                              scheduleMarkdownChange();
                            }
                          }
                        };

                        return header;
                      },
                      { side: -1 }
                    )
                  );

                  // Footer widget with closing ``` backticks
                  decorations.push(
                    Decoration.widget(
                      nodeEnd - 1,
                      (view, getPos) => {
                        const footer = document.createElement('div');
                        footer.className = 'md-codeblock-hover-graves-footer';
                        footer.setAttribute('contenteditable', 'false');
                        footer.title = 'Click to delete code block backticks (```)';

                        const badge = document.createElement('span');
                        badge.className = 'md-codeblock-grave-badge';
                        badge.innerHTML = '<span class="md-grave-chars">```</span>';

                        footer.appendChild(badge);

                        footer.onclick = (e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          const rawPos = typeof getPos === 'function' ? getPos() : nodeStart;
                          const currentPos = typeof rawPos === 'number' ? rawPos : nodeStart;
                          const paragraphType = view.state.schema.nodes.paragraph;
                          if (paragraphType) {
                            const tr = view.state.tr;
                            const resolved = tr.doc.resolve(Math.min(currentPos, tr.doc.content.size));
                            let depth = resolved.depth;
                            while (depth > 0 && resolved.node(depth).type.name !== 'codeBlock') {
                              depth--;
                            }
                            if (depth > 0) {
                              const blockStart = resolved.before(depth);
                              const blockNode = resolved.node(depth);
                              const textContent = blockNode.textContent;
                              const lines = textContent.split('\n');
                              const paragraphs = lines.map((line: string) =>
                                paragraphType.create(null, line ? view.state.schema.text(line) : null)
                              );
                              tr.replaceWith(blockStart, blockStart + blockNode.nodeSize, paragraphs);
                              view.dispatch(tr);
                              view.focus();
                              scheduleMarkdownChange();
                            }
                          }
                        };

                        return footer;
                      },
                      { side: 1 }
                    )
                  );
                }
              });

              // 2. Inline marks (code, bold, italic, strike): pop up delimiters around text on hover
              const markTypesToTrack = [
                { name: 'code', openChar: '`', closeChar: '`', label: 'grave (`)' },
                { name: 'bold', openChar: '**', closeChar: '**', label: 'bold (**)' },
                { name: 'italic', openChar: '*', closeChar: '*', label: 'italic (*)' },
                { name: 'strike', openChar: '~~', closeChar: '~~', label: 'strikethrough (~~)' }
              ];

              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              doc.descendants((node: any, pos: number) => {
                if (node.isBlock && node.content.size > 0) {
                  markTypesToTrack.forEach(({ name, openChar, closeChar, label }) => {
                    const markType = schema.marks[name];
                    if (!markType) return;

                    let spanStart: number | null = null;
                    let spanEnd: number | null = null;

                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    node.forEach((child: any, offset: number) => {
                      const childPos = pos + 1 + offset;
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      const hasMark = child.isText && child.marks.some((m: any) => m.type.name === name);

                      if (hasMark) {
                        if (spanStart === null) {
                          spanStart = childPos;
                        }
                        spanEnd = childPos + child.nodeSize;
                      } else {
                        if (spanStart !== null && spanEnd !== null) {
                          addInlineGraveDecorations(spanStart, spanEnd, name, openChar, closeChar, label, markType);
                          spanStart = null;
                          spanEnd = null;
                        }
                      }
                    });

                    if (spanStart !== null && spanEnd !== null) {
                      addInlineGraveDecorations(spanStart, spanEnd, name, openChar, closeChar, label, markType);
                    }
                  });
                }
              });

              function addInlineGraveDecorations(
                from: number,
                to: number,
                name: string,
                openChar: string,
                closeChar: string,
                label: string,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                markType: any
              ) {
                const spanId = `md_span_${lane.id}_${from}_${to}_${name}`;

                // Inline decoration spanning the formatted text
                decorations.push(
                  Decoration.inline(from, to, {
                    class: `md-hover-formatted-text md-hover-mark-${name}`,
                    'data-md-span-id': spanId,
                  })
                );

                // Start grave widget
                decorations.push(
                  Decoration.widget(
                    from,
                    (view) => {
                      const span = document.createElement('span');
                      span.className = `md-hover-inline-grave md-grave-open md-grave-type-${name}`;
                      span.setAttribute('contenteditable', 'false');
                      span.setAttribute('data-md-span-id', spanId);
                      span.textContent = openChar;
                      span.title = `Click to delete ${label}`;
                      span.onclick = (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const tr = view.state.tr.removeMark(from, to, markType);
                        view.dispatch(tr);
                        view.focus();
                        scheduleMarkdownChange();
                      };
                      return span;
                    },
                    { side: -1 }
                  )
                );

                // End grave widget
                decorations.push(
                  Decoration.widget(
                    to,
                    (view) => {
                      const span = document.createElement('span');
                      span.className = `md-hover-inline-grave md-grave-close md-grave-type-${name}`;
                      span.setAttribute('contenteditable', 'false');
                      span.setAttribute('data-md-span-id', spanId);
                      span.textContent = closeChar;
                      span.title = `Click to delete ${label}`;
                      span.onclick = (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const tr = view.state.tr.removeMark(from, to, markType);
                        view.dispatch(tr);
                        view.focus();
                        scheduleMarkdownChange();
                      };
                      return span;
                    },
                    { side: 1 }
                  )
                );
              }

              return DecorationSet.create(doc, decorations);
            }
          }
        })
      ];
    }
  });

  // Header color menu state (right-click on a group header in the editor)
  const [colorPaletteOpen, setColorPaletteOpen] = useState(false);
  // The selection tooltip starts as a small chip and only expands to the full toolbar on hover.
  const [selectionToolsExpanded, setSelectionToolsExpanded] = useState(false);
  // Text / header color palette in the formatting bar
  const [toolbarColorOpen, setToolbarColorOpen] = useState(false);
  const toolbarColorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!toolbarColorOpen) return;
    const handleOutside = (e: MouseEvent) => {
      if (toolbarColorRef.current && !toolbarColorRef.current.contains(e.target as Node)) setToolbarColorOpen(false);
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [toolbarColorOpen]);
  const headerCollapseKey = lane.filePath || lane.id;
  const collapsedHeadersRef = useRef<Set<string> | null>(null);
  if (!collapsedHeadersRef.current) collapsedHeadersRef.current = loadCollapsedHeaders(headerCollapseKey);

  const setHeadingColor = useCallback((view: any, pos: number, colorId: string) => {
    const node = view.state.doc.nodeAt(pos);
    if (!node || node.type.name !== 'heading') return;
    view.dispatch(view.state.tr.setNodeAttribute(pos, 'color', colorId));
    flushMarkdownChange();
  }, [flushMarkdownChange]);

  // Extension: group header colors (the heading's `color` attribute, see headingColorNode.ts) — tints the heading
  // and gives every header a color the moment it's created, so it stays the same while its name is typed out.
  const HeaderColorExtension = Extension.create({
    name: 'headerColor',
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: new PluginKey(`headerColor_${lane.id}`),
          appendTransaction: (transactions, _oldState, newState) => {
            if (!transactions.some((t) => t.docChanged && !t.getMeta('preventUpdate'))) return null;
            const tr = newState.tr;
            newState.doc.descendants((node, pos) => {
              if (node.type.name !== 'heading' || node.attrs.color) return;
              // A brand-new header gets a random color; an older uncolored one keeps the color it's already showing.
              const name = node.textContent.trim();
              tr.setNodeAttribute(pos, 'color', name ? resolveHeaderColor(name).id : randomHeaderColorId());
            });
            return tr.docChanged ? tr.setMeta('addToHistory', false) : null;
          },
          props: {
            decorations: (state) => {
              const decos: Decoration[] = [];
              state.doc.descendants((node, pos) => {
                if (node.type.name !== 'heading') return;
                const color = resolveHeaderColor(node.textContent.trim(), node.attrs.color);
                decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'hdr-colored', style: `--hdr-color: ${color.hex}` }));
              });

              // Header collapse: a collapsed header hides everything up to the next header of the same or higher level.
              const collapsed = collapsedHeadersRef.current!;
              let hideBelowLevel: number | null = null;
              // A header shown right under another header (e.g. a run of collapsed ones) drops its top margin.
              let lastShownWasHeading = false;
              state.doc.forEach((node, pos) => {
                if (node.type.name === 'heading') {
                  const level = node.attrs.level as number;
                  if (hideBelowLevel !== null && level <= hideBelowLevel) hideBelowLevel = null;
                  if (hideBelowLevel === null) {
                    if (lastShownWasHeading) decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'hdr-follows-hdr' }));
                    lastShownWasHeading = true;
                    const name = node.textContent;
                    if (!name.trim()) return;
                    const key = `${level}:${name.trim()}`;
                    const isCollapsed = collapsed.has(key);
                    if (isCollapsed) {
                      hideBelowLevel = level;
                      decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'hdr-is-collapsed' }));
                    }
                    decos.push(Decoration.widget(pos + 1, (view) => {
                      const btn = document.createElement('button');
                      btn.type = 'button';
                      btn.className = `hdr-collapse-btn ${isCollapsed ? 'is-collapsed' : ''}`;
                      btn.setAttribute('contenteditable', 'false');
                      btn.title = isCollapsed ? 'Expand section' : 'Collapse section';
                      btn.setAttribute('aria-label', btn.title);
                      btn.setAttribute('aria-expanded', String(!isCollapsed));
                      btn.innerHTML = `<svg class="collapse-chevron" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`;
                      btn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
                      btn.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (collapsed.has(key)) collapsed.delete(key);
                        else collapsed.add(key);
                        saveCollapsedHeaders(headerCollapseKey, collapsed);
                        view.dispatch(view.state.tr.setMeta('headerCollapseToggle', true));
                      });
                      return btn;
                    }, { side: -1, stopEvent: () => true, key: `${lane.id}|hdrchev|${key}|${isCollapsed}` }));
                    return;
                  }
                }
                if (hideBelowLevel !== null) {
                  decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'hdr-section-hidden' }));
                } else {
                  lastShownWasHeading = false;
                }
              });
              return DecorationSet.create(state.doc, decos);
            },
          },
        }),
      ];
    },
  });

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        paragraph: false,
        heading: false,
        underline: false,
        strike: false,
        code: false,
        bulletList: { keepMarks: true, keepAttributes: false },
        orderedList: { keepMarks: true, keepAttributes: false },
        listItem: false,
      }),
      CustomListItem,
      OuterStrike,
      StrikeableCode,
      ColorHeading,
      MarkdownUnderline,
      Highlight,
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
      TextColor,
      LineSpacingParagraph,
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
      TitledTasksExtension,
      CustomListKeymapExtension,
      TaskCheckboxDecorationExtension,
      AutoSurroundExtension,
      TaskAutocompleteExtension,
      TaskCommandExtension,
      MarkdownHoverSyntaxExtension,
      HeaderColorExtension,
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
    onCreate: ({ editor: createdEditor }) => {
      syncedDocRef.current = createdEditor.state.doc;
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
          // Neighbouring list lines: context for the local model's fill-in-the-middle completion.
          const { contextBefore, nextLine } = listContextAround(currentEditor.state.doc, sel.$from.before());
          const suggestion = await getAutocompleteSuggestion(
            {
              taskText: lineText,
              prefixText,
              suffixText,
              isSubtask,
              parentTaskTitle,
              projectId: projectRef.current?.id,
              contextBefore,
              nextLine,
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

  // Position of the header the whole selection sits in, or null when it isn't inside a single header.
  const selectionHeadingPos = (): number | null => {
    if (!editor) return null;
    const { $from, $to } = editor.state.selection;
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type.name === 'heading') return $to.depth >= d && $to.node(d) === $from.node(d) ? $from.before(d) : null;
    }
    return null;
  };

  const currentSelectionColor = (): string | undefined => {
    if (!editor) return undefined;
    const headingPos = selectionHeadingPos();
    if (headingPos != null) {
      const node = editor.state.doc.nodeAt(headingPos);
      if (!node) return undefined;
      return resolveHeaderColor(node.textContent.trim(), node.attrs.color).id;
    }
    return editor.getAttributes('textColor').color || undefined;
  };

  const applySelectionColor = (colorId: string | null) => {
    if (!editor) return;
    const headingPos = selectionHeadingPos();
    if (headingPos != null) {
      if (colorId) setHeadingColor(editor.view, headingPos, colorId);
    } else if (colorId) {
      editor.chain().focus().setMark('textColor', { color: colorId }).run();
    } else {
      editor.chain().focus().unsetMark('textColor').run();
    }
    setColorPaletteOpen(false);
  };

  useEffect(() => {
    if (!selectionTooltip) {
      setColorPaletteOpen(false);
      setSelectionToolsExpanded(false);
    }
  }, [selectionTooltip]);

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

  // Synchronize editor content when external lane.markdown changes. Only the changed part is replaced, so the caret
  // stays put (a whole-document setContent threw it to the end of the list), and typing the app hasn't seen is kept.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const stripped = stripHeaderComments(lane.markdown);
    // Our own last edit coming back: the editor may already be ahead of it, and nothing changed outside.
    if (stripped === syncedMarkdownRef.current) return;
    syncedMarkdownRef.current = stripped;
    const currentMd = (editor as unknown as WithMarkdownStorage).storage.markdown?.getMarkdown();
    syncedDocRef.current = currentMd === stripped
      ? editor.state.doc
      : applyExternalMarkdown(editor, stripped, syncedDocRef.current);
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

  // Skills added, renamed or toggled: re-highlight the /skill words.
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta('addToHistory', false));
  }, [editor, skillSlugs]);

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
          {/* Run the lane's tasks (opens the picker with every task not done yet ticked) */}
          {isBetaEnabled && onRunTasks && laneTasks.length > 0 && (
            <button
              type="button"
              className="swimlane-menu-btn"
              onClick={(e) => {
                e.stopPropagation();
                setBatchModal({ selectedIds: laneTasks.filter((t) => !t.isDone).map((t) => t.id), openedAt: Date.now() });
              }}
              title="Run this lane's tasks..."
              aria-label="Run this lane's tasks"
            >
              <Play size={14} />
            </button>
          )}

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
                  <span>Archives &amp; Learnings</span>
                  {archivedTasksCount > 0 && (
                    <span className="dropdown-item-badge" style={{ marginLeft: 'auto', fontSize: '0.7rem', padding: '0.05rem 0.35rem', borderRadius: '8px', background: 'rgba(245, 158, 11, 0.15)', border: '1px solid rgba(245, 158, 11, 0.35)', color: '#f59e0b', fontWeight: 600 }}>
                      {archivedTasksCount}
                    </span>
                  )}
                </button>

                <button
                  type="button"
                  className="swimlane-dropdown-item"
                  onClick={() => {
                    setIsMenuOpen(false);
                    setIsRulesOpen(true);
                  }}
                >
                  <ScrollText size={13} style={{ color: 'var(--accent-violet)' }} />
                  <span>Skills &amp; Rules</span>
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
            <ToolbarBtn onClick={() => editor?.chain().focus().toggleUnderline().run()} active={editor?.isActive('underline')} title="Underline (Ctrl+U, ++text++)">
              <UnderlineIcon size={13} />
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
            <ToolbarBtn onClick={() => editor?.chain().focus().toggleHighlight().run()} active={editor?.isActive('highlight')} title="Highlight (Ctrl+Shift+H, ==text==)">
              <Highlighter size={13} />
            </ToolbarBtn>
            <div className="toolbar-color-wrapper" ref={toolbarColorRef}>
              <ToolbarBtn onClick={() => setToolbarColorOpen((o) => !o)} active={toolbarColorOpen || editor?.isActive('textColor')} title={selectionHeadingPos() != null ? 'Header color' : 'Text color'}>
                <Baseline size={13} />
              </ToolbarBtn>
              {toolbarColorOpen && (
                <div className="selection-color-palette toolbar-color-palette" role="menu">
                  {HEADER_COLORS.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      role="menuitem"
                      title={c.label}
                      aria-label={c.label}
                      className={`hdr-color-swatch ${currentSelectionColor() === c.id ? 'is-active' : ''}`}
                      style={{ background: c.hex }}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => { applySelectionColor(c.id); setToolbarColorOpen(false); }}
                    />
                  ))}
                  {selectionHeadingPos() == null && (
                    <button
                      type="button"
                      role="menuitem"
                      title="Remove color"
                      aria-label="Remove color"
                      className="hdr-color-swatch is-clear"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => { applySelectionColor(null); setToolbarColorOpen(false); }}
                    >
                      <X size={11} />
                    </button>
                  )}
                </div>
              )}
            </div>
            <ToolbarBtn onClick={() => editor?.chain().focus().unsetAllMarks().run()} title="Clear formatting">
              <RemoveFormatting size={13} />
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
            <select
              className="line-spacing-select"
              title="Line spacing"
              value={editor?.getAttributes('paragraph').lineSpacing || ''}
              onMouseDown={(e) => e.stopPropagation()}
              onChange={(e) => {
                const v = e.target.value || null;
                editor?.chain().focus().updateAttributes('paragraph', { lineSpacing: v }).run();
              }}
            >
              <option value="">Spacing</option>
              {LINE_SPACINGS.map((v) => (
                <option key={v} value={v}>{v === '1' ? '1.0' : v}</option>
              ))}
            </select>
          </div>

          <Sep />

          <div className="tiptap-toolbar-group">
            <ToolbarBtn onClick={() => toggleListTypeForSelection(editor, 'orderedList')} active={innermostListType(editor) === 'orderedList'} title="Task List / Numbered List (1. Task)">
              <ListOrdered size={13} />
            </ToolbarBtn>
            <ToolbarBtn onClick={() => toggleListTypeForSelection(editor, 'bulletList')} active={innermostListType(editor) === 'bulletList'} title="Subtask / Bullet List (- Subtask)">
              <List size={13} />
            </ToolbarBtn>
            <ToolbarBtn onClick={() => editor?.chain().focus().liftListItem('listItem').run()} disabled={!editor?.can().liftListItem('listItem')} title="Outdent (Shift+Tab)">
              <IndentDecrease size={13} />
            </ToolbarBtn>
            <ToolbarBtn onClick={() => editor?.chain().focus().sinkListItem('listItem').run()} disabled={!editor?.can().sinkListItem('listItem')} title="Indent: make a subtask of the item above (Tab)">
              <IndentIncrease size={13} />
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

      <div className="swimlane-editor-area">
        {/* Editor Scroll Container */}
        <div
          className="obsidian-editor-container obsidian-scroll-area"
          style={{
            flex: 1,
            overflowY: 'auto',
            // Room below the last task so the add-task button never covers it.
            paddingBottom: `${(isActive && isAssistantOpen ? assistantDrawerHeight : 0) + 72}px`,
          }}
          onMouseDown={(e) => {
            // Empty space around the tasks belongs to the editor: a click there puts the caret at the end, so typing
            // and Backspace never land on the page itself. (Clicks on the scrollbar are left alone.)
            const container = e.currentTarget;
            const onScrollbar = e.clientX - container.getBoundingClientRect().left >= container.clientWidth;
            if (!editor || onScrollbar || (e.target as HTMLElement).closest('.ProseMirror')) return;
            e.preventDefault();
            editor.commands.focus('end');
          }}
        >
          <EditorContent editor={editor} className="tiptap-editor-root" />
        </div>

        {/* Add a new task to the end of this lane's task list */}
        <button
          type="button"
          className="add-task-fab"
          style={{ bottom: `${(isActive && isAssistantOpen ? assistantDrawerHeight : 0) + 16}px` }}
          onClick={(e) => {
            e.stopPropagation();
            onActivate();
            if (editor) {
              editor.commands.focus();
              handleAddNewCard(editor);
            }
          }}
          title="Add new task"
          aria-label="Add new task"
        >
          <Plus size={20} strokeWidth={2.5} />
        </button>
      </div>

      {/* ── Human AI Assistant Slide-up Bar / Drawer (rendered only within selected lane) ── */}
      {isActive && project && aiConfig && (
        <HumanAiAssistantModal
          isOpen={isAssistantOpen}
          onClose={onCloseAssistant || (() => { })}
          project={project}
          todoMarkdown={lane.markdown}
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

      <TaskCommandMenu
        ref={commandMenuRef}
        command={taskCommand}
        root={projectWorkingFolder(project)}
        skills={workspaceSkills}
        onPickSkill={(slug) => {
          if (editor && taskCommand) insertSkillCommand(editor.view, taskCommand, slug);
        }}
        onPickFiles={(paths) => {
          if (editor && taskCommand) insertFileReferences(editor.view, taskCommand, paths);
        }}
        onClose={() => setTaskCommand(null)}
      />

      {/* Freeform Selection "Run" & Style Controls Floating Tooltip */}
      {selectionTooltip && selectionTooltip.visible && typeof document !== 'undefined' && createPortal(
        <div
          className={`selection-run-tooltip ${selectionToolsExpanded ? '' : 'is-chip'}`}
          style={{
            top: `${selectionTooltip.y}px`,
            left: `${selectionTooltip.x}px`,
          }}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onMouseLeave={() => {
            if (!colorPaletteOpen) setSelectionToolsExpanded(false);
          }}
        >
          {!selectionToolsExpanded ? (
            <button
              type="button"
              className="selection-tools-chip"
              title="Selection tools"
              aria-label="Show selection tools"
              aria-expanded="false"
              onMouseEnter={() => setSelectionToolsExpanded(true)}
              onFocus={() => setSelectionToolsExpanded(true)}
              onClick={() => setSelectionToolsExpanded(true)}
            >
              <ChevronDown size={12} strokeWidth={2.5} />
            </button>
          ) : (<>
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

          {/* Color: a header's color when the selection is in a header, otherwise the selected text's */}
          <div className="selection-color-wrapper">
            <button
              type="button"
              className={`selection-tooltip-btn ${colorPaletteOpen || editor?.isActive('textColor') ? 'is-active' : ''}`}
              onClick={() => setColorPaletteOpen((o) => !o)}
              title={selectionHeadingPos() != null ? 'Header color' : 'Text color'}
            >
              <Palette size={13} />
            </button>
            {colorPaletteOpen && (
              <div className="selection-color-palette" role="menu">
                {HEADER_COLORS.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    role="menuitem"
                    title={c.label}
                    aria-label={c.label}
                    className={`hdr-color-swatch ${currentSelectionColor() === c.id ? 'is-active' : ''}`}
                    style={{ background: c.hex }}
                    onClick={() => applySelectionColor(c.id)}
                  />
                ))}
                {selectionHeadingPos() == null && (
                  <button
                    type="button"
                    role="menuitem"
                    title="Remove color"
                    aria-label="Remove color"
                    className="hdr-color-swatch is-clear"
                    onClick={() => applySelectionColor(null)}
                  >
                    <X size={11} />
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Subtask (Bullet) */}
          <button
            type="button"
            className={`selection-tooltip-btn ${innermostListType(editor) === 'bulletList' ? 'is-active' : ''}`}
            onClick={() => toggleListTypeForSelection(editor, 'bulletList')}
            title="Subtask / Bullet List (- item)"
          >
            <List size={13} />
          </button>
          </>)}
        </div>,
        document.body
      )}

      {isRulesOpen && <ScopedRulesModal laneId={lane.id} laneTitle={lane.title} onClose={() => setIsRulesOpen(false)} />}
      {batchModal && (
        <BatchRunModal
          key={batchModal.openedAt}
          isOpen
          tasks={laneTasks}
          initialSelectedIds={batchModal.selectedIds}
          onClose={() => setBatchModal(null)}
          onConfirm={(selected, mode) => onRunTasks?.(selected, lane.id, lane.title, mode)}
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
  aiConfig?: AIProviderConfig;
  mcpServers?: MCPServer[];
  onApplyAssistantResult?: (result: HumanAiAssistantResult, confirmedDeletions: boolean) => void;
  onArchiveTask?: (taskTitle: string) => void;
  /** Opens the Archives & Learnings screen. */
  onOpenArchives?: () => void;
  swimLanes?: SwimLaneDoc[];
  onAddSwimLane?: (afterLaneId?: string) => void;
  onRenameSwimLane?: (laneId: string, newTitle: string) => void;
  onDeleteSwimLane?: (laneId: string) => void;
  onSwimLaneMarkdownChange?: (laneId: string, newMarkdown: string) => void;
  onCreateTaskFromSelection?: (selectedText: string, laneId: string, laneTitle: string, sourceTask?: TaskItemType) => void;
  /** Run several tasks of a lane: one after another (queued) or all at once. */
  onRunTasks?: (tasks: TaskItemType[], laneId: string, laneTitle: string, mode: BatchRunMode) => void;
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
  aiConfig,
  mcpServers = [],
  onApplyAssistantResult = () => { },
  onArchiveTask,
  onOpenArchives,
  swimLanes,
  onAddSwimLane,
  onRenameSwimLane,
  onDeleteSwimLane,
  onSwimLaneMarkdownChange,
  onCreateTaskFromSelection,
  onRunTasks,
  onScheduleTask,
  autocompleteSettings = { enabled: true, keybinding: 'Tab' },
  onUpdateTaskMcpTools: _onUpdateTaskMcpTools,
}) => {
  // Formatting bar: on unless the user has hidden it.
  const [showStyles, setShowStyles] = useState(readShowFormattingBar);
  useEffect(() => subscribePrefs(() => setShowStyles(readShowFormattingBar())), []);
  const toggleStyles = () => {
    setShowStyles((prev) => {
      setPref(FORMATTING_BAR_PREF, prev ? 'hidden' : 'shown');
      return !prev;
    });
  };
  const [assistantDrawerHeight, setAssistantDrawerHeight] = useState<number>(0);
  const [isHeaderMenuOpen, setIsHeaderMenuOpen] = useState(false);
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
              onToggleStyles={toggleStyles}
              onSelectTask={onSelectTask}
              onMarkdownChange={handleLaneMarkdownChange}
              onRenameSwimLane={onRenameSwimLane}
              onDeleteSwimLane={onDeleteSwimLane}
              onAddSwimLaneAfter={(laneId) => onAddSwimLane?.(laneId)}
              onOpenArchivedTasks={onOpenArchives}
              archivedTasksCount={archivedTasks.length}
              onArchiveTask={onArchiveTask}
              onCreateTaskFromSelection={onCreateTaskFromSelection}
              onRunTasks={onRunTasks}
              onScheduleTask={onScheduleTask}
              assistantDrawerHeight={assistantDrawerHeight}
              onEditorReady={handleEditorReady}
              isAssistantOpen={isAssistantOpen}
              onOpenAssistant={onOpenDraftModal}
              onCloseAssistant={onCloseAssistant}
              project={project}
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


    </div>
  );
};
