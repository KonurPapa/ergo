import type { AIProviderId, CliAgentPreset, CliAgentConfig, UserApiKey, TaskItem, AgentContextItem, EffortLevel, PermissionLevel } from '../types';
import { hasUsableOverview } from './overviewUtils';
import { isTaskBrief } from './agentPipeline/taskBrief';
import { COMPLETION_RECORD_FORMAT, COMPLETION_RECORD_RULES, QUESTION_RULES } from './humanFacingOutput';
import { formatReferenceSections, type TaskReferenceContext } from './taskReferences';

export const CLI_AGENT_PRESETS: CliAgentPreset[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    command: 'claude',
    defaultArgs: '',
    docsUrl: 'https://docs.anthropic.com/claude/docs/claude-code',
    description: "Anthropic's official agentic coding assistant in the CLI. Run `npm install -g @anthropic-ai/claude-code` to install.",
    badgeColor: '#d97706',
  },
  {
    id: 'codex',
    label: 'OpenAI Codex CLI',
    command: 'codex',
    defaultArgs: '',
    docsUrl: 'https://github.com/openai/codex',
    description: "OpenAI's command-line coding agent. Run `npm install -g @openai/codex` to install.",
    badgeColor: '#7c3aed',
  },
  {
    id: 'antigravity',
    label: 'Antigravity (agy)',
    command: 'agy',
    defaultArgs: '',
    docsUrl: 'https://antigravity.dev',
    description: "Google Deepmind's Advanced Agentic Coding assistant. Powered by Gemini, invoked via `agy`.",
    badgeColor: '#2563eb',
  },
  {
    id: 'cursor-cli',
    label: 'Cursor CLI',
    command: 'cursor',
    defaultArgs: '',
    docsUrl: 'https://cursor.com',
    description: 'Cursor IDE agent CLI integration.',
    badgeColor: '#06b6d4',
  },
  {
    id: 'grok-cli',
    label: 'Grok CLI',
    command: 'grok',
    defaultArgs: '',
    docsUrl: 'https://x.ai',
    description: 'xAI Grok terminal coding agent.',
    badgeColor: '#e11d48',
  },
  {
    id: 'aider',
    label: 'Aider',
    command: 'aider',
    defaultArgs: '--model gpt-4o',
    docsUrl: 'https://aider.chat',
    description: 'Open-source terminal pair programming AI. Run `pip install aider-chat` to install.',
    badgeColor: '#059669',
  },
];

/**
 * Returns the default CLI preset id for a given AI provider.
 */
export function getDefaultCliPresetForProvider(provider: AIProviderId): string {
  switch (provider) {
    case 'anthropic':
      return 'claude-code';
    case 'openai':
      return 'codex';
    case 'gemini':
      return 'antigravity';
    case 'cursor':
      return 'cursor-cli';
    case 'grok':
      return 'grok-cli';
    case 'ollama':
      return 'aider';
    default:
      return 'claude-code';
  }
}

/**
 * Resolves the effective CLI agent configuration from a UserApiKey or standalone config.
 */
export function getEffectiveCliAgent(key?: UserApiKey | null, fallback?: CliAgentConfig | null): CliAgentConfig | null {
  if (!key) return fallback || null;

  // If power-user configured custom CLI command:
  if (key.cliCustomCommand && key.cliCustomCommand.trim().length > 0) {
    return {
      command: key.cliCustomCommand.trim(),
      extraArgs: key.cliExtraArgs || '',
      presetId: key.cliPresetId || 'custom',
      name: key.name ? `${key.name} CLI` : undefined,
    };
  }

  // Find preset by explicit presetId / agentId, or fall back to provider default
  const targetPresetId = key.cliPresetId || key.cliAgentId || getDefaultCliPresetForProvider(key.provider);
  const preset = CLI_AGENT_PRESETS.find((p) => p.id === targetPresetId);

  if (preset) {
    return {
      id: preset.id,
      presetId: preset.id,
      name: preset.label,
      command: preset.command,
      extraArgs: key.cliExtraArgs !== undefined ? key.cliExtraArgs : preset.defaultArgs,
    };
  }

  // Fallback if preset wasn't found in list
  return {
    command: targetPresetId || 'claude',
    extraArgs: key.cliExtraArgs || '',
  };
}

/** Task content shared by every CLI prompt: title, category, notes, the working brief (or the user's overview), checklist. */
/** The overview a run generated or the user wrote (trimmed); undefined for none or text merely copied from the task. */
function usableOverview(brief: AgentContextItem | undefined): string | undefined {
  const text = hasUsableOverview(brief) ? (brief?.overview || brief?.brief || '').trim() : '';
  return text || undefined;
}

function buildTaskContentSections(task: TaskItem, brief?: AgentContextItem, heading = 'TASK TO COMPLETE'): string[] {
  const sections: string[] = [];

  sections.push(`${heading}: "${task.title}"`);

  if (task.category && task.category.trim()) {
    sections.push(`CATEGORY: ${task.category.trim()}`);
  }

  if (task.summaryNote && task.summaryNote.trim()) {
    sections.push(`SUMMARY NOTE:\n${task.summaryNote.trim()}`);
  }

  // A brief made from a freeform selection has no task text of its own beyond this.
  if (brief?.sourceContent && brief.sourceContent.trim() && brief.sourceContent.trim() !== task.title.trim()) {
    sections.push(`TASK DESCRIPTION:\n${brief.sourceContent.trim()}`);
  }

  // Only an overview a run generated (or the user wrote) — never text merely copied from the task.
  const overview = usableOverview(brief);
  if (overview && isTaskBrief(overview)) {
    sections.push(
      `WORKING BRIEF (your spec: Ergo's Summary agent wrote it for you from this task and the related tasks and notes in this project; ` +
      `work from it, and where the code contradicts it, trust the code and say so in your completion record):\n${overview}`
    );
  } else if (overview) {
    sections.push(`OBJECTIVES & CONTEXT:\n${overview}`);
  }

  if (task.subtasks && task.subtasks.length > 0) {
    const subtaskLines = task.subtasks
      .map((s) => `- [${s.isDone ? 'x' : ' '}] ${s.text}`)
      .join('\n');
    sections.push(`CHECKLIST / SUBTASKS:\n${subtaskLines}`);
  }

  return sections;
}

/** The task's own content (title, category, objectives, checklist, criteria) as plain text, e.g. for the file scout. */
export function buildTaskContentText(task: TaskItem, brief?: AgentContextItem): string {
  return buildTaskContentSections(task, brief).join('\n\n');
}

/**
 * Builds a clear, structured prompt for a CLI coding agent from a task and optional brief.
 * Single-agent prompt without Ergo's run protocol; task runs use buildManagerCliPrompt.
 */
export function buildTaskCliPrompt(task: TaskItem, brief?: AgentContextItem): string {
  const sections = buildTaskContentSections(task, brief);

  sections.push(
    `INSTRUCTIONS:\n` +
    `- Inspect the repository workspace to understand existing files and structure.\n` +
    `- Implement all required changes to complete the task and satisfy all acceptance criteria.\n` +
    `- Run tests or build verification if available.\n` +
    `- Provide a summary of all changes made when finished.`
  );

  return sections.join('\n\n');
}

// ─── Multi-agent CLI runs (manager → workers → verifier) ──────────────────────────
//
// Agents report milestones by writing files into `<cwd>/<runDirRel>/`; the bridge watches those files
// (see vite.config.ts, ergo-pty plugin) and App orchestrates the next agent. Messages Ergo types into a
// running agent's terminal must be ONE line: a newline would submit a half-typed message.
//
// The bridge also ingests those files into Ergo's vector memory (namespace agent-notes, doc id
// `run:<runId>:<file name>`), and serves memory to the agents over its ergo-memory MCP server. Agents WRITE
// the run files (they are Ergo's signals) but read each other's reports through memory, not the folder.

