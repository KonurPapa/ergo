/**
 * Step 2 — Summary: synthesizes the Overview & Execution Brief (Gherkin scenarios, goals,
 * output destination, strictly filtered MCPs, task kind) from the Markdown baseline, then
 * assembles the stable sections of the TASK_CONTEXT.md bible.
 *
 * Token efficiency: ingests Markdown (not pretty-printed JSON) and relies on the skill doc as the
 * single source of Gherkin examples instead of duplicating them in the system prompt.
 */
import { type OverviewDocument, type TaskKind, type TokenUsage, type BibleSections } from '../../types';
import { buildVerboseOverviewAndRequiredMcps } from '../ai';
import { parseJsonLoose } from '../llmClient';
import { type PipelineContext, addUsage, emptyUsage, isAbortError, throwIfAborted, buildToolLoopRequest } from './contracts';
import { buildBibleSections } from './bible';
import { type BaselineContext } from './context';
import { runToolLoop } from './providerLoop';
import { loadPipelineSkill } from './skills';

export interface SummaryResult {
  overviewDoc: OverviewDocument;
  requiredMcps: string[];
  taskKind: TaskKind;
  requiresHardener: boolean;
  hardenerReason?: string;
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
  '"requiredMcps" (array of connected MCP server names/ids actually needed — 0 to 2 typical), ' +
  '"taskKind" (one of coding | writing | research | ops | data | other), ' +
  '"requiresHardener" (boolean: true for large coding/architectural tasks requiring independent QA proof; false for small/generic tasks or single-action MCP calls), ' +
  '"hardenerReason" (short string explaining why Hardener QA is required or skipped).';

export function inferTaskKind(text: string): TaskKind {
  const t = text.toLowerCase();
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

  ctx.emit({
    id: 'step-overview',
    stage: 'overview',
    agentRole: 'summary',
    title: 'Summary AI: Building Gherkin Brief & Tool Plan',
    detail: 'Synthesizing the baseline context into Given-When-Then acceptance scenarios, goals, output destination and the filtered MCP list…',
    status: 'running'
  });

  const serverLines = connectedMcps
    .filter((m) => m.status === 'connected')
    .map((m) => `- ${m.name} (id: ${m.id}) — tools: ${m.tools.map((t) => t.name).join(', ')}`);

  const userMessage =
    `${baseline.baselineMarkdown}\n\n## Connected MCP Servers (choose only what this task needs)\n${serverLines.length > 0 ? serverLines.join('\n') : '- (none connected)'}\n\n` +
    'Produce the Overview & Execution Brief JSON now.';

  let parsed: any = undefined;
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
  throwIfAborted(ctx.signal);

  const { overviewDoc, requiredMcps } = buildVerboseOverviewAndRequiredMcps(
    task,
    brief,
    undefined,
    connectedMcps,
    parsed,
    baseline.memoryHits
  );

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

  const rawKind = typeof parsed?.taskKind === 'string' ? parsed.taskKind.trim().toLowerCase() : '';
  const taskKind: TaskKind = (TASK_KINDS as string[]).includes(rawKind)
    ? (rawKind as TaskKind)
    : inferTaskKind(`${task.category} ${task.title} ${task.subtasks.map((s) => s.text).join(' ')} ${overviewDoc.output_as}`);
  overviewDoc.taskKind = taskKind;

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
    runId: ctx.runId
  });

  addUsage(ctx.usage, usage);

  console.log('%c[Ergo Agent Pipeline] ── Step 2: Summary → Overview & Execution Brief ──', 'color: #f59e0b; font-weight: bold; font-size: 13px;');
  console.log(JSON.stringify({ brief: overviewDoc.brief, goals: overviewDoc.goals, output_as: overviewDoc.output_as, requiredMcps, taskKind, requiresHardener, hardenerReason }, null, 2));

  ctx.emit({
    id: 'step-overview',
    stage: 'overview',
    agentRole: 'summary',
    title: 'Summary AI: Overview & Tool Plan Ready',
    detail: `Gherkin brief ready — kind: ${taskKind}${requiredMcps.length > 0 ? ` · MCPs: ${requiredMcps.join(', ')}` : ' · no external MCPs'} · hardener: ${requiresHardener ? 'required' : 'skipped'} · output: ${overviewDoc.output_as.slice(0, 90)}`,
    status: 'success',
    overviewDocument: overviewDoc,
    usage: { ...usage }
  });

  return { overviewDoc, requiredMcps, taskKind, requiresHardener, hardenerReason, sections, usage };
}
