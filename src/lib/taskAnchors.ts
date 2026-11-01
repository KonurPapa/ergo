/**
 * Task anchors: a hidden `<!-- ergo:k3x9qa -->` comment at the end of each top-level task line in TODO.md.
 *
 * Briefs, runs, the queue and schedules attach to a task by id. Ids used to be positional (`lane_task_3`), so moving
 * or inserting a line silently re-pointed every brief below it. An anchor travels with its line instead: the editor
 * keeps it as a hidden attribute on the list item (see listItemAnchor.ts), and the parser builds the task id from it.
 * The editor never shows anchors; exports leave them out unless the user asks for Ergo's formatting.
 */
import { cleanAndUnescapeMarkdown } from './parser';

/** Matches an anchor anywhere in a line (it may sit inside a `~~done~~` wrap written by older code). */
export const ANCHOR_RE = /\s*<!--\s*ergo:([a-z0-9]{4,16})\s*-->/i;
const ANCHOR_RE_G = /\s*<!--\s*ergo:[a-z0-9]{4,16}\s*-->/gi;

export const anchorComment = (id: string) => `<!-- ergo:${id} -->`;

/** A line without its anchor, and the anchor's id. */
export function splitAnchor(line: string): { text: string; id: string | null } {
  const m = line.match(ANCHOR_RE);
  if (!m) return { text: line, id: null };
  return { text: line.replace(ANCHOR_RE, ''), id: m[1].toLowerCase() };
}

export function newAnchorId(taken: Set<string>): string {
  for (;;) {
    const id = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
}

/** The task id for a task line: built from its anchor, or positional for a line that has none yet. */
export function taskIdFor(laneId: string, anchorId: string | null | undefined, index: number): string {
  return anchorId ? `${laneId}_${anchorId}` : `${laneId}_task_${index + 1}`;
}

// The same lines the parser treats as top-level tasks (parseTaskItemsBlock): numbered or bulleted at column 0,
// in the active part of the file (before `<!-- ARCHIVE -->`).
const TOP_TASK_RE = /^(\d+\.|[-*+])\s+(.*)$/;
const ARCHIVE_RE = /^\s*<!--\s*ARCHIVE\s*-->/i;

const titleKey = (text: string) =>
  cleanAndUnescapeMarkdown(text.replace(/^~~|~~$/g, '').trim())
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/** Each top-level task line's index, title and anchor, in document order. */
function taskLines(markdown: string): Array<{ line: number; id: string | null; key: string }> {
  const out: Array<{ line: number; id: string | null; key: string }> = [];
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (ARCHIVE_RE.test(lines[i])) break;
    if (lines[i].trim().startsWith('<!--')) continue;
    const m = lines[i].match(TOP_TASK_RE);
    if (!m) continue;
    const { text, id } = splitAnchor(m[2]);
    out.push({ line: i, id, key: titleKey(text) });
  }
  return out;
}

export interface AnchorResult {
  markdown: string;
  /** Tasks that got an anchor, by their position among the lane's tasks (for moving briefs off positional ids). */
  assigned: Array<{ index: number; id: string }>;
  changed: boolean;
}

/**
 * Gives every top-level task line an anchor. A line that lost its anchor (an AI rewrite, an edit outside Ergo) gets
 * back the one its title had in `previous`, so its brief stays attached; any other line gets a new one. Duplicate
 * anchors (a copied line) keep the first and re-anchor the rest.
 */
export function ensureAnchors(markdown: string, previous?: string): AnchorResult {
  const lines = markdown.split('\n');
  const tasks = taskLines(markdown);
  const taken = new Set<string>();
  const assigned: AnchorResult['assigned'] = [];

  // Anchors the previous version had, by title, that this version no longer carries.
  const reusable = new Map<string, string[]>();
  if (previous) {
    const present = new Set(tasks.map((t) => t.id).filter(Boolean) as string[]);
    for (const t of taskLines(previous)) {
      if (!t.id || present.has(t.id)) continue;
      const list = reusable.get(t.key);
      if (list) list.push(t.id);
      else reusable.set(t.key, [t.id]);
    }
  }

  let changed = false;
  tasks.forEach((t, index) => {
    if (t.id && !taken.has(t.id)) {
      taken.add(t.id);
      return;
    }
    const reuse = reusable.get(t.key)?.find((id) => !taken.has(id));
    const id = reuse ?? newAnchorId(taken);
    taken.add(id);
    const base = splitAnchor(lines[t.line]).text.replace(/\s+$/, '');
    lines[t.line] = `${base} ${anchorComment(id)}`;
    assigned.push({ index, id });
    changed = true;
  });

  return { markdown: changed ? lines.join('\n') : markdown, assigned, changed };
}

/** Puts a task line's anchor back after a rewrite of the line (e.g. toggling `~~done~~`): `content` has none. */
export function withAnchor(content: string, id: string | null): string {
  return id ? `${content} ${anchorComment(id)}` : content;
}

/**
 * The markdown without Ergo's own formatting: task anchors, header color tags (`## Name {color=teal}`) and inline
 * color tags (`{color=red}text{/color}`). For exports meant for other tools.
 */
export function stripErgoFormatting(markdown: string): string {
  return markdown
    .replace(ANCHOR_RE_G, '')
    .replace(/\{color=[a-z]+\}([\s\S]*?)\{\/color\}/gi, '$1')
    .replace(/[ \t]*\{color=[a-z]+\}[ \t]*$/gim, '');
}
