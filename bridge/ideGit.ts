/**
 * Opening files and diffs in the user's editor, and what a task run changed in its git repo.
 *
 *  - Editors: the user's choice (Settings › Editor, sent with each request) or Auto-detect. Launchers are found on PATH
 *    and in the installers' usual folders, and run without a shell (argument arrays); Windows `.cmd` launchers go
 *    through cmd.exe only when no argument holds a character cmd would read.
 *  - Run changes: when a run's first agent starts, the repo's working tree (tracked + untracked, .gitignore honored) is
 *    written as a git tree object through a temporary index — the user's index, stash and branches are never touched —
 *    and saved as `<cwd>/.ergo/runs/<runId>/git-base.json`. "Changed by this run" is that tree against the working tree
 *    now, so commits the agent made and edits it left uncommitted both count (edits the user made meanwhile do too).
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import {
  AUTO_IDE_ORDER,
  SYSTEM_ONLY_EXT_RE,
  ideCommandCandidates,
  ideDiffArgs,
  ideFamily,
  ideFileUrl,
  ideLabel,
  ideOpenArgs,
  isIdeId,
  safeForCmdShim,
  type IdeId,
} from '../src/lib/ideLaunch.ts';

// ── Finding and launching editors ──

const COMMAND_CACHE_MS = 60_000;
const commandCache = new Map<string, { path: string | null; at: number }>();

function extraSearchDirs(): string[] {
  const home = os.homedir();
  if (process.platform === 'win32') return [];
  // A desktop app started from the dock/launcher often has a shorter PATH than a terminal.
  return ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/snap/bin', path.join(home, '.local', 'bin'), path.join(home, 'bin')];
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    const st = await fs.stat(file);
    if (!st.isFile()) return false;
    if (process.platform === 'win32') return true;
    await fs.access(file, fsSync.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findOnPath(name: string): Promise<string | null> {
  const dirs = [...(process.env.PATH || '').split(path.delimiter).filter(Boolean), ...extraSearchDirs()];
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const full = path.join(dir, name);
    if (await isExecutable(full)) return full;
  }
  return null;
}

/** The launcher of an editor (`vscode`, `jetbrains`, … or an Auto-detect last resort like `sublime`), or null. */
export async function resolveIdeCommand(id: string): Promise<string | null> {
  const cached = commandCache.get(id);
  if (cached && Date.now() - cached.at < COMMAND_CACHE_MS) return cached.path;
  const { names, paths } = ideCommandCandidates(id, {
    platform: process.platform,
    home: os.homedir(),
    localAppData: process.env.LOCALAPPDATA,
    programFiles: process.env.ProgramFiles,
  });
  let found: string | null = null;
  for (const name of names) {
    found = await findOnPath(name);
    if (found) break;
  }
  if (!found) {
    for (const p of paths) {
      if (await isExecutable(p)) {
        found = p;
        break;
      }
    }
  }
  commandCache.set(id, { path: found, at: Date.now() });
  return found;
}

/** Which of the choosable editors this computer has (Settings › Editor). */
export async function detectIdes(): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  await Promise.all(AUTO_IDE_ORDER.map(async (id) => void (out[id] = Boolean(await resolveIdeCommand(id)))));
  return out;
}

/** The bridge's environment minus what would make an Electron editor (or an AppImage's libraries) misbehave. */
function launchEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('ELECTRON_') || key === 'APPIMAGE' || key === 'APPDIR' || key === 'ARGV0' || key === 'OWD') delete env[key];
  }
  if (process.env.APPIMAGE) delete env.LD_LIBRARY_PATH;
  return env;
}

