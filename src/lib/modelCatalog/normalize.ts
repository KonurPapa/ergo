/**
 * Model catalog normalization, shared by the bridge (`/api/models/catalog` in vite.config.ts) and the snapshot
 * script (scripts/update-model-snapshot.mjs, which imports this file through Node's built-in TypeScript type
 * stripping). Keep it free of browser- and Node-specific APIs, and of non-erasable TypeScript syntax.
 *
 * - `normalizeLiteLlmPrices` turns LiteLLM's public price list into `CatalogModel`s.
 * - `parseArtificialAnalysisRows` keeps the fields Ergo uses from Artificial Analysis' `/data/llms/models`.
 * - `attachBenchmarks` matches those rows to catalog ids.
 */
import type { BenchmarkScores, CatalogModel, CatalogProvider } from './types.ts';

/** Bump when the rules below change, so caches written by an older bridge are refreshed (still usable as fallback). */
export const CATALOG_NORMALIZER_VERSION = 2;

// ─── Prices (LiteLLM) ───────────────────────────────────────────────────────

/** LiteLLM `litellm_provider` → Ergo provider, and the key prefix LiteLLM puts on that provider's ids. */
const LITELLM_PROVIDERS: Record<string, { provider: CatalogProvider; prefix: string }> = {
  anthropic: { provider: 'anthropic', prefix: '' },
  openai: { provider: 'openai', prefix: '' },
  gemini: { provider: 'gemini', prefix: 'gemini/' },
  xai: { provider: 'grok', prefix: 'xai/' },
};

/** Id tokens that mark a non-chat or special-purpose variant (matched against `-`/`.`/`_`-separated tokens). */
const EXCLUDED_ID_TOKENS = new Set([
  'batch',
  'realtime',
  'audio',
  'image',
  'tts',
  'transcribe',
  'embedding',
  'embed',
  'search',
  'moderation',
  'robotics',
  'lyria',
]);
/** Multi-token variants that are excluded as a phrase. */
const EXCLUDED_ID_PHRASES = ['computer-use', 'deep-research'];

const PROVIDER_ORDER: Record<CatalogProvider, number> = { anthropic: 0, openai: 1, gemini: 2, grok: 3 };

const roundPrice = (perToken: number): number => Math.round(perToken * 1e6 * 1e6) / 1e6;

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

function isExcludedVariant(id: string): boolean {
  if (id.startsWith('ft:') || id.includes(':ft') || id.includes('ft:')) return true; // fine-tunes
  if (EXCLUDED_ID_PHRASES.some((p) => id.includes(p))) return true;
  return id.split(/[-._]+/).some((t) => EXCLUDED_ID_TOKENS.has(t));
}

/**
 * LiteLLM `model_prices_and_context_window.json` → catalog models.
 *
 * Keeps `mode: "chat"` entries of anthropic / openai / gemini (prefix `gemini/` stripped) / xai (→ grok, prefix
 * `xai/` stripped); drops ids still containing `/`, fine-tunes and batch / realtime / audio / image / tts /
 * transcribe / embedding / search / moderation / computer-use / robotics / lyria / deep-research variants, and
 * entries without both prices (a price of 0 counts as missing: those are free previews or unpriced placeholders).
 * When a provider lists an id both with and without its prefix, the prefixed entry wins. Sorted by provider, then id.
 */
