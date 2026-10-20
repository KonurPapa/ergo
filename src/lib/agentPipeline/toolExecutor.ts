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
import { type ExecutionStep, type HumanInputPrompt, type AgentRole, type McpToolPermissionPrompt, type PermissionDecision, type PermissionLevel } from '../../types';
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

/*
 * Read-only shell detection. The command is parsed with POSIX sh quoting rules (exec() runs it through
 * /bin/sh) into `;`/`&&`-separated pipelines of simple commands, and every simple command must be a known
 * read-only invocation. Anything the parser is not certain about — unbalanced quotes, `$` expansions,
 * backticks, subshells, `||`, backgrounding, `&>`, here-docs, process substitution, any redirection other
 * than `2>&1` / `>&2` / `>/dev/null` / `2>/dev/null`, comments, control characters — makes the whole command "not read-only",
 * so it goes through the normal approval flow. Fail closed: when in doubt, ask.
 */

/** Commands whose arguments can't make them write, delete or execute anything (any args, globs included). */
const ARGS_SAFE_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'pwd', 'echo', 'wc', 'grep', 'which', 'whoami', 'stat', 'du', 'df', 'uname',
  'cut', 'realpath', 'dirname', 'basename', 'diff', 'printenv', 'type', 'cd'
]);
/** Read commands with an option that writes or executes; checked per command, and never with unquoted globs. */
const FLAG_CHECKED_COMMANDS = new Set(['sort', 'tree', 'uniq', 'find', 'git', 'sed', 'rg', 'date', 'file']);
const READ_ONLY_GIT = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'shortlog', 'describe']);
/** Global git options allowed before the subcommand (`-c`, `--exec-path`, `--git-dir`… can run arbitrary code). */
const SAFE_GIT_GLOBAL_OPTIONS = new Set(['--no-pager', '-P', '--no-optional-locks']);
const FIND_WRITE_FLAGS = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls']);
/**
 * Tools whose `--version` / `--help` only prints; an arbitrary program might treat those flags differently.
 * Left out on purpose: launchers that pick the program to run from files in the project, which an agent can
 * write with auto-approved edits (yarn's yarnPath, pnpm's packageManager switch, rustup's rust-toolchain.toml
 * for cargo / rustc, go.mod's toolchain line, bun).
 */
const VERSION_PROBE_TOOLS = new Set([
  'node', 'npm', 'npx', 'deno', 'tsc', 'python', 'python3', 'pip', 'pip3',
  'java', 'javac', 'gcc', 'g++', 'clang', 'make', 'cmake', 'docker', 'ruby', 'php', 'git'
]);
/** `<tool> -v` / `-V` is a version probe for these only (python -v is verbose mode, pytest -v runs tests…). */
const SHORT_VERSION_FLAG: Record<string, string> = { node: '-v', npm: '-v', npx: '-v', python: '-V', python3: '-V' };
/** sed scripts that only print: line / `$` / `/regex/` addresses and ranges, each followed by `p`. */
const SED_ADDRESS = String.raw`(?:\d+|\$|/[^/\\]*/)`;
const SED_PRINT_CMD = String.raw`${SED_ADDRESS}(?:\s*,\s*(?:${SED_ADDRESS}|[+~]\d+))?\s*p`;
const SAFE_SED_SCRIPT_RE = new RegExp(String.raw`^\s*${SED_PRINT_CMD}(?:\s*;\s*${SED_PRINT_CMD})*\s*;?\s*$`);

interface ShellWord {
  /** The word after quote removal. */
  value: string;
  /** Contains an unquoted glob or brace character (`* ? [ ] { }`), so the shell may expand it into other words. */
  expands: boolean;
  /** Some part of the word was quoted or backslash-escaped. */
  quoted: boolean;
}
/** `;`/`&&`-separated pipelines, each a list of `|`-separated simple commands (their words). */
type ParsedShell = ShellWord[][][];

const isWindowsHost = (): boolean => {
  try {
    // Runs in the browser and in Node; read `process` off globalThis so neither environment's types are required.
    if ((globalThis as any).process?.platform === 'win32') return true;
    if (typeof navigator !== 'undefined') {
      const nav = navigator as any;
      return /^win/i.test(String(nav.userAgentData?.platform || nav.platform || '')) || /windows/i.test(String(nav.userAgent || ''));
    }
  } catch {}
  return false;
};

/**
 * Parse a command with POSIX sh quoting, accepting only plain words, `|`, `&&`, `;` and the harmless
 * redirections. Returns null for anything else.
 */