export interface CliRunPromptContext {
  runId: string;
  /** Run dir relative to the agent's cwd, e.g. ".ergo/runs/<runId>" (see runDirRel() in cliRunClient). */
  runDirRel: string;
  /** Most workers the manager may delegate to (delegation is offered only when this is ≥ 2). */
  maxWorkers: number;
  /** A verifier agent checks the manager's work after it writes completion.md. */
  verifierEnabled: boolean;
  /** Memory pre-fetched for this agent's prompt (RELEVANT MEMORY section; at most 4 are shown). */
  memoryHits?: Array<{ id: string; label: string; text: string }>;
  /** The ergo-memory MCP tools are registered for this agent (default true). False: agents use the run files. */
  memoryToolsAvailable?: boolean;
  /**
   * Context for the related tasks the Summary step selected for this task (formatSelectedRelatedContext): shown to
   * the manager and the workers as a RELATED TASKS section.
   */
  relatedContext?: string;
  /**
   * One-line index of the same related tasks (formatRelatedSourcesLine). A working brief already carries their facts,
   * so prompts built on one show this line instead of relatedContext.
   */
  relatedSources?: string;
  /**
   * The agent's folder has a ready code index: the prompts tell it to find code with the code_search tool first (on
   * the ergo-memory MCP server). `codeSearchPath`: the folder, for CLIs whose server can't tell the agent's cwd.
   */
  codeSearchAvailable?: boolean;
  codeSearchPath?: string;
  /** Files the file scout found for this task (repository-relative): the manager starts its searches there. */
  likelyFiles?: string[];
  /**
   * The bridge reports a manager's question.md (protocol ≥ 3): managers ask through that file, which Ergo shows as a
   * question card. Otherwise they use their CLI's own question tool or a plain reply.
   */
  questionFile?: boolean;
  /** The task's `/skill` and `@file` commands (taskReferences.ts): the manager prompt shows the skills and files. */
  references?: TaskReferenceContext;
  /**
   * The manager's ergo-memory server lists Ergo's workspace tools: an invoked skill uses them, and the manager checks
   * off the task's checklist with workspace_update_subtask (CHECKLIST IN ERGO).
   */
  workspaceTools?: boolean;
  /**
   * The project's learned rules for this task (formatProjectRules, a few hundred tokens): every agent of the run gets
   * them as a PROJECT RULES section, and verifier checks them.
   */
  projectRules?: string;
}

export interface CliWorkerPiece {
  id: string;
  title: string;
  instructions: string;
  files: string[];
}

/** Hard cap on workers per run, whatever the settings say. */
const MAX_DELEGATED_WORKERS = 8;
const WORKER_ID_RE = /^[A-Za-z0-9_-]{1,12}$/;
/** Keep any single argv entry well under Linux's 128 KiB MAX_ARG_STRLEN. */
const MAX_INSTRUCTIONS_CHARS = 12_000;
const MAX_FILES_PER_WORKER = 60;
const MAX_COMPLETION_IN_VERIFIER_PROMPT = 12_000;
const MAX_OVERVIEW_IN_WORKER_PROMPT = 4_000;
const MAX_MEMORY_HITS_IN_PROMPT = 4;
const MAX_MEMORY_HIT_CHARS = 240;
const MAX_RELATED_CONTEXT_CHARS = 2_100;

function runFile(ctx: Pick<CliRunPromptContext, 'runDirRel'>, name: string): string {
  return `${ctx.runDirRel.replace(/\/+$/, '')}/${name}`;
}

/** Memory doc id the bridge gives a run file it ingests (see vite.config.ts): `run:<runId>:<file name>`. */
export function runMemoryDocId(runId: string, fileName: string): string {
  return `run:${runId}:${fileName.replace(/^.*\//, '')}`;
}

function memoryOn(ctx: Pick<CliRunPromptContext, 'memoryToolsAvailable'>): boolean {
  return ctx.memoryToolsAvailable !== false;
}

/**
 * ERGO MEMORY (+ RELEVANT MEMORY) sections. Kept terse: the prompt is re-read on every agent turn.
 * `reportFile` is the signal file this agent must still WRITE.
 */
function buildMemorySections(ctx: CliRunPromptContext, reportFile: string): string[] {
  const sections: string[] = [];
  const dir = ctx.runDirRel.replace(/\/+$/, '');
  if (memoryOn(ctx)) {
    sections.push(
      `ERGO MEMORY (tools memory_search, memory_get, memory_save; pass run_id: "${ctx.runId}"):\n` +
      `- Search memory before re-reading many files or redoing analysis; memory_get <id> gives the full text.\n` +
      `- Save important findings, decisions and plans with memory_save, not note files. If the tools are unavailable, write notes under "${dir}/notes/".\n` +
      `- Run reports (plan, workers, verifier, completion) are in memory: never read files in "${dir}/" unless the tools are unavailable. Still WRITE "${reportFile}": it is Ergo's signal.`
    );
  }
  const hits = (ctx.memoryHits || []).filter((h) => h && h.id && h.text).slice(0, MAX_MEMORY_HITS_IN_PROMPT);
  if (hits.length > 0) {
    sections.push(
      `RELEVANT MEMORY (pre-fetched${memoryOn(ctx) ? '; memory_get <id> for the full text' : ''}):\n` +
      hits.map((h) => `- [${oneLine(h.id, 120)}] ${oneLine(h.label, 80)} — ${oneLine(h.text, MAX_MEMORY_HIT_CHARS)}`).join('\n')
    );
  }
  return sections;
}

/**
 * FINDING CODE section: code_search first for every lookup, grep only as the fallback, and enough surrounding code read
 * before changing anything. `edits`: the agent changes code (Verifier only verifies). Empty without a code index.
 */
function buildCodeSearchSection(ctx: Pick<CliRunPromptContext, 'codeSearchAvailable' | 'codeSearchPath'>, edits: boolean): string[] {
  if (!ctx.codeSearchAvailable) return [];
  const pathNote = ctx.codeSearchPath ? ` If it asks for a folder, pass path "${ctx.codeSearchPath}".` : '';
  return [
    `FINDING CODE — code_search FIRST, every time:\n` +
    `- Whenever you need to locate code — at the start and at every later point (definitions, callers, related state, styles, tests) — call code_search first. ` +
    `Describe what you need in plain words and/or name identifiers; it returns the best-matching code with line numbers, surrounding lines and each file's outline.${pathNote}\n` +
    `- Exact names count: code_search matches identifiers by keyword, so look a function, component, type or CSS class up with code_search before grepping the repository for it. (grep inside a file you have already found, to jump to a line, is fine.)\n` +
    `- If the results don't show what you need, search again with different words or the identifiers you have seen.\n` +
    `- Fall back to grep / find / ls across the repository only when code_search can't find what you need after that — for example when you need every call site of something, which a ranked search can't guarantee.\n` +
    (edits
      ? `READ ENOUGH CONTEXT BEFORE YOU CHANGE CODE:\n` +
        `- Search results are entry points, not the whole picture. Before editing, read the complete function or component you will change, where its inputs come from and where its result is used (search for its callers), and the state, types and styles it depends on.\n` +
        `- Settle on a fix only once you understand that flow end to end, and fix the root cause rather than working around it.`
      : `READ ENOUGH CONTEXT BEFORE YOU JUDGE:\n` +
        `- Search results are entry points. Read each changed function or component in full, plus its callers and the state it depends on, before deciding whether it is correct.`),
  ];
}

/**
 * LIKELY FILES section: the scout's file list, paths only. (Its reasons are left out on purpose: passed along, they
 * decided how managers read an ambiguous task.) Empty without a list or a code index.
 */
function buildLikelyFilesSection(ctx: Pick<CliRunPromptContext, 'codeSearchAvailable' | 'likelyFiles'>): string[] {
  if (!ctx.codeSearchAvailable || !ctx.likelyFiles?.length) return [];
  return [
    `LIKELY FILES (a quick scout found these files relevant to the task; it did not decide what to change):\n` +
    ctx.likelyFiles.map((f) => `- ${f}`).join('\n') +
    `\nStart with these: pass them as "files" to code_search to search only within them. If something you need isn't in them, ` +
    `search the whole repository (code_search without "files").`,
  ];
}

