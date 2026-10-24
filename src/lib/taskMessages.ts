/**
 * The task prompt box: messages the user sends to a task's agents, mid-run (steering) or after the run finished
 * (a follow-up that continues the same run). Shared by App, the CLI run hook and the views.
 */

/** What happened to a message the user sent from the prompt box. */
export type TaskMessageDelivery =
  /** Typed into the live agent's terminal / handed to the running pipeline: it reads it at its next step. */
  | 'sent'
  /** Held back (a permission prompt is open, or the agent is between steps): delivered as soon as it can be. */
  | 'queued'
  /** The run had finished and its manager was still open: the run was reopened and the manager got the message. */
  | 'continued'
  /** The run had finished and its manager process was gone: its conversation was resumed with the message. */
  | 'resumed'
  /** No resumable conversation: a new manager continues the run from its completion log. */
  | 'restarted'
  /** The run had been stopped partway: it was resumed and picks up where it stopped, with the message. */
  | 'unpaused'
  /** The manager is gone while workers / QA still run: the message continues the run once they finish. */
  | 'held';

export interface TaskMessageResult {
  ok: boolean;
  delivery?: TaskMessageDelivery;
  /** Who received it, e.g. "Manager", "Worker W2 · Login form". */
  target?: string;
  error?: string;
}

export interface TaskMessageOptions {
  /** The agent the user is looking at (CLI runs): it gets the message while it is working. Default: the manager. */
  ptySessionId?: string;
  /** In-app pipeline: the worker piece whose step the user is looking at (default: the manager). */
  pieceId?: string;
  /** Fired when a 'queued' message actually reaches the agent. */
  onDelivered?: () => void;
  /** Fired when a 'queued' message could not be delivered (the agent ended first). */
  onDropped?: () => void;
}

/** Short status shown next to a sent message. */
export function describeTaskMessage(result: TaskMessageResult): string {
  if (!result.ok) return result.error || 'Could not deliver the message.';
  const to = result.target || 'the agent';
  switch (result.delivery) {
    case 'queued':
      return `Queued for ${to} — delivered as soon as it can take input`;
    case 'continued':
      return `Continuing the task — ${to} picked it up`;
    case 'resumed':
      return `Continuing the task — resumed ${to}'s conversation`;
    case 'restarted':
      return `Continuing the task — a new ${to} picks up from the completion log`;
    case 'unpaused':
      return `Resuming the stopped run — ${to} picks up where it stopped`;
    case 'held':
      return `Held — continues the task once its running agents finish`;
    default:
      return `Sent to ${to}`;
  }
}
