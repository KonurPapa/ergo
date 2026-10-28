export type TaskStatus = 'not_started' | 'in_progress' | 'partly_done' | 'done';

export interface Subtask {
  id: string;
  text: string;
  isDone: boolean;
  isHumanReview?: boolean;
  sourceLine?: number; // 0-based line in the markdown it was parsed from
}

export interface TaskItem {
  id: string | number; // e.g. "lane-default_task_1" or 1, 2, 3
  title: string;
  category: string;
  categoryHeadingPrefix?: string; // e.g. "##", "#", "###"
  categoryColor?: string; // palette id from headerColors.ts, stored as {color=id} on the heading line
  categoryHasColon?: boolean; // whether heading originally ended with ':'
  listIndex?: number; // 1-based index within its specific section / list
  listType?: 'ordered' | 'bullet'; // whether the task list item is ordered or bullet
  isUnordered?: boolean; // true if item is from an unnumbered bullet list
  status: TaskStatus;
  isDone: boolean;
  subtasks: Subtask[];
  isHumanReview?: boolean;
  needsInput?: boolean;
  mcpRequired?: string[]; // e.g. ['github', 'filesystem']
  summaryNote?: string;
  isArchived?: boolean;
  archivedAtIndex?: number; // 0-based index in the active list at time of archiving, for position-accurate restore
  createdFiles?: string[];
  swimLaneId?: string; // ID of the swim lane / document this task belongs to
  sourceFileName?: string; // e.g. "TODO.md", "BACKLOG.md"
  totalUsage?: TokenUsage; // Running or final token accounting for this task
  sourceLine?: number; // 0-based line of this task in the markdown it was parsed from
}

export interface SwimLaneDoc {
  id: string; // unique identifier for the swim lane
  title: string; // e.g. "Human Workspace", "Feature Backlog", "Sprint Tasks"
  filePath: string; // e.g. "projects/default-workspace/TODO.md" or "projects/default-workspace/BACKLOG.md"
  markdown: string; // raw markdown content of this swim lane document
}

export interface AgentContextItem {
  id?: string; // unique ID for this AI brief/task
  itemNumber?: number; // 1-based display number or legacy number
  title: string;
  isUnordered?: boolean;
  status: TaskStatus | string;
  overview: string;
  buildAndVerification: string;
  completion: string;
  isArchived?: boolean;
  createdFiles?: string[];
  totalUsage?: TokenUsage; // Running or final token accounting for this task
  // Linkage metadata:
  sourceTaskId?: string | number; // ID of the source task in the swim lane (if tied to a task)
  sourceLaneId?: string;          // ID of the swim lane (e.g. "lane-default")
  sourceLaneTitle?: string;       // Title of the swim lane (e.g. "Human Workspace")
  sourceContent?: string;         // Freeform content snippet if tied to a freeform section
  sourceHeading?: string;         // Heading under which it was selected (if any)
  /** When the task was added to the AI side (ISO). Older briefs have none and keep their list position. */
  addedAt?: string;
  // Compatibility fields
  brief?: string;
  built?: string;
  validation?: string;
  humanReview?: string;
  followUps?: string;
  rawContent?: string;
  passes?: Array<{ title: string; content: string }>;
  requiredMcps?: string[];
  selectedMcpTools?: string[];
  /** Task menu → "Verification": run the verifier (and its retry rounds) on this task. On by default unless false. */
  verification?: boolean;
  /** runId of the CLI agent run whose completion log was last written into `completion` (finalize once per run). */
  completionRunId?: string;
  /**
   * Where `overview` came from. Unset = not generated yet (new tasks start empty; text copied from the task or
   * drafted elsewhere is never shown as the Overview). 'generated' = written by a run's Summary step;
   * 'user' = written or corrected by the user in the Overview card.
   */
  overviewSource?: 'generated' | 'user';
  /** Fingerprint of the task text (title + subtasks) the overview was made for; a change means it's stale. */
  overviewTaskHash?: string;
  /** Structured overview saved from the Summary step, reused by reruns instead of generating it again. */
  overviewDocument?: OverviewDocument;
  /** How the last run of this task ended and which models it used: a rerun after a failure starts one rung higher. */
  lastRunOutcome?: RunOutcomeRecord;
}

/**
 * passed: Verifier verified it · completed: finished without a verifier check · unverified: Verifier reached no verdict ·
 * verifier_failed: Verifier still failed after the retries · failed: the run errored or the agent quit · stopped: by the user.
 */
export type RunOutcome = 'passed' | 'completed' | 'unverified' | 'verifier_failed' | 'failed' | 'stopped';

