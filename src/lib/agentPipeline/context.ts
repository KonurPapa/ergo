/**
 * Step 1 — Zero-Token Context Assembly
 *
 * Replaces the token-consuming Discovery LLM agent with a fast, deterministic,
 * zero-token context assembler. Queries the local vector memory store for relevant
 * past learnings, architectural patterns, and completed task insights, reads
 * project guidelines (AGENTS.md / CLAUDE.md), and formats the baseline Markdown
 * handed directly to the Summary AI.
 */
import { searchMemory, type SearchResult } from '../memory';
import { callMcpTool } from '../mcpClient';
import { type AssembledBaselineContext } from '../../types';
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
    const res = await fetch('/api/files/read', {
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

function connectedServerLines(ctx: PipelineContext): string[] {
  return ctx.connectedMcps
    .filter((m) => m.status === 'connected')
    .map((m) => `- ${m.name} (id: ${m.id}) — tools: ${m.tools.map((t) => t.name).join(', ')}`);
}

/** Builds the compact Markdown baseline context handed directly to the Summary AI. */
function buildBaselineMarkdown(
  ctx: PipelineContext,
  guidelines: GuidelineDoc[],
  memoryHits: SearchResult[]
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
  out.push('');

  const existingBrief = cap(brief?.overview || brief?.brief, 1500);
  if (existingBrief) {
    out.push('## Existing Brief', existingBrief, '');
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
      const taskTitle = hit.chunk.metadata.taskTitle ? ` [Task: ${hit.chunk.metadata.taskTitle}]` : '';
      out.push(`- **[${sim} match${tags}${source}${taskTitle}]**: ${hit.chunk.text}`);
    }
    out.push('');
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
  const servers = connectedServerLines(ctx);
  out.push('- **Connected MCP servers**:');
  if (servers.length > 0) out.push(...servers.map((l) => `  ${l}`));
  else out.push('  - (none connected)');
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
    detail: 'Querying local vector store and project guidelines at 0 token cost…',
    status: 'running'
  });

  // 1. Local Vector Memory semantic search (0 tokens)
  let memoryHits: SearchResult[] = [];
  const query = `${task.title} ${task.category || ''} ${task.subtasks.map((s) => s.text).join(' ')}`.trim();
  try {
    memoryHits = await searchMemory(query, {
      topK: MEMORY_SEARCH_LIMIT,
      minSimilarity: MEMORY_SEARCH_THRESHOLD,
      projectId: ctx.project.id,
      excludeTaskId: task.id,
    });
  } catch (err) {
    console.warn('[Ergo Context] Vector memory search failed (non-fatal):', err);
  }

  throwIfAborted(ctx.signal);

  // 2. Read local guideline files (0 tokens)
  const guidelines = await readGuidelineFiles(ctx);
  throwIfAborted(ctx.signal);

  // 3. Assemble baseline markdown
  const baselineMarkdown = buildBaselineMarkdown(ctx, guidelines, memoryHits);

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
    timestamp: new Date().toISOString()
  };

  ctx.emit({
    id: 'step-context',
    stage: 'context',
    title: 'Vector Memory: Baseline Context Assembled',
    detail:
      (memoryHits.length > 0
        ? `Retrieved ${memoryHits.length} relevant memory hit(s) from local vector DB (cutoff ≥ ${(MEMORY_SEARCH_THRESHOLD * 100).toFixed(0)}%, 0 tokens). `
        : `No prior memory hits above ${(MEMORY_SEARCH_THRESHOLD * 100).toFixed(0)}% threshold. `) +
      (guidelines.length > 0 ? `Guidelines: ${guidelines.map((g) => g.path).join(', ')}.` : 'No guideline files found.'),
    status: 'success',
    usage: emptyUsage(),
    baselineContext: assembledBaselineContext
  });

  return { baselineMarkdown, guidelines, memoryHits };
}
