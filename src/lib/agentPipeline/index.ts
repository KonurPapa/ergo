/**
 * Agent Execution Pipeline orchestrator.
 *
 *   Step 1 Discovery  → compact Markdown baseline (fast model)
 *   Step 2 Summary    → Gherkin brief, goals, output, filtered MCPs, task kind → TASK_CONTEXT.md bible
 *   Step 3 Manager    → decompose → fan-out workers (clean contexts, locks, cache warming) → verify
 *   Step 4 Cleaner    → lint/format (coding only)
 *   Step 5 Hardener   → QA verdict; a fail feeds a fresh Step 3 attempt (bounded by maxQaRetries)
 *   Final  Logger     → Build & Verification + Completion records, human review steps
 *
 * See docs/AI_WORKFLOW_ARCHITECTURE_2.md. Real errors are surfaced (never faked by the offline simulator).
 */
import {
  type TaskItem,
  type AgentContextItem,
  type ProjectData,
  type AIProviderConfig,
  type MCPServer,
  type ExecutionStep,
  type McpToolPermissionPrompt,
  type HumanInputPrompt,
  type AgentPipelineOptions,
  type TaskKind
} from '../../types';
import { runOfflineExecution } from '../ai';
import { getAllowedRoots } from '../mcpClient';
import { DEFAULT_AGENT_PIPELINE_OPTIONS, type PipelineContext, emptyUsage, formatUsage, isAbortError, slugify } from './contracts';
import { BibleStore, FileLockRegistry } from './bible';
import { runDiscovery } from './discovery';
import { runSummary } from './summary';
import { buildToolDefinitions } from './toolSchemas';
import { runManager, type ManagerRunResult } from './manager';
import { runCleaner } from './cleaner';
import { runHardener, type HardenerResult } from './hardener';
import { runLogger } from './logger';

export interface HardenerEvaluation {
  shouldRun: boolean;
  reason: string;
}

/**
 * Intelligent two-tier Determiner for Step 5 Hardener:
 * 1. Tier 1: Summary agent upfront classification (0 extra tokens).
 * 2. Tier 2: Post-execution empirical scope safeguard (0 extra tokens).
 */
export function evaluateHardenerNecessity(params: {
  enableHardenerOption: boolean;
  summaryRequiresHardener?: boolean;
  summaryReason?: string;
  taskKind: TaskKind;
  createdFilesCount: number;
  piecesCount: number;
  allScenariosPass: boolean;
  attempt: number;
  createdFiles?: string[];
}): HardenerEvaluation {
  if (!params.enableHardenerOption) {
    return {
      shouldRun: false,
      reason: 'Hardener is disabled globally in Settings.'
    };
  }

  // If this is a retry attempt, re-run Hardener to verify fixes
  if (params.attempt > 1) {
    return {
      shouldRun: true,
      reason: `Re-evaluating Hardener on retry attempt ${params.attempt} to verify fixes.`
    };
  }

  const fileList = params.createdFiles || [];
  const hasWebDeliverable = fileList.some((f) => /\.(html|htm|jsx|tsx|vue|svelte)$/i.test(f));
  const isSingleStandaloneFile = params.createdFilesCount === 1 && !hasWebDeliverable;

  // Single standalone non-web file with passed manager scenarios: cleanly skip Hardener
  if (isSingleStandaloneFile && params.piecesCount <= 2 && params.allScenariosPass) {
    return {
      shouldRun: false,
      reason: `Single standalone file created (${fileList[0] || 'deliverable'}) and scenarios verified by manager. Skipping Hardener to conserve tokens.`
    };
  }

  // Tier 1: Summary Agent's upfront classification
  if (params.summaryRequiresHardener === true) {
    // Quality-control sanity check: if it was a complete no-op (0 files modified, 1 simple piece, scenarios already pass), skip
    if (params.createdFilesCount === 0 && params.piecesCount <= 1 && params.allScenariosPass) {
      return {
        shouldRun: false,
        reason: 'Summary flagged for Hardener, but execution completed with 0 file changes and 1 piece (trivial scope). Skipping Hardener to conserve tokens.'
      };
    }
    return {
      shouldRun: true,
      reason: params.summaryReason || (hasWebDeliverable ? 'Web deliverable detected; running Hardener QA validation.' : 'Summary classified task as large/complex requiring independent QA proof.')
    };
  }

  // Web deliverable safeguard: web tasks benefit from QA validation (e.g. headless browser checks)
  if (hasWebDeliverable) {
    return {
      shouldRun: true,
      reason: `Web deliverable detected (${fileList.filter((f) => /\.(html|htm|jsx|tsx|vue|svelte)$/i.test(f)).join(', ')}); running Hardener to verify via browser/UI testing.`
    };
  }

  // Tier 2: Post-execution empirical scope safeguard
  // If Summary thought it was a small task, check if the actual execution expanded
  const isEmpiricallyLarge =
    params.createdFilesCount >= 2 ||
    params.piecesCount >= 3 ||
    !params.allScenariosPass;

  if (isEmpiricallyLarge) {
    return {
      shouldRun: true,
      reason: `Escalated to Hardener post-execution: task execution exceeded small scope (${params.createdFilesCount} files created/modified, ${params.piecesCount} puzzle pieces, all scenarios pass: ${params.allScenariosPass}).`
    };
  }

  // Otherwise, small/generic task: cleanly skip Hardener to save tokens
  return {
    shouldRun: false,
    reason: params.summaryReason || `Task classified as small/generic (${params.taskKind}, ${params.createdFilesCount} files, ${params.piecesCount} piece(s)). Hardener skipped for token efficiency.`
  };
}

