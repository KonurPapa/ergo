import {
  type MCPTool,
  type MCPServer,
  type McpRootBoundary,
  type McpToolExecutionResult
} from '../types';
import { executeWorkspaceToolAction } from './workspaceMcp';

/**
 * Call an MCP tool via the local MCP Host JSON-RPC / REST bridge
 */
export async function callMcpTool(
  serverId: string,
  toolName: string,
  args: Record<string, any> = {},
  options?: { endpoint?: string; authHeader?: string }
): Promise<McpToolExecutionResult> {
  // Direct execution for Ergo Workspace MCP tools
  if (serverId === 'mcp-ergo-workspace' || toolName.startsWith('workspace_')) {
    return executeWorkspaceToolAction(toolName, args);
  }
  try {
    const res = await fetch('/api/mcp/tools/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serverId,
        toolName,
        args,
        endpoint: options?.endpoint,
        authHeader: options?.authHeader
      })
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      return {
        success: false,
        error: errData.error || `MCP tool call failed with HTTP ${res.status}`
      };
    }

    const data = await res.json();
    return {
      success: true,
      data: data.data || data
    };
  } catch (err: any) {
    console.warn(`[MCP Client] Error calling ${serverId}/${toolName}:`, err);
    return {
      success: false,
      error: err?.message || 'Network error executing MCP tool'
    };
  }
}

/**
 * Open a created file or document in the user's IDE or system viewer
 */
export async function openFileInIdeOrSystem(
  filePath: string,
  line?: number
): Promise<{ success: boolean; opened?: boolean; methodUsed?: string; resolvedPath?: string; error?: string }> {
  try {
    const res = await fetch('/api/files/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath, line, openInIde: true })
    });
    const data = await res.json();
    return data;
  } catch (err: any) {
    console.warn(`[Ergo Client] Error opening ${filePath}:`, err);
    return {
      success: false,
      error: err?.message || 'Network error opening file'
    };
  }
}

/**
 * Query safe directory roots from the MCP Host
 */
export async function getAllowedRoots(): Promise<McpRootBoundary[]> {
  try {
    const res = await fetch('/api/mcp/roots');
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.roots)) return data.roots;
    }
  } catch {}

  const saved = localStorage.getItem('ergo_mcp_roots');
  if (saved) {
    try {
      return JSON.parse(saved);
    } catch {}
  }

  return [
    { id: 'root-default', path: '~/.ergo', name: 'Default Storage (~/.ergo)', isDefault: true }
  ];
}

/**
 * Save updated directory roots
 */
