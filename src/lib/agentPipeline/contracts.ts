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
import {
  type AIProviderConfig,
  type AIProviderId,
  type AgentPipelineOptions,
  type AgentRole,
  type AgentContextItem,
  type ExecutionStep,
  type HumanInputPrompt,
  type MCPServer,
  type McpRootBoundary,
  type McpToolPermissionPrompt,
  type ProjectData,
  type TaskItem,
  type TokenUsage
} from '../../types';

export const DEFAULT_AGENT_PIPELINE_OPTIONS: AgentPipelineOptions = {
  maxConcurrentAgents: 3,
  maxQaRetries: 2,
  maxToolRoundsPerAgent: 15,
  enableCleaner: true,
  enableHardener: true,
  discoveryRelevanceThreshold: 50
};

/** Max characters of any single tool result fed back into a model (per-turn payload trimming). */
export const TOOL_RESULT_CHAR_CAP = 12_000;
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
  return target;
}

export function formatUsage(u: TokenUsage): string {
  const cached = u.cachedInputTokens > 0 ? ` (${u.cachedInputTokens.toLocaleString()} cached)` : '';
  return `${u.calls} call${u.calls === 1 ? '' : 's'} · in ${u.inputTokens.toLocaleString()}${cached} · out ${u.outputTokens.toLocaleString()}`;
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
  onRequestPermission?: (prompt: McpToolPermissionPrompt) => Promise<boolean>;
  onRequestHumanInput?: (prompt: HumanInputPrompt) => Promise<string>;
}

export interface PipelineContext extends PipelineCallbacks {
  task: TaskItem;
  brief: AgentContextItem | undefined;
  project: ProjectData;
  aiConfig: AIProviderConfig;
  connectedMcps: MCPServer[];
  allowedRoots: McpRootBoundary[];
  options: AgentPipelineOptions;
  /** Short unique id for this execution run (used in run dir + bible metadata). */
  runId: string;
  /** Run directory relative to the storage root, e.g. "runs/default-workspace/task-3-k9x2". */
  runDir: string;
  signal?: AbortSignal;
  /** Cumulative usage across the whole run. */
  usage: TokenUsage;
  /** Convenience emitter that stamps `time` and `taskId`. */
  emit: (step: Omit<ExecutionStep, 'time' | 'taskId'> & Partial<Pick<ExecutionStep, 'time' | 'taskId'>>) => void;
}

/** Resolve which model a role should use — decided once per run (route at task boundaries). */
export function resolveModelForRole(config: AIProviderConfig, role: AgentRole): string {
  const general = config.generalModel || config.model || '';
  switch (role) {
    case 'discovery':
      return config.discoveryModel || general;
    case 'summary':
    case 'logger':
      return config.summaryModel || general;
    case 'worker':
    case 'cleaner':
      return config.workerModel || general;
    case 'manager':
    case 'hardener':
    default:
      return general;
  }
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
