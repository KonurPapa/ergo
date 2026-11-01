import React from 'react';
import { useAgentActivity, useTick } from '../hooks/useAgentActivity';
import type { AgentSessionRole, AgentSessionStatus } from '../types';
import { AgentRoleBadge } from './AgentSessionTabs';

export interface AgentLiveStatusProps {
  /** The CLI agent to follow (SpawnedSession.ptySessionId). Without one, `fallbackText` is shown (in-app pipeline). */
  ptySessionId?: string;
  status?: AgentSessionStatus;
  role?: AgentSessionRole;
  pieceId?: string;
  label?: string;
  /** Show the agent's badge (when it isn't the one the prompt box below talks to). */
  showBadge?: boolean;
  /** What an in-app pipeline run is doing (its running step's title). */
  fallbackText?: string;
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * One line above the task prompt box with what the agent is doing right now: its latest narration and the step it
 * took after it, read by the bridge from the CLI's own session log (Claude Code, Codex, Gemini) or its screen. The
 * pulse and the counter (time since it last changed) keep moving while the agent works, so a long think doesn't
 * look frozen.
 */
export const AgentLiveStatus: React.FC<AgentLiveStatusProps> = ({ ptySessionId, status, role, pieceId, label, showBadge, fallbackText }) => {
  const { activity, live, changedAt } = useAgentActivity(ptySessionId);
  useTick();

  const needsApproval = status === 'awaiting_approval';
  const waitingOnAgents = status === 'waiting';
  // Old bridge / no terminal: the session status is all there is.
  const working = needsApproval || waitingOnAgents ? false : live ? live.working : status ? status === 'starting' || status === 'running' : true;
  if (live && !live.isActive) return null;

  const said = activity?.said ?? '';
  let doing = activity?.doing ?? '';
  if (needsApproval) doing = 'Waiting for your approval';
  else if (waitingOnAgents && !doing) doing = 'Waiting on its agents';
  else if (!ptySessionId && fallbackText) doing = fallbackText;
  const state = needsApproval ? 'needs approval' : waitingOnAgents ? 'waiting' : !working ? 'idle' : activity?.phase === 'tool' ? 'running' : 'thinking';
  if (!said && !doing) doing = status === 'starting' ? 'Starting up…' : working ? 'Thinking…' : 'Waiting…';

  return (
    <div className={`agent-live-status ${working ? 'is-working' : 'is-still'} ${needsApproval ? 'is-approval' : ''}`} role="status" aria-live="polite">
      <span className="agent-live-pulse" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <div className="agent-live-lines">
        {said && (
          <div className="agent-live-said" title={said}>
            {showBadge && role && <AgentRoleBadge role={role} pieceId={pieceId} label={label} />}
            <span>{said}</span>
          </div>
        )}
        {doing && (
          <div className="agent-live-doing" title={doing}>
            {showBadge && role && !said && <AgentRoleBadge role={role} pieceId={pieceId} label={label} />}
            <span className="agent-live-doing-text">{doing}</span>
          </div>
        )}
      </div>
      <span className="agent-live-state" title={`Last change ${formatElapsed(Date.now() - changedAt)} ago`}>
        {state} · {formatElapsed(Date.now() - changedAt)}
      </span>
    </div>
  );
};