export async function saveAllowedRoots(roots: McpRootBoundary[]): Promise<boolean> {
  try {
    localStorage.setItem('ergo_mcp_roots', JSON.stringify(roots));
    const res = await fetch('/api/mcp/roots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roots })
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Add a new allowed root folder boundary
 */
export async function addAllowedRoot(rootPath: string, name?: string): Promise<McpRootBoundary[]> {
  const current = await getAllowedRoots();
  const trimmed = rootPath.trim();
  if (!trimmed) return current;

  const exists = current.some((r) => r.path === trimmed);
  if (exists) return current;

  const newRoot: McpRootBoundary = {
    id: `root-${Date.now()}`,
    path: trimmed,
    name: name || trimmed.split('/').filter(Boolean).pop() || 'Folder',
    isDefault: false,
    addedAt: new Date().toISOString()
  };

  const next = [...current, newRoot];
  await saveAllowedRoots(next);
  return next;
}

/**
 * Remove an allowed root folder boundary
 */
export async function removeAllowedRoot(id: string): Promise<McpRootBoundary[]> {
  const current = await getAllowedRoots();
  const next = current.filter((r) => r.id !== id || r.isDefault);
  await saveAllowedRoots(next);
  return next;
}

/**
 * Connect to an MCP endpoint (or check status) and discover tools via tools/list
 */
export async function discoverRemoteMcpTools(
  endpoint: string,
  authHeader?: string
): Promise<{
  success: boolean;
  serverInfo?: { name: string; version?: string };
  tools: MCPTool[];
  error?: string;
  authRequired?: boolean;
}> {
  try {
    const res = await fetch('/api/mcp/remote/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint, authHeader })
    });

    const data = await res.json();
    if (!res.ok) {
      return {
        success: false,
        tools: [],
        error: data.error || `Discovery failed with status ${res.status}`,
        authRequired: Boolean(data.authRequired)
      };
    }

    const discoveredTools: MCPTool[] = (data.tools || []).map((t: any, idx: number) => ({
      id: t.name ? `tool-${t.name}-${idx}` : `tool-${idx}`,
      name: t.name || `tool_${idx}`,
      description: t.description || 'Remote MCP Tool',
      autoApprove: false,
      inputSchema: t.inputSchema || t.schema || undefined
    }));

    return {
      success: true,
      serverInfo: data.serverInfo,
      tools: discoveredTools
    };
  } catch (err: any) {
    return {
      success: false,
      tools: [],
      error: err?.message || 'Network error reaching MCP endpoint'
    };
  }
}

/**
 * Sync and fetch latest tools list for an MCP server (Implements `tools/list`)
 */
export async function syncMcpServerTools(server: MCPServer): Promise<MCPTool[]> {
  try {
    const res = await fetch('/api/mcp/tools/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serverId: server.id,
        endpoint: server.endpoint,
        authHeader: server.authHeader
      })
    });

    if (res.ok) {
      const data = await res.json();
      if (data.success && Array.isArray(data.tools) && data.tools.length > 0) {
        return data.tools.map((t: any) => ({
          ...t,
          serverId: server.id,
          autoApprove: server.tools.find((existing) => existing.name === t.name)?.autoApprove ?? Boolean(t.autoApprove)
        }));
      }
    }
  } catch (e) {
    console.warn(`[MCP Client] Error calling tools/list for ${server.name} (${server.id}):`, e);
  }

  // Fallback to remote discovery if endpoint is present
  if (server.endpoint && (server.endpoint.startsWith('http://') || server.endpoint.startsWith('https://'))) {
    const disc = await discoverRemoteMcpTools(server.endpoint, server.authHeader);
    if (disc.success && disc.tools.length > 0) {
      return disc.tools.map((t) => ({
        ...t,
        serverId: server.id,
        autoApprove: server.tools.find((existing) => existing.name === t.name)?.autoApprove ?? t.autoApprove
      }));
    }
  }

  return server.tools.map((t) => ({ ...t, serverId: server.id }));
}

export interface McpServerUpdateDiff {
  serverId: string;
  serverName: string;
  hasChanges: boolean;
  addedTools: string[];
  removedTools: string[];
  totalTools: number;
  error?: string;
}

export interface McpCheckUpdatesResult {
  updatedServers: MCPServer[];
  hasChanges: boolean;
  changes: McpServerUpdateDiff[];
  summaryMessage?: string;
}

/**
 * Routinely check for updates across all connected MCP servers by invoking `tools/list`.
 * Detects new tools, removed tools, and schema updates so the AI and user stay up-to-date.
 */
