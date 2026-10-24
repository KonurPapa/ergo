/**
 * CLI run state on the user's machine (<storage root>/config/cli-runs.json, through the bridge): what lets a reload, a
 * second browser or a restarted app pick a run back up, since the agents themselves run in the bridge. The app reads
 * a copy kept in memory (loaded once per bridge connection) and writes the file shortly after each change.
 *
 * Several open tabs may write: each write re-reads the file and keeps, per run, the most recently saved state.
 */
import { readFilesFromDisk, writeFilesToDisk } from './fileSystem';

const RUNS_FILE = 'config/cli-runs.json';
/** Where runs used to be kept (browser localStorage, one key per run): moved to RUNS_FILE once, then cleared. */
const LEGACY_PREFIX = 'ergo_cli_run_';
const WRITE_DELAY_MS = 400;
/** Runs older than this are dropped (their completion logs stay on the task's brief). */
export const RUN_STATE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export interface StoredRunState {
  runId: string;
  savedAt?: number;
  [key: string]: unknown;
}

const runs = new Map<string, StoredRunState>();
let loaded: Promise<void> | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let writing: Promise<void> = Promise.resolve();

function parseFile(raw: string | null | undefined): Record<string, StoredRunState> {
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed.runs === 'object' && parsed.runs ? parsed.runs : {};
  } catch {
    return {};
  }
}

function takeLegacyRuns(): StoredRunState[] {
  const out: StoredRunState[] = [];
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(LEGACY_PREFIX)) keys.push(key);
    }
    for (const key of keys) {
      try {
        const state = JSON.parse(localStorage.getItem(key) || 'null');
        if (state && typeof state.runId === 'string') out.push(state);
      } catch {}
    }
  } catch {}
  return out;
}

function clearLegacyRuns(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(LEGACY_PREFIX)) keys.push(key);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  } catch {}
}

/** Newest state per run, fresh ones only. */
function mergeInto(target: Map<string, StoredRunState>, states: Iterable<StoredRunState>): void {
  const now = Date.now();
  for (const s of states) {
    if (!s || typeof s.runId !== 'string') continue;
    if (typeof s.savedAt === 'number' && now - s.savedAt > RUN_STATE_TTL_MS) continue;
    const prev = target.get(s.runId);
    if (!prev || (s.savedAt ?? 0) >= (prev.savedAt ?? 0)) target.set(s.runId, s);
  }
}

/** Loads the runs from the user's machine (moving browser-kept runs there once). Resolves even when it fails. */
export function loadRunStates(force = false): Promise<void> {
  if (loaded && !force) return loaded;
  loaded = (async () => {
    try {
      const files = await readFilesFromDisk([RUNS_FILE]);
      mergeInto(runs, Object.values(parseFile(files[RUNS_FILE])));
      const legacy = takeLegacyRuns();
      if (legacy.length > 0) {
        mergeInto(runs, legacy);
        if (await flush()) clearLegacyRuns();
      }
    } catch (err) {
      console.warn('[Run state] Could not load CLI runs from disk:', err);
    }
  })();
  return loaded;
}

async function flush(): Promise<boolean> {
  const files = await readFilesFromDisk([RUNS_FILE]).catch(() => ({} as Record<string, string | null>));
  const merged = new Map<string, StoredRunState>();
  mergeInto(merged, Object.values(parseFile(files[RUNS_FILE])));
  mergeInto(merged, runs.values());
  for (const [id, s] of merged) if (!runs.has(id) || (s.savedAt ?? 0) > (runs.get(id)!.savedAt ?? 0)) runs.set(id, s);
  const res = await writeFilesToDisk([
    { filePath: RUNS_FILE, content: JSON.stringify({ version: 1, runs: Object.fromEntries(merged) }) },
  ]);
  return res.success;
}

function scheduleWrite(): void {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    writing = writing.then(() => flush().then(() => undefined)).catch(() => undefined);
  }, WRITE_DELAY_MS);
}

export function getRunState(runId: string): StoredRunState | null {
  return runs.get(runId) ?? null;
}

export function listRunStates(): StoredRunState[] {
  return [...runs.values()];
}

export function putRunState(state: StoredRunState): void {
  runs.set(state.runId, { ...state, savedAt: Date.now() });
  scheduleWrite();
}

/** Drops runs older than RUN_STATE_TTL_MS. */
export function pruneRunStates(): void {
  const now = Date.now();
  let changed = false;
  for (const [id, s] of runs) {
    if (typeof s.savedAt !== 'number' || now - s.savedAt > RUN_STATE_TTL_MS) {
      runs.delete(id);
      changed = true;
    }
  }
  if (changed) scheduleWrite();
}
