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
  description?: string
): ProjectData {
  const slug = createSlug(customFolder || name);
  const id = `project-${Date.now()}`;
  const folderPath = `projects/${slug}`;
  const todoFilePath = `${folderPath}/TODO.md`;
  const agentContextFilePath = `${folderPath}/AGENT_CONTEXT.md`;

  const todoMarkdown = `<!-- Project: ${name} | Folder: ${folderPath} -->
<!-- Linked Context: ${agentContextFilePath} -->
<!-- Keep this file scannable. Full briefs, build records and test notes live in ${agentContextFilePath}, keyed by item number. -->

# ${name} Tasks:

1. **Initial Task Setup:**
    - Define project scope and task list
    - Verify bi-directional link with ${agentContextFilePath}`;

  const agentContextMarkdown = `<!-- Project: ${name} | Folder: ${folderPath} -->
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
    todoMarkdown,
    agentContextMarkdown,
    connectedMcps: ['mcp-vscode', 'mcp-filesystem']
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
    connectedMcps: ['mcp-vscode', 'mcp-filesystem'],
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
    id: 'mcp-vscode',
    name: 'VS Code Editor MCP',
    description: 'Drive real-time file edits, open active markdown documents, and sync workspace tasks directly with VS Code.',
    iconName: 'Code',
    category: 'developer',
    status: 'connected',
    transport: 'Local Stdio',
    endpoint: 'vscode-ipc://ergo-vscode-bridge',
    tools: [
      { id: 'vscode_edit_document', name: 'edit_active_document', description: 'Drive line-by-line file edits and selections in active VS Code editor tab', autoApprove: true },
      { id: 'vscode_sync_markdown', name: 'sync_markdown_files', description: 'Bi-directional sync of TODO.md & AGENT_CONTEXT.md with VS Code project', autoApprove: true },
      { id: 'vscode_open_file', name: 'open_workspace_file', description: 'Open target file or jump to heading in VS Code editor', autoApprove: true },
      { id: 'vscode_run_cmd', name: 'execute_vscode_command', description: 'Trigger VS Code extension commands and save file buffers', autoApprove: false }
    ]
  },
  {
    id: 'mcp-github',
    name: 'GitHub Server',
    description: 'Access repositories, pull requests, issue tracking, and code commits.',
    iconName: 'Github',
    category: 'developer',
    status: 'connected',
    transport: 'OAuth 2.1',
    endpoint: 'https://mcp.github.com/v1',
    tools: [
      { id: 'gh_create_issue', name: 'create_issue', description: 'Create a new issue in a target repository', autoApprove: false },
      { id: 'gh_list_prs', name: 'list_pull_requests', description: 'List open PRs with CI status', autoApprove: true },
      { id: 'gh_post_comment', name: 'post_pr_comment', description: 'Post review comment on a pull request', autoApprove: false }
    ]
  },
  {
    id: 'mcp-filesystem',
    name: 'Local Workspace File System',
    description: 'Direct reading and writing of project files, briefs, and code diffs.',
    iconName: 'Folder',
    category: 'developer',
    status: 'connected',
    transport: 'Local Stdio',
    endpoint: 'stdio://ergo-fs-bridge',
    tools: [
      { id: 'fs_read_file', name: 'read_file', description: 'Read file contents from local workspace', autoApprove: true },
      { id: 'fs_write_file', name: 'write_file', description: 'Write or modify code/text file', autoApprove: false },
      { id: 'fs_git_diff', name: 'git_diff', description: 'Generate unified git diff of unstaged changes', autoApprove: true }
    ]
  },
  {
    id: 'mcp-bluebeam',
    name: 'Bluebeam & PDF Takeoff Bridge',
    description: 'Interact with PDF plan sheets, Revu markups, and appearance streams.',
    iconName: 'FileText',
    category: 'productivity',
    status: 'connected',
    transport: 'SSE',
    endpoint: 'https://mcp.ergo-takeoff.io/sse',
    tools: [
      { id: 'bb_extract_schedules', name: 'extract_schedules', description: 'Extract schedule tables from PDF vector text layer', autoApprove: true },
      { id: 'bb_apply_count', name: 'apply_count_markups', description: 'Apply count symbols with /AP streams to PDF', autoApprove: false },
      { id: 'bb_overlay_compare', name: 'overlay_revision_compare', description: 'Compare revision addendum layers on plan sheet', autoApprove: true }
    ]
  },
  {
    id: 'mcp-slack',
    name: 'Slack Workspace',
    description: 'Send channel broadcasts, draft messages, and post automated status digests.',
    iconName: 'MessageSquare',
    category: 'productivity',
    status: 'connected',
    transport: 'OAuth 2.1',
    endpoint: 'https://mcp.slack.com/sse',
    tools: [
      { id: 'slack_send_msg', name: 'send_channel_message', description: 'Send message to Slack channel', autoApprove: false },
      { id: 'slack_draft', name: 'render_message_composer', description: 'Render interactive message composer widget', autoApprove: true }
    ]
  },
  {
    id: 'mcp-gdrive',
    name: 'Google Workspace & Drive',
    description: 'Create Google Docs, export XLSX spreadsheets, and organize launch folders.',
    iconName: 'HardDrive',
    category: 'productivity',
    status: 'connected',
    transport: 'OAuth 2.1',
    endpoint: 'https://mcp.google.com/drive/v1',
    tools: [
      { id: 'gdrive_create_sheet', name: 'create_spreadsheet', description: 'Export quantity schedule to Google Sheets', autoApprove: false },
      { id: 'gdrive_search', name: 'search_files', description: 'Search launch assets in Google Drive', autoApprove: true }
    ]
  },
  {
    id: 'mcp-figma',
    name: 'Figma Design Tokens',
    description: 'Extract design tokens, UI component frames, and export WebP image assets.',
    iconName: 'Figma',
    category: 'design',
    status: 'disconnected',
    transport: 'OAuth 2.1',
    endpoint: 'https://mcp.figma.com/v1',
    tools: [
      { id: 'figma_get_tokens', name: 'get_design_tokens', description: 'Fetch HSL color palettes and font variables', autoApprove: true },
      { id: 'figma_render_canvas', name: 'render_interactive_canvas', description: 'Render editable Figma canvas widget', autoApprove: true }
    ]
  },
  {
    id: 'mcp-amplitude',
    name: 'Amplitude Analytics',
    description: 'Query event funnels, cohort retentions, and render product metrics charts.',
    iconName: 'BarChart2',
    category: 'analytics',
    status: 'disconnected',
    transport: 'OAuth 2.1',
    endpoint: 'https://mcp.amplitude.com/v1',
    tools: [
      { id: 'amp_query_funnel', name: 'query_conversion_funnel', description: 'Query conversion funnel data', autoApprove: true },
      { id: 'amp_render_chart', name: 'render_analytics_chart', description: 'Render interactive metric chart widget', autoApprove: true }
    ]
  },
  {
    id: 'mcp-database',
    name: 'Neon & Supabase Database',
    description: 'Execute SQL queries, inspect tables, and apply database migrations.',
    iconName: 'Database',
    category: 'database',
    status: 'connected',
    transport: 'SSE',
    endpoint: 'https://mcp.neon.tech/sse',
    tools: [
      { id: 'db_run_query', name: 'run_sql_query', description: 'Execute read SQL query against Neon DB', autoApprove: true },
      { id: 'db_apply_migration', name: 'apply_schema_migration', description: 'Apply database DDL migration file', autoApprove: false }
    ]
  }
];