export async function checkAllMcpUpdates(servers: MCPServer[]): Promise<McpCheckUpdatesResult> {
  const connected = servers.filter((s) => s.status === 'connected');
  if (connected.length === 0) {
    return { updatedServers: servers, hasChanges: false, changes: [] };
  }

  const payload = connected.map((s) => ({
    id: s.id,
    endpoint: s.endpoint,
    authHeader: s.authHeader,
    toolsCount: s.tools.length
  }));

  let serverResults: Record<string, { success: boolean; tools: any[]; hasChanges?: boolean; error?: string }> = {};

  try {
    const res = await fetch('/api/mcp/check-updates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ servers: payload })
    });
    if (res.ok) {
      const data = await res.json();
      if (data.updates) serverResults = data.updates;
    }
  } catch (err) {
    console.warn('[MCP Client] /api/mcp/check-updates request failed, falling back to sequential sync:', err);
  }

  const diffs: McpServerUpdateDiff[] = [];
  let anyChange = false;

  const nextServers = await Promise.all(
    servers.map(async (server) => {
      if (server.status !== 'connected') return server;

      let freshTools: MCPTool[] | null = null;
      const apiResult = serverResults[server.id];

      if (apiResult && apiResult.success && Array.isArray(apiResult.tools)) {
        freshTools = apiResult.tools.map((t: any) => ({
          ...t,
          serverId: server.id,
          autoApprove: server.tools.find((e) => e.name === t.name)?.autoApprove ?? Boolean(t.autoApprove)
        }));
      } else {
        // Fallback to direct sync
        try {
          freshTools = await syncMcpServerTools(server);
        } catch {}
      }

      if (!freshTools || freshTools.length === 0) return server;

      const oldNames = new Set(server.tools.map((t) => t.name));
      const newNames = new Set(freshTools.map((t) => t.name));

      const added = freshTools.filter((t) => !oldNames.has(t.name)).map((t) => t.name);
      const removed = server.tools.filter((t) => !newNames.has(t.name)).map((t) => t.name);
      const hasDiff = added.length > 0 || removed.length > 0;

      if (hasDiff) {
        anyChange = true;
        diffs.push({
          serverId: server.id,
          serverName: server.name,
          hasChanges: true,
          addedTools: added,
          removedTools: removed,
          totalTools: freshTools.length
        });
        return {
          ...server,
          tools: freshTools,
          lastSyncedAt: new Date().toISOString()
        };
      }

      return {
        ...server,
        lastSyncedAt: new Date().toISOString()
      };
    })
  );

  let summaryMessage: string | undefined;
  if (anyChange) {
    const summaryParts = diffs.map((d) => {
      const addedDesc = d.addedTools.length > 0 ? `+${d.addedTools.length} new tools (${d.addedTools.slice(0, 2).join(', ')}${d.addedTools.length > 2 ? '…' : ''})` : '';
      const remDesc = d.removedTools.length > 0 ? `-${d.removedTools.length} removed` : '';
      return `${d.serverName}: ${[addedDesc, remDesc].filter(Boolean).join(', ')}`;
    });
    summaryMessage = `MCP updates discovered: ${summaryParts.join(' • ')}`;
  }

  return {
    updatedServers: nextServers,
    hasChanges: anyChange,
    changes: diffs,
    summaryMessage
  };
}

/**
 * Starts a background routine update checker for connected MCP servers.
 * Periodically calls `tools/list` on all connected servers to guarantee the AI and user
 * always have the latest tools. Returns an unsubscribe/cleanup function.
 */
export function startMcpRoutineUpdateChecker(
  getServers: () => MCPServer[],
  onUpdate: (result: McpCheckUpdatesResult) => void,
  intervalMs = 60000
): () => void {
  let isChecking = false;

  const runCheck = async () => {
    if (isChecking) return;
    isChecking = true;
    try {
      const current = getServers();
      const hasConnected = current.some((s) => s.status === 'connected');
      if (hasConnected) {
        const result = await checkAllMcpUpdates(current);
        if (result.hasChanges) {
          onUpdate(result);
        }
      }
    } catch (e) {
      console.warn('[MCP Routine Checker] Error checking MCP updates:', e);
    } finally {
      isChecking = false;
    }
  };

  // Run on window focus / app return
  const onFocus = () => {
    runCheck();
  };
  window.addEventListener('focus', onFocus);

  // Routine interval timer
  const timer = setInterval(runCheck, intervalMs);

  return () => {
    clearInterval(timer);
    window.removeEventListener('focus', onFocus);
  };
}

/**
 * Universal connect and authentication helper for any MCP server.
 * Handles credential verification, triggers `tools/list`, and stores discovered tools.
 */
export async function authenticateAndConnectMcp(
  server: MCPServer,
  options: { endpoint?: string; authHeader?: string } = {}
): Promise<{ success: boolean; updatedServer?: MCPServer; error?: string }> {
  try {
    const endpoint = options.endpoint || server.endpoint;
    const authHeader = options.authHeader || server.authHeader;

    const res = await fetch('/api/mcp/auth/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serverId: server.id,
        serverName: server.name,
        endpoint,
        authHeader
      })
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      return {
        success: false,
        error: data.error || `Authentication failed (HTTP ${res.status})`
      };
    }

    const discoveredTools: MCPTool[] = (data.tools || []).map((t: any, idx: number) => ({
      id: t.id || `${server.id}_${t.name || idx}`,
      name: t.name || `tool_${idx}`,
      description: t.description || 'MCP Tool',
      autoApprove: server.tools.find((e) => e.name === t.name)?.autoApprove ?? Boolean(t.autoApprove),
      serverId: server.id,
      inputSchema: t.inputSchema || t.schema
    }));

    const updatedServer: MCPServer = {
      ...server,
      status: 'connected',
      endpoint: endpoint || server.endpoint,
      authHeader: authHeader || server.authHeader,
      authUsername: data.user?.login || server.authUsername,
      lastSyncedAt: new Date().toISOString(),
      tools: discoveredTools.length > 0 ? discoveredTools : server.tools,
      error: undefined
    };

    return {
      success: true,
      updatedServer
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Network error authenticating MCP server'
    };
  }
}

