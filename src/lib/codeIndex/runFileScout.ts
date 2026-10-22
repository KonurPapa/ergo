/**
 * Runs the file scout (./fileScout.ts) on the profile's small model, from the app.
 *
 * Subscription profiles: one headless Claude Code process in the bridge (/api/code-index/scout), with code_search and
 * read-only tools. API-key profiles (and subscription profiles that carry a direct key, which smallModelCallConfig
 * prefers): Ergo's own tool loop with code_search, read_file, search_files and list_directory. Other CLIs (Codex,
 * Antigravity) have no small-model tool path here: no scout, the run starts without a list.
 */
import type { AIProviderConfig, TokenUsage } from '../../types';
import { bridgeClient } from '../bridgeClient';
import { callMcpTool } from '../mcpClient';
import { runToolLoop } from '../agentPipeline/providerLoop';
import { bundledToolDefinitions } from '../agentPipeline/toolSchemas';
import { resolveCliBinary } from '../agentPipeline/contracts';
import { parseScoutFiles, scoutSystemPrompt, scoutUserPrompt, SCOUT_MAX_TURNS, SCOUT_TIMEOUT_MS } from './fileScout';

export interface FileScoutResult {
  /** Repository-relative paths, best first. */
  files: string[];
  usage?: TokenUsage;
  /** The small model that scouted. */
  model: string;
  durationMs: number;
}

const SCOUT_TOOLS = ['code_search', 'read_file', 'search_files', 'list_directory'];

/** Joins a repository-relative path onto `root` (absolute and ~ paths pass through). */
function inRepo(root: string, p: unknown): string {
  const s = typeof p === 'string' ? p.trim() : '';
  if (!s || s === '.' || s === './') return root;
  if (s.startsWith('/') || s.startsWith('~')) return s;
  return `${root.replace(/\/+$/, '')}/${s.replace(/^\.\/+/, '')}`;
}

/**
 * The files the task will likely need, or null when there is no scout for this profile, it failed, or it took longer
 * than SCOUT_TIMEOUT_MS. `config`: smallModelCallConfig of the active profile. Never throws.
 */
export async function runFileScout(params: {
  config: AIProviderConfig | null;
  taskText: string;
  cwd: string;
  signal?: AbortSignal;
}): Promise<FileScoutResult | null> {
  const { config, taskText, cwd } = params;
  if (!config || !cwd || !taskText.trim()) return null;
  const started = Date.now();
  const timeout = AbortSignal.timeout(SCOUT_TIMEOUT_MS + 5_000);
  const signal = params.signal ? AbortSignal.any([params.signal, timeout]) : timeout;
  try {
    if (config.provider === 'cli_subscription') {
      const cli = resolveCliBinary(config);
      if (!/claude/i.test(cli)) return null;
      const res = await bridgeClient.fetch('/api/code-index/scout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, task: taskText, cli, model: config.model }),
        signal,
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data?.success || !Array.isArray(data.files) || data.files.length === 0) {
        if (data?.error) console.warn('[Ergo File Scout]', data.error);
        return null;
      }
      return { files: data.files, ...(data.usage ? { usage: data.usage } : {}), model: config.model, durationMs: Date.now() - started };
    }

    const result = await runToolLoop({
      provider: config.provider,
      model: config.model,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      authMode: config.authMode,
      stableSystem: scoutSystemPrompt('code_search, read_file, search_files, list_directory (paths relative to the repository)'),
      sharedContext: '',
      initialUserMessage: `${scoutUserPrompt(taskText)}\n\nRepository: ${cwd}`,
      tools: bundledToolDefinitions(SCOUT_TOOLS),
      maxRounds: SCOUT_MAX_TURNS,
      maxTokens: 2_000,
      compaction: { mode: 'off' },
      signal,
      onToolCalls: (calls) =>
        Promise.all(
          calls.map(async (c) => {
            const args = { ...c.args, path: inRepo(cwd, c.args.path) };
            const out = await callMcpTool('mcp-filesystem', c.name, args);
            const data = out.data;
            const content = out.success
              ? typeof data === 'string' ? data : typeof data?.content === 'string' ? data.content : JSON.stringify(data)
              : out.error || 'Tool call failed.';
            return { id: c.id, name: c.name, content: content.slice(0, 20_000), isError: !out.success };
          })
        ),
    });
    const files = parseScoutFiles(result.text, cwd);
    if (files.length === 0) return null;
    return { files, usage: result.usage, model: config.model, durationMs: Date.now() - started };
  } catch (err) {
    if (!params.signal?.aborted) console.warn('[Ergo File Scout] failed; the run starts without a file list:', err);
    return null;
  }
}
