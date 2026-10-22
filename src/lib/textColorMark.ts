import { Mark } from '@tiptap/core';
import { getHeaderColor } from './headerColors';

/**
 * Inline text color, using the same palette as group headers.
 *
 * Encoding (in TODO.md): `{color=red}some text{/color}`. Plain text like the header `{color=id}` token,
 * so it survives the editor's markdown round-trip with html disabled.
 */

const OPEN_RE = /^\{color=([a-z]+)\}/i;
const CLOSE = '{/color}';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function textColorMarkdownIt(md: any) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  md.inline.ruler.before('emphasis', 'text_color', (state: any, silent: boolean) => {
    if (state.src.charCodeAt(state.pos) !== 0x7b /* { */) return false;
    const rest = state.src.slice(state.pos);
    const open = rest.match(OPEN_RE);
    if (open) {
      // A header's trailing `{color=id}` has no closer, so it stays plain text.
      if (!getHeaderColor(open[1]) || !rest.includes(CLOSE, open[0].length)) return false;
      if (!silent) state.push('text_color_open', 'span', 1).attrSet('data-text-color', open[1].toLowerCase());
      state.pos += open[0].length;
      return true;
    }
    if (rest.startsWith(CLOSE)) {
      if (!silent) state.push('text_color_close', 'span', -1);
      state.pos += CLOSE.length;
      return true;
    }
    return false;
  });
}

export const TextColor = Mark.create({
  name: 'textColor',

  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-text-color'),
        renderHTML: (attrs: { color?: string | null }) => {
          const color = getHeaderColor(attrs.color);
          if (!color) return {};
          return { 'data-text-color': color.id, class: 'text-colored', style: `--text-color: ${color.hex}` };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-text-color]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', HTMLAttributes, 0];
  },

  addStorage() {
    return {
      markdown: {
        serialize: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          open: (_state: any, mark: any) => `{color=${mark.attrs.color}}`,
          close: CLOSE,
          mixable: true,
          expelEnclosingWhitespace: true,
        },
        parse: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          setup(markdownit: any) {
            markdownit.use(textColorMarkdownIt);
          },
        },
      },
    };
  },
});

