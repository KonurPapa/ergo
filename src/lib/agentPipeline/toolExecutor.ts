/**
 * Scoped tool executor — the harness side of "state gating".
 *
 * Tool DEFINITIONS never change during a run (cache stability); what each agent may actually DO
 * is constrained here: read-only phases, per-piece write scopes, file locks held by other pieces,
 * and user permission prompts for non-auto-approved tools. Violations come back to the model as
 * high-signal error results that say exactly what was wrong and what to do instead.
 *
 * Results are trimmed to TOOL_RESULT_CHAR_CAP (pass pointers over payloads); the model is told how
 * to narrow the request when that happens.
 */
import { type ExecutionStep, type HumanInputPrompt, type AgentRole, type PermissionLevel } from '../../types';
import { callMcpTool } from '../mcpClient';
import {
  TOOL_RESULT_CHAR_CAP,
  type PipelineContext,
  type ToolCallRequest,
  type ToolCallResult,
  type ToolDefinition,
  type ToolScope
} from './contracts';
import { FILE_MUTATING_TOOL_NAMES, FILE_WRITING_TOOL_NAMES, MUTATING_TOOL_NAMES, extractTargetPath } from './toolSchemas';
import { type FileLockRegistry, normalizePath, pathWithin, pathsRefer } from './bible';

export interface ToolExecutorOptions {
  ctx: PipelineContext;
  tools: ToolDefinition[];
  scope: ToolScope;
  agentRole: AgentRole;
  pieceId?: string;
  locks?: FileLockRegistry;
  onFileWritten?: (path: string) => void;
  stepIdPrefix?: string;
}

// ─── Permission policy ──────────────────────────────────────────────────────

/** Commands that only read state; anything that writes, deletes, installs or executes project code is excluded. */
const READ_ONLY_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'pwd', 'echo', 'wc', 'grep', 'rg', 'tree', 'which', 'whoami', 'date', 'file', 'stat',
  'du', 'df', 'uname', 'sort', 'uniq', 'cut', 'realpath', 'dirname', 'basename', 'diff', 'printenv', 'type'
]);
const READ_ONLY_GIT = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'shortlog', 'describe']);
const FIND_WRITE_FLAGS = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprintf', '-fls']);

