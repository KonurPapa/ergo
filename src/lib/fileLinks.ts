/**
 * Finds file paths in text (briefs, run notes, agent output) so they can open in the user's editor at the line:
 * `src/App.tsx`, `src/App.tsx:42`, `src/App.tsx:42:7`, `src/App.tsx#L42`, `src/App.tsx(42,7)`, `/abs/path.md`, `~/x.ts`,
 * `C:\repo\a.ts`. Pure (no React, no bridge): MarkdownRenderer uses `remarkFileLinks`, plain-text surfaces
 * `splitFileLinks`. Paths are only checked when clicked (the bridge says when the file isn't there).
 *
 * Kept out to avoid false positives: URLs and e-mail addresses, version numbers (`1.2.3`: an extension must start with
 * a letter), domains (`example.com/a.html`), abbreviations (`e.g./i.e.`), framework names in prose (`Node.js`), and
 * bare file names in prose unless their extension is a code/doc one (`App.tsx` yes, `foo.bar` no).
 */

export interface FileRef {
  /** The path as written, without the position. */
  path: string;
  line?: number;
  column?: number;
}

export interface FileRefMatch extends FileRef {
  /** Offsets of the whole match (path + position) in the text. */
  start: number;
  end: number;
  text: string;
}

/** Extensions a bare file name (no folder) must have to be linked. */
const CODE_EXTS = new Set(
  (
    'ts tsx mts cts js jsx mjs cjs json jsonc json5 py pyi rs go c cc cpp cxx h hh hpp cs java kt kts swift m mm rb php ' +
    'css scss sass less html htm vue svelte astro md mdx rst txt toml yaml yml ini cfg conf sh bash zsh fish ps1 bat ' +
    'sql prisma graphql gql proto xml gradle lock dart lua r scala ex exs erl hrl hs ml clj cljs elm zig nim tf hcl ' +
    'dockerfile ipynb csv tsv svg'
  ).split(' '),
);

/** Extensionless file names that are still files. */
const NAMED_FILES = 'Makefile|Dockerfile|Containerfile|Procfile|Gemfile|Rakefile|Justfile|Vagrantfile|Brewfile|LICENSE|CHANGELOG|README';

const TLD_RE = /^[\w-]+(?:\.[\w-]+)*\.(?:com|org|net|io|dev|ai|app|co|gov|edu|me|sh|xyz|info|us|uk|de|fr|jp|ca|au|ly|gg|so|to|tv|cloud|site|page|run)$/i;

// One path segment: word chars and . @ + - (plus a bracketed route group like [id]).
const SEG = String.raw`(?:[\w@+.\-]|\[[\w.\-]+\])+`;
const EXT = String.raw`\.[A-Za-z][A-Za-z0-9_]{0,11}`;
const NAME = String.raw`(?:(?:[\w@+.\-]|\[[\w.\-]+\])*${EXT}|(?:${NAMED_FILES}))`;
const PREFIX = String.raw`(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|[\\/])`;
const POSITION = String.raw`(?::(\d{1,7})(?::(\d{1,5}))?(?:-\d{1,7})?|#L(\d{1,7})(?:C(\d{1,5}))?(?:-L?\d{1,7})?|\((\d{1,7}),(\d{1,5})\))?`;

/** A path with at least one folder, or a bare file name; then an optional position. */
const PATH_RE = new RegExp(
  String.raw`(?<![\w@+.\-/\\~\]])(${PREFIX}?(?:${SEG}[\\/])+${NAME}|${PREFIX}?${NAME})(?![\w/\\]|\.\w)${POSITION}(?![\w(])`,
  'g',
);

const URLISH_RE = /\b(?:[a-z][a-z0-9+.-]{1,20}:\/\/|www\.)[^\s<>"'`]+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gi;

function maskedRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of text.matchAll(URLISH_RE)) out.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  return out;
}

function plausible(path: string, inCode: boolean): boolean {
  const hasDir = /[\\/]/.test(path.replace(/[\\/]$/, ''));
  // Some run of 2+ word characters somewhere (rules out "e.g./i.e").
  if (!/[A-Za-z0-9_]{2,}/.test(path)) return false;
  const segments = path.split(/[\\/]/).filter(Boolean);
  const last = segments[segments.length - 1] || '';
  const ext = /\.([A-Za-z][A-Za-z0-9_]*)$/.exec(last)?.[1]?.toLowerCase();
  if (hasDir) {
    // example.com/a/b.html (a URL without its scheme).
    if (!/^(?:[A-Za-z]:|~|\.{1,2})?[\\/]/.test(path) && TLD_RE.test(segments[0] || '')) return false;
    return true;
  }
  if (new RegExp(`^(?:${NAMED_FILES})$`).test(last)) return inCode;
  // Dotfiles (.env, .gitignore) only in code spans.
  if (/^\.[A-Za-z]/.test(last) && !last.slice(1).includes('.')) return inCode;
  if (!ext || !CODE_EXTS.has(ext)) return false;
  // "Node.js", "Next.js", "Vue.js" in prose are frameworks, not files.
  if (!inCode && /^(?:js|ts)$/.test(ext) && /^[A-Z][A-Za-z0-9]*\.(?:js|ts)$/.test(last)) return false;
  return true;
}