/** One stage's model in a run. tier: Auto's pick (1 light · 2 standard · 3 top); calibrated: the learning table moved it a rung. */
export interface RunStageModel {
  model?: string;
  effort?: EffortLevel;
  tier?: 1 | 2 | 3;
  calibrated?: -1 | 1;
}

export interface RunOutcomeRecord {
  runId: string;
  at: string;
  outcome: RunOutcome;
  /** Rungs the manager and workers started above the plan (an earlier failed run). */
  escalation: number;
  /** Verifier retries used (each one stepped the manager and workers up one more rung). */
  verifierRetries?: number;
  rating?: TaskRating;
  /** The models the work ended on (after any verifier-retry step-ups). */
  models?: Partial<Record<'manager' | 'worker' | 'verifier', RunStageModel>>;
  /** The models the run started on, when verifier retries stepped up (otherwise the same as `models`). */
  startModels?: Partial<Record<'manager' | 'worker' | 'verifier', RunStageModel>>;
  /** Model family the run used (cli-claude, anthropic, openai …), for model calibration. */
  family?: string;
}

export interface MCPServer {
  id: string;
  name: string;
  description: string;
  iconName: string;
  iconUrl?: string;
  category: 'developer' | 'productivity' | 'design' | 'analytics' | 'database';
  status: 'connected' | 'disconnected' | 'authenticating';
  transport: 'OAuth 2.1' | 'SSE' | 'Local Stdio' | string;
  endpoint: string;
  tools: MCPTool[];
  serverType?: 'bundled_harness' | 'external_oauth';
  lastSyncedAt?: string;
  isCustom?: boolean;
  authHeader?: string;
  authUsername?: string;
  error?: string;
}

export interface MCPTool {
  id: string;
  name: string;
  description: string;
  autoApprove: boolean;
  serverId?: string;
  category?: string;
  inputSchema?: Record<string, any>;
}

export interface McpRootBoundary {
  id: string;
  path: string;
  name: string;
  isDefault?: boolean;
  addedAt?: string;
}

export interface McpToolCallRequest {
  serverId: string;
  toolName: string;
  args: Record<string, any>;
}

export interface McpToolPermissionPrompt {
  id: string;
  serverId: string;
  serverName: string;
  toolName: string;
  args: Record<string, any>;
  summary: string;
  diffPreview?: string;
  /** What an "allow for this task" answer would cover, e.g. "all npm commands" (omit to hide that option). */
  rememberLabel?: string;
}

/** Answer to a permission prompt: allow once, deny, or allow every matching call for the rest of the run. */
export type PermissionDecision = boolean | 'always';

export type OllamaFallbackChoice = 'terminate' | 'switch_cloud';

export interface OllamaFallbackPrompt {
  id: string;
  taskId: string | number;
  consecutiveFailures: number;
  url: string;
  errorMessage?: string;
}

export interface McpToolExecutionResult {
  success: boolean;
  data?: any;
  error?: string;
}

export interface WorkspaceSkill {
  id: string;
  name: string;
  description: string;
  rules?: string;
  instructions: string;
  triggerKeywords: string[];
  enabled: boolean;
  isBuiltIn?: boolean;
  filePath?: string;
  createdAt?: string;
  updatedAt?: string;
}

export type WorkspaceMcpAction =
  | 'workspace_create_task'
  | 'workspace_update_task'
  | 'workspace_delete_task'
  | 'workspace_create_subtask'
  | 'workspace_update_subtask'
  | 'workspace_delete_subtask'
  | 'workspace_list_swim_lanes'
  | 'workspace_create_swim_lane'
  | 'workspace_update_swim_lane'
  | 'workspace_delete_swim_lane'
  | 'workspace_move_task_lane'
  | 'workspace_list_mcp_servers'
  | 'workspace_read_mcp_server'
  | 'workspace_read_mcp_tools'
  | 'workspace_execute_ai_task'
  | 'workspace_run_tasks_sequence'
  | 'workspace_run_tasks_parallel'
  | 'workspace_schedule_task'
  | 'workspace_cancel_scheduled_task'
  | 'workspace_create_ai_brief'
  | 'workspace_update_ai_brief';


export type AIProviderId = 'openai' | 'anthropic' | 'gemini' | 'grok' | 'cursor' | 'ollama' | 'cli_subscription' | 'none' | 'mock';

export type AuthMode = 'api_key' | 'cli_subscription';

export interface CliDetectedAgent {
  id: string;
  name: string;
  command: string;
  detectedPath: string | null;
  isInstalled: boolean;
  version: string | null;
  provider: AIProviderId;
  subscriptionTier: string;
  installCommand: string;
  loginCommand?: string;
  loginArgs?: string[];
  docsUrl: string;
  badgeColor: string;
  supportsHeadless: boolean;
  supportsInteractive: boolean;
}

