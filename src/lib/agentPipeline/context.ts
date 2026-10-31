/**
 * Step 1 — Zero-Token Context Assembly
 *
 * Replaces the token-consuming Discovery LLM agent with a fast, deterministic,
 * zero-token context assembler. Queries the local vector memory store for relevant
 * past learnings, architectural patterns, and completed task insights, reads
 * project guidelines (AGENTS.md / CLAUDE.md), and formats the baseline Markdown
 * handed directly to the Summary AI.
 */
import { hasUsableOverview } from '../overviewUtils';
import { searchMemory, type SearchResult } from '../memory';
import { findRelatedTasks, formatRelatedCandidatesForPrompt } from '../memory/relatedTasks';
import { describeProjectRules } from '../memory/insights';
import { withScopedRules } from '../scopedRules';
import type { ProjectInsight, RelatedNoteCandidate, RelatedTaskCandidate, RelatedTasksRequest, RelatedTasksResponse } from '../memory/types';
import { callMcpTool } from '../mcpClient';
import { type AgentContextItem, type AssembledBaselineContext, type ExecutionStep, type TaskItem } from '../../types';
import { bridgeClient } from '../bridgeClient';
import {
  GUIDELINE_EXCERPT_CHAR_CAP,
  type PipelineContext,
  emptyUsage,
  throwIfAborted
} from './contracts';

export interface GuidelineDoc {
  path: string;
  excerpt: string;
}

export interface BaselineContext {
  baselineMarkdown: string;
  guidelines: GuidelineDoc[];
  memoryHits: SearchResult[];
  /** Stage 1 of related-task matching (local, zero tokens); the Summary step selects from these. */
  relatedCandidates: RelatedTaskCandidate[];
  relatedNotes: RelatedNoteCandidate[];
  /** The related-task search ran (false: the memory bridge was unreachable, so no selection is possible). */
  relatedSearchOk: boolean;
  /** The project's learned rules for this task (same bridge call): in the brief writer's input and the bible. */
  projectRules: ProjectInsight[];
  /** The context step as emitted, so the Summary step can re-emit it with its related-task selection. */
  contextStep: Pick<ExecutionStep, 'title' | 'detail' | 'time'> & { baselineContext: AssembledBaselineContext };
}

const RELATED_TOP_K = 10;
const MAX_RELATED_QUERY_SUBTASKS = 12;
const MAX_RELATED_QUERY_TEXT = 600;

/** The related-tasks query for a task: title, subtasks, and its summary note or freeform source text. */
export function buildRelatedTasksRequest(
  projectId: string,
  task: Pick<TaskItem, 'id' | 'title' | 'subtasks' | 'summaryNote'>,
  brief?: Pick<AgentContextItem, 'sourceContent'> | null
): RelatedTasksRequest {
  const extra = (task.summaryNote || '').trim() || (brief?.sourceContent || '').trim();
  return {
    projectId,
    taskId: String(task.id),
    title: task.title,
    subtasks: (task.subtasks || [])
      .map((s) => s.text.trim())
      .filter(Boolean)
      .slice(0, MAX_RELATED_QUERY_SUBTASKS),
    ...(extra && extra !== task.title.trim() ? { text: extra.slice(0, MAX_RELATED_QUERY_TEXT) } : {}),
    topK: RELATED_TOP_K,
  };
}

const RELATED_SEARCH_TIMEOUT_MS = 20_000;

/**
 * findRelatedTasks that never blocks a run for long: resolves as a failed search (no candidates) after a timeout
 * (the bridge may still be loading its embedding model) or when `signal` aborts. Never throws.
 */
