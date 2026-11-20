/**
 * Deep links from Ergo into the user's editor: open a file at a line, list the files a run changed, open one change as
 * a diff. The editor is the user's choice in Settings › Editor (`IDE_PREF_KEY`), sent with each request; the bridge
 * finds the editor's launcher, keeps everything inside the project's Allowed Folders, and falls back to the system app.
 *
 * Problems surface as toasts (`ergo:toast` events, shown by App) so a click on a link never fails silently.
 */
import { bridgeClient, type BridgeStatus } from './bridgeClient';
import { IDE_LINKS_PROTOCOL, VISUAL_DIFF_PROTOCOL } from './bridgeProtocol';
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

/** The bridge serves in-app unified diffs, checkpoint snapshots, and 1-click revert. */
export function bridgeSupportsVisualDiff(): boolean {
  return (bridgeClient.getStatus().bridgeInfo?.protocol ?? 0) >= VISUAL_DIFF_PROTOCOL;
}

export interface BridgeVisualDiffCapability {
  connected: boolean;
  protocol: number | null;
  supported: boolean;
}

export function getBridgeVisualDiffCapability(status: BridgeStatus = bridgeClient.getStatus()): BridgeVisualDiffCapability {
  const protocol = status.bridgeInfo?.protocol ?? null;
  return {
    connected: Boolean(status.isConnected),
    protocol,
    supported: Boolean(status.isConnected && (protocol ?? 0) >= VISUAL_DIFF_PROTOCOL),
  };
}

/** Subscribes to bridge protocol changes so visual diff & checkpoint views react once the handshake finishes. */
export function subscribeBridgeVisualDiffCapability(cb: (cap: BridgeVisualDiffCapability) => void): () => void {
  let prevKey = '';
  return bridgeClient.subscribe((status) => {
    const cap = getBridgeVisualDiffCapability(status);
    const key = `${cap.connected}:${cap.protocol ?? ''}:${cap.supported}`;
    if (key === prevKey) return;
    prevKey = key;
    cb(cap);
  });
}

type ToastType = 'warning' | 'info' | 'error' | 'success';

export function showAppToast(type: ToastType, title: string, message: string): void {
  try {
    window.dispatchEvent(new CustomEvent('ergo:toast', { detail: { type, title, message, duration: 6000 } }));
  } catch { }
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
  /** The recorded pre-run git tree hash, when available. */
  baseTree?: string;
  startedAt?: string;
  error?: string;
}

export interface RunDiffPayload {
  baseline: boolean;
  git: boolean;
  files: RunChangedFile[];
  diffs: Record<string, string>;
  root?: string;
  baseTree?: string;
  fromTree?: string;
  toTree?: string;
  truncated?: boolean;
  error?: string;
}

export interface RunRevertResponse {
  success: boolean;
  reverted: string[];
  deleted: string[];
  failed: Array<{ path: string; error: string }>;
  restoredTree?: string;
  error?: string;
}

export interface RunCheckpointRecord {
  id: string;
  stepId?: string;
  label: string;
  summary?: string;
  at: string;
  tree?: string;
  prevTree?: string;
  files?: RunChangedFile[];
  isBaseline?: boolean;
  changelog?: string;
}

export interface RunCheckpointsResponse {
  baseline: boolean;
  git: boolean;
  reason?: 'not-git' | 'no-snapshot' | 'snapshot-failed';
  root?: string;
  baseTree?: string;
  checkpoints: RunCheckpointRecord[];
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
      baseTree: typeof data.baseTree === 'string' ? data.baseTree : undefined,
      startedAt: typeof data.startedAt === 'string' ? data.startedAt : undefined,
      error: data.success === false ? data.error || 'Could not read the changes.' : undefined,
    };
  } catch {
    return null;
  }
}

