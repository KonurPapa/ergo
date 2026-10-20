/**
 * Shared contracts for the Agent Execution Pipeline.
 *
 * Every module in this directory codes against these interfaces so that the pieces
 * (discovery, summary, manager, workers, cleaner, hardener, logger) can be built and
 * tested independently while the orchestrator in ./index.ts wires them together.
 *
 * Context-engineering invariants (see docs/AI_WORKFLOW_ARCHITECTURE_2.md):
 *  - Byte-stable prefix: `stableSystem` and `sharedContext` must be identical for every
 *    agent in a run so provider prompt caches hit (tools → system → messages render order).
 *  - Pass pointers over payloads: tool results are truncated; agents pull more on demand.
 *  - Route at task boundaries: models are chosen per role once, never mid-loop.
 *  - Clean hand-offs: workers receive only the shared prefix + their piece contract.
 */
import type { SteeringQueue } from './steeringQueue';
import {
  type AIProviderConfig,
  type AIProviderId,
  type AgentPipelineOptions,
  type AgentRole,
  type AgentContextItem,
  type AuthMode,
  type EffortLevel,
  type ExecutionStep,
  type HumanInputPrompt,
  type MCPServer,
  type McpRootBoundary,
  type McpToolPermissionPrompt,
  type OllamaFallbackChoice,
  type OllamaFallbackPrompt,
  type PermissionDecision,
  type PermissionLevel,
  type ProjectData,
  type TaskItem,
  type TokenUsage
} from '../../types';

export const DEFAULT_AGENT_PIPELINE_OPTIONS: AgentPipelineOptions = {
  permissionLevel: 'acceptEdits',
  effortLevel: 'medium',
  modelSelection: 'auto',
  maxConcurrentAgents: 3,
  maxQaRetries: 2,
  maxToolRoundsPerAgent: 10,
  enableCleaner: true
};

/**
 * Merge persisted (possibly partial / stale) pipeline settings over `base`, ignoring undefined or invalid values.
 * Migrates the old `autoModelRouting` flag: false → Manual model selection, anything else → Auto.
 */
export function mergeAgentPipelineOptions(
  base: AgentPipelineOptions,
  patch?: (Partial<AgentPipelineOptions> & { autoModelRouting?: unknown }) | null
): AgentPipelineOptions {
  if (!patch) return base;
  const next: AgentPipelineOptions = { ...base };
  if (typeof patch.maxConcurrentAgents === 'number' && Number.isFinite(patch.maxConcurrentAgents)) next.maxConcurrentAgents = patch.maxConcurrentAgents;
  if (typeof patch.maxQaRetries === 'number' && Number.isFinite(patch.maxQaRetries)) next.maxQaRetries = patch.maxQaRetries;
  if (typeof patch.maxToolRoundsPerAgent === 'number' && Number.isFinite(patch.maxToolRoundsPerAgent)) next.maxToolRoundsPerAgent = patch.maxToolRoundsPerAgent;
  if (typeof patch.enableCleaner === 'boolean') next.enableCleaner = patch.enableCleaner;
  if (patch.permissionLevel && ['plan', 'ask', 'acceptEdits', 'bypass'].includes(patch.permissionLevel)) next.permissionLevel = patch.permissionLevel;
  if (patch.effortLevel && ['low', 'medium', 'high', 'xhigh', 'max'].includes(patch.effortLevel)) next.effortLevel = patch.effortLevel;
  if (patch.modelSelection === 'auto' || patch.modelSelection === 'manual') next.modelSelection = patch.modelSelection;
  else if ('autoModelRouting' in patch) next.modelSelection = patch.autoModelRouting === false ? 'manual' : 'auto';
  return next;
}