function makeRunId(): string {
  return `${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 5)}`;
}

export async function executeTaskWithAi(
  task: TaskItem,
  brief: AgentContextItem | undefined,
  project: ProjectData,
  aiConfig: AIProviderConfig,
  connectedMcps: MCPServer[],
  onStepUpdate: (step: ExecutionStep) => void,
  onRequestPermission?: (prompt: McpToolPermissionPrompt) => Promise<boolean>,
  onRequestHumanInput?: (prompt: HumanInputPrompt) => Promise<string>,
  signal?: AbortSignal,
  options?: Partial<AgentPipelineOptions>
): Promise<{ updatedBrief: AgentContextItem; updatedTask: TaskItem }> {
  const isLiveAi =
    aiConfig.provider !== 'none' &&
    aiConfig.provider !== 'mock' &&
    (aiConfig.apiKey || aiConfig.provider === 'ollama');

  if (!isLiveAi) {
    return runOfflineExecution(task, brief, project, connectedMcps, onStepUpdate, onRequestPermission, onRequestHumanInput);
  }

  const runId = makeRunId();
  const runDir = BibleStore.runDirFor(project.id || slugify(project.name || 'project'), task.id, runId);
  const resolvedOptions: AgentPipelineOptions = { ...DEFAULT_AGENT_PIPELINE_OPTIONS, ...(options || {}) };
  let bible: BibleStore | null = null;

  const ctx: PipelineContext = {
    task,
    brief,
    project,
    aiConfig,
    connectedMcps,
    allowedRoots: [],
    options: resolvedOptions,
    runId,
    runDir,
    signal,
    usage: emptyUsage(),
    onStepUpdate,
    onRequestPermission,
    onRequestHumanInput,
    emit: (step) =>
      onStepUpdate({
        time: new Date().toLocaleTimeString(),
        taskId: task.id,
        totalUsage: step.totalUsage || { ...ctx.usage },
        ...step
      } as ExecutionStep)
  };

  try {
    ctx.allowedRoots = await getAllowedRoots();

    console.log('%c[Ergo Agent Pipeline] ── Run started ──', 'color: #38bdf8; font-weight: bold; font-size: 13px;');
    console.log(`Task #${task.id} "${task.title}" · run ${runId} · dir ${runDir} · options`, resolvedOptions);

    // Step 1 + 2
    const discovery = await runDiscovery(ctx);
    const summary = await runSummary(ctx, discovery);

    // Bible + tools (fixed for the whole run — task-boundary decisions)
    bible = new BibleStore(summary.sections, runDir);
    const locks = new FileLockRegistry(runDir);
    bible.appendEvent({ actor: 'pipeline', kind: 'info', text: `Run ${runId} initialized (attempt policy: ${resolvedOptions.maxQaRetries} QA retr${resolvedOptions.maxQaRetries === 1 ? 'y' : 'ies'}, ${resolvedOptions.maxConcurrentAgents} concurrent worker(s)).` });
    await bible.persist();
    // The filesystem harness is always available because deliverables land in files; everything else is filtered to what Summary required.
    const requiredSet = Array.from(new Set([...summary.requiredMcps, 'mcp-filesystem']));
    const tools = buildToolDefinitions(connectedMcps, requiredSet);

    console.log('%c[Ergo Agent Pipeline] ── Step 3: TASK_CONTEXT.md bible ──', 'color: #10b981; font-weight: bold; font-size: 13px;');
    console.log(bible.renderStable());
    console.log('Tools (byte-stable for this run):', tools.map((t) => t.name).join(', '));

    // Step 3 → 4 → 5 with bounded QA retry loop
    const createdFiles = new Set<string>();
    let mgr: ManagerRunResult | null = null;
    let hardener: HardenerResult | undefined;
    let diagnostics: string | undefined;
    let attempt = 1;
    const maxAttempts = 1 + Math.max(0, resolvedOptions.maxQaRetries);
    for (; attempt <= maxAttempts; attempt++) {
      mgr = await runManager(ctx, bible, tools, locks, attempt, diagnostics);
      for (const f of mgr.createdFiles) createdFiles.add(f);

      // Run Cleaner only for coding tasks that produced code, skipping standalone static files (e.g. single .html)
      const filesArray = Array.from(createdFiles);
      const isStandaloneStatic = filesArray.length === 1 && /\.(html|htm|md|txt)$/i.test(filesArray[0]);
      if (summary.taskKind === 'coding' && resolvedOptions.enableCleaner && filesArray.length > 0 && !isStandaloneStatic) {
        await runCleaner(ctx, bible, tools, filesArray, attempt);
      } else if (isStandaloneStatic) {
        bible.appendEvent({ actor: 'pipeline', kind: 'info', text: `Step 4 Cleaner skipped: single standalone file (${filesArray[0]}) needs no package lint/format pass.` });
        await bible.persist();
      }

      const hardenerEval = evaluateHardenerNecessity({
        enableHardenerOption: resolvedOptions.enableHardener,
        summaryRequiresHardener: summary.requiresHardener,
        summaryReason: summary.hardenerReason,
        taskKind: summary.taskKind,
        createdFilesCount: createdFiles.size,
        piecesCount: mgr.pieces.length,
        allScenariosPass: mgr.allScenariosPass,
        attempt,
        createdFiles: Array.from(createdFiles)
      });

      if (!hardenerEval.shouldRun) {
        bible.appendEvent({ actor: 'pipeline', kind: 'info', text: `Step 5 Hardener skipped: ${hardenerEval.reason}` });
        await bible.persist();
        ctx.emit({
          id: `step-hardener-skipped-a${attempt}`,
          stage: 'hardener',
          agentRole: 'hardener',
          title: 'Hardener QA: Skipped (Token Efficiency)',
          detail: hardenerEval.reason,
          status: 'success'
        });
        break;
      }

      hardener = await runHardener(ctx, bible, tools, summary.taskKind, Array.from(createdFiles), attempt);
      if (hardener.verdict !== 'fail') break;
      if (attempt >= maxAttempts) break;

      diagnostics = hardener.failures.map((f) => `- [${f.scenario}] ${f.diagnostics}`).join('\n') + (hardener.evidence ? `\n\nEvidence: ${hardener.evidence}` : '');
      bible.appendEvent({ actor: 'pipeline', kind: 'retry', text: `QA failed on attempt ${attempt}; re-running the manager with fresh contexts and the diagnostics above.` });
      await bible.persist();
      ctx.emit({
        id: `step-retry-${attempt}`,
        stage: 'retry',
        title: `QA Failed — Retrying Manager (attempt ${attempt + 1} of ${maxAttempts})`,
        detail: hardener.failures.map((f) => `✗ ${f.scenario}: ${f.diagnostics.slice(0, 200)}`).join('\n'),
        status: 'warning'
      });
    }
    if (attempt > maxAttempts) attempt = maxAttempts;
    if (!mgr) throw new Error('Manager did not run.');

    const result = await runLogger(ctx, bible, {
      createdFiles: Array.from(createdFiles),
      usedToolCalling: mgr.usedToolCalling,
      hardener,
      qaAttempts: attempt,
      allScenariosPass: mgr.allScenariosPass
    });
    bible.appendEvent({ actor: 'pipeline', kind: 'info', text: `Run complete — status ${result.updatedTask.status}; usage ${formatUsage(ctx.usage)}.` });
    await bible.persist();
    console.log('%c[Ergo Agent Pipeline] ── Pipeline Complete ✅ ──', 'color: #10b981; font-weight: bold;');
    return result;
  } catch (err: any) {
    if (isAbortError(err)) {
      console.log('%c[Ergo Agent Pipeline] ── Terminated by User ──', 'color: #ef4444; font-weight: bold;');
      if (bible) {
        bible.appendEvent({ actor: 'pipeline', kind: 'info', text: 'Run terminated by user.' });
        void bible.persist();
      }
      ctx.emit({
        id: 'step-terminated',
        stage: 'terminating',
        title: 'Agent Terminated',
        detail: 'The agent was stopped by the user. Any completed tool calls are preserved in the build log' + (bible ? ` and in ${bible.filePath}` : '') + '.',
        status: 'cancelled'
      });
      const partialBrief: AgentContextItem = {
        ...brief,
        id: brief?.id || `brief_${task.id}`,
        sourceTaskId: task.id,
        sourceLaneId: task.swimLaneId || brief?.sourceLaneId,
        itemNumber: brief?.itemNumber,
        title: task.title,
        status: 'not_started',
        overview: brief?.overview || brief?.brief || `Task (${task.title})`,
        buildAndVerification: brief?.buildAndVerification || '',
        completion: '',
        createdFiles: [],
        totalUsage: { ...ctx.usage },
        brief: brief?.overview || brief?.brief || `Task (${task.title})`,
        built: brief?.buildAndVerification || '',
        validation: '',
        humanReview: '',
        followUps: ''
      };
      return { updatedBrief: partialBrief, updatedTask: { ...task, status: 'not_started', isDone: false, totalUsage: { ...ctx.usage } } };
    }

    const message = err?.message || String(err);
    console.error('[Ergo Agent Pipeline] Pipeline error:', err);
    if (bible) {
      bible.appendEvent({ actor: 'pipeline', kind: 'error', text: `Pipeline error: ${message}` });
      void bible.persist();
    }
    ctx.emit({
      id: 'step-pipeline-error',
      stage: 'execution',
      title: 'Pipeline Error',
      detail: `${message}${bible ? ` — details preserved in ${bible.filePath}` : ''}`,
      status: 'error'
    });
    const dateStr = new Date().toISOString().split('T')[0];
    const errorNote = `\n\n**Pipeline error (${dateStr}):** ${message}${bible ? `\nSee ${bible.filePath}` : ''}`;
    const updatedBrief: AgentContextItem = {
      ...brief,
      id: brief?.id || `brief_${task.id}`,
      sourceTaskId: task.id,
      sourceLaneId: task.swimLaneId || brief?.sourceLaneId,
      itemNumber: brief?.itemNumber,
      title: task.title,
      status: brief?.status || 'not_started',
      overview: brief?.overview || brief?.brief || `Task #${task.id}: ${task.title}`,
      buildAndVerification: `${brief?.buildAndVerification || ''}${errorNote}`.trim(),
      completion: brief?.completion || '',
      createdFiles: brief?.createdFiles || [],
      totalUsage: { ...ctx.usage }
    };
    return { updatedBrief, updatedTask: { ...task, status: 'not_started', isDone: false, totalUsage: { ...ctx.usage } } };
  }
}
