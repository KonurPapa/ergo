/**
 * The user's small app state with no other home (scheduled tasks, beta flag, providers they disconnected) on their
 * machine: <storage root>/config/preferences.json, through the bridge (app settings live in config/settings.json).
 * Nothing about a user is kept by the Ergo site; until the file loads (on each bridge connection) the app runs on
 * Ergo's defaults.
 *
 * Reads are synchronous from a copy in memory; writes go to the file shortly after each change. Components whose
 * state starts from a preference subscribe to pick up the loaded values.
 */
import { readFilesFromDisk, writeFilesToDisk } from './fileSystem';

const PREFS_FILE = 'config/preferences.json';
const WRITE_DELAY_MS = 400;

/** Keys these preferences were kept under in browser localStorage: moved to PREFS_FILE once, then cleared. */
const LEGACY_KEYS = ['ergo_scheduled_tasks', 'ergo_beta_features_enabled'];
/** Browser copies of values config/settings.json already holds: just removed. */
const STALE_MIRROR_KEYS = ['ergo_autosave_enabled', 'ergo_autosave_delay_sec', 'ergo_active_key_id', 'ergo_autocomplete_settings'];
const LEGACY_PREFIXES = ['ergo_disconnected_'];

let prefs: Record<string, string> = {};
let loaded = false;
let writeTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

const isLegacyKey = (key: string) => LEGACY_KEYS.includes(key) || LEGACY_PREFIXES.some((p) => key.startsWith(p));

function notify() {
  listeners.forEach((cb) => {
    try {
      cb();
    } catch {}
  });
}

function scheduleWrite() {
  if (!loaded || writeTimer) return; // never save before the user's file is loaded (it would overwrite it)
  writeTimer = setTimeout(() => {
    writeTimer = null;
    writeFilesToDisk([{ filePath: PREFS_FILE, content: JSON.stringify({ version: 1, prefs }, null, 2) }]).catch((err) =>
      console.warn('[Prefs] Could not save preferences:', err)
    );
  }, WRITE_DELAY_MS);
}

export function getPref(key: string): string | null {
  return Object.prototype.hasOwnProperty.call(prefs, key) ? prefs[key] : null;
}

export function setPref(key: string, value: string): void {
  if (prefs[key] === value) return;
  prefs = { ...prefs, [key]: value };
  scheduleWrite();
  notify();
}

export function removePref(key: string): void {
  if (!(key in prefs)) return;
  const { [key]: _removed, ...rest } = prefs;
  prefs = rest;
  scheduleWrite();
  notify();
}

/** Called after the preferences load (and whenever they change). */
export function subscribePrefs(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Loads the preferences from the user's machine (moving browser-kept ones there once). Never throws. */
export async function loadPrefs(): Promise<void> {
  try {
    const files = await readFilesFromDisk([PREFS_FILE]);
    const raw = files[PREFS_FILE];
    if (raw === undefined) return; // bridge unreachable: keep what is in memory, try again on the next connection
    const fromDisk: Record<string, string> = raw ? JSON.parse(raw)?.prefs ?? {} : {};
    // Changes made in this session before the load finished win over the file.
    const merged = { ...fromDisk, ...(loaded ? {} : prefs) };
    const legacyKeys: string[] = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && isLegacyKey(key)) legacyKeys.push(key);
      }
    } catch {}
    for (const key of legacyKeys) {
      const value = localStorage.getItem(key);
      if (value !== null && !(key in merged)) merged[key] = value;
    }
    const needsWrite = raw === null || legacyKeys.length > 0 || Object.keys(merged).length !== Object.keys(fromDisk).length;
    prefs = merged;
    loaded = true;
    if (needsWrite) {
      const res = await writeFilesToDisk([{ filePath: PREFS_FILE, content: JSON.stringify({ version: 1, prefs }, null, 2) }]);
      if (res.success) legacyKeys.forEach((k) => localStorage.removeItem(k));
    }
    try {
      STALE_MIRROR_KEYS.forEach((k) => localStorage.removeItem(k));
    } catch {}
    notify();
  } catch (err) {
    console.warn('[Prefs] Could not load preferences:', err);
  }
}