export async function findRelatedTasksSoft(
  req: RelatedTasksRequest,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<RelatedTasksResponse> {
  const failed: RelatedTasksResponse = { success: false, candidates: [], notes: [], searched: 0 };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const cutoff = new Promise<RelatedTasksResponse>((resolve) => {
    timer = setTimeout(() => resolve(failed), opts.timeoutMs ?? RELATED_SEARCH_TIMEOUT_MS);
    if (opts.signal) {
      if (opts.signal.aborted) resolve(failed);
      onAbort = () => resolve(failed);
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([findRelatedTasks(req).catch(() => failed), cutoff]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
  }
}

/** Context-step detail line for the related-task search. */
export function describeRelatedSearch(res: { success: boolean; candidates: unknown[]; notes: unknown[]; searched: number }): string {
  if (!res.success) return 'Related-task search unavailable (memory bridge offline).';
  if (res.candidates.length === 0) {
    return `No related tasks among ${res.searched} workspace item(s).`;
  }
  return (
    `${res.candidates.length} candidate related task(s) among ${res.searched} workspace item(s)` +
    `${res.notes.length > 0 ? ` + ${res.notes.length} note(s)` : ''} (local search, 0 tokens).`
  );
}

const GUIDELINE_FILENAMES = ['AGENTS.md', 'CLAUDE.md'];
const MEMORY_SEARCH_LIMIT = 4;
const MEMORY_SEARCH_THRESHOLD = 0.45;

function excerpt(content: string, fullPath: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= GUIDELINE_EXCERPT_CHAR_CAP) return trimmed;
  return `${trimmed.slice(0, GUIDELINE_EXCERPT_CHAR_CAP)}\n…[truncated; full file at ${fullPath}]`;
}

/** Reads AGENTS.md / CLAUDE.md from the project folder and every non-default allowed root. Never throws. */
async function readGuidelineFiles(ctx: PipelineContext): Promise<GuidelineDoc[]> {
  const docs: GuidelineDoc[] = [];
  const seen = new Set<string>();

  // (a) Project folder (relative to the storage root)
  const projectPaths = GUIDELINE_FILENAMES.map((f) => `${ctx.project.folderPath}/${f}`);
  try {
    const res = await fetch(bridgeClient.getApiUrl('/api/files/read'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePaths: projectPaths })
    });
    if (res.ok) {
      const data = await res.json();
      for (const fp of projectPaths) {
        const content = data?.files?.[fp];
        if (typeof content === 'string' && content.trim() && !seen.has(fp)) {
          seen.add(fp);
          docs.push({ path: fp, excerpt: excerpt(content, fp) });
        }
      }
    }
  } catch {}

  // (b) Non-default allowed roots (user's real codebases) — via the filesystem harness
  for (const root of ctx.allowedRoots) {
    if (root.isDefault) continue;
    for (const f of GUIDELINE_FILENAMES) {
      const fp = `${root.path.replace(/\/+$/, '')}/${f}`;
      if (seen.has(fp)) continue;
      try {
        const res = await callMcpTool('mcp-filesystem', 'read_file', { path: fp, limit: 120 });
        const content = res.success ? res.data?.content : undefined;
        if (typeof content === 'string' && content.trim()) {
          seen.add(fp);
          docs.push({ path: fp, excerpt: excerpt(content, fp) });
        }
      } catch {}
    }
  }
  return docs;
}

function subtaskLine(s: { text: string; isDone: boolean; isHumanReview?: boolean }): string {
  return `- [${s.isDone ? 'x' : ' '}] ${s.text}${s.isHumanReview ? ' [Human Review]' : ''}`;
}

function cap(text: string | undefined, max: number): string {
  if (!text) return '';
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Builds the compact Markdown baseline context handed directly to the Summary AI. */
function buildBaselineMarkdown(
  ctx: PipelineContext,
  guidelines: GuidelineDoc[],
  memoryHits: SearchResult[],
  relatedCandidates: RelatedTaskCandidate[],
  relatedNotes: RelatedNoteCandidate[],
  projectRules: ProjectInsight[]
): string {
  const { task, brief, project } = ctx;
  const out: string[] = [];
  out.push(`# BASELINE CONTEXT: ${task.title}`, '');
  out.push('## Target Task');
  out.push(`- **ID**: #${task.id}`);
  out.push(`- **Title**: ${task.title}`);
  out.push(`- **Category**: ${task.category || 'General'}`);
  out.push(`- **Status**: ${task.status || 'not_started'}`);
  out.push(`- **Source document**: ${task.sourceFileName || 'TODO.md'}`);
  if (task.subtasks.length > 0) {
    out.push('- **Subtasks**:');
    for (const s of task.subtasks) out.push(`  ${subtaskLine(s)}`);
  } else {
    out.push('- **Subtasks**: (none)');
  }

  const userSelectedTools = Array.from(new Set([
    ...(task.mcpRequired || []),
    ...(brief?.requiredMcps || []),
    ...(brief?.selectedMcpTools || [])
  ]));
  if (userSelectedTools.length > 0) {
    out.push(`- **Configured MCP Tools**: ${userSelectedTools.map((t) => `\`${t}\``).join(', ')} (explicitly selected for this task)`);
  }
  out.push('');

  const sourceContent = cap(brief?.sourceContent, 2000);
  if (sourceContent && sourceContent.trim() !== task.title.trim()) {
    out.push('## Task Description', sourceContent, '');
  }

  // Unstamped drafts are still useful input for the Summary agent; only their label differs.
  const existingBrief = cap(brief?.overview || brief?.brief, 1500);
  if (existingBrief) {
    out.push(hasUsableOverview(brief) ? '## Existing Brief' : '## Draft Notes', existingBrief, '');
  }

  const existingBuild = cap(brief?.buildAndVerification || brief?.built, 2000);
  if (existingBuild) {
    out.push('## Prior Progress & Build Notes', existingBuild, '');
  }

  const isResuming = task.status === 'partly_done' || brief?.status === 'partly_done' || Boolean(existingBuild);
  const knownFiles = Array.from(new Set([...(task.createdFiles || []), ...(brief?.createdFiles || [])]));

  if (isResuming) {
    out.push(
      '## Resume Instructions',
      'This task was stopped partway through and is being RESUMED.',
      'Pick back up where the task was left off: inspect existing workspace files, preserve all already-completed deliverables, and finish the remaining unfinished requirements.',
      ''
    );
    if (knownFiles.length > 0) {
      out.push(`- **Deliverable Files Already Created**: ${knownFiles.join(', ')}`, '');
    }
  }

  // Inject prior knowledge from local vector memory (0 tokens!)
  if (memoryHits.length > 0) {
    out.push('## Prior Knowledge & Architectural Learnings (Local Memory)');
    out.push('_Retrieved from local vector memory at zero token cost._');
    out.push('> [!NOTE]');
    out.push('> The following entries are historical reference notes from prior tasks and memory logs.');
    out.push('> They are strictly ADVISORY architectural references and are NOT requirements.');
    out.push('> You must NEVER drop, reduce, replace, or simplify any user requirements, game mechanics, or subtasks based on these prior notes.');
    out.push('');
    for (const hit of memoryHits) {
      const sim = `${(hit.similarity * 100).toFixed(0)}%`;
      const tags = hit.chunk.metadata.tags?.length ? ` [${hit.chunk.metadata.tags.join(', ')}]` : '';
      const source = hit.chunk.metadata.source ? ` (${hit.chunk.metadata.source})` : '';
      const meta = hit.chunk.metadata;
      const taskTitle = meta.taskTitle
        ? ` [Task: ${meta.taskTitle}]`
        : meta.title
          ? ` [${meta.kind ? `${meta.kind}: ` : ''}${meta.title}]`
          : '';
      out.push(`- **[${sim} match${tags}${source}${taskTitle}]**: ${hit.chunk.text}`);
    }
    out.push('');
  }

  // Learned rules: the brief reflects the ones that bear on the task; the bible carries the list verbatim.
  if (projectRules.length > 0) {
    out.push('## Project Rules (set by the user, or learned from their feedback on earlier runs)');
    out.push('_Reflect the rules that bear on this task in Constraints or Done when; every agent also gets this list verbatim._');
    out.push(...projectRules.map((r) => `- ${r.text}`), '');
  }

  // Stage 1 related-task candidates; the Summary agent picks the useful ones (stage 2, "relatedTaskIds").
  if (relatedCandidates.length > 0 || relatedNotes.length > 0) {
    out.push('## Candidate Related Tasks (choose the useful ones)');
    out.push('_Found by local similarity search of this project; many are only superficially similar. Ids in brackets._');
    out.push(formatRelatedCandidatesForPrompt(relatedCandidates, relatedNotes).trim(), '');
  }

  if (guidelines.length > 0) {
    out.push('## Project Guidelines');
    for (const g of guidelines) {
      out.push(`### ${g.path}`, '```', g.excerpt, '```');
    }
    out.push('');
  }

  out.push('## Environment');
  out.push(`- **Project**: ${project.name} (${project.folderPath})`);
  out.push(`- **Allowed boundaries**: ${ctx.allowedRoots.map((r) => r.path).join(', ') || project.folderPath}`);
  // Connected MCP servers are listed (with their tools) by the Summary step's own message. The in-app assistant's
  // workspace skills are not task context, so they stay out of the brief writer's input.

  return out.join('\n').trimEnd() + '\n';
}

