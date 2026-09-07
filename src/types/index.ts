export type TaskStatus = 'not_started' | 'in_progress' | 'partly_done' | 'done';

export interface Subtask {
  id: string;
  text: string;
  isDone: boolean;
  isHumanReview?: boolean;
}

export interface TaskItem {
  id: string | number; // e.g. "lane-default_task_1" or 1, 2, 3
  title: string;
  category: string;
  categoryHeadingPrefix?: string; // e.g. "##", "#", "###"
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
  // Compatibility fields
  brief?: string;
  built?: string;
  validation?: string;
  humanReview?: string;
  followUps?: string;
  rawContent?: string;
  passes?: Array<{ title: string; content: string }>;
}

export interface MCPServer {
  id: string;
  name: string;
  description: string;
  iconName: string;
  iconUrl?: string;
  category: 'developer' | 'productivity' | 'design' | 'analytics' | 'database';
  status: 'connected' | 'disconnected' | 'authenticating';
  transport: 'OAuth 2.1' | 'SSE' | 'Local Stdio';
  endpoint: string;
  tools: MCPTool[];
  serverType?: 'bundled_harness' | 'external_oauth';
  lastSyncedAt?: string;
}

export interface MCPTool {
  id: string;
  name: string;
  description: string;
  autoApprove: boolean;
  serverId?: string;
  category?: string;
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
}

export interface McpToolExecutionResult {
  success: boolean;
  data?: any;
  error?: string;
}


export type AIProviderId = 'openai' | 'anthropic' | 'gemini' | 'ollama' | 'none' | 'mock';

export interface AIProviderConfig {
  provider: AIProviderId;
  model: string;
  discoveryModel?: string;
  summaryModel?: string;
  generalModel?: string;
  /** Optional cheaper/faster model used for fan-out worker sub-agents (defaults to generalModel). */
  workerModel?: string;
  apiKey?: string;
  baseUrl?: string;
  isCustomKey?: boolean;
  isConnected?: boolean;
}

export interface ProviderCredentials {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  discoveryModel?: string;
  summaryModel?: string;
  generalModel?: string;
  workerModel?: string;
  isConnected?: boolean;
}

export type AICredentialsMap = Record<AIProviderId, ProviderCredentials>;

export interface UserApiKey {
  id: string;
  name: string;
  provider: AIProviderId;
  apiKey: string;
  baseUrl?: string;
  model?: string;
  discoveryModel?: string;
  summaryModel?: string;
  generalModel?: string;
  workerModel?: string;
  isConnected?: boolean;
  createdAt?: string;
}


