/**
 * Detects interactive prompts (approval menus, yes/no confirmations, account notices) on the RENDERED screen
 * of a CLI agent (see TerminalScreen in ./cliScreen.ts), and turns an answer into the keystrokes the CLI expects.
 * Shared by the bridge (vite.config.ts), which detects and auto-approves, and the browser views, which answer.
 *
 * Layouts handled (bottom of the screen):
 *  - Claude Code 2.1: solid rule, tool header ("Bash command"), tip/description, the command between ╌ dashed
 *    rules, "Do you want to proceed?", a numbered menu with a ❯ cursor, "Esc to cancel · Tab to amend".
 *  - Older Claude Code: boxed panel with the header, an indented command and description, then the menu.
 *  - Codex: "Would you like to run the following command?" / "Allow command?", "$ cmd", a › numbered menu.
 *  - Gemini: boxed "? Shell <cmd> …", "Allow execution of: 'cmd'?", a ● radio menu.
 *  - Line-mode confirmations: "… [y/N]", "(Y)es/(N)o".
 * Plain lists (plans, checklists, numbered summaries) are not menus: a menu needs a question above it and a
 * cursor marker, a key-hint footer or approval-style labels, and nothing but footers below it unless it has a
 * cursor and an explicit approval question.
 *
 * Dependency-free: no DOM and no Node imports.
 */
import type { CliDetectedPrompt, CliPromptOption } from '../types/index.ts';

// ─── Patterns ────────────────────────────────────────────────────────────────

/** Frame characters stripped from both edges of a row. */
const FRAME_EDGE_LEFT_RE = /^[\s│┃║▌▎|╭╮╰╯╔╗╚╝]+/;
const FRAME_EDGE_RIGHT_RE = /[\s│┃║▌▎|╭╮╰╯╔╗╚╝]+$/;
/** Full-width solid rule (Claude 2.1 panel top) or a box top/bottom after unframing. */
const SOLID_RULE_RE = /^[─━═]{12,}$/;
/** Dashed rule (Claude 2.1 command / diff box). */
const DASHED_RULE_RE = /^[╌╍┄┅┈┉]{6,}$/;
const BOX_TOP_RE = /^\s*[╭┌╔]/;

/** Key-hint footers interactive menus print under their options. (Busy hints like "esc to interrupt" are not.) */
const MENU_FOOTER_RE =
  /esc to (?:cancel|exit|go back|close|reject)|enter to (?:confirm|select|submit|continue|approve)|press enter|\(use enter|use (?:the )?arrow|↑\/↓|↑↓|↑ ?↓ to|tab to amend|tab amend|ctrl\+[a-z] to (?:cancel|confirm|reject)|^\(?esc\)?$/i;
/** Questions CLIs ask before running a tool. */
const APPROVAL_QUESTION_RE =
  /do you want to|would you like to (?:proceed|run|allow|make|create|apply|continue|execute|edit|write|delete|overwrite)|allow (?:this|execution|command|edit|write|the|claude|agy|gemini|codex|access|fetch)|permission (?:needed|required|to|for)|needs? your (?:permission|approval)|\bapprove\b|run this command|proceed\?|apply (?:this|these) (?:edit|change)s?|make this edit|make the following edits|run the following command|create (?:this )?file|ok to (?:run|proceed|execute)/i;
/** Labels typical of approval menus (as opposed to a plan or checklist). */
const APPROVAL_OPTION_RE =
  /^(?:yes|no|allow|deny|approve|reject|always|never|don.?t ask|cancel|abort|skip|proceed|continue|run|accept|decline|ok)\b/i;
/** Options that grant the request. */
const APPROVE_LABEL_RE = /^(?:yes|y|allow|approve|proceed|accept|run|ok|okay|continue|confirm|execute)\b/i;
/** Options that refuse / back out (checked on the label's first clause only). */
const DESTRUCTIVE_LABEL_RE = /\b(?:no|cancel|reject|abort|deny|never|exit|quit|decline|stop)\b/i;
/** Approve options that also change the session's mode or hand control elsewhere — never auto-picked. */
const MODE_CHANGE_LABEL_RE =
  /switch to|auto mode|bypass|plan mode|yolo|accept edits mode|external editor|modify with|suggest changes|tell (?:claude|codex|gemini|the agent)|amend|i accept/i;
/** Approve options that grant more than this one request. */
const PERSISTENT_LABEL_RE = /don.?t ask|always|session|\ball\b|every|future|again|permanent|remember|for this (?:project|folder|directory|command)/i;

// Structural evidence that a menu is a CLI's own tool-permission dialog (vs. a question the agent asks the user).
// A generic "Do you want to …?" with Yes/No is NOT enough: agents ask those through AskUserQuestion too.
/** Questions only a CLI's permission dialog asks (Codex / Gemini; Claude's always come with a tool header). */
const PERMISSION_QUESTION_RE =
  /allow execution of|would you like to (?:run|make) the following|^allow command\??$|^apply this change\??$|permission (?:needed|required)|needs? your (?:permission|approval)/i;
/** Option labels only permission dialogs offer. */
const PERMISSION_OPTION_RE =
  /don.?t ask again|allow (?:once|always)|always allow|allow all edits|(?:during|for) this session|tell (?:claude|codex|gemini|the agent) what to do differently|suggest changes/i;
/** Rows inside a permission panel ("This command requires approval", Claude's bypass-mode warning). */
const PERMISSION_ROW_RE = /requires? approval\.?$|bypass permissions mode/i;
/** Claude Code AskUserQuestion: the free-text / chat-instead options it adds to every agent question. */
const AGENT_QUESTION_OPTION_RE = /^(?:type something|chat about this|other)\b/i;
const AGENT_QUESTION_ROW_RE = /^(?:[❯›>]\s*)?(?:\d{1,2}[.)]\s*)?(?:type something|chat about this)\b/i;
/** AskUserQuestion tab header: "← ☐ Header  ✔ Submit →" (ASCII fallback "[ ]" / "[×]"). */
const QUESTION_TAB_RE = /^(?:←\s*)?[☐☒]\s*\S|[☐☒].*[✔✓]\s*Submit\b|^←.*(?:[☐☒✔✓]|\[[ ×]\])/;

