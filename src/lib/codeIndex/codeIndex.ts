/**
 * Code index — semantic + keyword search over the code in the user's Allowed Folders (bridge side, Node only).
 *
 * Every source file is split into 30-line sections. Each section gets a keyword index (BM25, always current: it is
 * rebuilt the moment a changed file is re-read) and a MiniLM embedding (the memory model, computed in the background
 * at the lowest queue priority). A search ranks sections by both and fuses the rankings. Measured on real Ergo tasks:
 * 86-87% of the files an agent ended up editing are in the top 10; file names alone reach 22-28%.
 *
 * Staying current: a recursive file watcher queues changed files; after a short quiet period each one is re-read and
 * its sections replaced. Vectors are keyed by the hash of the exact text they were computed from, so they never go
 * stale — an edited section simply has no vector until the background embedder catches up, and until then it is
 * still found by keywords.
 *
 * Files being written while they are indexed: the indexer only ever READS project files (no locks, no writes), so an
 * agent is never blocked. A file is read between two stats; if it changed in between, or changes again before its
 * sections are swapped in, the read is discarded and retried after the next quiet period. Swapping a file's sections
 * is one synchronous Map update, so a search sees either the old or the new version of a file, never a mix.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

// ─── Tunables ─────────────────────────────────────────────────────────────────

const CHUNK_LINES = 30;
/** Most lines of surrounding code returned on each side of a matching section (fewer when more sections are asked for). */
const MAX_CONTEXT_LINES = 20;
const MIN_CONTEXT_LINES = 5;
/**
 * Code lines one result may show in total. Every result stays in the agent's context and is re-read on each later
 * turn: an unbounded result (8 sections × 70 lines ≈ 6k tokens) cost more than the searching it saved.
 */
const RESULT_LINE_BUDGET = 260;
const DEFAULT_RESULTS = 5;
const MAX_RESULTS = 8;
/** Declarations listed in a file's outline. */
const OUTLINE_SYMBOLS = 15;
/** Sections per file in one result list (the rest of a file is one read away). */
const MAX_HITS_PER_FILE = 2;
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 400_000;
const MAX_TOTAL_BYTES = 120 * 1024 * 1024;
/** Quiet period after the last change event before changed files are re-read. */
const SETTLE_MS = 1_500;
/** Re-read attempts for a file that keeps changing while it is read. */
const MAX_READ_RETRIES = 5;
const EMBED_BATCH = 32;
const SAVE_DEBOUNCE_MS = 5_000;
/** Safety-net rescan (stat comparison only) in case the watcher missed something. */
const RESCAN_INTERVAL_MS = 10 * 60_000;

/** Source files. Docs and data (md, json, yaml) are left out: they crowded real code out of the results. */
const CODE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi|css|scss|sass|less|html|htm|vue|svelte|astro|java|kt|kts|scala|go|rs|rb|php|cs|fs|swift|m|mm|c|h|cc|cpp|cxx|hpp|hh|sql|sh|bash|zsh|ps1|lua|dart|ex|exs|erl|hrl|clj|cljs|r|jl|gradle|tf|proto|graphql|gql|prisma|zig|nim|elm|hs|ml|mli|sol)$/i;
export const SKIP_DIR = /(^|\/)(node_modules|\.git|dist|build|out|\.next|\.nuxt|\.output|coverage|vendor|target|__pycache__|\.venv|venv|env|\.ergo|\.cache|\.turbo|\.svelte-kit|\.parcel-cache|\.gradle|Pods|DerivedData|bower_components)(\/|$)/;
const SKIP_FILE = /(\.min\.(js|css)|\.map|\.bundle\.js|\.chunk\.js|-lock\.\w+|\.lock)$/i;

// ─── Types ────────────────────────────────────────────────────────────────────

export type CodeIndexState = 'scanning' | 'indexing' | 'ready' | 'error' | 'too-large';

export interface CodeIndexStatus {
  root: string;
  state: CodeIndexState;
  files: number;
  sections: number;
  /** Sections that have their embedding. */
  embedded: number;
  /** Changed files waiting to be re-read. */
  pendingFiles: number;
  updatedAt?: number;
  error?: string;
}

export type CodeEmbedFn = (texts: string[], priority: 'query' | 'background') => Promise<Float32Array[]>;

