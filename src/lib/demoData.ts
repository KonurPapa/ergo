import { type ProjectData, type MCPServer } from '../types';

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
  const agentContextFilePath = `${folderPath}/AGENT_CONTEXT.md`;

  const defaultTodoMarkdown = `<!-- Project: ${name} | Folder: ${folderPath} -->
<!-- Linked Context: ${agentContextFilePath} -->
<!-- Keep this file scannable. Full briefs, build records and test notes live in ${agentContextFilePath}, keyed by item number. -->

# ${name} Tasks:

1. **Initial Task Setup:**
    - Define project scope and task list
    - Verify bi-directional link with ${agentContextFilePath}`;

  const defaultAgentContextMarkdown = `<!-- Project: ${name} | Folder: ${folderPath} -->
<!-- Linked Tasks: ${todoFilePath} -->
# ${name} Context — the verbose half of \`${todoFilePath}\`

\`TODO.md\` is the **human** view for ${name}. This file is the **agent** view: the full brief for an item before it's built, and the full record of what was built after.

Rules of the split:
- Sections here mirror \`${todoFilePath}\` **by item number and title** — same numbers, same order.
- Heavily bound to ${name} (${folderPath}).

---

### 1. Initial Task Setup

**Status:** not started

**Brief**
Setup initial project structure and link human task list with agent context briefs.

**Built**
Created project folder structure under ${folderPath} with isolated TODO.md and AGENT_CONTEXT.md.

**Validation**
Verified directory paths and unique markdown file references.`;

  return {
    id,
    name,
    description: description || `Project folder and markdown storage for ${name}.`,
    folderPath,
    todoFilePath,
    agentContextFilePath,
    todoMarkdown: initialTodoMarkdown || defaultTodoMarkdown,
    agentContextMarkdown: initialAgentContextMarkdown || defaultAgentContextMarkdown,
    connectedMcps: ['mcp-salesforce', 'mcp-gcal', 'mcp-slack', 'mcp-github', 'mcp-notion', 'mcp-zapier']
  };
}

export const INITIAL_PROJECTS: ProjectData[] = [
  {
    id: 'default-workspace',
    name: 'Default Workspace',
    description: 'Main project folder storing TODO.md and AGENT_CONTEXT.md',
    folderPath: 'projects/default-workspace',
    todoFilePath: 'projects/default-workspace/TODO.md',
    agentContextFilePath: 'projects/default-workspace/AGENT_CONTEXT.md',
    connectedMcps: ['mcp-salesforce', 'mcp-gcal', 'mcp-slack', 'mcp-github', 'mcp-notion', 'mcp-zapier'],
    todoMarkdown: `<!-- Project: Default Workspace | Folder: projects/default-workspace -->
<!-- Linked Context: projects/default-workspace/AGENT_CONTEXT.md -->
<!-- Keep this file scannable. Full briefs, build records and test notes live in AGENT_CONTEXT.md, keyed by item number. -->

# Core Tasks:

1. **Initial Task Setup:**
    - Define project scope and task list
    - Verify bi-directional link with AGENT_CONTEXT.md`,
    agentContextMarkdown: `<!-- Project: Default Workspace | Folder: projects/default-workspace -->
<!-- Linked Tasks: projects/default-workspace/TODO.md -->
# Default Workspace Context — the verbose half of \`projects/default-workspace/TODO.md\`

\`TODO.md\` is the **human** view for Default Workspace. This file is the **agent** view: the full brief for an item before it's built, and the full record of what was built after.

Rules of the split:
- Sections here mirror \`projects/default-workspace/TODO.md\` **by item number and title** — same numbers, same order.
- Heavily bound to Default Workspace (projects/default-workspace).

---

### 1. Initial Task Setup

**Status:** not started

**Brief**
Setup initial project structure and link human task list with agent context briefs.

**Built**
Created project folder structure under projects/default-workspace with isolated TODO.md and AGENT_CONTEXT.md.

**Validation**
Verified directory paths and unique markdown file references.`
  }
];

export const DEMO_PROJECTS = INITIAL_PROJECTS;

export const INITIAL_MCP_SERVERS: MCPServer[] = [
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
      { id: 'fs_read_file', name: 'read_file', description: 'Read full content of a file within allowed directory roots', autoApprove: true, serverId: 'mcp-filesystem' },
      { id: 'fs_write_file', name: 'write_file', description: 'Create or overwrite a file on disk within allowed roots', autoApprove: false, serverId: 'mcp-filesystem' },
      { id: 'fs_list_directory', name: 'list_directory', description: 'List files and subdirectories inside an allowed path', autoApprove: true, serverId: 'mcp-filesystem' },
      { id: 'fs_create_directory', name: 'create_directory', description: 'Create a new directory recursively', autoApprove: true, serverId: 'mcp-filesystem' },
      { id: 'fs_search_files', name: 'search_files', description: 'Search files matching a filename or content pattern', autoApprove: true, serverId: 'mcp-filesystem' },
      { id: 'fs_get_file_info', name: 'get_file_info', description: 'Retrieve file metadata (size, modified date, permissions)', autoApprove: true, serverId: 'mcp-filesystem' }
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
    description: 'Access repositories, pull requests, issue tracking, code commits, and CI workflow runs.',
    iconName: 'Github',
    iconUrl: '/icons/github.svg',
    category: 'developer',
    status: 'connected',
    transport: 'OAuth 2.1',
    endpoint: 'https://mcp.github.com/v1',
    serverType: 'external_oauth',
    tools: [
      { id: 'gh_create_issue', name: 'create_issue', description: 'Create a new issue in a target repository', autoApprove: false, serverId: 'mcp-github' },
      { id: 'gh_list_prs', name: 'list_pull_requests', description: 'List open PRs with CI and review status', autoApprove: true, serverId: 'mcp-github' },
      { id: 'gh_post_comment', name: 'post_pr_comment', description: 'Post review comments on pull requests and issues', autoApprove: false, serverId: 'mcp-github' }
    ]
  },
  {
    id: 'mcp-gcal',
    name: 'Google Calendar',
    description: 'Schedule meetings, check team availability, manage timeline events, and synchronize milestones.',
    iconName: 'Calendar',
    iconUrl: '/icons/googlecalendar.svg',
    category: 'productivity',
    status: 'connected',
    transport: 'OAuth 2.1',
    endpoint: 'https://mcp.google.com/calendar/v3',
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
    status: 'connected',
    transport: 'OAuth 2.1',
    endpoint: 'https://mcp.salesforce.com/services/oauth2',
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
    status: 'connected',
    transport: 'OAuth 2.1',
    endpoint: 'https://mcp.slack.com/sse',
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
    status: 'connected',
    transport: 'OAuth 2.1',
    endpoint: 'https://mcp.notion.com/v1',
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
    status: 'connected',
    transport: 'OAuth 2.1',
    endpoint: 'https://mcp.zapier.com/actions/v1',
    serverType: 'external_oauth',
    tools: [
      { id: 'zapier_list_actions', name: 'list_available_zaps', description: 'List connected Zapier AI action triggers and recipes', autoApprove: true, serverId: 'mcp-zapier' },
      { id: 'zapier_run_action', name: 'execute_zap_action', description: 'Trigger automated Zap with custom payload fields', autoApprove: false, serverId: 'mcp-zapier' }
    ]
  }
];

