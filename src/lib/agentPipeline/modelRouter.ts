/**
 * Effort router — turns the user's effort level into a per-stage model + effort choice.
 *
 * Each provider's lineup is ranked into capability tiers (1 = fast/cheap … 4 = frontier). A stage's
 * target tier comes from ROLE_TIER_BY_EFFORT (e.g. Low effort runs the Claude manager on Sonnet,
 * Extra High on Fable). When the Laya decision engine is connected it makes the final pick among
 * the neighbouring tiers using the task text; otherwise the target tier is used directly.
 *
 * Decided once per run, before any agent starts (route at task boundaries — keeps caches stable).
 * Explicit per-role model pins in roleConfigs always win; only their effort is filled in.
 */
import { type AIProviderConfig, type AgentRole, type AgentModelConfig, type EffortLevel, type MCPServer, type AIProviderId } from '../../types';
import { bridgeClient } from '../bridgeClient';
import { isLayaMcpConnected, pickOptionWithLaya } from '../layaClient';
import { resolveRoleTarget, resolveCliBinary, isSubscriptionTarget } from './contracts';

export const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max'
};

type Tier = 1 | 2 | 3 | 4;

interface TieredModel {
  id: string;
  tier: Tier;
  /** Short description shown to Laya. */
  blurb: string;
}

/** Families the router knows how to rank. CLI families use the CLI's own model names. */
export type ModelFamily = 'anthropic' | 'openai' | 'gemini' | 'grok' | 'cli-claude' | 'cli-agy';

const CATALOG: Record<ModelFamily, TieredModel[]> = {
  anthropic: [
    { id: 'claude-haiku-5-5', tier: 1, blurb: 'fastest, cheapest; simple well-scoped steps' },
    { id: 'claude-sonnet-5-5', tier: 2, blurb: 'balanced speed and capability for everyday coding' },
    { id: 'claude-opus-5-5', tier: 3, blurb: 'strong agentic coding and multi-step planning' },
    { id: 'claude-fable-5-1', tier: 4, blurb: 'most capable; hardest long-horizon reasoning' }
  ],
  'cli-claude': [
    { id: 'haiku', tier: 1, blurb: 'fastest, cheapest; simple well-scoped steps' },
    { id: 'sonnet', tier: 2, blurb: 'balanced speed and capability for everyday coding' },
    { id: 'opus', tier: 3, blurb: 'strong agentic coding and multi-step planning' },
    { id: 'claude-fable-5-1', tier: 4, blurb: 'most capable; hardest long-horizon reasoning' }
  ],
  openai: [
    { id: 'gpt-5-mini', tier: 1, blurb: 'fast and cheap' },
    { id: 'gpt-5', tier: 2, blurb: 'balanced general model' },
    { id: 'gpt-5.4', tier: 3, blurb: 'flagship coding and agentic model' },
    { id: 'gpt-5.4', tier: 4, blurb: 'flagship coding and agentic model' }
  ],
  gemini: [
    { id: 'gemini-3.7-flash', tier: 1, blurb: 'fast and cheap' },
    { id: 'gemini-3.7-flash', tier: 2, blurb: 'fast and cheap' },
    { id: 'gemini-3.7-pro', tier: 3, blurb: 'deep reasoning and agentic coding' },
    { id: 'gemini-3.7-pro', tier: 4, blurb: 'deep reasoning and agentic coding' }
  ],
  grok: [
    { id: 'grok-3-mini', tier: 1, blurb: 'fast and cheap' },
    { id: 'grok-3', tier: 2, blurb: 'flagship' },
    { id: 'grok-3', tier: 3, blurb: 'flagship' },
    { id: 'grok-3', tier: 4, blurb: 'flagship' }
  ],
  // Antigravity encodes thinking depth in the model name; availability is checked against `agy models`.
  'cli-agy': [
    { id: 'gemini-3.8-flash-low', tier: 1, blurb: 'Gemini Flash, light thinking' },
    { id: 'gemini-3.8-flash-high', tier: 2, blurb: 'Gemini Flash, full thinking' },
    { id: 'gemini-3.1-pro-low', tier: 3, blurb: 'Gemini Pro, light thinking' },
    { id: 'gemini-3.1-pro-high', tier: 4, blurb: 'Gemini Pro, full thinking' }
  ]
};

