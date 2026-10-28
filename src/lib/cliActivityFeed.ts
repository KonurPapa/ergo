/**
 * Reads what a CLI agent is doing from its rendered terminal rows (Claude Code, Codex and Gemini layouts). Shared by the
 * Notes view's activity feed and the bridge, which falls back to it for the live status line when a CLI has no
 * readable session log (agentActivity.ts).
 */

export interface ActivityFeedItem {
  id: string;
  type: 'thought' | 'tool' | 'user' | 'status' | 'approval';
  text: string;
  detail?: string;
  timestamp: string;
}

export const nowTime = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Box-drawing frame characters at the edges of TUI rows ("│ text │"). */
const FRAME_EDGE_RE = /^[\s│┃║▌▎|╭╮╰╯╔╗╚╝]+|[\s│┃║▌▎|╭╮╰╯╔╗╚╝]+$/g;
/** Rows made only of rule characters. */
const RULE_ROW_RE = /^[\s─━═╌╍┄┅┈┉_\-–—▔▁]+$/;
/** Footer / key-hint / mode rows every CLI repaints under its input box. */
const FOOTER_RE =
  /esc to (?:cancel|exit|go back)|enter to (?:confirm|select|submit)|↑\/↓|↑↓|tab to amend|ctrl\+[a-z] to|\? for shortcuts|shift\+tab to cycle|(?:accept edits|bypass permissions|plan mode|auto mode|manual mode) on|auto-accept edits|YOLO mode|context left|tokens? (?:used|left)|^\s*>\s*$|^Try "/i;
/** Rows that show a menu option ("❯ 1. Yes", "2. No"). */
const MENU_OPTION_RE = /^(?:[❯›>●◉▸▶→]\s*)?(?:\[\d{1,2}\]|\d{1,2}[.)])\s+/;
/** Live status rows (spinners): they describe what the agent is doing right now, not something it did. */
const SPINNER_RE = /\(?[^()]*\besc to (?:interrupt|cancel)\b[^()]*\)?/i;
const SPINNER_GLYPHS_RE = /^[✻✶✳✢✽·*⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒⣾⣽⣻⢿⡿⣟⣯⣷•]\s*/;
/** Spinner rows without an inline key hint ("✢ Gallivanting…", "✻ Crunching… (12s · ↓ 1.2k tokens)"). */
const SPINNER_WORD_RE = /^[✻✶✳✢✽·*⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]\s+[^\s…][^…]{0,60}…/;

export function isSpinnerRow(row: string): boolean {
  return /esc to (?:interrupt|cancel)/i.test(row) || SPINNER_WORD_RE.test(row);
}

const TOOL_NAMES =
  'Bash|Read|Edit|MultiEdit|Write|Update|Create|Glob|Grep|LS|List|Search|Task|Agent|WebFetch|WebSearch|Fetch|NotebookEdit|NotebookRead|TodoWrite|Shell|ReadFile|WriteFile|ReadManyFiles|ReadFolder|FindFiles|SearchText|Replace|GoogleSearch|SaveMemory';
/** "● Bash(npm test)", "⏺ Read(src/a.ts)", "✓ ReadFile src/a.ts" (Claude / Gemini tool rows). */
const TOOL_CALL_RE = new RegExp(`^(?:[●⏺•✓✔✗×✦⊷○◆]\\s*)?(${TOOL_NAMES})\\s*\\((.*?)\\)?\\s*$`);
const TOOL_ROW_RE = new RegExp(`^[✓✔✗×⊷○]\\s+(${TOOL_NAMES})\\s+(.+)$`);
/** Codex-style action rows: "• Ran npm test", "• Edited src/a.ts (+3 -1)". */
const ACTION_VERB_RE =
  /^[•●⏺]\s*(Ran|Running|Explored|Exploring|Edited|Editing|Added|Deleted|Updated|Wrote|Created|Searched|Searching|Called|Read|Reading|Applied patch)\b\s*(.*)$/;
/** A command shown under a tool row ("⎿  $ npm test") or on its own ("$ npm test"). */
const COMMAND_ROW_RE = /^(?:⎿|└)?\s*\$\s+(\S.*)$/;
/** Older "label: value" tool rows. */
const LABELLED_TOOL_RE = /^(?:permission for|bash command|running|tool\s+call|executing|calling tool)\s*:\s*(.+)$/i;
/** Assistant text rows ("● I'll start by…", "✦ Looking at…", "• Updated the plan"). */
const NARRATIVE_RE = /^[●⏺✦•]\s+(.+)$/;
const THINKING_RE = /^(?:[✻∴]\s*)?thinking\b[:\s…]*(.*)$/i;

export function cleanRow(row: string): string {
  return row.replace(FRAME_EDGE_RE, '').trim();
}