/** Fetches standard unified diffs for a run (all changed files, a single file, or between two checkpoint trees). */
export async function fetchRunDiff(
  runId: string,
  opts: { file?: string; fromTree?: string; toTree?: string; root?: string } = {},
): Promise<RunDiffPayload | null> {
  if (!runId) return null;
  try {
    const res = await bridgeClient.fetch('/api/git/run-diff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId,
        file: opts.file,
        fromTree: opts.fromTree,
        toTree: opts.toTree,
        root: opts.root,
        projectId: getRootsProject() || undefined,
      }),
    });
    const data = await res.json().catch(() => null);
    if (!data || typeof data !== 'object') return null;
    return {
      baseline: Boolean(data.baseline),
      git: Boolean(data.git),
      files: Array.isArray(data.files) ? data.files : [],
      diffs: data.diffs && typeof data.diffs === 'object' ? (data.diffs as Record<string, string>) : {},
      root: typeof data.root === 'string' ? data.root : undefined,
      baseTree: typeof data.baseTree === 'string' ? data.baseTree : undefined,
      fromTree: typeof data.fromTree === 'string' ? data.fromTree : undefined,
      toTree: typeof data.toTree === 'string' ? data.toTree : undefined,
      truncated: Boolean(data.truncated),
      error: data.success === false ? data.error || 'Could not generate the diff.' : undefined,
    };
  } catch {
    return null;
  }
}

/** Reverts a single file back to the run baseline (or a specific checkpoint tree). */
export async function revertRunFile(
  runId: string,
  filePath: string,
  opts: { tree?: string; root?: string } = {},
): Promise<RunRevertResponse> {
  try {
    const res = await bridgeClient.fetch('/api/git/revert-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId,
        path: filePath,
        tree: opts.tree,
        root: opts.root,
        projectId: getRootsProject() || undefined,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      return {
        success: false,
        reverted: [],
        deleted: [],
        failed: [{ path: filePath, error: data.error || `The bridge answered ${res.status}.` }],
        error: data.error || `The bridge answered ${res.status}.`,
      };
    }
    return {
      success: true,
      reverted: Array.isArray(data.reverted) ? data.reverted : [],
      deleted: Array.isArray(data.deleted) ? data.deleted : [],
      failed: Array.isArray(data.failed) ? data.failed : [],
    };
  } catch (err: any) {
    return {
      success: false,
      reverted: [],
      deleted: [],
      failed: [{ path: filePath, error: err?.message || 'The bridge did not answer.' }],
      error: err?.message || 'The bridge did not answer.',
    };
  }
}

/** Reverts all files changed in a run back to the run baseline or to a specific checkpoint tree. */
export async function revertRunChanges(
  runId: string,
  opts: { tree?: string; checkpointId?: string; root?: string } = {},
): Promise<RunRevertResponse> {
  try {
    const res = await bridgeClient.fetch('/api/git/revert-run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId,
        tree: opts.tree,
        checkpointId: opts.checkpointId,
        root: opts.root,
        projectId: getRootsProject() || undefined,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      return {
        success: false,
        reverted: Array.isArray(data.reverted) ? data.reverted : [],
        deleted: Array.isArray(data.deleted) ? data.deleted : [],
        failed: Array.isArray(data.failed) ? data.failed : [],
        error: data.error || `The bridge answered ${res.status}.`,
      };
    }
    return {
      success: true,
      reverted: Array.isArray(data.reverted) ? data.reverted : [],
      deleted: Array.isArray(data.deleted) ? data.deleted : [],
      failed: Array.isArray(data.failed) ? data.failed : [],
      restoredTree: typeof data.restoredTree === 'string' ? data.restoredTree : undefined,
    };
  } catch (err: any) {
    return {
      success: false,
      reverted: [],
      deleted: [],
      failed: [],
      error: err?.message || 'The bridge did not answer.',
    };
  }
}

/** Fetches the checkpoints recorded for a run (including the initial baseline when git is available). */
export async function fetchRunCheckpoints(runId: string, opts: { root?: string } = {}): Promise<RunCheckpointsResponse | null> {
  if (!runId) return null;
  try {
    const res = await bridgeClient.fetch('/api/git/checkpoints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId, projectId: getRootsProject() || undefined, root: opts.root }),
    });
    const data = await res.json().catch(() => null);
    if (!data || typeof data !== 'object') return null;
    return {
      baseline: Boolean(data.baseline),
      git: Boolean(data.git),
      reason:
        data.reason === 'not-git' || data.reason === 'no-snapshot' || data.reason === 'snapshot-failed'
          ? data.reason
          : undefined,
      root: typeof data.root === 'string' ? data.root : undefined,
      baseTree: typeof data.baseTree === 'string' ? data.baseTree : undefined,
      checkpoints: Array.isArray(data.checkpoints) ? (data.checkpoints as RunCheckpointRecord[]) : [],
    };
  } catch {
    return null;
  }
}