interface Section {
  start: number;
  end: number;
  hash: string;
  tf: Map<string, number>;
  len: number;
}

interface FileEntry {
  rel: string;
  size: number;
  mtimeMs: number;
  lines: string[];
  sections: Section[];
  /** Declarations (name, 1-based line; `nested`: a method or inner function), for the "in X" label and the outline. */
  symbols: Array<{ name: string; line: number; nested?: boolean }>;
}

// ─── Text helpers ─────────────────────────────────────────────────────────────

function words(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .toLowerCase()
    .split(' ')
    .filter((w) => w.length > 1);
}

const STOP = new Set(
  'the a an and or to of in on for is it this that be we i you with as at by from are was if not but so do can should need want make when then there have has into all any some our my your what how which also just like use using where find code file files'.split(' ')
);

function sha(s: string): string {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 20);
}

const SYMBOL_RE = /^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function\*?\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\(|function|React\.|memo\(|forwardRef\(|[A-Za-z_$][\w$]*\s*=>)|class\s+([A-Za-z_$][\w$]*)|interface\s+([A-Za-z_$][\w$]*)|type\s+([A-Za-z_$][\w$]*)\s*=|enum\s+([A-Za-z_$][\w$]*))|^(?:async\s+)?def\s+([A-Za-z_]\w*)|^class\s+([A-Za-z_]\w*)|^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)|^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)|^(?:pub\s+)?(?:struct|enum|trait|impl)\s+([A-Za-z_]\w*)/;