/**
 * RELATED TASKS section (empty when the run has no selected related tasks). Under a working brief, which already
 * carries their facts, only the one-line index of its sources.
 */
function buildRelatedSection(ctx: Pick<CliRunPromptContext, 'relatedContext' | 'relatedSources'>, brief?: AgentContextItem): string[] {
  const sources = (ctx.relatedSources || '').trim();
  if (sources && isTaskBrief(usableOverview(brief))) return [`BRIEF SOURCES (related tasks and notes the brief was built from): ${sources}`];
  const text = (ctx.relatedContext || '').trim();
  if (!text) return [];
  const capped = text.length > MAX_RELATED_CONTEXT_CHARS ? `${text.slice(0, MAX_RELATED_CONTEXT_CHARS - 1)}…` : text;
  return [
    `RELATED TASKS (context from this project — read before starting):\n` +
    `Tasks and notes from this project that were judged to explain this one. Read this task in their light, especially when its own text is short: ` +
    `open items here that this task points at are most likely what the user means by it, done work shows what exists to reuse, ` +
    `and notes and pending tasks are constraints to respect (e.g. something that must not be removed yet). ` +
    `Do not take on separate work that merely shares the area.\n${capped}`,
  ];
}

/** Collapse any whitespace (incl. newlines) so text can be typed into a TUI as one line. */
function oneLine(text: string, max = 200): string {
  const flat = String(text ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const COMPLETION_FORMAT = COMPLETION_RECORD_FORMAT;

/** question.md headings, in order (parseQuestionFile reads them). */
const QUESTION_FILE_FORMAT =
  `QUESTION: <the decision you need, as one short question>\n` +
  `DONE SO FAR: <what works now>\n` +
  `BLOCKED ON: <the one thing>\n` +
  `OPTIONS:\n` +
  `1. <choice> (recommended) — <one-line trade-off>\n` +
  `2. <choice> — <one-line trade-off>\n` +
  `DEFAULT: <what you will do if there is no answer>`;

/** How a CLI manager asks the user (QUESTION_RULES) and through which channel Ergo can show it. */
function buildCliQuestionSection(ctx: Pick<CliRunPromptContext, 'runDirRel' | 'questionFile'>): string {
  if (!ctx.questionFile) {
    return (
      `${QUESTION_RULES}\n` +
      `- How: if your CLI has its own question tool (Claude Code: AskUserQuestion), use it — Ergo shows it to the user. Otherwise write the question as your whole reply and end your turn. The answer is typed into this terminal.`
    );
  }
  const questionFile = runFile(ctx, 'question.md');
  return (
    `${QUESTION_RULES}\n` +
    `- How: use your normal file-write tool to write "${questionFile}" (overwrite it for a later question) in exactly this format, then END YOUR TURN and wait — do not use a built-in question tool, and do not keep working on the blocked part:\n` +
    `${QUESTION_FILE_FORMAT}\n` +
    `- Ergo shows it to the user and types the answer into this terminal as a message starting with "Ergo: the user answered". Then continue the task.`
  );
}

/** A manager's question.md as Ergo shows it: the question, its options, and one context line. */
export function parseQuestionFile(content: string): { question: string; options: string[]; context: string } {
  const lines = String(content || '').replace(/\r/g, '').split('\n');
  const field = (name: string) => {
    const re = new RegExp(`^\\s*(?:[-*]\\s*)?\\**${name}\\**\\s*:\\**\\s*(.*)$`, 'i');
    for (const l of lines) {
      const m = l.match(re);
      if (m) return m[1].replace(/\*\*/g, '').trim();
    }
    return '';
  };
  const options: string[] = [];
  const optStart = lines.findIndex((l) => /^\s*(?:[-*]\s*)?\**options\**\s*:/i.test(l));
  if (optStart !== -1) {
    for (let i = optStart + 1; i < lines.length; i++) {
      const l = lines[i].trim();
      if (!l) continue;
      if (/^(?:[-*]\s*)?\**(?:default|question|done so far|blocked on)\**\s*:/i.test(l)) break; // the next heading (DEFAULT: …)
      const opt = l.replace(/^(?:\d+[.)]|[-*•])\s*/, '').trim();
      if (opt) options.push(clipLine(opt, 200));
      if (options.length === 4) break;
    }
  }
  const question = field('question');
  const done = field('done so far');
  const blocked = field('blocked on');
  const fallback = field('default');
  const end = (t: string) => (/[.!?]$/.test(t) ? t : `${t}.`);
  const context = [done && `Done so far: ${end(done)}`, blocked && `Blocked on: ${end(blocked)}`, fallback && `Default if unanswered: ${end(fallback)}`]
    .filter(Boolean)
    .join(' ');
  if (!question) {
    // Not in the expected shape: shown as written.
    return { question: clipLine(lines.map((l) => l.trim()).filter(Boolean).join(' '), 600), options: [], context: '' };
  }
  return { question: clipLine(question, 300), options, context: clipLine(context, 400) };
}

function clipLine(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** One-line message Ergo types into the manager with the user's answer to its question.md. */
export function buildQuestionAnswerMessage(question: string, answer: string): string {
  return oneLine(
    `Ergo: the user answered your question ("${oneLine(question, 300)}"): ${oneLine(answer, MAX_FOLLOW_UP_CHARS)} — continue the task with this answer.`,
    MAX_FOLLOW_UP_CHARS + 500
  );
}

/**
 * Prompt for the manager agent of a CLI task run: the task itself plus Ergo's run protocol
 * (optional delegation via delegate.json, final completion record in completion.md).
 */
/** The PROJECT RULES section (learned rules), or nothing. */
function buildProjectRulesSection(ctx: Pick<CliRunPromptContext, 'projectRules'>): string[] {
  const rules = (ctx.projectRules || '').trim();
  return rules ? [rules] : [];
}

/**
 * CHECKLIST IN ERGO: a manager with the workspace tools checks off the task's open checklist items in Ergo as it
 * finishes them (the user sees them struck through on the board); the run's completion checks off the rest.
 */
function buildChecklistToolSection(task: TaskItem, ctx: Pick<CliRunPromptContext, 'workspaceTools'>): string[] {
  if (!ctx.workspaceTools) return [];
  const open = (task.subtasks || []).map((s, i) => ({ s, i })).filter(({ s }) => !s.isDone && !s.isHumanReview);
  if (open.length === 0) return [];
  return [
    `CHECKLIST IN ERGO:\n` +
    `The checklist above is the user's task list in Ergo. Each time you finish one of its open items (implemented and verified), check it off right away ` +
    `with the workspace_update_subtask tool (ergo-memory MCP server): taskId "${task.id}", the item's subtaskIndex below, isDone true. ` +
    `Check an item only once it is really done; never uncheck items or change anything else on the board. Ergo checks off the task itself when the run completes.\n` +
    open.map(({ s, i }) => `- subtaskIndex ${i}: ${oneLine(s.text, 200)}`).join('\n'),
  ];
}

export function buildManagerCliPrompt(task: TaskItem, brief: AgentContextItem | undefined, ctx: CliRunPromptContext): string {
  const sections = buildTaskContentSections(task, brief);
  const delegateFile = runFile(ctx, 'delegate.json');
  const completionFile = runFile(ctx, 'completion.md');
  const maxWorkers = Math.min(MAX_DELEGATED_WORKERS, Math.max(0, Math.floor(ctx.maxWorkers || 0)));
  const canDelegate = maxWorkers >= 2;
  const keyedToBrief = isTaskBrief(usableOverview(brief));

  sections.push(...buildRelatedSection(ctx, brief));
  sections.push(...formatReferenceSections(ctx.references, { workspaceTools: Boolean(ctx.workspaceTools) }));
  sections.push(...buildProjectRulesSection(ctx));

  sections.push(
    `YOUR ROLE:\n` +
    `You are the MANAGER agent of an Ergo task run (run id ${ctx.runId}). Ergo is the app that launched you; it watches ` +
    `files you write into the run folder "${ctx.runDirRel}/" (relative to your current working directory) to know what you are doing. ` +
    `Ergo has already created that folder. You own this task end to end: understand it, get it implemented, verify it, and record the result.`
  );

  sections.push(...buildMemorySections(ctx, completionFile));
  sections.push(...buildLikelyFilesSection(ctx));
  sections.push(...buildCodeSearchSection(ctx, true));

  sections.push(
    `HOW TO WORK:\n` +
    (ctx.codeSearchAvailable
      ? `1. Find the relevant code with code_search (see FINDING CODE) and read enough around it to understand the flow; check the project's conventions and how tests/build/lint are run before changing anything.\n`
      : `1. Inspect the repository first (structure, conventions, existing code, how tests/build/lint are run) before changing anything.\n`) +
    (keyedToBrief
      ? `2. Implement what the working brief's Scope and "Done when" require, and every checklist item, within its Constraints. Follow the project's existing style.\n`
      : `2. Implement every change the task needs so that all objectives and checklist items are satisfied. Follow the project's existing style.\n`) +
    `3. Verify your work: run the relevant tests, build, type-check and/or lint commands that exist in this project and fix what fails. If nothing can be run, verify by re-reading the changed code against the requirements.\n` +
    `4. Write the completion record (see FINAL STEP). That is the last thing you do.\n` +
    `Do not ask the user for confirmation of the plan — proceed autonomously.`
  );

  sections.push(...buildChecklistToolSection(task, ctx));

  sections.push(buildCliQuestionSection(ctx));

  if (canDelegate) {
    sections.push(
      `OPTIONAL — DELEGATING TO WORKER AGENTS:\n` +
      `Ergo can run up to ${maxWorkers} worker agents in parallel for you. Each worker is a separate CLI agent process like you, started in the same working directory, that sees ONLY the instructions you write for it (not this prompt, not your conversation).\n` +
      `- Delegate ONLY when the task clearly splits into independent pieces of real size, each touching a DISJOINT set of files (no file may appear in two pieces). For small or tightly coupled tasks, do all the work yourself and never create the delegation file.\n` +
      `- Delegate at most ONCE per run. Anything left afterwards you do yourself.\n` +
      `- To delegate, first finish your investigation, then use your normal file-write tool to create the file "${delegateFile}" containing ONLY valid JSON in exactly this shape:\n` +
      `{"workers":[{"id":"W1","title":"Short title","instructions":"Complete, self-contained instructions…","files":["src/path/a.ts","src/path/b.ts"]}]}\n` +
      `  • "id": short unique id using only letters, digits, "-" or "_" (max 12 characters), e.g. W1, W2.\n` +
      `  • "instructions": everything the worker needs — what to build, relevant context and conventions, exact interfaces/function signatures it must match or provide for the other pieces, and how to verify its piece.\n` +
      `  • "files": every file path (relative to the working directory) the worker may create or modify. The worker will touch nothing else.\n` +
      `  • At most ${maxWorkers} workers.\n` +
      `- Right after writing "${delegateFile}", END YOUR TURN and wait. Do not poll for results, do not run sleep or watch commands, and do not edit any file assigned to a worker while the workers run. ` +
      (memoryOn(ctx)
        ? `When all workers have finished, Ergo will type a message into this terminal starting with "Ergo:" that gives each worker's status and the memory id of its report. ` +
          `Then read every report with memory_get, `
        : `When all workers have finished, Ergo will type a message into this terminal starting with "Ergo:" that lists each worker's report file. ` +
          `Then read every report, `) +
      `review and integrate the workers' changes (fix anything incomplete or inconsistent yourself, and do any piece a worker failed), verify the whole task, and continue with the FINAL STEP.`
    );
  } else {
    sections.push(
      `WORKERS:\n` +
      `Delegation to worker agents is not available in this run. Do all the work yourself and do not create "${delegateFile}".`
    );
  }

  if (ctx.verifierEnabled) {
    sections.push(
      `Verifier VERIFICATION:\n` +
      `After you write the completion record, an independent verifier agent will check your work against the task. ` +
      `If it finds problems, Ergo will type a message into this terminal starting with "Ergo:" that points to the verifier findings${memoryOn(ctx) ? ' in memory' : ' file'}. ` +
      `When that happens: read the findings, fix every issue it lists, re-verify, and then OVERWRITE "${completionFile}" with an updated, complete completion record as your last action again. ` +
      `Until then (after writing the completion record) simply end your turn and wait.`
    );
  }

  sections.push(
    `FINAL STEP — COMPLETION RECORD (REQUIRED):\n` +
    `When the work is implemented and verified, use your normal file-write tool to create the file "${completionFile}" as your LAST action. ` +
    `Write it in one go, only once the work is really finished (Ergo treats the moment this file appears as "the manager is done"). ` +
    `It is a short note for a human to scan in a few seconds and confirm the work — NOT a log. Use exactly these headings, in this order:\n\n` +
    `${COMPLETION_FORMAT}\n\n` +
    `${COMPLETION_RECORD_RULES} ` +
    `If something is unfinished or failed, say so in the Done line and put what is left under Needs your review. ` +
    `If your current permission mode does not let you write files (e.g. plan / read-only mode), put the same short record in your final reply instead. ` +
    `After writing the file, reply with one short sentence and end your turn.`
  );

  return sections.join('\n\n');
}

/** Prompt for one worker agent: its piece only, its files only, report in worker-<id>.md. */
export function buildWorkerCliPrompt(
  task: TaskItem,
  brief: AgentContextItem | undefined,
  piece: CliWorkerPiece,
  ctx: CliRunPromptContext
): string {
  const reportFile = runFile(ctx, `worker-${piece.id}.md`);
  const sections: string[] = [];
  const overview = (brief?.overview || brief?.brief || '').trim();

  sections.push(
    `YOUR ROLE:\n` +
    `You are WORKER ${piece.id} in an Ergo task run (run id ${ctx.runId}). A manager agent split the task "${task.title}" into pieces; ` +
    `other workers are implementing the other pieces at the same time in this same working directory. You do ONLY your piece.`
  );

  sections.push(...buildMemorySections(ctx, reportFile));
  sections.push(...buildCodeSearchSection(ctx, true));

  sections.push(`YOUR PIECE: ${piece.id} — ${piece.title}\n\n${piece.instructions.trim()}`);

  sections.push(
    piece.files.length > 0
      ? `FILES YOU MAY CREATE OR MODIFY (paths relative to your working directory; no others):\n${piece.files.map((f) => `- ${f}`).join('\n')}`
      : `FILES:\nThe manager did not list files for this piece. Change only the smallest set of files your piece clearly needs, and do not edit files that belong to other parts of the task.`
  );

  if (overview) {
    const excerpt = overview.length > MAX_OVERVIEW_IN_WORKER_PROMPT ? `${overview.slice(0, MAX_OVERVIEW_IN_WORKER_PROMPT)}\n…` : overview;
    sections.push(`OVERALL TASK CONTEXT (for background only — do not work on anything outside your piece):\n${excerpt}`);
  }

  sections.push(...buildRelatedSection(ctx, brief));
  sections.push(...buildProjectRulesSection(ctx));

  sections.push(
    `RULES:\n` +
    `- Read any file you need, but create, modify or delete ONLY the files listed above. Other workers own the other files; editing them would corrupt their work.\n` +
    `- If your piece needs a change in a file you do not own, do not make it — describe the exact change needed in your report instead.\n` +
    `- Do not delegate, do not start other agents, do not create git commits, and do not write any other file in "${ctx.runDirRel}/" besides your report${memoryOn(ctx) ? ' (and notes/, only if the memory tools are unavailable)' : ''}.\n` +
    `- Work autonomously; do not ask the user questions. If something is ambiguous, make the most reasonable choice and note it in your report.\n` +
    `- Verify your piece where you can (type-check, targeted tests, build) without editing files you don't own.`
  );

  sections.push(
    `FINAL STEP — REPORT (REQUIRED):\n` +
    `When your piece is done, use your normal file-write tool to create "${reportFile}" as your LAST action (Ergo treats its appearance as "worker ${piece.id} is done"). ` +
    `A short report (under 100 words, no code or command output) with these sections:\n\n` +
    `**What I did:** <one or two sentences>\n\n` +
    `**Files touched:**\n- \`path/to/file\` — created / modified / deleted, a few words\n\n` +
    `**Verified:** <one line: check and result, or "Not verified: <why>">\n\n` +
    `**Left for the manager:**\n- unfinished parts or changes needed in files you don't own — or "Nothing"\n\n` +
    `Then end your turn without a further summary.`
  );

  return sections.join('\n\n');
}

/** Prompt for the verifier agent: verify (never implement), write qa.md with the VERDICT line first. */
export function buildVerifierCliPrompt(
  task: TaskItem,
  brief: AgentContextItem | undefined,
  ctx: CliRunPromptContext & { completionMarkdown: string; attempt: number }
): string {
  const verifierFile = runFile(ctx, 'qa.md');
  const completionFile = runFile(ctx, 'completion.md');
  const keyedToBrief = isTaskBrief(usableOverview(brief));
  const sections: string[] = [];

  sections.push(
    `YOUR ROLE:\n` +
    `You are the independent verifier VERIFIER of an Ergo task run (run id ${ctx.runId}, verifier round ${Math.max(1, ctx.attempt)}). ` +
    `A manager agent says it finished the task below. Your job is to find out whether that is true. ` +
    `You VERIFY ONLY: do NOT implement fixes, do NOT edit, create or delete project files, and do NOT create git commits. ` +
    `The only file you write is your report "${verifierFile}".`
  );

  sections.push(...buildMemorySections(ctx, verifierFile));
  sections.push(...buildCodeSearchSection(ctx, false));

  sections.push(...buildTaskContentSections(task, brief, 'TASK UNDER REVIEW'));
  sections.push(...buildProjectRulesSection(ctx));

  const completion = (ctx.completionMarkdown || '').trim();
  const completionSource = memoryOn(ctx)
    ? `memory_get "${runMemoryDocId(ctx.runId, 'completion.md')}"`
    : `read ${completionFile}`;
  const completionExcerpt = completion.length > MAX_COMPLETION_IN_VERIFIER_PROMPT
    ? `${completion.slice(0, MAX_COMPLETION_IN_VERIFIER_PROMPT)}\n… (truncated — ${completionSource} for the full record)`
    : completion || `(empty — ${completionSource} if it exists)`;
  sections.push(`MANAGER'S COMPLETION RECORD (${completionFile}):\n${completionExcerpt}`);

  if (ctx.attempt > 1) {
    sections.push(
      `PREVIOUS verifier ROUND:\n` +
      `This is a re-check after the manager tried to fix earlier verifier findings. ` +
      (memoryOn(ctx)
        ? `Get the previous report with memory_get "${runMemoryDocId(ctx.runId, 'qa.md')}" first, `
        : `"${verifierFile}" may still hold the previous report: read it first, `) +
      `confirm each earlier finding is really fixed, then look for new problems. Overwrite "${verifierFile}" completely with your new report.`
    );
  }

  sections.push(
    `HOW TO VERIFY:\n` +
    `1. Inspect the changed files listed in the completion record (and anything else the task touches) and compare them with the task requirements.\n` +
    `2. Run the project's relevant checks that exist — tests, build, type-check, lint — and note the exact commands and results. Running them may create build output; that's fine, but do not change source files.\n` +
    `3. Check every ${keyedToBrief ? '"Done when" item and Constraint in the working brief and every ' : ''}checklist item, ${ctx.projectRules?.trim() ? 'every PROJECT RULE that applies to the change, ' : ''}and whether each claim in the completion record is true (files really exist and contain what is claimed, commands really pass).\n` +
    `4. Be strict but fair: FAIL only for real problems (a requirement not met, a broken build/test, a bug, a false claim, missing files). Style nits alone are not a failure; mention them as notes.\n` +
    `Work autonomously; do not ask the user questions.`
  );

  sections.push(
    `FINAL STEP — verifier REPORT (REQUIRED):\n` +
    `Use your normal file-write tool to create "${verifierFile}" as your LAST action (Ergo reads the verdict from it). ` +
    `The FIRST line must be exactly "VERDICT: PASS" or "VERDICT: FAIL" (nothing before it). Then markdown:\n\n` +
    `VERDICT: <PASS or FAIL>\n\n` +
    `**Checks run:** <one line: commands / checks and their results>\n\n` +
    `**Findings:**\n- [ ] <problem> — where (file:line) — the fix (one line each, at most 5)\n\n` +
    `Keep it under 150 words, no command output. For a PASS, write "None" under Findings. Each FAIL finding must be specific enough for the manager to fix without guessing. ` +
    `After writing the file, end your turn without a further summary.`
  );

  return sections.join('\n\n');
}

/**
 * One-line message Ergo types into the manager's terminal once every delegated worker has finished
 * (or failed). Contains no newlines; Ergo sends Enter separately.
 */
export function buildWorkersDoneMessage(
  results: Array<{ pieceId: string; title: string; fileRel: string; ok: boolean }>,
  ctx: CliRunPromptContext
): string {
  const completionFile = runFile(ctx, 'completion.md');
  if (results.length === 0) {
    return oneLine(
      `Ergo: no valid workers could be started from ${runFile(ctx, 'delegate.json')} (it was empty or invalid), so nothing was delegated. ` +
      `Do all of the remaining work yourself (do not delegate again), verify it, then write ${completionFile} as your final action.`,
      1500
    );
  }
  const failed = results.filter((r) => !r.ok);
  const head = failed.length === 0
    ? `Ergo: all ${results.length} worker${results.length === 1 ? ' has' : 's have'} finished.`
    : `Ergo: all workers have stopped — ${results.length - failed.length} of ${results.length} finished, ${failed.length} failed.`;
  const integrate =
    `review and integrate the workers' changes${failed.length > 0 ? ', complete the failed piece(s) yourself' : ''}, ` +
    `fix anything incomplete or inconsistent, verify the whole task, then write ${completionFile} as your final action.`;
  if (!memoryOn(ctx)) {
    const parts = results.map((r) =>
      r.ok
        ? `${oneLine(r.pieceId, 12)} "${oneLine(r.title, 60)}" finished, report in ${oneLine(r.fileRel, 160)}`
        : `${oneLine(r.pieceId, 12)} "${oneLine(r.title, 60)}" FAILED (stopped without a report; ${oneLine(r.fileRel, 160)} may be missing or partial)`
    );
    return oneLine(`${head} ${parts.join('; ')}. Read each report, ${integrate}`, 4000);
  }
  const parts = results.map((r) => {
    const id = runMemoryDocId(ctx.runId, oneLine(r.fileRel, 160));
    return r.ok
      ? `${oneLine(r.pieceId, 12)} "${oneLine(r.title, 60)}" done (report: ${id})`
      : `${oneLine(r.pieceId, 12)} "${oneLine(r.title, 60)}" FAILED (stopped; report ${id} may be missing or partial)`;
  });
  return oneLine(
    `${head} ${parts.join('; ')}. Read the reports with memory_get (or memory_search kinds=["worker"] scope="run" run_id="${ctx.runId}"); ` +
    `only if the memory tool is unavailable, read the worker-<id>.md files in ${ctx.runDirRel}/. Then ${integrate}`,
    4000
  );
}

/**
 * One-line message Ergo types into the manager's terminal after a verifier FAIL that still has fix rounds left.
 * Points to the findings in memory (the file only as a fallback); without `ctx.runId` it is read from the path.
 */
export function buildVerifierFailMessage(
  verifierFileRel: string,
  attempt: number,
  maxRetries: number,
  ctx: Partial<Pick<CliRunPromptContext, 'runId' | 'memoryToolsAvailable'>> = {}
): string {
  const verifier = oneLine(verifierFileRel, 200);
  const slash = verifier.lastIndexOf('/');
  const completionFile = slash >= 0 ? `${verifier.slice(0, slash)}/completion.md` : 'completion.md';
  const round = Math.max(1, Math.floor(attempt) || 1);
  const max = Math.max(round, Math.floor(maxRetries) || round);
  const runId = ctx.runId || (slash > 0 ? verifier.slice(0, slash).replace(/^.*\//, '') : '');
  const findings = runId && memoryOn(ctx)
    ? `Get the findings with memory_get "${runMemoryDocId(runId, verifier)}" (only if the memory tool is unavailable, read ${verifier})`
    : `Read the findings in ${verifier}`;
  return oneLine(
    `Ergo: the verifier FAILED your work (fix round ${round} of ${max}). ${findings}, fix every issue listed, ` +
    `re-run the relevant checks, then overwrite ${completionFile} with an updated complete completion record as your final action; ` +
    `Verifier will check again after that.`,
    1500
  );
}

/** Most characters of a user's follow-up message typed into an agent's terminal. */
const MAX_FOLLOW_UP_CHARS = 3000;

/**
 * One-line message Ergo types into (or resumes) the manager with when the user sends a follow-up after the run
 * finished: the user's words first, then a short reminder of the run protocol so Ergo can tell when it is done again.
 */
export function buildFollowUpMessage(userMessage: string, ctx: Pick<CliRunPromptContext, 'runDirRel' | 'verifierEnabled' | 'maxWorkers'>): string {
  const completionFile = runFile(ctx, 'completion.md');
  const delegation =
    Math.floor(ctx.maxWorkers || 0) >= 2
      ? ` If it is large and splits into independent pieces you may delegate again by writing a new ${runFile(ctx, 'delegate.json')}.`
      : '';
  return oneLine(
    `${oneLine(userMessage, MAX_FOLLOW_UP_CHARS)} ` +
    `(Ergo: this is a follow-up from the user on the task you already finished — continue from where you left off, do not start over.${delegation} ` +
    `When it is done and verified, overwrite ${completionFile} with an updated completion record covering this follow-up as your final action${ctx.verifierEnabled ? '; verifier will check it again' : ''}.)`,
    MAX_FOLLOW_UP_CHARS + 900
  );
}

/** What a stopped run's manager was waiting on when it was stopped (Ergo restarts it on resume). */
export type ResumeWaitingOn = 'workers' | 'verifier' | undefined;

function resumeWaitNote(waitingOn: ResumeWaitingOn, ctx: Pick<CliRunPromptContext, 'runDirRel'>): string {
  if (waitingOn === 'verifier') {
    return `You had already written ${runFile(ctx, 'completion.md')} and were waiting on the verifier: Ergo has restarted it. Change nothing; wait for its "Ergo:" message.`;
  }
  if (waitingOn === 'workers') {
    return `You were waiting on your workers: Ergo has restarted the ones that had not reported. Do not redo their pieces; wait for the "Ergo:" message saying they finished.`;
  }
  return '';
}

/**
 * One-line message a stopped run's manager is resumed with (its own conversation, so it remembers the work): carry
 * on exactly where it was interrupted. `workersDone` is the hand-off for workers that reported while it was stopped.
 */
export function buildResumeMessage(
  ctx: Pick<CliRunPromptContext, 'runDirRel' | 'verifierEnabled'>,
  opts: { userMessage?: string; waitingOn?: ResumeWaitingOn; workersDone?: string } = {}
): string {
  const completionFile = runFile(ctx, 'completion.md');
  const user = String(opts.userMessage || '').trim();
  const wait = resumeWaitNote(opts.waitingOn, ctx);
  return oneLine(
    `Ergo: the user stopped this run partway and has now resumed it. Continue exactly where you left off — do not start over, and check the files you were editing, since your last step may have been cut off. ` +
    (user ? `The user's message: "${oneLine(user, MAX_FOLLOW_UP_CHARS)}". ` : '') +
    (opts.workersDone ? `${opts.workersDone} ` : wait ? `${wait} ` : '') +
    (opts.waitingOn === 'verifier' ? '' : `When the task is done and verified, write ${completionFile} (overwrite it if it exists) as your final action${ctx.verifierEnabled ? '; verifier will check it' : ''}.`),
    MAX_FOLLOW_UP_CHARS + 6000
  );
}

/**
 * Prompt for a NEW manager that picks up a stopped run whose own conversation can't be resumed: a short note on
 * top of the run's original manager prompt (the earlier work is in the repository; continue it, don't start over).
 */
export function buildResumedManagerPrompt(
  originalPrompt: string,
  ctx: Pick<CliRunPromptContext, 'runDirRel'>,
  opts: { userMessage?: string; waitingOn?: ResumeWaitingOn } = {}
): string {
  const user = String(opts.userMessage || '').trim();
  const wait = resumeWaitNote(opts.waitingOn, ctx);
  const head =
    `RESUMING A STOPPED RUN:\n` +
    `An earlier manager started this task and the user stopped it partway. Its work so far is already in the repository (and possibly in ` +
    `"${ctx.runDirRel}/"). Before changing anything, inspect the current state of the files the task touches, keep what is done and works, ` +
    `and continue from there. Do not start the task over.` +
    (wait ? `\n${wait}` : '') +
    (user ? `\n\nTHE USER'S MESSAGE ON RESUMING:\n${user.slice(0, MAX_FOLLOW_UP_CHARS)}` : '');
  return `${head}\n\n${originalPrompt}`;
}

/** Note on top of the prompt of a worker restarted after its run was stopped. */
export function buildResumedWorkerNote(): string {
  return (
    `RESUMING: you started this piece earlier and the run was stopped before you reported. Some of your changes may already be in the ` +
    `files below: check their current state first and continue from there rather than starting over.`
  );
}

/**
 * Prompt for a NEW manager that continues a finished run whose own conversation can't be resumed (the CLI has no
 * resumable session id, or the process and its id are gone): the task, what was done so far (the completion log and
 * files), the user's follow-up and the run protocol. Compact on purpose — the original task prompt is not repeated.
 */
export function buildContinuationPrompt(
  task: TaskItem,
  ctx: CliRunPromptContext,
  prior: { userMessage: string; completionLog?: string; createdFiles?: string[] }
): string {
  const completionFile = runFile(ctx, 'completion.md');
  const delegateFile = runFile(ctx, 'delegate.json');
  const sections: string[] = [];
  sections.push(`TASK (already worked on — this is a continuation): "${task.title}"`);
  const subtasks = (task.subtasks || []).filter((s) => !s.isHumanReview).map((s) => `- [${s.isDone ? 'x' : ' '}] ${oneLine(s.text, 200)}`);
  if (subtasks.length) sections.push(`CHECKLIST:\n${subtasks.slice(0, 20).join('\n')}`);
  const log = (prior.completionLog || '').replace(/<!--[\s\S]*?-->/g, '').trim();
  sections.push(
    `WHAT WAS DONE SO FAR (Ergo's completion log for this task):\n${log ? (log.length > 2500 ? `…${log.slice(-2500)}` : log) : '(no completion log was written)'}`
  );
  const files = (prior.createdFiles || []).filter(Boolean).slice(0, 30);
  if (files.length) sections.push(`FILES CREATED OR CHANGED SO FAR:\n${files.map((f) => `- ${f}`).join('\n')}`);
  sections.push(`THE USER'S FOLLOW-UP (what to do now):\n${String(prior.userMessage || '').trim().slice(0, MAX_FOLLOW_UP_CHARS)}`);
  sections.push(...buildRelatedSection(ctx));
  sections.push(...buildProjectRulesSection(ctx));
  sections.push(
    `YOUR ROLE:\n` +
    `You are the MANAGER agent continuing an Ergo task run (run id ${ctx.runId}). The earlier work is already in the repository: ` +
    `inspect the files above before changing anything, keep what works, and do only what the follow-up asks (plus fixing anything it reveals). Do not start the task over. ` +
    `Ergo watches the run folder "${ctx.runDirRel}/" (relative to your working directory).`
  );
  sections.push(...buildMemorySections(ctx, completionFile));
  sections.push(buildCliQuestionSection(ctx));
  if (Math.floor(ctx.maxWorkers || 0) >= 2) {
    sections.push(
      `OPTIONAL — WORKERS: only if the follow-up is large and splits into independent pieces with DISJOINT files, write "${delegateFile}" ` +
      `as {"workers":[{"id":"W1","title":"…","instructions":"complete, self-contained instructions","files":["path"]}]} (at most ${Math.min(MAX_DELEGATED_WORKERS, Math.floor(ctx.maxWorkers))} workers), then end your turn; ` +
      `Ergo types a message starting with "Ergo:" when they finish.`
    );
  }
  if (ctx.verifierEnabled) {
    sections.push(
      `Verifier: after you write the completion record a verifier checks your work; if it fails, Ergo types a message starting with "Ergo:" — fix the findings and overwrite "${completionFile}" again.`
    );
  }
  sections.push(
    `FINAL STEP — COMPLETION RECORD (REQUIRED):\n` +
    `When the follow-up is implemented and verified, write "${completionFile}" (overwrite it) as your LAST action, covering this follow-up, in exactly this format:\n\n` +
    `${COMPLETION_FORMAT}\n\n` +
    `${COMPLETION_RECORD_RULES} Then reply with one short sentence and end your turn.`
  );
  return sections.join('\n\n');
}

/**
 * The CLI's own resumable session id, read from what it prints when it exits — Claude Code "claude --resume <id>",
 * Codex "codex resume <id>", Antigravity "agy --conversation=<id>". Null when none is found.
 */
export function parseCliResumeId(cmd: string, transcript: string): string | null {
  const base = cliBaseName(cmd);
  const text = String(transcript || '');
  const patterns: RegExp[] =
    base === 'agy'
      ? [/--conversation[= ]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi]
      : base === 'codex'
        ? [/codex\s+resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi]
        : base === 'claude'
          ? [/--resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi]
          : [];
  let found: string | null = null;
  for (const re of patterns) {
    for (const m of text.matchAll(re)) found = m[1]; // the last one printed is the latest session
  }
  return found;
}

function sanitizeRelPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let p = raw.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/{2,}/g, '/');
  if (!p || p.length > 300 || /[\0\r\n]/.test(p)) return null;
  p = p.replace(/\/+$/, '');
  return p || null;
}

function sanitizeWorkerId(raw: unknown): string {
  const s = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
  const cleaned = s.replace(/\s+/g, '-').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 12);
  return WORKER_ID_RE.test(cleaned) ? cleaned : '';
}

function mergePiece(into: CliWorkerPiece, from: CliWorkerPiece, reason: string): void {
  into.title = `${into.title} + ${from.title}`.slice(0, 160);
  into.instructions = `${into.instructions}\n\nALSO DO (piece "${from.title}", merged into yours because ${reason}):\n${from.instructions}`.slice(0, MAX_INSTRUCTIONS_CHARS);
  for (const f of from.files) {
    if (!into.files.includes(f) && into.files.length < MAX_FILES_PER_WORKER) into.files.push(f);
  }
}

/**
 * Validate the manager's delegate.json. Accepts `{"workers":[…]}` (or a bare array), drops entries
 * without usable instructions, sanitizes ids to /^[A-Za-z0-9_-]{1,12}$/ (re-numbering invalid or
 * duplicate ones), and keeps file sets disjoint: a piece that shares a file with an earlier piece is
 * merged into it instead of being run in parallel. Pieces beyond min(maxWorkers, 8) are merged into
 * the last allowed piece so no delegated work is silently lost. Returns [] for unusable input.
 */
export function parseDelegatePlan(json: string, maxWorkers: number): CliWorkerPiece[] {
  let data: unknown;
  try {
    const text = String(json ?? '')
      .replace(/^﻿/, '')
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const rawList: unknown[] = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as any).workers)
      ? (data as any).workers
      : data && typeof data === 'object' && Array.isArray((data as any).pieces)
        ? (data as any).pieces
        : [];

  const candidates: CliWorkerPiece[] = [];
  for (const entry of rawList) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const instructionsRaw = typeof e.instructions === 'string' ? e.instructions
      : typeof e.task === 'string' ? e.task
      : typeof e.description === 'string' ? e.description
      : '';
    const titleRaw = typeof e.title === 'string' ? e.title : typeof e.name === 'string' ? e.name : '';
    const instructions = instructionsRaw.trim() || titleRaw.trim();
    if (!instructions) continue;
    const title = oneLine(titleRaw.trim() || instructions, 120);
    const filesRaw = Array.isArray(e.files) ? e.files : typeof e.files === 'string' ? [e.files] : [];
    const files: string[] = [];
    for (const f of filesRaw) {
      const p = sanitizeRelPath(f);
      if (p && !files.includes(p) && files.length < MAX_FILES_PER_WORKER) files.push(p);
    }
    candidates.push({
      id: sanitizeWorkerId(e.id),
      title,
      instructions: instructions.slice(0, MAX_INSTRUCTIONS_CHARS),
      files
    });
  }

  // Keep file sets disjoint: merge a piece into the first earlier piece it shares a file with.
  const disjoint: CliWorkerPiece[] = [];
  for (const piece of candidates) {
    const overlap = disjoint.find((p) => p.files.some((f) => piece.files.includes(f)));
    if (overlap) mergePiece(overlap, piece, 'both pieces edit the same file(s)');
    else disjoint.push({ ...piece, files: [...piece.files] });
  }

  const limit = Math.min(MAX_DELEGATED_WORKERS, Math.max(1, Math.floor(Number(maxWorkers)) || 1));
  const kept = disjoint.slice(0, limit);
  for (const extra of disjoint.slice(limit)) {
    mergePiece(kept[kept.length - 1], extra, `the run allows at most ${limit} worker${limit === 1 ? '' : 's'}`);
  }

  // Unique, valid ids (W<n> for missing / invalid / duplicate ones).
  const used = new Set<string>();
  kept.forEach((piece, idx) => {
    let id = piece.id;
    if (!id || used.has(id.toLowerCase())) {
      let n = idx + 1;
      id = `W${n}`;
      while (used.has(id.toLowerCase())) id = `W${++n}`;
    }
    used.add(id.toLowerCase());
    piece.id = id;
  });

  return kept;
}

