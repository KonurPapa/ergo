/**
 * What a CLI agent is doing right now, in plain words: the one-line status above the task prompt box. The bridge
 * folds each CLI's own session log into it (Claude Code JSONL, Codex rollout, Gemini chat log) and falls back to the
 * rendered terminal for CLIs without a readable log. Raw commands are never shown: a shell call reads as its
 * description ("Rename archive module and fix imports") or as the program it runs ("Running npm").
 */

import { extractActivityEntries } from './cliActivityFeed.ts';

export interface AgentActivity {
  /**
   * The agent's latest narration ("Clean. Renaming the leftover file…") or reasoning headline (Codex reasoning
   * summaries, Gemini thought subjects); cleared when a new user turn starts.
   */
  said: string;
  /** The step it took after that narration ("Rename archive module and fix imports", "Editing App.tsx"). */
  doing: string;
  /** 'tool': a tool call has not returned yet. 'thinking': between steps. 'idle': the CLI ended its turn. */
  phase: 'thinking' | 'tool' | 'idle';
}

/** GET /api/pty/activity */
export interface AgentActivityResponse {
  success: boolean;
  activity?: AgentActivity;
  source?: 'claude-session-log' | 'codex-session-log' | 'gemini-session-log' | 'screen' | 'none';
  isActive?: boolean;
  /** The CLI's own "working" spinner is on screen (Claude "esc to interrupt", Codex "Working", Gemini "esc to cancel"). */
  spinner?: boolean;
  /** Milliseconds since the agent's terminal last printed anything (null once it ended). */
  quietMs?: number | null;
  error?: string;
}

/** Fold state: the activity plus the tool calls that have not returned yet. */
export interface ActivityFold {
  activity: AgentActivity;
  /** Tool calls that have not returned yet, by call id, in call order (what an approval prompt is about). */
  pending: Map<string, PendingToolCall>;
}

export interface PendingToolCall {
  name: string;
  input: unknown;
}

export function newActivityFold(): ActivityFold {
  return { activity: { said: '', doing: '', phase: 'thinking' }, pending: new Map() };
}

const MAX_SAID = 240;

