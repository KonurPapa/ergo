/**
 * Terminal screen model for CLI agent PTYs, shared by the bridge (vite.config.ts) and the browser.
 *
 * TUI agents (Claude Code, Codex, Gemini) draw with cursor addressing and differential repaints: words are
 * spaced with CHA/CUF codes and unchanged cells are never re-sent. Stripping escape codes from the byte stream
 * therefore yields joined words and stale fragments. TerminalScreen replays the bytes through a small VT
 * reducer and exposes the rendered rows, which is what prompt detection and activity feeds must read.
 *
 * Dependency-free: no DOM and no Node imports.
 */

/**
 * Strips terminal ANSI escape sequences, OSC codes, and carriage returns.
 * (Byte-stream cleanup only — use TerminalScreen when cursor movement matters.)
 */
export function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

// ─── Character widths (best-effort wcwidth) ──────────────────────────────────

/** Code points that occupy no column of their own (combining marks, joiners, variation selectors, modifiers). */
const ZERO_WIDTH_RANGES: Array<[number, number]> = [
  [0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x05bf, 0x05bf], [0x05c1, 0x05c2], [0x05c4, 0x05c5],
  [0x05c7, 0x05c7], [0x0610, 0x061a], [0x064b, 0x065f], [0x0670, 0x0670], [0x06d6, 0x06dc], [0x06df, 0x06e4],
  [0x0e31, 0x0e31], [0x0e34, 0x0e3a], [0x0e47, 0x0e4e], [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], [0x200b, 0x200f],
  [0x202a, 0x202e], [0x2060, 0x2064], [0x20d0, 0x20ff], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f], [0xfeff, 0xfeff],
  [0x1f3fb, 0x1f3ff], [0xe0000, 0xe007f], [0xe0100, 0xe01ef],
];

/** East Asian Wide/Fullwidth and emoji-presentation code points (two columns). */
const WIDE_RANGES: Array<[number, number]> = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0x303e],
  [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x16fe0, 0x16fe4],
  [0x17000, 0x18cff], [0x1b000, 0x1b2ff], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a], [0x1f200, 0x1f202], [0x1f210, 0x1f23b], [0x1f240, 0x1f248], [0x1f250, 0x1f251],
  [0x1f260, 0x1f265], [0x1f300, 0x1f320], [0x1f32d, 0x1f335], [0x1f337, 0x1f37c], [0x1f37e, 0x1f393],
  [0x1f3a0, 0x1f3ca], [0x1f3cf, 0x1f3d3], [0x1f3e0, 0x1f3f0], [0x1f3f4, 0x1f3f4], [0x1f3f8, 0x1f43e],
  [0x1f440, 0x1f440], [0x1f442, 0x1f4fc], [0x1f4ff, 0x1f53d], [0x1f54b, 0x1f54e], [0x1f550, 0x1f567],
  [0x1f57a, 0x1f57a], [0x1f595, 0x1f596], [0x1f5a4, 0x1f5a4], [0x1f5fb, 0x1f64f], [0x1f680, 0x1f6c5],
  [0x1f6cc, 0x1f6cc], [0x1f6d0, 0x1f6d2], [0x1f6d5, 0x1f6d7], [0x1f6dc, 0x1f6df], [0x1f6eb, 0x1f6ec],
  [0x1f6f4, 0x1f6fc], [0x1f7e0, 0x1f7eb], [0x1f7f0, 0x1f7f0], [0x1f90c, 0x1f93a], [0x1f93c, 0x1f945],
  [0x1f947, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];

