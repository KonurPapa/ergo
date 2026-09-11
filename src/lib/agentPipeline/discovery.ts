/**
 * Step 1 — Discovery: fast, read-only reconnaissance on a lightweight model.
 *
 * Skims only the task header index (titles/categories/150-char snippets — never full bodies),
 * looks for project guideline files (AGENTS.md / CLAUDE.md), and assembles the compact Markdown
 * baseline context that Step 2 ingests. Pointers over payloads throughout.
 */
import { type DiscoveryJobPayload, type TokenUsage } from '../../types';
import { buildDiscoveryJobPayload, buildTaskHeaderIndex, extractAllWorkspaceTasks } from '../ai';
import { searchMemory, isEmbeddingReady, type SearchResult } from '../memory';
import { parseJsonLoose } from '../llmClient';
import { callMcpTool } from '../mcpClient';
import { GUIDELINE_EXCERPT_CHAR_CAP, type PipelineContext, addUsage, emptyUsage, isAbortError, resolveRoleTarget, throwIfAborted } from './contracts';
import { runToolLoop } from './providerLoop';
import { loadPipelineSkill } from './skills';

export interface DiscoveryResult {
  payload: DiscoveryJobPayload;
  baselineMarkdown: string;
  usage: TokenUsage;
  memoryHits: SearchResult[];
}

interface GuidelineDoc {
  path: string;
  excerpt: string;
}

const GUIDELINE_FILENAMES = ['AGENTS.md', 'CLAUDE.md'];

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