/** Max characters of any single tool result fed back into a model (per-turn payload trimming). */
export const TOOL_RESULT_CHAR_CAP = 5_000;
/** Max characters for a worker's condensed summary appended to the bible event log. */
export const PIECE_SUMMARY_CHAR_CAP = 1_200;
/** Max characters excerpted from a project guideline file (AGENTS.md / CLAUDE.md). */
export const GUIDELINE_EXCERPT_CHAR_CAP = 3_000;

export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, calls: 0 };
}

export function addUsage(target: TokenUsage, delta: Partial<TokenUsage>): TokenUsage {
  target.inputTokens += delta.inputTokens || 0;
  target.outputTokens += delta.outputTokens || 0;
  target.cachedInputTokens += delta.cachedInputTokens || 0;
  target.cacheWriteTokens += delta.cacheWriteTokens || 0;
  target.calls += delta.calls || 0;
  if (delta.estimated) target.estimated = true;
  if (typeof delta.costUsd === 'number') target.costUsd = (target.costUsd || 0) + delta.costUsd;
  else if ((delta.inputTokens || 0) + (delta.outputTokens || 0) > 0) target.costPartial = true;
  if (delta.costPartial) target.costPartial = true;
  return target;
}

export function formatUsage(u: TokenUsage): string {
  const parts: string[] = [];
  if (u.cachedInputTokens > 0) parts.push(`${u.cachedInputTokens.toLocaleString()} cached`);
  if (u.cacheWriteTokens > 0) parts.push(`${u.cacheWriteTokens.toLocaleString()} written`);
  const cacheStr = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  return `${u.estimated ? '≈ ' : ''}${u.calls} call${u.calls === 1 ? '' : 's'} · in ${u.inputTokens.toLocaleString()}${cacheStr} · out ${u.outputTokens.toLocaleString()}`;
}

// ─── Tools ──────────────────────────────────────────────────────────────────

export type JsonSchema = Record<string, any>;

/**
 * Provider-agnostic tool definition. Converted to Anthropic / OpenAI / Gemini / Ollama
 * shapes by toolSchemas.ts. `name` is the wire name the model calls.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** Owning MCP server id ('builtin' for ask_human). */
  serverId: string;
  serverName: string;
  /** Read-only tools may run in verification/QA phases and never take file locks. */
  readOnly: boolean;
  /** Mirrors MCPTool.autoApprove — false means the user is prompted before execution. */
  autoApprove: boolean;
  endpoint?: string;
  authHeader?: string;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  args: Record<string, any>;
}

export interface ToolCallResult {
  id: string;
  name: string;
  content: string;
  isError: boolean;
}

/**
 * Scope applied to an agent's tool calls by the harness (state gating instead of mutating
 * tool definitions). Violations return a high-signal error tool result — never a silent no-op.
 */
export interface ToolScope {
  /** Human-readable label used in error messages ("worker P2", "hardener"). */
  actorLabel: string;
  /** If true, any mutating tool (write_file, edit_file, create_directory, git_commit, run_command) is rejected. */
  readOnly: boolean;
  /**
   * If set, mutating filesystem tools may only target these paths (exact or prefix match after
   * normalization). Undefined = any path inside the allowed roots (server still enforces roots).
   */
  allowedWritePaths?: string[];
}

// ─── Provider tool loop ─────────────────────────────────────────────────────

