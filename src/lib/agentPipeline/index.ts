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
  type PermissionDecision,
  type HumanInputPrompt,
  type OllamaFallbackChoice,
  type OllamaFallbackPrompt,
  type AgentPipelineOptions,
  type PermissionLevel,
  type AgentRole,
  type OverviewDocument,
  type RunOutcome,
  type TaskRating
} from '../../types';
import { runOfflineExecution } from '../ai';
import { getAllowedRoots } from '../mcpClient';
import { DEFAULT_AGENT_PIPELINE_OPTIONS, type PipelineContext, emptyUsage, formatUsage, isAbortError, resolveRoleTarget, slugify, throwIfAborted } from './contracts';
import { BibleStore, FileLockRegistry } from './bible';
import { assembleTaskContext } from './context';
import { runSummary, requiresCliOrProcessTools, formatOverviewDocToMarkdown } from './summary';
import { buildToolDefinitions } from './toolSchemas';
import { runManager, isStraightforwardTask, type ManagerRunResult } from './manager';
import { runCleaner } from './cleaner';
import { runHardener, type HardenerResult } from './hardener';
import { runLogger } from './logger';
import { routeModelsForRun, describeRouting, familyForTarget, EFFORT_LABELS, type RoutingResult } from './modelRouter';
import { rateTask } from './taskRating';
import { buildRunOutcomeRecord, describeRerunEscalation, rerunEscalation, workEscalation } from './escalation';
import { isOverviewReusable, overviewTaskFingerprint } from '../overviewUtils';
import type { SteeringQueue } from './steeringQueue';
import { pipelineRunKey, rememberPipelineRun } from './runRegistry';

export interface HardenerEvaluation {
  shouldRun: boolean;
  reason: string;
}

/**
 * Step 5 Hardener runs only when the task's "QA verification" switch is on (task menu; off by default: most models
 * check their own work and many tasks are one-shot, so an independent QA pass on every task costs more than it saves).
 * When on, it runs on every attempt, so a QA retry is verified too.
 */
export function evaluateHardenerNecessity(params: { qaVerification: boolean; attempt: number }): HardenerEvaluation {
  if (!params.qaVerification) {
    return { shouldRun: false, reason: "QA verification is off for this task (turn it on from the task's menu)." };
  }
  return {
    shouldRun: true,
    reason: params.attempt > 1 ? `QA verification is on for this task: checking retry attempt ${params.attempt}.` : 'QA verification is on for this task.'
  };
}

/** Options for executeTaskWithAi: pipeline settings plus a live view of the permission level. */
export type ExecuteTaskOptions = Partial<AgentPipelineOptions> & {
  /**
   * Returns the CURRENT permission level. The user can move the Permissions slider while the run is in
   * flight; tool gating and headless CLI rounds read this every time instead of the run-start snapshot.
   */
  getPermissionLevel?: () => PermissionLevel;
  /** The prompt box's mid-run messages: agent loops take them at their next round boundary (steeringQueue.ts). */
  steering?: SteeringQueue;
};

const PERMISSION_LABELS: Record<PermissionLevel, string> = {
  plan: 'Plan (read-only)',
  ask: 'Ask',
  acceptEdits: 'Accept edits',
  bypass: 'Full access'
};