/** Builds the compact Markdown baseline context handed to the Summary AI. */
function buildBaselineMarkdown(ctx: PipelineContext, payload: DiscoveryJobPayload, guidelines: GuidelineDoc[], notes: string, memoryHits: SearchResult[]): string {
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

  if (payload.additionalContext.length > 0) {
    out.push('## Related Tasks (discovered)');
    for (const c of payload.additionalContext) {
      const flags = `${c.isArchived ? ' [ARCHIVED]' : ''}${c.isDone ? ' [DONE]' : ''}`;
      out.push(`### Task #${c.taskId}: ${c.title} (${c.category}) [${c.sourceDocument} / ${c.swimLaneTitle}]${flags}`);
      if (c.subtasks.length > 0) out.push(`- Subtasks: ${c.subtasks.join('; ')}`);
      if (c.overview) out.push(`- Overview: ${cap(c.overview, 600)}`);
      if (c.buildAndVerification) out.push(`- Build & Verification: ${cap(c.buildAndVerification, 600)}`);
      if (c.completion) out.push(`- Completion: ${cap(c.completion, 600)}`);
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

  if (notes) out.push('## Discovery Notes', notes, '');

  // Inject memory-first context (retrieved at 0 token cost from local vector DB)
  if (memoryHits.length > 0) {
    out.push('## Prior Knowledge (from Local Memory)');
    out.push('_The following was retrieved from the local vector memory database at zero token cost._');
    for (const hit of memoryHits) {
      const sim = `${(hit.similarity * 100).toFixed(0)}%`;
      const tags = hit.chunk.metadata.tags?.length ? ` [${hit.chunk.metadata.tags.join(', ')}]` : '';
      const source = hit.chunk.metadata.source ? ` (${hit.chunk.metadata.source})` : '';
      out.push(`- **[${sim} match${tags}${source}]**: ${hit.chunk.text.slice(0, 400)}`);
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

export async function runDiscovery(ctx: PipelineContext): Promise<DiscoveryResult> {
  const { task, project, aiConfig } = ctx;
  const usage = emptyUsage();

  ctx.emit({
    id: 'step-discovery',
    stage: 'context',
    agentRole: 'discovery',
    title: 'Discovery AI: Scanning Task Headers & Guidelines',
    detail: 'Querying local vector memory, skimming task headers across all swim lanes (active + archived), looking for AGENTS.md / CLAUDE.md, and detecting connected tools…',
    status: 'running'
  });

  // ── Memory-First: query local vector DB BEFORE any file exploration (0 tokens) ──
  let memoryHits: SearchResult[] = [];
  if (isEmbeddingReady()) {
    try {
      const query = `${task.title} ${task.category || ''} ${task.subtasks.map((s) => s.text).join(' ')}`.trim();
      memoryHits = await searchMemory(query, undefined, 8, 0.3);
      if (memoryHits.length > 0) {
        ctx.emit({
          id: 'step-discovery-memory',
          stage: 'context',
          agentRole: 'discovery',
          title: `Memory-First: ${memoryHits.length} Prior Knowledge Hit(s)`,
          detail: `Retrieved ${memoryHits.length} relevant chunk(s) from local vector memory (0 tokens). Top match: "${memoryHits[0].chunk.text.slice(0, 80)}…" (${(memoryHits[0].similarity * 100).toFixed(0)}% similarity).`,
          status: 'running'
        });
      } else {
        ctx.emit({
          id: 'step-discovery-memory',
          stage: 'context',
          agentRole: 'discovery',
          title: 'Memory-First: No Prior Knowledge Found',
          detail: 'Local vector memory returned no relevant results for this task.',
          status: 'running'
        });
      }
    } catch (err) {
      console.warn('[Ergo Discovery] Memory-first search failed (non-fatal):', err);
    }
  }

  const threshold = typeof ctx.options.discoveryRelevanceThreshold === 'number'
    ? ctx.options.discoveryRelevanceThreshold
    : 50;

  const allWorkspaceEntries = extractAllWorkspaceTasks(project.swimLanes, project.todoMarkdown);
  const candidateEntries = allWorkspaceEntries.filter(
    (e) => String(e.task.id) !== String(task.id) && e.task.title.trim().toLowerCase() !== task.title.trim().toLowerCase()
  );

  // Only scan human swim lane documents for header discovery (NOT verbose AGENT_CONTEXT.md)
  // to prevent prompt bloat; AGENT_CONTEXT.md is loaded later for adopted tasks.
  const headerIndex = buildTaskHeaderIndex(project.swimLanes, '', project.todoMarkdown);
  const guidelines = await readGuidelineFiles(ctx);
  throwIfAborted(ctx.signal);

  let relevantTaskIds: Array<string | number> = [];
  let notes = '';

  if (candidateEntries.length > 0) {
    const userLines: string[] = [];
    userLines.push('## Target Task Being Executed');
    userLines.push(`- #${task.id}: ${task.title} (${task.category || 'General'})`);
    if (task.subtasks.length > 0) userLines.push(...task.subtasks.map((s) => `  ${subtaskLine(s)}`));
    userLines.push('', '## Connected MCP Servers');
    const servers = connectedServerLines(ctx);
    userLines.push(...(servers.length > 0 ? servers : ['- (none connected)']));
    if (guidelines.length > 0) {
      userLines.push('', '## Project Guidelines');
      for (const g of guidelines) userLines.push(`### ${g.path}`, '```', g.excerpt, '```');
    }
    userLines.push('', '## Task Header Index Across Workspace', headerIndex);
    userLines.push(
      '',
      `Return ONLY JSON with this structure:`,
      `{`,
      `  "candidates": [`,
      `    { "taskId": "<id from index, never #${task.id}>", "probability": <integer 0-100 estimating probability that title/category is related to target task>, "reason": "<short justification>" }`,
      `  ],`,
      `  "notes": "<≤60 words: dependencies, shared schemas, architectural precedents>",`,
      `  "suggestedMcps": [...]`,
      `}`
    );

    let candidatesFromModel: Array<{ taskId: string | number; probability: number; reason?: string }> = [];
    try {
      const skill = await loadPipelineSkill('discovery-agent');
      const roleTarget = resolveRoleTarget(aiConfig, 'discovery');
      const result = await runToolLoop({
        provider: roleTarget.provider,
        model: roleTarget.model,
        apiKey: roleTarget.apiKey,
        baseUrl: roleTarget.baseUrl,
        stableSystem: skill,
        sharedContext: '',
        tools: [],
        initialUserMessage: userLines.join('\n'),
        maxRounds: 1,
        maxTokens: 1500,
        responseFormat: 'json',
        signal: ctx.signal
      });
      addUsage(usage, result.usage);
      if (result.stopReason === 'error') {
        console.warn('[Ergo Discovery] model call failed, continuing without relevance hints:', result.error);
      }
      const parsed = parseJsonLoose<{
        candidates?: any[];
        relevantTaskIds?: any[];
        notes?: string;
        suggestedMcps?: string[];
      }>(result.text);

      if (parsed) {
        if (Array.isArray(parsed.candidates)) {
          candidatesFromModel = parsed.candidates
            .map((c) => ({
              taskId: c?.taskId ?? c?.id,
              probability: typeof c?.probability === 'number' ? c.probability : parseInt(String(c?.probability ?? 0), 10) || 0,
              reason: typeof c?.reason === 'string' ? c.reason : undefined
            }))
            .filter((c) => c.taskId !== null && c.taskId !== undefined && String(c.taskId) !== String(task.id));
        } else if (Array.isArray(parsed.relevantTaskIds)) {
          // Backwards compatibility if legacy format returned
          candidatesFromModel = parsed.relevantTaskIds
            .filter((id) => String(id) !== String(task.id))
            .map((id) => ({ taskId: id, probability: 100, reason: 'Flagged as relevant' }));
        }
        notes = typeof parsed.notes === 'string' ? parsed.notes.trim().slice(0, 600) : '';
      }
    } catch (e) {
      if (isAbortError(e)) throw e;
      console.warn('[Ergo Discovery] header scan failed, continuing with empty relevance set:', e);
    }
    throwIfAborted(ctx.signal);

    // Filter candidates passing the user-configured relevance threshold
    const passingCandidates = candidatesFromModel
      .filter((c) => c.probability >= threshold)
      .sort((a, b) => b.probability - a.probability)
      .slice(0, 5); // Bound to at most 5 candidate evaluations to protect token budget

    if (passingCandidates.length === 0) {
      ctx.emit({
        id: 'step-discovery-scan',
        stage: 'context',
        agentRole: 'discovery',
        title: 'Discovery AI: Header Scan Complete',
        detail: `Evaluated ${candidateEntries.length} candidate tasks in workspace; none met the title match threshold of ${threshold}%.`,
        status: 'running'
      });
    } else {
      ctx.emit({
        id: 'step-discovery-scan',
        stage: 'context',
        agentRole: 'discovery',
        title: `Discovery AI: ${passingCandidates.length} Candidate${passingCandidates.length === 1 ? '' : 's'} Passed Threshold (≥${threshold}%)`,
        detail: `Candidates: ${passingCandidates.map((c) => `#${c.taskId} (${c.probability}%)`).join(', ')}. Inspecting subtasks for early-exit confirmation…`,
        status: 'running'
      });

      // Phase 2: Sequential early-exit subtask inspection
      for (const cand of passingCandidates) {
        throwIfAborted(ctx.signal);
        const matchEntry = candidateEntries.find((e) => String(e.task.id) === String(cand.taskId));
        if (!matchEntry) continue;

        const subtasks = matchEntry.task.subtasks || [];
        if (subtasks.length === 0) {
          // Candidate has no subtasks: if confidence was high, adopt it; otherwise disregard
          if (cand.probability >= Math.min(80, threshold + 20)) {
            relevantTaskIds.push(matchEntry.task.id);
            ctx.emit({
              id: `step-discovery-match-${matchEntry.task.id}`,
              stage: 'context',
              agentRole: 'discovery',
              title: `Discovery AI: Task #${matchEntry.task.id} Adopted`,
              detail: `Title "${matchEntry.task.title}" scored ${cand.probability}% confidence with no subtasks; adopted into Bible.`,
              status: 'running'
            });
          } else {
            ctx.emit({
              id: `step-discovery-skip-${matchEntry.task.id}`,
              stage: 'context',
              agentRole: 'discovery',
              title: `Discovery AI: Task #${matchEntry.task.id} Disregarded`,
              detail: `Title "${matchEntry.task.title}" scored ${cand.probability}%, but has no subtasks to verify relevance; disregarded as red herring.`,
              status: 'running'
            });
          }
          continue;
        }

        // Subtask evaluation prompt with strict early-exit instruction
        const subtaskMessage = [
          `Target Task Being Executed: #${task.id}: "${task.title}" (${task.category || 'General'})`,
          ...(task.subtasks.length > 0 ? ['Target Subtasks:', ...task.subtasks.map((s) => `  - ${s.text}`)] : []),
          '',
          `Candidate Task #${matchEntry.task.id}: "${matchEntry.task.title}" (${matchEntry.task.category || 'General'})`,
          `Title Match Probability: ${cand.probability}% (Threshold: ${threshold}%)`,
          'Candidate Subtasks to Evaluate:',
          ...subtasks.map((s, idx) => `  ${idx + 1}. [${s.isDone ? 'DONE' : 'TODO'}] ${s.text}`),
          '',
          'CRITICAL RULE: Evaluate the candidate subtasks sequentially.',
          'As soon as you find even 1 subtask that definitely seems related to the current task being executed, IMMEDIATELY STOP looking further and return:',
          '{ "matched": true, "matchingSubtask": "<text of the matching subtask>", "reason": "<why this proves relevance>" }',
          '',
          'If you evaluate ALL subtasks and NONE of them seem strongly related to the current task, return:',
          '{ "matched": false, "reason": "Red herring: none of the subtasks relate to target task" }',
          '',
          'Return ONLY valid JSON.'
        ].join('\n');

        try {
          const roleTarget = resolveRoleTarget(aiConfig, 'discovery');
          const subtaskResult = await runToolLoop({
            provider: roleTarget.provider,
            model: roleTarget.model,
            apiKey: roleTarget.apiKey,
            baseUrl: roleTarget.baseUrl,
            stableSystem: 'You are a fast relevance evaluator. Return ONLY valid JSON with no markdown fences.',
            sharedContext: '',
            tools: [],
            initialUserMessage: subtaskMessage,
            maxRounds: 1,
            maxTokens: 500,
            responseFormat: 'json',
            signal: ctx.signal
          });
          addUsage(usage, subtaskResult.usage);
          const parsedSubtask = parseJsonLoose<{ matched?: boolean; matchingSubtask?: string; reason?: string }>(subtaskResult.text);
          if (parsedSubtask?.matched === true) {
            relevantTaskIds.push(matchEntry.task.id);
            ctx.emit({
              id: `step-discovery-match-${matchEntry.task.id}`,
              stage: 'context',
              agentRole: 'discovery',
              title: `Discovery AI: Task #${matchEntry.task.id} Confirmed & Adopted`,
              detail: `Subtask "${parsedSubtask.matchingSubtask || 'match'}" confirmed relevance (${parsedSubtask.reason || 'related'}). Adopting entire task into Bible.`,
              status: 'running'
            });
          } else {
            ctx.emit({
              id: `step-discovery-skip-${matchEntry.task.id}`,
              stage: 'context',
              agentRole: 'discovery',
              title: `Discovery AI: Task #${matchEntry.task.id} Disregarded (Red Herring)`,
              detail: `None of the subtasks were strongly related (${parsedSubtask?.reason || 'no match'}). Disregarded.`,
              status: 'running'
            });
          }
        } catch (e) {
          if (isAbortError(e)) throw e;
          console.warn(`[Ergo Discovery] Subtask check for Task #${matchEntry.task.id} failed:`, e);
        }
      }
    }
  }

  const payload = buildDiscoveryJobPayload(task, relevantTaskIds, project.swimLanes, project.agentContextMarkdown, project.todoMarkdown);
  payload.guidelineDocs = guidelines;
  payload.discoveryNotes = notes || undefined;
  const baselineMarkdown = buildBaselineMarkdown(ctx, payload, guidelines, notes, memoryHits);
  payload.baselineMarkdown = baselineMarkdown;
  addUsage(ctx.usage, usage);

  console.log('%c[Ergo Agent Pipeline] ── Step 1: Discovery → Baseline Markdown Context ──', 'color: #38bdf8; font-weight: bold; font-size: 13px;');
  console.log(baselineMarkdown);

  const found = payload.additionalContext.map((c) => `#${c.taskId}`);
  ctx.emit({
    id: 'step-discovery',
    stage: 'context',
    agentRole: 'discovery',
    title: 'Discovery AI: Baseline Context Assembled',
    detail:
      (found.length > 0 ? `Related tasks: ${found.join(', ')}. ` : 'No related tasks needed. ') +
      (guidelines.length > 0 ? `Guidelines: ${guidelines.map((g) => g.path).join(', ')}. ` : 'No AGENTS.md / CLAUDE.md found. ') +
      (notes ? `Notes: ${cap(notes, 140)}` : ''),
    status: 'success',
    discoveryPayload: payload,
    usage: { ...usage }
  });

  return { payload, baselineMarkdown, usage, memoryHits };
}
