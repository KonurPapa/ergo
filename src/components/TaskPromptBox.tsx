import React, { useEffect, useRef, useState } from 'react';
import { Send, MessageSquare, Loader2, Check, Clock, AlertTriangle } from 'lucide-react';
import { describeTaskMessage, type TaskMessageOptions, type TaskMessageResult } from '../lib/taskMessages';
import { MOD } from '../lib/shortcuts';
import { Button } from './ui';

export interface TaskPromptTarget {
  /** Unique key (a worker piece id, or an agent's PTY session id). */
  id: string;
  label: string;
  /** How the message is addressed to it (pieceId for in-app pipeline workers, ptySessionId for CLI agents). */
  opts: Pick<TaskMessageOptions, 'pieceId' | 'ptySessionId'>;
}

export interface TaskPromptBoxProps {
  /** A run is working right now: the message gives it direction. Otherwise it is a follow-up to the finished task. */
  running: boolean;
  onSend: (text: string, opts: TaskMessageOptions) => Promise<TaskMessageResult>;
  /** Agents working right now that the user may address instead of the manager. */
  targets?: TaskPromptTarget[];
  /** Shown beside the targets (e.g. which agent receives it). */
  hint?: string;
  /** What the agent is doing right now (AgentLiveStatus), right above the input. */
  status?: React.ReactNode;
}

interface SentMessage {
  id: number;
  text: string;
  state: 'sending' | 'queued' | 'delivered' | 'failed' | 'dropped';
  note: string;
}

/** Deliveries that start a follow-up: the timeline shows those messages, so the box drops them from its own log. */
const FOLLOW_UP_DELIVERIES = new Set<TaskMessageResult['delivery']>(['continued', 'resumed', 'restarted']);

/**
 * The task's prompt box, pinned under the timeline (ergo-design Composer). Mid-run (any stage) a message gives the run
 * direction; after the task finished it is a follow-up that continues the same task. ⌘↵ sends, ↵ is a new line.
 */
export const TaskPromptBox: React.FC<TaskPromptBoxProps> = ({ running, onSend, targets = [], hint, status }) => {
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

  // An agent that finished can't be addressed any more: fall back to the manager.
  useEffect(() => {
    if (target && !targets.some((t) => t.id === target)) setTarget('');
  }, [target, targets]);

  const patch = (id: number, next: Partial<SentMessage>) => {
    if (!mountedRef.current) return;
    setSent((prev) => prev.map((m) => (m.id === id ? { ...m, ...next } : m)));
  };
  const drop = (id: number) => {
    if (!mountedRef.current) return;
    setSent((prev) => prev.filter((m) => m.id !== id));
  };

  const submit = async () => {
    const text = input.trim();
    if (!text) return;
    const id = ++seqRef.current;
    const chosen = targets.find((t) => t.id === target);
    setInput('');
    setSent((prev) => [...prev.slice(-3), { id, text, state: 'sending', note: running ? 'Sending…' : 'Starting the follow-up…' }]);
    const res = await onSend(text, {
      ...(chosen ? chosen.opts : {}),
      onDelivered: () => patch(id, { state: 'delivered', note: 'Delivered' }),
      onDropped: () => patch(id, { state: 'dropped', note: 'Not delivered — the agent ended first' }),
    });
    if (!res.ok) {
      patch(id, { state: 'failed', note: describeTaskMessage(res) });
      if (mountedRef.current) setInput((cur) => cur || text);
      return;
    }
    if (FOLLOW_UP_DELIVERIES.has(res.delivery)) {
      drop(id);
      return;
    }
    patch(id, { state: res.delivery === 'queued' || res.delivery === 'held' ? 'queued' : 'delivered', note: describeTaskMessage(res) });
  };

  const placeholder = running ? 'Give direction to the current task…' : 'Add a follow-up to the task…';
  const showTargets = running && targets.length > 0;

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
      {status}
      <form
        className="eg-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <textarea
          className="eg-composer-input eg-composer-textarea"
          rows={1}
          placeholder={placeholder}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
          }}
          aria-label={running ? 'Give direction to the running task' : 'Add a follow-up to the task'}
        />
        <div className="eg-composer-foot">
          <div className="eg-composer-targets">
            {hint && <span className="task-prompt-hint">{hint}</span>}
            {showTargets && (
              <>
                <span className="task-prompt-hint">To</span>
                <button type="button" className={`task-prompt-target ${target === '' ? 'is-active' : ''}`} onClick={() => setTarget('')}>
                  Manager
                </button>
                {targets.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`task-prompt-target ${target === t.id ? 'is-active' : ''}`}
                    onClick={() => setTarget(t.id)}
                    title={t.label}
                  >
                    {t.label}
                  </button>
                ))}
              </>
            )}
          </div>
          <span className="eg-spacer" />
          <Button
            type="submit"
            size="sm"
            variant={input.trim() ? 'primary' : 'secondary'}
            icon={Send}
            kbd={[MOD, '↵']}
            disabled={!input.trim()}
            title={running ? 'Send to the running task' : 'Continue the task with this follow-up'}
          >
            {running ? 'Send' : 'Follow up'}
          </Button>
        </div>
      </form>
    </div>
  );
};
