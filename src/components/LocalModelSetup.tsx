/**
 * Local AI model (Qwen 2.5 Coder 0.5B via llama.cpp) — install / status UI shared by the
 * onboarding wizard and the Settings modal.
 *
 * The bridge does the actual work (download, checksum, extract, start); this file only polls
 * `/api/local-model/status` through `src/lib/localModel/client.ts` and renders the result.
 * Client responses are normalised defensively so a missing bridge or an unexpected payload
 * renders as "can't reach the bridge" instead of throwing.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  getLocalModelStatus,
  installLocalModel,
  cancelLocalModelInstall,
  uninstallLocalModel
} from '../lib/localModel/client';
import {
  AlertCircle,
  CheckCircle2,
  Cloud,
  Cpu,
  Download,
  HardDrive,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X
} from 'lucide-react';

export type LocalModelMode = 'local' | 'cloud' | 'unset';
export type LocalModelState = 'not_installed' | 'installing' | 'installed' | 'starting' | 'ready' | 'error';
export type LocalModelPhase = 'runtime' | 'model' | 'verifying' | 'extracting';

/** The fields of `GET /api/local-model/status` the UI reads. */
export interface LocalModelStatusView {
  state: LocalModelState;
  phase?: LocalModelPhase;
  bytesDone?: number;
  bytesTotal?: number;
  error?: string;
  platformSupported: boolean;
  sizes: { runtimeBytes: number; modelBytes: number };
  installDir?: string;
}

export type LocalModelBusy = 'install' | 'cancel' | 'uninstall' | null;

export interface LocalModelInstallController {
  /** Last good status from the bridge (kept through transient poll failures). */
  status: LocalModelStatusView | null;
  /** True once the first status request has finished (successfully or not). */
  checked: boolean;
  /** The bridge did not answer (offline, or an older bridge without the endpoint). */
  unreachable: boolean;
  busy: LocalModelBusy;
  /** Error from the last install / cancel / uninstall request itself. */
  actionError: string | null;
  /** The user started an install from this screen during this session. */
  installRequested: boolean;
  install: () => Promise<void>;
  cancel: () => Promise<void>;
  uninstall: () => Promise<void>;
  refresh: () => Promise<void>;
}

const POLL_MS = 500;
/** After "Install" is clicked, keep polling this long even if the bridge still says not_installed. */
const INSTALL_GRACE_MS = 8_000;
/** After the files land, keep polling this long to see the server reach `ready`. */
const START_WATCH_MS = 25_000;
const MAX_POLL_FAILURES = 3;

/** Used only until the bridge reports exact sizes (linux-x64 runtime + the pinned GGUF). */
const FALLBACK_SIZES = { runtimeBytes: 17_851_611, modelBytes: 491_400_064 };
const DEFAULT_INSTALL_DIR = '~/.ergo/local-model';

const STATES: ReadonlySet<string> = new Set(['not_installed', 'installing', 'installed', 'starting', 'ready', 'error']);
const PHASES: ReadonlySet<string> = new Set(['runtime', 'model', 'verifying', 'extracting']);

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function normalizeLocalModelStatus(raw: unknown): LocalModelStatusView | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.state !== 'string' || !STATES.has(r.state)) return null;
  const sizesRaw = (r.sizes && typeof r.sizes === 'object' ? r.sizes : {}) as Record<string, unknown>;
  return {
    state: r.state as LocalModelState,
    phase: typeof r.phase === 'string' && PHASES.has(r.phase) ? (r.phase as LocalModelPhase) : undefined,
    bytesDone: finiteNumber(r.bytesDone),
    bytesTotal: finiteNumber(r.bytesTotal),
    error: typeof r.error === 'string' && r.error.trim() ? r.error.trim() : undefined,
    platformSupported: r.platformSupported !== false,
    sizes: {
      runtimeBytes: finiteNumber(sizesRaw.runtimeBytes) || FALLBACK_SIZES.runtimeBytes,
      modelBytes: finiteNumber(sizesRaw.modelBytes) || FALLBACK_SIZES.modelBytes
    },
    installDir: typeof r.installDir === 'string' && r.installDir.trim() ? r.installDir.trim() : undefined
  };
}

