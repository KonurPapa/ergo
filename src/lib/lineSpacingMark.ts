import { Paragraph } from '@tiptap/extension-paragraph';

/**
 * Per-paragraph line spacing (Google Docs style).
 *
 * Encoding (in TODO.md): a trailing token on the paragraph's last line, `Some text {spacing=1.5}`.
 * Plain text, so it survives the markdown round-trip with html disabled. Absent token = default spacing.
 */

export const LINE_SPACINGS = ['1', '1.15', '1.5', '2'] as const;

const TOKEN_RE = /\s*\{spacing=(1|1\.15|1\.5|2)\}$/;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lineSpacingMarkdownIt(md: any) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  md.core.ruler.push('line_spacing', (state: any) => {
    const tokens = state.tokens;
    for (let i = 0; i + 1 < tokens.length; i++) {
      const open = tokens[i];
      const inline = tokens[i + 1];
      if (open.type !== 'paragraph_open' || inline.type !== 'inline') continue;
      const m = inline.content.match(TOKEN_RE);
      if (!m) continue;
      inline.content = inline.content.slice(0, m.index);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const last = inline.children?.[inline.children.length - 1];
      if (last && last.type === 'text') last.content = last.content.replace(TOKEN_RE, '');
      open.attrSet('data-line-spacing', m[1]);
    }
  });
}

export const LineSpacingParagraph = Paragraph.extend({
  addAttributes() {
    return {
      lineSpacing: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-line-spacing'),
        renderHTML: (attrs: { lineSpacing?: string | null }) =>
          attrs.lineSpacing ? { 'data-line-spacing': attrs.lineSpacing, style: `line-height: ${attrs.lineSpacing}` } : {},
      },
    };
  },

  addStorage() {
    return {
      markdown: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        serialize(state: any, node: any) {
          state.renderInline(node);
          const spacing = node.attrs.lineSpacing;
          if (spacing && node.content.size > 0) state.text(` {spacing=${spacing}}`, false);
          state.closeBlock(node);
        },
        parse: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          setup(markdownit: any) {
            markdownit.use(lineSpacingMarkdownIt);
          },
        },
      },
    };
  },
});
