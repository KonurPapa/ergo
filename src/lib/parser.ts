import { type TaskItem, type AgentContextItem, type SwimLaneDoc } from '../types';
import { splitHeaderColor, stripTextColorTokens } from './headerColors';

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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

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
      let subtext = subtaskMatch[3].trim();
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
    const numberedMatch = line.match(/^(\d+)\.\s+(.*)$/);
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

      let rawTitle = numberedMatch[2].trim();
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
        sourceLine: i
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

      let rawTitle = bulletMatch[1].trim();
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
        sourceLine: i
      };
      items.push(currentTask);
      continue;
    }

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
    id: `${swimLane.id}_task_${idx + 1}`,
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
        md += `- ${titleFormatted}\n`;
      } else {
        md += `${catIndex}. ${titleFormatted}\n`;
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
 * drops inline formatting (bold, links) and any prose between lists. When the tasks still match the
 * original document, the original text is kept verbatim; when only done-state differs, just those
 * lines are patched. Anything structural falls back to a full re-serialize.
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
  if (original.length !== active.length) return fallback();

  const lines = originalMarkdown.split('\n');
  const patches = new Map<number, boolean>(); // line index -> desired done state

  for (let t = 0; t < original.length; t++) {
    const before = original[t];
    const after = active[t];
    if (
      before.title !== after.title ||
      before.isUnordered !== after.isUnordered ||
      before.category !== after.category ||
      before.subtasks.length !== after.subtasks.length
    ) {
      return fallback();
    }
    if (before.isDone !== after.isDone && before.sourceLine !== undefined) {
      patches.set(before.sourceLine, after.isDone);
    }
    for (let s = 0; s < before.subtasks.length; s++) {
      const bs = before.subtasks[s];
      const as = after.subtasks[s];
      if (bs.text !== as.text) return fallback();
      if (bs.isDone !== as.isDone && bs.sourceLine !== undefined) {
        patches.set(bs.sourceLine, as.isDone);
      }
    }
  }

  for (const [lineIdx, done] of patches) {
    const m = lines[lineIdx]?.match(/^(\s*(?:[-*+]|\d+\.)\s+)(.*?)(\s*)$/);
    if (!m) return fallback();
    const [, prefix, content, trailing] = m;
    if (done) {
      lines[lineIdx] = `${prefix}~~${content}~~${trailing}`;
    } else {
      const unwrapped = content.match(/^~~(.*)~~$/s);
      if (!unwrapped) return fallback();
      lines[lineIdx] = `${prefix}${unwrapped[1]}${trailing}`;
    }
  }

  return lines.join('\n').trim();
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
