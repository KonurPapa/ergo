/**
 * Model calibration — Auto mode learning from the user's own runs (docs/AUTO_MODE.md, "Learning from your own runs").
 *
 * A small table of recent runs, kept in <storage>/config/model-calibration.json next to the agent skills so the user
 * can read it. Each run records, per stage (manager / workers / verifier): the task group (coding or not, difficulty), the
 * model + effort it started on and ended on (Verifier retries step up), how the run ended, and the user's messages that
 * judged the model ("that's wrong, try again", "use a cheaper model"). Plain counts, no vector search: the picker's
 * question is exact ("how often did Sonnet at Medium pass coding tasks of difficulty 3?").
 *
 * What counts:
 *  - passed / completed → success for the models that did the work. Passed only after stepping up → the starting
 *    models failed and the stepped-up ones succeeded.
 *  - verifier_failed / failed → failure. stopped / unverified, and reruns → nothing.
 *  - A message saying the model wasn't good enough → failure; saying it was more than needed → evidence for one rung
 *    cheaper.
 *
 * How the picker uses it (calibrationAdjustment): at most one rung per stage, never below the safety floors (those
 * live in autoRouter.stagePlan). Up when the planned setting often failed on tasks like this (≥ 3 runs, success
 * estimate < 70%) or when the next rung up is cheaper per successful result. Down only on a long clean record for
 * the cheaper rung (about seven successes in a row; see DOWN_MIN_*) that is also cheaper per success. Older
 * results fade (half weight after 45 days); results from a model that has since been replaced at that tier count half.
 *
 * Trying cheaper (PROBE_*): when the planned setting has a strong record on tasks like this and the cheaper rung has
 * little data, about one run in four starts the manager or workers one rung cheaper, and asks the user afterwards.
 *
 * "How did this task do?" (surveyReason): after an Auto run that passed or finished, the task card asks for a
 * good / bad answer when Ergo can't judge the models well on its own: Verifier reached no verdict, a stage's setting has
 * fewer than three results on tasks like this, or the run tried a cheaper rung that has few answers yet. An answer
 * overrides the automatic verdict and counts double (CONFIRMED_WEIGHT): the user saw the result, verifier only checked it.
 */
import type { EffortLevel, RunOutcome, TaskRating } from '../../types';

export type CalibratedRole = 'manager' | 'worker' | 'verifier';
export const CALIBRATED_ROLES: readonly CalibratedRole[] = ['manager', 'worker', 'verifier'];

export interface CalibrationStage {
  model: string;
  effort: EffortLevel;
  /** 1 light · 2 standard · 3 top, when Auto picked it. */
  tier?: 1 | 2 | 3;
  /** Calibration moved this stage's start a rung (−1 cheaper, +1 stronger). */
  calibrated?: -1 | 1;
}

export type SteeringSignal = 'too_weak' | 'too_strong';

/** Why Ergo asked "how did this task do?": Verifier gave no verdict, too few results, or a cheaper rung was tried. */
export type SurveyReason = 'no_verdict' | 'thin' | 'cheaper';
export type SurveyVerdict = 'good' | 'bad';

export interface CalibrationRun {
  runId: string;
  taskId: string;
  projectId?: string;
  /** Model family the run used (anthropic, cli-claude, openai, gemini, grok, cli-agy …). */
  family?: string;
  coding?: boolean;
  /** max(complexity, reasoning), 1–5. */
  difficulty?: number;
  outcome?: RunOutcome;
  /** Models the run started on, per stage. */
  start?: Partial<Record<CalibratedRole, CalibrationStage>>;
  /** Models the run ended on, when verifier retries stepped up. */
  end?: Partial<Record<CalibratedRole, CalibrationStage>>;
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens: number };
  signals?: Array<{ role: CalibratedRole; signal: SteeringSignal; text: string; at: string }>;
  /** Set when the task card asks "how did this task do?" (dismissed: the user closed it unanswered). */
  survey?: { reason: SurveyReason; dismissed?: boolean };
  /** The user's answer: replaces the automatic verdict for this run. */
  verdict?: { value: SurveyVerdict; at: string };
  at: string;
}

export interface CalibrationSummaryRow {
  group: string;
  stage: CalibratedRole;
  model: string;
  effort: EffortLevel;
  runs: number;
  passed: number;
  failed: number;
  lastUsed: string;
}

