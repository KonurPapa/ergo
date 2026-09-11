import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';


let activeStoragePath = '~/.ergo';

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

    // Skills (Ensure all 6 skills exist in local filesystem: ~/.ergo and .ergo)
    const skillNames = [
      'human-assistant',
      'assistant-context-analyzer',
      'assistant-todo-builder',
      'assistant-context-syncer',
      'discovery-agent',
      'summary-agent',
      'manager-agent',
      'worker-agent',
      'cleaner-agent',
      'hardener-agent'
    ];

    for (const skillName of skillNames) {
      const docPath = path.join(process.cwd(), 'docs', 'skills', skillName, 'SKILL.md');
      let skillContent = '';
      try {
        skillContent = await fs.readFile(docPath, 'utf-8');
      } catch {}

      if (skillContent) {
        const localSkillTargets = [
          path.join(storageDir, 'config', 'skills', skillName, 'SKILL.md'),
          path.join(process.cwd(), '.ergo', 'config', 'skills', skillName, 'SKILL.md')
        ];

        for (const target of localSkillTargets) {
          try {
            await fs.access(target);
          } catch {
            // File missing: seed it to the local filesystem from codebase docs
            try {
              await fs.mkdir(path.dirname(target), { recursive: true });
              await fs.writeFile(target, skillContent, 'utf-8');
            } catch (seedErr) {
              console.warn(`[Ergo Storage] Failed to seed skill ${skillName} at ${target}:`, seedErr);
            }
          }
        }
      }
    }

    // Projects
    const projectsDir = path.join(storageDir, 'projects');
    await fs.mkdir(projectsDir, { recursive: true });
    const defaultWorkspaceDir = path.join(projectsDir, 'default-workspace');
    await fs.mkdir(defaultWorkspaceDir, { recursive: true });

    const todoFile = path.join(defaultWorkspaceDir, 'TODO.md');
    try {
      await fs.access(todoFile);
    } catch {
      const defaultTodo = `# General TODOs:\n\n1. **Initial Task Setup:**\n   - Define project scope and task list\n   - Verify bi-directional link with AGENT_CONTEXT.md\n`;
      await fs.writeFile(todoFile, defaultTodo, 'utf-8');
    }

    const agentFile = path.join(defaultWorkspaceDir, 'AGENT_CONTEXT.md');
    try {
      await fs.access(agentFile);
    } catch {
      const defaultAgent = `# TODO context — the verbose half of \`TODO.md\`\n\n\`TODO.md\` is the **human** view: the ask in Konur's words, scannable in seconds, with at most a one-line \`DONE:\` per finished item. This file is the **agent** view: the full brief for an item before it's built, and the full record of what was built after.\n\n### 1. Initial Task Setup\n\n**Status:** not_started\n\n**Brief**\n\nInitial task setup and shared context synchronization.\n\n---`;
      await fs.writeFile(agentFile, defaultAgent, 'utf-8');
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

/**
 * Loads the allowed directory roots (storage dir + user-approved folders from config/roots.json),
 * resolved to absolute paths. Every filesystem / git / shell tool call is checked against this list.
 */
async function loadAllowedRoots(storageDir: string): Promise<string[]> {
  const roots = [path.resolve(storageDir)];
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
async function resolveInsideAllowedRoots(rawPath: string, storageDir: string): Promise<BoundaryCheck> {
  let targetPath = (rawPath || '').trim();
  if (targetPath.startsWith('~')) targetPath = path.join(os.homedir(), targetPath.slice(1));
  const fullPath = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(storageDir, targetPath || '.');
  const allowedRoots = await loadAllowedRoots(storageDir);
  const isAllowed = allowedRoots.some((root) => fullPath === root || fullPath.startsWith(root + path.sep));
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
    exec(command, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: process.env }, (error: any, stdout: any, stderr: any) => {
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
}): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean; durationMs: number }> {
  const { spawn } = await import('node:child_process');
  const started = Date.now();
  const timeoutMs = options.timeoutMs || 180_000;

  const rawCli = (options.cli || 'claude').trim();
  const cliBase = path.basename(rawCli).toLowerCase();
  let args: string[] = Array.isArray(options.customArgs) && options.customArgs.length > 0 ? [...options.customArgs] : [];

  const combinedPrompt = options.systemPrompt
    ? `${options.systemPrompt.trim()}\n\nTask:\n${options.prompt.trim()}`
    : options.prompt.trim();

  if (cliBase.includes('claude')) {
    if (!args.includes('-p') && !args.includes('--print')) {
      args.unshift('-p');
    }
    if (!args.includes('--dangerously-skip-permissions')) {
      args.push('--dangerously-skip-permissions');
    }
    // For Claude Code CLI, pass the prompt directly as argument when under 8000 chars for reliable single-command dispatch
    if (combinedPrompt.length < 8000 && !args.includes(combinedPrompt)) {
      args.push(combinedPrompt);
    }
  } else if (cliBase.includes('aider')) {
    if (!args.includes('--message') && !args.includes('-m')) {
      args.push('--message', combinedPrompt);
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
    if (combinedPrompt.length < 8000) {
      args.push(combinedPrompt);
    }
  } else if (cliBase.includes('agy')) {
    if (!args.includes('-p') && !args.includes('--print') && !args.includes('run')) {
      args.unshift('-p');
    }
    if (combinedPrompt.length < 8000) {
      args.push(combinedPrompt);
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
      proc = spawn(rawCli, args, {
        cwd: options.cwd,
        env: {
          ...process.env,
          CI: '1',
          NON_INTERACTIVE: '1',
          FORCE_COLOR: '0'
        },
        stdio: ['pipe', 'pipe', 'pipe']
      });

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
        resolve({
          exitCode: code ?? (timedOut ? 124 : 0),
          stdout,
          stderr: stderr + (timedOut ? `\n[CLI process timed out after ${timeoutMs}ms]` : ''),
          timedOut,
          durationMs: Date.now() - started
        });
      });

      // Write prompt to stdin as well for CLIs reading piped input
      try {
        if (proc.stdin && !proc.stdin.destroyed) {
          proc.stdin.write(combinedPrompt);
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

function sendJson(res: ServerResponse, statusCode: number, data: any) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

// Set of active SSE clients listening for file changes
const sseClients = new Set<ServerResponse>();
// Recent server-side writes with timestamp to suppress self-notifications in the originating client
const recentWrites = new Map<string, number>();

function broadcastFileChange(payload: {
  filePath: string;
  relativePath: string;
  projectId: string;
  fileType: 'todo' | 'agent' | 'other';
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
          const fileType: 'todo' | 'agent' | 'other' =
            baseName === 'TODO.md' ? 'todo' : baseName === 'AGENT_CONTEXT.md' ? 'agent' : 'other';

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

function ergoFileSystemPlugin(): Plugin {
  const attachMiddleware = (server: { middlewares: { use: Function } }) => {
    const storageDir = getActiveStorageDir();
    // Initialize default ~/.ergo directory on startup
    ensureStorageInitialized(storageDir);
    setupProjectWatcher(storageDir);

    server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: Function) => {
      const url = req.url?.split('?')[0];
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
          homeDir: os.homedir()
        });
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
            if (!item.filePath || typeof item.content !== 'string') continue;
            const fullPath = path.resolve(storageDir, item.filePath);
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

      if (url === '/api/files/read' && req.method === 'POST') {
        try {
          const body = await parseJsonBody(req);
          const filePaths: string[] = body.filePaths || [];
          const results: Record<string, string | null> = {};

          for (const fp of filePaths) {
            const fullPath = path.resolve(storageDir, fp);
            try {
              const content = await fs.readFile(fullPath, 'utf-8');
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
            const fullPath = path.resolve(storageDir, fp);
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

          const oldFullPath = path.resolve(storageDir, oldPath);
          const newFullPath = path.resolve(storageDir, newPath);
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
          const { folderPath, todoContent, agentContextContent } = body;

          if (!folderPath) {
            return sendJson(res, 400, { error: 'folderPath is required' });
          }

          const targetDir = path.resolve(storageDir, folderPath);
          await fs.mkdir(targetDir, { recursive: true });
          const todoPath = path.join(targetDir, 'TODO.md');
          const agentPath = path.join(targetDir, 'AGENT_CONTEXT.md');

          await fs.writeFile(todoPath, todoContent || '', 'utf-8');
          await fs.writeFile(agentPath, agentContextContent || '', 'utf-8');

          return sendJson(res, 200, {
            success: true,
            folderPath,
            todoPath: path.relative(storageDir, todoPath),
            agentPath: path.relative(storageDir, agentPath),
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
          const configType = body.type; // 'settings' | 'secrets'
          if (!configType || (configType !== 'settings' && configType !== 'secrets')) {
            return sendJson(res, 400, { error: 'type must be either "settings" or "secrets"' });
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
          if (!configType || (configType !== 'settings' && configType !== 'secrets')) {
            return sendJson(res, 400, { error: 'type must be either "settings" or "secrets"' });
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
          const skillName = body.skillName || 'human-assistant';

          // 1. Check user local workspace .ergo first, then storageDir ~/.ergo
          const localFilesystemPaths = [
            path.join(process.cwd(), '.ergo', 'config', 'skills', skillName, 'SKILL.md'),
            path.join(storageDir, 'config', 'skills', skillName, 'SKILL.md'),
          ];

          let content: string | null = null;
          let matchedPath: string | null = null;

          for (const fp of localFilesystemPaths) {
            try {
              content = await fs.readFile(fp, 'utf-8');
              matchedPath = fp;
              break;
            } catch {}
          }

          // 2. If missing on local filesystem, load default from codebase docs/skills/ and auto-seed to local filesystem
          if (!content) {
            const codebaseDocPath = path.join(process.cwd(), 'docs', 'skills', skillName, 'SKILL.md');
            try {
              content = await fs.readFile(codebaseDocPath, 'utf-8');
            } catch {}

            if (content) {
              for (const target of localFilesystemPaths) {
                try {
                  await fs.mkdir(path.dirname(target), { recursive: true });
                  await fs.writeFile(target, content, 'utf-8');
                } catch (wErr) {
                  console.warn(`[Ergo FS API] Could not auto-seed skill to ${target}:`, wErr);
                }
              }
              matchedPath = localFilesystemPaths[0];
            }
          }

          return sendJson(res, 200, {
            success: true,
            skillName,
            content,
            filePath: matchedPath
          });
        } catch (err: any) {
          console.error('[Ergo FS API] Skills read error:', err);
          return sendJson(res, 500, { error: err.message });
        }
      }

      if (url === '/api/skills/write' && req.method === 'POST') {
        try {
          const body = await parseJsonBody(req);
          const { skillName, content, projectFolder } = body;

          if (!skillName || typeof content !== 'string') {
            return sendJson(res, 400, { error: 'skillName and content are required' });
          }

          let skillsDir = path.resolve(storageDir, 'skills');
          if (projectFolder) {
            skillsDir = path.resolve(storageDir, projectFolder, 'skills');
          }

          const targetSkillDir = path.join(skillsDir, skillName);
          await fs.mkdir(targetSkillDir, { recursive: true });
          const targetSkillMd = path.join(targetSkillDir, 'SKILL.md');

          await fs.writeFile(targetSkillMd, content, 'utf-8');

          // Also save directly to user's local .ergo and storage config folders
          const configSkillTargets = [
            path.join(process.cwd(), '.ergo', 'config', 'skills', skillName, 'SKILL.md'),
            path.join(storageDir, 'config', 'skills', skillName, 'SKILL.md')
          ];
          for (const target of configSkillTargets) {
            try {
              await fs.mkdir(path.dirname(target), { recursive: true });
              await fs.writeFile(target, content, 'utf-8');
            } catch {}
          }

          return sendJson(res, 200, {
            success: true,
            skillName,
            savedAt: new Date().toISOString()
          });
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
            agentContextFilePath: string;
            todoMarkdown: string;
            agentContextMarkdown: string;
            swimLanes?: Array<{ id: string; title: string; filePath: string; markdown: string }>;
          }> = [];

          for (const entry of entries) {
            if (entry.isDirectory()) {
              const projectDir = path.join(projectsDir, entry.name);
              const projectFiles = await fs.readdir(projectDir, { withFileTypes: true });

              let todoContent = '';
              let agentContent = '';
              const swimLanes: Array<{ id: string; title: string; filePath: string; markdown: string }> = [];

              for (const pf of projectFiles) {
                if (pf.isFile() && pf.name.endsWith('.md')) {
                  const fp = path.join(projectDir, pf.name);
                  const relPath = `projects/${entry.name}/${pf.name}`;
                  try {
                    const content = await fs.readFile(fp, 'utf-8');
                    if (pf.name === 'AGENT_CONTEXT.md') {
                      agentContent = content;
                    } else {
                      if (pf.name === 'TODO.md') {
                        todoContent = content;
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
                    }
                  } catch {}
                }
              }

              // If TODO.md or AGENT_CONTEXT.md didn't exist, create defaults
              if (!todoContent) {
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

              if (!agentContent) {
                const agentPath = path.join(projectDir, 'AGENT_CONTEXT.md');
                agentContent = `# ${entry.name} Context\n\n### 1. Initial Task Setup\n\n**Status:** not started\n\n**Brief**\nInitial brief.`;
                await fs.writeFile(agentPath, agentContent, 'utf-8');
              }

              projectList.push({
                id: entry.name,
                name: entry.name.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
                folderPath: `projects/${entry.name}`,
                todoFilePath: `projects/${entry.name}/TODO.md`,
                agentContextFilePath: `projects/${entry.name}/AGENT_CONTEXT.md`,
                todoMarkdown: todoContent,
                agentContextMarkdown: agentContent,
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

      if (url === '/api/mcp/roots' && req.method === 'GET') {
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
          return sendJson(res, 200, { success: true, roots });
        } catch (err: any) {
          return sendJson(res, 500, { error: err.message });
        }
      }

      // ─────────────────────────────────────────────────────────────
      // File Open in IDE / System Opener Endpoint
      // ─────────────────────────────────────────────────────────────

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

          const { exec } = await import('child_process');
          const targetWithLine = line ? `${target}:${line}${column ? `:${column}` : ''}` : target;
          let opened = false;
          let methodUsed = '';

          const isCodeFile = /\.(ts|tsx|js|jsx|json|py|rs|go|c|cpp|h|css|html|md|toml|yaml|yml|sh|sql)$/i.test(target);
          const ideCommands = ['code', 'cursor', 'webstorm', 'subl', 'gedit', 'kate', 'notepad'];

          if (openInIde || isCodeFile) {
            for (const cmd of ideCommands) {
              try {
                exec(`${cmd} "${targetWithLine}"`, () => {});
                opened = true;
                methodUsed = cmd;
                break;
              } catch {}
            }
          }

          if (!opened) {
            const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
            try {
              exec(`${opener} "${target}"`, () => {});
              opened = true;
              methodUsed = opener;
            } catch (openErr: any) {
              console.warn('[Ergo File Open] Could not launch system opener:', openErr);
            }
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

      if (url === '/api/mcp/tools/call' && req.method === 'POST') {
        try {
          const body = await parseJsonBody(req);
          const { serverId, toolName, args } = body;

          if (!toolName) {
            return sendJson(res, 400, { error: 'toolName is required' });
          }

          // 1. Filesystem + Shell MCP Harness (root-sandboxed)
          const FS_TOOLS = new Set(['read_file', 'write_file', 'edit_file', 'list_directory', 'create_directory', 'search_files', 'get_file_info', 'run_command']);
          if (serverId === 'mcp-filesystem' || FS_TOOLS.has(toolName)) {
            // ── run_command: shell inside an allowed root ──
            if (toolName === 'run_command') {
              const command = typeof args.command === 'string' ? args.command.trim() : '';
              if (!command) return sendJson(res, 400, { error: 'run_command requires a non-empty "command" string.' });
              const cwdCheck = await resolveInsideAllowedRoots(typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd : storageDir, storageDir);
              if (!cwdCheck.ok) return sendJson(res, 403, { error: cwdCheck.error });
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
            const check = await resolveInsideAllowedRoots(targetPath, storageDir);
            if (!check.ok) return sendJson(res, 403, { error: check.error });
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
              await fs.mkdir(path.dirname(fullPath), { recursive: true });
              await fs.writeFile(fullPath, content, 'utf-8');
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
              await fs.writeFile(fullPath, updated, 'utf-8');
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
            const cwdCheck = await resolveInsideAllowedRoots(typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd : storageDir, storageDir);
            if (!cwdCheck.ok) return sendJson(res, 403, { error: cwdCheck.error });

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

          // Default custom tool execution simulated response
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
              installCommand: 'npm install -g @anthropic-ai/claude-code',
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
              docsUrl: 'https://github.com/openai/codex',
              badgeColor: '#7c3aed',
              supportsHeadless: true,
              supportsInteractive: true
            },
            {
              id: 'gemini',
              name: 'Google Gemini CLI',
              command: 'gemini',
              provider: 'gemini',
              subscriptionTier: 'Google One AI / Gemini Advanced',
              installCommand: 'npm install -g @google/gemini-cli',
              docsUrl: 'https://geminicli.com',
              badgeColor: '#2563eb',
              supportsHeadless: true,
              supportsInteractive: true
            },
            {
              id: 'antigravity',
              name: 'Antigravity (agy)',
              command: 'agy',
              provider: 'gemini',
              subscriptionTier: 'Google Antigravity Subscription',
              installCommand: 'Available via Antigravity IDE',
              docsUrl: 'https://antigravity.dev',
              badgeColor: '#2563eb',
              supportsHeadless: true,
              supportsInteractive: true
            },
            {
              id: 'aider',
              name: 'Aider',
              command: 'aider',
              provider: 'openai',
              subscriptionTier: 'BYOK / Subscription Proxy',
              installCommand: 'pip install aider-chat',
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
            const whichRes = await runShellCommand(`which ${preset.command}`, storageDir, 3000);
            const isInstalled = whichRes.exitCode === 0 && Boolean(whichRes.stdout.trim());
            const detectedPath = isInstalled ? whichRes.stdout.trim() : null;
            let version: string | null = null;
            if (isInstalled) {
              const verRes = await runShellCommand(`${preset.command} --version`, storageDir, 3000);
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
          if (customCmd) {
            const whichRes = await runShellCommand(`which ${customCmd}`, storageDir, 3000);
            const isInstalled = whichRes.exitCode === 0 && Boolean(whichRes.stdout.trim());
            const detectedPath = isInstalled ? whichRes.stdout.trim() : null;
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
          const { cli = 'claude', prompt, systemPrompt, cwd, args, timeoutMs } = body;

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
            timeoutMs: typeof timeoutMs === 'number' ? timeoutMs : 180_000
          });

          return sendJson(res, 200, {
            success: result.exitCode === 0,
            output: result.stdout.trim(),
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

      if (url === '/api/cli/auth-status' && req.method === 'GET') {
        try {
          const fullUrl = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
          let cli = fullUrl.searchParams.get('cli')?.trim() || 'claude';
          if (cli === 'antigravity') cli = 'gemini';

          // 1. Check if CLI binary is in PATH (with fallback for gemini <-> agy)
          let resolvedCmd = cli;
          let whichRes = await runShellCommand(`which ${cli}`, storageDir, 3000);
          if (whichRes.exitCode !== 0 && cli === 'gemini') {
            const agyRes = await runShellCommand('which agy', storageDir, 3000);
            if (agyRes.exitCode === 0) {
              resolvedCmd = 'agy';
              whichRes = agyRes;
            }
          }

          const isInstalled = whichRes.exitCode === 0 && Boolean(whichRes.stdout.trim());
          if (!isInstalled) {
            const humanName = cli === 'gemini' ? 'Google Gemini CLI (gemini)' : cli === 'claude' ? 'Claude Code (claude)' : cli;
            return sendJson(res, 200, {
              cli,
              isInstalled: false,
              isAuthenticated: false,
              message: `${humanName} is not installed in system PATH.`
            });
          }

          // 2. Check auth status for claude, gemini, codex
          let isAuthenticated = false;
          let userEmail: string | null = null;
          let message = 'Not authenticated';

          if (cli === 'claude' || cli.includes('claude')) {
            const claudeConfigPath = path.join(os.homedir(), '.claude.json');
            try {
              const configText = await fs.readFile(claudeConfigPath, 'utf-8');
              const parsed = JSON.parse(configText);
              if (parsed?.oauthAccount || parsed?.sessionKey || parsed?.userID || parsed?.primaryApiKey) {
                isAuthenticated = true;
                userEmail = parsed?.oauthAccount?.email || parsed?.email || null;
                message = userEmail ? `Authenticated as ${userEmail}` : 'Authenticated with Claude Pro/Team';
              }
            } catch {}

            if (!isAuthenticated) {
              const pingRes = await runShellCommand('claude -p "ping" --dangerously-skip-permissions', storageDir, 8000);
              const combined = (pingRes.stdout + ' ' + pingRes.stderr).toLowerCase();
              if (pingRes.exitCode === 0 && !combined.includes('login') && !combined.includes('unauthorized') && !combined.includes('authenticate')) {
                isAuthenticated = true;
                message = 'Authenticated with Claude';
              } else if (combined.includes('login') || combined.includes('auth')) {
                isAuthenticated = false;
                message = 'Login required via "claude login"';
              }
            }
          } else if (cli === 'gemini' || cli.includes('gemini') || resolvedCmd === 'agy') {
            const geminiConfigDir = path.join(os.homedir(), '.gemini');
            const userConfigDir = path.join(os.homedir(), '.config', 'gemini');
            const hasGeminiDir = fsSync.existsSync(geminiConfigDir) || fsSync.existsSync(userConfigDir);
            if (hasGeminiDir) {
              isAuthenticated = true;
              message = `${resolvedCmd} is installed and configured.`;
            } else {
              const pingRes = await runShellCommand(`${resolvedCmd} --version`, storageDir, 5000);
              if (pingRes.exitCode === 0) {
                isAuthenticated = true;
                message = `${resolvedCmd} ready (${pingRes.stdout.trim().split('\n')[0]})`;
              } else {
                isAuthenticated = false;
                message = `Login required for ${resolvedCmd}`;
              }
            }
          } else if (cli === 'codex') {
            const codexConfig = path.join(os.homedir(), '.codex');
            if (fsSync.existsSync(codexConfig)) {
              isAuthenticated = true;
              message = 'Codex authenticated';
            } else {
              const pingRes = await runShellCommand('codex --version', storageDir, 5000);
              if (pingRes.exitCode === 0) {
                isAuthenticated = true;
                message = 'Codex installed and ready';
              } else {
                isAuthenticated = false;
                message = 'Login required via "codex login"';
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
          if (cli === 'antigravity') cli = 'gemini';

          let installCmd = 'npm install -g @anthropic-ai/claude-code';
          if (cli === 'codex') {
            installCmd = 'npm install -g @openai/codex';
          } else if (cli === 'gemini' || cli === 'google') {
            installCmd = 'npm install -g @google/gemini-cli';
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
          if (cli === 'antigravity') cli = 'gemini';

          let resolvedCmd = cli;
          let whichRes = await runShellCommand(`which ${cli}`, storageDir, 3000);
          if (whichRes.exitCode !== 0 && cli === 'gemini') {
            const agyRes = await runShellCommand('which agy', storageDir, 3000);
            if (agyRes.exitCode === 0) {
              resolvedCmd = 'agy';
              whichRes = agyRes;
            }
          }

          if (whichRes.exitCode !== 0) {
            const toolName = cli === 'gemini' ? 'Google Gemini CLI (@google/gemini-cli)' : cli === 'claude' ? 'Claude Code (@anthropic-ai/claude-code)' : cli;
            return sendJson(res, 200, {
              success: false,
              authUrl: null,
              output: '',
              error: `${toolName} is not installed on your system. Please click 'Install & Sign In (1-Click)' above, or connect directly with a Google AI Studio key below.`
            });
          }

          const { spawn } = await import('node:child_process');

          let loginArgs = ['login'];
          if (resolvedCmd === 'gemini') {
            loginArgs = ['--login'];
          }

          let spawnError: Error | null = null;
          let proc: any;
          try {
            proc = spawn(resolvedCmd, loginArgs, {
              cwd: storageDir,
              env: { ...process.env },
              stdio: ['pipe', 'pipe', 'pipe']
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

          const urlRegex = /(https:\/\/(?:auth\.anthropic\.com|claude\.ai|openai\.com|accounts\.google\.com|google\.com\/device|oauth2\.googleapis\.com)[^\s"'<>]+)/i;

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

          // Wait up to 3.5 seconds to see if an OAuth URL or prompt is generated immediately
          await new Promise((resolve) => setTimeout(resolve, 3500));

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
// PTY WebSocket Plugin — one WS connection per task terminal
// Listens on ws://localhost:<PORT>/api/pty
// Messages in:  { type:'spawn', cmd, args, cwd, cols, rows }
//               { type:'input', data }      (keystrokes from xterm.js)
//               { type:'resize', cols, rows }
// Messages out: { type:'data', data }       (raw PTY output)
//               { type:'exit', code }       (process exited)
// ─────────────────────────────────────────────────────────────────────────────
function ergoPtyPlugin(): Plugin {
  return {
    name: 'ergo-pty',
    configureServer(server) {
      // Defer WSS creation until the underlying http.Server is available
      server.httpServer?.once('listening', async () => {
        const { WebSocketServer } = await import('ws');
        // node-pty must be imported dynamically so Vite doesn't try to bundle it
        const pty = (await import('node-pty')).default;

        const wss = new WebSocketServer({ noServer: true });

        server.httpServer!.on('upgrade', (req: IncomingMessage, socket: any, head: any) => {
          if (req.url === '/api/pty') {
            wss.handleUpgrade(req, socket as any, head, (ws) => {
              wss.emit('connection', ws, req);
            });
          }
        });

        wss.on('connection', (ws: any) => {
          let ptyProcess: ReturnType<typeof pty.spawn> | null = null;

          const safeKillPty = () => {
            if (ptyProcess) {
              try {
                if (typeof ptyProcess.pid === 'number' && ptyProcess.pid > 0) {
                  ptyProcess.kill();
                }
              } catch {}
              ptyProcess = null;
            }
          };

          const send = (obj: Record<string, unknown>) => {
            if (ws.readyState === 1 /* OPEN */) {
              ws.send(JSON.stringify(obj));
            }
          };

          ws.on('message', (raw: Buffer | string) => {
            let msg: any;
            try {
              msg = JSON.parse(raw.toString());
            } catch {
              return;
            }

            if (msg.type === 'spawn') {
              safeKillPty();

              const cmd: string = msg.cmd || 'bash';
              const args: string[] = Array.isArray(msg.args) ? msg.args : [];
              let cwd: string = resolveStoragePath(msg.cwd || os.homedir());
              try {
                if (!fsSync.existsSync(cwd)) {
                  cwd = process.cwd();
                }
              } catch {
                cwd = process.cwd();
              }
              const cols: number = typeof msg.cols === 'number' && msg.cols > 0 ? msg.cols : 120;
              const rows: number = typeof msg.rows === 'number' && msg.rows > 0 ? msg.rows : 40;

              console.log(`[Ergo PTY] Spawning: ${cmd} ${args.join(' ')} in ${cwd}`);

              try {
                ptyProcess = pty.spawn(cmd, args, {
                  name: 'xterm-256color',
                  cols,
                  rows,
                  cwd,
                  env: { ...process.env } as Record<string, string>,
                });

                ptyProcess.onData((data: string) => send({ type: 'data', data }));
                ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
                  console.log(`[Ergo PTY] Process exited with code ${exitCode}`);
                  send({ type: 'exit', code: exitCode });
                  ptyProcess = null;
                });

                send({ type: 'ready' });
              } catch (err: any) {
                console.error('[Ergo PTY] Spawn error:', err);
                send({ type: 'error', message: err.message });
              }

            } else if (msg.type === 'input') {
              if (ptyProcess && typeof msg.data === 'string') {
                ptyProcess.write(msg.data);
              }

            } else if (msg.type === 'resize') {
              if (ptyProcess && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
                try { ptyProcess.resize(msg.cols, msg.rows); } catch {}
              }

            } else if (msg.type === 'kill') {
              safeKillPty();
            }
          });

          ws.on('close', () => {
            if (ptyProcess) {
              console.log('[Ergo PTY] WebSocket closed — killing PTY process');
              safeKillPty();
            }
          });

          ws.on('error', (err: Error) => {
            console.error('[Ergo PTY] WebSocket error:', err);
            safeKillPty();
          });
        });

        console.log('[Ergo PTY] WebSocket PTY server ready at ws://localhost/api/pty');
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), ergoFileSystemPlugin(), ergoPtyPlugin()],
});
