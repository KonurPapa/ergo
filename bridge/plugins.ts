/**
 * Ergo's local device bridge: the /api/* routes and the PTY WebSocket that let the Ergo web app reach this computer
 * (files under ~/.ergo, CLI agents, terminals, local models, memory). Written as Vite plugins: `npm run dev` loads
 * them through vite.config.ts, and bridge/standalone.ts runs the same plugins on a plain Node server for the
 * Ergo Bridge desktop app.
 */
import type { Plugin } from 'vite';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { TerminalScreen, ScreenTranscript } from '../src/lib/cliScreen.ts';
import {
  parseCliScreenPrompt,
  keystrokesForOption,
  pickApproveOption,
  isBypassAcceptanceDialog,
  promptSummary,
} from '../src/lib/cliPromptParser.ts';
import type { CliDetectedPrompt } from '../src/types/index.ts';
import {
  activityFromScreen,
  foldClaudeEntry,
  foldCodexEvent,
  foldGeminiMessage,
  newActivityFold,
  pendingCallForPrompt,
  promptContextOfCall,
  withScreenNarration,
  type ActivityFold,
  type AgentActivity,
  type AgentActivityResponse,
} from '../src/lib/agentActivity.ts';
import { cleanRow, isSpinnerRow } from '../src/lib/cliActivityFeed.ts';
import { createMemoryStore, embedWithMemoryModel, MEMORY_NAMESPACES, AGENT_NOTE_KINDS, WORKSPACE_MAX_ITEMS, type MemoryStore, type MemoryStoreIo } from '../src/lib/memory/memoryStore.ts';
import { CodeIndexManager, SKIP_DIR } from '../src/lib/codeIndex/codeIndex.ts';
import { rankPaths } from '../src/lib/pathRank.ts';
import { WORKSPACE_MCP_TOOLS } from '../src/lib/workspaceMcp.ts';
import { bridgeInfo, hostFilePicker, requestBridgeUpdate, setActiveSessionCounter } from './selfUpdate.ts';
import { parseScoutFiles, scoutSystemPrompt, scoutUserPrompt, SCOUT_MAX_TURNS, SCOUT_TIMEOUT_MS } from '../src/lib/codeIndex/fileScout.ts';
import type {
  AgentNoteKind,
  ChunkMetadata,
  InsightOp,
  InsightSource,
  MemoryChunkDTO,
  MemoryNamespace,
  MemorySearchRequest,
  RelatedTasksRequest,
  WorkspaceIndexItem,
} from '../src/lib/memory/types.ts';
import type {
  BenchmarkSource,
  CatalogModel,
  ModelCatalog,
  ModelCatalogRequest,
  ModelCatalogResponse,
  PriceSource,
} from '../src/lib/modelCatalog/types.ts';
import {
  CATALOG_NORMALIZER_VERSION,
  attachBenchmarks,
  normalizeLiteLlmPrices,
  parseArtificialAnalysisRows,
  sanitizeAaRow,
  sanitizeCatalogModel,
  type AaBenchmarkRow,
} from '../src/lib/modelCatalog/normalize.ts';
import { PRICE_SNAPSHOT } from '../src/lib/modelCatalog/priceSnapshot.ts';
import { priceUsage, resolveAliasModelId } from '../src/lib/modelCatalog/pricing.ts';

/**
 * Hosted Ergo web app origin(s) allowed to use this machine's local bridge out of the box.
 * Change this when the app moves to a new domain (exact https:// origins only — no paths,
 * trailing slashes or wildcards). Users can allow extra origins via ERGO_ALLOWED_ORIGINS.
 */
export const HOSTED_APP_ORIGINS = ['https://ergo.appwrite.network'];

/**
 * Claude Code's native installer: no Node.js, no admin rights, and it updates itself. It puts `claude` in
 * ~/.local/bin (%USERPROFILE%\.local\bin on Windows).
 */
const CLAUDE_INSTALL_COMMAND = process.platform === 'win32'
  ? 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"'
  : 'curl -fsSL https://claude.ai/install.sh | bash';

// A process never sees PATH entries that installers add after it started, so a `claude` installed through the bridge
// would stay "not installed" until a restart.
{
  const userBin = path.join(os.homedir(), '.local', 'bin');
  const entries = (process.env.PATH || '').split(path.delimiter);
  if (!entries.includes(userBin)) process.env.PATH = [...entries, userBin].filter(Boolean).join(path.delimiter);
}

let activeStoragePath = '~/.ergo';

// ─── Built-in skills on disk ────────────────────────────────────────────────
// Ergo's built-in skills ship with the web app; the bridge keeps a copy of each under <storage>/config/skills so users
// can read and edit them. `.defaults.json` there records the hash of the default the bridge last wrote, so a copy the
// user changed is told apart from one they never touched (which is refreshed when a newer default ships).

const BUILTIN_SKILL_NAMES = [
  'human-assistant',
  'assistant-context-analyzer',
  'assistant-todo-builder',
  'task-brief',
  'manager-agent',
  'worker-agent',
  'cleaner-agent',
  'verifier-agent',
];
const SKILL_MANIFEST_FILE = '.defaults.json';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

async function bundledSkillDoc(skillName: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(process.cwd(), 'docs', 'skills', skillName, 'SKILL.md'), 'utf-8');
  } catch {
    return null;
  }
}

/**
 * The disk copy of a skill, seeded or refreshed as needed, and whether it is the user's own edit. A copy with no
 * record (seeded by an older bridge) that differs from the default is kept as SKILL.previous.md and replaced.
 */
async function syncSkillCopy(storageDir: string, skillName: string): Promise<{ content: string | null; filePath: string; edited: boolean }> {
  const skillsDir = path.join(storageDir, 'config', 'skills');
  const filePath = path.join(skillsDir, skillName, 'SKILL.md');
  const manifestPath = path.join(skillsDir, SKILL_MANIFEST_FILE);
  let manifest: Record<string, string> = {};
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
  } catch {}
  const bundled = await bundledSkillDoc(skillName);
  let current: string | null = null;
  try {
    current = await fs.readFile(filePath, 'utf-8');
  } catch {}

  const writeDefault = async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, bundled!, 'utf-8');
    manifest[skillName] = sha256(bundled!);
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  };
  try {
    if (current === null) {
      if (bundled) await writeDefault();
      return { content: bundled, filePath, edited: false };
    }
    if (!bundled) return { content: current, filePath, edited: true };
    const recorded = manifest[skillName];
    const currentHash = sha256(current);
    if (recorded && currentHash !== recorded) return { content: current, filePath, edited: true };
    if (currentHash !== sha256(bundled)) {
      if (!recorded) await fs.writeFile(path.join(path.dirname(filePath), 'SKILL.previous.md'), current, 'utf-8');
      await writeDefault();
    } else if (!recorded) {
      manifest[skillName] = currentHash;
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    }
    return { content: bundled, filePath, edited: false };
  } catch (err) {
    console.warn(`[Ergo Storage] Could not sync skill ${skillName}:`, err);
    return { content: current ?? bundled, filePath, edited: false };
  }
}

function resolveStoragePath(inputPath: string = activeStoragePath): string {
  if (inputPath.startsWith('~/') || inputPath === '~') {
    const homeTarget = path.join(os.homedir(), inputPath.slice(1));
    try {
      if (!fsSync.existsSync(homeTarget)) {
        try {
          fsSync.mkdirSync(homeTarget, { recursive: true });
        } catch {
          return path.resolve(process.cwd(), '.ergo');
        }
      }
      return homeTarget;
    } catch {
      return path.resolve(process.cwd(), '.ergo');
    }
  }
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(process.cwd(), inputPath);
}

function getActiveStorageDir(): string {
  return resolveStoragePath(activeStoragePath);
}

async function ensureStorageInitialized(storageDir: string) {
  try {
    try {
      await fs.mkdir(storageDir, { recursive: true });
    } catch (mkdirErr) {
      const fallbackDir = path.resolve(process.cwd(), '.ergo');
      if (storageDir !== fallbackDir) {
        console.warn(`[Ergo Storage] Storage directory ${storageDir} could not be initialized, falling back to ${fallbackDir}`);
        storageDir = fallbackDir;
        activeStoragePath = '.ergo';
        await fs.mkdir(storageDir, { recursive: true });
      } else {
        throw mkdirErr;
      }
    }
    const configDir = path.join(storageDir, 'config');
    await fs.mkdir(configDir, { recursive: true });

    // Settings
    const settingsFile = path.join(configDir, 'settings.json');
    try {
      await fs.access(settingsFile);
    } catch {
      const defaultSettings = {
        version: 1,
        activeProjectId: 'default-workspace',
        activeKeyId: null,
        autosaveDelaySec: 5,
        autosaveEnabled: true,
        storageDirectory: activeStoragePath,
        lastOpenedAt: new Date().toISOString()
      };
      await fs.writeFile(settingsFile, JSON.stringify(defaultSettings, null, 2), 'utf-8');
    }

    // Secrets
    const secretsFile = path.join(configDir, 'secrets.json');
    try {
      await fs.access(secretsFile);
    } catch {
      const defaultSecrets = {
        version: 1,
        updatedAt: new Date().toISOString(),
        userApiKeys: [],
        mcpSecrets: {}
      };
      await fs.writeFile(secretsFile, JSON.stringify(defaultSecrets, null, 2), 'utf-8');
    }

    // Built-in skills: seed missing copies and refresh unedited ones (syncSkillCopy).
    for (const skillName of BUILTIN_SKILL_NAMES) await syncSkillCopy(storageDir, skillName);

    // Projects
    const projectsDir = path.join(storageDir, 'projects');
    await fs.mkdir(projectsDir, { recursive: true });
    const defaultWorkspaceDir = path.join(projectsDir, 'default-workspace');
    await fs.mkdir(defaultWorkspaceDir, { recursive: true });

    const todoFile = path.join(defaultWorkspaceDir, 'TODO.md');
    try {
      await fs.access(todoFile);
    } catch {
      const defaultTodo = `# General TODOs:\n\n1. **Initial Task Setup:**\n   - Define project scope and task list\n`;
      await fs.writeFile(todoFile, defaultTodo, 'utf-8');
    }

    const runningJobsFile = path.join(defaultWorkspaceDir, 'RUNNING_JOBS.json');
    try {
      await fs.access(runningJobsFile);
    } catch {
      const initialJobs = {
        version: 1,
        projectId: 'default-workspace',
        updatedAt: new Date().toISOString(),
        tasks: [],
        runningJobs: [],
        queuedTaskIds: [],
        taskExecutionSteps: {}
      };
      await fs.writeFile(runningJobsFile, JSON.stringify(initialJobs, null, 2), 'utf-8');
    }
  } catch (err) {
    console.warn('[Ergo Storage] Failed to initialize storage dir:', err);
  }
}

function parseJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/** A project's own folders file, or null for an id that isn't a plain project folder name. */
function projectFoldersFile(storageDir: string, projectId: unknown): string | null {
  if (typeof projectId !== 'string' || !/^[A-Za-z0-9._ -]{1,200}$/.test(projectId) || /^\.+$/.test(projectId)) return null;
  return path.join(path.resolve(storageDir), 'projects', projectId, 'project.json');
}

type ProjectFolder = { id: string; path: string; name: string; addedAt?: string };

/**
 * A project's own Allowed Folders (`projects/<id>/project.json`). A project that has some uses only those (plus Ergo's
 * storage) instead of the folders allowed for every project, and its agents start in the first one.
 */
async function loadProjectFolders(storageDir: string, projectId: unknown): Promise<ProjectFolder[]> {
  const file = projectFoldersFile(storageDir, projectId);
  if (!file) return [];
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf-8'));
    return (Array.isArray(parsed?.folders) ? parsed.folders : []).filter((f: any) => typeof f?.path === 'string' && f.path.trim());
  } catch {
    return [];
  }
}

function resolveRootPath(raw: string): string {
  const p = raw.trim();
  return path.resolve(p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
}

/**
 * Loads the allowed directory roots (storage dir + user-approved folders from config/roots.json, or the project's own
 * folders when `projectId` has some), resolved to absolute paths. Every filesystem / git / shell tool call is checked
 * against this list.
 */
async function loadAllowedRoots(storageDir: string, projectId?: unknown): Promise<string[]> {
  const roots = [path.resolve(storageDir)];
  const own = projectId ? await loadProjectFolders(storageDir, projectId) : [];
  if (own.length > 0) {
    for (const f of own) {
      const resolved = resolveRootPath(f.path);
      if (!roots.includes(resolved)) roots.push(resolved);
    }
    return roots;
  }
  try {
    const rootsContent = await fs.readFile(path.join(path.resolve(storageDir, 'config'), 'roots.json'), 'utf-8');
    const parsedRoots = JSON.parse(rootsContent);
    if (Array.isArray(parsedRoots)) {
      for (const r of parsedRoots) {
        let p = (r?.path || '').trim();
        if (!p) continue;
        if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
        const resolvedRoot = path.resolve(p);
        if (!roots.includes(resolvedRoot)) roots.push(resolvedRoot);
      }
    }
  } catch {}
  return roots;
}

type BoundaryCheck = { ok: true; fullPath: string } | { ok: false; error: string };

/** Resolves a user/AI supplied path ('~' aware, relative to the storage dir) and enforces the allowed-roots boundary. */
async function resolveInsideAllowedRoots(rawPath: string, storageDir: string, projectId?: unknown): Promise<BoundaryCheck> {
  let targetPath = (rawPath || '').trim();
  if (targetPath.startsWith('~')) targetPath = path.join(os.homedir(), targetPath.slice(1));
  const fullPath = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : targetPath.startsWith('.agents')
    ? path.resolve(process.cwd(), targetPath)
    : path.resolve(storageDir, targetPath || '.');
  const allowedRoots = await loadAllowedRoots(storageDir, projectId);
  const agentsDir = path.resolve(process.cwd(), '.agents');
  const isAgentCustomization = fullPath === agentsDir || fullPath.startsWith(agentsDir + path.sep);
  const isAllowed = isAgentCustomization || allowedRoots.some((root) => fullPath === root || fullPath.startsWith(root + path.sep));
  if (!isAllowed) {
    return {
      ok: false,
      error: `Access denied: "${rawPath}" resolves to "${fullPath}", which is outside the approved folder boundaries. The AI may only read/write inside ~/.ergo or folders explicitly permitted under Connections -> Allowed Folders (currently: ${allowedRoots.join(', ')}). Choose a path inside one of those roots.`
    };
  }
  return { ok: true, fullPath };
}

function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8000));
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return true;
  }
  return false;
}

function capText(text: string, max: number): { text: string; truncated: boolean; omitted: number } {
  if (text.length <= max) return { text, truncated: false, omitted: 0 };
  const omitted = text.length - max;
  return { text: text.slice(0, max) + `\n[truncated ${omitted} chars]`, truncated: true, omitted };
}

/** Runs a shell command with a timeout; never rejects — a failing command is a normal, high-signal result. */
async function runShellCommand(command: string, cwd: string, timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean; durationMs: number }> {
  const { exec } = await import('node:child_process');
  const started = Date.now();
  return new Promise((resolve) => {
    // Agent tools auto-allow "read-only" git commands, and file edits outside `.git` are auto-allowed too. Without
    // this, an agent could write a bare repo (HEAD + config with diff.external / core.fsmonitor) and have git run
    // it from inside that folder. Command-line config (GIT_CONFIG_COUNT) counts as protected config for this key.
    const env: NodeJS.ProcessEnv = { ...process.env };
    const gitConfigCount = Number.parseInt(env.GIT_CONFIG_COUNT || '0', 10) || 0;
    env.GIT_CONFIG_COUNT = String(gitConfigCount + 1);
    env[`GIT_CONFIG_KEY_${gitConfigCount}`] = 'safe.bareRepository';
    env[`GIT_CONFIG_VALUE_${gitConfigCount}`] = 'explicit';
    exec(command, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env }, (error: any, stdout: any, stderr: any) => {
      const timedOut = Boolean(error && error.killed && error.signal === 'SIGTERM');
      let exitCode = 0;
      let extraErr = '';
      if (error) {
        if (typeof error.code === 'number') exitCode = error.code;
        else if (timedOut) exitCode = 124;
        else { exitCode = 1; extraErr = `\n${error.message}`; }
      }
      resolve({
        exitCode,
        stdout: String(stdout || ''),
        stderr: String(stderr || '') + extraErr + (timedOut ? `\n[command timed out after ${timeoutMs} ms and was killed]` : ''),
        timedOut,
        durationMs: Date.now() - started
      });
    });
  });
}

/** Recursively ensures parent directory exists before writing deliverable (mkdir -p) */
async function writeDeliverable(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

/**
 * Manages official GitHub MCP server (@modelcontextprotocol/server-github) running over local stdio IPC.
 */
class GithubMcpClient {
  private proc: any = null;
  private token: string | null = null;
  private buffer = '';
  private pending = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void; timer: any }>();
  private reqId = 1;
  private readyPromise: Promise<void> | null = null;

  async getProc(token: string) {
    if (this.proc && this.token === token && !this.proc.killed) {
      await this.readyPromise;
      return this.proc;
    }
    if (this.proc) {
      try { this.proc.kill(); } catch {}
    }
    this.token = token;
    const { spawn } = await import('node:child_process');
    this.proc = spawn('npx', ['-y', '@modelcontextprotocol/server-github'], {
      env: { ...process.env, GITHUB_PERSONAL_ACCESS_TOKEN: token },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.buffer = '';
    this.pending.clear();

    this.proc.stdout.on('data', (chunk: any) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id && this.pending.has(msg.id)) {
            const { resolve, reject, timer } = this.pending.get(msg.id)!;
            clearTimeout(timer);
            this.pending.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            else resolve(msg.result);
          }
        } catch {}
      }
    });

    this.proc.on('exit', () => {
      this.proc = null;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error('GitHub MCP server process exited'));
      }
      this.pending.clear();
    });

    this.readyPromise = new Promise<void>((resolve, reject) => {
      const initId = this.reqId++;
      const timer = setTimeout(() => reject(new Error('GitHub MCP initialization timed out')), 25000);
      this.pending.set(initId, {
        resolve: () => {
          try {
            this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
          } catch {}
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
        timer
      });
      try {
        this.proc.stdin.write(JSON.stringify({
          jsonrpc: '2.0',
          id: initId,
          method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ergo', version: '1.0.0' } }
        }) + '\n');
      } catch (writeErr) {
        clearTimeout(timer);
        reject(writeErr);
      }
    });

    await this.readyPromise;
    return this.proc;
  }

  async sendRequest(token: string, method: string, params: any, timeoutMs = 25000): Promise<any> {
    await this.getProc(token);
    const id = this.reqId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`GitHub MCP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async listTools(token: string) {
    const res = await this.sendRequest(token, 'tools/list', {});
    return res?.tools || [];
  }

  async callTool(token: string, name: string, args: any) {
    const res = await this.sendRequest(token, 'tools/call', { name, arguments: args });
    return res;
  }

  kill() {
    if (this.proc) {
      try { this.proc.kill(); } catch {}
      this.proc = null;
      this.token = null;
    }
  }
}

const githubMcpClient = new GithubMcpClient();

function syncClaudeConfig(apiKey?: string, projectCwd?: string) {
  try {
    const claudeJsonPath = path.join(os.homedir(), '.claude.json');
    let claudeConfig: any = {};
    if (fsSync.existsSync(claudeJsonPath)) {
      try {
        claudeConfig = JSON.parse(fsSync.readFileSync(claudeJsonPath, 'utf-8'));
      } catch {}
    }

    let modified = false;

    // 1. Ensure customApiKeyResponses has this key in approved and not in rejected
    if (apiKey && apiKey.trim().length > 10) {
      const truncated = apiKey.trim().slice(-20);
      if (!claudeConfig.customApiKeyResponses) {
        claudeConfig.customApiKeyResponses = { approved: [], rejected: [] };
        modified = true;
      }
      if (Array.isArray(claudeConfig.customApiKeyResponses.rejected) && claudeConfig.customApiKeyResponses.rejected.includes(truncated)) {
        claudeConfig.customApiKeyResponses.rejected = claudeConfig.customApiKeyResponses.rejected.filter((k: string) => k !== truncated);
        modified = true;
      }
      if (Array.isArray(claudeConfig.customApiKeyResponses.approved) && !claudeConfig.customApiKeyResponses.approved.includes(truncated)) {
        claudeConfig.customApiKeyResponses.approved.push(truncated);
        modified = true;
      }

      // Also ensure ~/.claude/personal-key.sh outputs this valid key if the script exists
      const personalKeyScript = path.join(os.homedir(), '.claude', 'personal-key.sh');
      if (fsSync.existsSync(personalKeyScript)) {
        try {
          fsSync.writeFileSync(personalKeyScript, `#!/bin/bash\necho "${apiKey.trim()}"\n`, { mode: 0o755 });
        } catch {}
      }
    }

    // 2. Ensure project workspace is trusted so the "Quick safety check" prompt never blocks execution
    if (projectCwd) {
      if (!claudeConfig.projects || typeof claudeConfig.projects !== 'object') {
        claudeConfig.projects = {};
        modified = true;
      }
      if (!claudeConfig.projects[projectCwd]) {
        claudeConfig.projects[projectCwd] = { hasTrustDialogAccepted: true };
        modified = true;
      } else if (!claudeConfig.projects[projectCwd].hasTrustDialogAccepted) {
        claudeConfig.projects[projectCwd].hasTrustDialogAccepted = true;
        modified = true;
      }
    }

    if (modified) {
      fsSync.writeFileSync(claudeJsonPath, JSON.stringify(claudeConfig, null, 2), 'utf-8');
      console.log('[Ergo] Synced Claude configuration for API key and workspace trust in ~/.claude.json');
    }
  } catch (err) {
    console.warn('[Ergo] Failed to sync ~/.claude.json:', err);
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// CLI agent policy + usage helpers
// Shared by the headless runner (/api/cli/execute) and PTY usage lookups (/api/pty/usage).
// ─────────────────────────────────────────────────────────────────────────────

type BridgeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
type BridgePermission = 'plan' | 'ask' | 'acceptEdits' | 'bypass';

interface BridgeUsage {
  /** All prompt tokens including cache reads/writes. */
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  calls: number;
  estimated?: boolean;
  /** API-price value of these calls (USD), cache discounts included; absent when no call could be priced. */
  costUsd?: number;
  /** Some calls have tokens but no price. */
  costPartial?: boolean;
}

/** Prices the bridge uses for usage costs: the model catalog's latest list once loaded, else the bundled snapshot. */
let bridgePriceModels: CatalogModel[] = PRICE_SNAPSHOT.models;

/** API-price cost of `usage` on `model` (aliases like "sonnet" resolve to the newest model), or undefined. */
function bridgeUsageCost(model: string | undefined | null, usage: BridgeUsage & { cacheWrite1hTokens?: number }): number | undefined {
  if (!model) return undefined;
  return priceUsage(bridgePriceModels, resolveAliasModelId(bridgePriceModels, model), usage);
}

/** The value of a CLI's --model / -m argument. */
function modelArgOf(args: string[]): string | undefined {
  for (let i = 0; i < args.length - 1; i++) if (args[i] === '--model' || args[i] === '-m') return args[i + 1];
  const eq = args.find((a) => a.startsWith('--model='));
  return eq ? eq.slice('--model='.length) : undefined;
}

const EFFORT_VALUES = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const PERMISSION_VALUES = new Set(['plan', 'ask', 'acceptEdits', 'bypass']);

function asEffort(v: any): BridgeEffort | undefined {
  return typeof v === 'string' && EFFORT_VALUES.has(v) ? (v as BridgeEffort) : undefined;
}

function asPermission(v: any): BridgePermission | undefined {
  return typeof v === 'string' && PERMISSION_VALUES.has(v) ? (v as BridgePermission) : undefined;
}

const PERMISSION_FLAG_PATTERN = /^(--permission-mode|--dangerously-skip-permissions|--mode|--sandbox|-s|--ask-for-approval|-a|--dangerously-bypass-approvals-and-sandbox|--full-auto|--approval-mode|--yolo)$/;

/** Normalizes Anthropic / OpenAI / Codex / Gemini usage objects onto BridgeUsage (input includes cached tokens). */
function normalizeUsageObject(u: any): BridgeUsage | null {
  if (!u || typeof u !== 'object') return null;
  const n = (v: any) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  if ('promptTokenCount' in u || 'candidatesTokenCount' in u) {
    return {
      inputTokens: n(u.promptTokenCount),
      outputTokens: n(u.candidatesTokenCount) + n(u.thoughtsTokenCount),
      cachedInputTokens: n(u.cachedContentTokenCount),
      cacheWriteTokens: 0,
      calls: 1
    };
  }
  if ('input_tokens' in u || 'output_tokens' in u) {
    const anthropicStyle = 'cache_read_input_tokens' in u || 'cache_creation_input_tokens' in u;
    const cacheRead = anthropicStyle ? n(u.cache_read_input_tokens) : n(u.cached_input_tokens);
    const cacheWrite = anthropicStyle ? n(u.cache_creation_input_tokens) : 0;
    return {
      inputTokens: n(u.input_tokens) + (anthropicStyle ? cacheRead + cacheWrite : 0),
      outputTokens: n(u.output_tokens),
      cachedInputTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      calls: 1
    };
  }
  if ('input' in u || 'output' in u) {
    // Gemini CLI session message tokens
    return { inputTokens: n(u.input), outputTokens: n(u.output) + n(u.thoughts), cachedInputTokens: n(u.cached), cacheWriteTokens: 0, calls: 1 };
  }
  return null;
}

function addBridgeUsage(target: BridgeUsage, delta: BridgeUsage | null) {
  if (!delta) return;
  target.inputTokens += delta.inputTokens;
  target.outputTokens += delta.outputTokens;
  target.cachedInputTokens += delta.cachedInputTokens;
  target.cacheWriteTokens += delta.cacheWriteTokens;
  target.calls += delta.calls;
  if (typeof delta.costUsd === 'number') target.costUsd = (target.costUsd || 0) + delta.costUsd;
  else if (delta.inputTokens + delta.outputTokens > 0) target.costPartial = true;
  if (delta.costPartial) target.costPartial = true;
}

function emptyBridgeUsage(): BridgeUsage {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, calls: 0 };
}

/** `claude -p --output-format json` prints one result object. */
function parseClaudeJsonResult(stdout: string): { text: string; usage: BridgeUsage | null; isError: boolean } | null {
  const trimmed = stdout.trim();
  const candidates = [trimmed, ...trimmed.split('\n').reverse().filter((l) => l.trim().startsWith('{'))];
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c);
      if (obj && typeof obj === 'object' && (obj.type === 'result' || 'result' in obj)) {
        const usage = normalizeUsageObject(obj.usage);
        if (usage) usage.calls = typeof obj.num_turns === 'number' && obj.num_turns > 0 ? obj.num_turns : 1;
        // Claude Code reports the API-price value of the call itself (cache discounts included).
        if (usage && typeof obj.total_cost_usd === 'number' && Number.isFinite(obj.total_cost_usd)) usage.costUsd = obj.total_cost_usd;
        return { text: typeof obj.result === 'string' ? obj.result : '', usage, isError: Boolean(obj.is_error) };
      }
    } catch {}
  }
  return null;
}

/** `codex exec --json` prints JSONL events; usage arrives on turn.completed (or token_count events in older builds). */
function parseCodexJsonl(stdout: string): { text: string; usage: BridgeUsage | null } {
  let text = '';
  const turnUsage = emptyBridgeUsage();
  let lastTotal: BridgeUsage | null = null;
  for (const line of stdout.split('\n')) {
    const l = line.trim();
    if (!l.startsWith('{')) continue;
    let ev: any;
    try { ev = JSON.parse(l); } catch { continue; }
    if (ev.type === 'turn.completed' && ev.usage) addBridgeUsage(turnUsage, normalizeUsageObject(ev.usage));
    const info = ev.payload?.info ?? ev.msg?.info ?? ev.info;
    if ((ev.payload?.type === 'token_count' || ev.msg?.type === 'token_count' || ev.type === 'token_count') && info?.total_token_usage) {
      lastTotal = normalizeUsageObject(info.total_token_usage);
    }
    const item = ev.item;
    if (ev.type === 'item.completed' && item && (item.type === 'agent_message' || item.type === 'assistant_message') && typeof item.text === 'string') {
      text = item.text;
    }
  }
  const usage = turnUsage.calls > 0 ? turnUsage : lastTotal;
  return { text, usage };
}

let agyModelListCache: { at: number; ids: string[] } | null = null;

/** Model ids reported by `agy models` (cached 10 minutes). Empty when agy is missing or not logged in. */
async function listAgyModels(cwd: string): Promise<string[]> {
  if (agyModelListCache && Date.now() - agyModelListCache.at < 10 * 60_000) return agyModelListCache.ids;
  const localAgy = path.join(os.homedir(), '.local', 'bin', 'agy');
  const bin = fsSync.existsSync(localAgy) ? localAgy : 'agy';
  const out = await runShellCommand(`"${bin}" models`, cwd, 20_000).catch(() => null);
  const ids = out && out.exitCode === 0
    ? out.stdout.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((id) => /^[a-z0-9][a-z0-9.-]+$/i.test(id) && id.includes('-'))
    : [];
  agyModelListCache = { at: Date.now(), ids };
  return ids;
}

/** Drops model names the target CLI would reject (e.g. API ids sent to agy, preset ids sent to claude). */
async function sanitizeCliModel(cliBase: string, model: string | undefined, cwd: string): Promise<string | undefined> {
  if (!model || !model.trim()) return undefined;
  const m = model.trim();
  if (cliBase.includes('claude')) return /^(haiku|sonnet|opus|fable|claude-[a-z0-9.-]+)$/i.test(m) ? m : undefined;
  if (cliBase.includes('agy')) return (await listAgyModels(cwd)).includes(m) ? m : undefined;
  if (cliBase.includes('codex')) return /^(gpt-|o\d|codex)/i.test(m) ? m : undefined;
  return m;
}

/**
 * Runs a local CLI coding agent process (e.g. claude -p, codex, agy, aider) headlessly.
 * Pipes the prompt to stdin and CLI arguments, and captures standard output.
 */
async function runCliProcess(options: {
  cli: string;
  prompt: string;
  systemPrompt?: string;
  cwd: string;
  customArgs?: string[];
  timeoutMs?: number;
  env?: Record<string, string>;
  model?: string;
  effort?: BridgeEffort;
  permissionLevel?: BridgePermission;
  /**
   * A one-shot answer (overview, rating, autocomplete…), not agent work. Claude Code then runs without its built-in
   * tools, MCP servers, settings / CLAUDE.md and default system prompt, and with `systemPrompt` as the system prompt:
   * a measured ~25k tokens of per-call overhead (30.7k → 4.4k for an overview) with the same answer.
   */
  completion?: boolean;
  req?: any;
}): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean; durationMs: number; output?: string; usage?: BridgeUsage | null }> {
  const { spawn } = await import('node:child_process');
  const started = Date.now();
  const timeoutMs = options.timeoutMs || 60_000;

  const rawCli = (options.cli === 'antigravity' ? 'agy' : (options.cli || 'claude')).trim();
  let executable = rawCli;
  if (rawCli === 'agy' || rawCli === 'antigravity') {
    const localAgy = path.join(os.homedir(), '.local', 'bin', 'agy');
    if (fsSync.existsSync(localAgy)) {
      executable = localAgy;
    }
  }
  const cliBase = path.basename(executable).toLowerCase();
  let args: string[] = Array.isArray(options.customArgs) && options.customArgs.length > 0 ? [...options.customArgs] : [];

  const completionMode = Boolean(options.completion) && /claude/.test(path.basename(executable).toLowerCase()) && args.length === 0;
  const combinedPrompt = options.systemPrompt && !completionMode
    ? `${options.systemPrompt.trim()}\n\nTask:\n${options.prompt.trim()}`
    : options.prompt.trim();
  let completionSystemFile: string | null = null;

  let passedPromptInArgs = false;
  const userSetPermissions = args.some((a) => PERMISSION_FLAG_PATTERN.test(a));
  const level = options.permissionLevel;
  const model = await sanitizeCliModel(cliBase, options.model, options.cwd);
  let outputMode: 'text' | 'claude-json' | 'codex-jsonl' = 'text';
  let codexLastMessageFile: string | null = null;

  if (cliBase.includes('claude')) {
    const anthropicKey = options.env?.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
    syncClaudeConfig(anthropicKey, options.cwd);
    if (!args.includes('-p') && !args.includes('--print')) {
      args.unshift('-p');
    }
    if (completionMode) {
      args.push(
        '--tools', '',
        '--strict-mcp-config',
        '--setting-sources', '',
        '--disable-slash-commands',
        '--no-session-persistence',
        '--exclude-dynamic-system-prompt-sections'
      );
      const system = (options.systemPrompt || '').trim() || 'You are a helpful assistant. Answer the request directly.';
      if (system.length > 60_000) {
        completionSystemFile = path.join(os.tmpdir(), `ergo-system-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
        await fs.writeFile(completionSystemFile, system, 'utf-8');
        args.push('--system-prompt-file', completionSystemFile);
      } else {
        args.push('--system-prompt', system);
      }
    }
    if (!userSetPermissions && !completionMode) {
      // Print mode can't answer prompts. Ergo's own tool layer gates <tool_call> actions, so "ask" denies the
      // CLI's built-in tools (dontAsk) to route every edit and command through Ergo's approval flow.
      if (level === 'plan') args.push('--permission-mode', 'plan');
      else if (level === 'ask') args.push('--permission-mode', 'dontAsk');
      else if (level === 'acceptEdits') args.push('--permission-mode', 'acceptEdits');
      else args.push('--dangerously-skip-permissions');
    }
    if (model && !args.includes('--model')) {
      args.push('--model', model);
    }
    if (options.effort && !args.includes('--effort')) {
      args.push('--effort', options.effort);
    }
    if (!args.includes('--output-format')) {
      args.push('--output-format', 'json');
      outputMode = 'claude-json';
    }
    // Agent work (not completion mode): the user's settings minus plugins, as for PTY task agents.
    const agentSettings = !completionMode && !args.includes('--settings') && !args.includes('--setting-sources')
      ? writeAgentClaudeSettings({ apiKeyHelperOff: Boolean(anthropicKey), keepModel: !args.includes('--model') })
      : null;
    if (completionMode) {
      // --setting-sources '' above already skips user settings (and their plugins).
      if (anthropicKey && !args.includes('--settings')) args.push('--settings', '{"apiKeyHelper":""}');
    } else if (agentSettings) {
      args.push('--setting-sources', 'project,local', '--settings', agentSettings);
    } else if (anthropicKey && !args.includes('--settings')) {
      args.push('--settings', '{"apiKeyHelper":""}');
    }
    // For Claude Code CLI, pass the prompt directly as argument when under 8000 chars for reliable single-command dispatch
    if (combinedPrompt.length < 8000 && !args.includes(combinedPrompt)) {
      args.push(combinedPrompt);
      passedPromptInArgs = true;
    }
  } else if (cliBase.includes('aider')) {
    if (!args.includes('--message') && !args.includes('-m')) {
      args.push('--message', combinedPrompt);
      passedPromptInArgs = true;
    }
    if (model && !args.includes('--model') && !args.includes('-m')) {
      args.push('--model', model);
    }
    if (!args.includes('--no-git')) {
      args.push('--no-git');
    }
    if (!args.includes('--yes')) {
      args.push('--yes');
    }
  } else if (cliBase.includes('codex')) {
    if (!args.includes('exec')) {
      args.unshift('exec');
    }
    if (!args.includes('--skip-git-repo-check')) {
      // Ergo workspaces are often not git repos; without this codex exec refuses to start.
      args.push('--skip-git-repo-check');
    }
    if (!userSetPermissions) {
      if (level === 'plan') args.push('--sandbox', 'read-only');
      else if (level === 'bypass' || !level) args.push('--dangerously-bypass-approvals-and-sandbox');
      else args.push('--sandbox', 'workspace-write');
    }
    if (model && !args.includes('--model') && !args.includes('-m')) {
      args.push('--model', model);
    }
    if (options.effort && !args.some((a) => a.includes('model_reasoning_effort'))) {
      const codexEffort = options.effort === 'low' ? 'low' : options.effort === 'medium' ? 'medium' : 'high';
      args.push('-c', `model_reasoning_effort="${codexEffort}"`);
    }
    if (!args.includes('--json')) {
      args.push('--json');
      outputMode = 'codex-jsonl';
      codexLastMessageFile = path.join(os.tmpdir(), `ergo-codex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
      args.push('--output-last-message', codexLastMessageFile);
    }
    if (combinedPrompt.length < 8000) {
      args.push(combinedPrompt);
      passedPromptInArgs = true;
    }
  } else if (cliBase.includes('agy')) {
    if (!userSetPermissions) {
      // Print mode can't answer approval prompts; plan keeps it read-only, every other level auto-approves
      // (Ergo's tool layer still gates the <tool_call> actions it executes).
      if (level === 'plan') args.push('--mode', 'plan');
      else args.push('--dangerously-skip-permissions');
    }
    if (!args.includes('--disable-slash-commands')) {
      args.push('--disable-slash-commands');
    }
    if (!args.includes('--effort')) {
      args.push('--effort', options.effort || 'low');
    }
    if (model && !args.includes('--model') && !args.includes('-m')) {
      args.push('--model', model);
    }
    if (!args.includes('-p') && !args.includes('--print') && !args.some((a) => a.startsWith('-p=') || a.startsWith('--print='))) {
      args.push('-p', combinedPrompt);
      passedPromptInArgs = true;
    }
  } else if (cliBase.includes('cursor')) {
    if (!args.includes('-p') && !args.includes('--print') && !args.includes('agent')) {
      args.unshift('agent');
    }
    if (combinedPrompt.length < 8000 && !args.includes(combinedPrompt)) {
      args.push(combinedPrompt);
      passedPromptInArgs = true;
    }
  } else if (cliBase.includes('grok')) {
    if (!args.includes('-p') && !args.includes('--prompt')) {
      args.unshift('-p');
    }
    if (combinedPrompt.length < 8000 && !args.includes(combinedPrompt)) {
      args.push(combinedPrompt);
      passedPromptInArgs = true;
    }
  }

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let proc: any = null;

    const timer = setTimeout(() => {
      timedOut = true;
      if (proc) {
        try { proc.kill('SIGTERM'); } catch {}
      }
    }, timeoutMs);

    try {
      proc = spawn(executable, args, {
        cwd: options.cwd,
        env: {
          ...process.env,
          PATH: `${path.join(os.homedir(), '.local', 'bin')}:${process.env.PATH || ''}`,
          CI: '1',
          NON_INTERACTIVE: '1',
          FORCE_COLOR: '0',
          ...(options.env || {})
        },
        stdio: ['pipe', 'pipe', 'pipe']
      });

      if (options.req) {
        options.req.on('close', () => {
          if (proc && !proc.killed) {
            try { proc.kill('SIGTERM'); } catch {}
          }
        });
      }

      proc.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf-8');
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8');
      });

      proc.on('error', (err: any) => {
        clearTimeout(timer);
        resolve({
          exitCode: 1,
          stdout,
          stderr: (stderr ? stderr + '\n' : '') + err.message,
          timedOut: false,
          durationMs: Date.now() - started
        });
      });

      proc.on('close', (code: number | null) => {
        clearTimeout(timer);
        let output: string | undefined;
        let usage: BridgeUsage | null = null;
        let extraStderr = '';
        if (outputMode === 'claude-json') {
          const parsed = parseClaudeJsonResult(stdout);
          if (parsed) {
            usage = parsed.usage;
            // Errors (bad model, auth) come back as is_error results — surface them as failures, not answers.
            if (parsed.isError) {
              extraStderr = parsed.text;
              output = '';
            } else {
              output = parsed.text;
            }
          }
        } else if (outputMode === 'codex-jsonl') {
          const parsed = parseCodexJsonl(stdout);
          usage = parsed.usage;
          let lastMessage = '';
          if (codexLastMessageFile) {
            try {
              lastMessage = fsSync.readFileSync(codexLastMessageFile, 'utf-8');
              fsSync.unlinkSync(codexLastMessageFile);
            } catch {}
          }
          output = (lastMessage || parsed.text).trim();
        }
        if (completionSystemFile) {
          try {
            fsSync.unlinkSync(completionSystemFile);
          } catch {}
        }
        resolve({
          exitCode: code ?? (timedOut ? 124 : 0),
          stdout,
          stderr: stderr + (extraStderr ? `\n${extraStderr}` : '') + (timedOut ? `\n[CLI process timed out after ${timeoutMs}ms]` : ''),
          timedOut,
          durationMs: Date.now() - started,
          output,
          usage
        });
      });

      // Write prompt to stdin only if NOT passed via argument flags to prevent stdin read hang
      try {
        if (proc.stdin && !proc.stdin.destroyed) {
          if (!passedPromptInArgs) {
            proc.stdin.write(combinedPrompt);
          }
          proc.stdin.end();
        }
      } catch {}
    } catch (err: any) {
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        stdout,
        stderr: err.message,
        timedOut: false,
        durationMs: Date.now() - started
      });
    }
  });
}

// ── Change review helpers (/api/git/changes, /api/git/revert) ──

interface GitChangeFile {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';
  /** Unified diff against HEAD, capped; empty for binary files. */
  diff: string;
  binary: boolean;
  truncated: boolean;
}
interface GitChangeRepo {
  root: string;
  files: GitChangeFile[];
}

const GIT_DIFF_MAX_CHARS = 60_000;
const GIT_CHANGE_MAX_FILES = 200;

function gitExec(cwd: string, args: string[], okCodes: number[] = []): Promise<{ out: string; ok: boolean }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 32 * 1024 * 1024, timeout: 20_000 }, (err: any, stdout) => {
      const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
      resolve({ out: String(stdout ?? err?.stdout ?? ''), ok: !err || okCodes.includes(code) });
    });
  });
}

/** Trimmed-free stdout of a git command, or null when it fails (e.g. not a repository). */
async function gitOut(cwd: string, args: string[]): Promise<string | null> {
  const r = await gitExec(cwd, args);
  return r.ok ? r.out : null;
}

async function gitRun(cwd: string, args: string[]): Promise<void> {
  const r = await gitExec(cwd, args);
  if (!r.ok) throw new Error(`git ${args[0]} failed`);
}

async function listGitChanges(root: string, withDiff = true): Promise<GitChangeFile[]> {
  const status = await gitOut(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (!status) return [];
  const parts = status.split('\0').filter(Boolean);
  const files: GitChangeFile[] = [];
  for (let i = 0; i < parts.length && files.length < GIT_CHANGE_MAX_FILES; i++) {
    const code = parts[i].slice(0, 2);
    const file = parts[i].slice(3);
    if (code[0] === 'R' || code[0] === 'C') i++; // the rename's old path follows
    const st: GitChangeFile['status'] =
      code === '??' ? 'untracked' : code.includes('D') ? 'deleted' : code[0] === 'R' ? 'renamed' : code.includes('A') ? 'added' : 'modified';
    let diff = '';
    if (withDiff) {
      const r =
        st === 'untracked'
          ? await gitExec(root, ['diff', '--no-index', '--', os.devNull, file], [1])
          : await gitExec(root, ['diff', 'HEAD', '--', file]);
      diff = r.out;
    }
    const binary = withDiff && /^Binary files /m.test(diff);
    const truncated = diff.length > GIT_DIFF_MAX_CHARS;
    files.push({ path: file, status: st, diff: binary ? '' : diff.slice(0, GIT_DIFF_MAX_CHARS), binary, truncated });
  }
  return files;
}

function sendJson(res: ServerResponse, statusCode: number, data: any) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

// ─────────────────────────────────────────────────────────────────────────────
// Bridge Access Guard
// The /api/* bridge can spawn shells and read/write files, so every HTTP request
// and WebSocket upgrade must pass this guard before reaching a route handler:
//   1. The TCP peer must be loopback — even if Vite is started with --host,
//      nothing on the LAN can reach the bridge.
//   2. The Host header must be a loopback name — blocks DNS-rebinding attacks.
//   3. A browser caller must be same-origin or an exact entry in
//      ERGO_ALLOWED_ORIGINS (the hosted Ergo app). No wildcards. Callers without
//      an Origin header are rejected when Fetch Metadata marks them cross-site
//      (e.g. <img src>, <form>, or link navigations from another site).
// ─────────────────────────────────────────────────────────────────────────────

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const a = address.replace(/^::ffff:/i, '');
  return a === '::1' || /^127(\.\d{1,3}){3}$/.test(a);
}

/** ERGO_* entries from the .env files Vite reads in the working directory, later files winning as in Vite. */
function readErgoEnvFiles(mode: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const file of ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`]) {
    let text: string;
    try {
      text = fsSync.readFileSync(path.join(process.cwd(), file), 'utf-8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?(ERGO_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (match) vars[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return vars;
}

/** HOSTED_APP_ORIGINS plus any extra exact origins from ERGO_ALLOWED_ORIGINS. */
function loadAllowedBridgeOrigins(): Set<string> {
  const env = readErgoEnvFiles(process.env.NODE_ENV === 'production' ? 'production' : 'development');
  const extra = (process.env.ERGO_ALLOWED_ORIGINS || env.ERGO_ALLOWED_ORIGINS || '').split(',');
  const origins = new Set<string>();
  for (const entry of [...HOSTED_APP_ORIGINS, ...extra].map((s) => s.trim()).filter(Boolean)) {
    try {
      const parsed = new URL(entry);
      // Plain-HTTP origins can be tampered with in transit, which would hand a network attacker a shell.
      if (parsed.protocol !== 'https:' && !isLoopbackHostname(parsed.hostname)) {
        console.warn(`[Ergo Bridge] Ignoring ERGO_ALLOWED_ORIGINS entry "${entry}": only https:// origins are allowed.`);
        continue;
      }
      if (parsed.hostname.includes('*')) {
        console.warn(`[Ergo Bridge] Ignoring ERGO_ALLOWED_ORIGINS entry "${entry}": wildcards are not allowed.`);
        continue;
      }
      origins.add(parsed.origin);
    } catch {
      console.warn(`[Ergo Bridge] Ignoring invalid ERGO_ALLOWED_ORIGINS entry "${entry}".`);
    }
  }
  return origins;
}

const allowedBridgeOrigins = loadAllowedBridgeOrigins();
const rejectedOriginsLogged = new Set<string>();

type BridgeAccess = { ok: true; corsOrigin: string | null } | { ok: false; reason: string };

function checkBridgeAccess(req: IncomingMessage): BridgeAccess {
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    return { ok: false, reason: `non-loopback client ${req.socket.remoteAddress}` };
  }

  const hostHeader = req.headers.host || '';
  let hostname = '';
  try {
    hostname = new URL(`http://${hostHeader}`).hostname;
  } catch {}
  if (!hostname || !isLoopbackHostname(hostname)) {
    return { ok: false, reason: `non-loopback Host header "${hostHeader}"` };
  }

  const origin = req.headers.origin;
  if (origin) {
    if (origin === `http://${hostHeader}` || origin === `https://${hostHeader}`) {
      return { ok: true, corsOrigin: null };
    }
    if (allowedBridgeOrigins.has(origin)) {
      return { ok: true, corsOrigin: origin };
    }
    if (origin !== 'null' && !rejectedOriginsLogged.has(origin)) {
      rejectedOriginsLogged.add(origin);
      console.warn(
        `[Ergo Bridge] Blocked request from origin ${origin}. If this is your hosted Ergo app, ` +
        `add it to HOSTED_APP_ORIGINS in bridge/plugins.ts (or ERGO_ALLOWED_ORIGINS in .env.local) and restart.`
      );
    }
    return { ok: false, reason: `origin ${origin} is not allowed` };
  }

  // Pasted images are embedded in notes as plain <img src="…/api/media/…">, which never send an
  // Origin header. That route is read-only, image-only and confined to the storage dir.
  const isMediaGet = req.method === 'GET' && Boolean(req.url?.startsWith('/api/media/'));
  const fetchSite = req.headers['sec-fetch-site'];
  if (!isMediaGet && fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return { ok: false, reason: `cross-site request without Origin (sec-fetch-site: ${fetchSite})` };
  }
  return { ok: true, corsOrigin: null };
}

/**
 * Applies the bridge guard to an /api/* HTTP request and sets CORS headers for allowed
 * cross-origin callers. Returns false after responding when the request is rejected
 * or was a completed CORS preflight.
 */
function guardBridgeRequest(req: IncomingMessage, res: ServerResponse): boolean {
  res.setHeader('Vary', 'Origin');
  const access = checkBridgeAccess(req);
  if (!access.ok) {
    sendJson(res, 403, { error: `Ergo bridge refused this request: ${access.reason}.` });
    return false;
  }
  if (access.corsOrigin) {
    res.setHeader('Access-Control-Allow-Origin', access.corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    res.setHeader('Access-Control-Max-Age', '600');
    if (req.headers['access-control-request-private-network']) {
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
  }
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return false;
  }
  return true;
}

/** True for bare executable names like "claude" or "agy" — safe to interpolate into a shell command. */
function isSafeCommandName(cmd: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(cmd);
}

/** `which` for runShellCommand: cmd.exe has none, and its `where` prints every match, one per line. */
const FIND_ON_PATH = process.platform === 'win32' ? 'where' : 'which';

// Set of active SSE clients listening for file changes
const sseClients = new Set<ServerResponse>();
// Recent server-side writes with timestamp to suppress self-notifications in the originating client
const recentWrites = new Map<string, number>();

function broadcastFileChange(payload: {
  filePath: string;
  relativePath: string;
  projectId: string;
  fileType: 'todo' | 'other';
  content: string;
  updatedAt: string;
}) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(data);
    } catch {
      sseClients.delete(client);
    }
  }
}

let fileWatcher: fsSync.FSWatcher | null = null;
let watchDebounceTimer: NodeJS.Timeout | null = null;

function setupProjectWatcher(storageDir: string) {
  if (fileWatcher) {
    try {
      fileWatcher.close();
    } catch {}
    fileWatcher = null;
  }

  const projectsDir = path.join(storageDir, 'projects');
  try {
    if (!fsSync.existsSync(projectsDir)) {
      fsSync.mkdirSync(projectsDir, { recursive: true });
    }

    fileWatcher = fsSync.watch(projectsDir, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;
      const normalizedFilename = filename.replace(/\\/g, '/');
      if (!normalizedFilename.endsWith('.md')) return;
      // Agent run files (<project>/.ergo/runs/…) are read by the PTY bridge, not synced as notes.
      if (`/${normalizedFilename}`.includes('/.ergo/')) return;

      if (watchDebounceTimer) {
        clearTimeout(watchDebounceTimer);
      }

      watchDebounceTimer = setTimeout(async () => {
        try {
          const fullPath = path.join(projectsDir, normalizedFilename);
          const relativeToStorage = path.join('projects', normalizedFilename).replace(/\\/g, '/');

          // Check if this file was recently written via Ergo's internal write API (within 1.5s)
          const lastWrite = recentWrites.get(relativeToStorage) || recentWrites.get(fullPath);
          if (lastWrite && Date.now() - lastWrite < 1500) {
            return;
          }

          if (!fsSync.existsSync(fullPath)) return;
          const stat = await fs.stat(fullPath);
          if (!stat.isFile()) return;

          const content = await fs.readFile(fullPath, 'utf-8');
          const pathParts = normalizedFilename.split('/');
          const projectId = pathParts[0] || 'default-workspace';
          const baseName = path.basename(normalizedFilename);
          const fileType: 'todo' | 'other' = baseName === 'TODO.md' ? 'todo' : 'other';

          broadcastFileChange({
            filePath: fullPath,
            relativePath: relativeToStorage,
            projectId,
            fileType,
            content,
            updatedAt: stat.mtime.toISOString(),
          });
        } catch (err) {
          console.warn('[Ergo Watcher] Error reading changed file:', err);
        }
      }, 150);
    });
  } catch (err) {
    console.warn('[Ergo Watcher] Could not initialize file watcher:', err);
  }
}

// ── Task references: the `@` file dropdown and the files a task references ──

const FILE_LIST_TTL_MS = 20_000;
const FILE_LIST_MAX = 50_000;
const fileListCache = new Map<string, { at: number; paths: string[]; truncated: boolean }>();

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Files (and the folders holding them, with a trailing "/") under root: git's view when it is a repository, else a bounded walk. */
async function listFolderPaths(root: string): Promise<{ paths: string[]; truncated: boolean }> {
  const cached = fileListCache.get(root);
  if (cached && Date.now() - cached.at < FILE_LIST_TTL_MS) return cached;
  const gitOut = await new Promise<string | null>((resolve) => {
    execFile('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, maxBuffer: 64 * 1024 * 1024, timeout: 15_000 }, (err, stdout) =>
      resolve(err ? null : stdout)
    );
  });
  let files: string[] = [];
  let truncated = false;
  if (gitOut !== null) {
    files = gitOut.split('\0').filter(Boolean);
  } else {
    const walk = async (dir: string, depth: number) => {
      if (depth > 12 || files.length >= FILE_LIST_MAX) return;
      let entries: fsSync.Dirent[];
      try {
        entries = await fs.readdir(path.join(root, dir), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (files.length >= FILE_LIST_MAX) {
          truncated = true;
          return;
        }
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!e.name.startsWith('.') && !SKIP_DIR.test(`${rel}/`)) await walk(rel, depth + 1);
        } else if (e.isFile()) {
          files.push(rel);
        }
      }
    };
    await walk('', 0);
  }
  if (files.length > FILE_LIST_MAX) {
    files = files.slice(0, FILE_LIST_MAX);
    truncated = true;
  }
  const dirs = new Set<string>();
  for (const f of files) {
    for (let i = f.indexOf('/'); i !== -1; i = f.indexOf('/', i + 1)) dirs.add(f.slice(0, i + 1));
  }
  const entry = { at: Date.now(), paths: [...dirs, ...files], truncated };
  fileListCache.set(root, entry);
  return entry;
}

/** Files whose text is never copied into an agent's prompt, even when the task references them. */
const SECRET_FILE_RE = /(^|[\\/])(\.(ssh|gnupg|aws|kube|docker)[\\/]|\.env(\.[^\\/]*)?$|\.netrc$|\.npmrc$|\.pypirc$|id_(rsa|dsa|ecdsa|ed25519)|credentials|secrets?\.json$)|\.(pem|key|p12|pfx|keystore|jks)$/i;
/** An outside file's text is included up to this size. */
const REF_INLINE_MAX_BYTES = 24_000;

async function resolveFileRef(root: string, ref: string) {
  const target = path.resolve(root, expandHome(ref.trim()));
  const rel = path.relative(root, target);
  const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  const out: Record<string, unknown> = { ref, absPath: target, ...(inside ? { relPath: rel.split(path.sep).join('/') || '.' } : {}) };
  let st: fsSync.Stats;
  try {
    st = await fs.stat(target);
  } catch {
    return { ...out, exists: false };
  }
  Object.assign(out, { exists: true, isDirectory: st.isDirectory(), size: st.size });
  if (inside) return out;
  out.outside = true;
  if (st.isDirectory()) return { ...out, note: 'a folder; read what you need from it' };
  if (SECRET_FILE_RE.test(target)) return { ...out, note: 'looks like a credentials file, so Ergo did not copy it into this prompt' };
  if (st.size > REF_INLINE_MAX_BYTES) return { ...out, note: `${Math.round(st.size / 1024)} KB, too large to include; read it yourself if you can` };
  const buf = await fs.readFile(target).catch(() => null);
  if (!buf) return { ...out, note: 'Ergo could not read it' };
  if (buf.subarray(0, 8_000).includes(0)) return { ...out, note: 'a binary file' };
  return { ...out, content: buf.toString('utf-8') };
}

/** The OS's own file dialog, for a bridge without a desktop host (run from a checkout). Paths chosen; [] when cancelled. */
async function pickFilesWithOsDialog(defaultPath: string): Promise<string[]> {
  const runDialog = (cmd: string, args: string[], env: Record<string, string> = {}) =>
    new Promise<{ code: number | null; stdout: string; missing: boolean }>((resolve) => {
      const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'ignore'] });
      let stdout = '';
      child.stdout?.on('data', (c) => (stdout += String(c)));
      child.on('error', (err: any) => resolve({ code: null, stdout: '', missing: err?.code === 'ENOENT' }));
      child.on('close', (code) => resolve({ code, stdout, missing: false }));
    });
  const lines = (s: string) => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (process.platform === 'darwin') {
    const script = [
      'set d to system attribute "ERGO_PICK_DIR"',
      'try',
      'set fs to choose file with prompt "Reference files in this task" default location (POSIX file d) with multiple selections allowed',
      'on error number -128',
      'return ""',
      'end try',
      'set out to ""',
      'repeat with f in fs',
      'set out to out & POSIX path of f & linefeed',
      'end repeat',
      'return out',
    ];
    const r = await runDialog('osascript', script.flatMap((l) => ['-e', l]), { ERGO_PICK_DIR: defaultPath });
    return lines(r.stdout);
  }
  if (process.platform === 'win32') {
    const ps =
      'Add-Type -AssemblyName System.Windows.Forms; $o = New-Object System.Windows.Forms.Form -Property @{TopMost=$true}; ' +
      '$d = New-Object System.Windows.Forms.OpenFileDialog; $d.Multiselect = $true; $d.Title = "Reference files in this task"; ' +
      '$d.InitialDirectory = $env:ERGO_PICK_DIR; if ($d.ShowDialog($o) -eq "OK") { $d.FileNames -join "`n" }';
    const r = await runDialog('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], { ERGO_PICK_DIR: defaultPath });
    return lines(r.stdout);
  }
  const start = defaultPath.endsWith('/') ? defaultPath : `${defaultPath}/`;
  const zenity = await runDialog('zenity', ['--file-selection', '--multiple', '--separator=\n', '--title=Reference files in this task', `--filename=${start}`]);
  if (!zenity.missing) return zenity.code === 0 ? lines(zenity.stdout) : [];
  const kdialog = await runDialog('kdialog', ['--getopenfilename', defaultPath, '--multiple', '--separate-output', '--title', 'Reference files in this task']);
  if (!kdialog.missing) return kdialog.code === 0 ? lines(kdialog.stdout) : [];
  throw new Error('No file dialog is available on this computer (install zenity or kdialog).');
}

/** Files in <storage>/config that /api/config/read|write may touch (model-calibration: Auto mode's learning table). */
const CONFIG_FILE_TYPES = new Set(['settings', 'secrets', 'model-calibration']);

export function ergoFileSystemPlugin(): Plugin {
  const attachMiddleware = (server: { middlewares: { use: Function } }) => {
    const storageDir = getActiveStorageDir();
    // Initialize default ~/.ergo directory on startup
    ensureStorageInitialized(storageDir);
    setupProjectWatcher(storageDir);

    server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: Function) => {
      const url = req.url?.split('?')[0];
      if (!url?.startsWith('/api/')) return next();
      if (!guardBridgeRequest(req, res)) return;
      const storageDir = getActiveStorageDir();

      // ─────────────────────────────────────────────────────────────
      // SSE Real-time File Change Subscription Endpoint
      // ─────────────────────────────────────────────────────────────
      if (url === '/api/files/events' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
        });
        res.write('data: {"type":"connected"}\n\n');
        sseClients.add(res);

        req.on('close', () => {
          sseClients.delete(res);
        });
        return;
      }

      // ─────────────────────────────────────────────────────────────
      // App Storage Directory Config Endpoints
      // ─────────────────────────────────────────────────────────────

      if (url === '/api/storage/config' && req.method === 'GET') {
        return sendJson(res, 200, {
          success: true,
          defaultPath: '~/.ergo',
          activePath: activeStoragePath,
          resolvedPath: storageDir,
          homeDir: os.homedir(),
          // The Ergo checkout `npm run dev` runs from, so the hosted app can show how to start the bridge again.
          appDir: process.cwd(),
          // Protocol, version and update state: the web app asks an older bridge to update (bridgeProtocol.ts).
          bridge: bridgeInfo()
        });
      }

      if (url === '/api/bridge/update' && req.method === 'POST') {
        // Ergo Bridge (desktop) checks and downloads now, then installs once no agent session is running.
        return sendJson(res, 200, { success: true, started: requestBridgeUpdate(), bridge: bridgeInfo() });
      }

      if (url === '/api/storage/config' && req.method === 'POST') {
        try {
          const body = await parseJsonBody(req);
          const newPath = body.path || '~/.ergo';
          activeStoragePath = newPath;
          const resolved = resolveStoragePath(newPath);
          await ensureStorageInitialized(resolved);
          setupProjectWatcher(resolved);

          return sendJson(res, 200, {
            success: true,
            defaultPath: '~/.ergo',
            activePath: activeStoragePath,
            resolvedPath: resolved,
            homeDir: os.homedir()
          });
        } catch (err: any) {
          return sendJson(res, 500, { error: err.message });
        }
      }

      if (url === '/api/files/write' && req.method === 'POST') {
        try {
          const body = await parseJsonBody(req);
          const files: Array<{ filePath: string; content: string }> = body.files || [];

          if (!Array.isArray(files) || files.length === 0) {
            return sendJson(res, 400, { error: 'files must be a non-empty array of { filePath, content }' });
          }

          const writtenFiles: string[] = [];
          const now = Date.now();
          for (const item of files) {
            const check = await resolveInsideAllowedRoots(item.filePath, storageDir);
            if (!check.ok) return sendJson(res, 403, { error: check.error });
            const fullPath = check.fullPath;
            await fs.mkdir(path.dirname(fullPath), { recursive: true });
            await fs.writeFile(fullPath, item.content, 'utf-8');
            writtenFiles.push(item.filePath);
            recentWrites.set(item.filePath, now);
            recentWrites.set(fullPath, now);
          }

          return sendJson(res, 200, {
            success: true,
            savedAt: new Date().toISOString(),
            files: writtenFiles
          });
        } catch (err: any) {
          console.error('[Ergo FS API] Write error:', err);
          return sendJson(res, 500, { error: err.message });
        }
      }

      if (url === '/api/files/write-binary' && req.method === 'POST') {
        try {
          const body = await parseJsonBody(req);
          const { filePath, base64Content } = body;

          if (!filePath || typeof base64Content !== 'string') {
            return sendJson(res, 400, { error: 'filePath and base64Content are required' });
          }

          // Strip data URI prefix if present (e.g. "data:image/png;base64,...")
          const rawBase64 = base64Content.includes(',')
            ? base64Content.split(',')[1]
            : base64Content;

          const check = await resolveInsideAllowedRoots(filePath, storageDir);
          if (!check.ok) return sendJson(res, 403, { error: check.error });
          const buffer = Buffer.from(rawBase64, 'base64');
          const fullPath = check.fullPath;
          await fs.mkdir(path.dirname(fullPath), { recursive: true });
          await fs.writeFile(fullPath, buffer);

          const now = Date.now();
          recentWrites.set(filePath, now);
          recentWrites.set(fullPath, now);

          return sendJson(res, 200, {
            success: true,
            filePath,
            savedAt: new Date().toISOString(),
          });
        } catch (err: any) {
          console.error('[Ergo FS API] Binary write error:', err);
          return sendJson(res, 500, { error: err.message });
        }
      }

      if (url === '/api/files/read' && req.method === 'POST') {
        try {
          const body = await parseJsonBody(req);
          const filePaths: string[] = body.filePaths || [];
          const results: Record<string, string | null> = {};

          for (const fp of filePaths) {
            const check = await resolveInsideAllowedRoots(fp, storageDir);
            if (!check.ok) {
              results[fp] = null;
              continue;
            }
            try {
              const content = await fs.readFile(check.fullPath, 'utf-8');
              results[fp] = content;
            } catch {
              results[fp] = null;
            }
          }

          return sendJson(res, 200, { success: true, files: results });
        } catch (err: any) {
          console.error('[Ergo FS API] Read error:', err);
          return sendJson(res, 500, { error: err.message });
        }
      }

      // Change review (protocol 7): what the agents changed in the approved folders that are git repositories, and
      // an undo per file. The baseline is HEAD, so it also shows edits that were already uncommitted before the run.
      if (url === '/api/git/changes' && req.method === 'POST') {
        try {
          const roots = (await loadAllowedRoots(storageDir)).filter((r) => r !== path.resolve(storageDir));
          const repos: GitChangeRepo[] = [];
          const seen = new Set<string>();
          for (const root of roots) {
            const top = (await gitOut(root, ['rev-parse', '--show-toplevel']))?.trim();
            if (!top || seen.has(top)) continue;
            seen.add(top);
            repos.push({ root: top, files: await listGitChanges(top) });
          }
          return sendJson(res, 200, { success: true, repos: repos.filter((r) => r.files.length > 0) });
        } catch (err: any) {
          return sendJson(res, 500, { error: err.message });
        }
      }

      if (url === '/api/git/revert' && req.method === 'POST') {
        try {
          const body = await parseJsonBody(req);
          const root = path.resolve(String(body.root || ''));
          const files: string[] = Array.isArray(body.files) ? body.files.filter((f: unknown) => typeof f === 'string' && f) : [];
          if (!body.root || files.length === 0) return sendJson(res, 400, { error: 'root and a non-empty files array are required' });
          const check = await resolveInsideAllowedRoots(root, storageDir);
          if (!check.ok) return sendJson(res, 403, { error: check.error });
          const known = new Map((await listGitChanges(root, false)).map((f) => [f.path, f]));
          const reverted: string[] = [];
          const failed: string[] = [];
          for (const rel of files) {
            const change = known.get(rel);
            const full = path.resolve(root, rel);
            if (!change || !full.startsWith(root + path.sep)) {
              failed.push(rel);
              continue;
            }
            try {
              const inHead = (await gitOut(root, ['cat-file', '-e', `HEAD:${rel}`])) !== null;
              if (inHead) {
                await gitRun(root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', rel]);
              } else {
                if (change.status !== 'untracked') await gitRun(root, ['rm', '-r', '-f', '--cached', '--ignore-unmatch', '--', rel]);
                await fs.unlink(full).catch((e: any) => {
                  if (e.code !== 'ENOENT') throw e;
                });
              }
              recentWrites.set(full, Date.now());
              reverted.push(rel);
            } catch {
              failed.push(rel);
            }
          }
          return sendJson(res, 200, { success: failed.length === 0, reverted, failed });
        } catch (err: any) {
          return sendJson(res, 500, { error: err.message });
        }
      }

      if (url === '/api/files/delete' && req.method === 'POST') {
        try {
          const body = await parseJsonBody(req);
          const filePaths: string[] = body.filePaths || (body.filePath ? [body.filePath] : []);

          if (!Array.isArray(filePaths) || filePaths.length === 0) {
            return sendJson(res, 400, { error: 'filePaths must be a non-empty array of strings' });
          }

          const deletedFiles: string[] = [];
          const now = Date.now();
          for (const fp of filePaths) {
            if (!fp) continue;
            const check = await resolveInsideAllowedRoots(fp, storageDir);
            if (!check.ok) return sendJson(res, 403, { error: check.error });
            const fullPath = check.fullPath;
            try {
              await fs.unlink(fullPath);
              deletedFiles.push(fp);
              recentWrites.set(fp, now);
              recentWrites.set(fullPath, now);
            } catch (unlinkErr: any) {
              if (unlinkErr.code !== 'ENOENT') {
                console.warn('[Ergo FS API] Unlink warning for', fullPath, unlinkErr.message);
              }
            }
          }

          return sendJson(res, 200, {
            success: true,
            deletedAt: new Date().toISOString(),
            files: deletedFiles
          });
        } catch (err: any) {
          console.error('[Ergo FS API] Delete error:', err);
          return sendJson(res, 500, { error: err.message });
        }
      }

      if (url === '/api/files/rename' && req.method === 'POST') {
        try {
          const body = await parseJsonBody(req);
          const { oldPath, newPath, content } = body;

          if (!oldPath || !newPath) {
            return sendJson(res, 400, { error: 'oldPath and newPath are required' });
          }

          const oldCheck = await resolveInsideAllowedRoots(oldPath, storageDir);
          if (!oldCheck.ok) return sendJson(res, 403, { error: oldCheck.error });
          const newCheck = await resolveInsideAllowedRoots(newPath, storageDir);
          if (!newCheck.ok) return sendJson(res, 403, { error: newCheck.error });
          const oldFullPath = oldCheck.fullPath;
          const newFullPath = newCheck.fullPath;
          const now = Date.now();

          await fs.mkdir(path.dirname(newFullPath), { recursive: true });

          if (typeof content === 'string') {
            await fs.writeFile(newFullPath, content, 'utf-8');
            if (oldFullPath !== newFullPath) {
              try { await fs.unlink(oldFullPath); } catch {}
            }
          } else {
            if (oldFullPath !== newFullPath) {
              await fs.rename(oldFullPath, newFullPath);
            }
          }

          recentWrites.set(oldPath, now);
          recentWrites.set(oldFullPath, now);
          recentWrites.set(newPath, now);
          recentWrites.set(newFullPath, now);

          return sendJson(res, 200, {
            success: true,
            oldPath,
            newPath
          });
        } catch (err: any) {
          console.error('[Ergo FS API] Rename error:', err);
          return sendJson(res, 500, { error: err.message });
        }
      }

      if (url === '/api/projects/create' && req.method === 'POST') {
        try {
          const body = await parseJsonBody(req);
          const { folderPath, todoContent } = body;

          if (!folderPath) {
            return sendJson(res, 400, { error: 'folderPath is required' });
          }

          const targetDir = path.resolve(storageDir, folderPath);
          await fs.mkdir(targetDir, { recursive: true });
          const todoPath = path.join(targetDir, 'TODO.md');
          await fs.writeFile(todoPath, todoContent || '', 'utf-8');

          const runningJobsPath = path.join(targetDir, 'RUNNING_JOBS.json');
          const initialJobs = {
            version: 1,
            projectId: path.basename(folderPath),
            updatedAt: new Date().toISOString(),
            tasks: Array.isArray(body.initialTasks) ? body.initialTasks : [],
            runningJobs: [],
            queuedTaskIds: [],
            taskExecutionSteps: {}
          };
          await fs.writeFile(runningJobsPath, JSON.stringify(initialJobs, null, 2), 'utf-8');

          return sendJson(res, 200, {
            success: true,
            folderPath,
            todoPath: path.relative(storageDir, todoPath),
            runningJobsPath: path.relative(storageDir, runningJobsPath),
            createdAt: new Date().toISOString()
          });
        } catch (err: any) {
          console.error('[Ergo FS API] Create project error:', err);
          return sendJson(res, 500, { error: err.message });
        }
      }

      if (url === '/api/config/read' && req.method === 'POST') {
        try {
          const body = await parseJsonBody(req);
          const configType = body.type; // 'settings' | 'secrets' | 'model-calibration'
          if (!CONFIG_FILE_TYPES.has(configType)) {
            return sendJson(res, 400, { error: 'type must be "settings", "secrets" or "model-calibration"' });
          }

          const configDir = path.resolve(storageDir, 'config');
          const filePath = path.join(configDir, `${configType}.json`);

          try {
            const content = await fs.readFile(filePath, 'utf-8');
            return sendJson(res, 200, { success: true, data: JSON.parse(content) });
          } catch {
            return sendJson(res, 200, { success: true, data: null });
          }
        } catch (err: any) {
          console.error('[Ergo FS API] Config read error:', err);
          return sendJson(res, 500, { error: err.message });
        }
      }

      if (url === '/api/config/write' && req.method === 'POST') {
        try {
          const body = await parseJsonBody(req);
          const { type: configType, data } = body;
          if (!CONFIG_FILE_TYPES.has(configType)) {
            return sendJson(res, 400, { error: 'type must be "settings", "secrets" or "model-calibration"' });
          }

          const configDir = path.resolve(storageDir, 'config');
          await fs.mkdir(configDir, { recursive: true });
          const filePath = path.join(configDir, `${configType}.json`);
          await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');

          return sendJson(res, 200, {
            success: true,
            type: configType,
            savedAt: new Date().toISOString()
          });
        } catch (err: any) {
          console.error('[Ergo FS API] Config write error:', err);
          return sendJson(res, 500, { error: err.message });
        }
      }

      // ─────────────────────────────────────────────────────────────
      // Skill Document Endpoints (.ergo/config/skills/)
      // ─────────────────────────────────────────────────────────────

      if (url === '/api/skills/read' && req.method === 'POST') {
        try {
          const body = await parseJsonBody(req);
          const skillName = String(body.skillName || 'human-assistant');
          if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(skillName)) return sendJson(res, 400, { error: 'invalid skillName' });
          // `edited`: the copy is the user's own version (else the web app uses its built-in one).
          const { content, filePath, edited } = await syncSkillCopy(storageDir, skillName);
          return sendJson(res, 200, { success: true, skillName, content, filePath: content ? filePath : null, edited });
        } catch (err: any) {
          console.error('[Ergo FS API] Skills read error:', err);
          return sendJson(res, 500, { error: err.message });
        }
      }

      if (url === '/api/skills/write' && req.method === 'POST') {
        try {
          const body = await parseJsonBody(req);
          const skillName = String(body.skillName || '');
          const content = body.content;
          if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(skillName) || typeof content !== 'string') {
            return sendJson(res, 400, { error: 'skillName (letters, digits, -) and content are required' });
          }
          // The user's own version: it differs from the recorded default, so reads report it as edited.
          const target = path.join(storageDir, 'config', 'skills', skillName, 'SKILL.md');
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, content, 'utf-8');
          return sendJson(res, 200, { success: true, skillName, savedAt: new Date().toISOString() });
        } catch (err: any) {
          console.error('[Ergo FS API] Skill write error:', err);
          return sendJson(res, 500, { error: err.message });
        }
      }

      if (url === '/api/projects/list' && req.method === 'GET') {
        try {
          const projectsDir = path.resolve(storageDir, 'projects');
          await fs.mkdir(projectsDir, { recursive: true });
          const entries = await fs.readdir(projectsDir, { withFileTypes: true });

          const projectList: Array<{
            id: string;
            name: string;
            folderPath: string;
            todoFilePath: string;
            todoMarkdown: string;
            runningJobsDoc?: any;
            swimLanes?: Array<{ id: string; title: string; filePath: string; markdown: string }>;
            folders?: ProjectFolder[];
          }> = [];

          for (const entry of entries) {
            if (entry.isDirectory()) {
              const projectDir = path.join(projectsDir, entry.name);
              const projectFiles = await fs.readdir(projectDir, { withFileTypes: true });

              let todoContent = '';
              let hasTodoFile = false;
              const swimLanes: Array<{ id: string; title: string; filePath: string; markdown: string }> = [];

              for (const pf of projectFiles) {
                if (pf.isFile() && pf.name.endsWith('.md')) {
                  const fp = path.join(projectDir, pf.name);
                  const relPath = `projects/${entry.name}/${pf.name}`;
                  try {
                    const content = await fs.readFile(fp, 'utf-8');
                    if (pf.name === 'TODO.md') {
                      todoContent = content;
                      hasTodoFile = true;
                    }

                    // Check for embedded title metadata in comments or headings
                    let title = '';
                    const titleCommentMatch = content.match(/<!--\s*(?:Swimlane Title|Title):\s*(.*?)\s*-->/i);
                    if (titleCommentMatch && titleCommentMatch[1]) {
                      title = titleCommentMatch[1].trim();
                    } else {
                      const h1Match = content.match(/^#\s+(?:.*?\s+)?(.*?)(?:\s+Tasks)?\s*$/m);
                      const h2Match = content.match(/^##\s+(.*?)(?:\s+Tasks)?\s*$/m);
                      if (h1Match && h1Match[1] && pf.name !== 'TODO.md') {
                        title = h1Match[1].trim();
                      } else if (h2Match && h2Match[1] && pf.name !== 'TODO.md') {
                        title = h2Match[1].trim();
                      } else {
                        title = pf.name === 'TODO.md' ? 'Human Workspace' : pf.name.replace(/\.md$/i, '').replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
                      }
                    }

                    swimLanes.push({
                      id: `lane-${pf.name.replace(/\.md$/i, '').toLowerCase()}`,
                      title: title || (pf.name === 'TODO.md' ? 'Human Workspace' : pf.name.replace(/\.md$/i, '')),
                      filePath: relPath,
                      markdown: content
                    });
                  } catch {}
                }
              }

              // If TODO.md didn't exist, create default (an emptied one is the user's, and stays empty)
              if (!hasTodoFile) {
                const todoPath = path.join(projectDir, 'TODO.md');
                todoContent = `# ${entry.name} Tasks:\n\n1. Initial Task Setup:\n    - Define project scope`;
                await fs.writeFile(todoPath, todoContent, 'utf-8');
                swimLanes.unshift({
                  id: 'lane-todo',
                  title: 'Human Workspace',
                  filePath: `projects/${entry.name}/TODO.md`,
                  markdown: todoContent
                });
              }

              // Read or create RUNNING_JOBS.json for persistent AI workspace task & job tracking
              let runningJobsDoc: any = null;
              const runningJobsPath = path.join(projectDir, 'RUNNING_JOBS.json');
              try {
                const jobsRaw = await fs.readFile(runningJobsPath, 'utf-8');
                runningJobsDoc = JSON.parse(jobsRaw);
              } catch {
                runningJobsDoc = {
                  version: 1,
                  projectId: entry.name,
                  updatedAt: new Date().toISOString(),
                  tasks: [],
                  runningJobs: [],
                  queuedTaskIds: [],
                  taskExecutionSteps: {}
                };
                try {
                  await fs.writeFile(runningJobsPath, JSON.stringify(runningJobsDoc, null, 2), 'utf-8');
                } catch {}
              }

              const folders = await loadProjectFolders(storageDir, entry.name);
              projectList.push({
                ...(folders.length > 0 ? { folders } : {}),
                id: entry.name,
                name: entry.name.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
                folderPath: `projects/${entry.name}`,
                todoFilePath: `projects/${entry.name}/TODO.md`,
                todoMarkdown: todoContent,
                runningJobsDoc,
                swimLanes
              });
            }
          }

          return sendJson(res, 200, { success: true, projects: projectList });
        } catch (err: any) {
          console.error('[Ergo FS API] List projects error:', err);
          return sendJson(res, 500, { error: err.message });
        }
      }

      // ─────────────────────────────────────────────────────────────
      // Model Context Protocol (MCP) Host Local Endpoints
      // ─────────────────────────────────────────────────────────────

      // A project's own Allowed Folders (see loadProjectFolders).
      if (url === '/api/projects/folders') {
        const projectId = req.method === 'GET'
          ? new URL(req.url || '', 'http://bridge').searchParams.get('projectId')
          : undefined;
        if (req.method === 'GET') {
          if (!projectFoldersFile(storageDir, projectId)) return sendJson(res, 400, { success: false, error: 'A valid projectId is required.' });
          return sendJson(res, 200, { success: true, folders: await loadProjectFolders(storageDir, projectId) });
        }
        if (req.method === 'POST') {
          try {
            const body = await parseJsonBody(req);
            const file = projectFoldersFile(storageDir, body?.projectId);
            if (!file) return sendJson(res, 400, { success: false, error: 'A valid projectId is required.' });
            const folders: ProjectFolder[] = (Array.isArray(body.folders) ? body.folders : [])
              .filter((f: any) => typeof f?.path === 'string' && f.path.trim())
              .map((f: any) => ({
                id: typeof f.id === 'string' ? f.id : `root-${Date.now()}`,
                path: f.path.trim(),
                name: typeof f.name === 'string' && f.name.trim() ? f.name.trim() : path.basename(f.path.trim()) || 'Folder',
                ...(typeof f.addedAt === 'string' ? { addedAt: f.addedAt } : {}),
              }));
            let existing: any = {};
            try {
              existing = JSON.parse(await fs.readFile(file, 'utf-8'));
            } catch {}
            await fs.mkdir(path.dirname(file), { recursive: true });
            await fs.writeFile(file, JSON.stringify({ ...existing, version: 1, folders }, null, 2), 'utf-8');
            void syncCodeIndexRoots();
            return sendJson(res, 200, { success: true, folders });
          } catch (err: any) {
            return sendJson(res, 500, { success: false, error: err.message });
          }
        }
      }

      if (url === '/api/mcp/roots' && req.method === 'GET') {
        // With ?projectId=: the folders that project's agents may use (its own when it has some).
        const projectId = new URL(req.url || '', 'http://bridge').searchParams.get('projectId');
        const own = projectId ? await loadProjectFolders(storageDir, projectId) : [];
        if (own.length > 0) {
          return sendJson(res, 200, {
            success: true,
            projectOnly: true,
            roots: [{ id: 'root-default', path: storageDir, name: 'Home Ergo Root (~/.ergo)', isDefault: true }, ...own],
          });
        }
        try {
          const configDir = path.resolve(storageDir, 'config');
          const rootsFile = path.join(configDir, 'roots.json');
          let roots = [
            { id: 'root-default', path: storageDir, name: 'Home Ergo Root (~/.ergo)', isDefault: true }
          ];
          try {
            const content = await fs.readFile(rootsFile, 'utf-8');
            const parsed = JSON.parse(content);
            if (Array.isArray(parsed) && parsed.length > 0) {
              roots = parsed;
            }
          } catch {}
          return sendJson(res, 200, { success: true, roots });
        } catch (err: any) {
          return sendJson(res, 500, { error: err.message });
        }
      }

      if (url === '/api/mcp/roots' && req.method === 'POST') {
        try {
          const body = await parseJsonBody(req);
          const roots = body.roots || [];
          const configDir = path.resolve(storageDir, 'config');
          await fs.mkdir(configDir, { recursive: true });
          const rootsFile = path.join(configDir, 'roots.json');
          await fs.writeFile(rootsFile, JSON.stringify(roots, null, 2), 'utf-8');
          void syncCodeIndexRoots(); // a newly added folder starts indexing right away; a removed one is dropped
          return sendJson(res, 200, { success: true, roots });
        } catch (err: any) {
          return sendJson(res, 500, { error: err.message });
        }
      }

      // ─────────────────────────────────────────────────────────────
      // File Open in IDE / System Opener Endpoint
      // ─────────────────────────────────────────────────────────────

      if (url === '/api/files/search' && req.method === 'POST') {
        // The `@` dropdown: files and folders under the task's working folder that match what is typed.
        let body: any = {};
        try {
          body = await parseJsonBody(req);
        } catch {}
        // The same folder an agent launched with this cwd works in.
        const root = typeof body.root === 'string' && body.root.trim() ? resolvePtyCwd(body.root.trim()) : '';
        const query = typeof body.query === 'string' ? body.query.trim().slice(0, 300) : '';
        const limit = Math.max(1, Math.min(100, Math.floor(Number(body.limit) || 40)));
        if (!root || !path.isAbsolute(root)) return sendJson(res, 400, { success: false, error: 'root (absolute) is required.' });
        const st = await fs.stat(root).catch(() => null);
        if (!st?.isDirectory()) return sendJson(res, 200, { success: false, error: `Folder not found: ${root}` });
        const listed = await listFolderPaths(root);
        return sendJson(res, 200, { success: true, root, paths: rankPaths(listed.paths, query, limit), truncated: listed.truncated });
      }

      if (url === '/api/files/pick' && req.method === 'POST') {
        // The `@` dropdown's "Browse…": the computer's own file dialog, for files anywhere.
        let body: any = {};
        try {
          body = await parseJsonBody(req);
        } catch {}
        let defaultPath = typeof body.defaultPath === 'string' ? path.resolve(expandHome(body.defaultPath.trim() || '~')) : os.homedir();
        if (!(await fs.stat(defaultPath).catch(() => null))?.isDirectory()) defaultPath = os.homedir();
        try {
          const picker = hostFilePicker();
          const paths = picker ? await picker({ defaultPath }) : await pickFilesWithOsDialog(defaultPath);
          return sendJson(res, 200, { success: true, paths: paths.filter((p) => path.isAbsolute(p)) });
        } catch (err: any) {
          return sendJson(res, 200, { success: false, error: err?.message || String(err) });
        }
      }

      if (url === '/api/files/refs' && req.method === 'POST') {
        // A task's @ references at run start: where each one is, and the text of small files outside the working folder.
        let body: any = {};
        try {
          body = await parseJsonBody(req);
        } catch {}
        // The same folder an agent launched with this cwd works in.
        const root = typeof body.root === 'string' && body.root.trim() ? resolvePtyCwd(body.root.trim()) : '';
        const refs: string[] = Array.isArray(body.refs) ? body.refs.filter((r: unknown) => typeof r === 'string' && r.trim()).slice(0, 30) : [];
        if (!root) return sendJson(res, 400, { success: false, error: 'root is required.' });
        const files = await Promise.all(refs.map((ref) => resolveFileRef(root, ref)));
        return sendJson(res, 200, { success: true, files });
      }

      if (url === '/api/files/open' && req.method === 'POST') {
        try {
          const body = await parseJsonBody(req);
          const { filePath, line, column, openInIde } = body;
          if (!filePath || typeof filePath !== 'string') {
            return sendJson(res, 400, { error: 'filePath is required' });
          }

          let target = filePath.trim();
          if (target.startsWith('file://')) {
            target = target.replace(/^file:\/\//, '');
          }
          if (target.startsWith('~')) {
            target = path.join(os.homedir(), target.slice(1));
          }
          if (!path.isAbsolute(target)) {
            target = path.resolve(storageDir, target);
          }

          let fileStat: any = null;
          try {
            fileStat = await fs.stat(target);
          } catch {
            return sendJson(res, 404, { error: `File not found: ${filePath}`, resolvedPath: target });
          }

          // Launch without a shell so file names can never be interpreted as commands.
          const { spawn, spawnSync } = await import('child_process');
          const launch = (cmd: string, args: string[]) => {
            const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
            child.on('error', (launchErr) => console.warn(`[Ergo File Open] Could not launch ${cmd}:`, launchErr));
            child.unref();
          };
          const isOnPath = (cmd: string) =>
            spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }).status === 0;
          const lineNum = Number.isInteger(Number(line)) && Number(line) > 0 ? Number(line) : null;
          const colNum = Number.isInteger(Number(column)) && Number(column) > 0 ? Number(column) : null;
          const targetWithLine = lineNum ? `${target}:${lineNum}${colNum ? `:${colNum}` : ''}` : target;
          let opened = false;
          let methodUsed = '';

          const isCodeFile = /\.(ts|tsx|js|jsx|json|py|rs|go|c|cpp|h|css|html|md|toml|yaml|yml|sh|sql)$/i.test(target);
          const ideCommands = ['code', 'cursor', 'webstorm', 'subl', 'gedit', 'kate', 'notepad'];

          if (openInIde || isCodeFile) {
            const ide = ideCommands.find(isOnPath);
            if (ide) {
              const supportsGoto = ide === 'code' || ide === 'cursor';
              launch(ide, supportsGoto && lineNum ? ['-g', targetWithLine] : [target]);
              opened = true;
              methodUsed = ide;
            }
          }

          if (!opened) {
            const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
            launch(opener, [target]);
            opened = true;
            methodUsed = opener;
          }

          return sendJson(res, 200, {
            success: true,
            opened,
            methodUsed,
            filePath,
            resolvedPath: target,
            isDirectory: fileStat.isDirectory()
          });
        } catch (err: any) {
          return sendJson(res, 500, { error: err.message });
        }
      }

      // ── GitHub MCP Integration Endpoints ──
      if (url === '/api/mcp/github/status' && req.method === 'GET') {
        try {
          const secretsPath = path.join(storageDir, 'config', 'secrets.json');
          let mcpSecrets: any = {};
          try {
            const raw = await fs.readFile(secretsPath, 'utf-8');
            mcpSecrets = JSON.parse(raw).mcpSecrets || {};
          } catch {}

          const ghEntry = mcpSecrets['mcp-github'];
          const token = ghEntry?.token || process.env.GITHUB_PERSONAL_ACCESS_TOKEN || process.env.GITHUB_TOKEN;
          if (!token) {
            return sendJson(res, 200, { configured: false });
          }

          return sendJson(res, 200, {
            configured: true,
            username: ghEntry?.username || 'configured',
            name: ghEntry?.name,
            avatarUrl: ghEntry?.avatarUrl,
            scopes: ghEntry?.scopes,
            connectedAt: ghEntry?.connectedAt
          });
        } catch (err: any) {
          return sendJson(res, 500, { error: err.message });
        }
      }

      if (url === '/api/mcp/github/verify' && req.method === 'POST') {
        try {
          const body = await parseJsonBody(req);
          const rawToken = (body.token || '').trim();
          if (!rawToken) {
            return sendJson(res, 400, { error: 'GitHub token is required' });
          }
          const cleanToken = rawToken.replace(/^Bearer\s+/i, '').replace(/^token\s+/i, '');

          const userRes = await fetch('https://api.github.com/user', {
            headers: {
              'Authorization': `Bearer ${cleanToken}`,
              'User-Agent': 'Ergo-MCP/1.0',
              'Accept': 'application/vnd.github.v3+json'
            },
            signal: AbortSignal.timeout(10_000)
          });

          if (!userRes.ok) {
            const errBody: any = await userRes.json().catch(() => ({}));
            return sendJson(res, userRes.status, {
              success: false,
              error: errBody.message ? `GitHub authentication failed: ${errBody.message}` : `GitHub returned status ${userRes.status}`
            });
          }

          const user: any = await userRes.json();
          const scopes = userRes.headers.get('x-oauth-scopes') || '';

          return sendJson(res, 200, {
            success: true,
            user: {
              login: user.login,
              name: user.name,
              avatarUrl: user.avatar_url,
              htmlUrl: user.html_url
            },
            scopes
          });
        } catch (err: any) {
          return sendJson(res, 500, { error: err.message || 'Error verifying GitHub token' });
        }
      }

      if (url === '/api/mcp/github/connect' && req.method === 'POST') {
        try {
          const body = await parseJsonBody(req);
          const rawToken = (body.token || '').trim();
          if (!rawToken) {
            return sendJson(res, 400, { error: 'GitHub token is required' });
          }
          const cleanToken = rawToken.replace(/^Bearer\s+/i, '').replace(/^token\s+/i, '');

          // 1. Validate token with GitHub API
          const userRes = await fetch('https://api.github.com/user', {
            headers: {
              'Authorization': `Bearer ${cleanToken}`,
              'User-Agent': 'Ergo-MCP/1.0',
              'Accept': 'application/vnd.github.v3+json'
            },
            signal: AbortSignal.timeout(10_000)
          });

          if (!userRes.ok) {
            const errBody: any = await userRes.json().catch(() => ({}));
            return sendJson(res, 401, {
              success: false,
              error: errBody.message ? `GitHub authentication failed: ${errBody.message}` : `GitHub returned status ${userRes.status}`
            });
          }

          const user: any = await userRes.json();
          const scopes = userRes.headers.get('x-oauth-scopes') || '';

          // 2. Discover live tools from official GitHub MCP server
          let rawTools: any[] = [];
          try {
            rawTools = await githubMcpClient.listTools(cleanToken);
          } catch (mcpErr: any) {
            console.warn('[Vite MCP API] Error discovering tools from GitHub MCP process:', mcpErr.message);
          }

          const tools = rawTools.map((t: any) => ({
            id: `gh_${t.name}`,
            name: t.name,
            description: t.description,
            autoApprove: t.name.startsWith('search_') || t.name.startsWith('list_') || t.name.startsWith('get_'),
            serverId: 'mcp-github',
            inputSchema: t.inputSchema
          }));

          // 3. Persist to storageDir/config/secrets.json
          const secretsPath = path.join(storageDir, 'config', 'secrets.json');
          let currentSecrets: any = { version: 1, updatedAt: new Date().toISOString(), userApiKeys: [], mcpSecrets: {} };
          try {
            const raw = await fs.readFile(secretsPath, 'utf-8');
            currentSecrets = JSON.parse(raw);
          } catch {}

          if (!currentSecrets.mcpSecrets) currentSecrets.mcpSecrets = {};
          currentSecrets.mcpSecrets['mcp-github'] = {
            token: cleanToken,
            username: user.login,
            name: user.name,
            avatarUrl: user.avatar_url,
            scopes,
            connectedAt: new Date().toISOString()
          };
          currentSecrets.updatedAt = new Date().toISOString();

          await fs.writeFile(secretsPath, JSON.stringify(currentSecrets, null, 2), 'utf-8');

          return sendJson(res, 200, {
            success: true,
            user: {
              login: user.login,
              name: user.name,
              avatarUrl: user.avatar_url,
              htmlUrl: user.html_url
            },
            tools: tools.length > 0 ? tools : undefined
          });
        } catch (err: any) {
          return sendJson(res, 500, { error: err.message || 'Error connecting GitHub MCP' });
        }
      }

      if (url === '/api/mcp/github/disconnect' && req.method === 'POST') {
        try {
          const secretsPath = path.join(storageDir, 'config', 'secrets.json');
          try {
            const raw = await fs.readFile(secretsPath, 'utf-8');
            const secrets = JSON.parse(raw);
            if (secrets.mcpSecrets?.['mcp-github']) {
              delete secrets.mcpSecrets['mcp-github'];
              secrets.updatedAt = new Date().toISOString();
              await fs.writeFile(secretsPath, JSON.stringify(secrets, null, 2), 'utf-8');
            }
          } catch {}

          githubMcpClient.kill();
          return sendJson(res, 200, { success: true });
        } catch (err: any) {
          return sendJson(res, 500, { error: err.message });
        }
      }

      // ── Remote MCP Discovery (tools/list) ──
      if (url === '/api/mcp/remote/discover' && req.method === 'POST') {
        try {
          const body = await parseJsonBody(req);
          const { endpoint, authHeader } = body;
          if (!endpoint || typeof endpoint !== 'string') {
            return sendJson(res, 400, { error: 'endpoint is required' });
          }

          let normalized = endpoint.trim();
          if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
            normalized = `https://${normalized}`;
          }

          const reqHeaders: Record<string, string> = {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream'
          };
          if (authHeader) {
            reqHeaders['Authorization'] = authHeader.trim().startsWith('Bearer ') || authHeader.trim().startsWith('token ')
              ? authHeader.trim()
              : `Bearer ${authHeader.trim()}`;
          }

          // Construct standard MCP JSON-RPC tools/list payload
          const rpcPayload = {
            jsonrpc: '2.0',
            id: `disc-${Date.now()}`,
            method: 'tools/list',
            params: {}
          };

          const timeoutSignal = AbortSignal.timeout(10_000);
          let remoteRes: Response;
          try {
            remoteRes = await fetch(normalized, {
              method: 'POST',
              headers: reqHeaders,
              body: JSON.stringify(rpcPayload),
              signal: timeoutSignal
            });
          } catch (fetchErr: any) {
            // Check if GET returns SSE or capabilities
            try {
              const getRes = await fetch(normalized, {
                method: 'GET',
                headers: reqHeaders,
                signal: AbortSignal.timeout(4000)
              });
              if (getRes.status === 401 || getRes.status === 403) {
                return sendJson(res, 401, {
                  error: 'Endpoint requires authentication credentials (OAuth or API Key).',
                  authRequired: true,
                  status: getRes.status
                });
              }
            } catch {}
            return sendJson(res, 502, {
              error: `Unable to connect to MCP endpoint (${fetchErr.message}). Check URL and network connectivity.`
            });
          }

          if (remoteRes.status === 401 || remoteRes.status === 403) {
            return sendJson(res, 401, {
              error: 'Authentication failed. Please verify your token or re-authenticate.',
              authRequired: true,
              status: remoteRes.status
            });
          }

          if (!remoteRes.ok) {
            return sendJson(res, remoteRes.status, {
              error: `Remote MCP server responded with status HTTP ${remoteRes.status}`
            });
          }

          const resData: any = await remoteRes.json().catch(() => ({}));
          const tools = resData?.result?.tools || resData?.tools || (Array.isArray(resData) ? resData : []);
          const serverInfo = resData?.result?.serverInfo || resData?.serverInfo || { name: new URL(normalized).hostname };

          return sendJson(res, 200, {
            success: true,
            serverInfo,
            tools
          });
        } catch (err: any) {
          return sendJson(res, 500, { error: err.message || 'Error discovering remote MCP endpoint' });
        }
      }

      // ── Universal MCP Tools List (tools/list) ──
      if (url === '/api/mcp/tools/list' && req.method === 'POST') {
        try {
          const body = await parseJsonBody(req);
          const { serverId, endpoint, authHeader } = body;
          if (!serverId && !endpoint) {
            return sendJson(res, 400, { error: 'serverId or endpoint is required' });
          }

          // 1. GitHub MCP
          if (serverId === 'mcp-github') {
            let token = (authHeader || '').trim();
            if (token.startsWith('Bearer ')) token = token.slice(7).trim();
            if (token.startsWith('token ')) token = token.slice(6).trim();
            if (!token) {
              try {
                const secretsPath = path.join(storageDir, 'config', 'secrets.json');
                const rawSecrets = await fs.readFile(secretsPath, 'utf-8');
                const parsed = JSON.parse(rawSecrets);
                token = parsed.mcpSecrets?.['mcp-github']?.token || '';
              } catch {}
            }
            if (!token) {
              token = process.env.GITHUB_PERSONAL_ACCESS_TOKEN || process.env.GITHUB_TOKEN || '';
            }
            if (!token) {
              return sendJson(res, 401, { error: 'GitHub Personal Access Token required to list tools' });
            }

            try {
              const rawTools = await githubMcpClient.listTools(token);
              const tools = rawTools.map((t: any) => ({
                id: `gh_${t.name}`,
                name: t.name,
                description: t.description,
                autoApprove: t.name.startsWith('search_') || t.name.startsWith('list_') || t.name.startsWith('get_'),
                serverId: 'mcp-github',
                inputSchema: t.inputSchema
              }));
              return sendJson(res, 200, { success: true, serverId: 'mcp-github', tools });
            } catch (err: any) {
              return sendJson(res, 502, { error: `Failed to list GitHub MCP tools: ${err.message}` });
            }
          }

          // 2. Bundled Harnesses (filesystem, fetch, git)
          if (serverId === 'mcp-filesystem') {
            const tools = [
              { id: 'fs_read_file', name: 'read_file', description: 'Read a file within allowed directory roots; supports offset/limit line paging for large files', autoApprove: true, serverId: 'mcp-filesystem' },
              { id: 'fs_write_file', name: 'write_file', description: 'Create or overwrite a file on disk within allowed roots', autoApprove: false, serverId: 'mcp-filesystem' },
              { id: 'fs_edit_file', name: 'edit_file', description: 'Replace an exact text span in an existing file (diff-style edit; cheaper than rewriting the whole file)', autoApprove: false, serverId: 'mcp-filesystem' },
              { id: 'fs_list_directory', name: 'list_directory', description: 'List files and subdirectories inside an allowed path', autoApprove: true, serverId: 'mcp-filesystem' },
              { id: 'fs_create_directory', name: 'create_directory', description: 'Create a new directory recursively', autoApprove: true, serverId: 'mcp-filesystem' },
              { id: 'fs_code_search', name: 'code_search', description: 'Semantic + keyword search over the indexed project code (use first to locate code)', autoApprove: true, serverId: 'mcp-filesystem' },
              { id: 'fs_search_files', name: 'search_files', description: 'Search files by filename substring and/or grep file contents with a regex (contentPattern)', autoApprove: true, serverId: 'mcp-filesystem' },
              { id: 'fs_get_file_info', name: 'get_file_info', description: 'Retrieve file metadata (size, modified date, permissions)', autoApprove: true, serverId: 'mcp-filesystem' },
              { id: 'fs_run_command', name: 'run_command', description: 'Run a shell command (tests, lint, build, scripts) inside an allowed folder; returns exit code, stdout and stderr', autoApprove: false, serverId: 'mcp-filesystem' }
            ];
            return sendJson(res, 200, { success: true, serverId: 'mcp-filesystem', tools });
          }

          if (serverId === 'mcp-fetch') {
            const tools = [
              { id: 'fetch_markdown', name: 'fetch_markdown', description: 'Fetch a web page or API and convert content to clean markdown for the AI', autoApprove: true, serverId: 'mcp-fetch' },
              { id: 'fetch_url', name: 'fetch_url', description: 'Fetch raw HTTP response content and headers from a target URL', autoApprove: true, serverId: 'mcp-fetch' }
            ];
            return sendJson(res, 200, { success: true, serverId: 'mcp-fetch', tools });
          }

          if (serverId === 'mcp-git') {
            const tools = [
              { id: 'git_status', name: 'git_status', description: 'Show working tree status and modified files', autoApprove: true, serverId: 'mcp-git' },
              { id: 'git_diff', name: 'git_diff', description: 'Show changes between commits or working tree', autoApprove: true, serverId: 'mcp-git' },
              { id: 'git_log', name: 'git_log', description: 'Show commit history logs and author metadata', autoApprove: true, serverId: 'mcp-git' },
              { id: 'git_commit', name: 'git_commit', description: 'Record changes to the repository with a commit message', autoApprove: false, serverId: 'mcp-git' }
            ];
            return sendJson(res, 200, { success: true, serverId: 'mcp-git', tools });
          }

          // 3. Remote HTTP/SSE MCP Endpoint
          if (endpoint) {
            let normalized = String(endpoint).trim();
            if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
              normalized = `https://${normalized}`;
            }

            const reqHeaders: Record<string, string> = {
              'Content-Type': 'application/json',
              'Accept': 'application/json, text/event-stream'
            };
            if (authHeader) {
              reqHeaders['Authorization'] = authHeader.trim().startsWith('Bearer ') || authHeader.trim().startsWith('token ')
                ? authHeader.trim()
                : `Bearer ${authHeader.trim()}`;
            }

            const rpcPayload = {
              jsonrpc: '2.0',
              id: `tools-list-${Date.now()}`,
              method: 'tools/list',
              params: {}
            };

            const remoteRes = await fetch(normalized, {
              method: 'POST',
              headers: reqHeaders,
              body: JSON.stringify(rpcPayload),
              signal: AbortSignal.timeout(10_000)
            });

            if (!remoteRes.ok) {
              return sendJson(res, remoteRes.status, {
                error: `Remote MCP server returned HTTP ${remoteRes.status}`
              });
            }

            const resData: any = await remoteRes.json().catch(() => ({}));
            const rawTools = resData?.result?.tools || resData?.tools || (Array.isArray(resData) ? resData : []);
            const tools = rawTools.map((t: any, idx: number) => ({
              id: t.name ? `tool-${t.name}-${idx}` : `tool-${idx}`,
              name: t.name || `tool_${idx}`,
              description: t.description || 'Remote MCP Tool',
              autoApprove: false,
              serverId: serverId || 'custom-mcp',
              inputSchema: t.inputSchema || t.schema || undefined
            }));

            return sendJson(res, 200, {
              success: true,
              serverId,
              serverInfo: resData?.result?.serverInfo || resData?.serverInfo,
              tools
            });
          }

          return sendJson(res, 400, { error: `Unable to list tools for server "${serverId}". No handler or endpoint configured.` });
        } catch (err: any) {
          return sendJson(res, 500, { error: err.message || 'Error listing MCP tools' });
        }
      }

      // ── Routine Updates Check for All Connected MCP Servers ──
      if (url === '/api/mcp/check-updates' && req.method === 'POST') {
        try {
          const body = await parseJsonBody(req);
          const servers: Array<{ id: string; endpoint?: string; authHeader?: string; toolsCount?: number }> = Array.isArray(body.servers) ? body.servers : [];

          const updates: Record<string, { success: boolean; tools: any[]; hasChanges?: boolean; error?: string }> = {};

          await Promise.all(
            servers.map(async (server) => {
              try {
                if (server.id === 'mcp-github') {
                  const secretsPath = path.join(storageDir, 'config', 'secrets.json');
                  let token = (server.authHeader || '').trim();
                  if (!token) {
                    try {
                      const raw = await fs.readFile(secretsPath, 'utf-8');
                      token = JSON.parse(raw).mcpSecrets?.['mcp-github']?.token || '';
                    } catch {}
                  }
                  if (!token) token = process.env.GITHUB_PERSONAL_ACCESS_TOKEN || process.env.GITHUB_TOKEN || '';
                  if (!token) {
                    updates[server.id] = { success: false, tools: [], error: 'Not authenticated' };
                    return;
                  }
                  const rawTools = await githubMcpClient.listTools(token);
                  const tools = rawTools.map((t: any) => ({
                    id: `gh_${t.name}`,
                    name: t.name,
                    description: t.description,
                    autoApprove: t.name.startsWith('search_') || t.name.startsWith('list_') || t.name.startsWith('get_'),
                    serverId: 'mcp-github',
                    inputSchema: t.inputSchema
                  }));
                  const hasChanges = server.toolsCount !== undefined && server.toolsCount !== tools.length;
                  updates[server.id] = { success: true, tools, hasChanges };
                  return;
                }

                if (server.id === 'mcp-filesystem' || server.id === 'mcp-fetch' || server.id === 'mcp-git') {
                  // Bundled harness tool specs are deterministic
                  updates[server.id] = { success: true, tools: [], hasChanges: false };
                  return;
                }

                if (server.endpoint) {
                  let normalized = server.endpoint.trim();
                  if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
                    normalized = `https://${normalized}`;
                  }
                  const reqHeaders: Record<string, string> = {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json, text/event-stream'
                  };
                  if (server.authHeader) {
                    reqHeaders['Authorization'] = server.authHeader.trim().startsWith('Bearer ') || server.authHeader.trim().startsWith('token ')
                      ? server.authHeader.trim()
                      : `Bearer ${server.authHeader.trim()}`;
                  }
                  const rpcPayload = { jsonrpc: '2.0', id: `check-${Date.now()}`, method: 'tools/list', params: {} };
                  const remoteRes = await fetch(normalized, {
                    method: 'POST',
                    headers: reqHeaders,
                    body: JSON.stringify(rpcPayload),
                    signal: AbortSignal.timeout(8_000)
                  });
                  if (!remoteRes.ok) {
                    updates[server.id] = { success: false, tools: [], error: `HTTP ${remoteRes.status}` };
                    return;
                  }
                  const resData: any = await remoteRes.json().catch(() => ({}));
                  const rawTools = resData?.result?.tools || resData?.tools || (Array.isArray(resData) ? resData : []);
                  const tools = rawTools.map((t: any, idx: number) => ({
                    id: t.name ? `tool-${t.name}-${idx}` : `tool-${idx}`,
                    name: t.name || `tool_${idx}`,
                    description: t.description || 'Remote MCP Tool',
                    autoApprove: false,
                    serverId: server.id,
                    inputSchema: t.inputSchema || t.schema || undefined
                  }));
                  const hasChanges = server.toolsCount !== undefined && server.toolsCount !== tools.length;
                  updates[server.id] = { success: true, tools, hasChanges };
                  return;
                }

                updates[server.id] = { success: false, tools: [], error: 'Unknown server type' };
              } catch (err: any) {
                updates[server.id] = { success: false, tools: [], error: err.message };
              }
            })
          );

          return sendJson(res, 200, { success: true, updates });
        } catch (err: any) {
          return sendJson(res, 500, { error: err.message || 'Error checking MCP updates' });
        }
      }

      // ── Generic MCP Connect & Authenticate ──
      if (url === '/api/mcp/auth/connect' && req.method === 'POST') {
        try {
          const body = await parseJsonBody(req);
          const { serverId, endpoint, authHeader, serverName } = body;

          if (!serverId) {
            return sendJson(res, 400, { error: 'serverId is required' });
          }

          if (serverId === 'mcp-github') {
            // Forward to GitHub connect logic
            const token = (authHeader || '').trim();
            if (!token) return sendJson(res, 400, { error: 'GitHub token required' });
            const cleanToken = token.replace(/^Bearer\s+/i, '').replace(/^token\s+/i, '');
            const userRes = await fetch('https://api.github.com/user', {
              headers: { 'Authorization': `Bearer ${cleanToken}`, 'User-Agent': 'Ergo-MCP/1.0' },
              signal: AbortSignal.timeout(10_000)
            });
            if (!userRes.ok) {
              return sendJson(res, 401, { error: `GitHub auth failed (HTTP ${userRes.status})` });
            }
            const user: any = await userRes.json();
            const rawTools = await githubMcpClient.listTools(cleanToken);
            const tools = rawTools.map((t: any) => ({
              id: `gh_${t.name}`,
              name: t.name,
              description: t.description,
              autoApprove: t.name.startsWith('search_') || t.name.startsWith('list_') || t.name.startsWith('get_'),
              serverId: 'mcp-github',
              inputSchema: t.inputSchema
            }));

            // Persist to secrets
            const secretsPath = path.join(storageDir, 'config', 'secrets.json');
            let currentSecrets: any = { version: 1, updatedAt: new Date().toISOString(), userApiKeys: [], mcpSecrets: {} };
            try {
              currentSecrets = JSON.parse(await fs.readFile(secretsPath, 'utf-8'));
            } catch {}
            if (!currentSecrets.mcpSecrets) currentSecrets.mcpSecrets = {};
            currentSecrets.mcpSecrets['mcp-github'] = {
              token: cleanToken,
              username: user.login,
              name: user.name,
              avatarUrl: user.avatar_url,
              connectedAt: new Date().toISOString()
            };
            currentSecrets.updatedAt = new Date().toISOString();
            await fs.writeFile(secretsPath, JSON.stringify(currentSecrets, null, 2), 'utf-8');

            return sendJson(res, 200, { success: true, serverId: 'mcp-github', tools, user });
          }

          if (endpoint) {
            let normalized = String(endpoint).trim();
            if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
              normalized = `https://${normalized}`;
            }

            const reqHeaders: Record<string, string> = {
              'Content-Type': 'application/json',
              'Accept': 'application/json, text/event-stream'
            };
            if (authHeader) {
              reqHeaders['Authorization'] = authHeader.trim().startsWith('Bearer ') || authHeader.trim().startsWith('token ')
                ? authHeader.trim()
                : `Bearer ${authHeader.trim()}`;
            }

            const rpcPayload = { jsonrpc: '2.0', id: `auth-connect-${Date.now()}`, method: 'tools/list', params: {} };
            const remoteRes = await fetch(normalized, {
              method: 'POST',
              headers: reqHeaders,
              body: JSON.stringify(rpcPayload),
              signal: AbortSignal.timeout(10_000)
            });

            if (remoteRes.status === 401 || remoteRes.status === 403) {
              return sendJson(res, 401, { error: 'Authentication failed. Please verify credentials or token.' });
            }
            if (!remoteRes.ok) {
              return sendJson(res, remoteRes.status, { error: `Server responded with status HTTP ${remoteRes.status}` });
            }

            const resData: any = await remoteRes.json().catch(() => ({}));
            const rawTools = resData?.result?.tools || resData?.tools || (Array.isArray(resData) ? resData : []);
            const tools = rawTools.map((t: any, idx: number) => ({
              id: t.name ? `tool-${t.name}-${idx}` : `tool-${idx}`,
              name: t.name || `tool_${idx}`,
              description: t.description || 'Remote MCP Tool',
              autoApprove: false,
              serverId,
              inputSchema: t.inputSchema || t.schema || undefined
            }));

            // Persist authHeader to secrets if provided
            if (authHeader) {
              try {
                const secretsPath = path.join(storageDir, 'config', 'secrets.json');
                let currentSecrets: any = { version: 1, updatedAt: new Date().toISOString(), userApiKeys: [], mcpSecrets: {} };
                try {
                  currentSecrets = JSON.parse(await fs.readFile(secretsPath, 'utf-8'));
                } catch {}
                if (!currentSecrets.mcpSecrets) currentSecrets.mcpSecrets = {};
                currentSecrets.mcpSecrets[serverId] = {
                  token: authHeader.trim(),
                  endpoint: normalized,
                  serverName: serverName || serverId,
                  connectedAt: new Date().toISOString()
                };
                currentSecrets.updatedAt = new Date().toISOString();
                await fs.writeFile(secretsPath, JSON.stringify(currentSecrets, null, 2), 'utf-8');
              } catch {}
            }

            return sendJson(res, 200, {
              success: true,
              serverId,
              serverInfo: resData?.result?.serverInfo || resData?.serverInfo,
              tools
            });
          }

          return sendJson(res, 400, { error: `Missing endpoint or unsupported serverId "${serverId}"` });
        } catch (err: any) {
          return sendJson(res, 500, { error: err.message || 'Error connecting MCP server' });
        }
      }

      if (url === '/api/mcp/tools/call' && req.method === 'POST') {
        try {
          const body = await parseJsonBody(req);
          const { serverId, toolName, args, endpoint, authHeader } = body;
          // The project the call is made for: one with its own Allowed Folders is held to those.
          const projectId = typeof body.projectId === 'string' ? body.projectId : undefined;

          if (!toolName) {
            return sendJson(res, 400, { error: 'toolName is required' });
          }

          // 1. Filesystem + Shell MCP Harness (root-sandboxed)
          const FS_TOOLS = new Set(['code_search', 'read_file', 'write_file', 'edit_file', 'list_directory', 'create_directory', 'search_files', 'get_file_info', 'run_command']);
          if (serverId === 'mcp-filesystem' || FS_TOOLS.has(toolName)) {
            if (toolName === 'code_search') {
              const query = typeof args?.query === 'string' ? args.query.trim().slice(0, 2_000) : '';
              if (!query) return sendJson(res, 400, { error: 'code_search requires "query".' });
              // A project with its own folders searches its working folder (the first) unless told otherwise.
              const ownFolder = (await loadProjectFolders(storageDir, projectId))[0];
              const out = await codeSearch(query, { path: typeof args.path === 'string' ? args.path : undefined, ...(ownFolder ? { cwd: resolveRootPath(ownFolder.path) } : {}), k: Number(args.k) || undefined, files: args.files });
              if (out.isError) return sendJson(res, 400, { error: out.text });
              return sendJson(res, 200, { success: true, data: { content: out.text } }); // plain text for the agent, not JSON
            }
            // ── run_command: shell inside an allowed root ──
            if (toolName === 'run_command') {
              const command = typeof args.command === 'string' ? args.command.trim() : '';
              if (!command) return sendJson(res, 400, { error: 'run_command requires a non-empty "command" string.' });
              const cwdCheck = await resolveInsideAllowedRoots(typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd : storageDir, storageDir, projectId);
              if ('error' in cwdCheck) return sendJson(res, 403, { error: cwdCheck.error });
              try {
                const st = await fs.stat(cwdCheck.fullPath);
                if (!st.isDirectory()) return sendJson(res, 400, { error: `cwd "${args.cwd}" is not a directory.` });
              } catch {
                return sendJson(res, 404, { error: `cwd "${args.cwd}" does not exist.` });
              }
              const requested = typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : 60_000;
              const timeoutMs = Math.min(requested, 300_000);
              const result = await runShellCommand(command, cwdCheck.fullPath, timeoutMs);
              const out = capText(result.stdout, 20_000);
              const errOut = capText(result.stderr, 20_000);
              return sendJson(res, 200, {
                success: true,
                data: {
                  command,
                  cwd: cwdCheck.fullPath,
                  exitCode: result.exitCode,
                  stdout: out.text,
                  stderr: errOut.text,
                  timedOut: result.timedOut,
                  durationMs: result.durationMs
                }
              });
            }

            const targetPath = (args.path || args.filePath || '').trim();
            if (!targetPath) return sendJson(res, 400, { error: `${toolName} requires a "path" argument.` });
            const check = await resolveInsideAllowedRoots(targetPath, storageDir, projectId);
            if ('error' in check) return sendJson(res, 403, { error: check.error });
            const fullPath = check.fullPath;

            if (toolName === 'read_file') {
              let stat;
              try {
                stat = await fs.stat(fullPath);
              } catch {
                return sendJson(res, 404, { error: `File not found: ${targetPath}` });
              }
              if (stat.isDirectory()) return sendJson(res, 400, { error: `"${targetPath}" is a directory — use list_directory instead.` });
              if (stat.size > 5 * 1024 * 1024) return sendJson(res, 400, { error: `"${targetPath}" is ${stat.size} bytes (> 5 MB). Use get_file_info or search_files with contentPattern instead of reading it whole.` });
              const buf = await fs.readFile(fullPath);
              if (looksBinary(buf)) return sendJson(res, 400, { error: `"${targetPath}" looks like a binary file. Use get_file_info for metadata instead.` });
              const allLines = buf.toString('utf-8').split('\n');
              const totalLines = allLines.length;
              const offset = typeof args.offset === 'number' && args.offset > 0 ? Math.floor(args.offset) : 1;
              const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : totalLines;
              const startLine = Math.min(offset, Math.max(totalLines, 1));
              const endLine = Math.min(startLine + limit - 1, totalLines);
              let content = allLines.slice(startLine - 1, endLine).join('\n');
              let truncated = endLine < totalLines || startLine > 1;
              const MAX_CHARS = 60_000;
              if (content.length > MAX_CHARS) {
                content = content.slice(0, MAX_CHARS) + `\n[truncated at ${MAX_CHARS} chars — call read_file again with offset/limit to read the rest]`;
                truncated = true;
              }
              return sendJson(res, 200, { success: true, data: { content, path: targetPath, totalLines, startLine, endLine, truncated } });
            }

            if (toolName === 'write_file') {
              const content = typeof args.content === 'string' ? args.content : '';
              await writeDeliverable(fullPath, content);
              const now = Date.now();
              recentWrites.set(targetPath, now);
              recentWrites.set(fullPath, now);
              return sendJson(res, 200, { success: true, data: { path: targetPath, bytes: Buffer.byteLength(content, 'utf-8'), writtenAt: new Date().toISOString() } });
            }

            if (toolName === 'edit_file') {
              const oldString = typeof args.old_string === 'string' ? args.old_string : '';
              const newString = typeof args.new_string === 'string' ? args.new_string : '';
              const replaceAll = args.replace_all === true;
              if (!oldString) return sendJson(res, 400, { error: 'edit_file requires a non-empty "old_string" (the exact text to replace). To create a new file use write_file.' });
              let existing: string;
              try {
                existing = await fs.readFile(fullPath, 'utf-8');
              } catch {
                return sendJson(res, 404, { error: `File not found: ${targetPath}. edit_file only modifies existing files — use write_file to create it.` });
              }
              const occurrences = existing.split(oldString).length - 1;
              if (occurrences === 0) {
                return sendJson(res, 409, { error: `old_string not found in ${targetPath} — read the file first (read_file) and copy the exact text, including whitespace and indentation.` });
              }
              if (occurrences > 1 && !replaceAll) {
                return sendJson(res, 409, { error: `old_string matches ${occurrences} places in ${targetPath}. Include more surrounding lines so it is unique, or pass replace_all: true to replace every occurrence.` });
              }
              const updated = replaceAll ? existing.split(oldString).join(newString) : existing.replace(oldString, newString);
              await writeDeliverable(fullPath, updated);
              const idx = updated.indexOf(newString);
              const previewStart = Math.max(0, idx - 100);
              const preview = updated.slice(previewStart, Math.min(updated.length, idx + newString.length + 100));
              recentWrites.set(fullPath, Date.now());
              return sendJson(res, 200, { success: true, data: { path: targetPath, replacements: replaceAll ? occurrences : 1, preview } });
            }

            if (toolName === 'list_directory') {
              try {
                const entries = await fs.readdir(fullPath, { withFileTypes: true });
                const items = entries.map((e) => ({
                  name: e.name,
                  isDirectory: e.isDirectory(),
                  isFile: e.isFile()
                }));
                return sendJson(res, 200, { success: true, data: { path: targetPath, entries: items } });
              } catch {
                return sendJson(res, 404, { error: `Directory not found: ${targetPath}` });
              }
            }

            if (toolName === 'create_directory') {
              await fs.mkdir(fullPath, { recursive: true });
              return sendJson(res, 200, { success: true, data: { path: targetPath, created: true } });
            }

            if (toolName === 'get_file_info') {
              try {
                const stat = await fs.stat(fullPath);
                return sendJson(res, 200, {
                  success: true,
                  data: {
                    path: targetPath,
                    sizeBytes: stat.size,
                    isDirectory: stat.isDirectory(),
                    isFile: stat.isFile(),
                    modifiedAt: stat.mtime.toISOString()
                  }
                });
              } catch {
                return sendJson(res, 404, { error: `File not found: ${targetPath}` });
              }
            }

            if (toolName === 'search_files') {
              const query = typeof (args.query ?? args.pattern) === 'string' ? String(args.query ?? args.pattern).toLowerCase() : '';
              const contentPatternRaw = typeof args.contentPattern === 'string' ? args.contentPattern : '';
              const maxResults = Math.min(typeof args.maxResults === 'number' && args.maxResults > 0 ? Math.floor(args.maxResults) : 50, 200);
              let contentRegex: RegExp | null = null;
              if (contentPatternRaw) {
                try {
                  contentRegex = new RegExp(contentPatternRaw, 'i');
                } catch (e: any) {
                  return sendJson(res, 400, { error: `Invalid contentPattern regex: ${e.message}` });
                }
              }
              if (!query && !contentRegex) return sendJson(res, 400, { error: 'search_files requires "query" (filename substring) and/or "contentPattern" (regex).' });
              try {
                const st = await fs.stat(fullPath);
                if (!st.isDirectory()) return sendJson(res, 400, { error: `"${targetPath}" is not a directory.` });
              } catch {
                return sendJson(res, 404, { error: `Directory not found: ${targetPath}` });
              }

              const matched: string[] = [];
              const contentMatches: Array<{ path: string; line: number; text: string }> = [];
              let truncated = false;
              const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage']);

              async function walk(dir: string) {
                if (truncated) return;
                let files;
                try {
                  files = await fs.readdir(dir, { withFileTypes: true });
                } catch {
                  return;
                }
                for (const file of files) {
                  if (truncated) return;
                  if (SKIP_DIRS.has(file.name)) continue;
                  const resolved = path.join(dir, file.name);
                  const rel = path.relative(fullPath, resolved) || file.name;
                  if (file.isDirectory()) {
                    await walk(resolved);
                    continue;
                  }
                  if (!file.isFile()) continue;
                  if (query && file.name.toLowerCase().includes(query)) {
                    matched.push(rel);
                    if (matched.length >= maxResults) truncated = true;
                  }
                  if (contentRegex) {
                    try {
                      const st = await fs.stat(resolved);
                      if (st.size > 2 * 1024 * 1024) continue;
                      const buf = await fs.readFile(resolved);
                      if (looksBinary(buf)) continue;
                      const lines = buf.toString('utf-8').split('\n');
                      for (let i = 0; i < lines.length; i++) {
                        if (contentRegex.test(lines[i])) {
                          contentMatches.push({ path: rel, line: i + 1, text: lines[i].trim().slice(0, 200) });
                          if (contentMatches.length >= maxResults) { truncated = true; break; }
                        }
                      }
                    } catch {}
                  }
                }
              }

              await walk(fullPath);
              return sendJson(res, 200, { success: true, data: { root: targetPath, query: query || undefined, contentPattern: contentPatternRaw || undefined, matched, contentMatches, truncated } });
            }

            return sendJson(res, 400, { error: `Unknown filesystem tool "${toolName}".` });
          }

          // 2. Fetch / Web MCP Harness
          if (serverId === 'mcp-fetch' || toolName === 'fetch_url' || toolName === 'fetch_markdown') {
            const targetUrl = args.url;
            if (!targetUrl) {
              return sendJson(res, 400, { error: 'url argument is required' });
            }

            try {
              const fetchRes = await fetch(targetUrl, {
                headers: { 'User-Agent': 'Ergo-Agent-MCP/1.0' }
              });
              const rawText = await fetchRes.text();

              if (toolName === 'fetch_markdown') {
                // Simple clean HTML -> Markdown conversion
                const markdown = rawText
                  .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
                  .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
                  .replace(/<h1[^>]*>(.*?)<\/h1>/gi, '\n# $1\n')
                  .replace(/<h2[^>]*>(.*?)<\/h2>/gi, '\n## $1\n')
                  .replace(/<h3[^>]*>(.*?)<\/h3>/gi, '\n### $1\n')
                  .replace(/<p[^>]*>(.*?)<\/p>/gi, '\n$1\n')
                  .replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n')
                  .replace(/<a\s+(?:[^>]*?\s+)?href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)')
                  .replace(/<[^>]+>/g, '')
                  .replace(/\n\s*\n\s*\n/g, '\n\n')
                  .trim();

                return sendJson(res, 200, {
                  success: true,
                  data: {
                    url: targetUrl,
                    status: fetchRes.status,
                    contentType: fetchRes.headers.get('content-type'),
                    markdown: markdown.slice(0, 15000)
                  }
                });
              }

              return sendJson(res, 200, {
                success: true,
                data: {
                  url: targetUrl,
                  status: fetchRes.status,
                  content: rawText.slice(0, 15000)
                }
              });
            } catch (err: any) {
              return sendJson(res, 500, { error: `Failed to fetch URL: ${err.message}` });
            }
          }

          // 3. Git Operations MCP Harness (cwd must be inside an allowed root; defaults to the storage dir)
          if (serverId === 'mcp-git' || toolName.startsWith('git_')) {
            const cwdCheck = await resolveInsideAllowedRoots(typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd : storageDir, storageDir, projectId);
            if ('error' in cwdCheck) return sendJson(res, 403, { error: cwdCheck.error });

            const shellQuote = (v: string) => `'${String(v).replace(/'/g, `'\\''`)}'`;
            let gitCommand = 'git status --short';
            if (toolName === 'git_status') gitCommand = 'git status --short --branch';
            if (toolName === 'git_diff') gitCommand = `git diff -U2${typeof args.path === 'string' && args.path.trim() ? ' -- ' + shellQuote(args.path.trim()) : ''}`;
            if (toolName === 'git_log') {
              const count = Math.min(typeof args.count === 'number' && args.count > 0 ? Math.floor(args.count) : 10, 50);
              gitCommand = `git log -n ${count} --oneline`;
            }
            if (toolName === 'git_commit') {
              const msg = typeof args.message === 'string' ? args.message.trim() : '';
              if (!msg) return sendJson(res, 400, { error: 'git_commit requires a non-empty "message".' });
              gitCommand = `git commit -m ${shellQuote(msg)}`;
            }

            const result = await runShellCommand(gitCommand, cwdCheck.fullPath, 60_000);
            const output = capText((result.stdout || '') + (result.stderr ? (result.stdout ? '\n' : '') + result.stderr : ''), 20_000);
            return sendJson(res, 200, {
              success: true,
              data: {
                command: gitCommand,
                cwd: cwdCheck.fullPath,
                exitCode: result.exitCode,
                output: output.text.trim()
              }
            });
          }

          // 4. GitHub MCP Stdio Runner
          const GITHUB_TOOLS = new Set([
            'create_or_update_file', 'search_repositories', 'create_repository', 'get_file_contents',
            'push_files', 'create_issue', 'create_pull_request', 'fork_repository', 'create_branch',
            'list_commits', 'list_issues', 'update_issue', 'add_issue_comment', 'search_code',
            'search_issues', 'search_users', 'get_issue', 'get_pull_request', 'list_pull_requests',
            'create_pull_request_review', 'merge_pull_request', 'get_pull_request_files',
            'get_pull_request_status', 'update_pull_request_branch', 'get_pull_request_comments',
            'get_pull_request_reviews'
          ]);

          if (serverId === 'mcp-github' || GITHUB_TOOLS.has(toolName)) {
            let token = (authHeader || '').trim();
            if (token.startsWith('Bearer ')) token = token.slice(7).trim();
            if (token.startsWith('token ')) token = token.slice(6).trim();

            if (!token) {
              try {
                const secretsPath = path.join(storageDir, 'config', 'secrets.json');
                const rawSecrets = await fs.readFile(secretsPath, 'utf-8');
                const parsed = JSON.parse(rawSecrets);
                token = parsed.mcpSecrets?.['mcp-github']?.token || '';
              } catch {}
            }
            if (!token) {
              token = process.env.GITHUB_PERSONAL_ACCESS_TOKEN || process.env.GITHUB_TOKEN || '';
            }

            if (!token) {
              return sendJson(res, 401, {
                error: 'GitHub Personal Access Token is required to execute GitHub MCP tools. Connect GitHub in the MCP Hub to authenticate.'
              });
            }

            try {
              const toolResult = await githubMcpClient.callTool(token, toolName, args || {});
              const payload = toolResult?.content !== undefined ? toolResult.content : toolResult;
              return sendJson(res, 200, {
                success: true,
                data: payload
              });
            } catch (err: any) {
              return sendJson(res, 502, {
                error: `GitHub MCP execution error: ${err.message}`
              });
            }
          }

          // 5. Remote MCP Endpoint Forwarding
          if (endpoint && typeof endpoint === 'string' && (endpoint.startsWith('http://') || endpoint.startsWith('https://'))) {
            try {
              const reqHeaders: Record<string, string> = {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream'
              };
              if (authHeader) {
                reqHeaders['Authorization'] = authHeader.trim().startsWith('Bearer ') || authHeader.trim().startsWith('token ')
                  ? authHeader.trim()
                  : `Bearer ${authHeader.trim()}`;
              }

              const rpcCall = {
                jsonrpc: '2.0',
                id: `call-${Date.now()}`,
                method: 'tools/call',
                params: {
                  name: toolName,
                  arguments: args || {}
                }
              };

              const remoteRes = await fetch(endpoint, {
                method: 'POST',
                headers: reqHeaders,
                body: JSON.stringify(rpcCall),
                signal: AbortSignal.timeout(30_000)
              });

              if (!remoteRes.ok) {
                const errText = await remoteRes.text().catch(() => '');
                return sendJson(res, remoteRes.status, {
                  error: `Remote MCP server (${serverId}) returned error HTTP ${remoteRes.status}: ${errText.slice(0, 300)}`
                });
              }

              const remoteData: any = await remoteRes.json().catch(() => ({}));
              if (remoteData?.error) {
                return sendJson(res, 400, {
                  error: remoteData.error.message || `Remote MCP tool error: ${JSON.stringify(remoteData.error)}`
                });
              }

              // Return the inner result.content array or structured data
              const resultPayload = remoteData?.result !== undefined ? remoteData.result : remoteData;
              return sendJson(res, 200, {
                success: true,
                data: resultPayload
              });
            } catch (remoteErr: any) {
              return sendJson(res, 502, {
                error: `Failed to dispatch tool "${toolName}" to remote MCP at ${endpoint}: ${remoteErr.message}`
              });
            }
          }

          // Default fallback tool execution response
          return sendJson(res, 200, {
            success: true,
            data: {
              serverId,
              toolName,
              args,
              executedAt: new Date().toISOString(),
              result: `Executed tool ${toolName} on server ${serverId}`
            }
          });
        } catch (err: any) {
          console.error('[Ergo MCP API] Tool call error:', err);
          return sendJson(res, 500, { error: err.message });
        }
      }

      // ─────────────────────────────────────────────────────────────
      // CLI Coding Agent Bridge Endpoints
      // ─────────────────────────────────────────────────────────────

      if (url === '/api/cli/detect' && req.method === 'GET') {
        try {
          const cliPresets = [
            {
              id: 'claude-code',
              name: 'Claude Code',
              command: 'claude',
              provider: 'anthropic',
              subscriptionTier: 'Claude Pro / Team / Enterprise',
              installCommand: CLAUDE_INSTALL_COMMAND,
              loginCommand: 'claude login',
              loginArgs: ['login'],
              docsUrl: 'https://docs.anthropic.com/claude/docs/claude-code',
              badgeColor: '#d97706',
              supportsHeadless: true,
              supportsInteractive: true
            },
            {
              id: 'codex',
              name: 'OpenAI Codex CLI',
              command: 'codex',
              provider: 'openai',
              subscriptionTier: 'ChatGPT Plus / Team / Pro',
              installCommand: 'npm install -g @openai/codex',
              loginCommand: 'codex login',
              loginArgs: ['login'],
              docsUrl: 'https://github.com/openai/codex',
              badgeColor: '#7c3aed',
              supportsHeadless: true,
              supportsInteractive: true
            },
            {
              id: 'antigravity',
              name: 'Antigravity CLI (agy)',
              command: 'agy',
              provider: 'gemini',
              subscriptionTier: 'Google Antigravity / Gemini Code Assist',
              installCommand: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
              loginCommand: 'agy',
              loginArgs: [],
              docsUrl: 'https://antigravity.google',
              badgeColor: '#2563eb',
              supportsHeadless: true,
              supportsInteractive: true
            },
            {
              id: 'cursor-cli',
              name: 'Cursor CLI',
              command: 'cursor',
              provider: 'cursor',
              subscriptionTier: 'Cursor Pro / Business',
              installCommand: 'curl -fsSL https://cursor.com/install.sh | bash',
              loginCommand: 'cursor login',
              loginArgs: ['login'],
              docsUrl: 'https://cursor.com',
              badgeColor: '#0066FF',
              supportsHeadless: true,
              supportsInteractive: true
            },
            {
              id: 'grok-cli',
              name: 'Grok CLI (grok)',
              command: 'grok',
              provider: 'grok',
              subscriptionTier: 'X Premium+ / SuperGrok',
              installCommand: 'npm install -g grok-cli',
              loginCommand: 'grok login',
              loginArgs: ['login'],
              docsUrl: 'https://x.ai',
              badgeColor: '#1d9bf0',
              supportsHeadless: true,
              supportsInteractive: true
            },
            {
              id: 'aider',
              name: 'Aider CLI',
              command: 'aider',
              provider: 'ollama',
              subscriptionTier: 'Local Pair Programming / Ollama',
              installCommand: 'pip install aider-chat',
              loginCommand: 'aider',
              loginArgs: [],
              docsUrl: 'https://aider.chat',
              badgeColor: '#059669',
              supportsHeadless: true,
              supportsInteractive: true
            }
          ];

          const fullUrl = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
          const customCmd = fullUrl.searchParams.get('customCommand')?.trim();

          const results = [];
          for (const preset of cliPresets) {
            let whichRes = await runShellCommand(`${FIND_ON_PATH} ${preset.command}`, storageDir, 3000);
            if (whichRes.exitCode !== 0 && preset.command === 'agy') {
              const localAgy = path.join(os.homedir(), '.local', 'bin', 'agy');
              if (fsSync.existsSync(localAgy)) {
                whichRes = { exitCode: 0, stdout: localAgy, stderr: '', timedOut: false, durationMs: 0 };
              }
            }
            const isInstalled = whichRes.exitCode === 0 && Boolean(whichRes.stdout.trim());
            const detectedPath = isInstalled ? whichRes.stdout.trim().split(/\r?\n/)[0] : null;
            let version: string | null = null;
            if (isInstalled) {
              const verCmd = preset.command === 'agy' && detectedPath ? `${detectedPath} --version` : `${preset.command} --version`;
              const verRes = await runShellCommand(verCmd, storageDir, 3000);
              if (verRes.exitCode === 0 && verRes.stdout.trim()) {
                version = verRes.stdout.trim().split('\n')[0].slice(0, 50);
              }
            }
            results.push({
              ...preset,
              isInstalled,
              detectedPath,
              version
            });
          }

          let customResult = null;
          if (customCmd && !isSafeCommandName(customCmd)) {
            return sendJson(res, 400, { error: 'Invalid custom command name' });
          }
          if (customCmd) {
            const whichRes = await runShellCommand(`${FIND_ON_PATH} ${customCmd}`, storageDir, 3000);
            const isInstalled = whichRes.exitCode === 0 && Boolean(whichRes.stdout.trim());
            const detectedPath = isInstalled ? whichRes.stdout.trim().split(/\r?\n/)[0] : null;
            let version: string | null = null;
            if (isInstalled) {
              const verRes = await runShellCommand(`${customCmd} --version`, storageDir, 3000);
              if (verRes.exitCode === 0 && verRes.stdout.trim()) {
                version = verRes.stdout.trim().split('\n')[0].slice(0, 50);
              }
            }
            customResult = {
              id: 'custom',
              name: 'Custom CLI',
              command: customCmd,
              provider: 'anthropic',
              subscriptionTier: 'Custom Subscription',
              installCommand: '',
              docsUrl: '',
              badgeColor: '#6366f1',
              supportsHeadless: true,
              supportsInteractive: true,
              isInstalled,
              detectedPath,
              version
            };
          }

          return sendJson(res, 200, {
            success: true,
            agents: results,
            custom: customResult
          });
        } catch (err: any) {
          return sendJson(res, 500, { error: err.message });
        }
      }

      if (url === '/api/cli/execute' && req.method === 'POST') {
        try {
          const body = await parseJsonBody(req);
          const { cli = 'claude', prompt, systemPrompt, cwd, args, timeoutMs, env, model, effort, permissionLevel, mode } = body;

          if (!prompt || typeof prompt !== 'string') {
            return sendJson(res, 400, { error: 'prompt is required and must be a string' });
          }

          // Boundary check for cwd
          const rawCwd = cwd || storageDir;
          const cwdCheck = await resolveInsideAllowedRoots(rawCwd, storageDir);
          const executionCwd = cwdCheck.ok ? cwdCheck.fullPath : storageDir;

          const result = await runCliProcess({
            cli,
            prompt,
            systemPrompt,
            cwd: executionCwd,
            customArgs: args,
            timeoutMs: typeof timeoutMs === 'number' ? timeoutMs : 180_000,
            env,
            model,
            effort: asEffort(effort),
            permissionLevel: asPermission(permissionLevel),
            completion: mode === 'completion',
            req
          });

          return sendJson(res, 200, {
            success: result.exitCode === 0,
            output: result.output !== undefined ? result.output : result.stdout.trim(),
            usage: result.usage || null,
            stderr: result.stderr.trim(),
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            durationMs: result.durationMs,
            command: cli
          });
        } catch (err: any) {
          console.error('[Ergo CLI API] Execute error:', err);
          return sendJson(res, 500, { error: err.message });
        }
      }

      // The subscription plan's usage limits as the CLI last saw them (Claude Code caches them in ~/.claude.json).
      // Percentages only: plans don't publish their size, so a single task's share can't be computed.
      if (url === '/api/cli/plan-usage' && req.method === 'GET') {
        const fullUrl = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
        const cli = fullUrl.searchParams.get('cli')?.trim() || 'claude';
        if (cli !== 'claude') return sendJson(res, 200, { cli, available: false });
        try {
          const raw = JSON.parse(await fs.readFile(path.join(os.homedir(), '.claude.json'), 'utf-8'));
          const cached = raw?.cachedUsageUtilization;
          const u = cached?.utilization;
          if (!u) return sendJson(res, 200, { cli, available: false });
          const pick = (w: any) =>
            w && typeof w.utilization === 'number' ? { percent: w.utilization, resetsAt: typeof w.resets_at === 'string' ? w.resets_at : null } : null;
          return sendJson(res, 200, {
            cli,
            available: true,
            fetchedAt: typeof cached.fetchedAtMs === 'number' ? new Date(cached.fetchedAtMs).toISOString() : null,
            session: pick(u.five_hour),
            weekly: pick(u.seven_day),
          });
        } catch {
          return sendJson(res, 200, { cli, available: false });
        }
      }

      if (url === '/api/cli/models' && req.method === 'GET') {
        try {
          const fullUrl = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
          const cli = fullUrl.searchParams.get('cli')?.trim() || '';
          if (cli !== 'agy' && cli !== 'antigravity') {
            return sendJson(res, 200, { cli, models: [] });
          }
          const ids = await listAgyModels(storageDir);
          return sendJson(res, 200, { cli: 'agy', models: ids.map((id) => ({ id })) });
        } catch (err: any) {
          return sendJson(res, 500, { error: err.message });
        }
      }

      if (url === '/api/cli/auth-status' && req.method === 'GET') {
        try {
          const fullUrl = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
          let cli = fullUrl.searchParams.get('cli')?.trim() || 'claude';
          if (!isSafeCommandName(cli)) {
            return sendJson(res, 400, { error: 'Invalid CLI name' });
          }
          let resolvedCmd = (cli === 'antigravity' || cli === 'gemini') ? 'agy' : cli;

          // 1. Check if CLI binary is in PATH (with fallback for agy in ~/.local/bin)
          let whichRes = await runShellCommand(`${FIND_ON_PATH} ${resolvedCmd}`, storageDir, 3000);
          if (whichRes.exitCode !== 0 && (cli === 'antigravity' || cli === 'agy' || cli === 'gemini')) {
            const localAgy = path.join(os.homedir(), '.local', 'bin', 'agy');
            if (fsSync.existsSync(localAgy)) {
              resolvedCmd = localAgy;
              whichRes = { exitCode: 0, stdout: localAgy, stderr: '', timedOut: false, durationMs: 0 };
            }
          }

          const isInstalled = whichRes.exitCode === 0 && Boolean(whichRes.stdout.trim());
          if (!isInstalled) {
            const humanName = (cli === 'antigravity' || cli === 'agy' || cli === 'gemini')
              ? 'Antigravity CLI (agy)'
              : cli === 'claude'
                ? 'Claude Code (claude)'
                : cli === 'codex'
                  ? 'OpenAI Codex CLI (codex)'
                  : cli;
            return sendJson(res, 200, {
              cli: resolvedCmd,
              isInstalled: false,
              isAuthenticated: false,
              message: `${humanName} is not installed in system PATH.`
            });
          }

          // 2. Check auth status for claude, antigravity (agy), codex
          let isAuthenticated = false;
          let userEmail: string | null = null;
          let message = 'Not authenticated';

          if (cli === 'claude' || cli.includes('claude')) {
            const claudeConfigPath = path.join(os.homedir(), '.claude.json');
            const claudeCredsPath = path.join(os.homedir(), '.claude', '.credentials.json');
            const claudeAuthPath = path.join(os.homedir(), '.claude', 'auth.json');
            try {
              if (fsSync.existsSync(claudeCredsPath) || fsSync.existsSync(claudeAuthPath)) {
                isAuthenticated = true;
              }
              if (fsSync.existsSync(claudeConfigPath)) {
                const configText = await fs.readFile(claudeConfigPath, 'utf-8');
                const parsed = JSON.parse(configText);
                if (parsed?.oauthAccount || parsed?.sessionKey || parsed?.accountToken || parsed?.primaryApiKey) {
                  isAuthenticated = true;
                  userEmail = parsed?.oauthAccount?.email || parsed?.email || null;
                  message = userEmail ? `Authenticated as ${userEmail}` : 'Authenticated with Claude Pro/Team';
                }
              }
            } catch {}

            if (!isAuthenticated) {
              userEmail = null;
              message = 'Not authenticated (Sign in to connect)';
            }
          } else if (cli === 'antigravity' || cli === 'agy' || cli === 'gemini' || resolvedCmd.includes('agy')) {
            const geminiConfigDir = path.join(os.homedir(), '.gemini');
            const accountsFile = path.join(geminiConfigDir, 'google_accounts.json');
            const oauthFile = path.join(geminiConfigDir, 'oauth_creds.json');
            const tokensFile = path.join(geminiConfigDir, 'tokens.json');
            const agyCliDir = path.join(geminiConfigDir, 'antigravity-cli');
            const settingsFile = path.join(agyCliDir, 'settings.json');
            const ideDir = path.join(geminiConfigDir, 'antigravity-ide');
            const mcpTokens = path.join(ideDir, 'mcp_oauth_tokens.json');
            const disconnectedFlag = path.join(geminiConfigDir, '.ergo_disconnected_agy');

            // If user explicitly reset/disconnected, do not report authenticated until reconnected
            if (fsSync.existsSync(disconnectedFlag)) {
              isAuthenticated = false;
              userEmail = null;
              message = 'Not authenticated (Sign in to connect)';
            } else if (fsSync.existsSync(accountsFile) || fsSync.existsSync(oauthFile) || fsSync.existsSync(tokensFile)) {
              isAuthenticated = true;
              try {
                if (fsSync.existsSync(accountsFile)) {
                  const accData = JSON.parse(await fs.readFile(accountsFile, 'utf-8'));
                  userEmail = accData?.active || accData?.current || (Array.isArray(accData?.accounts) ? accData.accounts[0]?.email : null) || null;
                }
              } catch {}
              message = userEmail ? `Authenticated with Google as ${userEmail}` : 'Antigravity CLI (agy) is authenticated with your Google account.';
            } else if (fsSync.existsSync(settingsFile) || fsSync.existsSync(mcpTokens) || fsSync.existsSync(path.join(geminiConfigDir, 'settings.json'))) {
              isAuthenticated = true;
              message = 'Antigravity CLI is installed and active.';
            } else {
              isAuthenticated = false;
              userEmail = null;
              message = 'Not authenticated (Sign in to connect)';
            }
          } else if (cli === 'codex') {
            const codexConfig = path.join(os.homedir(), '.codex');
            const authJsonPath = path.join(codexConfig, 'auth.json');
            const credsJsonPath = path.join(codexConfig, 'credentials.json');
            const sessionJsonPath = path.join(codexConfig, 'session.json');

            if (fsSync.existsSync(authJsonPath) || fsSync.existsSync(credsJsonPath) || fsSync.existsSync(sessionJsonPath)) {
              isAuthenticated = true;
              try {
                if (fsSync.existsSync(authJsonPath)) {
                  const authData = JSON.parse(await fs.readFile(authJsonPath, 'utf-8'));
                  const idTok = authData?.tokens?.id_token;
                  if (idTok && typeof idTok === 'string') {
                    const parts = idTok.split('.');
                    if (parts.length >= 2) {
                      const payload = Buffer.from(parts[1], 'base64').toString('utf-8');
                      const parsedPayload = JSON.parse(payload);
                      userEmail = parsedPayload?.email || parsedPayload?.name || parsedPayload?.preferred_username || null;
                    }
                  }
                  if (!userEmail && authData?.tokens?.account_id) {
                    userEmail = authData.tokens.account_id;
                  }
                }
              } catch {}
              message = userEmail ? `Authenticated with OpenAI as ${userEmail}` : 'Codex authenticated';
            } else {
              isAuthenticated = false;
              userEmail = null;
              message = 'Not authenticated (Sign in to connect)';
            }
          } else if (cli === 'cursor' || cli === 'cursor-cli') {
            const cursorConfig = path.join(os.homedir(), '.cursor');
            if (fsSync.existsSync(cursorConfig)) {
              isAuthenticated = true;
              message = 'Cursor CLI authenticated';
            } else {
              const pingRes = await runShellCommand('cursor --version', storageDir, 5000);
              if (pingRes.exitCode === 0) {
                isAuthenticated = true;
                message = `Cursor CLI ready (${pingRes.stdout.trim().split('\n')[0]})`;
              } else {
                isAuthenticated = false;
                message = 'Login required via "cursor login"';
              }
            }
          } else if (cli === 'grok' || cli === 'grok-cli') {
            const grokConfig = path.join(os.homedir(), '.xai');
            if (fsSync.existsSync(grokConfig)) {
              isAuthenticated = true;
              message = 'Grok CLI authenticated';
            } else {
              const pingRes = await runShellCommand('grok --version', storageDir, 5000);
              if (pingRes.exitCode === 0) {
                isAuthenticated = true;
                message = `Grok CLI ready (${pingRes.stdout.trim().split('\n')[0]})`;
              } else {
                isAuthenticated = false;
                message = 'Login required via "grok login"';
              }
            }
          } else {
            isAuthenticated = isInstalled;
            message = `${cli} installed.`;
          }

          return sendJson(res, 200, {
            cli: resolvedCmd,
            isInstalled: true,
            isAuthenticated,
            userEmail,
            message
          });
        } catch (err: any) {
          return sendJson(res, 500, { error: err.message });
        }
      }

      if (url === '/api/cli/install' && req.method === 'POST') {
        try {
          const body = await parseJsonBody(req);
          let { cli = 'claude' } = body;

          let installCmd = CLAUDE_INSTALL_COMMAND;
          if (cli === 'codex') {
            installCmd = 'npm install -g @openai/codex';
          } else if (cli === 'antigravity' || cli === 'agy' || cli === 'gemini' || cli === 'google') {
            installCmd = 'curl -fsSL https://antigravity.google/cli/install.sh | bash';
          } else if (cli === 'cursor' || cli === 'cursor-cli') {
            installCmd = 'curl -fsSL https://cursor.com/install.sh | bash';
          } else if (cli === 'grok' || cli === 'grok-cli') {
            installCmd = 'npm install -g grok-cli';
          } else if (cli === 'aider') {
            installCmd = 'pip install aider-chat';
          }

          const result = await runShellCommand(installCmd, storageDir, 180_000);
          const errorMsg = result.exitCode !== 0
            ? (result.stderr.trim() || result.stdout.trim() || `Installation command '${installCmd}' failed with exit code ${result.exitCode}`)
            : undefined;

          return sendJson(res, 200, {
            success: result.exitCode === 0,
            output: result.stdout.trim(),
            error: errorMsg
          });
        } catch (err: any) {
          return sendJson(res, 500, { error: err.message });
        }
      }

      if (url === '/api/cli/login' && req.method === 'POST') {
        try {
          const body = await parseJsonBody(req);
          let { cli = 'claude' } = body;
          if (typeof cli !== 'string' || !isSafeCommandName(cli)) {
            return sendJson(res, 400, { success: false, authUrl: null, output: '', error: 'Invalid CLI name' });
          }
          let resolvedCmd = (cli === 'antigravity' || cli === 'gemini') ? 'agy' : cli;
          if (cli === 'antigravity' || cli === 'agy' || cli === 'gemini') {
            const flag = path.join(os.homedir(), '.gemini', '.ergo_disconnected_agy');
            if (fsSync.existsSync(flag)) {
              await fs.unlink(flag).catch(() => {});
            }
          }

          let whichRes = await runShellCommand(`${FIND_ON_PATH} ${resolvedCmd}`, storageDir, 3000);
          if (whichRes.exitCode !== 0 && (cli === 'antigravity' || cli === 'agy' || cli === 'gemini')) {
            const localAgy = path.join(os.homedir(), '.local', 'bin', 'agy');
            if (fsSync.existsSync(localAgy)) {
              resolvedCmd = localAgy;
              whichRes = { exitCode: 0, stdout: localAgy, stderr: '', timedOut: false, durationMs: 0 };
            }
          }

          if (whichRes.exitCode !== 0) {
            const toolName = (cli === 'antigravity' || cli === 'agy' || cli === 'gemini')
              ? 'Antigravity CLI (agy)'
              : cli === 'claude'
                ? 'Claude Code (@anthropic-ai/claude-code)'
                : cli;
            return sendJson(res, 200, {
              success: false,
              authUrl: null,
              output: '',
              error: `${toolName} is not installed on your system. Please click 'Install CLI' above to install it directly in the terminal.`
            });
          }

          const { spawn } = await import('node:child_process');

          let loginArgs = ['login'];
          if (resolvedCmd.includes('claude')) {
            loginArgs = ['auth', 'login'];
          } else if (resolvedCmd.includes('agy')) {
            loginArgs = []; // agy runs interactive authentication loop directly
          }

          let spawnError: Error | null = null;
          let proc: any;
          try {
            proc = spawn(resolvedCmd, loginArgs, {
              cwd: storageDir,
              env: {
                ...process.env,
                BROWSER: 'none',
                NO_BROWSER: '1'
              },
              stdio: ['pipe', 'pipe', 'pipe'],
              // npm installs CLIs on Windows as .cmd shims, which only a shell can launch. The name passed
              // isSafeCommandName and the args are constants, so nothing here is shell-interpreted input.
              shell: process.platform === 'win32' && isSafeCommandName(resolvedCmd)
            });
          } catch (err: any) {
            return sendJson(res, 200, {
              success: false,
              authUrl: null,
              output: '',
              error: `Failed to launch ${resolvedCmd}: ${err.message}`
            });
          }

          proc.on('error', (err: any) => {
            spawnError = err;
          });

          let stdout = '';
          let stderr = '';
          let capturedUrl: string | null = null;

          const urlRegex = /(https:\/\/(?:auth\.anthropic\.com|claude\.ai|claude\.com|[a-zA-Z0-9.-]*openai\.com|[a-zA-Z0-9.-]*google\.com)[^\s"'<>]+)/i;

          proc.stdout?.on('data', (chunk: Buffer) => {
            const str = chunk.toString('utf-8');
            stdout += str;
            const match = str.match(urlRegex);
            if (match && !capturedUrl) {
              capturedUrl = match[1];
            }
          });

          proc.stderr?.on('data', (chunk: Buffer) => {
            const str = chunk.toString('utf-8');
            stderr += str;
            const match = str.match(urlRegex);
            if (match && !capturedUrl) {
              capturedUrl = match[1];
            }
          });

          // Wait up to 4.5 seconds to see if an OAuth URL or prompt is generated immediately
          await new Promise((resolve) => setTimeout(resolve, 4500));

          if (spawnError) {
            return sendJson(res, 200, {
              success: false,
              authUrl: null,
              output: (stdout + '\n' + stderr).trim(),
              error: (spawnError as any).message || `Failed to spawn ${resolvedCmd}`
            });
          }

          return sendJson(res, 200, {
            success: true,
            authUrl: capturedUrl,
            output: (stdout + '\n' + stderr).trim(),
            pid: proc.pid
          });
        } catch (err: any) {
          return sendJson(res, 200, {
            success: false,
            authUrl: null,
            output: '',
            error: err.message || 'Server error during login initialization'
          });
        }
      }

      // Reset CLI authentication for a given provider
      if (url === '/api/cli/reset-auth' && req.method === 'POST') {
        try {
          const body = await parseJsonBody(req);
          const { cli = 'claude' } = body;

          if (cli === 'codex') {
            const codexDir = path.join(os.homedir(), '.codex');
            const filesToWipe = ['auth.json', 'credentials.json', 'session.json', 'tokens.json'];
            for (const file of filesToWipe) {
              const fullPath = path.join(codexDir, file);
              if (fsSync.existsSync(fullPath)) {
                await fs.unlink(fullPath).catch(() => {});
              }
            }
            // Execute codex logout if binary exists
            await runShellCommand('codex logout', storageDir, 5000).catch(() => {});
          } else if (cli === 'antigravity' || cli === 'agy' || cli === 'gemini') {
            const geminiDir = path.join(os.homedir(), '.gemini');
            const filesToWipe = ['google_accounts.json', 'oauth_creds.json', 'tokens.json', 'state.json'];
            for (const file of filesToWipe) {
              const fullPath = path.join(geminiDir, file);
              if (fsSync.existsSync(fullPath)) {
                await fs.unlink(fullPath).catch(() => {});
              }
            }
            const configGeminiDir = path.join(os.homedir(), '.config', 'gemini');
            for (const file of filesToWipe) {
              const fullPath = path.join(configGeminiDir, file);
              if (fsSync.existsSync(fullPath)) {
                await fs.unlink(fullPath).catch(() => {});
              }
            }
            // Mark provider as disconnected so onboarding reset persists
            try {
              await fs.writeFile(path.join(geminiDir, '.ergo_disconnected_agy'), Date.now().toString());
            } catch {}
            // Execute agy logout if available
            await runShellCommand('agy auth logout || agy logout', storageDir, 5000).catch(() => {});
          } else if (cli === 'claude') {
            // 1. Run claude auth logout to clear keychain/secure storage if supported
            await runShellCommand('claude auth logout || claude logout', storageDir, 6000).catch(() => {});

            // 2. Clear credentials from ~/.claude
            const claudeDir = path.join(os.homedir(), '.claude');
            const claudeFilesToWipe = [
              '.credentials.json',
              'auth.json',
              'tokens.json',
              'credentials.json',
              'session.json'
            ];
            for (const file of claudeFilesToWipe) {
              const fullPath = path.join(claudeDir, file);
              if (fsSync.existsSync(fullPath)) {
                await fs.unlink(fullPath).catch(() => {});
              }
            }

            // 3. Clear auth fields from ~/.claude.json
            const claudeConfig = path.join(os.homedir(), '.claude.json');
            if (fsSync.existsSync(claudeConfig)) {
              try {
                const text = await fs.readFile(claudeConfig, 'utf-8');
                const parsed = JSON.parse(text);
                delete parsed.oauthAccount;
                delete parsed.sessionKey;
                delete parsed.primaryApiKey;
                delete parsed.accountToken;
                delete parsed.userID;
                delete parsed.email;
                delete parsed.user;
                delete parsed.tokens;
                await fs.writeFile(claudeConfig, JSON.stringify(parsed, null, 2), 'utf-8');
              } catch {}
            }
          }

          return sendJson(res, 200, { success: true, message: `Authentication for ${cli} has been reset. You can now connect a new profile.` });
        } catch (err: any) {
          return sendJson(res, 500, { success: false, error: err.message });
        }
      }

      // ─────────────────────────────────────────────────────────────
      // List media folder: POST /api/media/list
      // Body: { folderPath: "projects/xxx/media" }
      // Returns: { files: ["projects/xxx/media/img_123.png", ...] }
      // ─────────────────────────────────────────────────────────────
      if (url === '/api/media/list' && req.method === 'POST') {
        try {
          const body = await parseJsonBody(req);
          const { folderPath } = body;
          if (!folderPath || typeof folderPath !== 'string') {
            return sendJson(res, 400, { error: 'folderPath is required' });
          }
          const fullFolderPath = path.resolve(storageDir, folderPath);
          const storageRoot = path.resolve(storageDir);
          if (fullFolderPath !== storageRoot && !fullFolderPath.startsWith(storageRoot + path.sep)) {
            return sendJson(res, 403, { error: 'Forbidden' });
          }
          let files: string[] = [];
          try {
            const entries = await fs.readdir(fullFolderPath);
            files = entries
              .filter((name) => /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i.test(name))
              .map((name) => `${folderPath}/${name}`);
          } catch {
            // Folder doesn't exist yet — no files
          }
          return sendJson(res, 200, { success: true, files });
        } catch (err: any) {
          return sendJson(res, 500, { error: err.message });
        }
      }

      // ─────────────────────────────────────────────────────────────
      // Static media serving: /api/media/<relativePath>
      // Serves binary files (images) from storageDir at any sub-path
      // ─────────────────────────────────────────────────────────────
      if (url?.startsWith('/api/media/')) {
        try {
          const relativePath = decodeURIComponent(url.slice('/api/media/'.length));
          if (!relativePath || relativePath.includes('..')) {
            res.statusCode = 400;
            return res.end('Bad request');
          }
          const fullPath = path.resolve(storageDir, relativePath);
          // Only serve from within storageDir
          if (!fullPath.startsWith(path.resolve(storageDir) + path.sep)) {
            res.statusCode = 403;
            return res.end('Forbidden');
          }
          const ext = path.extname(fullPath).toLowerCase();
          const mimeTypes: Record<string, string> = {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.webp': 'image/webp',
            '.svg': 'image/svg+xml',
            '.bmp': 'image/bmp',
            '.ico': 'image/x-icon',
            '.avif': 'image/avif',
          };
          const contentType = mimeTypes[ext];
          if (!contentType) {
            res.statusCode = 404;
            return res.end('Not found');
          }
          const fileBuffer = await fs.readFile(fullPath);
          res.statusCode = 200;
          res.setHeader('Content-Type', contentType);
          res.setHeader('Cache-Control', 'private, max-age=3600');
          // An SVG opened directly would otherwise run scripts with the bridge's own origin.
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
          return res.end(fileBuffer);
        } catch {
          res.statusCode = 404;
          return res.end('Not found');
        }
      }

      next();
    });
  };

  return {
    name: 'ergo-filesystem-api',
    configureServer(server) {
      attachMiddleware(server);
    },
    configurePreviewServer(server) {
      attachMiddleware(server as any);
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PTY Plugin — CLI agent sessions (one PTY per agent: `${taskId}::manager`, `${taskId}::worker::<id>`, `${taskId}::qa`)
// REST (App):   POST /api/pty/spawn | /api/pty/input | /api/pty/kill | /api/pty/policy
//               GET  /api/pty/sessions | /api/pty/usage | /api/pty/transcript | /api/pty/activity | /api/pty/events (SSE)
// WebSocket ws://localhost:<PORT>/api/pty (views):
// Messages in:  { type:'attach', sessionId, cols?, rows?, observe? }   (task agents: attach only)
//               { type:'spawn', cmd, args, cwd, cols, rows, ... }     (legacy: login / onboarding terminals)
//               { type:'input', data } | { type:'resize', cols, rows } | { type:'kill' }
// Messages out: { type:'ready', cols, rows } | { type:'replay', data } | { type:'data', data } | { type:'exit', code }
//               { type:'resized', cols, rows } | { type:'prompt', prompt } | { type:'auto-approved', summary } | { type:'error', message }
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// PTY session token usage
// Interactive CLI agents don't print machine-readable usage, so read what each CLI logs locally:
//   Claude Code → ~/.claude/projects/<cwd-slug>/<session-id>.jsonl (Ergo launches it with --session-id)
//   Codex       → ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (matched by cwd + start time)
//   Gemini CLI  → ~/.gemini/tmp/<sha256(cwd)>/chats/session-*.json
// Anything else (e.g. Antigravity, whose logs are protobuf) falls back to a transcript-length estimate.
// ─────────────────────────────────────────────────────────────────────────────

interface PtyUsageMeta {
  cmd: string;
  args: string[];
  cwd: string;
  startedAt: string;
  buffer: string[];
}

/** 'qa' is the verifier's wire name (kept so apps and bridges of every protocol version agree). */
type BridgeAgentRole = 'manager' | 'worker' | 'qa';
type AgentSignalKind = 'delegate' | 'worker-done' | 'complete' | 'qa-verdict' | 'question';

interface AgentSignalRecord {
  signal: AgentSignalKind;
  /** Path relative to the session cwd. */
  file: string;
  mtime: number;
  content: string;
  verdict?: 'PASS' | 'FAIL';
}

/** What is kept of a PTY session after it was killed or replaced: enough to replay it, read usage and transcripts. */
interface EndedPtySession extends PtyUsageMeta {
  id: string;
  taskId: string | number;
  projectId?: string;
  role?: BridgeAgentRole;
  label?: string;
  pieceId?: string;
  runId?: string;
  spawnId?: string;
  permissionLevel?: BridgePermission;
  exitCode: number | null;
  endedAt: string;
  transcript?: ScreenTranscript;
  signals: AgentSignalRecord[];
}

/** Sessions removed by /api/pty/kill or respawn, kept so views can replay them and usage/transcripts stay readable. */
const endedPtySessions = new Map<string, EndedPtySession>();
const MAX_ENDED_PTY_SESSIONS = 100;

function rememberEndedPtySession(id: string, session: PtySessionState): EndedPtySession {
  const meta: EndedPtySession = {
    id,
    taskId: session.taskId,
    projectId: session.projectId,
    role: session.role,
    label: session.label,
    pieceId: session.pieceId,
    runId: session.runId,
    spawnId: session.spawnId,
    permissionLevel: session.permissionLevel,
    cmd: session.cmd,
    args: [...session.args],
    cwd: session.cwd,
    startedAt: session.startedAt,
    buffer: [...session.buffer],
    exitCode: session.exitCode,
    endedAt: new Date().toISOString(),
    transcript: session.transcript,
    signals: Array.from(session.signals.values()),
  };
  // Re-insert so the map stays ordered oldest → newest.
  endedPtySessions.delete(id);
  endedPtySessions.set(id, meta);
  session.endedMeta = meta;
  while (endedPtySessions.size > MAX_ENDED_PTY_SESSIONS) {
    const oldest = endedPtySessions.keys().next().value;
    if (oldest === undefined) break;
    endedPtySessions.delete(oldest);
  }
  return meta;
}

function argValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  const inline = args.find((a) => a.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : undefined;
}

/** Claude Code session id of a launch: `--session-id <uuid>`, or `--resume <uuid>` (a resumed conversation keeps its id and log). */
function claudeSessionIdArg(args: string[]): string | undefined {
  return argValue(args, '--session-id') || argValue(args, '--resume');
}

async function readJsonlFile(file: string): Promise<any[]> {
  const raw = await fs.readFile(file, 'utf-8').catch(() => '');
  const out: any[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

/** Locates Claude Code's session log (~/.claude/projects/<cwd-slug>/<session-id>.jsonl). */
async function findClaudeSessionLog(sessionId: string, cwd: string): Promise<{ sessionDir: string; file: string } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  let sessionDir = path.join(projectsDir, cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  if (!fsSync.existsSync(path.join(sessionDir, `${sessionId}.jsonl`))) {
    const dirs = await fs.readdir(projectsDir).catch(() => [] as string[]);
    const hit = dirs.find((d) => fsSync.existsSync(path.join(projectsDir, d, `${sessionId}.jsonl`)));
    if (!hit) return null;
    sessionDir = path.join(projectsDir, hit);
  }
  return { sessionDir, file: path.join(sessionDir, `${sessionId}.jsonl`) };
}

async function readClaudeSessionUsage(sessionId: string, cwd: string): Promise<BridgeUsage | null> {
  const log = await findClaudeSessionLog(sessionId, cwd);
  if (!log) return null;
  const files = [log.file];
  const subagentDir = path.join(log.sessionDir, sessionId, 'subagents');
  for (const f of await fs.readdir(subagentDir).catch(() => [] as string[])) {
    if (f.endsWith('.jsonl')) files.push(path.join(subagentDir, f));
  }
  // One API response is logged as several lines (one per content block) sharing message.id — count it once.
  const byMessage = new Map<string, { usage: any; model?: string }>();
  for (const file of files) {
    for (const entry of await readJsonlFile(file)) {
      const usage = entry?.message?.usage;
      if (entry?.type !== 'assistant' || !usage) continue;
      const key = `${file}:${entry.message.id || entry.uuid}`;
      const prev = byMessage.get(key);
      if (!prev || (usage.output_tokens || 0) >= (prev.usage.output_tokens || 0)) byMessage.set(key, { usage, model: entry.message.model });
    }
  }
  if (byMessage.size === 0) return null;
  const total = emptyBridgeUsage();
  // Each response names its model (a subagent or /model switch can differ), so each is priced on its own.
  for (const { usage, model } of byMessage.values()) {
    const delta = normalizeUsageObject(usage);
    if (delta) {
      const cost = bridgeUsageCost(model, { ...delta, cacheWrite1hTokens: Number(usage?.cache_creation?.ephemeral_1h_input_tokens) || 0 });
      if (typeof cost === 'number') delta.costUsd = cost;
    }
    addBridgeUsage(total, delta);
  }
  return total;
}

function codexDayDirs(startMs: number): string[] {
  const root = path.join(os.homedir(), '.codex', 'sessions');
  const dirs = new Set<string>();
  for (const t of [startMs, Date.now()]) {
    const d = new Date(t);
    for (const [y, m, day] of [
      [d.getFullYear(), d.getMonth() + 1, d.getDate()],
      [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]
    ]) {
      dirs.add(path.join(root, String(y), String(m).padStart(2, '0'), String(day).padStart(2, '0')));
    }
  }
  return Array.from(dirs);
}

// ── Binding a session to its own CLI log ──
// Every agent of a run shares one cwd, so "the log started in this cwd after this session" can be another agent's.
// A session is bound to the log whose user message is its launch prompt; a bound log is never given to another session.

/** Session (owner key) → its log file, and log file → the owner that claimed it. */
const sessionLogBindings = new Map<string, string>();
const sessionLogClaims = new Map<string, string>();
const MAX_SESSION_LOG_BINDINGS = 500;
/** How far a log's start may be from the session's start when it cannot be matched by prompt. */
const LOG_LOOSE_EARLY_MS = 5_000;
const LOG_LOOSE_LATE_MS = 60_000;

interface SessionLogCandidate {
  file: string;
  /** When the CLI session started (from the log), ms. */
  started: number;
  /** The log's user messages (the launch prompt is one of the first). */
  userTexts: string[];
}

/** Identifies one launch: the live session and its ended copy share it. */
function sessionLogOwner(meta: PtyUsageMeta): string {
  return `${meta.startedAt}\u0000${meta.cmd}\u0000${meta.cwd}\u0000${meta.args.join('\u0000')}`;
}

const normalizeForMatch = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The task prompt the CLI was launched with (Ergo appends it as the last argument), whitespace-collapsed. */
function launchPromptOf(meta: PtyUsageMeta): string {
  const last = meta.args[meta.args.length - 1];
  if (typeof last !== 'string' || last.startsWith('-')) return '';
  const prompt = normalizeForMatch(last);
  return prompt.length >= 12 ? prompt : '';
}

function userTextsMatchPrompt(texts: string[], prompt: string): boolean {
  if (!prompt) return false;
  const head = prompt.slice(0, 300);
  return texts.some((t) => {
    const n = normalizeForMatch(t);
    return n.includes(head) || (n.length >= 40 && prompt.startsWith(n.slice(0, 300)));
  });
}

function bindSessionLog(owner: string, file: string) {
  const previous = sessionLogBindings.get(owner);
  if (previous && previous !== file && sessionLogClaims.get(previous) === owner) sessionLogClaims.delete(previous);
  sessionLogBindings.delete(owner);
  sessionLogBindings.set(owner, file);
  sessionLogClaims.set(file, owner);
  while (sessionLogBindings.size > MAX_SESSION_LOG_BINDINGS) {
    const oldest = sessionLogBindings.entries().next().value;
    if (!oldest) break;
    sessionLogBindings.delete(oldest[0]);
    if (sessionLogClaims.get(oldest[1]) === oldest[0]) sessionLogClaims.delete(oldest[1]);
  }
}

/** The log already bound to this session, if it still exists. */
function boundSessionLog(meta: PtyUsageMeta): string | null {
  const file = sessionLogBindings.get(sessionLogOwner(meta));
  return file && fsSync.existsSync(file) ? file : null;
}

/** Launch prompts of the other known sessions in the same cwd (their logs are not this session's). */
function otherLaunchPrompts(meta: PtyUsageMeta): string[] {
  const owner = sessionLogOwner(meta);
  const own = launchPromptOf(meta);
  const out = new Set<string>();
  for (const s of [...activePtySessions.values(), ...endedPtySessions.values()]) {
    if (s.cwd !== meta.cwd || sessionLogOwner(s) === owner) continue;
    const prompt = launchPromptOf(s);
    if (prompt && prompt !== own) out.add(prompt);
  }
  return Array.from(out);
}

/**
 * Picks this session's own log: one whose user message is its launch prompt (bound for good), else — when no log
 * carries the prompt — the log that started closest to the session and belongs to no other known session (not bound,
 * so a later read can still find the exact match). Never a log another session has claimed.
 */
function pickSessionLog(meta: PtyUsageMeta, candidates: SessionLogCandidate[]): string | null {
  const owner = sessionLogOwner(meta);
  const startMs = Date.parse(meta.startedAt) || Date.now();
  const free = candidates.filter((c) => {
    const claimedBy = sessionLogClaims.get(c.file);
    return !claimedBy || claimedBy === owner;
  });
  const byCloseness = (a: SessionLogCandidate, b: SessionLogCandidate) => Math.abs(a.started - startMs) - Math.abs(b.started - startMs);
  const prompt = launchPromptOf(meta);
  if (prompt) {
    const matched = free.filter((c) => c.started >= startMs - 15_000 && userTextsMatchPrompt(c.userTexts, prompt)).sort(byCloseness);
    if (matched.length > 0) {
      bindSessionLog(owner, matched[0].file);
      return matched[0].file;
    }
  }
  const others = otherLaunchPrompts(meta);
  const loose = free
    .filter((c) => c.started >= startMs - LOG_LOOSE_EARLY_MS && c.started <= startMs + LOG_LOOSE_LATE_MS)
    .filter((c) => !others.some((p) => userTextsMatchPrompt(c.userTexts, p)))
    .sort(byCloseness);
  return loose[0]?.file ?? null;
}

/** The Codex rollout log of this session (rollouts of every session in the cwd are candidates). */
async function findCodexRollout(meta: PtyUsageMeta): Promise<string | null> {
  const bound = boundSessionLog(meta);
  if (bound) return bound;
  const startMs = Date.parse(meta.startedAt) || Date.now();
  const candidates: SessionLogCandidate[] = [];
  for (const dir of codexDayDirs(startMs)) {
    for (const f of await fs.readdir(dir).catch(() => [] as string[])) {
      if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue;
      const file = path.join(dir, f);
      const stat = await fs.stat(file).catch(() => null);
      if (!stat || stat.mtimeMs < startMs - 5_000) continue;
      const lines = (await fs.readFile(file, 'utf-8').catch(() => '')).split('\n', 200);
      let meta0: any = null;
      try { meta0 = JSON.parse(lines[0]); } catch {}
      const payload = meta0?.payload ?? meta0;
      const metaCwd = payload?.cwd;
      const started = Date.parse(payload?.timestamp || meta0?.timestamp || '');
      if (!metaCwd || path.resolve(metaCwd) !== path.resolve(meta.cwd)) continue;
      if (!Number.isFinite(started) || started < startMs - 15_000) continue;
      const userTexts: string[] = [];
      for (const line of lines.slice(1)) {
        if (!line.trim()) continue;
        let ev: any = null;
        try { ev = JSON.parse(line); } catch { continue; }
        const p = ev?.payload ?? ev?.msg ?? ev;
        if (p?.type === 'user_message' && typeof p.message === 'string') userTexts.push(p.message);
        else if (p?.type === 'message' && p.role === 'user') userTexts.push(textOfContent(p.content));
      }
      candidates.push({ file, started, userTexts });
    }
  }
  return pickSessionLog(meta, candidates);
}

async function readCodexSessionUsage(meta: PtyUsageMeta): Promise<BridgeUsage | null> {
  const file = await findCodexRollout(meta);
  if (!file) return null;
  let last: BridgeUsage | null = null;
  let turns = 0;
  for (const ev of await readJsonlFile(file)) {
    const info = ev?.payload?.info ?? ev?.msg?.info;
    if ((ev?.payload?.type === 'token_count' || ev?.msg?.type === 'token_count') && info?.total_token_usage) {
      last = normalizeUsageObject(info.total_token_usage);
      turns++;
    }
  }
  if (last) last.calls = Math.max(1, turns);
  return last;
}

/**
 * A Gemini chat log as `{ projectHash, startTime, messages }`. Older CLIs write one JSON document (session-*.json);
 * newer ones append JSONL (session-*.jsonl): a metadata line, then message records (a re-written message repeats its
 * id) and `$set` / `$rewindTo` patches.
 */
async function readGeminiChat(file: string): Promise<any | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch {
    return null;
  }
  if (!file.endsWith('.jsonl')) {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const session: any = { messages: [] as any[] };
  const indexById = new Map<string, number>();
  const reindex = () => {
    indexById.clear();
    session.messages.forEach((m: any, i: number) => m?.id && indexById.set(String(m.id), i));
  };
  let first = true;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || typeof rec !== 'object') continue;
    if (first && !rec.type && !rec.$set && (rec.sessionId || rec.projectHash)) {
      Object.assign(session, rec, { messages: session.messages });
    } else if (rec.$set && typeof rec.$set === 'object') {
      const { messages, ...rest } = rec.$set;
      Object.assign(session, rest);
      if (Array.isArray(messages)) {
        session.messages = [...messages];
        reindex();
      }
    } else if (rec.$rewindTo !== undefined) {
      const at = indexById.get(String(rec.$rewindTo?.messageId ?? rec.$rewindTo));
      if (at !== undefined) {
        session.messages = session.messages.slice(0, at);
        reindex();
      }
    } else if (rec.type) {
      const at = rec.id !== undefined ? indexById.get(String(rec.id)) : undefined;
      if (at !== undefined) session.messages[at] = rec;
      else {
        session.messages.push(rec);
        if (rec.id !== undefined) indexById.set(String(rec.id), session.messages.length - 1);
      }
    }
    first = false;
  }
  return session;
}

function geminiUserTexts(session: any): string[] {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  return messages.filter((m: any) => m?.type === 'user' || m?.role === 'user').map((m: any) => textOfContent(m.content ?? m.parts));
}

/** This session's Gemini CLI chat log (~/.gemini/tmp/<project>/chats/session-*.json or .jsonl), parsed. */
async function findGeminiSession(meta: PtyUsageMeta): Promise<any | null> {
  return (await findGeminiSessionFile(meta))?.session ?? null;
}

async function findGeminiSessionFile(meta: PtyUsageMeta): Promise<{ file: string; session: any } | null> {
  const bound = boundSessionLog(meta);
  if (bound) {
    const session = await readGeminiChat(bound);
    return session ? { file: bound, session } : null;
  }
  const startMs = Date.parse(meta.startedAt) || Date.now();
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update(meta.cwd).digest('hex');
  const root = path.join(os.homedir(), '.gemini', 'tmp');
  const dirs = await fs.readdir(root).catch(() => [] as string[]);
  const candidates: SessionLogCandidate[] = [];
  const parsed = new Map<string, any>();
  for (const d of dirs) {
    const chats = path.join(root, d, 'chats');
    for (const f of await fs.readdir(chats).catch(() => [] as string[])) {
      if (!f.startsWith('session-') || !(f.endsWith('.json') || f.endsWith('.jsonl'))) continue;
      const file = path.join(chats, f);
      const stat = await fs.stat(file).catch(() => null);
      if (!stat || stat.mtimeMs < startMs - 5_000) continue;
      const session = await readGeminiChat(file);
      if (!session || (d !== hash && session?.projectHash !== hash)) continue;
      const startTime = Date.parse(session?.startTime || '');
      const started = Number.isFinite(startTime) ? startTime : stat.birthtimeMs || stat.mtimeMs;
      if (started < startMs - 15_000) continue;
      parsed.set(file, session);
      candidates.push({ file, started, userTexts: geminiUserTexts(session) });
    }
  }
  const file = pickSessionLog(meta, candidates);
  const session = file ? parsed.get(file) : null;
  return file && session ? { file, session } : null;
}

async function readGeminiCliSessionUsage(meta: PtyUsageMeta): Promise<BridgeUsage | null> {
  const session = await findGeminiSession(meta);
  const total = emptyBridgeUsage();
  for (const msg of Array.isArray(session?.messages) ? session.messages : []) {
    if (msg?.tokens) addBridgeUsage(total, normalizeUsageObject(msg.tokens));
  }
  return total.calls > 0 ? total : null;
}

function stripTerminalCodes(str: string): string {
  return str
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\r\n?/g, '\n');
}

/**
 * Rough usage from the terminal transcript (~4 chars/token). TUIs repaint constantly, so only unique lines
 * count, and lines that merely echo the task prompt are excluded from output.
 */
function estimatePtyUsage(meta: PtyUsageMeta): BridgeUsage {
  const promptText = meta.args.join('\n');
  const promptLines = new Set(promptText.split('\n').map((l) => l.trim()).filter(Boolean));
  const seen = new Set<string>();
  let outputChars = 0;
  for (const line of stripTerminalCodes(meta.buffer.join('')).split('\n')) {
    const l = line.trim();
    if (l.length < 2 || seen.has(l) || promptLines.has(l)) continue;
    seen.add(l);
    outputChars += l.length;
  }
  return {
    inputTokens: Math.ceil(promptText.length / 4),
    outputTokens: Math.ceil(outputChars / 4),
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    calls: 1,
    estimated: true
  };
}

/** Prices a session's usage on the model it was launched with, when its log didn't price it already. */
function withArgModelCost(usage: BridgeUsage, meta: PtyUsageMeta): BridgeUsage {
  if (typeof usage.costUsd === 'number') return usage;
  const cost = bridgeUsageCost(modelArgOf(meta.args), usage);
  return typeof cost === 'number' ? { ...usage, costUsd: cost, costPartial: false } : { ...usage, costPartial: usage.inputTokens + usage.outputTokens > 0 };
}

async function resolvePtySessionUsage(meta: PtyUsageMeta): Promise<{ usage: BridgeUsage; source: string }> {
  const base = path.basename(meta.cmd).toLowerCase();
  try {
    if (base.includes('claude')) {
      const sessionId = claudeSessionIdArg(meta.args);
      const usage = sessionId ? await readClaudeSessionUsage(sessionId, meta.cwd) : null;
      if (usage) return { usage, source: 'claude-session-log' };
    } else if (base.includes('codex')) {
      const usage = await readCodexSessionUsage(meta);
      if (usage) return { usage: withArgModelCost(usage, meta), source: 'codex-session-log' };
    } else if (base === 'gemini') {
      const usage = await readGeminiCliSessionUsage(meta);
      if (usage) return { usage: withArgModelCost(usage, meta), source: 'gemini-session-log' };
    }
  } catch (err) {
    console.warn('[Ergo PTY] Usage lookup failed, falling back to estimate:', err);
  }
  return { usage: withArgModelCost(estimatePtyUsage(meta), meta), source: 'estimate' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent final messages (for completion logs)
// The agent's last reply, read from the CLI's own session log; else the last assistant-looking block of the
// rendered transcript. Every reader fails soft.
// ─────────────────────────────────────────────────────────────────────────────

type FinalMessageSource = 'claude-session-log' | 'codex-session-log' | 'gemini-session-log' | 'transcript' | 'none';

function textOfContent(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: any) => (typeof part === 'string' ? part : part && (part.type === 'text' || part.type === 'output_text' || part.text) ? String(part.text ?? '') : ''))
    .filter((t: string) => t.trim())
    .join('\n\n');
}

async function readClaudeFinalMessage(meta: PtyUsageMeta): Promise<string | null> {
  const sessionId = claudeSessionIdArg(meta.args);
  if (!sessionId) return null;
  const log = await findClaudeSessionLog(sessionId, meta.cwd);
  if (!log) return null;
  const entries = (await readJsonlFile(log.file)).filter((e) => e?.type === 'assistant' && !e?.isSidechain && e?.message);
  for (let i = entries.length - 1; i >= 0; i--) {
    const text = textOfContent((entries[i].message.content || []).filter?.((b: any) => b?.type === 'text') ?? entries[i].message.content);
    if (!text.trim()) continue;
    // One response is logged as one line per content block: collect the text blocks of the same message.
    const id = entries[i].message.id;
    const parts: string[] = [];
    for (let j = i; j >= 0 && id && entries[j].message.id === id; j--) {
      const t = textOfContent((entries[j].message.content || []).filter?.((b: any) => b?.type === 'text') ?? '');
      if (t.trim()) parts.unshift(t);
    }
    return (parts.length ? parts.join('\n\n') : text).trim();
  }
  return null;
}

async function readCodexFinalMessage(meta: PtyUsageMeta): Promise<string | null> {
  const file = await findCodexRollout(meta);
  if (!file) return null;
  let last: string | null = null;
  for (const ev of await readJsonlFile(file)) {
    const payload = ev?.payload ?? ev?.msg;
    if (!payload) continue;
    if (payload.type === 'agent_message' && typeof payload.message === 'string' && payload.message.trim()) {
      last = payload.message;
    } else if (payload.type === 'message' && payload.role === 'assistant') {
      const text = textOfContent(payload.content);
      if (text.trim()) last = text;
    }
  }
  return last?.trim() || null;
}

async function readGeminiFinalMessage(meta: PtyUsageMeta): Promise<string | null> {
  // Only this session's own chat log: other agents of the run share the cwd.
  const session = await findGeminiSession(meta);
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.type !== 'gemini' && msg?.type !== 'model' && msg?.role !== 'model') continue;
    const text = textOfContent(msg.content ?? msg.parts);
    if (text.trim()) return text.trim();
  }
  return null;
}

/** Last block of agent prose in a rendered transcript ("● text" / "⏺ text" / "✦ text" / "• text"), skipping tool calls. */
function lastAssistantBlock(lines: string[]): string | null {
  const BULLET_RE = /^\s*[●⏺✦•]\s+\S/;
  const TOOL_RE = /^\s*[●⏺✦•]\s+(?:[A-Z][A-Za-z]*\(|(?:Ran|Read|Explored|Edited|Updated|Update|Wrote|Write|Searched|Search|Running|Called|Bash|Fetch|Task|Shell|Edit|ReadFile|WriteFile)\b)/;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!BULLET_RE.test(lines[i]) || TOOL_RE.test(lines[i])) continue;
    const block = [lines[i].replace(/^\s*[●⏺✦•]\s+/, '').trim()];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (BULLET_RE.test(line) || /^\s*(?:[❯›>]|⎿)/.test(line) || !/^\s{2,}\S/.test(line)) break;
      block.push(line.trim());
    }
    const text = block.join('\n').trim();
    if (text) return text;
  }
  return null;
}

async function readAgentFinalMessage(meta: PtyUsageMeta, transcript?: ScreenTranscript): Promise<{ text?: string; source: FinalMessageSource }> {
  const base = path.basename(meta.cmd).toLowerCase();
  try {
    if (base.includes('claude')) {
      const text = await readClaudeFinalMessage(meta);
      if (text) return { text, source: 'claude-session-log' };
    } else if (base.includes('codex')) {
      const text = await readCodexFinalMessage(meta);
      if (text) return { text, source: 'codex-session-log' };
    } else if (base === 'gemini' || base.startsWith('gemini')) {
      const text = await readGeminiFinalMessage(meta);
      if (text) return { text, source: 'gemini-session-log' };
    }
  } catch (err) {
    console.warn('[Ergo PTY] Reading the agent session log failed, falling back to the transcript:', err);
  }
  const fromTranscript = transcript ? lastAssistantBlock(transcript.lines()) : null;
  if (fromTranscript) return { text: fromTranscript, source: 'transcript' };
  return { source: 'none' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent activity (the live status line above the task prompt box)
// Folded from the CLI's own session log — JSONL logs are read incrementally, only the lines appended since the last
// poll — else from the rendered transcript. The folding itself is src/lib/agentActivity.ts.
// ─────────────────────────────────────────────────────────────────────────────

type ActivitySource = NonNullable<AgentActivityResponse['source']>;

interface ActivityCursor {
  file: string;
  /** Byte offset of the first line not folded yet. */
  offset: number;
  /** The first read started mid-file: the partial line before the first newline is skipped. */
  skipPartial: boolean;
  fold: ActivityFold;
  /** Gemini's whole-document log: the mtime/size it was folded at. */
  stamp?: string;
  reading?: Promise<ActivityFold | null>;
}

/** Session (owner key) → its log cursor. */
const activityCursors = new Map<string, ActivityCursor>();
const MAX_ACTIVITY_CURSORS = 200;
/** A first read of a long log starts this far from its end (the status only needs the latest turn). */
const ACTIVITY_MAX_READ_BYTES = 8 * 1024 * 1024;
/** Unbound Codex/Gemini log picks are re-resolved after this long (bound logs are cached by the binding). */
const ACTIVITY_PICK_TTL_MS = 10_000;
const activityPicks = new Map<string, { file: string | null; at: number }>();

function activityCursor(owner: string, file: string): ActivityCursor {
  let cursor = activityCursors.get(owner);
  if (!cursor || cursor.file !== file) cursor = { file, offset: 0, skipPartial: false, fold: newActivityFold() };
  activityCursors.delete(owner);
  activityCursors.set(owner, cursor);
  while (activityCursors.size > MAX_ACTIVITY_CURSORS) {
    const oldest = activityCursors.keys().next().value;
    if (oldest === undefined) break;
    activityCursors.delete(oldest);
  }
  return cursor;
}

/** One read at a time per cursor: overlapping polls would fold the same lines twice. */
function readOnce(cursor: ActivityCursor, read: () => Promise<ActivityFold | null>): Promise<ActivityFold | null> {
  if (!cursor.reading) cursor.reading = read().finally(() => { cursor.reading = undefined; });
  return cursor.reading;
}

/** Folds the whole lines appended to a JSONL log since the last read. */
function foldJsonlTail(owner: string, file: string, foldLine: (fold: ActivityFold, entry: any) => void): Promise<ActivityFold | null> {
  const cursor = activityCursor(owner, file);
  return readOnce(cursor, async () => {
    const stat = await fs.stat(file).catch(() => null);
    if (!stat) return null;
    if (stat.size < cursor.offset) Object.assign(cursor, { offset: 0, skipPartial: false, fold: newActivityFold() });
    if (cursor.offset === 0 && stat.size > ACTIVITY_MAX_READ_BYTES) {
      cursor.offset = stat.size - ACTIVITY_MAX_READ_BYTES;
      cursor.skipPartial = true;
    }
    while (stat.size > cursor.offset) {
      const length = Math.min(stat.size - cursor.offset, ACTIVITY_MAX_READ_BYTES);
      const buf = Buffer.alloc(length);
      const handle = await fs.open(file, 'r');
      let bytesRead = 0;
      try {
        ({ bytesRead } = await handle.read(buf, 0, length, cursor.offset));
      } finally {
        await handle.close();
      }
      // Only whole lines: one still being written is folded on the next poll.
      const end = buf.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (end < 0) break;
      let start = 0;
      if (cursor.skipPartial) {
        start = buf.indexOf(0x0a) + 1;
        cursor.skipPartial = false;
      }
      for (const line of buf.subarray(start, end).toString('utf-8').split('\n')) {
        if (!line.trim()) continue;
        let entry: any;
        try { entry = JSON.parse(line); } catch { continue; }
        foldLine(cursor.fold, entry);
      }
      cursor.offset += end + 1;
    }
    return cursor.fold;
  });
}

/** A Codex/Gemini log picked without a binding is kept for a few seconds instead of rescanning on every poll. */
async function pickedActivityLog(meta: PtyUsageMeta, find: () => Promise<string | null>): Promise<string | null> {
  const bound = boundSessionLog(meta);
  if (bound) return bound;
  const owner = sessionLogOwner(meta);
  const cached = activityPicks.get(owner);
  if (cached && Date.now() - cached.at < ACTIVITY_PICK_TTL_MS) return cached.file;
  const file = await find();
  activityPicks.set(owner, { file, at: Date.now() });
  if (activityPicks.size > MAX_ACTIVITY_CURSORS) activityPicks.delete(activityPicks.keys().next().value!);
  return file;
}

async function readGeminiActivity(meta: PtyUsageMeta, owner: string): Promise<ActivityFold | null> {
  const file = await pickedActivityLog(meta, async () => (await findGeminiSessionFile(meta))?.file ?? null);
  if (!file) return null;
  // Even the JSONL log is folded whole (when it changed): a re-written message repeats its id, and $rewindTo drops some.
  const cursor = activityCursor(owner, file);
  return readOnce(cursor, async () => {
    const stat = await fs.stat(file).catch(() => null);
    if (!stat) return null;
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    if (cursor.stamp !== stamp) {
      const session = await readGeminiChat(file);
      const fold = newActivityFold();
      for (const msg of Array.isArray(session?.messages) ? session.messages : []) foldGeminiMessage(fold, msg);
      cursor.fold = fold;
      cursor.stamp = stamp;
    }
    return cursor.fold;
  });
}

/** The session's activity folded from its CLI's own log (null when the CLI or its log is unknown). */
async function readActivityFold(meta: PtyUsageMeta): Promise<{ fold: ActivityFold; source: ActivitySource } | null> {
  const base = path.basename(meta.cmd).toLowerCase();
  const owner = sessionLogOwner(meta);
  try {
    if (base.includes('claude')) {
      const sessionId = claudeSessionIdArg(meta.args);
      const log = sessionId ? await findClaudeSessionLog(sessionId, meta.cwd) : null;
      const fold = log ? await foldJsonlTail(owner, log.file, foldClaudeEntry) : null;
      if (fold) return { fold, source: 'claude-session-log' };
    } else if (base.includes('codex')) {
      const file = await pickedActivityLog(meta, () => findCodexRollout(meta));
      const fold = file ? await foldJsonlTail(owner, file, foldCodexEvent) : null;
      if (fold) return { fold, source: 'codex-session-log' };
    } else if (base === 'gemini' || base.startsWith('gemini')) {
      const fold = await readGeminiActivity(meta, owner);
      if (fold) return { fold, source: 'gemini-session-log' };
    }
  } catch (err) {
    console.warn('[Ergo PTY] Reading agent activity from its session log failed:', err);
  }
  return null;
}

async function readAgentActivity(
  meta: PtyUsageMeta,
  transcript?: ScreenTranscript,
  liveRows: string[] = []
): Promise<{ activity: AgentActivity; source: ActivitySource }> {
  const launchPrompt = meta.args[meta.args.length - 1];
  const fromLog = await readActivityFold(meta);
  if (fromLog) {
    const { activity } = fromLog.fold;
    return { activity: transcript ? withScreenNarration(activity, transcript.tail(400), launchPrompt) : { ...activity }, source: fromLog.source };
  }
  if (transcript) {
    return { activity: activityFromScreen(transcript.tail(400), liveRows, launchPrompt), source: 'screen' };
  }
  return { activity: { said: '', doing: '', phase: 'thinking' }, source: 'none' };
}

/** Transcript of a session that has no screen model (fallback): unique non-empty lines of the stripped log. */
function transcriptFromBuffer(buffer: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of stripTerminalCodes(buffer.join('')).split('\n')) {
    const l = line.replace(/\s+$/, '');
    if (!l.trim() || seen.has(l)) continue;
    seen.add(l);
    out.push(l);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// PTY sessions
// App launches every task agent (manager, workers, verifier) over REST and views attach over the WebSocket. The bridge
// keeps a VT screen per session, detects prompts on the rendered rows, auto-approves them under Full access,
// applies live permission changes and watches the run's signal files. Everything is reported to attached views
// (WebSocket) and to App (SSE /api/pty/events).
// ─────────────────────────────────────────────────────────────────────────────

interface PtySessionState {
  id: string;
  taskId: string | number;
  /** Ergo project the agent works for (from the spawn request); scopes its memory. */
  projectId?: string;
  cmd: string;
  args: string[];
  cwd: string;
  ptyProcess: any;
  buffer: string[];
  bufferLength: number;
  maxBufferChars: number;
  subscribers: Set<any>;
  isActive: boolean;
  exitCode: number | null;
  startedAt: string;
  /** When the process ended (exit or kill). */
  endedAt?: string;
  /** Client-generated id of the launch that created this process; re-mounts with the same id reattach. */
  spawnId?: string;
  role?: BridgeAgentRole;
  label?: string;
  pieceId?: string;
  runId?: string;
  /** `<cwd>/.ergo/runs/<runId>` */
  runDir?: string;
  /** Ergo's workspace tools are on this agent's ergo-memory MCP server (PtySpawnOptions.workspaceTools). */
  workspaceTools?: boolean;
  /** Level the session runs under now (changed by /api/pty/policy). */
  permissionLevel?: BridgePermission;
  /** Level the CLI was launched with (its flags). */
  launchPermissionLevel?: BridgePermission;
  /** Text the CLI echoes back (its launch args), never read as menu content. */
  echoedText: string;
  screen: TerminalScreen;
  transcript: ScreenTranscript;
  observedScroll: number;
  /** Confirmed prompt on screen (null when none). */
  prompt: CliDetectedPrompt | null;
  /** False while the prompt is being auto-approved (views and App are not told about it). */
  promptVisible: boolean;
  candidate: { signature: string | null; prompt: CliDetectedPrompt | null; count: number };
  lastEvalAt: number;
  evalTimer: ReturnType<typeof setTimeout> | null;
  trailingEvalTimer: ReturnType<typeof setTimeout> | null;
  autoApproved: Map<string, { at: number; attempts: number }>;
  signals: Map<string, AgentSignalRecord>;
  signalMtimes: Map<string, number>;
  signalTimer: ReturnType<typeof setInterval> | null;
  signalPoll: Promise<void>;
  signalPollQueued: boolean;
  /** Latest requested permission mode, and a mode switch waiting for the on-screen prompt to clear. */
  modeTarget: BridgePermission | null;
  pendingModeTarget: BridgePermission | null;
  modeChain: Promise<unknown>;
  /** Mode transitions seen after a mode key (`<cli>:<mode>:<key>` → next mode), so later switches can plan ahead. */
  modeCycle: Map<string, Exclude<ScreenMode, null>>;
  /** Time of the last output chunk (mode keys wait for a pause in output). */
  lastOutputAt: number;
  /** Size the process was launched with, and the views that size it (not observers); restored when the last one leaves. */
  launchCols: number;
  launchRows: number;
  resizers: Set<any>;
  /** Replaced by a newer process under the same id: its late events are dropped. */
  superseded: boolean;
  endedMeta?: EndedPtySession;
  /** Title of the task the agent works on (from the spawn request), kept with its saved terminal. */
  taskTitle?: string;
  /** The terminal's copy on disk (task agents only). */
  history?: TerminalHistory;
  /**
   * Request details for the prompt with this signature, read from the session log when the CLI's panel did not fit
   * on screen (fields null while the lookup runs). Merged into every re-parse of the same prompt.
   */
  promptContext?: { signature: string; fields: Partial<CliDetectedPrompt> | null };
}

// ─── Terminal history on disk ────────────────────────────────────────────────
// A task agent's terminal output is also written to <storage>/terminals/<project>/<task>/<session>.log, with
// <session>.json (role, task, start, exit) beside it, so a task's terminals can be replayed after the app reloads or the
// bridge restarts: memory only keeps live and recently ended sessions. A task's folder is deleted when the task leaves
// the AI workspace (POST /api/pty/history/delete).

const TERMINAL_HISTORY_DIR = 'terminals';
/** A log past this size is rewritten as the session's in-memory tail, which is all a replay shows anyway. */
const TERMINAL_LOG_MAX_CHARS = 4_000_000;
const TERMINAL_REPLAY_MAX_CHARS = 400_000;
const TERMINAL_LOG_FLUSH_MS = 1_000;

interface TerminalHistory {
  file: string;
  metaFile: string;
  pending: string[];
  chars: number;
  timer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
}

interface TerminalHistoryMeta {
  id: string;
  taskId: string | number;
  taskTitle?: string;
  projectId?: string;
  role?: BridgeAgentRole;
  label?: string;
  pieceId?: string;
  runId?: string;
  cmd: string;
  args: string[];
  cwd: string;
  startedAt: string;
  endedAt?: string;
  exitCode: number | null;
}

/** A file-name-safe path segment: letters, digits, "_" and "-" kept, the rest %-encoded; long values end in a hash. */
function historySegment(value: string): string {
  const encoded = value.replace(/[^A-Za-z0-9_-]/g, (c) => `%${c.charCodeAt(0).toString(16)}`);
  if (!encoded) return '_';
  return encoded.length > 120 ? `${encoded.slice(0, 100)}-${sha256(value).slice(0, 16)}` : encoded;
}

function terminalHistoryRoot(): string {
  return path.join(getActiveStorageDir(), TERMINAL_HISTORY_DIR);
}

function terminalTaskDir(projectId: string | undefined, taskId: string | number): string {
  return path.join(terminalHistoryRoot(), historySegment(projectId || '_'), historySegment(String(taskId)));
}

function terminalHistoryMeta(session: PtySessionState): TerminalHistoryMeta {
  return {
    id: session.id,
    taskId: session.taskId,
    ...(session.taskTitle ? { taskTitle: session.taskTitle } : {}),
    ...(session.projectId ? { projectId: session.projectId } : {}),
    ...(session.role ? { role: session.role } : {}),
    ...(session.label ? { label: session.label } : {}),
    ...(session.pieceId ? { pieceId: session.pieceId } : {}),
    ...(session.runId ? { runId: session.runId } : {}),
    cmd: session.cmd,
    args: session.args,
    cwd: session.cwd,
    startedAt: session.startedAt,
    ...(session.endedAt ? { endedAt: session.endedAt } : {}),
    exitCode: session.exitCode,
  };
}

/** Starts the session's saved terminal (replacing an earlier process's under the same id). Fails soft. */
function startTerminalHistory(session: PtySessionState) {
  try {
    const dir = terminalTaskDir(session.projectId, session.taskId);
    fsSync.mkdirSync(dir, { recursive: true });
    const base = path.join(dir, historySegment(session.id));
    fsSync.writeFileSync(`${base}.log`, '');
    fsSync.writeFileSync(`${base}.json`, JSON.stringify(terminalHistoryMeta(session), null, 2));
    session.history = { file: `${base}.log`, metaFile: `${base}.json`, pending: [], chars: 0, timer: null, closed: false };
  } catch (err) {
    console.warn(`[Ergo PTY] Could not save the terminal of [${session.id}]:`, err);
  }
}

/** Writes buffered output (synchronously, so a replacing process never races an older one for the file). */
function flushTerminalHistory(session: PtySessionState) {
  const h = session.history;
  if (!h) return;
  if (h.timer) clearTimeout(h.timer);
  h.timer = null;
  if (h.pending.length === 0) return;
  const chunk = h.pending.join('');
  h.pending = [];
  try {
    if (h.chars + chunk.length > TERMINAL_LOG_MAX_CHARS) {
      const tail = session.buffer.join('');
      fsSync.writeFileSync(h.file, tail);
      h.chars = tail.length;
    } else {
      fsSync.appendFileSync(h.file, chunk);
      h.chars += chunk.length;
    }
  } catch {
    session.history = undefined; // the task's folder was deleted
  }
}

function recordTerminalOutput(session: PtySessionState, data: string) {
  const h = session.history;
  if (!h || h.closed) return;
  h.pending.push(data);
  if (!h.timer) {
    h.timer = setTimeout(() => flushTerminalHistory(session), TERMINAL_LOG_FLUSH_MS);
    h.timer.unref?.();
  }
}

/** Final flush, with the end recorded in the meta file. Output after this (a replaced process) isn't saved. */
function closeTerminalHistory(session: PtySessionState) {
  const h = session.history;
  if (!h || h.closed) return;
  flushTerminalHistory(session);
  h.closed = true;
  try {
    fsSync.writeFileSync(h.metaFile, JSON.stringify(terminalHistoryMeta(session), null, 2));
  } catch {}
}

/** The saved terminal of a session (its last TERMINAL_REPLAY_MAX_CHARS), or null when none was kept. */
async function readTerminalHistory(sessionKey: string): Promise<{ meta: TerminalHistoryMeta; data: string } | null> {
  const root = terminalHistoryRoot();
  const name = historySegment(sessionKey);
  const projects = await fs.readdir(root).catch(() => [] as string[]);
  for (const project of projects) {
    const tasks = await fs.readdir(path.join(root, project)).catch(() => [] as string[]);
    for (const task of tasks) {
      const base = path.join(root, project, task, name);
      try {
        const [log, meta] = await Promise.all([fs.readFile(`${base}.log`, 'utf-8'), fs.readFile(`${base}.json`, 'utf-8')]);
        return { meta: JSON.parse(meta), data: log.length > TERMINAL_REPLAY_MAX_CHARS ? log.slice(-TERMINAL_REPLAY_MAX_CHARS) : log };
      } catch {}
    }
  }
  return null;
}

/** The saved terminals of a project's tasks (their meta files). */
async function listTerminalHistory(projectId: string): Promise<TerminalHistoryMeta[]> {
  const projectDir = path.join(terminalHistoryRoot(), historySegment(projectId));
  const out: TerminalHistoryMeta[] = [];
  for (const task of await fs.readdir(projectDir).catch(() => [] as string[])) {
    const taskDir = path.join(projectDir, task);
    for (const file of await fs.readdir(taskDir).catch(() => [] as string[])) {
      if (!file.endsWith('.json')) continue;
      try {
        out.push(JSON.parse(await fs.readFile(path.join(taskDir, file), 'utf-8')));
      } catch {}
    }
  }
  return out;
}

const historyTitleKey = (title: unknown) => (typeof title === 'string' ? title.replace(/[~*`_]/g, '').replace(/\s+/g, ' ').trim().toLowerCase() : '');

/**
 * Deletes the saved terminals of tasks that left the AI workspace: by task id, and by title (task ids are positions in
 * the lane, so a task's terminals may sit under the id it had before tasks above it moved). Ended sessions kept in
 * memory for those tasks go too. Returns how many terminals were removed.
 */
async function deleteTerminalHistory(projectId: string, taskIds: string[], titles: string[]): Promise<number> {
  const projectDir = path.join(terminalHistoryRoot(), historySegment(projectId));
  const ids = new Set(taskIds);
  const titleKeys = new Set(titles.map(historyTitleKey).filter(Boolean));
  let removed = 0;
  for (const task of await fs.readdir(projectDir).catch(() => [] as string[])) {
    const taskDir = path.join(projectDir, task);
    const files = await fs.readdir(taskDir).catch(() => [] as string[]);
    for (const file of files.filter((f) => f.endsWith('.json'))) {
      let meta: TerminalHistoryMeta | null = null;
      try {
        meta = JSON.parse(await fs.readFile(path.join(taskDir, file), 'utf-8'));
      } catch {}
      if (!meta || !(ids.has(String(meta.taskId)) || titleKeys.has(historyTitleKey(meta.taskTitle)))) continue;
      const base = path.join(taskDir, file.slice(0, -'.json'.length));
      await Promise.all([fs.rm(`${base}.json`, { force: true }), fs.rm(`${base}.log`, { force: true })]);
      removed++;
    }
    if ((await fs.readdir(taskDir).catch(() => ['?'])).length === 0) await fs.rm(taskDir, { recursive: true, force: true });
  }
  for (const [key, ended] of endedPtySessions) {
    if ((ended.projectId || '') === projectId && ids.has(String(ended.taskId))) endedPtySessions.delete(key);
  }
  return removed;
}

const activePtySessions = new Map<string, PtySessionState>();
// A bridge update waits until no agent is running (selfUpdate.ts).
setActiveSessionCounter(() => [...activePtySessions.values()].filter((s) => s.isActive).length);
/** WebSockets attached to an id that has no live process yet (App may still be launching it). */
const ptyKeyWatchers = new Map<string, Set<any>>();
/** SSE clients of /api/pty/events. */
const agentEventClients = new Set<ServerResponse>();

const PROMPT_EVAL_THROTTLE_MS = 300;
const PROMPT_EVAL_TRAILING_MS = 250;
const AUTO_APPROVE_DEDUPE_MS = 5_000;
const AUTO_APPROVE_MAX_ATTEMPTS = 3;
const SIGNAL_POLL_MS = 1_500;
const SIGNAL_MAX_BYTES = 64 * 1024;
const MODE_SWITCH_STEP_MS = 350;
const MODE_SWITCH_MAX_PRESSES = 6;
const SAFE_RUN_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;
const SAFE_PIECE_ID_RE = /^[A-Za-z0-9_-]{1,12}$/;
const AGENT_ROLES = new Set<BridgeAgentRole>(['manager', 'worker', 'qa']);

let nodePtyModule: Promise<any> | null = null;

/** node-pty is imported lazily so Vite never tries to bundle it. */
function loadNodePty(): Promise<any> {
  if (!nodePtyModule) {
    nodePtyModule = import('node-pty')
      .then((m: any) => m.default ?? m)
      .catch((err) => {
        nodePtyModule = null;
        throw err;
      });
  }
  return nodePtyModule;
}

function safeWsSend(ws: any, obj: Record<string, unknown>) {
  if (ws?.readyState === 1 /* OPEN */) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {}
  }
}

function sendToSubscribers(session: PtySessionState, obj: Record<string, unknown>) {
  if (session.subscribers.size === 0) return;
  const payload = JSON.stringify(obj);
  for (const subscriber of session.subscribers) {
    if (subscriber.readyState === 1 /* OPEN */) {
      try {
        subscriber.send(payload);
      } catch {}
    }
  }
}

/** SSE event for App. Only task-agent sessions (launched with a role) are reported; login/onboarding terminals are not. */
function broadcastAgentEvent(session: PtySessionState, event: Record<string, unknown>) {
  if (session.superseded || !session.role) return;
  const payload = {
    ...event,
    sessionId: session.id,
    taskId: String(session.taskId),
    role: session.role,
    ...(session.runId ? { runId: session.runId } : {}),
    at: new Date().toISOString(),
  };
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of agentEventClients) {
    try {
      client.write(data);
    } catch {
      agentEventClients.delete(client);
    }
  }
}

function cliKindOf(cmd: string): 'claude' | 'gemini' | 'other' {
  const base = path.basename(cmd || '').toLowerCase();
  if (base.includes('claude')) return 'claude';
  if (base === 'gemini' || base.startsWith('gemini')) return 'gemini';
  return 'other';
}

function resolvePtyCwd(raw: unknown): string {
  let cwd = resolveStoragePath(typeof raw === 'string' && raw ? raw : os.homedir());
  try {
    if (!fsSync.existsSync(cwd)) cwd = process.cwd();
  } catch {
    cwd = process.cwd();
  }
  return cwd;
}

/** Creates `<cwd>/.ergo/runs/<runId>` and `<cwd>/.ergo/.gitignore` (`*`) so run files never reach git. */
function ensureRunDir(cwd: string, runId: string): string {
  const ergoDir = path.join(cwd, '.ergo');
  const runDir = path.join(ergoDir, 'runs', runId);
  fsSync.mkdirSync(runDir, { recursive: true });
  const gitignore = path.join(ergoDir, '.gitignore');
  if (!fsSync.existsSync(gitignore)) {
    try {
      fsSync.writeFileSync(gitignore, '*\n', 'utf-8');
    } catch {}
  }
  return runDir;
}

function signalFilesFor(session: PtySessionState): Array<{ name: string; signal: AgentSignalKind }> {
  if (!session.runId || !session.role) return [];
  if (session.role === 'manager') {
    return [
      { name: 'delegate.json', signal: 'delegate' },
      { name: 'completion.md', signal: 'complete' },
      // A question for the user mid-run (the manager ends its turn after writing it).
      { name: 'question.md', signal: 'question' },
    ];
  }
  if (session.role === 'worker') {
    return session.pieceId && SAFE_PIECE_ID_RE.test(session.pieceId) ? [{ name: `worker-${session.pieceId}.md`, signal: 'worker-done' }] : [];
  }
  return [{ name: 'qa.md', signal: 'qa-verdict' }];
}

/** "VERDICT: PASS" / "**VERDICT:** FAIL" / "# Verdict: pass" on one of the first non-empty lines. */
function parseVerifierVerdict(content: string): 'PASS' | 'FAIL' | undefined {
  const lines = content.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 5);
  for (const line of lines) {
    const m = line.match(/verdict\W{0,6}(pass|fail)/i);
    if (m) return m[1].toUpperCase() as 'PASS' | 'FAIL';
  }
  return undefined;
}

/**
 * Reads the session's signal files. Emits a file when it is new or rewritten (mtime later than the last one emitted
 * and not older than the session), non-empty and finished writing (≥ 400 ms old, unless `final`).
 */
function pollSignals(session: PtySessionState, final: boolean): Promise<void> {
  const files = signalFilesFor(session);
  if (files.length === 0 || !session.runDir) return Promise.resolve();
  if (!final && session.signalPollQueued) return session.signalPoll;
  session.signalPollQueued = true;
  const run = async () => {
    session.signalPollQueued = false;
    const startedMs = Date.parse(session.startedAt) || 0;
    for (const { name, signal } of files) {
      try {
        const abs = path.join(session.runDir!, name);
        const stat = await fs.stat(abs).catch(() => null);
        if (!stat || !stat.isFile() || stat.size === 0) continue;
        const mtime = Math.round(stat.mtimeMs);
        if (mtime <= (session.signalMtimes.get(name) ?? 0)) continue;
        if (mtime < startedMs - 2_000) continue;
        if (!final && Date.now() - mtime < 400) continue;
        const full = await fs.readFile(abs, 'utf-8');
        if (!full.trim()) continue;
        let verdict: 'PASS' | 'FAIL' | undefined;
        if (signal === 'delegate') {
          try {
            JSON.parse(full);
          } catch {
            continue; // still being written (or invalid): look again on the next poll
          }
        } else if (signal === 'qa-verdict') {
          verdict = parseVerifierVerdict(full);
          if (!verdict) {
            if (!final) continue;
            verdict = 'FAIL'; // Verifier ended without a verdict line: treat as not verified
          }
        }
        const content = full.length > SIGNAL_MAX_BYTES ? full.slice(0, SIGNAL_MAX_BYTES) : full;
        session.signalMtimes.set(name, mtime);
        const record: AgentSignalRecord = {
          signal,
          file: `.ergo/runs/${session.runId}/${name}`,
          mtime,
          content,
          ...(verdict ? { verdict } : {}),
        };
        session.signals.set(name, record);
        if (session.endedMeta) session.endedMeta.signals = Array.from(session.signals.values());
        console.log(`[Ergo PTY] Signal ${signal} from [${session.id}] (${name})`);
        await ingestRunSignal(session, name, signal, full);
        broadcastAgentEvent(session, { type: 'signal', ...record });
      } catch (err) {
        console.warn(`[Ergo PTY] Reading signal file ${name} for [${session.id}] failed:`, err);
      }
    }
    // Agent notes (<runDir>/notes/) and CLI artifacts (Claude Code todo lists) go to the AI-only memory namespace.
    await pollMemoryArtifacts(session, final);
  };
  session.signalPoll = session.signalPoll.then(run, run);
  return session.signalPoll;
}

function stopSessionTimers(session: PtySessionState) {
  if (session.evalTimer) clearTimeout(session.evalTimer);
  if (session.trailingEvalTimer) clearTimeout(session.trailingEvalTimer);
  if (session.signalTimer) clearInterval(session.signalTimer);
  session.evalTimer = null;
  session.trailingEvalTimer = null;
  session.signalTimer = null;
}

// ── Prompt detection ──

function observeTranscript(session: PtySessionState) {
  const screen = session.screen;
  const scrolled = screen.scrollCount - session.observedScroll;
  session.observedScroll = screen.scrollCount;
  const rows = scrolled > 0 && !screen.isAltScreen() ? screen.tailRows(screen.rows + Math.min(scrolled, 1500)) : screen.visibleRows();
  session.transcript.observe(rows);
}

/** Evaluate at most every 300 ms while output flows, plus once 250 ms after the last chunk (no quiet period needed). */
function schedulePromptEval(session: PtySessionState) {
  if (!session.evalTimer) {
    const wait = Math.max(0, PROMPT_EVAL_THROTTLE_MS - (Date.now() - session.lastEvalAt));
    session.evalTimer = setTimeout(() => {
      session.evalTimer = null;
      evaluateSessionScreen(session);
    }, wait);
  }
  if (session.trailingEvalTimer) clearTimeout(session.trailingEvalTimer);
  session.trailingEvalTimer = setTimeout(() => {
    session.trailingEvalTimer = null;
    evaluateSessionScreen(session);
  }, PROMPT_EVAL_TRAILING_MS);
}

function defaultOptionIndex(prompt: CliDetectedPrompt | null): number {
  return prompt?.options?.findIndex((o) => o.isDefault) ?? -1;
}

/** A prompt is confirmed (or cleared) when two consecutive evaluations agree. */
function evaluateSessionScreen(session: PtySessionState) {
  if (!session.isActive || session.superseded) return;
  session.lastEvalAt = Date.now();
  let parsed: CliDetectedPrompt | null = null;
  try {
    observeTranscript(session);
    parsed = parseCliScreenPrompt(session.screen.visibleRows(), { echoedText: session.echoedText });
  } catch (err) {
    console.warn(`[Ergo PTY] Prompt detection failed for [${session.id}]:`, err);
    return;
  }
  const signature = parsed?.signature ?? null;
  if (signature === session.candidate.signature) session.candidate.count++;
  else session.candidate = { signature, prompt: parsed, count: 1 };
  if (parsed) session.candidate.prompt = parsed;
  if (session.candidate.count < 2) return;

  if (signature === (session.prompt?.signature ?? null)) {
    // Same prompt; keep the latest rendering (the highlighted option may have moved — answers depend on it).
    if (parsed && session.prompt && defaultOptionIndex(parsed) !== defaultOptionIndex(session.prompt)) {
      session.prompt = withPromptContext(session, parsed);
      if (session.promptVisible) {
        // App (toast Approve) needs the moved highlight too: Enter answers whichever option is highlighted.
        sendToSubscribers(session, { type: 'prompt', prompt: parsed });
        broadcastAgentEvent(session, { type: 'prompt', prompt: parsed });
      }
    } else if (parsed) {
      session.prompt = withPromptContext(session, parsed);
    }
    return;
  }
  setSessionPrompt(session, parsed);
}

/** A prompt that shows neither the command nor what it would change: its panel was taller than the screen. */
function promptNeedsContext(prompt: CliDetectedPrompt): boolean {
  return prompt.kind !== 'notice' && Boolean(prompt.options?.length) && !prompt.targetCommand && !prompt.detailLines?.length;
}

function withPromptContext(session: PtySessionState, prompt: CliDetectedPrompt): CliDetectedPrompt;
function withPromptContext(session: PtySessionState, prompt: CliDetectedPrompt | null): CliDetectedPrompt | null;
function withPromptContext(session: PtySessionState, prompt: CliDetectedPrompt | null): CliDetectedPrompt | null {
  const ctx = session.promptContext;
  if (!prompt || !ctx?.fields || ctx.signature !== prompt.signature) return prompt;
  const fields = Object.fromEntries(Object.entries(ctx.fields).filter(([, v]) => v !== undefined));
  return { ...prompt, ...fields };
}

/** When the log names it, how long after a prompt appears its tool call is looked up (the log may lag the screen). */
const PROMPT_CONTEXT_RETRY_MS = [0, 600, 1500, 3000];

/**
 * Fills in what a prompt asks to approve from the call waiting on it in the CLI's session log (the newest pending
 * call that isn't a question to the user), then re-sends the prompt — and re-checks Full-access auto-approval, since
 * a request with a pending tool call behind it is a permission prompt.
 */
function lookUpPromptContext(session: PtySessionState, prompt: CliDetectedPrompt) {
  if (session.promptContext?.signature === prompt.signature) return;
  session.promptContext = { signature: prompt.signature, fields: null };
  void (async () => {
    for (const delay of PROMPT_CONTEXT_RETRY_MS) {
      if (delay) await sleep(delay);
      if (!session.isActive || session.superseded || session.prompt?.signature !== prompt.signature) return;
      const call = pendingCallForPrompt((await readActivityFold(session))?.fold ?? newActivityFold());
      if (!call) continue;
      session.promptContext = { signature: prompt.signature, fields: { ...promptContextOfCall(call), kind: 'approval' } };
      setSessionPrompt(session, session.prompt);
      return;
    }
  })();
}

function setSessionPrompt(session: PtySessionState, prompt: CliDetectedPrompt | null) {
  const wasVisible = session.promptVisible;
  prompt = withPromptContext(session, prompt);
  session.prompt = prompt;
  if (prompt && promptNeedsContext(prompt)) lookUpPromptContext(session, prompt);
  session.promptVisible = false;
  const visible = prompt ? !tryAutoApprove(session, prompt) : false;
  if (visible) {
    session.promptVisible = true;
    sendToSubscribers(session, { type: 'prompt', prompt });
    broadcastAgentEvent(session, { type: 'prompt', prompt });
  } else if (wasVisible) {
    sendToSubscribers(session, { type: 'prompt', prompt: null });
    broadcastAgentEvent(session, { type: 'prompt', prompt: null });
  }
  if (!prompt) {
    // The previous prompt was answered: auto-approvals for it succeeded.
    for (const rec of session.autoApproved.values()) rec.attempts = 0;
    if (session.pendingModeTarget) {
      const target = session.pendingModeTarget;
      session.pendingModeTarget = null;
      void runModeSwitch(session, target).then((result) => {
        broadcastAgentEvent(session, { type: 'policy', permissionLevel: target, applied: result.applied, deferred: true, ...(result.detail ? { detail: result.detail } : {}) });
      });
    }
  }
}

/**
 * Under Full access, answers an approval prompt with its plain "Yes / Allow once" option. Returns true when the
 * prompt is being handled (keys sent, or waiting out the dedupe window), false when the user must answer it.
 */
function tryAutoApprove(session: PtySessionState, prompt: CliDetectedPrompt): boolean {
  // Only task agents: the user's own terminals (login / onboarding shells) are never answered for them.
  if (!session.role || session.permissionLevel !== 'bypass' || prompt.kind !== 'approval' || isBypassAcceptanceDialog(prompt)) return false;
  const option = pickApproveOption(prompt);
  if (!option || !session.isActive || !session.ptyProcess) return false;
  const now = Date.now();
  for (const [sig, rec] of session.autoApproved) if (now - rec.at > 60_000) session.autoApproved.delete(sig);
  const rec = session.autoApproved.get(prompt.signature);
  const scheduleRecheck = (delay: number) => {
    setTimeout(() => {
      if (session.isActive && !session.superseded && session.prompt?.signature === prompt.signature && !session.promptVisible) {
        setSessionPrompt(session, session.prompt);
      }
    }, delay);
  };
  if (rec && now - rec.at < AUTO_APPROVE_DEDUPE_MS) {
    scheduleRecheck(rec.at + AUTO_APPROVE_DEDUPE_MS - now + 50);
    return true;
  }
  if (rec && rec.attempts >= AUTO_APPROVE_MAX_ATTEMPTS) {
    console.warn(`[Ergo PTY] Auto-approve did not clear the prompt on [${session.id}] after ${rec.attempts} attempts; asking the user.`);
    return false;
  }
  try {
    session.ptyProcess.write(keystrokesForOption(prompt, option));
  } catch {
    return false;
  }
  session.autoApproved.set(prompt.signature, { at: now, attempts: (rec?.attempts ?? 0) + 1 });
  scheduleRecheck(AUTO_APPROVE_DEDUPE_MS + 50);
  const summary = promptSummary(prompt);
  console.log(`[Ergo PTY] Auto-approved on [${session.id}]: ${summary}`);
  sendToSubscribers(session, { type: 'auto-approved', summary });
  broadcastAgentEvent(session, { type: 'auto-approved', summary });
  return true;
}

// ── Live permission changes ──

type PolicyApplied = 'live' | 'auto-approve-only' | 'restart-required' | 'unchanged';
type ScreenMode = BridgePermission | 'auto' | null;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Claude Code's permission mode, from its footer ("⏵⏵ accept edits on", "⏸ plan mode on", "⏸ manual mode on"…). */
function readClaudeMode(rows: string[]): ScreenMode {
  const bottom = rows.map((r) => r.trim()).filter(Boolean).slice(-8);
  const text = bottom.join('\n');
  if (/bypass permissions on/i.test(text)) return 'bypass';
  if (/accept edits on/i.test(text)) return 'acceptEdits';
  if (/plan mode on/i.test(text)) return 'plan';
  if (/auto mode on/i.test(text)) return 'auto';
  if (/manual mode on|default mode on/i.test(text)) return 'ask';
  // Older versions show no footer in the default mode: accept it only when the input box is clearly on screen.
  if (bottom.some((r) => /^❯(?:\s|$)/.test(r)) && /\? for shortcuts|shift\+tab|esc to interrupt|^─{20,}$/m.test(text)) return 'ask';
  return null;
}

/**
 * Gemini CLI's approval mode, from its footer indicator: "YOLO ctrl+y", "auto-accept edits shift+tab to plan|manual",
 * "plan shift+tab to manual", and "shift+tab to accept edits" in the default mode (minimal UI: "● auto edit" /
 * "● plan" / "● YOLO", nothing in the default mode, and nothing at all while Gemini is busy).
 */
function readGeminiMode(rows: string[]): ScreenMode {
  const text = rows.map((r) => r.trim()).filter(Boolean).slice(-8).join('\n');
  if (/\bYOLO\b/.test(text) || /yolo mode/i.test(text)) return 'bypass';
  if (/accepting edits|auto[- ]?accept(?:ing)? edits|\bauto[_ ]edit\b/i.test(text)) return 'acceptEdits';
  if (/plan mode|(?:^|[\s●])plan\b[^\n]*\bto manual\b|●\s*plan\b/im.test(text)) return 'plan';
  if (/\bto accept edits\b/i.test(text)) return 'ask';
  // No indicator: the minimal UI's default mode, unless Gemini is busy (every indicator is hidden then).
  if (/esc to cancel/i.test(text)) return null;
  return 'ask';
}

function promptOnScreen(session: PtySessionState): boolean {
  if (session.prompt) return true;
  try {
    return Boolean(parseCliScreenPrompt(session.screen.visibleRows(), { echoedText: session.echoedText }));
  } catch {
    return false;
  }
}

type ModeSwitchResult = { ok: boolean; queued?: boolean; detail?: string };

/** How much a mode lets the agent do without asking. Never rest on a mode above both the start and the target. */
const MODE_RANK: Record<string, number> = { plan: 0, ask: 1, acceptEdits: 2, auto: 3, bypass: 4 };
const modeRank = (mode: ScreenMode) => (mode ? MODE_RANK[mode] ?? 0 : 0);
const MODE_POLL_MS = 25;
/** Keys are sent only after the CLI's output has paused this long (bounded), so they never race a frame in flight. */
const MODE_QUIET_MS = 80;
const MODE_QUIET_MAX_WAIT_MS = 600;
const MODE_QUIET_ESCALATED_MAX_WAIT_MS = 150;

async function waitForQuietOutput(session: PtySessionState, maxWaitMs = MODE_QUIET_MAX_WAIT_MS) {
  const deadline = Date.now() + maxWaitMs;
  while (session.isActive && Date.now() < deadline && Date.now() - session.lastOutputAt < MODE_QUIET_MS) await sleep(MODE_POLL_MS);
}

/** Polls the screen after a key press until it shows a mode other than `from`; null when it never changes. */
async function waitForModeChange(session: PtySessionState, read: () => ScreenMode, from: ScreenMode): Promise<ScreenMode> {
  const deadline = Date.now() + MODE_SWITCH_STEP_MS * 2;
  while (Date.now() < deadline) {
    await sleep(MODE_POLL_MS);
    if (!session.isActive || session.superseded) return null;
    const mode = read();
    if (mode !== null && mode !== from) return mode;
  }
  return null;
}

interface ModeDriver {
  /** "Claude Code" / "Gemini CLI", for messages. */
  name: string;
  read: () => ScreenMode;
  /** Keys that move `mode` one step toward `goal`, or why no safe step exists. */
  step: (mode: Exclude<ScreenMode, null>, goal: BridgePermission) => { keys: string } | { refuse: string };
  /** Checked once against the starting mode, before any key is sent; returns why the switch must not start. */
  precheck?: (initial: Exclude<ScreenMode, null>, goal: BridgePermission) => string | null;
}

/**
 * Steps a CLI's permission mode toward `goal` one key at a time, reading the screen after every key. Never presses
 * while a prompt is open (re-checked right before each key), and moves straight on from a mode that is more
 * permissive than both the start and the goal. On failure it steps back to the starting mode where that is safe.
 */
async function driveModeSwitch(session: PtySessionState, goal: BridgePermission, driver: ModeDriver, rollback = false): Promise<ModeSwitchResult> {
  const ended = (): ModeSwitchResult | null => {
    if (!session.isActive || session.superseded) return { ok: false, detail: 'The session has ended.' };
    if (!rollback && session.modeTarget !== goal) return { ok: false, detail: 'Superseded by a newer permission change.' };
    return null;
  };
  let initial: ScreenMode = null;
  let unreadable = 0;
  let stalls = 0;
  let presses = 0;
  const left = new Set<ScreenMode>();
  const fail = async (detail: string): Promise<ModeSwitchResult> => {
    // Go back to the starting mode rather than leaving an arbitrary one on, but only when that is no more permissive.
    const start = initial;
    const now = driver.read();
    if (!rollback && start && start !== 'auto' && now && now !== start && modeRank(start) <= modeRank(now) && !ended()) {
      await driveModeSwitch(session, start, driver, true).catch(() => undefined);
    }
    return { ok: false, detail };
  };
  while (true) {
    const stop = ended();
    if (stop) return stop;
    if (promptOnScreen(session)) return { ok: false, queued: true };
    const mode = driver.read();
    if (mode === goal) return { ok: true };
    if (mode === null) {
      // Mode not readable right now (repaint, overlay, busy): wait a moment, but never press blind.
      if (++unreadable > 4) return fail(`Could not read ${driver.name}'s permission mode.`);
      await sleep(MODE_SWITCH_STEP_MS);
      continue;
    }
    if (initial === null) {
      initial = mode;
      const refused = driver.precheck?.(mode, goal);
      if (refused) return { ok: false, detail: refused };
    }
    // Back at a mode already left once: the goal is not in this cycle.
    if (left.has(mode)) return fail(`This mode is not in ${driver.name}'s mode cycle.`);
    if (presses >= MODE_SWITCH_MAX_PRESSES) return fail(`${driver.name} did not reach this mode after ${presses} key presses.`);
    const step = driver.step(mode, goal);
    if ('refuse' in step) return fail(step.refuse);
    // A mode more permissive than both the start and the goal (auto) is left quickly, but still only after a short
    // pause in output: a dialog drawn in that gap would take the key (shift+tab answers Claude's edit dialog).
    const escalated = modeRank(mode) > Math.max(modeRank(initial), modeRank(goal));
    await waitForQuietOutput(session, escalated ? MODE_QUIET_ESCALATED_MAX_WAIT_MS : MODE_QUIET_MAX_WAIT_MS);
    const again = ended();
    if (again) return again;
    if (driver.read() !== mode) continue;
    // Checked immediately before the key: a key landing in a permission dialog would answer it.
    if (promptOnScreen(session)) return { ok: false, queued: true };
    try {
      session.ptyProcess.write(step.keys);
    } catch {
      return { ok: false, detail: 'Could not write to the terminal.' };
    }
    presses++;
    const next = await waitForModeChange(session, driver.read, mode);
    if (next === null) {
      if (++stalls >= 2) return fail(`${driver.name} did not respond to the mode key.`);
      continue;
    }
    left.add(mode);
    session.modeCycle.set(`${driver.name}:${mode}:${step.keys}`, next);
  }
}

/** True when Claude Code's shift+tab cycle includes bypass permissions (observed, else from its launch flags). */
function claudeBypassInCycle(session: PtySessionState): boolean {
  const seen = session.modeCycle.get('Claude Code:plan:\x1b[Z');
  if (seen !== undefined) return seen === 'bypass';
  if (session.args.some((a) => /^--(?:allow-)?dangerously-skip-permissions(?:=|$)/.test(a))) return true;
  return argValue(session.args, '--permission-mode') === 'bypassPermissions';
}

/** Claude Code 2.1's shift+tab cycle: default → acceptEdits → plan → [bypassPermissions] → [auto] → default. */
function predictClaudeNext(session: PtySessionState, mode: Exclude<ScreenMode, null>): Exclude<ScreenMode, null> {
  const seen = session.modeCycle.get(`Claude Code:${mode}:\x1b[Z`);
  if (seen) return seen;
  switch (mode) {
    case 'ask':
      return 'acceptEdits';
    case 'acceptEdits':
      return 'plan';
    case 'plan':
      return claudeBypassInCycle(session) ? 'bypass' : 'auto';
    case 'bypass':
      return 'auto';
    default:
      return 'ask';
  }
}

const CLAUDE_CROSSES_BYPASS =
  "Claude Code can only reach this mode by cycling through bypass permissions, which would let tools run unapproved in between; restart the agent to apply it.";

/**
 * Cycles Claude Code's mode with shift+tab (there is no reverse key). It never passes through bypass permissions on
 * the way to another mode, and moves straight on from auto mode; such a switch needs a restart instead.
 */
function switchClaudeMode(session: PtySessionState, target: BridgePermission): Promise<ModeSwitchResult> {
  return driveModeSwitch(session, target, {
    name: 'Claude Code',
    read: () => readClaudeMode(session.screen.visibleRows()),
    precheck: (initial, goal) => {
      let mode = initial;
      for (let i = 0; i < MODE_SWITCH_MAX_PRESSES && mode !== goal; i++) {
        const next = predictClaudeNext(session, mode);
        if (next === 'bypass' && goal !== 'bypass') return CLAUDE_CROSSES_BYPASS;
        mode = next;
      }
      if (mode === goal) return null;
      return goal === 'bypass'
        ? "Bypass permissions is not in this Claude Code session's shift+tab cycle."
        : "This mode is not in Claude Code's shift+tab cycle.";
    },
    step: (mode, goal) =>
      predictClaudeNext(session, mode) === 'bypass' && goal !== 'bypass' ? { refuse: CLAUDE_CROSSES_BYPASS } : { keys: '\x1b[Z' },
  });
}

/**
 * Gemini CLI: Ctrl+Y toggles YOLO (off lands in DEFAULT, not the launch mode); shift+tab cycles
 * DEFAULT → AUTO_EDIT → [PLAN] → DEFAULT, and YOLO → AUTO_EDIT. The result is read back from the footer.
 */
function switchGeminiMode(session: PtySessionState, target: BridgePermission): Promise<ModeSwitchResult> {
  return driveModeSwitch(session, target, {
    name: 'Gemini CLI',
    read: () => readGeminiMode(session.screen.visibleRows()),
    step: (mode, goal) => {
      if (goal === 'bypass') return { keys: '\x19' };
      if (mode === 'bypass') return { keys: goal === 'ask' ? '\x19' : '\x1b[Z' };
      if (mode === 'acceptEdits' && goal === 'plan') {
        const footer = session.screen.visibleRows().map((r) => r.trim()).filter(Boolean).slice(-8).join('\n');
        if (/\bto manual\b/i.test(footer) && !/\bto plan\b/i.test(footer)) return { refuse: "Gemini CLI's plan mode is not enabled in this session." };
      }
      return { keys: '\x1b[Z' };
    },
  });
}

function policyFallback(session: PtySessionState, target: BridgePermission, detail?: string): { applied: PolicyApplied; detail?: string } {
  if (target === 'bypass') return { applied: 'auto-approve-only', detail: detail ? `${detail} Ergo approves its prompts instead.` : 'Ergo approves its prompts automatically.' };
  return { applied: 'restart-required', detail: detail || `${path.basename(session.cmd)} can't change this permission level while running.` };
}

/** Runs one mode switch for `target` after any switch already in progress. */
function runModeSwitch(session: PtySessionState, target: BridgePermission): Promise<{ applied: PolicyApplied; detail?: string }> {
  session.modeTarget = target;
  const kind = cliKindOf(session.cmd);
  const job = session.modeChain.then(async (): Promise<{ applied: PolicyApplied; detail?: string }> => {
    if (session.modeTarget !== target) return { applied: 'unchanged', detail: 'Superseded by a newer permission change.' };
    const result = kind === 'claude' ? await switchClaudeMode(session, target) : await switchGeminiMode(session, target);
    if (result.ok) return { applied: 'live' };
    if (result.queued) {
      session.pendingModeTarget = target;
      if (!session.prompt) {
        // Only a passing frame parsed as a prompt (never confirmed), so no prompt-cleared event will run the queued
        // switch. Retry on our own once the screen has had time to settle.
        setTimeout(() => {
          if (session.pendingModeTarget !== target || session.prompt || !session.isActive) return;
          session.pendingModeTarget = null;
          void runModeSwitch(session, target).then((retry) => {
            broadcastAgentEvent(session, { type: 'policy', permissionLevel: target, applied: retry.applied, deferred: true, ...(retry.detail ? { detail: retry.detail } : {}) });
          });
        }, 1500);
      }
      return target === 'bypass'
        ? { applied: 'auto-approve-only', detail: 'Ergo approves the open prompt now and switches the mode once it is answered.' }
        : { applied: 'live', detail: 'Switches as soon as the open prompt is answered.' };
    }
    return policyFallback(session, target, result.detail);
  });
  session.modeChain = job.catch(() => undefined);
  return job.catch((err) => policyFallback(session, target, String(err?.message || err)));
}

async function applySessionPolicy(session: PtySessionState, level: BridgePermission): Promise<{ sessionId: string; applied: PolicyApplied; detail?: string }> {
  const previous = session.permissionLevel;
  session.permissionLevel = level;
  // A prompt already on screen: approve it now (bypass), or show it again (it was being auto-approved).
  if (session.prompt && (level === 'bypass' ? session.promptVisible : !session.promptVisible)) setSessionPrompt(session, session.prompt);
  let result: { applied: PolicyApplied; detail?: string };
  if (!session.isActive) {
    result = { applied: 'unchanged', detail: 'The session has ended.' };
  } else {
    const kind = cliKindOf(session.cmd);
    if (kind === 'claude' || kind === 'gemini') {
      result = await runModeSwitch(session, level);
    } else if (level === 'bypass') {
      result = { applied: 'auto-approve-only', detail: 'Ergo approves its prompts automatically.' };
    } else if (level !== (session.launchPermissionLevel ?? previous)) {
      result = { applied: 'restart-required', detail: `${path.basename(session.cmd)} can't change this permission level while running.` };
    } else {
      result = { applied: 'unchanged' };
    }
  }
  broadcastAgentEvent(session, { type: 'policy', permissionLevel: level, applied: result.applied, ...(result.detail ? { detail: result.detail } : {}) });
  return { sessionId: session.id, ...result };
}

// ── Spawn / kill ──

interface PtySpawnOptions {
  sessionKey: string;
  taskId: string | number;
  projectId?: string;
  cmd: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  spawnId?: string;
  role?: BridgeAgentRole;
  label?: string;
  pieceId?: string;
  runId?: string;
  runDir?: string;
  permissionLevel?: BridgePermission;
  /** The run invoked a skill that uses Ergo's workspace tools: its ergo-memory MCP server lists them (relayed to the app). */
  workspaceTools?: boolean;
  /** The WebSocket that asked for the launch (legacy WS spawn). */
  subscriber?: any;
  taskTitle?: string;
}

function terminateProcess(session: PtySessionState) {
  if (!session.isActive) return; // never signal a pid that may already belong to another process
  try {
    if (typeof session.ptyProcess?.pid === 'number' && session.ptyProcess.pid > 0) {
      const pid = session.ptyProcess.pid;
      try {
        // Kill the process group first to stop child CLI processes (e.g. gemini-cli, node, bash)
        process.kill(-pid, 'SIGTERM');
      } catch {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {}
      }
      try {
        session.ptyProcess.kill('SIGKILL');
      } catch {
        try {
          session.ptyProcess.kill();
        } catch {}
      }
      // Ensure the process group is gone
      setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {}
      }, 200);
    }
  } catch {}
}

/** Kills a session (if running) and moves it to endedPtySessions. Its exit is reported when the process dies. */
function killPtySession(session: PtySessionState, reason: string) {
  const wasActive = session.isActive;
  terminateProcess(session);
  session.isActive = false;
  session.endedAt = session.endedAt || new Date().toISOString();
  if (session.evalTimer) clearTimeout(session.evalTimer);
  if (session.trailingEvalTimer) clearTimeout(session.trailingEvalTimer);
  session.evalTimer = null;
  session.trailingEvalTimer = null;
  rememberEndedPtySession(session.id, session);
  if (activePtySessions.get(session.id) === session) activePtySessions.delete(session.id);
  if (!wasActive) stopSessionTimers(session);
  // The exit handler stops the signal watcher after its final poll; this is the backstop if the exit never comes.
  else setTimeout(() => stopSessionTimers(session), 10_000);
  console.log(`[Ergo PTY] Session [${session.id}] killed (${reason}).`);
}

function resizeSession(session: PtySessionState, cols: unknown, rows: unknown) {
  if (typeof cols !== 'number' || typeof rows !== 'number' || cols < 2 || rows < 1) return;
  const c = Math.min(500, Math.floor(cols));
  const r = Math.min(300, Math.floor(rows));
  if (c === session.screen.cols && r === session.screen.rows) return;
  if (session.isActive) {
    try {
      session.ptyProcess?.resize(c, r);
    } catch {}
  }
  session.screen.resize(c, r);
  // Observers (Notes view) keep their own screen model in sync with the PTY size.
  sendToSubscribers(session, { type: 'resized', cols: c, rows: r });
}

/**
 * The user's Claude Code user settings (~/.claude/settings.json) without `enabledPlugins` (and without `model` when
 * Ergo passes --model), written to a private temp file for `--settings`, used with `--setting-sources project,local`.
 * Permissions, API-key helper, effort and hooks carry over unchanged. Null when it can't be written (the agent then
 * starts with the full settings, as before).
 */
function writeAgentClaudeSettings(opts: { apiKeyHelperOff: boolean; keepModel: boolean }): string | null {
  try {
    let user: Record<string, unknown> = {};
    try {
      user = JSON.parse(fsSync.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf-8')) || {};
    } catch {}
    const { enabledPlugins: _plugins, ...rest } = user;
    if (!opts.keepModel) delete rest.model;
    if (opts.apiKeyHelperOff) rest.apiKeyHelper = '';
    const file = path.join(os.tmpdir(), `ergo-agent-claude-settings-${process.getuid?.() ?? 'u'}.json`);
    fsSync.writeFileSync(file, JSON.stringify(rest), { mode: 0o600 });
    fsSync.chmodSync(file, 0o600);
    return file;
  } catch (err) {
    console.warn('[Ergo PTY] Could not write agent Claude settings; using the full settings:', err);
    return null;
  }
}

/**
 * Starts a PTY process under `sessionKey` (both REST /api/pty/spawn and the legacy WS spawn use this).
 * A session already running under that key is killed and replaced; views attached to it (or waiting for the
 * key) follow the new process. Throws when the process cannot be spawned.
 */
function spawnPtySession(pty: any, opts: PtySpawnOptions): PtySessionState {
  const sessionKey = opts.sessionKey;
  const cmd = opts.cmd || 'bash';
  const args = [...opts.args];
  const customEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.env && typeof opts.env === 'object' ? opts.env : {})) {
    if (typeof v === 'string') customEnv[k] = v;
  }

  if (cmd.includes('agy') || cmd === 'antigravity') {
    const flag = path.join(os.homedir(), '.gemini', '.ergo_disconnected_agy');
    if (fsSync.existsSync(flag)) {
      try { fsSync.unlinkSync(flag); } catch {}
    }
  }

  const cwd = opts.cwd;
  // Task agents get Ergo's memory MCP server: launch flags before the prompt (claude, codex) or a config file
  // entry (gemini, agy). Fails soft.
  if (opts.role) {
    getMemoryStore().warm(); // the agent's first signal / memory call should not wait for the model
    registerMemoryMcp({ cmd, args, cwd, projectId: opts.projectId, taskId: opts.taskId, runId: opts.runId, sessionId: sessionKey, workspaceTools: opts.workspaceTools });
  }
  // If running Claude CLI, sync API key approval and workspace trust into ~/.claude.json
  if (cmd.toLowerCase().includes('claude')) {
    const anthropicKey = customEnv.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
    syncClaudeConfig(anthropicKey, cwd);
    // Task agents run with the user's Claude Code settings minus their plugins: plugin skill and agent listings are
    // ~9k tokens in every agent's first prompt (28.6k → 19.6k measured) and Ergo's agents follow Ergo's own skills.
    const agentSettings = opts.role && !args.includes('--settings') && !args.includes('--setting-sources')
      ? writeAgentClaudeSettings({ apiKeyHelperOff: Boolean(anthropicKey), keepModel: !args.includes('--model') })
      : null;
    if (agentSettings) {
      args.push('--setting-sources', 'project,local', '--settings', agentSettings);
    } else if (anthropicKey && !args.includes('--settings')) {
      args.push('--settings', '{"apiKeyHelper":""}');
    }
  }
  const cols = typeof opts.cols === 'number' && opts.cols > 1 ? Math.min(500, Math.floor(opts.cols)) : 120;
  const rows = typeof opts.rows === 'number' && opts.rows > 0 ? Math.min(300, Math.floor(opts.rows)) : 40;

  // Replace whatever runs under this key; its views follow the new process.
  const previous = activePtySessions.get(sessionKey);
  const followers = new Set<any>();
  if (previous) {
    previous.superseded = true;
    closeTerminalHistory(previous);
    if (previous.isActive) {
      console.log(`[Ergo PTY] Replacing session [${sessionKey}] (pid ${previous.ptyProcess?.pid})`);
      killPtySession(previous, 'replaced by a new launch');
    } else {
      rememberEndedPtySession(sessionKey, previous);
      activePtySessions.delete(sessionKey);
      stopSessionTimers(previous);
    }
    for (const ws of previous.subscribers) followers.add(ws);
    previous.subscribers.clear();
  }
  for (const ws of ptyKeyWatchers.get(sessionKey) || []) followers.add(ws);
  ptyKeyWatchers.delete(sessionKey);
  if (opts.subscriber) followers.delete(opts.subscriber);

  console.log(`[Ergo PTY] Spawning session [${sessionKey}]: ${cmd} ${args.join(' ')} in ${cwd}`);
  const proc = pty.spawn(cmd, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: {
      ...process.env,
      ...customEnv,
    } as Record<string, string>,
  });

  const session: PtySessionState = {
    id: sessionKey,
    taskId: opts.taskId,
    projectId: opts.projectId,
    cmd,
    args,
    cwd,
    ptyProcess: proc,
    buffer: [],
    bufferLength: 0,
    maxBufferChars: 200000,
    subscribers: new Set(opts.subscriber ? [opts.subscriber] : []),
    isActive: true,
    exitCode: null,
    startedAt: new Date().toISOString(),
    spawnId: opts.spawnId,
    role: opts.role,
    label: opts.label,
    pieceId: opts.pieceId,
    runId: opts.runId,
    runDir: opts.runDir,
    workspaceTools: opts.workspaceTools === true,
    permissionLevel: opts.permissionLevel,
    launchPermissionLevel: opts.permissionLevel,
    echoedText: args.join('\n'),
    screen: new TerminalScreen(cols, rows),
    transcript: new ScreenTranscript(),
    observedScroll: 0,
    prompt: null,
    promptVisible: false,
    candidate: { signature: null, prompt: null, count: 0 },
    lastEvalAt: 0,
    evalTimer: null,
    trailingEvalTimer: null,
    autoApproved: new Map(),
    signals: new Map(),
    signalMtimes: new Map(),
    signalTimer: null,
    signalPoll: Promise.resolve(),
    signalPollQueued: false,
    modeTarget: null,
    pendingModeTarget: null,
    modeChain: Promise.resolve(),
    modeCycle: new Map(),
    lastOutputAt: 0,
    launchCols: cols,
    launchRows: rows,
    resizers: new Set(opts.subscriber ? [opts.subscriber] : []),
    superseded: false,
    ...(opts.taskTitle ? { taskTitle: opts.taskTitle } : {}),
  };
  activePtySessions.set(sessionKey, session);
  if (opts.role) startTerminalHistory(session);

  proc.onData((data: string) => {
    session.lastOutputAt = Date.now();
    session.buffer.push(data);
    session.bufferLength += data.length;
    while (session.bufferLength > session.maxBufferChars && session.buffer.length > 1) {
      const removed = session.buffer.shift();
      if (removed) session.bufferLength -= removed.length;
    }
    sendToSubscribers(session, { type: 'data', data });
    recordTerminalOutput(session, data);
    try {
      session.screen.write(data);
    } catch (err) {
      console.warn(`[Ergo PTY] Screen model error for [${sessionKey}]:`, err);
    }
    schedulePromptEval(session);
  });

  proc.onExit(({ exitCode }: { exitCode: number }) => {
    console.log(`[Ergo PTY] Session [${sessionKey}] exited with code ${exitCode}`);
    session.isActive = false;
    session.endedAt = session.endedAt || new Date().toISOString();
    session.exitCode = exitCode;
    if (session.endedMeta) session.endedMeta.exitCode = exitCode;
    closeTerminalHistory(session);
    if (session.evalTimer) clearTimeout(session.evalTimer);
    if (session.trailingEvalTimer) clearTimeout(session.trailingEvalTimer);
    session.evalTimer = null;
    session.trailingEvalTimer = null;
    try {
      observeTranscript(session);
    } catch {}
    if (session.prompt) {
      const wasVisible = session.promptVisible;
      session.prompt = null;
      session.promptVisible = false;
      if (wasVisible) {
        sendToSubscribers(session, { type: 'prompt', prompt: null });
        broadcastAgentEvent(session, { type: 'prompt', prompt: null });
      }
    }
    // Signal files written just before exiting are reported before the exit itself.
    void pollSignals(session, true).finally(() => {
      stopSessionTimers(session);
      sendToSubscribers(session, { type: 'exit', code: exitCode });
      broadcastAgentEvent(session, { type: 'exit', code: exitCode });
    });
  });

  if (signalFilesFor(session).length > 0 && session.runDir) {
    session.signalTimer = setInterval(() => {
      if (session.isActive) void pollSignals(session, false);
    }, SIGNAL_POLL_MS);
  }

  for (const ws of followers) {
    if (ws.readyState !== 1 /* OPEN */) continue;
    session.subscribers.add(ws);
    safeWsSend(ws, { type: 'ready', reattached: false, restarted: true, taskId: session.taskId, sessionId: sessionKey, cols, rows });
    safeWsSend(ws, { type: 'replay', data: '' }); // clears the view for the new process
  }
  return session;
}

function sessionInfo(s: PtySessionState) {
  return {
    id: s.id,
    taskId: s.taskId,
    ...(s.projectId ? { projectId: s.projectId } : {}),
    ...(s.role ? { role: s.role } : {}),
    ...(s.label ? { label: s.label } : {}),
    ...(s.pieceId ? { pieceId: s.pieceId } : {}),
    ...(s.runId ? { runId: s.runId } : {}),
    ...(s.spawnId ? { spawnId: s.spawnId } : {}),
    ...(s.permissionLevel ? { permissionLevel: s.permissionLevel } : {}),
    cmd: s.cmd,
    args: s.args,
    cwd: s.cwd,
    isActive: s.isActive,
    exitCode: s.exitCode,
    startedAt: s.startedAt,
    ...(s.endedAt ? { endedAt: s.endedAt } : {}),
    hasSubscribers: s.subscribers.size > 0,
    prompt: s.promptVisible ? s.prompt : null,
    signals: Array.from(s.signals.values()),
  };
}

export function ergoPtyPlugin(): Plugin {
  return {
    name: 'ergo-pty',
    configureServer(server) {
      // REST API: App launches and steers agent sessions; views only attach over the WebSocket.
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const url = req.url?.split('?')[0];
        if (!url?.startsWith('/api/pty/')) return next();
        if (!guardBridgeRequest(req, res)) return;

        if (url === '/api/pty/sessions' && req.method === 'GET') {
          const sessions = Array.from(activePtySessions.values()).map(sessionInfo);
          return sendJson(res, 200, { success: true, sessions });
        }

        // Saved terminals of a project's tasks that aren't in /api/pty/sessions (ended a while ago, or before a restart).
        if (url === '/api/pty/history' && req.method === 'GET') {
          const projectId = new URL(req.url || '', 'http://bridge').searchParams.get('projectId') || '';
          if (!projectId) return sendJson(res, 400, { success: false, error: 'projectId is required.' });
          const sessions = (await listTerminalHistory(projectId)).filter((m) => !activePtySessions.has(m.id));
          return sendJson(res, 200, { success: true, sessions });
        }

        if (url === '/api/pty/history/delete' && req.method === 'POST') {
          let body: any;
          try {
            body = await parseJsonBody(req);
          } catch {
            return sendJson(res, 400, { success: false, error: 'Invalid JSON body.' });
          }
          const projectId = typeof body?.projectId === 'string' ? body.projectId : '';
          if (!projectId) return sendJson(res, 400, { success: false, error: 'projectId is required.' });
          const taskIds = (Array.isArray(body.taskIds) ? body.taskIds : []).filter((id: unknown) => typeof id === 'string' || typeof id === 'number').map(String);
          const titles = (Array.isArray(body.titles) ? body.titles : []).filter((t: unknown) => typeof t === 'string');
          const removed = await deleteTerminalHistory(projectId, taskIds, titles);
          return sendJson(res, 200, { success: true, removed });
        }

        if (url === '/api/pty/events' && req.method === 'GET') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
          });
          res.write('data: {"type":"connected"}\n\n');
          agentEventClients.add(res);
          const heartbeat = setInterval(() => {
            try {
              res.write(': keep-alive\n\n');
            } catch {
              clearInterval(heartbeat);
              agentEventClients.delete(res);
            }
          }, 20_000);
          req.on('close', () => {
            clearInterval(heartbeat);
            agentEventClients.delete(res);
          });
          return;
        }

        if (url === '/api/pty/usage' && req.method === 'GET') {
          const fullUrl = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
          const id = fullUrl.searchParams.get('sessionId') || '';
          const meta: PtyUsageMeta | undefined = activePtySessions.get(id) || endedPtySessions.get(id);
          if (!meta) return sendJson(res, 404, { success: false, error: 'No PTY session with that id.' });
          const { usage, source } = await resolvePtySessionUsage(meta);
          return sendJson(res, 200, { success: true, usage, source, cli: path.basename(meta.cmd) });
        }

        if (url === '/api/pty/activity' && req.method === 'GET') {
          // What the agent is doing now, in plain words (the status line above the task prompt box).
          const fullUrl = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
          const id = fullUrl.searchParams.get('sessionId') || '';
          const live = activePtySessions.get(id);
          const ended = live ? undefined : endedPtySessions.get(id);
          const meta: PtyUsageMeta | undefined = live || ended;
          if (!meta) return sendJson(res, 404, { success: false, error: 'No PTY session with that id.' });
          let liveRows: string[] = [];
          if (live?.isActive) {
            try {
              observeTranscript(live);
              liveRows = live.screen.visibleRows();
            } catch {}
          }
          const { activity, source } = await readAgentActivity(meta, live ? live.transcript : ended?.transcript, liveRows);
          const body: AgentActivityResponse = {
            success: true,
            activity,
            source,
            isActive: Boolean(live?.isActive),
            spinner: liveRows.some((row) => isSpinnerRow(cleanRow(row))),
            quietMs: live?.isActive && live.lastOutputAt ? Date.now() - live.lastOutputAt : null,
          };
          return sendJson(res, 200, body);
        }

        if (url === '/api/pty/cli-session' && req.method === 'GET') {
          // The agent CLI's own resumable conversation id (a follow-up resumes the manager with it): Claude's
          // --session-id / --resume, Codex's rollout session id. Null when unknown (e.g. Antigravity: read from its
          // exit text instead).
          const fullUrl = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
          const id = fullUrl.searchParams.get('sessionId') || '';
          const meta: PtyUsageMeta | undefined = activePtySessions.get(id) || endedPtySessions.get(id);
          if (!meta) return sendJson(res, 404, { success: false, error: 'No PTY session with that id.' });
          const base = path.basename(meta.cmd).toLowerCase();
          let cliSessionId: string | null = null;
          try {
            if (base.includes('claude')) {
              cliSessionId = claudeSessionIdArg(meta.args) || null;
            } else if (base.includes('codex')) {
              const file = await findCodexRollout(meta);
              const uuidRe = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
              if (file) {
                const first = (await fs.readFile(file, 'utf-8').catch(() => '')).split('\n', 1)[0];
                let head: any = null;
                try { head = JSON.parse(first); } catch {}
                const fromMeta = head?.payload?.id ?? head?.id;
                cliSessionId = typeof fromMeta === 'string' && uuidRe.test(fromMeta) ? fromMeta : path.basename(file).match(uuidRe)?.[1] ?? null;
              }
            }
          } catch (err) {
            console.warn('[Ergo PTY] CLI session id lookup failed:', err);
          }
          return sendJson(res, 200, { success: true, cliSessionId, cli: base });
        }

        if (url === '/api/pty/transcript' && req.method === 'GET') {
          const fullUrl = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
          const id = fullUrl.searchParams.get('sessionId') || '';
          const live = activePtySessions.get(id);
          const ended = live ? undefined : endedPtySessions.get(id);
          const meta: PtyUsageMeta | undefined = live || ended;
          if (!meta) {
            return sendJson(res, 404, { success: false, exitCode: null, isActive: false, transcriptTail: '', error: 'No PTY session with that id.' });
          }
          const transcript = live ? live.transcript : ended?.transcript;
          if (live) {
            try {
              observeTranscript(live);
            } catch {}
          }
          const tailLines = transcript ? transcript.tail(300) : transcriptFromBuffer(meta.buffer).slice(-300);
          let transcriptTail = tailLines.join('\n');
          if (transcriptTail.length > 20_000) transcriptTail = transcriptTail.slice(-20_000);
          const final = await readAgentFinalMessage(meta, transcript);
          return sendJson(res, 200, {
            success: true,
            cli: path.basename(meta.cmd),
            exitCode: live ? live.exitCode : ended?.exitCode ?? null,
            isActive: Boolean(live?.isActive),
            startedAt: meta.startedAt,
            ...(final.text ? { finalMessage: final.text } : {}),
            finalMessageSource: final.source,
            transcriptTail,
          });
        }

        if (url === '/api/pty/spawn' && req.method === 'POST') {
          let body: any;
          try {
            body = await parseJsonBody(req);
          } catch {
            return sendJson(res, 400, { success: false, error: 'Invalid JSON body.' });
          }
          const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
          const cmd = typeof body?.cmd === 'string' ? body.cmd.trim() : '';
          if (!sessionId || sessionId.length > 200) return sendJson(res, 400, { success: false, error: 'sessionId is required.' });
          if (!cmd) return sendJson(res, 400, { success: false, error: 'cmd is required.' });
          if (body.args !== undefined && (!Array.isArray(body.args) || body.args.some((a: unknown) => typeof a !== 'string'))) {
            return sendJson(res, 400, { success: false, error: 'args must be an array of strings.' });
          }
          const role: BridgeAgentRole = AGENT_ROLES.has(body.role) ? body.role : 'manager';
          const runId = typeof body.runId === 'string' && SAFE_RUN_ID_RE.test(body.runId) ? body.runId : undefined;
          if (body.runId !== undefined && body.runId !== '' && !runId) return sendJson(res, 400, { success: false, error: 'runId may only contain letters, digits, ".", "_" and "-".' });
          const pieceId = typeof body.pieceId === 'string' && SAFE_PIECE_ID_RE.test(body.pieceId) ? body.pieceId : undefined;
          if (role === 'worker' && !pieceId) return sendJson(res, 400, { success: false, error: 'Workers need a pieceId matching [A-Za-z0-9_-]{1,12}.' });
          const taskId = typeof body.taskId === 'number' || (typeof body.taskId === 'string' && body.taskId) ? body.taskId : sessionId;
          const cwd = resolvePtyCwd(body.cwd);
          const projectId = typeof body.projectId === 'string' && body.projectId.trim() ? body.projectId.trim().slice(0, 200) : undefined;
          const taskTitle = typeof body.taskTitle === 'string' && body.taskTitle.trim() ? body.taskTitle.trim().slice(0, 300) : undefined;
          let runDir: string | undefined;
          if (runId) {
            try {
              runDir = ensureRunDir(cwd, runId);
            } catch (err: any) {
              return sendJson(res, 500, { success: false, error: `Could not create the run folder: ${err?.message || err}` });
            }
          }
          try {
            const pty = await loadNodePty();
            const session = spawnPtySession(pty, {
              sessionKey: sessionId,
              taskId,
              projectId,
              cmd,
              args: Array.isArray(body.args) ? body.args : [],
              cwd,
              env: body.env,
              cols: body.cols,
              rows: body.rows,
              spawnId: typeof body.spawnId === 'string' ? body.spawnId : undefined,
              role,
              label: typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 120) : undefined,
              pieceId,
              runId,
              runDir,
              permissionLevel: asPermission(body.permissionLevel),
              workspaceTools: body.workspaceTools === true,
              taskTitle,
            });
            broadcastAgentEvent(session, { type: 'spawned', label: session.label || role, ...(pieceId ? { pieceId } : {}) });
            return sendJson(res, 200, { success: true, sessionId, cwd, ...(runDir ? { runDir } : {}) });
          } catch (err: any) {
            console.error(`[Ergo PTY] Spawn error for [${sessionId}]:`, err);
            return sendJson(res, 500, { success: false, error: err?.message || String(err) });
          }
        }

        if ((url === '/api/pty/workspace-claim' || url === '/api/pty/workspace-result') && req.method === 'POST') {
          let body: any;
          try {
            body = await parseJsonBody(req);
          } catch {
            return sendJson(res, 400, { success: false, error: 'Invalid JSON body.' });
          }
          const callId = typeof body?.callId === 'string' ? body.callId : '';
          if (!callId) return sendJson(res, 400, { success: false, error: 'callId is required.' });
          const ok = url === '/api/pty/workspace-claim' ? claimWorkspaceCall(callId) : settleWorkspaceCall(callId, body);
          return sendJson(res, 200, { success: ok });
        }

        if (url === '/api/pty/input' && req.method === 'POST') {
          let body: any;
          try {
            body = await parseJsonBody(req);
          } catch {
            return sendJson(res, 400, { success: false, error: 'Invalid JSON body.' });
          }
          const session = activePtySessions.get(String(body?.sessionId || ''));
          if (!session || !session.isActive || typeof body?.data !== 'string') {
            return sendJson(res, 200, { success: false, error: session ? 'The session has ended.' : 'No PTY session with that id.' });
          }
          // Ergo's own hand-off messages end with Enter, which would answer an approval menu that opened before the
          // client heard about it (or one being auto-answered). Refuse them while anything prompt-like is on screen.
          if (body?.handoff === true && promptOnScreen(session)) {
            return sendJson(res, 200, { success: false, promptOpen: true });
          }
          try {
            session.ptyProcess.write(body.data);
          } catch (err: any) {
            return sendJson(res, 200, { success: false, error: err?.message || String(err) });
          }
          return sendJson(res, 200, { success: true });
        }

        if (url === '/api/pty/kill' && req.method === 'POST') {
          let body: any = {};
          try {
            body = await parseJsonBody(req);
          } catch {}
          let targets: PtySessionState[] = [];
          if (body?.sessionId) {
            const s = activePtySessions.get(String(body.sessionId));
            if (s) targets = [s];
          } else if (body?.taskId !== undefined && body?.taskId !== null && body?.taskId !== '') {
            const taskKey = String(body.taskId);
            // `projectKey` (optional) keeps the same task id in another project apart: agent ids start with `<projectKey>~`.
            const projectKey = typeof body.projectKey === 'string' && body.projectKey ? `${body.projectKey}~` : null;
            targets = Array.from(activePtySessions.values()).filter(
              (s) => (String(s.taskId) === taskKey || s.id === taskKey) && (!projectKey || s.id.startsWith(projectKey))
            );
          }
          for (const s of targets) killPtySession(s, 'requested by the app');
          return sendJson(res, 200, { success: true, killed: targets.length > 0, count: targets.length });
        }

        if (url === '/api/pty/policy' && req.method === 'POST') {
          let body: any;
          try {
            body = await parseJsonBody(req);
          } catch {
            return sendJson(res, 400, { success: false, error: 'Invalid JSON body.' });
          }
          const level = asPermission(body?.permissionLevel);
          if (!level) return sendJson(res, 400, { success: false, error: 'permissionLevel must be one of plan, ask, acceptEdits, bypass.' });
          let targets: PtySessionState[];
          if (body.sessionId) {
            const s = activePtySessions.get(String(body.sessionId));
            targets = s ? [s] : [];
          } else if (Array.isArray(body.sessionIds)) {
            targets = body.sessionIds
              .filter((id: unknown) => typeof id === 'string')
              .map((id: string) => activePtySessions.get(id))
              .filter((s: PtySessionState | undefined): s is PtySessionState => Boolean(s));
          } else if (body.taskId !== undefined && body.taskId !== null && body.taskId !== '') {
            const taskKey = String(body.taskId);
            targets = Array.from(activePtySessions.values()).filter((s) => String(s.taskId) === taskKey || s.id === taskKey);
          } else {
            targets = Array.from(activePtySessions.values());
          }
          // Only task agents (launched with a role) follow Ergo's permission level; login/onboarding terminals never do.
          // `projectKey` limits the change to one project's agents (their ids start with `<projectKey>~`).
          const projectKey = typeof body.projectKey === 'string' && body.projectKey ? `${body.projectKey}~` : null;
          targets = targets.filter((s) => s.isActive && s.role && (!projectKey || s.id.startsWith(projectKey)));
          const results = await Promise.all(targets.map((s) => applySessionPolicy(s, level)));
          return sendJson(res, 200, { success: true, results });
        }

        next();
      });

      // Defer WSS creation until the underlying http.Server is available
      server.httpServer?.once('listening', async () => {
        const { WebSocketServer } = await import('ws');
        // Vite installs no unhandledRejection handler, so a native module that fails to load here would take the whole
        // bridge down with it. Terminals report the failure instead.
        const pty = await loadNodePty().catch((err) => {
          console.error('[Ergo PTY] Could not load node-pty, so embedded terminals are unavailable:', err);
          return null;
        });

        const wss = new WebSocketServer({ noServer: true });

        server.httpServer!.on('upgrade', (req: IncomingMessage, socket: any, head: any) => {
          if (req.url === '/api/pty') {
            // WebSockets are exempt from CORS, so the guard is the only thing stopping
            // an arbitrary web page from spawning a shell here.
            const access = checkBridgeAccess(req);
            if (!access.ok) {
              console.warn(`[Ergo PTY] Refused WebSocket upgrade: ${access.reason}`);
              socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
              socket.destroy();
              return;
            }
            wss.handleUpgrade(req, socket as any, head, (ws) => {
              wss.emit('connection', ws, req);
            });
          }
        });

        wss.on('connection', (ws: any) => {
          let currentSessionKey: string | null = null;
          /** Attached with observe: true (Notes view) — never resizes the PTY. */
          let observeOnly = false;
          let attachTimer: ReturnType<typeof setTimeout> | null = null;

          const send = (obj: Record<string, unknown>) => safeWsSend(ws, obj);

          const detach = () => {
            if (attachTimer) clearTimeout(attachTimer);
            attachTimer = null;
            if (!currentSessionKey) return;
            const session = activePtySessions.get(currentSessionKey);
            if (session) {
              session.subscribers.delete(ws);
              // The last view that sized the PTY left: give the agent its launch size back, so later prompts are not
              // drawn (and parsed) on a small embedded terminal's screen.
              if (session.resizers.delete(ws) && session.resizers.size === 0 && session.isActive) {
                resizeSession(session, session.launchCols, session.launchRows);
              }
            }
            const watchers = ptyKeyWatchers.get(currentSessionKey);
            if (watchers) {
              watchers.delete(ws);
              if (watchers.size === 0) ptyKeyWatchers.delete(currentSessionKey);
            }
          };

          const watchKey = (key: string) => {
            let watchers = ptyKeyWatchers.get(key);
            if (!watchers) {
              watchers = new Set();
              ptyKeyWatchers.set(key, watchers);
            }
            watchers.add(ws);
          };

          /** Subscribe to a session: ready, replay of everything so far, the open prompt, and the exit if it ended. */
          const subscribe = (session: PtySessionState, opts: { resize: boolean; cols?: unknown; rows?: unknown }) => {
            session.subscribers.add(ws);
            if (opts.resize && session.isActive) {
              session.resizers.add(ws);
              resizeSession(session, opts.cols, opts.rows);
            }
            send({ type: 'ready', reattached: true, taskId: session.taskId, sessionId: session.id, cols: session.screen.cols, rows: session.screen.rows });
            if (session.buffer.length > 0) send({ type: 'replay', data: session.buffer.join('') });
            if (session.prompt && session.promptVisible) send({ type: 'prompt', prompt: session.prompt });
            if (!session.isActive) send({ type: 'exit', code: session.exitCode ?? 0 });
          };

          /** Replays a killed/replaced session; returns false when nothing is known about the key. */
          const replayEnded = (key: string): boolean => {
            const ended = endedPtySessions.get(key);
            if (!ended) return false;
            send({ type: 'ready', reattached: true, ended: true, taskId: ended.taskId, sessionId: key });
            if (ended.buffer.length > 0) send({ type: 'replay', data: ended.buffer.join('') });
            send({ type: 'exit', code: ended.exitCode ?? -1 });
            return true;
          };

          ws.on('message', (raw: Buffer | string) => {
            let msg: any;
            try {
              msg = JSON.parse(raw.toString());
            } catch {
              return;
            }

            if (msg.type === 'attach') {
              const key = String(msg.sessionId || msg.taskId || '');
              if (!key) {
                send({ type: 'error', message: 'attach needs a sessionId.' });
                return;
              }
              detach();
              currentSessionKey = key;
              observeOnly = msg.observe === true;
              const live = activePtySessions.get(key);
              if (live) {
                subscribe(live, { resize: !observeOnly, cols: msg.cols, rows: msg.rows });
                return;
              }
              // No live process: follow the key so a launch (or relaunch) under it reaches this view.
              watchKey(key);
              if (replayEnded(key)) return;
              // Not in memory (it ended a while ago, or before the bridge restarted): its saved terminal, if any.
              void readTerminalHistory(key).then((saved) => {
                if (ws.readyState !== 1 /* OPEN */ || currentSessionKey !== key || activePtySessions.has(key)) return;
                if (saved) {
                  send({ type: 'ready', reattached: true, ended: true, taskId: saved.meta.taskId, sessionId: key });
                  if (saved.data) send({ type: 'replay', data: saved.data });
                  send({ type: 'exit', code: saved.meta.exitCode ?? -1 });
                  return;
                }
                attachTimer = setTimeout(() => {
                  attachTimer = null;
                  if (ws.readyState !== 1 /* OPEN */ || currentSessionKey !== key) return;
                  const late = activePtySessions.get(key);
                  if (late) {
                    if (!late.subscribers.has(ws)) subscribe(late, { resize: !observeOnly, cols: msg.cols, rows: msg.rows });
                    return;
                  }
                  if (!replayEnded(key)) send({ type: 'exit', code: -1 });
                }, 5_000);
              });
              return;
            }

            if (msg.type === 'spawn') {
              // Legacy launch path (login / onboarding terminals). Task agents are launched over REST.
              const sessionKey = String(msg.sessionId || msg.taskId || 'default');
              detach();
              currentSessionKey = sessionKey;
              observeOnly = false;

              const existingSession = activePtySessions.get(sessionKey);
              const spawnId = typeof msg.spawnId === 'string' ? msg.spawnId : undefined;
              if (existingSession && spawnId && existingSession.spawnId === spawnId) {
                // Same launch re-mounted (view switch, card re-expand): reattach — never restart or re-run the agent.
                subscribe(existingSession, { resize: true, cols: msg.cols, rows: msg.rows });
                return;
              }
              if (msg.attachOnly) {
                // A view re-mounting for a launch that already happened: show what exists, never start the agent again.
                if (existingSession) {
                  subscribe(existingSession, { resize: true, cols: msg.cols, rows: msg.rows });
                  return;
                }
                // A sibling view's launch message may still be in flight on its own socket; give it a moment.
                watchKey(sessionKey);
                attachTimer = setTimeout(() => {
                  attachTimer = null;
                  if (ws.readyState !== 1 /* OPEN */ || currentSessionKey !== sessionKey) return;
                  const late = activePtySessions.get(sessionKey);
                  if (late) {
                    if (!late.subscribers.has(ws)) subscribe(late, { resize: true, cols: msg.cols, rows: msg.rows });
                    return;
                  }
                  const ended = endedPtySessions.get(sessionKey);
                  if (ended && ended.buffer.length > 0) send({ type: 'replay', data: ended.buffer.join('') });
                  send({ type: 'exit', code: -1 });
                }, 750);
                return;
              }
              if (existingSession && !msg.forceRestart && existingSession.isActive && existingSession.ptyProcess) {
                // Re-attach to the live, running background process!
                console.log(`[Ergo PTY] Reattached to running persistent session [${sessionKey}] (pid ${existingSession.ptyProcess.pid})`);
                existingSession.subscribers.add(ws);
                existingSession.resizers.add(ws);
                resizeSession(existingSession, msg.cols, msg.rows);
                send({ type: 'ready', reattached: true, taskId: existingSession.taskId, sessionId: sessionKey });
                if (existingSession.buffer.length > 0) send({ type: 'replay', data: existingSession.buffer.join('') });
                if (existingSession.prompt && existingSession.promptVisible) send({ type: 'prompt', prompt: existingSession.prompt });
                return;
              }
              if (existingSession && msg.forceRestart) {
                console.log(`[Ergo PTY] Force-restarting persistent session [${sessionKey}] (pid ${existingSession.ptyProcess?.pid})`);
              }

              try {
                if (!pty) throw new Error('Embedded terminals are unavailable: node-pty failed to load (see the terminal running npm run dev).');
                const session = spawnPtySession(pty, {
                  sessionKey,
                  taskId: msg.taskId || sessionKey,
                  cmd: typeof msg.cmd === 'string' && msg.cmd ? msg.cmd : 'bash',
                  args: Array.isArray(msg.args) ? msg.args.filter((a: unknown) => typeof a === 'string') : [],
                  cwd: resolvePtyCwd(msg.cwd),
                  env: msg.env,
                  cols: msg.cols,
                  rows: msg.rows,
                  spawnId,
                  role: AGENT_ROLES.has(msg.role) ? msg.role : undefined,
                  label: typeof msg.label === 'string' ? msg.label : undefined,
                  permissionLevel: asPermission(msg.permissionLevel),
                  subscriber: ws,
                });
                send({ type: 'ready', taskId: session.taskId, sessionId: sessionKey });
              } catch (err: any) {
                console.error(`[Ergo PTY] Spawn error for [${sessionKey}]:`, err);
                send({ type: 'error', message: err?.message || String(err) });
              }

            } else if (msg.type === 'input') {
              const sessionKey = currentSessionKey || String(msg.sessionId || msg.taskId || '');
              const session = activePtySessions.get(sessionKey);
              if (session?.isActive && session.ptyProcess && typeof msg.data === 'string') {
                try {
                  session.ptyProcess.write(msg.data);
                } catch {}
              }

            } else if (msg.type === 'resize') {
              if (observeOnly) return;
              const sessionKey = currentSessionKey || String(msg.sessionId || msg.taskId || '');
              const session = activePtySessions.get(sessionKey);
              if (session?.subscribers.has(ws)) {
                session.resizers.add(ws);
                resizeSession(session, msg.cols, msg.rows);
              }

            } else if (msg.type === 'kill') {
              const sessionKey = currentSessionKey || String(msg.sessionId || msg.taskId || '');
              const session = activePtySessions.get(sessionKey);
              if (session) killPtySession(session, 'killed from the terminal view');
            }
          });

          ws.on('close', () => {
            if (currentSessionKey) {
              const session = activePtySessions.get(currentSessionKey);
              if (session?.subscribers.has(ws)) {
                console.log(`[Ergo PTY] WebSocket closed for session [${currentSessionKey}] — PTY process pid ${session.ptyProcess?.pid} keeps running in background`);
              }
            }
            detach();
          });

          ws.on('error', (err: Error) => {
            console.error('[Ergo PTY] WebSocket error:', err);
            detach();
          });
        });

        console.log('[Ergo PTY] WebSocket PTY server ready at ws://localhost/api/pty');
      });
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Ergo memory (vector store on disk) — src/lib/memory/memoryStore.ts
// REST (App):  POST /api/memory/search | add | upsert-doc | update | remove | import | embed
//                   /api/memory/workspace-sync (live index of the human workspace, namespace `workspace`)
//                   /api/memory/related (stage-1 related tasks: centered multi-vector search over that index, plus the
//                   project's learned rules for the task)
//                   /api/memory/insights/list | apply (learned rules, namespace `insights`)
//              GET  /api/memory/chunks | count | has | status
// MCP (agents): POST /api/mcp/ergo-memory — stateless streamable-HTTP JSON-RPC with memory_search / memory_get /
//              memory_save. CLI agents call it from localhost without an Origin header (allowed by the bridge guard).
// Ingestion:   run signal files, <runDir>/notes/** and Claude Code todo lists → the AI-only `agent-notes` namespace.
// Registration: task-agent launches get the MCP server (claude/codex flags; gemini/agy config files).
// ─────────────────────────────────────────────────────────────────────────────

const MEMORY_MCP_PATH = '/api/mcp/ergo-memory';
const MEMORY_MCP_NAME = 'ergo-memory';
const MEMORY_TOOL_NAMES = ['code_search', 'memory_search', 'memory_get', 'memory_save'] as const;
const MEMORY_DOC_MAX_CHARS = 200_000;
const MEMORY_GET_MAX_CHARS = 6_000;
const MEMORY_SNIPPET_CHARS = 280;
const MEMORY_NOTE_MAX_FILES = 200;
const MEMORY_NOTE_MAX_DEPTH = 4;
const MEMORY_SETTLE_MS = 400;
/** Longest a signal event waits for its file to be embedded (first use may still be loading the model). */
const MEMORY_INGEST_WAIT_MS = 20_000;

let memoryStoreInstance: MemoryStore | null = null;
let atomicWriteSeq = 0;

function atomicTmpPath(file: string): string {
  return `${file}.${process.pid}.${Date.now().toString(36)}.${++atomicWriteSeq}.tmp`;
}

const memoryIo: MemoryStoreIo = {
  async readText(file) {
    try {
      return await fs.readFile(file, 'utf-8');
    } catch (err: any) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
  },
  async readBytes(file) {
    try {
      return new Uint8Array(await fs.readFile(file));
    } catch (err: any) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
  },
  async writeAtomic(file, data) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = atomicTmpPath(file);
    try {
      await fs.writeFile(tmp, data);
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  },
  writeAtomicSync(file, data) {
    fsSync.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = atomicTmpPath(file);
    try {
      fsSync.writeFileSync(tmp, data);
      fsSync.renameSync(tmp, file);
    } catch (err) {
      try {
        fsSync.rmSync(tmp, { force: true });
      } catch {}
      throw err;
    }
  },
};

/**
 * The store under `<storage root>/memory`, or `<storage root>/.ergo/memory` when the user pointed the storage root
 * at a visible folder (the default root is already `~/.ergo`). Re-created when the storage root changes.
 */
function getMemoryStore(): MemoryStore {
  const root = getActiveStorageDir();
  const base = path.basename(root) === '.ergo' ? root : path.join(root, '.ergo');
  const dir = path.join(base, 'memory');
  if (!memoryStoreInstance || memoryStoreInstance.dir !== dir) {
    memoryStoreInstance?.flushSync();
    memoryStoreInstance = createMemoryStore({
      dir,
      chunksFile: path.join(dir, 'chunks.json'),
      vectorsFile: path.join(dir, 'vectors.f32'),
      modelsDir: path.join(base, 'models'),
      io: memoryIo,
    });
  }
  return memoryStoreInstance;
}

/**
 * Registers a synchronous cleanup that runs on exit / SIGINT / SIGHUP. (Vite handles SIGTERM itself: it closes the
 * server, which fires the plugins' `close` hooks, then exits.) The signal handlers are installed once per process and
 * survive config reloads; `name` keeps a single entry per subsystem, so a reloaded config replaces its own hook.
 */
function registerBridgeExitHook(name: string, hook: () => void) {
  const g = globalThis as any;
  const hooksKey = Symbol.for('ergo.bridge.exitHooks');
  const hooks: Map<string, () => void> = g[hooksKey] || (g[hooksKey] = new Map());
  hooks.set(name, hook);
  const installed = Symbol.for('ergo.bridge.exitHooksInstalled');
  if (g[installed]) return;
  g[installed] = true;
  const runAll = () => {
    for (const fn of hooks.values()) {
      try {
        fn();
      } catch {}
    }
  };
  process.once('exit', runAll);
  for (const sig of ['SIGINT', 'SIGHUP'] as const) {
    process.once(sig, () => {
      runAll();
      // Nobody else handles it: keep the default behaviour (terminate).
      if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
    });
  }
}

/** Flushes pending memory writes on exit / SIGINT / SIGHUP. */
function installMemoryExitFlush() {
  registerBridgeExitHook('memory', () => memoryStoreInstance?.flushSync());
  registerBridgeExitHook('terminal-history', () => {
    for (const session of activePtySessions.values()) flushTerminalHistory(session);
  });
  registerBridgeExitHook('code-index', () => codeIndexManager?.saveAll());
}

// ── Code index (src/lib/codeIndex/codeIndex.ts) ──
// Every Allowed Folder (except Ergo's own storage folder) is indexed in the background as soon as it is added, then
// kept current by a file watcher. Agents search it with the code_search tool (ergo-memory MCP server for CLI agents,
// /api/mcp/tools/call for API agents). REST: GET /api/code-index/status · POST /api/code-index/refresh {path}.

let codeIndexManager: CodeIndexManager | null = null;
let codeIndexDir = '';

/** The manager under `<storage root>/.ergo/code-index` (vectors only; it shares the memory model's queue). */
function getCodeIndexManager(): CodeIndexManager {
  const root = getActiveStorageDir();
  const base = path.basename(root) === '.ergo' ? root : path.join(root, '.ergo');
  const dir = path.join(base, 'code-index');
  if (!codeIndexManager || codeIndexDir !== dir) {
    codeIndexManager?.disposeAll();
    codeIndexDir = dir;
    const modelsDir = path.join(base, 'models');
    codeIndexManager = new CodeIndexManager(
      dir,
      (texts, priority) => embedWithMemoryModel(texts, priority, modelsDir),
      (msg, err) => (err ? console.warn(`[Ergo Code Index] ${msg}:`, err) : console.log(`[Ergo Code Index] ${msg}`))
    );
  }
  return codeIndexManager;
}

/** Indexes exactly the current Allowed Folders, minus Ergo's storage folder and whole-disk / home roots. */
async function syncCodeIndexRoots(): Promise<void> {
  try {
    const storage = path.resolve(getActiveStorageDir());
    const all = await loadAllowedRoots(storage);
    // Projects' own folders are indexed too.
    for (const project of await fs.readdir(path.join(storage, 'projects')).catch(() => [] as string[])) {
      for (const f of await loadProjectFolders(storage, project)) {
        const resolved = resolveRootPath(f.path);
        if (!all.includes(resolved)) all.push(resolved);
      }
    }
    const roots = all.filter((r) => r !== storage && r !== os.homedir() && r !== path.parse(r).root);
    getCodeIndexManager().sync(roots);
  } catch (err) {
    console.warn('[Ergo Code Index] Could not sync the indexed folders:', err);
  }
}

/**
 * code_search for agents. `path`: folder or subfolder to search (absolute, or relative to `cwd`); default the agent's
 * working directory. Only indexed Allowed Folders can be searched.
 */
async function codeSearch(query: string, opts: { path?: string; cwd?: string; k?: number; files?: unknown }): Promise<{ text: string; isError?: boolean }> {
  const mgr = getCodeIndexManager();
  let target = opts.path?.trim() || '';
  if (target.startsWith('~')) target = path.join(os.homedir(), target.slice(1));
  if (target && !path.isAbsolute(target)) target = opts.cwd ? path.resolve(opts.cwd, target) : '';
  if (!target) target = opts.cwd || '';
  if (!target) {
    const roots = mgr.roots();
    if (roots.length !== 1) return { text: `Pass "path": the project folder to search. Indexed folders: ${roots.join(', ') || 'none'}.`, isError: true };
    target = roots[0];
  }
  const idx = mgr.forPath(target);
  if (!idx) {
    return {
      text: `No code index covers ${target} (indexed: ${mgr.roots().join(', ') || 'none'}; folders are indexed when added under Connections → Allowed Folders). Use grep / find for this folder.`,
      isError: true,
    };
  }
  const under = path.relative(idx.root, target);
  // `files`: repository-relative (or absolute) paths to search within, e.g. the file scout's list.
  const files = Array.isArray(opts.files)
    ? opts.files.filter((f): f is string => typeof f === 'string' && f.trim() !== '').map((f) => (path.isAbsolute(f) ? path.relative(idx.root, f) : f.trim())).filter((f) => !f.startsWith('..'))
    : [];
  return { text: await idx.search(query, { k: opts.k, ...(under && !under.startsWith('..') ? { under } : {}), ...(files.length ? { files } : {}) }) };
}

const isMemoryNamespace = (v: unknown): v is MemoryNamespace => typeof v === 'string' && (MEMORY_NAMESPACES as readonly string[]).includes(v);
const isAgentNoteKind = (v: unknown): v is AgentNoteKind => typeof v === 'string' && (AGENT_NOTE_KINDS as readonly string[]).includes(v);
const optString = (v: unknown, max = 200): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const optTaskId = (v: unknown): string | number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : undefined;

function capMemoryText(text: string, max = MEMORY_DOC_MAX_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text;
}

function sanitizeSearchRequest(body: any): MemorySearchRequest {
  const req: MemorySearchRequest = { query: typeof body?.query === 'string' ? body.query.slice(0, 4_000) : '' };
  if (isMemoryNamespace(body?.namespace)) req.namespace = body.namespace;
  if (Array.isArray(body?.namespaces)) req.namespaces = body.namespaces.filter(isMemoryNamespace);
  if (typeof body?.topK === 'number') req.topK = body.topK;
  if (typeof body?.minSimilarity === 'number') req.minSimilarity = body.minSimilarity;
  const projectId = optString(body?.projectId);
  if (projectId) req.projectId = projectId;
  const excludeTaskId = optTaskId(body?.excludeTaskId);
  if (excludeTaskId !== undefined) req.excludeTaskId = excludeTaskId;
  const taskId = optTaskId(body?.taskId);
  if (taskId !== undefined) req.taskId = taskId;
  const runId = optString(body?.runId);
  if (runId) req.runId = runId;
  if (Array.isArray(body?.kinds)) req.kinds = body.kinds.filter(isAgentNoteKind);
  if (body?.includeHidden === true) req.includeHidden = true;
  return req;
}

function sanitizeChunkInput(c: any): { id: string; namespace: MemoryNamespace; text: string; metadata: ChunkMetadata } | null {
  if (!c || typeof c.id !== 'string' || !c.id || typeof c.text !== 'string' || !isMemoryNamespace(c.namespace)) return null;
  const metadata = c.metadata && typeof c.metadata === 'object' && !Array.isArray(c.metadata) ? (c.metadata as ChunkMetadata) : {};
  return { id: c.id.slice(0, 500), namespace: c.namespace, text: capMemoryText(c.text), metadata };
}

/** Workspace items as the app sent them (shape only; the store normalizes and caps the text). */
function sanitizeWorkspaceItems(list: unknown): WorkspaceIndexItem[] {
  if (!Array.isArray(list)) return [];
  const out: WorkspaceIndexItem[] = [];
  for (const it of list.slice(0, WORKSPACE_MAX_ITEMS)) {
    if (!it || typeof it !== 'object') continue;
    const id = optTaskId((it as any).id);
    const title = typeof (it as any).title === 'string' ? (it as any).title : '';
    if (id === undefined) continue;
    out.push({
      id: String(id),
      kind: (it as any).kind === 'note' ? 'note' : 'task',
      title,
      category: optString((it as any).category),
      subtasks: Array.isArray((it as any).subtasks) ? (it as any).subtasks.filter((s: unknown) => typeof s === 'string') : undefined,
      text: typeof (it as any).text === 'string' ? (it as any).text : undefined,
      status: optString((it as any).status, 40),
      isDone: typeof (it as any).isDone === 'boolean' ? (it as any).isDone : undefined,
    });
  }
  return out;
}

function sanitizeRelatedRequest(body: any): RelatedTasksRequest | null {
  const projectId = optString(body?.projectId);
  if (!projectId) return null;
  const taskId = optTaskId(body?.taskId);
  return {
    projectId,
    taskId: taskId === undefined ? '' : String(taskId),
    title: typeof body?.title === 'string' ? body.title.slice(0, 2_000) : '',
    subtasks: Array.isArray(body?.subtasks) ? body.subtasks.filter((s: unknown) => typeof s === 'string').slice(0, 100) : undefined,
    text: typeof body?.text === 'string' ? body.text.slice(0, 4_000) : undefined,
    topK: typeof body?.topK === 'number' ? body.topK : undefined,
  };
}

function sanitizeInsightOp(o: any): InsightOp | null {
  const id = optString(o?.id, 300);
  const text = typeof o?.text === 'string' ? o.text.slice(0, 2_000) : undefined;
  const scope = o?.scope === 'always' || o?.scope === 'topical' ? o.scope : undefined;
  switch (o?.op) {
    case 'add':
      return text ? { op: 'add', text, ...(scope ? { scope } : {}) } : null;
    case 'update':
      return id && (text !== undefined || scope) ? { op: 'update', id, ...(text !== undefined ? { text } : {}), ...(scope ? { scope } : {}) } : null;
    case 'delete':
    case 'confirm':
    case 'unconfirm':
      return id ? { op: o.op, id } : null;
    case 'put': {
      const ins = o?.insight;
      const insId = optString(ins?.id, 300);
      if (!insId || typeof ins?.text !== 'string') return null;
      return {
        op: 'put',
        insight: {
          id: insId,
          text: ins.text.slice(0, 2_000),
          scope: ins.scope === 'always' ? 'always' : 'topical',
          confirms: typeof ins.confirms === 'number' ? ins.confirms : 1,
          origin: ins.origin === 'user' ? 'user' : 'learned',
          ...(typeof ins.createdAt === 'number' ? { createdAt: ins.createdAt } : {}),
          ...(optString(ins.taskId, 300) ? { taskId: optString(ins.taskId, 300) } : {}),
          ...(optString(ins.taskTitle, 400) ? { taskTitle: optString(ins.taskTitle, 400) } : {}),
        },
      };
    }
    default:
      return null;
  }
}

function sanitizeInsightSource(s: any): InsightSource {
  return {
    origin: s?.origin === 'user' ? 'user' : 'learned',
    ...(optString(s?.taskId, 300) ? { taskId: optString(s.taskId, 300) } : {}),
    ...(optString(s?.taskTitle, 400) ? { taskTitle: optString(s.taskTitle, 400) } : {}),
    ...(optString(s?.runId, 200) ? { runId: optString(s.runId, 200) } : {}),
  };
}

// ── CLI registration of the memory MCP server ──

/** `http://127.0.0.1:<port>` (or `http://[::1]:<port>`) — the bridge as local processes reach it; set on listen. */
let bridgeLocalOrigin: string | null = null;

function memoryMcpUrl(params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
  const q = qs.toString();
  return `${bridgeLocalOrigin}${MEMORY_MCP_PATH}${q ? `?${q}` : ''}`;
}

function tomlString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function detectJsonIndent(text: string): string | number {
  const m = text.match(/\n([ \t]+)"/);
  if (!m) return 2;
  return m[1][0] === '\t' ? '\t' : m[1].length;
}

/**
 * Merges `mcpServers[name] = { ...existing, ...entry }` into a JSON config file, preserving everything else and its
 * indentation. Writes through symlinks (atomically, keeping the file mode), only when one of `compareKeys` differs.
 * Throws on unreadable / invalid JSON (callers fail soft; the file is never clobbered).
 */
function mergeMcpServerEntry(
  file: string,
  name: string,
  entry: Record<string, unknown>,
  compareKeys: string[],
  opts: { backup: boolean; defaultIndent: string | number }
): 'unchanged' | 'written' {
  let target = file;
  try {
    target = fsSync.realpathSync(file);
  } catch {}
  let text: string | null = null;
  let mode: number | undefined;
  try {
    text = fsSync.readFileSync(target, 'utf-8');
    mode = fsSync.statSync(target).mode & 0o777;
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
  }
  let data: any = {};
  if (text !== null && text.trim()) {
    data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${file} is not a JSON object`);
  }
  if (!data.mcpServers || typeof data.mcpServers !== 'object' || Array.isArray(data.mcpServers)) data.mcpServers = {};
  const existing = data.mcpServers[name];
  const existingObj = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : null;
  if (existingObj && compareKeys.every((k) => JSON.stringify(existingObj[k]) === JSON.stringify(entry[k]))) return 'unchanged';
  data.mcpServers[name] = { ...(existingObj || {}), ...entry };
  const indent = text !== null && text.trim() ? detectJsonIndent(text) : opts.defaultIndent;
  const out = JSON.stringify(data, null, indent) + (text === null || !text.trim() || text.endsWith('\n') ? '\n' : '');
  // Ergo's own backup of the file as it was before Ergo first touched it: never overwrite the user's `.backup`, and
  // keep the pre-Ergo original rather than replacing it on every re-registration.
  if (opts.backup && text !== null && !fsSync.existsSync(`${file}.ergo-backup`)) {
    fsSync.writeFileSync(`${file}.ergo-backup`, text, 'utf-8');
  }
  fsSync.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = atomicTmpPath(target);
  try {
    fsSync.writeFileSync(tmp, out, { encoding: 'utf-8', ...(mode !== undefined ? { mode } : {}) });
    if (mode !== undefined) fsSync.chmodSync(tmp, mode);
    fsSync.renameSync(tmp, target);
  } catch (err) {
    try {
      fsSync.rmSync(tmp, { force: true });
    } catch {}
    throw err;
  }
  return 'written';
}

/** Per cwd: is `.gemini/settings.json` tracked by git (then Ergo leaves it alone), and was it excluded already. */
const geminiGitState = new Map<string, { tracked: boolean; excluded: boolean }>();

function geminiSettingsGitState(cwd: string): { tracked: boolean; excluded: boolean; gitDir?: string; prefix?: string } {
  const cached = geminiGitState.get(cwd);
  if (cached) return cached;
  let state: { tracked: boolean; excluded: boolean; gitDir?: string; prefix?: string } = { tracked: false, excluded: true };
  try {
    const out = execFileSync('git', ['rev-parse', '--git-common-dir', '--show-prefix'], {
      cwd,
      encoding: 'utf-8',
      timeout: 3_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const [gitDirRaw, prefixRaw = ''] = out.split('\n');
    let tracked = false;
    try {
      execFileSync('git', ['ls-files', '--error-unmatch', '--', '.gemini/settings.json'], { cwd, timeout: 3_000, stdio: 'ignore' });
      tracked = true;
    } catch {}
    state = { tracked, excluded: false, gitDir: path.resolve(cwd, gitDirRaw.trim()), prefix: prefixRaw.trim() };
  } catch {
    // not a git repo (or no git): nothing to exclude
  }
  if (state.tracked || state.excluded) geminiGitState.set(cwd, { tracked: state.tracked, excluded: state.excluded });
  return state;
}

function registerGeminiProjectMcp(cwd: string, url: string) {
  const git = geminiSettingsGitState(cwd);
  if (git.tracked) {
    console.warn(`[Ergo Memory] ${cwd}/.gemini/settings.json is tracked by git; not adding the memory server to it.`);
    return;
  }
  const settingsFile = path.join(cwd, '.gemini', 'settings.json');
  const result = mergeMcpServerEntry(settingsFile, MEMORY_MCP_NAME, { httpUrl: url, trust: true }, ['httpUrl', 'trust'], {
    backup: false,
    defaultIndent: 2,
  });
  if (result === 'written') console.log(`[Ergo Memory] Registered the memory MCP server in ${settingsFile}`);
  if (!git.excluded && git.gitDir) {
    const pattern = `/${git.prefix || ''}.gemini/settings.json`;
    const excludeFile = path.join(git.gitDir, 'info', 'exclude');
    let current = '';
    try {
      current = fsSync.readFileSync(excludeFile, 'utf-8');
    } catch {}
    if (!current.split('\n').some((l) => l.trim() === pattern)) {
      fsSync.mkdirSync(path.dirname(excludeFile), { recursive: true });
      fsSync.appendFileSync(excludeFile, `${current && !current.endsWith('\n') ? '\n' : ''}${pattern}\n`, 'utf-8');
      console.log(`[Ergo Memory] Added ${pattern} to ${excludeFile}`);
    }
    geminiGitState.set(cwd, { tracked: false, excluded: true });
  }
}

function registerAgyMcp(url: string) {
  const file = path.join(os.homedir(), '.gemini', 'antigravity', 'mcp_config.json');
  const result = mergeMcpServerEntry(file, MEMORY_MCP_NAME, { serverUrl: url }, ['serverUrl'], { backup: true, defaultIndent: '\t' });
  if (result === 'written') console.log(`[Ergo Memory] Registered the memory MCP server in ${file}`);
}

/**
 * Gives a task-agent launch Ergo's memory MCP server. claude / codex: flags inserted before the positional prompt
 * (the last arg); gemini: `<cwd>/.gemini/settings.json`; agy: `~/.gemini/antigravity/mcp_config.json`. Fails soft.
 */
function registerMemoryMcp(o: { cmd: string; args: string[]; cwd: string; projectId?: string; taskId: string | number; runId?: string; sessionId: string; workspaceTools?: boolean }) {
  if (!bridgeLocalOrigin) return;
  try {
    const base = path.basename(o.cmd || '').toLowerCase().replace(/\.(cmd|exe)$/, '');
    const at = Math.max(0, o.args.length - 1);
    const runUrl = () => memoryMcpUrl({ project: o.projectId, task: String(o.taskId), run: o.runId, session: o.sessionId });
    if (base.includes('claude')) {
      if (o.args.some((a) => a === '--mcp-config' || a.startsWith('--mcp-config=') || a === '--strict-mcp-config')) return;
      const config = JSON.stringify({ mcpServers: { [MEMORY_MCP_NAME]: { type: 'http', url: runUrl() } } });
      // `--opt=value` form: both options are variadic, and the space form would swallow the prompt as a value.
      o.args.splice(
        at,
        0,
        `--mcp-config=${config}`,
        `--allowedTools=${[...MEMORY_TOOL_NAMES, ...(o.workspaceTools ? WORKSPACE_AUTO_APPROVED_TOOLS : [])].map((t) => `mcp__${MEMORY_MCP_NAME}__${t}`).join(',')}`
      );
    } else if (base === 'codex') {
      if (o.args.some((a) => a.includes('mcp_servers.ergo_memory'))) return;
      o.args.splice(
        at,
        0,
        '-c',
        `mcp_servers.ergo_memory.url=${tomlString(runUrl())}`,
        '-c',
        'mcp_servers.ergo_memory.default_tools_approval_mode="approve"'
      );
    } else if (base === 'gemini' || base.startsWith('gemini-')) {
      registerGeminiProjectMcp(o.cwd, memoryMcpUrl({ project: o.projectId }));
    } else if (base === 'agy' || base === 'antigravity') {
      registerAgyMcp(memoryMcpUrl({}));
    }
  } catch (err) {
    console.warn(`[Ergo Memory] Could not register the memory MCP server for ${o.cmd}:`, err);
  }
}

// ── Automatic ingestion into `agent-notes` ──

const SIGNAL_MEMORY_KIND: Record<AgentSignalKind, AgentNoteKind> = {
  delegate: 'plan',
  complete: 'completion',
  'worker-done': 'worker',
  'qa-verdict': 'verifier',
  question: 'note',
};

function sessionMemoryMeta(session: PtySessionState): ChunkMetadata {
  return {
    ...(session.projectId ? { projectId: session.projectId } : {}),
    taskId: session.taskId,
    ...(session.runId ? { runId: session.runId } : {}),
    sessionId: session.id,
  };
}

/** delegate.json → one line per worker: id, title, files. */
function renderDelegatePlan(json: string): string {
  try {
    const data = JSON.parse(json);
    const list: any[] = Array.isArray(data) ? data : Array.isArray(data?.workers) ? data.workers : Array.isArray(data?.pieces) ? data.pieces : [];
    const lines = list
      .filter((w) => w && typeof w === 'object')
      .map((w, i) => {
        const id = typeof w.id === 'string' || typeof w.id === 'number' ? String(w.id) : String(i + 1);
        const title = String(w.title || w.name || w.instructions || w.task || '').replace(/\s+/g, ' ').trim().slice(0, 160);
        const files = Array.isArray(w.files) ? w.files.filter((f: unknown) => typeof f === 'string') : typeof w.files === 'string' ? [w.files] : [];
        return `- Worker ${id}: ${title}${files.length ? ` — files: ${files.join(', ')}` : ''}`;
      });
    if (lines.length > 0) return `Delegation plan (${lines.length} worker${lines.length === 1 ? '' : 's'}):\n${lines.join('\n')}`;
  } catch {}
  return json;
}

/**
 * Upserts a run signal file into memory. Awaited (bounded) before the signal event goes out, so a hand-off sent right
 * after the event never reads the previous round's version from memory.
 */
async function ingestRunSignal(session: PtySessionState, name: string, signal: AgentSignalKind, text: string): Promise<void> {
  // A question is for the user, not knowledge for later agents.
  if (!session.runId || signal === 'question') return;
  const title =
    signal === 'delegate' ? 'Delegation plan'
    : signal === 'complete' ? 'Completion record'
    : signal === 'worker-done' ? `Worker ${session.pieceId || ''} report`.replace(/\s+report$/, ' report')
    : 'Verifier report';
  const body = signal === 'delegate' ? renderDelegatePlan(text) : text;
  const work = getMemoryStore()
    .upsertDocument({
      docId: `run:${session.runId}:${name}`,
      namespace: 'agent-notes',
      text: capMemoryText(body),
      metadata: { ...sessionMemoryMeta(session), kind: SIGNAL_MEMORY_KIND[signal], title, source: 'run-signal' },
    })
    .then(
      () => {},
      (err) => console.warn(`[Ergo Memory] Ingesting ${name} of run ${session.runId} failed:`, err)
    );
  let timer: ReturnType<typeof setTimeout> | null = null;
  await Promise.race([work, new Promise<void>((resolve) => (timer = setTimeout(resolve, MEMORY_INGEST_WAIT_MS)))]);
  if (timer) clearTimeout(timer);
}

/** Last ingested state per note file / todo list (shared by every session of a run, so each file is ingested once). */
const memoryArtifactState = new Map<string, string>();

function rememberArtifactState(key: string, state: string) {
  memoryArtifactState.delete(key);
  memoryArtifactState.set(key, state);
  if (memoryArtifactState.size > 5_000) {
    const oldest = memoryArtifactState.keys().next().value;
    if (oldest !== undefined) memoryArtifactState.delete(oldest);
  }
}

async function listNoteFiles(dir: string, rel = '', depth = 0, out: Array<{ abs: string; rel: string }> = []) {
  if (depth > MEMORY_NOTE_MAX_DEPTH || out.length >= MEMORY_NOTE_MAX_FILES) return out;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (out.length >= MEMORY_NOTE_MAX_FILES) break;
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await listNoteFiles(abs, childRel, depth + 1, out);
    else if (entry.isFile() && /\.(md|txt)$/i.test(entry.name)) out.push({ abs, rel: childRel }); // symlinks are skipped
  }
  return out;
}

async function pollRunNotes(session: PtySessionState, final: boolean) {
  const runId = session.runId!;
  const files = await listNoteFiles(path.join(session.runDir!, 'notes'));
  for (const { abs, rel } of files) {
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat || stat.size === 0) continue;
    const state = `${Math.round(stat.mtimeMs)}:${stat.size}`;
    if (memoryArtifactState.get(abs) === state) continue;
    if (!final && Date.now() - stat.mtimeMs < MEMORY_SETTLE_MS) continue;
    rememberArtifactState(abs, state);
    const text = (await fs.readFile(abs, 'utf-8').catch(() => '')).trim();
    if (!text) continue;
    const heading = text.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim();
    const { sessionId: _sessionId, ...meta } = sessionMemoryMeta(session); // any agent of the run may have written it
    await getMemoryStore()
      .upsertDocument({
        docId: `run:${runId}:notes/${rel}`,
        namespace: 'agent-notes',
        text: capMemoryText(text),
        metadata: { ...meta, kind: 'note', title: (heading || rel).slice(0, 160), source: 'agent' },
      })
      .catch((err) => console.warn(`[Ergo Memory] Ingesting note ${rel} of run ${runId} failed:`, err));
  }
}

function renderClaudeTodos(lists: any[]): string {
  const lines: string[] = [];
  for (const list of lists) {
    const items: any[] = Array.isArray(list) ? list : Array.isArray(list?.todos) ? list.todos : [];
    for (const item of items) {
      const content = String(item?.content || item?.activeForm || '').replace(/\s+/g, ' ').trim();
      if (!content) continue;
      const mark = item?.status === 'completed' ? '[x]' : item?.status === 'in_progress' ? '[~]' : '[ ]';
      lines.push(`${mark} ${content}`);
    }
  }
  return lines.length ? `Claude Code todo list:\n${lines.join('\n')}` : '';
}

/** `~/.claude/todos/<session uuid>*.json` of a claude session launched with `--session-id <uuid>`. */
async function pollClaudeTodos(session: PtySessionState, final: boolean) {
  const uuid = claudeSessionIdArg(session.args);
  if (!uuid || !/^[A-Za-z0-9-]{8,64}$/.test(uuid)) return;
  const dir = path.join(os.homedir(), '.claude', 'todos');
  const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => n.startsWith(uuid) && n.endsWith('.json')).sort();
  if (names.length === 0) return;
  const stats = await Promise.all(names.map((n) => fs.stat(path.join(dir, n)).catch(() => null)));
  const state = names.map((n, i) => `${n}:${Math.round(stats[i]?.mtimeMs ?? 0)}:${stats[i]?.size ?? 0}`).join('|');
  const key = `cc-todos:${session.id}:${uuid}`;
  if (memoryArtifactState.get(key) === state) return;
  if (!final && stats.some((s) => s && Date.now() - s.mtimeMs < MEMORY_SETTLE_MS)) return;
  rememberArtifactState(key, state);
  const lists: any[] = [];
  for (const n of names) {
    try {
      lists.push(JSON.parse(await fs.readFile(path.join(dir, n), 'utf-8')));
    } catch {}
  }
  const text = renderClaudeTodos(lists);
  if (!text) return;
  await getMemoryStore()
    .upsertDocument({
      docId: `cc-todos:${session.runId}:${session.id}`,
      namespace: 'agent-notes',
      text: capMemoryText(text),
      metadata: { ...sessionMemoryMeta(session), kind: 'artifact', title: 'Claude Code todo list', source: 'cli-artifact' },
    })
    .catch((err) => console.warn(`[Ergo Memory] Ingesting the todo list of [${session.id}] failed:`, err));
}

/** Called from the signal watcher (every poll, and once more when the agent exits). */
async function pollMemoryArtifacts(session: PtySessionState, final: boolean) {
  if (!session.runId || !session.runDir) return;
  try {
    await pollRunNotes(session, final);
  } catch (err) {
    console.warn(`[Ergo Memory] Polling notes of run ${session.runId} failed:`, err);
  }
  if (cliKindOf(session.cmd) === 'claude') {
    try {
      await pollClaudeTodos(session, final);
    } catch (err) {
      console.warn(`[Ergo Memory] Polling the todo list of [${session.id}] failed:`, err);
    }
  }
}

// ── Memory MCP server ──

interface MemoryCallContext {
  projectId?: string;
  taskId?: string;
  runId?: string;
  sessionId?: string;
  /** The caller's folder, for code_search when there is no agent session to read it from (the file scout). */
  cwd?: string;
}

/** Project + task of a run, from the agent sessions (live first, then ended), else from memory it already holds. */
async function resolveRunContext(runId: string): Promise<MemoryCallContext> {
  const sessions: Array<{ runId?: string; projectId?: string; taskId: string | number }> = [
    ...activePtySessions.values(),
    ...Array.from(endedPtySessions.values()).reverse(),
  ];
  const s = sessions.find((x) => x.runId === runId && x.projectId) || sessions.find((x) => x.runId === runId);
  if (s) return { runId, projectId: s.projectId, taskId: String(s.taskId) };
  const meta = await getMemoryStore().findMetadata((m) => m.runId === runId);
  if (meta) return { runId, projectId: meta.projectId, taskId: meta.taskId != null ? String(meta.taskId) : undefined };
  return { runId };
}

async function memoryCallContext(base: MemoryCallContext, runIdArg: unknown): Promise<MemoryCallContext> {
  const runId = typeof runIdArg === 'string' ? runIdArg.trim() : '';
  if (!runId || !SAFE_RUN_ID_RE.test(runId) || runId === base.runId) return base;
  const resolved = await resolveRunContext(runId);
  return { ...resolved, projectId: resolved.projectId || base.projectId, taskId: resolved.taskId || (resolved.projectId ? undefined : base.taskId) };
}

const oneLineSnippet = (text: string, max: number) => {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

function memoryHitLabel(c: MemoryChunkDTO): string {
  const what = c.metadata.kind || c.namespace;
  const title = c.metadata.title || c.metadata.taskTitle;
  return title ? `${what} · ${oneLineSnippet(String(title), 80)}` : what;
}

const MEMORY_MCP_TOOLS = [
  {
    name: 'code_search',
    description:
      'Find code in this project: semantic + keyword search over Ergo\'s index of the folder. Describe what you need in plain words ' +
      'and/or name identifiers. Returns the best-matching code with line numbers and surrounding lines, the enclosing function, and each ' +
      'file\'s outline. Use it FIRST every time you need to locate code; fall back to grep / find / ls only if it cannot find what you need.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        path: { type: 'string', description: 'Folder or subfolder to search (default: your working directory).' },
        k: { type: 'integer', minimum: 1, maximum: 8, description: 'Code sections to return (default 5; more sections show less surrounding code each).' },
        files: { type: 'array', items: { type: 'string' }, description: 'Only search these files (paths relative to the repository), e.g. the likely files you were given.' },
      },
      required: ['query'],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'memory_search',
    description: 'Search Ergo memory (run reports, plans, notes, past tasks, learnings). Compact hits; use memory_get for full text.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        scope: { type: 'string', enum: ['run', 'task', 'project'], description: 'Default project.' },
        kinds: { type: 'array', items: { type: 'string', enum: [...AGENT_NOTE_KINDS] } },
        top_k: { type: 'integer', minimum: 1, maximum: 8 },
        run_id: { type: 'string' },
      },
      required: ['query'],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'memory_get',
    description: 'Full text of a memory entry by id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'memory_save',
    description: 'Save a finding, decision or plan to Ergo memory. Same title updates it.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        text: { type: 'string' },
        kind: { type: 'string', enum: ['note', 'plan', 'artifact'] },
        run_id: { type: 'string' },
      },
      required: ['title', 'text'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
];

// ── Ergo workspace tools for CLI agents (relayed to the web app) ──
//
// A run whose task invokes a skill that calls workspace_* tools spawns its agents with workspaceTools: their
// ergo-memory server then lists those tools too. The board they act on lives in the web app, so a call goes out on the
// agent event stream as a `workspace-call` event; the app that owns the run claims it (one app, even with several tabs
// open), runs it against the open project, and posts the result back.

const WORKSPACE_CALL_TIMEOUT_MS = 60_000;
const WORKSPACE_TOOL_NAMES = new Set(WORKSPACE_MCP_TOOLS.map((t) => t.name));
/** Pre-approved for Claude Code: everything but the destructive ones, which it asks about on screen. */
const WORKSPACE_AUTO_APPROVED_TOOLS = WORKSPACE_MCP_TOOLS.filter((t) => t.autoApprove !== false).map((t) => t.name);
const WORKSPACE_MCP_TOOL_DEFS = WORKSPACE_MCP_TOOLS.map((t) => ({
  name: t.name,
  description: `[Ergo workspace] ${t.description}`,
  inputSchema: t.inputSchema || { type: 'object', properties: {} },
  annotations: {
    readOnlyHint: t.name.startsWith('workspace_list') || t.name.startsWith('workspace_read'),
    destructiveHint: t.name.includes('delete'),
    openWorldHint: false,
  },
}));

interface PendingWorkspaceCall {
  sessionId: string;
  claimed: boolean;
  resolve: (out: { text: string; isError?: boolean }) => void;
  timer: ReturnType<typeof setTimeout>;
}
const pendingWorkspaceCalls = new Map<string, PendingWorkspaceCall>();

function workspaceToolsFor(sessionId: string | undefined): PtySessionState | null {
  const session = sessionId ? activePtySessions.get(sessionId) : undefined;
  return session && session.workspaceTools && session.isActive ? session : null;
}

function relayWorkspaceCall(session: PtySessionState, tool: string, args: unknown): Promise<{ text: string; isError?: boolean }> {
  const callId = randomBytes(9).toString('base64url');
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingWorkspaceCalls.delete(callId);
      resolve({ text: 'Ergo did not answer: the Ergo app that started this run is not open. Leave this step undone and say so in your completion record.', isError: true });
    }, WORKSPACE_CALL_TIMEOUT_MS);
    timer.unref?.();
    pendingWorkspaceCalls.set(callId, { sessionId: session.id, claimed: false, resolve, timer });
    broadcastAgentEvent(session, { type: 'workspace-call', callId, tool, args: args && typeof args === 'object' ? args : {} });
  });
}

/** The app claims a call before running it; only the first claim wins. */
function claimWorkspaceCall(callId: string): boolean {
  const call = pendingWorkspaceCalls.get(callId);
  if (!call || call.claimed) return false;
  call.claimed = true;
  return true;
}

function settleWorkspaceCall(callId: string, result: { success?: unknown; data?: unknown; error?: unknown }): boolean {
  const call = pendingWorkspaceCalls.get(callId);
  if (!call) return false;
  pendingWorkspaceCalls.delete(callId);
  clearTimeout(call.timer);
  if (result.success === true) {
    const data = result.data === undefined ? { success: true } : result.data;
    call.resolve({ text: typeof data === 'string' ? data : JSON.stringify(data, null, 2).slice(0, 20_000) });
  } else {
    call.resolve({ text: `Ergo workspace error: ${typeof result.error === 'string' && result.error ? result.error : 'the action failed.'}`, isError: true });
  }
  return true;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'note';
}

async function callMemoryTool(name: string, args: any, base: MemoryCallContext): Promise<{ text: string; isError?: boolean }> {
  const store = getMemoryStore();
  args = args && typeof args === 'object' ? args : {};

  if (WORKSPACE_TOOL_NAMES.has(name)) {
    const session = workspaceToolsFor(base.sessionId);
    if (!session) return { text: 'Ergo workspace tools are not enabled for this agent.', isError: true };
    return relayWorkspaceCall(session, name, args);
  }

  if (name === 'code_search') {
    const query = typeof args.query === 'string' ? args.query.trim().slice(0, 2_000) : '';
    if (!query) return { text: 'query is required.', isError: true };
    const session = base.sessionId ? activePtySessions.get(base.sessionId) || endedPtySessions.get(base.sessionId) : undefined;
    return codeSearch(query, { path: typeof args.path === 'string' ? args.path : undefined, cwd: session?.cwd || base.cwd, k: Number(args.k) || undefined, files: args.files });
  }

  if (name === 'memory_search') {
    const query = typeof args.query === 'string' ? args.query.trim().slice(0, 2_000) : '';
    if (!query) return { text: 'query is required.', isError: true };
    const ctx = await memoryCallContext(base, args.run_id);
    const scope = args.scope === 'run' || args.scope === 'task' ? args.scope : 'project';
    const topK = Math.max(1, Math.min(8, Math.floor(Number(args.top_k) || 5)));
    const req: MemorySearchRequest = { query, topK: topK * 3, minSimilarity: 0.3, includeHidden: true };
    if (Array.isArray(args.kinds)) {
      const kinds = args.kinds.filter(isAgentNoteKind);
      if (kinds.length) req.kinds = kinds;
    }
    if (scope === 'run' && ctx.runId) req.runId = ctx.runId;
    else if (scope !== 'project' && ctx.taskId) req.taskId = ctx.taskId;
    if (ctx.projectId) req.projectId = ctx.projectId;
    const hits = await store.search(req);
    // One hit per document (memory_get returns the whole document anyway).
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const { chunk, similarity } of hits) {
      const doc = chunk.metadata.docId || chunk.id;
      if (seen.has(doc)) continue;
      seen.add(doc);
      lines.push(`[${chunk.id}] ${memoryHitLabel(chunk)} · sim ${similarity.toFixed(2)} — ${oneLineSnippet(chunk.text, MEMORY_SNIPPET_CHARS)}`);
      if (lines.length >= topK) break;
    }
    if (lines.length === 0) return { text: 'No relevant memory found.' };
    return { text: `${lines.join('\n')}\nUse memory_get with an id for the full text.` };
  }

  if (name === 'memory_get') {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!id) return { text: 'id is required.', isError: true };
    const chunk = await store.get(id);
    const docId = chunk ? chunk.metadata.docId : id.replace(/#\d+$/, '');
    let parts = docId ? await store.getDocument(docId) : [];
    if (chunk && parts.length <= 1) parts = [chunk];
    if (parts.length === 0) return { text: `No memory entry with id ${id}.`, isError: true };
    const head = parts[0];
    const label = memoryHitLabel(head);
    let text = parts.map((p) => p.text).join('\n\n');
    const total = text.length;
    if (total > MEMORY_GET_MAX_CHARS) text = `${text.slice(0, MEMORY_GET_MAX_CHARS)}\n…[truncated: ${total - MEMORY_GET_MAX_CHARS} more chars]`;
    const shownId = head.metadata.docId || head.id;
    return { text: `[${shownId}] ${label}${parts.length > 1 ? ` (${parts.length} parts)` : ''}\n${text}` };
  }

  if (name === 'memory_save') {
    const title = typeof args.title === 'string' ? args.title.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    if (!title || !text) return { text: 'title and text are required.', isError: true };
    const ctx = await memoryCallContext(base, args.run_id);
    if (!ctx.runId) return { text: 'No run context: pass run_id (your Ergo run id) to memory_save.', isError: true };
    const kind: AgentNoteKind = args.kind === 'plan' || args.kind === 'artifact' ? args.kind : 'note';
    const docId = `note:${ctx.runId}:${slugify(title)}`;
    await store.upsertDocument({
      docId,
      namespace: 'agent-notes',
      text: capMemoryText(text, 50_000),
      metadata: {
        ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
        ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
        runId: ctx.runId,
        ...(ctx.sessionId && ctx.runId === base.runId ? { sessionId: ctx.sessionId } : {}),
        kind,
        title,
        source: 'agent',
      },
    });
    return { text: `Saved to Ergo memory as ${docId}.` };
  }

  return { text: `Unknown tool ${name}.`, isError: true };
}

/** One JSON-RPC message → response object, or null for notifications. */
async function handleMemoryMcpMessage(msg: any, ctx: MemoryCallContext): Promise<Record<string, unknown> | null> {
  const isRequest = msg && typeof msg === 'object' && msg.id !== undefined && msg.id !== null;
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return { jsonrpc: '2.0', id: isRequest ? msg.id : null, error: { code: -32600, message: 'Invalid Request' } };
  }
  if (!isRequest) return null; // notifications (notifications/initialized, cancelled, …)
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result });
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: MEMORY_MCP_NAME, version: '1.0.0' },
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: workspaceToolsFor(ctx.sessionId) ? [...MEMORY_MCP_TOOLS, ...WORKSPACE_MCP_TOOL_DEFS] : MEMORY_MCP_TOOLS });
    case 'tools/call': {
      const toolName = String(params.name || '');
      try {
        const out = await callMemoryTool(toolName, params.arguments, ctx);
        return reply({ content: [{ type: 'text', text: out.text }], ...(out.isError ? { isError: true } : {}) });
      } catch (err: any) {
        console.warn(`[Ergo Memory] MCP ${toolName} failed:`, err);
        return reply({ content: [{ type: 'text', text: `Ergo memory error: ${err?.message || err}` }], isError: true });
      }
    }
    default:
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }
}

export function ergoMemoryPlugin(): Plugin {
  return {
    name: 'ergo-memory',
    configureServer(server) {
      installMemoryExitFlush();
      server.httpServer?.once('listening', () => {
        const addr = server.httpServer?.address();
        if (addr && typeof addr === 'object') {
          bridgeLocalOrigin = addr.address === '::1' ? `http://[::1]:${addr.port}` : `http://127.0.0.1:${addr.port}`;
        }
      });
      server.httpServer?.once('close', () => {
        memoryStoreInstance?.flushSync();
        codeIndexManager?.saveAll();
      });
      // Index the Allowed Folders in the background (a no-op for folders whose index is already current).
      setTimeout(() => void syncCodeIndexRoots(), 3_000).unref?.();

      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const url = req.url?.split('?')[0];
        if (!url || !(url.startsWith('/api/memory/') || url === MEMORY_MCP_PATH || url.startsWith('/api/code-index/'))) return next();
        if (!guardBridgeRequest(req, res)) return;
        const fullUrl = new URL(req.url || '', 'http://localhost');
        const q = fullUrl.searchParams;

        if (url === '/api/code-index/status' && req.method === 'GET') {
          return sendJson(res, 200, { success: true, indexes: getCodeIndexManager().statuses() });
        }
        if (url === '/api/code-index/scout' && req.method === 'POST') {
          // The file scout on a subscription CLI (src/lib/codeIndex/fileScout.ts): one headless Claude Code process on the
          // profile's small model, with code_search + read-only tools and no settings / CLAUDE.md / default prompt.
          let body: any = {};
          try {
            body = await parseJsonBody(req);
          } catch {}
          const cwd = typeof body.cwd === 'string' ? body.cwd.trim() : '';
          const taskText = typeof body.task === 'string' ? body.task : '';
          const cli = typeof body.cli === 'string' && body.cli.trim() ? body.cli.trim() : 'claude';
          if (!cwd || !path.isAbsolute(cwd) || !taskText.trim()) return sendJson(res, 400, { success: false, error: 'cwd (absolute) and task are required.' });
          if (!/claude/.test(path.basename(cli).toLowerCase())) return sendJson(res, 200, { success: false, error: 'The CLI scout runs on Claude Code only.' });
          const idx = getCodeIndexManager().forPath(cwd);
          if (!idx) return sendJson(res, 200, { success: false, error: 'This folder has no code index.' });
          const mcpConfig = JSON.stringify({ mcpServers: { [MEMORY_MCP_NAME]: { type: 'http', url: memoryMcpUrl({ cwd }) } } });
          const result = await runCliProcess({
            cli,
            cwd,
            prompt: scoutUserPrompt(taskText),
            model: typeof body.model === 'string' ? body.model : undefined,
            timeoutMs: SCOUT_TIMEOUT_MS,
            customArgs: [
              '--system-prompt', scoutSystemPrompt('code_search, Read, Grep, Glob'),
              '--setting-sources', '',
              '--strict-mcp-config',
              `--mcp-config=${mcpConfig}`,
              '--tools=Read,Grep,Glob',
              `--allowedTools=mcp__${MEMORY_MCP_NAME}__code_search,Read,Grep,Glob`,
              '--permission-mode', 'dontAsk',
              '--disable-slash-commands',
              '--no-session-persistence',
              '--max-turns', String(SCOUT_MAX_TURNS),
            ],
          });
          const files = parseScoutFiles(result.output || '', cwd);
          return sendJson(res, 200, {
            success: files.length > 0,
            files,
            usage: result.usage ?? null,
            durationMs: result.durationMs,
            ...(files.length ? {} : { error: result.timedOut ? 'The scout timed out.' : (result.stderr || 'The scout returned no files.').slice(0, 300) }),
          });
        }

        if (url === '/api/code-index/refresh' && req.method === 'POST') {
          // Task start: catch up on changes made while the watcher wasn't looking (stat comparison, bounded wait).
          let body: any = {};
          try {
            body = await parseJsonBody(req);
          } catch {}
          let target = typeof body.path === 'string' ? body.path.trim() : '';
          if (target.startsWith('~')) target = path.join(os.homedir(), target.slice(1));
          const idx = target && path.isAbsolute(target) ? getCodeIndexManager().forPath(target) : null;
          if (!idx) return sendJson(res, 200, { success: true, indexed: false });
          await Promise.race([idx.rescan(), new Promise((r) => setTimeout(r, 8_000))]);
          const status = idx.status();
          return sendJson(res, 200, { success: true, indexed: status.state !== 'too-large' && status.state !== 'error', status });
        }

        if (url === MEMORY_MCP_PATH) {
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.setHeader('Allow', 'POST');
            return res.end();
          }
          let body: any;
          try {
            body = await parseJsonBody(req);
          } catch {
            return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
          }
          const ctx: MemoryCallContext = {
            projectId: optString(q.get('project')),
            taskId: optString(q.get('task')),
            runId: optString(q.get('run'), 80),
            sessionId: optString(q.get('session')),
            cwd: optString(q.get('cwd'), 4_000),
          };
          if (Array.isArray(body)) {
            if (body.length === 0) return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
            const replies = (await Promise.all(body.map((m) => handleMemoryMcpMessage(m, ctx)))).filter(Boolean);
            if (replies.length === 0) {
              res.statusCode = 202;
              return res.end();
            }
            return sendJson(res, 200, replies);
          }
          const reply = await handleMemoryMcpMessage(body, ctx);
          if (!reply) {
            res.statusCode = 202;
            return res.end();
          }
          return sendJson(res, 200, reply);
        }

        const store = getMemoryStore();
        try {
          if (req.method === 'GET') {
            const filter = {
              namespace: isMemoryNamespace(q.get('namespace')) ? (q.get('namespace') as MemoryNamespace) : undefined,
              projectId: optString(q.get('projectId')),
              includeHidden: q.get('includeHidden') === '1' || q.get('includeHidden') === 'true',
            };
            if (url === '/api/memory/chunks') return sendJson(res, 200, { success: true, chunks: await store.list(filter) });
            if (url === '/api/memory/count') return sendJson(res, 200, { success: true, count: await store.count(filter) });
            if (url === '/api/memory/has') return sendJson(res, 200, { success: true, exists: await store.has(q.get('id') || '') });
            if (url === '/api/memory/status') {
              if (q.get('warm') === '1') store.warm();
              return sendJson(res, 200, { success: true, ...store.status() });
            }
            return next();
          }
          if (req.method !== 'POST') return next();

          let body: any;
          try {
            body = await parseJsonBody(req);
          } catch {
            return sendJson(res, 400, { success: false, error: 'Invalid JSON body.' });
          }

          if (url === '/api/memory/search') {
            const results = await store.search(sanitizeSearchRequest(body));
            return sendJson(res, 200, { success: true, results });
          }
          if (url === '/api/memory/add') {
            if (!Array.isArray(body?.chunks)) return sendJson(res, 400, { success: false, error: 'chunks must be an array.' });
            const chunks = body.chunks.map(sanitizeChunkInput).filter(Boolean) as NonNullable<ReturnType<typeof sanitizeChunkInput>>[];
            return sendJson(res, 200, { success: true, added: await store.add(chunks) });
          }
          if (url === '/api/memory/upsert-doc') {
            const docId = optString(body?.docId, 300);
            if (!docId || typeof body?.text !== 'string' || !isMemoryNamespace(body?.namespace)) {
              return sendJson(res, 400, { success: false, error: 'docId, namespace and text are required.' });
            }
            const metadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata) ? body.metadata : {};
            const count = await store.upsertDocument({ docId, namespace: body.namespace, text: capMemoryText(body.text), metadata });
            return sendJson(res, 200, { success: true, chunks: count });
          }
          if (url === '/api/memory/update') {
            if (typeof body?.id !== 'string' || !body.id) return sendJson(res, 400, { success: false, error: 'id is required.' });
            const chunk = await store.update(body.id, {
              ...(typeof body.text === 'string' ? { text: capMemoryText(body.text) } : {}),
              ...(isMemoryNamespace(body.namespace) ? { namespace: body.namespace } : {}),
              ...(body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata) ? { metadata: body.metadata } : {}),
            });
            return sendJson(res, 200, { success: true, chunk });
          }
          if (url === '/api/memory/remove') {
            let removed = 0;
            if (body?.all === true) removed = await store.remove({ all: true });
            else if (Array.isArray(body?.ids)) removed = await store.remove({ ids: body.ids.filter((x: unknown) => typeof x === 'string') });
            else if (optTaskId(body?.taskId) !== undefined) removed = await store.remove({ taskId: optTaskId(body.taskId)!, projectId: optString(body.projectId) });
            else if (optString(body?.projectId)) removed = await store.remove({ projectId: optString(body.projectId)! });
            else if (isMemoryNamespace(body?.namespace)) removed = await store.remove({ namespace: body.namespace });
            else return sendJson(res, 400, { success: false, error: 'Pass ids, taskId, projectId, namespace or all: true.' });
            return sendJson(res, 200, { success: true, removed });
          }
          if (url === '/api/memory/import') {
            if (!Array.isArray(body?.chunks)) return sendJson(res, 400, { success: false, error: 'chunks must be an array.' });
            const chunks = body.chunks
              .map((c: any) => {
                const base = sanitizeChunkInput(c);
                if (!base) return null;
                return {
                  ...base,
                  createdAt: typeof c.createdAt === 'number' ? c.createdAt : undefined,
                  embedding: Array.isArray(c.embedding) ? c.embedding : null,
                };
              })
              .filter(Boolean);
            return sendJson(res, 200, { success: true, imported: await store.importChunks(chunks) });
          }
          if (url === '/api/memory/workspace-sync') {
            const projectId = optString(body?.projectId);
            if (!projectId || !Array.isArray(body?.items)) {
              return sendJson(res, 400, { success: false, error: 'projectId and items are required.' });
            }
            return sendJson(res, 200, await store.syncWorkspace(projectId, sanitizeWorkspaceItems(body.items)));
          }
          if (url === '/api/memory/related') {
            const related = sanitizeRelatedRequest(body);
            if (!related) return sendJson(res, 400, { success: false, error: 'projectId is required.' });
            // The project's learned rules ride along (protocol 5): one call gives the run all of its memory context.
            const ruleQuery = [related.title, ...(related.subtasks || []), related.text || ''].filter(Boolean).join('\n');
            const [result, insights] = await Promise.all([
              store.relatedTasks(related),
              store.insightsForTask(related.projectId, ruleQuery).catch((err) => {
                console.warn('[Ergo Memory] Learned rules for the related-tasks call failed:', err);
                return [];
              }),
            ]);
            return sendJson(res, 200, { ...result, insights });
          }
          if (url === '/api/memory/insights/list') {
            const projectId = optString(body?.projectId);
            if (!projectId) return sendJson(res, 400, { success: false, error: 'projectId is required.' });
            return sendJson(res, 200, { success: true, insights: await store.listInsights(projectId) });
          }
          if (url === '/api/memory/insights/apply') {
            const projectId = optString(body?.projectId);
            if (!projectId || !Array.isArray(body?.ops) || body.ops.length > 50) {
              return sendJson(res, 400, { success: false, error: 'projectId and ops (at most 50) are required.' });
            }
            const ops = body.ops.map(sanitizeInsightOp).filter(Boolean) as InsightOp[];
            return sendJson(res, 200, await store.applyInsightOps(projectId, ops, sanitizeInsightSource(body.source)));
          }
          if (url === '/api/memory/embed') {
            if (!Array.isArray(body?.texts) || body.texts.length > 256) {
              return sendJson(res, 400, { success: false, error: 'texts must be an array of at most 256 strings.' });
            }
            const vectors = await store.embed(body.texts.map((t: unknown) => (typeof t === 'string' ? t : String(t ?? ''))));
            return sendJson(res, 200, { success: true, embeddings: vectors.map((v) => Array.from(v)) });
          }
          return next();
        } catch (err: any) {
          console.warn(`[Ergo Memory] ${req.method} ${url} failed:`, err);
          return sendJson(res, 500, { success: false, error: err?.message || String(err) });
        }
      });
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Local decision model — llama.cpp `llama-server` running Qwen 2.5 Coder 0.5B Instruct (GGUF Q4_K_M).
// Installed per user under <storage root>/.ergo/local-model (no system install, no sudo). The server is a child
// process bound to 127.0.0.1 with a random per-start API key. It makes the CLI-run shape decision (single
// deliverable? verifier?) and serves autocomplete; the client falls back to the provider's tiny cloud model when
// it is missing, so nothing here may make a task fail.
// REST (all behind guardBridgeRequest):
//   GET  /api/local-model/status
//   POST /api/local-model/install | cancel | uninstall
//   POST /api/local-model/shape     { title, subtasks?, kindHint? } → { success, single, needsVerifier, source: 'local', ms }
//   POST /api/local-model/complete  { prefix, suffix?, maxTokens? } → { success, text, source: 'local', ms }
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Autocomplete keeps only what the local model is sure of: nothing when its first token is a guess, and otherwise the
 * leading words it stays sure of. Replaying 442 cursor spots from real task lists, the raw model offered a suggestion
 * 77% of the time and got the next word right in 21% of them (2% fully right, ~7 words each). With these limits it
 * offers one 21% of the time: next word right 40%, fully right 25%, ~1.7 words each.
 */
const COMPLETE_MIN_FIRST_TOKEN_PROB = 0.3;
const COMPLETE_MIN_RUNNING_PROB = 0.1;

function confidentCompletion(tokens: Array<{ token?: string; logprob?: number }>): string {
  if (!tokens.length || Math.exp(tokens[0].logprob ?? -Infinity) < COMPLETE_MIN_FIRST_TOKEN_PROB) return '';
  let text = '';
  let word = '';
  let running = 1;
  for (const { token = '', logprob = -Infinity } of tokens) {
    if (/^\s/.test(token) && word) {
      text += word;
      word = '';
    }
    running *= Math.exp(logprob);
    if (running < COMPLETE_MIN_RUNNING_PROB) return text; // a word the model isn't sure of is left out whole
    word += token;
  }
  return text + word;
}

const LOCAL_MODEL_RUNTIME_VERSION = 'b11669';
const LOCAL_MODEL_ID = 'qwen2.5-coder-0.5b-instruct-q4_k_m';

type LocalModelAsset = { file: string; bytes: number; sha256: string };

/** Pinned llama.cpp CPU builds, keyed by `${process.platform}-${process.arch}`. */
const LOCAL_MODEL_RUNTIMES: Record<string, LocalModelAsset> = {
  'linux-x64': { file: 'llama-b11669-bin-ubuntu-x64.tar.gz', bytes: 17_851_611, sha256: 'cf07c1c112d709bd67e522017471de57ed0ec8bea031d732c5422351c07f65ac' },
  'linux-arm64': { file: 'llama-b11669-bin-ubuntu-arm64.tar.gz', bytes: 13_900_160, sha256: '9ac6fda2058d35677608a06f751a50122ddfa4ce0ddb7f084466b8e79b6d4a99' },
  'darwin-arm64': { file: 'llama-b11669-bin-macos-arm64.tar.gz', bytes: 12_191_582, sha256: 'dbed55493d72bc1ba2babc8770d669c2289b5bc4ee9fb2a4dfc158d45b7d13fd' },
  'darwin-x64': { file: 'llama-b11669-bin-macos-x64.tar.gz', bytes: 11_677_404, sha256: 'cab28238d78158109b48deb27b05d50e0dcef56275d2e76da9ca8281526c7532' },
  'win32-x64': { file: 'llama-b11669-bin-win-cpu-x64.zip', bytes: 19_537_886, sha256: '37b3efcf962847ca869745fd4ccf7f5e7e8dacfeff9fa3523b4ca8cdc66d632b' },
  'win32-arm64': { file: 'llama-b11669-bin-win-cpu-arm64.zip', bytes: 12_442_177, sha256: '9cff39ffed17edcd03a7d876073f74d7b48cd43a1e5eafdd59ee094185ad871b' },
};

const LOCAL_MODEL_GGUF: LocalModelAsset = {
  file: 'qwen2.5-coder-0.5b-instruct-q4_k_m.gguf',
  bytes: 491_400_064,
  sha256: '1d9614638d18024d0fbb36575a15f1302a3adf044df10345688ec4f6e1c4ff32',
};

const LOCAL_MODEL_PLATFORM = `${process.platform}-${process.arch}`;
const LOCAL_MODEL_RUNTIME: LocalModelAsset | undefined = LOCAL_MODEL_RUNTIMES[LOCAL_MODEL_PLATFORM];

const LOCAL_MODEL_PORT_MIN = 11500;
const LOCAL_MODEL_PORT_MAX = 11599;
const LOCAL_MODEL_HEALTH_TIMEOUT_MS = 20_000;
const LOCAL_MODEL_REQUEST_TIMEOUT_MS = 15_000;
/** The server stops after this long without a request, so the model only holds RAM while it's being used. */
const LOCAL_MODEL_IDLE_STOP_MS = 10 * 60_000;
const LOCAL_MODEL_STALL_TIMEOUT_MS = 60_000;
const LOCAL_MODEL_CRASH_WINDOW_MS = 120_000;
const LOCAL_MODEL_MAX_CRASHES = 3;

/**
 * Download URLs. ERGO_LOCAL_MODEL_RUNTIME_URL (a base the asset name is appended to) and ERGO_LOCAL_MODEL_MODEL_URL
 * override them for mirrors and tests; the pinned sizes and SHA-256 sums are enforced either way.
 */
function localModelRuntimeUrl(asset: LocalModelAsset): string {
  const base = process.env.ERGO_LOCAL_MODEL_RUNTIME_URL || `https://github.com/ggml-org/llama.cpp/releases/download/${LOCAL_MODEL_RUNTIME_VERSION}/`;
  return base.endsWith('/') ? base + asset.file : `${base}/${asset.file}`;
}

function localModelGgufUrl(): string {
  return (
    process.env.ERGO_LOCAL_MODEL_MODEL_URL ||
    `https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF/resolve/ebb2015119c907b064c512bf053e945850b5875f/${LOCAL_MODEL_GGUF.file}`
  );
}

/** `<storage root>/local-model` when the root is a `.ergo` folder, else `<storage root>/.ergo/local-model` (as the memory store). */
function localModelInstallDir(): string {
  const root = getActiveStorageDir();
  const base = path.basename(root) === '.ergo' ? root : path.join(root, '.ergo');
  return path.join(base, 'local-model');
}

// Few-shot prompts, exactly as evaluated (scratchpad qwen/qeval2.py, round 2). The assistant turns keep the
// evaluation's `{"key": value}` formatting.
type LocalBoolQuestion = { key: string; system: string; shots: Array<[string, boolean]> };

const LOCAL_SINGLE_QUESTION: LocalBoolQuestion = {
  key: 'single',
  system:
    'Decide if a to-do item is one small, self-contained job (single=true) or a bigger job with several distinct parts (single=false). Reply with JSON.',
  shots: [
    ['Fix the typo in the footer', true],
    ['Build user accounts | Subtasks: sign-up; login; password reset; profile page', false],
    ['Write a short release announcement', true],
    ['Migrate the app to the new payment provider | Subtasks: API client; webhooks; data migration; remove old SDK', false],
  ],
};

const LOCAL_VERIFIER_QUESTION: LocalBoolQuestion = {
  key: 'needs_qa',
  system:
    'Decide if a coding change is risky or broad enough that an independent reviewer should test it (needs_qa=true), or a small contained change (needs_qa=false). Reply with JSON.',
  shots: [
    ['Change the button color on the settings page', false],
    ['Rewrite the authentication system to use OAuth | Subtasks: providers; token storage; migrate sessions', true],
    ['Add a tooltip to the export icon', false],
    ['Move all data from SQLite to Postgres with a migration script', true],
  ],
};

function localBoolMessages(question: LocalBoolQuestion, query: string) {
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [{ role: 'system', content: question.system }];
  for (const [text, answer] of question.shots) {
    messages.push({ role: 'user', content: text }, { role: 'assistant', content: `{"${question.key}": ${answer}}` });
  }
  messages.push({ role: 'user', content: query });
  return messages;
}

type LocalModelState = 'not_installed' | 'installing' | 'installed' | 'starting' | 'ready' | 'error';
type LocalModelPhase = 'runtime' | 'model' | 'verifying' | 'extracting';

interface LocalModelRecord {
  version: 1;
  platform: string;
  runtime: { version: string; file: string; sha256: string; server: string };
  model: { id: string; file: string; bytes: number; sha256: string };
  installedAt: string;
}

interface LocalModelInstallJob {
  abort: AbortController;
  phase: LocalModelPhase;
  bytesDone: number;
  bytesTotal: number;
  done: Promise<void>;
}

type LocalModelPaths = { dir: string; record: string; pidFile: string; downloads: string; runtime: string; model: string };

function localModelPaths(dir: string): LocalModelPaths {
  return {
    dir,
    record: path.join(dir, 'install.json'),
    pidFile: path.join(dir, 'server.pid'),
    downloads: path.join(dir, 'downloads'),
    runtime: path.join(dir, 'runtime', `llama-${LOCAL_MODEL_RUNTIME_VERSION}`),
    model: path.join(dir, 'models', LOCAL_MODEL_GGUF.file),
  };
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const toMb = (bytes: number) => Math.round(bytes / 1_000_000);
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Removes a directory tree, retrying briefly when Windows still holds a handle open. */
async function removeTree(target: string) {
  await fs.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}

async function ensureFreeDiskSpace(dir: string, needed: number) {
  let free: number;
  try {
    const stats = await fs.statfs(dir);
    free = Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return; // statfs unsupported here: let the download find out
  }
  if (free < needed) throw new Error(`not enough disk space (${toMb(needed)} MB needed, ${toMb(free)} MB free)`);
}

/**
 * Streams `url` to `<dest>.part` while hashing it, then renames it to `dest` — only when the size and SHA-256 match
 * the pinned values. Anything else (wrong size, wrong hash, oversized body, stall, cancel) removes the .part file.
 */
async function downloadVerified(
  url: string,
  dest: string,
  expected: LocalModelAsset,
  signal: AbortSignal,
  onBytes: (count: number) => void,
  onVerify: () => void
): Promise<void> {
  const part = `${dest}.part`;
  // Aborted by a cancel (`signal`) or by a stall. (Built by hand: AbortSignal.any needs Node 20.3+, Vite 5 runs on 18.)
  const combined = new AbortController();
  const onCancel = () => combined.abort(new Error('cancelled'));
  if (signal.aborted) onCancel();
  else signal.addEventListener('abort', onCancel, { once: true });
  let stallError: Error | null = null;
  let stallTimer: NodeJS.Timeout | undefined;
  const armStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stallError = new Error(`the download of ${expected.file} stalled for ${LOCAL_MODEL_STALL_TIMEOUT_MS / 1000} s`);
      combined.abort(stallError);
    }, LOCAL_MODEL_STALL_TIMEOUT_MS);
  };
  armStall();
  try {
    const res = await fetch(url, { signal: combined.signal, redirect: 'follow', headers: { 'User-Agent': 'Ergo-local-model' } });
    if (!res.ok || !res.body) throw new Error(`downloading ${expected.file} failed: HTTP ${res.status} from ${new URL(url).host}`);
    const announced = Number(res.headers.get('content-length') || 0);
    if (announced && announced !== expected.bytes) {
      throw new Error(`${expected.file} is ${announced} bytes on the server, expected ${expected.bytes}; refusing it`);
    }
    const hash = createHash('sha256');
    let received = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > expected.bytes) {
          callback(new Error(`${expected.file} is larger than the expected ${expected.bytes} bytes; refusing it`));
          return;
        }
        hash.update(chunk);
        onBytes(chunk.length);
        armStall();
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body as NodeWebReadableStream<Uint8Array>), meter, fsSync.createWriteStream(part), { signal: combined.signal });
    onVerify();
    if (received !== expected.bytes) throw new Error(`${expected.file} ended after ${received} of ${expected.bytes} bytes`);
    const digest = hash.digest('hex');
    if (digest !== expected.sha256) {
      throw new Error(`checksum mismatch for ${expected.file} (sha256 ${digest.slice(0, 16)}…, expected ${expected.sha256.slice(0, 16)}…); refusing to install it`);
    }
    await fs.rename(part, dest);
  } catch (err) {
    await fs.rm(part, { force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
    if (signal.aborted) throw new Error('cancelled');
    throw stallError ?? err;
  } finally {
    clearTimeout(stallTimer);
    signal.removeEventListener('abort', onCancel);
  }
}

async function findFileByName(dir: string, name: string, depth: number): Promise<string | null> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [] as fsSync.Dirent[]);
  for (const entry of entries) if (entry.isFile() && entry.name === name) return path.join(dir, entry.name);
  if (depth <= 0) return null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const hit = await findFileByName(path.join(dir, entry.name), name, depth - 1);
    if (hit) return hit;
  }
  return null;
}

/**
 * Unpacks the (already verified) runtime archive with the system `tar` into a temp dir inside the install dir, then
 * moves the whole tree (llama-server plus the libraries next to it) to `runtimeDir`. Returns the server's path
 * relative to `installDir`, '/'-separated.
 */
async function extractLocalRuntime(archive: string, installDir: string, runtimeDir: string, signal: AbortSignal): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(installDir, '.extract-'));
  try {
    // Windows 10+ ships bsdtar, which also reads .zip; prefer it over a GNU tar (Git Bash) earlier on PATH.
    const systemTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    const tar = process.platform === 'win32' && fsSync.existsSync(systemTar) ? systemTar : 'tar';
    const args = archive.endsWith('.zip') ? ['-xf', archive, '-C', tmp] : ['-xzf', archive, '-C', tmp];
    await new Promise<void>((resolve, reject) => {
      execFile(tar, args, { signal, timeout: 120_000, windowsHide: true }, (err, _stdout, stderr) => {
        if (err) reject(new Error(`could not unpack the runtime: ${String(stderr || err.message).trim().slice(0, 300)}`));
        else resolve();
      });
    });
    const entries = await fs.readdir(tmp, { withFileTypes: true });
    const root = entries.length === 1 && entries[0].isDirectory() ? path.join(tmp, entries[0].name) : tmp;
    const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
    const found = await findFileByName(root, exe, 4);
    if (!found) throw new Error(`${exe} is missing from the runtime archive`);
    const relInRoot = path.relative(root, found);
    await removeTree(runtimeDir);
    await fs.mkdir(path.dirname(runtimeDir), { recursive: true });
    await fs.rename(root, runtimeDir);
    const serverPath = path.join(runtimeDir, relInRoot);
    if (process.platform !== 'win32') await fs.chmod(serverPath, 0o755);
    if (process.platform === 'darwin') {
      await new Promise<void>((resolve) => execFile('xattr', ['-dr', 'com.apple.quarantine', runtimeDir], () => resolve()));
    }
    return path.relative(installDir, serverPath).split(path.sep).join('/');
  } finally {
    await removeTree(tmp);
  }
}

function isLocalPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, () => probe.close(() => resolve(true)));
  });
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

/**
 * Owns the install and the llama-server child process for the current storage root. One per bridge process: a config
 * reload disposes the previous one (see replaceLocalModelManager).
 */
class LocalModelManager {
  private dir = localModelInstallDir();
  private job: LocalModelInstallJob | null = null;
  /** Install / start failure shown by status until the next attempt succeeds. */
  private lastError: string | null = null;
  private child: ChildProcess | null = null;
  /** Servers sent SIGTERM whose exit hasn't been seen yet. */
  private stopping = new Set<ChildProcess>();
  private port = 0;
  private apiKey = '';
  private serverState: 'stopped' | 'starting' | 'ready' = 'stopped';
  private startPromise: Promise<void> | null = null;
  /** Bumped by every stop, so a start or exit that belongs to an older server is ignored. */
  private generation = 0;
  private crashTimes: number[] = [];
  private gaveUp = false;
  private logTail: string[] = [];
  private disposed = false;
  private inFlight = 0;
  private idleTimer: NodeJS.Timeout | null = null;

  private get paths(): LocalModelPaths {
    return localModelPaths(this.dir);
  }

  /** Follows a storage-root change: the old root's download and server stop. */
  private syncDir() {
    const dir = localModelInstallDir();
    if (dir === this.dir) return;
    this.job?.abort.abort(); // its own cleanup removes the old partial install
    this.job = null;
    void this.stopServer();
    this.dir = dir;
    this.lastError = null;
    this.crashTimes = [];
    this.gaveUp = false;
  }

  /** The install when its record matches the pinned versions and its files are present; otherwise null. */
  private installed(): { serverPath: string; modelPath: string } | null {
    const p = this.paths;
    let record: LocalModelRecord;
    try {
      record = JSON.parse(fsSync.readFileSync(p.record, 'utf-8'));
    } catch {
      return null;
    }
    if (
      record?.platform !== LOCAL_MODEL_PLATFORM ||
      record?.runtime?.version !== LOCAL_MODEL_RUNTIME_VERSION ||
      record?.model?.sha256 !== LOCAL_MODEL_GGUF.sha256 ||
      typeof record.runtime.server !== 'string'
    ) {
      return null;
    }
    const serverPath = path.resolve(p.dir, ...record.runtime.server.split('/'));
    if (!serverPath.startsWith(p.dir + path.sep)) return null;
    try {
      if (!fsSync.statSync(serverPath).isFile()) return null;
      if (fsSync.statSync(p.model).size !== LOCAL_MODEL_GGUF.bytes) return null;
    } catch {
      return null;
    }
    return { serverPath, modelPath: p.model };
  }

  status() {
    this.syncDir();
    const job = this.job;
    const isInstalled = !job && this.installed() !== null;
    let state: LocalModelState;
    if (job) state = 'installing';
    else if (!isInstalled) state = this.lastError ? 'error' : 'not_installed';
    else if (this.serverState === 'ready') state = 'ready';
    else if (this.serverState === 'starting') state = 'starting';
    else state = this.lastError || this.gaveUp ? 'error' : 'installed';
    return {
      success: true,
      state,
      ...(job ? { phase: job.phase, bytesDone: job.bytesDone, bytesTotal: job.bytesTotal } : {}),
      ...(state === 'error' && this.lastError ? { error: this.lastError } : {}),
      platformSupported: Boolean(LOCAL_MODEL_RUNTIME),
      sizes: { runtimeBytes: LOCAL_MODEL_RUNTIME?.bytes ?? 0, modelBytes: LOCAL_MODEL_GGUF.bytes },
      installDir: this.dir,
      version: { runtime: LOCAL_MODEL_RUNTIME_VERSION, model: LOCAL_MODEL_ID },
    };
  }

  /** Starts a background install (idempotent). When already installed, (re)starts the server instead. */
  install(): { ok: boolean; error?: string } {
    this.syncDir();
    if (this.job) return { ok: true };
    const runtime = LOCAL_MODEL_RUNTIME;
    if (!runtime) {
      return { ok: false, error: `The local model isn't available for this platform (${LOCAL_MODEL_PLATFORM}). Use the cloud model instead.` };
    }
    if (this.installed()) {
      // Also the way out of a crash-loop error: try again from a clean slate.
      this.gaveUp = false;
      this.crashTimes = [];
      this.lastError = null;
      this.inUse(() => this.ensureStarted()).catch(() => {}); // starts the idle countdown too
      return { ok: true };
    }
    const job: LocalModelInstallJob = {
      abort: new AbortController(),
      phase: 'runtime',
      bytesDone: 0,
      bytesTotal: runtime.bytes + LOCAL_MODEL_GGUF.bytes,
      done: Promise.resolve(),
    };
    this.job = job;
    this.lastError = null;
    this.gaveUp = false;
    this.crashTimes = [];
    job.done = this.runInstall(job, runtime, this.paths);
    return { ok: true };
  }

  private async runInstall(job: LocalModelInstallJob, runtime: LocalModelAsset, p: LocalModelPaths): Promise<void> {
    const signal = job.abort.signal;
    try {
      if (path.basename(p.dir) !== 'local-model') throw new Error(`unexpected install folder ${p.dir}`);
      await removeTree(p.dir); // leftovers of an interrupted install
      await fs.mkdir(p.downloads, { recursive: true });
      await ensureFreeDiskSpace(p.dir, runtime.bytes * 6 + LOCAL_MODEL_GGUF.bytes + 64_000_000);

      // 1. Runtime: download + verify, unpack into a temp dir, move into place.
      const archive = path.join(p.downloads, runtime.file);
      await downloadVerified(localModelRuntimeUrl(runtime), archive, runtime, signal, (n) => (job.bytesDone += n), () => (job.phase = 'verifying'));
      job.phase = 'extracting';
      const serverRel = await extractLocalRuntime(archive, p.dir, p.runtime, signal);
      await fs.rm(archive, { force: true });

      // 2. Model.
      job.phase = 'model';
      await fs.mkdir(path.dirname(p.model), { recursive: true });
      await downloadVerified(localModelGgufUrl(), p.model, LOCAL_MODEL_GGUF, signal, (n) => (job.bytesDone += n), () => (job.phase = 'verifying'));
      await removeTree(p.downloads);

      if (signal.aborted) throw new Error('cancelled');
      const record: LocalModelRecord = {
        version: 1,
        platform: LOCAL_MODEL_PLATFORM,
        runtime: { version: LOCAL_MODEL_RUNTIME_VERSION, file: runtime.file, sha256: runtime.sha256, server: serverRel },
        model: { id: LOCAL_MODEL_ID, file: LOCAL_MODEL_GGUF.file, bytes: LOCAL_MODEL_GGUF.bytes, sha256: LOCAL_MODEL_GGUF.sha256 },
        installedAt: new Date().toISOString(),
      };
      const tmpRecord = `${p.record}.tmp`;
      await fs.writeFile(tmpRecord, JSON.stringify(record, null, 2), 'utf-8');
      await fs.rename(tmpRecord, p.record);
    } catch (err) {
      // Nothing half-installed stays behind: a failed or cancelled install removes the whole folder.
      await removeTree(p.dir);
      if (this.job === job) {
        this.job = null;
        this.lastError = signal.aborted ? null : `Installing the local model failed: ${errorText(err)}`;
        if (this.lastError) console.warn(`[Ergo Local Model] ${this.lastError}`);
      }
      return;
    }
    if (this.job !== job) return;
    this.job = null;
    console.log(`[Ergo Local Model] Installed ${LOCAL_MODEL_ID} (llama.cpp ${LOCAL_MODEL_RUNTIME_VERSION}) in ${p.dir}.`);
    this.inUse(() => this.ensureStarted()).catch(() => {}); // starts the idle countdown too
  }

  /** Aborts a running install; its cleanup removes the partial files before this resolves. */
  async cancel(): Promise<void> {
    this.syncDir();
    const job = this.job;
    if (!job) return;
    job.abort.abort();
    await Promise.race([job.done, delay(15_000)]);
  }

  async uninstall(): Promise<void> {
    this.syncDir();
    await this.cancel();
    await this.stopServer();
    if (path.basename(this.dir) === 'local-model') await removeTree(this.dir);
    this.lastError = null;
    this.crashTimes = [];
    this.gaveUp = false;
  }

  /** Starts the server when installed (serialized: concurrent callers share one start). */
  ensureStarted(): Promise<void> {
    if (this.serverState === 'ready' && this.child) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    if (this.disposed) return Promise.reject(new Error('The bridge is shutting down.'));
    if (this.job) return Promise.reject(new Error('The local model is still installing.'));
    const install = this.installed();
    if (!install) return Promise.reject(new Error('The local model is not installed.'));
    if (this.gaveUp) return Promise.reject(new Error(this.lastError || 'The local model is off after repeated crashes.'));
    const gen = this.generation;
    this.serverState = 'starting';
    const run: Promise<void> = (async () => {
      try {
        await this.startServer(install.serverPath, install.modelPath, gen);
        this.serverState = 'ready';
        this.lastError = null;
        console.log(`[Ergo Local Model] llama-server ready on 127.0.0.1:${this.port}.`);
      } catch (err) {
        if (gen === this.generation) {
          this.serverState = 'stopped';
          if (this.child) {
            const child = this.child;
            this.child = null;
            this.port = 0;
            try {
              child.kill('SIGKILL');
            } catch {}
          }
          this.noteCrash(`could not start: ${errorText(err)}`);
        }
        throw err;
      }
    })();
    this.startPromise = run;
    const clear = () => {
      if (this.startPromise === run) this.startPromise = null;
    };
    run.then(clear, clear);
    return run;
  }

  private noteCrash(reason: string) {
    const now = Date.now();
    this.crashTimes = this.crashTimes.filter((t) => now - t < LOCAL_MODEL_CRASH_WINDOW_MS);
    this.crashTimes.push(now);
    // llama-server log lines look like "0.00.553.718 E srv  …": keep the last error-level lines as the explanation.
    const hints = this.logTail
      .filter((line) => /^[\d.]+ E /.test(line) || /error|failed|unable|cannot/i.test(line))
      .slice(-2)
      .map((line) => line.replace(/^[\d.]+ [A-Z] +/, '').slice(0, 200));
    const detail = `${reason}${hints.length ? ` (${hints.join(' | ')})` : ''}`;
    if (this.crashTimes.length >= LOCAL_MODEL_MAX_CRASHES) {
      this.gaveUp = true;
      this.lastError = `The local model server failed ${this.crashTimes.length} times in 2 minutes, so Ergo stopped restarting it. Last: ${detail}.`;
    } else {
      this.lastError = `The local model server ${detail}.`;
    }
    console.warn(`[Ergo Local Model] ${this.lastError}`);
  }

  private async startServer(serverPath: string, modelPath: string, gen: number): Promise<void> {
    const stopped = () => new Error('The local model server was stopped.');
    await this.killOrphanServer(serverPath);
    let port = 0;
    for (let candidate = LOCAL_MODEL_PORT_MIN; candidate <= LOCAL_MODEL_PORT_MAX && !port; candidate++) {
      if (await isLocalPortFree(candidate)) port = candidate;
    }
    if (!port) throw new Error(`no free port in ${LOCAL_MODEL_PORT_MIN}-${LOCAL_MODEL_PORT_MAX}`);
    if (gen !== this.generation) throw stopped();

    const apiKey = randomBytes(24).toString('hex');
    const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
    const threads = Math.max(1, Math.min(8, cpus - 1));
    // Drop the user's LLAMA_* variables (e.g. LLAMA_ARG_HOST): only the flags below configure this server.
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) if (!/^LLAMA_/i.test(key)) env[key] = value;
    env.LLAMA_API_KEY = apiKey; // via env, not argv, so other local users can't read it from `ps`
    const binDir = path.dirname(serverPath);
    if (process.platform === 'linux') env.LD_LIBRARY_PATH = [binDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
    if (process.platform === 'darwin') env.DYLD_LIBRARY_PATH = [binDir, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(':');

    const args = ['-m', modelPath, '--host', '127.0.0.1', '--port', String(port), '-c', '4096', '--parallel', '2', '-t', String(threads), '--no-webui', '--no-slots'];
    const child = spawn(serverPath, args, { cwd: binDir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    this.port = port;
    this.apiKey = apiKey;
    const tail: string[] = [];
    this.logTail = tail;
    const collect = (chunk: Buffer) => {
      for (const line of chunk.toString('utf-8').split(/\r?\n/)) {
        const text = line.trim();
        if (text) tail.push(text.slice(0, 300));
      }
      if (tail.length > 60) tail.splice(0, tail.length - 60);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    const exit = { reason: '' };
    const onGone = (reason: string) => {
      if (exit.reason) return;
      exit.reason = reason;
      this.removePidFile(child.pid);
      if (this.child !== child) return; // stopped on purpose
      const wasReady = this.serverState === 'ready';
      this.child = null;
      this.port = 0;
      this.serverState = 'stopped';
      if (!wasReady) return; // a failed start: ensureStarted reports it
      this.noteCrash(`crashed (${reason})`);
      // Restart once per crash; noteCrash gives up after LOCAL_MODEL_MAX_CRASHES in the window.
      if (!this.gaveUp && !this.disposed) this.ensureStarted().catch(() => {});
    };
    child.once('error', (err) => onGone(`failed to launch: ${err.message}`));
    child.once('exit', (code, signal) => onGone(signal ? `killed by ${signal}` : `exit code ${code}`));
    if (child.pid) this.writePidFile(child.pid, serverPath);

    const deadline = Date.now() + LOCAL_MODEL_HEALTH_TIMEOUT_MS;
    for (;;) {
      if (exit.reason) throw new Error(`llama-server ${exit.reason}`);
      if (gen !== this.generation) throw stopped();
      if (Date.now() > deadline) throw new Error(`llama-server was not ready within ${LOCAL_MODEL_HEALTH_TIMEOUT_MS / 1000} s`);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) });
        await res.arrayBuffer().catch(() => null); // release the connection
        if (res.ok && !exit.reason) return; // 503 while the model loads
      } catch {}
      await delay(150);
    }
  }

  private async stopServer(): Promise<void> {
    this.generation++;
    this.startPromise = null;
    const child = this.child;
    this.child = null;
    this.port = 0;
    this.serverState = 'stopped';
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null) {
      this.stopping.add(child);
      await new Promise<void>((resolve) => {
        const force = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {}
        }, 3_000);
        const giveUp = setTimeout(finish, 6_000);
        function finish() {
          clearTimeout(force);
          clearTimeout(giveUp);
          resolve();
        }
        child.once('exit', finish);
        try {
          child.kill('SIGTERM');
        } catch {
          finish();
        }
      });
      this.stopping.delete(child);
    }
    this.removePidFile(child.pid);
  }

  private writePidFile(pid: number, serverPath: string) {
    try {
      fsSync.writeFileSync(this.paths.pidFile, JSON.stringify({ pid, ownerPid: process.pid, server: serverPath, startedAt: new Date().toISOString() }));
    } catch {}
  }

  private removePidFile(pid: number | undefined) {
    const file = this.paths.pidFile;
    try {
      if (JSON.parse(fsSync.readFileSync(file, 'utf-8'))?.pid === pid) fsSync.rmSync(file, { force: true });
    } catch {}
  }

  /** Stops a server left behind by a bridge that was killed outright (SIGKILL), so orphans don't pile up. */
  private async killOrphanServer(serverPath: string) {
    if (process.platform === 'win32') return;
    const file = this.paths.pidFile;
    let info: any;
    try {
      info = JSON.parse(await fs.readFile(file, 'utf-8'));
    } catch {
      return;
    }
    const pid = Number(info?.pid);
    const owner = Number(info?.ownerPid);
    if (!Number.isInteger(pid) || pid <= 1 || pid === this.child?.pid) return;
    // A server owned by another live bridge on the same storage root is not an orphan.
    if (Number.isInteger(owner) && owner !== process.pid && isPidAlive(owner)) return;
    if (isPidAlive(pid)) {
      const command = await new Promise<string>((resolve) =>
        execFile('ps', ['-o', 'command=', '-p', String(pid)], { timeout: 3_000 }, (err, stdout) => resolve(err ? '' : String(stdout)))
      );
      if (info?.server === serverPath && command.includes(serverPath)) {
        try {
          process.kill(pid, 'SIGKILL');
          console.log(`[Ergo Local Model] Stopped an orphaned llama-server (pid ${pid}).`);
          for (let i = 0; i < 20 && isPidAlive(pid); i++) await delay(100); // let it release its port
        } catch {}
      }
    }
    await fs.rm(file, { force: true }).catch(() => {});
  }

  private async llamaPost(route: string, body: unknown): Promise<any> {
    if (!this.port) throw new Error('The local model server is not running.');
    const res = await fetch(`http://127.0.0.1:${this.port}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(LOCAL_MODEL_REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`llama-server answered HTTP ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  }

  private async askBool(question: LocalBoolQuestion, query: string): Promise<boolean> {
    const out = await this.llamaPost('/v1/chat/completions', {
      messages: localBoolMessages(question, query),
      temperature: 0,
      max_tokens: 32,
      cache_prompt: true,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'a', schema: { type: 'object', properties: { [question.key]: { type: 'boolean' } }, required: [question.key] } },
      },
    });
    const content = out?.choices?.[0]?.message?.content;
    let value: unknown;
    try {
      value = JSON.parse(typeof content === 'string' ? content : '')?.[question.key];
    } catch {}
    if (typeof value !== 'boolean') throw new Error(`The local model gave no usable "${question.key}" answer.`);
    return value;
  }

  /** Runs a model request; the idle countdown restarts once no request is in flight. */
  private async inUse<T>(fn: () => Promise<T>): Promise<T> {
    this.inFlight++;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    try {
      return await fn();
    } finally {
      this.inFlight--;
      if (this.inFlight === 0 && !this.disposed) {
        this.idleTimer = setTimeout(() => {
          this.idleTimer = null;
          if (this.inFlight > 0 || this.serverState === 'stopped') return;
          console.log('[Ergo Local Model] Stopping the idle model server; the next request starts it again.');
          void this.stopServer();
        }, LOCAL_MODEL_IDLE_STOP_MS);
        this.idleTimer.unref();
      }
    }
  }

  async shape(input: { title: string; subtasks: string[]; skipVerifier: boolean }): Promise<{ single: boolean; needsVerifier: boolean; ms: number }> {
    this.syncDir();
    return this.inUse(async () => {
      const started = Date.now();
      await this.ensureStarted();
      const query = input.title + (input.subtasks.length ? ` | Subtasks: ${input.subtasks.join('; ')}` : '');
      const [single, needsVerifier] = await Promise.all([
        this.askBool(LOCAL_SINGLE_QUESTION, query),
        input.skipVerifier ? Promise.resolve(false) : this.askBool(LOCAL_VERIFIER_QUESTION, query),
      ]);
      return { single, needsVerifier, ms: Date.now() - started };
    });
  }

  async complete(input: { prefix: string; suffix: string; maxTokens: number }): Promise<{ text: string; ms: number }> {
    this.syncDir();
    const started = Date.now();
    if (!input.prefix.trim()) return { text: '', ms: 0 };
    return this.inUse(async () => {
      await this.ensureStarted();
      const out = await this.llamaPost('/infill', {
        input_prefix: input.prefix,
        input_suffix: input.suffix,
        n_predict: input.maxTokens,
        temperature: 0,
        stop: ['\n'],
        n_probs: 1,
      });
      const tokens = Array.isArray(out?.completion_probabilities) ? out.completion_probabilities : null;
      const text = tokens ? confidentCompletion(tokens) : typeof out?.content === 'string' ? out.content : '';
      return { text: text.trim(), ms: Date.now() - started };
    });
  }

  /** Config reload / server close: abort an install (its cleanup removes partial files) and stop the server. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.job?.abort.abort();
    await this.stopServer();
  }

  /** Process exit / SIGINT / SIGHUP: only synchronous work runs here. */
  killSync() {
    this.disposed = true;
    this.generation++;
    this.job?.abort.abort();
    // Includes a server still being stopped: Vite exits right after closing, before an async stop completes.
    const children = [this.child, ...this.stopping];
    this.child = null;
    this.stopping.clear();
    this.serverState = 'stopped';
    for (const child of children) {
      if (!child) continue;
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {}
      }
      this.removePidFile(child.pid);
    }
  }
}

/** One manager per process: a config reload disposes the previous one (its server and any install in progress). */
function replaceLocalModelManager(): LocalModelManager {
  const g = globalThis as any;
  const key = Symbol.for('ergo.localModel.manager');
  const previous = g[key];
  if (previous && typeof previous.dispose === 'function') void previous.dispose();
  const manager = new LocalModelManager();
  g[key] = manager;
  return manager;
}

const cleanLine = (value: unknown, max: number): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');

export function ergoLocalModelPlugin(): Plugin {
  return {
    name: 'ergo-local-model',
    configureServer(server) {
      const manager = replaceLocalModelManager();
      registerBridgeExitHook('localModel', () => manager.killSync());
      // No eager start: the server comes up on the first request, so cloud-mode users never load the model.
      server.httpServer?.once('close', () => {
        void manager.dispose();
      });

      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const url = req.url?.split('?')[0];
        if (!url?.startsWith('/api/local-model/')) return next();
        if (!guardBridgeRequest(req, res)) return;
        const route = url.slice('/api/local-model/'.length);
        const postRoutes = ['install', 'cancel', 'uninstall', 'shape', 'complete'];
        if (route !== 'status' && !postRoutes.includes(route)) return next();
        const method = route === 'status' ? 'GET' : 'POST';
        if (req.method !== method) {
          res.setHeader('Allow', method);
          return sendJson(res, 405, { success: false, error: `Use ${method}.` });
        }

        try {
          if (route === 'status') return sendJson(res, 200, manager.status());
          if (route === 'install') {
            const started = manager.install();
            return sendJson(res, 200, { ...manager.status(), success: started.ok, ...(started.error ? { error: started.error } : {}) });
          }
          if (route === 'cancel') {
            await manager.cancel();
            return sendJson(res, 200, manager.status());
          }
          if (route === 'uninstall') {
            await manager.uninstall();
            return sendJson(res, 200, manager.status());
          }

          let body: any;
          try {
            body = await parseJsonBody(req);
          } catch {
            return sendJson(res, 400, { success: false, error: 'Invalid JSON body.' });
          }

          if (route === 'shape') {
            const title = cleanLine(body?.title, 500);
            if (!title) return sendJson(res, 400, { success: false, error: 'title is required.' });
            const subtasks = (Array.isArray(body?.subtasks) ? body.subtasks : [])
              .map((s: unknown) => cleanLine(s, 200))
              .filter(Boolean)
              .slice(0, 12);
            // The verifier question only applies to coding work: a known non-coding kind skips it.
            const kindHint = cleanLine(body?.kindHint, 40).toLowerCase();
            const skipVerifier = Boolean(kindHint) && kindHint !== 'coding' && kindHint !== 'code';
            try {
              const decision = await manager.shape({ title, subtasks, skipVerifier });
              return sendJson(res, 200, { success: true, single: decision.single, needsVerifier: decision.needsVerifier, source: 'local', ms: decision.ms });
            } catch (err) {
              return sendJson(res, 200, { success: false, error: errorText(err) });
            }
          }

          // route === 'complete'
          if (typeof body?.prefix !== 'string') return sendJson(res, 400, { success: false, error: 'prefix is required.' });
          const requested = Math.floor(Number(body?.maxTokens));
          const maxTokens = Number.isFinite(requested) && requested > 0 ? Math.min(48, requested) : 24;
          try {
            const completion = await manager.complete({
              prefix: body.prefix.slice(-4_000), // the text nearest the cursor matters most
              suffix: typeof body?.suffix === 'string' ? body.suffix.slice(0, 2_000) : '',
              maxTokens,
            });
            return sendJson(res, 200, { success: true, text: completion.text, source: 'local', ms: completion.ms });
          } catch (err) {
            return sendJson(res, 200, { success: false, error: errorText(err) });
          }
        } catch (err) {
          console.warn(`[Ergo Local Model] ${req.method} ${url} failed:`, err);
          return sendJson(res, 500, { success: false, error: errorText(err) });
        }
      });
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Model catalog — POST /api/models/catalog (Auto model selection; docs/wip/AUTO_MODEL_SPEC.md)
// Prices come from LiteLLM's public price list, benchmarks from Artificial Analysis when the caller sends its key.
// Both are cached under <storage>/.ergo/model-catalog/ and served stale-while-revalidate.
//
// sources.prices / sources.benchmarks:
//   'litellm' / 'artificial-analysis'             data younger than the freshness window (just fetched, or a fresh cache)
//   'litellm-cache' / 'artificial-analysis-cache' an older cache: a background refresh is running, or the last fetch failed
//   'snapshot'                                    no usable cache and the fetch failed (bundled priceSnapshot.ts)
//   'none'                                        no key, the key was rejected, or no benchmark data at all
//
// The Artificial Analysis key lives only in the request handling it: it is sent as the x-api-key header and never
// logged, written to disk or echoed in an error (errors are scrubbed of it). Only a SHA-256 fingerprint is kept in
// memory, to tell whether this key has been checked yet in this bridge process.
// ─────────────────────────────────────────────────────────────────────────────

const MODEL_PRICES_URL_DEFAULT = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const MODEL_BENCHMARKS_URL_DEFAULT = 'https://artificialanalysis.ai/api/v2/data/llms/models';
const CATALOG_PRICES_TTL_MS = 12 * 60 * 60_000;
const CATALOG_BENCHMARKS_TTL_MS = 24 * 60 * 60_000;
/** `refresh: true` bypasses the age check at most this often, and a failed fetch isn't retried sooner than this. */
const CATALOG_REFRESH_MIN_INTERVAL_MS = 5 * 60_000;
const CATALOG_FETCH_TIMEOUT_MS = 10_000;
const CATALOG_MAX_BODY_BYTES = 20 * 1024 * 1024;
/** A normalized price list smaller than this is treated as a broken download (the live list yields ~150). */
const CATALOG_MIN_PRICE_MODELS = 20;
const CATALOG_CACHE_VERSION = 1;

/** ERGO_MODEL_PRICES_URL / ERGO_MODEL_BENCHMARKS_URL override the sources (mirrors and tests). Read per fetch. */
const modelPricesUrl = () => process.env.ERGO_MODEL_PRICES_URL || MODEL_PRICES_URL_DEFAULT;
const modelBenchmarksUrl = () => process.env.ERGO_MODEL_BENCHMARKS_URL || MODEL_BENCHMARKS_URL_DEFAULT;

/** `<storage root>/model-catalog` when the root is a `.ergo` folder, else `<storage root>/.ergo/model-catalog` (as the memory store). */
function modelCatalogCacheDir(): string {
  const root = getActiveStorageDir();
  const base = path.basename(root) === '.ergo' ? root : path.join(root, '.ergo');
  return path.join(base, 'model-catalog');
}

interface PriceCache {
  fetchedAt: string;
  models: CatalogModel[];
  /** False when written by an older normalizer: served, but refreshed as if stale. */
  current: boolean;
}

interface BenchmarkCache {
  fetchedAt: string;
  rows: AaBenchmarkRow[];
  current: boolean;
}

type CatalogFetchErrorKind = 'http' | 'timeout' | 'network' | 'size' | 'parse';

class CatalogFetchError extends Error {
  kind: CatalogFetchErrorKind;
  status?: number;
  constructor(kind: CatalogFetchErrorKind, message: string, status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

/** GET a JSON document with a 10 s deadline (covering the body) and a 20 MB cap. Error messages never include headers. */
async function fetchCatalogJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const signal = AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS);
  const timedOut = () => new CatalogFetchError('timeout', `no response within ${CATALOG_FETCH_TIMEOUT_MS / 1000} s`);
  let res: Response;
  try {
    // No redirects: a redirect would carry the x-api-key header to wherever it points.
    res = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal, redirect: 'error' });
  } catch (err: any) {
    if (signal.aborted) throw timedOut();
    const cause = err?.cause?.code || err?.cause?.message || err?.message || 'network error';
    throw new CatalogFetchError('network', String(cause).slice(0, 200));
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new CatalogFetchError('http', `HTTP ${res.status}`, res.status);
  }
  const tooLarge = () => new CatalogFetchError('size', `response larger than ${CATALOG_MAX_BODY_BYTES / (1024 * 1024)} MB`);
  if (Number(res.headers.get('content-length')) > CATALOG_MAX_BODY_BYTES) {
    await res.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    const reader = res.body?.getReader();
    if (!reader) throw new CatalogFetchError('parse', 'empty response');
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > CATALOG_MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof CatalogFetchError) throw err;
    if (signal.aborted) throw timedOut();
    throw new CatalogFetchError('network', errorText(err).slice(0, 200));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch {
    throw new CatalogFetchError('parse', 'response is not valid JSON');
  }
}

async function writeCatalogCacheFile(file: string, data: unknown): Promise<void> {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = atomicTmpPath(file);
    try {
      await fs.writeFile(tmp, JSON.stringify(data), 'utf-8');
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  } catch (err) {
    console.warn(`[Ergo Model Catalog] Could not write ${path.basename(file)}: ${errorText(err)}`);
  }
}

async function readCatalogCacheFile(file: string): Promise<any | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.fetchedAt !== 'string' || !Number.isFinite(Date.parse(parsed.fetchedAt))) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Fresh = written by the current normalizer, and younger than `ttl` (a timestamp in the future counts as stale). */
function catalogCacheFresh(entry: { fetchedAt: string; current: boolean }, ttl: number): boolean {
  const age = Date.now() - Date.parse(entry.fetchedAt);
  return entry.current && age >= 0 && age < ttl;
}

const aaKeyFingerprint = (key: string) => createHash('sha256').update(key).digest('hex');

/** Replaces the key with "[key]" in a message before it can reach a log or a response (belt and braces). */
function scrubAaKey(message: string, key: string): string {
  return key ? message.split(key).join('[key]') : message;
}

function aaErrorMessage(err: unknown, key: string): string {
  if (err instanceof CatalogFetchError) {
    if (err.kind === 'http') {
      if (err.status === 401 || err.status === 403) return `Artificial Analysis rejected the key (${err.status})`;
      if (err.status === 429) return 'Artificial Analysis rate limit reached (429); try again later';
      return `Artificial Analysis returned an error (HTTP ${err.status})`;
    }
    if (err.kind === 'timeout') return `Artificial Analysis did not respond within ${CATALOG_FETCH_TIMEOUT_MS / 1000} s`;
    if (err.kind === 'network') return scrubAaKey(`Could not reach Artificial Analysis (${err.message})`, key);
    return scrubAaKey(`Artificial Analysis returned an unexpected response (${err.message})`, key);
  }
  return scrubAaKey(`Artificial Analysis request failed (${errorText(err)})`, key);
}

/**
 * Cache state for one storage root. Replaced when the root changes; fetches still running for the old root finish
 * into their own directory.
 */
class ModelCatalogService {
  readonly dir: string;
  private loaded: Promise<void> | null = null;
  private prices: PriceCache | null = null;
  private benchmarks: BenchmarkCache | null = null;

  private pricesInFlight: Promise<PriceCache> | null = null;
  private pricesForcedAt = 0;
  private pricesFailedAt = 0;

  /** In-flight AA fetches by key fingerprint (two different keys don't share a result). */
  private benchInFlight = new Map<string, Promise<BenchmarkCache>>();
  private benchForcedAt = 0;
  private benchFailedAt = 0;
  private benchLastError: string | null = null;
  /** Fingerprint of the last key AA accepted in this process (null until the first successful fetch). */
  private goodKeyFp: string | null = null;
  /** Fingerprint and message of the last key AA rejected (401 / 403). */
  private rejectedKey: { fp: string; error: string } | null = null;

  constructor(dir: string) {
    this.dir = dir;
  }

  private get pricesFile() {
    return path.join(this.dir, 'prices.json');
  }

  private get benchmarksFile() {
    return path.join(this.dir, 'benchmarks.json');
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      const [p, b] = await Promise.all([readCatalogCacheFile(this.pricesFile), readCatalogCacheFile(this.benchmarksFile)]);
      if (p && Array.isArray(p.models)) {
        const models = p.models.map(sanitizeCatalogModel).filter((m: CatalogModel | null): m is CatalogModel => m !== null);
        if (models.length) {
          this.prices = { fetchedAt: p.fetchedAt, models, current: p.version === CATALOG_CACHE_VERSION && p.normalizer === CATALOG_NORMALIZER_VERSION };
          if (models.length > 20) bridgePriceModels = models;
        }
      }
      if (b && Array.isArray(b.rows)) {
        const rows = b.rows.map(sanitizeAaRow).filter((r: AaBenchmarkRow | null): r is AaBenchmarkRow => r !== null);
        if (rows.length) {
          this.benchmarks = { fetchedAt: b.fetchedAt, rows, current: b.version === CATALOG_CACHE_VERSION && b.normalizer === CATALOG_NORMALIZER_VERSION };
        }
      }
    })();
    return this.loaded;
  }

  private fetchPrices(): Promise<PriceCache> {
    this.pricesInFlight ??= (async () => {
      try {
        const models = normalizeLiteLlmPrices(await fetchCatalogJson(modelPricesUrl()));
        if (models.length < CATALOG_MIN_PRICE_MODELS) {
          throw new CatalogFetchError('parse', `only ${models.length} usable models in the price list`);
        }
        const entry: PriceCache = { fetchedAt: new Date().toISOString(), models, current: true };
        this.prices = entry;
        if (entry.models.length > 20) bridgePriceModels = entry.models;
        this.pricesFailedAt = 0;
        await writeCatalogCacheFile(this.pricesFile, { version: CATALOG_CACHE_VERSION, normalizer: CATALOG_NORMALIZER_VERSION, fetchedAt: entry.fetchedAt, models });
        return entry;
      } catch (err) {
        this.pricesFailedAt = Date.now();
        console.warn(`[Ergo Model Catalog] Fetching LiteLLM prices failed: ${errorText(err)}`);
        throw err;
      } finally {
        this.pricesInFlight = null;
      }
    })();
    return this.pricesInFlight;
  }

  private fetchBenchmarks(key: string, fp: string): Promise<BenchmarkCache> {
    let pending = this.benchInFlight.get(fp);
    if (!pending) {
      pending = (async () => {
        try {
          const rows = parseArtificialAnalysisRows(await fetchCatalogJson(modelBenchmarksUrl(), { 'x-api-key': key }));
          if (!rows.length) throw new CatalogFetchError('parse', 'no scored models in the response');
          const entry: BenchmarkCache = { fetchedAt: new Date().toISOString(), rows, current: true };
          this.benchmarks = entry;
          this.benchFailedAt = 0;
          this.benchLastError = null;
          this.goodKeyFp = fp;
          if (this.rejectedKey?.fp === fp) this.rejectedKey = null;
          // The rows only: the key is never written.
          await writeCatalogCacheFile(this.benchmarksFile, { version: CATALOG_CACHE_VERSION, normalizer: CATALOG_NORMALIZER_VERSION, fetchedAt: entry.fetchedAt, rows });
          return entry;
        } catch (err) {
          const message = aaErrorMessage(err, key);
          if (err instanceof CatalogFetchError && err.kind === 'http' && (err.status === 401 || err.status === 403)) {
            this.rejectedKey = { fp, error: message };
            if (this.goodKeyFp === fp) this.goodKeyFp = null;
          } else {
            this.benchFailedAt = Date.now();
            this.benchLastError = message;
          }
          console.warn(`[Ergo Model Catalog] Fetching Artificial Analysis benchmarks failed: ${message}`);
          throw new CatalogFetchError(err instanceof CatalogFetchError ? err.kind : 'network', message);
        } finally {
          this.benchInFlight.delete(fp);
        }
      })();
      this.benchInFlight.set(fp, pending);
    }
    return pending;
  }

  /** Prices: fresh cache → as is; stale cache → served while a background refresh runs; no cache → fetch, else snapshot. */
  async getPrices(refresh: boolean): Promise<{ fetchedAt: string; models: CatalogModel[]; source: PriceSource }> {
    await this.load();
    const now = Date.now();
    const backedOff = now - this.pricesFailedAt < CATALOG_REFRESH_MIN_INTERVAL_MS;
    const snapshot = () => ({ fetchedAt: PRICE_SNAPSHOT.fetchedAt, models: PRICE_SNAPSHOT.models, source: 'snapshot' as const });

    if (refresh && now - this.pricesForcedAt >= CATALOG_REFRESH_MIN_INTERVAL_MS) {
      this.pricesForcedAt = now;
      try {
        const entry = await this.fetchPrices();
        return { fetchedAt: entry.fetchedAt, models: entry.models, source: 'litellm' };
      } catch {
        return this.prices ? { fetchedAt: this.prices.fetchedAt, models: this.prices.models, source: 'litellm-cache' } : snapshot();
      }
    }

    const cache = this.prices;
    if (cache && catalogCacheFresh(cache, CATALOG_PRICES_TTL_MS)) {
      return { fetchedAt: cache.fetchedAt, models: cache.models, source: 'litellm' };
    }
    if (cache) {
      if (!backedOff) this.fetchPrices().catch(() => {});
      return { fetchedAt: cache.fetchedAt, models: cache.models, source: 'litellm-cache' };
    }
    if (backedOff && !this.pricesInFlight) return snapshot();
    try {
      const entry = await this.fetchPrices();
      return { fetchedAt: entry.fetchedAt, models: entry.models, source: 'litellm' };
    } catch {
      return snapshot();
    }
  }

  /**
   * Benchmarks for `key`. A key AA rejected gets 'none' + the error until it's retried with `refresh`. A key not yet
   * checked in this process is fetched on `refresh` regardless of the rate limit (so "Check" verifies a new key), and
   * on any request once another key has been accepted (so changing keys is noticed). Otherwise as prices.
   */
  async getBenchmarks(key: string, refresh: boolean): Promise<{ rows: AaBenchmarkRow[]; source: BenchmarkSource; error?: string }> {
    await this.load();
    const fp = aaKeyFingerprint(key);
    const now = Date.now();
    const backedOff = now - this.benchFailedAt < CATALOG_REFRESH_MIN_INTERVAL_MS;
    const unchecked = fp !== this.goodKeyFp;
    const forced =
      (refresh && (unchecked || now - this.benchForcedAt >= CATALOG_REFRESH_MIN_INTERVAL_MS)) ||
      (unchecked && this.goodKeyFp !== null && !backedOff);

    const fromCache = (error?: string) => {
      const cache = this.benchmarks;
      if (!cache) return { rows: [], source: 'none' as const, error: error ?? this.benchLastError ?? undefined };
      const fresh = catalogCacheFresh(cache, CATALOG_BENCHMARKS_TTL_MS);
      // Report the last failure only when it's newer than the cached data.
      const failedSince = this.benchFailedAt > Date.parse(cache.fetchedAt) ? this.benchLastError ?? undefined : undefined;
      const err = error ?? failedSince;
      return { rows: cache.rows, source: fresh ? ('artificial-analysis' as const) : ('artificial-analysis-cache' as const), ...(err ? { error: err } : {}) };
    };

    if (this.rejectedKey?.fp === fp && !(refresh && now - this.benchForcedAt >= CATALOG_REFRESH_MIN_INTERVAL_MS)) {
      return { rows: [], source: 'none', error: this.rejectedKey.error };
    }

    if (forced) {
      if (refresh) this.benchForcedAt = now;
      try {
        const entry = await this.fetchBenchmarks(key, fp);
        return { rows: entry.rows, source: 'artificial-analysis' };
      } catch (err) {
        if (this.rejectedKey?.fp === fp) return { rows: [], source: 'none', error: this.rejectedKey.error };
        return fromCache(errorText(err));
      }
    }

    const cache = this.benchmarks;
    if (cache && catalogCacheFresh(cache, CATALOG_BENCHMARKS_TTL_MS)) return fromCache();
    if (cache) {
      if (!backedOff) this.fetchBenchmarks(key, fp).catch(() => {});
      return fromCache();
    }
    if (backedOff && !this.benchInFlight.has(fp)) return fromCache();
    try {
      const entry = await this.fetchBenchmarks(key, fp);
      return { rows: entry.rows, source: 'artificial-analysis' };
    } catch (err) {
      if (this.rejectedKey?.fp === fp) return { rows: [], source: 'none', error: this.rejectedKey.error };
      return fromCache(errorText(err));
    }
  }
}

let modelCatalogService: ModelCatalogService | null = null;

/** The service for the current storage root (follows storage-root changes). */
function getModelCatalogService(): ModelCatalogService {
  const dir = modelCatalogCacheDir();
  if (!modelCatalogService || modelCatalogService.dir !== dir) modelCatalogService = new ModelCatalogService(dir);
  return modelCatalogService;
}

/** Printable ASCII without spaces: anything else can't be a valid key and would make fetch() reject the header. */
const AA_KEY_RE = /^[\x21-\x7e]{8,512}$/;

async function buildModelCatalog(request: ModelCatalogRequest): Promise<ModelCatalog> {
  const service = getModelCatalogService();
  const key = typeof request.artificialAnalysisKey === 'string' ? request.artificialAnalysisKey.trim() : '';
  const refresh = request.refresh === true;

  const [prices, bench] = await Promise.all([
    service.getPrices(refresh),
    key
      ? AA_KEY_RE.test(key)
        ? service.getBenchmarks(key, refresh)
        : Promise.resolve({ rows: [] as AaBenchmarkRow[], source: 'none' as const, error: 'The Artificial Analysis key is malformed (expected a single token of printable characters).' })
      : Promise.resolve(null),
  ]);

  let models = prices.models;
  let benchmarks: BenchmarkSource = 'none';
  let benchmarksError = bench?.error;
  if (bench && bench.source !== 'none') {
    const result = attachBenchmarks(prices.models, bench.rows);
    models = result.models;
    benchmarks = bench.source;
    if (!result.matched) benchmarksError ??= 'No Artificial Analysis model matched the price list.';
  }
  if (benchmarksError) benchmarksError = scrubAaKey(benchmarksError, key);
  return {
    fetchedAt: prices.fetchedAt,
    sources: { prices: prices.source, benchmarks, ...(benchmarksError ? { benchmarksError } : {}) },
    models,
  };
}

export function ergoModelCatalogPlugin(): Plugin {
  return {
    name: 'ergo-model-catalog',
    configureServer(server) {
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const url = req.url?.split('?')[0];
        if (url !== '/api/models/catalog') return next();
        if (!guardBridgeRequest(req, res)) return;
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST');
          return sendJson(res, 405, { success: false, error: 'Use POST.' } satisfies ModelCatalogResponse);
        }
        let body: any;
        try {
          body = await parseJsonBody(req);
        } catch {
          return sendJson(res, 400, { success: false, error: 'Invalid JSON body.' } satisfies ModelCatalogResponse);
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return sendJson(res, 400, { success: false, error: 'Expected a JSON object.' } satisfies ModelCatalogResponse);
        }
        const key = typeof body.artificialAnalysisKey === 'string' ? body.artificialAnalysisKey.trim() : '';
        try {
          const catalog = await buildModelCatalog({ artificialAnalysisKey: key || undefined, refresh: body.refresh === true });
          return sendJson(res, 200, { success: true, ...catalog } satisfies ModelCatalogResponse);
        } catch (err) {
          const message = scrubAaKey(errorText(err), key);
          console.warn(`[Ergo Model Catalog] ${message}`);
          return sendJson(res, 500, { success: false, error: message } satisfies ModelCatalogResponse);
        }
      });
    },
  };
}