export interface RelevantToolAnalysis {
  selectedToolIds: string[];
  reasons: Record<string, string>;
  isAmbiguous: boolean;
  clarificationMessage?: string;
}

/**
 * Automatically analyze user prompt, task title, and brief to guess/suggest the most relevant MCP tools,
 * returning both the selected IDs and human-readable reasoning for each choice.
 */
export function guessRelevantToolsWithDetails(
  prompt: string,
  availableTools: MCPTool[],
  briefText?: string
): RelevantToolAnalysis {
  const combined = `${prompt} ${briefText || ''}`.toLowerCase();
  const selected: Set<string> = new Set();
  const reasons: Record<string, string> = {};

  availableTools.forEach((tool) => {
    const tName = tool.name.toLowerCase();
    const tDesc = (tool.description || '').toLowerCase();

    // 1. Filesystem reading & editing
    if (
      (combined.includes('file') || combined.includes('read') || combined.includes('view') || combined.includes('inspect') || combined.includes('find') || combined.includes('search')) &&
      (tName === 'read_file' || tName === 'search_files' || tName === 'get_file_info' || tName === 'list_directory')
    ) {
      selected.add(tool.id);
      reasons[tool.id] = 'Relevant for inspecting files and directory structure mentioned in the task.';
    }

    if (
      (combined.includes('write') || combined.includes('create file') || combined.includes('edit') || combined.includes('refactor') || combined.includes('code') || combined.includes('implement') || combined.includes('fix') || combined.includes('update file')) &&
      (tName === 'write_file' || tName === 'edit_file' || tName === 'create_directory')
    ) {
      selected.add(tool.id);
      reasons[tool.id] = 'Relevant for creating or modifying files for this task.';
    }

    // 2. Shell / Command execution
    if (
      (combined.includes('terminal') || combined.includes('shell') || combined.includes('command') || combined.includes('run') || combined.includes('test') || combined.includes('script') || combined.includes('npm') || combined.includes('build') || combined.includes('compile') || combined.includes('lint')) &&
      tName === 'run_command'
    ) {
      selected.add(tool.id);
      reasons[tool.id] = 'Relevant for running tests, build commands, or shell scripts.';
    }

    // 3. Web Fetch
    if (
      (combined.includes('fetch') || combined.includes('url') || combined.includes('web') || combined.includes('http') || combined.includes('api') || combined.includes('doc') || combined.includes('scrape') || combined.includes('download')) &&
      (tName === 'fetch_markdown' || tName === 'fetch_url')
    ) {
      selected.add(tool.id);
      reasons[tool.id] = 'Relevant for fetching documentation, web URLs, or external API responses.';
    }

    // 4. Git Version Control
    if (
      (combined.includes('git') || combined.includes('commit') || combined.includes('branch') || combined.includes('diff') || combined.includes('repo') || combined.includes('repository')) &&
      tName.startsWith('git_')
    ) {
      selected.add(tool.id);
      reasons[tool.id] = 'Relevant for version control, commit inspection, or repo diffs.';
    }

    // 5. GitHub MCP Tools (Fine-grained)
    if (tool.serverId === 'mcp-github' || tName.startsWith('gh_')) {
      if ((combined.includes('issue') || combined.includes('bug report')) && (tName.includes('issue'))) {
        selected.add(tool.id);
        reasons[tool.id] = 'Directly matches issue management mentioned in the task.';
      }
      if ((combined.includes('pr') || combined.includes('pull request') || combined.includes('review') || combined.includes('merge')) && (tName.includes('pull_request') || tName.includes('pr'))) {
        selected.add(tool.id);
        reasons[tool.id] = 'Directly matches pull request review or creation.';
      }
      if ((combined.includes('repo') || combined.includes('github') || combined.includes('clone') || combined.includes('push')) && (tName.includes('push') || tName.includes('repository') || tName.includes('branch') || tName.includes('commit'))) {
        selected.add(tool.id);
        reasons[tool.id] = 'Relevant for GitHub repository and branch operations.';
      }
      if ((combined.includes('search') || combined.includes('codebase')) && (tName.includes('search_code') || tName.includes('search_repositories'))) {
        selected.add(tool.id);
        reasons[tool.id] = 'Relevant for searching GitHub repositories and code.';
      }
    }

    // 6. Slack
    if (
      (combined.includes('slack') || combined.includes('channel') || combined.includes('message') || combined.includes('notify team') || combined.includes('broadcast')) &&
      tool.serverId === 'mcp-slack'
    ) {
      selected.add(tool.id);
      reasons[tool.id] = 'Relevant for team messaging or Slack channel notifications.';
    }

    // 7. Google Calendar
    if (
      (combined.includes('calendar') || combined.includes('meeting') || combined.includes('schedule') || combined.includes('invite') || combined.includes('availability')) &&
      tool.serverId === 'mcp-gcal'
    ) {
      selected.add(tool.id);
      reasons[tool.id] = 'Relevant for calendar event management and scheduling.';
    }

    // 8. Notion
    if (
      (combined.includes('notion') || combined.includes('wiki') || combined.includes('database page') || combined.includes('notes')) &&
      tool.serverId === 'mcp-notion'
    ) {
      selected.add(tool.id);
      reasons[tool.id] = 'Relevant for Notion documentation and database pages.';
    }

    // 9. Salesforce
    if (
      (combined.includes('salesforce') || combined.includes('crm') || combined.includes('lead') || combined.includes('opportunity') || combined.includes('account')) &&
      tool.serverId === 'mcp-salesforce'
    ) {
      selected.add(tool.id);
      reasons[tool.id] = 'Relevant for Salesforce CRM records.';
    }

    // 10. Laya Local Decisions
    if (
      (combined.includes('classify') || combined.includes('triage') || combined.includes('score') || combined.includes('evaluate') || combined.includes('fast decision')) &&
      tool.serverId === 'mcp-laya'
    ) {
      selected.add(tool.id);
      reasons[tool.id] = 'Local System-1 micro-decision evaluation.';
    }

    // Generic match on custom MCP tool name keyword overlap
    const words = tName.split(/[_\s-]+/).concat(tDesc.split(/[_\s-]+/)).filter((w) => w.length >= 4);
    for (const w of words) {
      if (combined.includes(w) && !selected.has(tool.id)) {
        selected.add(tool.id);
        reasons[tool.id] = `Matches keyword "${w}" in task prompt.`;
        break;
      }
    }
  });

  // Default: if no specific tools matched, include read_file as a safe baseline
  if (selected.size === 0) {
    const defaultTool = availableTools.find((t) => t.name === 'read_file');
    if (defaultTool) {
      selected.add(defaultTool.id);
      reasons[defaultTool.id] = 'Safe default tool for reading workspace context.';
    }
  }

  // Detect ambiguity: prompt is very short or vague but multiple disconnected domains matched
  const isAmbiguous = prompt.trim().split(/\s+/).length < 3 && selected.size > 4;
  const clarificationMessage = isAmbiguous
    ? `Task description is concise. Auto-suggested ${selected.size} tools across active MCPs. You can refine or toggle specific tools below.`
    : undefined;

  return {
    selectedToolIds: Array.from(selected),
    reasons,
    isAmbiguous,
    clarificationMessage
  };
}