/** Indented methods / inner functions: `  async save(a) {`, `  get x() {`, `    def run(self):`, `  const f = (…) =>`. */
const NESTED_RE = /^\s+(?:(?:public|private|protected|static|async|override|readonly|get|set)\s+)*(?:([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[^{=]+)?\{\s*$|def\s+([A-Za-z_]\w*)\s*\(|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)/;
const NOT_A_NAME = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'with', 'else', 'do', 'try', 'super', 'constructor']);

function extractSymbols(lines: string[]): FileEntry['symbols'] {
  const out: FileEntry['symbols'] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = SYMBOL_RE.exec(lines[i]);
    const name = m?.slice(1).find(Boolean);
    if (name) {
      out.push({ name, line: i + 1 });
      continue;
    }
    const n = NESTED_RE.exec(lines[i]);
    const nested = n?.slice(1).find(Boolean);
    if (nested && !NOT_A_NAME.has(nested)) out.push({ name: nested, line: i + 1, nested: true });
  }
  return out;
}

function buildSections(rel: string, lines: string[]): Section[] {
  const out: Section[] = [];
  for (let i = 0; i < lines.length; i += CHUNK_LINES) {
    const body = lines.slice(i, i + CHUNK_LINES).join('\n');
    if (!body.trim()) continue;
    const text = `${rel}\n${body}`;
    const tf = new Map<string, number>();
    const ws = words(text);
    for (const w of ws) tf.set(w, (tf.get(w) || 0) + 1);
    out.push({ start: i + 1, end: Math.min(lines.length, i + CHUNK_LINES), hash: sha(text), tf, len: ws.length });
  }
  return out;
}

/** The text a section's embedding is computed from (path line + its code). */
function sectionText(f: FileEntry, s: Section): string {
  return `${f.rel}\n${f.lines.slice(s.start - 1, s.end).join('\n')}`;
}

function run(cmd: string, args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, maxBuffer: 256 * 1024 * 1024, timeout: 60_000 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

function isIndexable(rel: string): boolean {
  return CODE_EXT.test(rel) && !SKIP_DIR.test(rel) && !SKIP_FILE.test(rel);
}

// ─── One indexed folder ───────────────────────────────────────────────────────

export class CodeIndex {
  readonly root: string;
  private readonly storeFile: string;
  private readonly embed: CodeEmbedFn;
  private readonly log: (msg: string, err?: unknown) => void;

  private files = new Map<string, FileEntry>();
  private vectors = new Map<string, Float32Array>();
  private state: CodeIndexState = 'scanning';
  private error?: string;
  private updatedAt?: number;
  private isGit = false;

  private pending = new Map<string, number>(); // rel → read attempts so far
  private settleTimer: NodeJS.Timeout | null = null;
  private rescanTimer: NodeJS.Timeout | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private watcher: fsSync.FSWatcher | null = null;
  private embedding = false;
  private disposed = false;
  private scanPromise: Promise<void> | null = null;
  private statsDirty = true;
  private df = new Map<string, number>();
  private avgLen = 1;
  private sectionCount = 0;

  constructor(opts: { root: string; storeFile: string; embed: CodeEmbedFn; log: (msg: string, err?: unknown) => void }) {
    this.root = opts.root;
    this.storeFile = opts.storeFile;
    this.embed = opts.embed;
    this.log = opts.log;
  }

  /** Loads saved vectors, scans the folder, starts watching and embedding. Resolves once the scan is done. */
  start(): Promise<void> {
    this.loadVectors();
    this.watch();
    this.rescanTimer = setInterval(() => void this.rescan(), RESCAN_INTERVAL_MS);
    this.rescanTimer.unref?.();
    return this.rescan();
  }

  dispose(deleteStore = false): void {
    this.disposed = true;
    this.watcher?.close();
    for (const t of [this.settleTimer, this.saveTimer]) if (t) clearTimeout(t);
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    if (deleteStore) {
      for (const f of [this.storeFile, `${this.storeFile}.f32`]) fsSync.rmSync(f, { force: true });
    } else {
      this.saveSync();
    }
  }

  status(): CodeIndexStatus {
    let sections = 0;
    let embedded = 0;
    for (const f of this.files.values()) {
      for (const s of f.sections) {
        sections++;
        if (this.vectors.has(s.hash)) embedded++;
      }
    }
    const state = this.state === 'ready' && (embedded < sections || this.pending.size > 0) ? 'indexing' : this.state;
    return {
      root: this.root,
      state,
      files: this.files.size,
      sections,
      embedded,
      pendingFiles: this.pending.size,
      ...(this.updatedAt ? { updatedAt: this.updatedAt } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  /**
   * Brings the index in line with the disk by comparing sizes and modified times (re-reads only what differs).
   * Concurrent calls share one scan.
   */
  rescan(): Promise<void> {
    if (!this.scanPromise) {
      this.scanPromise = this.doRescan().finally(() => {
        this.scanPromise = null;
      });
    }
    return this.scanPromise;
  }

  private async doRescan(): Promise<void> {
    try {
      const listed = await this.listFiles();
      if (this.disposed) return;
      if (listed === 'too-large') {
        this.state = 'too-large';
        this.error = `More than ${MAX_FILES.toLocaleString()} source files or ${MAX_TOTAL_BYTES / 1024 / 1024} MB — pick a project folder instead.`;
        return;
      }
      const keep = new Set(listed.map((f) => f.rel));
      for (const rel of [...this.files.keys()]) if (!keep.has(rel)) this.removeFile(rel);
      const changed = listed.filter((f) => {
        const cur = this.files.get(f.rel);
        return !cur || cur.size !== f.size || cur.mtimeMs !== f.mtimeMs;
      });
      // Read in small parallel batches: a first scan of a large repo shouldn't open thousands of files at once.
      for (let i = 0; i < changed.length; i += 32) {
        await Promise.all(changed.slice(i, i + 32).map((f) => this.readFile(f.rel)));
        if (this.disposed) return;
      }
      if (this.state !== 'ready') this.state = 'ready';
      this.error = undefined;
      this.updatedAt = Date.now();
      if (changed.length > 0) this.log(`Code index ${this.root}: ${this.files.size} files (${changed.length} re-read)`);
      void this.embedMissing();
    } catch (err: any) {
      this.state = 'error';
      this.error = err?.message || String(err);
      this.log(`Code index scan failed for ${this.root}`, err);
    }
  }

  /** Every indexable file under the root with its size and modified time. */
  private async listFiles(): Promise<Array<{ rel: string; size: number; mtimeMs: number }> | 'too-large'> {
    // Inside a git work tree: tracked + untracked-but-not-ignored files (honours .gitignore). Otherwise walk.
    const gitOut = await run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], this.root);
    this.isGit = gitOut !== null;
    let rels: string[];
    if (gitOut !== null) {
      rels = [...new Set(gitOut.split('\0').filter(Boolean))];
    } else {
      rels = [];
      const walk = async (dir: string, depth: number) => {
        if (depth > 14 || rels.length > MAX_FILES * 4) return;
        let entries: fsSync.Dirent[];
        try {
          entries = await fs.readdir(path.join(this.root, dir), { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const rel = dir ? `${dir}/${e.name}` : e.name;
          if (e.isDirectory()) {
            if (!SKIP_DIR.test(`${rel}/`) && !e.name.startsWith('.')) await walk(rel, depth + 1);
          } else if (e.isFile()) {
            rels.push(rel);
          }
        }
      };
      await walk('', 0);
    }
    const out: Array<{ rel: string; size: number; mtimeMs: number }> = [];
    let total = 0;
    for (const rel of rels) {
      if (!isIndexable(rel)) continue;
      const st = await fs.stat(path.join(this.root, rel)).catch(() => null);
      if (!st || !st.isFile() || st.size > MAX_FILE_BYTES) continue;
      total += st.size;
      out.push({ rel, size: st.size, mtimeMs: st.mtimeMs });
      if (out.length > MAX_FILES || total > MAX_TOTAL_BYTES) return 'too-large';
    }
    return out;
  }

  /**
   * (Re-)reads one file and swaps in its sections. The read sits between two stats: if the file changed in between
   * (someone is writing it), nothing is swapped and the file is retried after the next quiet period.
   */
  private async readFile(rel: string): Promise<void> {
    const full = path.join(this.root, rel);
    const before = await fs.stat(full).catch(() => null);
    if (!before || !before.isFile()) {
      // Gone (or replaced by a rename mid-write): drop it only if it is still gone after a quiet period.
      if (this.files.has(rel)) this.queue(rel, 'missing', true);
      return;
    }
    if (before.size > MAX_FILE_BYTES) {
      this.removeFile(rel);
      return;
    }
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(full);
    } catch {
      this.queue(rel, 'unreadable', true);
      return;
    }
    const after = await fs.stat(full).catch(() => null);
    if (!after || after.mtimeMs !== before.mtimeMs || after.size !== before.size || bytes.length !== after.size) {
      this.queue(rel, 'changed while read', true);
      return;
    }
    if (bytes.includes(0)) {
      this.removeFile(rel); // binary
      return;
    }
    const text = bytes.toString('utf8');
    const lines = text.split('\n');
    const entry: FileEntry = { rel, size: after.size, mtimeMs: after.mtimeMs, lines, sections: buildSections(rel, lines), symbols: extractSymbols(lines) };
    this.files.set(rel, entry); // one synchronous swap: searches see the old or the new file, never a mix
    this.pending.delete(rel);
    this.statsDirty = true;
    this.updatedAt = Date.now();
  }

  private removeFile(rel: string): void {
    if (this.files.delete(rel)) this.statsDirty = true;
    this.pending.delete(rel);
  }

  /**
   * Queues a file for re-reading after the quiet period. `failed`: a read attempt just failed (bounded retries for a
   * file that never settles); change events only (re)arm the timer.
   */
  private queue(rel: string, why: string, failed = false): void {
    if (this.disposed) return;
    const attempts = (this.pending.get(rel) ?? (failed ? -1 : 0)) + (failed ? 1 : 0);
    if (attempts > MAX_READ_RETRIES) {
      this.log(`Code index ${this.root}: giving up on ${rel} for now (${why}); the next change or rescan retries it`);
      this.pending.delete(rel);
      return;
    }
    this.pending.set(rel, attempts);
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => void this.flushPending(), SETTLE_MS);
    this.settleTimer.unref?.();
  }

  private async flushPending(): Promise<void> {
    this.settleTimer = null;
    const rels = [...this.pending.keys()];
    for (const rel of rels) {
      if (this.disposed) return;
      const full = path.join(this.root, rel);
      if (!fsSync.existsSync(full)) {
        // Still gone after the quiet period: deleted.
        if ((this.pending.get(rel) ?? 0) >= 1 || !this.files.has(rel)) this.removeFile(rel);
        else this.queue(rel, 'missing', true);
        continue;
      }
      await this.readFile(rel);
    }
    void this.embedMissing();
  }

  private watch(): void {
    try {
      this.watcher = fsSync.watch(this.root, { recursive: true, persistent: false }, (_event, filename) => {
        if (!filename) return;
        const rel = filename.toString().split(path.sep).join('/');
        if (rel === '.git/HEAD' || rel.endsWith('/.gitignore') || rel === '.gitignore') {
          void this.rescan(); // branch switch / pull / ignore rules: compare everything
          return;
        }
        if (!isIndexable(rel)) return;
        if (!this.files.has(rel) && this.isGit) {
          // A new file: index it unless git ignores it.
          void run('git', ['check-ignore', '-q', rel], this.root).then((ignored) => {
            if (ignored === null) this.queue(rel, 'new');
          });
          return;
        }
        this.queue(rel, 'changed');
      });
      this.watcher.on('error', (err) => {
        this.log(`Code index ${this.root}: file watcher stopped; relying on rescans`, err);
        this.watcher?.close();
        this.watcher = null;
      });
    } catch (err) {
      this.log(`Code index ${this.root}: cannot watch this folder; relying on rescans`, err);
    }
  }

  /** Embeds every section without a vector, in background batches. One loop at a time. */
  private async embedMissing(): Promise<void> {
    if (this.embedding || this.disposed) return;
    this.embedding = true;
    try {
      while (!this.disposed) {
        const batch: Array<{ hash: string; text: string }> = [];
        const seen = new Set<string>();
        outer: for (const f of this.files.values()) {
          for (const s of f.sections) {
            if (this.vectors.has(s.hash) || seen.has(s.hash)) continue;
            seen.add(s.hash);
            batch.push({ hash: s.hash, text: sectionText(f, s) });
            if (batch.length >= EMBED_BATCH) break outer;
          }
        }
        if (batch.length === 0) break;
        const vecs = await this.embed(batch.map((b) => b.text), 'background');
        // Keyed by the hash of the text they came from: correct even if the file changed meanwhile.
        batch.forEach((b, i) => this.vectors.set(b.hash, vecs[i]));
        this.scheduleSave();
      }
    } catch (err) {
      this.log(`Code index ${this.root}: embedding failed; keyword search still works`, err);
    } finally {
      this.embedding = false;
    }
  }

  // ─── Search ─────────────────────────────────────────────────────────────────

  private refreshStats(): void {
    if (!this.statsDirty) return;
    this.df = new Map();
    let total = 0;
    let n = 0;
    for (const f of this.files.values()) {
      for (const s of f.sections) {
        n++;
        total += s.len;
        for (const w of s.tf.keys()) this.df.set(w, (this.df.get(w) || 0) + 1);
      }
    }
    this.sectionCount = n;
    this.avgLen = n ? total / n : 1;
    this.statsDirty = false;
  }

  /** Whether `p` (absolute) is inside this index's folder. */
  covers(p: string): boolean {
    const rel = path.relative(this.root, p);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }

  /**
   * Best-matching code sections for `query`, as text for an agent: each hit widened by CONTEXT_LINES on both sides,
   * labelled with its enclosing declaration, plus each file's outline. `under`: limit to a subfolder (relative);
   * `files`: limit to these files (relative paths).
   */
  async search(query: string, opts: { k?: number; under?: string; files?: string[] } = {}): Promise<string> {
    if (this.scanPromise && this.files.size === 0) await this.scanPromise;
    if (this.state === 'too-large') return `Not indexed: ${this.error}`;
    const k = Math.max(1, Math.min(MAX_RESULTS, Math.floor(opts.k || DEFAULT_RESULTS)));
    const under = (opts.under || '').replace(/^\.?\/+/, '').replace(/\/+$/, '');
    const only = opts.files?.length ? new Set(opts.files.map((f) => path.normalize(f.replace(/^\.?\/+/, '')))) : null;
    this.refreshStats();

    // Keyword-only if the model is unavailable.
    const qv = await this.embed([query], 'query').then((v) => v[0]).catch(() => undefined);
    const qWords = [...new Set(words(query).filter((w) => !STOP.has(w)))];
    type Cand = { f: FileEntry; s: Section; dense: number | null; sparse: number };
    const cands: Cand[] = [];
    for (const f of this.files.values()) {
      if (under && !(f.rel === under || f.rel.startsWith(`${under}/`))) continue;
      if (only && !only.has(path.normalize(f.rel))) continue;
      for (const s of f.sections) {
        const v = this.vectors.get(s.hash);
        let dense: number | null = null;
        if (v && qv) {
          let d = 0;
          for (let i = 0; i < v.length; i++) d += v[i] * qv[i];
          dense = d;
        }
        let sparse = 0;
        for (const w of qWords) {
          const tf = s.tf.get(w);
          if (!tf) continue;
          const df = this.df.get(w) || 1;
          const idf = Math.log(1 + (this.sectionCount - df + 0.5) / (df + 0.5));
          sparse += (idf * (tf * 2.2)) / (tf + 1.2 * (0.25 + (0.75 * s.len) / this.avgLen));
        }
        cands.push({ f, s, dense, sparse });
      }
    }
    if (cands.length === 0) return under ? `No indexed code under ${under}.` : 'The index is empty.';

    // Reciprocal-rank fusion of the two rankings; sections without a vector yet compete on keywords alone.
    const denseOrder = cands.map((c, i) => [c.dense, i] as const).filter(([d]) => d !== null).sort((a, b) => (b[0] as number) - (a[0] as number));
    const sparseOrder = cands.map((c, i) => [c.sparse, i] as const).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]);
    const score = new Float64Array(cands.length);
    denseOrder.forEach(([, i], r) => (score[i] += 1 / (60 + r)));
    sparseOrder.forEach(([, i], r) => (score[i] += 1 / (60 + r)));
    const order = [...score.keys()].filter((i) => score[i] > 0).sort((a, b) => score[b] - score[a]);

    const picked: Cand[] = [];
    const perFile = new Map<string, number>();
    for (const i of order) {
      const c = cands[i];
      const n = perFile.get(c.f.rel) || 0;
      if (n >= MAX_HITS_PER_FILE) continue;
      perFile.set(c.f.rel, n + 1);
      picked.push(c);
      if (picked.length >= k) break;
    }

    // Widen each hit with surrounding code (as much as the line budget allows); merge overlapping windows in the same
    // file (keeping rank order of files).
    const context = Math.max(MIN_CONTEXT_LINES, Math.min(MAX_CONTEXT_LINES, Math.floor((RESULT_LINE_BUDGET / picked.length - CHUNK_LINES) / 2)));
    const windows = new Map<string, Array<[number, number]>>();
    for (const c of picked) {
      const list = windows.get(c.f.rel) || [];
      list.push([Math.max(1, c.s.start - context), Math.min(c.f.lines.length, c.s.end + context)]);
      windows.set(c.f.rel, list);
    }
    const blocks: string[] = [];
    for (const [rel, list] of windows) {
      const f = this.files.get(rel)!;
      list.sort((a, b) => a[0] - b[0]);
      const merged: Array<[number, number]> = [];
      for (const w of list) {
        const last = merged[merged.length - 1];
        if (last && w[0] <= last[1] + 1) last[1] = Math.max(last[1], w[1]);
        else merged.push([...w]);
      }
      // Outline: top-level declarations (methods too when the file has few of those, e.g. one class).
      const top = f.symbols.filter((x) => !x.nested);
      const shown = (top.length >= 4 ? top : f.symbols).slice(0, OUTLINE_SYMBOLS);
      const total = top.length >= 4 ? top.length : f.symbols.length;
      const outline = shown.map((x) => `${x.name}:${x.line}`).join(', ');
      const head = [`══ ${rel} (${f.lines.length} lines)${outline ? ` — outline: ${outline}${total > shown.length ? ', …' : ''}` : ''}`];
      for (const [a, b] of merged) {
        const inside = [...f.symbols].reverse().find((s) => s.line <= a);
        head.push(`── lines ${a}-${b}${inside ? ` (in ${inside.name})` : ''}`);
        head.push(f.lines.slice(a - 1, b).map((l, j) => `${a + j}\t${l}`).join('\n'));
      }
      blocks.push(head.join('\n'));
    }
    const notEmbedded = picked.filter((c) => c.dense === null).length;
    const notes: string[] = [];
    if (notEmbedded > 0) notes.push(`${notEmbedded} of these sections were matched by keywords only (recently changed or still being indexed).`);
    if (this.pending.size > 0) notes.push(`${this.pending.size} recently changed file(s) are being re-indexed.`);
    return `${blocks.join('\n\n')}\n\n${notes.length ? `Note: ${notes.join(' ')}\n` : ''}These are entry points, not the whole picture: before editing, read the complete function or component you will change, the code that calls it and the state, types or styles it depends on (code_search again for those).`;
  }

  // ─── Persistence (vectors only: file text is re-read from disk on start) ─────

  private loadVectors(): void {
    try {
      const meta = JSON.parse(fsSync.readFileSync(this.storeFile, 'utf8'));
      const bytes = fsSync.readFileSync(`${this.storeFile}.f32`);
      const dim = Number(meta.dim) || 0;
      const hashes: string[] = Array.isArray(meta.hashes) ? meta.hashes : [];
      if (!dim || bytes.byteLength !== hashes.length * dim * 4) return;
      const all = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      hashes.forEach((h, i) => this.vectors.set(h, all.slice(i * dim, (i + 1) * dim)));
    } catch {
      // No saved index yet (or unreadable): it is rebuilt.
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer || this.disposed) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveSync();
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  /** Writes the vectors still in use (atomically: temp file + rename). */
  saveSync(): void {
    try {
      const used = new Set<string>();
      for (const f of this.files.values()) for (const s of f.sections) used.add(s.hash);
      for (const h of [...this.vectors.keys()]) if (!used.has(h)) this.vectors.delete(h);
      const hashes = [...this.vectors.keys()];
      if (hashes.length === 0) return;
      const dim = this.vectors.get(hashes[0])!.length;
      const all = new Float32Array(hashes.length * dim);
      hashes.forEach((h, i) => all.set(this.vectors.get(h)!, i * dim));
      fsSync.mkdirSync(path.dirname(this.storeFile), { recursive: true });
      const write = (file: string, data: string | Uint8Array) => {
        const tmp = `${file}.${process.pid}.tmp`;
        fsSync.writeFileSync(tmp, data);
        fsSync.renameSync(tmp, file);
      };
      write(`${this.storeFile}.f32`, new Uint8Array(all.buffer));
      write(this.storeFile, JSON.stringify({ root: this.root, dim, hashes }));
    } catch (err) {
      this.log(`Code index ${this.root}: saving failed`, err);
    }
  }
}

// ─── All indexed folders ──────────────────────────────────────────────────────

export class CodeIndexManager {
  private indexes = new Map<string, CodeIndex>();
  private readonly dir: string;
  private readonly embed: CodeEmbedFn;
  private readonly log: (msg: string, err?: unknown) => void;

  constructor(dir: string, embed: CodeEmbedFn, log: (msg: string, err?: unknown) => void) {
    this.dir = dir;
    this.embed = embed;
    this.log = log;
  }

  /** Indexes exactly these folders (absolute paths): new ones start in the background, removed ones are dropped. */
  sync(roots: string[]): void {
    const want = new Set(roots.map((r) => path.resolve(r)).filter((r) => fsSync.existsSync(r) && fsSync.statSync(r).isDirectory()));
    for (const [root, idx] of this.indexes) {
      if (!want.has(root)) {
        idx.dispose(true);
        this.indexes.delete(root);
        this.log(`Code index dropped: ${root}`);
      }
    }
    for (const root of want) {
      if (this.indexes.has(root)) continue;
      const idx = new CodeIndex({ root, storeFile: path.join(this.dir, `${sha(root)}.json`), embed: this.embed, log: this.log });
      this.indexes.set(root, idx);
      this.log(`Code index starting: ${root}`);
      void idx.start();
    }
  }

  /** The index whose folder contains `p` (the innermost one when folders nest). */
  forPath(p: string): CodeIndex | null {
    const abs = path.resolve(p);
    let best: CodeIndex | null = null;
    for (const idx of this.indexes.values()) {
      if (idx.covers(abs) && (!best || idx.root.length > best.root.length)) best = idx;
    }
    return best;
  }

  roots(): string[] {
    return [...this.indexes.keys()];
  }

  statuses(): CodeIndexStatus[] {
    return [...this.indexes.values()].map((i) => i.status());
  }

  saveAll(): void {
    for (const idx of this.indexes.values()) idx.saveSync();
  }

  disposeAll(): void {
    for (const idx of this.indexes.values()) idx.dispose();
    this.indexes.clear();
  }
}
