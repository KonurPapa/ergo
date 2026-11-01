import { useEffect, useRef, useState } from 'react';
import { bridgeClient } from '../lib/bridgeClient';
import { ACTIVITY_PROTOCOL } from '../lib/bridgeProtocol';
import type { AgentActivity, AgentActivityResponse } from '../lib/agentActivity';

const POLL_MS = 1500;
/** Output this recent counts as working even without a spinner on screen (CLIs without one, or between frames). */
const WORKING_QUIET_MS = 5000;

export interface AgentActivityState {
  activity: AgentActivity | null;
  /** From the bridge: whether the PTY is alive and whether the agent is working right now. Null until known. */
  live: { isActive: boolean; working: boolean } | null;
  /** When the activity line last changed (ms epoch). */
  changedAt: number;
}

/**
 * What a CLI agent is doing right now, polled from the bridge (`/api/pty/activity`), which reads it from the CLI's own
 * session log (Claude Code, Codex, Gemini) or its screen. Null session or an old bridge: nothing is polled.
 */
export function useAgentActivity(ptySessionId: string | null | undefined): AgentActivityState {
  const [activity, setActivity] = useState<AgentActivity | null>(null);
  const [live, setLive] = useState<{ isActive: boolean; working: boolean } | null>(null);
  const [changedAt, setChangedAt] = useState(() => Date.now());
  const lastKeyRef = useRef('');

  const canPoll = Boolean(ptySessionId) && (bridgeClient.getStatus().bridgeInfo?.protocol ?? 0) >= ACTIVITY_PROTOCOL;

  useEffect(() => {
    setActivity(null);
    setLive(null);
    lastKeyRef.current = '';
    setChangedAt(Date.now());
    if (!canPoll || !ptySessionId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const res = await bridgeClient.fetch(`/api/pty/activity?sessionId=${encodeURIComponent(ptySessionId)}`);
        const body: AgentActivityResponse = await res.json();
        if (disposed) return;
        if (body.success && body.activity) {
          const quiet = typeof body.quietMs === 'number' ? body.quietMs : Infinity;
          setLive({ isActive: Boolean(body.isActive), working: Boolean(body.isActive) && (Boolean(body.spinner) || quiet < WORKING_QUIET_MS) });
          const key = `${body.activity.said}\u0000${body.activity.doing}\u0000${body.activity.phase}`;
          if (key !== lastKeyRef.current) {
            lastKeyRef.current = key;
            setActivity(body.activity);
            setChangedAt(Date.now());
          }
        }
      } catch {
        // The bridge is unreachable for a moment: keep the last line.
      }
      if (!disposed) timer = setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [ptySessionId, canPoll]);

  return { activity, live, changedAt };
}

/** A ticking clock for elapsed-time labels: re-renders the caller every `ms` while `active`. */
export function useTick(active = true, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}
