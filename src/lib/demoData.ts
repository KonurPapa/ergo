import { type ProjectData, type MCPServer } from '../types';
import { GITHUB_MCP_TOOLS } from './githubMcpTools';

export function createSlug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'new-project';
}

export function createNewProjectData(
  name: string,
  customFolder?: string,
  description?: string,
  initialTodoMarkdown?: string,
  initialAgentContextMarkdown?: string
): ProjectData {
  const slug = createSlug(customFolder || name);
  const id = `project-${Date.now()}`;
  const folderPath = `projects/${slug}`;
  const todoFilePath = `${folderPath}/TODO.md`;

  const defaultTodoMarkdown = `<!-- Project: ${name} | Folder: ${folderPath} -->

## ${name} Tasks

1. Initial Task Setup
    - Define project scope and task list
    - Verify AI task execution and vector memory context`;

  const defaultAgentContextMarkdown = `<!-- Project: ${name} | Folder: ${folderPath} -->
<!-- Linked Tasks: ${todoFilePath} -->
# ${name} Context — the verbose half of \`${todoFilePath}\`

\`TODO.md\` is the **human** view for ${name}. This file is the **agent** view: the full overview for an item before it's built, mid-task build & verification notes, and the completion record of what was built and where the task stands.

Rules of the split:
- Sections here mirror \`${todoFilePath}\` **by item number and title** — same numbers, same order.
- Heavily bound to ${name} (${folderPath}).

---

### 1. Initial Task Setup

**Status:** not started

**Overview**
Setup initial project structure and link human task list with agent context briefs.

**Build & Verification**
Created project folder structure under ${folderPath} with isolated TODO.md and local vector storage. Verified directory paths and markdown file references.

**Completion**
Initial project structure initialized. All core links verified.`;

  const todoMd = initialTodoMarkdown || defaultTodoMarkdown;
  const agentMd = initialAgentContextMarkdown || defaultAgentContextMarkdown;

  return {
    id,
    name,
    description: description || `Project folder and markdown storage for ${name}.`,
    folderPath,
    todoFilePath,
    todoMarkdown: todoMd,
    agentContextMarkdown: agentMd,
    connectedMcps: ['mcp-filesystem', 'mcp-fetch', 'mcp-git'],
    swimLanes: [
      {
        id: `lane-${slug || 'default'}`,
        title: 'Human Workspace',
        filePath: todoFilePath,
        markdown: todoMd
      }
    ]
  };
}

export const INITIAL_PROJECTS: ProjectData[] = [
  {
    id: 'default-workspace',
    name: 'Default Workspace',
    description: 'Main project folder storing workspace markdown and vector memory',
    folderPath: 'projects/default-workspace',
    todoFilePath: 'projects/default-workspace/TODO.md',
    connectedMcps: ['mcp-filesystem', 'mcp-fetch', 'mcp-git'],
    todoMarkdown: `<!-- Project: Default Workspace | Folder: projects/default-workspace -->

## Core Tasks

1. Initial Task Setup
    - Define project scope and task list
    - Verify AI task execution and vector memory context`,
    agentContextMarkdown: `<!-- Project: Default Workspace | Folder: projects/default-workspace -->
<!-- Linked Tasks: projects/default-workspace/TODO.md -->
# Default Workspace Context — the verbose half of \`projects/default-workspace/TODO.md\`

\`TODO.md\` is the **human** view for Default Workspace. This file is the **agent** view: the full overview for an item before it's built, mid-task build & verification notes, and the completion record of what was built and where the task stands.

Rules of the split:
- Sections here mirror \`projects/default-workspace/TODO.md\` **by item number and title** — same numbers, same order.
- Heavily bound to Default Workspace (projects/default-workspace).

---

### 1. Initial Task Setup

**Status:** not started

**Overview**
Setup initial project structure and link human task list with agent context briefs.

**Build & Verification**
Created project folder structure under projects/default-workspace with isolated TODO.md and local vector storage. Verified directory paths and markdown file references.

**Completion**
Initial project structure initialized. All core links verified.`,
    swimLanes: [
      {
        id: 'lane-default',
        title: 'Human Workspace',
        filePath: 'projects/default-workspace/TODO.md',
        markdown: `<!-- Project: Default Workspace | Folder: projects/default-workspace -->
<!-- Linked Context: Local Vector Storage (ergo-vector-memory) -->

## Core Tasks

1. Initial Task Setup
    - Define project scope and task list
    - Verify zero-token context retrieval with vector memory`
      }
    ]
  }
];

export const DEMO_PROJECTS = INITIAL_PROJECTS;