/** Error text from an install/cancel/uninstall response, or null when it looks fine. */
function actionResultError(res: unknown, fallback: string): string | null {
  if (res === null || res === false) return fallback;
  if (res && typeof res === 'object') {
    const r = res as Record<string, unknown>;
    if (r.success === false) return typeof r.error === 'string' && r.error.trim() ? r.error.trim() : fallback;
  }
  return null;
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export const isLocalModelInstalled = (status: LocalModelStatusView | null | undefined): boolean =>
  !!status && (status.state === 'installed' || status.state === 'starting' || status.state === 'ready');

/** Decimal megabytes, like download sizes are usually quoted ("491.4 MB"). */
export function formatMB(bytes: number, digits = 1): string {
  const mb = bytes / 1_000_000;
  if (mb >= 1000) return `${(mb / 1000).toFixed(2)} GB`;
  return `${mb.toFixed(digits)} MB`;
}

export const totalDownloadBytes = (status: LocalModelStatusView | null): number => {
  const sizes = status?.sizes ?? FALLBACK_SIZES;
  return sizes.runtimeBytes + sizes.modelBytes;
};

/** For labels like "a small cloud model" that may start a sentence. */
const capitalize = (text: string): string => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text);

/** "Claude Haiku" reads as a name; "a small cloud model" / "your Ollama model" read as a description. */
const isProperName = (label: string): boolean => /^[A-Z0-9]/.test(label);

export const installDirOf = (status: LocalModelStatusView | null): string => status?.installDir || DEFAULT_INSTALL_DIR;

export function progressPercent(status: LocalModelStatusView | null): number | null {
  if (!status || status.state !== 'installing') return null;
  const { bytesDone, bytesTotal } = status;
  if (bytesDone === undefined || !bytesTotal) return null;
  return Math.max(0, Math.min(100, Math.round((bytesDone / bytesTotal) * 100)));
}

function phaseLabel(status: LocalModelStatusView): string {
  if (status.state === 'starting') return 'Starting the model';
  switch (status.phase) {
    case 'runtime':
      return 'Downloading the model runner (step 1 of 2)';
    case 'extracting':
      return 'Unpacking the model runner';
    case 'model':
      return 'Downloading the model (step 2 of 2)';
    case 'verifying':
      return 'Checking the download';
    default:
      return 'Preparing the download';
  }
}

function shouldPoll(status: LocalModelStatusView | null, installRequested: boolean, watchUntil: number): boolean {
  const watching = installRequested && Date.now() < watchUntil;
  if (!status) return watching;
  switch (status.state) {
    case 'installing':
    case 'starting':
      return true;
    case 'not_installed': // the bridge may not have flipped to `installing` yet right after the click
    case 'installed': // files are in place; the server is about to start
      return watching;
    default: // ready, error
      return false;
  }
}

/**
 * Status + actions for the local model. `enabled` fetches the status (and polls while an install
 * or start is in progress); an install started here keeps being watched while the host modal is
 * closed so `onInstalled` still fires when it finishes.
 */
