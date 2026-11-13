/**
 * Telling bridge problems apart from task problems. When the Ergo Bridge app on the user's computer is broken or out of
 * date, every agent fails to start with a low-level error (e.g. node-pty's "Cannot find module './prebuilds/linux-x64'"),
 * which reads like a bug in Ergo or the task. This module recognizes those errors, explains them in plain words, and
 * remembers the last one so the app can show how to fix the bridge (BridgeUpdateBanner, the status bar).
 *
 * A bridge on protocol 8+ reports its own problems with its info (BridgeInfo.problems); for older bridges the web app
 * only learns from the errors agent starts return.
 */

/** Errors that come from the bridge app itself rather than from the task, the agent CLI or the user's AI account. */
const BRIDGE_SIDE_ERROR =
  /Failed to load native module|node-pty|pty\.node|Embedded terminals are unavailable|GLIBC_\d|NODE_MODULE_VERSION|did not self-register/i;

export function isBridgeSideError(message: string | null | undefined): boolean {
  return !!message && BRIDGE_SIDE_ERROR.test(message);
}

/** What an agent start that failed for a bridge-side reason reports, in place of the technical error. */
export const BRIDGE_FAILURE_SUMMARY =
  "Ergo Bridge on this computer couldn't start the agent. This is a problem with the Ergo Bridge app, not with your task: follow the steps at the top of the screen to fix it.";

/** The cause of a bridge-side error in plain words. */
export function explainBridgeError(message: string): string {
  const glibc = message.match(/GLIBC_(\d+\.\d+)/);
  if (glibc) {
    return `This copy of Ergo Bridge was built for a newer version of Linux than this computer has (it needs glibc ${glibc[1]}).`;
  }
  if (/NODE_MODULE_VERSION|did not self-register|wrong ELF class|invalid ELF|not a valid Win32|incompatible architecture/i.test(message)) {
    return 'Part of Ergo Bridge was built for a different kind of computer than this one.';
  }
  return 'The part of Ergo Bridge that starts agents failed to load.';
}

/** Compares dotted version numbers ("0.10.0" > "0.9.2"); non-numeric parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// The last bridge-side failure this page saw. Cleared when an agent starts, or when the bridge restarts or changes version.
let lastFailure: string | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function reportBridgeFailure(message: string): void {
  if (lastFailure === message) return;
  lastFailure = message;
  emit();
}

export function clearBridgeFailure(): void {
  if (lastFailure === null) return;
  lastFailure = null;
  emit();
}

export function getBridgeFailure(): string | null {
  return lastFailure;
}

export function subscribeBridgeFailure(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
