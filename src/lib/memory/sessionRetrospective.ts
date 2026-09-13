/**
 * Session Retrospective — Distills durable project knowledge from task execution.
 *
 * Instead of dumping raw build transcripts and verbose event logs into AGENT_CONTEXT.md,
 * this module extracts only high-signal lessons — architectural decisions, bug fixes,
 * gotchas, and reusable patterns — and stores them as searchable vector memory chunks.
 *
 * Called by the Logger at the end of each successful task execution.
 */

import {
  addChunks,
  hasChunk,
  removeChunksByTaskId,
  searchMemory,
  type ChunkMetadata,
  type MemoryNamespace,
} from './vectorEngine';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Learning {
  id: string;
  lesson: string;
  category: LearningCategory;
  taskId: string | number;
  taskTitle: string;
  projectId?: string;
  timestamp: number;
}

export type LearningCategory =
  | 'architecture'
  | 'pattern'
  | 'gotcha'
  | 'convention'
  | 'dependency'
  | 'performance'
  | 'security'
  | 'tooling'
  | 'general';

export interface RetrospectiveInput {
  taskId: string | number;
  taskTitle: string;
  projectId?: string;
  /** The Gherkin brief / overview that scoped the task */
  overview: string;
  /** Build & verification log (condensed from the bible) */
  buildLog: string;
  /** Completion summary from the Logger */
  completion: string;
  /** Files created or modified during execution */
  createdFiles: string[];
  /** Whether all Gherkin scenarios passed */
  allScenariosPass: boolean;
  /** QA verdict from the hardener (if run) */
  qaVerdict?: string;
  /** Event log excerpt (last N events from the bible) */
  eventLog?: string;
}

// ─── Distillation Logic ─────────────────────────────────────────────────────

/**
 * Heuristic extraction of high-signal lessons from task execution output.
 *
 * This is a deterministic, 0-token distillation pass. It scans the build log,
 * completion summary, and event log for patterns that indicate durable knowledge:
 *
 *  1. Architectural decisions (e.g. "chose X pattern because Y")
 *  2. Bug fixes and workarounds (e.g. "fixed by adding Z")
 *  3. Gotchas and pitfalls (e.g. "this silently fails when...")
 *  4. File conventions and locations (e.g. "auth tokens stored in X")
 *  5. Dependency and tooling notes (e.g. "requires Node 22+ for X")
 */