/** Starts a program detached, without a shell. Resolves once it started; rejects when it couldn't. */
function launchDetached(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let file = cmd;
    let argv = args;
    let verbatim = false;
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd)) {
      // Node won't start a .cmd without a shell; cmd.exe gets it only when no argument holds cmd syntax.
      if (!safeForCmdShim([cmd, ...args])) return reject(new Error('The path holds characters the editor launcher cannot take.'));
      file = process.env.ComSpec || 'cmd.exe';
      argv = ['/d', '/s', '/c', `"${[cmd, ...args].map((a) => `"${a}"`).join(' ')}"`];
      verbatim = true;
    }
    let child;
    try {
      child = spawn(file, argv, { detached: true, stdio: 'ignore', env: launchEnv(), windowsHide: true, windowsVerbatimArguments: verbatim });
    } catch (err) {
      return reject(err);
    }
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/** Opens a file, folder or URL with the computer's default app. */
export async function openWithSystem(target: string): Promise<string> {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  await launchDetached(opener, [target]);
  return opener;
}

export interface OpenResult {
  /** The editor (or opener) used. */
  method: string;
  /** Set when the chosen editor wasn't used: what happened instead, in plain words. */
  note?: string;
  /** 'diff' when a diff opened, 'file' when the file did. */
  mode?: 'diff' | 'file';
}

const LAST_RESORTS = ['sublime', 'gedit', 'kate'];

/** Opens an existing file (or folder) at a line in the chosen editor; falls back to the system's app. */
export async function openInIde(choice: unknown, target: string, line?: number | null, column?: number | null): Promise<OpenResult> {
  const ide: IdeId = isIdeId(choice) ? choice : 'auto';
  if (ide !== 'system' && !SYSTEM_ONLY_EXT_RE.test(target)) {
    const order = ide === 'auto' ? [...AUTO_IDE_ORDER, ...LAST_RESORTS] : [ide];
    for (const id of order) {
      const cmd = await resolveIdeCommand(id);
      if (!cmd) continue;
      try {
        await launchDetached(cmd, ideOpenArgs(ideFamily(id), target, line, column));
        return { method: id };
      } catch (err) {
        console.warn(`[Ergo Open] Could not start ${cmd}:`, err);
      }
    }
    if (ide !== 'auto') {
      // The launcher isn't installed (or on PATH): VS Code, Cursor and Windsurf still answer their URL.
      const url = ideFileUrl(ide, target, line, column);
      if (url) {
        try {
          await openWithSystem(url);
          return { method: `${ide}-url` };
        } catch {}
      }
      const method = await openWithSystem(target);
      return { method, note: `${ideLabel(ide)}'s command-line launcher wasn't found, so the file opened with the system's app.` };
    }
  }
  return { method: await openWithSystem(target) };
}

/** Opens a side-by-side diff of two files; editors without one open `fallback` (the changed file) instead. */
export async function openDiffInIde(choice: unknown, left: string, right: string, fallback: string): Promise<OpenResult> {
  const ide: IdeId = isIdeId(choice) ? choice : 'auto';
  const order = ide === 'auto' ? AUTO_IDE_ORDER : ide === 'system' ? [] : [ide];
  for (const id of order) {
    const args = ideDiffArgs(ideFamily(id), left, right);
    if (!args) continue;
    const cmd = await resolveIdeCommand(id);
    if (!cmd) continue;
    try {
      await launchDetached(cmd, args);
      return { method: id, mode: 'diff' };
    } catch (err) {
      console.warn(`[Ergo Diff] Could not start ${cmd}:`, err);
    }
  }
  const opened = await openInIde(choice, fallback);
  const why =
    ide === 'auto'
      ? 'No editor with a diff view was found'
      : ideDiffArgs(ideFamily(ide), left, right)
        ? `${ideLabel(ide)}'s command-line launcher wasn't found`
        : `${ideLabel(ide)} can't open a diff from the command line`;
  return { ...opened, mode: 'file', note: `${why}, so the file opened instead.` };
}

// ── Git ──

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function git(args: string[], cwd: string, opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...opts.env }, timeout: opts.timeoutMs ?? 30_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }),
    );
  });
}

function gitBuffer(args: string[], cwd: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 30_000, windowsHide: true }, (err, stdout) =>
      resolve(err ? null : (stdout as Buffer)),
    );
  });
}

interface RepoInfo {
  top: string;
  /** cwd relative to `top`, '/'-separated with a trailing '/', or ''. */
  prefix: string;
}

