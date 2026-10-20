/**
 * Keeps the bridge's `workspace` memory index (see memoryStore.syncWorkspace) in step with the human workspace:
 * every active task, freeform briefs, and freeform text in the lane documents. Debounced; identical payloads are
 * never re-sent, and the bridge only embeds what changed, so this is cheap to run on every edit.
 */

import { useEffect, useRef } from 'react';
import type { AgentContextItem, SwimLaneDoc, TaskItem } from '../types';
import { cleanWorkspaceText, type WorkspaceIndexItem } from '../lib/memory/types';
import { syncWorkspaceIndex } from '../lib/memory/relatedTasks';

const SYNC_DEBOUNCE_MS = 1_500;
/** Machine-written header comments (`<!-- Project: … | Folder: … -->`, `<!-- Linked Tasks: … -->`, …). */
const MACHINE_COMMENT = /^(project|folder|linked [a-z ]+|swimlane title|archive)\b\s*:?/i;

export interface WorkspaceMemorySyncInput {
  projectId: string | null | undefined;
  tasks: TaskItem[];
  briefs?: AgentContextItem[];
  swimLanes?: SwimLaneDoc[];
}

/** Per line: drops strike-through / bold markers and backticks, keeps the line breaks (paragraphs matter). */
function stripDecorations(line: string): string {
  return line.replace(/~~/g, '').replace(/\*\*/g, '').replace(/`/g, '').replace(/[ \t]+/g, ' ').trim();
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'section'
  );
}

/**
 * Freeform text of one lane document: everything that is not a task list item (or its subtasks), a heading, a
 * horizontal rule, a blank line or a machine-written header comment — grouped under its nearest heading, one note
 * per section. Mirrors parser.ts's task detection so nothing that becomes a task is indexed twice.
 */
export function extractFreeformNotes(lane: Pick<SwimLaneDoc, 'id' | 'title' | 'markdown'>): WorkspaceIndexItem[] {
  const md = String(lane.markdown || '').replace(/\r\n?/g, '\n');
  const archiveAt = md.search(/^\s*<!--\s*ARCHIVE\s*-->/im);
  const lines = (archiveAt >= 0 ? md.slice(0, archiveAt) : md).split('\n');

  const sections: Array<{ heading: string; paras: string[][] }> = [];
  let current: { heading: string; paras: string[][] } | null = null;
  let para: string[] | null = null;
  let inTask = false;
  const section = (heading: string) => {
    current = { heading, paras: [] };
    sections.push(current);
    para = null;
  };
  const addLine = (text: string) => {
    if (!text) return;
    if (!current) section('');
    if (!para) {
      para = [];
      current!.paras.push(para);
    }
    para.push(text);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '') {
      para = null; // paragraph break; a task list continues across blank lines (as in the parser)
      continue;
    }
    if (trimmed.startsWith('<!--')) {
      let body = trimmed;
      while (!body.includes('-->') && i + 1 < lines.length) body += `\n${lines[++i]}`;
      const inner = body.replace(/^<!--/, '').replace(/-->[\s\S]*$/, '').trim();
      if (inner && !MACHINE_COMMENT.test(inner)) {
        para = null;
        for (const l of inner.split('\n')) addLine(stripDecorations(l));
        para = null;
      }
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+?)(:?)$/);
    if (heading) {
      section(stripDecorations(heading[2]).replace(/:$/, ''));
      inTask = false;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      inTask = false;
      para = null;
      continue;
    }
    if (inTask && /^(\t+|\s{2,})([*+-]|\d+\.)\s+/.test(line)) continue; // subtask
    if (/^\d+\.\s+/.test(line) || /^[-*+]\s+/.test(line)) {
      inTask = true; // top-level task
      para = null;
      continue;
    }
    inTask = false;
    addLine(stripDecorations(line));
  }

  const out: WorkspaceIndexItem[] = [];
  const seen = new Map<string, number>();
  for (const s of sections) {
    const text = s.paras.map((p) => p.join('\n')).filter(Boolean).join('\n\n').trim();
    if (!text) continue;
    const base = `note:lane:${lane.id}:${slug(s.heading || 'top')}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    out.push({
      id: n === 1 ? base : `${base}~${n}`,
      kind: 'note',
      title: s.heading || lane.title || 'Notes',
      category: lane.title || undefined,
      text,
    });
  }
  return out;
}

