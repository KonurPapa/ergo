/**
 * Orchestrates CLI agent task runs (manager → optional workers → optional verifier).
 *
 * App owns every agent PTY: this hook launches them over the bridge's REST API, listens to the bridge's
 * agent event stream (prompts, signal files, exits), drives the run protocol from those events and writes
 * the completion log when the run ends. Terminal views only attach to the sessions it creates.
 *
 * All asynchronous continuations read App state through refs (never render closures), so a long run can't
 * overwrite edits made while it was working.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type {
  AIProviderConfig,
  AgentContextItem,
  AgentPipelineOptions,
  AgentSessionRole,
  AgentSessionStatus,
  CliDetectedPrompt,
  ExecutionStep,
  HumanInputPrompt,
  PermissionLevel,
  RunOutcome,
  RunStageModel,
  RunningJobInfo,
  SpawnedSession,
  Subtask,
  TaskItem,
  TaskStatus,
  TokenUsage,
} from '../types';
import type { ToastMessage } from '../components/Toast';
import { bridgeClient } from '../lib/bridgeClient';
import {
  agentProjectKey,
  agentSessionId,
  applyPermissionPolicy,
  fetchAgentTranscript,
  fetchCliSessionId,
  killAgentSessions,
  parseAgentSessionId,
  runDirRel,
  sendAgentHandoff,
  sendAgentInput,
  spawnAgentSession,
  subscribeAgentEvents,
  claimWorkspaceCall,
  sendWorkspaceCallResult,
  type BridgeAgentSessionInfo,
  type CliAgentEvent,
  fromWireRole,
} from '../lib/cliRunClient';
import {
  buildCliArgsForTask,
  buildContinuationPrompt,
  buildFollowUpMessage,
  buildManagerCliPrompt,
  buildTaskContentText,
  buildVerifierCliPrompt,
  buildVerifierFailMessage,
  buildQuestionAnswerMessage,
  buildResumeMessage,
  buildResumedManagerPrompt,
  buildResumedWorkerNote,
  buildWorkerCliPrompt,
  buildWorkersDoneMessage,
  hasUserPermissionOverride,
  parseCliResumeId,
  parseDelegatePlan,
  parseQuestionFile,
  type CliRunPromptContext,
  type ResumeWaitingOn,
  type CliWorkerPiece,
} from '../lib/cliAgents';
import { cliBiblePath, writeCliBible } from '../lib/cliBible';
import { isBypassAcceptanceDialog, keystrokesForOption, pickApproveOption, promptSummary } from '../lib/cliPromptParser';
import { prefetchPromptMemory, taskMemoryQuery } from '../lib/memory/promptMemory';
import { getRunState, listRunStates, loadRunStates, pruneRunStates, putRunState, type StoredRunState } from '../lib/runStateStore';
import { refreshCodeIndex } from '../lib/mcpClient';
import { runFileScout } from '../lib/codeIndex/runFileScout';
import { buildRunOutcomeRecord } from '../lib/agentPipeline/escalation';
import { familyForTarget } from '../lib/modelCatalog/availability';
import { recordSteeringMessage } from '../lib/agentPipeline/steeringLog';
import type { TaskMessageOptions, TaskMessageResult } from '../lib/taskMessages';
import { QUESTION_SIGNAL_PROTOCOL } from '../lib/bridgeProtocol';
import { bridgeSupportsTaskReferences, type TaskReferenceContext } from '../lib/taskReferences';
import { executeWorkspaceToolAction } from '../lib/workspaceMcp';

// ─── Public types ─────────────────────────────────────────────────────────────────────

/** Everything needed to start one agent of a run (resolved once per run by App). */
export interface CliLaunchConfig {
  /** CLI executable, e.g. "claude". */
  cmd: string;
  /** Display name, e.g. "Claude Code". */
  cliName: string;
  /** User extra args (raw string, parsed by buildCliArgsForTask). */
  extraArgs: string;
  /** API keys forwarded to the process (never persisted or stored in session state). */
  env: Record<string, string>;
  hasApiKey: boolean;
  /** The profile's small model (smallModelCallConfig), for the file scout. Holds keys: never persisted. */
  smallModel?: AIProviderConfig | null;
  cwd: string;
  /** Model + effort per agent role, in the CLI's own vocabulary. */
  roles: Record<AgentSessionRole, RunStageModel>;
  /**
   * The manager and worker models for verifier retry n (index n − 1), each one rung above the last (escalation.ts).
   * Workers spawned after the retry use them; a Claude Code manager is switched with /model.
   */
  retryRoles?: Array<Partial<Record<AgentSessionRole, RunStageModel>>>;
  /** Rungs this run started above its plan (the task's last run failed or was stopped). */
  startEscalation?: number;
}

export interface LaunchCliRunParams {
  task: TaskItem;
  brief: AgentContextItem | undefined;
  launch: CliLaunchConfig;
  /** From makeCliRunId(); App creates it first so its overview step ids carry it. */
  runId: string;
  /** Steps that precede the manager (context, overview) — kept as given. */
  preSteps: ExecutionStep[];
  /**
   * The brief's status before App prepared this launch (its overview merge marks the brief in progress); null when
   * the task had no brief. Restored when the manager can't start. Omitted: inferred from the task's status.
   */
  priorBriefStatus?: AgentContextItem['status'] | null;
  /** Context block for the related tasks selected for this task; the manager and worker prompts show it. */
  relatedContext?: string;
  /** One-line index of those related tasks: shown instead of the block when the overview is a working brief. */
  relatedSources?: string;
  /** The project's learned rules for this task (formatProjectRules): every agent of the run gets them. */
  projectRules?: string;
  /** The task's `/skill` and `@file` commands, resolved by App (taskReferences.ts): the manager prompt shows them. */
  references?: TaskReferenceContext;
  /**
   * Per-run override of the verifier. Defaults to the task's "Verification" switch (brief.verification, on
   * by default unless false) and whether the AI determined verifier is needed. Persisted with the run.
   */
  verifierEnabled?: boolean;
  /** Whether the AI determined that independent verifier is necessary for this task. */
  needsVerifier?: boolean;
  /** Per-run cap on worker agents (1 = the manager does the work itself). Defaults to Settings' maxConcurrentAgents. */
  maxWorkers?: number;
  /** One line shown in the manager step explaining the run plan (e.g. "Run plan: single deliverable · …"). */
  runPlanNote?: string;
}

export interface CliAgentRunsDeps {
  tasksRef: MutableRefObject<TaskItem[]>;
  briefsRef: MutableRefObject<AgentContextItem[]>;
  taskExecutionStepsRef: MutableRefObject<Record<string | number, ExecutionStep[]>>;
  setTaskExecutionSteps: Dispatch<SetStateAction<Record<string | number, ExecutionStep[]>>>;
  runningJobsRef: MutableRefObject<RunningJobInfo[]>;
  setRunningJobs: Dispatch<SetStateAction<RunningJobInfo[]>>;
  setExecutingTaskId: Dispatch<SetStateAction<string | number | null>>;
  agentPipelineOptionsRef: MutableRefObject<AgentPipelineOptions>;
  /** App's syncAndSaveProject (latest render's version is used). */
  syncAndSaveProject: (tasks: TaskItem[], briefs: AgentContextItem[], immediateDiskSave?: boolean) => void;
  /** App's persistRunningJobsDoc with its ref defaults. */
  persistRunningJobsDoc: () => void;
  showToast: (toast: Omit<ToastMessage, 'id'> & { id?: string }) => void;
  dismissToast: (id: string) => void;
  /** Select a task and reveal its card. */
  openTask: (taskId: string | number) => void;
  /**
   * Show a manager's question as the task's question card (the in-app pipeline's ask_human card). Resolves with the
   * user's answer; '' when the card was dismissed without one (e.g. Stop).
   */
  requestHumanInput: (taskId: string | number, prompt: HumanInputPrompt) => Promise<string>;
  /** Remove the task's question card without an answer (the question was answered another way, or is moot). */
  cancelHumanInput: (taskId: string | number) => void;
  /**
   * Resolve the CLI launch config for a task (used when a restored run needs to start workers or verifier, or a follow-up
   * resumes its manager). `skipRouting`: don't pick models — the run reuses the ones it launched with.
   */
  prepareLaunch: (
    task: TaskItem,
    brief: AgentContextItem | undefined,
    opts?: { skipRouting?: boolean }
  ) => Promise<CliLaunchConfig | null>;
  projectId: string;
  /**
   * Project whose data tasksRef / briefsRef currently hold (null while a newly opened project is still loading).
   * `projectId` switches on render, before the load finishes; finalize must compare against this instead.
   */
  dataProjectIdRef?: { current: string | null };
}

export type StopCliRunResult = 'stopping' | 'finalized' | 'none';

