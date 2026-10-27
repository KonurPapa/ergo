/**
 * Archive records — what the archive keeps of a task or execution card the user archives, in the `tasks` namespace.
 */

import { addChunks, type ChunkMetadata, type MemoryNamespace } from './vectorEngine';

/**
 * Archive a task directly to vector memory.
 * Stores a concise task summary and any relevant brief notes in the 'tasks' namespace,
 * ensuring the AI retains this context even after the task is removed from active workspaces.
 *
 * `side` says which workspace the record comes from: 'human' keeps the task and its checklist,
 * 'ai' the execution card's overview and completion. Each side gets its own record so the
 * archive screen can list them apart; omitting it writes one combined record (legacy migration).
 */
export async function archiveTaskToVectorMemory(input: {
  taskId: string | number;
  taskTitle: string;
  category?: string;
  status?: string;
  overview?: string;
  completion?: string;
  subtasks?: Array<{ text: string; isDone?: boolean }>;
  projectId?: string;
  side?: 'human' | 'ai';
  /** The whole execution card (side 'ai'), kept so Restore can bring it back as it was. */
  brief?: unknown;
}): Promise<number> {
  const normTaskId = String(input.taskId).replace(/^brief_/, '');
  const projId = input.projectId || 'default';
  const cleanTitle = input.taskTitle.trim();

  const lines: string[] = [
    `Archived Task: "${cleanTitle}"`,
    input.category ? `Category: ${input.category}` : '',
    input.status ? `Status: ${input.status}` : '',
  ].filter(Boolean);

  const withHuman = input.side !== 'ai';
  const withAi = input.side !== 'human';

  if (withAi && input.overview && input.overview.trim().length > 0) {
    lines.push(`Overview: ${input.overview.trim().slice(0, 500)}`);
  }

  if (withAi && input.completion && input.completion.trim().length > 0) {
    const cleanComp = input.completion.replace(/<!--[\s\S]*?-->/g, '').trim();
    lines.push(`Completion: ${cleanComp.slice(0, 500)}`);
  }

  if (withHuman && input.subtasks && input.subtasks.length > 0) {
    const subtaskLines = input.subtasks.map((st) => `- [${st.isDone ? 'x' : ' '}] ${st.text}`);
    lines.push(`Checklist:\n${subtaskLines.join('\n')}`);
  }

  const chunkText = lines.join('\n\n');

  const chunk = {
    id: input.side === 'ai' ? `archived-ai_${projId}_${normTaskId}` : `archived_${projId}_${normTaskId}`,
    namespace: 'tasks' as MemoryNamespace,
    text: chunkText,
    metadata: {
      taskId: normTaskId,
      taskTitle: cleanTitle,
      category: input.category || 'general',
      projectId: input.projectId,
      source: input.side === 'ai' ? 'ai-archive' : 'workspace-archive',
      tags: ['archived', input.category || 'general'].filter(Boolean),
      subtasks: input.subtasks,
      serializedSubtasks: input.subtasks ? JSON.stringify(input.subtasks) : undefined,
      serializedBrief: input.side === 'ai' && input.brief ? JSON.stringify(input.brief) : undefined,
    } as ChunkMetadata,
  };

  const stored = await addChunks([chunk]);
  console.log(`[SessionRetrospective] Archived task #${normTaskId} "${cleanTitle}" to vector memory`);
  return stored;
}
