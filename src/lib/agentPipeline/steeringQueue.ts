/**
 * Mid-run steering for the in-app pipeline: messages the user sends from the prompt box while the run works.
 *
 * App pushes messages; each agent loop (providerLoop) drains the ones meant for it at its next round boundary and
 * appends them to the END of its conversation as a user turn (earlier turns, tools and the cached prefix are never
 * touched). A message addressed to a worker that is no longer running goes to the manager; once the manager's loops
 * are done for the attempt, the Verifier takes the manager's messages. Whatever no loop took by the end of the run
 * is returned by close() and continues the run as a follow-up.
 */
import type { AgentRole } from '../../types';

export interface SteeringItem {
  id: string;
  text: string;
  /** Worker piece the user addressed (they were looking at its step); undefined = the manager. */
  pieceId?: string;
  queuedAt: string;
}

export interface SteeringDelivery {
  item: SteeringItem;
  /** The agent loop that received it. */
  role: AgentRole;
  pieceId?: string;
  /** The pipeline run it was delivered into. */
  runId: string;
}

/** How a steering message is framed when appended to an agent's conversation. */
export function formatSteeringMessage(text: string): string {
  return `MESSAGE FROM THE USER (sent while you are working — take it into account from now on; it overrides earlier instructions where they conflict):\n${text.trim()}`;
}

export class SteeringQueue {
  /** Set by the pipeline when the run starts (recorded with each delivery). */
  runId = '';
  private items: SteeringItem[] = [];
  private readonly activeWorkers = new Set<string>();
  private managerDone = false;
  private closed = false;
  private seq = 0;

  private readonly onDelivered?: (delivery: SteeringDelivery) => void;

  constructor(onDelivered?: (delivery: SteeringDelivery) => void) {
    this.onDelivered = onDelivered;
  }

  attach(runId: string): void {
    this.runId = runId;
  }

  isOpen(): boolean {
    return !this.closed;
  }

  /** Queue a message for the running agents. Null once the run has ended (send it as a follow-up instead). */
  push(text: string, pieceId?: string): SteeringItem | null {
    const clean = String(text || '').trim();
    if (this.closed || !clean) return null;
    const item: SteeringItem = {
      id: `steer-${Date.now().toString(36)}-${++this.seq}`,
      text: clean,
      ...(pieceId ? { pieceId } : {}),
      queuedAt: new Date().toISOString(),
    };
    this.items.push(item);
    return item;
  }

  /** Messages not yet taken by any agent loop. */
  pending(): SteeringItem[] {
    return [...this.items];
  }

  setWorkerActive(pieceId: string, active: boolean): void {
    if (active) this.activeWorkers.add(pieceId);
    else this.activeWorkers.delete(pieceId);
  }

  /** The manager's loops are done for this attempt (Verifier / logger next) — or running again (false). */
  setManagerDone(done: boolean): void {
    this.managerDone = done;
  }

  /**
   * Called by an agent loop at a round boundary: removes and returns the messages for this agent (and reports each
   * delivery). Worker loops take only their own; the manager also takes messages for workers that are no longer
   * running; the verifier takes the manager's once the manager is done.
   */
  drain(role: AgentRole, pieceId?: string): SteeringItem[] {
    if (this.items.length === 0) return [];
    const forManager = (it: SteeringItem) => !it.pieceId || !this.activeWorkers.has(it.pieceId);
    const take = (it: SteeringItem): boolean => {
      if (role === 'worker') return Boolean(pieceId) && it.pieceId === pieceId;
      if (role === 'manager') return forManager(it);
      if (role === 'verifier') return this.managerDone && forManager(it);
      return false;
    };
    const taken = this.items.filter(take);
    if (taken.length === 0) return [];
    this.items = this.items.filter((it) => !taken.includes(it));
    for (const item of taken) {
      try {
        this.onDelivered?.({ item, role, ...(pieceId ? { pieceId } : {}), runId: this.runId });
      } catch (err) {
        console.warn('[Ergo steering] delivery callback failed:', err);
      }
    }
    return taken;
  }

  /** drain() formatted for appending to a conversation. */
  drainTexts(role: AgentRole, pieceId?: string): string[] {
    return this.drain(role, pieceId).map((it) => formatSteeringMessage(it.text));
  }

  /** The run ended: stop accepting messages and return the ones no agent took (they continue the run as a follow-up). */
  close(): SteeringItem[] {
    this.closed = true;
    const left = this.items;
    this.items = [];
    return left;
  }
}