export interface CliLaunchPolicy {
  permissionLevel?: PermissionLevel;
  effort?: EffortLevel;
  /** Model name in the CLI's own vocabulary (e.g. "sonnet" for claude, "gemini-3.1-pro-high" for agy). */
  model?: string;
  /** Claude Code session UUID, so Ergo can read token usage from its session log. */
  sessionId?: string;
  /**
   * Resume this CLI conversation instead of starting a new one (the prompt becomes its next user message):
   * claude --resume <id> · codex resume <id> · agy --conversation <id>. Other CLIs ignore it.
   */
  resumeSessionId?: string;
}

/**
 * Flags that set each CLI's approval / sandbox mode — the ones permissionArgsForCli would otherwise add.
 * Per CLI, because short flags mean different things across CLIs (gemini's -s / --sandbox is a container
 * sandbox, not an approval flag). CLIs Ergo adds no permission flags for have no entry.
 */
const PERMISSION_FLAGS_BY_CLI: Record<string, ReadonlySet<string>> = {
  claude: new Set(['--permission-mode', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions']),
  agy: new Set(['--mode', '--dangerously-skip-permissions']),
  codex: new Set(['-s', '--sandbox', '-a', '--ask-for-approval', '--dangerously-bypass-approvals-and-sandbox', '--full-auto', '--yolo']),
  gemini: new Set(['--approval-mode', '--yolo', '-y']),
  aider: new Set(['--yes-always', '--yes']),
  cursor: new Set(['--force', '-f'])
};

/** Lower-case executable name without its directory ("/usr/bin/Claude" → "claude"), as the switches below expect. */
function cliBaseName(cmd: string): string {
  return (cmd || '').toLowerCase().trim().replace(/^.*[\\/]/, '');
}

/** Split a user's extra-args string into argv tokens, honouring "double" and 'single' quotes. */
function tokenizeExtraArgs(extraArgsString: string): string[] {
  const tokens: string[] = [];
  const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec((extraArgsString || '').trim())) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[0]);
  }
  return tokens;
}

