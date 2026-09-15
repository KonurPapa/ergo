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
  type OllamaFallbackChoice,
  type OllamaFallbackPrompt,
  type AgentPipelineOptions,
  type TaskKind
} from '../../types';
import { runOfflineExecution } from '../ai';
import { getAllowedRoots } from '../mcpClient';
import { DEFAULT_AGENT_PIPELINE_OPTIONS, type PipelineContext, emptyUsage, formatUsage, isAbortError, slugify } from './contracts';
import { BibleStore, FileLockRegistry } from './bible';
import { assembleTaskContext } from './context';
import { runSummary } from './summary';
import { buildToolDefinitions } from './toolSchemas';
import { runManager, isStraightforwardTask, type ManagerRunResult } from './manager';
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
  isStraightforward?: boolean;
}): HardenerEvaluation {
  if (!params.enableHardenerOption) {
    return {
      shouldRun: false,
      reason: 'Hardener is disabled globally in Settings.'
    };
  }

  const fileList = params.createdFiles || [];
  const isSingleStandaloneFile = params.createdFilesCount <= 1;

  // Unconditional Hardener skip for straightforward tasks and single-file deliverables:
  // Solo Manager remediation handles direct fixes; running a 35k-token read-only QA agent on small tasks is wasteful and counterproductive.
  if (params.isStraightforward || isSingleStandaloneFile || params.summaryRequiresHardener === false) {
    // Only escalate if scope empirically exploded into a full multi-component project (>= 3 created files AND >= 3 pieces)
    const exploded = params.createdFilesCount >= 3 && params.piecesCount >= 3;
    if (!exploded) {
      return {
        shouldRun: false,
        reason: params.summaryReason || `Straightforward/standalone deliverable (${fileList[0] || 'deliverable'}); Hardener strictly skipped to conserve tokens.`
      };
    }
  }

  // If this is a retry attempt for multi-piece / multi-file complex tasks, re-run Hardener to verify fixes
  if (params.attempt > 1) {
    return {
      shouldRun: true,
      reason: `Re-evaluating Hardener on retry attempt ${params.attempt} to verify fixes.`
    };
  }

  // Tier 1: Summary Agent explicitly flagged task as large/complex requiring independent QA proof
  if (params.summaryRequiresHardener === true) {
    if (params.createdFilesCount === 0 && params.piecesCount <= 1 && params.allScenariosPass) {
      return {
        shouldRun: false,
        reason: 'Summary flagged for Hardener, but execution completed with 0 file changes and 1 piece (trivial scope). Skipping Hardener to conserve tokens.'
      };
    }
    return {
      shouldRun: true,
      reason: params.summaryReason || 'Summary classified task as large/complex requiring independent QA proof.'
    };
  }

  // Tier 2: Post-execution empirical scope safeguard for complex multi-piece tasks
  const isEmpiricallyLarge =
    params.createdFilesCount >= 3 ||
    params.piecesCount >= 3;

  if (isEmpiricallyLarge) {
    return {
      shouldRun: true,
      reason: `Escalated to Hardener post-execution: task execution exceeded small scope (${params.createdFilesCount} files created/modified, ${params.piecesCount} puzzle pieces).`
    };
  }

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
  options?: Partial<AgentPipelineOptions>,
  onRequestOllamaFallback?: (prompt: OllamaFallbackPrompt) => Promise<OllamaFallbackChoice>
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
  if (aiConfig.provider === 'ollama') {
    // Local Ollama running on local hardware must serialize worker agents to prevent VRAM thrashing and timeouts
    resolvedOptions.maxConcurrentAgents = 1;
  }
  let bible: BibleStore | null = null;
  const createdFiles = new Set<string>([
    ...(task.createdFiles || []),
    ...(brief?.createdFiles || [])
  ]);

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
    ollamaFailureState: { count: 0 },
    onStepUpdate,
    onRequestPermission,
    onRequestHumanInput,
    onRequestOllamaFallback,
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

    // Step 1: Zero-token vector memory & guidelines context assembly
    const baseline = await assembleTaskContext(ctx);
    // Step 2: Summary AI
    const summary = await runSummary(ctx, baseline);

    // Bible + tools (fixed for the whole run — task-boundary decisions)
    bible = new BibleStore(summary.sections, runDir);
    const locks = new FileLockRegistry(runDir);
    const isResumed = task.status === 'partly_done' || brief?.status === 'partly_done' || Boolean(brief?.buildAndVerification && brief.buildAndVerification.trim().length > 0);
    bible.appendEvent({
      actor: 'pipeline',
      kind: 'info',
      text: isResumed
        ? `Run ${runId} resumed from prior progress (attempt policy: ${resolvedOptions.maxQaRetries} QA retr${resolvedOptions.maxQaRetries === 1 ? 'y' : 'ies'}, ${resolvedOptions.maxConcurrentAgents} concurrent worker(s)).`
        : `Run ${runId} initialized (attempt policy: ${resolvedOptions.maxQaRetries} QA retr${resolvedOptions.maxQaRetries === 1 ? 'y' : 'ies'}, ${resolvedOptions.maxConcurrentAgents} concurrent worker(s)).`
    });
    await bible.persist();
    // The filesystem harness is always available because deliverables land in files; everything else is filtered to what Summary required.
    const requiredSet = Array.from(new Set([...summary.requiredMcps, 'mcp-filesystem']));
    const tools = buildToolDefinitions(connectedMcps, requiredSet);

    console.log('%c[Ergo Agent Pipeline] ── Step 3: TASK_CONTEXT.md bible ──', 'color: #10b981; font-weight: bold; font-size: 13px;');
    console.log(bible.renderStable());
    console.log('Tools (byte-stable for this run):', tools.map((t) => t.name).join(', '));

    // Step 3 → 4 → 5 with bounded QA retry loop
    let mgr: ManagerRunResult | null = null;
    let hardener: HardenerResult | undefined;
    let diagnostics: string | undefined;
    let attempt = 1;
    const maxAttempts = 1 + Math.max(0, resolvedOptions.maxQaRetries);
    for (; attempt <= maxAttempts; attempt++) {
      mgr = await runManager(ctx, bible, tools, locks, attempt, diagnostics);
      for (const f of mgr.createdFiles) createdFiles.add(f);

      // Step 4: Cleaner - strictly skipped for straightforward or single-file deliverables to avoid token waste & markup corruption
      const filesArray = Array.from(createdFiles);
      const isStraightforward = isStraightforwardTask(bible);
      const isSingleStandaloneFile = filesArray.length <= 1;
      const shouldRunCleaner =
        resolvedOptions.enableCleaner &&
        summary.taskKind === 'coding' &&
        filesArray.length > 1 &&
        !isStraightforward;

      if (shouldRunCleaner) {
        await runCleaner(ctx, bible, tools, filesArray, attempt);
      } else {
        const skipReason = !resolvedOptions.enableCleaner
          ? 'Cleaner is disabled in pipeline options.'
          : summary.taskKind !== 'coding'
          ? `Non-coding task (${summary.taskKind}) needs no code cleaning.`
          : isStraightforward || isSingleStandaloneFile
          ? `Straightforward / single-file deliverable (${filesArray.join(', ') || 'deliverable'}); Cleaner strictly skipped for token efficiency.`
          : 'No created files recorded.';
        bible.appendEvent({ actor: 'pipeline', kind: 'info', text: `Step 4 Cleaner skipped: ${skipReason}` });
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
        createdFiles: Array.from(createdFiles),
        isStraightforward
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

        // If manager passed all scenarios, the straightforward task is complete
        if (mgr.allScenariosPass) {
          break;
        }

        // If manager verification failed (e.g. deliverable missing on disk), retry up to maxAttempts
        if (attempt >= maxAttempts) {
          break;
        }

        diagnostics = mgr.verificationSummary;
        bible.appendEvent({
          actor: 'pipeline',
          kind: 'retry',
          text: `Manager execution failed verification on attempt ${attempt}; re-running with diagnostics:\n${diagnostics}`
        });
        await bible.persist();
        ctx.emit({
          id: `step-retry-${attempt}`,
          stage: 'retry',
          title: `Manager Execution Failed — Retrying (attempt ${attempt + 1} of ${maxAttempts})`,
          detail: diagnostics.slice(0, 200),
          status: 'warning'
        });
        continue;
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
      allScenariosPass: mgr.allScenariosPass,
      overviewDoc: summary.overviewDoc
    });
    bible.sections.metadata.status = result.updatedTask.status;
    bible.sections.subtasks = result.updatedTask.subtasks.map((s) => ({
      text: s.text,
      isDone: Boolean(s.isDone),
      isHumanReview: Boolean(s.isHumanReview)
    }));
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
        status: 'partly_done',
        overview: brief?.overview || brief?.brief || `Task (${task.title})`,
        buildAndVerification: brief?.buildAndVerification || brief?.built || '',
        completion: brief?.completion || brief?.validation || '',
        createdFiles: Array.from(createdFiles),
        totalUsage: { ...ctx.usage },
        brief: brief?.overview || brief?.brief || `Task (${task.title})`,
        built: brief?.buildAndVerification || brief?.built || '',
        validation: brief?.validation || '',
        humanReview: '',
        followUps: ''
      };
      return { updatedBrief: partialBrief, updatedTask: { ...task, status: 'partly_done', isDone: false, createdFiles: Array.from(createdFiles), totalUsage: { ...ctx.usage } } };
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
