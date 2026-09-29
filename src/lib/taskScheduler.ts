export interface ScheduledJob {
  id: string;
  taskId: string | number;
  taskTitle: string;
  scheduledTime: string; // ISO 8601 string
  cronExpression?: string;
  createdAt: string;
  status: 'pending' | 'executing' | 'completed' | 'cancelled';
  lastRunAt?: string;
}

const STORAGE_KEY = 'ergo_scheduled_tasks';

export function getScheduledJobs(): ScheduledJob[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('[Scheduler] Failed to load scheduled jobs:', err);
    return [];
  }
}

export function saveScheduledJobs(jobs: ScheduledJob[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(jobs));
  } catch (err) {
    console.error('[Scheduler] Failed to save scheduled jobs:', err);
  }
}

export function addScheduledJob(job: Omit<ScheduledJob, 'id' | 'createdAt' | 'status'>): ScheduledJob {
  const jobs = getScheduledJobs();
  // Filter out any existing pending job for the exact same task
  const filtered = jobs.filter((j) => String(j.taskId) !== String(job.taskId) || j.status !== 'pending');
  const newJob: ScheduledJob = {
    ...job,
    id: `sched_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
    status: 'pending',
  };
  filtered.push(newJob);
  saveScheduledJobs(filtered);
  return newJob;
}

export function cancelScheduledJob(taskId: string | number): void {
  const jobs = getScheduledJobs();
  const updated = jobs.map((j) =>
    String(j.taskId) === String(taskId) && j.status === 'pending'
      ? { ...j, status: 'cancelled' as const }
      : j
  );
  saveScheduledJobs(updated);
}

export function markJobCompleted(taskId: string | number): void {
  const jobs = getScheduledJobs();
  const updated = jobs.map((j) =>
    String(j.taskId) === String(taskId) && (j.status === 'pending' || j.status === 'executing')
      ? { ...j, status: 'completed' as const, lastRunAt: new Date().toISOString() }
      : j
  );
  saveScheduledJobs(updated);
}

export function getJobForTask(taskId: string | number): ScheduledJob | undefined {
  const jobs = getScheduledJobs();
  return jobs.find((j) => String(j.taskId) === String(taskId) && j.status === 'pending');
}