export interface CalibrationFile {
  version: 1;
  about: string;
  updatedAt: string;
  /** Human-readable totals per group / stage / model, rebuilt on every save (the picker reads `runs`). */
  summary: CalibrationSummaryRow[];
  runs: CalibrationRun[];
}

export const CALIBRATION_FILE_PATH = 'config/model-calibration.json';
const MAX_RUNS = 400;
const HALF_LIFE_DAYS = 45;
const ABOUT =
  "Ergo's Auto mode learning table: how runs went per task group, stage and model. Edit or delete this file to " +
  'reset what Ergo has learned (Settings → Model data has a reset button). See docs/AUTO_MODE.md.';

export function emptyCalibration(): CalibrationFile {
  return { version: 1, about: ABOUT, updatedAt: new Date().toISOString(), summary: [], runs: [] };
}

// ─── Samples ─────────────────────────────────────────────────────────────────

interface Sample {
  run: CalibrationRun;
  role: CalibratedRole;
  stage: CalibrationStage;
  success: number;
  failure: number;
  /** The user said this setting was more than needed: evidence that one rung cheaper would do. */
  overkill: number;
  /** The user answered "how did this task do?" for this run. */
  confirmed?: boolean;
}

/** A user's good / bad answer weighs as much as two automatic results. */
const CONFIRMED_WEIGHT = 2;

const sameStage = (a?: CalibrationStage, b?: CalibrationStage) => Boolean(a && b && a.model === b.model && a.effort === b.effort);

/** What one run teaches about each stage's model (see the header for the rules). */
export function samplesFromRun(run: CalibrationRun): Sample[] {
  const out: Sample[] = [];
  const push = (role: CalibratedRole, stage: CalibrationStage | undefined, success: number, failure: number, overkill = 0, confirmed = false) => {
    if (stage?.model) out.push({ run, role, stage, success, failure, overkill, ...(confirmed ? { confirmed } : {}) });
  };
  const outcome = run.outcome;
  const verdict = run.verdict?.value;
  for (const role of CALIBRATED_ROLES) {
    const start = run.start?.[role];
    const end = run.end?.[role] ?? start;
    const steppedUp = !sameStage(start, end);
    if (verdict) {
      // The user judged the end result: it holds for the models that produced it (and for verifier, which approved it).
      // Starting models that verifier retries stepped up from still failed.
      if (role !== 'verifier' && steppedUp) push(role, start, 0, 1);
      if (verdict === 'good') push(role, end, CONFIRMED_WEIGHT, 0, 0, true);
      else if (role !== 'verifier' || outcome === 'passed') push(role, end, 0, CONFIRMED_WEIGHT, 0, true);
      continue;
    }
    if (outcome === 'passed' || outcome === 'completed') {
      if (role !== 'verifier' && steppedUp) {
        push(role, start, 0, 1);
        push(role, end, 1, 0);
      } else {
        push(role, start, 1, 0);
      }
    } else if (outcome === 'verifier_failed' || outcome === 'failed') {
      if (role === 'verifier') continue; // Verifier caught the problem (or never ran): no verdict on its model
      push(role, end, 0, 1);
      if (steppedUp) push(role, start, 0, 1);
    }
  }
  for (const s of run.signals || []) {
    const stage = run.end?.[s.role] ?? run.start?.[s.role];
    if (s.signal === 'too_weak') push(s.role, stage, 0, 1);
    else push(s.role, stage, 0, 0, 1);
  }
  return out;
}

// ─── Statistics ──────────────────────────────────────────────────────────────

const EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface RungStats {
  /** Weighted counts (decay, difficulty distance, model replaced, effort distance). */
  success: number;
  failure: number;
  overkill: number;
  /** Unweighted counts of the exact setting, for explanations. */
  rawPassed: number;
  rawRuns: number;
  /** User answers about the exact model and effort (any nearby difficulty). */
  confirmed: number;
}

export interface RungQuery {
  family: string;
  coding: boolean;
  difficulty: number;
  role: CalibratedRole;
  tier: 1 | 2 | 3;
  effort: EffortLevel;
  /** The model at this tier now: results from an older model at the same tier count half. */
  model: string;
  now?: number;
  /** Leave this run out (deciding whether to ask about it). */
  excludeRunId?: string;
}

