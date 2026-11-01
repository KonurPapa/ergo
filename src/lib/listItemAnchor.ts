/**
 * The editor side of task anchors (taskAnchors.ts): a list item carries its line's `<!-- ergo:id -->` as a hidden
 * `ergoId` attribute. It is read from the markdown, written back at the end of the item's first line, kept when the
 * item moves, and not copied when a line is split. Every top-level item (a task) gets one; a line that lost its
 * anchor gets back the one its text had before, so its brief stays attached.
 */
import ListItem from '@tiptap/extension-list-item';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { ANCHOR_RE, anchorComment, anchorIdFor } from './taskAnchors';

/** markdown-it: take `<!-- ergo:id -->` off the first line of a list item and put it on the item as data-ergo-id. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function anchorMarkdownIt(md: any) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  md.core.ruler.after('block', 'ergo_task_anchor', (state: any) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok.type !== 'inline' || !ANCHOR_RE.test(tok.content)) continue;
      const m = tok.content.match(ANCHOR_RE);
      tok.content = tok.content.replace(ANCHOR_RE, '');
      // The item's first block: list_item_open, paragraph_open, inline.
      if (i >= 2 && tokens[i - 1].type === 'paragraph_open' && tokens[i - 2].type === 'list_item_open') {
        tokens[i - 2].attrSet('data-ergo-id', m[1].toLowerCase());
      }
    }
  });
}

const isTopLevelItem = (doc: PMNode, pos: number) => {
  const $pos = doc.resolve(pos);
  for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).type.name === 'listItem') return false;
  return $pos.parent.type.name === 'orderedList' || $pos.parent.type.name === 'bulletList';
};

const itemKey = (node: PMNode) => (node.firstChild?.textContent || '').trim().toLowerCase().replace(/\s+/g, ' ');

const anchorPluginKey = new PluginKey('ergoTaskAnchors');

export const AnchoredListItem = ListItem.extend({
  content: 'block+',

  addAttributes() {
    return {
      ...this.parent?.(),
      ergoId: {
        default: null,
        // A split line is a new task: it gets its own anchor.
        keepOnSplit: false,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-ergo-id'),
        renderHTML: () => ({}),
      },
    };
  },

  addStorage() {
    return {
      markdown: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        serialize(state: any, node: PMNode) {
          const id = node.attrs.ergoId as string | null;
          const first = node.firstChild;
          if (!id || !first) {
            state.renderContent(node);
            return;
          }
          // The anchor goes at the end of the item's first line: just before its first block closes.
          const closeBlock = state.closeBlock;
          let written = false;
          state.closeBlock = function (this: unknown, n: PMNode) {
            if (!written && n === first) {
              written = true;
              state.write(` ${anchorComment(id)}`);
            }
            return closeBlock.call(state, n);
          };
          try {
            state.renderContent(node);
          } finally {
            state.closeBlock = closeBlock;
          }
        },
        parse: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          setup(markdownit: any) {
            markdownit.use(anchorMarkdownIt);
          },
        },
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      ...(this.parent?.() ?? []),
      new Plugin({
        key: anchorPluginKey,
        appendTransaction(transactions, oldState, newState) {
          if (!transactions.some((t) => t.docChanged)) return null;
          // Anchors the old document had, by item text, that the new one no longer carries.
          const present = new Set<string>();
          newState.doc.descendants((node) => {
            if (node.type.name === 'listItem' && node.attrs.ergoId) present.add(node.attrs.ergoId);
            return true;
          });
          const reusable = new Map<string, string[]>();
          oldState.doc.descendants((node, pos) => {
            if (node.type.name !== 'listItem') return true;
            const id = node.attrs.ergoId as string | null;
            if (id && !present.has(id) && isTopLevelItem(oldState.doc, pos)) {
              const k = itemKey(node);
              reusable.set(k, [...(reusable.get(k) ?? []), id]);
            }
            return true;
          });

          const taken = new Set<string>(present);
          const seen = new Set<string>();
          const occurrences = new Map<string, number>();
          const tr = newState.tr;
          newState.doc.descendants((node, pos) => {
            if (node.type.name !== 'listItem') return true;
            if (!isTopLevelItem(newState.doc, pos)) return true;
            const key = itemKey(node);
            const nth = (occurrences.get(key) ?? 0) + 1;
            occurrences.set(key, nth);
            const id = node.attrs.ergoId as string | null;
            if (id && !seen.has(id)) {
              seen.add(id);
              return true;
            }
            const reuse = reusable.get(key)?.find((r) => !taken.has(r));
            // Derived from the line's text, like the load-time migration's, so the two never disagree.
            const next = reuse ?? anchorIdFor(`${key}|${nth}`, taken);
            seen.add(next);
            taken.add(next);
            tr.setNodeAttribute(pos, 'ergoId', next);
            return true;
          });
          return tr.docChanged ? tr.setMeta('addToHistory', false) : null;
        },
      }),
    ];
  },
});
