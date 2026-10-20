/**
 * Which models Auto model selection may choose from for one role target (src/lib/agentPipeline/autoRouter.ts).
 *
 *  - API-key profiles: the provider's catalog models that support tools and aren't retired, limited to the models
 *    the key can list (skipped when listing fails), dated duplicates collapsed onto the undated alias.
 *  - Claude Code: the aliases haiku / sonnet / opus, each priced and scored as the newest catalog model of its
 *    family, plus the newest claude-fable-* id.
 *  - Antigravity: the ids `agy models` reports, mapped to their base catalog model (thinking suffix removed; agy also
 *    serves Claude and GPT-OSS models, so any provider's catalog entry counts).
 *  - Codex: the newest-generation OpenAI models.
 *  - Ollama, Cursor, custom CLIs and unknown providers: none (Auto behaves like Manual for them).
 */
import type { AIProviderId, EffortLevel } from '../../types';
import { bridgeClient } from '../bridgeClient';
import { SUPPORTED_AI_PROVIDERS, fetchAnthropicModels, fetchGeminiModels, fetchGrokModels, fetchOpenAIModels } from '../aiProviders';
import { isSubscriptionTarget, resolveCliBinary } from '../agentPipeline/contracts';
import type { CatalogModel, CatalogProvider, ModelCatalog } from './types';
import { findBuiltinStrength } from '../agentPipeline/autoRouter';

/** Families Ergo knows how to pick models for. CLI families use the CLI's own model names. */
export type ModelFamily = 'anthropic' | 'openai' | 'gemini' | 'grok' | 'cli-claude' | 'cli-agy' | 'cli-codex';

export type RoleTargetLike = {
  provider: AIProviderId;
  authMode?: string;
  apiKey?: string;
  model?: string;
  cliAgentId?: string;
  cliCustomCommand?: string;
};

/** A model Auto may pick: the id passed to the provider / CLI, and the catalog entry it is priced and scored as. */
export interface CandidateModel {
  /** e.g. "claude-opus-5-5" (API), "opus" (Claude Code alias), "gemini-3.8-flash-high" (Antigravity). */
  id: string;
  model: CatalogModel;
}

function cliFamily(binary: string): ModelFamily | null {
  const base = binary.toLowerCase().replace(/^.*[\\/]/, '');
  if (base === 'claude') return 'cli-claude';
  if (base === 'agy' || base === 'antigravity') return 'cli-agy';
  if (base === 'codex') return 'cli-codex';
  return null;
}

export function familyForTarget(target: RoleTargetLike): ModelFamily | null {
  if (isSubscriptionTarget(target) || (target.provider === 'cursor' && !target.apiKey)) {
    return cliFamily(resolveCliBinary(target));
  }
  switch (target.provider) {
    case 'anthropic':
    case 'openai':
    case 'gemini':
    case 'grok':
      return target.provider;
    default:
      // Ollama (user's local models), Cursor API and unknown providers keep the configured model.
      return null;
  }
}

/** Short name of what the target runs, for "Auto isn't available for …" notes. */
export function targetLabel(target: RoleTargetLike): string {
  if (isSubscriptionTarget(target) || (target.provider === 'cursor' && !target.apiKey)) return `the ${resolveCliBinary(target)} CLI`;
  return SUPPORTED_AI_PROVIDERS.find((p) => p.id === target.provider)?.shortName || target.provider;
}

// ─── Id helpers ───────────────────────────────────────────────────────────────

/** Date stamps (20250805, 2025-08-07, Grok's 0309) and "-latest" aliases. */
const DATE_SUFFIX_RE = /-(?:\d{8}|\d{4}-\d{2}-\d{2}|\d{4}|latest)$/;

/** "claude-opus-4-1-20250805" → "claude-opus-4-1"; "gpt-5-2025-08-07" → "gpt-5"; "grok-4.3-latest" → "grok-4.3". */
export function undatedId(id: string): string {
  return id.replace(DATE_SUFFIX_RE, '');
}

