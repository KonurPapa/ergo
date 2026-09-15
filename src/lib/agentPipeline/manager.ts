/**
 * Step 3 — Manager: decomposition → fan-out workers → verification.
 *
 * The manager is a deterministic harness with LLM calls only at task boundaries:
 *  1. Decompose (one JSON call, read-only tools) the Gherkin scenarios into puzzle pieces.
 *  2. Schedule pieces in dependency waves under the concurrency limit; each piece runs in an
 *     isolated worker sub-agent with a clean context (shared bible prefix + one piece contract),
 *     scoped writes, and file locks. The first worker of a run is started alone to warm the
 *     provider cache before the rest fan out.
 *  3. Verify every scenario against the workspace + event log (JSON), spawning remediation pieces
 *     once if needed.
 *
 * Nothing volatile (timestamps, attempt numbers, run ids) is placed in the cached system blocks;
 * all of that goes into the first user message.
 */
import { type PuzzlePiece, type PuzzlePieceKind, type TokenUsage } from '../../types';
import { parseJsonLoose } from '../llmClient';
import { callMcpTool } from '../mcpClient';
import {
  PIECE_SUMMARY_CHAR_CAP,
  type PipelineContext,
  type ToolDefinition,
  addUsage,
  emptyUsage,
  formatUsage,
  isAbortError,
  resolveRoleTarget,
  throwIfAborted
} from './contracts';
import { type BibleStore, type FileLockRegistry, normalizePath } from './bible';
import { runToolLoop } from './providerLoop';
import { createToolExecutor } from './toolExecutor';
import { loadPipelineSkill } from './skills';
import { verifyDeliverableHealth } from './verifier';

export interface ManagerRunResult {
  pieces: PuzzlePiece[];
  createdFiles: string[];
  allScenariosPass: boolean;
  verificationSummary: string;
  usage: TokenUsage;
  usedToolCalling: boolean;
}

const PIECE_KINDS: PuzzlePieceKind[] = ['given', 'when', 'then', 'edge'];
const MAX_PIECES = 12;

/** Fixed rules appended to the manager skill — byte-stable, nothing run-specific. */
const MANAGER_RULES = `EXECUTION RULES (harness-enforced)
- The bible above is your single source of truth. Its Allowed Boundaries are the only writable locations; the Ergo application codebase is never a target.
- You may inspect the workspace with read-only tools (list_directory, read_file with offset/limit, search_files, get_file_info, git_status, git_diff) and, during verification, execute run_command. You never write files yourself; workers do.
- Respond to decomposition and verification requests with ONLY the JSON object described in your skill — no prose, no fences.
- Every piece's instructions must be self-contained: the worker sees only the bible and that piece.
- Call ask_human only when blocked by a genuine decision no file can answer.`;

/** Fixed rules appended to the worker skill — byte-stable. */
const WORKER_RULES = `EXECUTION RULES (harness-enforced)
- Writes outside your piece's file list, or to files locked by another piece, are rejected with an error that tells you why. Do not retry them; report the needed change in your summary.
- Only paths inside the bible's Allowed Boundaries are writable.
- Tools requiring approval (write_file, edit_file, run_command, git_commit) may pause for the user; a rejection is final for that call.
- Tool results are truncated when large; use read_file offset/limit and search_files contentPattern to narrow.
- End with the condensed summary and the exact final line "STATUS: DONE" or "STATUS: FAILED — <reason>".`;

/** Byte-stable prompt for Direct (Solo) Mode — clean, builder-focused, no decomposition JSON contracts. */
export const MANAGER_DIRECT_STABLE = `You are the Direct Implementation Agent (Solo Execution) in Ergo's Agent Execution Pipeline.
You are executing a straightforward, standalone deliverable task directly without spawning sub-agents.

YOUR MISSION:
1. Review the TASK_CONTEXT bible (Gherkin acceptance criteria, goals, and output destination).
2. Call the write_file tool to write the complete, high-quality, fully functioning deliverable to the exact target destination.
3. MANDATORY COMPLETENESS RULE:
   - Skeletons, placeholder bodies, empty canvases, or partial outlines are STRICTLY PROHIBITED.
   - All checklist goals and acceptance scenarios MUST be fully implemented and working in the deliverable.
   - If the task is a game or interactive application, you must implement the full game loop, player rendering, keyboard input listeners (WASD/arrows), collision detection, scoring, and win states.
   - If the task is writing or research, provide full, finished content rather than placeholders or stubs.
4. If the task is an HTML game, script, or page, include all HTML, CSS, and JavaScript in that file so it executes cleanly and independently in a browser without external CDN dependencies.
5. STRICT VARIABLE DECLARATIONS & STARTUP INTEGRITY:
   - Ensure every variable, constant, and parameter is strictly declared (with let, const, or function args). Never reference undeclared variables (like dx, dy, x, y) that cause runtime ReferenceErrors.
   - All initialization routines, event listeners, and animation loops (initGame, drawPlayer, gameLoop, etc.) must execute cleanly on initial load with 0 console errors. The pipeline automatically boots and smoke-tests every created page and endpoint in a sandboxed runtime before accepting your work.
6. Verify your work with read_file, get_file_info, or run_command if relevant.
7. Reply with a condensed summary of what you built and verified, followed by the final line:
STATUS: DONE
or if genuinely blocked:
STATUS: FAILED — <reason>

CRITICAL HARNESS RULES:
- You MUST call write_file to save your deliverable to disk. Do NOT merely describe the code in your response; write the complete file via write_file.
- Only paths inside the bible's Allowed Boundaries are writable.
- Write ONLY the requested deliverable. Do not create redundant duplicate files or edit workspace markdown documents.`;

export function isStraightforwardTask(bible: BibleStore): boolean {
  const { metadata, subtasks, outputAs } = bible.sections;
  const taskKind = metadata.taskKind;

  // Non-coding tasks with small subtask count
  if (taskKind && taskKind !== 'coding' && subtasks.length <= 3) {
    return true;
  }

  // Summary explicitly flagged task as small/generic needing no hardener
  if (metadata.requiresHardener === false) {
    return true;
  }

  // Standalone single-file deliverable patterns in outputAs or title
  const outputText = (outputAs || '').toLowerCase();
  const titleText = (bible.sections.title || '').toLowerCase();
  const isSingleFileDeliverable =
    /\.(html|htm|jsx|tsx|vue|svelte|py|sh|ts|js|md|json|css|sql|txt|csv|tsv|yaml|yml)\b/i.test(outputText) ||
    /(?:build|create|make)\s+an?\s+(?:html|browser|standalone|simple|2d)?\s*(?:game|page|script|app|tool|website)/i.test(titleText);

  if (isSingleFileDeliverable && subtasks.length <= 3) {
    return true;
  }

  // Tasks with 0 or 1 subtasks
  if (subtasks.length <= 1) {
    return true;
  }

  return false;
}