/** Weighted results of one rung (tier + effort) for tasks like this. */
export function rungStats(file: CalibrationFile, q: RungQuery): RungStats {
  const now = q.now ?? Date.now();
  const stats: RungStats = { success: 0, failure: 0, overkill: 0, rawPassed: 0, rawRuns: 0, confirmed: 0 };
  for (const run of file.runs) {
    if (run.runId === q.excludeRunId) continue;
    if (run.family !== q.family || run.coding !== q.coding || typeof run.difficulty !== 'number') continue;
    const dDist = Math.abs(run.difficulty - q.difficulty);
    if (dDist > 1) continue;
    for (const s of samplesFromRun(run)) {
      if (s.role !== q.role) continue;
      const sameModel = s.stage.model === q.model;
      if (!sameModel && s.stage.tier !== q.tier) continue;
      const eDist = Math.abs(EFFORTS.indexOf(s.stage.effort) - EFFORTS.indexOf(q.effort));
      if (eDist > 1) continue;
      const ageDays = Math.max(0, (now - Date.parse(run.at)) / 86_400_000);
      const w = Math.pow(0.5, ageDays / HALF_LIFE_DAYS) * (dDist === 0 ? 1 : 0.5) * (sameModel ? 1 : 0.5) * (eDist === 0 ? 1 : 0.5);
      stats.success += w * s.success;
      stats.failure += w * s.failure;
      stats.overkill += w * s.overkill;
      if (sameModel && eDist === 0 && dDist === 0 && s.success + s.failure > 0) {
        stats.rawRuns += 1;
        stats.rawPassed += s.success > 0 ? 1 : 0;
      }
      if (sameModel && eDist === 0 && s.confirmed) stats.confirmed += 1;
    }
  }
  return stats;
}

/** Success estimate with one imagined success and one failure (keeps a couple of runs from deciding alone). */
export function successEstimate(s: Pick<RungStats, 'success' | 'failure'>): number {
  return (s.success + 1) / (s.success + s.failure + 2);
}

/** Conservative lower bound on the success rate (Wilson score; z = 1.645 is a one-sided 95% / two-sided 90% bound). */
export function successLowerBound(s: Pick<RungStats, 'success' | 'failure'>, z = 1.645): number {
  const n = s.success + s.failure;
  if (n <= 0) return 0;
  const p = s.success / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (centre - margin) / denom);
}

/** Share of input tokens served from the prompt cache in this family's recent runs (null without data). */
export function measuredCacheShare(file: CalibrationFile, family: string): number | null {
  let input = 0;
  let cached = 0;
  for (const run of file.runs.slice(-60)) {
    if (run.family !== family || !run.usage) continue;
    input += run.usage.inputTokens;
    cached += run.usage.cachedInputTokens;
  }
  return input >= 50_000 ? Math.max(0, Math.min(0.98, cached / input)) : null;
}

// ─── Decision ────────────────────────────────────────────────────────────────

export interface RungOption {
  tier: 1 | 2 | 3;
  effort: EffortLevel;
  model: string;
  /** Blended price per million tokens (cache-aware), for cost per successful result. */
  price: number;
}

export interface CalibrationAdjustment {
  steps: -1 | 0 | 1;
  /** e.g. "Your history: sonnet at Medium passed 3 of 6 coding tasks like this, so starting one step up." */
  note?: string;
  /** A step down to find out whether the cheaper rung does (PROBE_*), not one the record already supports. */
  probe?: boolean;
}

const EFFORT_WORDS: Record<EffortLevel, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra High', max: 'Max' };

/** Step up once the planned setting has at least this many (weighted) results and an estimate below UP_BELOW. */
const MIN_RUNS_UP = 3;
const UP_BELOW = 0.7;
/**
 * Step down only on a long, clean record for the cheaper setting: 7 successes in a row clear the conservative bound
 * (6 of 6 and 7 of 8 don't; 12 of 13 does).
 */
const MIN_RUNS_DOWN = 5;
const DOWN_MIN_ESTIMATE = 0.85;
const DOWN_MIN_LOWER_BOUND = 0.7;
/**
 * Trying cheaper: the planned setting's record must clear the same conservative bound as a step down (about seven
 * clean results, or four "good" answers), the cheaper rung must have fewer results than a step down needs and not a
 * poor record, and only about one such run in PROBE_RATE tries it.
 */
const PROBE_RATE = 0.25;
const PROBE_MIN_DOWN_ESTIMATE = 0.5;

