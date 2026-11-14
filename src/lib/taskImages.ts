/**
 * Screenshots in tasks. In the document they show as small thumbnails (document.css); clicking one opens it full size
 * in a lightbox (ImageLightbox.tsx), with the task's other images a key press away; the selected task also shows its
 * images in the right margin (TaskPane's line decorations). The markdown is unchanged: `![alt](src)` on its own line.
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';

export interface TaskImage {
  src: string;
  alt: string;
}

/** Every image inside `node` (a task's list item, sub-items included), in document order. */
export function collectImages(node: PMNode): TaskImage[] {
  const out: TaskImage[] = [];
  node.descendants((child) => {
    if (child.type.name === 'image' && child.attrs.src) out.push({ src: String(child.attrs.src), alt: String(child.attrs.alt || '') });
    return true;
  });
  return out;
}

/** The images of the task around `pos` (its outermost list item), or just the block at `pos` outside a list. */
export function imagesAround(doc: PMNode, pos: number): { images: TaskImage[]; start: number } {
  const $pos = doc.resolve(pos);
  for (let d = 1; d <= $pos.depth; d++) {
    if ($pos.node(d).type.name === 'listItem') return { images: collectImages($pos.node(d)), start: $pos.before(d) };
  }
  const node = doc.nodeAt(pos);
  const own = node && node.type.name === 'image' && node.attrs.src ? [{ src: String(node.attrs.src), alt: String(node.attrs.alt || '') }] : [];
  return { images: own, start: pos };
}

/**
 * Inserts an image the way a screenshot is attached to a line: below the caret's line (after its text block, before
 * its sub-items) instead of splitting the line, and the caret stays where it was. Outside a text block, it replaces
 * the selection.
 */
export function insertTaskImage(view: EditorView, attrs: { src: string; alt: string }) {
  const { state } = view;
  const image = state.schema.nodes.image?.create(attrs);
  if (!image) return;
  const { $from } = state.selection;
  if ($from.parent.isTextblock && $from.depth > 0 && !$from.parent.type.spec.code) {
    // After the line's text and any images already attached to it, so they stay in the order they were added.
    const container = $from.node($from.depth - 1);
    let at = $from.after();
    for (let i = $from.index($from.depth - 1) + 1; i < container.childCount && container.child(i).type.name === 'image'; i++) {
      at += container.child(i).nodeSize;
    }
    const tr = state.tr.insert(at, image);
    view.dispatch(tr.scrollIntoView());
  } else {
    view.dispatch(state.tr.replaceSelectionWith(image).scrollIntoView());
  }
  view.focus();
}

/** Click an image in the document: opens the lightbox on it, with the rest of its task's images. */
export function createImageLightboxExtension(name: string, onOpen: { current: ((images: TaskImage[], index: number) => void) | null }) {
  return Extension.create({
    name,
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: new PluginKey(name),
          props: {
            handleClickOn(view, _pos, node, nodePos, event, direct) {
              if (!direct || node.type.name !== 'image' || event.button !== 0 || event.shiftKey) return false;
              const { images, start } = imagesAround(view.state.doc, nodePos);
              if (!images.length) return false;
              // Which of the task's images this is: count the images before it.
              let index = 0;
              view.state.doc.nodesBetween(start, nodePos, (child, childPos) => {
                if (child.type.name === 'image' && childPos < nodePos) index++;
                return true;
              });
              onOpen.current?.(images, Math.min(index, images.length - 1));
              // Still let the click select the image (so Backspace deletes it after the lightbox closes).
              return false;
            },
          },
        }),
      ];
    },
  });
}
