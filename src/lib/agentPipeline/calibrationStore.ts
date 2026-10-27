/**
 * Calibration store — loads and saves Auto mode's learning table (calibration.ts) and feeds it:
 *  - recordRunCalibration: called once a run ends (and again when a follow-up continues the same run).
 *  - steering messages (steeringLog.ts): the few that judge the model are classified and attached to their run.
 *  - "how did this task do?" (RunSurveyCard): recording a run decides whether to ask; answerRunSurvey saves the answer.
 * The table lives in <storage>/config/model-calibration.json; saves are debounced and serialized.
 */
import type { AIProviderConfig, EffortLevel, RunOutcome, TaskRating, TokenUsage } from '../../types';
import { storageManager } from '../storageManager';
import { callAiEngine, parseJsonLoose } from '../llmClient';
import { timeoutSignal } from '../localModel/client';
import { tinyCloudCallConfig } from './modelRouter';
import { onSteeringMessage, type SteeringMessage } from './steeringLog';
import {
  buildSummary,
  emptyCalibration,
  parseCalibration,
  ratingGroup,
  surveyReason,
  upsertRun,
  type CalibratedRole,
  type CalibrationFile,
  type CalibrationRun,
  type CalibrationStage,
  type SteeringSignal,
  type SurveyReason,
  type SurveyVerdict,
} from './calibration';

let current: CalibrationFile | null = null;
let loading: Promise<CalibrationFile> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saving: Promise<void> = Promise.resolve();
const listeners = new Set<(file: CalibrationFile) => void>();

/** The table (loaded once, then kept in memory). Never throws: an unreadable file is an empty table. */
export function getCalibration(): Promise<CalibrationFile> {
  if (current) return Promise.resolve(current);
  if (!loading) {
    loading = storageManager
      .loadModelCalibration()
      .then((raw) => parseCalibration(raw))
      .catch(() => emptyCalibration())
      .then((file) => {
        // A record made while loading wins over the file it was merged into.
        current = current ?? file;
        return current;
      });
  }
  return loading;
}

/** The table if it is already in memory (routing never waits on disk for it). */
export function peekCalibration(): CalibrationFile | null {
  return current;
}

export function subscribeCalibration(listener: (file: CalibrationFile) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function commit(next: CalibrationFile) {
  current = next;
  for (const l of listeners) l(next);
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const snapshot = current!;
    saving = saving.then(async () => {
      const ok = await storageManager.saveModelCalibration({ ...snapshot, summary: buildSummary(snapshot) }).catch(() => false);
      if (!ok) console.warn('[Ergo calibration] Could not save config/model-calibration.json');
    });
  }, 1000);
}

async function update(fn: (file: CalibrationFile) => CalibrationFile) {
  const file = await getCalibration();
  commit(fn(current ?? file));
}

/** Clear everything Ergo has learned (Settings → Model data). */
export async function resetCalibration(): Promise<void> {
  await getCalibration();
  commit(emptyCalibration());
}

export interface RunCalibrationInput {
  runId: string;
  taskId: string;
  projectId?: string;
  family?: string;
  rating?: TaskRating;
  outcome: RunOutcome;
  start?: Partial<Record<CalibratedRole, CalibrationStage | { model?: string; effort?: EffortLevel; tier?: 1 | 2 | 3; calibrated?: -1 | 1 }>>;
  end?: Partial<Record<CalibratedRole, CalibrationStage | { model?: string; effort?: EffortLevel; tier?: 1 | 2 | 3; calibrated?: -1 | 1 }>>;
  usage?: TokenUsage;
}

