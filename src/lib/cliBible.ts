/**
 * TASK_CONTEXT.md for CLI task runs — the run's bible, readable by the user: the working brief exactly as the
 * manager got it, the run's execution log (its steps), and the manager prompt as sent. Written to the same storage
 * location as the in-app pipeline's bible (runs/<project>/task-<id>-<runId>/), outside the watched projects/ tree.
 * The agents never read this file; it is the record of what they were handed and what happened.
 */
import type { AgentContextItem, ExecutionStep, TaskItem } from '../types';
import { BibleStore, writeStorageFile } from './agentPipeline/bible';
import { isTaskBrief } from './agentPipeline/taskBrief';
import { hasUsableOverview } from './overviewUtils';

export function cliBiblePath(projectId: string, taskId: string | number, runId: string): string {
  return `${BibleStore.runDirFor(projectId, taskId, runId)}/TASK_CONTEXT.md`;
}

export interface CliBibleInput {
  task: TaskItem;
  brief?: AgentContextItem;
  runId: string;
  cliName: string;
  relatedSources?: string;
  managerPrompt?: string;
  steps: ExecutionStep[];
}

function firstLine(text: string, max = 240): string {
  const line = (text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function renderCliBible(input: CliBibleInput): string {
  const { task, brief, runId } = input;
  const out: string[] = [`# TASK EXECUTION BIBLE: ${task.title}`, ''];
  out.push('## Metadata');
  out.push(`- **Task ID**: #${task.id}`);
  out.push(`- **Category**: ${task.category || 'General'}`);
  out.push(`- **Run ID**: ${runId}`);
  out.push(`- **Manager CLI**: ${input.cliName}`, '');

  out.push('## Task Checklist');
  if (task.subtasks.length > 0) {
    for (const s of task.subtasks) out.push(`- [${s.isDone ? 'x' : ' '}] ${s.text}${s.isHumanReview ? ' **[Human Review]**' : ''}`);
  } else {
    out.push(`- [ ] ${task.title}`);
  }
  out.push('');

  const overview = hasUsableOverview(brief) ? (brief?.overview || brief?.brief || '').trim() : '';
  if (overview && isTaskBrief(overview)) {
    out.push("## Working Brief (the Summary step's spec)", overview, '');
  } else if (overview) {
    out.push('## Overview (your own text — the manager worked from it)', overview, '');
  } else {
    out.push('## Working Brief', '_None: the manager worked from the task title and checklist._', '');
  }
  if (input.relatedSources?.trim()) out.push('## Brief Sources', input.relatedSources.trim(), '');

  out.push('## Execution Event Log');
  if (input.steps.length === 0) out.push('- _(no events yet)_');
  for (const s of input.steps) {
    const detail = firstLine(s.detail);
    out.push(`- [${s.time}] **${s.title}** (${s.status})${detail ? `: ${detail}` : ''}`);
  }
  out.push('');

  if (input.managerPrompt?.trim()) {
    // A fence longer than any backtick run inside the prompt, so the prompt shows verbatim.
    const longest = Math.max(2, ...(input.managerPrompt.match(/`+/g) || []).map((m) => m.length));
    const fence = '`'.repeat(longest + 1);
    out.push('## Manager Prompt (exactly as sent)', `${fence}text`, input.managerPrompt.trim(), fence, '');
  }
  return out.join('\n').trimEnd() + '\n';
}

export function writeCliBible(filePath: string, input: CliBibleInput): Promise<void> {
  return writeStorageFile(filePath, renderCliBible(input));
}
