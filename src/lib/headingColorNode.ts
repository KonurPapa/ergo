import { Heading } from '@tiptap/extension-heading';
import { InputRule } from '@tiptap/core';
import { getHeaderColor, HEADER_COLOR_TOKEN_RE } from './headerColors';
import { renderInlineKeepingSpaces } from './preserveWhitespace';

/**
 * Group header color, held as a heading attribute while editing.
 *
 * Encoding (in TODO.md) is unchanged: a trailing `{color=id}` token on the heading line (see headerColors.ts).
 * The token is stripped on parse and written back on serialize, so it is never part of the editable text: the
 * caret can't land behind a hidden token, and typing at the end of a header can't break it.
 * Power users can still set a color by typing the token itself at the end of a header, e.g. `{color=teal}`.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function headingColorMarkdownIt(md: any) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  md.core.ruler.push('heading_color', (state: any) => {
    const tokens = state.tokens;
    for (let i = 0; i + 1 < tokens.length; i++) {
      const open = tokens[i];
      const inline = tokens[i + 1];
      if (open.type !== 'heading_open' || inline.type !== 'inline') continue;
      const m = inline.content.match(HEADER_COLOR_TOKEN_RE);
      if (!m || !getHeaderColor(m[1])) continue;
      inline.content = inline.content.slice(0, m.index);
      const last = inline.children?.[inline.children.length - 1];
      if (last && last.type === 'text') last.content = last.content.replace(HEADER_COLOR_TOKEN_RE, '');
      open.attrSet('data-hdr-color', m[1].toLowerCase());
    }
  });
}

export const ColorHeading = Heading.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      color: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-hdr-color'),
        renderHTML: (attrs: { color?: string | null }) => (attrs.color ? { 'data-hdr-color': attrs.color } : {}),
      },
    };
  },

  addInputRules() {
    return [
      ...(this.parent?.() ?? []),
      // `{color=id}` typed at the end of a header recolors it (the token itself is removed).
      new InputRule({
        find: /\s*\{color=([a-z]+)\}$/i,
        handler: ({ state, range, match }) => {
          const { $from } = state.selection;
          if ($from.parent.type.name !== this.name || !getHeaderColor(match[1])) return null;
          state.tr.delete(range.from, range.to);
          state.tr.setNodeAttribute($from.before(), 'color', match[1].toLowerCase());
        },
      }),
    ];
  },

  addStorage() {
    return {
      markdown: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        serialize(state: any, node: any) {
          state.write(state.repeat('#', node.attrs.level) + ' ');
          renderInlineKeepingSpaces(state, node);
          if (node.attrs.color && node.content.size > 0) state.text(` {color=${node.attrs.color}}`, false);
          state.closeBlock(node);
        },
        parse: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          setup(markdownit: any) {
            markdownit.use(headingColorMarkdownIt);
          },
        },
      },
    };
  },
});
