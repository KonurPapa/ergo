/**
 * The user's MCP servers — connections, tool permissions (auto-approve), credentials such as auth headers — live on
 * their machine in <storage root>/config/mcp-servers.json (read and written through the bridge), next to the
 * secrets.json that holds their API keys. Ergo's bundled servers ship with the app; the file keeps the user's state for
 * them plus the servers they added.
 */
import type { MCPServer } from '../types';
import { readFilesFromDisk, writeFilesToDisk } from './fileSystem';
import { INITIAL_MCP_SERVERS, removeRetiredMcpServers } from './demoData';

const MCP_FILE = 'config/mcp-servers.json';
/** Where servers used to be kept (browser localStorage): moved to MCP_FILE once, then cleared. */
const LEGACY_SERVERS_KEY = 'ergo_mcp_servers';
const LEGACY_TOGGLED_PREFIX = 'ergo_mcp_user_toggled_';
const WRITE_DELAY_MS = 400;

interface McpConfigFile {
  version: 1;
  servers: MCPServer[];
  /** Bundled servers the user switched on or off themselves (their choice beats the bundled default). */
  userToggled: string[];
}

let userToggled = new Set<string>();
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let pending: MCPServer[] | null = null;

/** The saved servers merged over Ergo's bundled ones (bundled tools keep their schemas; the user's flags win). */
export function mergeSavedMcpServers(savedList: MCPServer[]): MCPServer[] {
  const parsed = removeRetiredMcpServers(savedList);
  if (!Array.isArray(parsed) || parsed.length === 0) return INITIAL_MCP_SERVERS;
  return INITIAL_MCP_SERVERS.map((initServer) => {
    const match = parsed.find((s: MCPServer) => s.id === initServer.id);
    if (!match) return initServer;
    const mergedTools = (match.tools && match.tools.length >= initServer.tools.length)
      ? match.tools.map((mt: any) => {
        const initTool = initServer.tools.find((it) => it.name === mt.name);
        return { ...initTool, ...mt, inputSchema: mt.inputSchema || initTool?.inputSchema };
      })
      : initServer.tools.map((initTool) => {
        const toolMatch = match.tools?.find((t: any) => t.id === initTool.id || t.name === initTool.name);
        return toolMatch ? { ...initTool, autoApprove: Boolean(toolMatch.autoApprove) } : initTool;
      });
    // Bundled connections that are on by default stay on unless the user switched them off themselves.
    const resolvedStatus = (initServer.serverType === 'bundled_harness' && initServer.status === 'connected' && match.status === 'disconnected' && !userToggled.has(initServer.id))
      ? 'connected'
      : (match.status || initServer.status);
    return { ...initServer, ...match, status: resolvedStatus, tools: mergedTools };
  }).concat(parsed.filter((s: MCPServer) => !INITIAL_MCP_SERVERS.some((init) => init.id === s.id)));
}

function takeLegacy(): { servers: MCPServer[] | null; toggled: string[] } {
  try {
    const raw = localStorage.getItem(LEGACY_SERVERS_KEY);
    const toggled: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(LEGACY_TOGGLED_PREFIX)) toggled.push(key.slice(LEGACY_TOGGLED_PREFIX.length));
    }
    return { servers: raw ? JSON.parse(raw) : null, toggled };
  } catch {
    return { servers: null, toggled: [] };
  }
}

function clearLegacy(): void {
  try {
    const keys: string[] = [LEGACY_SERVERS_KEY];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(LEGACY_TOGGLED_PREFIX)) keys.push(key);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  } catch {}
}

async function write(servers: MCPServer[]): Promise<boolean> {
  const file: McpConfigFile = { version: 1, servers, userToggled: [...userToggled] };
  const res = await writeFilesToDisk([{ filePath: MCP_FILE, content: JSON.stringify(file, null, 2) }]);
  return res.success;
}

/**
 * The user's servers from their machine (moving browser-kept ones there once), merged over the bundled ones; null
 * when the bridge couldn't be read (keep what is shown).
 */
export async function loadMcpServers(): Promise<MCPServer[] | null> {
  try {
    const files = await readFilesFromDisk([MCP_FILE]);
    const raw = files[MCP_FILE];
    if (raw) {
      const file = JSON.parse(raw) as Partial<McpConfigFile>;
      userToggled = new Set(Array.isArray(file.userToggled) ? file.userToggled : []);
      return mergeSavedMcpServers(Array.isArray(file.servers) ? file.servers : []);
    }
    if (raw === undefined) return null;
    const legacy = takeLegacy();
    userToggled = new Set(legacy.toggled);
    const servers = legacy.servers ? mergeSavedMcpServers(legacy.servers) : INITIAL_MCP_SERVERS;
    if (await write(servers)) clearLegacy();
    return servers;
  } catch (err) {
    console.warn('[MCP config] Could not load MCP servers from disk:', err);
    return null;
  }
}

/** Saves the servers to the user's machine (shortly after the last change). */
export function saveMcpServers(servers: MCPServer[]): void {
  pending = servers;
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    const next = pending;
    pending = null;
    if (next) write(next).catch((err) => console.warn('[MCP config] Could not save MCP servers:', err));
  }, WRITE_DELAY_MS);
}

/** The user switched a bundled server on or off themselves. */
export function markMcpServerToggled(serverId: string): void {
  userToggled.add(serverId);
}
