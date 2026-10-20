/**
 * Model catalog — browser client for the bridge's `POST /api/models/catalog` (prices from LiteLLM, optional
 * Artificial Analysis benchmarks). Used by Auto model selection (src/lib/agentPipeline/autoRouter.ts) and Settings.
 *
 * Never throws: when the bridge can't be reached the bundled price snapshot is returned (no benchmarks).
 * Results are kept in memory for 10 minutes; the bridge caches on disk for longer.
 */
import { bridgeClient } from '../bridgeClient';
import { PRICE_SNAPSHOT } from './priceSnapshot';
import type { ModelCatalog, ModelCatalogRequest, ModelCatalogResponse } from './types';

const CACHE_MS = 10 * 60_000;
/** A snapshot served because the bridge was down is retried sooner. */
const SNAPSHOT_CACHE_MS = 60_000;
/** The bridge's own upstream fetches are capped at 10 s; leave room for both prices and benchmarks. */
const REQUEST_TIMEOUT_MS = 25_000;

// The Artificial Analysis key from Settings (App sets it on load and on change), so library code that routes models
// doesn't need it passed through every call. Memory only.
let configuredKey = '';

export function setArtificialAnalysisKey(key: string | undefined | null): void {
  const next = (key || '').trim();
  if (next !== configuredKey) cache = null;
  configuredKey = next;
}

export function getArtificialAnalysisKey(): string {
  return configuredKey;
}

let cache: { at: number; key: string; ttl: number; catalog: ModelCatalog } | null = null;
let inflight: { key: string; promise: Promise<ModelCatalog> } | null = null;

export interface GetModelCatalogOptions {
  /** Defaults to the key set with setArtificialAnalysisKey. Pass '' to fetch without benchmarks. */
  artificialAnalysisKey?: string;
  /** Ask the bridge to bypass its cache age check (it rate-limits this to once per 5 minutes). */
  refresh?: boolean;
  signal?: AbortSignal;
}

export async function getModelCatalog(opts: GetModelCatalogOptions = {}): Promise<ModelCatalog> {
  const key = (opts.artificialAnalysisKey ?? configuredKey).trim();
  if (!opts.refresh) {
    if (cache && cache.key === key && Date.now() - cache.at < cache.ttl) return cache.catalog;
    if (inflight && inflight.key === key) return inflight.promise;
  }
  const promise = fetchCatalog(key, Boolean(opts.refresh), opts.signal).then(({ catalog, fromBridge }) => {
    if (!opts.signal?.aborted) cache = { at: Date.now(), key, ttl: fromBridge ? CACHE_MS : SNAPSHOT_CACHE_MS, catalog };
    return catalog;
  });
  inflight = { key, promise };
  try {
    return await promise;
  } finally {
    if (inflight?.promise === promise) inflight = null;
  }
}

/** The last catalog fetched (any key), without fetching; null before the first fetch. */
export function peekModelCatalog(): ModelCatalog | null {
  return cache?.catalog ?? null;
}

/** The bundled snapshot (no network). */
export function snapshotCatalog(): ModelCatalog {
  return PRICE_SNAPSHOT;
}

async function fetchCatalog(key: string, refresh: boolean, parent?: AbortSignal): Promise<{ catalog: ModelCatalog; fromBridge: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  parent?.addEventListener('abort', onAbort, { once: true });
  try {
    const body: ModelCatalogRequest = { ...(key ? { artificialAnalysisKey: key } : {}), ...(refresh ? { refresh: true } : {}) };
    const res = await bridgeClient.fetch('/api/models/catalog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = (await res.json().catch(() => null)) as ModelCatalogResponse | null;
    if (!json || json.success !== true || !Array.isArray(json.models)) {
      console.warn('[Model catalog] Bridge returned no catalog, using the bundled price snapshot:', (json as any)?.error || `HTTP ${res.status}`);
      return { catalog: PRICE_SNAPSHOT, fromBridge: false };
    }
    const { success: _success, ...catalog } = json;
    return { catalog, fromBridge: true };
  } catch (err) {
    if (!parent?.aborted) console.warn('[Model catalog] Bridge unreachable, using the bundled price snapshot:', err instanceof Error ? err.message : err);
    return { catalog: PRICE_SNAPSHOT, fromBridge: false };
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', onAbort);
  }
}

/** True when the catalog carries live (or cached) Artificial Analysis scores. */
export function usesArtificialAnalysis(catalog: Pick<ModelCatalog, 'sources'>): boolean {
  return catalog.sources.benchmarks === 'artificial-analysis' || catalog.sources.benchmarks === 'artificial-analysis-cache';
}

/** "3 h ago", "just now", "on 2026-10-01" — for price-source lines. Empty for a missing / bad date. */
export function formatCatalogAge(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const mins = Math.round((now - at) / 60_000);
  if (mins < 2) return 'just now';
  if (mins < 90) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `on ${new Date(at).toISOString().slice(0, 10)}`;
}

/** " from 2026-10-15" for a snapshot's generation date ('' when unknown). */
export function snapshotDate(iso: string): string {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? ` from ${new Date(at).toISOString().slice(0, 10)}` : '';
}

/** One line naming where prices (and benchmarks) came from, e.g. "Prices: LiteLLM (live, 2 h ago)". */
export function describeCatalogSources(catalog: Pick<ModelCatalog, 'sources' | 'fetchedAt'>): string {
  const age = formatCatalogAge(catalog.fetchedAt);
  const prices =
    catalog.sources.prices === 'litellm'
      ? `Prices: LiteLLM${age ? ` (fetched ${age})` : ''}`
      : catalog.sources.prices === 'litellm-cache'
        ? `Prices: LiteLLM, cached${age ? ` ${age}` : ''} (couldn't refresh)`
        : `Prices: bundled snapshot${snapshotDate(catalog.fetchedAt)} (bridge offline)`;
  const benchmarks = usesArtificialAnalysis(catalog)
    ? `Benchmarks: Artificial Analysis (artificialanalysis.ai)${catalog.sources.benchmarks === 'artificial-analysis-cache' ? ', cached' : ''}`
    : `Strengths: built-in table${catalog.sources.benchmarksError ? ` (${catalog.sources.benchmarksError})` : ''}`;
  return `${prices} · ${benchmarks}`;
}
