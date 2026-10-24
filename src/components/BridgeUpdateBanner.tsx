import React, { useEffect, useRef } from 'react';
import { ArrowDownCircle, Loader2 } from 'lucide-react';
import { bridgeClient, getBridgeDownload, type BridgeStatus } from '../lib/bridgeClient';
import { MIN_BRIDGE_PROTOCOL, type BridgeInfo } from '../lib/bridgeProtocol';
import { BridgeDownloadButton } from './BridgeDownloadButton';

/** The connected bridge is too old for this web app (or too old to say: it predates the version handshake). */
export function isBridgeOutdated(status: BridgeStatus): boolean {
  return status.isConnected && status.bridgeInfo !== undefined && (!status.bridgeInfo || status.bridgeInfo.protocol < MIN_BRIDGE_PROTOCOL);
}

function describe(info: BridgeInfo | null): { text: string; busy: boolean; offerDownload: boolean } {
  if (!info) {
    return {
      text: 'Your Ergo Bridge is out of date. Quit Ergo Bridge from its tray icon and open it again: it installs the update it has already downloaded. If that doesn’t help, download the latest version.',
      busy: false,
      offerDownload: true,
    };
  }
  if (info.kind === 'source') {
    return {
      text: 'The bridge running from your Ergo checkout is out of date: pull the latest code (git pull), then restart it (npm run dev).',
      busy: false,
      offerDownload: false,
    };
  }
  const u = info.update ?? { status: 'idle' as const };
  switch (u.status) {
    case 'checking':
      return { text: 'Updating your Ergo Bridge: looking for the new version…', busy: true, offerDownload: false };
    case 'downloading':
      return { text: `Updating your Ergo Bridge: downloading ${u.version ?? 'the new version'} (${u.percent ?? 0}%)…`, busy: true, offerDownload: false };
    case 'ready':
      return u.waitingForSessions
        ? {
            text: `The Ergo Bridge update is ready and installs as soon as your running agents finish (${u.waitingForSessions} running).`,
            busy: true,
            offerDownload: false,
          }
        : { text: 'Installing the Ergo Bridge update…', busy: true, offerDownload: false };
    case 'installing':
      return { text: 'Installing the Ergo Bridge update: it restarts and reconnects by itself in a few seconds.', busy: true, offerDownload: false };
    case 'up-to-date':
      return { text: 'This Ergo app needs a newer Ergo Bridge than the one published so far. Try again shortly.', busy: false, offerDownload: false };
    case 'error':
      return { text: `Ergo Bridge couldn’t update itself${u.message ? ` (${u.message})` : ''}. Download the latest version to update it.`, busy: false, offerDownload: true };
    default:
      return { text: 'Updating your Ergo Bridge…', busy: true, offerDownload: false };
  }
}

/**
 * Shown while the connected bridge is older than this web app needs. An Ergo Bridge app is asked to update right away
 * (it downloads, then installs and restarts once no agent is running); the heartbeat shows its progress and the
 * banner goes away when the updated bridge reconnects.
 */
export const BridgeUpdateBanner: React.FC<{ status: BridgeStatus }> = ({ status }) => {
  const outdated = isBridgeOutdated(status);
  const info = status.bridgeInfo ?? null;
  const requested = useRef(false);

  useEffect(() => {
    if (!outdated || info?.kind !== 'desktop' || requested.current) return;
    requested.current = true;
    void bridgeClient.fetch('/api/bridge/update', { method: 'POST' }).catch(() => {});
  }, [outdated, info?.kind]);

  if (!outdated) return null;
  const { text, busy, offerDownload } = describe(info);
  return (
    <div
      role="status"
      style={{
        background: 'linear-gradient(90deg, rgba(59, 130, 246, 0.16) 0%, rgba(99, 102, 241, 0.12) 100%)',
        borderBottom: '1px solid rgba(59, 130, 246, 0.35)',
        padding: '0.45rem 1.25rem',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '1rem',
        zIndex: 40,
        fontSize: '0.8rem',
        color: 'var(--text-bright)',
        flexWrap: 'wrap',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
        {busy ? <Loader2 size={14} className="spin-animate" color="#60a5fa" /> : <ArrowDownCircle size={14} color="#60a5fa" />}
        <span>{text}</span>
      </div>
      {offerDownload && getBridgeDownload() && (
        <BridgeDownloadButton style={{ fontSize: '0.74rem', fontWeight: 700, padding: '0.35rem 0.75rem' }} />
      )}
    </div>
  );
};
