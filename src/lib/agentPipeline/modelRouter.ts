/**
 * Model router — the model + effort for each pipeline stage of a run, decided once before any agent starts (route at
 * task boundaries — keeps caches stable).
 *
 *  - Manual: the per-stage models of the AI profile (roleConfigs), with the effort filled in. A stage without a
 *    model uses the provider default.
 *  - Auto: autoRouter.ts picks each stage's model for the task from the provider's available models
 *    (modelCatalog/availability.ts), their strengths and live prices, using the task rating (taskRating.ts). Stages
 *    Auto can't serve (Ollama, Cursor, custom CLIs, nothing matched) fall back to Manual's choice.
 *
 * Effort: Auto picks it per stage with the model (autoRouter.ts stagePlan: difficulty sets effort, the slider shifts
 * it); Manual uses the slider's level (one step lower for bookkeeping stages, effortForRole). Escalation steps (QA
 * retries, reruns after a failed run) climb one rung each: Auto moves to the next model tier, then more effort;
 * Manual keeps the profile's models and raises effort. The tiny cloud model (tinyCloudModelFor) makes the
 * small background decisions (run shape, autocomplete, task rating) when the local model is not used.
 */
import { type AIProviderConfig, type AgentRole, type AgentModelConfig, type EffortLevel, type MCPServer, type AIProviderId, type ModelSelectionMode, type TaskRating } from '../../types';
import { resolveCliBinary, isSubscriptionTarget, isCliPlaceholderModel, resolveRoleTarget } from './contracts';
import { familyForTarget, availableModelsFor, resolveTinyModelId, targetLabel, type ModelFamily } from '../modelCatalog/availability';
import { getModelCatalog, describeCatalogSources, peekModelCatalog } from '../modelCatalog/catalog';
import type { ModelCatalog } from '../modelCatalog/types';
import { DEFAULT_TASK_RATING, describeTaskRating, formatModelPrice, pickModelForStage, shiftEffort, type CalibrateFn, type ScoreSource } from './autoRouter';
import { calibrationAdjustment, measuredCacheShare, ratingGroup, type CalibrationFile } from './calibration';
import { getCalibration } from './calibrationStore';

export { familyForTarget, type ModelFamily };

export const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max'
};

/** Bookkeeping stages run one effort step below the chosen level to save tokens. */
const LIGHT_ROLES = new Set<AgentRole>(['summary', 'logger', 'cleaner', 'autocomplete']);

export function effortForRole(role: AgentRole, effort: EffortLevel): EffortLevel {
  if (!LIGHT_ROLES.has(role)) return effort;
  return EFFORT_LEVELS[Math.max(0, EFFORT_LEVELS.indexOf(effort) - 1)];
}

export interface RoutingDecision {
  role: AgentRole;
  model?: string;
  effort: EffortLevel;
  via: 'pinned' | 'auto' | 'provider-default';
  /** Auto: why this model ("coding 82 ≥ 76 needed · $4.00/$20.00 per M · cheapest that qualifies"). */
  reason?: string;
  /** Auto: where the deciding quality score came from. */
  scoreSource?: ScoreSource;
  /** Auto: the tier picked (1 light · 2 standard · 3 top), recorded for calibration. */
  tier?: 1 | 2 | 3;
  /** Auto: the learning table moved this stage's start a rung (−1 cheaper, +1 stronger). */
  calibrated?: -1 | 1;
  /** Auto fell back to the profile's model for this stage, and why. */
  note?: string;
}

export interface RoutingResult {
  config: AIProviderConfig;
  decisions: RoutingDecision[];
  mode: ModelSelectionMode;
  /** Auto: the rating the picks were made for (absent when none was given and only light stages were routed). */
  rating?: TaskRating;
  /** Auto: the catalog's price / benchmark sources. */
  catalogSources?: Pick<ModelCatalog, 'sources' | 'fetchedAt'>;
}

