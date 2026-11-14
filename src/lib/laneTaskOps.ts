/**
 * Task-level edits to a lane's markdown, done on the text: read or replace one task's block (its title line and
 * everything nested under it), move a task within its lane or into another lane's file, add a task, and check one
 * off. The board view (KanbanBoard.tsx) uses these; the lane markdown stays the single source of truth.
 *
 * A task is a top-level list item of the active part of the file (before `<!-- ARCHIVE -->`), as the parser reads it
 * (parser.ts parseTaskItemsBlock): numbered (`1.`, or ` 9.` padded in a list of 10+) or bulleted (`-`, `*`, `+`) at
 * column 0. Its block runs on through blank and indented lines. Tasks are found by their hidden anchor
 * (`<!-- ergo:id -->`, taskAnchors.ts), which travels with the block.
 *
 * Numbered lists are renumbered after a task leaves or joins them (from the number the list started at), with the
 * nested lines shifted to the new marker's width so they stay nested ("- " is 2 wide, "1. " 3, "10. " 4).
 */
import { ANCHOR_RE, anchorComment, newAnchorId, splitAnchor } from './taskAnchors';

const ARCHIVE_RE = /^\s*<!--\s*ARCHIVE\s*-->/i;
/** A top-level task line: optional single pad space before a number, or a bullet at column 0. */
const TOP_RE = /^( ?)(\d+)\.[ \t]+(.*)$|^([-*+])[ \t]+(.*)$/;
const PADDED_NUM_RE = /^ \d+\.[ \t]/;

export interface TaskBlock {
  /** First line (the title line) and the line after the block's last non-blank line. */
  start: number;
  end: number;
  anchorId: string | null;
  ordered: boolean;
  /** The list number (ordered items). */
  number: number;
  /** The width of the marker, pad and its space: where the item's content (and nested lines) start. */
  width: number;
  /** Index of the list (run of adjacent items of one kind) this task belongs to. */
  run: number;
}

interface Scan {
  lines: string[];
  blocks: TaskBlock[];
  /** Line where the active section ends (the ARCHIVE marker, or the line count). */
  activeEnd: number;
  /** Per run: whether its items are separated by blank lines (a loose list). */
  loose: boolean[];
}

const isBlank = (l: string) => l.trim() === '';

function topMatch(line: string): { ordered: boolean; number: number; width: number; text: string } | null {
  if (line.trim().startsWith('<!--')) return null;
  const m = line.match(TOP_RE);
  if (!m) return null;
  if (m[2] !== undefined) {
    // "1. text": pad + digits + "." + one space.
    return { ordered: true, number: parseInt(m[2], 10), width: m[1].length + m[2].length + 2, text: m[3] };
  }
  return { ordered: false, number: 0, width: 2, text: m[5] };
}

function scan(markdown: string): Scan {
  const lines = markdown.split('\n');
  let activeEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (ARCHIVE_RE.test(lines[i])) {
      activeEnd = i;
      break;
    }
  }
  const blocks: TaskBlock[] = [];
  const loose: boolean[] = [];
  let i = 0;
  while (i < activeEnd) {
    // A code block at the margin is code, not tasks (as the parser reads it): skip to its closing fence.
    const fence = lines[i].match(/^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/);
    if (fence) {
      const close = new RegExp(`^\\s*${fence[1][0] === '`' ? '`' : '~'}{${fence[1].length},}\\s*$`);
      i++;
      while (i < activeEnd && !close.test(lines[i])) i++;
      i++;
      continue;
    }
    const top = topMatch(lines[i]);
    if (!top) {
      i++;
      continue;
    }
    // The block: blank lines and indented lines (a padded " 9." is the next task, not a nested line).
    let end = i + 1;
    let j = i + 1;
    while (j < activeEnd) {
      const l = lines[j];
      if (isBlank(l)) {
        j++;
        continue;
      }
      if (/^[ \t]/.test(l) && !PADDED_NUM_RE.test(l)) {
        j++;
        end = j;
        continue;
      }
      break;
    }
    const prev = blocks[blocks.length - 1];
    // Same list as the previous task when only blank lines lie between them and the kind matches.
    let run = loose.length;
    if (prev && prev.ordered === top.ordered && lines.slice(prev.end, i).every(isBlank)) {
      run = prev.run;
      if (i > prev.end) loose[run] = true;
    } else {
      loose.push(false);
    }
    blocks.push({ start: i, end, anchorId: splitAnchor(top.text).id, ordered: top.ordered, number: top.number, width: top.width, run });
    i = end;
  }
  return { lines, blocks, activeEnd, loose };
}

/** Every task block of the lane, in document order. */
export function findTaskBlocks(markdown: string): TaskBlock[] {
  return scan(markdown).blocks;
}

const findBlock = (blocks: TaskBlock[], anchorId: string) => blocks.find((b) => b.anchorId === anchorId.toLowerCase());

/**
 * Rewrites a block's first-line marker (`- `, `3. `, ` 9. `) and shifts its nested lines by the change in marker
 * width, so they stay nested under it. `lines` is the block alone.
 */