function parseSimpleShell(command: string): ParsedShell | null {
  const pipelines: ParsedShell = [];
  let stages: ShellWord[][] = [];
  let words: ShellWord[] = [];
  let word: ShellWord = { value: '', expands: false, quoted: false };
  let inWord = false;
  /** After `|` or `&&` a command must follow (`ls &&` is a syntax error). */
  let needCommand = false;

  const endWord = () => {
    if (inWord) {
      words.push(word);
      needCommand = false;
    }
    word = { value: '', expands: false, quoted: false };
    inWord = false;
  };
  const endStage = (): boolean => {
    endWord();
    if (words.length === 0) return false;
    stages.push(words);
    words = [];
    return true;
  };
  const endPipeline = (): boolean => {
    if (!endStage()) return false;
    pipelines.push(stages);
    stages = [];
    return true;
  };
  const isDelimiter = (c: string | undefined) => c === undefined || c === ' ' || c === '\t' || c === ';' || c === '&' || c === '|';
  /** Parse the target of `>` / `>>` starting at `j`: only `/dev/null` is allowed. Returns the last index used. */
  const devNullTarget = (j: number): number | null => {
    while (command[j] === ' ' || command[j] === '\t') j++;
    if (command.slice(j, j + 9) !== '/dev/null' || !isDelimiter(command[j + 9])) return null;
    return j + 8;
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const code = ch.charCodeAt(0);
    // Newlines separate commands and other control characters are never needed: refuse them all.
    if ((code < 0x20 && ch !== '\t') || code === 0x7f) return null;
    if (ch === ' ' || ch === '\t') {
      endWord();
      continue;
    }
    if (ch === "'") {
      const close = command.indexOf("'", i + 1);
      if (close === -1) return null;
      word.value += command.slice(i + 1, close);
      word.quoted = true;
      inWord = true;
      i = close;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++) {
        const c = command[j];
        if (c === '$' || c === '`') return null; // expansions still run inside double quotes
        if (c === '\\') {
          const next = command[j + 1];
          if (next === undefined) return null;
          // Inside double quotes a backslash only escapes $ ` " \ (and newline, refused above).
          if (next === '$' || next === '`' || next === '"' || next === '\\') {
            word.value += next;
            j++;
            continue;
          }
          word.value += '\\';
          continue;
        }
        if (c.charCodeAt(0) < 0x20 && c !== '\t') return null;
        word.value += c;
      }
      if (j >= command.length) return null;
      word.quoted = true;
      inWord = true;
      i = j;
      continue;
    }
    if (ch === '\\') {
      // Outside quotes a backslash makes the next character literal (\' and \" do NOT open a quote).
      const next = command[i + 1];
      if (next === undefined) return null;
      if (next.charCodeAt(0) < 0x20 || next === '\x7f') return null;
      word.value += next;
      word.quoted = true;
      inWord = true;
      i++;
      continue;
    }
    if (ch === '$' || ch === '`' || ch === '(' || ch === ')' || ch === '<') return null;
    if (ch === '#' && !inWord) return null; // comment: keep it simple and ask
    if (ch === '>') {
      // An unquoted number right before `>` is the fd being redirected: only stdout (1) or stderr (2).
      if (inWord) {
        if (!word.quoted && /^\d+$/.test(word.value)) {
          if (word.value !== '1' && word.value !== '2') return null;
          word = { value: '', expands: false, quoted: false };
          inWord = false;
        } else {
          endWord();
        }
      }
      let j = i + 1;
      if (command[j] === '&') {
        // N>&M duplicates an fd: only to stdout/stderr.
        const target = command[j + 1];
        if ((target !== '1' && target !== '2') || !isDelimiter(command[j + 2])) return null;
        i = j + 1;
        continue;
      }
      if (command[j] === '>') j++;
      else if (command[j] === '|') return null;
      const end = devNullTarget(j);
      if (end === null) return null;
      i = end;
      continue;
    }
    if (ch === '&') {
      if (command[i + 1] === '&') {
        if (!endPipeline()) return null;
        needCommand = true;
        i++;
        continue;
      }
      // A lone `&` backgrounds. `&>` too: bash reads it as a redirection, but dash (/bin/sh on Debian/Ubuntu)
      // reads `a &> /dev/null b` as `a &` then `b` — a second command the words after it would hide.
      return null;
    }
    if (ch === '|') {
      if (command[i + 1] === '|' || command[i + 1] === '&') return null;
      if (!endStage()) return null;
      needCommand = true;
      continue;
    }
    if (ch === ';') {
      if (command[i + 1] === ';' || command[i + 1] === '&') return null;
      if (!endPipeline()) return null;
      continue;
    }
    if ('*?[]{}'.includes(ch)) word.expands = true;
    word.value += ch;
    inWord = true;
  }
  endWord();
  if (needCommand) return null;
  if (words.length > 0 || stages.length > 0) {
    if (!endPipeline()) return null;
  } else if (pipelines.length === 0) {
    return null; // nothing but whitespace / redirections
  }
  // (a trailing `;` leaves nothing pending and is fine)
  return pipelines;
}