export interface CliAgentRunsApi {
  launchCliRun: (params: LaunchCliRunParams) => Promise<boolean>;
  /** Resolves when the task's current CLI run has written its completion log or was stopped (immediately when none is running). */
  waitForCliRun: (taskId: string | number) => Promise<void>;
  /**
   * Kill every agent of the task. A run that hadn't finished is paused where it was — nothing is logged, and
   * resumeCliRun picks it up later.
   */
  stopCliRun: (taskId: string | number) => StopCliRunResult;
  /** The task's CLI run was stopped partway and can be resumed. */
  isCliRunPaused: (taskId: string | number) => boolean;
  /** Resume a stopped run from where it stopped (the manager's own conversation when the CLI can resume it). */
  resumeCliRun: (taskId: string | number, message?: string) => Promise<TaskMessageResult>;
  /** Stop one worker or verifier agent (the manager is stopped through stopCliRun). */
  killAgentSession: (ptySessionId: string) => void;
  /** Push a new permission level to every running agent. */
  applyPermissionLevel: (level: PermissionLevel) => Promise<void>;
  /** Re-attach to the bridge's live agent sessions for these tasks (project load / stream reconnect). */
  restoreAgentSessions: (taskIds: Iterable<string | number>) => Promise<void>;
  hasActiveCliRun: (taskId: string | number) => boolean;
  /** Kill the task's agents and drop its sessions and run without writing a completion log (task purged). */
  forgetTask: (taskId: string | number) => void;
  /**
   * A new launch of the task is being prepared: detach its previous run if that run has finished or is only
   * finalizing (e.g. a Stop still flushing), so that late finalize can't reset the new launch's state.
   */
  supersedeFinishedRun: (taskId: string | number) => void;
  /**
   * The task prompt box. While the run works the message goes to the agent the user is looking at (default: the
   * manager), never into an open approval prompt (held until it clears). After the run finished it continues the same
   * run: the live manager gets it, else its conversation is resumed (or a new manager continues from the log).
   * `{ ok: false, error: 'no-run' }` when the task has no CLI run to continue.
   */
  sendUserMessage: (taskId: string | number, text: string, opts?: TaskMessageOptions) => Promise<TaskMessageResult>;
  /** Dynamically enable or disable the planned verifier on an active run before it runs. */
  updateRunVerification: (taskId: string | number, enabled: boolean) => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────────────

const WORKING_STATUSES = new Set<AgentSessionStatus>(['starting', 'running', 'awaiting_approval', 'waiting']);
const TERMINAL_STATUSES = new Set<AgentSessionStatus>(['done', 'failed', 'cancelled']);

/** True while an agent session is doing (or waiting to do) work. */
export function isWorkingAgentSession(s: SpawnedSession): boolean {
  return WORKING_STATUSES.has(s.status);
}

export function makeCliRunId(taskId: string | number): string {
  return `${taskId}-${Date.now().toString(36)}`;
}

/** Key of a task's current run: task ids are only unique within a project. */
function runKeyOf(projectId: string, taskKey: string | number): string {
  return `${projectId}\u0000${String(taskKey)}`;
}

/**
 * Token usage of an embedded CLI agent session. The bridge reads the CLI's own session log (Claude Code,
 * Codex, Gemini CLI) and falls back to a transcript-length estimate (flagged `estimated`) for other CLIs.
 */
export async function fetchCliSessionUsage(sessionId: string): Promise<TokenUsage | null> {
  try {
    const res = await fetch(bridgeClient.getApiUrl(`/api/pty/usage?sessionId=${encodeURIComponent(sessionId)}`));
    if (!res.ok) return null;
    const u = (await res.json())?.usage;
    if (!u || typeof u.inputTokens !== 'number') return null;
    return {
      inputTokens: u.inputTokens || 0,
      outputTokens: u.outputTokens || 0,
      cachedInputTokens: u.cachedInputTokens || 0,
      cacheWriteTokens: u.cacheWriteTokens || 0,
      calls: u.calls || 0,
      ...(u.estimated ? { estimated: true } : {}),
      ...(typeof u.costUsd === 'number' ? { costUsd: u.costUsd } : {}),
      ...(u.costPartial ? { costPartial: true } : {}),
    };
  } catch {
    return null;
  }
}

/** Active bridge sessions, or null when the bridge couldn't be reached (so callers never mistake an outage for "no sessions"). */
async function fetchAgentSessionsStrict(): Promise<BridgeAgentSessionInfo[] | null> {
  try {
    const res = await bridgeClient.fetch('/api/pty/sessions');
    if (!res.ok) return null;
    const json = await res.json();
    return Array.isArray(json?.sessions) ? json.sessions.map(fromWireRole) : [];
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, calls: 0 };
}

function addUsageInto(target: TokenUsage, u: TokenUsage): void {
  target.inputTokens += u.inputTokens || 0;
  target.outputTokens += u.outputTokens || 0;
  target.cachedInputTokens += u.cachedInputTokens || 0;
  target.cacheWriteTokens += u.cacheWriteTokens || 0;
  target.calls += u.calls || 0;
  if (u.estimated) target.estimated = true;
  if (typeof u.costUsd === 'number') target.costUsd = (target.costUsd || 0) + u.costUsd;
  else if ((u.inputTokens || 0) + (u.outputTokens || 0) > 0) target.costPartial = true;
  if (u.costPartial) target.costPartial = true;
}

function hasUsage(u: TokenUsage | undefined | null): u is TokenUsage {
  return Boolean(u && (u.calls > 0 || u.inputTokens > 0 || u.outputTokens > 0));
}

function nowTime(): string {
  return new Date().toLocaleTimeString();
}

function baseCommandName(cmd: string): string {
  return cmd.trim().replace(/^.*[\\/]/, '').toLowerCase();
}

function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

type PromptMemoryHits = NonNullable<CliRunPromptContext['memoryHits']>;

function firstLines(text: string, n: number): string {
  const lines = text.replace(/\r/g, '').split('\n');
  const head = lines.slice(0, n).join('\n').trim();
  return lines.length > n ? `${head}\n…` : head;
}

/** Index of the brief that belongs to a task: exact source id first, then title, then item number. */
function findBriefIndex(briefs: AgentContextItem[], taskId: string | number, title: string): number {
  const key = String(taskId);
  let idx = briefs.findIndex((b) => b.sourceTaskId != null && String(b.sourceTaskId) === key);
  if (idx !== -1) return idx;
  idx = briefs.findIndex((b) => String(b.id) === `brief_${key}`);
  if (idx !== -1) return idx;
  const lower = title.trim().toLowerCase();
  idx = briefs.findIndex((b) => (b.title || '').trim().toLowerCase() === lower);
  if (idx !== -1) return idx;
  return briefs.findIndex((b) => b.sourceTaskId == null && String(b.itemNumber) === key);
}

/** Body of a `**Name:**` (or `## Name`) section of an agent-written markdown record. */
function extractSection(md: string, names: string[]): string {
  const lines = md.replace(/\r/g, '').split('\n');
  const isHeading = (l: string) => /^\s*(\*\*[^*]+:\*\*|#{1,6}\s+\S)/.test(l);
  const wanted = names.map((n) => n.toLowerCase());
  const matchName = (l: string) => {
    const m = l.match(/^\s*(?:\*\*([^*]+?):?\*\*:?|#{1,6}\s+(.+?):?\s*$)/);
    const name = (m?.[1] || m?.[2] || '').trim().toLowerCase();
    return Boolean(name) && wanted.some((w) => name === w || name.startsWith(w));
  };
  const start = lines.findIndex(matchName);
  if (start === -1) return '';
  // Content may follow the heading on the same line ("**Verification:** npm test passed").
  const sameLine = lines[start].replace(/^\s*(?:\*\*[^*]+\*\*:?|#{1,6}\s+[^:]+:?)/, '').trim();
  const body: string[] = sameLine ? [sameLine] : [];
  for (let i = start + 1; i < lines.length; i++) {
    if (isHeading(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join('\n').trim();
}

const NONE_RE = /^(none|n\/a|nothing|no(?:thing)?(?: human review)?(?: required| needed)?)\.?$/i;

/** Checklist items of the "Human Review Required" section ("None" → no items). */
function extractHumanReviewItems(md: string): string[] {
  const section = extractSection(md, ['needs your review', 'human review required', 'human review']);
  if (!section) return [];
  const items: string[] = [];
  for (const raw of section.split('\n')) {
    const line = raw
      .trim()
      .replace(/^(?:[-*•]\s+|\d+[.)]\s+)/, '')
      .replace(/^\[[ xX]\]\s*/, '')
      .replace(/^\*\*human review\*\*\s*[-–—:]?\s*/i, '')
      .trim();
    if (!line || NONE_RE.test(line) || /^_?none_?\.?$/i.test(line)) continue;
    items.push(truncate(line, 240));
  }
  return items;
}

/** File paths the agent listed under "Completed Work & Created Files" (markdown links and backticked paths). */
function extractCreatedFiles(md: string): string[] {
  const section = extractSection(md, ['changed', 'completed work & created files', 'completed work', 'created files']);
  if (!section) return [];
  const files = new Set<string>();
  for (const m of section.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const p = m[1].trim();
    if (p && !/^https?:/i.test(p) && !p.startsWith('#')) files.add(p.replace(/^\.\//, ''));
  }
  for (const m of section.matchAll(/`([^`\s]+\.[A-Za-z0-9]{1,8})`/g)) {
    files.add(m[1].replace(/^\.\//, ''));
  }
  return Array.from(files).filter((f) => !f.includes('.ergo/'));
}

function verifierVerdictFrom(content: string, explicit?: 'PASS' | 'FAIL'): 'PASS' | 'FAIL' {
  if (explicit) return explicit;
  const first = content.split('\n').map((l) => l.trim()).find(Boolean) || '';
  return /VERDICT:\s*PASS/i.test(first) ? 'PASS' : 'FAIL';
}

/** First `max` findings of a verifier report as single short lines ("None" → none). */
function topFindings(report: string, max: number): string[] {
  const section = extractSection(report, ['findings']) || report;
  const out: string[] = [];
  for (const raw of section.split('\n')) {
    const line = raw.trim().replace(/^(?:[-*•]\s+|\d+[.)]\s+)/, '').replace(/^\[[ xX]\]\s*/, '').trim();
    if (!line || NONE_RE.test(line) || /^\*\*/.test(line)) continue;
    out.push(truncate(line, 160));
    if (out.length >= max) break;
  }
  return out;
}

const RECORD_SECTION_CAP = 5;

/** Numbered items with 4-space sub-items (the human side's TODO.md layout); "- …and N more" closes a capped list. */
function numberedList(items: string[], max: number, more: (n: number) => string): string {
  const kept = items.slice(0, max).map((item, i) => `${i + 1}. ${item}`);
  if (items.length > max) kept.push(`    - ${more(items.length - max)}`);
  return kept.join('\n');
}

/** Review items as the human side writes them: numbered, `**human review**` first, at most 3. */
function reviewList(items: string[]): string {
  return numberedList(items.map((i) => `**human review** ${truncate(i, 180)}`), 3, (n) => `…and ${n} more (see the task's review items)`);
}

/** Items of a list section: top-level items, each with its indented sub-items kept under it. */
function listItems(text: string): string[] {
  const items: string[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    const sub = /^\s{2,}[-*•]\s+/.test(raw);
    const line = raw.trim().replace(/^(?:[-*•]\s+|\d+[.)]\s+)/, '').replace(/^\[[ xX]\]\s*/, '').trim();
    if (!line) continue;
    if (sub && items.length > 0) items[items.length - 1] += `\n    - ${truncate(line, 160)}`;
    else items.push(truncate(line, 180));
  }
  return items;
}

/**
 * The agent's completion record, cut down to the brief format (Done · Try it · Changed · Verified · Needs your
 * review) whatever it actually wrote: each section capped to a few short lines, under `###` headings (the run's
 * `##` heading sits above them).
 */
function compactCompletionRecord(md: string, reviewItems: string[]): string {
  // "Done" (older records: "Summary").
  const summary = extractSection(md, ['done', 'summary']);
  const tryIt = extractSection(md, ['try it']);
  const separately = extractSection(md, ['separately']);
  const changed = extractSection(md, ['changed', 'completed work & created files', 'completed work', 'created files']);
  const verified = extractSection(md, ['verified', 'verification']);
  if (!summary && !changed && !verified) {
    // Not in the expected shape: keep a short excerpt rather than the whole thing.
    return truncate(md.replace(/\n{3,}/g, '\n\n').trim(), 800);
  }
  const out: string[] = [];
  if (summary) out.push(`### Done\n${truncate(summary.replace(/\s*\n\s*/g, ' '), 400)}`);
  if (tryIt) out.push(`### Try it\n${truncate(tryIt.replace(/\s*\n\s*/g, ' '), 240)}`);
  if (changed) out.push(`### Changed\n${numberedList(listItems(changed), RECORD_SECTION_CAP, (n) => `…and ${n} more`)}`);
  if (verified) out.push(`### Verified\n${truncate(verified.replace(/^\s*(?:[-*•]|\d+[.)])\s*/gm, '').replace(/\s*\n\s*/g, '; '), 300)}`);
  out.push(`### Needs your review\n${reviewItems.length ? reviewList(reviewItems) : 'None'}`);
  if (separately && !NONE_RE.test(separately.trim())) out.push(`### Separately\n${truncate(separately.replace(/\s*\n\s*/g, ' '), 200)}`);
  return out.join('\n\n');
}

function stripVerdictLine(content: string): string {
  const lines = content.replace(/\r/g, '').split('\n');
  const idx = lines.findIndex((l) => l.trim());
  if (idx !== -1 && /^\s*VERDICT:/i.test(lines[idx])) lines.splice(idx, 1);
  return lines.join('\n').trim();
}


// ─── Run state ────────────────────────────────────────────────────────────────────────

type WorkerStatus = 'queued' | 'running' | 'done' | 'failed';

interface RunWorker {
  piece: CliWorkerPiece;
  round: number;
  status: WorkerStatus;
  stepId: string;
  ptySessionId: string;
  resultFile?: string;
  /** Was working when the run was stopped: restarted on resume, told to continue its piece. */
  resumed?: boolean;
}

interface PersistedRunState {
  runId: string;
  /** Project the run belongs to (task ids are only unique within a project). */
  projectId: string;
  taskKey: string;
  taskId: string | number;
  taskTitle: string;
  taskSnapshot: TaskItem;
  /** The task's brief at launch: prompts of a run whose project is not open use it instead of the open project's. */
  briefSnapshot?: AgentContextItem;
  /** Selected related tasks' context (from launch), for the manager and every worker the run starts later. */
  relatedContext?: string;
  /** Their one-line index (from launch), shown instead of the block when the overview is a working brief. */
  relatedSources?: string;
  /** The project's learned rules at launch: the run's later agents (workers, verifier, a resumed manager) get the same. */
  projectRules?: string;
  /** The run's TASK_CONTEXT.md under the storage root (cliBible.ts): the brief as handed over, the log, the prompt. */
  bibleFilePath?: string;
  /** The manager's launch prompt, exactly as sent (kept for the bible). */
  managerPrompt?: string;
  /** The run's folder has a ready code index (checked at launch): prompts tell agents to use code_search first. */
  codeSearch?: boolean;
  /** That folder (the agents' cwd at launch). */
  codeSearchPath?: string;
  /** Files the file scout found at launch (repository-relative), shown to the manager. */
  likelyFiles?: string[];
  /** The task's `/skill` and `@file` commands as resolved at launch (a resumed manager sees the same). */
  references?: TaskReferenceContext;
  /**
   * The manager's MCP server lists Ergo's workspace tools (this CLI can get them): an invoked skill uses them, or the
   * task has open checklist items for the manager to check off as it finishes them (workspace_update_subtask).
   */
  workspaceTools?: boolean;
  startedAt: string;
  cliName: string;
  managerSessionId: string;
  managerStepId: string;
  needsVerifier?: boolean;
  verifierEnabled: boolean;
  maxWorkers: number;
  maxVerifierRetries: number;
  workers: RunWorker[];
  delegateRounds: number;
  workersReported: boolean;
  verifierRuns: number;
  verifierRetriesUsed: number;
  verifierActive: boolean;
  /** Exit code of a manager that exited while workers / verifier were still running (the run finalizes when they finish). */
  managerExitCode?: number | null;
  lastCompletion?: string;
  lastVerifier?: { verdict: 'PASS' | 'FAIL'; content: string; attempt: number };
  verifierNote?: string;
  handledSignals: string[];
  finalized: boolean;
  /**
   * Set when the run ended while another project was open (finalized once its project is loaded again), and
   * while a finalize is writing the completion log (so a reload in that window finalizes the run again).
   */
  deferredFinalize?: FinalizeOptions;
  /** Follow-up cycles: each message sent after the run finished reopens it; its completion entry is appended. */
  followUps?: number;
  /** The user's message that started the current follow-up cycle (quoted in its completion entry). */
  followUpText?: string;
  /** verifierRuns when the current follow-up cycle started: a cycle's verifier attempts and retries count from here. */
  verifierBase?: number;
  /** Messages for a manager that was gone mid-run (workers / verifier still running): they continue the run when it ends. */
  pendingFollowUps?: string[];
  /** The manager CLI's own conversation id (Claude: --session-id; Codex / Antigravity: from its exit text), to resume it. */
  cliSessionId?: string;
  /** The manager's open question (its question.md), shown as the task's question card until answered. */
  question?: { key: string; prompt: HumanInputPrompt; stepId: string };
  /**
   * Stopped by the user partway: its agents were killed and nothing was logged (no completion log, no checklist or
   * task-done changes). Resume picks the run up from here. Not finalized: the run is still open.
   */
  paused?: {
    at: string;
    /** The manager was still working (not exited while workers / verifier ran): resume starts it again. */
    managerWasLive?: boolean;
    /** Verifier was verifying: resume runs that attempt again. */
    verifierInterrupted?: boolean;
  };
  /** Model + effort per role the run launched with: a restored run or a follow-up never routes models again. */
  roles?: CliLaunchConfig['roles'];
  retryRoles?: CliLaunchConfig['retryRoles'];
  startEscalation?: number;
  /** The models the run started on, saved before a verifier retry first steps them up (model calibration). */
  startRoles?: CliLaunchConfig['roles'];
  /**
   * The last usage reading of each of the run's agent processes (spawn id → its CLI's count), saved so the run's
   * token total survives a reload and a Stop (the in-memory readings are gone after a reload).
   */
  spawnUsage?: Record<string, TokenUsage>;
}

interface RunState extends PersistedRunState {
  launch?: CliLaunchConfig;
  done: Promise<void>;
  resolveDone: () => void;
  /**
   * In memory only: a finalize is writing the completion log. `finalized` is already true in memory (so nothing
   * else acts on the run), but it is persisted as false until the log is saved.
   */
  finalizePending?: boolean;
}

type FinalizeReason = 'complete' | 'verifier-pass' | 'verifier-fail' | 'verifier-error' | 'exit' | 'stopped';

interface FinalizeOptions {
  reason: FinalizeReason;
  completionMarkdown?: string;
  exitCode?: number | null;
}

/** Queued hand-off entry that only submits (its text was typed before a prompt opened). */
const SUBMIT_ONLY = '\u0000submit';

function withDonePromise(state: PersistedRunState): RunState {
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const run: RunState = { ...state, done, resolveDone };
  if (state.finalized || state.paused) resolveDone();
  return run;
}

/** The run's own model / effort per role over the launch defaults (a role it has no record of keeps the default). */
function mergeKnownRoles(defaults: CliLaunchConfig['roles'], known: CliLaunchConfig['roles']): CliLaunchConfig['roles'] {
  const pick = (role: AgentSessionRole) => {
    const k = known[role] || {};
    return {
      ...defaults[role],
      ...(k.model ? { model: k.model } : {}),
      ...(k.effort ? { effort: k.effort } : {}),
      ...(k.tier ? { tier: k.tier } : {}),
      ...(k.calibrated ? { calibrated: k.calibrated } : {}),
    };
  };
  return { manager: pick('manager'), worker: pick('worker'), verifier: pick('verifier') };
}

/** A reopened run (follow-up) needs a new completion promise: the previous one already resolved. */
function renewDonePromise(run: RunState): void {
  run.done = new Promise<void>((resolve) => {
    run.resolveDone = resolve;
  });
}

/** Key written to brief.completionRunId: the run id, plus `#n` for follow-up cycle n. */
function completionKeyOf(run: PersistedRunState): string {
  return run.followUps ? `${run.runId}#${run.followUps}` : run.runId;
}

/** Follow-up cycle of `runId` whose completion log the brief holds (0 = the run itself), or -1 when none. */
function loggedCycleOf(brief: AgentContextItem | undefined, runId: string): number {
  const key = brief?.completionRunId;
  if (!key) return -1;
  if (key === runId) return 0;
  if (!key.startsWith(`${runId}#`)) return -1;
  const n = Number(key.slice(runId.length + 1));
  return Number.isFinite(n) && n >= 0 ? n : -1;
}

/** The brief already holds this run's completion log for its current cycle (finalize must not write it again). */
function briefLoggedRun(brief: AgentContextItem | undefined, run: PersistedRunState): boolean {
  return loggedCycleOf(brief, run.runId) >= (run.followUps ?? 0);
}

/** How a CLI run ended, for the task's run record (escalation.ts). */
function runOutcomeFor(reason: FinalizeReason, verdict: string | undefined, failedRun: boolean): RunOutcome {
  if (reason === 'stopped') return 'stopped';
  if (reason === 'verifier-pass') return 'passed';
  if (reason === 'verifier-fail') return 'verifier_failed';
  if (reason === 'verifier-error') return 'unverified';
  if (failedRun) return 'failed';
  return verdict === 'PASS' ? 'passed' : 'completed';
}

/** The task has checklist items left for the agent (not done, not human review). */
function hasOpenChecklist(task: TaskItem): boolean {
  return (task.subtasks || []).some((st) => !st.isDone && !st.isHumanReview);
}

/**
 * Why a workspace call is refused for a run whose manager has the workspace tools only to check off its own
 * checklist, or null when it is that: workspace_update_subtask on this task, checking an item (isDone true).
 */
function checklistOnlyError(taskKey: string, tool: string, args: Record<string, unknown>): string | null {
  if (tool !== 'workspace_update_subtask') {
    return `In this run the Ergo workspace tools are only for checking off this task's checklist (workspace_update_subtask); ${tool} is not available.`;
  }
  if (String(args.taskId ?? '').replace(/^#/, '').trim() !== taskKey) return `Only this task's own checklist (taskId "${taskKey}") can be updated in this run.`;
  if (args.isDone !== true || args.text !== undefined) return 'Only checking an item off (isDone: true, no text change) is allowed in this run.';
  return null;
}

/** Saves the run's state on the user's machine (runStateStore.ts); the run keeps working if that fails. */
function saveRunState(run: RunState): void {
  const { launch: _launch, done: _done, resolveDone: _resolve, finalizePending, ...persisted } = run;
  // Keep the dedupe list bounded; old signal keys only matter for replays of the latest file versions.
  const trimmed: PersistedRunState = {
    ...persisted,
    finalized: persisted.finalized && !finalizePending,
    handledSignals: persisted.handledSignals.slice(-200),
  };
  putRunState(trimmed as unknown as StoredRunState);
}

function asRunState(state: StoredRunState | null, runId?: string): PersistedRunState | null {
  if (!state || (runId && state.runId !== runId) || !Array.isArray((state as any).workers)) return null;
  return state as unknown as PersistedRunState;
}

function loadRunState(runId: string): PersistedRunState | null {
  return asRunState(getRunState(runId), runId);
}

function listPersistedRuns(): PersistedRunState[] {
  return listRunStates().map((s) => asRunState(s)).filter((s): s is PersistedRunState => s !== null);
}

// ─── Hook ─────────────────────────────────────────────────────────────────────────────

export function useCliAgentRuns(deps: CliAgentRunsDeps): {
  terminalSessions: SpawnedSession[];
  terminalSessionsRef: MutableRefObject<SpawnedSession[]>;
  api: CliAgentRunsApi;
} {
  const depsRef = useRef(deps);
  depsRef.current = deps;

  // This hook is the only writer of terminalSessions, so the ref is always the latest value.
  const [terminalSessions, setTerminalSessions] = useState<SpawnedSession[]>([]);
  const sessionsRef = useRef<SpawnedSession[]>([]);

  const runsRef = useRef<Map<string, RunState>>(new Map());
  const taskQueuesRef = useRef<Map<string, Promise<void>>>(new Map());
  /** Status a session returns to when its pending prompt clears. */
  const baseStatusRef = useRef<Map<string, AgentSessionStatus>>(new Map());
  const usageBySpawnRef = useRef<Map<string, TokenUsage>>(new Map());
  const stepPersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bibleTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const warnedPermissionOverrideRef = useRef(false);
  const promptToastSigRef = useRef<Map<string, string>>(new Map());
  /** Hand-off messages held back while the agent shows a prompt (typing into a menu could answer it). */
  const deferredInputRef = useRef<Map<string, string[]>>(new Map());
  /** Sessions whose held-back hand-offs are being typed right now (new ones queue behind them). */
  const flushingInputRef = useRef<Set<string>>(new Set());
  /** Project each agent session belongs to (its pty key carries a hash of it; legacy keys don't). */
  const sessionProjectRef = useRef<Map<string, string>>(new Map());
  /** Prompt-box messages typed (or queued) into an agent: `delivered` fires once Ergo submits them, `dropped` if it ends first. */
  const userMessageWaitersRef = useRef<Map<string, Array<{ text: string; delivered: () => void; dropped: () => void }>>>(new Map());
  /** Text typed into an agent whose Enter is still held back by a prompt (the next SUBMIT_ONLY entry submits it). */
  const unsubmittedRef = useRef<Map<string, string>>(new Map());

  // ── Session state ──
  const commitSessions = useCallback((fn: (prev: SpawnedSession[]) => SpawnedSession[]) => {
    const next = fn(sessionsRef.current);
    if (next === sessionsRef.current) return;
    sessionsRef.current = next;
    setTerminalSessions(next);
  }, []);

  const patchSession = useCallback(
    (ptySessionId: string, fn: (s: SpawnedSession) => SpawnedSession) => {
      commitSessions((prev) => {
        let changed = false;
        const next = prev.map((s) => {
          if (s.ptySessionId !== ptySessionId) return s;
          const updated = fn(s);
          if (updated !== s) changed = true;
          return updated;
        });
        return changed ? next : prev;
      });
    },
    [commitSessions]
  );

  const findSession = (ptySessionId: string): SpawnedSession | undefined =>
    sessionsRef.current.find((s) => s.ptySessionId === ptySessionId);

  /** Project of an agent session; undefined when unknown (legacy key never seen at spawn/restore). */
  const sessionProjectOf = (ptySessionId: string): string | undefined => {
    const known = sessionProjectRef.current.get(ptySessionId);
    if (known !== undefined) return known;
    const { projectKey } = parseAgentSessionId(ptySessionId);
    const open = depsRef.current.projectId;
    return projectKey && projectKey === agentProjectKey(open) ? open : undefined;
  };

  /** True when the session is one of the given project's task agents (legacy sessions of unknown project count). */
  const sessionInProject = (s: SpawnedSession, projectId: string): boolean => {
    const owner = sessionProjectOf(s.ptySessionId);
    if (owner !== undefined) return owner === projectId;
    const { projectKey } = parseAgentSessionId(s.ptySessionId);
    return !projectKey || projectKey === agentProjectKey(projectId);
  };

  const sessionsOfTask = (projectId: string, taskKey: string): SpawnedSession[] =>
    sessionsRef.current.filter((s) => String(s.session.taskId) === taskKey && sessionInProject(s, projectId));

  /** Pty key for an agent of a run, in the same scheme as its manager (legacy runs keep unscoped keys). */
  const runSessionId = (run: PersistedRunState, role: AgentSessionRole, pieceId?: string): string => {
    const scoped = parseAgentSessionId(run.managerSessionId).projectKey !== null;
    return agentSessionId(scoped ? agentProjectKey(run.projectId) : null, run.taskId, role, pieceId);
  };

  const rk = (run: PersistedRunState) => runKeyOf(run.projectId, run.taskKey);

  /** Set a session's lifecycle status; a pending prompt keeps it shown as awaiting approval. */
  const setSessionStatus = (ptySessionId: string, status: AgentSessionStatus) => {
    baseStatusRef.current.set(ptySessionId, status);
    patchSession(ptySessionId, (s) => {
      if (status === 'cancelled' || status === 'failed' || !s.session.isActive) {
        return s.status === status && !s.pendingPrompt ? s : { ...s, status, pendingPrompt: null };
      }
      // A live agent (even a finished manager the user keeps steering) can still be blocked on a prompt.
      const shown: AgentSessionStatus = s.pendingPrompt ? 'awaiting_approval' : status;
      return s.status === shown ? s : { ...s, status: shown };
    });
  };

  // ── Steps / jobs ──
  const schedulePersist = () => {
    if (stepPersistTimerRef.current) clearTimeout(stepPersistTimerRef.current);
    stepPersistTimerRef.current = setTimeout(() => {
      stepPersistTimerRef.current = null;
      depsRef.current.persistRunningJobsDoc();
    }, 600);
  };

  const updateSteps = (run: RunState, fn: (steps: ExecutionStep[]) => ExecutionStep[], persist = true) => {
    const d = depsRef.current;
    const key = run.taskKey;
    // Steps state belongs to the open project; a run of another project must not write into it.
    if (run.projectId && run.projectId !== d.projectId) return;
    const apply = (rec: Record<string | number, ExecutionStep[]>) => ({ ...rec, [key]: fn(rec[key] || []) });
    d.taskExecutionStepsRef.current = apply(d.taskExecutionStepsRef.current);
    d.setTaskExecutionSteps((prev) => {
      const next = apply(prev);
      d.taskExecutionStepsRef.current = next;
      return next;
    });
    if (persist) schedulePersist();
    scheduleBibleWrite(run);
  };

  /** Re-renders the run's TASK_CONTEXT.md from its steps, at most once per second per run. */
  const scheduleBibleWrite = (run: RunState) => {
    if (!run.bibleFilePath) return;
    const key = runKeyOf(run.projectId, run.taskKey);
    if (bibleTimersRef.current.has(key)) return;
    bibleTimersRef.current.set(
      key,
      setTimeout(() => {
        bibleTimersRef.current.delete(key);
        const d = depsRef.current;
        if (!run.bibleFilePath || (run.projectId && run.projectId !== d.projectId)) return;
        void writeCliBible(run.bibleFilePath, {
          task: run.taskSnapshot,
          brief: run.briefSnapshot,
          runId: run.runId,
          cliName: run.cliName,
          relatedSources: run.relatedSources,
          projectRules: run.projectRules,
          managerPrompt: run.managerPrompt,
          steps: d.taskExecutionStepsRef.current[run.taskKey] || [],
        });
      }, 1000)
    );
  };

  const upsertStep = (run: RunState, step: ExecutionStep) => {
    updateSteps(run, (steps) => {
      const idx = steps.findIndex((s) => s.id === step.id);
      if (idx === -1) return [...steps, step];
      const next = [...steps];
      next[idx] = { ...steps[idx], ...step };
      return next;
    });
  };

  const patchStep = (run: RunState, stepId: string, patch: Partial<ExecutionStep> | ((s: ExecutionStep) => ExecutionStep)) => {
    updateSteps(run, (steps) =>
      steps.map((s) => (s.id === stepId ? (typeof patch === 'function' ? patch(s) : { ...s, ...patch }) : s))
    );
  };

  const updateJobs = (fn: (jobs: RunningJobInfo[]) => RunningJobInfo[]) => {
    const d = depsRef.current;
    d.runningJobsRef.current = fn(d.runningJobsRef.current);
    d.setRunningJobs((prev) => {
      const next = fn(prev);
      d.runningJobsRef.current = next;
      return next;
    });
  };

  const clearExecuting = (taskId: string | number) => {
    depsRef.current.setExecutingTaskId((cur) => (cur !== null && String(cur) === String(taskId) ? null : cur));
  };

  // ── Run helpers ──
  const runCtx = (run: RunState, memoryHits?: PromptMemoryHits): CliRunPromptContext => ({
    runId: run.runId,
    runDirRel: runDirRel(run.runId),
    maxWorkers: run.maxWorkers,
    verifierEnabled: run.verifierEnabled,
    // The bridge registers its ergo-memory MCP server for every CLI it can (claude, codex, gemini, agy); the
    // prompts keep a run-file fallback for the rest.
    memoryToolsAvailable: true,
    ...(memoryHits && memoryHits.length > 0 ? { memoryHits } : {}),
    ...(run.relatedContext ? { relatedContext: run.relatedContext } : {}),
    ...(run.relatedSources ? { relatedSources: run.relatedSources } : {}),
    ...(run.projectRules ? { projectRules: run.projectRules } : {}),
    ...(run.codeSearch ? { codeSearchAvailable: true, ...(run.codeSearchPath ? { codeSearchPath: run.codeSearchPath } : {}) } : {}),
    ...(run.likelyFiles?.length ? { likelyFiles: run.likelyFiles } : {}),
    ...(run.references ? { references: run.references } : {}),
    ...(run.workspaceTools ? { workspaceTools: true } : {}),
    // Managers ask through question.md only when the bridge reports it (protocol 3); else the old way.
    ...((bridgeClient.getStatus().bridgeInfo?.protocol ?? 0) >= QUESTION_SIGNAL_PROTOCOL ? { questionFile: true } : {}),
  });

  /** The run's project isn't open: App's tasks/briefs belong to another project (which may reuse this task id). */
  const dataProjectId = (): string | null =>
    depsRef.current.dataProjectIdRef ? depsRef.current.dataProjectIdRef.current : depsRef.current.projectId;
  const isForeignRun = (run: PersistedRunState) => Boolean(run.projectId) && run.projectId !== dataProjectId();

  const latestTask = (run: RunState): TaskItem =>
    isForeignRun(run)
      ? run.taskSnapshot
      : depsRef.current.tasksRef.current.find((t) => String(t.id) === run.taskKey) || run.taskSnapshot;

  const latestBrief = (run: RunState): AgentContextItem | undefined => {
    if (isForeignRun(run)) return run.briefSnapshot;
    const briefs = depsRef.current.briefsRef.current;
    const idx = findBriefIndex(briefs, run.taskId, latestTask(run).title);
    return idx === -1 ? undefined : briefs[idx];
  };

  /** Serialize event handling per task so signals of one run never interleave. */
  const enqueue = (taskKey: string, job: () => Promise<void> | void) => {
    const prev = taskQueuesRef.current.get(taskKey) || Promise.resolve();
    const next = prev
      .then(() => job())
      .catch((err) => console.warn('[Ergo CLI runs] event handler failed:', err));
    taskQueuesRef.current.set(taskKey, next);
    return next;
  };

  const ensureLaunch = async (run: RunState): Promise<CliLaunchConfig | null> => {
    if (run.launch) return run.launch;
    try {
      // A run that knows its models reuses them (no new routing for a restored run or a follow-up).
      const known = run.roles;
      const cfg = await depsRef.current.prepareLaunch(latestTask(run), latestBrief(run), { skipRouting: Boolean(known) });
      if (!cfg) return null;
      const managerCwd = findSession(run.managerSessionId)?.cwd;
      const withModels: CliLaunchConfig = known
        ? {
            ...cfg,
            roles: mergeKnownRoles(cfg.roles, known),
            ...(run.retryRoles ? { retryRoles: run.retryRoles } : {}),
            ...(run.startEscalation !== undefined ? { startEscalation: run.startEscalation } : {}),
          }
        : cfg;
      run.launch = managerCwd ? { ...withModels, cwd: managerCwd } : withModels;
      run.roles = run.launch.roles;
      run.retryRoles = run.launch.retryRoles;
      run.startEscalation = run.launch.startEscalation;
      return run.launch;
    } catch (err) {
      console.warn('[Ergo CLI runs] could not resolve CLI launch config:', err);
      return null;
    }
  };

  /**
   * Verifier retry n: the workers climb one rung (launch.retryRoles); workers spawned from now on use the new model. The
   * running manager keeps its model: Claude Code's /model would also save the model as the user's default for every
   * new Claude Code session, and other CLIs can't switch mid-session. A rerun after the failure starts the manager a
   * rung up instead. Returns a note for the manager step, or ''.
   */
  const stepUpForRetry = async (run: RunState, retry: number): Promise<string> => {
    const launch = await ensureLaunch(run);
    const next = launch?.retryRoles?.[retry - 1];
    if (!launch || !next) return '';
    if (!run.startRoles) run.startRoles = JSON.parse(JSON.stringify(launch.roles));
    let note = '';
    if (next.worker && (next.worker.model !== launch.roles.worker.model || next.worker.effort !== launch.roles.worker.effort)) {
      launch.roles.worker = { ...launch.roles.worker, ...next.worker };
      note = `Stepped up: workers → ${next.worker.model || 'default model'}${next.worker.effort ? ` (${next.worker.effort})` : ''}.`;
    }
    saveRunState(run); // launch.roles is run.roles: the stepped-up models are reused by a follow-up
    return note;
  };

  /** Spawn one agent PTY for a run. Returns the session on success, or an error message. */
  const spawnAgent = async (
    run: RunState,
    role: AgentSessionRole,
    opts: { pieceId?: string; label: string; prompt: string; resumeSessionId?: string }
  ): Promise<{ ok: true; session: SpawnedSession } | { ok: false; error: string; cancelled?: boolean }> => {
    const launch = await ensureLaunch(run);
    if (!launch) return { ok: false, error: 'No CLI agent is configured for the active AI profile.' };

    const ptySessionId = runSessionId(run, role, opts.pieceId);
    const level = depsRef.current.agentPipelineOptionsRef.current.permissionLevel;
    const roleCfg = launch.roles[role] || {};
    const isClaude = baseCommandName(launch.cmd) === 'claude';
    const claudeSessionId = isClaude ? opts.resumeSessionId || crypto.randomUUID() : undefined;
    const args = buildCliArgsForTask(launch.cmd, launch.extraArgs, opts.prompt, launch.hasApiKey, {
      permissionLevel: level,
      effort: roleCfg.effort,
      model: roleCfg.model,
      sessionId: claudeSessionId,
      ...(opts.resumeSessionId ? { resumeSessionId: opts.resumeSessionId } : {}),
    });
    if (role === 'manager') {
      // The manager's own conversation id: a follow-up after it exits resumes it (Codex / Antigravity print theirs on exit).
      run.cliSessionId = claudeSessionId ?? opts.resumeSessionId;
      saveRunState(run);
    }
    const spawnId = `${run.runId}-${role}${opts.pieceId ? `-${opts.pieceId}` : ''}-${Date.now().toString(36)}`;
    const session: SpawnedSession = {
      session: {
        taskId: run.taskId,
        taskTitle: run.taskTitle,
        isActive: true,
        spawnedAt: new Date().toISOString(),
      },
      role,
      label: opts.label,
      ...(opts.pieceId ? { pieceId: opts.pieceId } : {}),
      ptySessionId,
      runId: run.runId,
      status: 'starting',
      permissionLevel: level,
      pendingPrompt: null,
      cwd: launch.cwd,
      cmd: launch.cmd,
      args,
      spawnId,
    };
    baseStatusRef.current.set(ptySessionId, 'starting');
    sessionProjectRef.current.set(ptySessionId, run.projectId);
    clearDeferredInput(ptySessionId);
    commitSessions((prev) => [...prev.filter((s) => s.ptySessionId !== ptySessionId), session]);

    const res = await spawnAgentSession({
      sessionId: ptySessionId,
      taskId: run.taskId,
      ...(run.projectId ? { projectId: run.projectId } : {}),
      runId: run.runId,
      role,
      label: opts.label,
      ...(opts.pieceId ? { pieceId: opts.pieceId } : {}),
      cmd: launch.cmd,
      args,
      cwd: launch.cwd,
      env: launch.env,
      permissionLevel: level,
      spawnId,
      cols: 120,
      rows: 40,
      // The manager applies the invoked skills; only it gets the workspace tools.
      ...(role === 'manager' && run.workspaceTools ? { workspaceTools: true } : {}),
    });

    if (!res.success) {
      const error = res.error || 'The bridge could not start the agent.';
      baseStatusRef.current.set(ptySessionId, 'failed');
      patchSession(ptySessionId, (s) =>
        s.spawnId === spawnId
          ? { ...s, status: 'failed', session: { ...s.session, isActive: false, exitCode: -1 }, endedAt: new Date().toISOString() }
          : s
      );
      return { ok: false, error };
    }

    // Stopped (or the run ended / was replaced) while the spawn request was in flight: the kill sent then found
    // no process, so kill the one that just started — unless a newer launch already took over this pty key.
    const current = findSession(ptySessionId);
    const superseded = Boolean(current && current.spawnId !== spawnId);
    const stale = !current || current.status === 'cancelled' || run.finalized || Boolean(run.paused) || runsRef.current.get(rk(run)) !== run;
    if (!superseded && stale) {
      void killAgentSessions({ sessionId: ptySessionId });
      if (current) {
        baseStatusRef.current.set(ptySessionId, 'cancelled');
        patchSession(ptySessionId, (s) =>
          s.spawnId === spawnId
            ? { ...s, status: 'cancelled', pendingPrompt: null, session: { ...s.session, isActive: false }, endedAt: new Date().toISOString() }
            : s
        );
      }
      // Whoever stopped it (Stop, the run's finalize, a relaunch) handles the run; callers just bail out.
      return { ok: false, error: 'The agent was stopped while it was starting.', cancelled: true };
    }

    patchSession(ptySessionId, (s) =>
      s.spawnId === spawnId
        ? { ...s, cwd: res.cwd || s.cwd, status: s.status === 'starting' ? 'running' : s.status }
        : s
    );
    if (baseStatusRef.current.get(ptySessionId) === 'starting') baseStatusRef.current.set(ptySessionId, 'running');
    if (role === 'manager' && res.cwd && run.launch) run.launch = { ...run.launch, cwd: res.cwd };
    return { ok: true, session: findSession(ptySessionId) || session };
  };

  /** A message Ergo typed into the agent was submitted: settle the prompt-box message it was, if any. */
  const notifySubmitted = (ptySessionId: string, text: string | undefined) => {
    if (!text) return;
    const list = userMessageWaitersRef.current.get(ptySessionId);
    const idx = list ? list.findIndex((w) => w.text === text) : -1;
    if (!list || idx === -1) return;
    const [waiter] = list.splice(idx, 1);
    if (list.length === 0) userMessageWaitersRef.current.delete(ptySessionId);
    try {
      waiter.delivered();
    } catch (err) {
      console.warn('[Ergo CLI runs] message delivery callback failed:', err);
    }
  };

  /** The agent ended (or was replaced): queued input is moot, and its prompt-box messages were not delivered. */
  const clearDeferredInput = (ptySessionId: string) => {
    deferredInputRef.current.delete(ptySessionId);
    unsubmittedRef.current.delete(ptySessionId);
    const waiters = userMessageWaitersRef.current.get(ptySessionId);
    userMessageWaitersRef.current.delete(ptySessionId);
    for (const w of waiters || []) {
      try {
        w.dropped();
      } catch {}
    }
  };

  const deferInput = (ptySessionId: string, messages: string[]) => {
    deferredInputRef.current.set(ptySessionId, [...(deferredInputRef.current.get(ptySessionId) || []), ...messages]);
  };

  type TypeLineResult = { status: 'sent' | 'failed' } | { status: 'held'; rest: string; hiddenPrompt: boolean };

  /**
   * Types one line and submits it. Stops at the part that can't go in because a prompt is open (the bridge
   * refused the text, or a prompt opened before the Enter) and returns it as `rest` for the caller to queue.
   */
  const typeLine = async (ptySessionId: string, message: string): Promise<TypeLineResult> => {
    if (message !== SUBMIT_ONLY) {
      const typed = await sendAgentHandoff(ptySessionId, message.replace(/[\r\n]+/g, ' '));
      if (typed === 'prompt-open') return { status: 'held', rest: message, hiddenPrompt: !findSession(ptySessionId)?.pendingPrompt };
      if (typed === 'failed') return { status: 'failed' };
      // Typed but not yet submitted: a held SUBMIT_ONLY later submits this text.
      unsubmittedRef.current.set(ptySessionId, message);
      await sleep(150);
    }
    // Enter on an open approval menu would pick its highlighted option ("Yes"): submit once it has cleared.
    if (findSession(ptySessionId)?.pendingPrompt) return { status: 'held', rest: SUBMIT_ONLY, hiddenPrompt: false };
    const submitted = await sendAgentHandoff(ptySessionId, '\r');
    if (submitted === 'prompt-open') return { status: 'held', rest: SUBMIT_ONLY, hiddenPrompt: !findSession(ptySessionId)?.pendingPrompt };
    if (submitted === 'sent') {
      const text = unsubmittedRef.current.get(ptySessionId);
      unsubmittedRef.current.delete(ptySessionId);
      notifySubmitted(ptySessionId, text);
    }
    return { status: submitted };
  };

  /** Queue held-back hand-offs ahead of any queued later; a prompt the client wasn't shown gets a timed retry. */
  const holdInput = (ptySessionId: string, entries: string[], hiddenPrompt: boolean) => {
    deferredInputRef.current.set(ptySessionId, [...entries, ...(deferredInputRef.current.get(ptySessionId) || [])]);
    // A prompt the bridge auto-answers is never shown here, so no "prompt cleared" event will flush the queue.
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    if (hiddenPrompt) setTimeout(() => flushDeferredInput(ptySessionId), 1500);
  };

  /**
   * Type a one-line message into an agent's terminal and submit it — never into an open approval / question
   * menu (its digits, letters or the final Enter could answer it). While a prompt is open the message is queued
   * and delivered once the prompt clears (see handlePrompt).
   */
  const typeIntoAgent = async (ptySessionId: string, message: string): Promise<boolean> => {
    const s = findSession(ptySessionId);
    if (
      s?.pendingPrompt ||
      s?.status === 'awaiting_approval' ||
      deferredInputRef.current.get(ptySessionId)?.length ||
      flushingInputRef.current.has(ptySessionId)
    ) {
      deferInput(ptySessionId, [message]);
      return true;
    }
    const res = await typeLine(ptySessionId, message);
    if (res.status === 'held') holdInput(ptySessionId, [res.rest], res.hiddenPrompt);
    return res.status !== 'failed';
  };

  /** Deliver hand-offs held back by an open prompt, once it has cleared (re-queued if another prompt opens). */
  const flushDeferredInput = (ptySessionId: string) => {
    const queued = deferredInputRef.current.get(ptySessionId);
    if (!queued?.length || flushingInputRef.current.has(ptySessionId)) return;
    deferredInputRef.current.delete(ptySessionId);
    flushingInputRef.current.add(ptySessionId);
    void (async () => {
      try {
        // Let the CLI finish repainting after the answer before typing.
        await sleep(400);
        for (let i = 0; i < queued.length; i++) {
          const s = findSession(ptySessionId);
          const base = baseStatusRef.current.get(ptySessionId);
          // Agent gone, or its run already finished: the hand-off is moot.
          if (!s || !s.session.isActive || base === 'cancelled' || base === 'failed' || base === 'done') {
            clearDeferredInput(ptySessionId);
            return;
          }
          if (s.pendingPrompt) {
            holdInput(ptySessionId, queued.slice(i), false);
            return;
          }
          const res = await typeLine(ptySessionId, queued[i]);
          if (res.status === 'held') {
            holdInput(ptySessionId, [res.rest, ...queued.slice(i + 1)], res.hiddenPrompt);
            return;
          }
        }
      } finally {
        flushingInputRef.current.delete(ptySessionId);
      }
      // Hand-offs queued (by typeIntoAgent) while this flush was typing.
      if (!findSession(ptySessionId)?.pendingPrompt) flushDeferredInput(ptySessionId);
    })();
  };

  // ── Usage ──
  /**
   * Sum over every agent process of the run (spawn ids are `${runId}-…`, so earlier verifier attempts still count):
   * the live readings, plus the saved ones of processes this page hasn't read since a reload.
   */
  const runUsageTotal = (run: RunState): TokenUsage => {
    const total = emptyUsage();
    const counted = new Set<string>();
    for (const [spawnId, u] of usageBySpawnRef.current) {
      if (!spawnId.startsWith(`${run.runId}-`)) continue;
      addUsageInto(total, u);
      counted.add(spawnId);
    }
    for (const [spawnId, u] of Object.entries(run.spawnUsage || {})) {
      if (!counted.has(spawnId)) addUsageInto(total, u);
    }
    return total;
  };

  /**
   * A reading of one agent process's usage. A session's usage only grows, so a smaller reading (its log no longer
   * found after the process was killed, a transcript estimate) never replaces a larger one.
   */
  const noteSpawnUsage = (spawnId: string, u: TokenUsage, run?: RunState | null) => {
    const prev = usageBySpawnRef.current.get(spawnId) ?? run?.spawnUsage?.[spawnId];
    if (prev && u.inputTokens + u.outputTokens < prev.inputTokens + prev.outputTokens) {
      if (!usageBySpawnRef.current.has(spawnId)) usageBySpawnRef.current.set(spawnId, prev);
      return;
    }
    usageBySpawnRef.current.set(spawnId, u);
  };

  /** A resumed Claude session's log holds the earlier turns too: the previous process's reading is dropped. */
  const forgetSpawnUsage = (run: RunState, spawnId: string) => {
    usageBySpawnRef.current.delete(spawnId);
    if (run.spawnUsage && spawnId in run.spawnUsage) {
      const { [spawnId]: _dropped, ...rest } = run.spawnUsage;
      run.spawnUsage = rest;
      saveRunState(run);
    }
  };

  /** Copies the run's live readings into its saved state; true when any changed. */
  const syncSpawnUsage = (run: RunState): boolean => {
    let changed = false;
    const saved = { ...(run.spawnUsage || {}) };
    for (const [spawnId, u] of usageBySpawnRef.current) {
      if (!spawnId.startsWith(`${run.runId}-`)) continue;
      const prev = saved[spawnId];
      if (prev && prev.calls === u.calls && prev.inputTokens === u.inputTokens && prev.outputTokens === u.outputTokens) continue;
      saved[spawnId] = { ...u };
      changed = true;
    }
    if (changed) run.spawnUsage = saved;
    return changed;
  };

  /**
   * Puts the run's token total on its steps (the token card). When it grew it is saved too — with the run's state
   * and in RUNNING_JOBS.json — so the running figure survives a Stop and a reload; `persist` saves the steps anyway.
   */
  const applyRunUsage = (run: RunState, persist = false) => {
    const grew = syncSpawnUsage(run);
    if (grew) saveRunState(run);
    const total = runUsageTotal(run);
    const bySession = new Map<string, TokenUsage>();
    for (const s of sessionsRef.current) {
      if (s.runId !== run.runId || !s.spawnId) continue;
      const u = usageBySpawnRef.current.get(s.spawnId);
      if (u) bySession.set(s.ptySessionId, u);
    }
    if (bySession.size === 0 && !hasUsage(total)) return;
    const prefix = `-${run.runId}`;
    updateSteps(run, (steps) => {
      // Latest step per pty session gets that agent's live usage.
      const latestIdx = new Map<string, number>();
      steps.forEach((st, i) => {
        if (st.ptySessionId && st.id.includes(prefix)) latestIdx.set(st.ptySessionId, i);
      });
      let changed = false;
      const next = steps.map((st, i) => {
        if (!st.id.includes(prefix) || !st.ptySessionId) return st;
        const own = latestIdx.get(st.ptySessionId) === i ? bySession.get(st.ptySessionId) : undefined;
        if (!own && !hasUsage(total)) return st;
        changed = true;
        return { ...st, ...(own ? { usage: own } : {}), totalUsage: total };
      });
      return changed ? next : steps;
    }, persist || grew); // live usage ticks every 5 s: the steps file is only rewritten when the total grew
  };

  /** The run's token total so far onto its task and brief (saved with the project), e.g. once it is stopped. */
  const saveRunUsage = (run: RunState) => {
    if (isForeignRun(run)) return;
    const total = runUsageTotal(run);
    if (!hasUsage(total)) return;
    const d = depsRef.current;
    const tasks = d.tasksRef.current;
    const nextTasks = tasks.map((t) => (String(t.id) === run.taskKey ? { ...t, totalUsage: total } : t));
    const briefs = d.briefsRef.current;
    const briefIdx = findBriefIndex(briefs, run.taskId, latestTask(run).title);
    const nextBriefs = briefIdx === -1 ? briefs : briefs.map((b, i) => (i === briefIdx ? { ...b, totalUsage: total } : b));
    d.syncAndSaveProject(nextTasks, nextBriefs, true);
  };

  // ── Workers ──
  const currentRoundWorkers = (run: RunState) => run.workers.filter((w) => w.round === run.delegateRounds);

  const reportWorkersToManager = async (run: RunState) => {
    const round = currentRoundWorkers(run);
    if (run.finalized || run.deferredFinalize || run.paused || run.workersReported || round.length === 0) return;
    if (round.some((w) => w.status === 'queued' || w.status === 'running')) return;
    run.workersReported = true;
    saveRunState(run);
    if (!findSession(run.managerSessionId)?.session.isActive) {
      // The manager exited while its workers ran: nobody to hand the results to — close the run out now
      // (queued, since this can run outside the task's event queue; finalize is idempotent).
      void enqueue(rk(run), () =>
        // eslint-disable-next-line @typescript-eslint/no-use-before-define
        finalizeRun(run, { reason: 'exit', exitCode: run.managerExitCode ?? null, completionMarkdown: run.lastCompletion })
      );
      return;
    }
    const ctx = runCtx(run);
    const message = buildWorkersDoneMessage(
      round.map((w) => ({
        pieceId: w.piece.id,
        title: w.piece.title,
        fileRel: `${ctx.runDirRel}/worker-${w.piece.id}.md`,
        ok: w.status === 'done',
      })),
      ctx
    );
    const okCount = round.filter((w) => w.status === 'done').length;
    const sent = await typeIntoAgent(run.managerSessionId, message);
    setSessionStatus(run.managerSessionId, 'running');
    patchStep(run, run.managerStepId, (s) => ({
      ...s,
      status: 'running',
      detail: `${s.detail}\n\n${sent ? '↳' : '⚠'} ${okCount}/${round.length} worker(s) finished${
        sent ? '; results handed back to the manager.' : ', but Ergo could not type the hand-off into the manager terminal — tell it to read the worker result files.'
      }`,
    }));
  };

  const finishWorker = (run: RunState, w: RunWorker, ok: boolean, detail: string) => {
    if (w.status === 'done' || w.status === 'failed') return;
    w.status = ok ? 'done' : 'failed';
    saveRunState(run);
    patchStep(run, w.stepId, (s) => ({ ...s, status: ok ? 'success' : 'error', detail }));
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    launchQueuedWorkers(run);
    void reportWorkersToManager(run);
  };

  const startWorker = async (run: RunState, w: RunWorker) => {
    const task = latestTask(run);
    const label = `Worker ${w.piece.id} · ${truncate(w.piece.title, 40)}`;
    upsertStep(run, {
      id: w.stepId,
      taskId: run.taskId,
      time: nowTime(),
      stage: 'subagent',
      agentRole: 'worker',
      pieceId: w.piece.id,
      ptySessionId: w.ptySessionId,
      title: `Worker ${w.piece.id}: ${w.piece.title}`,
      detail: `${w.piece.instructions.trim()}${w.piece.files.length ? `\n\nFiles: ${w.piece.files.map((f) => `\`${f}\``).join(', ')}` : ''}`,
      status: 'running',
    });
    const memoryHits = await prefetchPromptMemory(run.projectId, `${w.piece.title}\n${w.piece.instructions}`);
    if (run.paused) return; // stopped while the memory search ran: the worker is queued again for resume
    if (run.finalized || w.status !== 'running') {
      // Stopped while the memory search ran (finishWorker is a no-op for a worker already settled).
      finishWorker(run, w, false, 'Stopped before it started.');
      return;
    }
    const piecePrompt = buildWorkerCliPrompt(task, latestBrief(run), w.piece, runCtx(run, memoryHits));
    const prompt = w.resumed ? `${buildResumedWorkerNote()}\n\n${piecePrompt}` : piecePrompt;
    const res = await spawnAgent(run, 'worker', { pieceId: w.piece.id, label, prompt });
    if (!res.ok && res.cancelled && run.paused) return;
    if (!res.ok) finishWorker(run, w, false, res.cancelled ? 'Stopped before it started.' : `Worker could not start: ${res.error}`);
  };

  const launchQueuedWorkers = (run: RunState) => {
    // A run waiting for its project to reopen to be finalized (or stopped by the user) starts nothing new.
    if (run.finalized || run.deferredFinalize || run.paused) return;
    const limit = Math.max(1, Math.floor(depsRef.current.agentPipelineOptionsRef.current.maxConcurrentAgents || 1));
    let running = run.workers.filter((w) => w.status === 'running').length;
    for (const w of run.workers) {
      if (running >= limit) break;
      if (w.status !== 'queued') continue;
      w.status = 'running';
      running++;
      void startWorker(run, w);
    }
    saveRunState(run);
  };

  /** Stop every worker of the run that hasn't reported (manager finished without waiting, or run ended). */
  const cancelOpenWorkers = (run: RunState, reason: string) => {
    for (const w of run.workers) {
      if (w.status !== 'queued' && w.status !== 'running') continue;
      const wasRunning = w.status === 'running';
      w.status = 'failed';
      patchStep(run, w.stepId, { status: 'cancelled', detail: reason });
      if (wasRunning) {
        setSessionStatus(w.ptySessionId, 'cancelled');
        void killAgentSessions({ sessionId: w.ptySessionId });
      }
    }
    saveRunState(run);
  };

  // ── verifier ──
  const launchVerifier = async (run: RunState, completionMarkdown: string) => {
    run.verifierRuns += 1;
    run.verifierActive = true;
    saveRunState(run);
    const attempt = run.verifierRuns;
    const stepId = `step-verifier-${run.taskKey}-${run.runId}-${attempt}`;
    // A follow-up cycle counts its verifier attempts from 1 again (the step id above stays unique across cycles).
    const shownAttempt = attempt - (run.verifierBase ?? 0);
    const ptySessionId = runSessionId(run, 'verifier');
    upsertStep(run, {
      id: stepId,
      taskId: run.taskId,
      time: nowTime(),
      stage: 'verifier',
      agentRole: 'verifier',
      ptySessionId,
      title: shownAttempt > 1 ? `Verifier (attempt ${shownAttempt})` : run.followUps ? `Verifier (follow-up ${run.followUps})` : 'Verifier',
      detail: 'Verifying the manager\'s work against the acceptance criteria (tests, build, completion record)…',
      status: 'running',
    });
    setSessionStatus(run.managerSessionId, 'waiting');
    patchStep(run, run.managerStepId, (s) => ({
      ...s,
      detail: `${s.detail}\n\n↳ Completion record written; waiting on the verifier${shownAttempt > 1 ? ` (attempt ${shownAttempt})` : ''}.`,
    }));
    const verifierTask = latestTask(run);
    const memoryHits = await prefetchPromptMemory(run.projectId, taskMemoryQuery(verifierTask));
    if (run.finalized || run.paused) return; // stopped while the memory search ran: the stop path settles verifier / the run
    const prompt = buildVerifierCliPrompt(verifierTask, latestBrief(run), { ...runCtx(run, memoryHits), completionMarkdown, attempt: shownAttempt });
    const res = await spawnAgent(run, 'verifier', { label: shownAttempt > 1 ? `Verifier · attempt ${shownAttempt}` : 'Verifier', prompt });
    if (!res.ok && res.cancelled) return; // stopped while starting: the stop path settles verifier / the run
    if (!res.ok) {
      run.verifierActive = false;
      run.verifierNote = `The verifier could not start: ${res.error}`;
      saveRunState(run);
      patchStep(run, stepId, { status: 'error', detail: run.verifierNote });
      // eslint-disable-next-line @typescript-eslint/no-use-before-define
      await finalizeRun(run, { reason: 'verifier-error', completionMarkdown });
    }
  };

  const verifierStepId = (run: RunState) => `step-verifier-${run.taskKey}-${run.runId}-${run.verifierRuns}`;

  // ── Finalize ──
  const finalizeRun = async (run: RunState, opts: FinalizeOptions): Promise<void> => {
    // A stopped run is paused, not ended: nothing is logged until it is resumed and finishes.
    if (run.finalized || run.paused) return;
    const d0 = depsRef.current;
    if (run.projectId && run.projectId !== d0.projectId) {
      // Tasks/briefs in memory belong to the open project: write this run's log when its project is open again.
      if (!run.deferredFinalize) {
        run.deferredFinalize = opts;
        saveRunState(run);
        if (opts.reason !== 'stopped') {
          for (const s of sessionsRef.current) {
            if (s.runId === run.runId && s.role !== 'manager' && s.session.isActive) void killAgentSessions({ sessionId: s.ptySessionId });
          }
        }
      }
      return;
    }
    const briefAtStart = latestBrief(run);
    clearQuestion(run, 'cancelled', '↳ The run ended before you answered.');
    run.finalized = true;
    if (briefLoggedRun(briefAtStart, run)) {
      run.deferredFinalize = undefined;
      saveRunState(run);
      run.resolveDone();
      return;
    }
    // finalized is true in memory (nothing else acts on the run now) but persisted only once the log is saved;
    // until then the persisted state carries these options, so a reload in between finalizes the run again.
    run.finalizePending = true;
    run.deferredFinalize = opts;
    saveRunState(run);

    const followUp = run.followUps ?? 0;
    const recordStepId = `step-record-${run.taskKey}-${run.runId}${followUp ? `-f${followUp}` : ''}`;
    upsertStep(run, {
      id: recordStepId,
      taskId: run.taskId,
      time: nowTime(),
      stage: 'built_record',
      agentRole: 'logger',
      title: 'Completion Log',
      detail: 'Writing the completion log from the agent run…',
      status: 'running',
    });

    // Workers / verifier never outlive the run; the manager stays open (unless stopped) so the user can keep steering.
    cancelOpenWorkers(run, opts.reason === 'stopped' ? 'Stopped by user.' : 'Run finished before this worker reported.');
    if (run.verifierActive) {
      run.verifierActive = false;
      patchStep(run, verifierStepId(run), { status: 'cancelled', detail: opts.reason === 'stopped' ? 'Stopped by user.' : 'Run ended before the verifier reported.' });
    }
    for (const s of sessionsRef.current) {
      if (s.runId !== run.runId || s.role === 'manager' || !s.session.isActive) continue;
      if (!TERMINAL_STATUSES.has(s.status)) setSessionStatus(s.ptySessionId, 'cancelled');
      void killAgentSessions({ sessionId: s.ptySessionId });
    }
    // If a planned verifier session was never started, remove it from sessions so it does not linger:
    commitSessions((prev) => prev.filter((s) => !(s.runId === run.runId && s.role === 'verifier' && s.status === 'waiting')));

    // CLIs flush their session logs on exit; give them a moment before reading usage / final message.
    if (opts.reason === 'exit' || opts.reason === 'stopped') await sleep(1500);

    await Promise.all(
      sessionsRef.current
        .filter((s) => s.runId === run.runId && s.spawnId)
        .map(async (s) => {
          const u = await fetchCliSessionUsage(s.ptySessionId);
          if (u && s.spawnId) noteSpawnUsage(s.spawnId, u, run);
        })
    );
    applyRunUsage(run);
    const totalUsage = runUsageTotal(run);

    const agentRecord = (opts.completionMarkdown ?? run.lastCompletion ?? '').trim();
    let body = agentRecord;
    let bodySource: 'agent-file' | 'session-log' | 'none' = body ? 'agent-file' : 'none';
    if (!body) {
      const transcript = await fetchAgentTranscript(run.managerSessionId);
      const finalMessage = transcript?.finalMessage?.trim() || '';
      if (finalMessage && transcript?.finalMessageSource !== 'none') {
        body = finalMessage;
        bodySource = 'session-log';
      }
    }

    // A newer launch of this task (e.g. Run pressed again during the post-stop flush) owns the task, brief, job
    // and steps now: writing this run's log would clobber it.
    if (runsRef.current.get(rk(run)) !== run) {
      run.finalizePending = false;
      run.deferredFinalize = undefined;
      saveRunState(run);
      run.resolveDone();
      return;
    }
    // The user switched projects while we awaited: App's tasks/briefs belong to another project now. Finish this
    // run when its project is open again (restore picks up deferredFinalize); workers / verifier were already stopped.
    if (run.projectId && run.projectId !== dataProjectId()) {
      run.finalizePending = false;
      run.finalized = false;
      run.deferredFinalize = opts;
      saveRunState(run);
      return;
    }

    // ── Everything below reads the latest App state (after all awaits). ──
    const d = depsRef.current;
    const date = new Date().toISOString().split('T')[0];
    const verifier = run.lastVerifier;
    const exitCode = opts.exitCode;
    const failedRun =
      opts.reason === 'stopped' || (opts.reason === 'exit' && exitCode !== 0 && !agentRecord);

    const reasonText = (() => {
      switch (opts.reason) {
        case 'complete':
          return 'completed';
        case 'verifier-pass':
          return `completed, verifier passed${verifier && verifier.attempt > 1 ? ` on attempt ${verifier.attempt}` : ''}`;
        case 'verifier-fail': {
          const attempts = run.verifierRuns - (run.verifierBase ?? 0);
          return `Verifier failed after ${attempts} attempt${attempts === 1 ? '' : 's'}`;
        }
        case 'verifier-error':
          return 'the verifier did not reach a verdict';
        case 'stopped':
          return 'stopped by user';
        case 'exit':
          return exitCode === 0
            ? 'agent exited'
            : typeof exitCode === 'number'
              ? `agent exited with code ${exitCode}`
              : 'agent session ended while Ergo was not connected';
      }
    })();

    // Human review items: the agent's own, plus Ergo's when the verifier failed / couldn't run / no record exists.
    const agentReviewItems = agentRecord ? extractHumanReviewItems(agentRecord) : [];
    const ergoReviewItems: string[] = [];
    if (opts.reason === 'verifier-fail' && verifier) {
      ergoReviewItems.push(`The verifier reported failures after ${run.verifierRuns - (run.verifierBase ?? 0)} attempt(s) — check the verifier findings in the completion log.`);
    }
    if (opts.reason === 'verifier-error') {
      ergoReviewItems.push(`Manually verify the work: ${run.verifierNote || 'the verifier did not reach a verdict'}.`);
    }
    if (!agentRecord && opts.reason === 'exit' && exitCode !== 0) {
      ergoReviewItems.push('The agent ended without writing a completion record — review its terminal output and the changed files.');
    }
    const reviewItems = [...agentReviewItems, ...ergoReviewItems];

    // The completion log is a brief, human-scannable check of what got done — never a dump of terminal output or
    // agent reports (that only costs tokens wherever the log is read back). Long agent text is cut down here too.
    const parts: string[] = followUp
      ? [
          `## Follow-up ${followUp} (${date}) — ${run.cliName}, ${reasonText}`,
          ...(run.followUpText ? [`_You: "${truncate(run.followUpText, 240)}"_`] : []),
        ]
      : [`## Completion (${date}) — ${run.cliName}, ${reasonText}`];
    if (agentRecord) {
      parts.push(compactCompletionRecord(agentRecord, reviewItems));
    } else if (body) {
      // No record file: the agent's last reply, trimmed to a short excerpt.
      parts.push(`### Agent's last message\n_No completion record was written._\n\n${truncate(body.replace(/\n{3,}/g, '\n\n'), 600)}`);
    } else {
      parts.push(
        opts.reason === 'stopped'
          ? 'The run was stopped before the agent wrote its completion record.'
          : 'The agent did not write a completion record.'
      );
    }
    if (run.workers.length > 0) {
      parts.push(
        `### Workers\n` +
          numberedList(run.workers.map((w) => `${w.piece.id} ${w.status === 'done' ? '✓' : '✗ did not finish'}`), run.workers.length, () => '')
      );
    }
    if (verifier) {
      // PASS: just the verdict. FAIL: the first few findings, one line each.
      const findings = verifier.verdict === 'FAIL' ? topFindings(stripVerdictLine(verifier.content), 3) : [];
      parts.push(`### Verifier\n${verifier.verdict === 'PASS' ? 'Passed' : 'Failed'}${verifier.attempt > 1 ? ` (attempt ${verifier.attempt})` : ''}${findings.length ? `\n${numberedList(findings, findings.length, () => '')}` : ''}`);
    } else if (run.verifierNote) {
      parts.push(`### Verifier\n${truncate(run.verifierNote, 200)}`);
    }
    if (ergoReviewItems.length > 0 && !agentRecord) {
      parts.push(`### Needs your review\n${reviewList(ergoReviewItems)}`);
    }
    const completionText = parts.join('\n\n').trim();

    const verification = agentRecord ? truncate(extractSection(agentRecord, ['verified', 'verification']), 400) : '';
    const createdFromRecord = agentRecord ? extractCreatedFiles(agentRecord) : [];
    const workerFiles = run.workers.filter((w) => w.status === 'done').flatMap((w) => w.piece.files);
    const status: TaskStatus = failedRun || reviewItems.length > 0 ? 'partly_done' : 'done';

    const sessionsOfRun = sessionsRef.current.filter((s) => s.runId === run.runId);
    const agentLines = [
      `- Manager (${run.cliName})`,
      ...run.workers.map((w) => `- Worker ${w.piece.id} · ${w.piece.title}: ${w.status === 'done' ? 'done' : 'did not finish'}`),
      ...(verifier ? [`- Verifier: ${verifier.verdict} (attempt ${verifier.attempt})`] : run.verifierNote ? [`- Verifier: ${run.verifierNote}`] : []),
    ];
    const usageComment = hasUsage(totalUsage) ? `\n\n<!-- task_token_usage: ${JSON.stringify(totalUsage)} -->` : '';
    const buildRecord =
      `**Build Record (${date}):** CLI agent run \`${run.runId}\`${followUp ? `, follow-up ${followUp}` : ''} (${sessionsOfRun.length} agent session${sessionsOfRun.length === 1 ? '' : 's'}).\n` +
      agentLines.join('\n') +
      (verification ? `\n\n**Verification:**\n${verification}` : '') +
      usageComment;

    // Task
    const tasks = d.tasksRef.current;
    const taskIdx = tasks.findIndex((t) => String(t.id) === run.taskKey);
    const baseTask = taskIdx === -1 ? run.taskSnapshot : tasks[taskIdx];
    const createdFiles = Array.from(new Set([...(baseTask.createdFiles || []), ...createdFromRecord, ...workerFiles]));
    let nextTasks = tasks;
    if (taskIdx !== -1) {
      let subtasks: Subtask[] = baseTask.subtasks;
      if (!failedRun) {
        const existingReview = baseTask.subtasks.filter((s) => s.isHumanReview);
        const seen = new Set(existingReview.map((s) => s.text.trim().toLowerCase()));
        const added: Subtask[] = [];
        reviewItems.forEach((text) => {
          if (seen.has(text.trim().toLowerCase())) return;
          seen.add(text.trim().toLowerCase());
          added.push({ id: `${baseTask.id}-hr-${existingReview.length + added.length + 1}`, text, isDone: false, isHumanReview: true });
        });
        subtasks = [
          ...baseTask.subtasks.filter((s) => !s.isHumanReview).map((s) => ({ ...s, isDone: true })),
          ...existingReview,
          ...added,
        ];
      }
      const updatedTask: TaskItem = {
        ...baseTask,
        status,
        isDone: status === 'done',
        isHumanReview: reviewItems.length > 0 || Boolean(baseTask.isHumanReview),
        subtasks,
        ...(createdFiles.length ? { createdFiles } : {}),
        ...(hasUsage(totalUsage) ? { totalUsage } : {}),
      };
      nextTasks = tasks.map((t, i) => (i === taskIdx ? updatedTask : t));
    }

    // Brief
    const briefs = d.briefsRef.current;
    const briefIdx = findBriefIndex(briefs, run.taskId, baseTask.title);
    const existing = briefIdx === -1 ? undefined : briefs[briefIdx];
    const humanReviewText = reviewItems.length ? reviewItems.map((i) => `- [ ] ${i}`).join('\n') : '';
    // A follow-up appends its entry: the earlier completion log (and build record) stay as they were.
    const appendTo = (previous: string | undefined, next: string) =>
      followUp && previous && previous.trim() ? `${previous.trim()}\n\n---\n\n${next}` : next;
    const updatedBrief: AgentContextItem = {
      ...(existing || {
        id: `brief_${run.taskKey}`,
        sourceTaskId: run.taskId,
        sourceLaneId: baseTask.swimLaneId,
        title: baseTask.title,
        overview: '',
        brief: '',
        built: '',
      }),
      status,
      buildAndVerification: appendTo(existing?.buildAndVerification, buildRecord),
      built: appendTo(existing?.built, buildRecord),
      completion: appendTo(existing?.completion, completionText),
      validation: verification,
      humanReview: humanReviewText,
      followUps: '',
      completionRunId: completionKeyOf(run),
      lastRunOutcome: buildRunOutcomeRecord({
        runId: run.runId,
        outcome: runOutcomeFor(opts.reason, verifier?.verdict, failedRun),
        escalation: run.launch?.startEscalation ?? run.startEscalation ?? 0,
        verifierRetries: run.verifierRetriesUsed - (run.verifierBase ?? 0),
        rating: (briefAtStart ?? latestBrief(run))?.overviewDocument?.taskRating,
        models: run.launch || run.roles
          ? {
              manager: (run.launch?.roles ?? run.roles)!.manager,
              worker: (run.launch?.roles ?? run.roles)!.worker,
              verifier: (run.launch?.roles ?? run.roles)!.verifier,
            }
          : undefined,
        startModels: run.startRoles
          ? { manager: run.startRoles.manager, worker: run.startRoles.worker, verifier: run.startRoles.verifier }
          : undefined,
        family: run.launch ? familyForTarget({ provider: 'none', authMode: 'cli_subscription', cliCustomCommand: run.launch.cmd }) ?? undefined : undefined,
      }),
      ...(createdFiles.length ? { createdFiles } : {}),
      ...(hasUsage(totalUsage) ? { totalUsage } : {}),
    } as AgentContextItem;
    const nextBriefs = briefIdx === -1 ? [...briefs, updatedBrief] : briefs.map((b, i) => (i === briefIdx ? updatedBrief : b));

    // Steps + jobs first so the save below writes them into RUNNING_JOBS.json too.
    const managerStepStatus: ExecutionStep['status'] =
      opts.reason === 'stopped' ? 'cancelled' : failedRun ? 'error' : 'success';
    patchStep(run, run.managerStepId, (s) => ({
      ...s,
      status: managerStepStatus,
      detail: `${s.detail}\n\n${
        managerStepStatus === 'success'
          ? `✓ Manager finished (${reasonText}).`
          : managerStepStatus === 'cancelled'
            ? '■ Run stopped by user.'
            : `✗ ${reasonText.charAt(0).toUpperCase()}${reasonText.slice(1)}.`
      }`,
    }));
    patchStep(run, recordStepId, {
      status: 'success',
      detail:
        `Completion log written (${bodySource === 'agent-file' ? "from the manager's completion record" : bodySource === 'session-log' ? "from the agent's final reply" : 'deterministic record'})` +
        `${reviewItems.length ? ` with ${reviewItems.length} human review item(s)` : ''}. Task marked ${status === 'done' ? 'Done' : 'Partly done'}.`,
      ...(hasUsage(totalUsage) ? { totalUsage } : {}),
    });
    const jobStatus: RunningJobInfo['status'] =
      opts.reason === 'stopped' ? 'cancelled' : failedRun ? 'failed' : 'completed';
    const completedAt = new Date().toISOString();
    updateJobs((jobs) =>
      jobs.map((j) =>
        String(j.taskId) === run.taskKey && (j.status === 'in_progress' || j.status === 'queued')
          ? { ...j, status: jobStatus, completedAt }
          : j
      )
    );
    clearExecuting(run.taskId);

    const manager = findSession(run.managerSessionId);
    // Keep the manager's own conversation id now (Codex), so a follow-up after a Stop can still resume it.
    if (manager && manager.runId === run.runId) void captureResumeId(run, manager);
    if (manager && manager.runId === run.runId && !TERMINAL_STATUSES.has(manager.status)) {
      // The manager stays open (status done) so the user can keep steering it; a stopped one was killed.
      setSessionStatus(run.managerSessionId, opts.reason === 'stopped' ? 'cancelled' : 'done');
    }

    d.syncAndSaveProject(nextTasks, nextBriefs, true);
    // The completion log (and brief.completionRunId) is saved: now the run may be persisted as finalized.
    run.finalizePending = false;
    run.deferredFinalize = undefined;
    saveRunState(run);
    if (stepPersistTimerRef.current) {
      clearTimeout(stepPersistTimerRef.current);
      stepPersistTimerRef.current = null;
    }

    if (opts.reason !== 'stopped') {
      d.showToast({
        type: status === 'done' ? 'success' : 'warning',
        title: status === 'done' ? 'Task Completed' : 'Task Needs Review',
        message: `"${baseTask.title}": ${reasonText}. The completion log has been written.`,
        duration: 6000,
        actionLabel: 'Open task',
        onAction: () => depsRef.current.openTask(run.taskId),
      });
    }

    run.resolveDone();

    // Messages sent while the manager was gone mid-run continue the run now that it has finished.
    const pending = run.pendingFollowUps || [];
    if (pending.length > 0) {
      run.pendingFollowUps = [];
      saveRunState(run);
      if (opts.reason !== 'stopped') {
        // eslint-disable-next-line @typescript-eslint/no-use-before-define
        void enqueue(rk(run), () => continueRunWith(run, pending.join('\n\n'), {}).then(() => undefined));
      }
    }
  };

  /** Mark the run's job in progress again (restored run, or a follow-up reopened it). False when it already was. */
  const reviveRunJob = (run: RunState): boolean => {
    const hasLiveJob = depsRef.current.runningJobsRef.current.some(
      (j) => String(j.taskId) === run.taskKey && j.status === 'in_progress'
    );
    if (hasLiveJob) return false;
    updateJobs((jobs) => {
      const idx = jobs.findIndex((j) => String(j.taskId) === run.taskKey);
      const revived: RunningJobInfo = {
        ...(idx === -1
          ? { id: `job_cli_${run.taskKey}_${Date.now()}`, taskId: run.taskId, taskTitle: run.taskTitle, type: 'cli' as const, startedAt: run.startedAt }
          : jobs[idx]),
        status: 'in_progress',
        sessionId: run.managerSessionId,
      };
      delete revived.completedAt;
      return idx === -1 ? [...jobs, revived] : jobs.map((j, i) => (i === idx ? revived : j));
    });
    schedulePersist();
    return true;
  };

  /** The task (and its brief) shows this status; the rest of both is left as it is. */
  const setTaskStatus = (run: RunState, status: TaskStatus) => {
    if (isForeignRun(run)) return;
    const d = depsRef.current;
    const tasks = d.tasksRef.current;
    const nextTasks = tasks.map((t) => (String(t.id) === run.taskKey && t.status !== status ? { ...t, status, isDone: status === 'done' } : t));
    const briefs = d.briefsRef.current;
    const briefIdx = findBriefIndex(briefs, run.taskId, latestTask(run).title);
    const nextBriefs =
      briefIdx === -1 || briefs[briefIdx].status === status ? briefs : briefs.map((b, i) => (i === briefIdx ? { ...b, status } : b));
    if (nextTasks.some((t, i) => t !== tasks[i]) || nextBriefs !== briefs) d.syncAndSaveProject(nextTasks, nextBriefs, true);
  };

  // ── Stop / resume ──

  /**
   * Settle a run the user stopped partway (stopCliRun already set run.paused and killed its agents). The run stays
   * open exactly where it was: no completion log, no checklist or done changes, no run record. Workers that were
   * working are queued again and verifier's attempt is rolled back, so resumeRun restarts them. `note` replaces the
   * manager step's stop line (e.g. a resume that could not start).
   */
  const pauseRun = async (run: RunState, note?: string): Promise<void> => {
    if (run.finalized || !run.paused) return;
    clearQuestion(run, 'cancelled', '■ Stopped before you answered — the manager can ask again after Resume.');
    run.paused = {
      ...run.paused,
      managerWasLive: run.paused.managerWasLive ?? run.managerExitCode === undefined,
      verifierInterrupted: Boolean(run.paused.verifierInterrupted || run.verifierActive),
    };
    for (const w of run.workers) {
      if (w.status === 'running') {
        w.status = 'queued';
        w.resumed = true;
        patchStep(run, w.stepId, { status: 'cancelled', detail: `${w.piece.instructions.trim()}\n\n■ Stopped by user — this worker starts again when the task is resumed.` });
        void killAgentSessions({ sessionId: w.ptySessionId });
      }
    }
    if (run.verifierActive) {
      patchStep(run, verifierStepId(run), { status: 'cancelled', detail: 'Stopped by user — verifier runs again when the task is resumed.' });
      run.verifierActive = false;
      run.verifierRuns = Math.max(0, run.verifierRuns - 1); // the resumed attempt reuses this attempt's number and step
    }
    const stopLine = note || '■ Stopped by user. Nothing was logged — Resume picks the run up from here.';
    updateSteps(run, (steps) =>
      steps.map((st) => {
        if (st.id === run.managerStepId) return { ...st, status: 'cancelled', detail: `${st.detail}\n\n${stopLine}` };
        return st.status === 'running' && st.id.includes(run.runId) ? { ...st, status: 'cancelled' } : st;
      })
    );
    const completedAt = new Date().toISOString();
    updateJobs((jobs) =>
      jobs.map((j) =>
        String(j.taskId) === run.taskKey && (j.status === 'in_progress' || j.status === 'queued') ? { ...j, status: 'cancelled', completedAt } : j
      )
    );
    clearExecuting(run.taskId);
    setTaskStatus(run, 'partly_done');
    saveRunState(run);
    run.resolveDone();

    // Usage so far, and (Codex / Antigravity) the manager's conversation id, once the CLIs have flushed their logs.
    await sleep(1500);
    await Promise.all(
      sessionsRef.current
        .filter((s) => s.runId === run.runId && s.spawnId)
        .map(async (s) => {
          const u = await fetchCliSessionUsage(s.ptySessionId);
          if (u && s.spawnId) noteSpawnUsage(s.spawnId, u, run);
        })
    );
    // The total so far stays on the task (steps, brief, task): a Stop never drops it, and Resume adds to it.
    applyRunUsage(run, true);
    if (!run.finalized && run.paused && runsRef.current.get(rk(run)) === run) saveRunUsage(run);
    const manager = findSession(run.managerSessionId);
    if (manager && manager.runId === run.runId) await captureResumeId(run, manager);
    saveRunState(run);
  };

  /**
   * Pick a stopped run up where it stopped: the manager's own conversation is resumed when the CLI can (else a new
   * manager gets the original prompt with a "continue, don't start over" note), interrupted workers start again and
   * an interrupted verifier attempt runs again. Runs in the run's event queue.
   */
  const resumeRun = async (run: RunState, message = ''): Promise<TaskMessageResult> => {
    if (!run.paused || run.finalized) return { ok: false, error: 'This run is not stopped.' };
    if (runsRef.current.get(rk(run)) !== run) return { ok: false, error: 'A newer run of this task has started.' };
    if (isForeignRun(run)) return { ok: false, error: "Open this task's project to resume it." };
    const launch = await ensureLaunch(run);
    if (!launch) return { ok: false, error: 'No CLI agent is configured for the active AI profile.' };
    if (!run.cliName) run.cliName = launch.cliName || launch.cmd;

    const paused = run.paused;
    const userMessage = [...(run.pendingFollowUps || []), message.trim()].filter(Boolean).join('\n\n');
    run.paused = undefined;
    run.pendingFollowUps = [];
    run.managerExitCode = paused.managerWasLive ? undefined : run.managerExitCode;
    renewDonePromise(run);
    saveRunState(run);

    reviveRunJob(run);
    depsRef.current.setExecutingTaskId(run.taskId);
    setTaskStatus(run, 'in_progress');
    patchStep(run, run.managerStepId, (s) => ({
      ...s,
      status: 'running',
      detail: `${s.detail}\n\n▶ Resumed by user${userMessage ? `: "${truncate(userMessage, 400)}"` : ''}.`,
    }));
    if (userMessage) {
      recordSteeringMessage({ taskId: String(run.taskId), runId: run.runId, role: 'manager', text: userMessage, phase: 'mid-run', projectId: run.projectId, taskTitle: run.taskTitle });
    }

    // Workers that reported while the run was stopped: their hand-off goes into the manager's resume message.
    const round = currentRoundWorkers(run);
    const roundSettled = round.length > 0 && round.every((w) => w.status === 'done' || w.status === 'failed');
    let workersDone: string | undefined;
    if (roundSettled && !run.workersReported) {
      workersDone = buildWorkersDoneMessage(
        round.map((w) => ({ pieceId: w.piece.id, title: w.piece.title, fileRel: `${runDirRel(run.runId)}/worker-${w.piece.id}.md`, ok: w.status === 'done' })),
        runCtx(run)
      );
    }
    const workersQueued = run.workers.some((w) => w.status === 'queued');
    // A message for a manager that was waiting on verifier is work to do first: Verifier then checks its new completion record.
    const rerunVerifier = Boolean(paused.verifierInterrupted && !(userMessage && paused.managerWasLive));
    const waitingOn: ResumeWaitingOn = rerunVerifier ? 'verifier' : workersQueued ? 'workers' : undefined;

    let delivery: TaskMessageResult['delivery'] = 'unpaused';
    if (paused.managerWasLive) {
      const started = await startResumedManager(run, launch, { userMessage, waitingOn, workersDone });
      if (!started.ok) {
        run.paused = paused;
        if (userMessage) run.pendingFollowUps = [userMessage];
        await pauseRun(run, `⚠ Could not resume the manager: ${started.error}`);
        return { ok: false, error: `Could not resume the manager: ${started.error}` };
      }
      if (workersDone) run.workersReported = true;
      if (waitingOn) setSessionStatus(run.managerSessionId, 'waiting');
    } else if (userMessage) {
      // The manager had already exited (its workers / verifier were still running): the message continues the run once they finish.
      run.pendingFollowUps = [userMessage];
      delivery = 'held';
    }
    saveRunState(run);

    if (rerunVerifier) await launchVerifier(run, run.lastCompletion || '');
    launchQueuedWorkers(run);
    // Manager gone and nothing left to wait for: close the run out as the exit it was.
    if (!paused.managerWasLive && !rerunVerifier && !run.workers.some((w) => w.status === 'queued' || w.status === 'running')) {
      await finalizeRun(run, { reason: 'exit', exitCode: run.managerExitCode ?? null, completionMarkdown: run.lastCompletion });
    }
    return { ok: true, delivery, target: 'Manager' };
  };

  /** Start the manager of a resumed run: its own conversation when the CLI can resume it, else a new manager. */
  const startResumedManager = async (
    run: RunState,
    launch: CliLaunchConfig,
    opts: { userMessage: string; waitingOn: ResumeWaitingOn; workersDone?: string },
    allowResume = true
  ): Promise<{ ok: true; resumed: boolean } | { ok: false; error: string }> => {
    const base = baseCommandName(launch.cmd);
    const previous = findSession(run.managerSessionId);
    const startedBefore = Boolean(previous && previous.runId === run.runId && previous.spawnId);
    const sameCli = !previous || baseCommandName(previous.cmd) === base;
    let resumeId: string | undefined;
    if (allowResume && startedBefore && sameCli && (base === 'claude' || base === 'codex' || base === 'agy')) {
      resumeId = run.cliSessionId || (previous ? await captureResumeId(run, previous) : undefined);
    }
    const ctx = runCtx(run);
    let prompt: string;
    if (resumeId) {
      prompt = buildResumeMessage(ctx, opts);
    } else {
      const original = run.managerPrompt || buildManagerCliPrompt(latestTask(run), latestBrief(run), ctx);
      if (!run.managerPrompt) run.managerPrompt = original;
      // Never started (stopped while the files were scouted): its original prompt as it was.
      prompt = startedBefore ? buildResumedManagerPrompt(original, ctx, { userMessage: opts.userMessage, waitingOn: opts.waitingOn }) : original;
      if (!startedBefore && opts.userMessage) prompt = `${prompt}\n\nTHE USER'S MESSAGE:\n${opts.userMessage}`;
      if (opts.workersDone) prompt = `${prompt}\n\n${opts.workersDone}`;
    }
    // A resumed Claude session log holds the earlier turns too: count them once.
    if (resumeId && base === 'claude' && previous?.spawnId) forgetSpawnUsage(run, previous.spawnId);
    const res = await spawnAgent(run, 'manager', { label: 'Manager', prompt, ...(resumeId ? { resumeSessionId: resumeId } : {}) });
    if (!res.ok) return { ok: false, error: res.cancelled ? 'it was stopped while starting' : res.error };
    if (resumeId && res.session.spawnId) {
      resumeAttemptsRef.current.set(run.runId, {
        spawnId: res.session.spawnId,
        at: Date.now(),
        message: opts.userMessage,
        resumeOf: { waitingOn: opts.waitingOn, ...(opts.workersDone ? { workersDone: opts.workersDone } : {}) },
      });
    }
    noteOnStep(
      run,
      run.managerStepId,
      resumeId
        ? `↳ Resumed the manager's ${run.cliName} conversation where it stopped.`
        : startedBefore
          ? `↳ The manager's conversation can't be resumed: a new manager continues from the work already in the repository.`
          : '↳ Task prompt dispatched; watching the manager live.'
    );
    return { ok: true, resumed: Boolean(resumeId) };
  };

  // ── Questions (the manager's question.md) ──

  const questionToastId = (run: PersistedRunState) => `cli-question-${rk(run)}`;

  /** Show the run's open question: the task's question card and a toast; the manager waits on the user. */
  const showQuestion = (run: RunState) => {
    const q = run.question;
    if (!q || isForeignRun(run)) return;
    setSessionStatus(run.managerSessionId, 'waiting');
    const d = depsRef.current;
    d.showToast({
      id: questionToastId(run),
      type: 'warning',
      title: `Manager is asking — ${truncate(latestTask(run).title, 60)}`,
      message: truncate(q.prompt.question, 280),
      duration: 0,
      actionLabel: 'Answer',
      onAction: () => depsRef.current.openTask(run.taskId),
    });
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    void d.requestHumanInput(run.taskId, q.prompt).then((answer) => answerQuestion(run, q.key, answer));
  };

  /** Close the open question (answered, replaced or moot): its card, toast and step. */
  const clearQuestion = (run: RunState, status: ExecutionStep['status'], note: string) => {
    const q = run.question;
    if (!q) return;
    run.question = undefined;
    saveRunState(run);
    depsRef.current.dismissToast(questionToastId(run));
    depsRef.current.cancelHumanInput(run.taskId);
    patchStep(run, q.stepId, (st) => ({ ...st, status, detail: `${st.detail}\n\n${note}` }));
  };

  /** The user answered the question card: the answer is typed into the manager, which continues. */
  const answerQuestion = async (run: RunState, key: string, answer: string) => {
    const text = answer.trim();
    // '' = dismissed (e.g. Stop); a different key = an older card.
    if (!text || run.question?.key !== key || run.finalized || run.paused) return;
    const question = run.question.prompt.question;
    clearQuestion(run, 'success', `You answered: "${truncate(text, 400)}"`);
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    const res = await sendUserMessage(run.taskId, buildQuestionAnswerMessage(question, text));
    if (!res.ok) noteOnStep(run, run.managerStepId, `⚠ Your answer could not reach the manager: ${res.error}`);
  };

  // ── Prompt box: mid-run steering and post-run follow-ups ──

  /** An agent that can take a message now: alive, and not a worker / verifier that already reported. */
  const isLiveAgent = (s: SpawnedSession | undefined): s is SpawnedSession =>
    Boolean(
      s && s.session.isActive && s.status !== 'cancelled' && s.status !== 'failed' && (s.role === 'manager' || s.status !== 'done')
    );

  /** The step an agent's activity is noted under. */
  const stepIdForSession = (run: RunState, s: SpawnedSession): string => {
    if (s.role === 'worker') {
      return [...run.workers].reverse().find((w) => w.ptySessionId === s.ptySessionId)?.stepId ?? run.managerStepId;
    }
    return s.role === 'verifier' ? verifierStepId(run) : run.managerStepId;
  };

  const noteOnStep = (run: RunState, stepId: string, line: string) =>
    patchStep(run, stepId, (st) => ({ ...st, detail: `${st.detail}\n\n${line}` }));

  /**
   * Type a prompt-box message into an agent through typeIntoAgent (so never into an open approval prompt: it is held
   * and typed once the prompt clears). `delivered` fires when Ergo submits it, `dropped` if the agent ends first.
   */
  const typeUserMessage = async (
    ptySessionId: string,
    text: string,
    delivered: () => void,
    dropped: () => void
  ): Promise<'sent' | 'queued' | 'failed'> => {
    const waiter = { text, delivered, dropped };
    userMessageWaitersRef.current.set(ptySessionId, [...(userMessageWaitersRef.current.get(ptySessionId) || []), waiter]);
    const ok = await typeIntoAgent(ptySessionId, text);
    const list = userMessageWaitersRef.current.get(ptySessionId);
    const pending = Boolean(list?.includes(waiter));
    if (!ok) {
      if (list && pending) {
        const rest = list.filter((w) => w !== waiter);
        if (rest.length) userMessageWaitersRef.current.set(ptySessionId, rest);
        else userMessageWaitersRef.current.delete(ptySessionId);
      }
      return 'failed';
    }
    return pending ? 'queued' : 'sent';
  };

  /** Mid-run: the message goes straight to a live agent of the run (it takes it in at its next step). */
  const steerLiveAgent = async (
    run: RunState,
    target: SpawnedSession,
    message: string,
    opts: TaskMessageOptions,
    phase: 'mid-run' | 'post-run'
  ): Promise<TaskMessageResult> => {
    const role = target.role;
    const stepId = stepIdForSession(run, target);
    let queued = false;
    const status = await typeUserMessage(
      target.ptySessionId,
      message,
      () => {
        recordSteeringMessage({ taskId: String(run.taskId), runId: run.runId, role, text: message, phase, projectId: run.projectId, taskTitle: run.taskTitle });
        if (queued) noteOnStep(run, stepId, `↳ Your queued message reached ${target.label}.`);
        opts.onDelivered?.();
      },
      () => {
        noteOnStep(run, stepId, `⚠ ${target.label} ended before your queued message could be delivered.`);
        opts.onDropped?.();
      }
    );
    queued = status === 'queued';
    if (status === 'failed') return { ok: false, error: `Could not reach ${target.label}'s terminal — is it still running?` };
    noteOnStep(
      run,
      stepId,
      `↳ You → ${target.label}: "${truncate(message, 400)}"${queued ? ' (queued: delivered once the open prompt is answered)' : ''}`
    );
    return { ok: true, delivery: queued ? 'queued' : 'sent', target: target.label };
  };

  type ReopenSnapshot = Pick<PersistedRunState, 'followUps' | 'followUpText' | 'verifierBase' | 'verifierRetriesUsed' | 'managerStepId'> & {
    taskStatus?: TaskStatus;
    taskDone?: boolean;
    briefStatus?: AgentContextItem['status'];
  };

  /**
   * A follow-up reopens the finished run: a new follow-up cycle (its verifier attempts count from 1, its completion entry is
   * appended), a new manager step, and the task / job / executing indicator back to in progress.
   */
  const reopenRun = (run: RunState, message: string): ReopenSnapshot => {
    const d = depsRef.current;
    const task = d.tasksRef.current.find((t) => String(t.id) === run.taskKey);
    const brief = latestBrief(run);
    const snapshot: ReopenSnapshot = {
      followUps: run.followUps,
      followUpText: run.followUpText,
      verifierBase: run.verifierBase,
      verifierRetriesUsed: run.verifierRetriesUsed,
      managerStepId: run.managerStepId,
      taskStatus: task?.status,
      taskDone: task?.isDone,
      briefStatus: brief?.status,
    };
    run.finalized = false;
    run.finalizePending = false;
    run.deferredFinalize = undefined;
    run.followUps = (run.followUps ?? 0) + 1;
    run.followUpText = message;
    // Verifier runs again for this cycle's completion record ('complete' launches verifier while verifierRuns === verifierRetriesUsed).
    run.verifierRetriesUsed = run.verifierRuns;
    run.verifierBase = run.verifierRuns;
    run.verifierActive = false;
    run.lastVerifier = undefined;
    run.verifierNote = undefined;
    run.lastCompletion = undefined;
    run.managerExitCode = undefined;
    run.workersReported = true; // earlier delegation rounds are settled; a new delegate.json starts a new round
    renewDonePromise(run);
    const stepId = `step-followup-${run.taskKey}-${run.runId}-${run.followUps}`;
    run.managerStepId = stepId;
    saveRunState(run);
    upsertStep(run, {
      id: stepId,
      taskId: run.taskId,
      time: nowTime(),
      stage: 'execution',
      agentRole: 'manager',
      ptySessionId: run.managerSessionId,
      title: `Follow-up ${run.followUps}: Manager continues the task${run.cliName ? ` (${run.cliName})` : ''}`,
      detail: `You: "${truncate(message, 600)}"\n\nContinuing run \`${run.runId}\` from where it left off (no new overview or model routing).`,
      status: 'running',
    });
    if (task) {
      const nextTasks = d.tasksRef.current.map((t) =>
        String(t.id) === run.taskKey ? { ...t, status: 'in_progress' as TaskStatus, isDone: false } : t
      );
      const briefs = d.briefsRef.current;
      const idx = findBriefIndex(briefs, run.taskId, task.title);
      const nextBriefs = idx === -1 ? briefs : briefs.map((b, i) => (i === idx ? { ...b, status: 'in_progress' } : b));
      d.syncAndSaveProject(nextTasks, nextBriefs, true);
    }
    reviveRunJob(run);
    d.setExecutingTaskId(run.taskId);
    return snapshot;
  };

  /** The follow-up could not start: close the run again the way it was (its completion log is untouched). */
  const undoReopen = (run: RunState, snapshot: ReopenSnapshot, error: string) => {
    const d = depsRef.current;
    patchStep(run, run.managerStepId, (st) => ({ ...st, status: 'error', detail: `${st.detail}\n\n✗ ${error}` }));
    run.finalized = true;
    run.followUps = snapshot.followUps;
    run.followUpText = snapshot.followUpText;
    run.verifierBase = snapshot.verifierBase;
    run.verifierRetriesUsed = snapshot.verifierRetriesUsed;
    run.managerStepId = snapshot.managerStepId;
    saveRunState(run);
    run.resolveDone();
    const completedAt = new Date().toISOString();
    updateJobs((jobs) =>
      jobs.map((j) => (String(j.taskId) === run.taskKey && j.status === 'in_progress' ? { ...j, status: 'failed', completedAt } : j))
    );
    clearExecuting(run.taskId);
    if (snapshot.taskStatus) {
      const nextTasks = d.tasksRef.current.map((t) =>
        String(t.id) === run.taskKey ? { ...t, status: snapshot.taskStatus!, isDone: Boolean(snapshot.taskDone) } : t
      );
      const briefs = d.briefsRef.current;
      const idx = findBriefIndex(briefs, run.taskId, run.taskTitle);
      const nextBriefs =
        idx === -1 || snapshot.briefStatus === undefined ? briefs : briefs.map((b, i) => (i === idx ? { ...b, status: snapshot.briefStatus! } : b));
      d.syncAndSaveProject(nextTasks, nextBriefs, true);
    }
  };

  /** Resume attempts in flight (in memory): a resume the CLI rejects at once falls back to a continuation prompt. */
  const resumeAttemptsRef = useRef<
    Map<string, { spawnId: string; at: number; message: string; resumeOf?: { waitingOn: ResumeWaitingOn; workersDone?: string } }>
  >(new Map());

  /**
   * Post-run follow-up whose manager process is gone: resume the manager's own conversation with the message
   * (claude --resume · codex resume · agy --conversation). Without a resumable id a new manager continues the run
   * from its completion log. The run's models are reused (never routed again).
   */
  const restartManager = async (
    run: RunState,
    message: string,
    snapshot: ReopenSnapshot,
    record: () => void,
    allowResume = true
  ): Promise<TaskMessageResult> => {
    const launch = await ensureLaunch(run);
    if (!launch) {
      const error = 'No CLI agent is configured for the active AI profile.';
      undoReopen(run, snapshot, error);
      return { ok: false, error };
    }
    if (!run.cliName) run.cliName = launch.cliName || launch.cmd;
    const base = baseCommandName(launch.cmd);
    const previous = findSession(run.managerSessionId);
    const sameCli = !previous || baseCommandName(previous.cmd) === base;
    let resumeId: string | undefined;
    if (allowResume && sameCli && (base === 'claude' || base === 'codex' || base === 'agy')) {
      resumeId = run.cliSessionId || (previous ? await captureResumeId(run, previous) : undefined);
    }
    const ctx = runCtx(run);
    const task = latestTask(run);
    const brief = latestBrief(run);
    const prompt = resumeId
      ? buildFollowUpMessage(message, ctx)
      : buildContinuationPrompt(task, ctx, {
          userMessage: message,
          completionLog: brief?.completion,
          createdFiles: Array.from(new Set([...(task.createdFiles || []), ...(brief?.createdFiles || [])])),
        });
    // A resumed Claude session log holds the earlier turns too: count them once.
    if (resumeId && base === 'claude' && previous?.spawnId) forgetSpawnUsage(run, previous.spawnId);
    const res = await spawnAgent(run, 'manager', { label: 'Manager', prompt, ...(resumeId ? { resumeSessionId: resumeId } : {}) });
    if (!res.ok) {
      if (res.cancelled) return { ok: false, error: 'The follow-up was stopped while the manager was starting.' };
      const error = `Could not start the manager: ${res.error}`;
      undoReopen(run, snapshot, error);
      return { ok: false, error };
    }
    if (resumeId && res.session.spawnId) {
      resumeAttemptsRef.current.set(run.runId, { spawnId: res.session.spawnId, at: Date.now(), message });
    }
    record();
    noteOnStep(
      run,
      run.managerStepId,
      resumeId
        ? `↳ The manager had exited: resumed its ${run.cliName} conversation with your message.`
        : '↳ The manager had exited and its conversation can\'t be resumed: a new manager continues from the completion log with your message.'
    );
    return { ok: true, delivery: resumeId ? 'resumed' : 'restarted', target: 'Manager' };
  };

  /**
   * A resumed manager that exits within seconds with an error (e.g. the CLI no longer has that conversation) is
   * replaced by a new manager seeded with a continuation prompt. True when the fallback took over the exit.
   */
  const retryFailedResume = async (run: RunState, session: SpawnedSession, code: number): Promise<boolean> => {
    const attempt = resumeAttemptsRef.current.get(run.runId);
    if (!attempt || attempt.spawnId !== session.spawnId) return false;
    resumeAttemptsRef.current.delete(run.runId);
    if (code === 0 || Date.now() - attempt.at > 30_000) return false;
    if (attempt.resumeOf) {
      // Resuming a stopped run: a new manager picks up from the work already in the repository.
      run.cliSessionId = undefined;
      saveRunState(run);
      noteOnStep(run, run.managerStepId, `⚠ Resuming the conversation failed (exit code ${code}); starting a new manager instead.`);
      const launch = await ensureLaunch(run);
      if (!launch) return false;
      const res = await startResumedManager(run, launch, { userMessage: attempt.message, ...attempt.resumeOf }, false);
      return res.ok;
    }
    if (run.lastCompletion) return false;
    run.cliSessionId = undefined;
    saveRunState(run);
    noteOnStep(run, run.managerStepId, `⚠ Resuming the conversation failed (exit code ${code}); starting a new manager from the completion log instead.`);
    const res = await restartManager(run, attempt.message, { followUps: run.followUps, followUpText: run.followUpText, verifierBase: run.verifierBase, verifierRetriesUsed: run.verifierRetriesUsed, managerStepId: run.managerStepId }, () => {}, false);
    return res.ok;
  };

  /** Post-run (runs in the run's event queue, after any finalize): reopen the run and hand the manager the message. */
  const continueRunWith = async (run: RunState, message: string, opts: TaskMessageOptions): Promise<TaskMessageResult> => {
    if (runsRef.current.get(rk(run)) !== run) return { ok: false, error: 'A newer run of this task has started — send the message again.' };
    if (run.paused && !run.finalized) return resumeRun(run, message);
    const manager = findSession(run.managerSessionId);
    const managerAlive = Boolean(manager && manager.runId === run.runId && isLiveAgent(manager));
    if (!run.finalized) {
      // Reopened meanwhile (e.g. two quick follow-ups): it is a mid-run message now.
      if (managerAlive) return steerLiveAgent(run, manager!, message, opts, 'mid-run');
      run.pendingFollowUps = [...(run.pendingFollowUps || []), message];
      saveRunState(run);
      return { ok: true, delivery: 'held', target: 'Manager' };
    }
    if (run.projectId && run.projectId !== depsRef.current.projectId) {
      return { ok: false, error: "Open this task's project to continue it." };
    }
    const snapshot = reopenRun(run, message);
    // A follow-up uses the task's verifier switch as it is now (the user may have changed it since the run).
    if (!isForeignRun(run)) run.verifierEnabled = (latestBrief(run)?.verification !== false) && (run.needsVerifier ?? true);
    const record = () =>
      recordSteeringMessage({ taskId: String(run.taskId), runId: run.runId, role: 'manager', text: message, phase: 'post-run', projectId: run.projectId, taskTitle: run.taskTitle });
    if (managerAlive) {
      // Working again (a held-back message is only typed into an agent whose run is live).
      setSessionStatus(run.managerSessionId, 'running');
      let queued = false;
      const status = await typeUserMessage(
        run.managerSessionId,
        buildFollowUpMessage(message, runCtx(run)),
        () => {
          record();
          if (queued) noteOnStep(run, run.managerStepId, '↳ Your queued follow-up reached the manager.');
          opts.onDelivered?.();
        },
        () => opts.onDropped?.()
      );
      queued = status === 'queued';
      if (status !== 'failed') {
        noteOnStep(
          run,
          run.managerStepId,
          queued
            ? '↳ Queued for the manager (still open) until its prompt is answered.'
            : '↳ Sent to the manager, which was still open: it continues from where it left off.'
        );
        return { ok: true, delivery: queued ? 'queued' : 'continued', target: 'Manager' };
      }
      // Its terminal is gone after all: resume the conversation instead.
    }
    return restartManager(run, message, snapshot, record);
  };

  /**
   * A task with no run in memory (app restarted, or another device ran it): its latest saved run on this device, or one
   * rebuilt from the brief's completion log (models from its last run record), so a follow-up can continue it.
   */
  const adoptRunForFollowUp = (projectId: string, taskKey: string): RunState | undefined => {
    const d = depsRef.current;
    const task = d.tasksRef.current.find((t) => String(t.id) === taskKey);
    if (!task) return undefined;
    const briefs = d.briefsRef.current;
    const brief = briefs[findBriefIndex(briefs, task.id, task.title)];
    const saved = listPersistedRuns()
      .filter((st) => st.projectId === projectId && st.taskKey === taskKey)
      .sort((a, b) => (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0))[0];
    let state: PersistedRunState | undefined =
      saved && saved.paused && !saved.finalized
        ? saved // stopped partway: resumed where it stopped
        : saved && (saved.finalized || briefLoggedRun(brief, saved))
          ? { ...saved, finalized: true, deferredFinalize: undefined }
          : undefined;
    if (!state) {
      if (!brief || !(brief.completion || '').trim()) return undefined;
      const lastRunId = brief.lastRunOutcome?.runId || brief.completionRunId?.split('#')[0];
      // CLI run ids are `${taskId}-…`: only a CLI run's models are in this CLI's vocabulary.
      const cliRunId = lastRunId && lastRunId.startsWith(`${taskKey}-`) ? lastRunId : undefined;
      const runId = cliRunId || makeCliRunId(task.id);
      const models = cliRunId ? brief.lastRunOutcome?.models : undefined;
      const opts = d.agentPipelineOptionsRef.current;
      state = {
        runId,
        projectId,
        taskKey,
        taskId: task.id,
        taskTitle: task.title,
        taskSnapshot: task,
        briefSnapshot: brief,
        startedAt: new Date().toISOString(),
        cliName: '',
        managerSessionId: agentSessionId(agentProjectKey(projectId), task.id, 'manager'),
        managerStepId: `step-manager-${taskKey}-${runId}`,
        verifierEnabled: (brief?.verification !== false) && (brief?.overviewDocument?.requiresVerifier ?? true),
        maxWorkers: Math.max(1, Math.min(8, Math.floor(opts.maxConcurrentAgents || 1))),
        maxVerifierRetries: Math.max(0, Math.floor(opts.maxVerifierRetries || 0)),
        workers: [],
        delegateRounds: 0,
        workersReported: true,
        verifierRuns: 0,
        verifierRetriesUsed: 0,
        verifierActive: false,
        handledSignals: [],
        finalized: true,
        followUps: Math.max(0, loggedCycleOf(brief, runId)),
        // Known models are reused; unknown ones fall back to the profile's defaults — never a new routing.
        roles: { manager: { ...(models?.manager || {}) }, worker: { ...(models?.worker || {}) }, verifier: { ...(models?.verifier || {}) } },
      };
    }
    const run = withDonePromise(state);
    runsRef.current.set(runKeyOf(projectId, taskKey), run);
    return run;
  };

  const sendUserMessage = async (taskId: string | number, text: string, opts: TaskMessageOptions = {}): Promise<TaskMessageResult> => {
    const message = String(text || '').trim();
    if (!message) return { ok: false, error: 'Type a message first.' };
    const projectId = depsRef.current.projectId;
    const taskKey = String(taskId);
    const run = runsRef.current.get(runKeyOf(projectId, taskKey)) ?? adoptRunForFollowUp(projectId, taskKey);
    if (!run) return { ok: false, error: 'no-run' };

    if (run.paused && !run.finalized) {
      // Stopped partway: the message resumes the run where it stopped.
      let resumed: TaskMessageResult = { ok: false, error: 'The run could not be resumed.' };
      await enqueue(rk(run), async () => {
        resumed = await resumeRun(run, message);
      });
      return resumed;
    }

    if (!run.finalized && !run.deferredFinalize) {
      // Mid-run: the agent the user is looking at while it works, else the manager.
      const shown = opts.ptySessionId ? findSession(opts.ptySessionId) : undefined;
      const manager = findSession(run.managerSessionId);
      const target = shown && shown.runId === run.runId && isLiveAgent(shown)
        ? shown
        : manager && manager.runId === run.runId && isLiveAgent(manager)
          ? manager
          : undefined;
      if (target && target.role === 'manager' && run.question) {
        // A message to a manager waiting on its question answers it.
        const question = run.question.prompt.question;
        clearQuestion(run, 'success', `You answered from the prompt box: "${truncate(message, 400)}"`);
        return steerLiveAgent(run, target, buildQuestionAnswerMessage(question, message), opts, 'mid-run');
      }
      if (target) return steerLiveAgent(run, target, message, opts, 'mid-run');
      // The manager exited while workers / verifier still run: the message continues the run once they finish.
      run.pendingFollowUps = [...(run.pendingFollowUps || []), message];
      saveRunState(run);
      noteOnStep(run, run.managerStepId, `↳ You: "${truncate(message, 400)}" — held: the manager has exited, so this continues the run once its agents finish.`);
      return { ok: true, delivery: 'held', target: 'Manager' };
    }

    // Post-run: serialized behind any finalize still writing the completion log.
    let result: TaskMessageResult = { ok: false, error: 'The follow-up could not be started.' };
    await enqueue(rk(run), async () => {
      result = await continueRunWith(run, message, opts);
    });
    return result;
  };

  // ── Event handling ──
  const sessionMatchesEvent = (s: SpawnedSession | undefined, ev: { runId?: string }): s is SpawnedSession =>
    Boolean(s && (!ev.runId || !s.runId || ev.runId === s.runId));

  /** The current run (of any project) with this id; replaced runs are no longer in runsRef. */
  const runById = (runId: string | undefined): RunState | undefined => {
    if (!runId) return undefined;
    for (const run of runsRef.current.values()) if (run.runId === runId) return run;
    return undefined;
  };

  const runForSession = (s: SpawnedSession): RunState | undefined => {
    const run = runById(s.runId);
    return run && String(run.taskKey) === String(s.session.taskId) ? run : undefined;
  };

  /** Run an agent event belongs to (by its session, else by its run id). */
  const runForEvent = (ev: { sessionId: string; runId?: string }): RunState | undefined => {
    const session = findSession(ev.sessionId);
    if (session) return runForSession(session);
    return runById(ev.runId);
  };

  /** Event-queue key: the run's key, so all agents of a run share one queue (and other projects' runs don't). */
  const queueKeyForEvent = (ev: { sessionId: string; taskId: string; runId?: string }): string => {
    const run = runForEvent(ev);
    if (run) return rk(run);
    return runKeyOf(sessionProjectOf(ev.sessionId) ?? `?${parseAgentSessionId(ev.sessionId).projectKey ?? ''}`, ev.taskId);
  };

  const handlePrompt = (ptySessionId: string, prompt: CliDetectedPrompt | null) => {
    const session = findSession(ptySessionId);
    if (!session) return;
    const base = baseStatusRef.current.get(ptySessionId) || (session.status === 'awaiting_approval' ? 'running' : session.status);
    if (!baseStatusRef.current.has(ptySessionId)) baseStatusRef.current.set(ptySessionId, base);
    // A prompt painted by an agent that is being stopped is moot.
    if (base === 'cancelled' || base === 'failed') prompt = null;
    patchSession(ptySessionId, (s) => {
      const status: AgentSessionStatus = prompt && s.session.isActive ? 'awaiting_approval' : base;
      return { ...s, pendingPrompt: prompt, status };
    });

    const toastId = `cli-prompt-${ptySessionId}`;
    if (!prompt) {
      promptToastSigRef.current.delete(ptySessionId);
      depsRef.current.dismissToast(toastId);
      flushDeferredInput(ptySessionId);
      return;
    }
    const bypassDialog = isBypassAcceptanceDialog(prompt);
    // The bridge only reports prompts it did not auto-answer (under Full access: none of the approve options was
    // safe to pick, or auto-approval gave up), so every prompt reported here needs the user.
    if (promptToastSigRef.current.get(ptySessionId) === prompt.signature) return;
    promptToastSigRef.current.set(ptySessionId, prompt.signature);

    const inOpenProject = sessionProjectOf(ptySessionId) === undefined || sessionProjectOf(ptySessionId) === depsRef.current.projectId;
    const task = inOpenProject
      ? depsRef.current.tasksRef.current.find((t) => String(t.id) === String(session.session.taskId))
      : undefined;
    const taskTitle = task?.title || session.session.taskTitle;
    const summary = truncate(promptSummary(prompt) || prompt.question, 280);
    const approveOption = prompt.kind === 'approval' && !bypassDialog ? pickApproveOption(prompt) : null;
    depsRef.current.showToast({
      id: toastId,
      type: 'warning',
      title:
        prompt.kind === 'approval'
          ? `Approve ${prompt.toolLabel || 'action'}? — ${session.label} · ${taskTitle}`
          : prompt.kind === 'notice'
            ? `${session.label} needs attention — ${taskTitle}`
            : `${session.label} is asking — ${taskTitle}`,
      message: summary,
      duration: 0,
      actions: [
        {
          label: 'Open task',
          variant: 'secondary',
          onClick: () => depsRef.current.openTask(session.session.taskId),
        },
        ...(approveOption
          ? [
              {
                label: approveOption.label.length > 24 ? 'Approve' : approveOption.label,
                variant: 'emerald' as const,
                onClick: () => {
                  const live = findSession(ptySessionId);
                  // Only answer the prompt the toast was raised for.
                  const livePrompt = live?.pendingPrompt;
                  if (livePrompt?.signature === prompt.signature) {
                    // Keys depend on the highlighted option, which may have moved since the toast was raised.
                    const liveOption = pickApproveOption(livePrompt);
                    if (liveOption) void sendAgentInput(ptySessionId, keystrokesForOption(livePrompt, liveOption));
                  }
                  depsRef.current.dismissToast(toastId);
                },
              },
            ]
          : []),
      ],
    });
  };

  const handleSignal = async (ev: Extract<CliAgentEvent, { type: 'signal' }>) => {
    const run = runForEvent(ev);
    if (!run || (ev.runId && ev.runId !== run.runId)) return;
    const key = `${ev.sessionId}:${ev.signal}:${ev.mtime}`;
    if (run.handledSignals.includes(key)) return;
    run.handledSignals.push(key);
    saveRunState(run);

    switch (ev.signal) {
      case 'delegate': {
        if (run.finalized || run.deferredFinalize || ev.role !== 'manager') return;
        if (currentRoundWorkers(run).some((w) => w.status === 'queued' || w.status === 'running')) {
          console.warn('[Ergo CLI runs] Ignoring delegate.json while workers of the previous round are still running.');
          return;
        }
        let pieces: CliWorkerPiece[] = [];
        try {
          pieces = parseDelegatePlan(ev.content, run.maxWorkers);
        } catch (err) {
          console.warn('[Ergo CLI runs] delegate.json could not be parsed:', err);
        }
        if (pieces.length === 0) {
          await typeIntoAgent(run.managerSessionId, buildWorkersDoneMessage([], runCtx(run)));
          patchStep(run, run.managerStepId, (s) => ({ ...s, detail: `${s.detail}\n\n⚠ delegate.json had no valid pieces — the manager continues alone.` }));
          return;
        }
        run.delegateRounds += 1;
        run.workersReported = false;
        const round = run.delegateRounds;
        for (const piece of pieces) {
          run.workers.push({
            piece,
            round,
            status: 'queued',
            stepId: `step-worker-${run.taskKey}-${run.runId}-r${round}-${piece.id}`,
            ptySessionId: runSessionId(run, 'worker', piece.id),
          });
        }
        saveRunState(run);
        // Written just before a Stop: the workers are queued and start when the run is resumed.
        if (!run.paused) setSessionStatus(run.managerSessionId, 'waiting');
        patchStep(run, run.managerStepId, (s) => ({
          ...s,
          detail: `${s.detail}\n\n↳ Delegated ${pieces.length} piece(s) to workers (${pieces.map((p) => p.id).join(', ')}); waiting for their results.`,
        }));
        launchQueuedWorkers(run);
        return;
      }
      case 'worker-done': {
        const w = [...run.workers].reverse().find((x) => x.ptySessionId === ev.sessionId);
        if (!w || (w.status !== 'running' && w.status !== 'queued')) return;
        w.resultFile = ev.file;
        setSessionStatus(ev.sessionId, 'done');
        finishWorker(run, w, true, `Result (${ev.file}):\n\n${firstLines(ev.content, 12)}`);
        setTimeout(() => {
          const s = findSession(ev.sessionId);
          if (s && s.spawnId && s.runId === run.runId && s.status === 'done') void killAgentSessions({ sessionId: ev.sessionId });
        }, 3000);
        return;
      }
      case 'question': {
        if (ev.role !== 'manager' || run.finalized || run.deferredFinalize || run.paused) return;
        const parsed = parseQuestionFile(ev.content);
        if (!parsed.question) return;
        clearQuestion(run, 'cancelled', '↳ Replaced by a newer question.');
        const stepId = `step-question-${run.taskKey}-${run.runId}-${ev.mtime}`;
        const prompt: HumanInputPrompt = {
          id: `cli-question-${run.runId}-${ev.mtime}`,
          taskId: run.taskId,
          question: parsed.question,
          ...(parsed.options.length ? { options: parsed.options } : {}),
          ...(parsed.context ? { context: parsed.context } : {}),
          allowFreeform: true,
        };
        upsertStep(run, {
          id: stepId,
          taskId: run.taskId,
          time: nowTime(),
          stage: 'human_input',
          agentRole: 'manager',
          title: 'Question from the Manager',
          detail: [parsed.question, parsed.context].filter(Boolean).join('\n\n'),
          status: 'running',
        });
        run.question = { key, prompt, stepId };
        saveRunState(run);
        showQuestion(run);
        return;
      }
      case 'complete': {
        if (ev.role !== 'manager') return;
        clearQuestion(run, 'cancelled', '↳ The manager finished without waiting for an answer.');
        run.lastCompletion = ev.content;
        saveRunState(run);
        // Stopped: the resumed manager writes it again when it is done.
        if (run.finalized || run.deferredFinalize || run.paused || run.verifierActive) return;
        if (currentRoundWorkers(run).some((w) => w.status === 'queued' || w.status === 'running')) {
          cancelOpenWorkers(run, 'The manager finished the task before this worker reported.');
        }
        if (run.verifierEnabled && run.verifierRuns === run.verifierRetriesUsed) {
          await launchVerifier(run, ev.content);
        } else {
          await finalizeRun(run, { reason: 'complete', completionMarkdown: ev.content });
        }
        return;
      }
      case 'qa-verdict': {
        // Stopped: that verifier attempt runs again on resume.
        if (ev.role !== 'verifier' || !run.verifierActive || run.finalized || run.deferredFinalize || run.paused) return;
        const verdict = verifierVerdictFrom(ev.content, ev.verdict);
        run.verifierActive = false;
        const verifierBase = run.verifierBase ?? 0;
        run.lastVerifier = { verdict, content: ev.content, attempt: run.verifierRuns - verifierBase };
        saveRunState(run);
        const findings = stripVerdictLine(ev.content);
        patchStep(run, verifierStepId(run), {
          status: verdict === 'PASS' ? 'success' : 'error',
          detail: `VERDICT: ${verdict}${findings ? `\n\n${firstLines(findings, 14)}` : ''}`,
        });
        setSessionStatus(ev.sessionId, 'done');
        void killAgentSessions({ sessionId: ev.sessionId });
        if (verdict === 'PASS') {
          await finalizeRun(run, { reason: 'verifier-pass', completionMarkdown: run.lastCompletion });
          return;
        }
        const manager = findSession(run.managerSessionId);
        if (run.verifierRetriesUsed - verifierBase < run.maxVerifierRetries && manager?.session.isActive) {
          run.verifierRetriesUsed += 1;
          saveRunState(run);
          const cycleRetry = run.verifierRetriesUsed - verifierBase;
          const stepUp = await stepUpForRetry(run, cycleRetry);
          const message = buildVerifierFailMessage(ev.file || `${runDirRel(run.runId)}/qa.md`, cycleRetry, run.maxVerifierRetries, runCtx(run));
          await typeIntoAgent(run.managerSessionId, message);
          setSessionStatus(run.managerSessionId, 'running');
          patchStep(run, run.managerStepId, (s) => ({
            ...s,
            status: 'running',
            detail: `${s.detail}\n\n↳ verifier failed (attempt ${run.verifierRuns - verifierBase}); findings sent back to the manager for fix-up ${cycleRetry}/${run.maxVerifierRetries}.${stepUp ? ` ${stepUp}` : ''}`,
          }));
          return;
        }
        await finalizeRun(run, { reason: 'verifier-fail', completionMarkdown: run.lastCompletion });
        return;
      }
    }
  };

  /** Codex / Antigravity print their resumable conversation id when they exit: kept so a follow-up resumes the manager. */
  const captureResumeId = async (run: RunState, s: SpawnedSession): Promise<string | undefined> => {
    const base = baseCommandName(s.cmd);
    if (base !== 'codex' && base !== 'agy') return run.cliSessionId;
    await sleep(800); // let the bridge record the last output
    // Codex: the bridge finds its rollout log (works while it runs, and after a kill). Else the CLI's exit text.
    let id = base === 'codex' ? await fetchCliSessionId(s.ptySessionId) : null;
    if (!id) {
      const transcript = await fetchAgentTranscript(s.ptySessionId);
      id = parseCliResumeId(s.cmd, transcript?.transcriptTail || '');
    }
    if (id && run.cliSessionId !== id) {
      run.cliSessionId = id;
      saveRunState(run);
    }
    return run.cliSessionId;
  };

  const handleExit = async (ev: Extract<CliAgentEvent, { type: 'exit' }>) => {
    const session = findSession(ev.sessionId);
    if (!sessionMatchesEvent(session, ev)) return;
    if (!session.session.isActive && TERMINAL_STATUSES.has(session.status)) return;

    // A relaunch under the same pty id kills the previous process; make sure this exit isn't that old one.
    if (!TERMINAL_STATUSES.has(session.status)) {
      const rows = await fetchAgentSessionsStrict();
      const row = rows?.find((r) => r.id === ev.sessionId);
      if (row && row.isActive && (!row.spawnId || row.spawnId === session.spawnId)) return;
    }

    const wasTerminal = TERMINAL_STATUSES.has(session.status);
    const role = session.role;
    const exitStatus: AgentSessionStatus = wasTerminal
      ? session.status
      : role === 'manager'
        ? ev.code === 0 ? 'done' : 'failed'
        : 'failed';
    baseStatusRef.current.set(ev.sessionId, exitStatus);
    clearDeferredInput(ev.sessionId);
    promptToastSigRef.current.delete(ev.sessionId);
    depsRef.current.dismissToast(`cli-prompt-${ev.sessionId}`);
    patchSession(ev.sessionId, (s) =>
      s.spawnId !== session.spawnId
        ? s
        : {
            ...s,
            status: exitStatus,
            pendingPrompt: null,
            endedAt: new Date().toISOString(),
            session: { ...s.session, isActive: false, exitCode: ev.code },
          }
    );

    // Final usage reading once the CLI has flushed its log.
    setTimeout(() => {
      void fetchCliSessionUsage(ev.sessionId).then((u) => {
        if (u && session.spawnId) {
          const run = runForSession(session);
          noteSpawnUsage(session.spawnId, u, run);
          if (run) applyRunUsage(run);
        }
      });
    }, 1500);

    const run = runForSession(session);
    if (run && role === 'manager') void captureResumeId(run, session);
    if (run && role === 'manager' && run.question) clearQuestion(run, 'cancelled', '↳ The manager exited before you answered.');
    if (wasTerminal || !run || run.finalized || run.paused) return;

    // Signal files are polled once more at exit: give that last signal a moment to arrive (without holding up
    // this task's event queue), then decide what the exit means for the run.
    const verifierRunAtExit = run.verifierRuns;
    setTimeout(() => {
      void enqueue(rk(run), async () => {
        if (run.finalized || run.deferredFinalize || run.paused) return;
        if (role === 'worker') {
          const w = [...run.workers].reverse().find((x) => x.ptySessionId === ev.sessionId);
          if (w && (w.status === 'running' || w.status === 'queued')) {
            finishWorker(run, w, false, `Worker exited (code ${ev.code}) without writing its result file.`);
          }
        } else if (role === 'verifier') {
          if (run.verifierActive && run.verifierRuns === verifierRunAtExit) {
            run.verifierActive = false;
            run.verifierNote = `The verifier exited (code ${ev.code}) without writing qa.md`;
            saveRunState(run);
            patchStep(run, verifierStepId(run), { status: 'error', detail: run.verifierNote });
            await finalizeRun(run, { reason: 'verifier-error', completionMarkdown: run.lastCompletion });
          }
        } else {
          // A resume the CLI rejected at once: a new manager takes over (also while workers / verifier still run).
          if (await retryFailedResume(run, session, ev.code)) return;
          const workersOpen = currentRoundWorkers(run).some((w) => w.status === 'queued' || w.status === 'running');
          if (run.verifierActive || workersOpen) {
            // One-shot CLIs exit right after writing completion.md / delegate.json. The run finalizes when verifier
            // reports (verdict, verifier exit, or verifier FAIL with no manager to fix it) or when the workers finish.
            run.managerExitCode = ev.code;
            saveRunState(run);
            return;
          }
          await finalizeRun(run, { reason: 'exit', exitCode: ev.code, completionMarkdown: run.lastCompletion });
        }
      });
    }, 2500);
  };

  const handleEvent = (ev: CliAgentEvent) => {
    switch (ev.type) {
      case 'spawned': {
        const s = findSession(ev.sessionId);
        if (!sessionMatchesEvent(s, ev)) return;
        if (baseStatusRef.current.get(ev.sessionId) === 'starting') setSessionStatus(ev.sessionId, 'running');
        return;
      }
      case 'prompt': {
        const s = findSession(ev.sessionId);
        if (!sessionMatchesEvent(s, ev)) return;
        handlePrompt(ev.sessionId, ev.prompt);
        return;
      }
      case 'policy': {
        const s = findSession(ev.sessionId);
        // Every result (restart-required too) means the bridge now enforces this level for its prompts.
        if (!sessionMatchesEvent(s, ev)) return;
        patchSession(ev.sessionId, (x) => (x.permissionLevel === ev.permissionLevel ? x : { ...x, permissionLevel: ev.permissionLevel }));
        // A switch queued behind an open prompt reports its real outcome here, after the policy call returned.
        if (ev.deferred && ev.applied === 'restart-required' && s && sessionInProject(s, depsRef.current.projectId)) {
          depsRef.current.showToast({
            id: `cli-policy-restart-${ev.sessionId}`,
            type: 'warning',
            title: 'Restart needed for an agent',
            message: `${s.label} couldn't switch approval mode while running${ev.detail ? ` (${ev.detail})` : ''}. Restart the task to apply the new mode.`,
            duration: 10000,
          });
        }
        return;
      }
      case 'auto-approved':
        return;
      case 'signal':
        void enqueue(queueKeyForEvent(ev), () => handleSignal(ev));
        return;
      case 'exit':
        void enqueue(queueKeyForEvent(ev), () => handleExit(ev));
        return;
      case 'workspace-call':
        void handleWorkspaceCall(ev);
        return;
    }
  };

  /**
   * A manager called one of Ergo's workspace tools (an invoked skill needs them). Only the window that owns the run
   * answers: it claims the call (another window may have the run too), runs it on the open project, and replies.
   */
  const handleWorkspaceCall = async (ev: Extract<CliAgentEvent, { type: 'workspace-call' }>) => {
    const s = findSession(ev.sessionId);
    const run = s && sessionMatchesEvent(s, ev) ? runForSession(s) : runById(ev.runId);
    if (!run || !run.workspaceTools || run.finalized) return;
    if (!(await claimWorkspaceCall(ev.callId))) return;
    const d = depsRef.current;
    // Without a skill that needs the board, the tools are there only to check off this task's checklist.
    const denied = run.references?.skills.some((sk) => sk.usesWorkspaceTools) ? null : checklistOnlyError(run.taskKey, ev.tool, ev.args || {});
    const result = denied
      ? { success: false, error: denied }
      : run.projectId && run.projectId !== d.projectId
        ? { success: false, error: `Ergo has another project open. Open "${run.taskTitle}"'s project in Ergo and try again.` }
        : await executeWorkspaceToolAction(ev.tool, ev.args || {}).catch((err: unknown) => ({
            success: false,
            error: err instanceof Error ? err.message : String(err),
          }));
    await sendWorkspaceCallResult(ev.callId, { success: result.success, ...('data' in result ? { data: result.data } : {}), ...(result.error ? { error: result.error } : {}) });
    noteOnStep(run, run.managerStepId, `↳ Workspace: ${ev.tool}${result.success ? '' : ` failed — ${result.error || 'unknown error'}`}`);
  };

  // ── Restore / resync ──
  const restoreAgentSessions = async (taskIds: Iterable<string | number>): Promise<void> => {
    const wanted = new Set(Array.from(taskIds, (id) => String(id)));
    await loadRunStates(); // the runs saved on this machine, before any is matched to a live session
    const rows = await fetchAgentSessionsStrict();
    if (!rows) return;
    const projectId = depsRef.current.projectId;
    const projectKey = agentProjectKey(projectId);
    const taskKeyOf = (r: BridgeAgentSessionInfo) => String(r.taskId ?? parseAgentSessionId(String(r.id)).taskKey);
    const relevant = rows.filter((r) => {
      const parsed = parseAgentSessionId(String(r.id));
      if (!wanted.has(taskKeyOf(r)) && !wanted.has(parsed.taskKey)) return false;
      // Task ids are only unique per project: skip agents of runs started from another project.
      if (parsed.projectKey) return parsed.projectKey === projectKey;
      const owner = r.runId ? loadRunState(r.runId)?.projectId : undefined; // legacy unscoped key
      return !owner || owner === projectId;
    });
    for (const r of relevant) sessionProjectRef.current.set(r.id, projectId);

    /**
     * A run restored without its saved state (other browser / origin, cleared storage): rebuild its workers from
     * the live worker agents so replaying the manager's delegate.json doesn't launch (and supersede) them again.
     */
    const adoptLiveWorkers = (state: PersistedRunState, managerRow: BridgeAgentSessionInfo) => {
      const delegates = (managerRow.signals || []).filter((sg) => sg.signal === 'delegate').sort((a, b) => a.mtime - b.mtime);
      const latest = delegates[delegates.length - 1];
      if (!latest) return;
      // Worker agents of this run the bridge still lists (live, or ended with their signals kept).
      const workerRows = relevant.filter((r) => r.role === 'worker' && r.runId === state.runId && r.pieceId);
      const completedAfter = (managerRow.signals || []).some((sg) => sg.signal === 'complete' && sg.mtime > latest.mtime);
      // No worker agents and no later completion: we can't tell whether the round ever ran, so let the replay start it.
      if (workerRows.length === 0 && !completedAfter) return;
      state.handledSignals.push(...delegates.map((sg) => `${managerRow.id}:delegate:${sg.mtime}`));
      if (workerRows.length === 0) return;
      let pieces: CliWorkerPiece[] = [];
      try {
        pieces = parseDelegatePlan(latest.content, state.maxWorkers);
      } catch {}
      state.delegateRounds = 1;
      // The manager wrote completion.md after delegating, so it already had the workers' results: replaying the
      // worker-done signals must not type the "workers finished" hand-off into it a second time.
      state.workersReported = completedAfter;
      const ids = Array.from(new Set([...pieces.map((p) => p.id), ...workerRows.map((r) => r.pieceId!)]));
      for (const id of ids) {
        const rows = workerRows.filter((r) => r.pieceId === id);
        const row = rows.find((r) => r.isActive) || rows[0];
        const piece = pieces.find((p) => p.id === id) || { id, title: row?.label || `Worker ${id}`, instructions: '', files: [] };
        state.workers.push({
          piece,
          round: 1,
          // A listed agent is settled by the replayed worker-done signal, else by reconcile (ended without a result).
          // A piece with no agent at all already ended; its outcome is unknown, so the manager is told to check it.
          status: row ? 'running' : 'failed',
          stepId: `step-worker-${state.taskKey}-${state.runId}-r1-${id}`,
          ptySessionId: row ? row.id : runSessionId(state, 'worker', id),
        });
      }
    };

    const defaultLabel = (role: AgentSessionRole, pieceId?: string) =>
      role === 'worker' ? `Worker ${pieceId || ''}`.trim() : role === 'verifier' ? 'Verifier' : 'Manager';

    const restored: SpawnedSession[] = relevant.map((r) => {
      const role: AgentSessionRole = r.role || 'manager';
      const known = findSession(r.id);
      const status: AgentSessionStatus = !r.isActive
        ? r.exitCode === 0 ? 'done' : 'failed'
        : known && known.spawnId === r.spawnId && !TERMINAL_STATUSES.has(known.status)
          ? baseStatusRef.current.get(r.id) || known.status
          : 'running';
      if (!baseStatusRef.current.has(r.id) || !known || known.spawnId !== r.spawnId) baseStatusRef.current.set(r.id, status);
      return {
        session: {
          taskId: known?.session.taskId ?? r.taskId,
          taskTitle: known?.session.taskTitle || `Task ${r.taskId}`,
          isActive: Boolean(r.isActive),
          ...(r.isActive ? {} : { exitCode: typeof r.exitCode === 'number' ? r.exitCode : 0 }),
          spawnedAt: new Date(r.startedAt || Date.now()).toISOString(),
        },
        role,
        label: r.label || known?.label || defaultLabel(role, r.pieceId),
        ...(r.pieceId ? { pieceId: r.pieceId } : {}),
        ptySessionId: r.id,
        runId: r.runId || '',
        status: r.prompt && r.isActive ? 'awaiting_approval' : status,
        ...(r.permissionLevel ? { permissionLevel: r.permissionLevel } : {}),
        pendingPrompt: r.prompt ?? null,
        cwd: r.cwd || known?.cwd || '',
        cmd: r.cmd || known?.cmd || '',
        args: r.args || known?.args || [],
        ...(r.spawnId ? { spawnId: r.spawnId } : known?.spawnId ? { spawnId: known.spawnId } : {}),
        // Follow-live orders finished agents by when they ended.
        ...(!r.isActive && (r.endedAt || known?.endedAt) ? { endedAt: r.endedAt || known?.endedAt } : {}),
      };
    });

    // Sessions still starting on this client may not be listed yet — keep them as they are.
    const keepAsIs = new Set(sessionsRef.current.filter((s) => s.status === 'starting').map((s) => s.ptySessionId));
    const merged = restored.filter((s) => !keepAsIs.has(s.ptySessionId));
    commitSessions((prev) => {
      const ids = new Set(merged.map((s) => s.ptySessionId));
      return [...prev.filter((p) => !ids.has(p.ptySessionId)), ...merged];
    });

    // Rebuild run state for the restored runs.
    const tasks = depsRef.current.tasksRef.current;
    const briefs = depsRef.current.briefsRef.current;
    const managerRows = relevant.filter((r) => (r.role || 'manager') === 'manager' && r.runId);
    for (const row of managerRows) {
      const taskKey = taskKeyOf(row);
      const existing = runsRef.current.get(runKeyOf(projectId, taskKey));
      if (existing && existing.runId === row.runId) continue;
      if (existing && !existing.finalized) continue; // a newer launch on this client wins
      const persisted = loadRunState(row.runId!);
      const task =
        tasks.find((t) => String(t.id) === taskKey) ||
        ({ id: row.taskId, title: `Task ${row.taskId}`, category: 'AI Workspace', status: 'in_progress', isDone: false, subtasks: [] } as TaskItem);
      const brief = briefs[findBriefIndex(briefs, task.id, task.title)];
      const opts = depsRef.current.agentPipelineOptionsRef.current;
      if (persisted && persisted.projectId && persisted.projectId !== depsRef.current.projectId) continue;
      const state: PersistedRunState = persisted || {
        runId: row.runId!,
        projectId,
        taskKey,
        taskId: task.id,
        taskTitle: task.title,
        taskSnapshot: task,
        ...(brief ? { briefSnapshot: brief } : {}),
        startedAt: new Date(row.startedAt || Date.now()).toISOString(),
        cliName: row.cmd || 'CLI agent',
        managerSessionId: row.id,
        managerStepId: `step-manager-${taskKey}-${row.runId}`,
        verifierEnabled: (brief?.verification !== false) && (brief?.overviewDocument?.requiresVerifier ?? true),
        maxWorkers: Math.max(1, Math.min(8, Math.floor(opts.maxConcurrentAgents || 1))),
        maxVerifierRetries: Math.max(0, Math.floor(opts.maxVerifierRetries || 0)),
        workers: [],
        delegateRounds: 0,
        workersReported: false,
        verifierRuns: 0,
        verifierRetriesUsed: 0,
        verifierActive: false,
        handledSignals: [],
        finalized: loggedCycleOf(brief, row.runId!) >= 0,
      };
      if (!persisted && !state.finalized) adoptLiveWorkers(state, row);
      if (briefLoggedRun(brief, state)) state.finalized = true;
      runsRef.current.set(runKeyOf(projectId, taskKey), withDonePromise(state));
    }

    // Replay signals (deduped, oldest first) through the normal handlers.
    const signalEvents: Array<Extract<CliAgentEvent, { type: 'signal' }>> = [];
    for (const r of relevant) {
      for (const sig of r.signals || []) {
        signalEvents.push({
          type: 'signal',
          signal: sig.signal,
          file: sig.file,
          content: sig.content,
          mtime: sig.mtime,
          ...(sig.verdict ? { verdict: sig.verdict } : {}),
          sessionId: r.id,
          taskId: taskKeyOf(r),
          role: r.role || 'manager',
          ...(r.runId ? { runId: r.runId } : {}),
          at: new Date(sig.mtime).toISOString(),
        });
      }
    }
    signalEvents.sort((a, b) => a.mtime - b.mtime);
    const touchedTasks = new Set<string>();
    for (const ev of signalEvents) {
      touchedTasks.add(String(ev.taskId));
      void enqueue(queueKeyForEvent(ev), () => handleSignal(ev));
    }

    // Surface prompts that are already on screen; deliver hand-offs held back by a prompt that has since cleared.
    for (const r of relevant) {
      if (r.prompt && r.isActive) handlePrompt(r.id, r.prompt);
      else if (r.isActive) flushDeferredInput(r.id);
    }

    // Reconcile agents that ended while Ergo wasn't listening.
    const activeIds = new Set(relevant.filter((r) => r.isActive).map((r) => r.id));
    const reconcile = async (run: RunState) => {
      const managerNow = findSession(run.managerSessionId);
      if (run.paused && !run.finalized) {
        // Stopped by the user: its agents were killed on purpose and show as stopped, not failed.
        for (const s of sessionsRef.current) {
          if (s.runId === run.runId && !s.session.isActive && s.status === 'failed') setSessionStatus(s.ptySessionId, 'cancelled');
        }
        return;
      }
      if (run.finalized) {
        if (managerNow?.session.isActive && managerNow.runId === run.runId && !TERMINAL_STATUSES.has(managerNow.status)) {
          setSessionStatus(run.managerSessionId, 'done');
        }
        return;
      }
      for (const w of run.workers) {
        if (w.status === 'done' && findSession(w.ptySessionId)?.session.isActive) setSessionStatus(w.ptySessionId, 'done');
      }
      for (const w of run.workers) {
        if (w.status !== 'running') continue;
        const s = findSession(w.ptySessionId);
        if (s?.status === 'starting') continue;
        if (!activeIds.has(w.ptySessionId)) {
          finishWorker(run, w, false, 'Worker ended while Ergo was not connected, without reporting a result.');
        }
      }
      if (run.finalized) return;
      const verifierId = runSessionId(run, 'verifier');
      if (run.verifierActive && !activeIds.has(verifierId) && findSession(verifierId)?.status !== 'starting') {
        run.verifierActive = false;
        run.verifierNote = 'The verifier ended while Ergo was not connected, without a verdict';
        saveRunState(run);
        patchStep(run, verifierStepId(run), { status: 'error', detail: run.verifierNote });
        await finalizeRun(run, { reason: 'verifier-error', completionMarkdown: run.lastCompletion });
        return;
      }
      const manager = findSession(run.managerSessionId);
      const waitingOnAgents = run.verifierActive || currentRoundWorkers(run).some((w) => w.status === 'queued' || w.status === 'running');
      const managerGone = !activeIds.has(run.managerSessionId) && manager?.status !== 'starting';
      if (managerGone && !waitingOnAgents) {
        await finalizeRun(run, { reason: 'exit', exitCode: run.managerExitCode ?? manager?.session.exitCode ?? null, completionMarkdown: run.lastCompletion });
        return;
      }
      if (managerGone) {
        // Workers / verifier still running: the run finalizes when they report (see the manager exit handler).
        if (run.managerExitCode === undefined) {
          run.managerExitCode = manager?.session.exitCode ?? null;
          saveRunState(run);
        }
      } else if (manager?.status !== 'starting') {
        setSessionStatus(run.managerSessionId, waitingOnAgents ? 'waiting' : 'running');
        // Its question is still open (the card is gone after a reload): show it again.
        if (run.question) showQuestion(run);
      }
      // Project load marks every in-progress job cancelled; this run is still going, so its job is too.
      if (reviveRunJob(run)) depsRef.current.setExecutingTaskId((cur) => cur ?? run.taskId);
      launchQueuedWorkers(run);
      await reportWorkersToManager(run);
    };
    for (const run of runsRef.current.values()) {
      if (!wanted.has(run.taskKey) || run.projectId !== depsRef.current.projectId) continue;
      if (run.deferredFinalize && !run.finalized) {
        const deferred = run.deferredFinalize;
        void enqueue(rk(run), () => finalizeRun(run, deferred));
        continue;
      }
      void enqueue(rk(run), () => reconcile(run));
    }

    // Runs persisted on this device whose manager is gone (e.g. the bridge restarted): close them out.
    for (const state of listPersistedRuns()) {
      if (state.finalized || state.projectId !== depsRef.current.projectId) continue;
      if (!wanted.has(state.taskKey)) continue;
      if (state.paused) {
        // Stopped partway: stays open (unfinalized) so Resume can pick it up — unless a newer run replaced it.
        const current = runsRef.current.get(rk(state));
        if (!current) runsRef.current.set(rk(state), withDonePromise(state));
        else if (current.runId !== state.runId && (Date.parse(current.startedAt) || 0) >= (Date.parse(state.startedAt) || 0)) {
          saveRunState(withDonePromise({ ...state, finalized: true }));
        }
        continue;
      }
      if (activeIds.has(state.managerSessionId) && !state.deferredFinalize) continue;
      const current = runsRef.current.get(rk(state));
      if (current && current.runId !== state.runId) {
        // Superseded by a newer run: just mark it closed.
        saveRunState(withDonePromise({ ...state, finalized: true }));
        continue;
      }
      if (current) continue; // handled by reconcile above
      const briefIdx = findBriefIndex(briefs, state.taskId, state.taskTitle);
      if (briefIdx !== -1 && briefLoggedRun(briefs[briefIdx], state)) {
        saveRunState(withDonePromise({ ...state, finalized: true }));
        continue;
      }
      const run = withDonePromise(state);
      runsRef.current.set(rk(state), run);
      if (!state.deferredFinalize && relevant.some((r) => r.isActive && r.runId === state.runId)) {
        // The manager is gone but its workers / verifier still run: the run finalizes when they report.
        void enqueue(rk(run), () => reconcile(run));
        continue;
      }
      const finalOpts: FinalizeOptions = state.deferredFinalize || { reason: 'exit', exitCode: state.managerExitCode ?? null, completionMarkdown: run.lastCompletion };
      void enqueue(rk(run), () => finalizeRun(run, finalOpts));
    }
  };

  // ── Lifecycle: SSE subscription + pruning ──
  const handleEventRef = useRef(handleEvent);
  handleEventRef.current = handleEvent;
  const restoreRef = useRef(restoreAgentSessions);
  restoreRef.current = restoreAgentSessions;

  useEffect(() => {
    void loadRunStates().then(pruneRunStates);
    const unsubscribe = subscribeAgentEvents(
      (ev) => handleEventRef.current(ev),
      () => {
        // Events sent while disconnected are lost: resync every task of the open project.
        const d = depsRef.current;
        const ids = new Set<string>([
          ...d.tasksRef.current.map((t) => String(t.id)),
          ...d.briefsRef.current.map((b) => String(b.sourceTaskId ?? b.id ?? b.itemNumber)),
          ...Array.from(runsRef.current.values())
            .filter((run) => run.projectId === d.projectId)
            .map((run) => run.taskKey),
        ]);
        // Re-read the saved runs too: another browser may have started or finished one, or the first load ran
        // before the bridge was reachable.
        void loadRunStates(true).then(() => restoreRef.current(ids));
      }
    );
    return () => {
      unsubscribe();
      if (stepPersistTimerRef.current) clearTimeout(stepPersistTimerRef.current);
    };
  }, []);

  // ── Per-agent usage polling ──
  const applyRunUsageRef = useRef(applyRunUsage);
  applyRunUsageRef.current = applyRunUsage;
  const noteSpawnUsageRef = useRef(noteSpawnUsage);
  noteSpawnUsageRef.current = noteSpawnUsage;
  const activeSessionKey = terminalSessions
    .filter((s) => s.session.isActive && s.spawnId)
    .map((s) => `${s.ptySessionId}@${s.spawnId}`)
    .join('|');
  useEffect(() => {
    if (!activeSessionKey) return;
    let cancelled = false;
    const poll = async () => {
      const active = sessionsRef.current.filter((s) => s.session.isActive && s.spawnId);
      const touchedRuns = new Set<RunState>();
      for (const s of active) {
        const usage = await fetchCliSessionUsage(s.ptySessionId);
        if (cancelled) return;
        if (usage && s.spawnId) {
          const run = runForSession(s);
          noteSpawnUsageRef.current(s.spawnId, usage, run);
          if (run) touchedRuns.add(run);
        }
      }
      for (const run of touchedRuns) applyRunUsageRef.current(run);
    };
    void poll();
    const timer = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeSessionKey]);

  // ── Public API (stable identity; everything reads refs) ──
  const implRef = useRef({
    finalizeRun,
    spawnAgent,
    restoreAgentSessions,
    handlePrompt,
    launchQueuedWorkers,
    finishWorker,
    sendUserMessage,
    pauseRun,
    resumeRun,
    clearQuestion,
  });
  implRef.current = {
    finalizeRun,
    spawnAgent,
    restoreAgentSessions,
    handlePrompt,
    launchQueuedWorkers,
    finishWorker,
    sendUserMessage,
    pauseRun,
    resumeRun,
    clearQuestion,
  };

  /**
   * Kill every agent of one project's task — by session id, never by task id (other projects reuse task ids).
   * Also catches agents of the task this client doesn't track (e.g. launched from another tab).
   */
  const killTaskAgents = async (projectId: string, taskKey: string, known: SpawnedSession[]): Promise<void> => {
    const ids = new Set(known.map((s) => s.ptySessionId));
    await Promise.all(Array.from(ids, (id) => killAgentSessions({ sessionId: id })));
    const rows = await fetchAgentSessionsStrict();
    if (!rows) return;
    const projectKey = agentProjectKey(projectId);
    const untracked = rows.filter((r) => {
      if (!r.isActive || ids.has(r.id)) return false;
      const parsed = parseAgentSessionId(String(r.id));
      if (String(r.taskId ?? parsed.taskKey) !== taskKey) return false;
      if (parsed.projectKey) return parsed.projectKey === projectKey;
      // Legacy unscoped key: only when its run is known to belong to this project.
      return Boolean(r.runId) && loadRunState(r.runId!)?.projectId === projectId;
    });
    await Promise.all(untracked.map((r) => killAgentSessions({ sessionId: r.id })));
  };

  const dropDeferredInput = (ptySessionIds: Iterable<string>) => {
    for (const id of ptySessionIds) clearDeferredInput(id);
  };

  const api = useMemo<CliAgentRunsApi>(() => {
    const launchCliRun = async ({
      task,
      brief,
      launch,
      runId,
      preSteps,
      priorBriefStatus,
      relatedContext,
      relatedSources,
      projectRules,
      references,
      verifierEnabled,
      needsVerifier,
      maxWorkers,
      runPlanNote,
    }: LaunchCliRunParams): Promise<boolean> => {
      const d = depsRef.current;
      const projectId = d.projectId;
      const taskKey = String(task.id);
      const opts = d.agentPipelineOptionsRef.current;

      // Retire a previous run of this task (its sessions are replaced below).
      const previous = runsRef.current.get(runKeyOf(projectId, taskKey));
      if (previous?.question) implRef.current.clearQuestion(previous, 'cancelled', '↳ A new run started before you answered.');
      if (previous && !previous.finalized) {
        previous.finalized = true;
        saveRunState(previous);
        previous.resolveDone();
      }

      if (!warnedPermissionOverrideRef.current && hasUserPermissionOverride(launch.extraArgs || '', launch.cmd)) {
        warnedPermissionOverrideRef.current = true;
        d.showToast({
          type: 'warning',
          title: 'Approval mode overridden',
          message: `Your ${launch.cliName} extra arguments contain a permission flag, so Ergo's approval mode is not applied to its launch flags. Remove it from the AI profile to let the approval mode take effect.`,
          duration: 9000,
        });
      }

      const oldSessions = sessionsOfTask(projectId, taskKey);
      await killTaskAgents(projectId, taskKey, oldSessions);
      if (depsRef.current.projectId !== projectId) return false; // project switched meanwhile: don't launch into it
      const doomed = new Set(sessionsOfTask(projectId, taskKey).map((s) => s.ptySessionId));
      for (const id of doomed) {
        baseStatusRef.current.delete(id);
        promptToastSigRef.current.delete(id);
        d.dismissToast(`cli-prompt-${id}`);
      }
      dropDeferredInput(doomed);
      commitSessions((prev) => prev.filter((s) => !doomed.has(s.ptySessionId)));

      const taskNeedsVerifier = needsVerifier ?? (verifierEnabled !== undefined ? verifierEnabled : (brief?.overviewDocument?.requiresVerifier ?? true));
      const userVerifierSetting = brief?.verification !== false;
      const resolvedVerifierEnabled = verifierEnabled !== undefined ? verifierEnabled : (userVerifierSetting && taskNeedsVerifier);

      const managerSessionId = agentSessionId(agentProjectKey(projectId), task.id, 'manager');
      const managerStepId = `step-manager-${taskKey}-${runId}`;
      const run = withDonePromise({
        runId,
        projectId,
        taskKey,
        taskId: task.id,
        taskTitle: task.title,
        taskSnapshot: task,
        startedAt: new Date().toISOString(),
        cliName: launch.cliName || launch.cmd,
        managerSessionId,
        managerStepId,
        bibleFilePath: cliBiblePath(projectId, task.id, runId),
        needsVerifier: taskNeedsVerifier,
        verifierEnabled: resolvedVerifierEnabled,
        maxWorkers: Math.max(1, Math.min(8, Math.floor(maxWorkers ?? (opts.maxConcurrentAgents || 1)) || 1)),
        maxVerifierRetries: Math.max(0, Math.floor(opts.maxVerifierRetries || 0)),
        workers: [],
        delegateRounds: 0,
        workersReported: false,
        verifierRuns: 0,
        verifierRetriesUsed: 0,
        verifierActive: false,
        handledSignals: [],
        finalized: false,
        ...(relatedContext && relatedContext.trim() ? { relatedContext: relatedContext.trim() } : {}),
        ...(relatedSources && relatedSources.trim() ? { relatedSources: relatedSources.trim() } : {}),
        ...(projectRules && projectRules.trim() ? { projectRules: projectRules.trim() } : {}),
        ...(references ? { references } : {}),
        // Claude Code and Codex reach the ergo-memory server per agent (its URL names the session); Gemini and
        // Antigravity share one config entry, so they run skills without the workspace tools (and their checklist is
        // checked off when the run completes).
        ...((references?.skills.some((s) => s.usesWorkspaceTools) || hasOpenChecklist(task)) &&
        bridgeSupportsTaskReferences() &&
        /^(claude|codex)$/.test(baseCommandName(launch.cmd))
          ? { workspaceTools: true }
          : {}),
      });
      run.launch = launch;
      // Persisted (models only, no keys): a restored run or a follow-up reuses them instead of routing again.
      run.roles = launch.roles;
      run.retryRoles = launch.retryRoles;
      run.startEscalation = launch.startEscalation;
      runsRef.current.set(runKeyOf(projectId, taskKey), run);

      // If the AI determined verifier is needed and it is enabled, show the planned Verifier tab in Actions tabs:
      if (resolvedVerifierEnabled) {
        const verifierSessionId = runSessionId(run, 'verifier');
        const plannedVerifierSession: SpawnedSession = {
          session: {
            taskId: run.taskId,
            taskTitle: run.taskTitle,
            isActive: true,
            spawnedAt: new Date().toISOString(),
          },
          role: 'verifier',
          label: 'Verifier',
          ptySessionId: verifierSessionId,
          runId: run.runId,
          status: 'waiting',
          permissionLevel: depsRef.current.agentPipelineOptionsRef.current.permissionLevel,
          pendingPrompt: null,
          cwd: launch.cwd,
          cmd: launch.cmd,
          args: [],
          spawnId: `${run.runId}-verifier-planned`,
        };
        commitSessions((prev) => [...prev.filter((s) => s.ptySessionId !== verifierSessionId), plannedVerifierSession]);
      }

      // Fresh run: clear the previous run's completion log and mark the task in progress (latest state, not closures).
      const tasks = d.tasksRef.current;
      const nextTasks = tasks.map((t) =>
        String(t.id) === taskKey && t.status !== 'in_progress' ? { ...t, status: 'in_progress' as TaskStatus, isDone: false } : t
      );
      const briefs = d.briefsRef.current;
      const briefIdx = findBriefIndex(briefs, task.id, task.title);
      const baseBrief = briefIdx === -1 ? brief : briefs[briefIdx];
      const resetBrief: AgentContextItem = {
        ...(baseBrief || {
          id: `brief_${taskKey}`,
          addedAt: new Date().toISOString(),
          sourceTaskId: task.id,
          sourceLaneId: task.swimLaneId,
          title: task.title,
          overview: '',
          brief: '',
          buildAndVerification: '',
          built: '',
        }),
        status: 'in_progress',
        completion: '',
        validation: '',
        humanReview: '',
        followUps: '',
      } as AgentContextItem;
      const nextBriefs = briefIdx === -1 ? [...briefs, resetBrief] : briefs.map((b, i) => (i === briefIdx ? resetBrief : b));
      // Workers / verifier build their prompts from this when the run's project isn't the open one.
      run.briefSnapshot = resetBrief;
      saveRunState(run);

      const managerStep: ExecutionStep = {
        id: managerStepId,
        taskId: task.id,
        time: nowTime(),
        stage: 'execution',
        agentRole: 'manager',
        ptySessionId: managerSessionId,
        bibleFilePath: run.bibleFilePath,
        title: `Manager Agent (${launch.cliName || launch.cmd})`,
        detail: `Running \`${launch.cmd}\` in \`${launch.cwd}\`. ${
          run.maxWorkers >= 2 ? 'The manager works through the task and may delegate separable pieces to worker agents' : 'The manager works through the task itself'
        }${run.verifierEnabled ? '; a verifier checks the result before the completion log is written' : ''}.${
          runPlanNote && runPlanNote.trim() ? `\n${runPlanNote.trim()}` : ''
        }`,
        status: 'running',
      };
      updateSteps(run, () => [...preSteps, managerStep]);

      const job: RunningJobInfo = {
        id: `job_cli_${taskKey}_${Date.now()}`,
        taskId: task.id,
        taskTitle: task.title,
        type: 'cli',
        status: 'in_progress',
        startedAt: new Date().toISOString(),
        sessionId: managerSessionId,
        cmd: launch.cmd,
        cwd: launch.cwd,
      };
      updateJobs((jobs) => {
        const prev = jobs.find((j) => String(j.taskId) === taskKey);
        const kept = jobs.filter((j) => String(j.taskId) !== taskKey);
        return [...kept, { ...job, ...(prev?.laneId ? { laneId: prev.laneId, laneTitle: prev.laneTitle } : {}) }];
      });
      d.setExecutingTaskId(task.id);
      d.syncAndSaveProject(nextTasks, nextBriefs, true);

      // Bring the code index up to date, then let the small model scout the files.
      const scoutStepId = `step-scout-${taskKey}-${runId}`;
      const scoutAndIndex = (async () => {
        const indexed = await refreshCodeIndex(launch.cwd);
        if (!indexed || !launch.smallModel) return { indexed, scout: null };
        updateSteps(run, (steps) => {
          const at = steps.findIndex((st) => st.id === managerStepId);
          const step: ExecutionStep = {
            id: scoutStepId,
            taskId: task.id,
            time: nowTime(),
            stage: 'execution',
            agentRole: 'autocomplete',
            title: `File scout (${launch.smallModel?.model || 'small model'})`,
            detail: 'Finding the files this task needs, so the manager can start there.',
            status: 'running',
          };
          return at === -1 ? [...steps, step] : [...steps.slice(0, at), step, ...steps.slice(at)];
        });
        const scout = await runFileScout({ config: launch.smallModel, taskText: buildTaskContentText(task, resetBrief), cwd: launch.cwd });
        if (scout?.usage) usageBySpawnRef.current.set(`${run.runId}-scout`, scout.usage);
        patchStep(run, scoutStepId, (st) => ({
          ...st,
          status: scout ? 'success' : 'warning',
          detail: scout
            ? `Found ${scout.files.length} likely file${scout.files.length === 1 ? '' : 's'} in ${(scout.durationMs / 1000).toFixed(0)} s:\n${scout.files.map((f) => `- ${f}`).join('\n')}`
            : 'No file list (the scout failed or ran out of time); the manager searches the whole repository.',
          ...(scout?.usage ? { usage: scout.usage } : {}),
        }));
        return { indexed, scout };
      })();
      // Prior knowledge from memory reaches the manager through the working brief (the overview call folds it in);
      // the manager's own prompt carries no pre-fetched memory, only the memory tools.
      const { indexed: codeIndexed, scout } = await scoutAndIndex;
      run.codeSearch = codeIndexed;
      run.codeSearchPath = launch.cwd;
      if (scout) run.likelyFiles = scout.files;
      // Stopped or relaunched while the files were scouted: that path owns the task now (a stopped run resumes
      // from here: its manager has not started yet).
      if (run.finalized || run.paused || runsRef.current.get(runKeyOf(projectId, taskKey)) !== run) return false;
      const prompt = buildManagerCliPrompt(task, resetBrief, runCtx(run));
      run.managerPrompt = prompt;
      saveRunState(run);
      scheduleBibleWrite(run);
      const res = await implRef.current.spawnAgent(run, 'manager', { label: 'Manager', prompt });
      if (res.ok) {
        patchStep(run, managerStepId, (s) => ({ ...s, detail: `${s.detail}\nTask prompt dispatched; watching the manager live.` }));
        return true;
      }
      // Stopped (or relaunched) while the manager was starting: that path finalizes / owns the task now.
      if (res.cancelled) return false;

      // The manager never started.
      const failToast = () =>
        depsRef.current.showToast({
          type: 'error',
          title: 'Agent Failed to Start',
          message: `"${task.title}": ${res.error}`,
          duration: 8000,
        });
      if (depsRef.current.projectId !== projectId) {
        // Another project is open now: its tasks/briefs/jobs must not be touched. Close this run out (as an
        // exit without a record) when its project is loaded again.
        run.deferredFinalize = { reason: 'exit', exitCode: -1 };
        saveRunState(run);
        failToast();
        return false;
      }
      // Close the run without a completion log.
      run.finalized = true;
      saveRunState(run);
      patchStep(run, managerStepId, { status: 'error', detail: `Could not start ${launch.cliName || launch.cmd}: ${res.error}` });
      updateJobs((jobs) =>
        jobs.map((j) =>
          String(j.taskId) === taskKey && j.status === 'in_progress' ? { ...j, status: 'failed', completedAt: new Date().toISOString() } : j
        )
      );
      clearExecuting(task.id);
      // Put the task and its previous completion log back the way they were before this attempt.
      const latestTasks = depsRef.current.tasksRef.current.map((t) =>
        String(t.id) === taskKey ? { ...t, status: task.status, isDone: task.isDone } : t
      );
      const currentBriefs = depsRef.current.briefsRef.current;
      const rollbackIdx = findBriefIndex(currentBriefs, task.id, task.title);
      const latestBriefs =
        rollbackIdx === -1
          ? currentBriefs
          : currentBriefs.map((b, i) =>
              i === rollbackIdx
                ? {
                    ...b,
                    // App's overview merge may already have marked the brief in progress for this attempt, so prefer
                    // the status App captured before it; without one, the task's pre-launch status is the best guess.
                    status:
                      typeof priorBriefStatus === 'string'
                        ? priorBriefStatus
                        : !baseBrief || baseBrief.status === 'in_progress' || priorBriefStatus === null
                          ? task.status
                          : baseBrief.status,
                    completion: baseBrief?.completion ?? '',
                    validation: baseBrief?.validation ?? '',
                    humanReview: baseBrief?.humanReview ?? '',
                    followUps: baseBrief?.followUps ?? '',
                  }
                : b
            );
      depsRef.current.syncAndSaveProject(latestTasks, latestBriefs, true);
      failToast();
      run.resolveDone();
      return false;
    };

    const waitForCliRun = (taskId: string | number): Promise<void> => {
      const run = runsRef.current.get(runKeyOf(depsRef.current.projectId, taskId));
      return run && !run.finalized && !run.paused ? run.done : Promise.resolve();
    };

    const stopCliRun = (taskId: string | number): StopCliRunResult => {
      const taskKey = String(taskId);
      const projectId = depsRef.current.projectId;
      const run = runsRef.current.get(runKeyOf(projectId, taskKey));
      const sessions = sessionsOfTask(projectId, taskKey);
      void killTaskAgents(projectId, taskKey, sessions);
      dropDeferredInput(sessions.map((s) => s.ptySessionId));
      for (const s of sessions) {
        depsRef.current.dismissToast(`cli-prompt-${s.ptySessionId}`);
        promptToastSigRef.current.delete(s.ptySessionId);
        if (!TERMINAL_STATUSES.has(s.status) && s.session.isActive) {
          baseStatusRef.current.set(s.ptySessionId, 'cancelled');
          patchSession(s.ptySessionId, (x) => ({ ...x, status: 'cancelled', pendingPrompt: null }));
        }
      }
      if (!run) return 'none';
      if (run.finalized) return 'finalized';
      if (run.paused) return 'stopping';
      if (run.deferredFinalize) {
        // Already ending (its log is being written): let it finish.
        const deferred = run.deferredFinalize;
        void enqueue(rk(run), () => implRef.current.finalizeRun(run, deferred));
        return 'stopping';
      }
      // Paused right away, so nothing queued behind this (signals, exits) advances or finalizes the run.
      run.paused = { at: new Date().toISOString() };
      saveRunState(run);
      void enqueue(rk(run), () => implRef.current.pauseRun(run));
      return 'stopping';
    };

    const isCliRunPaused = (taskId: string | number) => {
      const run = runsRef.current.get(runKeyOf(depsRef.current.projectId, taskId));
      return Boolean(run && run.paused && !run.finalized);
    };

    const resumeCliRun = async (taskId: string | number, message = ''): Promise<TaskMessageResult> => {
      const run = runsRef.current.get(runKeyOf(depsRef.current.projectId, taskId));
      if (!run || !run.paused || run.finalized) return { ok: false, error: 'This task has no stopped run to resume.' };
      let result: TaskMessageResult = { ok: false, error: 'The run could not be resumed.' };
      await enqueue(rk(run), async () => {
        result = await implRef.current.resumeRun(run, message);
      });
      return result;
    };

    const killAgentSession = (ptySessionId: string) => {
      const s = sessionsRef.current.find((x) => x.ptySessionId === ptySessionId);
      if (!s) {
        void killAgentSessions({ sessionId: ptySessionId });
        return;
      }
      if (s.role === 'manager') {
        stopCliRun(s.session.taskId);
        return;
      }
      void killAgentSessions({ sessionId: ptySessionId });
      depsRef.current.dismissToast(`cli-prompt-${ptySessionId}`);
      clearDeferredInput(ptySessionId);
      if (!TERMINAL_STATUSES.has(s.status)) {
        baseStatusRef.current.set(ptySessionId, 'cancelled');
        patchSession(ptySessionId, (x) => ({ ...x, status: 'cancelled', pendingPrompt: null }));
      }
      const run = runForSession(s);
      if (!run || run.finalized || run.paused) return;
      void enqueue(rk(run), async () => {
        if (s.role === 'worker') {
          const w = [...run.workers].reverse().find((x) => x.ptySessionId === ptySessionId);
          if (w && (w.status === 'running' || w.status === 'queued')) {
            implRef.current.finishWorker(run, w, false, 'Stopped by user before reporting a result.');
            patchStep(run, w.stepId, { status: 'cancelled' });
          }
        } else if (s.role === 'verifier') {
          if (run.verifierActive) {
            run.verifierActive = false;
            run.verifierNote = 'The verifier was stopped by the user before reaching a verdict';
            saveRunState(run);
            patchStep(run, verifierStepId(run), { status: 'cancelled', detail: run.verifierNote });
            await implRef.current.finalizeRun(run, { reason: 'verifier-error', completionMarkdown: run.lastCompletion });
          } else {
            run.verifierEnabled = false;
            saveRunState(run);
            commitSessions((prev) => prev.filter((x) => x.ptySessionId !== ptySessionId));
          }
        }
      });
    };

    const applyPermissionLevel = async (level: PermissionLevel): Promise<void> => {
      const live = sessionsRef.current.filter((s) => s.session.isActive);
      if (live.length === 0) return;
      // Target this app's agent sessions by id (never every PTY on the bridge: login / onboarding terminals too).
      const results = (
        await Promise.all(live.map((s) => applyPermissionPolicy(level, { sessionId: s.ptySessionId })))
      ).flat();
      const restartNeeded: string[] = [];
      for (const r of results) {
        const s = sessionsRef.current.find((x) => x.ptySessionId === r.sessionId);
        if (!s) continue;
        // The bridge enforces the new level for prompts whatever the result (restart-required only means the
        // CLI's own mode is unchanged), so the session's level follows it in every case.
        patchSession(r.sessionId, (x) => (x.permissionLevel === level ? x : { ...x, permissionLevel: level }));
        if (r.applied === 'restart-required') {
          const inOpenProject = sessionInProject(s, depsRef.current.projectId);
          const title =
            (inOpenProject && depsRef.current.tasksRef.current.find((t) => String(t.id) === String(s.session.taskId))?.title) ||
            s.session.taskTitle;
          restartNeeded.push(`${s.label} (${truncate(title, 40)})`);
        }
      }
      if (restartNeeded.length > 0) {
        depsRef.current.showToast({
          id: 'cli-policy-restart',
          type: 'warning',
          title: 'Restart needed for some agents',
          message: `This CLI can't switch approval mode while running: ${restartNeeded.join(', ')}. Restart the task to apply the new mode to them.`,
          duration: 10000,
        });
      }
    };

    const hasActiveCliRun = (taskId: string | number) => {
      const run = runsRef.current.get(runKeyOf(depsRef.current.projectId, taskId));
      return Boolean(run && !run.finalized && !run.paused);
    };

    const forgetTask = (taskId: string | number) => {
      const taskKey = String(taskId);
      const projectId = depsRef.current.projectId;
      const run = runsRef.current.get(runKeyOf(projectId, taskKey));
      if (run) {
        if (run.question) {
          depsRef.current.dismissToast(questionToastId(run));
          depsRef.current.cancelHumanInput(run.taskId);
          run.question = undefined;
        }
        if (!run.finalized) {
          run.finalized = true;
          saveRunState(run);
          run.resolveDone();
        }
        runsRef.current.delete(runKeyOf(projectId, taskKey));
      }
      const doomed = sessionsOfTask(projectId, taskKey);
      if (doomed.length === 0 && !run) return;
      void killTaskAgents(projectId, taskKey, doomed);
      const doomedIds = new Set(doomed.map((s) => s.ptySessionId));
      for (const id of doomedIds) {
        baseStatusRef.current.delete(id);
        promptToastSigRef.current.delete(id);
        depsRef.current.dismissToast(`cli-prompt-${id}`);
      }
      dropDeferredInput(doomedIds);
      commitSessions((prev) => prev.filter((s) => !doomedIds.has(s.ptySessionId)));
    };

    const supersedeFinishedRun = (taskId: string | number) => {
      const key = runKeyOf(depsRef.current.projectId, String(taskId));
      const run = runsRef.current.get(key);
      // Only finished / finalizing / stopped runs: an active run's agents are still working and must be stopped first.
      if (run && run.paused && !run.finalized) {
        // Started over instead of resumed: the stopped run is closed (still without a completion log).
        run.finalized = true;
        saveRunState(run);
      }
      if (run && (run.finalized || run.finalizePending)) runsRef.current.delete(key);
    };

    const updateRunVerification = (taskId: string | number, enabled: boolean) => {
      const taskKey = String(taskId);
      const projectId = depsRef.current.projectId;
      const run = runsRef.current.get(runKeyOf(projectId, taskKey));
      if (!run || run.finalized) return;

      // Cannot change if verifier has already started running or finished
      if (run.verifierActive || run.verifierRuns > 0) return;

      const taskNeedsVerifier = run.needsVerifier ?? true;
      const newVerifierEnabled = enabled && taskNeedsVerifier;
      run.verifierEnabled = newVerifierEnabled;
      saveRunState(run);

      const verifierSessionId = runSessionId(run, 'verifier');
      if (!newVerifierEnabled) {
        commitSessions((prev) => prev.filter((s) => !(s.runId === run.runId && s.role === 'verifier' && s.status === 'waiting')));
      } else {
        commitSessions((prev) => {
          if (prev.some((s) => s.ptySessionId === verifierSessionId)) return prev;
          const launch = run.launch;
          const plannedVerifierSession: SpawnedSession = {
            session: {
              taskId: run.taskId,
              taskTitle: run.taskTitle,
              isActive: true,
              spawnedAt: new Date().toISOString(),
            },
            role: 'verifier',
            label: 'Verifier',
            ptySessionId: verifierSessionId,
            runId: run.runId,
            status: 'waiting',
            permissionLevel: depsRef.current.agentPipelineOptionsRef.current.permissionLevel,
            pendingPrompt: null,
            cwd: launch?.cwd || '',
            cmd: launch?.cmd || '',
            args: [],
            spawnId: `${run.runId}-verifier-planned`,
          };
          return [...prev, plannedVerifierSession];
        });
      }
    };

    return {
      forgetTask,
      supersedeFinishedRun,
      launchCliRun,
      waitForCliRun,
      stopCliRun,
      isCliRunPaused,
      resumeCliRun,
      killAgentSession,
      applyPermissionLevel,
      restoreAgentSessions: (taskIds) => implRef.current.restoreAgentSessions(taskIds),
      hasActiveCliRun,
      sendUserMessage: (taskId, text, opts) => implRef.current.sendUserMessage(taskId, text, opts),
      updateRunVerification,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Views only see the open project's agents: task ids repeat across projects, and another project's run keeps
  // going (and is tracked here) while it is not open.
  const projectId = deps.projectId;
  const projectSessions = useMemo(
    () => terminalSessions.filter((s) => sessionInProject(s, projectId)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [terminalSessions, projectId]
  );

  return { terminalSessions: projectSessions, terminalSessionsRef: sessionsRef, api };
}
