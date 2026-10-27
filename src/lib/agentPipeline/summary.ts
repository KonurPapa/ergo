/**
 * Step 2 — Summary: writes the working brief (docs/skills/task-brief, the same spec CLI runs hand their manager) from
 * the Markdown baseline — task, related tasks and notes, prior knowledge, project guidelines — and picks the MCPs, task
 * kind and Verifier decision. The brief, verbatim, is the spec section of the TASK_CONTEXT.md bible: the manager and
 * workers get nothing else about the task.
 */
import { type AgentContextItem, type MCPServer, type OverviewDocument, type TaskItem, type TaskKind, type TaskRating, type TokenUsage, type BibleSections } from '../../types';
import { extractStringFromAiValue, parseJsonLoose } from '../llmClient';
import { type PipelineContext, addUsage, emptyUsage, isAbortError, throwIfAborted, buildToolLoopRequest } from './contracts';
import { buildBibleSections, doneWhenCriteria } from './bible';
import { buildOfflineTaskBrief } from './taskBrief';
import { type BaselineContext } from './context';
import { runToolLoop } from './providerLoop';
import { loadPipelineSkill } from './skills';
import { formatReferenceNoteForBrief } from '../taskReferences';
import { isOverviewReusable, overviewDocumentFor } from '../overviewUtils';
import {
  RELATED_INTERPRETATION_GUIDANCE,
  relatedSelectionPool,
  resolveSavedRelatedIds,
  savedRelatedSelection,
  strictRelatedFallback,
} from '../memory/relatedTasks';
import { normalizeTaskRating } from './taskRating';
import { TASK_RATING_SCALES } from './autoRouter';

export interface SummaryResult {
  overviewDoc: OverviewDocument;
  requiredMcps: string[];
  taskKind: TaskKind;
  requiresVerifier: boolean;
  verifierReason?: string;
  /** How demanding the task is (Auto model selection); undefined when the model didn't rate it. */
  taskRating?: TaskRating;
  sections: BibleSections;
  usage: TokenUsage;
}

/** The overview's Markdown: the working brief (or, for an overview saved before it, its goals and output). */
export function formatOverviewDocToMarkdown(doc?: OverviewDocument | null): string {
  if (!doc) return '';
  if (doc.raw && doc.raw.trim().length > 0) return doc.raw.trim();
  return [doc.goals, doc.output_as].map((t) => (t || '').trim()).filter(Boolean).join('\n\n');
}

const TASK_KINDS: TaskKind[] = ['coding', 'writing', 'research', 'ops', 'data', 'other'];

const OUTPUT_CONTRACT =
  'OUTPUT CONTRACT: return ONLY valid JSON (no markdown fences) with exactly these keys: ' +
  '"brief" (the working brief as one Markdown string, in exactly the format and headings your skill defines), ' +
  '"requiredMcps" (array of connected MCP server names/ids actually needed — 0 to 2 typical; provision shell/process-execution tools or domain MCPs like Godot whenever headless execution, scripts, tests, or CLI commands are involved), ' +
  '"taskKind" (one of coding | writing | research | ops | data | other — MUST be "coding" if the task contains verbs like write, script, scaffold, compile, or references languages/extensions like .py, .ts, .sh), ' +
  '"requiresVerifier" (boolean: true for large coding/architectural tasks requiring independent verifier proof; false for small/generic tasks or single-action MCP calls), ' +
  '"verifierReason" (short string explaining why Verifier is required or skipped), ' +
  '"relatedTaskIds" (array of ids — task ids or note:… ids — from the "Candidate Related Tasks" list whose content is genuinely useful context for THIS task — a shared feature area, a dependency, prior work to build on, or a conflict to avoid; [] when none are or there is no list; 0 to 5 typical), ' +
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

/**
 * The MCP servers the task needs: the model's picks that name a connected server or one of its tools, plus the user's
 * own selections; without picks, the servers the task's wording points at.
 */