/** `--name[=value]` that is `option` or a GNU-style abbreviation of it (`--out` for `--output`). */
function longOptionMatches(token: string, options: string[]): boolean {
  if (!token.startsWith('--') || token.length < 3) return false;
  const eq = token.indexOf('=');
  const name = eq === -1 ? token : token.slice(0, eq);
  return options.some((opt) => opt.startsWith(name) || name.startsWith(opt));
}
/** A bundle of short options (`-ro`) that includes any of `letters`. */
const shortOptionHas = (token: string, letters: string): boolean =>
  /^-[^-]/.test(token) && [...token.slice(1)].some((c) => letters.includes(c));

function isReadOnlyInvocation(words: ShellWord[]): boolean {
  const [cmdWord, ...argWords] = words;
  // Command name: a plain name looked up on PATH (no path, no assignment, no expansion).
  if (!cmdWord || cmdWord.expands || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(cmdWord.value)) return false;
  const name = cmdWord.value;
  const args = argWords.map((w) => w.value);
  if (ARGS_SAFE_COMMANDS.has(name)) return true;
  if (args.length === 1 && VERSION_PROBE_TOOLS.has(name) && (args[0] === '--version' || args[0] === '--help' || SHORT_VERSION_FLAG[name] === args[0])) {
    return !argWords[0].expands;
  }
  if (!FLAG_CHECKED_COMMANDS.has(name)) return false;
  // A glob or brace expansion could turn into an option (a file named "-delete" or "--output=x").
  if (argWords.some((w) => w.expands)) return false;
  switch (name) {
    case 'sort':
      return !args.some((t) => t === '--' || shortOptionHas(t, 'o') || longOptionMatches(t, ['--output', '--compress-program']));
    case 'tree':
      // -o writes the listing to a file; -R re-runs tree with -o 00Tree.html in every directory.
      return !args.some((t) => shortOptionHas(t, 'oR') || longOptionMatches(t, ['--output']));
    case 'uniq':
      // uniq [INPUT [OUTPUT]]: a second operand is written.
      return !args.includes('--') && args.filter((t) => t === '-' || !t.startsWith('-')).length < 2;
    case 'find':
      return !args.some((t) => FIND_WRITE_FLAGS.has(t));
    case 'date':
      return !args.some((t) => shortOptionHas(t, 's') || longOptionMatches(t, ['--set']));
    case 'file':
      return !args.some((t) => shortOptionHas(t, 'C') || longOptionMatches(t, ['--compile']));
    case 'rg':
      // --pre and --hostname-bin run a program.
      return !args.some((t) => longOptionMatches(t, ['--pre', '--hostname-bin']));
    case 'sed':
      // Only `sed -n '<addresses>p' [files]`: sed scripts can write (w) or execute (e), and -i edits in place.
      return args[0] === '-n' && args.length >= 2 && SAFE_SED_SCRIPT_RE.test(args[1]) && args.slice(2).every((t) => !t.startsWith('-'));
    case 'git': {
      let idx = 0;
      while (idx < args.length && SAFE_GIT_GLOBAL_OPTIONS.has(args[idx])) idx++;
      const sub = args[idx];
      if (!sub || sub.startsWith('-')) return false;
      const subArgs = args.slice(idx + 1);
      if (sub === 'branch' || sub === 'remote') {
        return subArgs.length <= 1 && subArgs.every((t) => t === '-v' || t === '-vv' || t === '-a' || t === '-r' || t === '--list');
      }
      if (!READ_ONLY_GIT.has(sub)) return false;
      // --output writes a file; --ext-diff runs a configured program. Paths after `--` are only pathspecs.
      const end = subArgs.indexOf('--');
      const options = end === -1 ? subArgs : subArgs.slice(0, end);
      return !options.some((t) => longOptionMatches(t, ['--output', '--ext-diff', '--exec', '--upload-pack', '--receive-pack']));
    }
    default:
      return false;
  }
}

/**
 * True for shell commands that can't change anything (ls, cat, grep, git status, find without -exec, …).
 * Pipes, `&&` and `;` chains are fine when every command is read-only; `2>&1`, `>&2`, `>/dev/null` and
 * `2>/dev/null` are allowed. Anything else — other redirections, `$` expansions, command substitution,
 * subshells, `||`, backgrounding, env assignments, explicit paths to programs — disqualifies the command.
 * Errs on the side of asking.
 */