export interface CliExecutionResult {
  success: boolean;
  output: string;
  exitCode: number;
  durationMs: number;
  command: string;
  stderr?: string;
  error?: string;
  timedOut?: boolean;
}

export interface AgentModelConfig {
  provider?: AIProviderId;
  model?: string;
  /** Reasoning effort for this role (set by the effort router; maps to each provider's own effort control). */
  effort?: EffortLevel;
}

/**
 * When Ergo's API / Ollama agent loops compact their conversation (CLI agents use their own compaction).
 * auto: at 80% of the model's context window · manual: at `tokens` · off: never.
 */
export interface ContextCompactionSetting {
  mode: 'auto' | 'manual' | 'off';
  /** manual: compact once the conversation reaches this many tokens. */
  tokens?: number;
  /** The model's context window when Ergo can't look it up (custom / local models). Ollama also runs with it as num_ctx. */
  windowTokens?: number;
}

export interface AIProviderConfig {
  provider: AIProviderId;
  model: string;
  authMode?: AuthMode;
  cliAgentId?: string;
  cliCustomCommand?: string;
  cliPresetId?: string;
  cliExtraArgs?: string;
  cliSubscriptionTier?: string;
  cliExecutionMode?: 'headless' | 'interactive';
  contextCompaction?: ContextCompactionSetting;
  summaryModel?: string;
  generalModel?: string;
  /** Optional cheaper/faster model used for fan-out worker sub-agents (defaults to generalModel). */
  workerModel?: string;
  cleanerModel?: string;
  verifierModel?: string;
  loggerModel?: string;
  autocompleteModel?: string;
  /** Per-role routing overrides: customize which provider and model runs each execution agent */
  roleConfigs?: Partial<Record<AgentRole, AgentModelConfig>>;
  /** Set by the effort router: the user's own roleConfigs before routed models were merged in. */
  routedFrom?: { roleConfigs?: Partial<Record<AgentRole, AgentModelConfig>> };
  /** Provider-specific credentials dictionary for multi-provider profiles */
  providerKeys?: Partial<Record<AIProviderId, { apiKey?: string; baseUrl?: string }>>;
  apiKey?: string;
  baseUrl?: string;
  isCustomKey?: boolean;
  isConnected?: boolean;
}

export interface ProviderCredentials {
  apiKey?: string;
  baseUrl?: string;
  authMode?: AuthMode;
  cliAgentId?: string;
  cliCustomCommand?: string;
  cliPresetId?: string;
  cliExtraArgs?: string;
  cliSubscriptionTier?: string;
  cliExecutionMode?: 'headless' | 'interactive';
  model?: string;
  summaryModel?: string;
  generalModel?: string;
  workerModel?: string;
  cleanerModel?: string;
  verifierModel?: string;
  loggerModel?: string;
  autocompleteModel?: string;
  roleConfigs?: Partial<Record<AgentRole, AgentModelConfig>>;
  providerKeys?: Partial<Record<AIProviderId, { apiKey?: string; baseUrl?: string }>>;
  isConnected?: boolean;
}

export type AICredentialsMap = Record<AIProviderId, ProviderCredentials>;

export interface UserApiKey {
  id: string;
  name: string;
  provider: AIProviderId;
  apiKey: string;
  authMode?: AuthMode;
  cliAgentId?: string;
  cliCustomCommand?: string;
  cliPresetId?: string;
  cliExtraArgs?: string;
  cliSubscriptionTier?: string;
  cliExecutionMode?: 'headless' | 'interactive';
  contextCompaction?: ContextCompactionSetting;
  baseUrl?: string;
  model?: string;
  summaryModel?: string;
  generalModel?: string;
  workerModel?: string;
  cleanerModel?: string;
  verifierModel?: string;
  loggerModel?: string;
  autocompleteModel?: string;
  /** Per-role routing overrides: customize which provider and model runs each execution agent */
  roleConfigs?: Partial<Record<AgentRole, AgentModelConfig>>;
  /** Provider-specific credentials dictionary for multi-provider profiles */
  providerKeys?: Partial<Record<AIProviderId, { apiKey?: string; baseUrl?: string }>>;
  isConnected?: boolean;
  createdAt?: string;
}


export interface RunningJobInfo {
  id: string;
  taskId: string | number;
  taskTitle: string;
  type: 'cli' | 'in_place' | 'scheduled';
  status: 'queued' | 'in_progress' | 'completed' | 'cancelled' | 'failed';
  startedAt: string;
  completedAt?: string;
  sessionId?: string;
  cmd?: string;
  args?: string[];
  cwd?: string;
  laneId?: string;
  laneTitle?: string;
}