export function calibrationAdjustment(params: {
  file: CalibrationFile;
  family: string;
  coding: boolean;
  difficulty: number;
  role: CalibratedRole;
  planned: RungOption;
  up: RungOption | null;
  down: RungOption | null;
  /** Allow a try one rung cheaper (manager and workers; one stage per run). */
  allowProbe?: boolean;
  /** For tests; Math.random otherwise. */
  random?: () => number;
}): CalibrationAdjustment {
  const { file, family, coding, difficulty, role, planned, up, down } = params;
  if (file.runs.length === 0) return { steps: 0 };
  const query = (r: RungOption): RungQuery => ({ family, coding, difficulty, role, tier: r.tier, effort: r.effort, model: r.model });
  const plannedStats = rungStats(file, query(planned));
  const plannedN = plannedStats.success + plannedStats.failure;
  const pPlanned = successEstimate(plannedStats);
  const perSuccess = (r: RungOption, p: number) => r.price / Math.max(0.05, p);
  const what = `${coding ? 'coding' : 'non-coding'} tasks like this`;
  const history = `${planned.model} at ${EFFORT_WORDS[planned.effort]} passed ${plannedStats.rawPassed} of ${plannedStats.rawRuns} ${what}`;

  if (up && !(up.model === planned.model && up.effort === planned.effort) && plannedN >= MIN_RUNS_UP - 0.01) {
    const upStats = rungStats(file, query(up));
    const pUp = upStats.success + upStats.failure >= MIN_RUNS_UP - 0.01 ? successEstimate(upStats) : Math.max(pPlanned, 0.85);
    if (pPlanned < UP_BELOW) {
      return { steps: 1, note: `Your history: ${history}, so starting one step up (${up.model} at ${EFFORT_WORDS[up.effort]}).` };
    }
    if (perSuccess(up, pUp) < perSuccess(planned, pPlanned)) {
      return {
        steps: 1,
        note: `Your history: ${history}; counting retries, ${up.model} at ${EFFORT_WORDS[up.effort]} is cheaper per good result, so starting there.`,
      };
    }
  }

  if (down && !(down.model === planned.model && down.effort === planned.effort)) {
    const downStats = rungStats(file, query(down));
    // The user saying the planned setting was more than needed counts as a success for the cheaper one.
    const evidence = { success: downStats.success + plannedStats.overkill, failure: downStats.failure };
    const n = evidence.success + evidence.failure;
    const pDown = successEstimate(evidence);
    if (
      n >= MIN_RUNS_DOWN - 0.01 &&
      pDown >= DOWN_MIN_ESTIMATE &&
      successLowerBound(evidence) >= DOWN_MIN_LOWER_BOUND &&
      perSuccess(down, pDown) < perSuccess(planned, pPlanned)
    ) {
      return {
        steps: -1,
        note: `Your history: ${down.model} at ${EFFORT_WORDS[down.effort]} has a strong record on ${what}, so starting one step cheaper.`,
      };
    }
    if (
      params.allowProbe &&
      role !== 'verifier' &&
      down.price < planned.price &&
      n < MIN_RUNS_DOWN - 0.01 &&
      pDown >= PROBE_MIN_DOWN_ESTIMATE &&
      successLowerBound(plannedStats) >= DOWN_MIN_LOWER_BOUND &&
      (params.random ?? Math.random)() < PROBE_RATE
    ) {
      return {
        steps: -1,
        probe: true,
        note:
          `Trying one step cheaper: ${planned.model} at ${EFFORT_WORDS[planned.effort]} has a strong record on ${what}, so this run ` +
          `checks whether ${down.model} at ${EFFORT_WORDS[down.effort]} will do. Verifier still checks the work.`,
      };
    }
  }
  return { steps: 0 };
}

// ─── "How did this task do?" ─────────────────────────────────────────────────

/** Fewer results than this on a stage's setting: Ergo can't tell yet how it does on tasks like this. */
const SURVEY_THIN_RUNS = MIN_RUNS_UP;
/** A cheaper rung Ergo started on keeps asking until it has this many answers. */
const SURVEY_CHEAPER_ANSWERS = 3;

/**
 * Whether to ask the user how this run went, and why (null: don't ask). Auto runs only (a stage with a tier), that
 * passed, finished or got no verifier verdict, that the user hasn't already judged in a message or an answer.
 */