/** Roles whose model need depends on the task rating (the others need a fixed baseline). */
const RATED_ROLES = new Set<AgentRole>(['manager', 'worker', 'hardener']);

/**
 * Returns a copy of `config` whose roleConfigs carry the routed model and effort for each role in `roles`. Roles not
 * listed keep their current (possibly already routed) config, so a run can route in two steps (Auto: the summary
 * stage first, the rest once the overview rated the task). The user's own roleConfigs are kept in `routedFrom`
 * so a rejected routed model can fall back.
 */
export async function routeModelsForRun(params: {
  config: AIProviderConfig;
  effort: EffortLevel;
  mode: ModelSelectionMode;
  roles: AgentRole[];
  /** Auto: the task rating (DEFAULT_TASK_RATING when missing). */
  rating?: TaskRating;
  /** Auto: a catalog already fetched for this run (otherwise getModelCatalog()). */
  catalog?: ModelCatalog;
  /** Rungs to climb per role (QA retries, reruns after a failed run). */
  escalation?: Partial<Record<AgentRole, number>>;
  signal?: AbortSignal;
  /** Not used for routing; accepted so existing callers keep compiling. */
  taskText?: string;
  /** Not used for routing; accepted so existing callers keep compiling. */
  connectedMcps?: MCPServer[];
}): Promise<RoutingResult> {
  const { config, effort, mode, roles } = params;
  const userRoleConfigs = config.routedFrom?.roleConfigs ?? config.roleConfigs ?? {};
  const baseConfig: AIProviderConfig = { ...config, roleConfigs: userRoleConfigs, routedFrom: undefined };
  const nextRoleConfigs: Partial<Record<AgentRole, AgentModelConfig>> = { ...userRoleConfigs, ...(config.roleConfigs ?? {}) };
  const decisions: RoutingDecision[] = [];
  const needsRating = roles.some((r) => RATED_ROLES.has(r));
  const rating = params.rating ?? (mode === 'auto' && needsRating ? DEFAULT_TASK_RATING : undefined);
  const catalog = mode === 'auto' ? params.catalog ?? (await getModelCatalog({ signal: params.signal })) : undefined;
  // Auto mode's learning table (config/model-calibration.json): read once, in memory afterwards.
  const calibration: CalibrationFile | null = mode === 'auto' && needsRating ? await getCalibration().catch(() => null) : null;
  // At most one stage per run tries a cheaper rung, so a run that goes wrong has one clear suspect.
  let probed = false;

  const manualChoice = (role: AgentRole, roleEffort: EffortLevel, note?: string) => {
    const pinned = userRoleConfigs[role];
    const target = resolveRoleTarget(baseConfig, role);
    // A CLI preset id ("claude-code") in a subscription profile isn't a model: the CLI uses its default.
    const placeholder = isSubscriptionTarget(target) && isCliPlaceholderModel(pinned?.model?.trim(), resolveCliBinary(target));
    if (pinned?.model?.trim() && !placeholder) {
      nextRoleConfigs[role] = { ...pinned, effort: roleEffort };
      decisions.push({ role, model: pinned.model, effort: roleEffort, via: 'pinned', ...(note ? { note } : {}) });
    } else {
      nextRoleConfigs[role] = { ...pinned, effort: roleEffort };
      decisions.push({ role, effort: roleEffort, via: 'provider-default', ...(note ? { note } : {}) });
    }
  };

  for (const role of roles) {
    const steps = Math.max(0, params.escalation?.[role] ?? 0);
    const roleEffort = effortForRole(role, effort);
    if (mode !== 'auto' || !catalog) {
      // Manual keeps the profile's model; a step up raises its effort instead.
      manualChoice(role, steps > 0 ? shiftEffort(roleEffort, steps) : roleEffort, steps > 0 ? `effort stepped up ${steps} after an earlier failure` : undefined);
      continue;
    }
    const target = resolveRoleTarget(baseConfig, role);
    let candidates = await availableModelsFor(target, catalog, { effort: roleEffort });
    // The overview (Summary stage) runs on the tiny model, as the CLI path's overview call does.
    const tinyId = role === 'summary' ? tinyCloudModelFor(target) : undefined;
    const tiny = tinyId ? candidates.find((c) => c.id === tinyId) : undefined;
    if (tiny) {
      nextRoleConfigs[role] = { ...userRoleConfigs[role], model: tiny.id, effort: roleEffort };
      decisions.push({ role, model: tiny.id, effort: roleEffort, via: 'auto', reason: `tiny model for the overview · ${formatModelPrice(tiny.model, isSubscriptionTarget(target))}` });
      continue;
    }
    const family = familyForTarget(target);
    const group = ratingGroup(params.rating);
    // Calibration needs a real rating (not the mid-scale default) and a known family.
    const calibrate: CalibrateFn | undefined =
      calibration && family && group.difficulty && (role === 'manager' || role === 'worker' || role === 'hardener')
        ? (options) =>
            calibrationAdjustment({ file: calibration, family, coding: Boolean(group.coding), difficulty: group.difficulty!, role, allowProbe: !probed, ...options })
        : undefined;
    const pick = pickModelForStage({
      role,
      slider: effort,
      rating: rating ?? DEFAULT_TASK_RATING,
      candidates,
      catalog,
      escalation: steps,
      relativeCost: isSubscriptionTarget(target),
      calibrate,
      cacheHitShare: (calibration && family ? measuredCacheShare(calibration, family) : null) ?? undefined
    });
    if (!pick) {
      manualChoice(role, roleEffort, familyForTarget(target) ? `no priced models found for ${targetLabel(target)}` : `Auto doesn't cover ${targetLabel(target)}`);
      continue;
    }
    let modelId = pick.candidate.id;
    if (pick.effort !== roleEffort) {
      // Some CLIs encode thinking depth in the model id (Antigravity "-low/-medium/-high"): take the variant for the picked effort.
      candidates = await availableModelsFor(target, catalog, { effort: pick.effort });
      modelId = candidates.find((c) => c.model.id === pick.candidate.model.id)?.id ?? modelId;
    }
    if (pick.calibration?.probe) probed = true;
    nextRoleConfigs[role] = { ...userRoleConfigs[role], model: modelId, effort: pick.effort };
    decisions.push({
      role,
      model: modelId,
      effort: pick.effort,
      via: 'auto',
      reason: pick.reason,
      scoreSource: pick.scoreSource,
      tier: pick.tier,
      ...(pick.calibration ? { calibrated: pick.calibration.steps } : {}),
    });
  }

  return {
    config: { ...config, roleConfigs: nextRoleConfigs, routedFrom: { roleConfigs: userRoleConfigs } },
    decisions,
    mode,
    ...(rating && mode === 'auto' ? { rating } : {}),
    ...(catalog ? { catalogSources: { sources: catalog.sources, fetchedAt: catalog.fetchedAt } } : {})
  };
}