export interface RunningJobsDoc {
  version: number;
  projectId: string;
  updatedAt: string;
  tasks: AgentContextItem[];
  runningJobs: RunningJobInfo[];
  queuedTaskIds: (string | number)[];
  taskExecutionSteps: Record<string, ExecutionStep[]>;
}

export interface ProjectData {
  id: string;
  name: string;
  description: string;
  folderPath: string; // e.g. "projects/default-workspace"
  todoFilePath: string; // e.g. "projects/default-workspace/TODO.md"
  todoMarkdown: string;
  runningJobsDoc?: RunningJobsDoc;
  connectedMcps: string[];
  swimLanes?: SwimLaneDoc[];
}

export interface HumanInputPrompt {
  id: string;
  taskId: string | number;
  question: string;
  options?: string[];
  context?: string;
  allowFreeform?: boolean;
}

/**
 * Structured Overview document produced by the Summary AI.
 * The working brief is the single source of truth handed to the manager (and the spec section of the bible).
 * The user can edit it mid-task to steer the agent.
 */
export interface OverviewDocument {
  /** The working brief (docs/skills/task-brief): Goal / Scope / Known context / Constraints / Done when / Assumptions. */
  raw: string;
  /** Legacy fields of overviews saved before the working brief (read only, never written). */
  brief?: string;
  goals?: string;
  output_as?: string;
  requiredMcps?: string[]; // MCP servers the Summary step selected (kept so a reused overview needs no new call)
  /** Related tasks the Summary step judged useful context (kept so a reused overview reuses the selection too). */
  relatedTaskIds?: string[];
  /** Titles of those tasks: task ids are positional and shift when tasks are reordered, titles don't. */
  relatedTaskTitles?: string[];
  taskKind?: TaskKind;   // Classified by the Summary AI; drives Cleaner/Verifier gating
  requiresVerifier?: boolean; // Evaluated by Summary AI: large tasks warrant Verifier, small/generic tasks skip it
  verifierReason?: string;    // Rationale for why Verifier is required or skipped
  /** How demanding the task is (Auto model selection). Rated once with the overview and reused by reruns. */
  taskRating?: TaskRating;
}

/**
 * Payload sent when the user runs an agent on an arbitrary text selection
 * rather than a structured task item.
 */
export interface SelectionPayload {
  type: 'selection';
  selectedText: string;   // The raw text the user highlighted
  laneId: string;         // Which swim lane the selection is from
  laneTitle: string;      // Human-readable name of the swim lane
  sourceHeading?: string; // Nearest heading above the selection (if any)
  sessionId: string;      // Unique ID for this execution run
}

/**
 * Delineated context entry for an individual related task discovered in the workspace
 */
export interface DiscoveredTaskContextEntry {
  taskId: string | number;
  title: string;
  category: string;
  status: string;
  isDone: boolean;
  isArchived: boolean;
  sourceDocument: string; // e.g. "TODO.md", "Backlog.md"
  swimLaneTitle: string;
  subtasks: string[];
  overview?: string;
  buildAndVerification?: string;
  completion?: string;
}

/**
 * Plain JSON payload produced by Step 2 Discovery AI.
 * Contains the target task context straight from the user alongside
 * all additional discovered task context entries delineated individually.
 */
export interface DiscoveryJobPayload {
  targetTask: {
    id: string | number;
    title: string;
    category: string;
    status: string;
    isDone: boolean;
    subtasks: { id?: string; text: string; isDone: boolean; isHumanReview?: boolean }[];
    sourceFileName?: string;
  };
  additionalContext: DiscoveredTaskContextEntry[];
  discoverySummary: {
    scannedDocumentCount: number;
    totalTasksScanned: number;
    relevantTasksCount: number;
  };
  // Assembled by Step 2 Summary AI
  overview?: OverviewDocument;
  requiredMcps?: string[];
  // Step 1 Discovery: compact Markdown baseline context handed to the Summary AI (pointers, not payloads)
  baselineMarkdown?: string;
  // Project guideline files found by Discovery (AGENTS.md / CLAUDE.md), excerpted
  guidelineDocs?: Array<{ path: string; excerpt: string }>;
  // Short free-text notes from the Discovery AI (dependencies, shared schemas, precedents)
  discoveryNotes?: string;
}

/**
 * Structured JSON "Bible Prompt" assembled from Discovery and Summary steps.
 * This is the concise, non-bloated execution blueprint used by the Step 3 Manager AI.
 */
