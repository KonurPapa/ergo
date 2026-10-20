/**
 * Step 2 — Summary: synthesizes the Overview & Execution Brief (Gherkin scenarios, goals,
 * output destination, strictly filtered MCPs, task kind) from the Markdown baseline, then
 * assembles the stable sections of the TASK_CONTEXT.md bible.
 *
 * Token efficiency: ingests Markdown (not pretty-printed JSON) and relies on the skill doc as the
 * single source of Gherkin examples instead of duplicating them in the system prompt.
 */
import { type OverviewDocument, type TaskKind, type TaskRating, type TokenUsage, type BibleSections } from '../../types';
import { buildVerboseOverviewAndRequiredMcps } from '../ai';
import { parseJsonLoose } from '../llmClient';
import { type PipelineContext, addUsage, emptyUsage, isAbortError, throwIfAborted, buildToolLoopRequest } from './contracts';
import { buildBibleSections } from './bible';
import { type BaselineContext } from './context';
import { runToolLoop } from './providerLoop';
import { loadPipelineSkill } from './skills';
import { isOverviewReusable, overviewDocumentFor } from '../overviewUtils';
import { formatSelectedRelatedContext, resolveSavedRelatedIds, savedRelatedSelection, strictRelatedFallback } from '../memory/relatedTasks';
import { normalizeTaskRating } from './taskRating';
import { TASK_RATING_SCALES } from './autoRouter';

export interface SummaryResult {
  overviewDoc: OverviewDocument;
  requiredMcps: string[];
  taskKind: TaskKind;
  requiresHardener: boolean;
  hardenerReason?: string;
  /** How demanding the task is (Auto model selection); undefined when the model didn't rate it. */
  taskRating?: TaskRating;
  sections: BibleSections;
  usage: TokenUsage;
}

/** Formats structured OverviewDocument into clean Markdown with goals and output destination (Gherkin optional). */
export function formatOverviewDocToMarkdown(
  doc?: OverviewDocument | null,
  options: { includeGherkin?: boolean } = { includeGherkin: false }
): string {
  if (!doc) return '';
  if (doc.raw && doc.raw.trim().length > 0) return doc.raw.trim();
  const parts: string[] = [];
  if (options.includeGherkin && doc.brief) {
    parts.push(`## Acceptance Brief (Gherkin)\n\n\`\`\`gherkin\n${doc.brief.trim()}\n\`\`\``);
  }
  if (doc.goals) {
    parts.push(`## Goals & Success Criteria\n\n${doc.goals.trim()}`);
  }
  if (doc.output_as) {
    parts.push(`## Output Destination\n\n${doc.output_as.trim()}`);
  }
  return parts.join('\n\n');
}

const TASK_KINDS: TaskKind[] = ['coding', 'writing', 'research', 'ops', 'data', 'other'];

const OUTPUT_CONTRACT =
  'OUTPUT CONTRACT: return ONLY valid JSON (no markdown fences) with exactly these keys: ' +
  '"brief" (Gherkin scenarios as a single string), "goals" (numbered checklist string), "output_as" (string: exact destination paths and MCP tool used — do NOT instruct agents to edit AGENT_CONTEXT.md or TODO.md), ' +
  '"requiredMcps" (array of connected MCP server names/ids actually needed — 0 to 2 typical; provision shell/process-execution tools or domain MCPs like Godot whenever headless execution, scripts, tests, or CLI commands are involved), ' +
  '"taskKind" (one of coding | writing | research | ops | data | other — MUST be "coding" if the task contains verbs like write, script, scaffold, compile, or references languages/extensions like .py, .ts, .sh), ' +
  '"requiresHardener" (boolean: true for large coding/architectural tasks requiring independent QA proof; false for small/generic tasks or single-action MCP calls), ' +
  '"hardenerReason" (short string explaining why Hardener QA is required or skipped), ' +
  '"relatedTaskIds" (array of ids from the "Candidate Related Tasks" list whose content is genuinely useful context for THIS task — a shared feature area, a dependency, prior work to build on, or a conflict to avoid; [] when none are or there is no list; 0 to 5 typical), ' +
  `"taskRating" (object {"complexity": 1-5, "reasoning": 1-5} rating how demanding the task is — ${TASK_RATING_SCALES}).`;

