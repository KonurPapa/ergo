/**
 * Post-run follow-up for the in-app pipeline: a message sent from the prompt box after a run finished continues that
 * run — it never starts the task over.
 *
 *   - No new overview, related-task search, task rating or model routing: the saved overview, the run's bible
 *     (same run dir, same stable sections → the cached prefix still matches) and the run's models are reused.
 *   - The manager gets the prior state (completion log + the bible's event log) and the user's message, then the
 *     usual Cleaner / Hardener QA / Logger steps run, and the new completion entry is APPENDED to the log.
 *
 * Within one app session the run comes from runRegistry (exact bible, tools and routed config). After a restart the
 * bible is rebuilt from the saved overview and the earlier event log is read back from the run's TASK_CONTEXT.md.
 */
import type {
  AIProviderConfig,
  AgentContextItem,
  AgentRole,
  BibleEvent,
  BibleEventKind,
  ExecutionStep,
  HumanInputPrompt,
  MCPServer,
  McpToolPermissionPrompt,
  OllamaFallbackChoice,
  OllamaFallbackPrompt,
  OverviewDocument,
  PermissionDecision,
  PermissionLevel,
  ProjectData,
  RunOutcome,
  TaskItem,
  TaskKind,
} from '../../types';
import { bridgeClient } from '../bridgeClient';
import { getAllowedRoots } from '../mcpClient';
import { overviewDocumentFor } from '../overviewUtils';
import { BibleStore, FileLockRegistry, buildBibleSections } from './bible';
import { runCleaner } from './cleaner';
import {
  DEFAULT_AGENT_PIPELINE_OPTIONS,
  type PipelineContext,
  emptyUsage,
  formatUsage,
  isAbortError,
  resolveRoleTarget,
  slugify,
} from './contracts';
import { buildRunOutcomeRecord } from './escalation';
import { familyForTarget } from '../modelCatalog/availability';
import { runHardener, type HardenerResult } from './hardener';
import { evaluateHardenerNecessity, type ExecuteTaskOptions } from './index';
import { runLogger } from './logger';
import { isStraightforwardTask, runManager, type ManagerRunResult } from './manager';
import { pipelineRunKey, recallPipelineRun, rememberPipelineRun } from './runRegistry';
import { inferTaskKind, isExplicitCodeTask, normalizeTaskKind } from './summary';
import { buildToolDefinitions } from './toolSchemas';

const BIBLE_EVENT_KINDS = new Set<BibleEventKind>([
  'info',
  'decompose',
  'piece_start',
  'piece_done',
  'piece_failed',
  'lock',
  'human',
  'verify',
  'cleaner',
  'qa_pass',
  'qa_fail',
  'retry',
  'error',
]);

function truncate(text: string, max: number): string {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Event-log lines of a persisted TASK_CONTEXT.md (`- [at] **actor** [piece] (kind): text`) back into events. */
export function parseBibleEventLog(markdown: string): BibleEvent[] {
  const start = markdown.indexOf('## Execution Event Log');
  if (start === -1) return [];
  const events: BibleEvent[] = [];
  for (const line of markdown.slice(start).split('\n').slice(1)) {
    const m = line.match(/^- \[([^\]]+)\] \*\*(.+?)\*\*(?: \[([^\]]+)\])? \(([a-z_]+)\): (.*)$/);
    if (!m) continue;
    const kind = (BIBLE_EVENT_KINDS.has(m[4] as BibleEventKind) ? m[4] : 'info') as BibleEventKind;
    events.push({ at: m[1], actor: m[2], kind, text: m[5].replace(/ ⏎ /g, '\n'), ...(m[3] ? { pieceId: m[3] } : {}) });
  }
  return events;
}

async function readStorageFile(filePath: string): Promise<string | null> {
  try {
    const res = await fetch(bridgeClient.getApiUrl('/api/files/read'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath] }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const content = json?.files?.[filePath];
    return typeof content === 'string' ? content : null;
  } catch {
    return null;
  }
}

/** The models the run's agents last used (its run record) on top of the profile — used when the run isn't in memory. */
function configWithRecordedModels(aiConfig: AIProviderConfig, brief: AgentContextItem | undefined, taskId: string | number): AIProviderConfig {
  const record = brief?.lastRunOutcome;
  // CLI runs (`${taskId}-…` ids) record models in their CLI's vocabulary: not usable for API calls.
  if (!record?.models || record.runId.startsWith(`${taskId}-`)) return aiConfig;
  const roleConfigs = { ...(aiConfig.roleConfigs || {}) };
  for (const role of ['manager', 'worker', 'hardener'] as const) {
    const m = record.models[role];
    if (!m?.model && !m?.effort) continue;
    roleConfigs[role] = { ...(roleConfigs[role] || {}), ...(m.model ? { model: m.model } : {}), ...(m.effort ? { effort: m.effort } : {}) };
  }
  return { ...aiConfig, roleConfigs, routedFrom: { roleConfigs: aiConfig.roleConfigs ?? {} } };
}

