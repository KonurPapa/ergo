import {
  type TaskItem,
  type Subtask,
  type AgentContextItem,
  type ProjectData,
  type MCPServer,
  type AIProviderConfig,
  type ExecutionStep,
  type McpToolPermissionPrompt,
  type PermissionDecision,
  type HumanInputPrompt,
  type HumanAiIntent,
  type HumanAiAssistantResult,
  type SwimLaneDoc,
  type DiscoveryJobPayload,
  type DiscoveredTaskContextEntry,
  type OverviewDocument,
  type ManagerBiblePayload,
  type TaskRating
} from '../types';
import { callMcpTool, formatConnectionsForAiPrompt, getAllowedRoots } from './mcpClient';
import { storageManager } from './storageManager';
import { parseTodoMarkdown } from './parser';
import { callAiEngine, stripSkillFrontmatter } from './llmClient';
import { extractTaskRatingLine } from './agentPipeline/taskRating';
import { buildOfflineTaskBrief, buildTaskBriefPrompts } from './agentPipeline/taskBrief';
import { resolveRequiredMcps } from './agentPipeline/summary';
import { loadPipelineSkill } from './agentPipeline/skills';

// The agent execution pipeline (Discovery → Summary → Manager → Cleaner → Verifier → Logger)
// lives in ./agentPipeline. Re-exported here so existing imports keep working.
export { executeTaskWithAi } from './agentPipeline';
export { callAiEngine } from './llmClient';


/**
 * The Human AI Assistant: a 2-step pipeline that edits the human task list.
 * 1. AI 1 (assistant-context-analyzer): skims the task list, extracts relevance & context (<= 200 words).
 * 2. AI 2 (assistant-todo-builder): writes the updated TODO.md in native markdown.
 * Tasks get no overview here: a run's Summary step writes each task's working brief when it first runs.
 */