export function normalizeLiteLlmPrices(raw: unknown): CatalogModel[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const byId = new Map<string, { model: CatalogModel; prefixed: boolean }>();

  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (e.mode !== 'chat' || typeof e.litellm_provider !== 'string') continue;
    const mapping = LITELLM_PROVIDERS[e.litellm_provider];
    if (!mapping) continue;

    const prefixed = Boolean(mapping.prefix) && key.startsWith(mapping.prefix);
    const id = (prefixed ? key.slice(mapping.prefix.length) : key).trim();
    if (!id || id.includes('/') || isExcludedVariant(id.toLowerCase())) continue;
    if (!positive(e.input_cost_per_token) || !positive(e.output_cost_per_token)) continue;

    const model: CatalogModel = {
      id,
      provider: mapping.provider,
      inputPerM: roundPrice(e.input_cost_per_token),
      outputPerM: roundPrice(e.output_cost_per_token),
      supportsTools: e.supports_function_calling === true,
    };
    if (positive(e.cache_read_input_token_cost)) model.cacheReadPerM = roundPrice(e.cache_read_input_token_cost);
    if (positive(e.cache_creation_input_token_cost)) model.cacheWritePerM = roundPrice(e.cache_creation_input_token_cost);
    if (positive(e.max_input_tokens)) model.contextTokens = Math.floor(e.max_input_tokens);
    if (typeof e.supports_reasoning === 'boolean') model.supportsReasoning = e.supports_reasoning;
    if (typeof e.deprecation_date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(e.deprecation_date)) {
      model.deprecationDate = e.deprecation_date.slice(0, 10);
    }

    const existing = byId.get(`${mapping.provider}|${id}`);
    if (existing && (existing.prefixed || !prefixed)) continue;
    byId.set(`${mapping.provider}|${id}`, { model, prefixed });
  }

  return [...byId.values()]
    .map((v) => v.model)
    .sort((a, b) => PROVIDER_ORDER[a.provider] - PROVIDER_ORDER[b.provider] || a.id.localeCompare(b.id));
}

const CATALOG_PROVIDER_SET = new Set<string>(['anthropic', 'openai', 'gemini', 'grok']);
const optNumber = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Validates a model read back from a cache file (drops anything malformed, including stale `benchmarks`). */
export function sanitizeCatalogModel(raw: unknown): CatalogModel | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== 'string' || !m.id || typeof m.provider !== 'string' || !CATALOG_PROVIDER_SET.has(m.provider)) return null;
  if (!positive(m.inputPerM) || !positive(m.outputPerM)) return null;
  const model: CatalogModel = {
    id: m.id,
    provider: m.provider as CatalogProvider,
    inputPerM: m.inputPerM,
    outputPerM: m.outputPerM,
    supportsTools: m.supportsTools === true,
  };
  if (positive(m.cacheReadPerM)) model.cacheReadPerM = m.cacheReadPerM;
  if (positive(m.cacheWritePerM)) model.cacheWritePerM = m.cacheWritePerM;
  if (positive(m.contextTokens)) model.contextTokens = m.contextTokens;
  if (typeof m.supportsReasoning === 'boolean') model.supportsReasoning = m.supportsReasoning;
  if (typeof m.deprecationDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(m.deprecationDate)) model.deprecationDate = m.deprecationDate;
  return model;
}

// ─── Benchmarks (Artificial Analysis) ───────────────────────────────────────

/** One Artificial Analysis model row, reduced to what Ergo uses (this is what the bridge caches; never the key). */
export interface AaBenchmarkRow {
  name: string;
  slug: string;
  /** model_creator.slug (or name), lowercased with non-alphanumerics removed, e.g. "anthropic", "google", "xai". */
  creator?: string;
  intelligence?: number;
  coding?: number;
  math?: number;
  tokensPerSecond?: number;
}