function describeReusedModels(config: AIProviderConfig): string {
  const roles: AgentRole[] = ['manager', 'worker', 'hardener', 'logger'];
  return roles
    .map((role) => {
      const t = resolveRoleTarget(config, role);
      return `- ${role === 'hardener' ? 'QA hardener' : role}: ${t.model || 'provider default'}${t.effort ? ` · ${t.effort}` : ''}`;
    })
    .join('\n');
}

/**
 * Continue the task's last in-app run with the user's follow-up. Same callbacks as executeTaskWithAi; returns the
 * updated brief (completion log appended) and task.
 */
export async function continueTaskWithAi(
  task: TaskItem,
  brief: AgentContextItem | undefined,
  project: ProjectData,
  aiConfig: AIProviderConfig,
  connectedMcps: MCPServer[],
  followUpMessage: string,
  onStepUpdate: (step: ExecutionStep) => void,
  onRequestPermission?: (prompt: McpToolPermissionPrompt) => Promise<PermissionDecision>,
  onRequestHumanInput?: (prompt: HumanInputPrompt) => Promise<string>,
  signal?: AbortSignal,
  options?: ExecuteTaskOptions,
  onRequestOllamaFallback?: (prompt: OllamaFallbackPrompt) => Promise<OllamaFallbackChoice>
): Promise<{ updatedBrief: AgentContextItem; updatedTask: TaskItem; runId: string }> {
  const message = String(followUpMessage || '').trim();
  const key = pipelineRunKey(project, task.id);
  const prior = recallPipelineRun(key);
  const runId =
    prior?.runId ||
    (brief?.lastRunOutcome?.runId && !brief.lastRunOutcome.runId.startsWith(`${task.id}-`) ? brief.lastRunOutcome.runId : '') ||
    `${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 5)}`;
  const runDir = prior?.runDir || BibleStore.runDirFor(project.id || slugify(project.name || 'project'), task.id, runId);
  // Step ids of this follow-up get their own suffix: the earlier run's steps (same ids) stay as they were.
  const suffix = `~fu${Date.now().toString(36).slice(-5)}`;

  const { getPermissionLevel: liveLevelSource, steering, ...staticOptions } = options || {};
  steering?.attach(runId);
  const resolvedOptions = { ...DEFAULT_AGENT_PIPELINE_OPTIONS, ...staticOptions };
  if (aiConfig.provider === 'ollama') resolvedOptions.maxConcurrentAgents = 1;
  const getPermissionLevel = (): PermissionLevel => {
    try {
      return liveLevelSource?.() || resolvedOptions.permissionLevel;
    } catch {
      return resolvedOptions.permissionLevel;
    }
  };

  const routedConfig = prior ? prior.getAiConfig() : configWithRecordedModels(aiConfig, brief, task.id);
  const createdFiles = new Set<string>([...(task.createdFiles || []), ...(brief?.createdFiles || [])]);

  const ctx: PipelineContext = {
    task,
    brief,
    project,
    aiConfig: routedConfig,
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
        ...step,
        id: `${step.id}${suffix}`,
      } as ExecutionStep),
  };

  const date = new Date().toISOString().split('T')[0];
  const previousCompletion = (brief?.completion || '').trim();
  const previousBuild = (brief?.buildAndVerification || brief?.built || '').trim();
  const appendTo = (previous: string, next: string) => (previous ? `${previous}\n\n---\n\n${next}` : next);
  const header = `**Follow-up (${date}):** _You: "${truncate(message, 240)}"_`;
  let bible: BibleStore | null = null;
  let workModels: AIProviderConfig = routedConfig;
  const withOutcome = (updated: AgentContextItem, outcome: RunOutcome, qaRetries = 0): AgentContextItem => ({
    ...updated,
    lastRunOutcome: buildRunOutcomeRecord({
      runId,
      outcome,
      escalation: brief?.lastRunOutcome?.escalation ?? 0,
      qaRetries,
      rating: brief?.overviewDocument?.taskRating ?? brief?.lastRunOutcome?.rating,
      family: familyForTarget(resolveRoleTarget(workModels, 'manager')) ?? brief?.lastRunOutcome?.family,
      models: {
        manager: { model: resolveRoleTarget(workModels, 'manager').model, effort: resolveRoleTarget(workModels, 'manager').effort },
        worker: { model: resolveRoleTarget(workModels, 'worker').model, effort: resolveRoleTarget(workModels, 'worker').effort },
        hardener: { model: resolveRoleTarget(workModels, 'hardener').model, effort: resolveRoleTarget(workModels, 'hardener').effort },
      },
    }),
  });

  try {
    ctx.allowedRoots = await getAllowedRoots();
    ctx.emit({
      id: 'step-model-routing',
      stage: 'context',
      title: `Follow-up · continuing run ${runId} · models reused`,
      detail: `No new overview, related-task search or model routing: the follow-up reuses the run's models.\n${describeReusedModels(routedConfig)}`,
      status: 'success',
    });

    // ── The run's bible: the same one (in memory), or rebuilt from the saved overview + its event log on disk ──
    let requiredSet: string[];
    let taskKind: TaskKind;
    let requiresHardener: boolean | undefined;
    let hardenerReason: string | undefined;
    let overviewDoc: OverviewDocument;
    if (prior) {
      // Same stable sections the run's agents saw (byte-identical cached prefix), plus its pieces and event log.
      bible = new BibleStore(structuredClone(prior.stableSections), runDir);
      bible.events.push(...prior.bible.events);
      bible.setPieces(prior.bible.pieces);
      requiredSet = prior.requiredMcps;
      taskKind = prior.taskKind;
      requiresHardener = prior.requiresHardener;
      hardenerReason = prior.hardenerReason;
      overviewDoc = prior.overviewDoc;
    } else {
      overviewDoc = brief ? overviewDocumentFor(brief) : { brief: '', goals: task.title, output_as: '', raw: task.title };
      const text = `${task.category || ''} ${task.title} ${task.subtasks.map((s) => s.text).join(' ')} ${overviewDoc.output_as || ''}`;
      taskKind = normalizeTaskKind(overviewDoc.taskKind) || (isExplicitCodeTask(text) ? 'coding' : inferTaskKind(text));
      requiresHardener = overviewDoc.requiresHardener;
      hardenerReason = overviewDoc.hardenerReason;
      requiredSet = Array.from(
        new Set([
          ...(overviewDoc.requiredMcps || []),
          ...(task.mcpRequired || []),
          ...(brief?.requiredMcps || []),
          ...(brief?.selectedMcpTools || []),
          'mcp-filesystem',
        ])
      );
      bible = new BibleStore(
        buildBibleSections({
          task,
          project,
          overviewDoc,
          requiredMcps: requiredSet,
          taskKind,
          requiresHardener,
          hardenerReason,
          allowedRoots: ctx.allowedRoots,
          runId,
        }),
        runDir
      );
      const saved = await readStorageFile(bible.filePath);
      if (saved) bible.events.push(...parseBibleEventLog(saved));
    }
    bible.appendEvent({ actor: 'user', kind: 'info', text: `Follow-up after the run finished: ${message}` });
    await bible.persist();
    const tools = buildToolDefinitions(connectedMcps, requiredSet);
    const runBible = bible;
    rememberPipelineRun(key, {
      runId,
      runDir,
      bible: runBible,
      stableSections: structuredClone(runBible.sections),
      requiredMcps: requiredSet,
      taskKind,
      requiresHardener,
      hardenerReason,
      overviewDoc,
      getAiConfig: () => ctx.aiConfig,
      getRouting: () => prior?.getRouting(),
    });
    const locks = new FileLockRegistry(runDir);

    const priorState =
      `${previousCompletion ? `Completion log so far:\n${previousCompletion.replace(/<!--[\s\S]*?-->/g, '').slice(-2500)}\n\n` : ''}` +
      runBible.renderEventLog({ last: 15 });

    // ── Manager → Cleaner → Hardener (bounded QA retries), as in a normal run ──
    let mgr: ManagerRunResult | null = null;
    let hardener: HardenerResult | undefined;
    let diagnostics: string | undefined;
    let attempt = 1;
    const maxAttempts = 1 + Math.max(0, resolvedOptions.maxQaRetries);
    for (; attempt <= maxAttempts; attempt++) {
      ctx.steering?.setManagerDone(false);
      mgr = await runManager(ctx, runBible, tools, locks, attempt, diagnostics, { message, priorState });
      ctx.steering?.setManagerDone(true);
      for (const f of mgr.createdFiles) createdFiles.add(f);
      const filesArray = Array.from(createdFiles);
      const isStraightforward = isStraightforwardTask(runBible);
      if (resolvedOptions.enableCleaner && taskKind === 'coding' && filesArray.length > 1 && !isStraightforward) {
        await runCleaner(ctx, runBible, tools, filesArray, attempt);
      }
      const hardenerEval = evaluateHardenerNecessity({ qaVerification: brief?.qaVerification === true, attempt });
      if (!hardenerEval.shouldRun) {
        runBible.appendEvent({ actor: 'pipeline', kind: 'info', text: `Hardener skipped for the follow-up: ${hardenerEval.reason}` });
        ctx.emit({
          id: `step-hardener-skipped-a${attempt}`,
          stage: 'hardener',
          agentRole: 'hardener',
          title: 'Hardener QA: Skipped (Token Efficiency)',
          detail: hardenerEval.reason,
          status: 'success',
        });
        if (mgr.allScenariosPass || attempt >= maxAttempts) break;
        diagnostics = mgr.verificationSummary;
        continue;
      }
      hardener = await runHardener(ctx, runBible, tools, taskKind, filesArray, attempt);
      if (hardener.verdict !== 'fail' || attempt >= maxAttempts) break;
      diagnostics =
        hardener.failures.map((f) => `- [${f.scenario}] ${f.diagnostics}`).join('\n') + (hardener.evidence ? `\n\nEvidence: ${hardener.evidence}` : '');
      runBible.appendEvent({ actor: 'pipeline', kind: 'retry', text: `QA failed on follow-up attempt ${attempt}; re-running the manager with the diagnostics.` });
      ctx.emit({
        id: `step-retry-${attempt}`,
        stage: 'retry',
        title: `QA Failed — Retrying Manager (attempt ${attempt + 1} of ${maxAttempts})`,
        detail: hardener.failures.map((f) => `✗ ${f.scenario}: ${f.diagnostics.slice(0, 200)}`).join('\n'),
        status: 'warning',
      });
    }
    if (attempt > maxAttempts) attempt = maxAttempts;
    if (!mgr) throw new Error('Manager did not run.');
    workModels = ctx.aiConfig;

    const result = await runLogger(ctx, runBible, {
      createdFiles: Array.from(createdFiles),
      usedToolCalling: mgr.usedToolCalling,
      hardener,
      qaAttempts: attempt,
      allScenariosPass: mgr.allScenariosPass,
      overviewDoc,
    });
    runBible.appendEvent({ actor: 'pipeline', kind: 'info', text: `Follow-up complete — status ${result.updatedTask.status}; usage ${formatUsage(ctx.usage)}.` });
    await runBible.persist();
    const outcome: RunOutcome = hardener
      ? hardener.verdict === 'pass' ? 'passed' : hardener.verdict === 'fail' ? 'qa_failed' : 'unverified'
      : mgr.allScenariosPass ? 'completed' : 'failed';
    const newCompletion = `${header}\n\n${result.updatedBrief.completion}`;
    const updatedBrief: AgentContextItem = {
      ...result.updatedBrief,
      // The earlier entries stay; the follow-up's entry is appended (the saved overview is untouched).
      overview: brief?.overview ?? result.updatedBrief.overview,
      brief: brief?.brief ?? result.updatedBrief.brief,
      completion: appendTo(previousCompletion, newCompletion),
      buildAndVerification: appendTo(previousBuild, `**Follow-up (${date}):**\n${result.updatedBrief.buildAndVerification}`),
      built: appendTo(previousBuild, `**Follow-up (${date}):**\n${result.updatedBrief.buildAndVerification}`),
      ...(brief?.overviewDocument ? { overviewDocument: brief.overviewDocument } : {}),
    };
    return { updatedBrief: withOutcome(updatedBrief, outcome, attempt - 1), updatedTask: result.updatedTask, runId };
  } catch (err: any) {
    const aborted = isAbortError(err);
    const errorText = aborted ? 'stopped by user' : `error: ${err?.message || String(err)}`;
    if (bible) {
      bible.appendEvent({ actor: 'pipeline', kind: aborted ? 'info' : 'error', text: `Follow-up ${errorText}.` });
      void bible.persist();
    }
    ctx.emit({
      id: aborted ? 'step-terminated' : 'step-pipeline-error',
      stage: aborted ? 'terminating' : 'execution',
      title: aborted ? 'Follow-up Stopped' : 'Follow-up Error',
      detail: aborted
        ? 'The follow-up was stopped by the user. The earlier completion log is unchanged.'
        : `${err?.message || String(err)}${bible ? ` — details preserved in ${bible.filePath}` : ''}`,
      status: aborted ? 'cancelled' : 'error',
    });
    const updatedBrief: AgentContextItem = {
      ...brief,
      id: brief?.id || `brief_${task.id}`,
      sourceTaskId: task.id,
      title: task.title,
      status: 'partly_done',
      overview: brief?.overview || '',
      buildAndVerification: brief?.buildAndVerification || '',
      completion: appendTo(previousCompletion, `${header}\n\nThe follow-up ended early (${errorText}).`),
      createdFiles: Array.from(createdFiles),
      totalUsage: { ...ctx.usage },
    };
    return {
      updatedBrief: withOutcome(updatedBrief, aborted ? 'stopped' : 'failed'),
      updatedTask: { ...task, status: 'partly_done', isDone: false, createdFiles: Array.from(createdFiles) },
      runId,
    };
  }
}