export interface ToolLoopRequest {
  provider: AIProviderId;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  authMode?: AuthMode;
  cliAgentId?: string;
  cliCustomCommand?: string;
  /** Reasoning effort mapped onto the provider's own control (Anthropic output_config.effort, OpenAI reasoning_effort, Gemini thinkingConfig, CLI --effort). */
  effort?: EffortLevel;
  /** Model to retry with if the provider rejects `model` (e.g. a routed model the account can't access). */
  fallbackModel?: string;
  /** Permission level, forwarded to headless CLI agents so their built-in tools follow the same policy. */
  permissionLevel?: PermissionLevel;
  /**
   * Live permission level (the user may change it mid-run). Headless CLI providers read it before every
   * round so each new CLI process runs under the current level; falls back to `permissionLevel`.
   */
  getPermissionLevel?: () => PermissionLevel;
  /**
   * Cached block 2 — role skill + execution rules. Byte-identical for every agent sharing a role
   * within a run. Rendered AFTER sharedContext so all roles share the longest possible prefix.
   */
  stableSystem: string;
  /**
   * Cached block 1 — the bible's stable sections. Byte-identical for every agent in a run and
   * rendered FIRST (right after the tools block) so manager, workers, cleaner and hardener all
   * hit the same cache entry. Empty for discovery/summary (no bible yet).
   */
  sharedContext: string;
  /** Small uncached tail (role/piece specifics). Rendered AFTER the cache breakpoints. */
  volatileSystem?: string;
  /** Deterministically ordered (sorted by name) and fixed for the whole run. */
  tools: ToolDefinition[];
  /** First user turn (piece contract, event log excerpt, etc.). */
  initialUserMessage: string;
  maxRounds: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Execute a batch of tool calls (all tool_use blocks of one assistant turn) and return all results. Required when tools is non-empty. */
  onToolCalls?: (calls: ToolCallRequest[]) => Promise<ToolCallResult[]>;
  /** Fired once after the first model response — used to sequence cache warming before fan-out. */
  onFirstResponse?: () => void;
  /** Per-call usage callback. */
  onUsage?: (usage: TokenUsage) => void;
  /** Ask the provider for JSON in the final answer (best effort; still parse loosely). */
  responseFormat?: 'text' | 'json';
  /** Track consecutive Ollama connection failures across rounds and pipeline steps. */
  ollamaFailureState?: { count: number };
  /** Task ID associated with this tool loop invocation (for UI alert prompts). */
  taskId?: string | number;
  /** Invoked when 3 consecutive Ollama calls fail so the user can pause and choose a remediation. */
  onRequestOllamaFallback?: (prompt: OllamaFallbackPrompt) => Promise<OllamaFallbackChoice>;
  /** Callback fired when the user switches to a cloud profile, returning the new credentials. */
  onSwitchToCloud?: () => Promise<ResolvedRoleTarget | null>;
  /**
   * Mid-run steering: messages the user sent from the prompt box for this agent, taken at each round boundary and
   * appended to the END of the conversation as a user turn (tools and earlier turns stay byte-identical).
   */
  drainSteering?: () => string[];
}

export type ToolLoopStopReason = 'end' | 'max_rounds' | 'aborted' | 'no_tool_support' | 'error';

export interface ToolLoopResult {
  /** Final assistant text (last text block(s)). */
  text: string;
  rounds: number;
  toolCallCount: number;
  usage: TokenUsage;
  stopReason: ToolLoopStopReason;
  error?: string;
}

// ─── Pipeline context (shared by every step) ────────────────────────────────

export interface PipelineCallbacks {
  onStepUpdate: (step: ExecutionStep) => void;
  onRequestPermission?: (prompt: McpToolPermissionPrompt) => Promise<PermissionDecision>;
  onRequestHumanInput?: (prompt: HumanInputPrompt) => Promise<string>;
  onRequestOllamaFallback?: (prompt: OllamaFallbackPrompt) => Promise<OllamaFallbackChoice>;
}