/**
 * The related-task ids the Summary model returned, kept only when they name one of the candidates it was shown
 * (as strings, deduped, in the model's order). Accepts an array or a comma-separated string; anything else → [].
 */
export function validateRelatedTaskIds(ids: unknown, candidates: ReadonlyArray<{ taskId: string | number }>): string[] {
  const known = new Set(candidates.map((c) => String(c.taskId)));
  const raw: unknown[] = Array.isArray(ids) ? ids : typeof ids === 'string' ? ids.split(/[,;\s]+/) : [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    const id = String(v).replace(/^[\s[\]("'`#]+|[\s[\])"'`.]+$/g, '').trim();
    if (id && known.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

export function isExplicitCodeTask(text: string): boolean {
  const t = text.toLowerCase();
  // File extensions referencing code/scripts/markup/configs
  if (/\.(py|ts|tsx|js|jsx|sh|bash|rs|go|c|cpp|h|hpp|rb|php|java|cs|gd|tscn|tres|html|css|json|yaml|yml|sql)\b/i.test(t)) return true;
  // Code generation verbs/nouns
  if (/\b(script|scripts|scaffold|scaffolding|compile|compiling|parser|function|class|method|endpoint|refactor|unit\s+test|integration\s+test)\b/i.test(t)) return true;
  // Specific languages/runtimes/frameworks
  if (/\b(python|typescript|javascript|bash|shell|golang|rust|c\+\+|godot|gdscript|node|react)\b/i.test(t)) return true;
  // Code creation verbs
  if (/\b(write|create|implement|build|scaffold)\s+(?:a\s+)?(?:python|typescript|javascript|bash|shell|node|script|program|module|plugin|handler|service|parser|code|test|class|function|api)\b/i.test(t)) return true;
  return false;
}

export function normalizeTaskKind(val: any): TaskKind {
  if (typeof val === 'string') {
    const v = val.trim().toLowerCase();
    if (v === 'code' || v === 'coding') return 'coding';
    if (TASK_KINDS.includes(v as TaskKind)) return v as TaskKind;
  }
  return 'other';
}

export function requiresCliOrProcessTools(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /\b(cli|headless|terminal|shell|command|bash|run|exec|execute|script|test|verify|compile|export|flags?)\b/i.test(t) ||
    /\b(python|node|npm|cargo|pytest|godot)\b/i.test(t) ||
    /\.(py|sh|bash|js|ts)\b/i.test(t)
  );
}

export function inferTaskKind(text: string): TaskKind {
  const t = text.toLowerCase();
  if (isExplicitCodeTask(t)) return 'coding';
  if (/\b(code|coding|component|api|endpoint|function|class|test|bug|refactor|script|html|css|javascript|typescript|python|react|sql|schema|build|compile|lint|repo|git)\b/.test(t)) return 'coding';
  if (/\b(write|draft|article|pitch|outline|essay|blog|email|copy|document|documentation|readme|spec|proposal)\b/.test(t)) return 'writing';
  if (/\b(research|analy[sz]e|analysis|compare|investigate|survey|study|summari[sz]e|review literature)\b/.test(t)) return 'research';
  if (/\b(deploy|configure|config|server|install|migrate|backup|monitor|infra|devops|pipeline)\b/.test(t)) return 'ops';
  if (/\b(dataset|csv|spreadsheet|table|chart|metrics|statistics|etl|query|database)\b/.test(t)) return 'data';
  return 'other';
}

export async function runSummary(ctx: PipelineContext, baseline: BaselineContext): Promise<SummaryResult> {
  const { task, brief, connectedMcps } = ctx;
  const usage = emptyUsage();

  // ── REUSE ──────────────────────────────────────────────────────────────────
  // The overview from an earlier run (or the user's own) is kept on the brief; reruns reuse it instead of paying
  // for a new Summary call, unless the task's text changed since it was generated.
  const reusedDoc = brief && isOverviewReusable(brief, task) ? overviewDocumentFor(brief) : null;

  // Task kind, MCP selection and the Hardener decision come from this step's own model call (or its heuristics).
  // A small local model was evaluated for them (40 labelled tasks: task kind 48%, MCP selection ≤60% exact) and is
  // not used here; it only decides the shape of CLI runs (src/lib/localModel/decisions.ts).

  let parsed: any = undefined;
  if (reusedDoc) {
    // Carry the saved classification through the same post-processing as a fresh result.
    parsed = { taskKind: reusedDoc.taskKind, requiresHardener: reusedDoc.requiresHardener, hardenerReason: reusedDoc.hardenerReason };
  } else {
    ctx.emit({
      id: 'step-overview',
      stage: 'overview',
      agentRole: 'summary',
      title: 'Summary AI: Building Gherkin Brief & Tool Plan',
      detail: 'Synthesizing the baseline context into Given-When-Then acceptance scenarios, goals, output destination and the filtered MCP list…',
      status: 'running'
    });

    const serverLines = connectedMcps.filter((m) => m.status === 'connected').map((m) => `- ${m.name} (id: ${m.id}) — tools: ${m.tools.map((t) => t.name).join(', ')}`);

    const relatedGuidance = baseline.relatedCandidates.length > 0
      ? '\nRELATED TASKS: put in "relatedTaskIds" only the candidates that are genuinely useful context for this task. ' +
        'When this task is sparse, use the selected tasks\' context (what they built, their subtasks) to fill gaps in goals and output_as — never copy their requirements into this task.\n'
      : '';
    const userMessage =
      `${baseline.baselineMarkdown}\n\n## Connected MCP Servers (choose only what this task needs)\n${serverLines.length > 0 ? serverLines.join('\n') : '- (none connected)'}\n${relatedGuidance}\n\n` +
      'Produce the Overview & Execution Brief JSON now.';

    try {
      const skill = await loadPipelineSkill('summary-agent');
      const result = await runToolLoop(
        buildToolLoopRequest(ctx, 'summary', {
          stableSystem: `${skill}\n\n${OUTPUT_CONTRACT}`,
          sharedContext: '',
          tools: [],
          initialUserMessage: userMessage,
          maxRounds: 1,
          maxTokens: 6000,
          responseFormat: 'json'
        })
      );
      addUsage(usage, result.usage);
      if (result.stopReason === 'error') {
        console.warn('[Ergo Summary] model call failed, using fallback overview:', result.error);
      }
      parsed = parseJsonLoose(result.text) || undefined;
    } catch (e) {
      if (isAbortError(e)) throw e;
      console.warn('[Ergo Summary] failed, using fallback overview:', e);
    }
  }
  throwIfAborted(ctx.signal);

  const { overviewDoc, requiredMcps } = reusedDoc
    ? {
        overviewDoc: reusedDoc,
        // The saved tool selection, limited to servers still connected.
        requiredMcps: (reusedDoc.requiredMcps || []).filter((id) => connectedMcps.some((m) => m.id === id || m.name === id)),
      }
    : buildVerboseOverviewAndRequiredMcps(task, brief, undefined, connectedMcps, parsed, baseline.memoryHits);

  // Completeness Guard: Ensure all explicit task subtasks are preserved in overviewDoc.goals
  if (task.subtasks.length > 0) {
    const goalsLower = (overviewDoc.goals || '').toLowerCase();
    const missingSubtasks = task.subtasks.filter((s) => {
      const cleanText = s.text.replace(/^[0-9]+[.)-]\s*/, '').trim().toLowerCase();
      const significantWords = cleanText.split(/\s+/).filter((w) => w.length >= 4);
      if (significantWords.length === 0) return !goalsLower.includes(cleanText);
      const matchCount = significantWords.filter((w) => goalsLower.includes(w)).length;
      return matchCount < Math.min(2, significantWords.length);
    });

    if (missingSubtasks.length > 0) {
      const currentGoals = (overviewDoc.goals || '').trim();
      const existingNumberedCount = (currentGoals.match(/^\d+\./gm) || []).length;
      const appendedGoals = missingSubtasks
        .map((s, idx) => `${existingNumberedCount + idx + 1}. Complete subtask: ${s.text}${s.isDone ? ' [Completed]' : ''}`)
        .join('\n');
      overviewDoc.goals = currentGoals ? `${currentGoals}\n${appendedGoals}` : appendedGoals;
    }
  }

  const combinedText = `${task.category} ${task.title} ${task.subtasks.map((s) => s.text).join(' ')} ${overviewDoc.output_as} ${overviewDoc.brief || ''}`;
  let taskKind: TaskKind = normalizeTaskKind(parsed?.taskKind);
  if (!taskKind || taskKind === 'other') {
    taskKind = inferTaskKind(combinedText);
  }
  // Enforce strict heuristic: if the task contains verbs like write, script, scaffold, compile, or references languages/extensions (.py, .ts, .sh), force Task Kind: coding
  if (isExplicitCodeTask(combinedText)) {
    taskKind = 'coding';
  }
  overviewDoc.taskKind = taskKind;
  // Task rating (Auto model selection): saved with the overview, so a reused overview keeps its rating.
  const taskRating = reusedDoc ? reusedDoc.taskRating : normalizeTaskRating(parsed?.taskRating, 'overview', taskKind);
  if (taskRating) overviewDoc.taskRating = taskRating;
  else delete overviewDoc.taskRating;

  // Dynamic Tool Provisioning: if headless CLI, shell, script execution, or domain runners (e.g. Godot) are required,
  // ensure shell/process-execution tool and relevant domain MCP servers are provisioned alongside mcp-filesystem.
  if (requiresCliOrProcessTools(combinedText)) {
    for (const mcp of connectedMcps) {
      if (mcp.status === 'connected') {
        const idLower = mcp.id.toLowerCase();
        const nameLower = mcp.name.toLowerCase();
        const isGodotTask = combinedText.toLowerCase().includes('godot');
        const isGodotServer = idLower.includes('godot') || nameLower.includes('godot');
        const isShellOrProcessServer =
          idLower.includes('shell') || idLower.includes('bash') || idLower.includes('terminal') || idLower.includes('command') ||
          mcp.tools.some((t) => ['run_command', 'bash', 'terminal', 'exec', 'run_project', 'launch_editor'].includes(t.name.toLowerCase()));

        if ((isGodotTask && isGodotServer) || isShellOrProcessServer) {
          if (!requiredMcps.includes(mcp.id) && !requiredMcps.includes(mcp.name)) {
            requiredMcps.push(mcp.id);
          }
        }
      }
    }
  }

  const outputText = (overviewDoc.output_as || '').toLowerCase();
  const titleText = (task.title || '').toLowerCase();
  const isStandaloneSingleDeliverable =
    /\.(html|htm|jsx|tsx|vue|svelte|py|sh|ts|js|md|json|css|sql|txt|csv|tsv|yaml|yml)\b/i.test(outputText) ||
    /build an? (?:html|browser|standalone|simple) (?:game|page|script|app|tool)/i.test(titleText) ||
    /create an? (?:html|browser|standalone|simple) (?:game|page|script|app|tool)/i.test(titleText);
  const isSmallScope = task.subtasks.length <= 3;

  let requiresHardener: boolean;
  let hardenerReason: string | undefined;

  if (isStandaloneSingleDeliverable && isSmallScope) {
    // Single deliverable / standalone tasks (e.g. single HTML game, standalone script) MUST skip Hardener to conserve tokens
    requiresHardener = false;
    hardenerReason = 'Standalone single deliverable; skipping Hardener to conserve tokens per workflow rules.';
  } else if (typeof parsed?.requiresHardener === 'boolean') {
    requiresHardener = parsed.requiresHardener;
    hardenerReason = typeof parsed.hardenerReason === 'string' && parsed.hardenerReason.trim()
      ? parsed.hardenerReason.trim()
      : undefined;
  } else {
    // Intelligent heuristic fallback: large coding tasks across multiple files or complex architecture warrant Hardener QA.
    // Standalone single-file tasks (e.g. single html/script/doc) or simple tasks skip it to conserve tokens.
    const isMultiFileOrComplex =
      taskKind === 'coding' &&
      !/\b(single|isolated|pure html|standalone|one file)\b/i.test(`${task.title} ${task.subtasks.map((s) => s.text).join(' ')}`) &&
      (task.subtasks.length >= 3 || (overviewDoc.goals && overviewDoc.goals.split('\n').filter(Boolean).length >= 3));

    if (isMultiFileOrComplex) {
      requiresHardener = true;
      hardenerReason = 'Complex coding task with multiple deliverables warrants independent QA validation.';
    } else {
      requiresHardener = false;
      hardenerReason = 'Task scope is small, standalone or generic; skipping Hardener to conserve tokens.';
    }
  }
  overviewDoc.requiresHardener = requiresHardener;
  overviewDoc.hardenerReason = hardenerReason;
  overviewDoc.requiredMcps = [...requiredMcps];

  // ── Related tasks (stage 2) ────────────────────────────────────────────────
  // Fresh: the ids the model picked from the candidates. Reuse: the selection saved with the overview (no call),
  // limited to tasks that are still candidates. Undefined: a reused overview saved before selections existed.
  const candidates = baseline.relatedCandidates || [];
  let selectedRelatedTaskIds: string[] | undefined;
  if (reusedDoc) {
    selectedRelatedTaskIds = resolveSavedRelatedIds(reusedDoc.relatedTaskIds ? reusedDoc : brief?.overviewDocument, candidates);
  } else if (baseline.relatedSearchOk) {
    // The model's choice when it answered; if the call failed or skipped the field, the candidates that clearly
    // stand out locally. (No search at all: undefined, not "none needed".)
    selectedRelatedTaskIds =
      parsed && parsed.relatedTaskIds !== undefined
        ? validateRelatedTaskIds(parsed.relatedTaskIds, candidates)
        : strictRelatedFallback(candidates);
    Object.assign(overviewDoc, savedRelatedSelection(candidates, selectedRelatedTaskIds));
  }
  const relatedContext =
    selectedRelatedTaskIds && selectedRelatedTaskIds.length > 0 && candidates.length > 0
      ? formatSelectedRelatedContext(candidates, selectedRelatedTaskIds).trim()
      : '';

  const sections = buildBibleSections({
    task,
    project: ctx.project,
    overviewDoc,
    requiredMcps,
    taskKind,
    requiresHardener,
    hardenerReason,
    allowedRoots: ctx.allowedRoots,
    guidelines: baseline.guidelines,
    memoryHits: baseline.memoryHits,
    relatedContext,
    runId: ctx.runId
  });

  addUsage(ctx.usage, usage);

  console.log('%c[Ergo Agent Pipeline] ── Step 2: Summary → Overview & Execution Brief ──', 'color: #f59e0b; font-weight: bold; font-size: 13px;');
  console.log(JSON.stringify({ brief: overviewDoc.brief, goals: overviewDoc.goals, output_as: overviewDoc.output_as, requiredMcps, taskKind, requiresHardener, hardenerReason }, null, 2));

  // The context step shows the selection next to its candidates.
  if (selectedRelatedTaskIds && baseline.contextStep) {
    const n = selectedRelatedTaskIds.length;
    ctx.emit({
      id: 'step-context',
      stage: 'context',
      title: baseline.contextStep.title,
      detail: `${baseline.contextStep.detail} ${reusedDoc ? 'Reused the saved selection' : 'Summary selected'}: ${n} related task${n === 1 ? '' : 's'}.`,
      time: baseline.contextStep.time,
      status: 'success',
      usage: emptyUsage(),
      baselineContext: { ...baseline.contextStep.baselineContext, selectedRelatedTaskIds }
    });
  }

  ctx.emit({
    id: 'step-overview',
    stage: 'overview',
    agentRole: 'summary',
    title: reusedDoc ? 'Summary AI: Reused Saved Overview (no new call)' : 'Summary AI: Overview & Tool Plan Ready',
    detail: `${reusedDoc ? 'Reused the overview saved from an earlier run — edit the task to regenerate it. ' : ''}Gherkin brief ready — kind: ${taskKind}${requiredMcps.length > 0 ? ` · MCPs: ${requiredMcps.join(', ')}` : ' · no external MCPs'} · hardener: ${requiresHardener ? 'required' : 'skipped'} · output: ${overviewDoc.output_as.slice(0, 90)}`,
    status: 'success',
    overviewDocument: overviewDoc,
    usage: { ...usage }
  });

  return { overviewDoc, requiredMcps, taskKind, requiresHardener, hardenerReason, ...(taskRating ? { taskRating } : {}), sections, usage };
}
