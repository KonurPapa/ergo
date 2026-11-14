/**
 * Deep links from Ergo into the user's editor: open a file at a line, list the files a run changed, open one change as
 * a diff. The editor is the user's choice in Settings › Editor (`IDE_PREF_KEY`), sent with each request; the bridge
 * finds the editor's launcher, keeps everything inside the project's Allowed Folders, and falls back to the system app.
 *
 * Problems surface as toasts (`ergo:toast` events, shown by App) so a click on a link never fails silently.
 */
import { bridgeClient } from './bridgeClient';
import { IDE_LINKS_PROTOCOL } from './bridgeProtocol';
import { DEFAULT_IDE, IDE_PREF_KEY, isIdeId, type IdeId } from './ideLaunch';
import { getRootsProject, openFileInIdeOrSystem } from './mcpClient';
import { getPref, setPref } from './userPrefs';
import type { FileRef } from './fileLinks';

export function getIdeChoice(): IdeId {
  const saved = getPref(IDE_PREF_KEY);
  return isIdeId(saved) ? saved : DEFAULT_IDE;
}

export function setIdeChoice(id: IdeId): void {
  setPref(IDE_PREF_KEY, id);
}

/** The bridge honors the editor choice and serves run changes and diffs. */
export function bridgeSupportsIdeLinks(): boolean {
  return (bridgeClient.getStatus().bridgeInfo?.protocol ?? 0) >= IDE_LINKS_PROTOCOL;
}

type ToastType = 'warning' | 'info' | 'error' | 'success';

export function showAppToast(type: ToastType, title: string, message: string): void {
  try {
    window.dispatchEvent(new CustomEvent('ergo:toast', { detail: { type, title, message, duration: 6000 } }));
  } catch {}
}

/** "src/a.ts:42" for messages. */
export function describeFileRef(ref: FileRef): string {
  return `${ref.path}${ref.line ? `:${ref.line}` : ''}${ref.line && ref.column ? `:${ref.column}` : ''}`;
}

/** Opens a file reference in the editor; tells the user (toast) when it can't. */
export async function openFileRef(ref: FileRef, opts: { root?: string } = {}): Promise<boolean> {
  const res = await openFileInIdeOrSystem(ref.path, ref.line, { column: ref.column, root: opts.root });
  if (res.success === false || res.error) {
    const err = res.error || '';
    if (/not found/i.test(err)) {
      showAppToast('warning', 'File not found', `${describeFileRef(ref)} isn't in this project's folders. It may have been moved or deleted.`);
    } else if (/outside/i.test(err)) {
      showAppToast('warning', "Outside the project's folders", `${ref.path} is outside this project's Allowed Folders. Add its folder under Settings › Folders to open it.`);
    } else {
      showAppToast('error', "Couldn't open the file", err || 'The bridge did not answer.');
    }
    return false;
  }
  if (res.note) showAppToast('info', 'Opened with another app', res.note);
  return true;
}

export interface RunChangedFile {
  /** Relative to the run's working folder ('/'-separated). */
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'changed';
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface RunChanges {
  /** False when the run has no recorded starting point (not a git repo, or started before this was recorded). */
  baseline: boolean;
  files: RunChangedFile[];
  truncated?: boolean;
  /** The run's working folder (absolute): changed files are relative to it. */
  root?: string;
  error?: string;
}

/** The files a run changed since its first agent started; null when the bridge can't tell (older bridge, offline). */
export async function fetchRunChanges(runId: string, opts: { root?: string } = {}): Promise<RunChanges | null> {
  if (!runId || !bridgeSupportsIdeLinks()) return null;
  try {
    const res = await bridgeClient.fetch('/api/git/run-changes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId, projectId: getRootsProject() || undefined, root: opts.root }),
    });
    const data = await res.json().catch(() => null);
    if (!data || typeof data !== 'object') return null;
    return {
      baseline: Boolean(data.baseline),
      files: Array.isArray(data.files) ? data.files : [],
      truncated: Boolean(data.truncated),
      root: typeof data.root === 'string' ? data.root : undefined,
      error: data.success === false ? data.error || 'Could not read the changes.' : undefined,
    };
  } catch {
    return null;
  }
}

/** Opens one file's change in a run as a side-by-side diff (or the file, for editors without a diff view). */
export async function openRunFileDiff(runId: string, path: string, opts: { root?: string } = {}): Promise<boolean> {
  try {
    const res = await bridgeClient.fetch('/api/files/diff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId, path, root: opts.root, ide: getIdeChoice(), projectId: getRootsProject() || undefined }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      showAppToast('error', "Couldn't open the diff", data.error || `The bridge answered ${res.status}.`);
      return false;
    }
    if (data.note) showAppToast('info', 'Opened the file instead', data.note);
    return true;
  } catch (err: any) {
    showAppToast('error', "Couldn't open the diff", err?.message || 'The bridge did not answer.');
    return false;
  }
}

/** Which editors this computer has (by Settings id); null with an older bridge or offline. */
export async function detectIdes(): Promise<Record<string, boolean> | null> {
  if (!bridgeSupportsIdeLinks()) return null;
  try {
    const res = await bridgeClient.fetch('/api/ide/detect');
    const data = await res.json();
    return data && typeof data.ides === 'object' ? data.ides : null;
  } catch {
    return null;
  }
}
