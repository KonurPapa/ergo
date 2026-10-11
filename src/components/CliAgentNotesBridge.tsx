import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Terminal,
  Sparkles,
  ShieldAlert,
  Send,
  RotateCcw,
  Square,
  Copy,
  Check,
  ChevronDown,
  ChevronUp,
  Brain,
  ExternalLink,
  MessageSquare,
  Command,
  Loader2,
} from 'lucide-react';
import { bridgeClient } from '../lib/bridgeClient';

export interface CliPromptOption {
  key: string;
  label: string;
  isDefault?: boolean;
  isDestructive?: boolean;
  /** False for un-numbered TUI menus ("❯ Yes"), which are answered with arrow keys instead of the key. */
  numbered?: boolean;
  /** Position in the menu (0-based). */
  index?: number;
}

export interface CliDetectedPrompt {
  type: 'multiple_choice' | 'confirmation' | 'freeform';
  title?: string;
  targetCommand?: string;
  question: string;
  options?: CliPromptOption[];
  rawSnippet: string;
}

export interface ActivityFeedItem {
  id: string;
  type: 'thought' | 'tool' | 'user' | 'status';
  text: string;
  detail?: string;
  timestamp: string;
}

export interface CliAgentNotesBridgeProps {
  cmd: string;
  args?: string[];
  cwd: string;
  taskId: string | number;
  sessionId?: string;
  env?: Record<string, string>;
  forceRestart?: boolean;
  spawnId?: string;
  isActive?: boolean;
  onExit?: (code: number) => void;
  onRestartSession?: () => void;
  onKillSession?: () => void;
  onSwitchToSteps?: () => void;
}

/**
 * Strips terminal ANSI escape sequences, OSC codes, and carriage returns.
 */
export function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

/** Footer hints that interactive CLI menus print under their options. */
const MENU_FOOTER_RE = /esc to (?:cancel|interrupt|exit|go back)|enter to (?:confirm|select|submit)|↑\/↓|↑↓|tab to amend|tab amend|ctrl\+[a-z] to/i;
/** Questions CLIs ask before running a tool. */
const APPROVAL_QUESTION_RE =
  /do you want to|would you like to (?:proceed|run|allow|make|create|apply|continue)|allow (?:this|execution|command|edit|write|the|claude|agy|gemini|codex)|permission (?:needed|required|to|for)|needs? your (?:permission|approval)|\bapprove\b|run this command|proceed\?|apply (?:this|these) (?:edit|change)s?|make this edit|create (?:this )?file/i;
/** Labels typical of approval menus (as opposed to a plan or checklist). */
const APPROVAL_OPTION_RE = /^(?:yes|no|allow|deny|approve|reject|always|never|don'?t ask|cancel|abort|skip|proceed|continue|run|accept)\b/i;
const CURSOR_OPTION_RE = /^[❯›>]\s+(?:(\d{1,2})[.)]\s+)?(.+)$/;
const NUMBERED_OPTION_RE = /^(?:[❯›>]\s*)?(?:\[(\d{1,2})\]|(\d{1,2})[.)])\s+(.+)$/;

/** Strips TUI box-drawing borders ("│ text │") so framed prompts parse like plain lines. */
function unframe(line: string): string {
  return line.replace(/^[\s│┃|╭╮╰╯─━]+/, '').replace(/[\s│┃|╭╮╰╯─━]+$/, '').trim();
}

function normalizeForEcho(line: string): string {
  return unframe(line).replace(/^(?:[-*•]\s+|\[[ x]\]\s+|\d+[.)]\s+)+/i, '').toLowerCase();
}

/**
 * AI-agnostic parser for interactive CLI prompts (e.g. Gemini agy, Claude Code, OpenAI Codex, Aider).
 * Detects multiple-choice approval menus, yes/no confirmations, and a trailing question, ONLY at the very
 * bottom of the output. Plain lists — the agent's plan, the echoed task checklist (`echoedText`), Gherkin
 * steps — are never treated as choices: a menu needs an approval question above it and either a cursor
 * marker, a key-hint footer, or approval-style labels.
 */