export interface PipelineContext extends PipelineCallbacks {
  task: TaskItem;
  brief: AgentContextItem | undefined;
  project: ProjectData;
  aiConfig: AIProviderConfig;
  connectedMcps: MCPServer[];
  allowedRoots: McpRootBoundary[];
  options: AgentPipelineOptions;
  /**
   * Current permission level. The user can change it while the run is in flight, so tool gating reads this
   * on every call instead of the `options.permissionLevel` snapshot taken at run start.
   */
  getPermissionLevel: () => PermissionLevel;
  /** Short unique id for this execution run (used in run dir + bible metadata). */
  runId: string;
  /** Run directory relative to the storage root, e.g. "runs/default-workspace/task-3-k9x2". */
  runDir: string;
  signal?: AbortSignal;
  /** Cumulative usage across the whole run. */
  usage: TokenUsage;
  /** Shared consecutive failure counter for Ollama calls across all pipeline phases. */
  ollamaFailureState: { count: number };
  /** Permission rules the user granted with "allow for this task" (keys from permissionRuleKey). */
  sessionAllowedTools: Set<string>;
  /** Convenience emitter that stamps `time` and `taskId`. */
  emit: (step: Omit<ExecutionStep, 'time' | 'taskId'> & Partial<Pick<ExecutionStep, 'time' | 'taskId'>>) => void;
  /** The prompt box's mid-run messages for this run's agent loops (see steeringQueue.ts). */
  steering?: SteeringQueue;
}

/** Resolved provider and credentials for an individual execution agent role. */
export interface ResolvedRoleTarget {
  provider: AIProviderId;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  authMode?: AuthMode;
  cliAgentId?: string;
  cliCustomCommand?: string;
  effort?: EffortLevel;
  /** The model this role would use without effort routing — the retry target if a routed model is rejected. */
  fallbackModel?: string;
}

/** Resolve which model a role should use — decided once per run (route at task boundaries). */
export function resolveModelForRole(config: AIProviderConfig, role: AgentRole): string {
  if (config.roleConfigs?.[role]?.model?.trim()) {
    return config.roleConfigs[role]!.model!.trim();
  }
  const general = config.generalModel || config.model || '';
  switch (role) {
    case 'summary':
      return config.summaryModel || general;
    case 'logger':
      return config.loggerModel || config.summaryModel || general;
    case 'worker':
      return config.workerModel || general;
    case 'cleaner':
      return config.cleanerModel || config.workerModel || general;
    case 'manager':
      return config.generalModel || general;
    case 'hardener':
      return config.hardenerModel || config.generalModel || general;
    default:
      return general;
  }
}

/** Resolve the provider, model, and credentials to execute a specific agent role. */
export function resolveRoleTarget(config: AIProviderConfig, role: AgentRole): ResolvedRoleTarget {
  const model = resolveModelForRole(config, role);
  const roleOverride = config.roleConfigs?.[role];
  const provider = (roleOverride?.provider && roleOverride.provider !== 'none' && roleOverride.provider !== 'mock')
    ? roleOverride.provider
    : config.provider;

  // Retrieve provider-specific credentials if available, falling back to top-level credentials
  const creds = config.providerKeys?.[provider];
  const apiKey = creds?.apiKey || (provider === config.provider ? config.apiKey : undefined);
  const baseUrl = creds?.baseUrl || (provider === config.provider ? config.baseUrl : undefined);

  const authMode = config.authMode || (apiKey === 'cli_subscription_active' ? 'cli_subscription' : undefined);
  const cliAgentId = config.cliAgentId;
  const cliCustomCommand = config.cliCustomCommand;
  const unroutedModel = resolveModelForRole({ ...config, roleConfigs: config.routedFrom?.roleConfigs ?? config.roleConfigs }, role);

  return {
    provider,
    model,
    apiKey,
    baseUrl,
    authMode,
    cliAgentId,
    cliCustomCommand,
    effort: roleOverride?.effort,
    fallbackModel: unroutedModel && unroutedModel !== model ? unroutedModel : undefined
  };
}

const CLI_PRESET_IDS = new Set(['claude-code', 'codex', 'antigravity', 'cursor-cli', 'grok-cli', 'custom']);

/** True if `model` is a preset id / binary name rather than a real model the CLI accepts via --model. */
export function isCliPlaceholderModel(model: string | undefined, binary: string): boolean {
  if (!model) return true;
  return CLI_PRESET_IDS.has(model) || model === binary || model === 'cli_subscription';
}

