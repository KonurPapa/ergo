/**
 * Client for the bridge's CLI-agent session API (vite.config.ts, ergo-pty plugin).
 *
 * App owns the lifecycle of every agent PTY (manager, workers, QA): it launches them over REST, and terminal
 * views only attach. The bridge watches each session's rendered screen and signal files and reports
 * prompts, auto-approvals, signals and exits on one Server-Sent Events stream.
 */
import { bridgeClient } from './bridgeClient';
import type { AgentSessionRole, CliDetectedPrompt, PermissionLevel } from '../types';

export interface SpawnAgentRequest {
  sessionId: string;
  taskId: string | number;
  /** Ergo project the run belongs to: scopes the agent's ergo-memory tools and the run notes the bridge ingests. */
  projectId?: string;
  runId: string;
  role: AgentSessionRole;
  label: string;
  pieceId?: string;
  cmd: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  permissionLevel: PermissionLevel;
  spawnId: string;
  cols?: number;
  rows?: number;
}

export interface SpawnAgentResponse {
  success: boolean;
  error?: string;
  sessionId?: string;
  /** cwd the process actually runs in (the bridge falls back when the requested one is missing). */
  cwd?: string;
  /** Absolute path of `<cwd>/.ergo/runs/<runId>`. */
  runDir?: string;
}

/** How a mid-run permission change reached a session. */
export type PolicyApplied = 'live' | 'auto-approve-only' | 'restart-required' | 'unchanged';

export interface PolicyResult {
  sessionId: string;
  applied: PolicyApplied;
  detail?: string;
}

/** Signal files an agent writes into its run dir when it reaches a milestone. */
export type AgentSignalKind = 'delegate' | 'worker-done' | 'complete' | 'qa-verdict';

export type CliAgentEvent =
  | ({ type: 'spawned'; label: string; pieceId?: string } & CliAgentEventBase)
  | ({ type: 'prompt'; prompt: CliDetectedPrompt | null } & CliAgentEventBase)
  | ({ type: 'auto-approved'; summary: string } & CliAgentEventBase)
  | ({
      type: 'signal';
      signal: AgentSignalKind;
      /** Path relative to the session cwd, e.g. ".ergo/runs/<runId>/completion.md". */
      file: string;
      content: string;
      /** File mtime (ms) — together with sessionId + signal it identifies one signal occurrence. */
      mtime: number;
      verdict?: 'PASS' | 'FAIL';
    } & CliAgentEventBase)
  | ({ type: 'exit'; code: number } & CliAgentEventBase)
  | ({ type: 'policy'; permissionLevel: PermissionLevel; applied: PolicyApplied; detail?: string; /** Outcome of a switch that was queued behind an open prompt. */ deferred?: boolean } & CliAgentEventBase);

export interface CliAgentEventBase {
  sessionId: string;
  taskId: string;
  role: AgentSessionRole;
  runId?: string;
  /** ISO timestamp */
  at: string;
}

export interface BridgeAgentSessionInfo {
  id: string;
  taskId: string | number;
  role?: AgentSessionRole;
  label?: string;
  pieceId?: string;
  runId?: string;
  spawnId?: string;
  permissionLevel?: PermissionLevel;
  cmd: string;
  args: string[];
  cwd: string;
  isActive: boolean;
  exitCode: number | null;
  startedAt: string;
  /** When the process ended (absent while it runs). */
  endedAt?: string;
  hasSubscribers: boolean;
  prompt?: CliDetectedPrompt | null;
  /** Latest occurrence of each signal file seen for this session. */
  signals?: Array<{ signal: AgentSignalKind; file: string; mtime: number; content: string; verdict?: 'PASS' | 'FAIL' }>;
}

export interface AgentTranscript {
  success: boolean;
  cli?: string;
  exitCode: number | null;
  isActive: boolean;
  startedAt?: string;
  /** The agent's last reply, from the CLI's own session log when readable. */
  finalMessage?: string;
  finalMessageSource?: 'claude-session-log' | 'codex-session-log' | 'gemini-session-log' | 'transcript' | 'none';
  /** De-duplicated rendered screen lines (TUI repaints collapsed), last ~300 lines. */
  transcriptTail: string;
}

