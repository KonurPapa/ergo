import React from 'react';
import { Brain, Users, ShieldCheck, Sparkles, Eraser, ScrollText, Wand2, Radio } from 'lucide-react';
import type { AgentRole, AgentSessionRole, AgentSessionStatus, SpawnedSession } from '../types';

/**
 * Agent identity UI shared by the Actions card: role badges (colour + icon + label), the per-task agent tab strip
 * of the Notes view, and the ordering / follow-live rules that decide which agent's terminal is shown.
 */

/** Every role a badge can show: CLI agent sessions plus the in-app pipeline's step roles ("hardener" shows as QA). */
export type AgentBadgeRole = AgentSessionRole | AgentRole;
type NormalizedBadgeRole = 'manager' | 'worker' | 'qa' | 'summary' | 'cleaner' | 'logger' | 'autocomplete';

export const AGENT_ROLE_ORDER: Record<AgentSessionRole, number> = { manager: 0, worker: 1, qa: 2 };

/** Statuses during which an agent still counts as working on the task. */
const WORKING_STATUSES: ReadonlySet<AgentSessionStatus> = new Set(['starting', 'running', 'awaiting_approval', 'waiting']);

export function isAgentWorking(status: AgentSessionStatus | undefined): boolean {
  return Boolean(status && WORKING_STATUSES.has(status));
}

/** Actively producing output (not merely waiting on other agents). */
function isAgentRunning(status: AgentSessionStatus | undefined): boolean {
  return status === 'starting' || status === 'running';
}

export function agentStatusLabel(status: AgentSessionStatus | undefined): string {
  switch (status) {
    case 'starting':
      return 'Starting';
    case 'running':
      return 'Running';
    case 'awaiting_approval':
      return 'Needs approval';
    case 'waiting':
      return 'Waiting';
    case 'done':
      return 'Done';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Stopped';
    default:
      return 'Idle';
  }
}

function normalizeRole(role: AgentBadgeRole): NormalizedBadgeRole {
  return role === 'hardener' ? 'qa' : role;
}

/** Default label for a role when no session label is known, e.g. "Worker W2", "QA". */
export function defaultAgentLabel(role: AgentBadgeRole, pieceId?: string): string {
  switch (normalizeRole(role)) {
    case 'manager':
      return 'Manager';
    case 'worker':
      return pieceId ? `Worker ${pieceId}` : 'Worker';
    case 'qa':
      return 'QA';
    case 'summary':
      return 'Summary';
    case 'cleaner':
      return 'Cleaner';
    case 'logger':
      return 'Logger';
    default:
      return 'Autocomplete';
  }
}

/** Order agents manager → workers (by piece id, numeric-aware) → QA; ties by launch time. */
export function sortAgentSessions(sessions: SpawnedSession[]): SpawnedSession[] {
  return [...sessions].sort(
    (a, b) =>
      (AGENT_ROLE_ORDER[a.role] ?? 0) - (AGENT_ROLE_ORDER[b.role] ?? 0) ||
      (a.pieceId || '').localeCompare(b.pieceId || '', undefined, { numeric: true, sensitivity: 'base' }) ||
      String(a.session.spawnedAt || '').localeCompare(String(b.session.spawnedAt || ''))
  );
}

/** One task's agent sessions in display order (task ids compared as strings). */
export function sessionsForTask(sessions: SpawnedSession[], taskId: string | number): SpawnedSession[] {
  const key = String(taskId);
  return sortAgentSessions(sessions.filter((s) => String(s.session.taskId) === key));
}

export interface LiveAgentPick {
  session: SpawnedSession;
  /** Why this agent is the one to watch, e.g. "needs your approval". */
  reason: string;
}

/**
 * Which agent the Notes view should follow while "Follow live" is on:
 * an agent awaiting approval → (manager waiting) the first running worker, else running QA → the running manager →
 * any running agent → the still-open manager → the agent that finished most recently.
 */