/** Cursor glyphs marking the highlighted option. */
const CURSOR_CHARS = '❯›>●◉▸▶→➤';
const NUMBERED_OPTION_RE = /^(?:([❯›>●◉▸▶→➤○◯])\s*)?(?:\[(\d{1,2})\]|(\d{1,2})[.)])\s+(\S.*)$/;
const CURSOR_PLAIN_OPTION_RE = /^([❯›>●◉▸▶→➤])\s+(\S.*)$/;
const RADIO_OFF_OPTION_RE = /^[○◯]\s+(\S.*)$/;

/** Tool headers shown above an approval question. */
const TOOL_HEADER_RE =
  /^(Bash command|Bash|Shell(?: command)?|Run shell command|Edit file|Update file|Create file|Overwrite file|Write(?: file)?|Read file|Fetch|Web ?Fetch|Web Search|Tool use|MCP tool|Notebook ?Edit|Delete file|Would you like to run the following command\??|Would you like to make the following edits\??|Allow command\??)$/i;
/** Gemini tool confirmation header: "? Shell npm test [current working directory …] (description)". */
const GEMINI_HEADER_RE =
  /^\?\s+(Shell|Edit|WriteFile|Write ?File|ReadFile|Read ?File|ReadManyFiles|WebFetch|Web ?Fetch|GoogleSearch|Google ?Search|ReadFolder|FindFiles|SearchText|Save ?Memory|[\w.-]+ \([^)]*MCP[^)]*\))(?:\s+(.*))?$/i;
/** Tool labels whose request is a file / URL / search rather than a shell command. */
const NON_COMMAND_TOOL_RE = /edit|update|create|overwrite|write|read|fetch|search|notebook|delete|memory|folder|files?$/i;

const ACCOUNT_NOTICE_RE =
  /^(?:[⎿●⏺✕✗×!⚠✖]\s*)?(?:API Error[^:]*:\s*|Error:\s*)?(credit balance is too low|your credit balance[^\n]*|insufficient (?:funds|credit|quota)[^\n]*|invalid api key[^\n]*|authentication failed[^\n]*|oauth token (?:has )?expired[^\n]*|please run \/login[^\n]*|you(?:'ve| have) (?:hit|reached) your (?:usage )?limit[^\n]*)/i;

const CONFIRM_RE = /\[[yY]\/[nN]\]|\([yY]\/[nN]\)|\(y\)es[/, ]+\(n\)o/i;

/** Max rows a menu may sit above the bottom of the screen (in non-blank rows). */
const MENU_SEARCH_ROWS = 18;
/** Max rows walked up from the question to find the prompt panel. */
const PANEL_SEARCH_ROWS = 25;

// ─── Row helpers ─────────────────────────────────────────────────────────────

/** Strips TUI box-drawing borders ("│ text │") so framed prompts parse like plain lines. */
export function unframe(line: string): string {
  return line.replace(FRAME_EDGE_LEFT_RE, '').replace(FRAME_EDGE_RIGHT_RE, '').trim();
}

interface Row {
  /** Right-trimmed row as rendered. */
  raw: string;
  /** Unframed, trimmed text. */
  text: string;
  /** Leading spaces inside the frame. */
  indent: number;
  blank: boolean;
}

function toRow(raw: string): Row {
  const r = raw.replace(/\s+$/, '');
  const inner = r.replace(/^\s*[│┃║▌▎|](?=\s|$)/, '');
  const indent = (inner.match(/^\s*/) || [''])[0].length;
  const text = unframe(r);
  return { raw: r, text, indent, blank: text === '' };
}

function isRule(row: Row): boolean {
  return SOLID_RULE_RE.test(row.text) || DASHED_RULE_RE.test(row.text);
}

function isBoundary(row: Row): boolean {
  return SOLID_RULE_RE.test(row.text) || BOX_TOP_RE.test(row.raw);
}

function normalizeForEcho(line: string): string {
  return unframe(line).replace(/^(?:[-*•]\s+|\[[ x]\]\s+|\d+[.)]\s+)+/i, '').toLowerCase();
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function capText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function hashString(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 5381;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193);
    h2 = (Math.imul(h2, 33) + code) | 0;
  }
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
}

