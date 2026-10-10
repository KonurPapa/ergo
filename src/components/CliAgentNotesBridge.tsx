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

/**
 * AI-agnostic parser for interactive CLI prompts (e.g. Gemini agy, Claude Code, OpenAI Codex, Aider).
 * Detects multiple-choice menus, yes/no approvals, and freeform queries waiting at the tail.
 */
export function parseCliInteractivePrompt(rawText: string): CliDetectedPrompt | null {
  const clean = stripAnsi(rawText);
  const allLines = clean
    .split('\n')
    .map((l) => l.trimEnd())
    .filter(Boolean);
  if (allLines.length === 0) return null;

  // Inspect the last 30 non-empty lines for active prompts waiting for user input
  const tail = allLines.slice(-30);
  const tailText = tail.join('\n');

  // Check 0: Claude Code / CLI Error messages that terminated or blocked the session
  // If credit balance or funds issue is detected in the tail, surface it cleanly as a prompt notice
  if (/credit balance is too low|insufficient funds|insufficient credit|authentication failed|invalid api key/i.test(tailText)) {
    const errorMatch = tailText.match(/(?:credit balance is too low|insufficient funds|insufficient credit|authentication failed|invalid api key[^\n]*)/i);
    const errorMsg = errorMatch ? errorMatch[0].trim() : 'Insufficient credit balance or authentication issue.';
    return {
      type: 'freeform',
      title: 'AI Account Notice',
      question: `${errorMsg} (Please check your API key in AI Credentials Settings or verify account balance).`,
      rawSnippet: tailText,
    };
  }

  // 1. Locate the interactive prompt question (searching backwards from tail)
  let questionIdx = -1;
  let question = '';
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i].trim();
    if (
      (line.endsWith('?') ||
        /run this command|do you want to|would you like to|choose an option|select an option|allow (?:this|execution|claude|\w+)|proceed|claude needs (?:your\s+)?permission|permission (?:needed|required|for|to)|approve/i.test(line)) &&
      !/^\s*(?:[>❯›*•-]\s*)?(?:\[[0-9]+\]|[0-9]+[.)-])\s+/.test(line)
    ) {
      questionIdx = i;
      question = line;
      break;
    }
  }

  // 2. Extract options ONLY from lines after questionIdx (or if no explicit question, the last contiguous group of choices)
  // Supports numbers like: "1. ", "1)", "[1]", and Claude symbols like "❯ 1. ", "❯ Yes", "  2. No"
  const choiceLineRegex = /^\s*(?:[>❯›*•-]\s*)?(?:\[([0-9a-zA-Z]+)\]|([0-9a-zA-Z]+)[.)-])\s+([^\n\r]+)/;
  const arrowChoiceRegex = /^\s*([>❯›*•-])\s+([^\n\r]+)/;
  let optionLines: { key: string; label: string; isDefault?: boolean; raw: string }[] = [];

  if (questionIdx !== -1) {
    // Collect choice lines following the question line
    for (let i = questionIdx + 1; i < tail.length; i++) {
      const line = tail[i];
      const match = line.match(choiceLineRegex);
      if (match) {
        const key = match[1] || match[2];
        const label = match[3].trim();
        optionLines.push({ key, label, isDefault: /^\s*[>❯›*]/.test(line) || key === '1', raw: line });
      } else {
        const arrowMatch = line.match(arrowChoiceRegex);
        if (arrowMatch && !/↑\/↓|tab Amend|ctrl\+|esc to/i.test(line)) {
          const key = String(optionLines.length + 1);
          optionLines.push({ key, label: arrowMatch[2].trim(), isDefault: true, raw: line });
        } else if (optionLines.length > 0 && line.trim().length > 0) {
          if (/↑\/↓|tab Amend|ctrl\+|esc to/i.test(line)) {
            break;
          }
        }
      }
    }
  } else {
    // Fallback: look from bottom up for the last contiguous block of choices
    let bottomIdx = tail.length - 1;
    while (
      bottomIdx >= 0 &&
      (/↑\/↓|tab Amend|ctrl\+|esc to/i.test(tail[bottomIdx]) || (!choiceLineRegex.test(tail[bottomIdx]) && !arrowChoiceRegex.test(tail[bottomIdx])))
    ) {
      bottomIdx--;
    }
    const tempChoices: { key: string; label: string; isDefault?: boolean; raw: string }[] = [];
    while (bottomIdx >= 0) {
      const line = tail[bottomIdx];
      const match = line.match(choiceLineRegex);
      if (match) {
        const key = match[1] || match[2];
        tempChoices.unshift({ key, label: match[3].trim(), isDefault: /^\s*[>❯›*]/.test(line), raw: line });
        bottomIdx--;
      } else {
        const arrowMatch = line.match(arrowChoiceRegex);
        if (arrowMatch && !/↑\/↓|tab Amend|ctrl\+|esc to/i.test(line)) {
          tempChoices.unshift({ key: String(tempChoices.length + 1), label: arrowMatch[2].trim(), isDefault: true, raw: line });
          bottomIdx--;
        } else {
          break;
        }
      }
    }
    optionLines = tempChoices;
  }

  // Helper to extract target command
  const extractTargetCommand = () => {
    let targetCommand = '';
    for (let i = 0; i < tail.length; i++) {
      const line = tail[i].trim();
      const codeBacktick = line.match(/`([^`]+)`/);
      if (codeBacktick && !line.includes('ctrl+') && !line.includes('esc to')) {
        targetCommand = codeBacktick[1];
        break;
      }

      if (/permission (?:for|to\s+\w+):|command:|action:|executing:|execute:/i.test(line)) {
        const afterColon = line
          .replace(/.*(?:permission (?:for|to\s+\w+):|command:|action:|executing:|execute:)\s*/i, '')
          .trim();
        if (afterColon && !/^(?:run this|choose|select)/i.test(afterColon)) {
          targetCommand = afterColon;
          break;
        } else if (tail[i + 1] && !choiceLineRegex.test(tail[i + 1])) {
          targetCommand = tail[i + 1].trim();
          break;
        }
      }
    }
    return targetCommand;
  };

  const targetCommand = extractTargetCommand();

  // Check 1: Multiple choice options (2 or more choices)
  if (optionLines.length >= 2) {
    const hasExplicitActiveMarker = optionLines.some((o) => /^\s*[>❯›*]/.test(o.raw));
    const options: CliPromptOption[] = optionLines.map(({ key, label, raw }) => {
      const isDefault = hasExplicitActiveMarker ? /^\s*[>❯›*]/.test(raw) : key === '1' || key.toLowerCase() === 'y';
      return {
        key,
        label,
        isDefault,
        isDestructive: /\b(?:cancel|no\b|reject|abort|deny|never)\b/i.test(label),
      };
    });

    return {
      type: 'multiple_choice',
      title: 'Action Requires Approval',
      targetCommand: targetCommand || undefined,
      question: question || 'Run this command?',
      options,
      rawSnippet: tailText,
    };
  }

  // Check 2: Yes / No confirmation (e.g. "[Y/n]", "(y/n)", "(y)es / (n)o", "Y/N", "❯ Yes")
  const ynMatch = tailText.match(
    /(?:\[([yYnN]\/[yYnN])\]|\(([yYnN]\/[yYnN])\)|\b\(y\)es[\/, ]+\(n\)o\b|\b(?:y\/n|Y\/n|y\/N)\b)/i
  );
  if (ynMatch) {
    const options: CliPromptOption[] = [
      { key: 'y', label: 'Approve / Yes', isDefault: true, isDestructive: false },
      { key: 'n', label: 'Reject / No', isDefault: false, isDestructive: true },
    ];
    if (/\(a\)lways|\balways\b/i.test(tailText)) {
      options.splice(1, 0, { key: 'a', label: 'Always Allow', isDefault: false, isDestructive: false });
    }

    return {
      type: 'confirmation',
      title: 'Confirmation Required',
      targetCommand: targetCommand || undefined,
      question: question || tail[tail.length - 1],
      options,
      rawSnippet: tailText,
    };
  }

  // Check 3: Freeform prompt question waiting for user input
  if (questionIdx !== -1 && question) {
    return {
      type: 'freeform',
      title: 'Clarification Needed',
      targetCommand: targetCommand || undefined,
      question,
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
        })
      );
    });

    const processIncomingText = (chunk: string, isFullReplay: boolean = false) => {
      if (isFullReplay) {
        rawBufferRef.current = chunk;
      } else {
        rawBufferRef.current += chunk;
        if (rawBufferRef.current.length > 250000) {
          rawBufferRef.current = rawBufferRef.current.slice(-200000);
        }
      }

      const stripped = stripAnsi(rawBufferRef.current);

      // Parse interactive prompts (e.g. multiple-choice approval or yes/no)
      const prompt = parseCliInteractivePrompt(rawBufferRef.current);
      setDetectedPrompt(prompt);
      if (prompt) {
        setIsSubmittingOption(null);
      }

      // Extract activities and current thought
      const { feed, currentActivity: latestActivity } = extractActivityEntries(stripped);
      setActivityFeed(feed);
      setCurrentActivity(prompt ? prompt.title || 'Action Requires Approval' : latestActivity);
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
        setCurrentActivity(`Process exited with code ${msg.code}`);
        setDetectedPrompt(null);
      }
    });

    return () => {
      isDisposed = true;
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
    // In Ink TUI menus (like Claude Code), pressing Enter on the active (default) item accepts it.
    // Otherwise send the option key with carriage return.
    if (option.isDefault && (option.key === '1' || option.key.toLowerCase() === 'y')) {
      sendInput('\r');
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