function cleanStages(stages: RunCalibrationInput['start']): Partial<Record<CalibratedRole, CalibrationStage>> | undefined {
  if (!stages) return undefined;
  const out: Partial<Record<CalibratedRole, CalibrationStage>> = {};
  for (const role of ['manager', 'worker', 'verifier'] as const) {
    const s = stages[role];
    if (s?.model && s.effort) {
      out[role] = { model: s.model, effort: s.effort, ...(s.tier ? { tier: s.tier } : {}), ...(s.calibrated ? { calibrated: s.calibrated } : {}) };
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/** Record how a run ended (both run paths call this; a follow-up on the same run updates its entry). Never throws. */
export function recordRunCalibration(input: RunCalibrationInput): void {
  // Runs whose models aren't known (Ollama, a CLI default) teach nothing about model choice.
  const start = cleanStages(input.start);
  if (!start || !input.family) return;
  const end = cleanStages(input.end);
  const patch: Partial<CalibrationRun> & { runId: string } = {
    runId: input.runId,
    taskId: input.taskId,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    family: input.family,
    ...ratingGroup(input.rating),
    outcome: input.outcome,
    start,
    ...(end ? { end } : {}),
    ...(input.usage && input.usage.inputTokens > 0
      ? { usage: { inputTokens: input.usage.inputTokens, outputTokens: input.usage.outputTokens, cachedInputTokens: input.usage.cachedInputTokens } }
      : {}),
  };
  void update((file) => withSurvey(upsertRun(file, patch), patch.runId)).catch((err) => console.warn('[Ergo calibration] record failed:', err));
}

// ─── "How did this task do?" ─────────────────────────────────────────────────

/** Decide (again, after a follow-up) whether the task card should ask about this run. An answer or a close stays. */
function withSurvey(file: CalibrationFile, runId: string): CalibrationFile {
  const run = file.runs.find((r) => r.runId === runId);
  if (!run || run.verdict || run.survey?.dismissed) return file;
  const reason = surveyReason(file, run);
  if ((reason ?? null) === (run.survey?.reason ?? null)) return file;
  const next: CalibrationRun = { ...run, survey: reason ? { reason } : undefined };
  return { ...file, runs: file.runs.map((r) => (r === run ? next : r)) };
}

/** The open question for a run, if the task card should show one. */
export function pendingSurvey(file: CalibrationFile | null, runId: string | undefined): SurveyReason | null {
  if (!file || !runId) return null;
  const run = file.runs.find((r) => r.runId === runId);
  return run?.survey && !run.survey.dismissed && !run.verdict ? run.survey.reason : null;
}

/** Save the user's good / bad answer for a run (it replaces the automatic verdict). */
export function answerRunSurvey(runId: string, value: SurveyVerdict): void {
  void update((file) => ({
    ...file,
    updatedAt: new Date().toISOString(),
    runs: file.runs.map((r) => (r.runId === runId ? { ...r, verdict: { value, at: new Date().toISOString() } } : r)),
  }));
}

/** The user closed the question without answering: don't ask about this run again. */
export function dismissRunSurvey(runId: string): void {
  void update((file) => ({
    ...file,
    runs: file.runs.map((r) => (r.runId === runId && r.survey ? { ...r, survey: { ...r.survey, dismissed: true } } : r)),
  }));
}

// ─── Steering messages ───────────────────────────────────────────────────────

/**
 * Cheap first pass: only messages with wording about quality or model choice are worth a model call. Most steering
 * notes ("also update the README") never get one.
 */
const CUE =
  /\b(wrong|incorrect|broken|doesn'?t work|not work|didn'?t work|try again|redo|start over|again|worse|bad|terrible|garbage|useless|not what i|that'?s not|mess|stupid|dumb|smarter|stronger|better model|bigger model|weaker|cheaper|smaller model|lower model|higher model|overkill|too expensive|model|opus|sonnet|haiku|fable|gpt|gemini|grok|downgrade|upgrade)\b/i;

const STRONG_WEAK = /\b(use|switch to|try) (a )?(stronger|smarter|better|bigger|higher)\b|\b(upgrade|switch up)\b/i;
const STRONG_OVERKILL = /\b(use|switch to|try) (a )?(cheaper|smaller|lower|weaker|lighter)\b|\boverkill\b|\bdowngrade\b|\btoo expensive\b/i;

/** Rule-based verdict, used when the tiny model can't be reached. */
export function heuristicSteeringSignal(text: string): SteeringSignal | null {
  if (STRONG_OVERKILL.test(text)) return 'too_strong';
  if (STRONG_WEAK.test(text)) return 'too_weak';
  if (/\b(that'?s wrong|this is wrong|doesn'?t work|didn'?t work|not what i (asked|wanted)|try again|redo it|start over)\b/i.test(text)) return 'too_weak';
  return null;
}

const CLASSIFY_SYSTEM = `You read one message a user sent to an AI coding agent while it worked on their task, and decide whether it says anything about how capable the AI model was.
- "too_weak": the user is unhappy with the quality of the work or asks for a stronger model (e.g. "this is wrong, try again", "that's not what I asked for", "use a smarter model").
- "too_strong": the user says the model is more than needed or asks for a cheaper one (e.g. "switch to a cheaper model", "this is overkill").
- "none": anything else — ordinary instructions, extra requirements, clarifications, questions, approvals (e.g. "also update the README", "use the existing helper", "looks good").
Reply with JSON: {"signal": "too_weak" | "too_strong" | "none"}`;

let steeringConfig: (() => AIProviderConfig | null | undefined) | null = null;

export async function classifySteeringMessage(text: string, aiConfig: AIProviderConfig | null | undefined): Promise<SteeringSignal | null> {
  const trimmed = text.trim();
  if (!trimmed || !CUE.test(trimmed)) return null;
  const fallback = heuristicSteeringSignal(trimmed);
  const config = tinyCloudCallConfig(aiConfig);
  if (!config) return fallback;
  const { signal, cancel } = timeoutSignal(8_000);
  try {
    const raw = await callAiEngine(`Message: ${trimmed.slice(0, 600)}`, CLASSIFY_SYSTEM, config, 'autocomplete', 'json', signal);
    const verdict = parseJsonLoose<{ signal?: string }>(raw)?.signal;
    if (verdict === 'too_weak' || verdict === 'too_strong') return verdict;
    if (verdict === 'none') return null;
    return fallback;
  } catch {
    return fallback;
  } finally {
    cancel();
  }
}

function roleOf(message: SteeringMessage): CalibratedRole | null {
  return message.role === 'manager' || message.role === 'worker' || message.role === 'verifier' ? message.role : null;
}

/**
 * Start listening to prompt-box messages (App calls this once). `getAiConfig` gives the active profile for the tiny
 * model call. Returns an unsubscribe function.
 */
export function startSteeringCalibration(getAiConfig: () => AIProviderConfig | null | undefined): () => void {
  steeringConfig = getAiConfig;
  return onSteeringMessage((message) => {
    const role = roleOf(message);
    if (!role) return;
    void classifySteeringMessage(message.text, steeringConfig?.()).then((signal) => {
      if (!signal) return;
      console.log(`[Ergo calibration] Message on run ${message.runId} reads as "${signal}": ${message.text.slice(0, 80)}`);
      void update((file) =>
        upsertRun(file, {
          runId: message.runId,
          taskId: message.taskId,
          signals: [{ role, signal, text: message.text.slice(0, 160), at: message.at }],
        })
      );
    });
  });
}