/**
 * Multi-line routing summary for the "Model routing" step: the mode, the task rating, each stage's model · effort ·
 * reason, and where prices / strengths came from. Accepts a bare decision list too (older callers).
 */
export function describeRouting(routing: RoutingResult | RoutingDecision[]): string {
  const result: Partial<RoutingResult> & { decisions: RoutingDecision[] } = Array.isArray(routing) ? { decisions: routing } : routing;
  const lines: string[] = [];
  if (result.mode === 'auto') {
    lines.push(`Models: Auto${result.rating ? ` · ${describeTaskRating(result.rating)}` : ''}`);
  } else if (result.mode === 'manual') {
    lines.push('Models: Manual (per-stage models from the AI profile)');
  }
  const viaLabel: Record<RoutingDecision['via'], string> = {
    pinned: result.mode === 'auto' ? "profile's model" : 'set in AI profile',
    auto: 'auto',
    'provider-default': 'provider default'
  };
  for (const d of result.decisions) {
    const why = d.via === 'auto' && d.reason ? d.reason : `${viaLabel[d.via]}${d.note ? ` (${d.note})` : ''}`;
    lines.push(`${d.role}: ${d.model || '(default model)'} · ${EFFORT_LABELS[d.effort]} effort · ${why}`);
  }
  if (result.mode === 'auto' && result.catalogSources && result.decisions.some((d) => d.via === 'auto')) {
    lines.push(describeCatalogSources(result.catalogSources));
  }
  return lines.join('\n');
}