export interface ManagerBiblePayload {
  task: {
    id: string | number;
    title: string;
    category: string;
    status: string;
    subtasks: { id?: string; text: string; isDone: boolean; isHumanReview?: boolean }[];
    sourceFileName?: string;
  };
  overview: {
    /** The working brief. */
    spec: string;
    requiredMcps?: string[];
  };
  discoveredContext: Array<{
    taskId: string | number;
    title: string;
    category: string;
    sourceDocument: string;
    overviewSnippet?: string;
  }>;
  environment: {
    projectName: string;
    projectPath: string;
    allowedRoots: string[];
    activeMcps: string[];
  };
}

/**
 * Pipeline stages emitted as ExecutionStep updates.
 *  - context: Step 1 Discovery
 *  - overview: Step 2 Summary (the working brief)
 *  - decompose: Step 3 Manager decomposing the brief's "Done when" criteria into puzzle pieces
 *  - subagent: a worker sub-agent executing one puzzle piece
 *  - mcp_call: an individual tool call (manager or worker)
 *  - verify: Manager verifying accumulated pieces against the brief's criteria
 *  - cleaner: Step 4 lint/format pass (coding tasks only)
 *  - verifier: Step 5 verification harness
 *  - retry: Verifier failure fed back into a fresh Step 3 attempt
 */
export type ExecutionStage =
  | 'context'
  | 'overview'
  | 'decompose'
  | 'subagent'
  | 'mcp_call'
  | 'thinking'
  | 'execution'
  | 'verify'
  | 'cleaner'
  | 'verifier'
  | 'retry'
  | 'human_input'
  | 'built_record'
  | 'done'
  | 'terminating';

export type AgentRole = 'summary' | 'manager' | 'worker' | 'cleaner' | 'verifier' | 'logger' | 'autocomplete';

/** Token accounting for a single LLM call or an aggregate across calls. */
export interface TokenUsage {
  /** All prompt tokens, INCLUDING cache reads/writes (Anthropic's raw input_tokens is normalized up to this). */
  inputTokens: number;
  outputTokens: number;
  /** Prompt tokens served from the provider's prompt cache (Anthropic cache_read, OpenAI cached_tokens, Gemini cachedContentTokenCount). */
  cachedInputTokens: number;
  /** Tokens written to cache this call (Anthropic only). */
  cacheWriteTokens: number;
  /** Number of LLM round-trips aggregated into this record. */
  calls: number;
  /** True when any part of this tally was approximated from text length instead of reported by the provider. */
  estimated?: boolean;
  /**
   * What these calls cost at the provider's API prices (USD), cache discounts included. For subscription CLIs it's the
   * API-equivalent value. Absent when no call in the tally could be priced (local models, unknown models).
   */
  costUsd?: number;
  /** Some calls in the tally have tokens but no price (an unknown or local model): costUsd undercounts. */
  costPartial?: boolean;
}

export interface ExecutionStep {
  id: string;
  taskId?: string | number;
  time: string;
  stage: ExecutionStage;
  title: string;
  detail: string;
  mcpToolUsed?: string;
  status: 'pending' | 'running' | 'success' | 'warning' | 'error' | 'cancelled';
  /** Which pipeline agent emitted this step. */
  agentRole?: AgentRole;
  /** Puzzle piece this step belongs to (worker sub-agents). */
  pieceId?: string;
  /** CLI agent session (SpawnedSession.ptySessionId) whose terminal belongs to this step. */
  ptySessionId?: string;
  /** Token usage for this step (per-agent or cumulative, see title/detail). */
  usage?: TokenUsage;
  /** Running tally of all tokens used during this task up to this step. */
  totalUsage?: TokenUsage;
  /** Snapshot of the TASK_CONTEXT.md bible (rendered markdown) for UI preview. */
  bibleMarkdown?: string;
  /** Relative path (under the storage root) of the persisted TASK_CONTEXT.md for this run. */
  bibleFilePath?: string;
  widgetType?: 'code_diff' | 'analytics_chart' | 'figma_preview' | 'slack_draft' | 'bluebeam_diff' | 'vscode_preview';
  widgetData?: any;
  humanInputPrompt?: HumanInputPrompt;
  // Plain JSON Discovery payload produced by Step 2 Discovery AI
  discoveryPayload?: DiscoveryJobPayload;
  // The assembled overview document (set after Summary AI completes)
  overviewDocument?: OverviewDocument;
  /** Assembled zero-token baseline context (vector memory hits + project guidelines) */
  baselineContext?: AssembledBaselineContext;
}

export interface AssembledMemoryHit {
  id: string;
  similarity: number;
  namespace: string;
  text: string;
  source?: string;
  taskTitle?: string;
  taskId?: string | number;
  projectId?: string;
  tags?: string[];
}

export interface AssembledGuidelineDoc {
  path: string;
  excerpt: string;
}