export function isReadOnlyCommand(command: unknown): boolean {
  if (typeof command !== 'string' || !command.trim()) return false;
  if (isWindowsHost()) {
    // cmd.exe has different quoting (^ escapes, ' is not a quote, %VAR% expands) and its own sort /O and date.
    // It also treats `\` as a plain character, so the sh-style escapes below don't hold there: any
    // backslash-adjacent operator (`echo \& calc`) would run. Refuse operators and backslashes outright.
    if (/['"^%!\\&|<>\r\n;]/.test(command)) return false;
  }
  const parsed = parseSimpleShell(command);
  if (!parsed) return false;
  const windows = isWindowsHost();
  return parsed.every((pipeline) =>
    pipeline.every((words) => isReadOnlyInvocation(words) && !(windows && (words[0].value === 'sort' || words[0].value === 'date')))
  );
}

/**
 * A path inside a `.git` directory (or a `.git` file), or a global git config file. git reads these on the
 * "read-only" commands auto-allowed above (core.fsmonitor runs on `git status`, diff textconv / external
 * drivers on `git diff`/`log`/`show`), so an auto-approved edit there would turn into running any command.
 */
function isGitConfigPath(target: string | undefined): boolean {
  if (!target) return false;
  // Lower-case (case-insensitive filesystems) and drop Windows' ignored trailing dots / spaces.
  const segments = target
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => (/^[. ]*$/.test(s) ? s : s.toLowerCase().replace(/[. ]+$/, '')));
  if (segments.some((s) => s === '.git' || /^git~\d+$/.test(s))) return true;
  const base = segments[segments.length - 1] || '';
  const parent = segments[segments.length - 2] || '';
  return base === '.gitconfig' || (parent === 'git' && (base === 'config' || base === 'attributes'));
}

/** Rule key an "allow for this task" answer grants: per command name for shell, one rule for all file edits. */
export function permissionRuleKey(def: ToolDefinition, call: ToolCallRequest): { key: string; label: string } {
  if (call.name === 'run_command') {
    const command = String(call.args?.command || '').trim();
    // Only a single plain command generalizes to "all <name> commands"; a chain, pipe, expansion or explicit
    // path would otherwise let a later `ls; rm -rf x` ride on an "all ls commands" grant.
    const parsed = parseSimpleShell(command);
    const words = parsed && parsed.length === 1 && parsed[0].length === 1 ? parsed[0][0] : null;
    const first = words?.[0];
    if (first && !first.expands && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(first.value)) {
      return { key: `run_command:${first.value}`, label: `all "${first.value}" commands` };
    }
    return { key: `run_command:exact:${command}`, label: 'this exact command' };
  }
  if (FILE_MUTATING_TOOL_NAMES.has(call.name)) {
    // A git config edit is never covered by "all file edits" (see isGitConfigPath): it gets its own exact rule.
    const target = extractTargetPath(call.name, call.args);
    if (isGitConfigPath(target)) return { key: `files:git-config:${call.name}:${normalizePath(String(target))}`, label: 'this git config file' };
    return { key: 'files:edit', label: 'all file edits' };
  }
  return { key: `${def.serverId}:${call.name}`, label: `all ${def.serverName} / ${call.name} calls` };
}

export type PermissionVerdict = 'allow' | 'prompt' | 'block';

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
      if (FILE_MUTATING_TOOL_NAMES.has(call.name)) return isGitConfigPath(extractTargetPath(call.name, call.args)) ? 'prompt' : 'allow';
      return def.autoApprove ? 'allow' : 'prompt';
  }
}

/** Live re-check for each prompt waiting on the user, keyed by the prompt object handed to onRequestPermission. */
const pendingPromptChecks = new WeakMap<McpToolPermissionPrompt, () => PermissionVerdict>();
/** Prompts settled because the permission level now blocks the call (the rejection gets the plan-mode message). */
const planBlockedPrompts = new WeakSet<McpToolPermissionPrompt>();

/**
 * Re-evaluate a waiting permission prompt under the run's current permission level, with the same
 * permissionVerdict the executor uses (it knows the tool definition). Returns null for prompts this module
 * did not issue. On 'block', resolve the prompt with false: the executor then reports the plan-mode reason
 * instead of "rejected by user".
 */