export function extractTargetFilePaths(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/(?:projects\/[^\s`"'\\]+\.[a-z0-9]+|[^\s`"'\\]+\.(html|htm|jsx|tsx|vue|svelte|py|sh|ts|js|md|json|css|sql|txt|csv|tsv|yaml|yml))/gi);
  if (!matches) return [];
  const unique = Array.from(new Set(matches.map(normalizePath)));
  return unique.filter((p) => !p.endsWith('TODO.md') && !p.endsWith('AGENT_CONTEXT.md') && !p.endsWith('TASK_CONTEXT.md') && !p.endsWith('FILE_LOCKS.md'));
}

export function extractCodeBlocks(text: string): Array<{ lang: string; code: string }> {
  const blocks: Array<{ lang: string; code: string }> = [];
  const regex = /```([a-zA-Z0-9_-]*)\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    const lang = (m[1] || '').trim().toLowerCase();
    const code = m[2] || '';
    if (code.trim().length > 0 && !['json', 'gherkin'].includes(lang)) {
      blocks.push({ lang, code: code.trim() });
    } else if (lang === 'json' && code.trim().length > 0) {
      try {
        const parsed = JSON.parse(code.trim());
        const innerContent = parsed.content || parsed.arguments?.content || parsed.args?.content;
        if (typeof innerContent === 'string' && innerContent.trim().length > 0) {
          blocks.push({ lang: '', code: innerContent.trim() });
        }
      } catch {}
    }
  }

  // Also extract raw HTML document if no code block was matched
  if (blocks.length === 0 && text) {
    const htmlMatch = text.match(/(<!DOCTYPE\s+html[\s\S]*?<\/html>|<html[\s\S]*?<\/html>)/i);
    if (htmlMatch) {
      blocks.push({ lang: 'html', code: htmlMatch[1].trim() });
    }
  }

  return blocks;
}

// ─── Gherkin helpers ────────────────────────────────────────────────────────

export function extractScenarioTitles(gherkin: string): string[] {
  const titles: string[] = [];
  for (const line of gherkin.split('\n')) {
    const m = line.match(/^\s*Scenario(?: Outline)?:\s*(.+?)\s*$/i);
    if (m) titles.push(m[1]);
  }
  return titles;
}

/** Splits the Gherkin text into per-scenario blocks keyed by title (the Feature header is kept separately). */
export function scenarioBlocks(gherkin: string): { feature: string; blocks: Map<string, string> } {
  const blocks = new Map<string, string>();
  const lines = gherkin.split('\n');
  let feature = '';
  let current: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (current !== null) blocks.set(current, buf.join('\n').trimEnd());
    buf = [];
  };
  for (const line of lines) {
    const m = line.match(/^\s*Scenario(?: Outline)?:\s*(.+?)\s*$/i);
    if (m) {
      flush();
      current = m[1];
      buf.push(line);
    } else if (current === null) {
      if (line.trim()) feature = feature ? `${feature}\n${line}` : line;
    } else {
      buf.push(line);
    }
  }
  flush();
  return { feature: feature.trim(), blocks };
}

function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function quoteScenarios(gherkin: string, refs: string[]): string {
  const { feature, blocks } = scenarioBlocks(gherkin);
  const wanted: string[] = [];
  for (const ref of refs) {
    const key = normalizeTitle(ref);
    for (const [title, block] of blocks) {
      const nt = normalizeTitle(title);
      if (nt === key || nt.includes(key) || key.includes(nt)) {
        if (!wanted.includes(block)) wanted.push(block);
      }
    }
  }
  const body = wanted.length > 0 ? wanted.join('\n\n') : gherkin.trim();
  return `\`\`\`gherkin\n${feature && wanted.length > 0 ? `${feature}\n` : ''}${body}\n\`\`\``;
}

// ─── Piece normalization ────────────────────────────────────────────────────

function toStringArray(v: any): string[] {
  if (!Array.isArray(v)) return typeof v === 'string' && v.trim() ? [v.trim()] : [];
  return v.map((x) => (typeof x === 'string' ? x.trim() : String(x ?? '').trim())).filter(Boolean);
}

function makePiece(partial: Partial<PuzzlePiece> & { id: string; kind: PuzzlePieceKind; title: string; instructions: string }): PuzzlePiece {
  return {
    id: partial.id,
    kind: partial.kind,
    title: partial.title,
    instructions: partial.instructions,
    scenarioRefs: partial.scenarioRefs || [],
    files: (partial.files || []).map(normalizePath).filter(Boolean),
    dependsOn: partial.dependsOn || [],
    status: 'pending',
    attempts: 0
  };
}

/** Validates the model's decomposition and applies the implicit given → when → then/edge ordering. */
export function normalizePieces(raw: any, scenarioTitles: string[], startIndex = 1): PuzzlePiece[] {
  const list: any[] = Array.isArray(raw?.pieces) ? raw.pieces : Array.isArray(raw) ? raw : [];
  const pieces: PuzzlePiece[] = [];
  const idMap = new Map<string, string>();
  let n = startIndex;
  for (const item of list.slice(0, MAX_PIECES)) {
    if (!item || typeof item !== 'object') continue;
    const title = typeof item.title === 'string' && item.title.trim() ? item.title.trim() : `Piece ${n}`;
    const instructions = typeof item.instructions === 'string' && item.instructions.trim() ? item.instructions.trim() : title;
    const kindRaw = typeof item.kind === 'string' ? item.kind.trim().toLowerCase() : 'when';
    const kind: PuzzlePieceKind = (PIECE_KINDS as string[]).includes(kindRaw) ? (kindRaw as PuzzlePieceKind) : 'when';
    const newId = `P${n}`;
    if (typeof item.id === 'string' && item.id.trim()) idMap.set(item.id.trim(), newId);
    idMap.set(newId, newId);
    pieces.push(
      makePiece({
        id: newId,
        kind,
        title,
        instructions,
        scenarioRefs: toStringArray(item.scenarioRefs),
        files: kind === 'then' ? [] : toStringArray(item.files),
        dependsOn: toStringArray(item.dependsOn)
      })
    );
    n++;
  }
  // Remap dependsOn to normalized ids and drop unknown/self references.
  for (const p of pieces) {
    p.dependsOn = Array.from(new Set(p.dependsOn.map((d) => idMap.get(d) || d).filter((d) => d !== p.id && pieces.some((x) => x.id === d))));
  }
  // Implicit ordering: when ⇐ given; then/edge ⇐ given + when.
  const givens = pieces.filter((p) => p.kind === 'given').map((p) => p.id);
  const whens = pieces.filter((p) => p.kind === 'when').map((p) => p.id);
  for (const p of pieces) {
    if (p.kind === 'when') p.dependsOn = Array.from(new Set([...p.dependsOn, ...givens]));
    if (p.kind === 'then' || p.kind === 'edge') p.dependsOn = Array.from(new Set([...p.dependsOn, ...givens, ...whens.filter((w) => w !== p.id)]));
  }
  // Break accidental cycles: a piece may not depend on something that depends on it (drop the later edge).
  for (const p of pieces) {
    p.dependsOn = p.dependsOn.filter((d) => {
      const dep = pieces.find((x) => x.id === d);
      return dep ? !dep.dependsOn.includes(p.id) : false;
    });
  }
  // Only append a dedicated 'then' verification piece when there are multiple (2+) implementing pieces
  // that need cross-piece integration verification. For a single self-contained piece (e.g. 1 'when' piece),
  // the worker verifies its own deliverable, saving an entire redundant worker loop!
  const hasMultipleImplPieces = pieces.filter((p) => p.kind === 'when' || p.kind === 'given').length >= 2;
  if (hasMultipleImplPieces && !pieces.some((p) => p.kind === 'then')) {
    pieces.push(
      makePiece({
        id: `P${n}`,
        kind: 'then',
        title: 'Acceptance verification',
        instructions: 'Verify every Then/And clause of the referenced scenarios against the workspace with evidence (commands, file excerpts). Do not modify files.',
        scenarioRefs: scenarioTitles,
        files: [],
        dependsOn: pieces.map((p) => p.id)
      })
    );
  }
  return pieces;
}

function fallbackPieces(scenarioTitles: string[], startIndex = 1): PuzzlePiece[] {
  const a = `P${startIndex}`;
  return [
    makePiece({
      id: a,
      kind: 'when',
      title: 'Implement and verify the task',
      instructions:
        'Implement everything the Gherkin scenarios in the bible require, writing output to the destination described under "Output Destination & Method". Inspect and verify your own work with commands and evidence before finishing.',
      scenarioRefs: scenarioTitles,
      files: [],
      dependsOn: []
    })
  ];
}

// ─── Worker status parsing ──────────────────────────────────────────────────

export function parseWorkerStatus(text: string): { status: 'DONE' | 'FAILED' | null; reason?: string } {
  const m = text.match(/^\s*STATUS:\s*(DONE|FAILED)(?:\s*[—–-]+\s*(.*))?\s*$/im);
  if (!m) return { status: null };
  return { status: m[1].toUpperCase() as 'DONE' | 'FAILED', reason: m[2]?.trim() };
}

function condense(text: string, cap = PIECE_SUMMARY_CHAR_CAP): string {
  const t = text.replace(/\n{3,}/g, '\n\n').trim();
  return t.length > cap ? `${t.slice(0, cap)}…` : t;
}

// ─── Manager ────────────────────────────────────────────────────────────────

export async function runManager(
  ctx: PipelineContext,
  bible: BibleStore,
  tools: ToolDefinition[],
  locks: FileLockRegistry,
  attempt: number,
  priorFailureDiagnostics?: string
): Promise<ManagerRunResult> {
  const usage = emptyUsage();
  const createdFiles = new Set<string>([
    ...(ctx.task.createdFiles || []),
    ...(ctx.brief?.createdFiles || [])
  ]);
  let usedToolCalling = true;
  const { aiConfig } = ctx;

  // Byte-stable prompt blocks (built once per manager run; identical text across attempts).
  const [managerSkill, workerSkill] = await Promise.all([loadPipelineSkill('manager-agent'), loadPipelineSkill('worker-agent')]);
  const managerStable = `${managerSkill}\n\n${MANAGER_RULES}`;
  const workerStable = `${workerSkill}\n\n${WORKER_RULES}`;
  // Manager receives slim context (Gherkin + Goals + Output Destination) without verbose guidelines/discovered dumps
  const managerContext = bible.renderManagerContext();
  // Workers receive the full bible with guidelines and discovered context
  const workerSharedBible = bible.renderStable();
  const scenarioTitles = extractScenarioTitles(bible.sections.gherkin);
  // The SAME tool list is offered to every role/phase (tools render at position 0 of the prompt, so any
  // difference would forfeit cache sharing between manager, workers and hardener). What each phase may
  // actually do is enforced by the executor scope (read-only / write paths), not by pruning definitions.
  const managerTarget = resolveRoleTarget(aiConfig, 'manager');
  const workerTarget = resolveRoleTarget(aiConfig, 'worker');
  const managerModel = managerTarget.model;
  const workerModel = workerTarget.model;
  const maxRounds = Math.max(5, ctx.options.maxToolRoundsPerAgent);

  const managerProviderBase = {
    provider: managerTarget.provider,
    apiKey: managerTarget.apiKey,
    baseUrl: managerTarget.baseUrl,
    signal: ctx.signal,
    ollamaFailureState: ctx.ollamaFailureState,
    taskId: ctx.task.id,
    onRequestOllamaFallback: ctx.onRequestOllamaFallback,
    onSwitchToCloud: async () => resolveRoleTarget(ctx.aiConfig, 'manager')
  } as const;
  const workerProviderBase = {
    provider: workerTarget.provider,
    apiKey: workerTarget.apiKey,
    baseUrl: workerTarget.baseUrl,
    signal: ctx.signal,
    ollamaFailureState: ctx.ollamaFailureState,
    taskId: ctx.task.id,
    onRequestOllamaFallback: ctx.onRequestOllamaFallback,
    onSwitchToCloud: async () => resolveRoleTarget(ctx.aiConfig, 'worker')
  } as const;

  const isResuming = ctx.task.status === 'partly_done' ||
    Boolean(ctx.brief?.buildAndVerification && ctx.brief.buildAndVerification.trim().length > 0);

  const resumeNotice = isResuming
    ? `\n## RESUMING TASK PROGRESS:\n` +
      `This task was stopped partway through and is being RESUMED.\n` +
      `- Inspect existing workspace files and check existing deliverable files (${Array.from(createdFiles).join(', ') || 'in workspace'}).\n` +
      `- Preserve and build upon any completed, working code and deliverables. Do not destroy or rewrite working parts.\n` +
      `- Focus on completing the remaining unfinished goals and acceptance criteria.\n`
    : '';

  // ── DIRECT EXECUTION (Solo Mode for straightforward / single deliverables) ──
  if (isStraightforwardTask(bible)) {
    const directStepId = `step-mgr-direct-a${attempt}`;
    ctx.emit({
      id: directStepId,
      stage: 'subagent',
      agentRole: 'manager',
      title: attempt > 1 ? `Manager AI: Direct Remediation (Attempt ${attempt})` : 'Manager AI: Direct Execution (Solo Mode)',
      detail: 'Executing straightforward deliverable directly without worker fan-out for token efficiency…',
      status: 'running'
    });

    const directMessage =
      `Execute this task directly per the bible above.\n` +
      `- Task kind: ${bible.sections.metadata.taskKind}\n` +
      `- Output destination: ${bible.sections.outputAs}\n` +
      `- Scenarios to cover (${scenarioTitles.length}): ${scenarioTitles.map((t) => `"${t}"`).join(', ') || '(cover the whole brief)'}\n` +
      `- Deliverable Goals checklist:\n${bible.sections.goals || '(complete all task requirements)'}\n` +
      resumeNotice +
      (attempt > 1 && priorFailureDiagnostics
        ? `\n## Prior attempt failed QA — fix exactly these:\n${priorFailureDiagnostics}\n\n${bible.renderEventLog({ last: 15 })}\n`
        : '') +
      `\nProduce the complete, fully functioning deliverable per all goals and scenarios (no placeholder skeletons/stubs), verify your work with commands/evidence, and reply with a condensed summary ending with "STATUS: DONE".`;

    const CORE_DIRECT_TOOL_NAMES = new Set(['write_file', 'edit_file', 'read_file', 'list_directory', 'get_file_info', 'run_command', 'ask_human']);
    const directTools = managerTarget.provider === 'ollama'
      ? tools.filter((t) => CORE_DIRECT_TOOL_NAMES.has(t.name))
      : tools;

    const executor = createToolExecutor({
      ctx,
      tools: directTools,
      scope: { actorLabel: 'manager', readOnly: false },
      agentRole: 'manager',
      onFileWritten: (p) => createdFiles.add(p),
      stepIdPrefix: `step-tool-mgr-direct-a${attempt}`
    });

    const result = await runToolLoop({
      ...managerProviderBase,
      model: managerModel,
      stableSystem: MANAGER_DIRECT_STABLE,
      sharedContext: managerContext,
      tools: directTools,
      initialUserMessage: directMessage,
      maxRounds: Math.min(3, Math.max(2, ctx.options.maxToolRoundsPerAgent)),
      maxTokens: 8000,
      onToolCalls: executor
    });

    addUsage(usage, result.usage);
    addUsage(ctx.usage, result.usage);
    if (result.stopReason === 'no_tool_support') usedToolCalling = false;

    const parsedStatus = parseWorkerStatus(result.text);
    const targetFilePaths = extractTargetFilePaths(bible.sections.outputAs);

    // Fallback: If no files were recorded as written, but target files were requested
    // and the model emitted code blocks in text, automatically save the deliverable.
    if (createdFiles.size === 0 && targetFilePaths.length > 0) {
      let blocks = extractCodeBlocks(result.text);
      if (blocks.length === 0) {
        // Recovery nudge: if the model produced text without calling write_file or code blocks,
        // perform one targeted recovery call specifically requesting the deliverable code.
        const recoveryRes = await runToolLoop({
          ...managerProviderBase,
          model: managerModel,
          stableSystem: MANAGER_DIRECT_STABLE,
          sharedContext: managerContext,
          tools: directTools,
          initialUserMessage: `The target deliverable ${targetFilePaths[0]} was NOT written to disk. Output the complete, functional source code for ${targetFilePaths[0]} now in a code block or by calling write_file.`,
          maxRounds: 2,
          maxTokens: 8000,
          onToolCalls: executor
        });
        addUsage(usage, recoveryRes.usage);
        addUsage(ctx.usage, recoveryRes.usage);
        blocks = extractCodeBlocks(recoveryRes.text);
      }
      if (blocks.length > 0) {
        const targetPath = targetFilePaths[0];
        const ext = targetPath.split('.').pop()?.toLowerCase() || '';
        const bestBlock = blocks.find((b) => b.lang === ext || (ext === 'html' && (b.lang === 'html' || b.lang === 'htm' || b.code.includes('<html') || b.code.includes('<!DOCTYPE')))) || blocks[0];
        if (bestBlock && bestBlock.code) {
          const writeRes = await callMcpTool('mcp-filesystem', 'write_file', {
            path: targetPath,
            content: bestBlock.code
          });
          if (writeRes.success) {
            createdFiles.add(normalizePath(targetPath));
            bible.appendEvent({
              actor: 'manager',
              kind: 'info',
              text: `Auto-extracted deliverable code block from text and saved to ${targetPath}.`
            });
          }
        }
      }
    }

    // Empirical verification: Check that target deliverables actually exist on disk
    let diskVerified = true;
    const missingTargetFiles: string[] = [];
    if (targetFilePaths.length > 0) {
      for (const tf of targetFilePaths) {
        const infoRes = await callMcpTool('mcp-filesystem', 'get_file_info', { path: tf });
        const exists = infoRes.success && infoRes.data?.isFile;
        if (exists) {
          createdFiles.add(normalizePath(tf));
        } else {
          diskVerified = false;
          missingTargetFiles.push(tf);
        }
      }
    }

    // 2. Automated Startup Smoke Test across ALL created files & endpoints
    let healthReport = await verifyDeliverableHealth(Array.from(createdFiles));
    if (!healthReport.ok) {
      bible.appendEvent({
        actor: 'pipeline',
        kind: 'verify',
        text: `Deliverable startup smoke test caught errors:\n${healthReport.summaryText}`
      });
      await bible.persist();

      ctx.emit({
        id: `${directStepId}-smoke-test`,
        stage: 'verify',
        agentRole: 'manager',
        title: 'Startup Verification: Runtime Errors Detected',
        detail: healthReport.summaryText.slice(0, 400),
        status: 'warning'
      });

      // Targeted single-round remediation prompt
      const remediationMsg =
        `CRITICAL STARTUP VERIFICATION ERROR:\n` +
        `The deliverable you wrote failed automated startup smoke testing with the following runtime/syntax errors:\n\n` +
        `${healthReport.summaryText}\n\n` +
        `DIAGNOSE & FIX:\n` +
        `- Review the error messages and line numbers above.\n` +
        `- Check for undeclared variables (ensure all variables are declared with let/const or passed as parameters).\n` +
        `- Ensure all syntax is valid and all startup functions/game loops run without uncaught exceptions.\n` +
        `- You MUST call write_file now to rewrite the complete, corrected file, or output the complete file in a code block.\n` +
        `Reply with STATUS: DONE once fixed.`;

      const remediationRes = await runToolLoop({
        ...managerProviderBase,
        model: managerModel,
        stableSystem: MANAGER_DIRECT_STABLE,
        sharedContext: managerContext,
        tools: directTools,
        initialUserMessage: remediationMsg,
        maxRounds: 2,
        maxTokens: 4000,
        onToolCalls: executor
      });
      addUsage(usage, remediationRes.usage);
      addUsage(ctx.usage, remediationRes.usage);

      // Fallback: If the model emitted code blocks in text instead of calling write_file, save them!
      const remBlocks = extractCodeBlocks(remediationRes.text);
      if (remBlocks.length > 0 && targetFilePaths.length > 0) {
        const targetPath = targetFilePaths[0];
        const ext = targetPath.split('.').pop()?.toLowerCase() || '';
        const bestBlock = remBlocks.find((b) => b.lang === ext || (ext === 'html' && (b.lang === 'html' || b.lang === 'htm' || b.code.includes('<html') || b.code.includes('<!DOCTYPE')))) || remBlocks[0];
        if (bestBlock && bestBlock.code) {
          const writeRes = await callMcpTool('mcp-filesystem', 'write_file', {
            path: targetPath,
            content: bestBlock.code
          });
          if (writeRes.success) {
            createdFiles.add(normalizePath(targetPath));
            bible.appendEvent({
              actor: 'manager',
              kind: 'info',
              text: `Auto-extracted corrected deliverable code block from remediation text and saved to ${targetPath}.`
            });
          }
        }
      }

      // Re-verify after remediation
      healthReport = await verifyDeliverableHealth(Array.from(createdFiles));
      if (healthReport.ok) {
        bible.appendEvent({
          actor: 'pipeline',
          kind: 'info',
          text: `Automated startup smoke test passed after remediation: ${healthReport.summaryText}`
        });
        await bible.persist();
      }
    }

    const hasFiles = createdFiles.size > 0;
    const isExplicitlyFailed = parsedStatus.status === 'FAILED';
    const isExplicitlyDone = parsedStatus.status === 'DONE';
    const textIndicatesSuccess = !isExplicitlyFailed && (
      /status:\s*done\b/i.test(result.text) ||
      /\b(completed|successfully (created|built|written|generated)|finished)\b/i.test(result.text)
    );
    const directOk = !isExplicitlyFailed && diskVerified && healthReport.ok && (
      (isExplicitlyDone && (hasFiles || targetFilePaths.length === 0)) ||
      (hasFiles && !result.error && (isExplicitlyDone || textIndicatesSuccess))
    );
    let summary = condense(
      (!healthReport.ok ? `Deliverable failed startup smoke test:\n${healthReport.summaryText}` : '') ||
      result.text.replace(/^\s*STATUS:.*$/im, '').trim() ||
      (directOk ? 'Deliverable produced and startup-verified with 0 errors.' : 'Direct execution finished without explicit DONE.')
    );
    if (!diskVerified && missingTargetFiles.length > 0) {
      summary = `Deliverable file(s) missing on disk: ${missingTargetFiles.join(', ')}. Code was not written to target destination.`;
    }

    const directPiece = makePiece({
      id: 'P1',
      kind: 'when',
      title: bible.sections.title,
      instructions: 'Direct execution by Manager',
      scenarioRefs: scenarioTitles,
      files: Array.from(createdFiles),
      dependsOn: []
    });
    directPiece.status = directOk ? 'done' : 'failed';
    directPiece.summary = summary;
    directPiece.attempts = 1;
    const directPieces = [directPiece];

    bible.setPieces(directPieces);
    bible.appendEvent({
      actor: 'manager',
      kind: directOk ? 'piece_done' : 'piece_failed',
      text: `Direct execution: ${summary}`
    });
    await bible.persist();

    ctx.emit({
      id: directStepId,
      stage: 'subagent',
      agentRole: 'manager',
      title: directOk ? 'Manager AI: Direct Execution Complete' : 'Manager AI: Direct Execution Failed',
      detail: summary,
      status: directOk ? 'success' : 'warning',
      usage: { ...result.usage }
    });

    console.log('%c[Ergo Agent Pipeline] ── Step 3: Manager direct complete ──', 'color: #10b981; font-weight: bold;');
    console.log(`Direct execution: ok=${directOk} | files=${createdFiles.size} | usage: ${formatUsage(usage)}`);

    return {
      pieces: directPieces,
      createdFiles: Array.from(createdFiles),
      allScenariosPass: directOk,
      verificationSummary: summary,
      usage,
      usedToolCalling
    };
  }

  // ── STEP A: Decompose ────────────────────────────────────────────────────
  const decomposeStepId = `step-decompose-a${attempt}`;
  ctx.emit({
    id: decomposeStepId,
    stage: 'decompose',
    agentRole: 'manager',
    title: attempt > 1 ? `Manager AI: Re-planning after QA failure (attempt ${attempt})` : 'Manager AI: Decomposing Gherkin Scenarios into Puzzle Pieces',
    detail: 'Reading the bible and splitting the scenarios into Given / When / Then / Edge pieces with disjoint file scopes…',
    status: 'running'
  });

  const decomposeMessage =
    `Decompose the Gherkin scenarios in the bible into puzzle pieces per your Decomposition Output Contract.\n` +
    `- Task kind: ${bible.sections.metadata.taskKind}\n` +
    `- Output destination: ${bible.sections.outputAs}\n` +
    `- Scenarios to cover (${scenarioTitles.length}): ${scenarioTitles.map((t) => `"${t}"`).join(', ') || '(none parsed — cover the whole brief)'}\n` +
    `- Concurrency limit: ${ctx.options.maxConcurrentAgents} worker(s).\n` +
    `- CRITICAL EFFICIENCY RULE: If this task builds a standalone deliverable, single file (e.g. an HTML game, standalone script, single component), or simple deliverable, plan EXACTLY 1 piece of kind "when" covering all scenarios ("Implement and self-verify deliverable"). Do NOT split it into multiple workers or a separate "then" worker. A single worker will implement and verify it directly.\n` +
    resumeNotice +
    (attempt > 1 && priorFailureDiagnostics
      ? `\n## Prior attempt failed QA — fix exactly these (fresh workers will be spawned)\n${priorFailureDiagnostics}\n\n${bible.renderPieces()}\n${bible.renderEventLog({ last: 25 })}\n`
      : '') +
    `\nReturn ONLY the JSON object with the "pieces" array: { "pieces": [ { "id": "P1", "kind": "when", "title": "...", "instructions": "...", "scenarioRefs": [...], "files": [...], "dependsOn": [] } ], "notes": "..." }.`;

  let pieces: PuzzlePiece[] = [];
  let decomposeNotes = '';
  {
    const executor = createToolExecutor({
      ctx,
      tools,
      scope: { actorLabel: 'manager', readOnly: true },
      agentRole: 'manager',
      stepIdPrefix: `step-tool-mgr-a${attempt}`
    });
    const result = await runToolLoop({
      ...managerProviderBase,
      model: managerModel,
      stableSystem: managerStable,
      sharedContext: managerContext,
      tools,
      initialUserMessage: decomposeMessage,
      maxRounds: 4,
      maxTokens: 8000,
      responseFormat: 'json',
      onToolCalls: executor
    });
    addUsage(usage, result.usage);
    addUsage(ctx.usage, result.usage);
    if (result.stopReason === 'no_tool_support') usedToolCalling = false;
    if (result.stopReason === 'error') {
      bible.appendEvent({ actor: 'manager', kind: 'error', text: `Decomposition call failed: ${result.error}` });
    }
    const parsed = parseJsonLoose<any>(result.text);
    pieces = parsed ? normalizePieces(parsed, scenarioTitles) : [];
    decomposeNotes = typeof parsed?.notes === 'string' ? parsed.notes.trim() : '';
    if (pieces.length === 0) {
      pieces = fallbackPieces(scenarioTitles);
      decomposeNotes = decomposeNotes || 'Decomposition JSON unusable — fell back to a single implementation piece plus verification.';
    }
  }
  throwIfAborted(ctx.signal);

  bible.setPieces(pieces);
  bible.appendEvent({
    actor: 'manager',
    kind: 'decompose',
    text: `Attempt ${attempt}: ${pieces.length} piece(s) — ${pieces.map((p) => `${p.id}:${p.kind}:${p.title}`).join('; ')}${decomposeNotes ? ` | Notes: ${decomposeNotes}` : ''}`
  });
  await bible.persist();
  ctx.emit({
    id: decomposeStepId,
    stage: 'decompose',
    agentRole: 'manager',
    title: `Manager AI: ${pieces.length} Puzzle Piece${pieces.length === 1 ? '' : 's'} Planned`,
    detail: pieces.map((p) => `${p.id} [${p.kind}] ${p.title}${p.files.length ? ` → ${p.files.join(', ')}` : ''}`).join('\n'),
    status: 'success',
    bibleMarkdown: bible.renderFull(),
    bibleFilePath: bible.filePath,
    usage: { ...usage }
  });

  // ── STEP B/C: Workers in waves ───────────────────────────────────────────
  const workerUsage = emptyUsage();

  const buildPieceContract = (piece: PuzzlePiece): string => {
    const lockedByOthers = locks.lockedByOthers(piece.id);
    const lines: string[] = [];
    lines.push(`## Your Piece: ${piece.id} (${piece.kind}) — ${piece.title}`, '');
    lines.push('### Instructions', piece.instructions, '');
    lines.push('### Scenarios you must satisfy or verify', quoteScenarios(bible.sections.gherkin, piece.scenarioRefs), '');
    if (piece.files.length > 0) {
      lines.push('### Files you own (write scope)', ...piece.files.map((f) => `- ${f}`), '');
    } else {
      lines.push('### Files you own', '- (none — this is a read-only piece; you may still run commands)', '');
    }
    if (lockedByOthers.length > 0) {
      lines.push('### Files locked by other pieces (read-only for you)', ...lockedByOthers.map((l) => `- ${l.file} (held by ${l.heldBy})`), '');
    }
    if (piece.lastError) {
      lines.push('### Prior attempt failed — fix this', piece.lastError, '');
    }
    lines.push(bible.renderEventLog({ last: 12 }));
    lines.push(
      '### Output contract',
      'When finished (or proven blocked), stop calling tools and reply with a condensed summary of at most 150 words: what you changed (paths), how you verified it (commands/results), and anything the manager must know. Then the exact final line `STATUS: DONE` or `STATUS: FAILED — <reason>`.'
    );
    return lines.join('\n');
  };

  const executePieceOnce = async (piece: PuzzlePiece, onFirstResponse: () => void): Promise<{ ok: boolean; summary: string; error?: string }> => {
    const executor = createToolExecutor({
      ctx,
      tools,
      scope: { actorLabel: `worker ${piece.id}`, readOnly: false, allowedWritePaths: piece.files.length > 0 ? piece.files : undefined },
      agentRole: 'worker',
      pieceId: piece.id,
      locks,
      onFileWritten: (p) => createdFiles.add(p),
      stepIdPrefix: `step-tool-${piece.id}-a${attempt}-t${piece.attempts}`
    });
    const isSinglePiece = pieces.length === 1;
    const effectiveWorkerMaxRounds = isSinglePiece ? Math.min(5, maxRounds) : Math.min(8, maxRounds);
    const effectiveWorkerBible = isSinglePiece ? managerContext : workerSharedBible;
    const result = await runToolLoop({
      ...workerProviderBase,
      model: workerModel,
      stableSystem: workerStable,
      sharedContext: effectiveWorkerBible,
      tools,
      initialUserMessage: buildPieceContract(piece),
      maxRounds: effectiveWorkerMaxRounds,
      onToolCalls: executor,
      onFirstResponse
    });
    addUsage(workerUsage, result.usage);
    if (result.stopReason === 'no_tool_support') usedToolCalling = false;

    // Fallback: If worker owns files but none were written via tools, extract code blocks from text
    if (piece.files.length > 0 && !piece.files.some((f) => createdFiles.has(normalizePath(f)))) {
      const blocks = extractCodeBlocks(result.text);
      if (blocks.length > 0) {
        const targetPath = piece.files[0];
        const ext = targetPath.split('.').pop()?.toLowerCase() || '';
        const bestBlock = blocks.find((b) => b.lang === ext) || blocks[0];
        if (bestBlock && bestBlock.code) {
          const writeRes = await callMcpTool('mcp-filesystem', 'write_file', {
            path: targetPath,
            content: bestBlock.code
          });
          if (writeRes.success) {
            createdFiles.add(normalizePath(targetPath));
            bible.appendEvent({
              actor: `worker:${piece.id}`,
              kind: 'info',
              text: `Auto-extracted code block and saved to ${targetPath}.`,
              pieceId: piece.id
            });
          }
        }
      }
    }

    const status = parseWorkerStatus(result.text);
    const summary = condense(result.text.replace(/^\s*STATUS:.*$/im, '').trim() || '(worker produced no summary)');
    if (result.stopReason === 'error') return { ok: false, summary, error: `Worker call failed: ${result.error}` };
    if (result.stopReason === 'aborted') return { ok: false, summary, error: 'Worker aborted.' };
    if (status.status === 'FAILED') return { ok: false, summary, error: status.reason || 'Worker reported STATUS: FAILED without a reason.' };
    if (result.stopReason === 'max_rounds' && status.status !== 'DONE') return { ok: false, summary, error: `Worker exceeded its tool round budget (${maxRounds}) without reporting STATUS: DONE.` };
    if (status.status === null && result.stopReason === 'no_tool_support') return { ok: true, summary };
    if (status.status === null) return { ok: false, summary, error: 'Worker finished without the required STATUS line.' };
    return { ok: true, summary };
  };

  const runWorker = (piece: PuzzlePiece): { done: Promise<void>; firstResponse: Promise<void> } => {
    let resolveFirst!: () => void;
    const firstResponse = new Promise<void>((r) => (resolveFirst = r));
    const stepId = `step-piece-${piece.id}-a${attempt}`;
    const done = (async () => {
      try {
        const acquired = locks.acquire(piece.id, piece.files);
        if (!acquired.ok) {
          // Should not happen (scheduler checks canStart), but never deadlock silently.
          piece.status = 'blocked';
          piece.lastError = `Could not acquire locks: ${acquired.conflicts.map((c) => `${c.file} held by ${c.heldBy}`).join(', ')}`;
          bible.updatePiece(piece.id, { status: 'blocked', lastError: piece.lastError });
          bible.appendEvent({ actor: 'manager', kind: 'lock', text: piece.lastError, pieceId: piece.id });
          return;
        }
        void locks.persist();
        piece.status = 'running';
        bible.updatePiece(piece.id, { status: 'running' });
        bible.appendEvent({ actor: 'manager', kind: 'piece_start', text: `${piece.title} (${piece.kind}) → worker${piece.files.length ? ` owns ${piece.files.join(', ')}` : ''}`, pieceId: piece.id });
        void bible.persist();
        ctx.emit({
          id: stepId,
          stage: 'subagent',
          agentRole: 'worker',
          pieceId: piece.id,
          title: `Worker ${piece.id}: ${piece.title}`,
          detail: `[${piece.kind}] ${piece.instructions.slice(0, 220)}${piece.instructions.length > 220 ? '…' : ''}`,
          status: 'running'
        });

        let outcome: { ok: boolean; summary: string; error?: string } = { ok: false, summary: '', error: 'not run' };
        const usageBefore = { ...workerUsage };
        for (let t = 1; t <= 2; t++) {
          throwIfAborted(ctx.signal);
          piece.attempts = t;
          bible.updatePiece(piece.id, { attempts: t });
          outcome = await executePieceOnce(piece, resolveFirst);
          if (outcome.ok) break;
          piece.lastError = `${outcome.error}\n\nWorker summary:\n${outcome.summary}`;
          bible.updatePiece(piece.id, { lastError: piece.lastError });
          bible.appendEvent({ actor: `worker:${piece.id}`, kind: 'piece_failed', text: `attempt ${t}: ${outcome.error} — ${condense(outcome.summary, 400)}`, pieceId: piece.id });
          void bible.persist();
          if (t === 1) {
            ctx.emit({
              id: stepId,
              stage: 'subagent',
              agentRole: 'worker',
              pieceId: piece.id,
              title: `Worker ${piece.id}: retrying with fresh context`,
              detail: `Attempt 1 failed: ${outcome.error}`,
              status: 'running'
            });
          }
        }
        const pieceUsage: TokenUsage = {
          inputTokens: workerUsage.inputTokens - usageBefore.inputTokens,
          outputTokens: workerUsage.outputTokens - usageBefore.outputTokens,
          cachedInputTokens: workerUsage.cachedInputTokens - usageBefore.cachedInputTokens,
          cacheWriteTokens: workerUsage.cacheWriteTokens - usageBefore.cacheWriteTokens,
          calls: workerUsage.calls - usageBefore.calls
        };
        addUsage(ctx.usage, pieceUsage);
        piece.summary = outcome.summary;
        piece.status = outcome.ok ? 'done' : 'failed';
        bible.updatePiece(piece.id, { status: piece.status, summary: piece.summary, lastError: piece.lastError });
        if (outcome.ok) {
          bible.appendEvent({ actor: `worker:${piece.id}`, kind: 'piece_done', text: outcome.summary, pieceId: piece.id });
        }
        ctx.emit({
          id: stepId,
          stage: 'subagent',
          agentRole: 'worker',
          pieceId: piece.id,
          title: outcome.ok ? `Worker ${piece.id}: Done — ${piece.title}` : `Worker ${piece.id}: Failed — ${piece.title}`,
          detail: outcome.ok ? outcome.summary : `${outcome.error}\n\n${outcome.summary}`,
          status: outcome.ok ? 'success' : 'warning',
          usage: pieceUsage
        });
      } catch (e) {
        if (isAbortError(e)) {
          piece.status = 'failed';
          piece.lastError = 'Aborted by user.';
          bible.updatePiece(piece.id, { status: 'failed', lastError: piece.lastError });
          throw e;
        }
        piece.status = 'failed';
        piece.lastError = `Unexpected worker error: ${(e as any)?.message || String(e)}`;
        bible.updatePiece(piece.id, { status: 'failed', lastError: piece.lastError });
        bible.appendEvent({ actor: `worker:${piece.id}`, kind: 'error', text: piece.lastError, pieceId: piece.id });
        ctx.emit({ id: stepId, stage: 'subagent', agentRole: 'worker', pieceId: piece.id, title: `Worker ${piece.id}: Error`, detail: piece.lastError, status: 'error' });
      } finally {
        locks.release(piece.id);
        void locks.persist();
        void bible.persist();
        resolveFirst();
      }
    })();
    return { done, firstResponse };
  };

  const runWaves = async (all: PuzzlePiece[]): Promise<void> => {
    const running = new Map<string, Promise<void>>();
    let warmed = false;
    let abortError: unknown = null;
    const byId = new Map(all.map((p) => [p.id, p]));
    // eslint-disable-next-line no-constant-condition
    while (true) {
      throwIfAborted(ctx.signal);
      for (const p of all) {
        if (p.status !== 'pending') continue;
        const badDep = p.dependsOn.find((d) => {
          const dep = byId.get(d);
          return dep && (dep.status === 'failed' || dep.status === 'blocked');
        });
        if (badDep) {
          p.status = 'blocked';
          p.lastError = `Blocked: dependency ${badDep} did not complete.`;
          bible.updatePiece(p.id, { status: 'blocked', lastError: p.lastError });
          bible.appendEvent({ actor: 'manager', kind: 'info', text: p.lastError, pieceId: p.id });
        }
      }
      const ready = all.filter(
        (p) => p.status === 'pending' && p.dependsOn.every((d) => byId.get(d)?.status === 'done') && locks.canStart(p) && !running.has(p.id)
      );
      const free = Math.max(0, ctx.options.maxConcurrentAgents - running.size);
      if (ready.length === 0 && running.size === 0) break;
      for (const p of ready.slice(0, free)) {
        const { done, firstResponse } = runWorker(p);
        // Never let a worker rejection become an unhandled promise; surface aborts after the race.
        const tracked = done
          .catch((e: unknown) => {
            if (isAbortError(e)) abortError = e;
          })
          .finally(() => running.delete(p.id));
        running.set(p.id, tracked);
        if (!warmed) {
          // Sequential cache warming: let the first worker's first response land before fanning out.
          warmed = true;
          await Promise.race([firstResponse, tracked]);
        }
      }
      if (running.size > 0) await Promise.race(Array.from(running.values()));
      else if (ready.length === 0) break;
      if (abortError) {
        await Promise.allSettled(Array.from(running.values()));
        throw abortError;
      }
    }
    // Anything still pending has an unsatisfiable dependency graph.
    for (const p of all) {
      if (p.status === 'pending') {
        p.status = 'blocked';
        p.lastError = 'Blocked: unsatisfiable dependencies (cycle).';
        bible.updatePiece(p.id, { status: 'blocked', lastError: p.lastError });
      }
    }
  };

  await runWaves(pieces);
  addUsage(usage, workerUsage);
  await bible.persist();

  // ── STEP D: Verify (with one remediation round) ──────────────────────────
  let allPass = false;
  let verificationSummary = '';
  for (let round = 1; round <= 2; round++) {
    throwIfAborted(ctx.signal);
    const verifyStepId = `step-verify-a${attempt}-r${round}`;
    ctx.emit({
      id: verifyStepId,
      stage: 'verify',
      agentRole: 'manager',
      title: round === 1 ? 'Manager AI: Verifying Scenarios Against Workspace' : 'Manager AI: Re-verifying After Remediation',
      detail: 'Checking every Gherkin scenario against the actual files, commands and the event log…',
      status: 'running'
    });
    const executor = createToolExecutor({
      ctx,
      tools,
      scope: { actorLabel: 'manager (verify)', readOnly: false, allowedWritePaths: [] },
      agentRole: 'manager',
      stepIdPrefix: `step-tool-verify-a${attempt}-r${round}`
    });
    const verifyMessage =
      `All pieces have finished. Verify each Gherkin scenario against the ACTUAL workspace state (read files, run tests/commands) and the event log — not against what the pieces claimed. Then return ONLY the verification JSON from your skill ({ allPass, scenarioResults, remediation }).\n\n` +
      `${bible.renderPieces()}\n${bible.renderEventLog({ last: 40 })}` +
      (createdFiles.size > 0 ? `\n### Files written this run\n${Array.from(createdFiles).map((f) => `- ${f}`).join('\n')}\n` : '');
    const result = await runToolLoop({
      ...managerProviderBase,
      model: managerModel,
      stableSystem: managerStable,
      sharedContext: managerContext,
      tools,
      initialUserMessage: verifyMessage,
      // Cap verification rounds strictly: 2 rounds if single piece passed, 4 rounds max otherwise
      maxRounds: pieces.length === 1 && pieces[0].status === 'done' ? Math.min(2, maxRounds) : Math.min(4, maxRounds),
      maxTokens: 8000,
      responseFormat: 'json',
      onToolCalls: executor
    });
    addUsage(usage, result.usage);
    addUsage(ctx.usage, result.usage);
    if (result.stopReason === 'no_tool_support') usedToolCalling = false;
    const parsed = parseJsonLoose<any>(result.text);
    const failedPieces = pieces.filter((p) => p.status !== 'done');
    const scenarioResults: Array<{ scenario: string; pass: boolean; evidence: string }> = Array.isArray(parsed?.scenarioResults)
      ? parsed.scenarioResults.map((r: any) => ({ scenario: String(r?.scenario ?? ''), pass: Boolean(r?.pass), evidence: String(r?.evidence ?? '') }))
      : [];
    allPass = Boolean(parsed?.allPass) && failedPieces.length === 0 && scenarioResults.every((r) => r.pass);
    const healthReport = await verifyDeliverableHealth(Array.from(createdFiles));
    if (!healthReport.ok) {
      allPass = false;
    }
    const failing = scenarioResults.filter((r) => !r.pass);
    verificationSummary =
      (!healthReport.ok ? `[STARTUP SMOKE TEST FAILED] ${healthReport.summaryText} | ` : '') +
      (parsed
        ? `${allPass ? 'All scenarios pass.' : `${failing.length} failing scenario(s).`} ` +
          scenarioResults.map((r) => `${r.pass ? '✓' : '✗'} ${r.scenario}${r.evidence ? ` — ${condense(r.evidence, 240)}` : ''}`).join(' | ')
        : `Verification returned no parseable JSON${result.error ? ` (${result.error})` : ''}: ${condense(result.text, 500)}`) +
      (failedPieces.length > 0 ? ` | Unfinished pieces: ${failedPieces.map((p) => `${p.id} (${p.status})`).join(', ')}` : '');
    bible.appendEvent({ actor: 'manager', kind: 'verify', text: `round ${round}: ${verificationSummary}` });
    ctx.emit({
      id: verifyStepId,
      stage: 'verify',
      agentRole: 'manager',
      title: allPass ? 'Manager AI: All Scenarios Verified' : `Manager AI: Verification Found ${failing.length + failedPieces.length} Issue(s)`,
      detail: verificationSummary,
      status: allPass ? 'success' : 'warning',
      usage: { ...result.usage }
    });
    await bible.persist();

    if (allPass || round === 2) break;

    // Remediation: convert the manager's proposed fixes into new when pieces + a final then piece.
    const remediation: any[] = Array.isArray(parsed?.remediation) ? parsed.remediation : [];
    const retryable = failedPieces.filter((p) => p.status === 'failed' || p.status === 'blocked');
    if (remediation.length === 0 && retryable.length === 0) break;
    const nextIndex = pieces.length + 1;
    const newPieces = normalizePieces(
      {
        pieces: [
          ...remediation.map((r) => ({ ...r, kind: 'when' })),
          ...retryable.map((p) => ({ title: `Retry: ${p.title}`, instructions: `${p.instructions}\n\nPrevious failure: ${p.lastError || 'unknown'}`, scenarioRefs: p.scenarioRefs, files: p.files, kind: p.kind === 'then' ? 'then' : 'when' }))
        ]
      },
      scenarioTitles,
      nextIndex
    );
    if (newPieces.length === 0) break;
    pieces.push(...newPieces);
    bible.addPieces(newPieces);
    bible.appendEvent({ actor: 'manager', kind: 'retry', text: `Remediation round: ${newPieces.map((p) => `${p.id}:${p.title}`).join('; ')}` });
    ctx.emit({
      id: `step-remediate-a${attempt}`,
      stage: 'retry',
      agentRole: 'manager',
      title: `Manager AI: ${newPieces.length} Remediation Piece(s) Spawned`,
      detail: newPieces.map((p) => `${p.id} [${p.kind}] ${p.title}`).join('\n'),
      status: 'warning'
    });
    await bible.persist();
    const before = { ...workerUsage };
    await runWaves(newPieces);
    addUsage(usage, {
      inputTokens: workerUsage.inputTokens - before.inputTokens,
      outputTokens: workerUsage.outputTokens - before.outputTokens,
      cachedInputTokens: workerUsage.cachedInputTokens - before.cachedInputTokens,
      cacheWriteTokens: workerUsage.cacheWriteTokens - before.cacheWriteTokens,
      calls: workerUsage.calls - before.calls
    });
  }

  console.log('%c[Ergo Agent Pipeline] ── Step 3: Manager complete ──', 'color: #10b981; font-weight: bold;');
  console.log(`Pieces: ${pieces.map((p) => `${p.id}=${p.status}`).join(', ')} | allPass=${allPass} | usage: ${formatUsage(usage)}`);

  return {
    pieces,
    createdFiles: Array.from(createdFiles),
    allScenariosPass: allPass,
    verificationSummary,
    usage,
    usedToolCalling
  };
}
