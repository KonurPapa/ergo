import { getPref, setPref } from './userPrefs';
import type { TaskItem } from '../types';

/**
 * Review, per project: 'manual' (the default) leaves every check-off to the user — a finished run marks its task
 * "needs review" in the document instead of checking it off; 'auto' lets the agent check off the task and its
 * checklist when the run finishes.
 */
export type ReviewMode = 'manual' | 'auto';

const key = (projectId: string) => `review_mode:${projectId}`;

export function getReviewMode(projectId: string | null | undefined): ReviewMode {
  return projectId && getPref(key(projectId)) === 'auto' ? 'auto' : 'manual';
}

export function setReviewMode(projectId: string, mode: ReviewMode): void {
  setPref(key(projectId), mode);
}

/**
 * A finished run's task update under the project's review mode. Manual: the task and its checklist keep the done
 * state the user gave them (everything else the run recorded — usage, files, review notes — still applies).
 */
export function applyReviewMode(projectId: string | null | undefined, before: TaskItem, after: TaskItem): TaskItem {
  if (getReviewMode(projectId) === 'auto') return after;
  const prevDone = new Map(before.subtasks.map((s) => [s.text.trim().toLowerCase(), s.isDone] as const));
  return {
    ...after,
    isDone: before.isDone,
    status: before.isDone ? 'done' : after.status === 'done' ? 'in_progress' : after.status,
    subtasks: after.subtasks.map((s) => {
      // A review note the run added starts unchecked either way.
      const was = prevDone.get(s.text.trim().toLowerCase());
      return was === undefined ? s : { ...s, isDone: was };
    }),
  };
}