function inRanges(cp: number, ranges: Array<[number, number]>): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < ranges[mid][0]) hi = mid - 1;
    else if (cp > ranges[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
}

function charWidth(cp: number): 0 | 1 | 2 {
  if (cp < 0x300) return 1;
  if (inRanges(cp, ZERO_WIDTH_RANGES)) return 0;
  return inRanges(cp, WIDE_RANGES) ? 2 : 1;
}

/** DEC special graphics charset (ESC ( 0), used by curses-style TUIs for box drawing. */
const DEC_GRAPHICS: Record<string, string> = {
  '`': '◆', a: '▒', f: '°', g: '±', j: '┘', k: '┐', l: '┌', m: '└', n: '┼', o: '⎺', p: '⎻', q: '─',
  r: '⎼', s: '⎽', t: '├', u: '┤', v: '┴', w: '┬', x: '│', y: '≤', z: '≥', '{': 'π', '|': '≠', '}': '£', '~': '·',
};

// ─── VT reducer ──────────────────────────────────────────────────────────────

/** One screen row; each entry is one column. '' marks the right half of a wide character. */
type Cells = string[];

interface ScreenBuffer {
  grid: Cells[];
  /** Cursor saved with DECSC / CSI s for this buffer. */
  saved: { r: number; c: number; graphics: boolean } | null;
}

const ST_GROUND = 0;
const ST_ESC = 1;
const ST_CSI = 2;
const ST_STRING = 3; // OSC / DCS / SOS / PM / APC payload (ignored)
const ST_STRING_ESC = 4; // ESC seen inside a string (expecting "\" = ST)
const ST_CHARSET = 5; // ESC ( X: designation char follows
const ST_SKIP_ONE = 6; // ESC # X, ESC % X, ESC SP X: one char follows

const MAX_CSI_LEN = 64;

/**
 * A best-effort VT100/xterm screen: enough of the control set to render what CLI agents draw (cursor addressing,
 * erase, insert/delete, scroll regions, alternate screen, deferred autowrap, wide characters). Colors and other
 * attributes are ignored. Chunks may split escape sequences anywhere.
 */
export class TerminalScreen {
  private w: number;
  private h: number;
  private readonly scrollbackMax: number;
  private main: ScreenBuffer;
  private alt: ScreenBuffer;
  private active: ScreenBuffer;
  private scrollback: string[] = [];
  private scrolled = 0;
  private r = 0;
  private c = 0;
  private wrapPending = false;
  private autowrap = true;
  private originMode = false;
  private top = 0;
  private bottom: number;
  private graphics = false;
  private lastPrinted = ' ';
  private state = ST_GROUND;
  private csi = '';
  private pendingHigh = '';

  constructor(cols = 120, rows = 40, scrollback = 2000) {
    this.w = Math.max(2, Math.floor(cols) || 120);
    this.h = Math.max(1, Math.floor(rows) || 40);
    this.scrollbackMax = Math.max(0, Math.floor(scrollback));
    this.main = { grid: this.blankGrid(), saved: null };
    this.alt = { grid: this.blankGrid(), saved: null };
    this.active = this.main;
    this.bottom = this.h - 1;
  }

  get cols(): number {
    return this.w;
  }

  get rows(): number {
    return this.h;
  }

  /** Total number of rows ever pushed into scrollback (monotonic; lets callers detect scrolled-off output). */
  get scrollCount(): number {
    return this.scrolled;
  }

  isAltScreen(): boolean {
    return this.active === this.alt;
  }

  /** Full reset (RIS): both screens cleared, scrollback dropped, modes restored. */
  reset(): void {
    this.main = { grid: this.blankGrid(), saved: null };
    this.alt = { grid: this.blankGrid(), saved: null };
    this.active = this.main;
    this.scrollback = [];
    this.r = 0;
    this.c = 0;
    this.wrapPending = false;
    this.autowrap = true;
    this.originMode = false;
    this.top = 0;
    this.bottom = this.h - 1;
    this.graphics = false;
    this.state = ST_GROUND;
    this.csi = '';
    this.pendingHigh = '';
  }

  /** Right-trimmed rows of the active screen. */
  visibleRows(): string[] {
    return this.active.grid.map(renderCells);
  }

  /** Last `n` rows of scrollback + screen (main screen), or of the screen alone (alternate screen). */
  tailRows(n: number): string[] {
    const visible = this.visibleRows();
    const count = Math.max(0, Math.floor(n));
    if (count === 0) return [];
    if (this.isAltScreen() || count <= visible.length) return visible.slice(-count);
    const fromScrollback = Math.min(this.scrollback.length, count - visible.length);
    return [...this.scrollback.slice(this.scrollback.length - fromScrollback), ...visible];
  }

  resize(cols: number, rows: number): void {
    const newCols = Math.max(2, Math.floor(cols) || this.w);
    const newRows = Math.max(1, Math.floor(rows) || this.h);
    if (newCols === this.w && newRows === this.h) return;
    for (const buf of [this.main, this.alt]) {
      const isActive = buf === this.active;
      let curR = isActive ? this.r : Math.min(buf.saved?.r ?? 0, this.h - 1);
      const grid = buf.grid;
      for (let i = 0; i < grid.length; i++) grid[i] = fitCells(grid[i], newCols);
      if (newRows < grid.length) {
        let excess = grid.length - newRows;
        // Drop empty rows below the cursor first, then scroll the top off (into scrollback on the main screen).
        while (excess > 0 && grid.length - 1 > curR && renderCells(grid[grid.length - 1]) === '') {
          grid.pop();
          excess--;
        }
        while (excess > 0) {
          const removed = grid.shift();
          if (removed && buf === this.main) this.pushScrollback(renderCells(removed));
          curR = Math.max(0, curR - 1);
          excess--;
        }
      }
      while (grid.length < newRows) grid.push(blankCells(newCols));
      if (isActive) this.r = Math.min(curR, newRows - 1);
      if (buf.saved) {
        buf.saved.r = Math.min(buf.saved.r, newRows - 1);
        buf.saved.c = Math.min(buf.saved.c, newCols - 1);
      }
    }
    this.w = newCols;
    this.h = newRows;
    this.c = Math.min(this.c, newCols - 1);
    this.top = 0;
    this.bottom = newRows - 1;
    this.wrapPending = false;
  }

  write(data: string): void {
    if (!data) return;
    let text = data;
    if (this.pendingHigh) {
      text = this.pendingHigh + text;
      this.pendingHigh = '';
    }
    const len = text.length;
    for (let i = 0; i < len; i++) {
      let code = text.charCodeAt(i);
      let ch = text[i];
      if (code >= 0xd800 && code <= 0xdbff) {
        if (i + 1 >= len) {
          // Surrogate pair split across chunks: finish it with the next write.
          this.pendingHigh = ch;
          break;
        }
        const low = text.charCodeAt(i + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          code = ((code - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
          ch = text.slice(i, i + 2);
          i++;
        }
      }
      this.feed(ch, code);
    }
  }

  // ── State machine ──

  private feed(ch: string, code: number): void {
    switch (this.state) {
      case ST_GROUND:
        if (code === 0x1b) this.state = ST_ESC;
        else if (code < 0x20 || code === 0x7f) this.control(code);
        else if (code >= 0x80 && code < 0xa0) {
          if (code === 0x9b) this.beginCsi();
          else if (code === 0x9d || code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) this.state = ST_STRING;
        } else this.print(ch, code);
        return;
      case ST_ESC:
        this.escape(ch);
        return;
      case ST_CSI:
        if (code === 0x1b) {
          this.state = ST_ESC;
        } else if (code === 0x18 || code === 0x1a) {
          this.state = ST_GROUND;
        } else if (code < 0x20) {
          this.control(code); // C0 controls execute inside CSI
        } else if (code >= 0x40 && code <= 0x7e) {
          this.state = ST_GROUND;
          this.dispatchCsi(this.csi, ch);
        } else if (this.csi.length < MAX_CSI_LEN) {
          this.csi += ch;
        }
        return;
      case ST_STRING:
        if (code === 0x07 || code === 0x9c) this.state = ST_GROUND;
        else if (code === 0x1b) this.state = ST_STRING_ESC;
        else if (code === 0x18 || code === 0x1a) this.state = ST_GROUND;
        return;
      case ST_STRING_ESC:
        if (ch === '\\') this.state = ST_GROUND;
        else {
          // The string ended without ST; this ESC starts a new sequence.
          this.state = ST_ESC;
          this.escape(ch);
        }
        return;
      case ST_CHARSET:
        this.graphics = ch === '0' ? true : ch === 'B' || ch === 'A' || ch === 'U' ? false : this.graphics;
        this.state = ST_GROUND;
        return;
      case ST_SKIP_ONE:
        this.state = ST_GROUND;
        return;
      default:
        this.state = ST_GROUND;
    }
  }

  private beginCsi(): void {
    this.state = ST_CSI;
    this.csi = '';
  }

  private escape(ch: string): void {
    this.state = ST_GROUND;
    switch (ch) {
      case '[':
        this.beginCsi();
        return;
      case ']':
      case 'P':
      case 'X':
      case '^':
      case '_':
        this.state = ST_STRING;
        return;
      case '(':
        this.state = ST_CHARSET;
        return;
      case ')':
      case '*':
      case '+':
      case '-':
      case '.':
      case '/':
      case '#':
      case '%':
      case ' ':
        this.state = ST_SKIP_ONE;
        return;
      case '7':
        this.saveCursor();
        return;
      case '8':
        this.restoreCursor();
        return;
      case 'D':
        this.index();
        return;
      case 'E':
        this.c = 0;
        this.index();
        return;
      case 'M':
        this.reverseIndex();
        return;
      case 'c':
        this.reset();
        return;
      case '\x1b':
        this.state = ST_ESC;
        return;
      default:
        // ESC = / ESC > (keypad), ESC H (tab set), ESC N/O (single shifts), ESC \ (stray ST): nothing to render.
        return;
    }
  }

  private control(code: number): void {
    switch (code) {
      case 0x08: // BS
        if (this.wrapPending) this.wrapPending = false;
        else this.c = Math.max(0, this.c - 1);
        return;
      case 0x09: // HT
        this.tab(1);
        return;
      case 0x0a: // LF
      case 0x0b: // VT
      case 0x0c: // FF
        this.index();
        return;
      case 0x0d: // CR
        this.c = 0;
        this.wrapPending = false;
        return;
      case 0x0e: // SO / SI: G1 charsets are not tracked
      case 0x0f:
      default:
        return;
    }
  }

  private print(ch: string, code: number): void {
    const glyph = this.graphics && code < 0x80 ? DEC_GRAPHICS[ch] ?? ch : ch;
    const width = charWidth(code);
    const grid = this.active.grid;
    if (width === 0) {
      // Combining mark / joiner / variation selector: attach to the previous cell.
      let target = this.wrapPending ? this.c : this.c - 1;
      if (target >= 0 && grid[this.r][target] === '' && target > 0) target--;
      if (target >= 0) grid[this.r][target] += glyph;
      return;
    }
    if (this.wrapPending) {
      if (this.autowrap) {
        this.c = 0;
        this.index();
      }
      this.wrapPending = false;
    }
    if (width === 2 && this.c >= this.w - 1) {
      if (this.autowrap) {
        grid[this.r][this.c] = ' ';
        this.c = 0;
        this.index();
      } else {
        this.c = this.w - 2;
      }
    }
    const row = this.active.grid[this.r];
    // Overwriting the lead half of a wide char orphans its right half. (Writing into a right half keeps the lead:
    // that only happens when our width table disagrees with the app's, and the app's layout should win.)
    if (row[this.c + 1] === '' && width === 1) row[this.c + 1] = ' ';
    row[this.c] = glyph;
    if (width === 2) {
      if (row[this.c + 2] === '') row[this.c + 2] = ' ';
      row[this.c + 1] = '';
    }
    this.lastPrinted = glyph;
    const next = this.c + width;
    if (next >= this.w) {
      this.c = this.w - 1;
      this.wrapPending = true;
    } else {
      this.c = next;
    }
  }

  private tab(n: number): void {
    this.wrapPending = false;
    for (let k = 0; k < n; k++) this.c = Math.min(this.w - 1, (Math.floor(this.c / 8) + 1) * 8);
  }

  private backTab(n: number): void {
    this.wrapPending = false;
    for (let k = 0; k < n; k++) this.c = Math.max(0, (Math.ceil(this.c / 8) - 1) * 8);
  }

  private index(): void {
    this.wrapPending = false;
    if (this.r === this.bottom) this.scrollUp(1);
    else if (this.r < this.h - 1) this.r++;
  }

  private reverseIndex(): void {
    this.wrapPending = false;
    if (this.r === this.top) this.scrollDown(1);
    else if (this.r > 0) this.r--;
  }

  private pushScrollback(line: string): void {
    if (this.scrollbackMax === 0) return;
    this.scrollback.push(line);
    this.scrolled++;
    if (this.scrollback.length > this.scrollbackMax + 256) {
      this.scrollback.splice(0, this.scrollback.length - this.scrollbackMax);
    }
  }

  private scrollUp(n: number): void {
    const grid = this.active.grid;
    const count = Math.min(n, this.bottom - this.top + 1);
    for (let k = 0; k < count; k++) {
      const [removed] = grid.splice(this.top, 1);
      if (this.top === 0 && this.active === this.main) this.pushScrollback(renderCells(removed));
      grid.splice(this.bottom, 0, blankCells(this.w));
    }
  }

  private scrollDown(n: number): void {
    const grid = this.active.grid;
    const count = Math.min(n, this.bottom - this.top + 1);
    for (let k = 0; k < count; k++) {
      grid.splice(this.bottom, 1);
      grid.splice(this.top, 0, blankCells(this.w));
    }
  }

  private saveCursor(): void {
    this.active.saved = { r: this.r, c: this.c, graphics: this.graphics };
  }

  private restoreCursor(): void {
    const saved = this.active.saved;
    this.wrapPending = false;
    if (!saved) {
      this.r = 0;
      this.c = 0;
      return;
    }
    this.r = Math.min(saved.r, this.h - 1);
    this.c = Math.min(saved.c, this.w - 1);
    this.graphics = saved.graphics;
  }

  private moveTo(row: number, col: number): void {
    this.wrapPending = false;
    const base = this.originMode ? this.top : 0;
    const maxRow = this.originMode ? this.bottom : this.h - 1;
    this.r = clamp(base + row, 0, maxRow);
    this.c = clamp(col, 0, this.w - 1);
  }

  private switchScreen(toAlt: boolean, opts: { save?: boolean; clear?: boolean }): void {
    const target = toAlt ? this.alt : this.main;
    if (toAlt && opts.save) this.saveCursorOn(this.main);
    if (toAlt && opts.clear) this.alt.grid = this.blankGrid();
    if (this.active !== target) {
      if (!toAlt && opts.clear) this.alt.grid = this.blankGrid();
      this.active = target;
    }
    this.top = 0;
    this.bottom = this.h - 1;
    this.wrapPending = false;
    if (!toAlt && opts.save) {
      const saved = this.main.saved;
      if (saved) {
        this.r = Math.min(saved.r, this.h - 1);
        this.c = Math.min(saved.c, this.w - 1);
      }
    }
  }

  private saveCursorOn(buf: ScreenBuffer): void {
    buf.saved = { r: this.r, c: this.c, graphics: this.graphics };
  }

  private setMode(params: string, on: boolean): void {
    if (!params.startsWith('?')) return; // ANSI modes (IRM, LNM) are not used by the agents we render
    for (const p of params.slice(1).split(';')) {
      const mode = parseInt(p, 10);
      switch (mode) {
        case 6:
          this.originMode = on;
          this.moveTo(0, 0);
          break;
        case 7:
          this.autowrap = on;
          if (!on) this.wrapPending = false;
          break;
        case 47:
          this.switchScreen(on, {});
          break;
        case 1047:
          this.switchScreen(on, { clear: !on });
          break;
        case 1048:
          if (on) this.saveCursor();
          else this.restoreCursor();
          break;
        case 1049:
          this.switchScreen(on, { save: true, clear: true });
          break;
        default:
          break;
      }
    }
  }

  private eraseCells(row: number, from: number, to: number): void {
    const cells = this.active.grid[row];
    if (!cells) return;
    const start = clamp(from, 0, this.w);
    const end = clamp(to, 0, this.w);
    if (start >= end) return;
    // Erasing either half of a wide character erases all of it.
    if (start > 0 && cells[start] === '') cells[start - 1] = ' ';
    if (end < this.w && cells[end] === '') cells[end] = ' ';
    for (let k = start; k < end; k++) cells[k] = ' ';
  }

  private dispatchCsi(raw: string, final: string): void {
    let prefix = '';
    let body = raw;
    if (body && '?>=<'.includes(body[0])) {
      prefix = body[0];
      body = body.slice(1);
    }
    const interMatch = body.match(/[ -/]+$/);
    const intermediates = interMatch ? interMatch[0] : '';
    if (intermediates) body = body.slice(0, body.length - intermediates.length);
    if (intermediates) {
      if (intermediates === '!' && final === 'p') this.softReset();
      return; // DECSCUSR and friends: nothing to render
    }
    if (prefix === '?' && (final === 'h' || final === 'l')) {
      this.setMode(`?${body}`, final === 'h');
      return;
    }
    if (prefix) return; // DA2, XTMODKEYS, kitty keyboard, ...
    const params = body === '' ? [] : body.split(';').map((p) => {
      const n = parseInt(p.split(':')[0], 10);
      return Number.isFinite(n) ? n : 0;
    });
    const p0 = params[0] ?? 0;
    const n1 = p0 > 0 ? p0 : 1; // count parameter: 0/missing = 1
    const grid = this.active.grid;
    switch (final) {
      case '@': {
        // ICH
        this.wrapPending = false;
        const row = grid[this.r];
        const count = Math.min(n1, this.w - this.c);
        if (row[this.c] === '' && this.c > 0) row[this.c - 1] = ' ';
        row.splice(this.c, 0, ...blankCells(count));
        if (row[this.w] === '') row[this.w - 1] = ' ';
        row.length = this.w;
        return;
      }
      case 'A':
        this.wrapPending = false;
        this.r = this.r >= this.top ? Math.max(this.top, this.r - n1) : Math.max(0, this.r - n1);
        return;
      case 'B':
      case 'e':
        this.wrapPending = false;
        this.r = this.r <= this.bottom ? Math.min(this.bottom, this.r + n1) : Math.min(this.h - 1, this.r + n1);
        return;
      case 'C':
      case 'a':
        this.wrapPending = false;
        this.c = Math.min(this.w - 1, this.c + n1);
        return;
      case 'D':
        this.wrapPending = false;
        this.c = Math.max(0, this.c - n1);
        return;
      case 'E':
        this.wrapPending = false;
        this.r = this.r <= this.bottom ? Math.min(this.bottom, this.r + n1) : Math.min(this.h - 1, this.r + n1);
        this.c = 0;
        return;
      case 'F':
        this.wrapPending = false;
        this.r = this.r >= this.top ? Math.max(this.top, this.r - n1) : Math.max(0, this.r - n1);
        this.c = 0;
        return;
      case 'G':
      case '`':
        this.wrapPending = false;
        this.c = clamp(n1 - 1, 0, this.w - 1);
        return;
      case 'H':
      case 'f': {
        const row = (params[0] ?? 0) > 0 ? params[0] - 1 : 0;
        const col = (params[1] ?? 0) > 0 ? params[1] - 1 : 0;
        this.moveTo(row, col);
        return;
      }
      case 'I':
        this.tab(n1);
        return;
      case 'Z':
        this.backTab(n1);
        return;
      case 'J':
        this.wrapPending = false;
        if (p0 === 0) {
          this.eraseCells(this.r, this.c, this.w);
          for (let k = this.r + 1; k < this.h; k++) grid[k] = blankCells(this.w);
        } else if (p0 === 1) {
          for (let k = 0; k < this.r; k++) grid[k] = blankCells(this.w);
          this.eraseCells(this.r, 0, this.c + 1);
        } else if (p0 === 2) {
          for (let k = 0; k < this.h; k++) grid[k] = blankCells(this.w);
        } else if (p0 === 3) {
          this.scrollback = [];
        }
        return;
      case 'K':
        this.wrapPending = false;
        if (p0 === 0) this.eraseCells(this.r, this.c, this.w);
        else if (p0 === 1) this.eraseCells(this.r, 0, this.c + 1);
        else if (p0 === 2) grid[this.r] = blankCells(this.w);
        return;
      case 'L':
        // IL: only inside the scroll region
        if (this.r < this.top || this.r > this.bottom) return;
        this.wrapPending = false;
        for (let k = 0; k < Math.min(n1, this.bottom - this.r + 1); k++) {
          grid.splice(this.bottom, 1);
          grid.splice(this.r, 0, blankCells(this.w));
        }
        this.c = 0;
        return;
      case 'M':
        // DL
        if (this.r < this.top || this.r > this.bottom) return;
        this.wrapPending = false;
        for (let k = 0; k < Math.min(n1, this.bottom - this.r + 1); k++) {
          grid.splice(this.r, 1);
          grid.splice(this.bottom, 0, blankCells(this.w));
        }
        this.c = 0;
        return;
      case 'P': {
        // DCH
        this.wrapPending = false;
        const row = grid[this.r];
        if (row[this.c] === '' && this.c > 0) row[this.c - 1] = ' ';
        row.splice(this.c, Math.min(n1, this.w - this.c));
        while (row.length < this.w) row.push(' ');
        if (row[this.c] === '') row[this.c] = ' ';
        return;
      }
      case 'S':
        this.scrollUp(n1);
        return;
      case 'T':
        if (params.length > 1) return; // xterm mouse highlight tracking, not SD
        this.scrollDown(n1);
        return;
      case 'X':
        this.wrapPending = false;
        this.eraseCells(this.r, this.c, this.c + n1);
        return;
      case 'b': {
        // REP: repeat the last printed character
        const ch = this.lastPrinted;
        const cp = ch.codePointAt(0) ?? 0x20;
        for (let k = 0; k < Math.min(n1, this.w * this.h); k++) this.print(ch, cp);
        return;
      }
      case 'd':
        this.wrapPending = false;
        this.r = clamp(n1 - 1, 0, this.h - 1);
        return;
      case 'r': {
        const t = (params[0] ?? 0) > 0 ? params[0] - 1 : 0;
        const b = (params[1] ?? 0) > 0 ? params[1] - 1 : this.h - 1;
        if (t < b && b < this.h) {
          this.top = t;
          this.bottom = b;
          this.moveTo(0, 0);
        }
        return;
      }
      case 's':
        if (params.length === 0) this.saveCursor();
        return;
      case 'u':
        if (params.length === 0) this.restoreCursor();
        return;
      default:
        // SGR (m), DSR (n), DA (c), window ops (t), ...: no effect on the rendered text
        return;
    }
  }

  private softReset(): void {
    this.autowrap = true;
    this.originMode = false;
    this.top = 0;
    this.bottom = this.h - 1;
    this.graphics = false;
    this.wrapPending = false;
  }

  private blankGrid(): Cells[] {
    return Array.from({ length: this.h }, () => blankCells(this.w));
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function blankCells(n: number): Cells {
  return new Array<string>(Math.max(0, n)).fill(' ');
}

function fitCells(cells: Cells, cols: number): Cells {
  if (cells.length === cols) return cells;
  if (cells.length > cols) {
    const out = cells.slice(0, cols);
    if (out[cols - 1] !== '' && cells[cols] === '') out[cols - 1] = ' ';
    return out;
  }
  return cells.concat(blankCells(cols - cells.length));
}

function renderCells(cells: Cells): string {
  return cells.join('').replace(/\s+$/, '');
}

// ─── Transcript of rendered rows ─────────────────────────────────────────────

/** Rows made only of rules / box edges carry no content. */
const RULE_ONLY_RE = /^[\s─━═╌╍┄┅┈┉│┃║╭╮╰╯╔╗╚╝┌┐└┘├┤┬┴┼▔▁-]*$/;
/** Spinner / status rows a TUI rewrites in place ("✻ Wandering…", "⠋ Thinking... (3s)"). */
const VOLATILE_RE = /^\s*[✶✻✢✳✽✺·*◐◓◑◒⠁-⣿]\s+\S[^\n]{0,80}?(?:…|\.\.\.)/;
/** TUI status footers that change in place (permission mode, key hints). */
const STATUS_FOOTER_RE = /(?:mode on|permissions on|accept edits on|shift\+tab to cycle|\? for shortcuts|esc to interrupt|ctrl\+[a-z] to toggle|context left)/i;
/** How far back an observed row is matched against history. */
const MATCH_WINDOW = 400;

/** Claude blinks the bullet of a pending tool call ("● Running…" ⇄ "  Running…"): treat both as one row. */
function blinkKey(row: string): string {
  return row.replace(/^(\s*)[●⏺](?=\s)/, '$1 ');
}

function volatileKey(row: string): string {
  return row
    .trim()
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/\d+/g, '#');
}

/**
 * Ordered, de-duplicated history of what a TUI rendered. Each observe() aligns the current rows with the recent
 * history: rows already recorded are skipped (repaints collapse), rows that grew (streaming text) or spinner
 * rows are updated in place, and new rows are inserted where they appear relative to known rows.
 */
export class ScreenTranscript {
  private readonly maxLines: number;
  private buf: string[] = [];

  constructor(maxLines = 4000) {
    this.maxLines = Math.max(50, Math.floor(maxLines) || 4000);
  }

  observe(rows: string[]): void {
    const incoming = rows
      .map((r) => r.replace(/\s+$/, ''))
      .filter((r) => r.trim() !== '' && !RULE_ONLY_RE.test(r));
    let p = -1;
    for (let k = 0; k < incoming.length; k++) {
      const row = incoming[k];
      const exact = this.findExact(row, p, incoming[k + 1]);
      if (exact !== -1) {
        if (this.buf[exact] !== row && row.length >= this.buf[exact].trimEnd().length && /^\s*[●⏺]/.test(row)) this.buf[exact] = row;
        p = exact;
        continue;
      }
      const upd = this.findUpdate(row, p);
      if (upd !== -1) {
        this.buf[upd] = row;
        p = upd;
        continue;
      }
      // A new row goes right before the next history row that is still on screen below it (e.g. the TUI's
      // footer chrome). When nothing below it is known, the rows after p were replaced: append at the end.
      const at = this.findAnchor(p, incoming, k + 1);
      this.buf.splice(at, 0, row);
      p = at;
    }
    if (this.buf.length > this.maxLines) this.buf.splice(0, this.buf.length - this.maxLines);
  }

  lines(): string[] {
    return this.buf.slice();
  }

  tail(n: number): string[] {
    const count = Math.max(0, Math.floor(n));
    return count === 0 ? [] : this.buf.slice(-count);
  }

  private findExact(row: string, p: number, nextRow: string | undefined): number {
    const key = blinkKey(row);
    const start = Math.max(p + 1, this.buf.length - MATCH_WINDOW, 0);
    if (p >= 0) {
      for (let j = start; j < this.buf.length; j++) if (blinkKey(this.buf[j]) === key) return j;
      return -1;
    }
    // First anchor: prefer the latest occurrence that is followed by the same next row.
    let last = -1;
    for (let j = this.buf.length - 1; j >= start; j--) {
      if (blinkKey(this.buf[j]) !== key) continue;
      if (last === -1) last = j;
      if (nextRow === undefined || j + 1 >= this.buf.length || blinkKey(this.buf[j + 1]) === blinkKey(nextRow)) return j;
    }
    return last;
  }

  private findAnchor(p: number, incoming: string[], from: number): number {
    if (from >= incoming.length) return this.buf.length;
    const below = new Set(incoming.slice(from).map(blinkKey));
    const start = Math.max(p + 1, this.buf.length - MATCH_WINDOW, 0);
    for (let j = start; j < this.buf.length; j++) if (below.has(blinkKey(this.buf[j]))) return j;
    return this.buf.length;
  }

  private findUpdate(row: string, p: number): number {
    const j = p === -1 ? this.buf.length - 1 : p + 1;
    if (j < 0 || j >= this.buf.length) return -1;
    const prev = this.buf[j];
    const prevTrim = prev.trim();
    if (prevTrim.length >= 4 && row.startsWith(prev)) return j; // streaming line grew
    if (VOLATILE_RE.test(prev) && VOLATILE_RE.test(row)) return j; // spinner frame / verb change
    if (STATUS_FOOTER_RE.test(prev) && STATUS_FOOTER_RE.test(row)) return j; // mode / key-hint footer
    if (volatileKey(prev) !== '' && volatileKey(prev) === volatileKey(row) && /\d/.test(prev + row)) return j; // timers
    return -1;
  }
}
