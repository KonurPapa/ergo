import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LucideIcon } from 'lucide-react';
import { CornerDownLeft, Search } from 'lucide-react';
import { Icon, Kbd, cx } from './ui';

export interface PaletteAction {
  label: string;
  icon: LucideIcon;
  kbd?: string[];
  run: () => void;
}

export interface PaletteItem {
  id: string;
  kind: 'task' | 'heading' | 'command';
  label: string;
  /** Right-side context (a task's heading, a command's settings page). */
  context?: string;
  icon: LucideIcon;
  kbd?: string[];
  /** Extra words to match on. */
  keywords?: string;
  /** Enter: tasks and headings jump the caret to their line; commands run. */
  run: () => void;
  /** ⇥: a task's actions (Open brief, Run, Queue). */
  actions?: PaletteAction[];
}

const GROUP_LABEL: Record<PaletteItem['kind'], string> = { task: 'Tasks', heading: 'Headings', command: 'Commands' };
const MAX_PER_GROUP = 8;

/** Every query word must appear somewhere; earlier and whole-word hits rank higher. */
function score(item: PaletteItem, words: string[]): number {
  if (!words.length) return 1;
  const hay = `${item.label} ${item.context ?? ''} ${item.keywords ?? ''}`.toLowerCase();
  let total = 0;
  for (const w of words) {
    const at = hay.indexOf(w);
    if (at < 0) return 0;
    total += 10 - Math.min(9, at / 8) + (at === 0 || /\W/.test(hay[at - 1]) ? 5 : 0);
  }
  return total;
}

/**
 * ⌘K: searches the document's tasks and headings and the app's commands, and runs the highlighted one with ↵.
 * `>` limits to commands, `#` to tasks and headings; ⇥ shows a task's actions.
 */
export const CommandPalette: React.FC<{ open: boolean; onClose: () => void; items: PaletteItem[] }> = ({ open, onClose, items }) => {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [actionsFor, setActionsFor] = useState<PaletteItem | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    setActionsFor(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const { rows, flat } = useMemo(() => {
    if (actionsFor) {
      const acts = (actionsFor.actions ?? []).map((a, i) => ({ key: `a${i}`, label: a.label, icon: a.icon, kbd: a.kbd, run: a.run }));
      return { rows: [{ group: actionsFor.label, items: acts }], flat: acts };
    }
    let q = query.trim().toLowerCase();
    let only: PaletteItem['kind'][] | null = null;
    if (q.startsWith('>')) {
      only = ['command'];
      q = q.slice(1);
    } else if (q.startsWith('#')) {
      only = ['task', 'heading'];
      q = q.slice(1);
    }
    // "run <task>" reads as the Run action on a task.
    let runPrefix = false;
    if (!only && /^run\s+\S/.test(q)) {
      runPrefix = true;
      q = q.replace(/^run\s+/, '');
    }
    const words = q.split(/\s+/).filter(Boolean);
    const groups: Array<{ group: string; items: Array<{ key: string; label: string; context?: string; icon: LucideIcon; kbd?: string[]; run: () => void; item?: PaletteItem }> }> = [];
    for (const kind of ['task', 'heading', 'command'] as const) {
      if (only && !only.includes(kind)) continue;
      if (runPrefix && kind !== 'task') continue;
      const hits = items
        .filter((it) => it.kind === kind)
        .map((it) => ({ it, s: score(it, words) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, words.length ? MAX_PER_GROUP : kind === 'command' ? MAX_PER_GROUP : 5);
      if (!hits.length) continue;
      groups.push({
        group: GROUP_LABEL[kind],
        items: hits.map(({ it }) => {
          const runAction = runPrefix ? it.actions?.find((a) => a.label === 'Run') : undefined;
          return runAction
            ? { key: `${it.id}:run`, label: `Run ${it.label}`, context: it.context, icon: runAction.icon, run: runAction.run, item: it }
            : { key: it.id, label: it.label, context: it.context, icon: it.icon, kbd: it.kbd, run: it.run, item: it };
        }),
      });
    }
    return { rows: groups, flat: groups.flatMap((g) => g.items) };
  }, [items, query, actionsFor]);

  useEffect(() => setActive(0), [query, actionsFor]);
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const runAt = (i: number) => {
    const row = flat[i];
    if (!row) return;
    onClose();
    // Let the palette unmount before the action moves focus (into the editor, a dialog…).
    requestAnimationFrame(() => row.run());
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(flat.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runAt(active);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const row = flat[active] as { item?: PaletteItem } | undefined;
      if (actionsFor) setActionsFor(null);
      else if (row?.item?.actions?.length) setActionsFor(row.item);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (actionsFor) setActionsFor(null);
      else onClose();
    } else if (e.key === 'Backspace' && actionsFor && !query) {
      setActionsFor(null);
    }
  };

  let index = -1;
  return createPortal(
    <div
      className="eg-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="eg-palette" role="dialog" aria-label="Command palette" onKeyDown={onKeyDown}>
        <div className="eg-palette-input">
          <Icon icon={Search} />
          <input
            ref={inputRef}
            className="eg-palette-field"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={actionsFor ? `Actions for ${actionsFor.label}` : 'Search tasks or run a command'}
            aria-label="Search tasks or run a command"
            spellCheck={false}
          />
        </div>
        <div className="eg-palette-list" ref={listRef} role="listbox">
          {flat.length === 0 && <div className="eg-palette-empty">No tasks or commands match “{query}”.</div>}
          {rows.map((g) => (
            <React.Fragment key={g.group}>
              <div className="eg-menu-label">{g.group}</div>
              {g.items.map((row) => {
                index += 1;
                const i = index;
                return (
                  <button
                    key={row.key}
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    className="eg-menu-item"
                    data-active={i === active ? 'true' : undefined}
                    onMouseMove={() => setActive(i)}
                    onClick={() => runAt(i)}
                  >
                    <Icon icon={row.icon} />
                    <span className="eg-menu-text">{row.label}</span>
                    {'context' in row && row.context && <span className="eg-palette-context">{row.context}</span>}
                    <span className="eg-menu-hint">
                      {i === active ? <Kbd keys="↵" /> : row.kbd ? <Kbd keys={row.kbd} /> : null}
                    </span>
                  </button>
                );
              })}
            </React.Fragment>
          ))}
        </div>
        <div className="eg-palette-foot">
          <span className="eg-hstack eg-palette-key">
            <Kbd keys={['↑', '↓']} />
            Navigate
          </span>
          <span className="eg-hstack eg-palette-key">
            <Icon icon={CornerDownLeft} size="sm" />
            Run
          </span>
          <span className="eg-hstack eg-palette-key">
            <Kbd keys="⇥" />
            Actions
          </span>
          <span className="eg-spacer" />
          <span className={cx('eg-hide-sm')}>Type &gt; for commands, # for tasks</span>
        </div>
      </div>
    </div>,
    document.body,
  );
};