export function pickLiveAgent(sessions: SpawnedSession[]): LiveAgentPick | null {
  if (sessions.length === 0) return null;
  const ordered = sortAgentSessions(sessions);
  const awaiting = ordered.find((s) => s.status === 'awaiting_approval');
  if (awaiting) return { session: awaiting, reason: 'needs your approval' };

  const manager = ordered.find((s) => s.role === 'manager');
  if (manager?.status === 'waiting') {
    const worker = ordered.find((s) => s.role === 'worker' && isAgentRunning(s.status));
    if (worker) return { session: worker, reason: 'the Manager is waiting on its workers' };
    const qa = ordered.find((s) => s.role === 'qa' && isAgentRunning(s.status));
    if (qa) return { session: qa, reason: 'QA is verifying the work' };
  }
  if (manager && isAgentRunning(manager.status)) return { session: manager, reason: 'the Manager is working' };

  const running = ordered.find((s) => isAgentRunning(s.status));
  if (running) return { session: running, reason: `${running.label} is running` };

  // Nothing is working any more. The manager outlives its run (it stays open for steering after finalize),
  // so prefer it while its process is alive; otherwise pick the agent that actually finished last — role
  // order says nothing about time. Ties keep the earlier (manager-first) entry.
  if (manager?.session.isActive) return { session: manager, reason: `${manager.label} is still open` };
  const timeOf = (s: SpawnedSession): number => {
    const t = Date.parse(s.endedAt || s.session.spawnedAt || '');
    return Number.isFinite(t) ? t : 0;
  };
  const last = ordered.reduce((a, b) => (timeOf(b) > timeOf(a) ? b : a));
  return { session: last, reason: `${last.label} ran last` };
}

const ROLE_ICONS: Record<NormalizedBadgeRole, React.ComponentType<{ size?: number; className?: string }>> = {
  manager: Brain,
  worker: Users,
  qa: ShieldCheck,
  summary: Sparkles,
  cleaner: Eraser,
  logger: ScrollText,
  autocomplete: Wand2,
};

export interface AgentRoleBadgeProps {
  role: AgentBadgeRole;
  pieceId?: string;
  /** Text to show; defaults to the role name ("Manager", "Worker W2", "QA"). */
  label?: string;
  size?: 'sm' | 'md';
  title?: string;
}

/** Role pill: role colour + icon + label, used on tabs, terminal headers, the notes bridge and step cards. */
export const AgentRoleBadge: React.FC<AgentRoleBadgeProps> = ({ role, pieceId, label, size = 'sm', title }) => {
  const normalized = normalizeRole(role);
  const Icon = ROLE_ICONS[normalized];
  const text = label?.trim() || defaultAgentLabel(role, pieceId);
  return (
    <span
      className={`agent-role-badge role-${normalized} size-${size}`}
      title={title || `${defaultAgentLabel(role, pieceId)} agent`}
    >
      <Icon size={size === 'md' ? 13 : 11} className="agent-role-badge-icon" />
      <span className="agent-role-badge-text">{text}</span>
    </span>
  );
};

/** Status dot (pulses while running; amber pulse while the agent needs approval). */
export const AgentStatusDot: React.FC<{ status: AgentSessionStatus | undefined }> = ({ status }) => (
  <span className={`agent-status-dot status-${status || 'idle'}`} title={agentStatusLabel(status)} aria-hidden="true" />
);

export interface AgentSessionTabsProps {
  sessions: SpawnedSession[];
  selectedId: string | null;
  onSelect: (ptySessionId: string) => void;
  followLive: boolean;
  onToggleFollow: (next: boolean) => void;
}

/** Tab strip of a task run's agents (manager → workers → QA) with a "Follow live" toggle. */
export const AgentSessionTabs: React.FC<AgentSessionTabsProps> = ({ sessions, selectedId, onSelect, followLive, onToggleFollow }) => {
  const ordered = sortAgentSessions(sessions);
  if (ordered.length === 0) return null;
  return (
    <div className="agent-session-tabs">
      <div className="agent-session-tab-list" role="tablist" aria-label="Agents of this task run">
        {ordered.map((s) => {
          const isSelected = s.ptySessionId === selectedId;
          const needsApproval = s.status === 'awaiting_approval';
          return (
            <button
              key={s.ptySessionId}
              type="button"
              role="tab"
              aria-selected={isSelected}
              className={`agent-session-tab role-${normalizeRole(s.role)} ${isSelected ? 'is-selected' : ''} ${needsApproval ? 'needs-approval' : ''}`}
              onClick={() => onSelect(s.ptySessionId)}
              title={`${s.label} · ${s.cmd} · ${agentStatusLabel(s.status)}${followLive && !isSelected ? ' — click to pin this agent (turns Follow live off)' : ''}`}
            >
              <AgentRoleBadge role={s.role} pieceId={s.pieceId} label={s.label} />
              <AgentStatusDot status={s.status} />
              <span className={`agent-session-tab-status status-${s.status}`}>{agentStatusLabel(s.status)}</span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className={`agent-follow-toggle ${followLive ? 'is-on' : ''}`}
        onClick={() => onToggleFollow(!followLive)}
        aria-pressed={followLive}
        title={
          followLive
            ? 'Following the active agent automatically — click to stay on the selected agent'
            : 'Pinned to the selected agent — click to follow whichever agent is active'
        }
      >
        <Radio size={11} />
        <span>Follow live</span>
      </button>
    </div>
  );
};