function isReadOnlySegment(segment: string): boolean {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  const [cmd, ...rest] = tokens;
  const name = cmd.replace(/^.*\//, '');
  if (rest.length === 1 && /^(--version|-v|-V|--help)$/.test(rest[0])) return true;
  if (READ_ONLY_COMMANDS.has(name)) return true;
  if (name === 'find') return !rest.some((t) => FIND_WRITE_FLAGS.has(t));
  if (name === 'git') {
    const sub = rest.find((t) => !t.startsWith('-'));
    if (sub === 'branch' || sub === 'remote') return rest.length <= 2 && rest.every((t) => t === sub || t === '-v' || t === '-a' || t === '--list');
    return Boolean(sub && READ_ONLY_GIT.has(sub));
  }
  if (name === 'sed') return rest[0] === '-n' && !rest.some((t) => t.startsWith('-i'));
  return false;
}

/**
 * True for shell commands that can't change anything (ls, cat, grep, git status, find without -exec, …).
 * Redirection, command substitution, chaining and backgrounding disqualify a command; pipes are fine when
 * every stage is read-only. Errs on the side of asking.
 */
export function isReadOnlyCommand(command: unknown): boolean {
  if (typeof command !== 'string' || !command.trim()) return false;
  if (/[;&`<>]|\$\(|\|\|/.test(command)) return false;
  return command.split('|').every(isReadOnlySegment);
}

/** Rule key an "allow for this task" answer grants: per command name for shell, one rule for all file edits. */
export function permissionRuleKey(def: ToolDefinition, call: ToolCallRequest): { key: string; label: string } {
  if (call.name === 'run_command') {
    const first = String(call.args?.command || '').trim().split(/\s+/)[0]?.replace(/^.*\//, '') || 'shell';
    return { key: `run_command:${first}`, label: `all "${first}" commands` };
  }
  if (FILE_MUTATING_TOOL_NAMES.has(call.name)) return { key: 'files:edit', label: 'all file edits' };
  return { key: `${def.serverId}:${call.name}`, label: `all ${def.serverName} / ${call.name} calls` };
}

type PermissionVerdict = 'allow' | 'prompt' | 'block';

const TRUSTED_SERVERS = new Set(['mcp-filesystem', 'builtin', 'ergo-workspace']);
const READ_STYLE_TOOL_RE = /^(get|list|read|search|fetch|find|view|describe|query|show|lookup|stat|count|check)(_|[A-Z]|$)/;

/**
 * Whether a call may change something. External MCP tools are only marked readOnly by a name-list heuristic,
 * so for them a read-style name (get_*, list_*, search_*…) is also required before skipping approval.
 */
function mayMutate(def: ToolDefinition, call: ToolCallRequest): boolean {
  if (MUTATING_TOOL_NAMES.has(call.name) || !def.readOnly) return true;
  if (TRUSTED_SERVERS.has(def.serverId) || def.serverId.toLowerCase().includes('workspace')) return false;
  return !READ_STYLE_TOOL_RE.test(call.name);
}

/** What the permission level says about one tool call (before any "allow for this task" grants). */
export function permissionVerdict(level: PermissionLevel, def: ToolDefinition, call: ToolCallRequest): PermissionVerdict {
  const isMutating = mayMutate(def, call);
  if (call.name === 'run_command' && isReadOnlyCommand(call.args?.command) && level !== 'ask') return 'allow';
  if (!isMutating) return level === 'ask' && !def.autoApprove ? 'prompt' : 'allow';
  switch (level) {
    case 'plan':
      return 'block';
    case 'bypass':
      return 'allow';
    case 'ask':
      return 'prompt';
    case 'acceptEdits':
    default:
      if (FILE_MUTATING_TOOL_NAMES.has(call.name)) return 'allow';
      return def.autoApprove ? 'allow' : 'prompt';
  }
}

/**
 * One permission prompt at a time per run: parallel workers would otherwise overwrite each other's pending
 * prompt in the UI (leaving a worker waiting forever). Queued requests re-check grants made while they waited.
 */
const permissionQueues = new WeakMap<PipelineContext, Promise<unknown>>();

function withPermissionLock<T>(ctx: PipelineContext, fn: () => Promise<T>): Promise<T> {
  const prev = permissionQueues.get(ctx) || Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  permissionQueues.set(ctx, run.catch(() => undefined));
  return run;
}

export function summarizeToolArgsForPermission(name: string, args: Record<string, any>): string {
  if (name === 'run_command') return `Run shell command: ${args.command}${args.cwd ? `  (cwd: ${args.cwd})` : ''}`;
  if (name === 'write_file') return `Write file: ${args.path} (${typeof args.content === 'string' ? args.content.length : 0} chars)`;
  if (name === 'edit_file') return `Edit file: ${args.path} (replace ${typeof args.old_string === 'string' ? args.old_string.length : 0} chars with ${typeof args.new_string === 'string' ? args.new_string.length : 0})`;
  if (name === 'create_directory') return `Create directory: ${args.path}`;
  if (name === 'git_commit') return `git commit -m "${args.message}"${args.cwd ? ` in ${args.cwd}` : ''}`;
  const compact = JSON.stringify(args ?? {});
  return `Execute tool "${name}" with ${compact.length > 300 ? compact.slice(0, 300) + '…' : compact}`;
}

function stringifyResultData(data: any): string {
  if (data === null || data === undefined) return '';
  if (typeof data === 'string') return data;
  // Common harness shapes: surface the primary text field directly to save tokens.
  if (typeof data === 'object' && !Array.isArray(data)) {
    const keys = Object.keys(data);
    if (keys.length <= 2 && typeof data.content === 'string') {
      return data.content;
    }
  }
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

function truncateResult(content: string): string {
  if (content.length <= TOOL_RESULT_CHAR_CAP) return content;
  const omitted = content.length - TOOL_RESULT_CHAR_CAP;
  return `${content.slice(0, TOOL_RESULT_CHAR_CAP)}\n[truncated — ${omitted} more chars; narrow the request (read_file offset/limit, search_files contentPattern, smaller command output)]`;
}

function missingRequiredArgs(def: ToolDefinition, args: Record<string, any>): string[] {
  const required: string[] = Array.isArray(def.inputSchema?.required) ? def.inputSchema.required : [];
  return required.filter((k) => {
    const v = args[k];
    return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
  });
}

export function createToolExecutor(opts: ToolExecutorOptions): (calls: ToolCallRequest[]) => Promise<ToolCallResult[]> {
  const { ctx, tools, scope, agentRole, pieceId, locks, onFileWritten } = opts;
  const prefix = opts.stepIdPrefix || 'step-tool';
  const byName = new Map(tools.map((t) => [t.name, t]));
  let counter = 0;

  const emit = (partial: Omit<ExecutionStep, 'time' | 'taskId'>) => ctx.emit({ ...partial, agentRole, pieceId });

  const err = (call: ToolCallRequest, message: string): ToolCallResult => ({ id: call.id, name: call.name, content: `ERROR: ${message}`, isError: true });

  async function handleAskHuman(call: ToolCallRequest): Promise<ToolCallResult> {
    const n = ++counter;
    const stepId = `${prefix}-human-${n}`;
    const args = call.args || {};
    const question = typeof args.question === 'string' && args.question.trim() ? args.question.trim() : 'The agent is requesting human input to proceed:';
    const options = Array.isArray(args.options) ? args.options.filter((o: any) => typeof o === 'string' && o.trim().length > 0) : undefined;
    const context = typeof args.context === 'string' ? args.context : undefined;
    const allowFreeform = args.allowFreeform !== false;
    const promptData: HumanInputPrompt = {
      id: `prompt-${Date.now()}-${n}`,
      taskId: ctx.task.id,
      question,
      options: options && options.length > 0 ? options : undefined,
      context,
      allowFreeform
    };
    emit({
      id: stepId,
      stage: 'human_input',
      title: `Clarification Needed: Question from ${scope.actorLabel}`,
      detail: question,
      status: 'running',
      humanInputPrompt: promptData
    });
    let answer = '';
    if (ctx.onRequestHumanInput) {
      answer = await ctx.onRequestHumanInput(promptData);
    } else {
      answer = 'User provided default approval / confirmation.';
    }
    emit({
      id: stepId,
      stage: 'human_input',
      title: 'Human Clarification Provided',
      detail: `Answer received: "${answer}"`,
      status: 'success',
      humanInputPrompt: undefined
    });
    return { id: call.id, name: call.name, content: `Human user provided response: "${answer}"`, isError: false };
  }

  function checkScope(call: ToolCallRequest, def: ToolDefinition): string | null {
    const isMutating = MUTATING_TOOL_NAMES.has(call.name) || !def.readOnly;
    if (isMutating && scope.readOnly) {
      return `"${call.name}" is not allowed in this read-only phase (${scope.actorLabel}). You may only inspect (read_file, search_files, list_directory, get_file_info, git_status, git_diff, fetch_*). Report what needs to change instead of doing it.`;
    }
    if (FILE_MUTATING_TOOL_NAMES.has(call.name)) {
      const target = extractTargetPath(call.name, call.args);
      if (!target) return `"${call.name}" requires a "path" argument.`;
      if (scope.allowedWritePaths !== undefined) {
        const allowed = scope.allowedWritePaths;
        if (allowed.length === 0) {
          if (scope.readOnly) {
            return `${scope.actorLabel} owns no files and is in read-only mode, so "${call.name}" on "${target}" is not allowed. Describe the required change in your summary so the manager can assign it.`;
          }
          // If not in a read-only phase, allow writing within the allowed workspace boundaries
        } else {
          // A piece may also create the parent directories of files it owns.
          const isAncestorOfOwned = call.name === 'create_directory' && allowed.some((p) => pathWithin(p, target) && !pathsRefer(p, target));
          const ok = isAncestorOfOwned || allowed.some((p) => pathWithin(target, p));
          if (!ok) {
            return `"${target}" is outside your write scope. ${scope.actorLabel} may only modify: ${allowed.map((p) => `"${p}"`).join(', ')}. Read-only access to everything else is fine; report needed changes to other files in your summary.`;
          }
        }
      }
      if (locks) {
        const holder = locks.holderOf(target);
        if (holder && holder !== pieceId) {
          return `"${target}" is currently locked by piece ${holder} (another worker is editing it). Do not modify it now; either wait for that piece to finish or report the needed change in your summary.`;
        }
      }
    }
    return null;
  }

  async function executeOne(call: ToolCallRequest): Promise<ToolCallResult> {
    const def = byName.get(call.name);
    if (!def) {
      return err(call, `Unknown tool "${call.name}". Available tools: ${tools.map((t) => t.name).join(', ')}.`);
    }
    const args = call.args && typeof call.args === 'object' ? call.args : {};
    const missing = missingRequiredArgs(def, args);
    if (missing.length > 0) {
      return err(call, `"${call.name}" is missing required argument(s): ${missing.join(', ')}.`);
    }
    const level: PermissionLevel = ctx.options.permissionLevel || 'acceptEdits';
    const verdict = permissionVerdict(level, def, call);
    const scopeError = verdict === 'block'
      ? `"${call.name}" is not allowed: the run is in Plan (read-only) permission mode, so files can't be changed and commands that modify state can't run. Inspect with read-only tools and describe the changes you would make instead.`
      : checkScope(call, def);
    if (scopeError) {
      const n = ++counter;
      emit({
        id: `${prefix}-${n}`,
        stage: 'mcp_call',
        title: `${scope.actorLabel}: ${call.name}() blocked`,
        detail: scopeError,
        mcpToolUsed: call.name,
        status: 'warning'
      });
      return err(call, scopeError);
    }

    const n = ++counter;
    const stepId = `${prefix}-${n}`;
    emit({
      id: stepId,
      stage: 'mcp_call',
      title: `${scope.actorLabel}: ${call.name}()`,
      detail: `Calling ${def.serverName} / ${call.name}… ${summarizeToolArgsForPermission(call.name, args).slice(0, 200)}`,
      mcpToolUsed: call.name,
      status: 'running'
    });

    let approved = true;
    if (verdict === 'prompt' && ctx.onRequestPermission) {
      const rule = permissionRuleKey(def, call);
      const requestPermission = ctx.onRequestPermission;
      approved = await withPermissionLock(ctx, async () => {
        if (ctx.sessionAllowedTools.has(rule.key)) return true;
        const decision = await requestPermission({
          id: `perm-${Date.now()}-${n}`,
          serverId: def.serverId,
          serverName: def.serverName,
          toolName: call.name,
          args,
          summary: summarizeToolArgsForPermission(call.name, args),
          rememberLabel: rule.label
        });
        if (decision === 'always') ctx.sessionAllowedTools.add(rule.key);
        return decision === true || decision === 'always';
      });
    }
    if (!approved) {
      emit({ id: stepId, stage: 'mcp_call', title: `${scope.actorLabel}: ${call.name}()`, detail: 'Tool call skipped / rejected by user.', mcpToolUsed: call.name, status: 'warning' });
      return err(call, 'Tool call rejected by user. Do not retry it; adapt your approach or ask_human why.');
    }

    let content = '';
    let isError = false;
    try {
      // Ensure parent directory exists before creating or editing files (mkdir -p)
      if (FILE_WRITING_TOOL_NAMES.has(call.name)) {
        const target = extractTargetPath(call.name, args);
        if (target) {
          const normalized = target.replace(/\\/g, '/');
          const lastSlash = normalized.lastIndexOf('/');
          if (lastSlash > 0) {
            const parentDir = normalized.slice(0, lastSlash);
            try {
              await callMcpTool('mcp-filesystem', 'create_directory', { path: parentDir });
            } catch {}
          }
        }
      }

      const result = await callMcpTool(def.serverId, call.name, args, {
        endpoint: def.endpoint,
        authHeader: def.authHeader
      });
      if (result.success) {
        content = stringifyResultData(result.data);
        if (call.name === 'run_command' && result.data && typeof result.data === 'object' && result.data.exitCode !== undefined && result.data.exitCode !== 0) {
          // Non-zero exit is a normal result but flag it so the model treats it as a failure signal.
          content = `[exit code ${result.data.exitCode}] ${content}`;
        }
      } else {
        isError = true;
        content = result.error || 'Tool call failed.';
      }
    } catch (e: any) {
      isError = true;
      content = `Exception calling tool: ${e?.message || String(e)}`;
    }

    content = truncateResult(content);
    if (!isError && FILE_WRITING_TOOL_NAMES.has(call.name)) {
      const target = extractTargetPath(call.name, args);
      if (target && onFileWritten) onFileWritten(normalizePath(target));
    }

    emit({
      id: stepId,
      stage: 'mcp_call',
      title: `${scope.actorLabel}: ${call.name}()`,
      detail: isError ? `Error: ${content.slice(0, 250)}` : `Result: ${content.slice(0, 250)}${content.length > 250 ? '…' : ''}`,
      mcpToolUsed: call.name,
      status: isError ? 'error' : 'success'
    });

    return { id: call.id, name: call.name, content: isError ? `ERROR: ${content}` : content, isError };
  }

  return async (calls: ToolCallRequest[]): Promise<ToolCallResult[]> => {
    const results: ToolCallResult[] = new Array(calls.length);
    // Read-only calls run concurrently; mutating calls (and ask_human) run sequentially in order.
    const readOnlyIdx: number[] = [];
    const sequentialIdx: number[] = [];
    calls.forEach((c, i) => {
      const def = byName.get(c.name);
      if (c.name === 'ask_human' || !def || !def.readOnly || MUTATING_TOOL_NAMES.has(c.name)) sequentialIdx.push(i);
      else readOnlyIdx.push(i);
    });
    await Promise.all(readOnlyIdx.map(async (i) => { results[i] = await executeOne(calls[i]); }));
    for (const i of sequentialIdx) {
      results[i] = calls[i].name === 'ask_human' ? await handleAskHuman(calls[i]) : await executeOne(calls[i]);
    }
    return results;
  };
}
