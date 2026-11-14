import { type TaskItem, type AgentContextItem, type SwimLaneDoc } from '../types';
import { splitHeaderColor, stripTextColorTokens } from './headerColors';
import { splitAnchor, taskIdFor, withAnchor } from './taskAnchors';

/**
 * Strips leading HTML comments and blank lines to provide clean markdown body for UI editor
 */
export function stripHeaderComments(markdown: string): string {
  // If there's an archive section, only consider the active section for the main editor
  const archiveIndex = markdown.search(/^\s*<!--\s*ARCHIVE\s*-->/im);
  const activeMarkdown = archiveIndex !== -1 ? markdown.slice(0, archiveIndex) : markdown;

  const lines = activeMarkdown.split('\n');
  let firstContentIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('<!--') || trimmed === '') {
      firstContentIndex = i + 1;
    } else {
      break;
    }
  }
  return lines.slice(firstContentIndex).join('\n');
}

/**
 * A lane's markdown from the editor's body: the editor never sees the file's leading comment lines (`<!-- Swimlane
 * Title: … -->`, `<!-- Project: … -->`, see stripHeaderComments), so they are put back from the lane's previous
 * markdown. Without them the first edit dropped the lane's saved name from its file.
 */
export function withHeaderComments(body: string, previous: string | undefined): string {
  const firstLine = body.split('\n').find((l) => l.trim() !== '');
  if (!previous || firstLine?.trim().startsWith('<!--')) return body;
  const header: string[] = [];
  for (const line of previous.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('<!--')) header.push(line);
    else if (trimmed !== '' || /^\s*<!--\s*ARCHIVE\s*-->/i.test(line)) break;
  }
  if (header.length === 0 || header.some((l) => /^\s*<!--\s*ARCHIVE\s*-->/i.test(l))) return body;
  return `${header.join('\n')}\n\n${body.replace(/^\s*\n/, '')}`;
}

/** A line ending in a markdown line break: an unescaped trailing backslash (Shift+Enter in the editor). */
const endsInHardBreak = (t: string) => /(^|[^\\])(\\\\)*\\$/.test(t.trimEnd());

/**
 * The last line of a title (or sub-item) that line `i` starts: past `i` while each line ends in a line break and the
 * next is an indented continuation (not a list item or a code fence). `i` itself when the title has no line break.
 */