/** Numeric version tokens after `prefix` (date suffix ignored): "claude-opus-5-5" / "claude-opus-" → [5, 5]. */
function versionAfter(id: string, prefix: string): number[] {
  return undatedId(id)
    .slice(prefix.length)
    .split(/[-.]/)
    .filter((t) => /^\d+$/.test(t))
    .map(Number);
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function isRetired(m: CatalogModel, now = Date.now()): boolean {
  if (!m.deprecationDate) return false;
  const at = Date.parse(m.deprecationDate);
  return Number.isFinite(at) && at <= now;
}

function blendedPriceOf(m: CatalogModel): number {
  return (3 * m.inputPerM + m.outputPerM) / 4;
}

/**
 * Tool-capable, not retired models of one provider. Free-priced entries (open-weight demos like Gemma) are left out:
 * they can't be placed on the price scale and aren't real agent options.
 */
function usableModels(catalog: ModelCatalog, provider: CatalogProvider): CatalogModel[] {
  return catalog.models.filter((m) => m.provider === provider && m.supportsTools && !isRetired(m) && blendedPriceOf(m) > 0);
}

/** One model per undated id, preferring the undated alias itself (else the newest dated one). */
export function collapseDated(models: CatalogModel[]): CatalogModel[] {
  const byBase = new Map<string, CatalogModel>();
  for (const m of models) {
    const base = undatedId(m.id);
    const cur = byBase.get(base);
    if (!cur) byBase.set(base, m);
    else if (m.id === base || (cur.id !== base && m.id > cur.id)) byBase.set(base, m);
  }
  return [...byBase.values()];
}

/** The newest model whose id starts with `prefix` (by version numbers; the undated alias wins a tie). */
function newestWithPrefix(models: CatalogModel[], prefix: string): CatalogModel | undefined {
  const matches = collapseDated(models.filter((m) => m.id.startsWith(prefix)));
  return matches.sort((a, b) => compareVersions(versionAfter(b.id, prefix), versionAfter(a.id, prefix)))[0];
}

// ─── Provider model lists (API keys) ─────────────────────────────────────────

const LIST_TTL_MS = 60 * 60_000;
const LIST_TIMEOUT_MS = 6_000;
const listCache = new Map<string, { at: number; ids: Set<string> | null }>();

function keyFingerprint(key: string): string {
  let hash = 5381;
  for (let i = 0; i < key.length; i++) hash = ((hash << 5) + hash + key.charCodeAt(i)) | 0;
  return `${(hash >>> 0).toString(36)}:${key.length}`;
}

/**
 * Model ids the key can use, cached 1 h per provider + key. Null when listing failed: the Anthropic and Grok
 * helpers return the static preset list instead of throwing, which is treated as a failure too.
 */
async function listProviderModelIds(provider: CatalogProvider, apiKey: string): Promise<Set<string> | null> {
  const cacheKey = `${provider}:${keyFingerprint(apiKey)}`;
  const hit = listCache.get(cacheKey);
  if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.ids;
  const fetchers = { anthropic: fetchAnthropicModels, openai: fetchOpenAIModels, gemini: fetchGeminiModels, grok: fetchGrokModels };
  const presets = SUPPORTED_AI_PROVIDERS.find((p) => p.id === provider)?.models;
  let ids: Set<string> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const list = await Promise.race([
      fetchers[provider](apiKey),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), LIST_TIMEOUT_MS);
      }),
    ]);
    if (list && list !== presets && list.length > 0) ids = new Set(list.map((m) => m.id));
  } catch {
    ids = null;
  } finally {
    clearTimeout(timer);
  }
  listCache.set(cacheKey, { at: Date.now(), ids });
  return ids;
}

/** The provider's model list from the cache, without fetching. Undefined when not listed yet; null when it failed. */
export function cachedProviderModelIds(provider: CatalogProvider, apiKey: string | undefined): Set<string> | null | undefined {
  const key = realKey(apiKey);
  if (!key) return undefined;
  const hit = listCache.get(`${provider}:${keyFingerprint(key)}`);
  return hit && Date.now() - hit.at < LIST_TTL_MS ? hit.ids : undefined;
}

