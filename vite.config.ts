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
    return path.join(os.homedir(), inputPath.slice(1));
  }
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(process.cwd(), inputPath);
}

function getActiveStorageDir(): string {
  return resolveStoragePath(activeStoragePath);
}

async function ensureStorageInitialized(storageDir: string) {
  try {
    await fs.mkdir(storageDir, { recursive: true });
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

function sendJson(res: ServerResponse, statusCode: number, data: any) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

function ergoFileSystemPlugin(): Plugin {
  const attachMiddleware = (server: { middlewares: { use: Function } }) => {
    // Initialize default ~/.ergo directory on startup
    ensureStorageInitialized(getActiveStorageDir());

    server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: Function) => {
      const url = req.url?.split('?')[0];
      const storageDir = getActiveStorageDir();

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
          for (const item of files) {
            if (!item.filePath || typeof item.content !== 'string') continue;
            const fullPath = path.resolve(storageDir, item.filePath);
            await fs.mkdir(path.dirname(fullPath), { recursive: true });
            await fs.writeFile(fullPath, item.content, 'utf-8');
            writtenFiles.push(item.filePath);
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
          }> = [];

          for (const entry of entries) {
            if (entry.isDirectory()) {
              const projectDir = path.join(projectsDir, entry.name);
              const todoPath = path.join(projectDir, 'TODO.md');
              const agentPath = path.join(projectDir, 'AGENT_CONTEXT.md');

              let todoContent = '';
              let agentContent = '';

              try {
                todoContent = await fs.readFile(todoPath, 'utf-8');
              } catch {
                todoContent = `# ${entry.name} Tasks:\n\n1. **Initial Task Setup:**\n    - Define project scope`;
                await fs.writeFile(todoPath, todoContent, 'utf-8');
              }

              try {
                agentContent = await fs.readFile(agentPath, 'utf-8');
              } catch {
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
            { id: 'root-default', path: storageDir, name: 'Home Ergo Root (~/.ergo)', isDefault: true },
            { id: 'root-workspace', path: process.cwd(), name: 'Workspace Folder', isDefault: false }
          ];
          try {
            const content = await fs.readFile(rootsFile, 'utf-8');
            roots = JSON.parse(content);
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

      if (url === '/api/mcp/tools/call' && req.method === 'POST') {
        try {
          const body = await parseJsonBody(req);
          const { serverId, toolName, args } = body;

          if (!toolName) {
            return sendJson(res, 400, { error: 'toolName is required' });
          }

          // 1. Filesystem MCP Harness
          if (serverId === 'mcp-filesystem' || toolName === 'read_file' || toolName === 'write_file' || toolName === 'list_directory' || toolName === 'create_directory' || toolName === 'search_files' || toolName === 'get_file_info') {
            const targetPath = args.path || args.filePath || '';
            const fullPath = path.isAbsolute(targetPath) ? targetPath : path.resolve(storageDir, targetPath);

            // Safe Roots boundary check
            const configDir = path.resolve(storageDir, 'config');
            let allowedRoots = [storageDir, process.cwd(), os.homedir()];
            try {
              const rootsContent = await fs.readFile(path.join(configDir, 'roots.json'), 'utf-8');
              const parsedRoots = JSON.parse(rootsContent);
              if (Array.isArray(parsedRoots)) {
                allowedRoots = parsedRoots.map((r: any) => path.resolve(r.path));
              }
            } catch {}

            const isAllowed = allowedRoots.some((root) => fullPath.startsWith(root));
            if (!isAllowed) {
              return sendJson(res, 403, {
                error: `Access denied: "${targetPath}" is outside allowed MCP Roots boundaries.`
              });
            }

            if (toolName === 'read_file') {
              try {
                const content = await fs.readFile(fullPath, 'utf-8');
                return sendJson(res, 200, { success: true, data: { content, path: targetPath } });
              } catch (err: any) {
                return sendJson(res, 404, { error: `File not found: ${targetPath}` });
              }
            }

            if (toolName === 'write_file') {
              const content = typeof args.content === 'string' ? args.content : '';
              await fs.mkdir(path.dirname(fullPath), { recursive: true });
              await fs.writeFile(fullPath, content, 'utf-8');
              return sendJson(res, 200, { success: true, data: { path: targetPath, writtenAt: new Date().toISOString() } });
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
              } catch (err: any) {
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
              } catch (err: any) {
                return sendJson(res, 404, { error: `File not found: ${targetPath}` });
              }
            }

            if (toolName === 'search_files') {
              const query = (args.query || args.pattern || '').toLowerCase();
              const matched: string[] = [];

              async function walk(dir: string) {
                const files = await fs.readdir(dir, { withFileTypes: true });
                for (const file of files) {
                  const resolved = path.join(dir, file.name);
                  if (file.name.startsWith('.') || file.name === 'node_modules' || file.name === 'dist') continue;
                  if (file.isDirectory()) {
                    await walk(resolved);
                  } else if (file.name.toLowerCase().includes(query)) {
                    matched.push(path.relative(process.cwd(), resolved));
                  }
                }
              }

              await walk(fullPath);
              return sendJson(res, 200, { success: true, data: { query, matched } });
            }
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

          // 3. Git Operations MCP Harness
          if (serverId === 'mcp-git' || toolName.startsWith('git_')) {
            const { exec } = await import('node:child_process');
            const { promisify } = await import('node:util');
            const execAsync = promisify(exec);

            let gitCommand = 'git status --short';
            if (toolName === 'git_status') gitCommand = 'git status --short';
            if (toolName === 'git_diff') gitCommand = 'git diff -U2';
            if (toolName === 'git_log') gitCommand = 'git log -n 5 --oneline';
            if (toolName === 'git_commit') {
              const msg = args.message ? ` -m "${args.message.replace(/"/g, '\\"')}"` : ' -m "Update from Ergo"';
              gitCommand = `git commit ${msg}`;
            }

            try {
              const { stdout, stderr } = await execAsync(gitCommand, { cwd: process.cwd() });
              return sendJson(res, 200, {
                success: true,
                data: {
                  command: gitCommand,
                  output: (stdout || stderr || '').trim()
                }
              });
            } catch (err: any) {
              return sendJson(res, 200, {
                success: true,
                data: {
                  command: gitCommand,
                  output: err.stdout || err.message
                }
              });
            }
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
              if (ptyProcess) {
                try { ptyProcess.kill(); } catch {}
                ptyProcess = null;
              }

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
              if (ptyProcess) {
                try { ptyProcess.kill(); } catch {}
                ptyProcess = null;
              }
            }
          });

          ws.on('close', () => {
            if (ptyProcess) {
              console.log('[Ergo PTY] WebSocket closed — killing PTY process');
              try { ptyProcess.kill(); } catch {}
              ptyProcess = null;
            }
          });

          ws.on('error', (err: Error) => {
            console.error('[Ergo PTY] WebSocket error:', err);
            if (ptyProcess) {
              try { ptyProcess.kill(); } catch {}
              ptyProcess = null;
            }
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
