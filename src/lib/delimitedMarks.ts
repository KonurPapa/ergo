import { Mark, markInputRule, markPasteRule } from '@tiptap/core';
import { Underline } from '@tiptap/extension-underline';

/**
 * Underline and highlight, which markdown has no syntax for.
 *
 * Encoding (in TODO.md): `++underlined++` and `==highlighted==` (the markdown-it-ins / -mark conventions, also
 * Obsidian's highlight). Plain text like the other editor tokens, so they survive the markdown round-trip with html
 * disabled. A delimiter only opens before a non-space and closes after one, so text like `C++ and C++` stays text.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function delimitedMarkdownIt(delim: string, tokenName: string, tag: string) {
  const first = delim.charCodeAt(0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (md: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    md.inline.ruler.before('emphasis', tokenName, (state: any, silent: boolean) => {
      const start = state.pos;
      if (state.src.charCodeAt(start) !== first || !state.src.startsWith(delim, start)) return false;
      const contentStart = start + delim.length;
      if (/\s/.test(state.src[contentStart] ?? ' ')) return false;
      const end = state.src.indexOf(delim, contentStart + 1);
      if (end < 0 || end + delim.length > state.posMax || /\s/.test(state.src[end - 1])) return false;
      if (!silent) {
        state.push(`${tokenName}_open`, tag, 1);
        const oldMax = state.posMax;
        state.pos = contentStart;
        state.posMax = end;
        state.md.inline.tokenize(state);
        state.posMax = oldMax;
        state.push(`${tokenName}_close`, tag, -1);
      }
      state.pos = end + delim.length;
      return true;
    });
  };
}

function markdownStorage(delim: string, tokenName: string, tag: string) {
  return {
    markdown: {
      serialize: { open: delim, close: delim, mixable: true, expelEnclosingWhitespace: true },
      parse: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setup(markdownit: any) {
          markdownit.use(delimitedMarkdownIt(delim, tokenName, tag));
        },
      },
    },
  };
}

export const MarkdownUnderline = Underline.extend({
  addStorage() {
    return markdownStorage('++', 'underline', 'u');
  },
});

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    highlight: {
      toggleHighlight: () => ReturnType;
    };
  }
}

export const Highlight = Mark.create({
  name: 'highlight',

  parseHTML() {
    return [{ tag: 'mark' }];
  },

  renderHTML() {
    return ['mark', { class: 'text-highlight' }, 0];
  },

  addCommands() {
    return {
      toggleHighlight: () => ({ commands }) => commands.toggleMark(this.name),
    };
  },

  addKeyboardShortcuts() {
    return {
      'Mod-Shift-h': () => this.editor.commands.toggleHighlight(),
    };
  },

  addInputRules() {
    return [markInputRule({ find: /(?:^|\s)(==(?!\s)([^=]+?)(?<!\s)==)$/, type: this.type })];
  },

  addPasteRules() {
    return [markPasteRule({ find: /(?:^|\s)(==(?!\s)([^=]+?)(?<!\s)==)/g, type: this.type })];
  },

  addStorage() {
    return markdownStorage('==', 'highlight', 'mark');
  },
});
