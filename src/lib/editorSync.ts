/**
 * Keeps a lane editor in step with markdown that changed outside it (the file on disk, an AI check-off) without
 * moving the user's caret. A whole-document setContent threw the caret to the end of the task list.
 *
 * Only the part that differs is replaced. Edits the app hasn't seen yet (typing inside the save debounce) are kept
 * when the outside change is elsewhere in the document; when both touch the same part, the outside version wins.
 */
import { createDocument } from '@tiptap/core';
import { Fragment, Mark, type Node as PMNode } from '@tiptap/pm/model';
import { ReplaceStep } from '@tiptap/pm/transform';

// The editor's own plugins change a freshly parsed document in two ways that aren't edits: headers get a color
// (HeaderColorExtension) and a trailing empty paragraph is added (TrailingNode). Diffs ignore both.
function sameMarkup(a: PMNode, b: PMNode): boolean {
  if (a.type !== b.type || a.type.name !== 'heading') return a.sameMarkup(b);
  const { color: colorA, ...restA } = a.attrs;
  const { color: colorB, ...restB } = b.attrs;
  if (colorA && colorB && colorA !== colorB) return false;
  return JSON.stringify(restA) === JSON.stringify(restB) && Mark.sameSet(a.marks, b.marks);
}

// Fragment.findDiffStart / findDiffEnd from prosemirror-model, comparing markup with `sameMarkup` above.
function findDiffStart(a: Fragment, b: Fragment, pos: number): number | null {
  for (let i = 0; ; i++) {
    if (i === a.childCount || i === b.childCount) return a.childCount === b.childCount ? null : pos;
    const childA = a.child(i);
    const childB = b.child(i);
    if (childA === childB) {
      pos += childA.nodeSize;
      continue;
    }
    if (!sameMarkup(childA, childB)) return pos;
    if (childA.isText && childA.text !== childB.text) {
      for (let j = 0; childA.text![j] === childB.text![j]; j++) pos++;
      return pos;
    }
    if (childA.content.size || childB.content.size) {
      const inner = findDiffStart(childA.content, childB.content, pos + 1);
      if (inner != null) return inner;
    }
    pos += childA.nodeSize;
  }
}

function findDiffEnd(a: Fragment, b: Fragment, posA: number, posB: number): { a: number; b: number } | null {
  for (let iA = a.childCount, iB = b.childCount; ;) {
    if (iA === 0 || iB === 0) return iA === iB ? null : { a: posA, b: posB };
    const childA = a.child(--iA);
    const childB = b.child(--iB);
    const size = childA.nodeSize;
    if (childA === childB) {
      posA -= size;
      posB -= size;
      continue;
    }
    if (!sameMarkup(childA, childB)) return { a: posA, b: posB };
    if (childA.isText && childA.text !== childB.text) {
      const textA = childA.text!;
      const textB = childB.text!;
      let same = 0;
      const minSize = Math.min(textA.length, textB.length);
      while (same < minSize && textA[textA.length - same - 1] === textB[textB.length - same - 1]) {
        same++;
        posA--;
        posB--;
      }
      return { a: posA, b: posB };
    }
    if (childA.content.size || childB.content.size) {
      const inner = findDiffEnd(childA.content, childB.content, posA - 1, posB - 1);
      if (inner) return inner;
    }
    posA -= size;
    posB -= size;
  }
}

/** The single replace step that turns one document into another, or null when they're the same. */
function docDiffStep(from: PMNode, to: PMNode): ReplaceStep | null {
  const start = findDiffStart(from.content, to.content, 0);
  if (start == null) return null;
  let { a: endA, b: endB } = findDiffEnd(from.content, to.content, from.content.size, to.content.size)!;
  // When the change repeats the text around it, both ends can run past the start; widen them by the overlap.
  const overlap = start - Math.min(endA, endB);
  if (overlap > 0) {
    endA += overlap;
    endB += overlap;
  }
  return new ReplaceStep(start, endA, to.slice(start, endB));
}

/**
 * Brings the editor up to date with `markdown` (the lane's body, header comments already stripped). `baseDoc` is
 * the document the app last saw. Returns the new base document.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyExternalMarkdown(editor: any, markdown: string, baseDoc: PMNode | null): PMNode {
  let incoming: PMNode = createDocument(editor.storage.markdown.parser.parse(markdown), editor.schema);
  const paragraph = editor.schema.nodes.paragraph;
  if (paragraph && incoming.lastChild?.type !== paragraph) {
    incoming = incoming.copy(incoming.content.append(Fragment.from(paragraph.create())));
  }
  const current: PMNode = editor.state.doc;
  const local = baseDoc ? docDiffStep(baseDoc, current) : null;
  const remote = local ? docDiffStep(baseDoc!, incoming) : null;
  if (local && !remote) return incoming; // nothing changed outside since the base; the editor's edits go out as usual

  const tr = editor.state.tr;
  const rebased = remote && local && (remote.to < local.from || remote.from > local.to) ? remote.map(local.getMap()) : null;
  const kept = !!rebased && !tr.maybeStep(rebased).failed;
  if (!kept) {
    const whole = docDiffStep(current, incoming);
    if (whole) tr.step(whole);
  }
  if (tr.docChanged) editor.view.dispatch(tr.setMeta('preventUpdate', true).setMeta('addToHistory', false));
  return kept ? remote!.apply(baseDoc!).doc ?? incoming : incoming;
}
