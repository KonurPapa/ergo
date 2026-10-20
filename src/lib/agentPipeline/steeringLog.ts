/**
 * Steering log — every message the user sends to a running (or finished) task through the prompt box.
 *
 * The prompt box calls recordSteeringMessage for each message it delivers. Model calibration (#3) reads these to
 * learn when a model wasn't good enough ("that's wrong, try again", "use a stronger model") or more than needed
 * ("switch to a cheaper model"); ordinary steering notes carry no signal.
 */
import type { AgentRole } from '../../types';

export interface SteeringMessage {
  taskId: string;
  /** The run the message belongs to (a post-run follow-up continues that run). */
  runId: string;
  /** Which agent received it: manager / worker / hardener (QA). */
  role: AgentRole;
  text: string;
  /** mid-run: the agent was working · post-run: the run had finished and the message continued it. */
  phase: 'mid-run' | 'post-run';
  at: string;
}

type Listener = (message: SteeringMessage) => void;
const listeners = new Set<Listener>();

/** Called by the prompt box (CLI runs and the in-app pipeline) for every message it delivers. Never throws. */
export function recordSteeringMessage(message: Omit<SteeringMessage, 'at'> & { at?: string }): void {
  const full: SteeringMessage = { ...message, at: message.at || new Date().toISOString() };
  for (const listener of listeners) {
    try {
      listener(full);
    } catch (err) {
      console.warn('[Ergo steering] listener failed:', err);
    }
  }
}

export function onSteeringMessage(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