function titleLastLine(lines: string[], i: number): number {
  let last = i;
  while (endsInHardBreak(splitAnchor(lines[last]).text) && last + 1 < lines.length) {
    const next = lines[last + 1];
    if (!/^\s+\S/.test(next) || /^\s*([*+-]|\d+\.)\s/.test(next) || /^\s*(`{3,}|~{3,})/.test(next)) break;
    last++;
  }
  return last;
}

/**
 * A title that goes on over line breaks, read as one line: joined with spaces, so a title struck through across the
 * break still reads as done. The lines after `i` are only read, never consumed.
 */
function withHardBreakLines(text: string, lines: string[], i: number): string {
  const last = titleLastLine(lines, i);
  if (last === i) return text;
  const parts = [text];
  for (let j = i + 1; j <= last; j++) parts.push(splitAnchor(lines[j]).text.trim());
  return parts.map((t, k) => (k < parts.length - 1 ? t.trimEnd().slice(0, -1).trimEnd() : t)).join(' ');
}

/**
 * Internal helper to parse a block of task markdown lines into TaskItem array
 */
function parseTaskItemsBlock(markdown: string, startIdOffset: number = 0, isArchived: boolean = false): { items: TaskItem[]; headerComments: string; bodyMarkdown: string } {
  const lines = markdown.split('\n');
  const items: TaskItem[] = [];
  let currentHeading: string | null = null;
  let currentHeadingPrefix = '##';
  let currentHeadingHasColon = false;
  let currentHeadingColor: string | undefined;
  let isHeadingActive = false;
  let currentCategory = isArchived ? 'Archive' : 'Untitled';
  let categoryCounter = 0;
  let currentTask: TaskItem | null = null;
  const commentLines: string[] = [];
  // The fenced code block the line is in, if any. Its lines are code, never tasks, headings or comments.
  let fence: { char: string; len: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (fence) {
      if (isFenceClose(line, fence)) fence = null;
      continue;
    }
    const fenceOpen = line.match(FENCE_OPEN_RE);
    if (fenceOpen) {
      fence = { char: fenceOpen[2][0], len: fenceOpen[2].length };
      // Indented, the code block belongs to the task above (it stays that task's); at the margin it ends the list.
      if (!fenceOpen[1] || !currentTask) {
        currentTask = null;
        isHeadingActive = false;
        currentCategory = isArchived ? 'Archive' : 'Untitled';
        categoryCounter = 0;
      }
      continue;
    }

    // Capture header comments
    if (line.trim().startsWith('<!--')) {
      commentLines.push(line);
      continue;
    }

    // Category / Section headers (e.g. # General TODOs: or ## other todos)
    const headingSplit = splitHeaderColor(line.trimEnd());
    const categoryMatch = headingSplit.name.match(/^(#{1,6})\s+(.+?)(:?)$/);
    if (categoryMatch && !line.trim().startsWith('<!--')) {
      const headingPrefix = categoryMatch[1];
      const hasColon = categoryMatch[3] === ':';
      const catText = categoryMatch[2].trim();
      currentHeadingColor = headingSplit.colorId;
      currentHeading = catText || 'Untitled';
      currentHeadingPrefix = headingPrefix;
      currentHeadingHasColon = hasColon;
      isHeadingActive = true;
      currentCategory = currentHeading;
      categoryCounter = 0;
      currentTask = null;
      continue;
    }

    // Horizontal rule separator
    if (line.trim().match(/^(-{3,}|\*{3,}|_{3,})$/)) {
      currentTask = null;
      isHeadingActive = false;
      currentCategory = isArchived ? 'Archive' : 'Untitled';
      categoryCounter = 0;
      continue;
    }

    // Subtask bullet lines (indented bullet or numbered item under currentTask)
    const subtaskMatch = line.match(/^(\t+|\s{2,})([*+-]|\d+\.)\s+(.*)$/);
    if (subtaskMatch && currentTask) {
      let subtext = withHardBreakLines(splitAnchor(subtaskMatch[3]).text.trim(), lines, i);
      // A sub-item that opens with a code block (older files): no text of its own, and the fence runs on below.
      const subFence = subtext.match(FENCE_OPEN_RE);
      if (subFence) {
        fence = { char: subFence[2][0], len: subFence[2].length };
        subtext = '';
      }
      // Check if item is marked done via unescaped strikethrough or checkbox
      const isDone = isUnescapedDone(subtext);
      const subHuman = isUnescapedHumanReview(subtext);

      subtext = cleanAndUnescapeMarkdown(subtext);

      currentTask.subtasks.push({
        id: `${currentTask.id}-${currentTask.subtasks.length + 1}`,
        text: subtext,
        isDone: isDone,
        isHumanReview: subHuman,
        sourceLine: i
      });

      if (isDone && currentTask.status === 'not_started') {
        currentTask.status = 'in_progress';
      }
      continue;
    }

    // Top-level numbered task item line (e.g. 1. Run bash terminal script or 1. ~~Run bash terminal script~~)
    // One leading space is the editor right-aligning numbers in a list of 10+ (" 9." above "10."), not nesting:
    // nested items are indented by their parent's marker width (2+ spaces) and handled above.
    const numberedMatch = line.match(/^ ?(\d+)\.\s+(.*)$/);
    if (numberedMatch) {
      const parsedNum = parseInt(numberedMatch[1], 10);
      if (parsedNum === 1) {
        if (isHeadingActive) {
          currentCategory = currentHeading || (isArchived ? 'Archive' : 'Untitled');
          isHeadingActive = false;
          categoryCounter = 1;
        } else {
          currentCategory = isArchived ? 'Archive' : 'Untitled';
        }
      } else {
        categoryCounter += 1;
      }

      const numberedSplit = splitAnchor(numberedMatch[2]);
      let rawTitle = withHardBreakLines(numberedSplit.text.trim(), lines, i);
      const numberedFence = rawTitle.match(FENCE_OPEN_RE);
      if (numberedFence) {
        fence = { char: numberedFence[2][0], len: numberedFence[2].length };
        rawTitle = '';
      }
      const isDone = isUnescapedDone(rawTitle);
      const isHumanReview = isUnescapedHumanReview(rawTitle);

      // Clean title and unescape
      const cleanedTitle = cleanAndUnescapeMarkdown(rawTitle);

      const nextId = startIdOffset + items.length + 1;
      currentTask = {
        id: nextId,
        title: cleanedTitle || `Task ${nextId}`,
        category: currentCategory,
        categoryHeadingPrefix: currentHeadingPrefix,
        categoryHasColon: currentHeadingHasColon,
        categoryColor: currentHeadingColor,
        listIndex: categoryCounter,
        listType: 'ordered',
        isUnordered: false,
        status: isDone ? 'done' : 'not_started',
        isDone,
        subtasks: [],
        isHumanReview,
        mcpRequired: extractMcpTags(cleanedTitle),
        isArchived,
        sourceLine: i,
        anchorId: numberedSplit.id ?? undefined
      };
      items.push(currentTask);
      continue;
    }

    // Top-level unnumbered bullet task (e.g. - title or - ~~title~~)
    const bulletMatch = line.match(/^[-*+]\s+(.*)$/);
    if (bulletMatch) {
      if (isHeadingActive) {
        currentCategory = currentHeading || (isArchived ? 'Archive' : 'Untitled');
        isHeadingActive = false;
        categoryCounter = 1;
      } else if (categoryCounter === 0) {
        currentCategory = isArchived ? 'Archive' : 'Untitled';
        categoryCounter = 1;
      } else {
        categoryCounter += 1;
      }

      const bulletSplit = splitAnchor(bulletMatch[1]);
      let rawTitle = withHardBreakLines(bulletSplit.text.trim(), lines, i);
      const bulletFence = rawTitle.match(FENCE_OPEN_RE);
      if (bulletFence) {
        fence = { char: bulletFence[2][0], len: bulletFence[2].length };
        rawTitle = '';
      }
      const isDone = isUnescapedDone(rawTitle);
      const isHumanReview = isUnescapedHumanReview(rawTitle);

      const cleanedTitle = cleanAndUnescapeMarkdown(rawTitle);

      const nextId = startIdOffset + items.length + 1;
      currentTask = {
        id: nextId,
        title: cleanedTitle || `Task ${nextId}`,
        category: currentCategory,
        categoryHeadingPrefix: currentHeadingPrefix,
        categoryHasColon: currentHeadingHasColon,
        categoryColor: currentHeadingColor,
        listIndex: categoryCounter,
        listType: 'bullet',
        isUnordered: true,
        status: isDone ? 'done' : 'not_started',
        isDone,
        subtasks: [],
        isHumanReview,
        mcpRequired: extractMcpTags(cleanedTitle),
        isArchived,
        sourceLine: i,
        anchorId: bulletSplit.id ?? undefined
      };
      items.push(currentTask);
      continue;
    }

    // An indented line under a task is more of that task (a screenshot, a second paragraph): the task goes on.
    if (currentTask && /^(\t|\s{2,})\S/.test(line)) continue;

    // Generic paragraph text outside of lists and headings
    if (line.trim() !== '') {
      currentTask = null;
      isHeadingActive = false;
      currentCategory = isArchived ? 'Archive' : 'Untitled';
      categoryCounter = 0;
    }
  }

  return {
    items,
    headerComments: commentLines.join('\n'),
    bodyMarkdown: stripHeaderComments(markdown)
  };
}

export interface ParsedTodoResult {
  items: TaskItem[];
  archivedItems: TaskItem[];
  headerComments: string;
  bodyMarkdown: string;
  archivedBodyMarkdown: string;
}

/**
 * Parses TODO.md content into structured TaskItem arrays (active and archived)
 */
export function parseTodoMarkdown(markdown: string): ParsedTodoResult {
  const archiveMatch = markdown.match(/^\s*<!--\s*ARCHIVE\s*-->/im);

  if (archiveMatch && archiveMatch.index !== undefined) {
    const activeMarkdown = markdown.slice(0, archiveMatch.index);
    const archivedMarkdown = markdown.slice(archiveMatch.index + archiveMatch[0].length);

    const activeResult = parseTaskItemsBlock(activeMarkdown, 0, false);
    const archivedResult = parseTaskItemsBlock(archivedMarkdown, 1000, true);

    return {
      items: activeResult.items,
      archivedItems: archivedResult.items,
      headerComments: activeResult.headerComments,
      bodyMarkdown: activeResult.bodyMarkdown,
      archivedBodyMarkdown: archivedResult.bodyMarkdown
    };
  }

  const activeResult = parseTaskItemsBlock(markdown, 0, false);
  return {
    items: activeResult.items,
    archivedItems: [],
    headerComments: activeResult.headerComments,
    bodyMarkdown: activeResult.bodyMarkdown,
    archivedBodyMarkdown: ''
  };
}

/**
 * Parses an individual SwimLane document into structured TaskItem arrays
 * with swimLaneId and sourceFileName metadata attached to each item.
 */
export function parseSwimLaneMarkdown(
  swimLane: SwimLaneDoc,
  _startIdOffset: number = 0
): ParsedTodoResult {
  const fileName = swimLane.filePath ? swimLane.filePath.split('/').pop() || 'TODO.md' : 'TODO.md';
  const result = parseTodoMarkdown(swimLane.markdown);

  const items = result.items.map((item, idx) => ({
    ...item,
    // A task's id comes from its line's hidden anchor (taskAnchors.ts), so it survives moves and edits.
    id: taskIdFor(swimLane.id, item.anchorId, idx),
    swimLaneId: swimLane.id,
    sourceFileName: fileName
  }));

  const archivedItems = result.archivedItems.map((item, idx) => ({
    ...item,
    id: `${swimLane.id}_archived_${idx + 1}`,
    swimLaneId: swimLane.id,
    sourceFileName: fileName
  }));

  return {
    ...result,
    items,
    archivedItems
  };
}

/**
 * Serializes a list of TaskItems into markdown text
 */
function serializeTaskListMarkdown(items: TaskItem[]): string {
  let md = '';
  // Group by categories
  const categoriesMap = new Map<string, TaskItem[]>();
  for (const item of items) {
    const cat = item.category || 'General TODOs';
    if (!categoriesMap.has(cat)) {
      categoriesMap.set(cat, []);
    }
    categoriesMap.get(cat)!.push(item);
  }

  categoriesMap.forEach((catItems, catName) => {
    if (catName && catName !== 'Untitled') {
      const firstItem = catItems[0];
      const prefix = firstItem?.categoryHeadingPrefix || '##';
      const colon = firstItem?.categoryHasColon ? ':' : '';
      const colorId = catItems.find((i) => i.categoryColor)?.categoryColor;
      const token = colorId ? ` {color=${colorId}}` : '';
      md += `${prefix} ${catName}${colon}${token}\n\n`;
    }
    let catIndex = 1;
    for (const item of catItems) {
      const titleFormatted = item.isDone ? `~~${item.title}~~` : item.title;
      if (item.isUnordered) {
        md += `- ${withAnchor(titleFormatted, item.anchorId ?? null)}\n`;
      } else {
        md += `${catIndex}. ${withAnchor(titleFormatted, item.anchorId ?? null)}\n`;
        catIndex++;
      }

      for (const sub of item.subtasks) {
        const subFormatted = sub.isDone ? `~~${sub.text}~~` : sub.text;
        md += `    - ${sub.isHumanReview ? '**human review** - ' : ''}${subFormatted}\n`;
      }
    }
    md += '\n';
  });

  return md.trim();
}

/**
 * Serializes TaskItem array back to TODO.md format, optionally including archived tasks
 */
export function serializeTodoMarkdown(
  items: TaskItem[],
  headerComment?: string,
  _archivedItems: TaskItem[] = []
): string {
  let md = headerComment && headerComment.trim() ? `${headerComment.trim()}\n\n` : '';

  // Active tasks only — archived tasks are removed from the workspace and preserved in vector memory
  const active = items.filter((i) => !i.isArchived);

  md += serializeTaskListMarkdown(active);
  return md.trim();
}

/**
 * Serializes tasks back to a lane's TODO markdown without disturbing what the editor wrote.
 *
 * `serializeTodoMarkdown` rebuilds the file from parsed tasks, which flattens nested sub-subtasks,
 * drops inline formatting (bold, links) and any prose between lists, and reads a task with struck words in it as
 * done. So the original text is kept: tasks that still match keep their lines verbatim (only a changed done-state is
 * patched), a task that is gone (archived, deleted) loses just its own lines, and a task that is new gets lines of
 * its own beside the task before it. Only a change the lines can't express falls back to a full re-serialize.
 */
export function serializeTodoMarkdownPreserving(
  items: TaskItem[],
  headerComment: string | undefined,
  originalMarkdown: string
): string {
  const fallback = () => serializeTodoMarkdown(items, headerComment);
  if (!originalMarkdown.trim() || /^\s*<!--\s*ARCHIVE\s*-->/im.test(originalMarkdown)) return fallback();

  const active = items.filter((i) => !i.isArchived);
  const original = parseTodoMarkdown(originalMarkdown).items;
  if (original.length === 0 || original.some((t) => t.sourceLine === undefined)) return fallback();

  const lines = originalMarkdown.split('\n');
  const patches = new Map<number, boolean>(); // line index -> desired done state

  const sameTask = (before: TaskItem, after: TaskItem) =>
    before.title === after.title &&
    before.isUnordered === after.isUnordered &&
    before.category === after.category &&
    before.subtasks.length === after.subtasks.length &&
    before.subtasks.every((bs, k) => bs.text === after.subtasks[k].text);

  // Line up the tasks with the original ones, in order: originals skipped over are gone, tasks with no original are new.
  const removed: number[] = [];
  const inserted: Array<{ after: number; item: TaskItem }> = []; // after: index of the original it follows, -1 = first
  let next = 0;
  for (const after of active) {
    let k = next;
    while (k < original.length && !sameTask(original[k], after)) k++;
    if (k === original.length) {
      inserted.push({ after: next - 1, item: after });
      continue;
    }
    for (let r = next; r < k; r++) removed.push(r);
    next = k + 1;
    const before = original[k];
    if (before.isDone !== after.isDone) patches.set(before.sourceLine!, after.isDone);
    before.subtasks.forEach((bs, s) => {
      const as = after.subtasks[s];
      if (bs.isDone !== as.isDone && bs.sourceLine !== undefined) patches.set(bs.sourceLine, as.isDone);
    });
  }
  for (let r = next; r < original.length; r++) removed.push(r);
  // A new task goes beside the task before it, under the same header; anything else is a reorganisation.
  for (const { after, item } of inserted) {
    const neighbour = original[after] ?? original[0];
    if (neighbour.category !== item.category) return fallback();
  }

  for (const [lineIdx, done] of patches) {
    const m = lines[lineIdx]?.match(/^(\s*(?:[-*+]|\d+\.)\s+)(.*?)(\s*)$/);
    if (!m) return fallback();
    const [, prefix, rawContent, trailing] = m;
    // A title with a line break: the ~~ wrap opens on its first line and closes at the end of its last one (closed
    // after the break's backslash, it would escape a tilde and end the break).
    const last = titleLastLine(lines, lineIdx);
    if (last !== lineIdx) {
      const { text, id } = splitAnchor(rawContent);
      const head = text.trimEnd().slice(0, -1).trimEnd(); // without the break's backslash
      const tail = lines[last].match(/^(\s*)(.*?)(\s*)$/)!;
      if (done) {
        lines[lineIdx] = `${prefix}~~${withAnchor(head, id)}\\${trailing}`;
        lines[last] = `${tail[1]}${tail[2]}~~${tail[3]}`;
      } else {
        if (!head.startsWith('~~') || !tail[2].endsWith('~~')) return fallback();
        lines[lineIdx] = `${prefix}${withAnchor(head.slice(2), id)}\\${trailing}`;
        lines[last] = `${tail[1]}${tail[2].slice(0, -2)}${tail[3]}`;
      }
      continue;
    }
    // The task's anchor stays outside the ~~done~~ wrap.
    const { text, id } = splitAnchor(rawContent);
    const content = text.trimEnd();
    if (done) {
      lines[lineIdx] = `${prefix}${withAnchor(`~~${content}~~`, id)}${trailing}`;
    } else {
      const unwrapped = content.match(/^~~(.*)~~$/s);
      if (!unwrapped) return fallback();
      lines[lineIdx] = `${prefix}${withAnchor(unwrapped[1], id)}${trailing}`;
    }
  }
  if (removed.length === 0 && inserted.length === 0) return lines.join('\n').trim();

  // Each original task's lines: its own line, then everything indented under it, without the blank lines after.
  const blockEnd = (start: number) => {
    let end = start + 1;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^\S/.test(lines[i]) || /^ \d+\.\s/.test(lines[i])) break;
      if (lines[i].trim() !== '') end = i + 1;
    }
    return end;
  };
  const blocks = original.map((t) => ({ start: t.sourceLine!, end: blockEnd(t.sourceLine!) }));
  const replaced: Array<string[] | null> = lines.map((l) => [l]);
  for (const r of removed) {
    const { start, end } = blocks[r];
    for (let i = start; i < end; i++) replaced[i] = null;
    // Don't leave the blank lines on both sides of the removed task behind as a double gap.
    if (end < lines.length && lines[end].trim() === '' && (start === 0 || lines[start - 1].trim() === '')) replaced[end] = null;
  }
  for (const { after, item } of inserted) {
    const title = item.isDone ? `~~${item.title}~~` : item.title;
    const own = [`${item.isUnordered ? '-' : '1.'} ${withAnchor(title, item.anchorId ?? null)}`];
    for (const sub of item.subtasks) {
      own.push(`    - ${sub.isHumanReview ? '**human review** - ' : ''}${sub.isDone ? `~~${sub.text}~~` : sub.text}`);
    }
    const anchorBlock = blocks[Math.max(0, after)];
    // Loose lists (a blank line between tasks) get one between the new task and its neighbour too.
    const loose = anchorBlock.end < lines.length && lines[anchorBlock.end].trim() === '';
    if (after < 0) {
      replaced[anchorBlock.start] = [...own, ...(loose ? [''] : []), ...(replaced[anchorBlock.start] ?? [])];
    } else {
      const at = anchorBlock.end - 1;
      replaced[at] = [...(replaced[at] ?? []), ...(loose ? [''] : []), ...own];
    }
  }
  // Keep where each line came from, so a list that lost its first task still starts at that task's number.
  const runStart = new Map<number, number>();
  for (const run of orderedListRuns(lines)) for (const i of run) runStart.set(i, parseInt(lines[run[0]].trim(), 10));
  const out: string[] = [];
  const startOf: Array<number | undefined> = [];
  replaced.forEach((group, i) => group?.forEach((line, k) => {
    out.push(line);
    startOf.push(k === 0 && line === lines[i] ? runStart.get(i) : undefined);
  }));
  for (const run of orderedListRuns(out)) {
    const start = run.map((i) => startOf[i]).find((n) => n !== undefined) ?? parseInt(out[run[0]].trim(), 10);
    const width = String(start + run.length - 1).length;
    run.forEach((i, n) => {
      out[i] = out[i].replace(/^ ?\d+\./, `${String(start + n).padStart(width, ' ')}.`);
    });
  }
  return out.join('\n').trim();
}

/** The line indices of each top-level ordered list's items, list by list (code blocks skipped). */
function orderedListRuns(lines: string[]): number[][] {
  const runs: number[][] = [];
  let run: number[] = [];
  const flush = () => {
    if (run.length > 0) runs.push(run);
    run = [];
  };
  let fence: { char: string; len: number } | null = null; // inside a code block nothing is a list item
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      if (isFenceClose(line, fence)) fence = null;
      continue;
    }
    const open = line.match(FENCE_OPEN_RE);
    if (open) {
      fence = { char: open[2][0], len: open[2].length };
      if (!open[1]) flush();
      continue;
    }
    if (/^ ?\d+\.\s/.test(line)) run.push(i);
    else if (/^\S/.test(line)) flush(); // a header, paragraph or bullet at the margin ends the list
  }
  flush();
  return runs;
}

/**
 * Synchronizes AgentContextItem array with updated TaskItem array:
 * - Preserves existing brief contents for matching tasks by sourceTaskId or title
 * - Preserves standalone and freeform AI tasks
 * - Removes obsolete briefs if explicit cleanup is needed
 */
export function syncBriefsWithTasks(
  prevBriefs: AgentContextItem[],
  currentTasks: TaskItem[]
): AgentContextItem[] {
  const updatedBriefs: AgentContextItem[] = [];

  for (let i = 0; i < currentTasks.length; i++) {
    const task = currentTasks[i];
    const newNumber = i + 1;

    // Try finding matching brief by sourceTaskId or by title
    const match = prevBriefs.find(
      (b) =>
        (b.sourceTaskId && b.sourceTaskId === task.id) ||
        b.title.trim().toLowerCase() === task.title.trim().toLowerCase()
    );

    if (match) {
      const overview = match.overview || match.brief || `Overview for ${task.title}`;
      const buildAndVerification = match.buildAndVerification || match.built || '';
      const completion = match.completion || match.validation || match.humanReview || match.followUps || '';
      updatedBriefs.push({
        ...match,
        id: match.id || `brief_${task.id}`,
        sourceTaskId: task.id,
        sourceLaneId: task.swimLaneId || match.sourceLaneId,
        itemNumber: newNumber,
        title: task.title,
        isUnordered: task.isUnordered,
        status: task.status,
        overview,
        buildAndVerification,
        completion,
        brief: overview,
        built: buildAndVerification,
        validation: completion,
      });
    } else {
      const overview = `Overview for ${task.title}`;
      updatedBriefs.push({
        id: `brief_${task.id}`,
        sourceTaskId: task.id,
        sourceLaneId: task.swimLaneId,
        itemNumber: newNumber,
        title: task.title,
        isUnordered: task.isUnordered,
        status: task.status,
        overview,
        buildAndVerification: '',
        completion: '',
        brief: overview,
        built: '',
        validation: '',
        humanReview: '',
        followUps: '',
      });
    }
  }

  // Also preserve any standalone / freeform AI briefs from prevBriefs that are not linked to tasks
  for (const prev of prevBriefs) {
    if (prev.sourceTaskId && !currentTasks.some((t) => t.id === prev.sourceTaskId)) {
      // Linked task was removed; skip or preserve as unlinked
      continue;
    }
    if (!prev.sourceTaskId && !updatedBriefs.some((b) => b.id === prev.id || b.title === prev.title)) {
      updatedBriefs.push(prev);
    }
  }

  return updatedBriefs;
}

// A fenced code block's opening line: up to its indent, three or more backticks (no backtick after) or tildes.
const FENCE_OPEN_RE = /^(\s*)(`{3,}(?=[^`]*$)|~{3,})/;

function isFenceClose(line: string, fence: { char: string; len: number }): boolean {
  const m = line.match(/^\s*(`{3,}|~{3,})\s*$/);
  return !!m && m[1][0] === fence.char && m[1].length >= fence.len;
}

function isUnescapedDone(text: string): boolean {
  if (/^\[[xX]\]/.test(text)) return true;
  // Match unescaped ~~...~~ (where the first ~ is not preceded by a backslash)
  // Negative lookbehind for backslash
  const strikethroughRegex = /(?<!\\)~~.*?(\\\\)*~~/s;
  if (strikethroughRegex.test(text)) return true;
  if (/<s>.*?<\/s>|<del>.*?<\/del>/i.test(text)) return true;
  return false;
}

function isUnescapedHumanReview(text: string): boolean {
  const hrRegex = /(?<!\\)\*\*human review(?<!\\)\*\*/i;
  return hrRegex.test(text);
}

export function cleanAndUnescapeMarkdown(text: string): string {
  let cleaned = text;

  // Strip leading checkbox syntax if any
  cleaned = cleaned.replace(/^\[[ xX]\]\s*/, '');
  cleaned = cleaned.replace(/^#{1,6}\s+/, '');
  cleaned = cleaned.replace(/^>\s+/, '');

  // Strip unescaped human review tags
  cleaned = cleaned.replace(/(?<!\\)\*\*human review(?<!\\)\*\*\s*-\s*/gi, '');

  cleaned = stripTextColorTokens(cleaned);
  // Spaces the editor keeps as entities (preserveWhitespace.ts)
  cleaned = cleaned.replace(/&nbsp;/g, ' ');

  // Strip unescaped bold/italic tags and strikethrough
  cleaned = cleaned.replace(/(?<!\\)~~/g, '');
  cleaned = cleaned.replace(/(?<!\\)\*\*/g, '');
  cleaned = cleaned.replace(/<s>/gi, '');
  cleaned = cleaned.replace(/<\/s>/gi, '');
  cleaned = cleaned.replace(/<del>/gi, '');
  cleaned = cleaned.replace(/<\/del>/gi, '');
  cleaned = cleaned.replace(/:$/, '');

  // Unescape escaped markdown punctuation (\*, \_, \~, \`, \#, [, \], \\, etc.)
  cleaned = cleaned.replace(/\\([*~_`#[\]()>+\-.!\\])/g, '$1');

  return cleaned.trim();
}

function extractMcpTags(text: string): string[] {
  const tags: string[] = [];
  const lower = text.toLowerCase();
  if (lower.includes('github') || lower.includes('git')) tags.push('github');
  if (lower.includes('slack')) tags.push('slack');
  if (lower.includes('drive') || lower.includes('g-drive') || lower.includes('dropbox') || lower.includes('excel') || lower.includes('xlsx')) tags.push('gdrive');
  if (lower.includes('figma')) tags.push('figma');
  if (lower.includes('bluebeam') || lower.includes('pdf')) tags.push('bluebeam');
  if (lower.includes('neon') || lower.includes('db') || lower.includes('database')) tags.push('database');
  return tags;
}
