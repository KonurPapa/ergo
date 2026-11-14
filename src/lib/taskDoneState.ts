/**
 * A task (or sub-item) is done when its line is struck through. Its "line" is the list item's own text: the title
 * paragraph and any other paragraphs it holds, not its nested sub-items. Code blocks and images in a task can't be
 * struck (code text takes no marks), so they don't count either way: a task with a code block or a screenshot is done
 * when its text is.
 *
 * In markdown the same rule reads `1. ~~Fix the parser~~` followed by the task's fenced code / image lines untouched;
 * parser.ts decides done-ness from the title line and skips fenced code, so the two always agree.
 */
import type { MarkType, Node as PMNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';

export const isListNode = (node: PMNode | null | undefined): boolean =>
  !!node && (node.type.name === 'bulletList' || node.type.name === 'orderedList');

/** Blocks a strikethrough can't reach: code blocks and images. They never decide whether a task is done. */
export const isUnstrikeableBlock = (node: PMNode): boolean =>
  node.type.name === 'codeBlock' || node.type.name === 'image' || !!node.type.spec.code;

/** Whether a block's text is all struck through (text inside code blocks and images ignored). Empty text is not done. */
export function isTextStruck(node: PMNode | null | undefined): boolean {
  if (!node || isUnstrikeableBlock(node)) return false;
  let hasText = false;
  let allStruck = true;
  node.descendants((child) => {
    if (isUnstrikeableBlock(child)) return false;
    if (child.isText) {
      hasText = true;
      if (!child.marks.some((m) => m.type.name === 'strike')) allStruck = false;
    }
    return true;
  });
  return hasText && allStruck;
}

/** A list item's title line: its first own block that can hold struck text (not a sub-list, code block or image). */
export function taskTitleBlock(item: PMNode): { node: PMNode; offset: number } | null {
  let found: { node: PMNode; offset: number } | null = null;
  item.forEach((child, offset) => {
    if (!found && !isListNode(child) && !isUnstrikeableBlock(child)) found = { node: child, offset };
  });
  return found;
}

/** Whether a task / sub-item list item is checked off: its title line is struck through. */
export function isTaskItemChecked(item: PMNode | null | undefined): boolean {
  if (!item || item.type.name !== 'listItem') return false;
  const title = taskTitleBlock(item);
  return !!title && isTextStruck(title.node);
}

/**
 * Strikes (or un-strikes) a list item's own text: every block of it except its sub-lists. Code blocks and images in
 * the range take no mark, so they're left as they are. With `withSubItems`, the item's direct sub-items too.
 */
export function setTaskItemDone(tr: Transaction, itemPos: number, done: boolean, strike: MarkType, withSubItems = false) {
  const item = tr.doc.nodeAt(itemPos);
  if (!item || item.type.name !== 'listItem') return;
  const apply = (from: number, to: number) => (done ? tr.addMark(from, to, strike.create()) : tr.removeMark(from, to, strike));
  item.forEach((child, offset) => {
    const childPos = itemPos + 1 + offset;
    if (!isListNode(child)) {
      apply(childPos, childPos + child.nodeSize);
    } else if (withSubItems) {
      child.forEach((sub, subOffset) => {
        const subPos = childPos + 1 + subOffset;
        sub.forEach((subChild, subChildOffset) => {
          if (isListNode(subChild)) return;
          const from = subPos + 1 + subChildOffset;
          apply(from, from + subChild.nodeSize);
        });
      });
    }
  });
}