/** Removes the common leading indentation of rows (keeps relative indentation of multi-line commands). */
function dedent(rows: Row[]): string[] {
  const inners = rows.map((r) => r.raw.replace(/^\s*[│┃║▌▎|](?=\s|$)/, '').replace(FRAME_EDGE_RIGHT_RE, ''));
  const indents = inners.filter((l) => l.trim() !== '').map((l) => (l.match(/^\s*/) || [''])[0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return inners.map((l) => l.slice(min).replace(/\s+$/, ''));
}

function snippetOf(rows: Row[]): string {
  return dedent(rows)
    .map((l) => (/^[─━═╌╍┄┅┈┉]{20,}$/.test(l.trim()) ? l.trim().slice(0, 40) : l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s*\n|\s+$/g, '');
}

// ─── Menus ───────────────────────────────────────────────────────────────────

interface MenuOption {
  key: string;
  label: string;
  cursor: boolean;
  numbered: boolean;
  rowIdx: number;
}

interface MenuMatch {
  options: MenuOption[];
  topIdx: number;
  bottomIdx: number;
  /** Last row index (inclusive) of the menu including its footer/continuation rows. */
  endIdx: number;
  hasFooter: boolean;
  /** Rows below the menu that are neither footer nor continuation. */
  strayTrailer: boolean;
}

/** Widest row on screen: approximately the terminal width, which wrapped rows run up to. */
function wrapWidth(rows: Row[]): number {
  let max = 0;
  for (const r of rows) max = Math.max(max, r.raw.trimEnd().length);
  return max;
}

function optionIndentOf(row: Row): number {
  return row.indent + (NUMBERED_OPTION_RE.exec(row.text)?.[1] || CURSOR_PLAIN_OPTION_RE.exec(row.text) ? 2 : 0);
}

/** Classifies the rows below a menu's last option. */
function scanTrailer(rows: Row[], bottomIdx: number, optionTextIndent: number): { hasFooter: boolean; stray: boolean; endIdx: number } {
  let hasFooter = false;
  let stray = false;
  let endIdx = bottomIdx;
  let sawBlank = false;
  for (let i = bottomIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.blank) {
      sawBlank = true;
      continue;
    }
    if (MENU_FOOTER_RE.test(row.text)) {
      hasFooter = true;
      endIdx = i;
      continue;
    }
    if (!sawBlank && row.indent > optionTextIndent - 1 && !stray) {
      // Wrapped label / option description directly under the last option.
      endIdx = i;
      continue;
    }
    if (/^[─━═╰╯╚╝└┘\s]+$/.test(row.raw.trim()) || isRule(row)) continue; // box bottom / rules
    stray = true;
  }
  return { hasFooter, stray, endIdx };
}

function findNumberedMenu(rows: Row[]): MenuMatch | null {
  // Bottom-most numbered option near the bottom of the screen.
  let bottomIdx = -1;
  let seen = 0;
  for (let i = rows.length - 1; i >= 0 && seen < MENU_SEARCH_ROWS; i--) {
    if (rows[i].blank) continue;
    seen++;
    if (NUMBERED_OPTION_RE.test(rows[i].text)) {
      bottomIdx = i;
      break;
    }
  }
  if (bottomIdx === -1) return null;
  const options: MenuOption[] = [];
  let expected = -1;
  let gap = 0;
  let topIdx = bottomIdx;
  // Rows a long label wrapped onto, waiting for the option above them (walking upward).
  let wrapped: string[] = [];
  for (let i = bottomIdx; i >= 0; i--) {
    const row = rows[i];
    const m = NUMBERED_OPTION_RE.exec(row.text);
    if (m) {
      const num = parseInt(m[2] || m[3], 10);
      if (expected !== -1 && num !== expected) return null;
      const marker = m[1] || '';
      const label = [m[4].trim(), ...wrapped].join(' ');
      options.unshift({ key: String(num), label, cursor: marker !== '' && CURSOR_CHARS.includes(marker), numbered: true, rowIdx: i });
      topIdx = i;
      gap = 0;
      wrapped = [];
      if (num === 1) break;
      expected = num - 1;
      continue;
    }
    // Between options: blank rows and indented continuation rows (descriptions, wrapped labels).
    const optIndent = optionIndentOf(rows[topIdx]);
    if ((row.blank || row.indent > optIndent) && gap < 3) {
      gap++;
      continue;
    }
    // Some CLIs (Antigravity) wrap a long label onto the next row with no indent at all. Accept it only when it
    // directly follows a numbered option that ran to the screen edge, i.e. it really is that label's wrap.
    const above = i > 0 ? rows[i - 1] : null;
    const aboveIsLongOption = Boolean(above && NUMBERED_OPTION_RE.test(above.text) && above.raw.trimEnd().length >= wrapWidth(rows) - 14);
    if (!row.blank && gap === 0 && wrapped.length === 0 && aboveIsLongOption && !MENU_FOOTER_RE.test(row.text) && !isRule(row)) {
      wrapped.unshift(row.text.trim());
      continue;
    }
    return null;
  }
  if (options.length < 2 || options.length > 9 || options[0].key !== '1') return null;
  if (options.filter((o) => o.cursor).length > 1) return null;
  if (options.some((o) => o.label.length > 160)) return null;
  const trailer = scanTrailer(rows, bottomIdx, optionIndentOf(rows[bottomIdx]) + 1);
  return { options, topIdx, bottomIdx, endIdx: trailer.endIdx, hasFooter: trailer.hasFooter, strayTrailer: trailer.stray };
}

function findArrowMenu(rows: Row[]): MenuMatch | null {
  let cursorIdx = -1;
  let seen = 0;
  for (let i = rows.length - 1; i >= 0 && seen < MENU_SEARCH_ROWS; i--) {
    if (rows[i].blank) continue;
    seen++;
    if (CURSOR_PLAIN_OPTION_RE.test(rows[i].text) && !NUMBERED_OPTION_RE.test(rows[i].text)) {
      cursorIdx = i;
      break;
    }
  }
  if (cursorIdx === -1) return null;
  const itemIndent = rows[cursorIdx].indent + 2;
  const isItem = (row: Row): { label: string; cursor: boolean } | null => {
    if (row.blank) return null;
    const cur = CURSOR_PLAIN_OPTION_RE.exec(row.text);
    if (cur && !NUMBERED_OPTION_RE.test(row.text)) return { label: cur[2].trim(), cursor: true };
    const radio = RADIO_OFF_OPTION_RE.exec(row.text);
    if (radio) return { label: radio[1].trim(), cursor: false };
    if (
      Math.abs(row.indent - itemIndent) <= 1 &&
      /^[A-Za-z]/.test(row.text) &&
      row.text.length <= 80 &&
      !/[?:.]$/.test(row.text) &&
      !APPROVAL_QUESTION_RE.test(row.text) &&
      !MENU_FOOTER_RE.test(row.text)
    ) {
      return { label: row.text, cursor: false };
    }
    return null;
  };
  let topIdx = cursorIdx;
  let bottomIdx = cursorIdx;
  while (topIdx - 1 >= 0 && isItem(rows[topIdx - 1])) topIdx--;
  while (bottomIdx + 1 < rows.length && isItem(rows[bottomIdx + 1])) bottomIdx++;
  const options: MenuOption[] = [];
  for (let i = topIdx; i <= bottomIdx; i++) {
    const item = isItem(rows[i]);
    if (item) options.push({ key: String(options.length + 1), label: item.label, cursor: item.cursor, numbered: false, rowIdx: i });
  }
  if (options.length < 2 || options.length > 6) return null;
  if (options.filter((o) => o.cursor).length !== 1) return null;
  const trailer = scanTrailer(rows, bottomIdx, itemIndent + 1);
  // Un-numbered rows are easy to confuse with text: require approval-like labels or a key-hint footer.
  const approvalLabels = options.filter((o) => APPROVAL_OPTION_RE.test(o.label)).length;
  if (approvalLabels < 2 && !trailer.hasFooter) return null;
  return { options, topIdx, bottomIdx, endIdx: trailer.endIdx, hasFooter: trailer.hasFooter, strayTrailer: trailer.stray };
}

/** The question a menu answers: the nearest '?' row just above it, or an approval question further up the panel. */
function findQuestion(rows: Row[], menuTopIdx: number): number {
  let nonBlank = 0;
  let nearest = -1;
  for (let i = menuTopIdx - 1; i >= 0 && nonBlank < 14; i--) {
    const row = rows[i];
    if (row.blank) continue;
    if (isBoundary(row)) break;
    nonBlank++;
    if (nonBlank <= 3 && nearest === -1 && (/\?\s*(?:\(.*\))?$/.test(row.text) || APPROVAL_QUESTION_RE.test(row.text))) {
      nearest = i;
      break;
    }
    if (APPROVAL_QUESTION_RE.test(row.text) && /\?\s*$|:\s*$/.test(row.text)) return i;
  }
  return nearest;
}

// ─── Panel details ───────────────────────────────────────────────────────────

interface PanelDetails {
  topIdx: number;
  toolLabel?: string;
  targetCommand?: string;
  description?: string;
  detailLines?: string[];
  /** targetCommand came from the panel's structure (dashed box, "$" row, Gemini header/question, header block). */
  structuralCommand: boolean;
}

/**
 * Joins the rows of a command drawn between dashed rules. Rows the CLI soft-wrapped at the box edge are joined back
 * (a long token hard-broken at the edge → no separator; a word that did not fit on the previous row → one space);
 * only real line breaks of a multi-line command stay '\n'.
 */
function joinBoxCommand(boxRows: Row[], boxWidth: number): string {
  const lines = dedent(boxRows);
  const inners = boxRows.map((r) => r.raw.replace(/^\s*[│┃║▌▎|](?=\s|$)/, '').replace(FRAME_EDGE_RIGHT_RE, ''));
  const indents = inners.map((l) => (l.trim() === '' ? -1 : (l.match(/^\s*/) || [''])[0].length));
  const base = Math.min(...indents.filter((n) => n >= 0));
  // Content may end one column short of the rule (right padding).
  const lastCol = boxWidth - 1;
  const contentWidth = lastCol - base;
  const len = (s: string) => Array.from(s).length;
  let out = lines[0] ?? '';
  for (let i = 1; i < lines.length; i++) {
    const prevEnd = len(inners[i - 1]);
    const continues = boxWidth > 0 && indents[i - 1] >= 0 && indents[i] === base;
    const firstWord = len((lines[i].match(/^\S+/) || [''])[0]);
    const prevLastWord = len((lines[i - 1].match(/\S+$/) || [''])[0]);
    // Word wrap moves a word that fits on a row to the next row whole; only a word longer than the row is split.
    if (continues && prevEnd >= lastCol && prevLastWord + firstWord > contentWidth) out += lines[i];
    else if (continues && prevEnd + 1 + firstWord > lastCol) out += ` ${lines[i]}`;
    else out += `\n${lines[i]}`;
  }
  return out;
}

function normalizeToolLabel(raw: string): string {
  const label = raw.replace(/\?$/, '').trim();
  if (/run the following command|^allow command$/i.test(label)) return 'Run command';
  if (/make the following edits/i.test(label)) return 'Edit files';
  return label;
}

function extractPanel(rows: Row[], questionIdx: number, menu: MenuMatch): PanelDetails {
  const question = rows[questionIdx];
  // Panel top: the question itself when it is the header (Codex), else walk up to a header, rule or box top.
  let topIdx = questionIdx;
  let headerIdx = -1;
  if (TOOL_HEADER_RE.test(question.text)) {
    headerIdx = questionIdx;
  } else {
    // A dashed command / diff box counts as one row, so a long (multi-line) command does not use up the search
    // budget before the header is reached — and rows inside it (command output, ─── in a heredoc) are never
    // mistaken for a header or a panel boundary.
    let budget = PANEL_SEARCH_ROWS;
    let inDashedBox = false;
    for (let i = questionIdx - 1; i >= 0 && budget > 0; i--) {
      const row = rows[i];
      if (DASHED_RULE_RE.test(row.text)) {
        inDashedBox = !inDashedBox;
        budget--;
        continue;
      }
      if (inDashedBox) continue;
      budget--;
      if (isBoundary(row)) {
        topIdx = i + 1;
        break;
      }
      if (TOOL_HEADER_RE.test(row.text) || GEMINI_HEADER_RE.test(row.text)) {
        topIdx = i;
        headerIdx = i;
        break;
      }
    }
  }
  // Body = panel rows above the menu, minus the question.
  const body: Array<{ row: Row; idx: number }> = [];
  for (let i = topIdx; i < menu.topIdx; i++) if (i !== questionIdx) body.push({ row: rows[i], idx: i });
  const used = new Set<number>();
  if (headerIdx !== -1) used.add(headerIdx);

  let toolLabel: string | undefined;
  let geminiRest: string | undefined;
  if (headerIdx !== -1) {
    const headerText = rows[headerIdx].text;
    const gem = TOOL_HEADER_RE.test(headerText) ? null : GEMINI_HEADER_RE.exec(headerText);
    if (gem) {
      toolLabel = gem[1].trim();
      geminiRest = gem[2]?.trim();
    } else {
      toolLabel = normalizeToolLabel(headerText);
    }
  }
  // Antigravity: a short header ("Command", "Edit file") sits just above the rule that tops the panel.
  if (!toolLabel && headerIdx === -1 && topIdx >= 2 && isRule(rows[topIdx - 1])) {
    const head = rows[topIdx - 2];
    if (!head.blank && head.text.length <= 32 && /^[A-Za-z][\w ./-]*$/.test(head.text)) toolLabel = normalizeToolLabel(head.text);
  }
  // Antigravity: "Requesting permission for:" followed by the command / path rows (or the same row, inline).
  let requested: string | undefined;
  const reqAt = body.findIndex((b) => /^requesting permission for:?(?:\s|$)/i.test(b.row.text));
  if (reqAt !== -1) {
    const req = body[reqAt];
    used.add(req.idx);
    const inline = req.row.text.replace(/^requesting permission for:?\s*/i, '').trim();
    const lines: string[] = inline ? [inline] : [];
    let firstIndent = -1;
    for (const b of body.slice(reqAt + 1)) {
      if (b.row.blank) {
        if (lines.length) break;
        continue;
      }
      if (isRule(b.row)) break;
      // A row indented less than the first one is that row wrapping at the screen edge, not a new line.
      if (firstIndent !== -1 && b.row.indent < firstIndent && lines.length) lines[lines.length - 1] += ` ${b.row.text}`;
      else lines.push(b.row.text);
      if (firstIndent === -1) firstIndent = b.row.indent;
      used.add(b.idx);
    }
    if (lines.length) requested = lines.join('\n');
  }
  const isCommandTool = !toolLabel || !NON_COMMAND_TOOL_RE.test(toolLabel) || /command|shell|bash/i.test(toolLabel);

  // Dashed box (Claude 2.1): command for Bash, diff / content for file tools.
  const dashed = body.filter((b) => DASHED_RULE_RE.test(b.row.text));
  let boxRows: Array<{ row: Row; idx: number }> = [];
  let boxWidth = 0;
  if (dashed.length >= 2) {
    boxRows = body.filter((b) => b.idx > dashed[0].idx && b.idx < dashed[1].idx);
    boxWidth = Math.max(Array.from(dashed[0].row.raw).length, Array.from(dashed[1].row.raw).length);
    used.add(dashed[0].idx);
    used.add(dashed[1].idx);
  }

  let targetCommand: string | undefined;
  let structuralCommand = false;
  let ruleHint: string | undefined;
  let detailLines: string[] | undefined;
  let description: string | undefined;

  if (isCommandTool) {
    // (0) Antigravity "Requesting permission for:" block
    if (requested) {
      targetCommand = requested;
      structuralCommand = true;
    }
    // (1) between dashed rules
    if (!targetCommand && boxRows.length > 0) {
      let start = 0;
      let end = boxRows.length;
      while (start < end && boxRows[start].row.blank) start++;
      while (end > start && boxRows[end - 1].row.blank) end--;
      if (end > start) {
        targetCommand = joinBoxCommand(boxRows.slice(start, end).map((b) => b.row), boxWidth);
        structuralCommand = true;
        boxRows.forEach((b) => used.add(b.idx));
      }
    }
    // (2) "$ cmd" row (Codex)
    if (!targetCommand) {
      const dollar = body.find((b) => /^\$\s+\S/.test(b.row.text));
      if (dollar) {
        targetCommand = dollar.row.text.replace(/^\$\s+/, '');
        structuralCommand = true;
        used.add(dollar.idx);
        // Continuation rows of a long or multi-line command (indented deeper than the "$").
        for (const b of body) {
          if (b.idx <= dollar.idx || b.row.blank || b.row.indent <= dollar.row.indent) {
            if (b.idx > dollar.idx) break;
            continue;
          }
          targetCommand += `\n${b.row.text}`;
          used.add(b.idx);
        }
      }
    }
    // (3) Gemini header "? Shell <cmd> [current working directory …] (description)"
    if (!targetCommand && geminiRest) {
      let rest = geminiRest.replace(/\s*\[current working directory[^\]]*\]/i, '');
      const desc = rest.match(/\s+\(([^()]*)\)\s*$/);
      if (desc) {
        description = desc[1].trim();
        rest = rest.slice(0, desc.index).trim();
      }
      if (rest) {
        targetCommand = rest;
        structuralCommand = true;
      }
      // The same command is usually repeated in the box body.
      for (const b of body) if (targetCommand && b.row.text === targetCommand) used.add(b.idx);
    }
    // (4) Gemini question "Allow execution of: 'cmd'?"
    if (!targetCommand) {
      const m = question.text.match(/allow execution of:?\s*['"`‘“](.+?)['"`’”]\s*\??\s*$/i);
      if (m) {
        targetCommand = m[1];
        structuralCommand = true;
      }
    }
    // (5) older Claude layout: header, indented command, description
    if (!targetCommand && headerIdx !== -1 && headerIdx !== questionIdx) {
      const block: Array<{ row: Row; idx: number }> = [];
      let started = false;
      for (const b of body) {
        if (b.idx <= headerIdx) continue;
        if (b.row.blank) {
          if (started) break;
          continue;
        }
        if (isRule(b.row) || /^tip:/i.test(b.row.text)) continue;
        started = true;
        block.push(b);
      }
      if (block.length) {
        targetCommand = block[0].row.text;
        structuralCommand = true;
        used.add(block[0].idx);
      }
    }
    // (6) backticks / "Command: x"
    if (!targetCommand) {
      for (const b of [...body, { row: question, idx: questionIdx }]) {
        const tick = b.row.text.match(/`([^`]+)`/);
        if (tick) {
          targetCommand = tick[1];
          break;
        }
        const labelled = b.row.text.match(/^(?:bash command|command|executing|execute|run)\s*:\s*(.+)$/i);
        if (labelled && labelled[1].trim()) {
          targetCommand = labelled[1].trim();
          used.add(b.idx);
          break;
        }
      }
    }
    // (7) "Yes, and don't ask again for: <prefix>" — only a hint of what is being run (a permission-rule pattern
    // such as "cat:*", not the command), so it goes into the description, never into targetCommand.
    if (!targetCommand) {
      for (const o of menu.options) {
        const m = o.label.match(/don.?t ask again for:?\s*(.+)$/i);
        if (m && m[1].trim() && !/^(?:this|these|commands?)\b/i.test(m[1].trim())) {
          ruleHint = `Rule offered: ${m[1].trim()}`;
          break;
        }
      }
    }
  } else {
    // File / URL / search tools: the target row under the header, then the box (diff / content) rows.
    const details: string[] = [];
    if (geminiRest) details.push(geminiRest);
    if (requested) details.push(...requested.split('\n'));
    const afterHeader = body.find((b) => b.idx > headerIdx && !b.row.blank && !isRule(b.row) && !/^tip:/i.test(b.row.text));
    if (afterHeader && (!boxRows.length || afterHeader.idx < boxRows[0].idx)) {
      details.push(afterHeader.row.text);
      used.add(afterHeader.idx);
    }
    const contentRows = boxRows.length ? boxRows : [];
    if (contentRows.length) {
      details.push(...dedent(contentRows.map((b) => b.row)).filter((l) => l.trim() !== '').slice(0, 40));
      contentRows.forEach((b) => used.add(b.idx));
    }
    if (details.length) detailLines = details;
  }

  if (description === undefined) {
    const descRows = body.filter(
      (b) =>
        !used.has(b.idx) &&
        !b.row.blank &&
        !isRule(b.row) &&
        !/^tip:/i.test(b.row.text) &&
        !/requires? approval\.?$/i.test(b.row.text) &&
        !(targetCommand && b.row.text === targetCommand.split('\n')[0])
    );
    const text = descRows.map((b) => b.row.text).join('\n').trim();
    if (text) description = capText(text, 600);
  }
  if (ruleHint) description = description ? `${description}\n${ruleHint}` : ruleHint;

  return { topIdx, toolLabel, targetCommand, description, detailLines, structuralCommand };
}

// ─── Prompt builders ─────────────────────────────────────────────────────────

function signatureOf(p: Omit<CliDetectedPrompt, 'signature'>): string {
  const parts = [
    p.type,
    p.kind,
    oneLine(p.question),
    p.toolLabel || '',
    p.targetCommand || '',
    (p.detailLines || []).slice(0, 3).join('|'),
    (p.options || []).map((o) => `${o.key}:${o.label}`).join('|'),
  ];
  return `p${hashString(parts.join('\u0001'))}`;
}

function finishPrompt(p: Omit<CliDetectedPrompt, 'signature'>): CliDetectedPrompt {
  return { ...p, signature: signatureOf(p) };
}

function firstClause(label: string): string {
  return label.split(/[,(·:;—–]| - /)[0];
}

function toPromptOptions(options: MenuOption[]): CliPromptOption[] {
  return options.map((o, idx) => {
    const destructive = DESTRUCTIVE_LABEL_RE.test(firstClause(o.label));
    return {
      key: o.key,
      label: o.label,
      isDefault: o.cursor,
      isDestructive: destructive,
      numbered: o.numbered,
      index: idx,
      isApprove: !destructive && APPROVE_LABEL_RE.test(o.label.trim()),
    };
  });
}

function buildMenuPrompt(rows: Row[], menu: MenuMatch): CliDetectedPrompt | null {
  const questionIdx = findQuestion(rows, menu.topIdx);
  if (questionIdx === -1) return null;
  const question = rows[questionIdx].text;
  const hasCursor = menu.options.some((o) => o.cursor);
  const approvalQuestion = APPROVAL_QUESTION_RE.test(question);
  const approvalLabels = menu.options.some((o) => APPROVAL_OPTION_RE.test(o.label));
  if (!hasCursor && !menu.hasFooter && !approvalLabels) return null;
  // Text below the menu means it is probably not waiting for input — unless it is clearly a live approval menu.
  if (menu.strayTrailer && !(hasCursor && (approvalQuestion || menu.hasFooter))) return null;

  const panel = extractPanel(rows, questionIdx, menu);
  const options = toPromptOptions(menu.options);
  const hasApprove = options.some((o) => o.isApprove);
  const snippetStart = Math.min(panel.topIdx, questionIdx);
  // Panel rows above the question, outside any dashed command / diff box (whose content is arbitrary).
  const headerRows: Row[] = [];
  let inBox = false;
  for (let i = snippetStart; i < questionIdx; i++) {
    if (DASHED_RULE_RE.test(rows[i].text)) inBox = !inBox;
    else if (!inBox && !rows[i].blank) headerRows.push(rows[i]);
  }
  // Agent questions (Claude's AskUserQuestion) are never approvals, whatever they ask ("Do you want to …?", "Run `x`?").
  const agentQuestion =
    menu.options.some((o) => AGENT_QUESTION_OPTION_RE.test(o.label.trim())) ||
    rows.slice(menu.bottomIdx + 1).some((r) => AGENT_QUESTION_ROW_RE.test(r.text)) ||
    headerRows.some((r) => QUESTION_TAB_RE.test(r.text));
  // An approval needs structural evidence of a tool-permission dialog, not just approval-sounding words.
  const permissionPanel =
    Boolean(panel.toolLabel) ||
    panel.structuralCommand ||
    PERMISSION_QUESTION_RE.test(question) ||
    menu.options.some((o) => PERMISSION_OPTION_RE.test(o.label)) ||
    [...headerRows, rows[questionIdx]].some((r) => PERMISSION_ROW_RE.test(r.text));
  const isApproval = hasApprove && !agentQuestion && permissionPanel;
  const kind: CliDetectedPrompt['kind'] = isApproval ? 'approval' : 'question';
  return finishPrompt({
    type: 'multiple_choice',
    kind,
    title: panel.toolLabel || (kind === 'approval' ? 'Action Requires Approval' : 'Agent is asking'),
    toolLabel: panel.toolLabel,
    targetCommand: panel.targetCommand,
    description: panel.description,
    detailLines: panel.detailLines,
    question,
    options,
    rawSnippet: snippetOf(rows.slice(snippetStart, menu.endIdx + 1)),
  });
}

/**
 * True when a y/n confirmation row is still waiting for an answer. Once answered, line-mode CLIs leave the answer
 * on the row ("…[Yes]: y", "…(y/n)? n", "[y/N] y"); that row must not be reported (and auto-answered) again.
 * Still pending: "(Y)es/(N)o/(D)on't ask again [Yes]: ", "Continue? (y/n) [y]: ", "[y/N] ", "[y/N] (default no)".
 */
function isPendingConfirmRow(text: string): boolean {
  const m = CONFIRM_RE.exec(text);
  if (!m) return false;
  const rest = text.slice(m.index + m[0].length).replace(/\s+$/, '');
  // An answer token typed after the prompt's last terminator (":", "?", "]", ")" or the marker itself).
  return !/(?:^|[:?\])])\s+[^\s[\]():?]{1,20}$/.test(rest);
}

function detectConfirmation(rows: Row[]): CliDetectedPrompt | null {
  const nonBlank = rows.map((r, idx) => ({ r, idx })).filter((x) => !x.r.blank);
  const last = nonBlank.slice(-2);
  const hit = [...last].reverse().find((x) => isPendingConfirmRow(x.r.text));
  if (!hit) return null;
  const text = last.map((x) => x.r.text).join('\n');
  const options: CliPromptOption[] = [
    { key: 'y', label: 'Approve / Yes', isDefault: false, isDestructive: false, numbered: true, index: 0, isApprove: true },
    { key: 'n', label: 'Reject / No', isDefault: false, isDestructive: true, numbered: true, index: 1, isApprove: false },
  ];
  if (/\(a\)lways|\[a\]lways/i.test(text)) {
    options.splice(1, 0, { key: 'a', label: 'Always Allow', isDefault: false, isDestructive: false, numbered: true, index: 1, isApprove: true });
    options[2].index = 2;
  }
  if (/\(d\)on.?t ask/i.test(text)) {
    options.push({ key: 'd', label: "Don't ask again", isDefault: false, isDestructive: false, numbered: true, index: options.length, isApprove: true });
  }
  // A [Y/n] default (capital letter) is the one Enter would pick.
  const defMatch = hit.r.text.match(/\[([yYnN])\/([yYnN])\]|\(([yYnN])\/([yYnN])\)|\[(Yes|No)\]/);
  if (defMatch) {
    const def = defMatch[5] ? defMatch[5][0].toLowerCase() : [defMatch[1], defMatch[2], defMatch[3], defMatch[4]].find((c) => c && c === c.toUpperCase())?.toLowerCase();
    const opt = options.find((o) => o.key === def);
    if (opt) opt.isDefault = true;
  }
  // Context: command-ish rows just above the question.
  const above = rows.slice(Math.max(0, hit.idx - 6), hit.idx).filter((r) => !r.blank && !isRule(r));
  let targetCommand: string | undefined;
  const dollar = [...above].reverse().find((r) => /^\$\s+\S/.test(r.text));
  if (dollar) targetCommand = dollar.text.replace(/^\$\s+/, '');
  if (!targetCommand) {
    const tick = (hit.r.text.match(/`([^`]+)`/) || above.map((r) => r.text.match(/`([^`]+)`/)).find(Boolean)) as RegExpMatchArray | null | undefined;
    if (tick) targetCommand = tick[1];
  }
  if (!targetCommand) {
    const labelled = [...above].reverse().map((r) => r.text.match(/^(?:bash command|command|executing|execute|run(?: shell command)?)\s*:\s*(.+)$/i)).find(Boolean);
    if (labelled) targetCommand = labelled[1].trim();
  }
  if (!targetCommand && /run shell command|run (?:this )?command|execute/i.test(hit.r.text) && above.length) {
    targetCommand = above[above.length - 1].text;
  }
  const question = hit.r.text;
  const kind: CliDetectedPrompt['kind'] =
    APPROVAL_QUESTION_RE.test(question) || /\b(?:run|execute|command|allow|apply|edit|create|write|delete|overwrite)\b/i.test(question) || targetCommand
      ? 'approval'
      : 'question';
  const snippetRows = rows.slice(Math.max(0, hit.idx - 6), hit.idx + 1);
  return finishPrompt({
    type: 'confirmation',
    kind,
    title: 'Confirmation Required',
    targetCommand,
    question,
    options,
    rawSnippet: snippetOf(snippetRows),
  });
}

function detectNotice(rows: Row[]): CliDetectedPrompt | null {
  const nonBlank = rows.filter((r) => !r.blank).slice(-10);
  for (let i = nonBlank.length - 1; i >= 0; i--) {
    const m = nonBlank[i].text.match(ACCOUNT_NOTICE_RE);
    if (!m) continue;
    const detail = oneLine(nonBlank[i].text.replace(/^[⎿●⏺✕✗×!⚠✖]\s*/, ''));
    return finishPrompt({
      type: 'freeform',
      kind: 'notice',
      title: 'AI Account Notice',
      question: `${capText(detail, 240)} (Please check your API key in AI Credentials Settings or verify account balance).`,
      rawSnippet: snippetOf(rows.slice(Math.max(0, rows.indexOf(nonBlank[i]) - 3), rows.indexOf(nonBlank[i]) + 2)),
    });
  }
  return null;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Parses the prompt an agent is blocked on from its rendered screen rows (TerminalScreen.visibleRows()).
 * `echoedText` = text the CLI echoes back (the task prompt), whose lines are never read as menu content.
 * Returns null when the bottom of the screen is not an interactive prompt.
 */
export function parseCliScreenPrompt(rows: string[], opts: { echoedText?: string } = {}): CliDetectedPrompt | null {
  const echoed = new Set(
    (opts.echoedText || '')
      .split('\n')
      .map(normalizeForEcho)
      .filter((l) => l.length > 3)
  );
  const isEcho = (text: string) => echoed.has(normalizeForEcho(text));
  const all = rows.map(toRow);
  const parse = (dropEcho: boolean): CliDetectedPrompt | null => {
    let parsed = dropEcho ? all.filter((r) => r.blank || isRule(r) || !isEcho(r.text)) : all;
    let end = parsed.length;
    while (end > 0 && parsed[end - 1].blank) end--;
    if (end === 0) return null;
    parsed = parsed.slice(Math.max(0, end - 60), end);

    const numbered = findNumberedMenu(parsed);
    const numberedPrompt = numbered ? buildMenuPrompt(parsed, numbered) : null;
    if (numberedPrompt) return numberedPrompt;
    const arrow = findArrowMenu(parsed);
    const arrowPrompt = arrow ? buildMenuPrompt(parsed, arrow) : null;
    if (arrowPrompt) return arrowPrompt;
    return detectConfirmation(parsed) || detectNotice(parsed);
  };
  if (echoed.size === 0) return parse(false);
  // Parse the screen as drawn first: a real panel's path / command / diff rows may equal lines of the task prompt
  // (e.g. "- src/app.ts", "- [ ] npm test") and must stay. Only when the prompt found is itself made of echoed
  // lines (question, an option, a notice) is it re-parsed without them, so the echoed task text is never a prompt.
  const raw = parse(false);
  if (raw && raw.kind !== 'notice' && !isEcho(raw.question) && !(raw.options || []).some((o) => o.label.length > 3 && isEcho(o.label))) {
    return raw;
  }
  return parse(true);
}

/**
 * Keystrokes that choose `option` in `prompt`:
 *  - [y/N] confirmations: the letter + Enter (Enter alone would pick whichever default the CLI chose);
 *  - the highlighted option: Enter;
 *  - un-numbered arrow menus: arrow keys from the highlighted option, then Enter;
 *  - numbered menus with a cursor (Ink / ratatui): the digit, which selects immediately;
 *  - numbered lists without a cursor (line-mode prompts): the digit + Enter.
 */
export function keystrokesForOption(prompt: CliDetectedPrompt, option: CliPromptOption): string {
  if (prompt.type === 'confirmation') return `${option.key}\r`;
  const options = prompt.options || [];
  const defaultIdx = options.findIndex((o) => o.isDefault);
  if (option.isDefault) return '\r';
  const index = typeof option.index === 'number' ? option.index : options.findIndex((o) => o.key === option.key && o.label === option.label);
  if (option.numbered === false && index >= 0) {
    const delta = index - Math.max(0, defaultIdx);
    return (delta > 0 ? '\x1b[B' : '\x1b[A').repeat(Math.abs(delta)) + '\r';
  }
  if (defaultIdx === -1) return `${option.key}\r`;
  return option.key;
}

/**
 * The option that approves just this request: "Yes" / "Allow once" style first, then "don't ask again" style.
 * Never a refusal, and never one that switches modes or hands control elsewhere.
 */
export function pickApproveOption(prompt: CliDetectedPrompt): CliPromptOption | null {
  const options = prompt.options || [];
  if (prompt.type === 'confirmation') return options.find((o) => o.key === 'y') || null;
  const candidates = options.filter((o) => o.isApprove && !o.isDestructive && !MODE_CHANGE_LABEL_RE.test(o.label));
  return (
    candidates.find((o) => !PERSISTENT_LABEL_RE.test(o.label)) ||
    candidates.find((o) => /\bsession\b/i.test(o.label)) ||
    candidates[0] ||
    null
  );
}

/** Claude Code's one-time "Bypass Permissions mode … Yes, I accept" dialog — never answered automatically. */
export function isBypassAcceptanceDialog(prompt: CliDetectedPrompt): boolean {
  const text = `${prompt.question}\n${prompt.rawSnippet}`;
  return /bypass permissions mode|dangerously-skip-permissions/i.test(text) && (prompt.options || []).some((o) => /i accept/i.test(o.label));
}

/** One line (≤200 chars) saying what the prompt is about: the command, else tool + detail, else the question. */
export function promptSummary(prompt: CliDetectedPrompt): string {
  let text: string;
  if (prompt.targetCommand) {
    text = oneLine(prompt.targetCommand);
  } else if (prompt.toolLabel) {
    const detail = prompt.detailLines?.find((l) => l.trim()) || prompt.description || '';
    text = oneLine(detail ? `${prompt.toolLabel}: ${detail}` : prompt.toolLabel);
  } else {
    text = oneLine(prompt.question);
  }
  return capText(text, 200);
}
