/**
 * The working brief of a CLI task run: the overview call's prompts (skill docs/skills/task-brief) and its offline
 * fallback. Pure (no I/O), so evaluation scripts can build the exact prompts the app sends.
 *
 * The brief is the manager's spec: the Summary model folds the selected related tasks and notes into it (goal, scope,
 * known context, constraints, done-when), so the manager works from one short synthesis instead of raw inputs.
 */
import type { TaskItem } from '../../types';
import { RELATED_INTERPRETATION_GUIDANCE } from '../memory/relatedTasks';
import { TASK_RATING_SCALES } from './autoRouter';

/** The overview is a working brief (not an older Done-State / In Context / Seams overview or the user's own text). */
export function isTaskBrief(overview: string | undefined): boolean {
  return /^\s*\*\*Goal:\*\*/.test(overview || '');
}

export interface TaskBriefPromptInput {
  task: Pick<TaskItem, 'id' | 'title' | 'category' | 'status' | 'isDone' | 'subtasks' | 'summaryNote'>;
  /** The task-brief skill (frontmatter stripped). */
  skill: string;
  project: { name?: string; folderPath?: string };
  /** Connected MCP server names: listed by name only, the brief names one only when the task needs it. */
  serverNames: string[];
  /** An earlier overview, the user's own notes, or a freeform brief's source text. */
  currentOverview?: string;
  /** Stage-1 candidates (formatRelatedCandidatesForPrompt); empty when there are none. */
  relatedCandidatesPrompt?: string;
  /** This project's memory relevant to the task (formatPriorKnowledge): earlier runs' notes, completed tasks. */
  priorKnowledge?: string;
}

export function buildTaskBriefPrompts(input: TaskBriefPromptInput): { system: string; user: string } {
  const { task, project } = input;
  const related = (input.relatedCandidatesPrompt || '').trim();
  const servers = input.serverNames.filter(Boolean);

  const system = [
    input.skill.trim(),
    `PROJECT: "${project.name || 'Workspace'}" (${project.folderPath || './'})`,
    `CONNECTED SERVICES: ${servers.length > 0 ? servers.join(', ') : 'none'}`,
    ...(related
      ? [
          `${RELATED_INTERPRETATION_GUIDANCE}\n` +
            'After the brief, add exactly one line: RELATED_TASK_IDS: <comma-separated candidate ids, including note:… ids> — or RELATED_TASK_IDS: none. 0–5 is typical.',
        ]
      : []),
    `TASK RATING:\nEnd your answer with exactly one line rating how demanding the task is: TASK_RATING: kind=<coding|writing|research|ops|data|other>; complexity=<1-5>; reasoning=<1-5>\nScales — ${TASK_RATING_SCALES}`,
    `OUTPUT: only the brief${related ? ', the RELATED_TASK_IDS line' : ''} and the TASK_RATING line. No code fences around the brief.`,
  ].join('\n\n');

  const subtasks = (task.subtasks || []).map((s) => `- [${s.isDone ? 'x' : ' '}] ${s.text}`).join('\n');
  const user = [
    `TASK #${task.id}: ${task.title}`,
    `CATEGORY: ${task.category || 'General'} · STATUS: ${task.isDone ? 'done' : task.status || 'not_started'}`,
    ...(task.summaryNote?.trim() ? [`SUMMARY NOTE:\n${task.summaryNote.trim()}`] : []),
    `SUBTASKS:\n${subtasks || '(none)'}`,
    ...(input.currentOverview?.trim()
      ? [`CURRENT OVERVIEW (an earlier draft or the user's notes; keep what is still right):\n${input.currentOverview.trim()}`]
      : []),
    ...(related ? [`CANDIDATE RELATED TASKS (choose the useful ones; ids in brackets):\n${related}`] : []),
    ...(input.priorKnowledge?.trim()
      ? [`PRIOR KNOWLEDGE (this project's memory: earlier runs' notes, completed tasks; many are only loosely related):\n${input.priorKnowledge.trim()}`]
      : []),
  ].join('\n\n');

  return { system, user };
}

/** Offline brief (no model available): the task's own checklist in the brief format, kept on top of an earlier overview. */
export function buildOfflineTaskBrief(task: Pick<TaskItem, 'title' | 'subtasks'>, currentOverview = ''): string {
  const open = (task.subtasks || []).filter((s) => !s.isDone).map((s) => `- ${s.text}`);
  const done = (task.subtasks || []).filter((s) => s.isDone).map((s) => `- Already done: ${s.text}`);
  const brief = [
    `**Goal:** ${task.title}`,
    `**Done when:**\n${open.length > 0 ? open.join('\n') : `- "${task.title}" is complete.`}`,
    ...(done.length > 0 ? [`**Known context:**\n${done.join('\n')}`] : []),
  ].join('\n\n');
  const earlier = currentOverview.trim();
  // An earlier overview is the better source; the offline brief only adds the checklist it may be missing.
  return earlier ? `${earlier}\n\n---\n\n${brief}` : brief;
}