function hasPermissionFlag(baseCmd: string, userTokens: string[]): boolean {
  const flags = PERMISSION_FLAGS_BY_CLI[baseCmd];
  if (!flags) return false;
  return userTokens.some((t, i) => {
    if (flags.has(t.split('=')[0])) return true;
    // A short flag with its value attached (codex `-sread-only`, `-anever`).
    if (/^-[A-Za-z]./.test(t) && flags.has(t.slice(0, 2))) return true;
    // codex config overrides: -c approval_policy=… / -c sandbox_mode=… (or --config).
    return baseCmd === 'codex' && i > 0 && (userTokens[i - 1] === '-c' || userTokens[i - 1] === '--config') && /^\s*(approval_policy|sandbox_mode)\s*=/.test(t);
  });
}

/**
 * True when the user's extra args for CLI `cmd` already set one of that CLI's permission flags. Ergo then adds
 * none of its own, so the Permissions slider has no effect on that CLI's launch mode (App warns about this once).
 * Without `cmd`, any CLI's permission flag counts (less precise; pass the command).
 */
export function hasUserPermissionOverride(extraArgs: string, cmd?: string): boolean {
  const tokens = tokenizeExtraArgs(extraArgs);
  if (cmd !== undefined) return hasPermissionFlag(cliBaseName(cmd), tokens);
  return Object.keys(PERMISSION_FLAGS_BY_CLI).some((cli) => hasPermissionFlag(cli, tokens));
}

