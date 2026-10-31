/**
 * Turns markdown files from elsewhere (Obsidian, GitHub, another todo app) into an Ergo project: the first file is the
 * project's TODO.md, every other file a swim lane of its own.
 */

export interface ImportedLane {
  /** File name in the project folder (TODO.md for the first). */
  fileName: string;
  title: string;
  markdown: string;
}

const FRONT_MATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
// "- [ ] task", "* [x] task", "1. [X] task" (GitHub / Obsidian checklists)
const CHECKBOX_RE = /^(\s*)([-*+]|\d+[.)])\s+\[([ xX])\]\s+(.*)$/;

/** A file's tasks in Ergo's form: checklist items become tasks, done ones struck through. */
export function convertImportedMarkdown(text: string): string {
  return text
    .replace(/^﻿/, '')
    .replace(FRONT_MATTER_RE, '')
    .split(/\r?\n/)
    .map((line) => {
      const m = line.match(CHECKBOX_RE);
      if (!m) return line;
      const [, indent, marker, mark, rest] = m;
      const body = rest.trim();
      const done = mark.toLowerCase() === 'x' && body && !/^~~.*~~$/.test(body);
      return `${indent}${marker} ${done ? `~~${body}~~` : body}`;
    })
    .join('\n')
    .trim();
}

/** The file's first heading, else its name made readable. */
export function importedTitle(fileName: string, text: string): string {
  const heading = text.replace(FRONT_MATTER_RE, '').match(/^#{1,3}\s+(.+?)\s*#*\s*$/m)?.[1];
  if (heading) return heading.replace(/[*_`~]/g, '').trim();
  return fileName.replace(/\.(md|markdown|txt)$/i, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim() || 'Imported';
}

/** Lanes for the chosen files, in the order given. */
export function importedLanes(files: Array<{ name: string; text: string }>): ImportedLane[] {
  const used = new Set<string>(['TODO.md']);
  return files.map((file, i) => {
    const title = importedTitle(file.name, file.text);
    const body = convertImportedMarkdown(file.text);
    if (i === 0) return { fileName: 'TODO.md', title, markdown: body };
    // Same naming as a lane made in the app (a renamed lane's file): TITLE_IN_CAPS.md
    const base = (title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'swim_lane').toUpperCase();
    let fileName = `${base}.md`;
    for (let n = 2; used.has(fileName); n++) fileName = `${base}_${n}.md`;
    used.add(fileName);
    return { fileName, title, markdown: `<!-- Swimlane Title: ${title} -->\n${body}` };
  });
}
