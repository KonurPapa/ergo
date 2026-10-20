import React, { useEffect, useRef, useState } from 'react';
import { Send, MessageSquare, Loader2, Check, Clock, AlertTriangle } from 'lucide-react';
import { describeTaskMessage, type TaskMessageOptions, type TaskMessageResult } from '../lib/taskMessages';

export interface TaskPromptTarget {
  /** Worker piece id (in-app pipeline). */
  pieceId: string;
  label: string;
}

export interface TaskPromptBoxProps {
  /** A run is working right now: the message steers it. Otherwise it continues the finished run. */
  running: boolean;
  onSend: (text: string, opts: TaskMessageOptions) => Promise<TaskMessageResult>;
  /** Running workers the user may address instead of the manager (in-app pipeline). */
  workerTargets?: TaskPromptTarget[];
  /** Shown above the input (e.g. which agent receives it). */
  hint?: string;
}

interface SentMessage {
  id: number;
  text: string;
  state: 'sending' | 'queued' | 'delivered' | 'failed' | 'dropped';
  note: string;
}

/**
 * The task's prompt box when no agent terminal is shown (in-app pipeline runs, a finished CLI run whose agents are
 * gone): a message mid-run steers the agents, a message after the run continues it from where it left off.
 */
export const TaskPromptBox: React.FC<TaskPromptBoxProps> = ({ running, onSend, workerTargets = [], hint }) => {
  const [input, setInput] = useState('');
  const [target, setTarget] = useState<string>('');
  const [sent, setSent] = useState<SentMessage[]>([]);
  const seqRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // A worker that finished can't be addressed any more: fall back to the manager.
  useEffect(() => {
    if (target && !workerTargets.some((w) => w.pieceId === target)) setTarget('');
  }, [target, workerTargets]);

  const patch = (id: number, next: Partial<SentMessage>) => {
    if (!mountedRef.current) return;
    setSent((prev) => prev.map((m) => (m.id === id ? { ...m, ...next } : m)));
  };

  const submit = async () => {
    const text = input.trim();
    if (!text) return;
    const id = ++seqRef.current;
    setInput('');
    setSent((prev) => [...prev.slice(-5), { id, text, state: 'sending', note: running ? 'Sending…' : 'Continuing the task…' }]);
    const res = await onSend(text, {
      ...(target ? { pieceId: target } : {}),
      onDelivered: () => patch(id, { state: 'delivered', note: 'Delivered' }),
      onDropped: () => patch(id, { state: 'dropped', note: 'Not delivered — the agent ended first' }),
    });
    if (!res.ok) {
      patch(id, { state: 'failed', note: describeTaskMessage(res) });
      if (mountedRef.current) setInput((cur) => cur || text);
      return;
    }
    patch(id, { state: res.delivery === 'queued' || res.delivery === 'held' ? 'queued' : 'delivered', note: describeTaskMessage(res) });
  };

  const placeholder = running
    ? 'Message the agent while it works — it reads it at its next step…'
    : 'Send a follow-up — continues this task from where it left off…';

  return (
    <div className="task-prompt-box">
      {sent.length > 0 && (
        <div className="task-prompt-log">
          {sent.map((m) => (
            <div key={m.id} className={`task-prompt-msg is-${m.state}`}>
              <MessageSquare size={11} className="task-prompt-msg-icon" />
              <span className="task-prompt-msg-text">{m.text}</span>
              <span className="task-prompt-msg-state" title={m.note}>
                {m.state === 'sending' ? (
                  <Loader2 size={10} className="spin-animate" />
                ) : m.state === 'queued' ? (
                  <Clock size={10} />
                ) : m.state === 'delivered' ? (
                  <Check size={10} />
                ) : (
                  <AlertTriangle size={10} />
                )}
                <span>{m.note}</span>
              </span>
            </div>
          ))}
        </div>
      )}
      {(hint || (running && workerTargets.length > 0)) && (
        <div className="task-prompt-targets">
          {hint && <span className="task-prompt-hint">{hint}</span>}
          {running && workerTargets.length > 0 && (
            <>
              <span className="task-prompt-hint">To:</span>
              <button type="button" className={`task-prompt-target ${target === '' ? 'is-active' : ''}`} onClick={() => setTarget('')}>
                Manager
              </button>
              {workerTargets.map((w) => (
                <button
                  key={w.pieceId}
                  type="button"
                  className={`task-prompt-target ${target === w.pieceId ? 'is-active' : ''}`}
                  onClick={() => setTarget(w.pieceId)}
                  title={w.label}
                >
                  {w.label}
                </button>
              ))}
            </>
          )}
        </div>
      )}
      <form
        className="cli-notes-steer-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="steer-input-wrapper">
          <input
            type="text"
            className="steer-input-field"
            placeholder={placeholder}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            aria-label={running ? 'Message the running agent' : 'Send a follow-up to continue this task'}
          />
          <button type="submit" className="steer-send-btn" disabled={!input.trim()} title={running ? 'Send to the running agent' : 'Continue the task with this message'}>
            <Send size={12} />
            <span>{running ? 'Send' : 'Continue'}</span>
          </button>
        </div>
      </form>
    </div>
  );
};
