import { type AgentContextItem, type ExecutionStep, type RunningJobsDoc } from '../types';

export const RUNNING_JOBS_FILENAME = 'RUNNING_JOBS.json';

/**
 * Returns the project relative path to RUNNING_JOBS.json
 */
export function getRunningJobsPath(folderPath: string): string {
  const clean = folderPath.replace(/\/+$/, '');
  return `${clean}/${RUNNING_JOBS_FILENAME}`;
}

/**
 * Creates a fresh RUNNING_JOBS.json document structure for a project workspace.
 */
export function createDefaultRunningJobsDoc(
  projectId: string,
  initialTasks: AgentContextItem[] = []
): RunningJobsDoc {
  return {
    version: 1,
    projectId,
    updatedAt: new Date().toISOString(),
    tasks: initialTasks,
    runningJobs: [],
    queuedTaskIds: [],
    taskExecutionSteps: {},
  };
}

/**
 * Safely parses raw RUNNING_JOBS.json content from disk.
 */
export function parseRunningJobsDoc(raw: string, fallbackProjectId: string): RunningJobsDoc {
  if (!raw || !raw.trim()) {
    return createDefaultRunningJobsDoc(fallbackProjectId);
  }

  try {
    const parsed = JSON.parse(raw);
    return {
      version: parsed.version || 1,
      projectId: parsed.projectId || fallbackProjectId,
      updatedAt: parsed.updatedAt || new Date().toISOString(),
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      runningJobs: Array.isArray(parsed.runningJobs) ? parsed.runningJobs : [],
      queuedTaskIds: Array.isArray(parsed.queuedTaskIds) ? parsed.queuedTaskIds : [],
      taskExecutionSteps: parsed.taskExecutionSteps && typeof parsed.taskExecutionSteps === 'object'
        ? (parsed.taskExecutionSteps as Record<string, ExecutionStep[]>)
        : {},
    };
  } catch (err) {
    console.warn(`[RunningJobs] Failed to parse ${RUNNING_JOBS_FILENAME}:`, err);
    return createDefaultRunningJobsDoc(fallbackProjectId);
  }
}

/**
 * Formats a RunningJobsDoc for pretty-printed disk serialization.
 */
export function serializeRunningJobsDoc(doc: RunningJobsDoc): string {
  return JSON.stringify(
    {
      ...doc,
      updatedAt: new Date().toISOString(),
    },
    null,
    2
  );
}