/** Resolve the CLI binary a subscription target runs (claude, agy, codex, …). */
export function resolveCliBinary(target: {
  provider: AIProviderId;
  model?: string;
  cliAgentId?: string;
  cliCustomCommand?: string;
}): string {
  if (target.cliCustomCommand) return target.cliCustomCommand;
  const byAgentId: Record<string, string> = {
    antigravity: 'agy',
    'claude-code': 'claude',
    codex: 'codex',
    'cursor-cli': 'cursor',
    cursor: 'cursor',
    'grok-cli': 'grok',
    grok: 'grok',
    aider: 'aider'
  };
  if (target.cliAgentId) return byAgentId[target.cliAgentId] || target.cliAgentId;
  const byProvider: Partial<Record<AIProviderId, string>> = { gemini: 'agy', openai: 'codex', cursor: 'cursor', grok: 'grok', ollama: 'aider' };
  if (byProvider[target.provider]) return byProvider[target.provider]!;
  const m = target.model || '';
  if (m === 'antigravity' || m.includes('agy') || m.includes('gemini')) return 'agy';
  if (m === 'codex') return 'codex';
  if (m === 'cursor-cli' || m === 'cursor') return 'cursor';
  if (m === 'grok-cli' || m === 'grok') return 'grok';
  if (m === 'claude-code' || m.includes('claude')) return 'claude';
  return m || 'claude';
}

export function isSubscriptionTarget(target: { provider: AIProviderId; authMode?: string; apiKey?: string }): boolean {
  return target.provider === 'cli_subscription' || target.authMode === 'cli_subscription' || target.apiKey === 'cli_subscription_active';
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Agent terminated by user.', 'AbortError');
}

export function isAbortError(err: any): boolean {
  return Boolean(err && (err.name === 'AbortError' || err.code === 20));
}

/** Compact, filesystem-safe slug for run directories. */
export function slugify(input: string, maxLen = 40): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen) || 'task';
}

/** Convenience helper to bind pipeline context defaults (circuit breaker, fallback handler, signal, taskId) to a tool loop request. */
export function buildToolLoopRequest(
  ctx: PipelineContext,
  role: AgentRole,
  params: Omit<ToolLoopRequest, 'provider' | 'model' | 'apiKey' | 'baseUrl' | 'signal' | 'ollamaFailureState' | 'taskId' | 'onRequestOllamaFallback' | 'onSwitchToCloud'> & {
    provider?: AIProviderId;
    model?: string;
    apiKey?: string;
    baseUrl?: string;
    authMode?: AuthMode;
    cliAgentId?: string;
    cliCustomCommand?: string;
  }
): ToolLoopRequest {
  const target = resolveRoleTarget(ctx.aiConfig, role);
  return {
    provider: params.provider ?? target.provider,
    model: params.model ?? target.model,
    apiKey: params.apiKey ?? target.apiKey,
    baseUrl: params.baseUrl ?? target.baseUrl,
    authMode: params.authMode ?? target.authMode,
    cliAgentId: params.cliAgentId ?? target.cliAgentId,
    cliCustomCommand: params.cliCustomCommand ?? target.cliCustomCommand,
    effort: params.effort ?? target.effort,
    fallbackModel: params.fallbackModel ?? target.fallbackModel,
    permissionLevel: params.permissionLevel ?? ctx.getPermissionLevel(),
    getPermissionLevel: params.getPermissionLevel ?? (params.permissionLevel ? undefined : ctx.getPermissionLevel),
    signal: ctx.signal,
    ollamaFailureState: ctx.ollamaFailureState,
    taskId: ctx.task.id,
    onRequestOllamaFallback: ctx.onRequestOllamaFallback,
    onSwitchToCloud: async () => {
      // Re-resolve target after aiConfig has been updated by user
      return resolveRoleTarget(ctx.aiConfig, role);
    },
    ...params
  };
}

