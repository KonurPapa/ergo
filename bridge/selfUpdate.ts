/**
 * What the bridge tells the web app about itself (protocol, version, kind, update progress) and how it updates.
 * The Ergo Bridge desktop app registers a host (desktop/src/bridge-process.ts): its version, the updater's state, and
 * a way to ask its main process to check for an update. A bridge run from a checkout (`npm run dev`, `npm run bridge`)
 * has no host and reports kind 'source'.
 */
import { BRIDGE_PROTOCOL, type BridgeInfo, type BridgeUpdateState } from '../src/lib/bridgeProtocol.ts';

export interface BridgeHost {
  version: string;
  getUpdate(): BridgeUpdateState;
  /** Ask the app to check for (and download) an update now; it installs once no agent session is running. */
  requestUpdate(): void;
  /** The OS file dialog (Electron's, from the main process): chosen absolute paths, [] when cancelled. */
  pickFiles?(opts: { defaultPath?: string }): Promise<string[]>;
}

let host: BridgeHost | null = null;
let countActiveSessions: () => number = () => 0;

export function setBridgeHost(next: BridgeHost): void {
  host = next;
}

/** Registered by the bridge's PTY layer: agent sessions still running (an update waits for them). */
export function setActiveSessionCounter(counter: () => number): void {
  countActiveSessions = counter;
}

export function activeSessionCount(): number {
  try {
    return countActiveSessions();
  } catch {
    return 0;
  }
}

export function bridgeInfo(): BridgeInfo {
  return host
    ? { protocol: BRIDGE_PROTOCOL, version: host.version, kind: 'desktop', update: host.getUpdate() }
    : { protocol: BRIDGE_PROTOCOL, version: 'source', kind: 'source' };
}

/** Starts an update; false when this bridge can't update itself (it runs from a checkout). */
export function requestBridgeUpdate(): boolean {
  if (!host) return false;
  host.requestUpdate();
  return true;
}

/** The desktop app's own file dialog; null when this bridge has none (it runs from a checkout: bridge/plugins.ts falls back to the OS's dialog commands). */
export function hostFilePicker(): BridgeHost['pickFiles'] | null {
  return host?.pickFiles ? host.pickFiles.bind(host) : null;
}