export function resolveRequiredMcps(
  task: TaskItem,
  brief: AgentContextItem | undefined,
  connectedMcps: MCPServer[],
  picked: unknown
): string[] {
  const activeMcps = connectedMcps.filter((m) => m.status === 'connected');
  let resolved: string[] = [];
  if (Array.isArray(picked) && picked.length > 0) {
    resolved = picked
      .map((m) => (typeof m === 'string' ? m.trim() : m && typeof m === 'object' ? (m as any).name || (m as any).id || '' : ''))
      .filter((ref: string) => {
        if (!ref) return false;
        const lower = ref.toLowerCase();
        return activeMcps.some((m) => m.id.toLowerCase() === lower || m.name.toLowerCase() === lower || m.tools.some((t) => t.name.toLowerCase() === lower));
      });
    const userExplicit = [...(task.mcpRequired || []), ...(brief?.requiredMcps || []), ...(brief?.selectedMcpTools || [])];
    if (userExplicit.length > 0) resolved = Array.from(new Set([...resolved, ...userExplicit]));
  }
  if (resolved.length > 0) return resolved;

  const text = `${task.title} ${task.subtasks.map((s) => s.text).join(' ')} ${brief?.overview || ''}`.toLowerCase();
  const find = (pred: (m: MCPServer) => boolean) => activeMcps.find(pred);
  const fs = find((m) => m.id === 'mcp-filesystem' || m.name.toLowerCase().includes('filesystem'));
  const git = find((m) => m.id === 'mcp-git' || m.name.toLowerCase().includes('git'));
  const fetch = find((m) => m.id === 'mcp-fetch' || m.name.toLowerCase().includes('fetch'));
  const godot = find((m) => m.id.toLowerCase().includes('godot') || m.name.toLowerCase().includes('godot'));
  const shell = find((m) => m.id.toLowerCase().includes('shell') || m.id.toLowerCase().includes('bash') || m.id.toLowerCase().includes('terminal') || m.tools.some((t) => t.name === 'run_command'));
  const add = (m: MCPServer | undefined) => {
    if (m && !resolved.includes(m.name)) resolved.push(m.name);
  };
  if (/\b(git|commit|branch|repository)\b/.test(text)) add(git);
  if (/fetch|url|http|api|download/.test(text)) add(fetch);
  if (text.includes('godot')) add(godot);
  if (/cli|headless|terminal|command|script|run|test/.test(text)) add(shell);
  if (/file|code|component|create|write|edit|refactor|implement|script|python/.test(text)) add(fs);
  const category = (task.category || '').toLowerCase();
  if (resolved.length === 0 && fs && (task.subtasks.length > 0 || /code|dev|backend|frontend/.test(category))) add(fs);
  return resolved;
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

  // Task kind, MCP selection and the Verifier decision come from this step's own model call (or its heuristics).
  // A small local model was evaluated for them (40 labelled tasks: task kind 48%, MCP selection ≤60% exact) and is
  // not used here; it only decides the shape of CLI runs (src/lib/localModel/decisions.ts).

  let parsed: any = undefined;
  if (reusedDoc) {
    // Carry the saved classification through the same post-processing as a fresh result.
    parsed = { taskKind: reusedDoc.taskKind, requiresVerifier: reusedDoc.requiresVerifier, verifierReason: reusedDoc.verifierReason };
  } else {
    ctx.emit({
      id: 'step-overview',
      stage: 'overview',
      agentRole: 'summary',
      title: 'Summary AI: Writing the Working Brief',
      detail: 'Folding the task, its related tasks, prior knowledge and project guidelines into the working brief the manager works from, and picking the MCPs…',
      status: 'running'
    });

    const serverLines = connectedMcps.filter((m) => m.status === 'connected').map((m) => `- ${m.name} (id: ${m.id}) — tools: ${m.tools.map((t) => t.name).join(', ')}`);

    const relatedGuidance = baseline.relatedCandidates.length > 0 || baseline.relatedNotes.length > 0
      ? `\n${RELATED_INTERPRETATION_GUIDANCE} Put the selected ids in "relatedTaskIds".\n`
      : '';
    const referencesNote = formatReferenceNoteForBrief(ctx.references);
    const userMessage =
      `${baseline.baselineMarkdown}\n\n${referencesNote ? `## Task Commands\n${referencesNote}\n\n` : ''}## Connected MCP Servers (choose only what this task needs)\n${serverLines.length > 0 ? serverLines.join('\n') : '- (none connected)'}\n${relatedGuidance}\n\n` +
      'Write the working brief JSON now.';

    try {
      const skill = await loadPipelineSkill('task-brief');
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

  // The brief the model wrote; without one (failed call, or no brief in its answer) the offline brief: the task's own
  // checklist in the brief format. The task checklist itself is in the bible either way.
  const writtenBrief = extractStringFromAiValue(parsed?.brief).trim();
  const overviewDoc: OverviewDocument = reusedDoc ?? {
    raw: writtenBrief.length > 30 ? writtenBrief : buildOfflineTaskBrief(task, brief?.overview || brief?.sourceContent || ''),
  };
  const requiredMcps = reusedDoc
    ? // The saved tool selection, limited to servers still connected.
      (reusedDoc.requiredMcps || []).filter((id) => connectedMcps.some((m) => m.id === id || m.name === id))
    : resolveRequiredMcps(task, brief, connectedMcps, parsed?.requiredMcps);

  const combinedText = `${task.category} ${task.title} ${task.subtasks.map((s) => s.text).join(' ')} ${overviewDoc.raw}`;
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

  const outputText = overviewDoc.raw.toLowerCase();
  const titleText = (task.title || '').toLowerCase();
  const isStandaloneSingleDeliverable =
    /\.(html|htm|jsx|tsx|vue|svelte|py|sh|ts|js|md|json|css|sql|txt|csv|tsv|yaml|yml)\b/i.test(outputText) ||
    /build an? (?:html|browser|standalone|simple) (?:game|page|script|app|tool)/i.test(titleText) ||
    /create an? (?:html|browser|standalone|simple) (?:game|page|script|app|tool)/i.test(titleText);
  const isSmallScope = task.subtasks.length <= 3;

  let requiresVerifier: boolean;
  let verifierReason: string | undefined;

  if (isStandaloneSingleDeliverable && isSmallScope) {
    // Single deliverable / standalone tasks (e.g. single HTML game, standalone script) MUST skip Verifier to conserve tokens
    requiresVerifier = false;
    verifierReason = 'Standalone single deliverable; skipping Verifier to conserve tokens per workflow rules.';
  } else if (typeof parsed?.requiresVerifier === 'boolean') {
    requiresVerifier = parsed.requiresVerifier;
    verifierReason = typeof parsed.verifierReason === 'string' && parsed.verifierReason.trim()
      ? parsed.verifierReason.trim()
      : undefined;
  } else {
    // Intelligent heuristic fallback: large coding tasks across multiple files or complex architecture warrant Verifier.
    // Standalone single-file tasks (e.g. single html/script/doc) or simple tasks skip it to conserve tokens.
    const isMultiFileOrComplex =
      taskKind === 'coding' &&
      !/\b(single|isolated|pure html|standalone|one file)\b/i.test(`${task.title} ${task.subtasks.map((s) => s.text).join(' ')}`) &&
      (task.subtasks.length >= 3 || doneWhenCriteria(overviewDoc.raw).length >= 3);

    if (isMultiFileOrComplex) {
      requiresVerifier = true;
      verifierReason = 'Complex coding task with multiple deliverables warrants independent verifier validation.';
    } else {
      requiresVerifier = false;
      verifierReason = 'Task scope is small, standalone or generic; skipping Verifier to conserve tokens.';
    }
  }
  overviewDoc.requiresVerifier = requiresVerifier;
  overviewDoc.verifierReason = verifierReason;
  overviewDoc.requiredMcps = [...requiredMcps];

  // ── Related tasks (stage 2) ────────────────────────────────────────────────
  // Fresh: the ids the model picked from the candidates. Reuse: the selection saved with the overview (no call),
  // limited to tasks that are still candidates. Undefined: a reused overview saved before selections existed.
  const candidates = relatedSelectionPool(baseline.relatedCandidates || [], baseline.relatedNotes || []);
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

  const sections = buildBibleSections({
    task,
    project: ctx.project,
    overviewDoc,
    requiredMcps,
    taskKind,
    requiresVerifier,
    verifierReason,
    allowedRoots: ctx.allowedRoots,
    runId: ctx.runId
  });

  addUsage(ctx.usage, usage);

  console.log('%c[Ergo Agent Pipeline] ── Step 2: Summary → Working Brief ──', 'color: #f59e0b; font-weight: bold; font-size: 13px;');
  console.log(overviewDoc.raw);
  console.log(JSON.stringify({ requiredMcps, taskKind, requiresVerifier, verifierReason }, null, 2));

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
    title: reusedDoc ? 'Summary AI: Reused Saved Brief (no new call)' : 'Summary AI: Working Brief Ready',
    detail: `${reusedDoc ? 'Reused the brief saved from an earlier run — edit the task to regenerate it. ' : ''}Working brief ready — kind: ${taskKind}${requiredMcps.length > 0 ? ` · MCPs: ${requiredMcps.join(', ')}` : ' · no external MCPs'} · verifier: ${requiresVerifier ? 'required' : 'skipped'}`,
    status: 'success',
    overviewDocument: overviewDoc,
    usage: { ...usage }
  });

  return { overviewDoc, requiredMcps, taskKind, requiresVerifier, verifierReason, ...(taskRating ? { taskRating } : {}), sections, usage };
}
