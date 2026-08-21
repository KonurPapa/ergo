export type TaskStatus = 'not_started' | 'in_progress' | 'partly_done' | 'done';

export interface Subtask {
  id: string;
  text: string;
  isDone: boolean;
  isHumanReview?: boolean;
}

export interface TaskItem {
  id: number; // e.g. 1, 2, 3
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
  mcpRequired?: string[]; // e.g. ['github', 'filesystem']
  summaryNote?: string;
}

export interface AgentContextItem {
  itemNumber: number;
  title: string;
  isUnordered?: boolean;
  status: TaskStatus | string;
  overview: string;
  buildAndVerification: string;
  completion: string;
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
  generalModel?: string;
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
  generalModel?: string;
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
  generalModel?: string;
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
}

export interface ExecutionStep {
  id: string;
  time: string;
  stage: 'context' | 'mcp_call' | 'thinking' | 'execution' | 'built_record' | 'done';
  title: string;
  detail: string;
  mcpToolUsed?: string;
  status: 'pending' | 'running' | 'success' | 'warning' | 'error';
  widgetType?: 'code_diff' | 'analytics_chart' | 'figma_preview' | 'slack_draft' | 'bluebeam_diff' | 'vscode_preview';
  widgetData?: any;
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
  theme?: string;
  storageDirectory?: string; // default: "~/.ergo"
  lastOpenedAt?: string;
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

/** User-configured CLI agent that Ergo will spawn in a PTY. */
export interface CliAgentConfig {
  presetId?: string;   // If set, derived from a CliAgentPreset
  command: string;     // Shell command to run, e.g. 'claude'
  extraArgs: string;   // Extra flags, e.g. '--verbose'
}

/**
 * Tracks a live or recently-exited PTY terminal session for a specific task.
 * One session per task; concurrent tasks get their own session.
 */
export interface TerminalSession {
  taskId: number;
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



