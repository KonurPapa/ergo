import React, { useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileText, Folder, FolderOpen, Loader2, Sparkles } from 'lucide-react';
import type { WorkspaceSkill } from '../types';
import { bridgeClient } from '../lib/bridgeClient';
import { bridgeSupportsTaskReferences, skillsBySlug } from '../lib/taskReferences';
import type { TaskCommandState } from '../lib/taskCommandExtension';

export interface TaskCommandMenuHandle {
  /** A menu key from the editor; true when the menu used it. */
  onKey: (key: 'ArrowUp' | 'ArrowDown' | 'Enter' | 'Tab' | 'Escape') => boolean;
}

interface TaskCommandMenuProps {
  command: TaskCommandState | null;
  /** The project's working folder: `@` lists its files, and relative references start there. */
  root: string;
  skills: WorkspaceSkill[];
  onPickSkill: (slug: string) => void;
  /** Paths relative to root when inside it, else absolute. */
  onPickFiles: (paths: string[]) => void;
  onClose: () => void;
}

type MenuItem =
  | { kind: 'skill'; slug: string; skill: WorkspaceSkill }
  | { kind: 'path'; path: string; isDir: boolean }
  | { kind: 'browse' };

const MAX_SKILLS = 8;
const MAX_FILES = 40;

/** Path relative to root when it lies inside root ("/a/b" + "/a/b/c/d.ts" → "c/d.ts"), else the path itself. */
function relativeToRoot(root: string, abs: string): string {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const r = norm(root);
  const a = norm(abs);
  return r && a.startsWith(`${r}/`) ? a.slice(r.length + 1) : abs;
}

/**
 * The dropdown for the command being typed in a task: enabled skills for `/`, the project's files and folders for `@`
 * (plus "Browse…", the computer's own file dialog, for files anywhere). A `/` that names no skill shows nothing, so
 * slashes in plain text are never in the way.
 */
