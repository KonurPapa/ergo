/**
 * TASK_CONTEXT.md — the Master Bible: single source of truth + append-only event log.
 *
 *  - renderStable() is DETERMINISTIC (no timestamps, no randomness, stable ordering). It is the
 *    `sharedContext` cached prompt block shared by the manager and every worker in a run, so a
 *    single byte of drift would invalidate every provider cache hit.
 *  - Events are appended, never rewritten. renderFull() is what gets persisted to disk under the
 *    storage root (runs/<project>/<task>-<runId>/TASK_CONTEXT.md), outside the watched projects/
 *    tree so writes never trigger workspace reloads.
 *  - FileLockRegistry is the "master markdown tracking document of active file modifications"
 *    (FILE_LOCKS.md) that prevents edit collisions between concurrent workers.
 */
import {
  type BibleEvent,
  type BibleSections,
  type DiscoveryJobPayload,
  type McpRootBoundary,
  type OverviewDocument,
  type ProjectData,
  type PuzzlePiece,
  type TaskItem,
  type TaskKind
} from '../../types';
import { slugify } from './contracts';

/** Normalizes a path for comparisons: trims, unifies separators, strips ./ and trailing slashes. */
export function normalizePath(p: string): string {
  let out = (p || '').trim().replace(/\\/g, '/');
  out = out.replace(/^\.\//, '');
  // '~/x' and '/home/<user>/x' must compare equal: drop the tilde so suffix matching (pathsRefer) works.
  out = out.replace(/^~\//, '');
  out = out.replace(/\/{2,}/g, '/');
  if (out.length > 1) out = out.replace(/\/+$/, '');
  return out;
}

/**
 * True when two paths refer to the same file even if one is absolute/`~`-relative and the other
 * is relative to the storage root (we cannot resolve the storage root in the browser, so we
 * compare on path-boundary suffixes).
 */
export function pathsRefer(a: string, b: string): boolean {
  const na = normalizePath(a);
  const nb = normalizePath(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return na.endsWith('/' + nb) || nb.endsWith('/' + na);
}

/** True when `target` is `scopePath` itself or lives underneath it (directory scope). */
export function pathWithin(target: string, scopePath: string): boolean {
  const t = normalizePath(target);
  const s = normalizePath(scopePath);
  if (!t || !s) return false;
  if (pathsRefer(t, s)) return true;
  return t.startsWith(s + '/') || t.includes('/' + s + '/');
}

function truncate(text: string | undefined, max: number): string {
  if (!text) return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
}

import { type SearchResult } from '../memory';

export function buildBibleSections(args: {
  task: TaskItem;
  project: ProjectData;
  overviewDoc: OverviewDocument;
  requiredMcps: string[];
  taskKind: TaskKind;
  requiresHardener?: boolean;
  hardenerReason?: string;
  allowedRoots: McpRootBoundary[];
  guidelines?: Array<{ path: string; excerpt: string }>;
  memoryHits?: SearchResult[];
  discoveryPayload?: DiscoveryJobPayload;
  runId: string;
}): BibleSections {
  const {
    task,
    project,
    overviewDoc,
    requiredMcps,
    taskKind,
    requiresHardener,
    hardenerReason,
    allowedRoots,
    guidelines,
    memoryHits,
    discoveryPayload,
    runId
  } = args;

  let discoveredContext: Array<{
    taskId?: string | number;
    title?: string;
    category?: string;
    sourceDocument?: string;
    snippet?: string;
    similarity?: number;
    source?: string;
  }> = [];

  if (memoryHits && memoryHits.length > 0) {
    discoveredContext = memoryHits.map((hit) => ({
      similarity: hit.similarity,
      source: hit.chunk.metadata.source || hit.chunk.namespace,
      snippet: truncate(hit.chunk.text, 350)
    }));
  } else if (discoveryPayload?.additionalContext?.length) {
    discoveredContext = discoveryPayload.additionalContext.map((c) => ({
      taskId: c.taskId,
      title: c.title,
      category: c.category,
      sourceDocument: c.sourceDocument,
      snippet: truncate(c.overview || c.buildAndVerification || c.completion, 250) || undefined
    }));
  }

  const effectiveGuidelines =
    guidelines ||
    (discoveryPayload?.guidelineDocs || []).map((g) => ({ path: g.path, excerpt: g.excerpt }));

  return {
    title: task.title,
    metadata: {
      taskId: task.id,
      category: task.category || 'General',
      status: task.status || 'not_started',
      sourceDocument: task.sourceFileName || 'TODO.md',
      projectName: project.name || 'Default Workspace',
      projectPath: project.folderPath || 'projects/default-workspace',
      taskKind,
      runId,
      requiresHardener,
      hardenerReason
    },
    subtasks: task.subtasks.map((s) => ({ text: s.text, isDone: Boolean(s.isDone), isHumanReview: Boolean(s.isHumanReview) })),
    gherkin: (overviewDoc.brief || '').trim(),
    goals: (overviewDoc.goals || '').trim(),
    outputAs: (overviewDoc.output_as || '').trim(),
    requiredMcps: [...requiredMcps],
    allowedRoots: allowedRoots.map((r) => r.path),
    discoveredContext,
    guidelines: effectiveGuidelines,
    discoveryNotes: discoveryPayload?.discoveryNotes?.trim() || undefined
  };
}

async function writeStorageFile(filePath: string, content: string): Promise<void> {
  try {
    const res = await fetch('/api/files/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [{ filePath, content }] })
    });
    if (!res.ok) console.warn(`[Ergo Bible] Failed to persist ${filePath}: HTTP ${res.status}`);
  } catch (err) {
    console.warn(`[Ergo Bible] Failed to persist ${filePath}:`, err);
  }
}

export class BibleStore {
  readonly sections: BibleSections;
  readonly events: BibleEvent[] = [];
  pieces: PuzzlePiece[] = [];
  private readonly runDir: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(sections: BibleSections, runDir: string) {
    this.sections = sections;
    this.runDir = normalizePath(runDir);
  }

  static runDirFor(projectId: string, taskId: string | number, runId: string): string {
    return `runs/${slugify(projectId)}/task-${slugify(String(taskId))}-${runId}`;
  }

  get filePath(): string {
    return `${this.runDir}/TASK_CONTEXT.md`;
  }

  /** Deterministic stable sections (the cached shared prefix). */
  renderStable(): string {
    const s = this.sections;
    const out: string[] = [];
    out.push(`# TASK EXECUTION BIBLE: ${s.title}`, '');
    out.push('## Metadata');
    out.push(`- **Task ID**: #${s.metadata.taskId}`);
    out.push(`- **Category**: ${s.metadata.category}`);
    out.push(`- **Status**: ${s.metadata.status}`);
    out.push(`- **Source**: ${s.metadata.sourceDocument}`);
    out.push(`- **Project**: ${s.metadata.projectName} (${s.metadata.projectPath})`);
    out.push(`- **Task Kind**: ${s.metadata.taskKind}`);
    if (s.metadata.requiresHardener !== undefined) {
      out.push(`- **QA Hardener**: ${s.metadata.requiresHardener ? 'Required' : 'Skipped'}${s.metadata.hardenerReason ? ` (${s.metadata.hardenerReason})` : ''}`);
    }
    out.push(`- **Run ID**: ${s.metadata.runId}`, '');

    out.push('## Target Task & Subtasks');
    if (s.subtasks.length > 0) {
      for (const st of s.subtasks) out.push(`- [${st.isDone ? 'x' : ' '}] ${st.text}${st.isHumanReview ? ' **[Human Review]**' : ''}`);
    } else {
      out.push(`- [ ] ${s.title}`);
    }
    out.push('');

    out.push('## Overview & Acceptance Criteria (Gherkin Scenarios)');
    out.push('```gherkin');
    out.push(s.gherkin || `Feature: ${s.title}`);
    out.push('```', '');

    out.push('## Deliverable Goals');
    out.push(s.goals || '1. Complete the task as described.', '');

    out.push('## Output Destination & Method');
    out.push(`- **Destination**: ${s.outputAs || 'Record results in AGENT_CONTEXT.md.'}`);
    out.push(`- **Required MCPs**: ${s.requiredMcps.length > 0 ? s.requiredMcps.join(', ') : '(none — pure reasoning/text)'}`);
    out.push(`- **Allowed Boundaries**: ${s.allowedRoots.length > 0 ? s.allowedRoots.join(', ') : s.metadata.projectPath}`, '');

    if (s.discoveredContext.length > 0) {
      out.push('## Prior Knowledge & Context (Vector Memory)');
      for (const c of s.discoveredContext) {
        if (c.similarity !== undefined) {
          const sim = ` [${(c.similarity * 100).toFixed(0)}% match]`;
          const src = c.source ? ` (${c.source})` : '';
          out.push(`- **Prior Knowledge${sim}${src}**: ${c.snippet || 'Referenced for context.'}`);
        } else {
          out.push(`- **Task #${c.taskId} (${c.title || ''})** [from \`${c.sourceDocument || 'context'}\` / ${c.category || 'General'}]: ${c.snippet || 'Referenced for context.'}`);
        }
      }
      out.push('');
    }

    if (s.guidelines.length > 0) {
      out.push('## Project Guidelines');
      for (const g of s.guidelines) {
        out.push(`### ${g.path}`);
        out.push('```');
        out.push(g.excerpt.trim());
        out.push('```');
      }
      out.push('');
    }

    if (s.discoveryNotes) {
      out.push('## Discovery Notes');
      out.push(s.discoveryNotes, '');
    }
    return out.join('\n').trimEnd() + '\n';
  }

  /**
   * Slim context for Manager (Step 3): Gherkin criteria, goals, output destination, and metadata.
   * Excludes verbose discovered context dumps and project guideline excerpts, which are intended
   * for worker implementation rather than manager decomposition and verification.
   */
  renderManagerContext(): string {
    const s = this.sections;
    const out: string[] = [];
    out.push(`# TASK EXECUTION BIBLE: ${s.title}`, '');
    out.push('## Metadata');
    out.push(`- **Task ID**: #${s.metadata.taskId}`);
    out.push(`- **Category**: ${s.metadata.category}`);
    out.push(`- **Status**: ${s.metadata.status}`);
    out.push(`- **Project**: ${s.metadata.projectName} (${s.metadata.projectPath})`);
    out.push(`- **Task Kind**: ${s.metadata.taskKind}`);
    out.push('');

    out.push('## Target Task & Subtasks');
    if (s.subtasks.length > 0) {
      for (const st of s.subtasks) out.push(`- [${st.isDone ? 'x' : ' '}] ${st.text}${st.isHumanReview ? ' **[Human Review]**' : ''}`);
    } else {
      out.push(`- [ ] ${s.title}`);
    }
    out.push('');

    out.push('## Overview & Acceptance Criteria (Gherkin Scenarios)');
    out.push('```gherkin');
    out.push(s.gherkin || `Feature: ${s.title}`);
    out.push('```', '');

    out.push('## Deliverable Goals');
    out.push(s.goals || '1. Complete the task as described.', '');

    out.push('## Output Destination & Method');
    out.push(`- **Destination**: ${s.outputAs || 'Record results in build log.'}`);
    out.push(`- **Required MCPs**: ${s.requiredMcps.length > 0 ? s.requiredMcps.join(', ') : '(none — pure reasoning/text)'}`);
    out.push(`- **Allowed Boundaries**: ${s.allowedRoots.length > 0 ? s.allowedRoots.join(', ') : s.metadata.projectPath}`, '');

    return out.join('\n').trimEnd() + '\n';
  }

  renderPieces(): string {
    const out: string[] = ['## Puzzle Pieces'];
    if (this.pieces.length === 0) {
      out.push('_(not yet decomposed)_');
      return out.join('\n') + '\n';
    }
    out.push('| ID | Kind | Title | Status | Files | Depends on |');
    out.push('|---|---|---|---|---|---|');
    for (const p of this.pieces) {
      const files = p.files.length > 0 ? p.files.map((f) => `\`${f}\``).join(', ') : '_read-only_';
      const deps = p.dependsOn.length > 0 ? p.dependsOn.join(', ') : '—';
      out.push(`| ${p.id} | ${p.kind} | ${p.title.replace(/\|/g, '\\|')} | ${p.status}${p.attempts > 1 ? ` (attempt ${p.attempts})` : ''} | ${files} | ${deps} |`);
    }
    return out.join('\n') + '\n';
  }

  renderEventLog(opts?: { last?: number }): string {
    const out: string[] = ['## Execution Event Log (Append-Only)'];
    let events = this.events;
    if (opts?.last !== undefined && events.length > opts.last) {
      out.push(`_(… ${events.length - opts.last} earlier entries omitted — see TASK_CONTEXT.md)_`);
      events = events.slice(-opts.last);
    }
    if (events.length === 0) out.push('- _(no events yet)_');
    for (const e of events) {
      const piece = e.pieceId ? ` [${e.pieceId}]` : '';
      out.push(`- [${e.at}] **${e.actor}**${piece} (${e.kind}): ${e.text.replace(/\r?\n/g, ' ⏎ ')}`);
    }
    return out.join('\n') + '\n';
  }

  renderFull(): string {
    return `${this.renderStable()}\n${this.renderPieces()}\n${this.renderEventLog()}`;
  }

  appendEvent(e: Omit<BibleEvent, 'at'> & { at?: string }): BibleEvent {
    const event: BibleEvent = { at: e.at || new Date().toISOString(), actor: e.actor, kind: e.kind, text: e.text, pieceId: e.pieceId };
    this.events.push(event);
    return event;
  }

  setPieces(pieces: PuzzlePiece[]): void {
    this.pieces = pieces.map((p) => ({ ...p }));
  }

  addPieces(pieces: PuzzlePiece[]): void {
    this.pieces.push(...pieces.map((p) => ({ ...p })));
  }

  updatePiece(id: string, patch: Partial<PuzzlePiece>): void {
    const idx = this.pieces.findIndex((p) => p.id === id);
    if (idx === -1) return;
    this.pieces[idx] = { ...this.pieces[idx], ...patch };
  }

  /** Serialized, never-throwing write of the full bible to disk. */
  persist(): Promise<void> {
    const content = this.renderFull();
    this.writeChain = this.writeChain.then(() => writeStorageFile(this.filePath, content)).catch(() => {});
    return this.writeChain;
  }
}

interface LockEntry {
  file: string;
  heldBy: string;
  since: string;
}

export class FileLockRegistry {
  private readonly runDir: string;
  private readonly active: LockEntry[] = [];
  private readonly released: Array<LockEntry & { releasedAt: string }> = [];
  private writeChain: Promise<void> = Promise.resolve();

  constructor(runDir: string) {
    this.runDir = normalizePath(runDir);
  }

  get filePath(): string {
    return `${this.runDir}/FILE_LOCKS.md`;
  }

  holderOf(file: string): string | null {
    for (const l of this.active) {
      if (pathsRefer(l.file, file) || pathWithin(file, l.file)) return l.heldBy;
    }
    return null;
  }

  lockedByOthers(pieceId: string): Array<{ file: string; heldBy: string }> {
    return this.active.filter((l) => l.heldBy !== pieceId).map((l) => ({ file: l.file, heldBy: l.heldBy }));
  }

  canStart(piece: PuzzlePiece): boolean {
    return piece.files.every((f) => {
      const holder = this.holderOf(f);
      return holder === null || holder === piece.id;
    });
  }

  acquire(pieceId: string, files: string[]): { ok: true } | { ok: false; conflicts: Array<{ file: string; heldBy: string }> } {
    const conflicts: Array<{ file: string; heldBy: string }> = [];
    for (const f of files) {
      const holder = this.holderOf(f);
      if (holder && holder !== pieceId) conflicts.push({ file: f, heldBy: holder });
    }
    if (conflicts.length > 0) return { ok: false, conflicts };
    const since = new Date().toISOString();
    for (const f of files) {
      const nf = normalizePath(f);
      if (!nf) continue;
      if (!this.active.some((l) => l.heldBy === pieceId && pathsRefer(l.file, nf))) {
        this.active.push({ file: nf, heldBy: pieceId, since });
      }
    }
    return { ok: true };
  }

  release(pieceId: string): void {
    const releasedAt = new Date().toISOString();
    for (let i = this.active.length - 1; i >= 0; i--) {
      if (this.active[i].heldBy === pieceId) {
        this.released.push({ ...this.active[i], releasedAt });
        this.active.splice(i, 1);
      }
    }
  }

  render(): string {
    const out: string[] = ['# FILE LOCKS (active file modifications)', ''];
    out.push('| File | Held by piece | Since |');
    out.push('|---|---|---|');
    if (this.active.length === 0) out.push('| _(none)_ | | |');
    for (const l of this.active) out.push(`| \`${l.file}\` | ${l.heldBy} | ${l.since} |`);
    out.push('', '## Released');
    if (this.released.length === 0) out.push('- _(none yet)_');
    for (const r of this.released.slice(-100)) out.push(`- \`${r.file}\` — ${r.heldBy} (${r.since} → ${r.releasedAt})`);
    return out.join('\n') + '\n';
  }

  persist(): Promise<void> {
    const content = this.render();
    this.writeChain = this.writeChain.then(() => writeStorageFile(this.filePath, content)).catch(() => {});
    return this.writeChain;
  }
}
