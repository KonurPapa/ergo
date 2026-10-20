/**
 * Escalation — when a run's work fails, the next attempt climbs one rung (autoRouter.ts stagePlan: the next model
 * tier, or more effort at the top tier). Applies to the manager and workers, who do the work; QA keeps its plan.
 *
 *  - QA retry within a run: attempt n + 1 runs n rungs above where the run started. In-app pipeline: manager and
 *    workers. CLI runs: the workers only (the live manager keeps its model; Claude Code's /model would also change
 *    the user's default model for every new session).
 *  - Rerun of a task whose last run failed, QA-failed or was stopped: starts one rung above that run (at most
 *    MAX_RERUN_ESCALATION). A run that passed or completed resets it.
 */
import type { AgentContextItem, AgentRole, EffortLevel, RunOutcome, RunOutcomeRecord, TaskRating } from '../../types';
import type { RoutingDecision } from './modelRouter';

export const MAX_RERUN_ESCALATION = 2;

const FAILED_OUTCOMES = new Set<RunOutcome>(['qa_failed', 'failed', 'stopped']);

export function isFailedOutcome(outcome: RunOutcome | undefined): boolean {
  return Boolean(outcome && FAILED_OUTCOMES.has(outcome));
}

/** Rungs a new run of this task starts at. */
export function rerunEscalation(brief: Pick<AgentContextItem, 'lastRunOutcome'> | undefined): number {
  const last = brief?.lastRunOutcome;
  if (!last || !isFailedOutcome(last.outcome)) return 0;
  return Math.min(MAX_RERUN_ESCALATION, Math.max(0, last.escalation || 0) + 1);
}

/** The per-role escalation for `steps` rungs: the manager and workers climb, QA doesn't. */
export function workEscalation(steps: number): Partial<Record<AgentRole, number>> {
  return steps > 0 ? { manager: steps, worker: steps } : {};
}

/** "Stepped up 1 rung: the last run was stopped." — for the routing step, or '' when not escalated. */
export function describeRerunEscalation(brief: Pick<AgentContextItem, 'lastRunOutcome'> | undefined): string {
  const steps = rerunEscalation(brief);
  if (!steps) return '';
  const why: Record<RunOutcome, string> = {
    qa_failed: 'QA failed on the last run',
    failed: 'the last run failed',
    stopped: 'the last run was stopped',
    passed: '',
    completed: '',
    unverified: '',
  };
  return `Manager and workers start ${steps} rung${steps === 1 ? '' : 's'} up: ${why[brief!.lastRunOutcome!.outcome]}.`;
}

export function buildRunOutcomeRecord(params: {
  runId: string;
  outcome: RunOutcome;
  escalation: number;
  qaRetries?: number;
  rating?: TaskRating;
  /** The models the work actually ran on (the last routing of each role). */
  decisions?: RoutingDecision[];
  models?: RunOutcomeRecord['models'];
  /** The routing the run started with, when it differs (QA retries stepped up). */
  startDecisions?: RoutingDecision[];
  startModels?: RunOutcomeRecord['startModels'];
  family?: string;
}): RunOutcomeRecord {
  const fromDecisions = (decisions: RoutingDecision[] | undefined, base: RunOutcomeRecord['models']) => {
    const out: NonNullable<RunOutcomeRecord['models']> = { ...(base || {}) };
    for (const d of decisions || []) {
      if (d.role === 'manager' || d.role === 'worker' || d.role === 'hardener') {
        out[d.role] = {
          ...(d.model ? { model: d.model } : {}),
          effort: d.effort as EffortLevel,
          ...(d.tier ? { tier: d.tier } : {}),
          ...(d.calibrated ? { calibrated: d.calibrated } : {}),
        };
      }
    }
    return out;
  };
  const models = fromDecisions(params.decisions, params.models);
  const startModels = params.startDecisions || params.startModels ? fromDecisions(params.startDecisions, params.startModels) : undefined;
  return {
    runId: params.runId,
    at: new Date().toISOString(),
    outcome: params.outcome,
    escalation: Math.max(0, params.escalation),
    ...(params.qaRetries ? { qaRetries: params.qaRetries } : {}),
    ...(params.rating ? { rating: params.rating } : {}),
    ...(Object.keys(models).length ? { models } : {}),
    ...(startModels && Object.keys(startModels).length ? { startModels } : {}),
    ...(params.family ? { family: params.family } : {}),
  };
}
