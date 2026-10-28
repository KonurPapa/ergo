/**
 * The contract between the Ergo web app and the user's local bridge. Both are built from this repository, so each
 * knows the protocol it was built with: the bridge reports its own on every connection check (`bridge` in
 * GET /api/storage/config), and the web app asks for an update when the bridge is older than MIN_BRIDGE_PROTOCOL.
 *
 * Release order: publish the bridge first, then deploy the web app that raises MIN_BRIDGE_PROTOCOL, so the update the
 * web app asks for already exists.
 */

/**
 * The bridge's protocol. Bump it whenever the web app starts relying on something new in the bridge (an endpoint, a
 * response field), and raise MIN_BRIDGE_PROTOCOL to match once that bridge is released.
 *  2 — version handshake + self-update (/api/bridge/update), skill copies report `edited`.
 *  3 — a run's manager may write question.md (a `question` signal): the web app shows it as a question card.
 *      Optional: with an older bridge the web app tells managers to ask the old way.
 *  4 — task commands: /api/files/search|pick|refs (the `@` file dropdown) and the workspace-tool relay for CLI agents
 *      (spawn `workspaceTools`, `workspace-call` events, /api/pty/workspace-claim|result). Optional: with an older
 *      bridge `@` lists no files and CLI agents run skills without the workspace tools (taskReferences.ts).
 *  5 — learned rules: /api/memory/insights/list|apply, and /api/memory/related returns the task's `insights`.
 *      Optional: with an older bridge nothing is learned and runs get no rules (insights.ts).
 *  6 — /api/pty/activity: what a CLI agent is doing, in plain words (the status line above the task prompt box).
 *      Optional: with an older bridge the line only shows that the agent is working (AgentLiveStatus.tsx).
 */
export const BRIDGE_PROTOCOL = 6;

/** First protocol whose bridge stores learned rules (namespace `insights`). */
export const INSIGHTS_PROTOCOL = 5;

/** First protocol whose bridge serves /api/pty/activity. */
export const ACTIVITY_PROTOCOL = 6;

/** First protocol whose bridge reports a manager's question.md as a `question` signal. */
export const QUESTION_SIGNAL_PROTOCOL = 3;

/** The oldest bridge this web app works with; an older one is updated (automatically where it can be). */
export const MIN_BRIDGE_PROTOCOL = 2;

export type BridgeUpdateStatus =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'up-to-date'
  | 'error';

export interface BridgeUpdateState {
  status: BridgeUpdateStatus;
  /** The version being downloaded or installed. */
  version?: string;
  /** Download progress, 0–100. */
  percent?: number;
  message?: string;
  /** Agent sessions still running: a ready update installs once this reaches 0. */
  waitingForSessions?: number;
}

export interface BridgeInfo {
  protocol: number;
  /** The installed Ergo Bridge app's version; 'source' when it runs from a checkout (`npm run dev` / `npm run bridge`). */
  version: string;
  /** desktop: the Ergo Bridge app, which updates itself. source: a checkout, updated with git pull + restart. */
  kind: 'desktop' | 'source';
  update?: BridgeUpdateState;
}