export interface AssembledBaselineContext {
  query: string;
  threshold: number;
  projectId?: string;
  memoryHits: AssembledMemoryHit[];
  guidelines: AssembledGuidelineDoc[];
  timestamp: string;
  /** Stage 1 of related-task matching: local candidates from the project's workspace index (zero tokens). */
  relatedCandidates?: import('../lib/memory/types.ts').RelatedTaskCandidate[];
  /** Freeform workspace text that matched the task. */
  relatedNotes?: import('../lib/memory/types.ts').RelatedNoteCandidate[];
  /** Stage 2: the candidate task ids the Summary step judged useful context (undefined until it has run). */
  selectedRelatedTaskIds?: string[];
}

export type RootFolderStatus = 'connected' | 'needs_permission' | 'disconnected' | 'server_fallback';

export interface FolderMetadata {
  name: string;
  path?: string;
  storageDirectory?: string; // e.g. "~/.ergo"
  resolvedPath?: string; // e.g. "/home/user/.ergo"
  status: RootFolderStatus;
  mode: 'file_system_api' | 'server_api' | 'local_fallback';
  lastSyncedAt?: string;
}

export interface AutocompleteSettings {
  enabled: boolean;
  keybinding: 'Tab' | 'ArrowRight' | 'Enter';
}

export interface AppSettings {
  version: number;
  activeProjectId: string;
  activeKeyId: string | null;
  autosaveDelaySec: number;
  autosaveEnabled: boolean;
  theme?: 'light' | 'dark';
  storageDirectory?: string; // default: "~/.ergo"
  lastOpenedAt?: string;
  hasCompletedOnboarding?: boolean;
  /** Agent execution pipeline tuning (concurrency, verifier retries, tool rounds). */
  agentPipeline?: Partial<AgentPipelineOptions>;
  /** Autocomplete configuration (toggle, keybinding). */
  autocomplete?: AutocompleteSettings;
  /**
   * Engine for small background decisions (CLI run shape, autocomplete): the installed local model, or the AI
   * profile's tiny cloud model. Absent = never chosen (the cloud model is used).
   */
  localModel?: LocalModelSettings;
  /** Legacy location of the Artificial Analysis key (now in secrets.json); read once to migrate it. */
  modelData?: ModelDataSettings;
}

export interface LocalModelSettings {
  mode: 'local' | 'cloud';
}

export interface ModelDataSettings {
  /** Free Artificial Analysis API key: live benchmark scores replace the built-in strengths table. */
  artificialAnalysisKey?: string;
}

export interface StorageDirectoryConfig {
  defaultPath: string;
  activePath: string;
  resolvedPath: string;
  homeDir: string;
}

