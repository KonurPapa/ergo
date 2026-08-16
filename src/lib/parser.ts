import { type TaskItem, type AgentContextItem, type TaskStatus } from '../types';

/**
 * Parses TODO.md content into structured TaskItem array
 */
export function parseTodoMarkdown(markdown: string): { items: TaskItem[]; headerComments: string } {
  const lines = markdown.split('\n');
  const items: TaskItem[] = [];
  let currentCategory = 'General TODOs';
  let currentTask: TaskItem | null = null;
  const commentLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Capture header comments
    if (line.trim().startsWith('<!--') || (i < 5 && line.trim().startsWith('#') && !line.match(/^##?\s+\w+/))) {
      if (line.trim().startsWith('<!--')) {
        commentLines.push(line);
      }
    }

    // Category headers (e.g. # Major TODOs for beta: or ## Missing features todos:)
    const categoryMatch = line.match(/^(?:#{1,6})\s+(.+):?$/);
    if (categoryMatch && !line.trim().startsWith('<!--')) {
      const catText = categoryMatch[1].trim().replace(/:$/, '');
      if (catText.toLowerCase() !== 'todos') {
        currentCategory = catText;
      }
      currentTask = null;
      continue;
    }

    // Horizontal rule separator
    if (line.trim().match(/^(-{3,}|\*{3,}|_{3,})$/)) {
      currentTask = null;
      continue;
    }

    // Task item line (e.g. 1. **conditions:** or 2. ~~**AI features:**~~ or - ~~zones~~)
    // Matches numbered items: 1. **title:** or 1. ~~**title:**~~ or 1. title
    const numberedMatch = line.match(/^(\d+)\.\s+(?:~~)?(?:\*\*)?(.*?)(?:\*\*)?(?:~~)?\s*:?\s*$/);
    const bulletMatch = line.match(/^[-*]\s+(?:~~)?(?:\*\*)?(.*?)(?:\*\*)?(?:~~)?\s*$/);

    if (numberedMatch) {
      let rawTitle = numberedMatch[2].trim();
      const isDone = line.includes('~~');
      const isHumanReview = line.includes('**human review**');
      
      // Clean title
      rawTitle = rawTitle.replace(/\*\*/g, '').replace(/~~/g, '').replace(/:$/, '').trim();

      const nextId = items.length + 1;
      currentTask = {
        id: nextId,
        title: rawTitle || `Task ${nextId}`,
        category: currentCategory,
        status: isDone ? 'done' : 'not_started',
        isDone,
        subtasks: [],
        isHumanReview,
        mcpRequired: extractMcpTags(rawTitle)
      };
      items.push(currentTask);
      continue;
    }

    if (bulletMatch && !currentTask) {
      // Top-level bullet task without number
      let rawTitle = bulletMatch[1].trim();
      const isDone = line.includes('~~');
      const isHumanReview = line.includes('**human review**');
      rawTitle = rawTitle.replace(/\*\*/g, '').replace(/~~/g, '').replace(/:$/, '').trim();

      const nextId = items.length + 1;
      currentTask = {
        id: nextId,
        title: rawTitle || `Task ${nextId}`,
        category: currentCategory,
        status: isDone ? 'done' : 'not_started',
        isDone,
        subtasks: [],
        isHumanReview,
        mcpRequired: extractMcpTags(rawTitle)
      };
      items.push(currentTask);
      continue;
    }

    // Subtask bullet lines under an existing item (e.g. - search feature in schedules panel)
    const subtaskMatch = line.match(/^\s{2,4}[-*]\s+(.*)$/);
    if (subtaskMatch && currentTask) {
      let subtext = subtaskMatch[1].trim();
      const subDone = subtext.includes('~~');
      const subHuman = subtext.includes('**human review**');

      subtext = subtext.replace(/~~/g, '').replace(/\*\*human review\*\*\s*-\s*/i, '').replace(/\*\*/g, '').trim();

      currentTask.subtasks.push({
        id: `${currentTask.id}-${currentTask.subtasks.length + 1}`,
        text: subtext,
        isDone: subDone,
        isHumanReview: subHuman
      });

      // Update status if partially done
      if (subDone && currentTask.status === 'not_started') {
        currentTask.status = 'in_progress';
      }
    }
  }

  return {
    items,
    headerComments: commentLines.join('\n') || '<!-- Keep this file scannable. Full briefs, build records and test notes live in AGENT_CONTEXT.md, keyed by item number. -->'
  };
}

/**
 * Serializes TaskItem array back to TODO.md format
 */
export function serializeTodoMarkdown(items: TaskItem[], headerComment?: string): string {
  let md = headerComment || '<!-- Keep this file scannable. Full briefs, build records and test notes live in AGENT_CONTEXT.md, keyed by item number. -->\n\n';

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
    md += `# ${catName}:\n\n`;
    let catIndex = 1;
    for (const item of catItems) {
      const titleFormatted = item.isDone ? `~~**${item.title}:**~~` : `**${item.title}:**`;
      md += `${catIndex}. ${titleFormatted}\n`;
      catIndex++;

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
 * Synchronizes AgentContextItem array with updated TaskItem array:
 * - Renumbers briefs to mirror task item numbers and titles (1, 2, 3...)
 * - Preserves existing brief, built, validation, humanReview contents for matching tasks
 * - Removes briefs for deleted tasks
 * - Creates default briefs for newly added tasks
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

    // If not found by title, try finding by previous index if available
    if (!match && prevBriefs[i]) {
      match = prevBriefs[i];
    }

    if (match) {
      updatedBriefs.push({
        ...match,
        itemNumber: newNumber,
        title: task.title,
        status: task.status,
      });
    } else {
      updatedBriefs.push({
        itemNumber: newNumber,
        title: task.title,
        status: task.status,
        brief: `Brief for ${task.title}`,
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
export function parseAgentContextMarkdown(markdown: string): AgentContextItem[] {
  const sections = markdown.split(/(?=^###\s+\d+\.)/m);
  const items: AgentContextItem[] = [];

  for (const section of sections) {
    const headerMatch = section.match(/^###\s+(\d+)\.\s+(.+)$/m);
    if (!headerMatch) continue;

    const itemNumber = parseInt(headerMatch[1], 10);
    const title = headerMatch[2].trim();

    // Extract Status
    const statusMatch = section.match(/\*\*Status:\*\*\s*(.+)$/m);
    const statusStr = statusMatch ? statusMatch[1].trim() : 'not started';

    // Parse sub-sections: Human Review (or Follow-ups), Brief, Built, Validation
    const humanReview = extractSectionContent(section, 'Human Review') || extractSectionContent(section, 'Follow-ups') || extractSectionContent(section, 'Followups');
    const brief = extractSectionContent(section, 'Brief');
    const built = extractSectionContent(section, 'Built');
    const validation = extractSectionContent(section, 'Validation');

    items.push({
      itemNumber,
      title,
      status: mapStatusString(statusStr),
      humanReview,
      followUps: humanReview,
      brief,
      built,
      validation,
      rawContent: section
    });
  }

  return items;
}

/**
 * Serializes AgentContextItem array back to AGENT_CONTEXT.md format
 */
export function serializeAgentContextMarkdown(items: AgentContextItem[]): string {
  let md = `# TODO context — the verbose half of \`TODO.md\`\n\n`;
  md += `\`TODO.md\` is the **human** view: the ask in Konur's words, scannable in seconds, with at most a one-line \`DONE:\` per finished item. This file is the **agent** view: the full brief for an item before it's built, and the full record of what was built after.\n\n`;
  md += `Rules of the split:\n- Sections here mirror \`TODO.md\` **by item number and title** — same numbers, same order.\n- Not every item needs a section here — only ones that have been fleshed out or worked.\n- Verbosity is fine here. It lives here and only here.\n\n---\n\n`;

  for (const item of items) {
    md += `### ${item.itemNumber}. ${item.title}\n\n`;
    md += `**Status:** ${item.status}\n\n`;

    const reviewContent = item.humanReview || item.followUps;
    if (reviewContent && reviewContent.trim()) {
      md += `**Human Review**\n\n${reviewContent.trim()}\n\n`;
    }
    if (item.brief && item.brief.trim()) {
      md += `**Brief**\n\n${item.brief.trim()}\n\n`;
    }
    if (item.built && item.built.trim()) {
      md += `**Built**\n\n${item.built.trim()}\n\n`;
    }
    if (item.validation && item.validation.trim()) {
      md += `**Validation**\n\n${item.validation.trim()}\n\n`;
    }

    md += `---\n\n`;
  }

  return md.trim();
}

function extractSectionContent(text: string, sectionName: string): string {
  // Custom parsing strategy for markdown sections
  const secStart = text.search(new RegExp(`\\*\\*${sectionName}\\*\\*`, 'i'));
  if (secStart === -1) return '';

  const afterSec = text.slice(secStart);
  const nextSecOffset = afterSec.slice(1).search(/\n\*\*(Status|Human Review|Brief|Built|Validation|Follow-ups|Followups)\*\*|\n### |\n---/i);

  let content = nextSecOffset !== -1 ? afterSec.slice(0, nextSecOffset + 1) : afterSec;
  // Remove section title heading line
  content = content.replace(new RegExp(`^\\*\\*${sectionName}\\*\\*\\s*(?:—\\s*)?`, 'i'), '').trim();
  return content;
}

function mapStatusString(statusStr: string): TaskStatus | string {
  const lower = statusStr.toLowerCase();
  if (lower.includes('done') || lower.includes('complete')) return 'done';
  if (lower.includes('in progress')) return 'in_progress';
  if (lower.includes('partly') || lower.includes('first pass')) return 'partly_done';
  return 'not_started';
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
