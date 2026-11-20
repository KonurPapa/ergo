/**
 * Lightweight parser for standard unified git diffs (`git diff -U3`), plus a side-by-side
 * row builder and a zero-token 1-sentence file change summarizer.
 */
import type { RunChangedFile } from './ideLinks';

export type DiffLineKind = 'context' | 'add' | 'del' | 'hunk' | 'meta';

export interface ParsedDiffLine {
  kind: DiffLineKind;
  oldLine?: number;
  newLine?: number;
  text: string;
}

export interface ParsedDiffHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: ParsedDiffLine[];
}

export interface ParsedUnifiedDiff {
  hunks: ParsedDiffHunk[];
  isBinary: boolean;
  isTruncated: boolean;
  additions: number;
  deletions: number;
}

export interface SplitDiffCell {
  kind: 'context' | 'add' | 'del' | 'empty';
  lineNumber?: number;
  text: string;
}

export interface SplitDiffRow {
  isHunk?: boolean;
  hunkHeader?: string;
  left?: SplitDiffCell;
  right?: SplitDiffCell;
}

const HUNK_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/;

/** Parses a unified diff string for a single file into structured hunks with line numbers. */
export function parseUnifiedDiff(raw: string): ParsedUnifiedDiff {
  if (!raw || !raw.trim()) {
    return { hunks: [], isBinary: false, isTruncated: false, additions: 0, deletions: 0 };
  }
  if (/^Binary files? /m.test(raw) || /^GIT binary patch$/m.test(raw)) {
    return { hunks: [], isBinary: true, isTruncated: false, additions: 0, deletions: 0 };
  }

  const lines = raw.split(/\r?\n/);
  const hunks: ParsedDiffHunk[] = [];
  let current: ParsedDiffHunk | null = null;
  let oldLn = 0;
  let newLn = 0;
  let additions = 0;
  let deletions = 0;
  let isTruncated = false;

  for (const line of lines) {
    if (line.startsWith('... (diff truncated')) {
      isTruncated = true;
      continue;
    }
    const hunkMatch = HUNK_RE.exec(line);
    if (hunkMatch) {
      oldLn = Number(hunkMatch[1]);
      newLn = Number(hunkMatch[3]);
      current = {
        header: line,
        oldStart: oldLn,
        oldCount: hunkMatch[2] !== undefined ? Number(hunkMatch[2]) : 1,
        newStart: newLn,
        newCount: hunkMatch[4] !== undefined ? Number(hunkMatch[4]) : 1,
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('+')) {
      current.lines.push({ kind: 'add', newLine: newLn++, text: line.slice(1) });
      additions++;
    } else if (line.startsWith('-')) {
      current.lines.push({ kind: 'del', oldLine: oldLn++, text: line.slice(1) });
      deletions++;
    } else if (line.startsWith(' ')) {
      current.lines.push({ kind: 'context', oldLine: oldLn++, newLine: newLn++, text: line.slice(1) });
    } else if (line.startsWith('\\')) {
      current.lines.push({ kind: 'meta', text: line.slice(1).trim() });
    }
  }

  return { hunks, isBinary: false, isTruncated, additions, deletions };
}

/** Converts parsed unified hunks into aligned side-by-side rows for Split view. */
export function buildSplitRows(parsed: ParsedUnifiedDiff): SplitDiffRow[] {
  const rows: SplitDiffRow[] = [];

  for (const hunk of parsed.hunks) {
    rows.push({ isHunk: true, hunkHeader: hunk.header });
    const lines = hunk.lines;
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line.kind === 'context') {
        rows.push({
          left: { kind: 'context', lineNumber: line.oldLine, text: line.text },
          right: { kind: 'context', lineNumber: line.newLine, text: line.text },
        });
        i++;
        continue;
      }
      if (line.kind === 'meta') {
        i++;
        continue;
      }
      // Group contiguous deletions and additions so replacements pair side-by-side.
      const dels: ParsedDiffLine[] = [];
      const adds: ParsedDiffLine[] = [];
      while (i < lines.length && lines[i].kind === 'del') {
        dels.push(lines[i++]);
      }
      while (i < lines.length && lines[i].kind === 'add') {
        adds.push(lines[i++]);
      }
      const maxLen = Math.max(dels.length, adds.length);
      for (let k = 0; k < maxLen; k++) {
        const d = dels[k];
        const a = adds[k];
        rows.push({
          left: d ? { kind: 'del', lineNumber: d.oldLine, text: d.text } : { kind: 'empty', text: '' },
          right: a ? { kind: 'add', lineNumber: a.newLine, text: a.text } : { kind: 'empty', text: '' },
        });
      }
    }
  }

  return rows;
}

const SYMBOL_RE =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|def|fn|func|struct|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/;

/**
 * Generates a calm, zero-token 1-sentence summary of what changed in a file from its diff stats
 * and top-level added/modified symbol names.
 */
export function summarizeFileChange(file: RunChangedFile, diffText?: string): string {
  if (file.binary) {
    if (file.status === 'added') return 'Added a new binary file.';
    if (file.status === 'deleted') return 'Removed this binary file.';
    return 'Updated this binary file.';
  }

  const parsed = diffText ? parseUnifiedDiff(diffText) : null;
  const symbols: string[] = [];
  if (parsed) {
    for (const h of parsed.hunks) {
      for (const l of h.lines) {
        if (l.kind !== 'add') continue;
        const m = SYMBOL_RE.exec(l.text);
        if (m && !symbols.includes(m[1])) {
          symbols.push(m[1]);
          if (symbols.length >= 3) break;
        }
      }
      if (symbols.length >= 3) break;
    }
  }

  const symbolSuffix =
    symbols.length > 0
      ? `, touching ${symbols.map((s) => `\`${s}\``).join(', ')}`
      : '';

  if (file.status === 'added') {
    return `Created with ${file.additions} line${file.additions === 1 ? '' : 's'}${symbolSuffix}.`;
  }
  if (file.status === 'deleted') {
    return `Deleted file (${file.deletions} line${file.deletions === 1 ? '' : 's'} removed).`;
  }

  const hunkCount = parsed?.hunks.length ?? 0;
  const sectionText = hunkCount > 1 ? ` across ${hunkCount} sections` : '';
  if (file.additions > 0 && file.deletions > 0) {
    return `Added ${file.additions} and removed ${file.deletions} line${file.deletions === 1 ? '' : 's'}${sectionText}${symbolSuffix}.`;
  }
  if (file.additions > 0) {
    return `Added ${file.additions} line${file.additions === 1 ? '' : 's'}${sectionText}${symbolSuffix}.`;
  }
  if (file.deletions > 0) {
    return `Removed ${file.deletions} line${file.deletions === 1 ? '' : 's'}${sectionText}.`;
  }
  return 'File metadata or permissions changed.';
}