async function repoOf(cwd: string): Promise<RepoInfo | null> {
  const res = await git(['rev-parse', '--show-toplevel', '--show-prefix'], cwd, { timeoutMs: 10_000 });
  if (!res.ok) return null;
  const [top, prefix = ''] = res.stdout.split(/\r?\n/);
  if (!top?.trim()) return null;
  return { top: path.resolve(top.trim()), prefix: prefix.trim() };
}

/**
 * The working tree as a git tree object (tracked + untracked files, .gitignore honored), written through a temporary
 * copy of the index so the user's own index is never changed. `trackedOnly` leaves untracked files out.
 */
async function snapshotTree(top: string, trackedOnly: boolean, timeoutMs: number): Promise<string | null> {
  const indexPath = await git(['rev-parse', '--git-path', 'index'], top, { timeoutMs: 10_000 });
  if (!indexPath.ok) return null;
  const realIndex = path.resolve(top, indexPath.stdout.trim());
  const tmpIndex = path.join(os.tmpdir(), `ergo-index-${randomBytes(6).toString('hex')}`);
  try {
    // Starting from the real index keeps its stat cache: only files that changed are read again.
    await fs.copyFile(realIndex, tmpIndex).catch(() => {});
    const env = { GIT_INDEX_FILE: tmpIndex };
    const add = await git(['add', trackedOnly ? '-u' : '-A', '--ignore-errors', '--', '.'], top, { env, timeoutMs });
    if (!add.ok && !/ignor|warning/i.test(add.stderr)) {
      console.warn('[Ergo Git] Could not snapshot the working tree:', add.stderr.trim().slice(0, 300));
    }
    const tree = await git(['write-tree'], top, { env, timeoutMs: 20_000 });
    return tree.ok && /^[0-9a-f]{40,64}$/.test(tree.stdout.trim()) ? tree.stdout.trim() : null;
  } finally {
    await fs.rm(tmpIndex, { force: true }).catch(() => {});
    await fs.rm(`${tmpIndex}.lock`, { force: true }).catch(() => {});
  }
}

/** Repos whose untracked files are hidden (a dotfiles repo in the home folder): only tracked files are compared. */
async function tracksOnly(top: string): Promise<boolean> {
  const res = await git(['config', '--get', 'status.showUntrackedFiles'], top, { timeoutMs: 5_000 });
  return res.ok && res.stdout.trim().toLowerCase() === 'no';
}

export interface RunGitBase {
  version: 1;
  git: boolean;
  /** The run's working folder (the agents' cwd). */
  cwd?: string;
  top?: string;
  prefix?: string;
  tree?: string;
  head?: string;
  trackedOnly?: boolean;
  at?: string;
  error?: string;
}

const BASE_FILE = 'git-base.json';

/**
 * Records the repo's state before a run's first agent starts (`<runDir>/git-base.json`); later agents of the run (and
 * follow-ups) find it there and leave it. Never throws; gives up after `timeoutMs` so an agent never waits long.
 */
export async function recordRunGitBase(cwd: string, runDir: string, timeoutMs = 20_000): Promise<void> {
  const file = path.join(runDir, BASE_FILE);
  if (fsSync.existsSync(file)) return;
  const write = (base: RunGitBase) => fs.writeFile(file, JSON.stringify(base, null, 2), 'utf-8').catch(() => {});
  const at = new Date().toISOString();
  try {
    const repo = await repoOf(cwd);
    // Not a repo, or a repo at the home folder / a drive root (snapshotting everything under it would be far too much).
    if (!repo || repo.top === path.resolve(os.homedir()) || path.dirname(repo.top) === repo.top) {
      return void (await write({ version: 1, git: false, cwd, at }));
    }
    const trackedOnly = await tracksOnly(repo.top);
    const [tree, head] = await Promise.all([
      snapshotTree(repo.top, trackedOnly, timeoutMs),
      git(['rev-parse', '--verify', '-q', 'HEAD'], repo.top, { timeoutMs: 5_000 }),
    ]);
    if (!tree) return void (await write({ version: 1, git: true, cwd, top: repo.top, prefix: repo.prefix, at, error: 'snapshot failed' }));
    await write({ version: 1, git: true, cwd, top: repo.top, prefix: repo.prefix, tree, ...(head.ok ? { head: head.stdout.trim() } : {}), trackedOnly, at });
  } catch (err: any) {
    await write({ version: 1, git: false, cwd, at, error: String(err?.message || err).slice(0, 300) });
  }
}