export const TaskCommandMenu = React.forwardRef<TaskCommandMenuHandle, TaskCommandMenuProps>(
  ({ command, root, skills, onPickSkill, onPickFiles, onClose }, ref) => {
    const [paths, setPaths] = useState<string[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [browsing, setBrowsing] = useState(false);
    const [active, setActive] = useState(0);
    const listRef = useRef<HTMLDivElement>(null);
    const trigger = command?.trigger;
    const query = command?.query ?? '';
    const canListFiles = bridgeSupportsTaskReferences();

    // `@`: ask the bridge for matching paths (debounced; the latest query wins).
    useEffect(() => {
      if (trigger !== '@' || !canListFiles) return;
      let cancelled = false;
      setLoading(true);
      const timer = setTimeout(async () => {
        try {
          const res = await bridgeClient.fetch('/api/files/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ root, query, limit: MAX_FILES }),
          });
          const json = await res.json();
          if (cancelled) return;
          if (json?.success && Array.isArray(json.paths)) {
            setPaths(json.paths);
            setError(null);
          } else {
            setPaths([]);
            setError(json?.error || 'Could not list the project files.');
          }
        } catch {
          if (!cancelled) {
            setPaths([]);
            setError('The Ergo bridge is not reachable.');
          }
        } finally {
          if (!cancelled) setLoading(false);
        }
      }, 120);
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    }, [trigger, query, root, canListFiles]);

    const items: MenuItem[] = useMemo(() => {
      if (trigger === '/') {
        const q = query.toLowerCase();
        return [...skillsBySlug(skills).entries()]
          .filter(([slug, s]) => !q || slug.includes(q) || s.name.toLowerCase().includes(q))
          .sort(([a], [b]) => Number(!a.startsWith(q)) - Number(!b.startsWith(q)) || a.localeCompare(b))
          .slice(0, MAX_SKILLS)
          .map(([slug, skill]) => ({ kind: 'skill' as const, slug, skill }));
      }
      if (trigger === '@') {
        return [
          ...paths.map((p) => ({ kind: 'path' as const, path: p.replace(/\/$/, ''), isDir: p.endsWith('/') })),
          ...(canListFiles ? [{ kind: 'browse' as const }] : []),
        ];
      }
      return [];
    }, [trigger, query, skills, paths, canListFiles]);

    useEffect(() => setActive(0), [trigger, query]);
    useEffect(() => {
      listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
    }, [active]);

    const browse = async () => {
      if (browsing) return;
      setBrowsing(true);
      try {
        const res = await bridgeClient.fetch('/api/files/pick', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ defaultPath: root }),
        });
        const json = await res.json();
        if (json?.success && Array.isArray(json.paths) && json.paths.length > 0) {
          onPickFiles(json.paths.map((p: string) => relativeToRoot(root, p)));
        } else if (!json?.success) {
          setError(json?.error || 'Could not open the file dialog.');
        }
      } catch {
        setError('The Ergo bridge is not reachable.');
      } finally {
        setBrowsing(false);
      }
    };

    const choose = (item: MenuItem | undefined) => {
      if (!item) return;
      if (item.kind === 'skill') onPickSkill(item.slug);
      else if (item.kind === 'path') onPickFiles([item.path]);
      else void browse();
    };

    const open = Boolean(command) && (items.length > 0 || (trigger === '@' && (loading || Boolean(error) || !canListFiles)));

    useImperativeHandle(ref, () => ({
      onKey: (key) => {
        if (!open) return false;
        if (key === 'Escape') {
          onClose();
          return true;
        }
        if (items.length === 0) return false;
        if (key === 'ArrowDown') setActive((i) => (i + 1) % items.length);
        else if (key === 'ArrowUp') setActive((i) => (i - 1 + items.length) % items.length);
        else choose(items[Math.min(active, items.length - 1)]);
        return true;
      },
    }));

    if (!open || !command || typeof document === 'undefined') return null;

    const width = 360;
    const left = Math.max(8, Math.min(command.left, window.innerWidth - width - 8));
    const below = command.top + 6;
    const flip = below + 280 > window.innerHeight;

    return createPortal(
      <div
        className="task-command-menu"
        role="listbox"
        style={{ left, width, ...(flip ? { bottom: window.innerHeight - command.top + 26 } : { top: below }) }}
        // Keep the editor focused (and the command open) while the menu is clicked.
        onMouseDown={(e) => e.preventDefault()}
      >
        <div className="task-command-menu-head">
          {trigger === '/' ? 'Run a skill when this task executes' : 'Reference a file'}
        </div>
        <div className="task-command-menu-list" ref={listRef}>
          {items.map((item, i) => {
            const isActive = i === active;
            if (item.kind === 'skill') {
              return (
                <div
                  key={`s-${item.slug}`}
                  data-index={i}
                  role="option"
                  aria-selected={isActive}
                  className={`task-command-item ${isActive ? 'is-active' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(item)}
                >
                  <Sparkles size={13} className="task-command-icon is-skill" />
                  <span className="task-command-main">
                    <span className="task-command-label">/{item.slug}</span>
                    <span className="task-command-detail">{item.skill.description}</span>
                  </span>
                </div>
              );
            }
            if (item.kind === 'path') {
              const slash = item.path.lastIndexOf('/');
              return (
                <div
                  key={`p-${item.path}`}
                  data-index={i}
                  role="option"
                  aria-selected={isActive}
                  className={`task-command-item ${isActive ? 'is-active' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(item)}
                  title={item.path}
                >
                  {item.isDir ? <Folder size={13} className="task-command-icon" /> : <FileText size={13} className="task-command-icon" />}
                  <span className="task-command-main is-row">
                    <span className="task-command-label">{item.path.slice(slash + 1)}</span>
                    {slash > 0 && <span className="task-command-detail">{item.path.slice(0, slash)}</span>}
                  </span>
                </div>
              );
            }
            return (
              <div
                key="browse"
                data-index={i}
                role="option"
                aria-selected={isActive}
                className={`task-command-item is-browse ${isActive ? 'is-active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(item)}
              >
                {browsing ? <Loader2 size={13} className="task-command-icon spin-animate" /> : <FolderOpen size={13} className="task-command-icon" />}
                <span className="task-command-main">
                  <span className="task-command-label">Browse…</span>
                  <span className="task-command-detail">Pick files anywhere on this computer</span>
                </span>
              </div>
            );
          })}
        </div>
        {trigger === '@' && (loading || error || !canListFiles) && (
          <div className="task-command-menu-foot">
            {!canListFiles
              ? 'Update the Ergo bridge to list files here. Typed @paths still work.'
              : loading && items.length <= 1
                ? 'Looking for files…'
                : error}
          </div>
        )}
      </div>,
      document.body
    );
  }
);
TaskCommandMenu.displayName = 'TaskCommandMenu';