/** Records a checkpoint snapshot for a major run step (non-blocking, best-effort). */
export async function recordRunCheckpointClient(
  runId: string,
  payload: {
    id?: string;
    stepId?: string;
    label?: string;
    summary?: string;
    changelog?: string;
    initBase?: boolean;
    root?: string;
  },
): Promise<RunCheckpointRecord | null> {
  if (!runId || !bridgeSupportsVisualDiff()) return null;
  try {
    const res = await bridgeClient.fetch('/api/git/checkpoint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId,
        projectId: getRootsProject() || undefined,
        ...payload,
      }),
    });
    const data = await res.json().catch(() => null);
    return data?.checkpoint && typeof data.checkpoint === 'object' ? (data.checkpoint as RunCheckpointRecord) : null;
  } catch {
    return null;
  }
}

const checkpointQueues = new Map<string, Promise<unknown>>();
const checkpointListeners = new Map<string, Set<(checkpoint: RunCheckpointRecord | null) => void>>();

function notifyRunCheckpoint(runId: string, checkpoint: RunCheckpointRecord | null): void {
  const set = checkpointListeners.get(runId);
  if (!set) return;
  for (const cb of set) {
    try {
      cb(checkpoint);
    } catch { }
  }
}

/** Subscribes to checkpoint write completions for a run so the timeline refreshes without racing bridge writes. */
export function subscribeRunCheckpoints(
  runId: string,
  cb: (checkpoint: RunCheckpointRecord | null) => void,
): () => void {
  if (!runId) return () => {};
  let set = checkpointListeners.get(runId);
  if (!set) {
    set = new Set();
    checkpointListeners.set(runId, set);
  }
  set.add(cb);
  return () => {
    set?.delete(cb);
    if (set && set.size === 0) checkpointListeners.delete(runId);
  };
}

/** Resolves once any in-flight checkpoint writes for `runId` have settled. */
export async function waitForPendingCheckpoints(runId: string): Promise<void> {
  const pending = checkpointQueues.get(runId);
  if (!pending) return;
  try {
    await pending;
  } catch { }
}

const MAJOR_CHECKPOINT_STAGES = new Set([
  'overview',
  'decompose',
  'subagent',
  'execution',
  'verify',
  'cleaner',
  'verifier',
  'retry',
  'built_record',
  'done',
]);

const READ_ONLY_TOOL_RE = /^(?:read_file|read_files|read_many|list_dir|list_directory|ls|glob|grep|search_files|find_files|get_|fetch_|inspect_)/i;

/** Whether an execution step represents a major milestone / mutating action that warrants a checkpoint snapshot. */
export function isMajorCheckpointStep(step: { stage?: string; mcpToolUsed?: string; status?: string }): boolean {
  if (step.stage && MAJOR_CHECKPOINT_STAGES.has(step.stage)) return true;
  if (step.stage === 'mcp_call' && step.mcpToolUsed && !READ_ONLY_TOOL_RE.test(step.mcpToolUsed)) return true;
  return false;
}

/** Serializes checkpoint writes per runId so checkpoints.json never races under parallel workers. */
export function queueRunCheckpoint(
  runId: string,
  payload: Parameters<typeof recordRunCheckpointClient>[1],
): Promise<RunCheckpointRecord | null> {
  if (!runId) return Promise.resolve(null);
  const prev = checkpointQueues.get(runId) ?? Promise.resolve();
  const next = prev
    .catch(() => { })
    .then(() => recordRunCheckpointClient(runId, payload))
    .then((cp) => {
      notifyRunCheckpoint(runId, cp);
      return cp;
    });
  checkpointQueues.set(runId, next);
  void next.finally(() => {
    if (checkpointQueues.get(runId) === next) checkpointQueues.delete(runId);
  });
  return next;
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