const CLAUDE_PERMISSION_MODES: Record<PermissionLevel, string> = {
  ask: 'manual',
  acceptEdits: 'acceptEdits',
  plan: 'plan',
  bypass: 'bypassPermissions'
};

/**
 * CLI flags implementing an Ergo permission level for an interactive agent. Each CLI has its own vocabulary:
 * claude --permission-mode, agy --mode / --dangerously-skip-permissions, codex --sandbox/--ask-for-approval,
 * gemini --approval-mode. Returns [] when the user already set a permission flag in their extra args.
 *
 * Claude always gets --allow-dangerously-skip-permissions so bypass stays reachable in its shift+tab mode
 * cycle: the bridge switches a running session's mode live when the user moves Ergo's Permissions slider
 * (Ergo's slider is the only thing that selects bypass).
 */
export function permissionArgsForCli(baseCmd: string, level: PermissionLevel | undefined, userTokens: string[]): string[] {
  if (!level || hasPermissionFlag(baseCmd, userTokens)) return [];
  switch (baseCmd) {
    case 'claude':
      return ['--allow-dangerously-skip-permissions', '--permission-mode', CLAUDE_PERMISSION_MODES[level] || 'acceptEdits'];
    case 'agy':
      if (level === 'plan') return ['--mode', 'plan'];
      if (level === 'acceptEdits') return ['--mode', 'accept-edits'];
      if (level === 'bypass') return ['--dangerously-skip-permissions'];
      return [];
    case 'codex':
      if (level === 'plan') return ['--sandbox', 'read-only', '--ask-for-approval', 'on-request'];
      if (level === 'bypass') return ['--dangerously-bypass-approvals-and-sandbox'];
      return ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'];
    case 'gemini':
      if (level === 'plan') return ['--approval-mode', 'plan'];
      if (level === 'acceptEdits') return ['--approval-mode', 'auto_edit'];
      if (level === 'bypass') return ['--approval-mode', 'yolo'];
      return ['--approval-mode', 'default'];
    case 'aider':
      return level === 'bypass' ? ['--yes-always'] : [];
    case 'cursor':
      return level === 'bypass' ? ['--force'] : [];
    default:
      return [];
  }
}

