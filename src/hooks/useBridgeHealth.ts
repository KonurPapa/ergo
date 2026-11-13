import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { latestBridgeVersion, type BridgeStatus } from '../lib/bridgeClient';
import { clearBridgeFailure, compareVersions, getBridgeFailure, subscribeBridgeFailure } from '../lib/bridgeHealth';

export type BridgeHealth =
  /** Connected and nothing known to be wrong (or not connected: the status bar covers that). */
  | { state: 'ok'; latest: string | null }
  /** The bridge can't start agents on this computer. `message` is the technical reason. */
  | { state: 'broken'; message: string; latest: string | null; updateAvailable: boolean }
  /** An Ergo Bridge app older than the newest published release. */
  | { state: 'update-available'; latest: string };

/**
 * How the connected bridge is doing: broken (it reports a problem, or an agent start failed for a bridge-side
 * reason), out of date (an Ergo Bridge app older than the newest release), or fine. Too old for this web app at all
 * (below MIN_BRIDGE_PROTOCOL) is BridgeUpdateBanner's own check.
 */
export function useBridgeHealth(status: BridgeStatus): BridgeHealth {
  const failure = useSyncExternalStore(subscribeBridgeFailure, getBridgeFailure);
  const info = status.isConnected ? status.bridgeInfo : undefined;
  const desktop = info?.kind === 'desktop';
  const [latest, setLatest] = useState<string | null>(null);

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    void latestBridgeVersion().then((v) => {
      if (!cancelled) setLatest(v);
    });
    return () => {
      cancelled = true;
    };
  }, [desktop]);

  // A failure belongs to the bridge that produced it: forget it once the bridge comes back (quit and reopened) or
  // changes version (updated or reinstalled).
  const seen = useRef<{ connected: boolean; version?: string }>({ connected: status.isConnected, version: info?.version });
  useEffect(() => {
    const prev = seen.current;
    if ((status.isConnected && !prev.connected) || (info?.version && prev.version && info.version !== prev.version)) {
      clearBridgeFailure();
    }
    seen.current = { connected: status.isConnected, version: info?.version ?? prev.version };
  }, [status.isConnected, info?.version]);

  if (!info) return { state: 'ok', latest };
  const updateAvailable = desktop && !!latest && compareVersions(latest, info.version) > 0;
  // A bridge that reports its problems (protocol 8+) is the authority; an older one is judged by what failed.
  const problem = Array.isArray(info.problems) ? info.problems[0]?.message : failure;
  if (problem) return { state: 'broken', message: problem, latest, updateAvailable };
  if (updateAvailable && latest) return { state: 'update-available', latest };
  return { state: 'ok', latest };
}
