import { type ProjectData, type MCPServer } from '../types';

export const DEMO_PROJECTS: ProjectData[] = [
  {
    id: 'ergo-takeoff-demo',
    name: 'Ergo Takeoff Engine (Beta)',
    description: 'AI-assisted plan takeoff and quantity extraction system with Bluebeam PDF integration & OCR cascade.',
    connectedMcps: ['mcp-vscode', 'mcp-filesystem', 'mcp-bluebeam', 'mcp-database', 'mcp-gdrive'],
    todoMarkdown: `<!-- Keep this file scannable. Full briefs, build records and test notes live in AGENT_CONTEXT.md, keyed by item number. -->

# Major TODOs for beta:
- ~~zones~~
- ~~dropbox/g-drive import/export~~
- ~~export page data~~
- 1. **conditions:**
    - search feature in schedules panel (filter the tree as you type — condition name/tag, group, schedule)
    - **human review** - verify the various condition details work correctly: assemblies, slope calc, QTY (all types), grid
- ~~comparisons between revisions~~

## Missing features todos:

2. ~~**AI features:**~~
    - ~~dismissing an AI suggestion should keep it in the AI panel; toggle back on again~~
    - **schedules:**
        - the schedules auto-extractor never dismisses, even after schedules are applied
    - **scale-finder:**
        - verify scale reader on high DPI raster title blocks
    - **title/sheet name:**
        - auto-detect sheet numbers and title block labels via local OCR cascade

3. **UI:**
    - all buttons need a keyboard shortcut
    - dropbox icon isn't rendering correctly - fix SVG outline path
    - cursor needs to be set when hovering over AI toast notifications
    - AI toast notifications should always be the highest level z-index
    - move 'switch plan file' dropdown to lower beside the 'sheets' button
    - make the 'rendering sheet...' text more obvious

4. **zones/breakouts:**
    - **human review** - verify zone calculations across multi-page PDFs

5. **MCP Access:**
    - Make sure the takeoff MCP has complete access to do anything within the tool

6. **Import/Export:**
    - ~~per-section subtotal row; a second XLSX sheet per zone; column choice into the Bluebeam legend~~
    - ~~remove the worksheet (the legend sheet) from the PDF export (unnecessary)~~
    - ~~add a callouts toggle to the export screen (off by default)~~
    - **human review** — open the Bluebeam export in Revu: shape opacity + count symbols on the sheet

7. **Performance & Storage:**
    - see if we can reduce the amount of space in-progress takeoffs take up in localStorage

8. **Cloud Database:**
    - in-progress takeoffs need to write to Neon DB so data isn't lost if browser is cleared

# Later Features:

9. **Direct connections to other services:**
    - Export to G-drive / Dropbox (creating folder structure based on project name found in Monday)
    - Quick-access button to open the folder directly

10. **AI 'chat with my takeoff' feature:**
    - should be able to answer questions about the takeoff data, the project, and the takeoff itself
    - should be able to do anything with the takeoff based on the user's prompts
    - should always follow up by telling the user what it found / intends to change`,
    agentContextMarkdown: `# TODO context — the verbose half of \`TODO.md\`

### 1. conditions

**Status:** in progress

**Brief**
The panel is the app's only conditions surface and on a real job its tree runs to hundreds of rows, so finding one condition means scrolling. What exists today is NOT incremental filter. The ask is an in-panel incremental filter: type in a search box in the panel and the tree shrinks to matching rows as you type.

- Match on: condition name and tag (condTitle in lib/schedules.js), plus group and schedule names.
- Where it lives: a filter input in the panel bar next to + New.
- Filtering seam: filter the built node node list (pure helper in lib/schedules.js).

**Built**
First pass done (seven sub-bullets); second pass — panel UX — done.

**Validation**
npm test 356 pass. Driven by hand in headless Chromium over CDP.

---

### 2. AI features

**Status:** done

**Brief**
The cascade is the spine of this pass. Every plan read now runs raw text → local OCR (tesseract.js, in-browser) → vision AI → graceful fail.
- Done = (1) dismissing AI suggestion keeps it in panel; (2) schedule name defaults from sheet title; (3) confirm bar is a toast; (4) OCR in flight spins AI button; (5) title/sheet name reader runs first of automatic actions.

**Built**
Three new modules: lib/ocr.js (tesseract worker), lib/ocrgate.js (quality gate), lib/titleblock.js (field reader). Local OCR bundled via WASM.

**Validation**
npm test 401 pass (45 new tests). End-to-end verified on ARCH-D title block PDF.

---

### 3. UI

**Status:** not started

**Brief**
Fix keyboard shortcuts, cursor hit-testing on floating toast notifications, Dropbox SVG path outlines, and z-index ordering so notifications don't sit under sidebar buttons.

---

### 5. MCP Access

**Status:** in progress

**Brief**
Provide a full Model Context Protocol (MCP) tool surface over the takeoff state so external AI agents can execute arbitrary actions: adding conditions, selecting shapes, adjusting scale factors, running compares, and triggering exports.

---

### 6. Import/Export

**Status:** done

**Brief**
Second pass — the table, paper, and Bluebeam channel. Fixed Bluebeam count export (/AP appearance streams) and transparency (/FillOpacity 0.16 wash). Added XLSX multi-tab zone exports.

**Built**
New modules lib/exportpaint.js, lib/reportcols.js, lib/xlsx.js.

**Validation**
Validated against 41 MB real Revu export in pdf.js and CDP headless browser.

---

### 10. AI 'chat with my takeoff' feature

**Status:** not started

**Brief**
Interactive conversational mode inside Ergo allowing the AI to read the active takeoff's geometry, answer pricing questions, and modify shapes/conditions directly via the takeoff MCP server.`
  },
  {
    id: 'q3-marketing-campaign',
    name: 'Q3 Product Marketing Launch',
    description: 'Non-developer administrative and creative workflow utilizing Amplitude analytics, Figma assets, and Slack team dispatch.',
    connectedMcps: ['mcp-slack', 'mcp-figma', 'mcp-amplitude', 'mcp-gdrive'],
    todoMarkdown: `# Q3 Launch Deliverables:

1. **Analyze Signup Conversion Drop:**
    - Query Amplitude MCP for user dropoff funnel between step 2 and step 3
    - **human review** - verify date range filters and segment cohorts

2. **Figma Hero Banner Refresh:**
    - Generate dark-mode variant mockups for homepage hero
    - Export 2x WebP assets directly to Google Drive launch folder

3. **Team Dispatch & Announcement Draft:**
    - Draft executive summary of campaign KPIs
    - Render interactive Slack message composer in execution window`,
    agentContextMarkdown: `### 1. Analyze Signup Conversion Drop

**Status:** in progress

**Brief**
Perform detailed funnel analysis on 2026 Q2 signup dropoff. Identify friction points in multi-factor auth step.

**Built**
Connected Amplitude MCP server via OAuth 2.1 PKCE transport.

---

### 2. Figma Hero Banner Refresh

**Status:** not started

**Brief**
Pull modern dark-mode glassmorphism design tokens from Figma file #84920 and generate banner variants.

---

### 3. Team Dispatch & Announcement Draft

**Status:** not started

**Brief**
Compose campaign update for #product-announcements. Allow human review before posting via Slack MCP.`
  },
  {
    id: 'nextjs-saas-refactor',
    name: 'Next.js SaaS Platform Refactor',
    description: 'Developer workflow for database migrations, GitHub PR management, and automated test execution.',
    connectedMcps: ['mcp-github', 'mcp-filesystem', 'mcp-database'],
    todoMarkdown: `# Engineering Sprint Tasks:

1. **Database Schema Migration (Supabase):**
    - Add user_preferences JSONB column to workspace table
    - Write idempotent SQL migration script

2. **Refactor Auth Middleware:**
    - Upgrade session validation to OAuth 2.1 PKCE
    - **human review** - test security edge cases with expired tokens

3. **Automated E2E Test Pipeline:**
    - Execute Playwright headless test suite on main branch
    - Post test status digest to GitHub PR #142`,
    agentContextMarkdown: `### 1. Database Schema Migration (Supabase)

**Status:** not started

**Brief**
Write migration file 20260811_user_prefs.sql and apply to Neon/Supabase DB instance via Database MCP.

---

### 2. Refactor Auth Middleware

**Status:** not started

**Brief**
Replace legacy bearer token checks with PKCE auth header validator in middleware.ts.

---

### 3. Automated E2E Test Pipeline

**Status:** not started

**Brief**
Run npx playwright test over e2e/auth.spec.ts and attach screenshot artifacts to GitHub PR.`
  }
];

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
