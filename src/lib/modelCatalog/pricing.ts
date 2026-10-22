/**
 * Pricing — what a call cost at the provider's API prices, from its token usage and the model catalog.
 * Shared by the browser (pipeline calls) and the bridge (CLI session logs); no browser or Node APIs.
 *
 * Input tokens are split the way providers bill them: plain input, prompt-cache reads (cheap) and cache writes
 * (Anthropic charges a premium). For subscription CLIs this is the API-equivalent value, not a charge.
 */
import type { CatalogModel } from './types.ts';

export interface PricedUsage {
  /** All prompt tokens, including cache reads and writes. */
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  /** Part of `cacheWriteTokens` written with Anthropic's 1-hour TTL, billed at 2× the input price (5-minute writes: 1.25×). */
  cacheWrite1hTokens?: number;
}

/** Strips date suffixes and provider prefixes so "claude-sonnet-5-5-20260101" or "anthropic/claude-sonnet-5.5" match. */
function normalizeId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/^(anthropic|openai|google|gemini|xai|models)\//, '')
    .replace(/[-@](\d{8}|\d{4}-\d{2}-\d{2})$/, '')
    .replace(/-latest$/, '');
}

/**
 * The catalog entry for a model id: exact, then without date / provider decorations, then the longest catalog id the
 * model id starts with (e.g. "claude-opus-5-5-thinking" → "claude-opus-5-5"). Undefined when nothing matches.
 */
export function findModelPrice(models: readonly CatalogModel[], modelId: string | undefined | null): CatalogModel | undefined {
  if (!modelId) return undefined;
  const exact = models.find((m) => m.id === modelId);
  if (exact) return exact;
  const want = normalizeId(modelId);
  const normalized = models.find((m) => normalizeId(m.id) === want);
  if (normalized) return normalized;
  let best: CatalogModel | undefined;
  for (const m of models) {
    const id = normalizeId(m.id);
    if (want.startsWith(id) && (!best || id.length > normalizeId(best.id).length)) best = m;
  }
  return best;
}

/** USD for one call (or a sum of calls on the same model) at API prices. */
export function usageCostUsd(usage: PricedUsage, price: Pick<CatalogModel, 'inputPerM' | 'outputPerM' | 'cacheReadPerM' | 'cacheWritePerM'>): number {
  const cached = Math.max(0, usage.cachedInputTokens || 0);
  const written = Math.max(0, usage.cacheWriteTokens || 0);
  const plain = Math.max(0, (usage.inputTokens || 0) - cached - written);
  const written1h = Math.min(written, Math.max(0, usage.cacheWrite1hTokens || 0));
  const perToken = (perM: number | undefined, fallback: number) => (perM ?? fallback) / 1e6;
  return (
    plain * perToken(price.inputPerM, 0) +
    cached * perToken(price.cacheReadPerM, price.inputPerM) +
    (written - written1h) * perToken(price.cacheWritePerM, price.inputPerM) +
    written1h * perToken(price.inputPerM, 0) * 2 +
    Math.max(0, usage.outputTokens || 0) * perToken(price.outputPerM, 0)
  );
}

/** Cost of `usage` on `modelId`, or undefined when the model isn't in the catalog. */
export function priceUsage(models: readonly CatalogModel[], modelId: string | undefined | null, usage: PricedUsage): number | undefined {
  const price = findModelPrice(models, modelId);
  return price ? usageCostUsd(usage, price) : undefined;
}

/** Claude Code / CLI aliases → the family prefix whose newest catalog model they mean. */
const CLI_ALIASES: Record<string, string> = { haiku: 'claude-haiku-', sonnet: 'claude-sonnet-', opus: 'claude-opus-', fable: 'claude-fable-' };

/** Resolves "sonnet" to the newest "claude-sonnet-*" in the catalog; other ids pass through. */
export function resolveAliasModelId(models: readonly CatalogModel[], modelId: string | undefined | null): string | undefined {
  if (!modelId) return undefined;
  const prefix = CLI_ALIASES[modelId.trim().toLowerCase()];
  if (!prefix) return modelId;
  const matches = models
    .filter((m) => m.id.startsWith(prefix) && !/\d{8}$/.test(m.id))
    .map((m) => m.id)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return matches[0] ?? modelId;
}