/**
 * The model to pass a CLI for a pinned (profile) model, or undefined when the pin isn't a model that CLI accepts
 * (a preset id like "claude-code", another provider's model): the CLI then uses its default.
 */
export function cliModelForPin(binary: string, model: string | undefined): string | undefined {
  const m = model?.trim();
  if (!m || isCliPlaceholderModel(m, binary)) return undefined;
  const base = binary.toLowerCase().replace(/^.*[\\/]/, '');
  if (base === 'claude') return /^(haiku|sonnet|opus|fable|claude-[\w.-]+)$/i.test(m) ? m : undefined;
  if (base === 'agy' || base === 'antigravity') return /^(gemini|claude|gpt-oss)-[\w.-]+$/i.test(m) ? m : undefined;
  if (base === 'codex') return /^(gpt-[\w.-]+|o\d[\w.-]*|codex-[\w.-]+)$/i.test(m) ? m : undefined;
  if (base === 'grok') return /^grok-[\w.-]+$/i.test(m) ? m : undefined;
  return undefined;
}

// ─── Tiny cloud model (small background decisions) ──────────────────────────

type TargetLike = { provider: AIProviderId; authMode?: string; apiKey?: string; model?: string; cliAgentId?: string; cliCustomCommand?: string };

/**
 * The tiny ("fast, cheap") model of each family, for small background calls, in order of preference. CLI families
 * use the CLI's own model names. Edit here when providers ship new small models. No ids: the family keeps its
 * configured model.
 */
export const TINY_MODELS: Record<ModelFamily, { ids: string[]; label: string }> = {
  anthropic: { ids: ['claude-haiku-5-5'], label: 'Claude Haiku' },
  'cli-claude': { ids: ['haiku'], label: 'Claude Haiku' },
  openai: { ids: ['gpt-6-luna', 'gpt-5.6-luna'], label: 'GPT-6 Luna' },
  gemini: { ids: ['gemini-3.5-flash-lite'], label: 'Gemini Flash-Lite' },
  grok: { ids: ['grok-4.3'], label: 'Grok 4.3' },
  'cli-agy': { ids: ['gemini-3.8-flash-low'], label: 'Gemini Flash' },
  'cli-codex': { ids: [], label: "your AI profile's model" }
};

/**
 * The tiny model of the target's family (TINY_MODELS). For API providers the first listed id the key can use wins,
 * else the cheapest capable model of that provider — judged from the provider model list and catalog already
 * cached by Auto model selection (nothing is fetched here). Undefined when the family has none (Ollama, Cursor,
 * Codex, custom CLIs): those keep their configured model.
 */
export function tinyCloudModelFor(target: TargetLike): string | undefined {
  const family = familyForTarget(target);
  if (!family) return undefined;
  const { ids } = TINY_MODELS[family];
  if (family === 'anthropic' || family === 'openai' || family === 'gemini' || family === 'grok') {
    return resolveTinyModelId(family, target.apiKey, ids, peekModelCatalog());
  }
  return ids[0];
}