async function postJson<T>(endpoint: string, body: unknown): Promise<T | null> {
  try {
    const res = await bridgeClient.fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await res.json().catch(() => null)) as T | null;
  } catch (err) {
    console.warn(`[Ergo CLI runs] ${endpoint} failed:`, err);
    return null;
  }
}

/** Launch (or relaunch — an existing session with the same id is killed first) one agent PTY. */
export function spawnAgentSession(req: SpawnAgentRequest): Promise<SpawnAgentResponse> {
  return postJson<SpawnAgentResponse>('/api/pty/spawn', req).then(
    (r) => r ?? { success: false, error: 'Bridge unreachable' }
  );
}

/** Type into an agent's terminal (an answer to a prompt, or raw keys from a view). */
export async function sendAgentInput(sessionId: string, data: string): Promise<boolean> {
  const r = await postJson<{ success: boolean }>('/api/pty/input', { sessionId, data });
  return Boolean(r?.success);
}

/**
 * Type an Ergo hand-off (worker results, QA findings) into an agent's terminal. Flagged as a hand-off so the
 * bridge can refuse it while an approval / question menu is on screen (its digits, letters or Enter would answer
 * it); 'prompt-open' means it was refused for that reason and should be retried once the prompt clears.
 */
export async function sendAgentHandoff(sessionId: string, data: string): Promise<'sent' | 'prompt-open' | 'failed'> {
  const r = await postJson<{ success: boolean; promptOpen?: boolean }>('/api/pty/input', { sessionId, data, handoff: true });
  if (r?.success) return 'sent';
  return r?.promptOpen ? 'prompt-open' : 'failed';
}

/** Kill one agent session (`sessionId`) or every session of a task (`taskId` only). */
export async function killAgentSessions(target: { sessionId?: string; taskId?: string | number }): Promise<void> {
  await postJson('/api/pty/kill', {
    ...(target.sessionId ? { sessionId: target.sessionId } : {}),
    ...(target.taskId !== undefined ? { taskId: String(target.taskId) } : {}),
  });
}

/** Apply a permission level to running sessions right away (all sessions when no target is given). */
export async function applyPermissionPolicy(
  permissionLevel: PermissionLevel,
  target: { sessionId?: string; taskId?: string | number } = {}
): Promise<PolicyResult[]> {
  const r = await postJson<{ success: boolean; results?: PolicyResult[] }>('/api/pty/policy', {
    permissionLevel,
    ...(target.sessionId ? { sessionId: target.sessionId } : {}),
    ...(target.taskId !== undefined ? { taskId: String(target.taskId) } : {}),
    ...(!target.sessionId && target.taskId === undefined ? { all: true } : {}),
  });
  return r?.results ?? [];
}

export async function fetchAgentTranscript(sessionId: string): Promise<AgentTranscript | null> {
  try {
    const res = await bridgeClient.fetch(`/api/pty/transcript?sessionId=${encodeURIComponent(sessionId)}`);
    if (!res.ok) return null;
    return (await res.json()) as AgentTranscript;
  } catch {
    return null;
  }
}

/** The agent CLI's own resumable conversation id (Claude session id, Codex rollout id); null when unknown. */
export async function fetchCliSessionId(sessionId: string): Promise<string | null> {
  try {
    const res = await bridgeClient.fetch(`/api/pty/cli-session?sessionId=${encodeURIComponent(sessionId)}`);
    if (!res.ok) return null;
    const json = await res.json();
    return typeof json?.cliSessionId === 'string' && json.cliSessionId ? json.cliSessionId : null;
  } catch {
    return null;
  }
}

export async function listAgentSessions(): Promise<BridgeAgentSessionInfo[]> {
  try {
    const res = await bridgeClient.fetch('/api/pty/sessions');
    if (!res.ok) return [];
    const json = await res.json();
    return Array.isArray(json?.sessions) ? json.sessions : [];
  } catch {
    return [];
  }
}