/**
 * Backward-compatible helper returning string array of tool IDs.
 */
export function guessRelevantTools(prompt: string, availableTools: MCPTool[], briefText?: string): string[] {
  return guessRelevantToolsWithDetails(prompt, availableTools, briefText).selectedToolIds;
}

export interface McpRuntimeConnection {
  serverId: string;
  serverName: string;
  category: string;
  status: 'connected' | 'disconnected' | 'authenticating';
  transport: string;
  serverType: 'bundled_harness' | 'external_oauth';
  isDefault: boolean;
  tools: MCPTool[];
}

export interface McpRuntimeSummary {
  connectedServers: McpRuntimeConnection[];
  availableTools: MCPTool[];
  allowedRoots: McpRootBoundary[];
  totalConnectedServers: number;
  totalAvailableTools: number;
}

/**
 * Returns a straightforward array of all active connected MCP servers and their tools.
 * Bundled harnesses (Filesystem, Fetch, Git) are always marked as default connections.
 */
export function getAvailableConnections(mcpServers: MCPServer[]): McpRuntimeConnection[] {
  return mcpServers
    .filter((s) => s.status === 'connected')
    .map((s) => ({
      serverId: s.id,
      serverName: s.name,
      category: s.category,
      status: s.status,
      transport: s.transport,
      serverType: s.serverType || (s.transport === 'Local Stdio' ? 'bundled_harness' : 'external_oauth'),
      isDefault: s.serverType === 'bundled_harness' || s.transport === 'Local Stdio',
      tools: s.tools.map((t) => ({ ...t, serverId: s.id }))
    }));
}