/** A short name for the tiny cloud model, for UI copy like "Skip — use Claude Haiku instead". */
export function tinyCloudModelLabelFor(target: TargetLike | null | undefined): string {
  if (!target || target.provider === 'none' || target.provider === 'mock') return 'a small cloud model';
  const family = familyForTarget(target);
  if (family) return TINY_MODELS[family].label;
  return target.provider === 'ollama' ? 'your Ollama model' : "your AI profile's model";
}

const DIRECT_API_PROVIDERS: AIProviderId[] = ['gemini', 'anthropic', 'openai', 'grok'];

function realKey(key: string | undefined): string | undefined {
  return key && key.trim() && key !== 'cli_subscription_active' ? key : undefined;
}

/**
 * Provider config for one small, fast call (autocomplete, run-shape triage) on the tiny cloud model, for
 * callAiEngine. API-key profiles call their provider directly. Subscription (CLI) profiles use a direct API key from
 * the profile when there is one (an answer in about a second instead of starting a CLI process); otherwise the call
 * goes through the CLI bridge (/api/cli/execute) with the CLI family's tiny model — the bridge drops a model the
 * CLI doesn't offer. Explicit `model` / `provider` overrides (e.g. a pinned autocomplete model) win.
 * Null when no AI profile is connected.
 */
export function tinyCloudCallConfig(
  aiConfig: AIProviderConfig | undefined | null,
  overrides: { provider?: AIProviderId; model?: string } = {}
): AIProviderConfig | null {
  if (!aiConfig || !aiConfig.isConnected || aiConfig.provider === 'none' || aiConfig.provider === 'mock') return null;
  const explicitModel = overrides.model?.trim() || undefined;
  const overrideProvider = overrides.provider && overrides.provider !== 'none' && overrides.provider !== 'mock' ? overrides.provider : undefined;
  const viaCliProfile = isSubscriptionTarget(aiConfig) || (aiConfig.provider === 'cursor' && !realKey(aiConfig.apiKey));

  let provider: AIProviderId = overrideProvider || aiConfig.provider;
  let viaCli = viaCliProfile && !overrideProvider;
  if (viaCliProfile) {
    // Prefer any direct API key the subscription profile carries (same order autocomplete always used).
    const direct =
      DIRECT_API_PROVIDERS.find((p) => realKey(aiConfig.providerKeys?.[p]?.apiKey)) ||
      (DIRECT_API_PROVIDERS.includes(aiConfig.provider) && realKey(aiConfig.apiKey) ? aiConfig.provider : undefined);
    if (direct) {
      provider = direct;
      viaCli = false;
    } else {
      viaCli = true;
    }
  }

  if (viaCli) {
    const binary = resolveCliBinary(aiConfig);
    const model = explicitModel || tinyCloudModelFor(aiConfig) || '';
    return {
      ...aiConfig,
      provider: 'cli_subscription',
      authMode: 'cli_subscription',
      cliCustomCommand: binary,
      model,
      generalModel: model,
      summaryModel: model,
      autocompleteModel: model,
      roleConfigs: undefined,
      routedFrom: undefined
    };
  }

  const keyEntry = aiConfig.providerKeys?.[provider];
  const apiKey = provider === aiConfig.provider ? realKey(aiConfig.apiKey) || keyEntry?.apiKey : keyEntry?.apiKey || realKey(aiConfig.apiKey);
  const baseUrl = provider === aiConfig.provider ? aiConfig.baseUrl || keyEntry?.baseUrl : keyEntry?.baseUrl || aiConfig.baseUrl;
  const model =
    explicitModel ||
    tinyCloudModelFor({ provider, authMode: 'api_key', apiKey }) ||
    aiConfig.summaryModel ||
    aiConfig.generalModel ||
    aiConfig.model;
  return {
    ...aiConfig,
    provider,
    authMode: 'api_key',
    apiKey,
    baseUrl,
    model,
    generalModel: model,
    summaryModel: model,
    autocompleteModel: model,
    roleConfigs: undefined,
    routedFrom: undefined
  };
}