export const INITIAL_MCP_SERVERS: MCPServer[] = [
  {
    id: 'mcp-laya',
    name: 'Laya Local Decision Engine',
    description: 'Local non-autoregressive System 1 decision engine for micro-decisions, tool routing, and classification at $0 token cost in ~30–75ms. Runs entirely on your CPU/GPU.',
    iconName: 'Zap',
    category: 'developer',
    status: 'disconnected',
    transport: 'Local Stdio',
    endpoint: 'stdio://ergo-mcp-laya',
    serverType: 'bundled_harness',
    tools: [
      { id: 'laya_choice', name: 'laya_choice', description: 'Choose the best option among candidates (max 15-20 options per batch) with calibrated probability', autoApprove: true, serverId: 'mcp-laya' },
      { id: 'laya_score', name: 'laya_score', description: 'Evaluate deliverable quality or relevance with calibrated confidence score (0.0 to 1.0)', autoApprove: true, serverId: 'mcp-laya' },
      { id: 'laya_noul', name: 'laya_noul', description: 'Evaluate binary yes/no decision propositions without generating tokens', autoApprove: true, serverId: 'mcp-laya' }
    ]
  },
  {
    id: 'mcp-filesystem',
    name: 'Filesystem MCP',
    description: 'Official MCP Filesystem server (server-filesystem) providing safe, root-sandboxed file reading, writing, directory navigation, and file search.',
    iconName: 'Folder',
    category: 'developer',
    status: 'connected',
    transport: 'Local Stdio',
    endpoint: 'stdio://ergo-mcp-filesystem',
    serverType: 'bundled_harness',
    lastSyncedAt: new Date().toISOString(),
    tools: [
      { id: 'fs_read_file', name: 'read_file', description: 'Read a file within allowed directory roots; supports offset/limit line paging for large files', autoApprove: true, serverId: 'mcp-filesystem' },
      { id: 'fs_write_file', name: 'write_file', description: 'Create or overwrite a file on disk within allowed roots', autoApprove: false, serverId: 'mcp-filesystem' },
      { id: 'fs_edit_file', name: 'edit_file', description: 'Replace an exact text span in an existing file (diff-style edit; cheaper than rewriting the whole file)', autoApprove: false, serverId: 'mcp-filesystem' },
      { id: 'fs_list_directory', name: 'list_directory', description: 'List files and subdirectories inside an allowed path', autoApprove: true, serverId: 'mcp-filesystem' },
      { id: 'fs_create_directory', name: 'create_directory', description: 'Create a new directory recursively', autoApprove: true, serverId: 'mcp-filesystem' },
      { id: 'fs_search_files', name: 'search_files', description: 'Search files by filename substring and/or grep file contents with a regex (contentPattern)', autoApprove: true, serverId: 'mcp-filesystem' },
      { id: 'fs_get_file_info', name: 'get_file_info', description: 'Retrieve file metadata (size, modified date, permissions)', autoApprove: true, serverId: 'mcp-filesystem' },
      { id: 'fs_run_command', name: 'run_command', description: 'Run a shell command (tests, lint, build, scripts) inside an allowed folder; returns exit code, stdout and stderr', autoApprove: false, serverId: 'mcp-filesystem' }
    ]
  },
  {
    id: 'mcp-fetch',
    name: 'Web Fetcher MCP',
    description: 'Official MCP Fetch server (server-fetch) that retrieves web pages, APIs, and online docs, automatically converting HTML to clean markdown.',
    iconName: 'Cloud',
    category: 'productivity',
    status: 'connected',
    transport: 'Local Stdio',
    endpoint: 'stdio://ergo-mcp-fetch',
    serverType: 'bundled_harness',
    lastSyncedAt: new Date().toISOString(),
    tools: [
      { id: 'fetch_markdown', name: 'fetch_markdown', description: 'Fetch a web page or API and convert content to clean markdown for the AI', autoApprove: true, serverId: 'mcp-fetch' },
      { id: 'fetch_url', name: 'fetch_url', description: 'Fetch raw HTTP response content and headers from a target URL', autoApprove: true, serverId: 'mcp-fetch' }
    ]
  },
  {
    id: 'mcp-git',
    name: 'Git Operations MCP',
    description: 'Reference MCP Git server (mcp-server-git) for inspecting repository status, file diffs, commits, branches, and logs.',
    iconName: 'Code',
    category: 'developer',
    status: 'connected',
    transport: 'Local Stdio',
    endpoint: 'stdio://ergo-mcp-git',
    serverType: 'bundled_harness',
    lastSyncedAt: new Date().toISOString(),
    tools: [
      { id: 'git_status', name: 'git_status', description: 'Show working tree status and modified files', autoApprove: true, serverId: 'mcp-git' },
      { id: 'git_diff', name: 'git_diff', description: 'Show changes between commits or working tree', autoApprove: true, serverId: 'mcp-git' },
      { id: 'git_log', name: 'git_log', description: 'Show commit history logs and author metadata', autoApprove: true, serverId: 'mcp-git' },
      { id: 'git_commit', name: 'git_commit', description: 'Record changes to the repository with a commit message', autoApprove: false, serverId: 'mcp-git' }
    ]
  },
  {
    id: 'mcp-github',
    name: 'GitHub',
    description: 'Access repositories, pull requests, issue tracking, code commits, branch inspection, and CI workflows via the official Model Context Protocol server.',
    iconName: 'Github',
    iconUrl: '/icons/github.svg',
    category: 'developer',
    status: 'disconnected',
    transport: 'Local Stdio',
    endpoint: 'stdio://@modelcontextprotocol/server-github',
    serverType: 'external_oauth',
    tools: GITHUB_MCP_TOOLS
  },
  {
    id: 'mcp-gcal',
    name: 'Google Calendar',
    description: 'Schedule meetings, check team availability, manage timeline events, and synchronize milestones.',
    iconName: 'Calendar',
    iconUrl: '/icons/googlecalendar.svg',
    category: 'productivity',
    status: 'disconnected',
    transport: 'OAuth 2.1',
    endpoint: '',
    serverType: 'external_oauth',
    tools: [
      { id: 'gcal_list_events', name: 'list_calendar_events', description: 'Query upcoming calendar schedule and availability', autoApprove: true, serverId: 'mcp-gcal' },
      { id: 'gcal_create_event', name: 'schedule_meeting_event', description: 'Create calendar event with attendees and conference link', autoApprove: false, serverId: 'mcp-gcal' },
      { id: 'gcal_update_event', name: 'reschedule_event', description: 'Modify meeting timing, attendees, or details', autoApprove: false, serverId: 'mcp-gcal' }
    ]
  },
  {
    id: 'mcp-salesforce',
    name: 'Salesforce',
    description: 'Sync CRM records, query leads and opportunities, update pipeline stages, and trigger workflow automations.',
    iconName: 'Cloud',
    iconUrl: '/icons/salesforce.svg',
    category: 'productivity',
    status: 'disconnected',
    transport: 'OAuth 2.1',
    endpoint: '',
    serverType: 'external_oauth',
    tools: [
      { id: 'sf_query_records', name: 'query_salesforce_records', description: 'Run SOQL queries to search accounts, leads, and opportunities', autoApprove: true, serverId: 'mcp-salesforce' },
      { id: 'sf_update_opportunity', name: 'update_opportunity_stage', description: 'Update pipeline stage, deal size, or close dates', autoApprove: false, serverId: 'mcp-salesforce' },
      { id: 'sf_create_lead', name: 'create_crm_lead', description: 'Create and assign new sales leads in CRM', autoApprove: false, serverId: 'mcp-salesforce' }
    ]
  },
  {
    id: 'mcp-slack',
    name: 'Slack',
    description: 'Send channel broadcasts, draft messages, trigger workflows, and post automated status digests.',
    iconName: 'MessageSquare',
    iconUrl: '/icons/slack.svg',
    category: 'productivity',
    status: 'disconnected',
    transport: 'Local Stdio',
    endpoint: 'stdio://@modelcontextprotocol/server-slack',
    serverType: 'external_oauth',
    tools: [
      { id: 'slack_send_msg', name: 'send_channel_message', description: 'Send message or announcement to a Slack channel', autoApprove: false, serverId: 'mcp-slack' },
      { id: 'slack_draft', name: 'render_message_composer', description: 'Render interactive message composer widget', autoApprove: true, serverId: 'mcp-slack' },
      { id: 'slack_list_channels', name: 'list_slack_channels', description: 'List public and private Slack channels for notifications', autoApprove: true, serverId: 'mcp-slack' }
    ]
  },
  {
    id: 'mcp-notion',
    name: 'Notion',
    description: 'Search databases, create workspace pages, sync documentation briefs, and update roadmap tasks.',
    iconName: 'BookOpen',
    iconUrl: '/icons/notion.svg',
    category: 'productivity',
    status: 'disconnected',
    transport: 'OAuth 2.1',
    endpoint: '',
    serverType: 'external_oauth',
    tools: [
      { id: 'notion_query_database', name: 'query_database_entries', description: 'Query and filter Notion workspace database records', autoApprove: true, serverId: 'mcp-notion' },
      { id: 'notion_create_page', name: 'create_notion_page', description: 'Create rich documentation pages and database entries', autoApprove: false, serverId: 'mcp-notion' },
      { id: 'notion_append_block', name: 'append_page_content', description: 'Append markdown blocks and task checklists to Notion pages', autoApprove: false, serverId: 'mcp-notion' }
    ]
  },
  {
    id: 'mcp-zapier',
    name: 'Zapier',
    description: 'Trigger automated multi-app Zaps, trigger webhooks, and orchestrate third-party SaaS integrations.',
    iconName: 'Zap',
    iconUrl: '/icons/zapier.svg',
    category: 'productivity',
    status: 'disconnected',
    transport: 'OAuth 2.1',
    endpoint: 'https://mcp.zapier.com/actions/v1',
    serverType: 'external_oauth',
    tools: [
      { id: 'zapier_list_actions', name: 'list_available_zaps', description: 'List connected Zapier AI action triggers and recipes', autoApprove: true, serverId: 'mcp-zapier' },
      { id: 'zapier_run_action', name: 'execute_zap_action', description: 'Trigger automated Zap with custom payload fields', autoApprove: false, serverId: 'mcp-zapier' }
    ]
  }
];