/**
 * Subscribe to the bridge's agent event stream. EventSource reconnects by itself; `onReconnect` fires after
 * each re-open so callers can re-sync from listAgentSessions() (events sent while disconnected are lost).
 * The stream follows the bridge: when discovery moves it to another URL, or the bridge comes back after the
 * stream gave up (e.g. an HTTP error closes an EventSource for good), it is reopened at the current URL.
 */
export function subscribeAgentEvents(onEvent: (ev: CliAgentEvent) => void, onReconnect?: () => void): () => void {
  let source: EventSource | null = null;
  let openedUrl = '';
  let everOpened = false;
  let disposed = false;
  const open = () => {
    try {
      source?.close();
    } catch {}
    source = null;
    if (disposed) return;
    openedUrl = bridgeClient.getApiUrl('/api/pty/events');
    try {
      const s = new EventSource(openedUrl);
      source = s;
      s.onopen = () => {
        if (source !== s) return;
        // Every open after the first is a reconnect (same URL after a drop, or a new URL after discovery).
        if (everOpened) onReconnect?.();
        everOpened = true;
      };
      s.onmessage = (msg) => {
        if (source !== s) return;
        try {
          const data = JSON.parse(msg.data);
          if (data && typeof data.type === 'string' && data.type !== 'connected') onEvent(data as CliAgentEvent);
        } catch {}
      };
    } catch (err) {
      console.warn('[Ergo CLI runs] Could not open agent event stream:', err);
    }
  };
  open();
  // subscribe() calls back once right away (same URL, open stream → no-op), then on every status change.
  const unsubBridge = bridgeClient.subscribe((status) => {
    if (disposed) return;
    const url = bridgeClient.getApiUrl('/api/pty/events');
    const closed = !source || source.readyState === 2; // EventSource.CLOSED
    if (url !== openedUrl || (status.isConnected && closed)) open();
  });
  return () => {
    disposed = true;
    unsubBridge();
    try {
      source?.close();
    } catch {}
    source = null;
  };
}

/**
 * Short, bridge-safe key for a project. Task ids are only unique within a project, so agent PTY keys carry
 * this prefix to keep the same task id in two projects apart.
 */
export function agentProjectKey(projectId: string): string {
  // FNV-1a (32-bit): project ids can be long or contain any character; the bridge caps session ids at 200 chars.
  let h = 0x811c9dc5;
  for (let i = 0; i < projectId.length; i++) {
    h ^= projectId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `p${(h >>> 0).toString(16).padStart(8, '0')}`;
}

const PROJECT_KEY_RE = /^p[0-9a-f]{8}$/;

/**
 * Bridge PTY key for one agent of a task: `${projectKey}~${taskId}::${role}[::${pieceId}]`.
 * Pass `projectKey = null` for the legacy unscoped form (`${taskId}::${role}…`) of runs started before scoping.
 */
export function agentSessionId(
  projectKey: string | null,
  taskId: string | number,
  role: AgentSessionRole,
  pieceId?: string
): string {
  return `${projectKey ? `${projectKey}~` : ''}${taskId}::${role}${pieceId ? `::${pieceId}` : ''}`;
}

/** Project key and task id encoded in an agent PTY key (projectKey is null for legacy unscoped keys). */
export function parseAgentSessionId(sessionId: string): { projectKey: string | null; taskKey: string } {
  const head = String(sessionId).split('::')[0];
  const tilde = head.indexOf('~');
  if (tilde !== -1 && PROJECT_KEY_RE.test(head.slice(0, tilde))) {
    return { projectKey: head.slice(0, tilde), taskKey: head.slice(tilde + 1) };
  }
  return { projectKey: null, taskKey: head };
}

/** Run-dir path relative to the agent's cwd (what prompts tell the agent to write into). */
export function runDirRel(runId: string): string {
  return `.ergo/runs/${runId}`;
}