export interface McpSecretEntry {
  endpoint?: string;
  token?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

export interface AppSecrets {
  version: number;
  updatedAt: string;
  userApiKeys: UserApiKey[];
  mcpSecrets?: Record<string, McpSecretEntry>;
  cliAgent?: CliAgentConfig;
  cliAgents?: CliAgentSetup[];
  activeCliAgentId?: string | null;
  /** Optional Artificial Analysis key for Auto model selection. Omitted on save = keep the stored value. */
  modelData?: ModelDataSettings;
}

// ─── CLI Coding Agent Types ──────────────────────────────────────────────────

/** A well-known coding agent CLI provider with pre-filled defaults. */
export interface CliAgentPreset {
  id: string;          // e.g. 'claude-code'
  label: string;       // e.g. 'Claude Code'
  command: string;     // e.g. 'claude'
  defaultArgs: string; // e.g. '--dangerously-skip-permissions'
  docsUrl: string;
  description: string;
  badgeColor: string;  // CSS var or hex
}

/** A saved coding agent configuration preset/setup */
export interface CliAgentSetup {
  id: string;
  name: string;
  presetId?: string;   // If set, derived from a CliAgentPreset or 'custom'
  command: string;     // Shell command to run, e.g. 'claude', 'agy', './my-agent.sh'
  extraArgs: string;   // Extra flags, e.g. '--verbose'
  createdAt?: string;
}

/** User-configured CLI agent that Ergo will spawn in a PTY. */
export interface CliAgentConfig {
  id?: string;
  name?: string;
  presetId?: string;   // If set, derived from a CliAgentPreset
  command: string;     // Shell command to run, e.g. 'claude'
  extraArgs: string;   // Extra flags, e.g. '--verbose'
}

/**
 * Tracks a live or recently-exited PTY terminal session for one agent of a task run.
 */
export interface TerminalSession {
  taskId: string | number;
  taskTitle: string;
  isActive: boolean;   // PTY process still alive
  exitCode?: number;
  spawnedAt: string;   // ISO string
}

/** Which agent of a CLI task run a PTY session belongs to. */
export type AgentSessionRole = 'manager' | 'worker' | 'verifier';

/**
 * Lifecycle of one agent session:
 *  - starting:          launch requested, PTY not confirmed yet
 *  - running:           working
 *  - awaiting_approval: the CLI is showing a prompt that needs the user (see pendingPrompt)
 *  - waiting:           manager handed work to workers (or verifier) and is waiting for their results
 *  - done / failed / cancelled: finished
 */
export type AgentSessionStatus = 'starting' | 'running' | 'awaiting_approval' | 'waiting' | 'done' | 'failed' | 'cancelled';

/** One option of an interactive CLI prompt (approval menu, yes/no confirmation). */
export interface CliPromptOption {
  key: string;
  label: string;
  isDefault?: boolean;
  isDestructive?: boolean;
  /** False for un-numbered TUI menus ("❯ Yes"), which are answered with arrow keys instead of the key. */
  numbered?: boolean;
  /** Position in the menu (0-based). */
  index?: number;
  /** This option grants the request ("Yes", "Allow", "Approve"...). */
  isApprove?: boolean;
}

/** An interactive prompt a CLI agent is blocked on, parsed from its rendered terminal screen. */
export interface CliDetectedPrompt {
  type: 'multiple_choice' | 'confirmation' | 'freeform';
  /** approval = asks permission for a tool/command/edit; question = agent asks the user something; notice = account/auth problem. */
  kind: 'approval' | 'question' | 'notice';
  title?: string;
  /** Tool header shown by the CLI, e.g. "Bash command", "Edit file", "Shell". */
  toolLabel?: string;
  /** The exact command (may be multi-line) the agent wants to run. */
  targetCommand?: string;
  /** Description line(s) the CLI shows with the request. */
  description?: string;
  /** Extra detail for non-command requests: file path, diff rows, URL, MCP tool + args. */
  detailLines?: string[];
  question: string;
  options?: CliPromptOption[];
  /** The prompt panel exactly as rendered on screen (fallback so the user never approves blind). */
  rawSnippet: string;
  /** Stable identity of this prompt (question + options + command) for dedupe. */
  signature: string;
}

export interface SpawnedSession {
  session: TerminalSession;
  /** Agent role within the task run. Sessions restored from older backends default to 'manager'. */
  role: AgentSessionRole;
  /** Human label shown on tabs and terminal headers, e.g. "Manager", "Worker W2 · Login form", "Verifier". */
  label: string;
  /** Worker piece id (workers only), e.g. "W2". */
  pieceId?: string;
  /** Bridge PTY key for this agent: `${taskId}::manager`, `${taskId}::worker::W2`, `${taskId}::qa`. */
  ptySessionId: string;
  /** Shared by every agent of one task run; signal files live in `<cwd>/.ergo/runs/<runId>/`. */
  runId: string;
  status: AgentSessionStatus;
  /** Permission level the session is currently running under. */
  permissionLevel?: PermissionLevel;
  /** Latest prompt the bridge detected on this agent's screen (null/undefined when none). */
  pendingPrompt?: CliDetectedPrompt | null;
  endedAt?: string;
  /** working directory the agent was launched in */
  cwd: string;
  /** resolved command + args */
  cmd: string;
  args: string[];
  /** Environment variables forwarded to the spawned process */
  env?: Record<string, string>;
  /** @deprecated Sessions are launched by App via POST /api/pty/spawn; views only attach. */
  forceRestart?: boolean;
  /** Unique per launch. */
  spawnId?: string;
  /** @deprecated Views always attach only. */
  attachOnly?: boolean;
}

// ─── Human Workspace AI Assistant Types ──────────────────────────────────────

export type HumanAiIntent = 'task' | 'architect';

export interface HumanAiAssistantResult {
  summary: string;
  todoMarkdown?: string;
  requiresDeletionApproval?: boolean;
  deletionReason?: string;
  aggregatedReport?: string;
  selectedMcpTools?: string[];
}

// ─── Agent Execution Pipeline Types ─────────────────────────────────────────

/** Coarse classification of a task; gates the Cleaner (lint/format) and shapes the Verifier's verifier prompt. */
export type TaskKind = 'coding' | 'writing' | 'research' | 'ops' | 'data' | 'other';

export type TaskRatingScore = 1 | 2 | 3 | 4 | 5;

/**
 * How demanding a task is, for Auto model selection (src/lib/agentPipeline/autoRouter.ts).
 *  - complexity: 1 = trivial one-liner, 3 = a feature touching a few files, 5 = large multi-part / architectural
 *  - reasoning:  1 = mechanical, 5 = hard design / debugging
 * `source`: the overview call rated it ('overview'), a separate tiny-model call ('tiny'), or heuristics.
 */
export interface TaskRating {
  kind: TaskKind;
  complexity: TaskRatingScore;
  reasoning: TaskRatingScore;
  source: 'overview' | 'tiny' | 'heuristic';
}

/** Auto: Ergo picks each stage's model per task. Manual: the per-stage models set in the AI profile. */
export type ModelSelectionMode = 'auto' | 'manual';

/**
 * How much the agent may do without asking, mirroring Claude Code's permission modes:
 *  - plan:        read-only; edits and commands are refused, nothing is asked
 *  - ask:         ask before every file edit, command, and external tool action
 *  - acceptEdits: workspace file edits and read-only commands run freely; ask for other commands and external tools
 *  - bypass:      never ask
 */
export type PermissionLevel = 'plan' | 'ask' | 'acceptEdits' | 'bypass';

/** Reasoning effort, using the shared scale that Claude, Antigravity and Codex expose. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** User-tunable knobs for the agent execution pipeline (persisted in settings.json). */
export interface AgentPipelineOptions {
  /** Permission level applied to pipeline tool calls and to spawned CLI agents. */
  permissionLevel: PermissionLevel;
  /** Effort level: each provider's reasoning depth; in Auto model selection also the quality-vs-cost balance. */
  effortLevel: EffortLevel;
  /** Auto: pick each stage's model per task (overrides the AI profile's per-stage models). Manual: use them. */
  modelSelection: ModelSelectionMode;
  /** Maximum worker sub-agents running concurrently (fan-out limit). */
  maxConcurrentAgents: number;
  /** How many times a Verifier failure may trigger a fresh Step 3 retry. */
  maxVerifierRetries: number;
  /** Maximum LLM round-trips (tool-call rounds) any single agent loop may take. */
  maxToolRoundsPerAgent: number;
  /** Run the Cleaner (lint/format) pass for coding tasks. */
  enableCleaner: boolean;
}

export type PuzzlePieceKind = 'setup' | 'build' | 'verify' | 'edge';
export type PuzzlePieceStatus = 'pending' | 'running' | 'done' | 'failed' | 'blocked' | 'skipped';

/**
 * One discrete, verifiable unit of work decomposed by the Manager from the working brief's "Done when" criteria.
 * Each piece is executed by an isolated worker sub-agent with a clean, scoped context.
 */
export interface PuzzlePiece {
  id: string;                 // e.g. "P1"
  kind: PuzzlePieceKind;      // setup = preconditions, build = implementation, verify = acceptance checks (read-only), edge = failure / edge cases
  title: string;
  /** Self-contained instructions for the worker (it sees nothing else about the task besides the shared bible prefix). */
  instructions: string;
  /** Ids of the "Done when" criteria (C1, C2, …) this piece satisfies or verifies. */
  criterionRefs: string[];
  /** Files this piece is allowed to create/modify (write scope + lock set). Empty = read-only piece. */
  files: string[];
  /** Piece IDs that must be done before this piece may start. */
  dependsOn: string[];
  status: PuzzlePieceStatus;
  /** Condensed result summary written back to the bible event log by the worker. */
  summary?: string;
  /** High-signal failure diagnostics preserved for retries. */
  lastError?: string;
  attempts: number;
}

export type BibleEventKind =
  | 'info'
  | 'decompose'
  | 'piece_start'
  | 'piece_done'
  | 'piece_failed'
  | 'lock'
  | 'human'
  | 'verify'
  | 'cleaner'
  | 'verifier_pass'
  | 'verifier_fail'
  | 'retry'
  | 'error';

/** One append-only entry in the TASK_CONTEXT.md Execution Event Log. */
export interface BibleEvent {
  at: string;          // ISO timestamp
  actor: string;       // e.g. "manager", "worker:P2", "verifier"
  kind: BibleEventKind;
  text: string;        // condensed, human-readable
  pieceId?: string;
}

/** Stable (per-run, byte-identical) sections of the TASK_CONTEXT.md bible. */
export interface BibleSections {
  title: string;
  metadata: {
    taskId: string | number;
    category: string;
    status: string;
    sourceDocument: string;
    projectName: string;
    projectPath: string;
    taskKind: TaskKind;
    runId: string;
    requiresVerifier?: boolean;
    verifierReason?: string;
  };
  subtasks: Array<{ text: string; isDone: boolean; isHumanReview?: boolean }>;
  /** The Summary step's working brief, verbatim: the manager's whole spec. */
  spec: string;
  /** The invoked skills and referenced files (formatReferenceSections), fixed at run start. */
  references?: string[];
  /** The project's learned rules (insights.ts), fixed at run start: every agent of the run reads them here. */
  projectRules?: string[];
  requiredMcps: string[];
  allowedRoots: string[];
}
