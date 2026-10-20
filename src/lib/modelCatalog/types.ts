/**
 * Model catalog — shared types for the bridge (`/api/models/catalog`, vite.config.ts) and the browser
 * (src/lib/modelCatalog/catalog.ts, src/lib/agentPipeline/autoRouter.ts).
 *
 * Prices come live from LiteLLM's public price list (no key), cached on disk by the bridge, with a bundled
 * snapshot as the last resort. Benchmark scores come from Artificial Analysis when the user adds a free key;
 * otherwise from the built-in strengths table (builtinStrengths.ts).
 */

/** Direct-API providers the catalog covers (Ergo's provider ids). */
export type CatalogProvider = 'anthropic' | 'openai' | 'gemini' | 'grok';

export const CATALOG_PROVIDERS: readonly CatalogProvider[] = ['anthropic', 'openai', 'gemini', 'grok'];

/** Artificial Analysis scores for one model, as published (not normalized). */
export interface BenchmarkScores {
  /** artificial_analysis_intelligence_index */
  intelligence?: number;
  /** artificial_analysis_coding_index */
  coding?: number;
  /** artificial_analysis_math_index */
  math?: number;
  /** median_output_tokens_per_second */
  tokensPerSecond?: number;
  /** The Artificial Analysis model name this entry was matched to (for the routing explanation). */
  matchedName: string;
}

export interface CatalogModel {
  /** The id the provider's API (and Ergo) uses, e.g. "claude-opus-5-5", "gpt-5.6-terra", "gemini-3.8-flash", "grok-4.7". */
  id: string;
  provider: CatalogProvider;
  /** USD per million input tokens. */
  inputPerM: number;
  /** USD per million output tokens. */
  outputPerM: number;
  /** USD per million input tokens served from the prompt cache (typically 5–25% of inputPerM). */
  cacheReadPerM?: number;
  /** USD per million input tokens written to the prompt cache (Anthropic charges a premium; others don't). */
  cacheWritePerM?: number;
  contextTokens?: number;
  supportsTools: boolean;
  supportsReasoning?: boolean;
  /** ISO date from the price list when the provider has announced a retirement. */
  deprecationDate?: string;
  /** Live benchmark scores, present only when an Artificial Analysis key is set and the model was matched. */
  benchmarks?: BenchmarkScores;
}

export type PriceSource = 'litellm' | 'litellm-cache' | 'snapshot';
export type BenchmarkSource = 'artificial-analysis' | 'artificial-analysis-cache' | 'none';

export interface ModelCatalog {
  /** When the prices were fetched (ISO). For the snapshot: when it was generated. */
  fetchedAt: string;
  sources: {
    prices: PriceSource;
    benchmarks: BenchmarkSource;
    /** Why live benchmarks are missing although a key was given (bad key, rate limit, offline). */
    benchmarksError?: string;
  };
  models: CatalogModel[];
}

/** POST /api/models/catalog request body. */
export interface ModelCatalogRequest {
  /** Artificial Analysis API key (optional). Sent per request; the bridge never stores or logs it. */
  artificialAnalysisKey?: string;
  /** Bypass the cache age check (rate-limited by the bridge to once per 5 minutes). */
  refresh?: boolean;
}

export type ModelCatalogResponse = ({ success: true } & ModelCatalog) | { success: false; error: string };
