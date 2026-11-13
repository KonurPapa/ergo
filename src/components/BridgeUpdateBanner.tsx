import React, { useEffect, useRef, useState } from 'react';
import { ArrowDownCircle, Copy, Check, Loader2, RefreshCw, Wrench, X } from 'lucide-react';
import { bridgeClient, getBridgeDownload, type BridgeStatus } from '../lib/bridgeClient';
import { MIN_BRIDGE_PROTOCOL, type BridgeInfo, type BridgeUpdateState } from '../lib/bridgeProtocol';
import { explainBridgeError } from '../lib/bridgeHealth';
import { useBridgeHealth } from '../hooks/useBridgeHealth';
import { BridgeDownloadButton } from './BridgeDownloadButton';
import { Button, Icon, IconButton } from './ui';

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

const UPDATE_IN_PROGRESS: ReadonlySet<BridgeUpdateState['status']> = new Set(['checking', 'downloading', 'ready', 'installing']);

/**
 * Asks an Ergo Bridge app to update now. `requested` stays true until the heartbeat shows the bridge's own progress;
 * `failed` when the update ended in an error (the steps then fall back to downloading it by hand).
 */
function useBridgeSelfUpdate(info: BridgeInfo | null | undefined) {
  const [requested, setRequested] = useState(false);
  const status = info?.update?.status;
  const inProgress = !!status && UPDATE_IN_PROGRESS.has(status);
  useEffect(() => {
    if (status && status !== 'idle' && status !== 'checking') setRequested(false);
  }, [status]);
  const start = () => {
    setRequested(true);
    void bridgeClient.fetch('/api/bridge/update', { method: 'POST' }).catch(() => setRequested(false));
  };
  return {
    start,
    busy: requested || inProgress,
    progress: inProgress && info ? describe(info).text : requested ? 'Starting the update…' : null,
    failed: status === 'error',
  };
}

const CopyDetailsButton: React.FC<{ status: BridgeStatus; message: string }> = ({ status, message }) => {
  const [copied, setCopied] = useState(false);
  const info = status.bridgeInfo;
  const copy = () => {
    const lines = [
      `Ergo Bridge ${info?.version ?? 'unknown version'} (${info?.kind ?? 'unknown'}, protocol ${info?.protocol ?? '?'}) at ${status.bridgeUrl}`,
      `Browser: ${navigator.userAgent}`,
      message,
    ];
    void navigator.clipboard?.writeText(lines.join('\n')).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <Button size="sm" variant="ghost" icon={copied ? Check : Copy} onClick={copy}>
      {copied ? 'Copied' : 'Copy details'}
    </Button>
  );
};

/** Platform-specific wording for installing a freshly downloaded Ergo Bridge over the old one. */
function installStep(platform: string | undefined): React.ReactNode {
  switch (platform) {
    case 'Windows':
      return <>Open the downloaded <strong>Ergo-Bridge-Setup.exe</strong> to install it over the old one.</>;
    case 'macOS':
      return <>Open the downloaded <strong>Ergo-Bridge.dmg</strong> and drag Ergo Bridge into Applications, replacing the old one.</>;
    case 'Linux':
      return (
        <>
          Replace your old <strong>Ergo-Bridge.AppImage</strong> with the downloaded one. If it won't open, right-click it, choose
          Properties, and allow it to run as a program.
        </>
      );
    default:
      return <>Install the downloaded Ergo Bridge over the old one.</>;
  }
}

/**
 * What's wrong with the bridge and exactly how to fix it, as numbered steps. Shown at the top of the app while the
 * bridge is broken, and in the status bar's bridge popover.
 */
export const BridgeFixSteps: React.FC<{
  status: BridgeStatus;
  message: string;
  latest: string | null;
  updateAvailable: boolean;
}> = ({ status, message, latest, updateAvailable }) => {
  const info = status.bridgeInfo;
  const update = useBridgeSelfUpdate(info);
  const platform = getBridgeDownload()?.platform;

  if (info?.kind === 'source') {
    return (
      <>
        <ol className="eg-steps">
          <li>
            <span>
              Stop the bridge: press <strong>Ctrl+C</strong> in the terminal running <code>npm run dev</code>.
            </span>
          </li>
          <li>
            <span>
              In the Ergo folder{status.appDir ? <> (<code>{status.appDir}</code>)</> : null}, run <code>npm install</code>, then{' '}
              <code>npm rebuild node-pty</code>.
            </span>
          </li>
          <li>
            <span>
              Start it again with <code>npm run dev</code>, then run your task again.
            </span>
          </li>
        </ol>
        <div className="eg-banner-actions">
          <CopyDetailsButton status={status} message={message} />
        </div>
      </>
    );
  }

  // The Ergo Bridge app can update itself to a fixed release: one click, no reinstall.
  if (updateAvailable && !update.failed) {
    return (
      <>
        <ol className="eg-steps">
          <li>
            <span>
              Click <strong>Update Ergo Bridge</strong> below. It downloads version {latest} and restarts by itself.
            </span>
          </li>
          <li>
            <span>Wait for this message to go away (about a minute).</span>
          </li>
          <li>
            <span>Run your task again.</span>
          </li>
        </ol>
        {update.progress && <p className="eg-bridge-fix-progress">{update.progress}</p>}
        <div className="eg-banner-actions">
          <Button size="sm" variant="primary" icon={RefreshCw} onClick={update.start} disabled={update.busy}>
            {update.busy ? 'Updating…' : 'Update Ergo Bridge'}
          </Button>
          <CopyDetailsButton status={status} message={message} />
        </div>
      </>
    );
  }

  const newestInstalled = !!latest && !!info?.version && latest === info.version;
  return (
    <>
      <ol className="eg-steps">
        <li>
          <span>
            Quit Ergo Bridge: click its icon in the {platform === 'macOS' ? 'menu bar' : 'system tray'} and choose{' '}
            <strong>Quit Ergo Bridge</strong>.
          </span>
        </li>
        <li>
          <span>Download Ergo Bridge again with the button below.</span>
        </li>
        <li>
          <span>{installStep(platform)}</span>
        </li>
        <li>
          <span>Open Ergo Bridge. Ergo reconnects by itself in a few seconds; then run your task again.</span>
        </li>
      </ol>
      {newestInstalled && (
        <p className="eg-bridge-fix-progress">
          You already have the newest Ergo Bridge ({info?.version}). If this message comes back after reinstalling, the release itself is
          broken: copy the details and report it.
        </p>
      )}
      <div className="eg-banner-actions">
        <BridgeDownloadButton size="sm" />
        <CopyDetailsButton status={status} message={message} />
      </div>
    </>
  );
};