export async function readRunGitBase(runDir: string): Promise<RunGitBase | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(runDir, BASE_FILE), 'utf-8'));
    return parsed && parsed.version === 1 ? (parsed as RunGitBase) : null;
  } catch {
    return null;
  }
}

export interface ChangedFile {
  /** Relative to the run's working folder, '/'-separated. */
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'changed';
  additions: number;
  deletions: number;
  binary: boolean;
}

const MAX_CHANGED_FILES = 300;

/** What changed in the run's working folder since the run started. */
export async function runChangedFiles(base: RunGitBase, cwd: string): Promise<{ files: ChangedFile[]; truncated: boolean } | null> {
  if (!base.git || !base.tree || !base.top) return null;
  const tree = await snapshotTree(base.top, Boolean(base.trackedOnly), 30_000);
  if (!tree) return null;
  if (tree === base.tree) return { files: [], truncated: false };
  // --relative (run from the working folder): only files under it, with paths relative to it.
  const diff = (format: string) => git(['diff', format, '-z', '--no-renames', '--no-ext-diff', '--relative', base.tree!, tree], cwd);
  const [numstat, names] = await Promise.all([diff('--numstat'), diff('--name-status')]);
  if (!numstat.ok || !names.ok) return null;
  const statusOf = new Map<string, ChangedFile['status']>();
  const nameParts = names.stdout.split('\0');
  for (let i = 0; i + 1 < nameParts.length; i += 2) {
    const code = nameParts[i].trim().charAt(0);
    statusOf.set(nameParts[i + 1], code === 'A' ? 'added' : code === 'D' ? 'deleted' : code === 'M' ? 'modified' : 'changed');
  }
  const files: ChangedFile[] = [];
  for (const entry of numstat.stdout.split('\0')) {
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]+)$/.exec(entry);
    if (!m) continue;
    const binary = m[1] === '-';
    files.push({
      path: m[3],
      status: statusOf.get(m[3]) ?? 'changed',
      additions: binary ? 0 : Number(m[1]),
      deletions: binary ? 0 : Number(m[2]),
      binary,
    });
  }
  return { files: files.slice(0, MAX_CHANGED_FILES), truncated: files.length > MAX_CHANGED_FILES };
}

/**
 * A file's content when the run started, written to a temp file named after it ("App (before run).tsx") so the editor
 * highlights it; an empty one when the file didn't exist then.
 */
export async function writeRunBaseFile(base: RunGitBase, runId: string, relPath: string): Promise<string> {
  const rel = relPath.replace(/\\/g, '/');
  const ext = path.extname(rel);
  const stem = path.basename(rel, ext);
  const dir = path.join(os.tmpdir(), 'ergo-diffs', runId, createHash('sha1').update(rel).digest('hex').slice(0, 10));
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${stem} (before run)${ext}`);
  const inTree = `${base.prefix || ''}${rel}`;
  const content = base.tree ? await gitBuffer(['cat-file', 'blob', `${base.tree}:${inTree}`], base.top || base.cwd || '.') : null;
  await fs.writeFile(file, content ?? Buffer.alloc(0));
  return file;
}

/** An empty stand-in for a file the run deleted ("App (deleted).tsx"). */
export async function writeDeletedStandIn(runId: string, relPath: string): Promise<string> {
  const rel = relPath.replace(/\\/g, '/');
  const ext = path.extname(rel);
  const dir = path.join(os.tmpdir(), 'ergo-diffs', runId, createHash('sha1').update(rel).digest('hex').slice(0, 10));
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${path.basename(rel, ext)} (deleted)${ext}`);
  await fs.writeFile(file, '');
  return file;
}