export function parseCliInteractivePrompt(rawText: string, opts: { echoedText?: string } = {}): CliDetectedPrompt | null {
  const echoed = new Set(
    (opts.echoedText || '')
      .split('\n')
      .map(normalizeForEcho)
      .filter((l) => l.length > 3)
  );
  const lines = stripAnsi(rawText)
    .split('\n')
    .map(unframe)
    .filter((l) => l.length > 0 && !echoed.has(normalizeForEcho(l)));
  if (lines.length === 0) return null;

  const tail = lines.slice(-14);
  const tailText = tail.join('\n');
  const lastLines = tail.slice(-6).join('\n');

  // Account / auth failures that stop the session
  const accountErr = lastLines.match(/credit balance is too low|insufficient funds|insufficient credit|authentication failed|invalid api key[^\n]*/i);
  if (accountErr) {
    return {
      type: 'freeform',
      title: 'AI Account Notice',
      question: `${accountErr[0].trim()} (Please check your API key in AI Credentials Settings or verify account balance).`,
      rawSnippet: tailText,
    };
  }

  // Walk up from the bottom past footer hints, then collect the contiguous option block.
  let i = tail.length - 1;
  let hasFooter = false;
  while (i >= 0 && MENU_FOOTER_RE.test(tail[i])) {
    hasFooter = true;
    i--;
  }
  // Candidate menu lines: numbered ("2. No"), cursor-marked ("❯ Yes"), or short plain items of an arrow menu ("  Deny").
  const candidates: { key: string; label: string; cursor: boolean; numbered: boolean; plain: boolean }[] = [];
  while (i >= 0 && candidates.length < 7) {
    const line = tail[i];
    const numbered = line.match(NUMBERED_OPTION_RE);
    const cursor = line.match(CURSOR_OPTION_RE);
    if (numbered) {
      candidates.unshift({ key: numbered[1] || numbered[2], label: numbered[3].trim(), cursor: /^[❯›>]/.test(line), numbered: true, plain: false });
    } else if (cursor) {
      candidates.unshift({ key: '', label: cursor[2].trim(), cursor: true, numbered: false, plain: false });
    } else if (/^[A-Za-z]/.test(line) && line.length <= 80 && !/[?:.]$/.test(line) && !APPROVAL_QUESTION_RE.test(line)) {
      candidates.unshift({ key: '', label: line, cursor: false, numbered: false, plain: true });
    } else {
      break;
    }
    i--;
  }
  // Numbered menus: the contiguous numbered block at the bottom (plain lines above it go back to the question
  // search). Arrow menus: un-numbered items with exactly one cursor line. Anything else is not a menu.
  let options: typeof candidates = [];
  const firstNumbered = candidates.findIndex((o) => o.numbered);
  if (firstNumbered !== -1) {
    const block = candidates.slice(firstNumbered);
    if (block.every((o) => o.numbered)) options = block;
  } else if (candidates.filter((o) => o.cursor).length === 1) {
    options = candidates;
  }
  i += candidates.length - options.length;
  // The question sits directly above the options (allow one detail line between, e.g. the command).
  let question = '';
  let questionIdx = -1;
  for (let q = i; q >= Math.max(0, i - 2); q--) {
    if (APPROVAL_QUESTION_RE.test(tail[q]) || tail[q].endsWith('?')) {
      question = tail[q];
      questionIdx = q;
      break;
    }
  }

  const extractTargetCommand = (): string | undefined => {
    const scanFrom = questionIdx !== -1 ? Math.max(0, questionIdx - 4) : Math.max(0, tail.length - 8);
    for (let k = scanFrom; k < tail.length; k++) {
      const line = tail[k];
      const tick = line.match(/`([^`]+)`/);
      if (tick && !MENU_FOOTER_RE.test(line)) return tick[1];
      if (/^(?:bash command|shell command|command|run command)$/i.test(line) && tail[k + 1] && !APPROVAL_QUESTION_RE.test(tail[k + 1])) {
        return tail[k + 1];
      }
      const labelled = line.match(/(?:bash command|command|executing|execute|run|permission for(?: \w+)?):\s*(.+)$/i);
      if (labelled && labelled[1].trim() && !/^(?:run this|choose|select)/i.test(labelled[1])) return labelled[1].trim();
    }
    return undefined;
  };

  const looksLikeApprovalMenu =
    options.length >= 2 &&
    options.length <= 6 &&
    options.every((o) => o.label.length <= 120) &&
    questionIdx !== -1 &&
    (options.some((o) => o.cursor) || hasFooter || options.some((o) => APPROVAL_OPTION_RE.test(o.label)));

  if (looksLikeApprovalMenu) {
    const cursorIdx = options.findIndex((o) => o.cursor);
    const defaultIdx = cursorIdx !== -1 ? cursorIdx : 0;
    return {
      type: 'multiple_choice',
      title: 'Action Requires Approval',
      targetCommand: extractTargetCommand(),
      question,
      options: options.map((o, idx) => ({
        key: o.numbered ? o.key : String(idx + 1),
        label: o.label,
        isDefault: idx === defaultIdx,
        isDestructive: /\b(?:cancel|no\b|reject|abort|deny|never)\b/i.test(o.label),
        numbered: o.numbered,
        index: idx,
      })),
      rawSnippet: tailText,
    };
  }

  // Yes / No confirmation on the last lines ("[Y/n]", "(y/n)", "(y)es / (n)o")
  const confirmLines = tail.slice(-3).join('\n');
  if (/\[[yY]\/[nN]\]|\([yY]\/[nN]\)|\(y\)es[/, ]+\(n\)o/i.test(confirmLines)) {
    const options: CliPromptOption[] = [
      { key: 'y', label: 'Approve / Yes', isDefault: true, isDestructive: false, numbered: true },
      { key: 'n', label: 'Reject / No', isDefault: false, isDestructive: true, numbered: true },
    ];
    if (/\(a\)lways/i.test(confirmLines)) {
      options.splice(1, 0, { key: 'a', label: 'Always Allow', isDefault: false, isDestructive: false, numbered: true });
    }
    return {
      type: 'confirmation',
      title: 'Confirmation Required',
      targetCommand: extractTargetCommand(),
      question: tail.slice(-3).find((l) => /\?|\[[yY]\/[nN]\]|\([yY]\/[nN]\)/.test(l)) || tail[tail.length - 1],
      options,
      rawSnippet: tailText,
    };
  }

  // The agent ended its turn with a question to the user (only the final line counts).
  let last = tail.length - 1;
  while (last >= 0 && MENU_FOOTER_RE.test(tail[last])) last--;
  const finalLine = last >= 0 ? tail[last] : '';
  if (finalLine.endsWith('?') && finalLine.length <= 240 && !/^(?:[-*•]|\d+[.)])\s/.test(finalLine)) {
    return {
      type: 'freeform',
      title: 'Clarification Needed',
      question: finalLine,
      rawSnippet: tailText,
    };
  }

  return null;
}

/**
 * Extracts chronological activity and thought entries from the cleaned CLI text.
 */
export function extractActivityEntries(cleanText: string): {
  feed: ActivityFeedItem[];
  currentActivity: string;
} {
  const lines = cleanText.split('\n').map((l) => l.trim()).filter(Boolean);
  const feed: ActivityFeedItem[] = [];
  let currentActivity = 'Manager AI is active';

  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Filter out menu choices and navigation keys from general activity feed
    if (/^[>*•-]?\s*(?:\[[0-9]+\]|[0-9]+[.)])\s+/.test(line)) continue;
    if (/↑\/↓|tab Amend|ctrl\+g|esc to cancel/i.test(line)) continue;
    if (/^Run this command\?/i.test(line)) continue;
    if (/^Choose an option/i.test(line)) continue;

    // Detect Tool calls & CLI operations
    if (
      /permission for:\s*(.*)/i.test(line) ||
      /bash command:\s*(.*)/i.test(line) ||
      /^running:\s*(.*)/i.test(line) ||
      /^(?:tool\s+call|executing|command|calling tool|tool):\s*(.*)/i.test(line) ||
      /^(?:●|○|\*|❯)\s*(?:Bash|Read|Edit|Write|Glob|Grep|View|Search)\b\s*(.*)/i.test(line)
    ) {
      const match = line.match(/(?:permission for:|bash command:|running:|tool\s+call:|executing:|command:|calling tool:|tool:|(?:●|○|\*|❯)\s*(?:Bash|Read|Edit|Write|Glob|Grep|View|Search)\b)\s*(.*)/i);
      const cmdStr = (match?.[1] || lines[i + 1] || '').trim();
      const text = cmdStr ? `Action: ${cmdStr}` : line;
      if (!seen.has(text)) {
        seen.add(text);
        feed.push({
          id: `item-${i}`,
          type: 'tool',
          text,
          detail: cmdStr || line,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        });
        currentActivity = text;
      }
      continue;
    }

    // Detect Thinking / Reasoning
    if (/^\|\s*(.*)/i.test(line) || /^thinking[:\s]*(.*)/i.test(line) || /claude is thinking|model is thinking/i.test(line) || /^(?:●|○)\s*thinking/i.test(line)) {
      const text = line.replace(/^[|●○]\s*/, '').replace(/^thinking[:\s]*/i, '').trim();
      if (text && text.length > 3 && !seen.has(text) && !text.includes('esc to dismiss')) {
        seen.add(text);
        feed.push({
          id: `item-${i}`,
          type: 'thought',
          text,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        });
        currentActivity = text;
      }
      continue;
    }

    // Detect File actions
    if (/(?:edit|read|inspect|write|created)\s+(?:file\s+)?([a-zA-Z0-9_\-\.\/]+)/i.test(line)) {
      const text = line;
      if (!seen.has(text)) {
        seen.add(text);
        feed.push({
          id: `item-${i}`,
          type: 'tool',
          text,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        });
        currentActivity = text;
      }
    }
  }

  // Fallback to latest non-empty line if needed
  if (lines.length > 0 && currentActivity === 'Manager AI is active') {
    const lastLine = lines[lines.length - 1];
    if (lastLine.length < 90 && !lastLine.startsWith('>')) {
      currentActivity = lastLine;
    }
  }

  return { feed: feed.slice(-15), currentActivity };
}

export const CliAgentNotesBridge: React.FC<CliAgentNotesBridgeProps> = ({
  cmd,
  args = [],
  cwd,
  taskId,
  sessionId,
  env,
  forceRestart,
  spawnId,
  isActive = true,
  onExit,
  onRestartSession,
  onKillSession,
  onSwitchToSteps,
}) => {
  const [detectedPrompt, setDetectedPrompt] = useState<CliDetectedPrompt | null>(null);
  const [currentActivity, setCurrentActivity] = useState<string>('Initializing AI agent...');
  const [activityFeed, setActivityFeed] = useState<ActivityFeedItem[]>([]);
  const [userMessages, setUserMessages] = useState<ActivityFeedItem[]>([]);
  const [steerInput, setSteerInput] = useState('');
  const [isCopiedCommand, setIsCopiedCommand] = useState(false);
  const [isSubmittingOption, setIsSubmittingOption] = useState<string | null>(null);
  const [isFeedCollapsed, setIsFeedCollapsed] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const rawBufferRef = useRef<string>('');
  const detectedPromptRef = useRef<CliDetectedPrompt | null>(null);
  const promptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const feedScrollRef = useRef<HTMLDivElement>(null);

  // Send data over WebSocket PTY bridge
  const sendInput = useCallback(
    (data: string) => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        try {
          wsRef.current.send(
            JSON.stringify({
              type: 'input',
              taskId,
              sessionId: sessionId || (taskId ? String(taskId) : undefined),
              data,
            })
          );
        } catch (err) {
          console.warn('[Ergo Notes Bridge] Send error:', err);
        }
      }
    },
    [taskId, sessionId]
  );

  // Connect WebSocket to /api/pty
  useEffect(() => {
    let isDisposed = false;
    const wsUrl = bridgeClient.getWsUrl('/api/pty');
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.addEventListener('open', () => {
      if (isDisposed) {
        try {
          ws.close();
        } catch {}
        return;
      }
      ws.send(
        JSON.stringify({
          type: 'spawn',
          taskId,
          sessionId: sessionId || (taskId ? String(taskId) : undefined),
          cmd,
          args,
          cwd,
          env,
          cols: 120,
          rows: 40,
          forceRestart,
          spawnId,
        })
      );
    });

    // Interactive prompts block the CLI, so real ones leave the output quiet. Only look for a new prompt
    // after a pause; streaming output (plans, checklists, the echoed task) never gets the chance to look like one.
    const PROMPT_IDLE_MS = 650;
    const echoedText = args.join('\n');
    const evaluatePrompt = () => {
      const prompt = parseCliInteractivePrompt(rawBufferRef.current.slice(-20000), { echoedText });
      detectedPromptRef.current = prompt;
      setDetectedPrompt(prompt);
      if (prompt) {
        setIsSubmittingOption(null);
        setCurrentActivity(prompt.title || 'Action Requires Approval');
      }
    };

    const processIncomingText = (chunk: string, isFullReplay: boolean = false) => {
      if (isFullReplay) {
        rawBufferRef.current = chunk;
      } else {
        rawBufferRef.current += chunk;
        if (rawBufferRef.current.length > 250000) {
          rawBufferRef.current = rawBufferRef.current.slice(-200000);
        }
      }

      // New output after a prompt was shown usually means it was answered — hide it until things settle again.
      if (detectedPromptRef.current && !isFullReplay) {
        detectedPromptRef.current = null;
        setDetectedPrompt(null);
      }
      if (promptTimerRef.current) clearTimeout(promptTimerRef.current);
      promptTimerRef.current = setTimeout(evaluatePrompt, isFullReplay ? 0 : PROMPT_IDLE_MS);

      // Extract activities and current thought
      const { feed, currentActivity: latestActivity } = extractActivityEntries(stripAnsi(rawBufferRef.current.slice(-60000)));
      setActivityFeed(feed);
      setCurrentActivity(latestActivity);
    };

    ws.addEventListener('message', (ev) => {
      if (isDisposed) return;
      let msg: any;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }

      if (msg.type === 'replay') {
        processIncomingText(msg.data, true);
      } else if (msg.type === 'data') {
        processIncomingText(msg.data, false);
      } else if (msg.type === 'exit') {
        onExit?.(msg.code);
        if (promptTimerRef.current) clearTimeout(promptTimerRef.current);
        detectedPromptRef.current = null;
        setCurrentActivity(`Process exited with code ${msg.code}`);
        setDetectedPrompt(null);
      }
    });

    return () => {
      isDisposed = true;
      if (promptTimerRef.current) clearTimeout(promptTimerRef.current);
      try {
        ws.close();
      } catch {}
    };
  }, [cmd, cwd, taskId, sessionId, env, onExit]);

  // Auto-scroll feed to bottom when entries update
  useEffect(() => {
    if (feedScrollRef.current) {
      feedScrollRef.current.scrollTop = feedScrollRef.current.scrollHeight;
    }
  }, [activityFeed, userMessages, detectedPrompt]);

  // Handle Option Click
  const handleSelectOption = (option: CliPromptOption) => {
    setIsSubmittingOption(option.key);
    const defaultIdx = detectedPrompt?.options?.findIndex((o) => o.isDefault) ?? 0;
    if (detectedPrompt?.type === 'confirmation') {
      // [y/N]-style prompts: type the letter — Enter would pick whichever default the CLI chose.
      sendInput(`${option.key}\r`);
    } else if (option.isDefault) {
      // Enter accepts the highlighted item in Ink-style menus (Claude Code, Antigravity).
      sendInput('\r');
    } else if (option.numbered === false && typeof option.index === 'number') {
      // Un-numbered arrow menu: move from the highlighted item to the chosen one, then confirm.
      const delta = option.index - Math.max(0, defaultIdx);
      sendInput((delta > 0 ? '\x1b[B' : '\x1b[A').repeat(Math.abs(delta)) + '\r');
    } else {
      sendInput(`${option.key}\r`);
    }

    // Log user response into feed
    const userEntry: ActivityFeedItem = {
      id: `user-opt-${Date.now()}`,
      type: 'user',
      text: `Selected: [${option.key}] ${option.label}`,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    };
    setUserMessages((prev) => [...prev, userEntry]);

    // Safety timeout in case CLI takes a moment to process and emit next output
    setTimeout(() => {
      setIsSubmittingOption((current) => (current === option.key ? null : current));
    }, 2500);
  };

  // Handle Mid-Task Steering Input Submission
  const handleSteerSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!steerInput.trim()) return;

    const message = steerInput.trim();
    // Send message + carriage return to PTY stdin
    sendInput(`${message}\r`);

    const userEntry: ActivityFeedItem = {
      id: `user-msg-${Date.now()}`,
      type: 'user',
      text: message,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    };
    setUserMessages((prev) => [...prev, userEntry]);
    setSteerInput('');
  };

  // Copy command helper
  const handleCopyCommand = (text: string) => {
    if (!text) return;
    navigator.clipboard.writeText(text);
    setIsCopiedCommand(true);
    setTimeout(() => setIsCopiedCommand(false), 2000);
  };

  // Combine feed entries chronologically
  const allEntries = [...activityFeed, ...userMessages].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp)
  );

  return (
    <div className="cli-notes-bridge">
      {/* ── Top Bar: AI Agent Status & Power-User Switch ── */}
      <div className="cli-notes-bridge-header">
        <div className="bridge-header-left">
          <div className="bridge-ai-avatar">
            <Brain size={14} className="avatar-icon" />
          </div>
          <div className="bridge-title-group">
            <div className="bridge-main-title">
              <span>Manager AI</span>
              <span className="bridge-cmd-tag">{cmd}</span>
            </div>
            <div className="bridge-status-line">
              {detectedPrompt ? (
                <span className="status-badge is-waiting">
                  <span className="pulse-dot-amber" />
                  <span>Action Required</span>
                </span>
              ) : isActive ? (
                <span className="status-badge is-running">
                  <span className="pulse-dot-emerald" />
                  <span>Working</span>
                </span>
              ) : (
                <span className="status-badge is-idle">
                  <span className="dot-gray" />
                  <span>Idle</span>
                </span>
              )}
              <span className="bridge-current-thought" title={currentActivity}>
                {currentActivity}
              </span>
            </div>
          </div>
        </div>

        <div className="bridge-header-right">
          {onSwitchToSteps && (
            <button
              type="button"
              className="bridge-terminal-switch-btn"
              onClick={onSwitchToSteps}
              title="Open the Steps tab to interact directly with the raw embedded terminal"
            >
              <Terminal size={11} />
              <span>Raw Terminal</span>
              <ExternalLink size={10} style={{ opacity: 0.6 }} />
            </button>
          )}

          {onRestartSession && (
            <button
              type="button"
              className="bridge-ctrl-btn"
              onClick={onRestartSession}
              title="Restart AI agent process"
            >
              <RotateCcw size={11} />
            </button>
          )}

          {isActive && onKillSession && (
            <button
              type="button"
              className="bridge-ctrl-btn is-danger"
              onClick={onKillSession}
              title="Stop AI agent"
            >
              <Square size={11} />
            </button>
          )}
        </div>
      </div>

      {/* ── Interactive Approval / Permission GUI Card ── */}
      {detectedPrompt && (
        <div className="cli-notes-prompt-card">
          <div className="prompt-card-header">
            <div className="prompt-header-title">
              <ShieldAlert size={15} color="var(--accent-amber)" />
              <span>{detectedPrompt.title || 'Permission Request'}</span>
            </div>
            <span className="prompt-interactive-pill">Requires Input</span>
          </div>

          {detectedPrompt.targetCommand && (
            <div className="prompt-command-container">
              <div className="prompt-command-header">
                <span className="command-label">Command to execute:</span>
                <button
                  type="button"
                  className="command-copy-btn"
                  onClick={() => handleCopyCommand(detectedPrompt.targetCommand!)}
                  title="Copy command to clipboard"
                >
                  {isCopiedCommand ? <Check size={11} color="var(--accent-emerald)" /> : <Copy size={11} />}
                  <span>{isCopiedCommand ? 'Copied' : 'Copy'}</span>
                </button>
              </div>
              <div className="prompt-command-snippet">
                <code>$ {detectedPrompt.targetCommand}</code>
              </div>
            </div>
          )}

          <p className="prompt-question-text">{detectedPrompt.question}</p>

          {/* Multiple-Choice or Confirmation Options */}
          {detectedPrompt.options && detectedPrompt.options.length > 0 ? (
            <div className="prompt-options-grid">
              {detectedPrompt.options.map((opt) => {
                const isSubmitting = isSubmittingOption === opt.key;
                return (
                  <button
                    key={opt.key}
                    type="button"
                    className={`prompt-option-btn ${opt.isDefault ? 'is-default' : ''} ${
                      opt.isDestructive ? 'is-destructive' : ''
                    } ${isSubmitting ? 'is-submitting' : ''}`}
                    onClick={() => handleSelectOption(opt)}
                    disabled={isSubmittingOption !== null}
                  >
                    <span className="opt-key-badge">{opt.key}</span>
                    <span className="opt-label-text">{opt.label}</span>
                    {isSubmitting && <Loader2 size={13} className="spin-animate" />}
                  </button>
                );
              })}
            </div>
          ) : detectedPrompt.type === 'freeform' && !/credit balance|insufficient/i.test(detectedPrompt.question) ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const inputEl = (e.currentTarget.elements.namedItem('promptAnswer') as HTMLInputElement);
                const answer = inputEl?.value?.trim();
                if (answer) {
                  sendInput(`${answer}\r`);
                  setUserMessages((prev) => [
                    ...prev,
                    {
                      id: `user-reply-${Date.now()}`,
                      type: 'user',
                      text: `Replied: ${answer}`,
                      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
                    },
                  ]);
                  inputEl.value = '';
                }
              }}
              style={{ display: 'flex', gap: '0.45rem', marginTop: '0.4rem' }}
            >
              <input
                type="text"
                name="promptAnswer"
                placeholder="Type your reply to the AI prompt..."
                className="steer-input-field"
                style={{ flex: 1 }}
                autoFocus
              />
              <button type="submit" className="btn btn-primary" style={{ padding: '0.35rem 0.85rem', fontSize: '0.78rem' }}>
                <Send size={12} />
                <span>Submit</span>
              </button>
            </form>
          ) : null}
        </div>
      )}

      {/* ── AI Thinking & Activity Stream ── */}
      <div className={`cli-notes-feed-container ${isFeedCollapsed ? 'is-collapsed' : ''}`}>
        <div
          className="feed-container-header"
          onClick={() => setIsFeedCollapsed((v) => !v)}
          title={isFeedCollapsed ? 'Expand AI Activity Stream' : 'Collapse AI Activity Stream'}
        >
          <div className="feed-header-left">
            <Sparkles size={12} color="var(--accent-cyan)" />
            <span>AI Activity Stream</span>
            {allEntries.length > 0 && <span className="feed-count-badge">{allEntries.length}</span>}
          </div>
          <button type="button" className="feed-toggle-btn" aria-label="Toggle feed">
            {isFeedCollapsed ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
          </button>
        </div>

        {!isFeedCollapsed && (
          <div className="feed-scroll-body" ref={feedScrollRef}>
            {allEntries.length === 0 ? (
              <div className="feed-empty-hint">
                <span>Watching AI progress... actions and thoughts will stream here in real time.</span>
              </div>
            ) : (
              allEntries.map((item) => (
                <div key={item.id} className={`feed-item is-${item.type}`}>
                  <div className="feed-item-icon">
                    {item.type === 'tool' && <Command size={11} color="var(--accent-cyan)" />}
                    {item.type === 'thought' && <Brain size={11} color="var(--accent-violet)" />}
                    {item.type === 'user' && <MessageSquare size={11} color="var(--accent-emerald)" />}
                    {item.type === 'status' && <Sparkles size={11} color="var(--text-muted)" />}
                  </div>
                  <div className="feed-item-content">
                    <span className="feed-item-text">{item.text}</span>
                    {item.detail && <code className="feed-item-detail">{item.detail}</code>}
                  </div>
                  <span className="feed-item-time">{item.timestamp}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* ── Mid-Task Steering Prompt Box ── */}
      <form onSubmit={handleSteerSubmit} className="cli-notes-steer-form">
        <div className="steer-input-wrapper">
          <input
            type="text"
            className="steer-input-field"
            placeholder="Steer the AI mid-task (e.g. 'focus on tests', 'skip this step', 'use TypeScript')..."
            value={steerInput}
            onChange={(e) => setSteerInput(e.target.value)}
          />
          <button
            type="submit"
            className="steer-send-btn"
            disabled={!steerInput.trim()}
            title="Send instruction to the AI agent"
          >
            <Send size={12} />
            <span>Send</span>
          </button>
        </div>
      </form>
    </div>
  );
};