/** Minimum built-in intelligence for a substitute tiny model. */
const TINY_MIN_INTELLIGENCE = 60;

/**
 * Synchronous tiny-model choice for an API provider: the first of `preferred` that is available (per the cached
 * provider list, else the cached catalog), else the cheapest available model of the provider with built-in
 * intelligence ≥ 60, else `preferred[0]`. Uses only what is already cached (never fetches).
 */
export function resolveTinyModelId(
  provider: CatalogProvider,
  apiKey: string | undefined,
  preferred: string[],
  catalog: ModelCatalog | null
): string | undefined {
  const listed = cachedProviderModelIds(provider, apiKey);
  const listedBases = listed ? new Set([...listed].map(undatedId)) : null;
  const usable = catalog ? usableModels(catalog, provider) : [];
  const isAvailable = (id: string) =>
    listed ? listed.has(id) || Boolean(listedBases?.has(undatedId(id))) : catalog ? usable.some((m) => m.id === id) : true;
  const hit = preferred.find(isAvailable);
  if (hit) return hit;
  if (catalog) {
    const substitute = collapseDated(usable.filter((m) => isAvailable(m.id)))
      .filter((m) => (findBuiltinStrength([m.id])?.intelligence ?? 0) >= TINY_MIN_INTELLIGENCE)
      .sort((a, b) => blendedPriceOf(a) - blendedPriceOf(b))[0];
    if (substitute) return substitute.id;
  }
  return preferred[0];
}

function realKey(key: string | undefined): string | undefined {
  return key && key.trim() && key !== 'cli_subscription_active' ? key.trim() : undefined;
}

async function apiCandidates(provider: CatalogProvider, apiKey: string | undefined, catalog: ModelCatalog): Promise<CandidateModel[]> {
  let models = usableModels(catalog, provider);
  const key = realKey(apiKey);
  const listed = key ? await listProviderModelIds(provider, key) : null;
  if (listed) {
    // Providers may list only dated ids (or only aliases): compare undated forms too.
    const listedBases = new Set([...listed].map(undatedId));
    const available = models.filter((m) => listed.has(m.id) || listedBases.has(undatedId(m.id)));
    // No overlap at all means the two lists name models differently; keep the catalog rather than nothing.
    if (available.length > 0) models = available;
  }
  return collapseDated(models).map((model) => ({ id: model.id, model }));
}

// ─── CLIs ────────────────────────────────────────────────────────────────────

function claudeCliCandidates(catalog: ModelCatalog): CandidateModel[] {
  const anthropic = usableModels(catalog, 'anthropic');
  const out: CandidateModel[] = [];
  for (const alias of ['haiku', 'sonnet', 'opus']) {
    const model = newestWithPrefix(anthropic, `claude-${alias}-`);
    if (model) out.push({ id: alias, model });
  }
  // Fable has no CLI alias: pass the full id.
  const fable = newestWithPrefix(anthropic, 'claude-fable-');
  if (fable) out.push({ id: fable.id, model: fable });
  return out;
}

let agyModelsCache: { at: number; ids: string[] | null } | null = null;

/** Models the local Antigravity CLI reports (`agy models`), cached for 10 minutes. Null when unknown. */
export async function fetchAgyModels(): Promise<string[] | null> {
  if (agyModelsCache && Date.now() - agyModelsCache.at < 10 * 60_000) return agyModelsCache.ids;
  let ids: string[] | null = null;
  try {
    const res = await fetch(bridgeClient.getApiUrl('/api/cli/models?cli=agy'));
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.models) && data.models.length > 0) ids = data.models.map((m: any) => String(m.id));
    }
  } catch {
    ids = null;
  }
  agyModelsCache = { at: Date.now(), ids };
  return ids;
}