function remark(lines: string[], marker: string): string[] {
  const top = topMatch(lines[0]);
  if (!top) return lines;
  const width = marker.length;
  const delta = width - top.width;
  const first = `${marker}${top.text}`;
  if (delta === 0) return [first, ...lines.slice(1)];
  return [
    first,
    ...lines.slice(1).map((l) => {
      if (isBlank(l) || l.startsWith('\t')) return l;
      if (delta > 0) return ' '.repeat(delta) + l;
      const lead = l.length - l.trimStart().length;
      return l.slice(Math.min(lead, -delta));
    }),
  ];
}

/** Puts every top-level item of a piece of markdown into one kind of list (`1. ` or `- `); numbers are fixed later. */
function retarget(lines: string[], ordered: boolean): string[] {
  const out = [...lines];
  for (const b of scan(lines.join('\n')).blocks.reverse()) {
    if (b.ordered === ordered && (!ordered || b.width === String(b.number).length + 2)) continue;
    out.splice(b.start, b.end - b.start, ...remark(out.slice(b.start, b.end), ordered ? `${b.ordered ? b.number : 1}. ` : '- '));
  }
  return out;
}

/** Numbers the list containing `anchorId` from `from`, padding to the widest number (the editor's " 9." / "10."). */
function renumberRunOf(markdown: string, anchorId: string | null, from: number): string {
  if (!anchorId) return markdown;
  const s = scan(markdown);
  const at = findBlock(s.blocks, anchorId);
  if (!at || !at.ordered) return markdown;
  const run = s.blocks.filter((b) => b.run === at.run);
  const widest = String(from + run.length - 1).length;
  const lines = [...s.lines];
  // Back to front: a marker change never changes the line count, but keep it simple and safe.
  for (let k = run.length - 1; k >= 0; k--) {
    const b = run[k];
    const n = String(from + k);
    const marker = `${' '.repeat(widest - n.length)}${n}. `;
    // The parser reads one pad space at most (lists of 10–99), so a wider pad is left off.
    const safe = marker.length - n.length - 2 > 1 ? `${n}. ` : marker;
    const top = topMatch(lines[b.start]);
    if (top && top.number === from + k && top.width === safe.length) continue;
    lines.splice(b.start, b.end - b.start, ...remark(lines.slice(b.start, b.end), safe));
  }
  return lines.join('\n');
}

/** The task's block as markdown on its own: its title line and nested lines. */
export function getTaskSlice(markdown: string, anchorId: string): string | null {
  const s = scan(markdown);
  const b = findBlock(s.blocks, anchorId);
  return b ? s.lines.slice(b.start, b.end).join('\n') : null;
}

/** Removes a task's block. Returns the lane without it and the block (null when the task isn't there). */
export function removeTask(markdown: string, anchorId: string): { markdown: string; slice: string | null } {
  const s = scan(markdown);
  const b = findBlock(s.blocks, anchorId);
  if (!b) return { markdown, slice: null };
  const run = s.blocks.filter((x) => x.run === b.run);
  const from = run[0].number || 1;
  const neighbor = run.find((x) => x !== b)?.anchorId ?? null;
  const slice = getTaskSlice(markdown, anchorId);
  const lines = [...s.lines];
  let cut = b.end - b.start;
  // Don't leave two blank lines where one separated the task from its neighbors.
  if (b.end < lines.length && isBlank(lines[b.end]) && (b.start === 0 || isBlank(lines[b.start - 1]))) cut++;
  lines.splice(b.start, cut);
  let out = lines.join('\n');
  if (b.ordered) out = renumberRunOf(out, neighbor, from);
  return { markdown: out, slice };
}

/**
 * Inserts a task block (from getTaskSlice / removeTask) before the task `beforeAnchorId`, or after the lane's last
 * task when it's null (or not found). The block takes the kind of list it joins, and that list is renumbered.
 */
export function insertTask(markdown: string, slice: string, beforeAnchorId: string | null): string {
  const s = scan(markdown);
  const sliceLines = slice.replace(/\s+$/, '').split('\n');
  const own = topMatch(sliceLines[0]);
  const ownAnchor = own ? splitAnchor(own.text).id : null;
  const lines = [...s.lines];
  const before = beforeAnchorId ? findBlock(s.blocks, beforeAnchorId) : undefined;
  const last = s.blocks[s.blocks.length - 1];
  const target = before ?? last;

  if (!target) {
    // The lane has no tasks yet: a new numbered list at the end of its active part.
    let at = s.activeEnd;
    while (at > 0 && isBlank(lines[at - 1])) at--;
    const block = retarget(sliceLines, true);
    const pre = at > 0 ? [''] : [];
    const post = at < lines.length ? [''] : [];
    lines.splice(at, s.activeEnd - at, ...pre, ...block, ...post);
    return renumberRunOf(lines.join('\n'), ownAnchor, 1);
  }

  const run = s.blocks.filter((x) => x.run === target.run);
  const from = run[0].number || 1;
  const block = retarget(sliceLines, target.ordered);
  const gap = s.loose[target.run] ? [''] : [];
  if (before) lines.splice(before.start, 0, ...block, ...gap);
  else lines.splice(last.end, 0, ...gap, ...block);
  const out = lines.join('\n');
  return target.ordered ? renumberRunOf(out, ownAnchor ?? target.anchorId, from) : out;
}