const num = (s: string | undefined) => (s ? Number(s) : undefined);

/** Every file path in `text`, in order. `inCode`: the text is an inline code span (bare names are linked more freely). */
export function findFileRefs(text: string, opts: { inCode?: boolean } = {}): FileRefMatch[] {
  if (!text || text.length > 200_000) return [];
  const masked = maskedRanges(text);
  const out: FileRefMatch[] = [];
  for (const m of text.matchAll(PATH_RE)) {
    let start = m.index ?? 0;
    const end = start + m[0].length;
    if (masked.some(([a, b]) => start < b && end > a)) continue;
    let path = m[1];
    // `@src/app.ts` (a task's @ reference): the @ isn't part of the path.
    if (path.startsWith('@') && !path.startsWith('@/')) {
      path = path.slice(1);
      start += 1;
    }
    if (path.length > 400 || !plausible(path, Boolean(opts.inCode))) continue;
    const line = num(m[2]) ?? num(m[4]) ?? num(m[6]);
    const column = num(m[3]) ?? num(m[5]) ?? num(m[7]);
    out.push({ path, ...(line ? { line } : {}), ...(line && column ? { column } : {}), start, end, text: text.slice(start, end) });
  }
  return out;
}

/** A single reference written as a link target or code span (`src/a.ts#L4`, `a.ts:4:2`), or null when it isn't one. */
export function parseFileRef(raw: string, opts: { inCode?: boolean } = {}): FileRef | null {
  const text = raw.trim();
  if (!text) return null;
  const refs = findFileRefs(text, opts);
  if (refs.length === 1 && refs[0].start === 0 && refs[0].end === text.length) {
    const { path, line, column } = refs[0];
    return { path, ...(line ? { line } : {}), ...(column ? { column } : {}) };
  }
  return null;
}

/** Text cut into plain parts and file references, for rendering. */
export type FileLinkPart = { kind: 'text'; text: string } | { kind: 'file'; text: string; ref: FileRef };

export function splitFileLinks(text: string, opts: { inCode?: boolean } = {}): FileLinkPart[] {
  const refs = findFileRefs(text, opts);
  if (refs.length === 0) return [{ kind: 'text', text }];
  const parts: FileLinkPart[] = [];
  let at = 0;
  for (const r of refs) {
    if (r.start > at) parts.push({ kind: 'text', text: text.slice(at, r.start) });
    parts.push({ kind: 'file', text: r.text, ref: { path: r.path, ...(r.line ? { line: r.line } : {}), ...(r.column ? { column: r.column } : {}) } });
    at = r.end;
  }
  if (at < text.length) parts.push({ kind: 'text', text: text.slice(at) });
  return parts;
}

// ── Markdown (remark) ──

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
  data?: Record<string, unknown>;
}

/** hast properties a linked path carries; MarkdownRenderer's `a` reads them (the href itself may be rewritten). */
export const FILE_LINK_PROPS = { path: 'dataFilePath', line: 'dataFileLine', column: 'dataFileColumn' } as const;

function fileLinkNode(text: string, ref: FileRef): MdNode {
  return {
    type: 'link',
    url: '#',
    children: [{ type: 'text', value: text }],
    data: {
      hProperties: {
        [FILE_LINK_PROPS.path]: ref.path,
        ...(ref.line ? { [FILE_LINK_PROPS.line]: String(ref.line) } : {}),
        ...(ref.column ? { [FILE_LINK_PROPS.column]: String(ref.column) } : {}),
      },
    },
  };
}

const SKIP_PARENTS = new Set(['link', 'linkReference', 'definition', 'code', 'inlineCode', 'html']);

function linkifyChildren(node: MdNode): void {
  if (!node.children || SKIP_PARENTS.has(node.type)) return;
  const next: MdNode[] = [];
  let changed = false;
  for (const child of node.children) {
    if (child.type === 'text' && typeof child.value === 'string') {
      const parts = splitFileLinks(child.value);
      if (parts.length > 1 || parts[0]?.kind === 'file') {
        changed = true;
        for (const p of parts) next.push(p.kind === 'text' ? { type: 'text', value: p.text } : fileLinkNode(p.text, p.ref));
        continue;
      }
    } else {
      linkifyChildren(child);
    }
    next.push(child);
  }
  if (changed) node.children = next;
}

/** remark plugin: file paths in prose become links MarkdownRenderer opens in the editor. Code spans are handled there. */
export function remarkFileLinks() {
  return (tree: MdNode) => {
    linkifyChildren(tree);
  };
}