/** Narration as one plain line: markdown, code fences and extra paragraphs dropped, clipped at a word. */
export function clipNarration(text: string): string {
  let t = String(text ?? '')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find(Boolean) ?? '';
  t = t
    .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/gm, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length <= MAX_SAID) return t;
  const cut = t.slice(0, MAX_SAID);
  const space = cut.lastIndexOf(' ');
  return `${(space > MAX_SAID * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

const baseName = (p: unknown): string => (typeof p === 'string' ? p.trim().split(/[\\/]/).filter(Boolean).pop() ?? '' : '');

/** The program a shell command runs ("cd x && FOO=1 npx vitest run" → "npx vitest"), never its arguments. */
export function shellProgram(command: unknown): string {
  let cmd = Array.isArray(command) ? command.map(String) : typeof command === 'string' ? [command] : [];
  // ["bash", "-lc", "<script>"] → the script.
  if (cmd.length >= 3 && /^(?:ba|z|)sh$|powershell|pwsh|cmd(?:\.exe)?$/i.test(baseName(cmd[0])) && /^-|^\/c$/i.test(cmd[1])) cmd = [cmd[cmd.length - 1]];
  const script = cmd.join(' ').trim();
  for (const part of script.split(/&&|\|\||;|\n/)) {
    const words = part.trim().split(/\s+/).filter((w) => w && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    while (words.length && /^(?:sudo|env|time|nohup|exec|command)$/.test(words[0])) {
      words.shift();
      while (words.length && words[0].startsWith('-')) words.shift();
    }
    if (!words.length || /^(?:cd|pushd|set|export|source|\.)$/.test(words[0])) continue;
    const prog = baseName(words[0]).replace(/^["']|["']$/g, '');
    if (!prog) continue;
    // npx / npm run / pnpm / yarn / python -m: the tool they start says more than the runner.
    const sub = words[1] && !words[1].startsWith('-') ? baseName(words[1]) : '';
    if (/^(?:npx|bunx|pnpx|uvx)$/.test(prog) && sub) return `${prog} ${sub}`;
    if (/^python[\d.]*$/.test(prog) && words[1] === '-m' && words[2]) return `${prog} -m ${words[2]}`;
    if (/^(?:npm|pnpm|yarn|bun|cargo|go|git|docker|make|uv|pip|gradle|mvn|dotnet|kubectl)$/.test(prog) && sub && /^[a-z][\w:-]*$/.test(sub)) {
      return `${prog} ${sub === 'run' && words[2] && !words[2].startsWith('-') ? words[2] : sub}`;
    }
    return prog;
  }
  return '';
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function filesOfPatch(patch: unknown): string[] {
  if (typeof patch !== 'string') return [];
  const out: string[] = [];
  for (const m of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/gm)) {
    const name = baseName(m[1]);
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

function listFiles(verb: string, files: string[]): string {
  if (files.length === 0) return `${verb} files`;
  if (files.length <= 2) return `${verb} ${files.join(', ')}`;
  return `${verb} ${files[0]} and ${plural(files.length - 1, 'other file')}`;
}

const humanize = (name: string) =>
  name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();

/**
 * A tool call in plain words. A description the model wrote for the call wins (Claude's Bash/Task `description`,
 * Gemini's run_shell_command `description`); otherwise it is derived from the tool and its target.
 */
export function describeToolCall(name: string, rawInput: unknown): string {
  let input: any = rawInput;
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input);
    } catch {
      input = { input };
    }
  }
  input = input && typeof input === 'object' ? input : {};
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  const mcp = name.match(/^mcp__(.+?)__(.+)$/);
  const tool = (mcp ? mcp[2] : name).replace(/^functions\./, '');
  const key = tool.toLowerCase().replace(/[^a-z]/g, '');
  const file = baseName(input.file_path ?? input.absolute_path ?? input.path ?? input.notebook_path ?? input.filename);

  if (/^(?:bash|shell|shellcommand|runshellcommand|execcommand|localshell|powershell|terminal|runterminalcommand|runcommand)$/.test(key)) {
    if (description) return clipNarration(description);
    const prog = shellProgram(input.command ?? input.cmd ?? input.input);
    return prog ? `Running ${prog}` : 'Running a command';
  }
  if (/^(?:task|agent|subagent|delegate)$/.test(key)) return description ? clipNarration(description) : 'Starting a sub-agent';
  if (/^(?:todowrite|writetodos|updateplan|updatetodos)$/.test(key)) {
    const items: any[] = Array.isArray(input.todos) ? input.todos : Array.isArray(input.plan) ? input.plan : [];
    const now = items.find((t) => t?.status === 'in_progress');
    const text = now && (now.activeForm || now.content || now.step || now.description);
    return typeof text === 'string' && text.trim() ? clipNarration(text) : 'Updating the plan';
  }
  if (key === 'applypatch') return listFiles('Editing', filesOfPatch(input.input ?? input.patch ?? rawInput));
  if (/^(?:read|readfile|view|viewfile|notebookread|cat)$/.test(key)) return file ? `Reading ${file}` : 'Reading a file';
  if (key === 'readmanyfiles') return 'Reading files';
  if (/^(?:write|writefile|create|createfile)$/.test(key)) return file ? `Writing ${file}` : 'Writing a file';
  if (/^(?:edit|multiedit|replace|update|strreplace|strreplaceeditor|editfile|notebookedit)$/.test(key)) return file ? `Editing ${file}` : 'Editing a file';
  if (/^(?:grep|glob|ls|list|listdirectory|readfolder|findfiles|searchtext|searchfilecontent|search|codesearch|codebasesearch|find)$/.test(key)) {
    return 'Searching the code';
  }
  if (/^(?:websearch|googlewebsearch|googlesearch|searchweb)$/.test(key)) {
    const q = typeof input.query === 'string' ? input.query.trim() : '';
    return q ? `Searching the web for “${clipNarration(q).slice(0, 60)}”` : 'Searching the web';
  }
  if (/^(?:webfetch|fetch|webread|readurl)$/.test(key)) return 'Reading a web page';
  if (/^(?:savememory|memory)$/.test(key)) return 'Saving a note';
  if (description) return clipNarration(description);
  return `Using ${humanize(tool)}`;
}

/** First line / bold header of a reasoning summary ("**Locating the router**\n\n…" → "Locating the router"). */
function reasoningHeadline(text: unknown): string {
  if (typeof text !== 'string') return '';
  const bold = text.match(/\*\*([^*\n]{3,120})\*\*/);
  const line = bold ? bold[1] : text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return clipNarration(line);
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: any) => (typeof part === 'string' ? part : part && (part.type === 'text' || part.type === 'output_text' || part.type === 'input_text' || (!part.type && part.text)) ? String(part.text ?? '') : ''))
    .filter((t) => t.trim())
    .join('\n\n');
}

function say(fold: ActivityFold, text: string) {
  const said = clipNarration(text);
  if (!said) return;
  fold.activity.said = said;
  fold.activity.doing = '';
  if (fold.pending.size === 0) fold.activity.phase = 'thinking';
}

function startTool(fold: ActivityFold, id: string | undefined, name: string, input: unknown) {
  fold.activity.doing = describeToolCall(name, input);
  if (id) {
    fold.pending.delete(id);
    fold.pending.set(id, { name, input });
  }
  fold.activity.phase = 'tool';
}

function endTool(fold: ActivityFold, id: string | undefined) {
  if (id) fold.pending.delete(id);
  else fold.pending.clear();
  if (fold.pending.size === 0) fold.activity.phase = 'thinking';
}

function newTurn(fold: ActivityFold) {
  fold.activity = { said: '', doing: '', phase: 'thinking' };
  fold.pending.clear();
}

/** Claude Code session log line (~/.claude/projects/<cwd>/<session>.jsonl). Thinking blocks are redacted there. */
export function foldClaudeEntry(fold: ActivityFold, entry: any): void {
  if (!entry || entry.isSidechain) return;
  const content = entry.message?.content;
  if (entry.type === 'user') {
    if (typeof content === 'string') {
      if (!entry.isMeta && content.trim()) newTurn(fold);
      return;
    }
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block?.type === 'tool_result') endTool(fold, block.tool_use_id);
    }
    if (!entry.isMeta && content.some((b: any) => b?.type === 'text' && String(b.text ?? '').trim()) && !content.some((b: any) => b?.type === 'tool_result')) {
      newTurn(fold);
    }
    return;
  }
  if (entry.type !== 'assistant' || !Array.isArray(content)) return;
  for (const block of content) {
    if (block?.type === 'text') say(fold, String(block.text ?? ''));
    else if (block?.type === 'tool_use') startTool(fold, block.id, String(block.name ?? ''), block.input);
    else if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
      if (fold.pending.size === 0) fold.activity.phase = 'thinking';
    }
  }
}

/** Codex rollout line (~/.codex/sessions/…/rollout-*.jsonl): `{ type, payload }`, older builds `{ msg }` or bare. */
export function foldCodexEvent(fold: ActivityFold, ev: any): void {
  const p = ev?.payload ?? ev?.msg ?? ev;
  if (!p || typeof p !== 'object') return;
  switch (p.type) {
    case 'user_message':
      newTurn(fold);
      return;
    case 'agent_message':
      if (typeof p.message === 'string') say(fold, p.message);
      return;
    case 'message':
      if (p.role === 'assistant') say(fold, textOf(p.content));
      return;
    case 'agent_reasoning':
    case 'reasoning':
      say(fold, reasoningHeadline(p.text ?? (Array.isArray(p.summary) ? p.summary.map((s: any) => s?.text ?? '').join('\n') : '')));
      return;
    case 'function_call':
      startTool(fold, p.call_id, String(p.name ?? ''), p.arguments);
      return;
    case 'custom_tool_call':
      startTool(fold, p.call_id, String(p.name ?? ''), p.name === 'apply_patch' ? { input: p.input } : p.input);
      return;
    case 'local_shell_call':
      startTool(fold, p.call_id, 'local_shell', { command: p.action?.command });
      return;
    case 'web_search_call':
      // Logged once it finished: nothing to wait on.
      fold.activity.doing = describeToolCall('web_search', { query: p.action?.query });
      return;
    case 'function_call_output':
    case 'custom_tool_call_output':
    case 'local_shell_call_output':
      endTool(fold, p.call_id);
      return;
    case 'task_complete':
    case 'turn_aborted':
      fold.pending.clear();
      fold.activity.phase = 'idle';
      return;
  }
}

const GEMINI_DONE = new Set(['success', 'error', 'cancelled', 'canceled']);

/** Gemini CLI chat message (`messages[]` of chats/session-*.json, or a record line of session-*.jsonl). */
export function foldGeminiMessage(fold: ActivityFold, msg: any): void {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'user' || msg.role === 'user') {
    newTurn(fold);
    return;
  }
  if (msg.type !== 'gemini' && msg.type !== 'model' && msg.role !== 'model') return;
  const thoughts: any[] = Array.isArray(msg.thoughts) ? msg.thoughts : [];
  const lastThought = thoughts[thoughts.length - 1];
  const thought = clipNarration(lastThought?.subject || lastThought?.description || '');
  const text = textOf(msg.content ?? msg.parts);
  say(fold, text.trim() ? text : thought);
  for (const call of Array.isArray(msg.toolCalls) ? msg.toolCalls : []) {
    const id = String(call?.id ?? '');
    startTool(fold, id || undefined, String(call?.name ?? call?.displayName ?? ''), call?.args);
    if (GEMINI_DONE.has(String(call?.status ?? '').toLowerCase()) || call?.result !== undefined) endTool(fold, id || undefined);
  }
}

/** Tools through which the agent asks the user something (their prompt is a question, not a permission request). */
const ASK_USER_TOOL_RE = /^(?:askuserquestion|askuser|askhuman|requestuserinput|ask_user(?:_question)?)$/i;

/** What an approval prompt is about, from the call it is for: the newest pending call (not a question tool). */
export function pendingCallForPrompt(fold: ActivityFold): PendingToolCall | null {
  const calls = [...fold.pending.values()];
  for (let i = calls.length - 1; i >= 0; i--) {
    if (!ASK_USER_TOOL_RE.test(calls[i].name.replace(/^mcp__.+?__/, ''))) return calls[i];
  }
  return null;
}

const MAX_DETAIL_LINES = 40;

/**
 * The prompt card's request details for a tool call: the command for shell tools, the file and change for edits,
 * the arguments for anything else. Filled in when the CLI's own panel did not fit on screen.
 */
export function promptContextOfCall(call: PendingToolCall): { toolLabel: string; targetCommand?: string; description?: string; detailLines?: string[] } {
  let input: any = call.input;
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input);
    } catch {
      input = { input };
    }
  }
  input = input && typeof input === 'object' ? input : {};
  const tool = call.name.replace(/^mcp__.+?__/, '').replace(/^functions\./, '');
  const key = tool.toLowerCase().replace(/[^a-z]/g, '');
  const description = typeof input.description === 'string' && input.description.trim() ? input.description.trim() : undefined;
  const lines = (text: unknown) => String(text ?? '').split('\n').slice(0, MAX_DETAIL_LINES);
  if (/^(?:bash|shell|shellcommand|runshellcommand|execcommand|localshell|powershell|terminal|runterminalcommand|runcommand)$/.test(key)) {
    let command: unknown = input.command ?? input.cmd ?? input.input;
    if (Array.isArray(command)) {
      const parts = command.map(String);
      command = parts.length >= 3 && /^-/.test(parts[1]) ? parts[parts.length - 1] : parts.join(' ');
    }
    return { toolLabel: 'Bash command', targetCommand: String(command ?? '').trim() || undefined, description };
  }
  const file = input.file_path ?? input.absolute_path ?? input.path ?? input.notebook_path;
  if (key === 'applypatch') {
    const patch = String(input.input ?? input.patch ?? '');
    return { toolLabel: 'Edit files', description: describeToolCall(call.name, input), detailLines: lines(patch) };
  }
  if (typeof file === 'string' && file) {
    const change = input.new_string ?? input.content ?? input.edits;
    const detail = [file, ...(change !== undefined ? ['', ...lines(typeof change === 'string' ? change : JSON.stringify(change, null, 2))] : [])];
    const toolLabel = /^(?:read|readfile|view|viewfile|notebookread|cat)$/.test(key)
      ? 'Read file'
      : /^(?:write|writefile|create|createfile)$/.test(key)
        ? 'Write file'
        : 'Edit file';
    return { toolLabel, description, detailLines: detail.slice(0, MAX_DETAIL_LINES) };
  }
  const args = Object.keys(input).length ? lines(JSON.stringify(input, null, 2)) : undefined;
  return { toolLabel: tool, description: description ?? describeToolCall(call.name, input), detailLines: args };
}

/** Screen fallback (CLIs without a readable log): narration and tool rows of the rendered transcript. */
export function activityFromScreen(lines: string[], liveRows: string[], launchPrompt?: string): AgentActivity {
  const { feed } = extractActivityEntries(lines, 'Agent', liveRows, launchPrompt);
  const fold = newActivityFold();
  for (const item of feed) {
    if (item.type === 'thought') say(fold, item.text);
    else if (item.type === 'tool') fold.activity.doing = describeScreenAction(item.text, item.detail);
  }
  return fold.activity;
}

/**
 * Narration the log missed (Claude Code doesn't always persist a text block written next to a tool call) is still on
 * the screen: when the screen shows narration after the log's latest, the screen's wins — with the log's step only if
 * the screen shows a tool row after it too.
 */
export function withScreenNarration(activity: AgentActivity, lines: string[], launchPrompt?: string): AgentActivity {
  if (!activity.said) return activity;
  const { feed } = extractActivityEntries(lines, 'Agent', undefined, launchPrompt);
  // The screen keeps only the first row of a wrapped narration: compare openings.
  const key = (t: string) => clipNarration(t).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 40);
  const want = key(activity.said);
  let logAt = -1;
  let lastThought = -1;
  feed.forEach((item, i) => {
    if (item.type !== 'thought') return;
    if (key(item.text) === want) logAt = i;
    lastThought = i;
  });
  if (logAt < 0 || lastThought <= logAt) return activity;
  const toolAfter = feed.slice(lastThought + 1).some((item) => item.type === 'tool');
  return { ...activity, said: clipNarration(feed[lastThought].text), doing: toolAfter ? activity.doing : '' };
}

/** A tool row from the terminal ("Bash" + "git mv a b", "Ran npm test", "Edited src/a.ts (+3 -1)") in plain words. */
function describeScreenAction(text: string, detail?: string): string {
  if (text === 'Command') return describeToolCall('bash', { command: detail });
  if (text === 'Sub-agent') return 'Starting a sub-agent';
  if (text === 'Action') return 'Working';
  const verb = text.match(/^(Ran|Running|Explored|Exploring|Edited|Editing|Added|Deleted|Updated|Wrote|Created|Searched|Searching|Called|Read|Reading|Applied patch)\b\s*(.*)$/);
  if (verb && !detail) {
    const rest = verb[2].replace(/\s*\([+\-\d\s]+\)\s*$/, '').trim();
    switch (verb[1]) {
      case 'Ran':
      case 'Running':
        return describeToolCall('bash', { command: rest });
      case 'Explored':
      case 'Exploring':
      case 'Searched':
      case 'Searching':
        return 'Searching the code';
      case 'Read':
      case 'Reading':
        return rest ? `Reading ${baseName(rest.split(/,\s*/)[0])}` : 'Reading files';
      case 'Called':
        return 'Using a tool';
      default:
        return rest ? `Editing ${baseName(rest.split(/\s+/)[0])}` : 'Editing files';
    }
  }
  return describeToolCall(text, { command: detail, file_path: detail, description: '' });
}
