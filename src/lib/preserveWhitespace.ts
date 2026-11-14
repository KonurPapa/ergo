/**
 * Keeps the human workspace's whitespace exactly as typed through the markdown round-trip.
 *
 * Markdown drops blank lines and trims or collapses spaces when the file is read back (leading / trailing spaces,
 * runs of spaces). So spaces markdown would lose are written as `&nbsp;`, and a deliberately blank line as a lone
 * `&nbsp;` line. markdown-it decodes the entity on load (html can stay disabled), giving the same text back.
 */

export const NBSP_ENTITY = '&nbsp;';

const CODE_SPAN_RE = /(`+[^`]*`+)/;

function encodeSpaces(text: string): string {
  return text
    .split(CODE_SPAN_RE)
    .map((part, i) => {
      if (i % 2 === 1) return part; // inside `code`: spaces are kept as is
      return part
        .replace(/ /g, NBSP_ENTITY)
        // A run of spaces inside a line: one real space, the rest kept as entities.
        .replace(/([^\n ]) {2,}/g, (m, c: string) => `${c} ${NBSP_ENTITY.repeat(m.length - 2)}`);
    })
    .join('')
    .replace(/^ +/, (m) => NBSP_ENTITY.repeat(m.length))
    .replace(/ +$/, (m) => NBSP_ENTITY.repeat(m.length));
}

/** Renders a textblock's inline content (as `state.renderInline` does) with its spaces kept. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function renderInlineKeepingSpaces(state: any, node: any) {
  if (node.content.size === 0) return;
  state.write(''); // flush the pending block separator and list indent, so only this block's text is rewritten
  const start = state.out.length;
  state.renderInline(node, false);
  state.out = state.out.slice(0, start) + encodeSpaces(state.out.slice(start));
}

/**
 * Whether an empty paragraph is a blank line the user made (kept as a `&nbsp;` line). A task with no text yet
 * (first block of a list item) and the editor's own trailing empty paragraph are left empty, unless the task holds a
 * code block or image under its empty title.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isKeptBlankLine(node: any, parent: any, index: number): boolean {
  if (node.content.size > 0 || !parent) return false;
  // A task's empty title above its code block or image is kept (as `&nbsp;`), or the task would load back without one.
  if (parent.type.name === 'listItem' && index === 0) {
    const next = parent.childCount > 1 ? parent.child(1) : null;
    return !!next && (next.type.name === 'codeBlock' || next.type.name === 'image');
  }
  if (parent.type.name === 'doc' && index === parent.childCount - 1) return false;
  return true;
}

/** markdown-it rule: a paragraph holding only `&nbsp;` is a kept blank line, so it loads as an empty paragraph. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function blankLineMarkdownIt(md: any) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  md.core.ruler.push('kept_blank_line', (state: any) => {
    const tokens = state.tokens;
    for (let i = 0; i + 1 < tokens.length; i++) {
      if (tokens[i].type !== 'paragraph_open' || tokens[i + 1].type !== 'inline') continue;
      if (tokens[i + 1].content.trim() !== NBSP_ENTITY) continue;
      tokens[i + 1].content = '';
      tokens[i + 1].children = [];
      // In a tight list the paragraph is rendered bare (hidden); an empty bare paragraph renders as nothing, and a
      // task's empty title above its code block was lost. Render it as a real (empty) paragraph, and mark the list
      // tight explicitly, since a <p> in it would otherwise read as a loose list.
      if (tokens[i].hidden) {
        tokens[i].hidden = false;
        if (tokens[i + 2]?.type === 'paragraph_close') tokens[i + 2].hidden = false;
        for (let j = i - 1; j >= 0; j--) {
          if (tokens[j].level === tokens[i].level - 2 && /_list_open$/.test(tokens[j].type)) {
            tokens[j].attrSet('data-tight', 'true');
            break;
          }
        }
      }
    }
  });
}