/** `GET /api/v2/data/llms/models` body (`{ data: [...] }` or a bare array) → rows with at least one score. */
export function parseArtificialAnalysisRows(raw: unknown): AaBenchmarkRow[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? (raw as { data?: unknown }).data : undefined;
  if (!Array.isArray(list)) return [];
  const rows: AaBenchmarkRow[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const name = typeof r.name === 'string' ? r.name.trim().slice(0, 200) : '';
    const slug = typeof r.slug === 'string' ? r.slug.trim().slice(0, 200) : '';
    if (!name && !slug) continue;
    const evals = r.evaluations && typeof r.evaluations === 'object' ? (r.evaluations as Record<string, unknown>) : {};
    const row: AaBenchmarkRow = { name: name || slug, slug };
    const creatorRaw = r.model_creator && typeof r.model_creator === 'object' ? (r.model_creator as Record<string, unknown>) : null;
    const creator = String(creatorRaw?.slug ?? creatorRaw?.name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (creator) row.creator = creator.slice(0, 60);
    const intelligence = optNumber(evals.artificial_analysis_intelligence_index);
    const coding = optNumber(evals.artificial_analysis_coding_index);
    const math = optNumber(evals.artificial_analysis_math_index);
    const tps = optNumber(r.median_output_tokens_per_second);
    if (intelligence === undefined && coding === undefined && math === undefined) continue;
    if (intelligence !== undefined) row.intelligence = intelligence;
    if (coding !== undefined) row.coding = coding;
    if (math !== undefined) row.math = math;
    if (tps !== undefined && tps > 0) row.tokensPerSecond = tps;
    rows.push(row);
  }
  return rows;
}

/** Validates a row read back from the benchmarks cache. */
export function sanitizeAaRow(raw: unknown): AaBenchmarkRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== 'string' || typeof r.slug !== 'string') return null;
  const row: AaBenchmarkRow = { name: r.name, slug: r.slug };
  if (typeof r.creator === 'string' && r.creator) row.creator = r.creator;
  for (const k of ['intelligence', 'coding', 'math', 'tokensPerSecond'] as const) {
    const v = optNumber(r[k]);
    if (v !== undefined) row[k] = v;
  }
  return row.intelligence === undefined && row.coding === undefined && row.math === undefined ? null : row;
}

/** AA creator → catalog provider. A row from a known creator only matches that provider's models. */
const CREATOR_PROVIDER: Record<string, CatalogProvider> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'gemini',
  googledeepmind: 'gemini',
  deepmind: 'gemini',
  gemini: 'gemini',
  xai: 'grok',
};
const CREATOR_TOKENS = new Set(Object.keys(CREATOR_PROVIDER));

/**
 * Words that only describe a release channel, a reasoning mode or an effort setting. They're ignored when comparing
 * names, so "gemini-3.1-pro-preview" ≈ "Gemini 3.1 Pro" and "claude-opus-5-5" ≈ "claude-opus-5-5-thinking".
 * (Month names cover AA dates like "Sep '25" outside parentheses.)
 */
const IGNORED_WORDS = new Set([
  'preview',
  'exp',
  'experimental',
  'latest',
  'beta',
  'thinking',
  'reasoning',
  'non',
  'nonreasoning',
  'adaptive',
  'effort',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'sept',
  'oct',
  'nov',
  'dec',
]);

interface NameKey {
  /** Sorted, de-duplicated word tokens. */
  words: string;
  /** Version numbers in order (dates removed), e.g. "5.5". */
  nums: string;
  nonReasoning: boolean;
}

/**
 * Normalizes a model name, slug or id: lowercase, `.` → `-`, parenthesised qualifiers and dates removed, split into
 * letter / digit runs ("gpt-4o" → gpt 4 o), the creator prefix stripped, then version numbers kept in order and the
 * remaining words compared as a set (so "claude-5-5-opus" ≈ "claude-opus-5-5").
 */
function nameKey(text: string, creator?: string): NameKey | null {
  const lower = text.toLowerCase();
  const nonReasoning = /non[-\s_]?reasoning/.test(lower);
  const cleaned = lower
    .replace(/\([^)]*\)/g, ' ')
    .replace(/'\d{2}\b/g, ' ') // "Sep '25"
    .replace(/\b20\d{2}-\d{2}-\d{2}\b/g, ' ') // 2026-03-17
    .replace(/\b(0[1-9]|1[0-2])-20\d{2}\b/g, ' ') // 04-2026
    .replace(/\./g, '-');
  let tokens = cleaned.split(/[^a-z0-9]+/).flatMap((t) => t.match(/[a-z]+|[0-9]+/g) ?? []);
  // Strip a creator prefix ("anthropic/claude-…", "x-ai grok …").
  const creators = creator ? new Set([...CREATOR_TOKENS, creator]) : CREATOR_TOKENS;
  if (tokens.length > 1 && creators.has(tokens[0])) tokens = tokens.slice(1);
  else if (tokens.length > 2 && creators.has(tokens[0] + tokens[1])) tokens = tokens.slice(2);

  const nums: string[] = [];
  const words = new Set<string>();
  for (const t of tokens) {
    if (/^\d+$/.test(t)) {
      if (t.length >= 4) continue; // dates: 20251001, 0309, 2026
      nums.push(String(Number(t)));
    } else if (!IGNORED_WORDS.has(t)) {
      words.add(t);
    }
  }
  if (!words.size) return null;
  return { words: [...words].sort().join(' '), nums: nums.join('.'), nonReasoning };
}

