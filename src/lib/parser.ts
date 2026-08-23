import { type TaskItem, type AgentContextItem, type TaskStatus } from '../types';

export const ARCHIVE_DELIMITER = '<!-- ARCHIVE -->';

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
    const categoryMatch = line.match(/^(#{1,6})\s+(.+?)(:?)$/);
    if (categoryMatch && !line.trim().startsWith('<!--')) {
      const headingPrefix = categoryMatch[1];
      const catText = categoryMatch[2].trim();
      const hasColon = categoryMatch[3] === ':';
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
        isHumanReview: subHuman
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
        listIndex: categoryCounter,
        listType: 'ordered',
        isUnordered: false,
        status: isDone ? 'done' : 'not_started',
        isDone,
        subtasks: [],
        isHumanReview,
        mcpRequired: extractMcpTags(cleanedTitle),
        isArchived
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
        listIndex: categoryCounter,
        listType: 'bullet',
        isUnordered: true,
        status: isDone ? 'done' : 'not_started',
        isDone,
        subtasks: [],
        isHumanReview,
        mcpRequired: extractMcpTags(cleanedTitle),
        isArchived
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
      md += `${prefix} ${catName}${colon}\n\n`;
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
  archivedItems: TaskItem[] = []
): string {
  let md = headerComment && headerComment.trim() ? `${headerComment.trim()}\n\n` : '';

  // Separate active and archived if mixed in items
  const active = items.filter((i) => !i.isArchived);
  const explicitArchived = items.filter((i) => i.isArchived);
  const allArchived = [...explicitArchived, ...archivedItems];

  md += serializeTaskListMarkdown(active);

  if (allArchived.length > 0) {
    const archiveMd = serializeTaskListMarkdown(allArchived);
    md = md.trim() + `\n\n${ARCHIVE_DELIMITER}\n\n${archiveMd}`;
  }

  return md.trim();
}

/**
 * Synchronizes AgentContextItem array with updated TaskItem array:
 * - Renumbers briefs to mirror task item numbers and titles (1, 2, 3...)
 * - Preserves existing brief, built, validation, humanReview contents for matching tasks by title
 * - Removes briefs for deleted tasks
 * - Creates clean default briefs for newly added tasks without cross-polluting other tasks
 */
export function syncBriefsWithTasks(
  prevBriefs: AgentContextItem[],
  currentTasks: TaskItem[]
): AgentContextItem[] {
  const updatedBriefs: AgentContextItem[] = [];

  for (let i = 0; i < currentTasks.length; i++) {
    const task = currentTasks[i];
    const newNumber = i + 1;

    // Try finding matching brief by task title (case-insensitive)
    let match = prevBriefs.find(
      (b) => b.title.trim().toLowerCase() === task.title.trim().toLowerCase()
    );

    if (match) {
      const overview = match.overview || match.brief || `Overview for ${task.title}`;
      const buildAndVerification = match.buildAndVerification || match.built || '';
      const completion = match.completion || match.validation || match.humanReview || match.followUps || '';
      updatedBriefs.push({
        ...match,
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

  return updatedBriefs;
}

/**
 * Parses AGENT_CONTEXT.md content into structured AgentContextItem array
 */
/**
 * Helper to parse a block of AgentContext markdown into AgentContextItem array
 */
function parseAgentContextBlock(markdown: string, isArchived: boolean = false): AgentContextItem[] {
  const sections = markdown.split(/(?=^###\s+)/m);
  const items: AgentContextItem[] = [];

  for (const section of sections) {
    const headerMatch = section.match(/^###\s+(?:(\d+)\.\s+)?(.+)$/m);
    if (!headerMatch) continue;

    const isUnordered = !headerMatch[1];
    const itemNumber = headerMatch[1] ? parseInt(headerMatch[1], 10) : items.length + 1;
    const title = headerMatch[2].trim();

    // Extract Status
    const statusMatch = section.match(/\*\*Status:\*\*\s*(.+)$/m);
    const statusStr = statusMatch ? statusMatch[1].trim() : 'not started';

    // Parse sub-sections: Overview, Build & Verification, Completion (with backwards-compatibility)
    const overview = extractSectionContent(section, 'Overview') || extractSectionContent(section, 'Brief');
    const buildAndVerification =
      extractSectionContent(section, 'Build & Verification') ||
      extractSectionContent(section, 'Build and Verification') ||
      extractSectionContent(section, 'Built & Verification') ||
      extractSectionContent(section, 'Built');
    const completion =
      extractSectionContent(section, 'Completion') ||
      extractSectionContent(section, 'Validation') ||
      extractSectionContent(section, 'Human Review') ||
      extractSectionContent(section, 'Follow-ups') ||
      extractSectionContent(section, 'Followups');

    items.push({
      itemNumber,
      title,
      isUnordered,
      status: mapStatusString(statusStr),
      overview,
      buildAndVerification,
      completion,
      brief: overview,
      built: buildAndVerification,
      validation: completion,
      humanReview: completion,
      followUps: completion,
      rawContent: section,
      isArchived
    });
  }

  return items;
}

/**
 * Parses AGENT_CONTEXT.md content into structured AgentContextItem array (with isArchived flag)
 */
export function parseAgentContextMarkdown(markdown: string): AgentContextItem[] {
  const archiveMatch = markdown.match(/^\s*<!--\s*ARCHIVE\s*-->/im);
  if (archiveMatch && archiveMatch.index !== undefined) {
    const activeMarkdown = markdown.slice(0, archiveMatch.index);
    const archivedMarkdown = markdown.slice(archiveMatch.index + archiveMatch[0].length);

    const activeItems = parseAgentContextBlock(activeMarkdown, false);
    const archivedItems = parseAgentContextBlock(archivedMarkdown, true);
    return [...activeItems, ...archivedItems];
  }

  return parseAgentContextBlock(markdown, false);
}

/**
 * Parses AGENT_CONTEXT.md into separated active and archived item lists
 */
export function parseAgentContextWithArchive(markdown: string): { items: AgentContextItem[]; archivedItems: AgentContextItem[] } {
  const archiveMatch = markdown.match(/^\s*<!--\s*ARCHIVE\s*-->/im);
  if (archiveMatch && archiveMatch.index !== undefined) {
    const activeMarkdown = markdown.slice(0, archiveMatch.index);
    const archivedMarkdown = markdown.slice(archiveMatch.index + archiveMatch[0].length);

    const items = parseAgentContextBlock(activeMarkdown, false);
    const archivedItems = parseAgentContextBlock(archivedMarkdown, true);
    return { items, archivedItems };
  }

  const items = parseAgentContextBlock(markdown, false);
  return { items, archivedItems: [] };
}

/**
 * Helper to serialize a list of AgentContextItems into markdown sections
 */
function serializeAgentContextItemsList(items: AgentContextItem[]): string {
  let md = '';
  for (const item of items) {
    if (item.isUnordered) {
      md += `### ${item.title}\n\n`;
    } else {
      md += `### ${item.itemNumber}. ${item.title}\n\n`;
    }
    md += `**Status:** ${item.status}\n\n`;

    const overviewContent = item.overview || item.brief;
    if (overviewContent && overviewContent.trim()) {
      md += `**Overview**\n\n${overviewContent.trim()}\n\n`;
    }
    const buildContent = item.buildAndVerification || item.built;
    if (buildContent && buildContent.trim()) {
      md += `**Build & Verification**\n\n${buildContent.trim()}\n\n`;
    }
    const completionContent = item.completion || item.validation || item.humanReview || item.followUps;
    if (completionContent && completionContent.trim()) {
      md += `**Completion**\n\n${completionContent.trim()}\n\n`;
    }

    md += `---\n\n`;
  }
  return md.trim();
}

/**
 * Serializes AgentContextItem array back to AGENT_CONTEXT.md format, optionally including archived briefs
 */
export function serializeAgentContextMarkdown(
  items: AgentContextItem[],
  archivedItems: AgentContextItem[] = []
): string {
  let md = `# TODO context — the verbose half of \`TODO.md\`\n\n`;
  md += `\`TODO.md\` is the **human** view: the ask in Konur's words, scannable in seconds, with at most a one-line \`DONE:\` per finished item. This file is the **agent** view: the full overview for an item before it's built, mid-task build & verification notes, and the completion record of what was built and where the task stands.\n\n`;
  md += `Rules of the split:\n- Sections here mirror \`TODO.md\` **by item number and title** — same numbers, same order.\n- Not every item needs a section here — only ones that have been fleshed out or worked.\n- Verbosity is fine here. It lives here and only here.\n\n---\n\n`;

  const active = items.filter((i) => !i.isArchived);
  const explicitArchived = items.filter((i) => i.isArchived);
  const allArchived = [...explicitArchived, ...archivedItems];

  md += serializeAgentContextItemsList(active);

  if (allArchived.length > 0) {
    const archiveMd = serializeAgentContextItemsList(allArchived);
    md = md.trim() + `\n\n${ARCHIVE_DELIMITER}\n\n${archiveMd}\n\n---`;
  }

  return md.trim();
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractSectionContent(text: string, sectionName: string): string {
  // Custom parsing strategy for markdown sections (matching only unescaped section markers)
  const escapedName = escapeRegex(sectionName);
  const secStart = text.search(new RegExp(`(?<!\\\\)\\*\\*${escapedName}(?<!\\\\)\\*\\*`, 'i'));
  if (secStart === -1) return '';

  const afterSec = text.slice(secStart);
  const nextSecOffset = afterSec.slice(1).search(/\n(?<!\\)\*\*(Status|Overview|Build\s*(?:&|and)\s*Verification|Completion|Human Review|Brief|Built|Validation|Follow-ups|Followups)\*\*|\n### |\n---/i);

  let content = nextSecOffset !== -1 ? afterSec.slice(0, nextSecOffset + 1) : afterSec;
  // Remove section title heading line
  content = content.replace(new RegExp(`^(?<!\\\\)\\*\\*${escapedName}(?<!\\\\)\\*\\*\\s*(?:—\\s*)?`, 'i'), '').trim();
  return content;
}

function mapStatusString(statusStr: string): TaskStatus | string {
  const lower = statusStr.toLowerCase();
  if (lower.includes('done') || lower.includes('complete')) return 'done';
  if (lower.includes('in progress')) return 'in_progress';
  if (lower.includes('partly') || lower.includes('first pass')) return 'partly_done';
  return 'not_started';
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

function cleanAndUnescapeMarkdown(text: string): string {
  let cleaned = text;

  // Strip leading checkbox syntax if any
  cleaned = cleaned.replace(/^\[[ xX]\]\s*/, '');
  cleaned = cleaned.replace(/^#{1,6}\s+/, '');
  cleaned = cleaned.replace(/^>\s+/, '');

  // Strip unescaped human review tags
  cleaned = cleaned.replace(/(?<!\\)\*\*human review(?<!\\)\*\*\s*-\s*/gi, '');

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