export interface ProjectData {
  id: string;
  name: string;
  description: string;
  folderPath: string; // e.g. "projects/default-workspace"
  todoFilePath: string; // e.g. "projects/default-workspace/TODO.md"
  agentContextFilePath: string; // e.g. "projects/default-workspace/AGENT_CONTEXT.md"
  todoMarkdown: string;
  agentContextMarkdown: string;
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
 * This is the single source of truth handed to the Builder AI.
 * The brief is structured as human-verifiable Gherkin scenarios (Given-When-Then).
 * The user can edit it mid-task to steer the agent.
 */
export interface OverviewDocument {
  brief: string;         // Human-verifiable Gherkin scenarios (Given-When-Then) detailing done-state acceptance specifications
  goals: string;         // Specific success criteria and expected outcomes
  output_as: string;     // Format and location of the final output (MCP, file, markdown, etc.)
  context?: string;      // (Optional)
  constraints?: string;  // (Optional)
  raw?: string;          // Raw markdown rendition of the overview
  taskKind?: TaskKind;   // Classified by the Summary AI; drives Cleaner/Hardener gating
  requiresHardener?: boolean; // Evaluated by Summary AI: large tasks warrant Hardener QA, small/generic tasks skip it
  hardenerReason?: string;    // Rationale for why Hardener is required or skipped
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
    brief: string; // The human-verifiable Gherkin scenarios (Given-When-Then)
    goals: string; // Numbered checklist of deliverables
    output_as: string; // Exact destination & tool method
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
 *  - overview: Step 2 Summary (Gherkin brief)
 *  - decompose: Step 3 Manager decomposing Gherkin into puzzle pieces
 *  - subagent: a worker sub-agent executing one puzzle piece
 *  - mcp_call: an individual tool call (manager or worker)
 *  - verify: Manager verifying accumulated pieces against Gherkin scenarios
 *  - cleaner: Step 4 lint/format pass (coding tasks only)
 *  - hardener: Step 5 QA / eval harness
 *  - retry: QA failure fed back into a fresh Step 3 attempt
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
  | 'hardener'
  | 'retry'
  | 'human_input'
  | 'built_record'
  | 'done'
  | 'terminating';

export type AgentRole = 'discovery' | 'summary' | 'manager' | 'worker' | 'cleaner' | 'hardener' | 'logger';

/** Token accounting for a single LLM call or an aggregate across calls. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Prompt tokens served from the provider's prompt cache (Anthropic cache_read, OpenAI cached_tokens, Gemini cachedContentTokenCount). */
  cachedInputTokens: number;
  /** Tokens written to cache this call (Anthropic only). */
  cacheWriteTokens: number;
  /** Number of LLM round-trips aggregated into this record. */
  calls: number;
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

export interface AppSettings {
  version: number;
  activeProjectId: string;
  activeKeyId: string | null;
  autosaveDelaySec: number;
  autosaveEnabled: boolean;
  theme?: 'light' | 'dark';
  storageDirectory?: string; // default: "~/.ergo"
  lastOpenedAt?: string;
  /** Agent execution pipeline tuning (concurrency, QA retries, tool rounds). */
  agentPipeline?: Partial<AgentPipelineOptions>;
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
 * Tracks a live or recently-exited PTY terminal session for a specific task.
 * One session per task; concurrent tasks get their own session.
 */
export interface TerminalSession {
  taskId: string | number;
  taskTitle: string;
  isActive: boolean;   // PTY process still alive
  exitCode?: number;
  spawnedAt: string;   // ISO string
}

export interface SpawnedSession {
  session: TerminalSession;
  /** working directory the agent was launched in */
  cwd: string;
  /** resolved command + args */
  cmd: string;
  args: string[];
}

// ─── Human Workspace AI Assistant Types ──────────────────────────────────────

export type HumanAiIntent = 'task' | 'architect';

export interface HumanAiAssistantResult {
  summary: string;
  todoMarkdown?: string;
  agentContextMarkdown?: string;
  requiresDeletionApproval?: boolean;
  deletionReason?: string;
  aggregatedReport?: string;
}

// ─── Agent Execution Pipeline Types ─────────────────────────────────────────

/** Coarse classification of a task; gates the Cleaner (lint/format) and shapes the Hardener's QA prompt. */
export type TaskKind = 'coding' | 'writing' | 'research' | 'ops' | 'data' | 'other';

/** User-tunable knobs for the agent execution pipeline (persisted in settings.json). */
export interface AgentPipelineOptions {
  /** Maximum worker sub-agents running concurrently (fan-out limit). */
  maxConcurrentAgents: number;
  /** How many times a Hardener QA failure may trigger a fresh Step 3 retry. */
  maxQaRetries: number;
  /** Maximum LLM round-trips (tool-call rounds) any single agent loop may take. */
  maxToolRoundsPerAgent: number;
  /** Run the Cleaner (lint/format) pass for coding tasks. */
  enableCleaner: boolean;
  /** Run the Hardener (QA / eval harness) pass. */
  enableHardener: boolean;
  /** Minimum title match probability percentage (10-90, default 50) for candidate tasks in discovery before reading subtasks. */
  discoveryRelevanceThreshold: number;
}

export type PuzzlePieceKind = 'given' | 'when' | 'then' | 'edge';
export type PuzzlePieceStatus = 'pending' | 'running' | 'done' | 'failed' | 'blocked' | 'skipped';

/**
 * One discrete, verifiable unit of work decomposed by the Manager from the Gherkin scenarios.
 * Each piece is executed by an isolated worker sub-agent with a clean, scoped context.
 */
export interface PuzzlePiece {
  id: string;                 // e.g. "P1"
  kind: PuzzlePieceKind;      // given = preconditions, when = implementation, then = acceptance checks, edge = alternate flows / recovery
  title: string;
  /** Self-contained instructions for the worker (it sees nothing else about the task besides the shared bible prefix). */
  instructions: string;
  /** Gherkin scenario titles this piece satisfies or verifies. */
  scenarioRefs: string[];
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
  | 'qa_pass'
  | 'qa_fail'
  | 'retry'
  | 'error';

/** One append-only entry in the TASK_CONTEXT.md Execution Event Log. */
export interface BibleEvent {
  at: string;          // ISO timestamp
  actor: string;       // e.g. "manager", "worker:P2", "hardener"
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
    requiresHardener?: boolean;
    hardenerReason?: string;
  };
  subtasks: Array<{ text: string; isDone: boolean; isHumanReview?: boolean }>;
  /** Gherkin scenarios (Given-When-Then) — the acceptance criteria. */
  gherkin: string;
  /** Numbered deliverable goals checklist. */
  goals: string;
  outputAs: string;
  requiredMcps: string[];
  allowedRoots: string[];
  discoveredContext: Array<{ taskId: string | number; title: string; category: string; sourceDocument: string; snippet?: string }>;
  guidelines: Array<{ path: string; excerpt: string }>;
  discoveryNotes?: string;
}