/**
 * Returns a straightforward flat array of all tools available at runtime from connected MCP servers.
 */
export function getAvailableTools(mcpServers: MCPServer[]): MCPTool[] {
  const tools: MCPTool[] = [];
  mcpServers
    .filter((s) => s.status === 'connected')
    .forEach((s) => {
      s.tools.forEach((t) => {
        tools.push({
          ...t,
          serverId: s.id
        });
      });
    });
  return tools;
}

/**
 * Returns a complete runtime summary containing active connections, available tools, and allowed folders.
 * Useful for runtime inspection, debugging, and passing state directly to agentic execution loops.
 */
export function getAllConnectionsSummary(
  mcpServers: MCPServer[],
  roots: McpRootBoundary[] = [{ id: 'root-default', path: '~/.ergo', name: 'Default Storage (~/.ergo)', isDefault: true }]
): McpRuntimeSummary {
  const connectedServers = getAvailableConnections(mcpServers);
  const availableTools = getAvailableTools(mcpServers);

  return {
    connectedServers,
    availableTools,
    allowedRoots: roots,
    totalConnectedServers: connectedServers.length,
    totalAvailableTools: availableTools.length
  };
}

/**
 * Formats all active connections, tools, and directory boundaries into a clear text prompt block
 * for the AI at runtime so it can determine which tool(s) to use.
 */
export function formatConnectionsForAiPrompt(
  mcpServers: MCPServer[],
  roots: McpRootBoundary[] = [{ id: 'root-default', path: '~/.ergo', name: 'Default Storage (~/.ergo)', isDefault: true }]
): string {
  const connected = getAvailableConnections(mcpServers);
  if (connected.length === 0) {
    return 'AVAILABLE TOOLS: None (All MCP connections currently inactive).';
  }

  const lines: string[] = ['AVAILABLE RUNTIME TOOLS & ACTIVE MCP CONNECTIONS:'];

  if (roots.length > 0) {
    lines.push(`ALLOWED DIRECTORY ROOTS (Filesystem Boundaries): ${roots.map((r) => `${r.name} (\`${r.path}\`)`).join(', ')}`);
  }

  connected.forEach((conn) => {
    lines.push(`\n- ${conn.serverName} [${conn.transport}] (${conn.isDefault ? 'Default Local Harness' : 'External App'}):`);
    conn.tools.forEach((tool) => {
      lines.push(`  * ${tool.name}: ${tool.description} (Auto-Approve: ${tool.autoApprove ? 'Yes' : 'Requires User Confirmation'})`);
    });
  });

  return lines.join('\n');
}

/**
 * Get GitHub MCP connection status and configured account
 */
export async function getGithubMcpStatus(): Promise<{
  configured: boolean;
  username?: string;
  name?: string;
  avatarUrl?: string;
  connectedAt?: string;
}> {
  try {
    const res = await fetch('/api/mcp/github/status');
    if (res.ok) {
      return await res.json();
    }
  } catch {}
  return { configured: false };
}

/**
 * Connect GitHub MCP with a Personal Access Token
 */
export async function connectGithubMcp(token: string): Promise<{
  success: boolean;
  user?: { login: string; name?: string; avatarUrl?: string };
  tools?: MCPTool[];
  error?: string;
}> {
  try {
    const res = await fetch('/api/mcp/github/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token.trim() })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      return {
        success: false,
        error: data.error || `GitHub connection failed (status ${res.status})`
      };
    }
    return {
      success: true,
      user: data.user,
      tools: data.tools
    };
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || 'Network error connecting to GitHub MCP'
    };
  }
}

/**
 * Disconnect GitHub MCP
 */
export async function disconnectGithubMcp(): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch('/api/mcp/github/disconnect', { method: 'POST' });
    const data = await res.json();
    return { success: Boolean(data?.success) };
  } catch (err: any) {
    return { success: false, error: err?.message };
  }
}