/**
 * Deterministically assembles task context using local vector search and
 * project guideline files at ZERO API-token cost.
 */
export async function assembleTaskContext(ctx: PipelineContext): Promise<BaselineContext> {
  const { task } = ctx;

  ctx.emit({
    id: 'step-context',
    stage: 'context',
    title: 'Vector Memory: Assembling Baseline Context',
    detail: 'Finding related tasks, querying local vector store, and reading guidelines…',
    status: 'running'
  });

  // 1. Local Vector Memory semantic search + related-task candidates (both 0 tokens, run together)
  let memoryHits: SearchResult[] = [];
  const query = `${task.title} ${task.category || ''} ${task.subtasks.map((s) => s.text).join(' ')}`.trim();
  const [, related] = await Promise.all([
    searchMemory(query, {
      topK: MEMORY_SEARCH_LIMIT,
      minSimilarity: MEMORY_SEARCH_THRESHOLD,
      projectId: ctx.project.id,
      excludeTaskId: task.id,
      // Agents see their own working memory (run notes, saved findings) too; the archive UI doesn't.
      includeHidden: true,
    }).then(
      (hits) => {
        memoryHits = hits;
      },
      (err) => {
        console.warn('[Ergo Context] Vector memory search failed (non-fatal):', err);
      }
    ),
    findRelatedTasksSoft(buildRelatedTasksRequest(ctx.project.id, task, ctx.brief), { signal: ctx.signal }),
  ]);
  const relatedCandidates = related.candidates || [];
  const relatedNotes = related.notes || [];
  // Learned rules, plus the user's rules for every task and for this task's lane.
  const projectRules = withScopedRules(related.insights, task.swimLaneId ?? ctx.brief?.sourceLaneId);

  throwIfAborted(ctx.signal);

  // 2. Read local guideline files (0 tokens)
  const guidelines = await readGuidelineFiles(ctx);
  throwIfAborted(ctx.signal);

  // 3. Assemble baseline markdown
  const baselineMarkdown = buildBaselineMarkdown(ctx, guidelines, memoryHits, relatedCandidates, relatedNotes, projectRules);

  console.log('%c[Ergo Agent Pipeline] ── Step 1: Zero-Token Context Assembly (Vector DB + Guidelines) ──', 'color: #38bdf8; font-weight: bold; font-size: 13px;');
  console.log(baselineMarkdown);

  const assembledBaselineContext: AssembledBaselineContext = {
    query,
    threshold: MEMORY_SEARCH_THRESHOLD,
    projectId: ctx.project.id,
    memoryHits: memoryHits.map((h) => ({
      id: h.chunk.id,
      similarity: h.similarity,
      namespace: h.chunk.namespace,
      text: h.chunk.text,
      source: h.chunk.metadata.source,
      taskTitle: h.chunk.metadata.taskTitle,
      taskId: h.chunk.metadata.taskId,
      projectId: h.chunk.metadata.projectId,
      tags: h.chunk.metadata.tags
    })),
    guidelines: guidelines.map((g) => ({ path: g.path, excerpt: g.excerpt })),
    timestamp: new Date().toISOString(),
    relatedCandidates,
    relatedNotes
  };

  const contextStep = {
    title: 'Vector Memory: Baseline Context Assembled',
    detail:
      `${describeRelatedSearch(related)} ` +
      (projectRules.length > 0 ? `${describeProjectRules(projectRules)} ` : '') +
      (memoryHits.length > 0
        ? `Retrieved ${memoryHits.length} relevant memory hit(s) from local vector DB (cutoff ≥ ${(MEMORY_SEARCH_THRESHOLD * 100).toFixed(0)}%, 0 tokens). `
        : `No prior memory hits above ${(MEMORY_SEARCH_THRESHOLD * 100).toFixed(0)}% threshold. `) +
      (guidelines.length > 0 ? `Guidelines: ${guidelines.map((g) => g.path).join(', ')}.` : 'No guideline files found.'),
    time: new Date().toLocaleTimeString(),
    baselineContext: assembledBaselineContext
  };
  ctx.emit({
    id: 'step-context',
    stage: 'context',
    ...contextStep,
    status: 'success',
    usage: emptyUsage()
  });

  return { baselineMarkdown, guidelines, memoryHits, relatedCandidates, relatedNotes, relatedSearchOk: Boolean(related.success), projectRules, contextStep };
}