function normalizeEcho(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function stripSpinner(row: string): string {
  return row.replace(SPINNER_RE, '').replace(SPINNER_GLYPHS_RE, '').replace(/[\s·•]+$/, '').trim();
}

/**
 * Builds the Notes activity feed from rendered terminal rows (a ScreenTranscript, so TUI repaints are already
 * collapsed and words keep their spacing). Recognises tool calls, shell commands, sub-agent launches and the agent's
 * own narration across Claude Code, Codex and Gemini layouts; the live spinner row becomes `currentActivity`.
 */
export function extractActivityEntries(
  lines: string[],
  label: string = 'Agent',
  /** Rows currently on screen; when given, only these can supply the live spinner status. */
  liveRows?: string[],
  /** The prompt Ergo launched the agent with: CLIs echo it back, and those rows aren't the agent's activity. */
  launchPrompt?: string
): {
  feed: ActivityFeedItem[];
  currentActivity: string;
} {
  const idle = `${label} is active`;
  const feed: ActivityFeedItem[] = [];
  const seen = new Set<string>();
  let currentActivity = idle;
  let liveStatus = '';
  let lastMeaningful = '';

  const push = (type: ActivityFeedItem['type'], text: string, detail?: string) => {
    const clipped = text.length > 220 ? `${text.slice(0, 219)}…` : text;
    const key = detail ? `${clipped}\u0000${detail}` : clipped;
    if (seen.has(key)) return;
    seen.add(key);
    feed.push({ id: `act:${key}`, type, text: clipped, detail, timestamp: nowTime() });
    currentActivity = detail ? `${clipped}: ${detail}` : clipped;
  };

  // Whitespace-collapsed, so rows the CLI wrapped the echoed prompt into still match as substrings.
  const echoed = launchPrompt ? normalizeEcho(launchPrompt) : '';
  const isEcho = (row: string) => {
    if (!echoed) return false;
    const norm = normalizeEcho(row.replace(/^[●○⏺✦•│>❯]\s*/, ''));
    return norm.length >= 8 && echoed.includes(norm);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = cleanRow(lines[i] ?? '');
    if (!line || RULE_ROW_RE.test(line)) continue;
    if (isEcho(line)) continue;
    if (MENU_OPTION_RE.test(line)) continue;
    if (/^(?:run this command\?|choose an option|do you want to proceed\?)/i.test(line)) continue;

    // The spinner row: "✻ Crunching… (12s · ↑ 1.2k tokens · esc to interrupt)"
    if (isSpinnerRow(line)) {
      const status = stripSpinner(line);
      if (status) liveStatus = status;
      continue;
    }
    if (FOOTER_RE.test(line)) continue;
    // Echo of what the user typed / the task prompt.
    if (/^[❯>]\s/.test(line)) continue;

    const call = line.match(TOOL_CALL_RE) || line.match(TOOL_ROW_RE);
    if (call) {
      const tool = call[1];
      const arg = (call[2] || '').trim();
      if (/^(?:Task|Agent)$/.test(tool)) {
        push('tool', 'Sub-agent', arg || undefined);
      } else {
        push('tool', tool, arg || undefined);
      }
      lastMeaningful = line;
      continue;
    }

    const command = line.match(COMMAND_ROW_RE);
    if (command) {
      push('tool', 'Command', command[1].trim());
      lastMeaningful = line;
      continue;
    }

    const action = line.match(ACTION_VERB_RE);
    if (action) {
      const detail = action[2].replace(/^`|`$/g, '').trim();
      push('tool', detail ? `${action[1]} ${detail}` : action[1]);
      lastMeaningful = line;
      continue;
    }

    const labelled = line.match(LABELLED_TOOL_RE);
    if (labelled) {
      const value = labelled[1].trim();
      push('tool', 'Action', value);
      lastMeaningful = line;
      continue;
    }

    const thinking = line.match(THINKING_RE);
    if (thinking) {
      const text = thinking[1].trim();
      if (text.length > 3) push('thought', text);
      continue;
    }

    const narrative = line.match(NARRATIVE_RE);
    if (narrative) {
      const text = narrative[1].trim();
      if (text.length > 2) push('thought', text);
      lastMeaningful = line;
      continue;
    }

    // Tool results ("⎿ Read 20 lines") and wrapped continuation text are context only.
    if (!/^(?:⎿|└)/.test(line) && line.length < 90) lastMeaningful = line;
  }

  if (liveRows) {
    // History keeps every old spinner frame; only a spinner that is on screen now describes current work.
    liveStatus = '';
    for (const raw of liveRows) {
      const row = cleanRow(raw ?? '');
      if (row && isSpinnerRow(row)) {
        const status = stripSpinner(row);
        if (status) liveStatus = status;
      }
    }
  }
  if (liveStatus) {
    currentActivity = liveStatus;
  } else if (currentActivity === idle && lastMeaningful) {
    currentActivity = cleanRow(lastMeaningful);
  }

  return { feed: feed.slice(-20), currentActivity };
}