/** True when a brief is freeform (made from a selected text passage rather than from a task). */
function isFreeformBrief(b: AgentContextItem): boolean {
  const noTask = b.sourceTaskId === undefined || b.sourceTaskId === null || String(b.sourceTaskId) === '';
  return noTask && !b.isArchived && typeof b.sourceContent === 'string' && b.sourceContent.trim() !== '';
}

/**
 * The workspace items to index: every active task (title, lane heading, subtasks, summary note, status), every
 * freeform brief's source text, and the freeform text of every lane document. Pure; markdown decorations stripped.
 */
export function buildWorkspaceIndexItems(input: Omit<WorkspaceMemorySyncInput, 'projectId'>): WorkspaceIndexItem[] {
  const items: WorkspaceIndexItem[] = [];
  const ids = new Set<string>();
  const push = (item: WorkspaceIndexItem) => {
    if (ids.has(item.id)) return;
    ids.add(item.id);
    items.push(item);
  };

  for (const t of input.tasks || []) {
    if (!t || t.isArchived) continue;
    const title = cleanWorkspaceText(t.title);
    if (!title) continue;
    const item: WorkspaceIndexItem = {
      id: String(t.id),
      kind: 'task',
      title,
      subtasks: (t.subtasks || []).map((s) => cleanWorkspaceText(s?.text)).filter(Boolean),
      status: t.status,
      isDone: Boolean(t.isDone),
    };
    const category = cleanWorkspaceText(t.category);
    if (category) item.category = category;
    const note = cleanWorkspaceText(t.summaryNote);
    if (note) item.text = note;
    push(item);
  }

  for (const b of input.briefs || []) {
    if (!b || !isFreeformBrief(b)) continue;
    const key = b.id || (b.itemNumber !== undefined ? `n${b.itemNumber}` : slug(b.title || ''));
    const text = String(b.sourceContent)
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map(stripDecorations)
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (!text) continue;
    const item: WorkspaceIndexItem = {
      id: `note:brief:${key}`,
      kind: 'note',
      title: cleanWorkspaceText(b.title) || cleanWorkspaceText(b.sourceHeading) || 'Freeform brief',
      text,
    };
    const category = cleanWorkspaceText(b.sourceLaneTitle || b.sourceHeading);
    if (category) item.category = category;
    push(item);
  }

  for (const lane of input.swimLanes || []) {
    if (!lane) continue;
    for (const note of extractFreeformNotes(lane)) push(note);
  }
  return items;
}

/**
 * Drop-in for App: `useWorkspaceMemorySync({ projectId: activeProjectId, tasks, briefs, swimLanes })`.
 * Syncs ~1.5 s after the workspace settles. Never sends an empty item list (that is what a project looks like
 * while it loads, and it would wipe the index), nor tasks whose lane isn't one of `swimLanes` (mid project switch).
 */
export function useWorkspaceMemorySync({ projectId, tasks, briefs, swimLanes }: WorkspaceMemorySyncInput): void {
  const lastSent = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    if (!projectId) return;
    const timer = setTimeout(() => {
      if (swimLanes && swimLanes.length > 0) {
        const laneIds = new Set(swimLanes.map((l) => l.id));
        if ((tasks || []).some((t) => t?.swimLaneId && !laneIds.has(t.swimLaneId))) return;
      }
      const items = buildWorkspaceIndexItems({ tasks, briefs, swimLanes });
      if (items.length === 0) return;
      const payload = JSON.stringify(items);
      if (lastSent.current.get(projectId) === payload) return;
      lastSent.current.set(projectId, payload);
      void syncWorkspaceIndex({ projectId, items }).then((res) => {
        // Let the next change (or an identical payload) retry after a failure.
        if (!res.success && lastSent.current.get(projectId) === payload) lastSent.current.delete(projectId);
      });
    }, SYNC_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [projectId, tasks, briefs, swimLanes]);
}