/** Target tier per stage at each effort level (index = EFFORT_LEVELS order). */
const ROLE_TIER_BY_EFFORT: Record<AgentRole, Tier[]> = {
  summary: [1, 1, 2, 2, 3],
  logger: [1, 1, 1, 2, 2],
  cleaner: [1, 1, 2, 2, 3],
  worker: [1, 2, 2, 3, 4],
  manager: [2, 2, 3, 4, 4],
  hardener: [2, 2, 3, 3, 4],
  autocomplete: [1, 1, 1, 1, 1]
};

const ROLE_PURPOSE: Record<AgentRole, string> = {
  summary: 'summarizes the task into a spec and acceptance criteria',
  logger: 'writes the final build/completion record',
  cleaner: 'lints and formats changed files',
  worker: 'implements one scoped piece of the task with file and shell tools',
  manager: 'plans the task, delegates pieces, and verifies the result',
  hardener: 'runs independent QA against the acceptance criteria',
  autocomplete: 'inline autocomplete'
};

/** Bookkeeping stages run one effort step below the chosen level to save tokens. */
const LIGHT_ROLES = new Set<AgentRole>(['summary', 'logger', 'cleaner', 'autocomplete']);

export function effortForRole(role: AgentRole, effort: EffortLevel): EffortLevel {
  if (!LIGHT_ROLES.has(role)) return effort;
  return EFFORT_LEVELS[Math.max(0, EFFORT_LEVELS.indexOf(effort) - 1)];
}

function cliFamily(binary: string): ModelFamily | null {
  const base = binary.toLowerCase().replace(/^.*[\\/]/, '');
  if (base === 'claude') return 'cli-claude';
  if (base === 'agy' || base === 'antigravity') return 'cli-agy';
  return null;
}

export function familyForTarget(target: { provider: AIProviderId; authMode?: string; apiKey?: string; model?: string; cliAgentId?: string; cliCustomCommand?: string }): ModelFamily | null {
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

let agyModelsCache: { at: number; ids: Set<string> | null } | null = null;

/** Models the local Antigravity CLI reports (`agy models`), cached for 10 minutes. Null when unknown. */
async function fetchAgyModels(): Promise<Set<string> | null> {
  if (agyModelsCache && Date.now() - agyModelsCache.at < 10 * 60_000) return agyModelsCache.ids;
  let ids: Set<string> | null = null;
  try {
    const res = await fetch(bridgeClient.getApiUrl('/api/cli/models?cli=agy'));
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.models) && data.models.length > 0) ids = new Set(data.models.map((m: any) => String(m.id)));
    }
  } catch {
    ids = null;
  }
  agyModelsCache = { at: Date.now(), ids };
  return ids;
}

async function catalogFor(family: ModelFamily): Promise<TieredModel[]> {
  if (family !== 'cli-agy') return CATALOG[family];
  const available = await fetchAgyModels();
  // Unknown availability → don't pass --model at all (agy uses its default), effort still applies.
  if (!available) return [];
  return CATALOG['cli-agy'].filter((m) => available.has(m.id));
}

function nearestByTier(models: TieredModel[], tier: Tier): TieredModel | undefined {
  return [...models].sort((a, b) => Math.abs(a.tier - tier) - Math.abs(b.tier - tier) || b.tier - a.tier)[0];
}

export interface RoutingDecision {
  role: AgentRole;
  model?: string;
  effort: EffortLevel;
  via: 'pinned' | 'laya' | 'effort' | 'provider-default';
}

export interface RoutingResult {
  config: AIProviderConfig;
  decisions: RoutingDecision[];
}