const keyString = (provider: CatalogProvider, k: NameKey) => `${provider}|${k.words}|${k.nums}`;

/**
 * Attaches Artificial Analysis scores to the catalog models they describe. A row matches a model when its name or
 * slug normalizes (see `nameKey`) to the same word set and the same version numbers as the model id. When several
 * rows match one model (AA lists reasoning and non-reasoning variants separately), the one whose reasoning mode
 * agrees with the id wins ("…-non-reasoning" ids take non-reasoning rows, other ids prefer reasoning rows), then the
 * highest Intelligence Index. Returns new model objects; existing `benchmarks` are replaced or removed.
 */
export function attachBenchmarks(models: CatalogModel[], rows: AaBenchmarkRow[]): { models: CatalogModel[]; matched: number } {
  const index = new Map<string, number[]>();
  const modelKeys: Array<NameKey | null> = models.map((m) => nameKey(m.id));
  modelKeys.forEach((k, i) => {
    if (!k) return;
    const key = keyString(models[i].provider, k);
    const list = index.get(key);
    if (list) list.push(i);
    else index.set(key, [i]);
  });

  const candidates = new Map<number, Array<{ row: AaBenchmarkRow; nonReasoning: boolean }>>();
  for (const row of rows) {
    const provider = row.creator ? CREATOR_PROVIDER[row.creator] : undefined;
    const providers: CatalogProvider[] = provider ? [provider] : ['anthropic', 'openai', 'gemini', 'grok'];
    const nonReasoning = /non[-\s_]?reasoning/i.test(row.name) || /non[-_]?reasoning/i.test(row.slug);
    const hits = new Set<number>();
    for (const text of [row.name, row.slug]) {
      if (!text) continue;
      const k = nameKey(text, row.creator);
      if (!k) continue;
      for (const p of providers) for (const i of index.get(keyString(p, k)) ?? []) hits.add(i);
    }
    for (const i of hits) {
      const list = candidates.get(i);
      const entry = { row, nonReasoning };
      if (list) list.push(entry);
      else candidates.set(i, [entry]);
    }
  }

  let matched = 0;
  const out = models.map((m, i) => {
    const { benchmarks: _drop, ...base } = m;
    void _drop;
    const list = candidates.get(i);
    if (!list?.length) return base;
    const wantNonReasoning = modelKeys[i]?.nonReasoning ?? false;
    const best = [...list].sort(
      (a, b) =>
        Number(b.nonReasoning === wantNonReasoning) - Number(a.nonReasoning === wantNonReasoning) ||
        (b.row.intelligence ?? -1) - (a.row.intelligence ?? -1) ||
        (b.row.coding ?? -1) - (a.row.coding ?? -1),
    )[0].row;
    const benchmarks: BenchmarkScores = { matchedName: best.name };
    if (best.intelligence !== undefined) benchmarks.intelligence = best.intelligence;
    if (best.coding !== undefined) benchmarks.coding = best.coding;
    if (best.math !== undefined) benchmarks.math = best.math;
    if (best.tokensPerSecond !== undefined) benchmarks.tokensPerSecond = best.tokensPerSecond;
    matched++;
    return { ...base, benchmarks };
  });
  return { models: out, matched };
}
