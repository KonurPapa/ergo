/**
 * The editor side of task commands (taskReferences.ts): typing `@` or `/` in a task opens the command menu
 * (TaskCommandMenu) at the cursor, the menu's keys take over while it is open, and `/slug` words that name an enabled
 * skill are highlighted so the user can see which slash words Ergo will run as skills.
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { activeCommandAt, formatFileReference, skillTokenRanges, type ActiveCommand } from './taskReferences';

export interface TaskCommandState extends ActiveCommand {
  /** Document range of the command (trigger through cursor). */
  from: number;
  to: number;
  /** Viewport position of the trigger's bottom-left corner (for placing the menu). */
  left: number;
  top: number;
}

export interface TaskCommandHandlers {
  /** The command under the cursor changed (null: none, or the user dismissed it). */
  onChange: (command: TaskCommandState | null) => void;
  /** A menu key while the menu is open; true when the menu used it. */
  onKey: (key: 'ArrowUp' | 'ArrowDown' | 'Enter' | 'Tab' | 'Escape') => boolean;
  /** Command names of the enabled skills (highlighted in the text). */
  skillSlugs: () => Set<string>;
}

export const taskCommandPluginKey = new PluginKey<{ dismissedAt: number | null }>('taskCommands');

const MENU_KEYS = new Set(['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape']);

function commandAt(state: EditorState): Omit<TaskCommandState, 'left' | 'top'> | null {
  const { selection } = state;
  if (!selection.empty || !(selection instanceof TextSelection)) return null;
  const $from = selection.$from;
  if (!$from.parent.isTextblock) return null;
  // Inside an inserted reference (inline code): editing it, not starting a command.
  if ($from.marks().some((m) => m.type.name === 'code')) return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼');
  const cmd = activeCommandAt(before);
  if (!cmd) return null;
  const from = $from.start() + cmd.start;
  return { ...cmd, from, to: selection.from };
}

function skillDecorations(state: EditorState, slugs: Set<string>): DecorationSet {
  if (slugs.size === 0) return DecorationSet.empty;
  const decos: Decoration[] = [];
  state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const text = node.textBetween(0, node.content.size, undefined, '￼');
    if (!text.includes('/')) return false;
    for (const r of skillTokenRanges(text, slugs)) {
      decos.push(Decoration.inline(pos + 1 + r.from, pos + 1 + r.to, { class: 'task-skill-token' }));
    }
    return false;
  });
  return DecorationSet.create(state.doc, decos);
}

export function createTaskCommandExtension(name: string, handlersRef: { current: TaskCommandHandlers }) {
  return Extension.create({
    name,
    // Ahead of the list keymaps (Enter) and the autocomplete (Tab) while the menu is open.
    priority: 1000,
    addProseMirrorPlugins() {
      let last: string | null = null;
      const report = (view: EditorView) => {
        const cmd = commandAt(view.state);
        const dismissedAt = taskCommandPluginKey.getState(view.state)?.dismissedAt ?? null;
        const shown = cmd && cmd.from !== dismissedAt && view.hasFocus() ? cmd : null;
        const sig = shown ? `${shown.trigger}|${shown.query}|${shown.from}|${shown.to}` : null;
        if (sig === last) return;
        last = sig;
        if (!shown) return handlersRef.current.onChange(null);
        const coords = view.coordsAtPos(shown.from);
        handlersRef.current.onChange({ ...shown, left: coords.left, top: coords.bottom });
      };
      return [
        new Plugin({
          key: taskCommandPluginKey,
          state: {
            init: () => ({ dismissedAt: null as number | null }),
            apply(tr, value) {
              const meta = tr.getMeta(taskCommandPluginKey);
              if (meta && 'dismissedAt' in meta) return { dismissedAt: meta.dismissedAt };
              // A dismissal lasts until the command it was for is gone (the trigger moves with edits before it).
              if (value.dismissedAt === null) return value;
              return { dismissedAt: tr.docChanged ? tr.mapping.map(value.dismissedAt) : value.dismissedAt };
            },
          },
          props: {
            handleKeyDown(view, event) {
              if (!MENU_KEYS.has(event.key) || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false;
              if (last === null) return false;
              const used = handlersRef.current.onKey(event.key as 'ArrowUp' | 'ArrowDown' | 'Enter' | 'Tab' | 'Escape');
              if (used && event.key === 'Escape') {
                const cmd = commandAt(view.state);
                if (cmd) view.dispatch(view.state.tr.setMeta(taskCommandPluginKey, { dismissedAt: cmd.from }));
              }
              if (used) event.preventDefault();
              return used;
            },
            decorations(state) {
              return skillDecorations(state, handlersRef.current.skillSlugs());
            },
            handleDOMEvents: {
              blur(view) {
                // Let a click on the menu land before it closes.
                setTimeout(() => {
                  if (!view.isDestroyed && !view.hasFocus()) report(view);
                }, 150);
                return false;
              },
            },
          },
          view() {
            return {
              update(view) {
                report(view);
              },
              destroy() {
                if (last !== null) handlersRef.current.onChange(null);
                last = null;
              },
            };
          },
        }),
      ];
    },
  });
}

/** Replaces the command with `/slug `. */
export function insertSkillCommand(view: EditorView, command: Pick<TaskCommandState, 'from' | 'to'>, slug: string) {
  const { state } = view;
  const tr = state.tr.insertText(`/${slug} `, command.from, command.to);
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

/** Replaces the command with the file references (inline code, so the markdown keeps them exactly), then a space. */
export function insertFileReferences(view: EditorView, command: Pick<TaskCommandState, 'from' | 'to'>, paths: string[]) {
  if (paths.length === 0) return;
  const { state } = view;
  const code = state.schema.marks.code;
  const nodes = paths.flatMap((p, i) => {
    const ref = formatFileReference(p);
    return [code ? state.schema.text(ref, [code.create()]) : state.schema.text(ref), ...(i < paths.length - 1 ? [state.schema.text(' ')] : [])];
  });
  nodes.push(state.schema.text(' '));
  let tr = state.tr.replaceWith(command.from, command.to, nodes);
  const end = command.from + nodes.reduce((n, node) => n + node.nodeSize, 0);
  tr = tr.setSelection(TextSelection.create(tr.doc, end)).setStoredMarks([]);
  view.dispatch(tr.scrollIntoView());
  view.focus();
}