export async function runHumanAiAssistant(
  userPrompt: string,
  intent: HumanAiIntent = 'task',
  currentTodoMarkdown: string,
  project: ProjectData,
  aiConfig: AIProviderConfig,
  connectedMcps: MCPServer[],
  customSkillDoc?: string | null
): Promise<HumanAiAssistantResult> {
  const allowedRoots = await getAllowedRoots();
  const runtimeConnectionsPrompt = formatConnectionsForAiPrompt(connectedMcps, allowedRoots);

  const [skill1Raw, skill2Raw] = await Promise.all([
    storageManager.loadSkillDoc('assistant-context-analyzer'),
    storageManager.loadSkillDoc('assistant-todo-builder')
  ]);

  const skill1Doc = stripSkillFrontmatter(skill1Raw);
  const skill2Doc = stripSkillFrontmatter(customSkillDoc || skill2Raw);

  const safeTodoMarkdown = currentTodoMarkdown || '';

  const modeGuidance = intent === 'architect'
    ? `OPERATIONAL MODE: ARCHITECT MODE (ALWAYS NUMEROUS TASKS — HIGHER-LEVEL ROADMAP)
- PURPOSE: Architect mode is ALWAYS for creating/modifying NUMEROUS tasks across the workspace.
- HIGHER-LEVEL SCOPE: Never assume it is confined to a single task. Always assume that the user's instructions are meant to be higher-level and broad, spanning multiple tasks, subtasks, or milestones across categories.
- MULTI-TASK REQUIREMENT: Whatever the user describes, extrapolate broadly to design a structured multi-task architecture and comprehensive workflow.
- FORMATTING: Maintain strict markdown list formatting (numbered tasks \`1.\`, \`2.\`, 4-space indented subtasks \`    - \`, and category headers \`##\`).`
    : `OPERATIONAL MODE: TASK MODE (SINGLE TASK ONLY — STRICT ISOLATION)
- PURPOSE: Task mode is ONLY for creating or modifying a SINGLE task/subtasks — either the task the user has currently selected, or a different task they explicitly call out (e.g. creating a new task).
- FLESH OUT PROMPT: Flesh out the user's prompt into a complete, well-formed single task with clear, concrete domain-specific subtasks.
- STRICT ISOLATION (ZERO BLEED-OVER): Confine your changes strictly to this current task. There must NOT be any bleed-over into other tasks.
- DO NOT alter, reorder, delete, or rewrite any other existing tasks in TODO.md.
- If creating a new task, append it to the appropriate category or at the end of TODO.md as a single new numbered task with its subtasks. If modifying an existing task, only modify that specific task.`;

  // 1. Check for report / summary requests
  const lowerPrompt = userPrompt.toLowerCase();
  if (lowerPrompt.includes('summarize') || lowerPrompt.includes('report') || lowerPrompt.includes('metrics') || lowerPrompt.includes('aggregate')) {
    const lines = safeTodoMarkdown.split('\n');
    const taskLines = lines.filter((l) => /^\d+\.\s+/.test(l.trim()));
    const doneLines = taskLines.filter((l) => /~~.+~~/.test(l));
    const reportMarkdown = `# 📊 Workspace Summary\n\n- **Total Tasks:** ${taskLines.length}\n- **Completed:** ${doneLines.length} (${taskLines.length > 0 ? Math.round((doneLines.length / taskLines.length) * 100) : 0}%)\n- **Remaining:** ${taskLines.length - doneLines.length}\n`;

    console.log('%c[Ergo AI Assistant] ── Workspace Summary Report Generated ──', 'color: #38bdf8; font-weight: bold;');
    console.log(reportMarkdown);

    return {
      summary: `Generated summary across ${taskLines.length} tasks.`,
      aggregatedReport: reportMarkdown
    };
  }

  // ─── Live 3-Agent Sequential Pipeline (When AI Provider is Connected) ───
  if (aiConfig.provider !== 'none' && aiConfig.provider !== 'mock' && (aiConfig.apiKey || aiConfig.provider === 'ollama')) {
    try {
      console.log('%c[Ergo AI Assistant] 🚀 Starting 2-Agent Pipeline...', 'color: #6366f1; font-weight: bold;');

      // ── Step 1: AI 1 — Context & Relevance Analyzer ──
      const ai1SystemPrompt = `You are AI 1 (Context & Relevance Analyzer) in Ergo.
${skill1Doc ? `\nSKILL INSTRUCTIONS:\n${skill1Doc}\n` : ''}

PROJECT: "${project.name || 'Default Workspace'}" (${project.folderPath})
ACTIVE MCP CONNECTIONS & PERMITTED ROOTS:
${runtimeConnectionsPrompt}

YOUR TASK:
1. Skim the current categories, task titles and subtasks in TODO.md.
2. Compare them against the user request.
3. Extract relevant existing structures to copy/mirror, target category, next task number, constraints, and relevant active MCP tools.
4. Output a concise analysis strictly under 200 words.

CURRENT TODO.md:
\`\`\`markdown
${safeTodoMarkdown}
\`\`\``;

      // Step 1: AI 1 uses primary task model ('general')
      const ai1ModelType = 'general' as const;
      const ai1Response = await callAiEngine(userPrompt, ai1SystemPrompt, aiConfig, ai1ModelType, 'text');
      const ai1Analysis = ai1Response.trim() || 'Standalone request. Create new task(s) matching workspace conventions.';

      console.log('%c[Ergo AI Assistant] ── Step 1 / 2: Context & Relevance Analysis (AI 1) ──', 'color: #38bdf8; font-weight: bold;');
      console.log(ai1Analysis);

      // ── Step 2: AI 2 — TODO.md Task Builder ──
      const ai2SystemPrompt = `You are AI 2 (TODO.md Task Builder) in Ergo.
${skill2Doc ? `\nSKILL INSTRUCTIONS:\n${skill2Doc}\n` : ''}

PROJECT: "${project.name || 'Default Workspace'}" (${project.folderPath})
ACTIVE MCP CONNECTIONS & PERMITTED ROOTS:
${runtimeConnectionsPrompt}
MODE: ${intent === 'architect' ? 'ARCHITECT MODE (BROAD MULTI-TASK & SUBTASK ROADMAP)' : 'TASK MODE (SINGLE TASK ONLY — ZERO BLEED-OVER)'}

${modeGuidance}

CORE PRINCIPLE — HUMAN-SIDE FIRST:
You write and modify TODO.md. Translate the user request and AI 1's Context Analysis directly into clear tasks and concrete subtasks in TODO.md.

FORMATTING RULES (STRICT):
- 4-space indentation for subtasks (\`    - \`)
- Numbered task lists (\`1.\`, \`2.\`), restart at 1 per category
- Headings: \`## Category Name\`
- Strikethrough for done tasks: \`~~Done task~~\`
- Preserve existing header comments (<!-- ... -->) and unmodified categories
${intent === 'task' ? '- STRICT ISOLATION: Modify/append ONLY the requested single task. Do NOT touch, reorder, or alter other tasks.' : '- ARCHITECT ROADMAP: Extrapolate into multiple structured tasks with subtasks across the roadmap.'}
- NEVER generate boilerplate like "Research and plan" or "Implement core work". Make every subtask concrete and domain-specific.
- DO NOT TRUNCATE. Output the complete updated TODO.md from start to finish.

CURRENT TODO.md:
\`\`\`markdown
${safeTodoMarkdown}
\`\`\`

Output your updated TODO.md directly inside a code fence:
\`\`\`markdown:TODO.md
...complete updated TODO.md content...
\`\`\``;

      const ai2UserPrompt = `USER REQUEST:
${userPrompt}

AI 1 CONTEXT & RELEVANCE ANALYSIS:
${ai1Analysis}`;

      const ai2Response = await callAiEngine(ai2UserPrompt, ai2SystemPrompt, aiConfig, 'general', 'text');
      const todoFenceMatch = ai2Response.match(/```(?:markdown)?(?::|\s+)?(?:TODO\.md|todo)\s*\n([\s\S]*?)```/i);
      let updatedTodoMarkdown = todoFenceMatch ? todoFenceMatch[1].trim() : '';

      if (!updatedTodoMarkdown) {
        const cleanRaw = ai2Response.replace(/^```(?:markdown)?\s*\n/i, '').replace(/\n```$/i, '').trim();
        if (/^\s*(?:#|\d+\.)/m.test(cleanRaw)) {
          updatedTodoMarkdown = cleanRaw;
        } else {
          updatedTodoMarkdown = safeTodoMarkdown;
        }
      }

      console.log('%c[Ergo AI Assistant] ── Step 2 / 2: Updated TODO.md Output (AI 2) ──', 'color: #34d399; font-weight: bold;');
      console.log(updatedTodoMarkdown);

      console.log('%c[Ergo AI Assistant] ── 2-Agent Pipeline Completed Successfully ✅ ──', 'color: #10b981; font-weight: bold;');

      const summaryText = intent === 'architect'
        ? `Architected multi-task roadmap structure across workspace.`
        : `Fleshed out single task with concrete subtasks.`;

      return {
        summary: summaryText,
        todoMarkdown: updatedTodoMarkdown
      };
    } catch (e: any) {
      console.warn(`[Ergo AI Assistant] Live API notice (falling back to the offline generator):`, e.message);
    }
  }

  // ─── Offline Fallback (No API Key or Offline) ───
  await new Promise((resolve) => setTimeout(resolve, 600));

  // Extract clean task title from user prompt
  const interpretedTitle = (() => {
    const raw = userPrompt.trim();
    // 1. Quoted names e.g. "Called 'Psalm 23'" or 'LOTR'
    const quotedMatch = raw.match(/['"]([^'"]+)['"]/);
    if (quotedMatch) return quotedMatch[1].trim();

    // 2. Named patterns e.g. task called X, named X
    const namedMatch = raw.match(/(?:called|named|titled)\s+([^,.;\n]+)/i);
    if (namedMatch) return namedMatch[1].trim();

    // 3. Action verbs e.g. "Create task for X", "Add dark mode"
    const verbMatch = raw.match(/^(?:please\s+)?(?:create|add|make|generate|draft|architect|design|build|setup|set\s+up)\s+(?:a\s+)?(?:new\s+)?(?:task\s+)?(?:called|named|for|about|to|with)?\s*(.+)/i);
    if (verbMatch) {
      const candidate = verbMatch[1].replace(/\s+subtasks?.*/i, '').replace(/\s+(?:and|with|including)\s+.*/i, '').trim();
      if (candidate.length > 2) return candidate.replace(/\b\w/g, (c) => c.toUpperCase());
    }

    const firstSentence = raw.split(/[.\n]/)[0].trim();
    return firstSentence.replace(/\b\w/g, (c) => c.toUpperCase()) || 'Workspace Task';
  })();

  // Domain-specific subtasks generator based on keywords in title/prompt
  const generateDomainSubtasks = (title: string, promptText: string): string[] => {
    const lower = `${title} ${promptText}`.toLowerCase();

    if (lower.includes('psalm') || lower.includes('bible') || lower.includes('verse') || lower.includes('scripture')) {
      return [
        `Read and annotate verses of ${title}`,
        `Analyze key pastoral themes, metaphors, and historical context`,
        `Draft study reflections and record practical applications`
      ];
    }
    if (lower.includes('lotr') || lower.includes('ring') || lower.includes('middle-earth')) {
      return [
        `Acquire the One Ring and consult Gandalf in the Shire`,
        `Unite the Fellowship of the Ring at Rivendell`,
        `Journey across Middle-Earth and evade the Nazgûl`,
        `Destroy the One Ring in the fires of Mount Doom`
      ];
    }
    if (lower.includes('auth') || lower.includes('login') || lower.includes('jwt') || lower.includes('oauth')) {
      return [
        `Configure OAuth provider client ID and secure redirect URIs`,
        `Implement JWT token issuance, refresh rotation, and cookie handling`,
        `Add authentication middleware to protect API routes and views`,
        `Write integration tests for login, token refresh, and logout flows`
      ];
    }
    if (lower.includes('billing') || lower.includes('stripe') || lower.includes('payment') || lower.includes('subscription')) {
      return [
        `Initialize Stripe SDK client and configure webhook signing secrets`,
        `Create subscription checkout sessions and handle customer portals`,
        `Process invoice.payment_succeeded and customer.subscription.updated webhooks`,
        `Implement grace periods, cancellation flows, and billing status UI`
      ];
    }
    if (lower.includes('pdf') || lower.includes('export') || lower.includes('print')) {
      return [
        `Design print-ready document template with header, footer, and page numbers`,
        `Implement rendering pipeline to assemble vector content and styling`,
        `Verify high-DPI rasterization and cross-browser PDF download reliability`
      ];
    }

    return [
      `Define architectural specification and data schemas for ${title}`,
      `Implement core functionality and wire necessary component integrations`,
      `Add automated test coverage and verify end-to-end user behavior`
    ];
  };

  // Determine existing task numbers
  const existingTaskNumbers = [...safeTodoMarkdown.matchAll(/^(\d+)\.\s+/gm)].map((m) => parseInt(m[1], 10));
  let nextNum = existingTaskNumbers.length > 0 ? Math.max(...existingTaskNumbers) + 1 : 1;

  // Offline Step 1: Context Analysis
  const offlineAnalysis = `### Context & Relevance Analysis (Offline Mode)
- **Relevance**: Standalone request for "${interpretedTitle}".
- **Target Category**: Append to active task list.
- **Next Task Number**: #${nextNum}
- **Structure to Follow**: 4-space indented subtasks, numbered task hierarchy.
- **Key Data & Constraints**: Extrapolate concrete domain steps for ${interpretedTitle}.`;

  console.log('%c[Ergo AI Assistant] ── Step 1 / 2: Context Analysis (Offline AI 1) ──', 'color: #38bdf8; font-weight: bold;');
  console.log(offlineAnalysis);

  if (intent === 'architect') {
    // Offline Step 2: Architect Mode (Multiple Tasks & Subtasks)
    const architectTasks = [
      {
        title: `Architecture & Data Contracts for ${interpretedTitle}`,
        subtasks: [
          `Define data schemas, state contracts, and domain types`,
          `Set up core module directory scaffolding and export index`,
          `Configure validation boundaries and error handlers`
        ]
      },
      {
        title: `Core Business Logic & Pipeline for ${interpretedTitle}`,
        subtasks: [
          `Implement primary processing handlers and execution workflow`,
          `Integrate runtime storage and event communication channels`,
          `Add validation gates and idempotency safeguards`
        ]
      },
      {
        title: `UI Views, Interaction & Verification for ${interpretedTitle}`,
        subtasks: [
          `Build responsive components and interactive feedback indicators`,
          `Implement empty states, loading indicators, and error banners`,
          `Conduct end-to-end flow testing and document usage guides`
        ]
      }
    ];

    let newTodoAppend = '';

    architectTasks.forEach((t) => {
      const currentTaskNum = nextNum++;
      const subtaskLines = t.subtasks.map((s) => `    - ${s}`).join('\n');
      newTodoAppend += `${currentTaskNum}. ${t.title}\n${subtaskLines}\n`;
    });

    const updatedTodo = safeTodoMarkdown.trimEnd() ? `${safeTodoMarkdown.trimEnd()}\n\n${newTodoAppend}` : newTodoAppend;

    console.log('%c[Ergo AI Assistant] ── Step 2 / 2: Updated TODO.md (Offline AI 2) ──', 'color: #34d399; font-weight: bold;');
    console.log(updatedTodo);

    return {
      summary: `Architected 3 structured roadmap tasks and subtasks for "${interpretedTitle}".`,
      todoMarkdown: updatedTodo
    };
  }

  // Offline Step 2: Task Mode (Single Task Focus)
  const domainSubtasks = generateDomainSubtasks(interpretedTitle, userPrompt);
  const subtasksBlock = domainSubtasks.map((s) => `    - ${s}`).join('\n');
  const newTodoBlock = `${nextNum}. ${interpretedTitle}\n${subtasksBlock}`;
  const updatedTodo = safeTodoMarkdown.trimEnd() ? `${safeTodoMarkdown.trimEnd()}\n${newTodoBlock}\n` : `${newTodoBlock}\n`;

  console.log('%c[Ergo AI Assistant] ── Step 2 / 2: Updated TODO.md (Offline AI 2) ──', 'color: #34d399; font-weight: bold;');
  console.log(updatedTodo);

  return {
    summary: `Fleshed out single task #${nextNum}: "${interpretedTitle}".`,
    todoMarkdown: updatedTodo
  };
}

const RELATED_IDS_LINE_RE = /^[ \t>*_`-]*RELATED[_ ]TASK[_ ]IDS[*_`]*[ \t]*:[*_`]*[ \t]*(.*)$/gim;

/**
 * Splits the overview model's trailing `RELATED_TASK_IDS: a, b` line off its answer (every such line is removed,
 * the last one wins). Ids are trimmed of brackets / `#` / quotes; "none" (or nothing) yields []. With
 * `allowedIds`, ids not in that list are dropped (the model may only pick from the candidates it was shown).
 */
export function extractRelatedTaskIdsLine(
  text: string,
  allowedIds?: readonly string[]
): { text: string; relatedTaskIds: string[]; found: boolean } {
  let lastValue: string | null = null;
  const stripped = String(text ?? '').replace(RELATED_IDS_LINE_RE, (_line, value: string) => {
    lastValue = value;
    return '';
  });
  if (lastValue === null) return { text: String(text ?? '').trim(), relatedTaskIds: [], found: false };
  const allowed = allowedIds ? new Set(allowedIds.map(String)) : null;
  const ids: string[] = [];
  for (const raw of (lastValue as string).split(/[,;\s]+/)) {
    const id = raw.replace(/^[\s[\]("'`#]+|[\s[\])"'`.]+$/g, '').trim();
    if (!id || /^(none|n\/a|null|-)$/i.test(id)) continue;
    if (allowed && !allowed.has(id)) continue;
    if (!ids.includes(id)) ids.push(id);
  }
  return { text: stripped.replace(/\n{3,}/g, '\n\n').trim(), relatedTaskIds: ids, found: true };
}

/**
 * Writes a task's overview: the manager's working brief (skill docs/skills/task-brief; prompts in
 * agentPipeline/taskBrief.ts). It is short on purpose — goal, scope, known context, constraints, done-when — and is
 * the spec CLI task runs hand the manager.
 *
 * With `options.relatedCandidatesPrompt` (stage 1 of related-task matching), the model also picks the candidates
 * that are genuinely useful context for this task (stage 2) and folds them into the brief; they come back as
 * `relatedTaskIds` (unvalidated against the candidate list — callers intersect them with their candidates).
 *
 * The model also rates the task on a final `TASK_RATING:` line (Auto model selection); it comes back as
 * `taskRating`, undefined when the line is missing or invalid (and from the offline fallback).
 */
export async function syncTaskOverviewWithAi(
  task: TaskItem,
  currentOverview: string,
  project: ProjectData,
  aiConfig: AIProviderConfig,
  connectedMcps: MCPServer[],
  options: { relatedCandidatesPrompt?: string; priorKnowledge?: string; referencesNote?: string; projectRules?: string } = {}
): Promise<{ overview: string; relatedTaskIds: string[]; relatedSelectionMade: boolean; taskRating?: TaskRating }> {
  if (aiConfig.provider !== 'none' && aiConfig.provider !== 'mock' && (aiConfig.apiKey || aiConfig.provider === 'ollama')) {
    try {
      const { system, user } = buildTaskBriefPrompts({
        task,
        skill: await loadPipelineSkill('task-brief'),
        project,
        serverNames: connectedMcps.filter((m) => m.status === 'connected').map((m) => m.name),
        currentOverview,
        relatedCandidatesPrompt: options.relatedCandidatesPrompt,
        priorKnowledge: options.priorKnowledge,
        referencesNote: options.referencesNote,
        projectRules: options.projectRules,
      });
      const response = await callAiEngine(user, system, aiConfig, 'general', 'text');
      // The selection line goes first: it may sit after a code fence the model wrapped the brief in.
      const { text: withoutRelated, relatedTaskIds, found: relatedSelectionMade } = extractRelatedTaskIdsLine(response);
      const { text: answerText, rating: taskRating } = extractTaskRatingLine(withoutRelated);
      const fenced = answerText.trim().match(/^```(?:markdown)?\s*\n([\s\S]*?)```$/i);
      const overview = (fenced ? fenced[1] : answerText).trim();
      if (overview) {
        console.log('%c[Ergo AI Assistant] ── Working brief ──', 'color: #a78bfa; font-weight: bold;');
        console.log(overview);
        if (options.relatedCandidatesPrompt) console.log('[Ergo AI Assistant] Related tasks selected:', relatedTaskIds.join(', ') || 'none');
        console.log('[Ergo AI Assistant] Task rating:', taskRating ? `${taskRating.kind} · complexity ${taskRating.complexity} · reasoning ${taskRating.reasoning}` : 'missing');
        return { overview, relatedTaskIds, relatedSelectionMade, ...(taskRating ? { taskRating } : {}) };
      }
    } catch (e: any) {
      console.warn('[Ergo AI Assistant] Working brief call failed (using the offline brief):', e.message);
    }
  }

  // No model ran, so nothing was selected.
  return { overview: buildOfflineTaskBrief(task, currentOverview), relatedTaskIds: [], relatedSelectionMade: false };
}

// ─── Task Execution Pipeline Helpers ────────────────────────────────────────

interface WorkspaceTaskEntry {
  task: TaskItem;
  laneTitle: string;
  fileName: string;
}

/**
 * Extracts and tags all tasks from all workspace swim lane markdown documents.
 */
export function extractAllWorkspaceTasks(
  swimLanesOrTodo: SwimLaneDoc[] | string | undefined,
  todoFallback: string = ''
): WorkspaceTaskEntry[] {
  let lanes: SwimLaneDoc[] = [];

  if (Array.isArray(swimLanesOrTodo) && swimLanesOrTodo.length > 0) {
    lanes = swimLanesOrTodo;
  } else if (typeof swimLanesOrTodo === 'string' && swimLanesOrTodo.trim()) {
    lanes = [{ id: 'lane-default', title: 'TODO', filePath: 'TODO.md', markdown: swimLanesOrTodo }];
  } else if (todoFallback && todoFallback.trim()) {
    lanes = [{ id: 'lane-default', title: 'TODO', filePath: 'TODO.md', markdown: todoFallback }];
  } else {
    lanes = [{ id: 'lane-default', title: 'TODO', filePath: 'TODO.md', markdown: '' }];
  }

  const results: WorkspaceTaskEntry[] = [];
  let globalOffset = 0;

  for (const lane of lanes) {
    const fileName = lane.filePath ? lane.filePath.split('/').pop() || 'TODO.md' : 'TODO.md';
    const parsed = parseTodoMarkdown(lane.markdown);
    for (let i = 0; i < parsed.items.length; i++) {
      results.push({
        task: {
          ...parsed.items[i],
          id: parsed.items[i].id || (globalOffset + i + 1),
          swimLaneId: lane.id,
          sourceFileName: fileName
        },
        laneTitle: lane.title || fileName,
        fileName
      });
    }
    for (const arch of parsed.archivedItems) {
      results.push({
        task: {
          ...arch,
          swimLaneId: lane.id,
          sourceFileName: fileName
        },
        laneTitle: lane.title || fileName,
        fileName
      });
    }
    globalOffset += parsed.items.length;
  }
  return results;
}

/**
 * Assembles a structured DiscoveryJobPayload object containing the target task
 * straight from the user and delineated entries for every related task discovered.
 */
export function buildDiscoveryJobPayload(
  targetTask: TaskItem,
  relevantTaskIds: (string | number)[],
  swimLanesOrTodo: SwimLaneDoc[] | string | undefined,
  todoFallback: string = ''
): DiscoveryJobPayload {
  const allWorkspaceEntries = extractAllWorkspaceTasks(swimLanesOrTodo, todoFallback);
  const totalTasksScanned = allWorkspaceEntries.length;
  const laneCount = Array.isArray(swimLanesOrTodo) && swimLanesOrTodo.length > 0 ? swimLanesOrTodo.length : 1;

  const additionalContext: DiscoveredTaskContextEntry[] = [];

  for (const id of relevantTaskIds) {
    const entry = allWorkspaceEntries.find((e) => e.task.id === id);
    if (!entry) continue;
    const { task, fileName, laneTitle } = entry;
    additionalContext.push({
      taskId: task.id,
      title: task.title,
      category: task.category,
      status: task.status,
      isDone: Boolean(task.isDone),
      isArchived: Boolean(task.isArchived),
      sourceDocument: fileName,
      swimLaneTitle: laneTitle,
      subtasks: task.subtasks.map((s) => (typeof s === 'string' ? s : s.text))
    });
  }

  return {
    targetTask: {
      id: targetTask.id,
      title: targetTask.title,
      category: targetTask.category,
      status: targetTask.status,
      isDone: Boolean(targetTask.isDone),
      subtasks: targetTask.subtasks.map((s) => ({
        id: s.id,
        text: s.text,
        isDone: Boolean(s.isDone),
        isHumanReview: Boolean(s.isHumanReview)
      })),
      sourceFileName: targetTask.sourceFileName || 'TODO.md'
    },
    additionalContext,
    discoverySummary: {
      scannedDocumentCount: laneCount,
      totalTasksScanned,
      relevantTasksCount: additionalContext.length
    }
  };
}


/**
  * Assembles the concise, structured JSON "Bible Prompt" for Step 3 Manager AI.
  * Filters out raw document blobs and extracts only the essential task data,
  * the working brief, and scoped discovered context.
  */
export function buildManagerBiblePayload(
  discoveryPayload: DiscoveryJobPayload,
  overviewDoc: OverviewDocument,
  project: { name?: string; folderPath?: string } | undefined,
  connectedMcps: MCPServer[],
  allowedRoots: { name: string; path: string }[]
): ManagerBiblePayload {
  const activeMcps = connectedMcps
    .filter((m) => m.status === 'connected')
    .map((m) => m.name);

  const discoveredContext = discoveryPayload.additionalContext.map((c) => ({
    taskId: c.taskId,
    title: c.title,
    category: c.category,
    sourceDocument: c.sourceDocument,
    overviewSnippet: c.overview ? (c.overview.length > 250 ? c.overview.slice(0, 250) + '...' : c.overview) : undefined
  }));

  return {
    task: {
      id: discoveryPayload.targetTask.id,
      title: discoveryPayload.targetTask.title,
      category: discoveryPayload.targetTask.category,
      status: discoveryPayload.targetTask.status,
      subtasks: discoveryPayload.targetTask.subtasks.map((s) => ({
        id: s.id,
        text: s.text,
        isDone: s.isDone,
        isHumanReview: s.isHumanReview
      })),
      sourceFileName: discoveryPayload.targetTask.sourceFileName
    },
    overview: {
      spec: overviewDoc.raw,
      requiredMcps: discoveryPayload.requiredMcps || []
    },
    discoveredContext,
    environment: {
      projectName: project?.name || 'Default Workspace',
      projectPath: project?.folderPath || '~/.ergo',
      allowedRoots: allowedRoots.map((r) => r.path),
      activeMcps
    }
  };
}

/**
 * Formats the ManagerBiblePayload into a human-readable, structured Markdown master blueprint document.
 */
export function formatManagerBibleMarkdown(bible: ManagerBiblePayload): string {
  const sections: string[] = [];

  sections.push(`# TASK EXECUTION BIBLE: ${bible.task.title}\n`);

  sections.push(`## Metadata`);
  sections.push(`- **Task ID**: #${bible.task.id}`);
  sections.push(`- **Category**: ${bible.task.category || 'General'}`);
  sections.push(`- **Status**: ${bible.task.status || 'todo'}`);
  if (bible.task.sourceFileName) sections.push(`- **Source Document**: ${bible.task.sourceFileName}`);
  sections.push(`- **Project**: ${bible.environment.projectName} (${bible.environment.projectPath})\n`);

  sections.push(`## Target Task & Subtasks`);
  if (bible.task.subtasks && bible.task.subtasks.length > 0) {
    bible.task.subtasks.forEach((s) => {
      sections.push(`- [${s.isDone ? 'x' : ' '}] ${s.text}${s.isHumanReview ? ' **[Human Review]**' : ''}`);
    });
  } else {
    sections.push(`- [ ] ${bible.task.title}`);
  }
  sections.push('');

  sections.push(`## Working Brief (the Summary step's spec)`);
  sections.push(bible.overview.spec.trim() + '\n');

  sections.push(`## Run Environment`);
  sections.push(`- **Required MCPs**: ${bible.overview.requiredMcps && bible.overview.requiredMcps.length > 0 ? bible.overview.requiredMcps.join(', ') : '(none - pure reasoning/text)'}`);
  sections.push(`- **Allowed Boundaries**: ${bible.environment.allowedRoots.join(', ') || bible.environment.projectPath}\n`);

  if (bible.discoveredContext && bible.discoveredContext.length > 0) {
    sections.push(`## Discovered Context References`);
    bible.discoveredContext.forEach((ctx) => {
      sections.push(`- **Task #${ctx.taskId} (${ctx.title})** [from \`${ctx.sourceDocument}\` / ${ctx.category}]: ${ctx.overviewSnippet || 'Referenced for context.'}`);
    });
    sections.push('');
  }

  sections.push(`## Execution Event Log (Append-Only)`);
  sections.push(`- Task initialized at ${new Date().toISOString()}`);

  return sections.join('\n');
}

/**
 * Offline / no-provider fallback execution.
 * Simulates the pipeline with dummy steps for demo and development purposes.
 */
export async function runOfflineExecution(
  task: TaskItem,
  brief: AgentContextItem | undefined,
  project: ProjectData | undefined,
  connectedMcps: MCPServer[],
  onStepUpdate: (step: ExecutionStep) => void,
  onRequestPermission?: (prompt: McpToolPermissionPrompt) => Promise<PermissionDecision>,
  onRequestHumanInput?: (prompt: HumanInputPrompt) => Promise<string>
): Promise<{ updatedBrief: AgentContextItem; updatedTask: TaskItem }> {
  console.log(
    '%c[Ergo Agent Pipeline] ── Step 1: User Task/Selection Sent to Discovery AI (Offline Mode) ──',
    'color: #38bdf8; font-weight: bold; font-size: 13px;'
  );
  console.log('📌 Target Task Payload:', {
    id: task.id,
    title: task.title,
    category: task.category,
    status: task.status,
    isDone: Boolean(task.isDone),
    subtasks: task.subtasks.map((s) => ({ id: s.id, text: s.text, isDone: s.isDone, isHumanReview: s.isHumanReview })),
    sourceFileName: task.sourceFileName || 'TODO.md'
  });

  const discoveryPayload = buildDiscoveryJobPayload(
    task,
    [],
    project?.swimLanes,
    project?.todoMarkdown
  );

  console.log(
    '%c[Ergo Agent Pipeline] ── Step 2: Discovery AI Output (Plain JSON Payload - Offline Mode) ──',
    'color: #06b6d4; font-weight: bold; font-size: 13px;'
  );
  console.log('📦 Discovery Plain JSON Object:', discoveryPayload);
  console.log('📄 Stringified Discovery Payload:\n' + JSON.stringify(discoveryPayload, null, 2));

  const toolName = (task.title.toLowerCase().includes('vscode') || task.title.toLowerCase().includes('editor') || task.title.toLowerCase().includes('markdown'))
    ? 'write_file'
    : (task.title.toLowerCase().includes('git') || task.title.toLowerCase().includes('commit'))
      ? 'git_status'
      : (task.title.toLowerCase().includes('fetch') || task.title.toLowerCase().includes('web') || task.title.toLowerCase().includes('api'))
        ? 'fetch_markdown'
        : (connectedMcps[0]?.tools[0]?.name || 'read_file');

  const targetServerId = toolName.startsWith('git_')
    ? 'mcp-git'
    : toolName.startsWith('fetch_')
      ? 'mcp-fetch'
      : toolName.includes('file') || toolName.includes('directory')
        ? 'mcp-filesystem'
        : (connectedMcps[0]?.id || 'mcp-filesystem');

  const overviewDoc: OverviewDocument = { raw: buildOfflineTaskBrief(task, brief?.overview || '') };
  const requiredMcps = resolveRequiredMcps(task, brief, connectedMcps, undefined);

  discoveryPayload.overview = overviewDoc;
  discoveryPayload.requiredMcps = requiredMcps;

  console.log(
    '%c[Ergo Agent Pipeline] ── Step 2: Summary AI Output (Updated JSON Payload - Offline Mode) ──',
    'color: #f59e0b; font-weight: bold; font-size: 13px;'
  );
  console.log('📦 Updated Job JSON Object (Summary & MCP Plan Added):', discoveryPayload);
  console.log('📄 Stringified Updated Payload:\n' + JSON.stringify(discoveryPayload, null, 2));

  const managerBible = buildManagerBiblePayload(
    discoveryPayload,
    overviewDoc,
    project || { name: 'Default Workspace', folderPath: '~/.ergo' },
    connectedMcps,
    [{ name: 'Workspace', path: project?.folderPath || '~/.ergo' }]
  );

  const markdownBible = formatManagerBibleMarkdown(managerBible);
  console.log(
    '%c[Ergo Agent Pipeline] ── Step 3: Manager AI Bible Prompt (Offline Mode - Markdown) ──',
    'color: #10b981; font-weight: bold; font-size: 13px;'
  );
  console.log('📖 Manager Bible Payload (Offline):', managerBible);
  console.log('📄 Formatted Markdown Bible (Offline):\n' + markdownBible);

  const totalScanned = discoveryPayload.discoverySummary.totalTasksScanned;
  const offlineSteps: Partial<ExecutionStep>[] = [
    { id: 'step-1', stage: 'context', title: 'Discovery AI: Reading Shared Context & Scanning All Documents', detail: `Scanning all task headers and workspace documents for #${task.id}: "${task.title}" (Found ${totalScanned} workspace tasks across all swim lanes & archives)...`, status: 'running' },
    { id: 'step-2', stage: 'mcp_call', title: `Executing MCP Tool (${targetServerId} / ${toolName})`, detail: `Resolving tool dependencies and executing ${toolName}() across safe roots...`, mcpToolUsed: toolName, status: 'pending' },
    { id: 'step-3', stage: 'execution', title: 'Manager AI: Executing Puzzle Pieces & Implementation Steps', detail: `Processing the working brief & subtasks: ${task.subtasks.map((s) => s.text).join('; ') || 'Implementing core logic'}`, status: 'pending' },
    { id: 'step-4', stage: 'built_record', title: 'Rendering Interactive MCP App Widget', detail: 'Building visual interactive UI result and code diff preview...', status: 'pending', widgetType: getWidgetTypeForTask(task), widgetData: getWidgetDataForTask(task) },
    { id: 'step-5', stage: 'done', title: 'Recording the completion log & updating TODO.md', detail: 'Recording Built decisions, Validation results, and marking task as completed.', status: 'pending' }
  ];

  onStepUpdate({
    id: offlineSteps[0].id!,
    time: new Date().toLocaleTimeString(),
    stage: offlineSteps[0].stage!,
    title: 'Discovery AI: Context Identified',
    detail: `Scanned ${totalScanned} task headers across all swim lanes & archives. Loaded task #${task.id} & parsed brief constraints.`,
    status: 'success',
    discoveryPayload,
    usage: { inputTokens: 410, outputTokens: 90, cachedInputTokens: 0, cacheWriteTokens: 0, calls: 1 },
    totalUsage: { inputTokens: 410, outputTokens: 90, cachedInputTokens: 0, cacheWriteTokens: 0, calls: 1 }
  });
  onStepUpdate({
    id: 'step-overview',
    time: new Date().toLocaleTimeString(),
    stage: 'overview',
    title: 'Summary AI: Working Brief Ready',
    detail: `Working brief written (offline: the task's own checklist)${discoveryPayload.requiredMcps.length > 0 ? ` (MCPs: ${discoveryPayload.requiredMcps.join(', ')})` : ''}`,
    status: 'success',
    overviewDocument: overviewDoc,
    discoveryPayload,
    usage: { inputTokens: 520, outputTokens: 160, cachedInputTokens: 300, cacheWriteTokens: 0, calls: 1 },
    totalUsage: { inputTokens: 930, outputTokens: 250, cachedInputTokens: 300, cacheWriteTokens: 0, calls: 2 }
  });

  const matchingServer = connectedMcps.find((s) => s.id === targetServerId);
  const matchingTool = matchingServer?.tools.find((t) => t.name === toolName);
  const requiresPermission = matchingTool ? !matchingTool.autoApprove : (toolName === 'write_file' || toolName === 'git_commit');

  if (requiresPermission && onRequestPermission) {
    onStepUpdate({ id: offlineSteps[1].id!, time: new Date().toLocaleTimeString(), stage: offlineSteps[1].stage!, title: `Prompting User Permission: ${toolName}()`, detail: `Waiting for user authorization to execute ${targetServerId} / ${toolName}...`, mcpToolUsed: toolName, status: 'running' });
    const approved = await onRequestPermission({ id: `perm-${Date.now()}`, serverId: targetServerId, serverName: matchingServer?.name || targetServerId, toolName, args: { path: `projects/default-workspace/TODO.md` }, summary: `Execute tool "${toolName}" on MCP server "${matchingServer?.name || targetServerId}" with user-approved parameters.` });
    if (!approved) {
      onStepUpdate({ id: offlineSteps[1].id!, time: new Date().toLocaleTimeString(), stage: offlineSteps[1].stage!, title: `Permission Denied for ${toolName}()`, detail: `User skipped or rejected tool execution. Falling back to read-only simulation.`, mcpToolUsed: toolName, status: 'warning' });
    }
  }

  // Simulate mid-build interactive clarification if task requests it
  if (onRequestHumanInput && (task.title.toLowerCase().includes('clarify') || task.title.toLowerCase().includes('choice') || task.title.toLowerCase().includes('prompt') || task.title.toLowerCase().includes('input'))) {
    const inputStepId = 'step-offline-human-input';
    const promptData: HumanInputPrompt = {
      id: `offline-prompt-${task.id}`,
      taskId: task.id,
      question: `Which configuration or approach should be applied for "${task.title}"?`,
      options: ['Option A (Recommended Default)', 'Option B (Alternative Strategy)', 'Option C (Minimal Setup)'],
      context: 'The Manager AI needs user clarification on which path to take before proceeding.',
      allowFreeform: true
    };
    onStepUpdate({
      id: inputStepId,
      time: new Date().toLocaleTimeString(),
      stage: 'human_input',
      title: 'Clarification Needed: Question from Manager AI',
      detail: promptData.question,
      status: 'running',
      humanInputPrompt: promptData
    });
    const ans = await onRequestHumanInput(promptData);
    onStepUpdate({
      id: inputStepId,
      time: new Date().toLocaleTimeString(),
      stage: 'human_input',
      title: 'Human Clarification Provided',
      detail: `User response: "${ans}"`,
      status: 'success',
      humanInputPrompt: undefined
    });
  }

  onStepUpdate({ id: offlineSteps[1].id!, time: new Date().toLocaleTimeString(), stage: offlineSteps[1].stage!, title: offlineSteps[1].title!, detail: offlineSteps[1].detail!, mcpToolUsed: toolName, status: 'running' });
  let toolResultDetail = `Executed ${toolName}() via MCP stdio/HTTP bridge.`;
  try {
    const toolExec = await callMcpTool(targetServerId, toolName, { path: 'projects/default-workspace/TODO.md', url: 'https://modelcontextprotocol.io' });
    if (toolExec.success) toolResultDetail = `MCP tool ${toolName}() returned 200 OK across safe root sandbox.`;
  } catch {}
  await new Promise((r) => setTimeout(r, 600));
  onStepUpdate({ id: offlineSteps[1].id!, time: new Date().toLocaleTimeString(), stage: offlineSteps[1].stage!, title: offlineSteps[1].title!, detail: toolResultDetail, mcpToolUsed: toolName, status: 'success' });

  onStepUpdate({ id: offlineSteps[2].id!, time: new Date().toLocaleTimeString(), stage: offlineSteps[2].stage!, title: offlineSteps[2].title!, detail: offlineSteps[2].detail!, status: 'running' });
  await new Promise((r) => setTimeout(r, 800));
  onStepUpdate({ id: offlineSteps[2].id!, time: new Date().toLocaleTimeString(), stage: offlineSteps[2].stage!, title: offlineSteps[2].title!, detail: `Completed implementation of ${task.subtasks.length || 1} subtasks. All unit checks green.`, status: 'success' });

  onStepUpdate({ id: offlineSteps[3].id!, time: new Date().toLocaleTimeString(), stage: offlineSteps[3].stage!, title: offlineSteps[3].title!, detail: offlineSteps[3].detail!, status: 'running', widgetType: offlineSteps[3].widgetType, widgetData: offlineSteps[3].widgetData });
  await new Promise((r) => setTimeout(r, 900));
  onStepUpdate({ id: offlineSteps[3].id!, time: new Date().toLocaleTimeString(), stage: offlineSteps[3].stage!, title: offlineSteps[3].title!, detail: 'Interactive MCP App widget rendered live in sandbox.', status: 'success', widgetType: offlineSteps[3].widgetType, widgetData: offlineSteps[3].widgetData });

  onStepUpdate({ id: offlineSteps[4].id!, time: new Date().toLocaleTimeString(), stage: offlineSteps[4].stage!, title: offlineSteps[4].title!, detail: offlineSteps[4].detail!, status: 'running' });
  await new Promise((r) => setTimeout(r, 800));

  const buildDate = new Date().toISOString().split('T')[0];
  const overviewContent = brief?.overview || brief?.brief || `Task #${task.id} (${task.title}) overview in context.`;
  const buildVerificationContent = brief?.buildAndVerification || brief?.built
    ? `${brief.buildAndVerification || brief.built}\n\n**Mid-Task Build Journey (${buildDate}):**\n1. Inspected seams and context for #${task.id} (${task.title}).\n2. Applied implementation changes in dependency order.\n3. Ran automated verification suite.`
    : `**Mid-Task Build Journey (${buildDate}):**\n1. Inspected seams and context for #${task.id} (${task.title}).\n2. Applied implementation changes in dependency order.\n3. Ran automated verification suite.`;

  // Preserve any human review subtasks from original task or generate for complex tasks
  const hasHumanReview =
    Boolean(task.isHumanReview) ||
    task.title.toLowerCase().includes('review') ||
    task.subtasks.some((s) => s.isHumanReview || s.text.toLowerCase().includes('human review'));

  const reviewSubtasks: Subtask[] = task.subtasks.filter((s) => s.isHumanReview);
  if (hasHumanReview && reviewSubtasks.length === 0) {
    reviewSubtasks.push({
      id: `${task.id}-hr-1`,
      text: `Verify changes for "${task.title}" in workspace`,
      isDone: false,
      isHumanReview: true
    });
  }

  const executedSubtasks = task.subtasks
    .filter((s) => !s.isHumanReview)
    .map((s) => ({ ...s, isDone: true }));

  const allSubtasks = [...executedSubtasks, ...reviewSubtasks];

  let completionContent = brief?.completion || brief?.validation || brief?.humanReview || brief?.followUps
    ? `${brief.completion || brief.validation || brief.humanReview || brief.followUps}\n\n**Completion Summary (${buildDate}):**\n- Implemented all subtasks for task #${task.id}.\n- Verified 100% pass rate with 0 regressions.\n- Current Status: ${reviewSubtasks.length > 0 ? 'Partly Done (Human Review Pending)' : 'Done / Verified'}.`
    : `**Completion Summary (${buildDate}):**\n- Implemented all subtasks for task #${task.id}.\n- Verified 100% pass rate with 0 regressions.\n- Current Status: ${reviewSubtasks.length > 0 ? 'Partly Done (Human Review Pending)' : 'Done / Verified'}.`;

  if (reviewSubtasks.length > 0 && !completionContent.toLowerCase().includes('human review')) {
    completionContent += `\n\n**Human Review Required:**\n` + reviewSubtasks.map((s) => `- [ ] **human review** - ${s.text}`).join('\n');
  }

  const sampleCreatedFiles = [`projects/default-workspace/src/${task.title.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 20)}.ts`];
  if (!completionContent.toLowerCase().includes('created file') && !completionContent.toLowerCase().includes('artifacts')) {
    completionContent += `\n\n**Created Files & Artifacts:**\n` + sampleCreatedFiles.map((f) => `- [${f}](${f})`).join('\n');
  }

  const updatedBrief: AgentContextItem = {
    ...brief,
    id: brief?.id || `brief_${task.id}`,
    sourceTaskId: task.id,
    sourceLaneId: task.swimLaneId || brief?.sourceLaneId,
    itemNumber: brief?.itemNumber,
    title: task.title,
    status: reviewSubtasks.length > 0 ? 'partly_done' : 'done',
    overview: overviewContent,
    buildAndVerification: buildVerificationContent,
    completion: completionContent,
    createdFiles: sampleCreatedFiles,
    brief: overviewContent,
    built: buildVerificationContent,
    validation: completionContent,
    humanReview: completionContent,
    followUps: completionContent,
    totalUsage: { inputTokens: 1450, outputTokens: 420, cachedInputTokens: 300, cacheWriteTokens: 0, calls: 3 }
  };
  const updatedTask: TaskItem = {
    ...task,
    status: reviewSubtasks.length > 0 ? 'partly_done' : 'done',
    isDone: reviewSubtasks.length === 0,
    isHumanReview: hasHumanReview,
    createdFiles: sampleCreatedFiles,
    totalUsage: { inputTokens: 1450, outputTokens: 420, cachedInputTokens: 300, cacheWriteTokens: 0, calls: 3 },
    subtasks: allSubtasks.length > 0 ? allSubtasks : task.subtasks.map((s) => ({ ...s, isDone: true }))
  };

  onStepUpdate({
    id: offlineSteps[4].id!,
    time: new Date().toLocaleTimeString(),
    stage: offlineSteps[4].stage!,
    title: reviewSubtasks.length > 0 ? 'Task Built — Human Review Pending' : 'Task Execution Completed Successfully!',
    detail: reviewSubtasks.length > 0
      ? `Task #${task.id} changes recorded in TODO.md with Human Review verification step(s).`
      : `Item #${task.id} marked DONE in TODO.md. Concise output & learnings saved to vector memory.`,
    status: 'success',
    totalUsage: { inputTokens: 1450, outputTokens: 420, cachedInputTokens: 300, cacheWriteTokens: 0, calls: 3 }
  });

  return { updatedBrief, updatedTask };
}

function getWidgetTypeForTask(task: TaskItem): ExecutionStep['widgetType'] {
  const title = task.title.toLowerCase();
  if (title.includes('vscode') || title.includes('vs code') || title.includes('editor') || title.includes('markdown')) return 'vscode_preview';
  if (title.includes('funnel') || title.includes('analytics') || title.includes('drop')) return 'analytics_chart';
  if (title.includes('slack') || title.includes('dispatch') || title.includes('announcement')) return 'slack_draft';
  if (title.includes('figma') || title.includes('hero') || title.includes('banner')) return 'figma_preview';
  if (title.includes('bluebeam') || title.includes('pdf') || title.includes('compare')) return 'bluebeam_diff';
  return 'code_diff';
}

function getWidgetDataForTask(task: TaskItem) {
  const widgetType = getWidgetTypeForTask(task);
  if (widgetType === 'vscode_preview') {
    return { editorFile: 'TODO.md', activeLine: 18, commandExecuted: 'edit_active_document', connectionStatus: 'Active Stdio Bridge (vscode-ipc://ergo-vscode-bridge)', selectionRange: 'Lines 15-24', diffLines: ['  14 | - ~~comparisons between revisions~~', '+ 15 | 1. **conditions:** [VS Code MCP Active Target]', '+ 16 |     - search feature in schedules panel (driven via VS Code MCP)', '+ 17 |     - **human review** - verify condition details in VS Code active tab'] };
  }
  if (widgetType === 'analytics_chart') {
    return { title: 'Signup Conversion Funnel (Q2 2026)', dropoffRate: '34.2%', step1: { name: 'Landing Page Visit', users: 14200 }, step2: { name: 'Account Creation', users: 8900 }, step3: { name: 'Workspace Init', users: 5850 } };
  }
  if (widgetType === 'slack_draft') {
    return { channel: '#product-announcements', sender: 'Ergo Agent Bot', message: `🚀 **Campaign Launch Digest**: All Q3 assets are deployed to Google Drive! Conversion analytics are now live in Amplitude.` };
  }
  if (widgetType === 'bluebeam_diff') {
    return { sheetNumber: 'A-101', sheetTitle: 'FIRST FLOOR PLAN - ADDENDUM 2', changedRegionsCount: 3, changeScore: 0.88, affectedConditions: ['72. Unilock ARTLINE UMBRIANO', '90. Foreverlawn Turf'] };
  }
  return { filename: 'lib/schedules.js', diffLines: ['- const schedFilter = activeSchedKey;', '+ const treeNodes = buildTree(treeModel);', '+ filterNodesByQuery(treeNodes, searchQuery);'] };
}

