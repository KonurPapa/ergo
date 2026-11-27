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
 *  7 — task agents' terminals are saved on disk: /api/pty/history (list), /api/pty/history/delete, replay of a saved
 *      terminal on attach, spawn `taskTitle`. Optional: with an older bridge terminals live only in its memory.
 *  8 — context rotation for CLI workers: /api/pty/usage reports `usage.context` (the conversation's current and starting
 *      size, the window when known) and a worker's handoff-<piece>.md arrives as a `handoff` signal. Optional: with an
 *      older bridge CLI workers are never rotated (they compact themselves).
 *      Also `problems` in the bridge's info: what keeps it from working on this computer (e.g. node-pty, which starts
 *      every agent, failed to load). Optional: with an older bridge the web app recognizes those failures from the
 *      error an agent start returns (bridgeHealth.ts).
 *  9 — editor deep links: /api/files/open takes `ide` (Settings › Editor), `column`, `projectId` and `root` (relative
 *      paths resolve against the task's folders; only files inside the project's Allowed Folders open), plus
 *      /api/ide/detect, /api/git/run-changes (files a run changed since its first agent started, recorded in
 *      `.ergo/runs/<runId>/git-base.json`) and /api/files/diff (a run's change to one file as a diff in the editor).
 *      Optional: with an older bridge paths still open (in its auto-detected editor) but runs list no changed files.
 * 10 — in-app visual diff & checkpoint rollback: /api/git/run-diff (unified diff payload), /api/git/revert-file,
 *      /api/git/revert-run, /api/git/checkpoint and /api/git/checkpoints (per-step tree snapshots and 1-click revert).
 *      Optional: older bridges still open diffs in the external editor.
 * 11 — Live Web Preview: /api/preview/session (a token for one folder), GET /api/preview/s/<token>/<path> (that
 *      folder's files, sandboxed, with a console relay injected into HTML) and /api/preview/ports (dev servers on
 *      common ports). Optional: with an older bridge the task pane has no Preview tab.
 */
export const BRIDGE_PROTOCOL = 11;

/** First protocol whose bridge serves the Live Web Preview (preview.ts). */
export const PREVIEW_PROTOCOL = 11;

/** First protocol whose bridge serves in-app unified diffs, checkpoints, and 1-click revert. */
export const VISUAL_DIFF_PROTOCOL = 10;

/** First protocol whose bridge honors the editor choice and serves run changes and diffs (ideLinks.ts). */
export const IDE_LINKS_PROTOCOL = 9;

/** First protocol whose bridge reports session context sizes and workers' handoff notes (CLI worker rotation). */
export const HANDOFF_PROTOCOL = 8;

/** First protocol whose bridge stores learned rules (namespace `insights`). */
export const INSIGHTS_PROTOCOL = 5;

/** First protocol whose bridge serves /api/pty/activity. */
export const ACTIVITY_PROTOCOL = 6;

/** First protocol whose bridge reports a manager's question.md as a `question` signal. */
export const QUESTION_SIGNAL_PROTOCOL = 3;

/** The oldest bridge this web app works with; an older one is updated (automatically where it can be). */
export const MIN_BRIDGE_PROTOCOL = 7;

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

/** Something that keeps this bridge from working on this computer, whatever the web app asks of it. */
export interface BridgeProblem {
  /** agents-unavailable: node-pty, which every agent runs in, failed to load. */
  code: 'agents-unavailable';
  /** The technical reason, for "Copy details". */
  message: string;
}

export interface BridgeInfo {
  protocol: number;
  /** The installed Ergo Bridge app's version; 'source' when it runs from a checkout (`npm run dev` / `npm run bridge`). */
  version: string;
  /** desktop: the Ergo Bridge app, which updates itself. source: a checkout, updated with git pull + restart. */
  kind: 'desktop' | 'source';
  update?: BridgeUpdateState;
  /** Protocol 8+: always present, empty when the bridge works. Missing from older bridges. */
  problems?: BridgeProblem[];
}