function effortArgsForCli(baseCmd: string, effort: EffortLevel | undefined, userTokens: string[]): string[] {
  if (!effort) return [];
  if ((baseCmd === 'claude' || baseCmd === 'agy') && !userTokens.includes('--effort')) return ['--effort', effort];
  if (baseCmd === 'codex' && !userTokens.some((t) => t.includes('model_reasoning_effort'))) {
    const codexEffort = effort === 'low' ? 'low' : effort === 'medium' ? 'medium' : 'high';
    return ['-c', `model_reasoning_effort="${codexEffort}"`];
  }
  return [];
}

function modelArgsForCli(baseCmd: string, model: string | undefined, userTokens: string[]): string[] {
  if (!model || userTokens.includes('--model') || userTokens.includes('-m')) return [];
  if (baseCmd === 'claude' || baseCmd === 'agy') return ['--model', model];
  return [];
}

/**
 * Formats command-line arguments for launching a CLI coding agent with a task prompt.
 * Handles specific CLI flags:
 * - agy: uses -i "<prompt>" (runs prompt interactively and keeps session active)
 * - claude: uses positional prompt "<prompt>"
 * - aider: uses --message "<prompt>"
 * - codex / cursor / grok: uses positional prompt
 * Policy flags (permission level, effort, model, session id) are added unless the user's extra args already set them.
 */
