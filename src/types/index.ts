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
  status: TaskStatus | string;
  humanReview?: string;
  followUps?: string;
  brief: string;
  built: string;
  validation: string;
  rawContent?: string;
  passes?: Array<{ title: string; content: string }>;
}

export interface MCPServer {
  id: string;
  name: string;
  description: string;
  iconName: string;
  category: 'developer' | 'productivity' | 'design' | 'analytics' | 'database';
  status: 'connected' | 'disconnected' | 'authenticating';
  transport: 'OAuth 2.1' | 'SSE' | 'Local Stdio';
  endpoint: string;
  tools: MCPTool[];
}

export interface MCPTool {
  id: string;
  name: string;
  description: string;
  autoApprove: boolean;
}

export type AIProviderId = 'openai' | 'anthropic' | 'gemini' | 'ollama' | 'mock';

export interface AIProviderConfig {
  provider: AIProviderId;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  isCustomKey?: boolean;
  isConnected?: boolean;
}

export interface ProviderCredentials {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
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
