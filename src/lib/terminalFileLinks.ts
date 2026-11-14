/**
 * File paths in an agent's terminal open in the user's editor (Ctrl/Cmd-click not needed: xterm underlines a link on
 * hover and a click opens it). Relative paths resolve against the agent's working folder.
 */
import type { IDisposable, Terminal } from '@xterm/xterm';
import { findFileRefs } from './fileLinks';
import { openFileRef } from './ideLinks';

export function registerTerminalFileLinks(term: Terminal, root?: string): IDisposable {
  return term.registerLinkProvider({
    provideLinks(y, callback) {
      const text = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? '';
      const refs = findFileRefs(text);
      if (refs.length === 0) return callback(undefined);
      callback(
        refs.map((r) => ({
          range: { start: { x: r.start + 1, y }, end: { x: r.end, y } },
          text: r.text,
          decorations: { underline: true, pointerCursor: true },
          activate: () => void openFileRef({ path: r.path, line: r.line, column: r.column }, { root }),
        })),
      );
    },
  });
}