/**
 * Returns a copy of `config` whose roleConfigs carry the routed model and effort for each role.
 * The user's original roleConfigs are kept in `routedFrom` so a rejected routed model can fall back.
 */
export async function routeModelsForRun(params: {
  config: AIProviderConfig;
  effort: EffortLevel;
  autoModelRouting: boolean;
  roles: AgentRole[];
  taskText: string;
  connectedMcps: MCPServer[];
}): Promise<RoutingResult> {
  const { config, effort, autoModelRouting, roles, taskText, connectedMcps } = params;
  const userRoleConfigs = config.routedFrom?.roleConfigs ?? config.roleConfigs ?? {};
  const baseConfig: AIProviderConfig = { ...config, roleConfigs: userRoleConfigs, routedFrom: undefined };
  const nextRoleConfigs: Partial<Record<AgentRole, AgentModelConfig>> = { ...userRoleConfigs };
  const decisions: RoutingDecision[] = [];
  const useLaya = autoModelRouting && isLayaMcpConnected(connectedMcps);
  const effortIdx = EFFORT_LEVELS.indexOf(effort);

  for (const role of roles) {
    const roleEffort = effortForRole(role, effort);
    const pinned = userRoleConfigs[role];
    if (pinned?.model?.trim()) {
      nextRoleConfigs[role] = { ...pinned, effort: roleEffort };
      decisions.push({ role, model: pinned.model, effort: roleEffort, via: 'pinned' });
      continue;
    }

    const target = resolveRoleTarget(baseConfig, role);
    const family = autoModelRouting ? familyForTarget(target) : null;
    const models = family ? await catalogFor(family) : [];
    if (models.length === 0) {
      nextRoleConfigs[role] = { ...pinned, effort: roleEffort };
      decisions.push({ role, effort: roleEffort, via: 'provider-default' });
      continue;
    }

    const targetTier = ROLE_TIER_BY_EFFORT[role][effortIdx];
    let chosen = nearestByTier(models, targetTier)!;
    let via: RoutingDecision['via'] = 'effort';

    if (useLaya) {
      const neighbours = models.filter((m) => Math.abs(m.tier - targetTier) <= 1);
      const options = Array.from(new Set(neighbours.map((m) => m.id)));
      if (options.length > 1) {
        const menu = options
          .map((id) => {
            const m = neighbours.find((n) => n.id === id)!;
            return `- ${id}: tier ${m.tier}/4, ${m.blurb}`;
          })
          .join('\n');
        const pick = await pickOptionWithLaya(
          `Pick the model for the "${role}" stage of an AI agent pipeline. This stage ${ROLE_PURPOSE[role]}.\n` +
            `Effort level chosen by the user: ${EFFORT_LABELS[effort]} (suggested tier ${targetTier}/4).\n` +
            `Prefer the cheapest model that will reliably succeed; go up a tier only if the task clearly needs it.\n\n` +
            `Task:\n${taskText.slice(0, 900)}\n\nModels:\n${menu}`,
          options
        );
        const picked = pick && pick.confidence >= 0.5 ? neighbours.find((m) => m.id === pick.choice) : undefined;
        if (picked) {
          chosen = picked;
          via = 'laya';
        }
      }
    }

    nextRoleConfigs[role] = { ...pinned, model: chosen.id, effort: roleEffort };
    decisions.push({ role, model: chosen.id, effort: roleEffort, via });
  }

  return {
    config: { ...config, roleConfigs: nextRoleConfigs, routedFrom: { roleConfigs: userRoleConfigs } },
    decisions
  };
}

export function describeRouting(decisions: RoutingDecision[]): string {
  const viaLabel: Record<RoutingDecision['via'], string> = {
    pinned: 'pinned in settings',
    laya: 'picked by Laya',
    effort: 'effort tier',
    'provider-default': 'provider default'
  };
  return decisions
    .map((d) => `${d.role}: ${d.model || '(default model)'} · ${EFFORT_LABELS[d.effort]} effort · ${viaLabel[d.via]}`)
    .join('\n');
}