/** Moves a task to just before `beforeAnchorId` in the same lane (null: to the end). */
export function moveTaskWithinLane(markdown: string, anchorId: string, beforeAnchorId: string | null): string {
  if (beforeAnchorId && beforeAnchorId.toLowerCase() === anchorId.toLowerCase()) return markdown;
  const removed = removeTask(markdown, anchorId);
  if (removed.slice === null) return markdown;
  return insertTask(removed.markdown, removed.slice, beforeAnchorId);
}

export interface CrossLaneMove {
  source: string;
  target: string;
  /** The task's anchor in the target lane: its own, or a new one when the target already has a task with it. */
  anchorId: string;
}

/** Moves a task (its whole block, anchor included) from one lane's markdown into another's, before `beforeAnchorId`. */
export function moveTaskAcrossLanes(source: string, target: string, anchorId: string, beforeAnchorId: string | null): CrossLaneMove | null {
  const removed = removeTask(source, anchorId);
  if (removed.slice === null) return null;
  let slice = removed.slice;
  let id = anchorId.toLowerCase();
  const taken = new Set(findTaskBlocks(target).map((b) => b.anchorId).filter(Boolean) as string[]);
  if (taken.has(id)) {
    id = newAnchorId(taken);
    const [first, ...rest] = slice.split('\n');
    slice = [`${first.replace(ANCHOR_RE, '').replace(/\s+$/, '')} ${anchorComment(id)}`, ...rest].join('\n');
  }
  return { source: removed.markdown, target: insertTask(target, slice, beforeAnchorId), anchorId: id };
}

/**
 * Replaces a task's block with edited markdown (e.g. from the card editor). The edit may hold more than one top-level
 * item (a task split in two); each joins the task's list. An empty edit removes the task.
 */
export function replaceTaskSlice(markdown: string, anchorId: string, nextSlice: string): string {
  const s = scan(markdown);
  const b = findBlock(s.blocks, anchorId);
  if (!b) return markdown;
  const trimmed = nextSlice.replace(/^\s*\n/, '').replace(/\s+$/, '');
  if (!trimmed) return removeTask(markdown, anchorId).markdown;
  const run = s.blocks.filter((x) => x.run === b.run);
  const from = run[0].number || 1;
  const block = retarget(trimmed.split('\n'), b.ordered);
  const lines = [...s.lines];
  lines.splice(b.start, b.end - b.start, ...block);
  const out = lines.join('\n');
  if (out === markdown || !b.ordered) return out;
  // Renumber from a task of the list that is sure to still be in it.
  const keep = findTaskBlocks(out).some((x) => x.anchorId === b.anchorId) ? b.anchorId : run.find((x) => x !== b)?.anchorId ?? null;
  return renumberRunOf(out, keep, from);
}

/** Adds a task at the end of the lane. Returns the lane and the new task's anchor. */
export function appendTask(markdown: string, title: string): { markdown: string; anchorId: string } {
  const taken = new Set(findTaskBlocks(markdown).map((b) => b.anchorId).filter(Boolean) as string[]);
  const id = newAnchorId(taken);
  const text = title.replace(/\s+/g, ' ').trim();
  return { markdown: insertTask(markdown, `1. ${text} ${anchorComment(id)}`, null), anchorId: id };
}

const DONE_RE = /^~~([\s\S]*)~~$/;
const ITEM_RE = /^(\s*(?:[-*+]|\d+\.)[ \t]+)(.*)$/;

function toggleStrike(text: string, done: boolean): string {
  const { text: body, id } = splitAnchor(text);
  const t = body.trim();
  if (!t) return text;
  const isDone = DONE_RE.test(t);
  if (isDone === done) return text;
  const next = done ? `~~${t}~~` : t.replace(DONE_RE, '$1');
  return id ? `${next} ${anchorComment(id)}` : next;
}

/**
 * Checks a task off (or back on), as the editor's checkbox does: the title and its sub-items are struck through as a
 * whole (`~~…~~`), or the strike is taken off.
 */
export function setTaskDone(markdown: string, anchorId: string, done: boolean): string {
  const s = scan(markdown);
  const b = findBlock(s.blocks, anchorId);
  if (!b) return markdown;
  const lines = [...s.lines];
  for (let i = b.start; i < b.end; i++) {
    const m = lines[i].match(i === b.start ? /^( ?(?:\d+\.|[-*+])[ \t]+)(.*)$/ : ITEM_RE);
    if (!m) continue;
    lines[i] = `${m[1]}${toggleStrike(m[2], done)}`;
  }
  return lines.join('\n');
}
