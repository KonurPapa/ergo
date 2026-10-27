/**
 * The verifier agent used to be called the "hardener" (in-app pipeline) and the "QA verifier" (CLI runs). Data
 * saved before the rename (projects, briefs, settings, API-key profiles, run state, the calibration table) still
 * carries the old field names and values; this rewrites them on load. Saving writes the new names.
 */

const KEY_RENAMES: Record<string, string> = {
  hardener: 'verifier',
  qa: 'verifier',
  qaVerification: 'verification',
};

/** Values renamed only under these keys: a bare "qa" elsewhere could be user text. */
const ROLE_KEYS = new Set(['role', 'agentRole', 'stage', 'kind', 'waitingOn']);
const ROLE_VALUES: Record<string, string> = { hardener: 'verifier', qa: 'verifier' };

const VALUE_RENAMES: Record<string, string> = {
  qa_failed: 'verifier_failed',
  qa_pass: 'verifier_pass',
  qa_fail: 'verifier_fail',
};

function renameKey(key: string): string {
  if (KEY_RENAMES[key]) return KEY_RENAMES[key];
  return key
    .replace(/hardener/g, 'verifier')
    .replace(/Hardener/g, 'Verifier')
    .replace(/^qa(?=[A-Z])/, 'verifier')
    .replace(/(?<=[a-z])Qa(?=[A-Z]|$)/g, 'Verifier');
}

/** Returns `value` with every legacy hardener / QA name rewritten (a new object; the input is left alone). */
export function migrateLegacyVerifier<T>(value: T): T {
  return walk(value, '') as T;
}

function walk(value: unknown, parentKey: string): unknown {
  if (Array.isArray(value)) return value.map((v) => walk(v, parentKey));
  if (typeof value === 'string') {
    if (ROLE_KEYS.has(parentKey) && ROLE_VALUES[value]) return ROLE_VALUES[value];
    return VALUE_RENAMES[value] ?? value;
  }
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const next = renameKey(key);
    // A record already saved under the new name wins over its legacy twin.
    if (next !== key && next in (value as Record<string, unknown>)) continue;
    out[next] = walk(v, next);
  }
  return out;
}

/** JSON.parse for saved data: also migrates legacy hardener / QA names. */
export function parseSavedJson(text: string): any {
  return migrateLegacyVerifier(JSON.parse(text));
}
