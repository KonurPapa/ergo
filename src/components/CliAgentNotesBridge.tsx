import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Sparkles,
  ShieldAlert,
  ShieldCheck,
  Send,
  Copy,
  Check,
  ChevronDown,
  ChevronUp,
  Brain,
  MessageSquare,
  Command,
  Loader2,
  HelpCircle,
  AlertTriangle,
} from 'lucide-react';
import { bridgeClient } from '../lib/bridgeClient';
import { sendAgentInput } from '../lib/cliRunClient';
import { TerminalScreen, ScreenTranscript } from '../lib/cliScreen';
import { keystrokesForOption, promptSummary, isBypassAcceptanceDialog } from '../lib/cliPromptParser';
import type {
  AgentSessionRole,
  CliDetectedPrompt,
  CliPromptOption,
  PermissionLevel,
} from '../types';
import { AgentRoleBadge } from './AgentSessionTabs';
import { describeTaskMessage, type TaskMessageOptions, type TaskMessageResult } from '../lib/taskMessages';
import { extractActivityEntries, nowTime, type ActivityFeedItem } from '../lib/cliActivityFeed';

export interface CliAgentNotesBridgeProps {
  /** Bridge PTY key of the agent (SpawnedSession.ptySessionId). The view only attaches; App owns the process. */
  sessionId: string;
  role: AgentSessionRole;
  /** Human label, e.g. "Manager", "Worker W2 · Login form", "Verifier". */
  label: string;
  /** The prompt the agent was launched with (filtered out of the activity feed when the CLI echoes it). */
  launchPrompt?: string;
  pieceId?: string;
  permissionLevel?: PermissionLevel;
  /** The prompt App already knows about (SpawnedSession.pendingPrompt), shown until the bridge reports otherwise. */
  initialPrompt?: CliDetectedPrompt | null;
  /**
   * The task prompt box (App routes it: mid-run to this agent — held while a permission prompt is open — and after the
   * run finished as a follow-up that continues it). Without it, the box types straight into this terminal.
   */
  onSendMessage?: (text: string, opts: TaskMessageOptions) => Promise<TaskMessageResult>;
  /** The task's run is working (false: it finished, and a message continues it). */
  runActive?: boolean;
  /** What the agent is doing right now (AgentLiveStatus), above the prompt box. */
  liveStatus?: React.ReactNode;
}

/** Screen size the Notes view renders the agent's output at until the bridge reports the PTY's real size. */
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
/** How often rendered rows are folded into the transcript / activity feed while output streams. */
const OBSERVE_THROTTLE_MS = 250;
/** Replays are fed through the screen in slices so repaints of alt-screen TUIs still reach the transcript. */
const REPLAY_SLICE = 4096;



function feedSignature(feed: ActivityFeedItem[]): string {
  return feed.map((f) => f.id).join('\u0000');
}