const PERMISSION_LEVEL_SET = new Set<PermissionLevel>(['plan', 'ask', 'acceptEdits', 'bypass']);

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
  onRequestPermission?: (prompt: McpToolPermissionPrompt) => Promise<PermissionDecision>,
  onRequestHumanInput?: (prompt: HumanInputPrompt) => Promise<string>,
  signal?: AbortSignal,
  options?: ExecuteTaskOptions,
  onRequestOllamaFallback?: (prompt: OllamaFallbackPrompt) => Promise<OllamaFallbackChoice>
): Promise<{ updatedBrief: AgentContextItem; updatedTask: TaskItem }> {
  const isLiveAi =
    aiConfig.provider !== 'none' &&
    aiConfig.provider !== 'mock' &&
    (aiConfig.apiKey || aiConfig.provider === 'ollama' || aiConfig.authMode === 'cli_subscription' || aiConfig.provider === 'cli_subscription');

  if (!isLiveAi) {
    return runOfflineExecution(task, brief, project, connectedMcps, onStepUpdate, onRequestPermission, onRequestHumanInput);
  }

  const runId = makeRunId();
  const runDir = BibleStore.runDirFor(project.id || slugify(project.name || 'project'), task.id, runId);
  const { getPermissionLevel: liveLevelSource, steering, ...staticOptions } = options || {};
  steering?.attach(runId);
  const resolvedOptions: AgentPipelineOptions = { ...DEFAULT_AGENT_PIPELINE_OPTIONS, ...staticOptions };
  if (aiConfig.provider === 'ollama') {
    // Local Ollama running on local hardware must serialize worker agents to prevent VRAM thrashing and timeouts
    resolvedOptions.maxConcurrentAgents = 1;
  }
  let bible: BibleStore | null = null;
  const createdFiles = new Set<string>([
    ...(task.createdFiles || []),
    ...(brief?.createdFiles || [])
  ]);
  // Overview the Summary agent generated this run — kept even when the run is stopped or fails later.
  let summaryOverview: string | undefined;
  // The Summary step's overview document, and whether it reused the saved one (decided like runSummary does).
  let summaryDoc: OverviewDocument | undefined;
  const summaryReused = Boolean(brief && isOverviewReusable(brief, task));
  // Auto rated a saved overview that had no rating: the rating is saved with the brief this run returns.
  let ratedThisRun = false;
  /**
   * The returned brief carries this run's overview document: a fresh one stamped as generated (the logger rebuilds
   * the brief from the pre-run copy), or the saved one with the rating added this run. Keeps the task rating, so
   * reruns don't rate the task again.
   */
  const withOverviewDoc = (updated: AgentContextItem): AgentContextItem => {
    if (!summaryDoc) return updated;
    if (summaryReused) {
      if (!ratedThisRun || !summaryDoc.taskRating) return updated;
      const saved = updated.overviewDocument ?? brief?.overviewDocument ?? summaryDoc;
      return { ...updated, overviewDocument: { ...saved, taskRating: summaryDoc.taskRating } };
    }
    if (updated.overviewSource === 'user') return updated;
    return { ...updated, overviewSource: 'generated', overviewTaskHash: overviewTaskFingerprint(task), overviewDocument: summaryDoc };
  };

  // Escalation: a rerun after a failed run starts the manager and workers a rung up; each QA retry adds one more.
  const startEscalation = rerunEscalation(brief);
  let routingRating: TaskRating | undefined;
  let workRouting: RoutingResult | undefined;
  /** The routing the run's work started with (QA retries may step up from it). */
  let startRouting: RoutingResult | undefined;
  /** The returned brief also records how this run ended and which models did the work (see escalation.ts). */
  const withRunOutcome = (updated: AgentContextItem, outcome: RunOutcome, qaRetries = 0): AgentContextItem => ({
    ...updated,
    lastRunOutcome: buildRunOutcomeRecord({
      runId,
      outcome,
      escalation: startEscalation,
      qaRetries,
      rating: routingRating ?? summaryDoc?.taskRating,
      decisions: workRouting?.decisions,
      startDecisions: startRouting?.decisions,
      family: familyForTarget(resolveRoleTarget(ctx.aiConfig, 'manager')) ?? undefined,
    }),
  });

  // Live permission level: read from the caller on every tool call; a change is recorded as a step.
  let lastSeenLevel: PermissionLevel = resolvedOptions.permissionLevel;
  const getPermissionLevel = (): PermissionLevel => {
    let level = resolvedOptions.permissionLevel;
    if (liveLevelSource) {
      try {
        const live = liveLevelSource();
        if (live && PERMISSION_LEVEL_SET.has(live)) level = live;
      } catch {}
    }
    if (level !== lastSeenLevel) {
      const previous = lastSeenLevel;
      lastSeenLevel = level;
      resolvedOptions.permissionLevel = level;
      console.log(`[Ergo Agent Pipeline] Permission level changed mid-run: ${previous} → ${level}`);
      ctx.emit({
        id: `step-permission-change-${Date.now().toString(36)}`,
        stage: 'context',
        title: `Permissions changed to ${PERMISSION_LABELS[level]}`,
        detail: `Was ${PERMISSION_LABELS[previous]}. Applies right away to this run's next tool calls and agent rounds.`,
        status: 'success'
      });
    }
    return level;
  };

  const ctx: PipelineContext = {
    task,
    brief,
    project,
    aiConfig,
    connectedMcps,
    allowedRoots: [],
    options: resolvedOptions,
    getPermissionLevel,
    runId,
    runDir,
    signal,
    usage: emptyUsage(),
    ollamaFailureState: { count: 0 },
    sessionAllowedTools: new Set<string>(),
    onStepUpdate,
    onRequestPermission,
    onRequestHumanInput,
    onRequestOllamaFallback,
    steering,
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

    // Model routing: each stage's model + effort is picked once per run, before its agent runs (route at task
    // boundaries). Manual routes every stage up front. Auto routes the Summary stage first, then the rest once the
    // overview has rated the task; both update the same "Model routing" step.
    const mode = resolvedOptions.modelSelection === 'manual' ? 'manual' : 'auto';
    const routingTitle = `Models ${mode === 'auto' ? 'Auto' : 'Manual'} · Effort ${EFFORT_LABELS[resolvedOptions.effortLevel]} · Permissions ${PERMISSION_LABELS[ctx.getPermissionLevel()]}`;
    const emitRouting = (routing: RoutingResult, status: 'running' | 'success', extra = '') => {
      const detail = describeRouting(routing) + extra;
      console.log('[Ergo Agent Pipeline] Model routing:\n' + detail);
      ctx.emit({ id: 'step-model-routing', stage: 'context', title: routingTitle, detail, status });
    };
    const laterRoles: AgentRole[] = ['manager', 'worker', 'cleaner', 'hardener', 'logger'];
    const escalationNote = describeRerunEscalation(brief);
    const firstRouting = await routeModelsForRun({
      config: aiConfig,
      effort: resolvedOptions.effortLevel,
      mode,
      roles: mode === 'auto' ? ['summary'] : ['summary', ...laterRoles],
      escalation: workEscalation(startEscalation),
      signal
    });
    ctx.aiConfig = firstRouting.config;
    workRouting = firstRouting;
    startRouting = firstRouting;
    if (mode === 'auto') emitRouting(firstRouting, 'running', '\nThe other stages are picked once the overview rates the task.');
    else emitRouting(firstRouting, 'success', escalationNote ? `\n${escalationNote}` : '');

    // Step 1: Zero-token vector memory & guidelines context assembly
    const baseline = await assembleTaskContext(ctx);
    // Step 2: Summary AI
    const summary = await runSummary(ctx, baseline);
    summaryOverview = formatOverviewDocToMarkdown(summary.overviewDoc) || undefined;
    summaryDoc = summary.overviewDoc;

    if (mode === 'auto') {
      // The rating comes with the overview (fresh or saved); an overview without one is rated once and saved.
      let rating = summary.taskRating;
      if (!rating) {
        rating = await rateTask(task, aiConfig, { signal, overview: summaryOverview });
        summary.overviewDoc.taskRating = rating;
        ratedThisRun = true;
      }
      throwIfAborted(signal);
      routingRating = rating;
      const laterRouting = await routeModelsForRun({
        config: ctx.aiConfig,
        effort: resolvedOptions.effortLevel,
        mode,
        roles: laterRoles,
        rating,
        escalation: workEscalation(startEscalation),
        signal
      });
      ctx.aiConfig = laterRouting.config;
      workRouting = { ...laterRouting, decisions: [...firstRouting.decisions, ...laterRouting.decisions] };
      startRouting = workRouting;
      emitRouting(workRouting, 'success', escalationNote ? `\n${escalationNote}` : '');
    }

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
    // The filesystem harness is always available because deliverables land in files;
    // merge summary requirements with user-configured tools on the task or brief.
    const userSelectedTools = [
      ...(task.mcpRequired || []),
      ...(brief?.requiredMcps || []),
      ...(brief?.selectedMcpTools || [])
    ];
    const requiredSet = Array.from(new Set([...summary.requiredMcps, ...userSelectedTools, 'mcp-filesystem']));
    const taskAndOutputText = `${task.title} ${task.subtasks.map((s) => s.text).join(' ')} ${summary.overviewDoc.output_as} ${summary.overviewDoc.brief || ''}`.toLowerCase();
    if (requiresCliOrProcessTools(taskAndOutputText)) {
      for (const mcp of connectedMcps) {
        if (mcp.status === 'connected') {
          const idLower = mcp.id.toLowerCase();
          const nameLower = mcp.name.toLowerCase();
          const isGodotTask = taskAndOutputText.includes('godot');
          const isGodotServer = idLower.includes('godot') || nameLower.includes('godot');
          const isShellOrProcessServer =
            idLower.includes('shell') || idLower.includes('bash') || idLower.includes('terminal') || idLower.includes('command') ||
            mcp.tools.some((t) => ['run_command', 'bash', 'terminal', 'exec', 'run_project', 'launch_editor'].includes(t.name.toLowerCase()));

          if ((isGodotTask && isGodotServer) || isShellOrProcessServer) {
            if (!requiredSet.includes(mcp.id) && !requiredSet.includes(mcp.name)) {
              requiredSet.push(mcp.id);
            }
          }
        }
      }
    }
    const tools = buildToolDefinitions(connectedMcps, requiredSet);
    // A post-run follow-up continues this run with the same bible, tools and models (continuation.ts).
    rememberPipelineRun(pipelineRunKey(project, task.id), {
      runId,
      runDir,
      bible,
      stableSections: structuredClone(bible.sections),
      requiredMcps: requiredSet,
      taskKind: summary.taskKind,
      requiresHardener: summary.requiresHardener,
      hardenerReason: summary.hardenerReason,
      overviewDoc: summary.overviewDoc,
      getAiConfig: () => ctx.aiConfig,
      getRouting: () => workRouting
    });

    console.log('%c[Ergo Agent Pipeline] ── Step 3: TASK_CONTEXT.md bible ──', 'color: #10b981; font-weight: bold; font-size: 13px;');
    console.log(bible.renderStable());
    console.log('Tools (byte-stable for this run):', tools.map((t) => t.name).join(', '));

    /** Before retry `failedAttempt + 1`: the manager and workers climb one more rung (escalation.ts). */
    const stepUpForRetry = async (failedAttempt: number) => {
      const steps = startEscalation + failedAttempt;
      const stepped = await routeModelsForRun({
        config: ctx.aiConfig,
        effort: resolvedOptions.effortLevel,
        mode,
        roles: ['manager', 'worker'],
        rating: routingRating,
        escalation: workEscalation(steps),
        signal
      });
      ctx.aiConfig = stepped.config;
      const prev = workRouting?.decisions.filter((d) => d.role !== 'manager' && d.role !== 'worker') ?? [];
      workRouting = { ...stepped, decisions: [...prev, ...stepped.decisions] };
      ctx.emit({
        id: `step-model-stepup-${failedAttempt}`,
        stage: 'context',
        title: `Stepping up for attempt ${failedAttempt + 1}`,
        detail: describeRouting(stepped),
        status: 'success'
      });
    };

    // Step 3 → 4 → 5 with bounded QA retry loop
    let mgr: ManagerRunResult | null = null;
    let hardener: HardenerResult | undefined;
    let diagnostics: string | undefined;
    let attempt = 1;
    const maxAttempts = 1 + Math.max(0, resolvedOptions.maxQaRetries);
    for (; attempt <= maxAttempts; attempt++) {
      ctx.steering?.setManagerDone(false);
      mgr = await runManager(ctx, bible, tools, locks, attempt, diagnostics);
      // The user's messages for the manager now go to QA (or continue the run as a follow-up after it).
      ctx.steering?.setManagerDone(true);
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

      const hardenerEval = evaluateHardenerNecessity({ qaVerification: brief?.qaVerification === true, attempt });

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
        await stepUpForRetry(attempt);
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
      await stepUpForRetry(attempt);
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
    const outcome: RunOutcome = hardener
      ? hardener.verdict === 'pass' ? 'passed' : hardener.verdict === 'fail' ? 'qa_failed' : 'unverified'
      : mgr.allScenariosPass ? 'completed' : 'failed';
    return { ...result, updatedBrief: withRunOutcome(withOverviewDoc(result.updatedBrief), outcome, attempt - 1) };
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
        overview: summaryOverview || brief?.overview || brief?.brief || `Task (${task.title})`,
        buildAndVerification: brief?.buildAndVerification || brief?.built || '',
        completion: brief?.completion || brief?.validation || '',
        createdFiles: Array.from(createdFiles),
        totalUsage: { ...ctx.usage },
        brief: summaryOverview || brief?.overview || brief?.brief || `Task (${task.title})`,
        built: brief?.buildAndVerification || brief?.built || '',
        validation: brief?.validation || '',
        humanReview: '',
        followUps: ''
      };
      return { updatedBrief: withRunOutcome(withOverviewDoc(partialBrief), 'stopped'), updatedTask: { ...task, status: 'partly_done', isDone: false, createdFiles: Array.from(createdFiles), totalUsage: { ...ctx.usage } } };
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
      overview: summaryOverview || brief?.overview || brief?.brief || `Task #${task.id}: ${task.title}`,
      buildAndVerification: `${brief?.buildAndVerification || ''}${errorNote}`.trim(),
      completion: brief?.completion || '',
      createdFiles: brief?.createdFiles || [],
      totalUsage: { ...ctx.usage }
    };
    return { updatedBrief: withRunOutcome(withOverviewDoc(updatedBrief), 'failed'), updatedTask: { ...task, status: 'not_started', isDone: false, totalUsage: { ...ctx.usage } } };
  }
}