const THINKING_SUFFIX_RE = /-(low|medium|high)$/;

/** Antigravity variant to prefer per stage effort (falling back to whatever exists). */
const AGY_VARIANT_ORDER: Record<EffortLevel, string[]> = {
  low: ['low', 'medium', '', 'high'],
  medium: ['medium', 'low', '', 'high'],
  high: ['high', 'medium', '', 'low'],
  xhigh: ['high', 'medium', '', 'low'],
  max: ['high', 'medium', '', 'low']
};

/**
 * Antigravity ids grouped by base model ("gemini-3.8-flash-high" → gemini-3.8-flash). agy serves models of several
 * providers (Gemini, Claude, GPT-OSS), so bases are matched against the whole catalog; a base the catalog can't price
 * is skipped. Each base is offered once, in the thinking variant that fits the stage's effort.
 */
export function agyCandidatesFrom(agyIds: string[], catalog: ModelCatalog, effort: EffortLevel = 'medium'): CandidateModel[] {
  const usable = catalog.models.filter((m) => m.supportsTools && !isRetired(m) && blendedPriceOf(m) > 0);
  const order = AGY_VARIANT_ORDER[effort];
  const variants = new Map<string, string[]>();
  for (const id of agyIds) {
    const base = id.replace(THINKING_SUFFIX_RE, '');
    variants.set(base, [...(variants.get(base) || []), id]);
  }
  const out: CandidateModel[] = [];
  for (const [base, ids] of variants) {
    const model = usable.find((m) => m.id === base) || collapseDated(usable.filter((m) => undatedId(m.id) === base))[0];
    if (!model) continue;
    const rank = (id: string) => order.indexOf(id.match(THINKING_SUFFIX_RE)?.[1] || '');
    const id = [...ids].sort((a, b) => rank(a) - rank(b))[0];
    out.push({ id, model });
  }
  return out;
}

/** The newest gpt-N generation (e.g. every gpt-6* id), newest minor version per variant, no ChatGPT-only ids. */
export function codexCandidatesFrom(catalog: ModelCatalog): CandidateModel[] {
  const gpt = collapseDated(usableModels(catalog, 'openai')).filter(
    (m) => /^gpt-\d+(?:\.\d+)?(?:-|$)/.test(m.id) && !/(?:^|-)(chat|cyber)(?:-|$)/.test(m.id)
  );
  const versionOf = (id: string) => id.match(/^gpt-(\d+)(?:\.(\d+))?/)!;
  const major = Math.max(-1, ...gpt.map((m) => Number(versionOf(m.id)[1])));
  const byVariant = new Map<string, CatalogModel>();
  for (const m of gpt) {
    const v = versionOf(m.id);
    if (Number(v[1]) !== major) continue;
    const variant = m.id.slice(v[0].length);
    const cur = byVariant.get(variant);
    if (!cur || Number(versionOf(cur.id)[2] || 0) < Number(v[2] || 0)) byVariant.set(variant, m);
  }
  return [...byVariant.values()].map((model) => ({ id: model.id, model }));
}

/**
 * Candidate models for one role target. Empty when Auto can't pick for it (unsupported provider / CLI, or nothing
 * matched); the caller then uses the profile's model. `effort` is the stage's effort (Antigravity thinking variant).
 */
export async function availableModelsFor(
  target: RoleTargetLike,
  catalog: ModelCatalog,
  opts: { effort?: EffortLevel } = {}
): Promise<CandidateModel[]> {
  const family = familyForTarget(target);
  switch (family) {
    case 'anthropic':
    case 'openai':
    case 'gemini':
    case 'grok':
      return apiCandidates(family, target.apiKey, catalog);
    case 'cli-claude':
      return claudeCliCandidates(catalog);
    case 'cli-agy': {
      const ids = await fetchAgyModels();
      return ids ? agyCandidatesFrom(ids, catalog, opts.effort) : [];
    }
    case 'cli-codex':
      return codexCandidatesFrom(catalog);
    default:
      return [];
  }
}