export function buildCliArgsForTask(
  cmd: string,
  extraArgsString: string = '',
  prompt: string,
  hasApiKey: boolean = false,
  policy: CliLaunchPolicy = {}
): string[] {
  // Parse extraArgsString into separate tokens, respecting quotes if present
  const userTokens = tokenizeExtraArgs(extraArgsString);

  const baseCmd = cliBaseName(cmd);
  const tokens = [
    ...userTokens,
    ...permissionArgsForCli(baseCmd, policy.permissionLevel, userTokens),
    ...effortArgsForCli(baseCmd, policy.effort, userTokens),
    ...modelArgsForCli(baseCmd, policy.model, userTokens)
  ];

  const resumeId = policy.resumeSessionId && /^[A-Za-z0-9-]{8,64}$/.test(policy.resumeSessionId) ? policy.resumeSessionId : undefined;
  const userResumes = (flags: string[]) => userTokens.some((t) => flags.includes(t.split('=')[0]));

  if (baseCmd === 'agy') {
    if (resumeId && !userResumes(['--conversation', '--continue', '-c'])) tokens.push('--conversation', resumeId);
    // agy takes -i or --prompt-interactive to run initial prompt interactively and continue the session
    const hasPromptFlag = tokens.some(
      (t) => t === '-i' || t === '--prompt-interactive' || t === '-p' || t === '--print' || t === '--prompt'
    );
    if (hasPromptFlag) {
      return [...tokens, prompt];
    }
    return [...tokens, '-i', prompt];
  }

  if (baseCmd === 'claude') {
    // Claude Code accepts positional prompt: claude [options] [prompt]
    const claudeTokens = [...tokens];
    if (hasApiKey && !claudeTokens.includes('--settings')) {
      claudeTokens.push('--settings', '{"apiKeyHelper":""}');
    }
    const resumes = claudeTokens.some((t) => t === '--session-id' || t === '--resume' || t === '-r' || t === '--continue' || t === '-c');
    if (resumeId && !resumes) {
      // Same session id: the conversation (and its session log) continues where it stopped.
      claudeTokens.push('--resume', resumeId);
    } else if (policy.sessionId && !resumes) {
      claudeTokens.push('--session-id', policy.sessionId);
    }
    return [...claudeTokens, prompt];
  }

  if (baseCmd === 'aider') {
    const hasMessageFlag = tokens.some((t) => t === '-m' || t === '--message');
    if (hasMessageFlag) {
      return [...tokens, prompt];
    }
    return [...tokens, '--message', prompt];
  }

  if (baseCmd === 'codex' && resumeId && !userTokens.includes('resume')) {
    // `codex resume <id> [options] [prompt]` takes the same launch options as `codex`.
    return ['resume', resumeId, ...tokens, prompt];
  }

  if (baseCmd === 'codex' || baseCmd === 'cursor' || baseCmd === 'grok') {
    return [...tokens, prompt];
  }

  // Generic fallback
  return [...tokens, prompt];
}