export function useLocalModelInstall(opts: { enabled: boolean; onInstalled?: () => void }): LocalModelInstallController {
  const { enabled, onInstalled } = opts;
  const [status, setStatus] = useState<LocalModelStatusView | null>(null);
  const [checked, setChecked] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  const [busy, setBusy] = useState<LocalModelBusy>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [installRequested, setInstallRequested] = useState(false);
  const [pollTick, setPollTick] = useState(0);

  const mountedRef = useRef(true);
  const hasStatusRef = useRef(false);
  const failuresRef = useRef(0);
  const watchUntilRef = useRef(0);
  const notifiedRef = useRef(false);
  const onInstalledRef = useRef(onInstalled);

  useEffect(() => {
    onInstalledRef.current = onInstalled;
  }, [onInstalled]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchStatus = useCallback(async (): Promise<LocalModelStatusView | null> => {
    let raw: unknown = null;
    try {
      raw = await getLocalModelStatus();
    } catch {
      raw = null;
    }
    if (!mountedRef.current) return null;
    const next = normalizeLocalModelStatus(raw);
    setChecked(true);
    if (next) {
      failuresRef.current = 0;
      hasStatusRef.current = true;
      setUnreachable(false);
      setStatus(next);
    } else {
      failuresRef.current += 1;
      if (!hasStatusRef.current || failuresRef.current >= MAX_POLL_FAILURES) setUnreachable(true);
    }
    setPollTick((t) => t + 1);
    return next;
  }, []);

  const refresh = useCallback(async () => {
    failuresRef.current = 0;
    await fetchStatus();
  }, [fetchStatus]);

  // Fetch when the host screen becomes visible.
  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);

  // Poll while something is in progress.
  useEffect(() => {
    if (!enabled && !installRequested) return;
    if (failuresRef.current >= MAX_POLL_FAILURES) return;
    if (!shouldPoll(status, installRequested, watchUntilRef.current)) return;
    const timer = setTimeout(() => {
      void fetchStatus();
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [enabled, installRequested, status, pollTick, fetchStatus]);

  // Tell the host once an install started here has finished.
  useEffect(() => {
    if (!installRequested || notifiedRef.current || !isLocalModelInstalled(status)) return;
    notifiedRef.current = true;
    if (status?.state !== 'ready') watchUntilRef.current = Date.now() + START_WATCH_MS;
    onInstalledRef.current?.();
  }, [installRequested, status]);

  const install = useCallback(async () => {
    setBusy('install');
    setActionError(null);
    notifiedRef.current = false;
    watchUntilRef.current = Date.now() + INSTALL_GRACE_MS;
    setInstallRequested(true);
    let err: string | null = null;
    try {
      const res: unknown = await installLocalModel();
      err = actionResultError(res, "Ergo's local bridge didn't accept the install request.");
    } catch (e) {
      err = errorMessage(e, "Ergo's local bridge didn't accept the install request.");
    }
    const next = await fetchStatus();
    if (!mountedRef.current) return;
    // The status is authoritative: an install that is running (or done) wins over a failed reply.
    if (err && !(next && (next.state === 'installing' || isLocalModelInstalled(next)))) {
      setActionError(err);
      setInstallRequested(false);
    }
    setBusy(null);
  }, [fetchStatus]);

  const cancel = useCallback(async () => {
    setBusy('cancel');
    setActionError(null);
    try {
      const res: unknown = await cancelLocalModelInstall();
      const err = actionResultError(res, "Couldn't cancel the install.");
      if (err && mountedRef.current) setActionError(err);
    } catch (e) {
      if (mountedRef.current) setActionError(errorMessage(e, "Couldn't cancel the install."));
    }
    setInstallRequested(false);
    watchUntilRef.current = 0;
    await refresh();
    if (mountedRef.current) setBusy(null);
  }, [refresh]);

  const uninstall = useCallback(async () => {
    setBusy('uninstall');
    setActionError(null);
    try {
      const res: unknown = await uninstallLocalModel();
      const err = actionResultError(res, "Couldn't remove the local model.");
      if (err && mountedRef.current) setActionError(err);
    } catch (e) {
      if (mountedRef.current) setActionError(errorMessage(e, "Couldn't remove the local model."));
    }
    setInstallRequested(false);
    watchUntilRef.current = 0;
    await refresh();
    if (mountedRef.current) setBusy(null);
  }, [refresh]);

  return { status, checked, unreachable, busy, actionError, installRequested, install, cancel, uninstall, refresh };
}

/* ─────────────────────────── Shared pieces ─────────────────────────── */

export const LocalModelProgress: React.FC<{
  status: LocalModelStatusView;
  onCancel?: () => void;
  cancelling?: boolean;
  compact?: boolean;
}> = ({ status, onCancel, cancelling, compact }) => {
  const pct = progressPercent(status);
  const label = phaseLabel(status);
  const figures =
    pct !== null && status.bytesTotal
      ? `${formatMB(status.bytesDone ?? 0)} of ${formatMB(status.bytesTotal)} · ${pct}%`
      : null;
  return (
    <div className={`lm-progress${compact ? ' is-compact' : ''}`}>
      <div className="lm-progress-head">
        <span className="lm-progress-label">
          <Loader2 size={13} className="spin-animate" aria-hidden="true" />
          <span>{label}…</span>
        </span>
        {figures && <span className="lm-progress-figures">{figures}</span>}
      </div>
      <div
        className="lm-progress-track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
      >
        <div
          className={`lm-progress-fill${pct === null ? ' is-indeterminate' : ''}`}
          style={pct === null ? undefined : { width: `${pct}%` }}
        />
      </div>
      {onCancel && status.state === 'installing' && (
        <div className="lm-progress-foot">
          <button type="button" className="lm-btn lm-btn-ghost" onClick={onCancel} disabled={cancelling}>
            {cancelling ? <Loader2 size={13} className="spin-animate" /> : <X size={13} />}
            <span>{cancelling ? 'Cancelling…' : 'Cancel'}</span>
          </button>
        </div>
      )}
    </div>
  );
};

const Notice: React.FC<{
  tone: 'success' | 'error' | 'warn' | 'info';
  title: string;
  children?: React.ReactNode;
}> = ({ tone, title, children }) => (
  <div className={`lm-notice is-${tone}`} role={tone === 'error' ? 'alert' : undefined}>
    {tone === 'success' ? (
      <CheckCircle2 size={16} className="lm-notice-icon" aria-hidden="true" />
    ) : (
      <AlertCircle size={16} className="lm-notice-icon" aria-hidden="true" />
    )}
    <div className="lm-notice-body">
      <div className="lm-notice-title">{title}</div>
      {children && <div className="lm-notice-text">{children}</div>}
    </div>
  </div>
);

/* ─────────────────────────── Onboarding step ─────────────────────────── */

export interface LocalModelOnboardingStepProps {
  controller: LocalModelInstallController;
  mode: LocalModelMode;
  cloudLabel: string;
  /** Skip / "use the cloud model instead": set mode `cloud` and continue to the next step. */
  onUseCloud: () => void;
  /** Model already installed but mode isn't local yet. */
  onUseLocal: () => void;
}

export const LocalModelOnboardingStep: React.FC<LocalModelOnboardingStepProps> = ({
  controller,
  mode,
  cloudLabel,
  onUseCloud,
  onUseLocal
}) => {
  const { status, checked, unreachable, busy, actionError } = controller;
  const total = totalDownloadBytes(status);
  const sizes = status?.sizes ?? FALLBACK_SIZES;
  const installed = isLocalModelInstalled(status);
  const unsupported = !!status && !status.platformSupported && !installed;
  const errored = !unsupported && (status?.state === 'error' || (!!actionError && !installed && status?.state !== 'installing'));
  const useCloudLabel = `Use ${cloudLabel} instead`;

  const renderActions = () => {
    if (!checked || (busy === 'install' && !status)) {
      return (
        <div className="lm-checking">
          <Loader2 size={14} className="spin-animate" aria-hidden="true" />
          <span>Checking this computer…</span>
        </div>
      );
    }

    if (unreachable && !status) {
      return (
        <>
          <Notice tone="warn" title="Can't reach Ergo's local bridge">
            The model is installed through Ergo's bridge on your computer, and it isn't responding right now.
            You can connect it in the next step and install the model later from Settings.
          </Notice>
          <div className="lm-actions">
            <button type="button" className="lm-btn lm-btn-secondary" onClick={() => void controller.refresh()}>
              <RefreshCw size={14} />
              <span>Check again</span>
            </button>
            <button type="button" className="lm-btn lm-btn-secondary" onClick={onUseCloud}>
              <Cloud size={14} />
              <span>{useCloudLabel}</span>
            </button>
          </div>
        </>
      );
    }

    if (unsupported) {
      return (
        <>
          <Notice tone="warn" title="Not available on this computer">
            The local model doesn't support this operating system or processor yet. {capitalize(cloudLabel)} can
            handle these jobs instead.
          </Notice>
          <div className="lm-actions">
            <button type="button" className="lm-btn lm-btn-primary" onClick={onUseCloud}>
              <Cloud size={14} />
              <span>{useCloudLabel}</span>
            </button>
          </div>
        </>
      );
    }

    if (status?.state === 'installing') {
      return (
        <>
          <LocalModelProgress status={status} onCancel={() => void controller.cancel()} cancelling={busy === 'cancel'} />
          <p className="lm-footnote">You can go on to the next step. The download keeps going in the background.</p>
        </>
      );
    }

    if (installed && status) {
      const running = status.state === 'ready';
      return (
        <>
          <Notice
            tone="success"
            title={running ? 'Installed and running' : status.state === 'starting' ? 'Installed. Starting the model…' : 'Installed'}
          >
            {mode !== 'local'
              ? 'The model is on this computer and ready to use.'
              : running || status.state === 'starting'
                ? 'Ergo will use it for background decisions and autocomplete. You can remove it in Settings.'
                : 'It starts automatically when Ergo needs it. You can remove it in Settings.'}
          </Notice>
          {mode !== 'local' && (
            <div className="lm-actions">
              <span className="lm-inline-note">Ergo is set to use {cloudLabel} for these jobs right now.</span>
              <button type="button" className="lm-btn lm-btn-secondary" onClick={onUseLocal}>
                <Cpu size={14} />
                <span>Use the local model</span>
              </button>
            </div>
          )}
        </>
      );
    }

    if (errored) {
      return (
        <>
          <Notice tone="error" title="The install didn't finish">
            {status?.error || actionError || 'Something went wrong while installing.'}
          </Notice>
          <div className="lm-actions">
            <button
              type="button"
              className="lm-btn lm-btn-secondary"
              onClick={() => void controller.install()}
              disabled={busy !== null}
            >
              <RefreshCw size={14} className={busy === 'install' ? 'spin-animate' : undefined} />
              <span>Try again</span>
            </button>
            <button type="button" className="lm-btn lm-btn-primary" onClick={onUseCloud}>
              <Cloud size={14} />
              <span>{useCloudLabel}</span>
            </button>
          </div>
        </>
      );
    }

    // Not installed.
    return (
      <>
        <div className="lm-actions is-stacked">
          <button
            type="button"
            className="lm-btn lm-btn-primary lm-btn-wide"
            onClick={() => void controller.install()}
            disabled={busy !== null}
          >
            {busy === 'install' ? <Loader2 size={15} className="spin-animate" /> : <Download size={15} />}
            <span>{busy === 'install' ? 'Starting download…' : `Download & install (${formatMB(total, 0)})`}</span>
          </button>
          <button type="button" className="lm-btn lm-btn-secondary lm-btn-wide" onClick={onUseCloud}>
            <Cloud size={14} />
            <span>Skip — use {cloudLabel} instead</span>
          </button>
        </div>
        <p className="lm-footnote">
          {mode === 'cloud' ? `Ergo uses ${cloudLabel} for now. ` : 'Nothing is downloaded if you skip. '}
          You can install it later in Settings.
        </p>
      </>
    );
  };

  return (
    <div className="lm-step">
      <div className="lm-step-header">
        <div className="lm-step-icon" aria-hidden="true">
          <Cpu size={18} />
        </div>
        <div>
          <h3 className="lm-step-title">Local AI model</h3>
          <p className="lm-step-subtitle">Optional. A small AI model that runs on this computer.</p>
        </div>
      </div>

      <div className="lm-card">
        <p className="lm-lead">
          Ergo can run <strong>Qwen 2.5 Coder 0.5B</strong>, a small open model, on this computer. It makes quick
          background decisions, such as whether a task needs a separate verifier check, and suggests autocomplete text as
          you type. It runs privately: what it reads stays on your computer.
        </p>

        <ul className="lm-facts">
          <li className="lm-fact">
            <Download size={15} className="lm-fact-icon" aria-hidden="true" />
            <div>
              <div className="lm-fact-title">{formatMB(total, 0)} download</div>
              <div className="lm-fact-detail">
                Model {formatMB(sizes.modelBytes)} + runner {formatMB(sizes.runtimeBytes)}
              </div>
            </div>
          </li>
          <li className="lm-fact">
            <HardDrive size={15} className="lm-fact-icon" aria-hidden="true" />
            <div>
              <div className="lm-fact-title">Stays in Ergo's folder</div>
              <div className="lm-fact-detail lm-mono" title={installDirOf(status)}>
                {installDirOf(status)}
              </div>
            </div>
          </li>
          <li className="lm-fact">
            <ShieldCheck size={15} className="lm-fact-icon" aria-hidden="true" />
            <div>
              <div className="lm-fact-title">No admin rights needed</div>
              <div className="lm-fact-detail">Remove it anytime in Settings</div>
            </div>
          </li>
        </ul>

        {renderActions()}
      </div>
    </div>
  );
};

/* ─────────────────────────── Settings section ─────────────────────────── */

export interface LocalModelSettingsSectionProps {
  controller: LocalModelInstallController;
  mode: LocalModelMode;
  cloudLabel: string;
  onSetMode: (mode: 'local' | 'cloud') => void;
}

function settingsBadge(controller: LocalModelInstallController): { text: string; className: string } {
  const { status, checked, unreachable } = controller;
  if (!checked) return { text: 'CHECKING', className: 'badge' };
  if (!status) return { text: unreachable ? 'UNAVAILABLE' : 'CHECKING', className: 'badge' };
  if (!status.platformSupported && !isLocalModelInstalled(status)) return { text: 'NOT SUPPORTED', className: 'badge' };
  switch (status.state) {
    case 'ready':
      return { text: 'READY', className: 'badge badge-done' };
    case 'installed':
      return { text: 'INSTALLED', className: 'badge badge-done' };
    case 'starting':
      return { text: 'STARTING', className: 'badge badge-running' };
    case 'installing': {
      const pct = progressPercent(status);
      return { text: pct === null ? 'INSTALLING' : `INSTALLING ${pct}%`, className: 'badge badge-running' };
    }
    case 'error':
      return { text: 'ERROR', className: 'badge badge-error' };
    default:
      return { text: 'NOT INSTALLED', className: 'badge' };
  }
}

export const LocalModelSettingsSection: React.FC<LocalModelSettingsSectionProps> = ({
  controller,
  mode,
  cloudLabel,
  onSetMode
}) => {
  const { status, checked, unreachable, busy, actionError } = controller;
  const installed = isLocalModelInstalled(status);
  const unsupported = !!status && !status.platformSupported && !installed;
  const total = totalDownloadBytes(status);
  const badge = settingsBadge(controller);
  // "unset" behaves like cloud (nothing local is used), so show it that way.
  const effectiveMode: 'local' | 'cloud' = mode === 'local' ? 'local' : 'cloud';

  const handleUninstall = async () => {
    const ok = window.confirm(
      `Remove the local AI model?\n\nThis deletes about ${formatMB(total, 0)} from ${installDirOf(status)}. ` +
        `Ergo will use ${cloudLabel} for these jobs instead. You can install it again anytime.`
    );
    if (!ok) return;
    await controller.uninstall();
    if (mode === 'local') onSetMode('cloud');
  };

  const handleCancel = async () => {
    await controller.cancel();
    if (mode === 'local') onSetMode('cloud');
  };

  const renderStatus = () => {
    if (!checked) {
      return (
        <div className="lm-checking">
          <Loader2 size={13} className="spin-animate" aria-hidden="true" />
          <span>Checking…</span>
        </div>
      );
    }
    if (!status) {
      return (
        <div className="lm-status-row">
          <span className="lm-status-text">
            Ergo's local bridge isn't responding, so the model can't be checked or installed right now.
          </span>
          <button type="button" className="btn btn-secondary lm-settings-btn" onClick={() => void controller.refresh()}>
            <RefreshCw size={12} />
            <span>Check again</span>
          </button>
        </div>
      );
    }
    if (unsupported) {
      return (
        <div className="lm-status-row">
          <span className="lm-status-text">
            Not available for this operating system or processor yet. Ergo uses {cloudLabel} instead.
          </span>
        </div>
      );
    }
    if (status.state === 'installing') {
      return (
        <LocalModelProgress status={status} onCancel={() => void handleCancel()} cancelling={busy === 'cancel'} compact />
      );
    }
    if (installed) {
      const stateText =
        status.state === 'ready'
          ? 'Installed · ready'
          : status.state === 'starting'
            ? 'Installed · starting…'
            : 'Installed · starts when needed';
      return (
        <div className="lm-status-row">
          <div className="lm-status-text">
            <div className="lm-status-strong">
              <CheckCircle2 size={13} aria-hidden="true" />
              <span>{stateText}</span>
            </div>
            <div className="lm-mono lm-status-dir" title={installDirOf(status)}>
              {installDirOf(status)}
            </div>
          </div>
          <button
            type="button"
            className="btn btn-secondary lm-settings-btn lm-danger-text"
            onClick={() => void handleUninstall()}
            disabled={busy !== null}
          >
            {busy === 'uninstall' ? <Loader2 size={12} className="spin-animate" /> : <Trash2 size={12} />}
            <span>{busy === 'uninstall' ? 'Removing…' : 'Uninstall'}</span>
          </button>
        </div>
      );
    }
    if (status.state === 'error') {
      return (
        <>
          <Notice tone="error" title="The local model isn't working">
            {status.error || 'Something went wrong.'} Ergo uses {cloudLabel} until this is fixed.
          </Notice>
          <div className="lm-actions">
            <button
              type="button"
              className="btn btn-secondary lm-settings-btn"
              onClick={() => void controller.install()}
              disabled={busy !== null}
            >
              <RefreshCw size={12} className={busy === 'install' ? 'spin-animate' : undefined} />
              <span>Try again</span>
            </button>
            <button
              type="button"
              className="btn btn-secondary lm-settings-btn lm-danger-text"
              onClick={() => void handleUninstall()}
              disabled={busy !== null}
            >
              <Trash2 size={12} />
              <span>Remove files</span>
            </button>
          </div>
        </>
      );
    }
    // not_installed
    return (
      <div className="lm-status-row">
        <span className="lm-status-text">
          Not installed · {formatMB(total, 0)} download, stored in Ergo's folder. No admin rights needed.
        </span>
        <button
          type="button"
          className="btn btn-primary lm-settings-btn"
          onClick={() => void controller.install()}
          disabled={busy !== null}
        >
          {busy === 'install' ? <Loader2 size={12} className="spin-animate" /> : <Download size={12} />}
          <span>{busy === 'install' ? 'Starting…' : 'Install'}</span>
        </button>
      </div>
    );
  };

  return (
    <div className="lm-settings">
      <div className="lm-settings-head">
        <div className="lm-settings-title">
          <Cpu size={16} color="var(--accent-cyan)" aria-hidden="true" />
          <span>Local AI model</span>
          <span className={badge.className} style={{ fontSize: '0.65rem', padding: '0.1rem 0.4rem' }}>
            {badge.text}
          </span>
        </div>
      </div>

      <p className="lm-settings-desc">
        Qwen 2.5 Coder 0.5B runs privately on this computer for quick background decisions and autocomplete. When
        it's not in use, Ergo sends these jobs to {cloudLabel}.
      </p>

      <div className="lm-segmented" role="radiogroup" aria-label="Model for background decisions and autocomplete">
        <button
          type="button"
          role="radio"
          aria-checked={effectiveMode === 'local'}
          className={`lm-segment${effectiveMode === 'local' ? ' is-active' : ''}`}
          onClick={() => onSetMode('local')}
          disabled={!installed}
          title={installed ? 'Use the model on this computer' : 'Install the model first'}
        >
          <Cpu size={14} aria-hidden="true" />
          <span className="lm-segment-text">
            <span className="lm-segment-title">Local model</span>
            <span className="lm-segment-sub">{installed ? 'On this computer' : 'Install it first'}</span>
          </span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={effectiveMode === 'cloud'}
          className={`lm-segment${effectiveMode === 'cloud' ? ' is-active' : ''}`}
          onClick={() => onSetMode('cloud')}
        >
          <Cloud size={14} aria-hidden="true" />
          <span className="lm-segment-text">
            <span className="lm-segment-title">
              {isProperName(cloudLabel) ? `Cloud — ${cloudLabel}` : 'Your AI account'}
            </span>
            <span className="lm-segment-sub">
              {isProperName(cloudLabel) ? 'Uses your AI account' : capitalize(cloudLabel)}
            </span>
          </span>
        </button>
      </div>

      {mode === 'local' && status?.platformSupported && (status.state === 'not_installed' || status.state === 'installing') && (
        <p className="lm-footnote">
          Set to use the local model, but it isn't installed{status?.state === 'installing' ? ' yet' : ''}. Ergo uses{' '}
          {cloudLabel} until it is.
        </p>
      )}

      <div className="lm-settings-status">{renderStatus()}</div>

      {actionError && status?.state !== 'error' && (
        <div className="lm-inline-error" role="alert">
          <AlertCircle size={13} aria-hidden="true" />
          <span>{actionError}</span>
        </div>
      )}
      {unreachable && status && (
        <div className="lm-inline-error is-warn">
          <AlertCircle size={13} aria-hidden="true" />
          <span>Lost contact with Ergo's local bridge. Showing the last known status.</span>
        </div>
      )}
    </div>
  );
};