function extractLessons(input: RetrospectiveInput): Learning[] {
  const lessons: Learning[] = [];
  const combined = [input.overview, input.buildLog, input.completion, input.eventLog || ''].join('\n');
  const lines = combined.split('\n').filter((l) => l.trim().length > 0);

  const makeLearning = (lesson: string, category: LearningCategory): Learning => ({
    id: `learning_${input.projectId || 'default'}_${input.taskId}_${category}_${lessons.length}`,
    lesson: lesson.trim(),
    category,
    taskId: input.taskId,
    taskTitle: input.taskTitle,
    projectId: input.projectId,
    timestamp: Date.now(),
  });

  // Pattern 1: Lines indicating architectural or design decisions
  const decisionPatterns = [
    /(?:chose|decided|opted|selected|using|switched to|migrated to)\s+(?:to\s+)?(.+?)(?:\s+because|\s+since|\s+due to|\s+for|\s+as|\.|$)/i,
    /(?:architecture|pattern|approach|design|convention|structure):\s*(.+)/i,
  ];

  // Pattern 2: Bug fixes, workarounds, and error resolutions
  const fixPatterns = [
    /(?:fixed|resolved|workaround|solved|corrected|patched)\s*(?:by|:)?\s*(.+)/i,
    /(?:the\s+(?:issue|bug|problem|error)\s+was)\s+(.+)/i,
    /(?:root\s+cause|caused\s+by)\s*:?\s*(.+)/i,
  ];

  // Pattern 3: Gotchas and warnings
  const gotchaPatterns = [
    /(?:gotcha|caveat|note|warning|careful|watch out|beware|silently|unexpectedly)\s*:?\s*(.+)/i,
    /(?:does\s+not|doesn't|won't|cannot|can't)\s+(.+?)(?:\s+unless|\s+without|\s+until|\.|$)/i,
  ];

  // Pattern 4: File location and convention mentions
  const locationPatterns = [
    /(?:stored|located|found|defined|declared|exported|lives?)\s+(?:in|at|under)\s+[`"']?([^\s`"']+\.\w+)[`"']?/i,
  ];

  for (const line of lines) {
    // Skip very short or boilerplate lines
    if (line.length < 20) continue;
    if (/^[-*•]\s*\[[ xX]\]/.test(line)) continue; // checkbox items
    if (/^(#{1,6}|\*\*Status\*\*|\*\*Overview\*\*)/.test(line)) continue; // headings/labels

    for (const pattern of decisionPatterns) {
      const match = line.match(pattern);
      if (match?.[1] && match[1].length > 15) {
        lessons.push(makeLearning(line, 'architecture'));
        break;
      }
    }

    for (const pattern of fixPatterns) {
      const match = line.match(pattern);
      if (match?.[1] && match[1].length > 10) {
        lessons.push(makeLearning(line, 'gotcha'));
        break;
      }
    }

    for (const pattern of gotchaPatterns) {
      const match = line.match(pattern);
      if (match?.[1] && match[1].length > 10) {
        lessons.push(makeLearning(line, 'gotcha'));
        break;
      }
    }

    for (const pattern of locationPatterns) {
      const match = line.match(pattern);
      if (match?.[1]) {
        lessons.push(makeLearning(line, 'convention'));
        break;
      }
    }
  }

  // Always create a task completion summary as a 'tasks' namespace chunk keyed on the internal taskId
  if (input.createdFiles.length > 0 || input.allScenariosPass) {
    const summaryParts = [
      `Task: "${input.taskTitle}"`,
      input.allScenariosPass ? 'All scenarios passed.' : 'Some scenarios did not pass.',
      input.createdFiles.length > 0
        ? `Files: ${input.createdFiles.slice(0, 10).join(', ')}${input.createdFiles.length > 10 ? ` (+${input.createdFiles.length - 10} more)` : ''}`
        : '',
      input.qaVerdict ? `QA: ${input.qaVerdict}` : '',
    ].filter(Boolean);

    lessons.push({
      id: `task_summary_${input.projectId || 'default'}_${input.taskId}`,
      lesson: summaryParts.join(' | '),
      category: 'general',
      taskId: input.taskId,
      taskTitle: input.taskTitle,
      projectId: input.projectId,
      timestamp: Date.now(),
    });
  }

  return lessons;
}

/**
 * Deduplicate candidate lessons against existing memory.
 *
 * Uses semantic similarity to detect near-duplicates: if a candidate lesson
 * is >0.85 similar to an existing chunk in the same project, it is considered redundant and dropped.
 */
async function deduplicateLessons(lessons: Learning[], projectId?: string): Promise<Learning[]> {
  const unique: Learning[] = [];

  for (const lesson of lessons) {
    // Skip if exact ID already exists
    if (await hasChunk(lesson.id)) continue;

    // Check semantic similarity against existing learnings within the same project
    const similar = await searchMemory(lesson.lesson, {
      namespace: 'learnings',
      topK: 1,
      minSimilarity: 0.85,
      projectId: lesson.projectId || projectId,
    });
    if (similar.length > 0) {
      // Near-duplicate found — skip
      continue;
    }

    unique.push(lesson);
  }

  return unique;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Run a session retrospective after task completion.
 *
 * Extracts high-signal lessons from the execution output, deduplicates them
 * against existing memory, and stores the survivors in the vector store.
 *
 * Automatically purges any prior runs' chunks for this task before storing new ones,
 * ensuring task reruns cleanly update memory instead of accumulating duplicates.
 *
 * @returns The number of new learnings stored
 */
export async function runSessionRetrospective(input: RetrospectiveInput): Promise<number> {
  console.log(`[SessionRetrospective] Distilling learnings from task #${input.taskId}: "${input.taskTitle}"`);

  // Step 0: Purge prior chunks for this task in this project so reruns cleanly overwrite
  try {
    const purged = await removeChunksByTaskId(input.taskId, input.projectId);
    if (purged > 0) {
      console.log(`[SessionRetrospective] Purged ${purged} existing chunk(s) for task #${input.taskId} prior to distillation`);
    }
  } catch (purgeErr) {
    console.warn('[SessionRetrospective] Failed to purge prior task chunks (non-fatal):', purgeErr);
  }

  // Step 1: Extract candidate lessons (0 tokens — pure heuristic)
  const candidates = extractLessons(input);
  if (candidates.length === 0) {
    console.log('[SessionRetrospective] No high-signal lessons extracted');
    return 0;
  }
  console.log(`[SessionRetrospective] Extracted ${candidates.length} candidate lesson(s)`);

  // Step 2: Deduplicate against existing memory within the same project
  const unique = await deduplicateLessons(candidates, input.projectId);
  if (unique.length === 0) {
    console.log('[SessionRetrospective] All candidates were duplicates of existing knowledge');
    return 0;
  }
  console.log(`[SessionRetrospective] ${unique.length} unique lesson(s) after deduplication`);

  // Step 3: Store in vector memory
  const learningChunks = unique
    .filter((l) => l.category !== 'general') // 'general' = task summaries → 'tasks' namespace
    .map((l) => ({
      id: l.id,
      namespace: 'learnings' as MemoryNamespace,
      text: l.lesson,
      metadata: {
        taskId: l.taskId,
        taskTitle: l.taskTitle,
        category: l.category,
        projectId: l.projectId,
        tags: [l.category],
        source: 'session-retrospective',
      } as ChunkMetadata,
    }));

  const taskChunks = unique
    .filter((l) => l.category === 'general')
    .map((l) => ({
      id: l.id,
      namespace: 'tasks' as MemoryNamespace,
      text: l.lesson,
      metadata: {
        taskId: l.taskId,
        taskTitle: l.taskTitle,
        projectId: l.projectId,
        source: 'session-retrospective',
      } as ChunkMetadata,
    }));

  let stored = 0;
  if (learningChunks.length > 0) stored += await addChunks(learningChunks);
  if (taskChunks.length > 0) stored += await addChunks(taskChunks);

  console.log(`[SessionRetrospective] Stored ${stored} new chunk(s) in vector memory`);
  return stored;
}

/**
 * Migrate existing AGENT_CONTEXT.md items into the vector store.
 *
 * Called during the transition period to seed the vector memory with
 * historical task data. Keyed deterministically on internal task ID and project ID.
 */
export async function migrateAgentContextToMemory(
  items: Array<{
    id: string;
    title: string;
    overview: string;
    buildAndVerification?: string;
    completion?: string;
    projectId?: string;
  }>
): Promise<number> {
  if (items.length === 0) return 0;
  console.log(`[SessionRetrospective] Migrating ${items.length} AGENT_CONTEXT items to vector memory…`);

  const chunks = items
    .filter((item) => item.overview && item.overview.trim().length > 20)
    .map((item) => {
      const normTaskId = String(item.id).replace(/^brief_/, '');
      const projId = item.projectId || 'default';
      // Combine overview + completion into a single searchable chunk
      const text = [
        `Task: ${item.title}`,
        item.overview,
        item.completion ? `Completion: ${item.completion.slice(0, 500)}` : '',
      ]
        .filter(Boolean)
        .join('\n');

      return {
        id: `migrated_${projId}_${normTaskId}`,
        namespace: 'tasks' as MemoryNamespace,
        text,
        metadata: {
          taskId: normTaskId,
          taskTitle: item.title,
          projectId: item.projectId,
          source: 'migration',
        } as ChunkMetadata,
      };
    });

  const stored = await addChunks(chunks);
  console.log(`[SessionRetrospective] Migration complete: ${stored} chunks stored`);
  return stored;
}