export const CliAgentNotesBridge: React.FC<CliAgentNotesBridgeProps> = ({
  sessionId,
  role,
  label,
  launchPrompt,
  pieceId,
  permissionLevel,
  initialPrompt = null,
  onSendMessage,
  runActive = true,
  liveStatus,
}) => {
  const [detectedPrompt, setDetectedPrompt] = useState<CliDetectedPrompt | null>(initialPrompt);
  const [activityFeed, setActivityFeed] = useState<ActivityFeedItem[]>([]);
  const [localEntries, setLocalEntries] = useState<ActivityFeedItem[]>([]);
  const [steerInput, setSteerInput] = useState('');
  const [promptAnswer, setPromptAnswer] = useState('');
  const [isCopiedCommand, setIsCopiedCommand] = useState(false);
  const [submitting, setSubmitting] = useState<{ signature: string; key: string } | null>(null);
  const [isFeedCollapsed, setIsFeedCollapsed] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const feedScrollRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef(label);
  const launchPromptRef = useRef(launchPrompt);
  launchPromptRef.current = launchPrompt;
  labelRef.current = label;
  // Stable first-seen time + order for every feed entry (the extractor re-derives the feed on each repaint).
  const firstSeenRef = useRef<Map<string, { time: string; seq: number }>>(new Map());
  const seqRef = useRef(0);

  const nextSeq = () => ++seqRef.current;

  const addLocalEntry = useCallback((type: ActivityFeedItem['type'], text: string, detail?: string): string => {
    const seq = ++seqRef.current;
    const id = `local-${seq}`;
    const time = nowTime();
    firstSeenRef.current.set(id, { time, seq });
    setLocalEntries((prev) => [...prev.slice(-40), { id, type, text, detail, timestamp: time }]);
    return id;
  }, []);

  const patchLocalEntry = useCallback((id: string, detail: string) => {
    setLocalEntries((prev) => prev.map((e) => (e.id === id ? { ...e, detail } : e)));
  }, []);

  const sendInput = useCallback(
    async (data: string): Promise<boolean> => {
      const ok = await sendAgentInput(sessionId, data);
      if (!ok) addLocalEntry('status', `Could not reach ${labelRef.current}'s terminal — is the agent still running?`);
      return ok;
    },
    [sessionId, addLocalEntry]
  );

  /** Types a message and submits it a moment later (TUIs treat text + Enter in one write as a paste). */
  const sendMessage = useCallback(
    async (message: string): Promise<boolean> => {
      const ok = await sendInput(message);
      if (!ok) return false;
      await new Promise((resolve) => setTimeout(resolve, 150));
      return sendInput('\r');
    },
    [sendInput]
  );

  // App learns about prompts from the bridge's event stream; mirror it in case it arrives before this view's socket.
  const initialSignature = initialPrompt?.signature ?? null;
  useEffect(() => {
    setDetectedPrompt(initialPrompt ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSignature]);

  // A new (or cleared) prompt ends any pending answer.
  useEffect(() => {
    setSubmitting(null);
    setPromptAnswer('');
  }, [detectedPrompt?.signature]);

  // Attach (observe only — never resizes the agent's PTY) and render its output on a client-side screen.
  useEffect(() => {
    let isDisposed = false;
    let screen = new TerminalScreen(DEFAULT_COLS, DEFAULT_ROWS);
    let transcript = new ScreenTranscript();
    let observeTimer: ReturnType<typeof setTimeout> | null = null;
    let lastFeedSig = '';

    const observeScreen = () => {
      transcript.observe(screen.isAltScreen() ? screen.visibleRows() : screen.tailRows(screen.rows * 2));
    };

    const publishFeed = () => {
      const { feed } = extractActivityEntries(
        transcript.tail(400),
        labelRef.current,
        screen.visibleRows(),
        launchPromptRef.current
      );
      if (firstSeenRef.current.size > 3000) {
        // Keep the map bounded on very long sessions: only entries that can still be shown need their first-seen time.
        const keep = new Set(feed.map((f) => f.id));
        for (const id of firstSeenRef.current.keys()) {
          if (!keep.has(id) && !id.startsWith('local-')) firstSeenRef.current.delete(id);
        }
      }
      const stamped = feed.map((item) => {
        let seen = firstSeenRef.current.get(item.id);
        if (!seen) {
          seen = { time: item.timestamp, seq: nextSeq() };
          firstSeenRef.current.set(item.id, seen);
        }
        return { ...item, timestamp: seen.time };
      });
      const sig = feedSignature(stamped);
      if (sig !== lastFeedSig) {
        lastFeedSig = sig;
        setActivityFeed(stamped);
      }
    };

    const scheduleObserve = () => {
      if (observeTimer) return;
      observeTimer = setTimeout(() => {
        observeTimer = null;
        if (isDisposed) return;
        observeScreen();
        publishFeed();
      }, OBSERVE_THROTTLE_MS);
    };

    const applySize = (msg: any) => {
      const cols = Number(msg?.cols);
      const rows = Number(msg?.rows);
      if (Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0 && (cols !== screen.cols || rows !== screen.rows)) {
        screen.resize(cols, rows);
      }
    };

    const wsUrl = bridgeClient.getWsUrl('/api/pty');
    const ws = new WebSocket(wsUrl);

    ws.addEventListener('open', () => {
      if (isDisposed) {
        try {
          ws.close();
        } catch {}
        return;
      }
      try {
        ws.send(JSON.stringify({ type: 'attach', sessionId, cols: DEFAULT_COLS, rows: DEFAULT_ROWS, observe: true }));
      } catch (err) {
        console.warn('[Ergo Notes Bridge] Attach send error:', err);
      }
    });

    ws.addEventListener('message', (ev) => {
      if (isDisposed) return;
      let msg: any;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }

      if (msg.type === 'ready') {
        setConnectionError(null);
        applySize(msg);
        // A 'ready' for a live process (first attach, reattach, or a relaunch under a reused key) supersedes any
        // exit/prompt we showed for an earlier process on this key — e.g. one replayed from endedPtySessions
        // because this view attached before the relaunch's spawn landed. The bridge follows with the live
        // session's own prompt/exit, if any. An ended replay ('ended') is followed by its 'exit' instead.
        if (!msg.ended) {
          setDetectedPrompt(null);
        }
      } else if (msg.type === 'resized') {
        // The Steps terminal refit the agent's PTY; keep our copy of the screen the same size.
        applySize(msg);
      } else if (msg.type === 'replay') {
        // The whole output so far: rebuild screen + transcript from scratch, observing as we go so history that
        // an alt-screen TUI repainted away still lands in the transcript.
        const cols = screen.cols;
        const rows = screen.rows;
        screen = new TerminalScreen(cols, rows);
        transcript = new ScreenTranscript();
        applySize(msg);
        const data: string = typeof msg.data === 'string' ? msg.data : '';
        let pos = 0;
        while (pos < data.length) {
          let end = Math.min(data.length, pos + REPLAY_SLICE);
          // Never split a surrogate pair.
          const code = data.charCodeAt(end - 1);
          if (end < data.length && code >= 0xd800 && code <= 0xdbff) end += 1;
          screen.write(data.slice(pos, end));
          observeScreen();
          pos = end;
        }
        observeScreen();
        publishFeed();
      } else if (msg.type === 'data') {
        if (typeof msg.data === 'string') {
          screen.write(msg.data);
          scheduleObserve();
        }
      } else if (msg.type === 'prompt') {
        setDetectedPrompt(msg.prompt ?? null);
      } else if (msg.type === 'auto-approved') {
        const summary = typeof msg.summary === 'string' && msg.summary.trim() ? msg.summary.trim() : 'approval prompt';
        addLocalEntry('approval', `Auto-approved: ${summary}`);
      } else if (msg.type === 'exit') {
        setDetectedPrompt(null);
        observeScreen();
        publishFeed();
      } else if (msg.type === 'error') {
        const message = typeof msg.message === 'string' ? msg.message : 'Terminal bridge error';
        setConnectionError(message);
      }
    });

    ws.addEventListener('error', () => {
      if (isDisposed) return;
      setConnectionError('Could not connect to the terminal bridge. Is the dev server running?');
    });

    return () => {
      isDisposed = true;
      if (observeTimer) clearTimeout(observeTimer);
      try {
        ws.close();
      } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Combine extracted activity with local entries (your replies, auto-approvals) in first-seen order.
  const allEntries = React.useMemo(() => {
    const order = (item: ActivityFeedItem) => firstSeenRef.current.get(item.id)?.seq ?? 0;
    return [...activityFeed, ...localEntries].sort((a, b) => order(a) - order(b));
  }, [activityFeed, localEntries]);

  // Auto-scroll feed to bottom when entries update
  useEffect(() => {
    if (feedScrollRef.current) {
      feedScrollRef.current.scrollTop = feedScrollRef.current.scrollHeight;
    }
  }, [allEntries, detectedPrompt]);

  const handleSelectOption = async (option: CliPromptOption) => {
    const prompt = detectedPrompt;
    if (!prompt) return;
    setSubmitting({ signature: prompt.signature, key: option.key });
    const sent = await sendInput(keystrokesForOption(prompt, option));
    if (sent) addLocalEntry('user', `Selected: [${option.key}] ${option.label}`, promptSummary(prompt));
    // The bridge clears the prompt once the CLI moves on; re-enable the buttons if it does not.
    setTimeout(() => {
      setSubmitting((current) => (current && current.signature === prompt.signature && current.key === option.key ? null : current));
    }, sent ? 4000 : 0);
  };

  const handlePromptAnswer = async (e: React.FormEvent) => {
    e.preventDefault();
    const answer = promptAnswer.trim();
    if (!answer || !detectedPrompt) return;
    setSubmitting({ signature: detectedPrompt.signature, key: '__answer__' });
    const sent = await sendMessage(answer);
    if (sent) {
      addLocalEntry('user', `Replied: ${answer}`);
      setPromptAnswer('');
    } else {
      setSubmitting(null);
    }
  };

  const handleSteerSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const message = steerInput.trim();
    if (!message) return;
    setSteerInput('');
    if (!onSendMessage) {
      const sent = await sendMessage(message);
      if (sent) addLocalEntry('user', message);
      else setSteerInput(message);
      return;
    }
    // Shown as the user's message right away; its status follows the delivery.
    const entryId = addLocalEntry('user', message, runActive ? 'Sending…' : 'Continuing the task…');
    const res = await onSendMessage(message, {
      onDelivered: () => patchLocalEntry(entryId, 'Delivered'),
      onDropped: () => patchLocalEntry(entryId, 'Not delivered — the agent ended first'),
    });
    patchLocalEntry(entryId, describeTaskMessage(res));
    if (!res.ok) setSteerInput((cur) => cur || message);
  };

  const handleCopyCommand = (text: string) => {
    if (!text) return;
    navigator.clipboard?.writeText(text).catch(() => {});
    setIsCopiedCommand(true);
    setTimeout(() => setIsCopiedCommand(false), 2000);
  };

  const isBypassDialog = detectedPrompt ? isBypassAcceptanceDialog(detectedPrompt) : false;
  // The bridge auto-answers Full-access approvals before they reach any view, so an approval prompt that is still
  // shown under Full access is one it deliberately handed back (no safe "allow once" option, repeated attempts did
  // not clear it, or the live session is not yet on Full access) — the user has to answer it.
  const autoApproveSkipped =
    Boolean(detectedPrompt) && detectedPrompt!.kind === 'approval' && permissionLevel === 'bypass' && !isBypassDialog;

  const promptTitle = detectedPrompt
    ? detectedPrompt.toolLabel ||
      (detectedPrompt.kind === 'approval'
        ? 'Action Requires Approval'
        : detectedPrompt.kind === 'notice'
        ? detectedPrompt.title || 'Notice'
        : 'Agent is asking')
    : '';
  const hasOptions = Boolean(detectedPrompt?.options && detectedPrompt.options.length > 0);

  return (
    <div className={`cli-notes-bridge role-${role}`}>
      {connectionError && (
        <div className="bridge-connection-error">
          <AlertTriangle size={12} />
          <span>{connectionError}</span>
        </div>
      )}

      {/* ── Interactive Approval / Question Card (detected by the bridge on the agent's rendered screen) ── */}
      {detectedPrompt && (
        <div className={`cli-notes-prompt-card kind-${detectedPrompt.kind}`}>
          <div className="prompt-card-header">
            <div className="prompt-header-title">
              {detectedPrompt.kind === 'question' ? (
                <HelpCircle size={15} color="var(--accent-amber)" />
              ) : (
                <ShieldAlert size={15} color="var(--accent-amber)" />
              )}
              <span>{promptTitle}</span>
            </div>
            <span className="prompt-interactive-pill">
              <AgentRoleBadge role={role} pieceId={pieceId} label={label} />
            </span>
          </div>

          {autoApproveSkipped && (
            <div className="prompt-auto-note is-warning">
              <AlertTriangle size={12} />
              <span>Full access is on, but Ergo didn't approve this one automatically — please answer it.</span>
            </div>
          )}
          {isBypassDialog && (
            <div className="prompt-auto-note is-warning">
              <AlertTriangle size={12} />
              <span>The CLI asks once to confirm Full access (bypass permissions) mode. Ergo never answers this for you.</span>
            </div>
          )}

          {detectedPrompt.targetCommand && (
            <div className="prompt-command-container">
              <div className="prompt-command-header">
                <span className="command-label">Command to execute</span>
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
              <pre className="prompt-command-pre">$ {detectedPrompt.targetCommand}</pre>
            </div>
          )}

          {detectedPrompt.description && <p className="prompt-description-text">{detectedPrompt.description}</p>}

          {detectedPrompt.detailLines && detectedPrompt.detailLines.length > 0 && (
            <pre className="prompt-detail-lines">
              {detectedPrompt.detailLines.map((line, idx) => (
                <div
                  key={idx}
                  className={/^\s*\+/.test(line) ? 'diff-line-add' : /^\s*-/.test(line) ? 'diff-line-del' : undefined}
                >
                  {line || ' '}
                </div>
              ))}
            </pre>
          )}

          <p className="prompt-question-text">{detectedPrompt.question}</p>

          {hasOptions ? (
            <div className="prompt-options-grid">
              {detectedPrompt.options!.map((opt) => {
                const isSubmitting = submitting?.signature === detectedPrompt.signature && submitting.key === opt.key;
                return (
                  <button
                    key={`${opt.key}-${opt.index ?? ''}`}
                    type="button"
                    className={`prompt-option-btn ${opt.isDefault ? 'is-default' : ''} ${
                      opt.isDestructive ? 'is-destructive' : ''
                    } ${isSubmitting ? 'is-submitting' : ''}`}
                    onClick={() => handleSelectOption(opt)}
                    disabled={submitting !== null}
                  >
                    <span className="opt-key-badge">{opt.key}</span>
                    <span className="opt-label-text">{opt.label}</span>
                    {isSubmitting && <Loader2 size={13} className="spin-animate" />}
                  </button>
                );
              })}
            </div>
          ) : detectedPrompt.kind === 'question' || (detectedPrompt.type === 'freeform' && detectedPrompt.kind !== 'notice') ? (
            <form onSubmit={handlePromptAnswer} style={{ display: 'flex', gap: '0.45rem', marginTop: '0.2rem' }}>
              <input
                type="text"
                placeholder={`Type your reply to ${label}…`}
                className="steer-input-field prompt-answer-input"
                style={{ flex: 1 }}
                value={promptAnswer}
                onChange={(e) => setPromptAnswer(e.target.value)}
                autoFocus
              />
              <button
                type="submit"
                className="btn btn-primary"
                style={{ padding: '0.35rem 0.85rem', fontSize: '0.78rem' }}
                disabled={!promptAnswer.trim() || submitting !== null}
              >
                <Send size={12} />
                <span>Submit</span>
              </button>
            </form>
          ) : null}

          <div className="prompt-card-footer">
            {detectedPrompt.rawSnippet && (
              <details className="prompt-raw-details">
                <summary>Show what the agent is asking</summary>
                <pre>{detectedPrompt.rawSnippet}</pre>
              </details>
            )}
          </div>
        </div>
      )}

      {/* ── Activity Stream ── */}
      <div className={`cli-notes-feed-container ${isFeedCollapsed ? 'is-collapsed' : ''}`}>
        <div
          className="feed-container-header"
          onClick={() => setIsFeedCollapsed((v) => !v)}
          title={isFeedCollapsed ? 'Expand activity stream' : 'Collapse activity stream'}
        >
          <div className="feed-header-left">
            <Sparkles size={12} color="var(--accent-cyan)" />
            <span>{label} · Activity</span>
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
                <span>
                  {role === 'verifier'
                    ? 'Verifier will check the work once the Manager finishes. (You can turn Verification off from the task menu.)'
                    : `Watching ${label}… actions and thoughts will stream here in real time.`}
                </span>
              </div>
            ) : (
              allEntries.map((item) => (
                <div key={item.id} className={`feed-item is-${item.type}`}>
                  <div className="feed-item-icon">
                    {item.type === 'tool' && <Command size={11} color="var(--accent-cyan)" />}
                    {item.type === 'thought' && <Brain size={11} color="var(--accent-violet)" />}
                    {item.type === 'user' && <MessageSquare size={11} color="var(--accent-emerald)" />}
                    {item.type === 'approval' && <ShieldCheck size={11} color="var(--accent-emerald)" />}
                    {item.type === 'status' && <Sparkles size={11} color="var(--text-muted)" />}
                  </div>
                  <div className="feed-item-content">
                    <span className="feed-item-text">{item.text}</span>
                    {item.detail && item.detail !== item.text && <code className="feed-item-detail">{item.detail}</code>}
                  </div>
                  <span className="feed-item-time">{item.timestamp}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {liveStatus}

      {/* ── Mid-Task Steering Prompt Box ── */}
      <form onSubmit={handleSteerSubmit} className="cli-notes-steer-form">
        <div className="steer-input-wrapper">
          <input
            type="text"
            className="steer-input-field"
            placeholder={
              runActive
                ? `Message ${label} while it works — it takes it in at its next step…`
                : 'Send a follow-up — continues this task from where it left off…'
            }
            value={steerInput}
            onChange={(e) => setSteerInput(e.target.value)}
          />
          <button
            type="submit"
            className="steer-send-btn"
            disabled={!steerInput.trim()}
            title={runActive ? `Send this to ${label}` : 'Continue the task with this message'}
          >
            <Send size={12} />
            <span>{runActive ? 'Send' : 'Continue'}</span>
          </button>
        </div>
      </form>
    </div>
  );
};