const DISMISSED_UPDATE_KEY = 'ergo_bridge_update_dismissed';

/** A newer Ergo Bridge is published: say so in one line, with a one-click update. Dismissed per version. */
const UpdateAvailableStrip: React.FC<{ status: BridgeStatus; latest: string }> = ({ status, latest }) => {
  const info = status.bridgeInfo;
  const update = useBridgeSelfUpdate(info);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISSED_UPDATE_KEY) === latest;
    } catch {
      return false;
    }
  });
  if (dismissed && !update.busy) return null;
  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISSED_UPDATE_KEY, latest);
    } catch {}
  };
  return (
    <div className="dlg-strip" role="status">
      {update.busy ? (
        <Loader2 size={14} strokeWidth={1.75} className="spin-animate dlg-strip-icon" aria-hidden="true" />
      ) : (
        <ArrowDownCircle size={14} strokeWidth={1.75} className="dlg-strip-icon" aria-hidden="true" />
      )}
      <span className="dlg-strip-text">
        {update.progress ??
          (update.failed
            ? 'Ergo Bridge couldn’t update itself. Quit it from its tray icon, download the new version, and install it over the old one.'
            : `A newer Ergo Bridge is available: version ${latest} (you have ${info?.version}). It installs by itself when no agents are running, or you can update now.`)}
      </span>
      {update.failed ? (
        getBridgeDownload() && <BridgeDownloadButton subtle size="sm" />
      ) : (
        <Button size="sm" onClick={update.start} disabled={update.busy}>
          Update now
        </Button>
      )}
      {!update.busy && <IconButton icon={X} label="Dismiss" size="sm" onClick={dismiss} />}
    </div>
  );
};

/**
 * The bridge's health at the top of the app:
 * - broken (it can't start agents on this computer): what went wrong and numbered steps to fix it;
 * - older than this web app needs: an Ergo Bridge app is asked to update right away (it downloads, then installs and
 *   restarts once no agent is running); the heartbeat shows its progress;
 * - a newer release is out: one line with "Update now".
 * Each goes away by itself once the bridge reconnects fixed or updated.
 */
export const BridgeUpdateBanner: React.FC<{ status: BridgeStatus }> = ({ status }) => {
  const outdated = isBridgeOutdated(status);
  const health = useBridgeHealth(status);
  const info = status.bridgeInfo ?? null;
  const requested = useRef(false);

  useEffect(() => {
    if (!outdated || info?.kind !== 'desktop' || requested.current) return;
    requested.current = true;
    void bridgeClient.fetch('/api/bridge/update', { method: 'POST' }).catch(() => {});
  }, [outdated, info?.kind]);

  if (health.state === 'broken') {
    return (
      <div className="eg-banner eg-banner-danger eg-bridge-fix" role="alert">
        <Icon icon={Wrench} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="eg-banner-title">Ergo Bridge can't start agents on this computer</div>
          <div className="eg-banner-text">
            {explainBridgeError(health.message)} This is a problem with the Ergo Bridge app, not with your tasks or your AI account. To fix
            it:
          </div>
          <BridgeFixSteps status={status} message={health.message} latest={health.latest} updateAvailable={health.updateAvailable} />
        </div>
      </div>
    );
  }

  if (outdated) {
    const { text, busy, offerDownload } = describe(info);
    return (
      <div className={`dlg-strip ${offerDownload ? 'dlg-strip-warning' : ''}`} role="status">
        {busy ? (
          <Loader2 size={14} strokeWidth={1.75} className="spin-animate dlg-strip-icon" aria-hidden="true" />
        ) : (
          <ArrowDownCircle size={14} strokeWidth={1.75} className="dlg-strip-icon" aria-hidden="true" />
        )}
        <span className="dlg-strip-text">{text}</span>
        {offerDownload && getBridgeDownload() && <BridgeDownloadButton subtle size="sm" />}
      </div>
    );
  }

  if (health.state === 'update-available') return <UpdateAvailableStrip status={status} latest={health.latest} />;
  return null;
};