export function surveyReason(file: CalibrationFile, run: CalibrationRun, now = Date.now()): SurveyReason | null {
  if (run.verdict || run.signals?.length) return null;
  if (run.outcome !== 'passed' && run.outcome !== 'completed' && run.outcome !== 'unverified') return null;
  if (!run.family || typeof run.difficulty !== 'number') return null;
  const stages = (['manager', 'worker'] as const)
    .map((role) => ({ role, start: run.start?.[role], stage: run.end?.[role] ?? run.start?.[role] }))
    .filter((s): s is { role: 'manager' | 'worker'; start: CalibrationStage | undefined; stage: CalibrationStage & { tier: 1 | 2 | 3 } } =>
      Boolean(s.stage?.model && s.stage.tier)
    );
  if (stages.length === 0) return null;
  if (run.outcome === 'unverified') return 'no_verdict';
  let thin = false;
  for (const { role, start, stage } of stages) {
    const stats = rungStats(file, {
      family: run.family,
      coding: Boolean(run.coding),
      difficulty: run.difficulty,
      role,
      tier: stage.tier,
      effort: stage.effort,
      model: stage.model,
      now,
      excludeRunId: run.runId,
    });
    if ((start?.calibrated ?? stage.calibrated) === -1 && stats.confirmed < SURVEY_CHEAPER_ANSWERS) return 'cheaper';
    if (stats.success + stats.failure < SURVEY_THIN_RUNS - 0.01) thin = true;
  }
  return thin ? 'thin' : null;
}

// ─── Recording ───────────────────────────────────────────────────────────────

export function ratingGroup(rating: TaskRating | undefined): { coding?: boolean; difficulty?: number } {
  if (!rating) return {};
  return { coding: rating.kind === 'coding', difficulty: Math.max(rating.complexity, rating.reasoning) };
}

/** Insert or merge a run (a follow-up continues the same run id: its latest outcome and models win, signals add up). */
export function upsertRun(file: CalibrationFile, patch: Partial<CalibrationRun> & { runId: string }): CalibrationFile {
  const runs = [...file.runs];
  const i = runs.findIndex((r) => r.runId === patch.runId);
  if (i === -1) {
    runs.push({ taskId: '', at: new Date().toISOString(), ...patch });
  } else {
    const prev = runs[i];
    runs[i] = {
      ...prev,
      ...patch,
      start: prev.start && Object.keys(prev.start).length ? prev.start : patch.start,
      signals: [...(prev.signals || []), ...(patch.signals || [])],
      at: patch.at || new Date().toISOString(),
    };
  }
  return { ...file, runs: runs.slice(-MAX_RUNS), updatedAt: new Date().toISOString() };
}

/** The human-readable totals written alongside the runs. */
export function buildSummary(file: CalibrationFile): CalibrationSummaryRow[] {
  const rows = new Map<string, CalibrationSummaryRow>();
  for (const run of file.runs) {
    if (!run.family || typeof run.difficulty !== 'number') continue;
    const group = `${run.family} · ${run.coding ? 'coding' : 'non-coding'} · difficulty ${run.difficulty}`;
    for (const s of samplesFromRun(run)) {
      if (s.success + s.failure === 0) continue;
      const key = `${group}|${s.role}|${s.stage.model}|${s.stage.effort}`;
      const row = rows.get(key) || { group, stage: s.role, model: s.stage.model, effort: s.stage.effort, runs: 0, passed: 0, failed: 0, lastUsed: run.at };
      row.runs += 1;
      if (s.success > 0) row.passed += 1;
      else row.failed += 1;
      if (run.at > row.lastUsed) row.lastUsed = run.at;
      rows.set(key, row);
    }
  }
  return [...rows.values()].sort((a, b) => a.group.localeCompare(b.group) || a.stage.localeCompare(b.stage) || b.runs - a.runs);
}

/** Parse a file read from disk; anything malformed becomes an empty table. */
export function parseCalibration(raw: unknown): CalibrationFile {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as any).runs)) return emptyCalibration();
  const runs = ((raw as any).runs as unknown[]).filter(
    (r): r is CalibrationRun => Boolean(r && typeof r === 'object' && typeof (r as any).runId === 'string' && typeof (r as any).at === 'string')
  );
  return { ...emptyCalibration(), updatedAt: String((raw as any).updatedAt || new Date().toISOString()), runs: runs.slice(-MAX_RUNS) };
}