export function reevaluatePendingPermission(prompt: McpToolPermissionPrompt): PermissionVerdict | null {
  const check = pendingPromptChecks.get(prompt);
  if (!check) return null;
  let verdict: PermissionVerdict;
  try {
    verdict = check();
  } catch {
    return 'prompt';
  }
  if (verdict === 'block') planBlockedPrompts.add(prompt);
  return verdict;
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

const PLAN_MODE_BLOCKED = (toolName: string): string =>
  `"${toolName}" is not allowed: the run is in Plan (read-only) permission mode, so files can't be changed and commands that modify state can't run. Inspect with read-only tools and describe the changes you would make instead.`;

const DIFF_PREVIEW_MAX_LINES = 40;

/** At most `budget` lines; when cut, the last kept line becomes a "… (n more lines)" marker. */
function fitLines(lines: string[], budget: number): string[] {
  if (lines.length <= budget) return lines;
  if (budget <= 0) return [];
  const kept = lines.slice(0, budget - 1);
  const more = lines.length - kept.length;
  return [...kept, `… (${more} more line${more === 1 ? '' : 's'})`];
}

/**
 * Short preview of what a file write/edit will change, shown in the approval prompt:
 * edit_file → "-old" / "+new" lines, write_file → the first lines of the new content. At most 40 lines.
 */
export function buildDiffPreview(name: string, args: Record<string, any>): string | undefined {
  if (name === 'edit_file') {
    const oldText = typeof args.old_string === 'string' ? args.old_string : '';
    const newText = typeof args.new_string === 'string' ? args.new_string : '';
    if (!oldText && !newText) return undefined;
    const oldLines = oldText ? oldText.split('\n').map((l: string) => `-${l}`) : [];
    const newLines = newText ? newText.split('\n').map((l: string) => `+${l}`) : [];
    const total = DIFF_PREVIEW_MAX_LINES;
    if (oldLines.length + newLines.length <= total) return [...oldLines, ...newLines].join('\n');
    // Over budget: share it so both sides stay visible (a short side keeps all its lines).
    const oldBudget = Math.min(oldLines.length, Math.max(Math.floor(total / 2), total - newLines.length));
    return [...fitLines(oldLines, oldBudget), ...fitLines(newLines, total - oldBudget)].join('\n');
  }
  if (name === 'write_file') {
    const content = typeof args.content === 'string' ? args.content : '';
    if (!content) return '(empty file)';
    return fitLines(content.split('\n'), DIFF_PREVIEW_MAX_LINES).join('\n');
  }
  return undefined;
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

  const currentLevel = (): PermissionLevel => {
    try {
      return ctx.getPermissionLevel?.() || ctx.options.permissionLevel || 'acceptEdits';
    } catch {
      return ctx.options.permissionLevel || 'acceptEdits';
    }
  };

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
    // Read the level live on every call: the user may change it while the run is in flight.
    const level: PermissionLevel = currentLevel();
    const verdict = permissionVerdict(level, def, call);
    const scopeError = verdict === 'block' ? PLAN_MODE_BLOCKED(call.name) : checkScope(call, def);
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
    let blockedByPlan = false;
    if (verdict === 'prompt' && ctx.onRequestPermission) {
      const rule = permissionRuleKey(def, call);
      const requestPermission = ctx.onRequestPermission;
      approved = await withPermissionLock(ctx, async () => {
        if (ctx.sessionAllowedTools.has(rule.key)) return true;
        // The level may have changed while this call queued behind another prompt: re-check before asking.
        const now = permissionVerdict(currentLevel(), def, call);
        if (now === 'allow') return true;
        if (now === 'block') {
          blockedByPlan = true;
          return false;
        }
        const prompt: McpToolPermissionPrompt = {
          id: `perm-${Date.now()}-${n}`,
          serverId: def.serverId,
          serverName: def.serverName,
          toolName: call.name,
          args,
          summary: summarizeToolArgsForPermission(call.name, args),
          diffPreview: buildDiffPreview(call.name, args),
          rememberLabel: rule.label
        };
        pendingPromptChecks.set(prompt, () => permissionVerdict(currentLevel(), def, call));
        let decision: PermissionDecision;
        try {
          decision = await requestPermission(prompt);
        } finally {
          pendingPromptChecks.delete(prompt);
        }
        const granted = decision === true || decision === 'always';
        if (!granted && planBlockedPrompts.has(prompt)) {
          blockedByPlan = true;
          return false;
        }
        if (decision === 'always') ctx.sessionAllowedTools.add(rule.key);
        return granted;
      });
    }
    if (blockedByPlan) {
      const message = PLAN_MODE_BLOCKED(call.name);
      emit({ id: stepId, stage: 'mcp_call', title: `${scope.actorLabel}: ${call.name}() blocked`, detail: message, mcpToolUsed: call.name, status: 'warning' });
      return err(call, message);
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
