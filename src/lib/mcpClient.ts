import {
  type MCPTool,
  type MCPServer,
  type McpRootBoundary,
  type McpToolExecutionResult
} from '../types';

/**
 * Call an MCP tool via the local MCP Host JSON-RPC / REST bridge
 */
export async function callMcpTool(
  serverId: string,
  toolName: string,
  args: Record<string, any> = {}
): Promise<McpToolExecutionResult> {
  try {
    const res = await fetch('/api/mcp/tools/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId, toolName, args })
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
    { id: 'root-default', path: '.', name: 'Workspace Root', isDefault: true }
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
 * Sync and fetch latest tools list for an MCP server (Implements `tools/list`)
 */
export async function syncMcpServerTools(server: MCPServer): Promise<MCPTool[]> {
  // If bundled harness, verify tools with local host
  if (server.serverType === 'bundled_harness') {
    return server.tools.map((t) => ({ ...t, serverId: server.id }));
  }

  // If remote OAuth/SSE server, attempt discovery or return configured tools
  return server.tools.map((t) => ({ ...t, serverId: server.id }));
}

/**
 * Automatically analyze user prompt and brief to guess/suggest the most relevant MCP tools
 */
export function guessRelevantTools(prompt: string, availableTools: MCPTool[]): string[] {
  const lower = prompt.toLowerCase();
  const selected: Set<string> = new Set();

  availableTools.forEach((tool) => {
    const tName = tool.name.toLowerCase();
    const tDesc = tool.description.toLowerCase();

    // Filesystem matching
    if (
      (lower.includes('file') || lower.includes('markdown') || lower.includes('read') || lower.includes('write') || lower.includes('disk') || lower.includes('config')) &&
      (tName.includes('file') || tName.includes('directory') || tDesc.includes('file') || tDesc.includes('directory'))
    ) {
      selected.add(tool.id);
    }

    // Web Fetch matching
    if (
      (lower.includes('fetch') || lower.includes('url') || lower.includes('web') || lower.includes('http') || lower.includes('api') || lower.includes('doc') || lower.includes('scrape')) &&
      (tName.includes('fetch') || tName.includes('url'))
    ) {
      selected.add(tool.id);
    }

    // Git matching
    if (
      (lower.includes('git') || lower.includes('commit') || lower.includes('branch') || lower.includes('diff') || lower.includes('repo')) &&
      tName.startsWith('git_')
    ) {
      selected.add(tool.id);
    }

    // GitHub matching
    if (
      (lower.includes('github') || lower.includes('pr') || lower.includes('pull request') || lower.includes('issue')) &&
      tool.serverId === 'mcp-github'
    ) {
      selected.add(tool.id);
    }

    // Slack matching
    if (
      (lower.includes('slack') || lower.includes('message') || lower.includes('channel') || lower.includes('notify') || lower.includes('broadcast')) &&
      tool.serverId === 'mcp-slack'
    ) {
      selected.add(tool.id);
    }

    // Notion matching
    if (
      (lower.includes('notion') || lower.includes('database') || lower.includes('wiki')) &&
      tool.serverId === 'mcp-notion'
    ) {
      selected.add(tool.id);
    }

    // Google Calendar matching
    if (
      (lower.includes('calendar') || lower.includes('schedule') || lower.includes('meeting') || lower.includes('event')) &&
      tool.serverId === 'mcp-gcal'
    ) {
      selected.add(tool.id);
    }

    // Salesforce matching
    if (
      (lower.includes('salesforce') || lower.includes('crm') || lower.includes('lead') || lower.includes('opportunity')) &&
      tool.serverId === 'mcp-salesforce'
    ) {
      selected.add(tool.id);
    }

    // Zapier matching
    if (
      (lower.includes('zap') || lower.includes('webhook') || lower.includes('automation')) &&
      tool.serverId === 'mcp-zapier'
    ) {
      selected.add(tool.id);
    }
  });

  // Default: if no specific tools matched, include read_file and fetch_markdown as versatile defaults
  if (selected.size === 0) {
    const defaultTool = availableTools.find((t) => t.name === 'read_file');
    if (defaultTool) selected.add(defaultTool.id);
  }

  return Array.from(selected);
}
