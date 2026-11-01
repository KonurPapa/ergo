import React, { useState } from 'react';
import { Check, Cpu, Download, Layers, RefreshCw, Settings as SettingsIcon, CircleAlert, LoaderCircle } from 'lucide-react';
import type { BridgeStatus } from '../lib/bridgeClient';
import { bridgeClient, getBridgeDownload } from '../lib/bridgeClient';
import type { AutosaveStatus } from '../hooks/useAutosave';
import type { SpawnedSession, UserApiKey, ModelSelectionMode } from '../types';
import { SUPPORTED_AI_PROVIDERS } from '../lib/aiProviders';
import { useAgentActivity, useTick } from '../hooks/useAgentActivity';
import { agentNameForCmd, formatElapsed } from '../lib/agentDisplay';
import { AgentStatus, Button, Icon, Menu, Popover, StatusDot, type MenuItem } from './ui';

interface StatusBarProps {
  bridgeStatus: BridgeStatus;
  isReconnecting: boolean;
  onReconnect: () => void;
  onOpenBridgeSettings: () => void;
  userApiKeys: UserApiKey[];
  activeKeyId: string | null;
  onSelectUserKey: (keyId: string | null) => void;
  modelSelection: ModelSelectionMode;
  onOpenModels: () => void;
  /** The agent session to follow in the live line (the first working one). */
  liveSession: SpawnedSession | null;
  /** Title of the task the live agent works on (opens it). */
  onOpenLiveTask?: () => void;
  queuedCount: number;
  onOpenQueue?: () => void;
  autosaveStatus: AutosaveStatus;
  todoFileName: string;
  onSaveNow: () => void;
}

/** Bridge state as the design names it: Connected · Connecting · Unreachable. */
function bridgeState(s: BridgeStatus): 'connected' | 'connecting' | 'unreachable' {
  if (s.isConnected) return 'connected';
  if (s.isChecking && !s.lastCheckedAt) return 'connecting';
  return 'unreachable';
}

function sinceLabel(iso?: string): string | null {
  if (!iso) return null;
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const m = Math.round(ms / 60000);
  if (m < 1) return 'Last seen just now';
  if (m < 60) return `Last seen ${m} min ago`;
  return `Last seen ${Math.round(m / 60)} h ago`;
}

/** The live agent line: one AgentStatus for the session being followed. */
const LiveAgent: React.FC<{ session: SpawnedSession; onClick?: () => void }> = ({ session, onClick }) => {
  const { activity } = useAgentActivity(session.ptySessionId);
  const now = useTick();
  const started = Date.parse(session.session.spawnedAt) || now;
  const waiting = session.status === 'awaiting_approval';
  const doing = waiting ? 'Waiting for your approval' : activity?.doing || activity?.said || (session.status === 'starting' ? 'Starting' : 'Working');
  return (
    <AgentStatus
      state={waiting ? 'waiting' : 'running'}
      agent={agentNameForCmd(session.cmd)}
      action={doing}
      elapsed={formatElapsed(now - started)}
      onClick={onClick}
      title={`${session.session.taskTitle} — ${doing}`}
    />
  );
};

/**
 * The status bar: bridge state, current agent + model mode, the live AgentStatus, queue count and save state.
 * Every item opens its detail.
 */
export const StatusBar: React.FC<StatusBarProps> = ({
  bridgeStatus,
  isReconnecting,
  onReconnect,
  onOpenBridgeSettings,
  userApiKeys,
  activeKeyId,
  onSelectUserKey,
  modelSelection,
  onOpenModels,
  liveSession,
  onOpenLiveTask,
  queuedCount,
  onOpenQueue,
  autosaveStatus,
  todoFileName,
  onSaveNow,
}) => {
  const [bridgeAnchor, setBridgeAnchor] = useState<HTMLButtonElement | null>(null);
  const [agentAnchor, setAgentAnchor] = useState<HTMLButtonElement | null>(null);
  const [openPop, setOpenPop] = useState<'bridge' | 'agent' | null>(null);

  const state = bridgeState(bridgeStatus);
  const download = getBridgeDownload();
  const hosted = bridgeClient.isHostedWeb();

  const activeKey = userApiKeys.find((k) => k.id === activeKeyId);
  const providerMeta = activeKey ? SUPPORTED_AI_PROVIDERS.find((p) => p.id === activeKey.provider) : undefined;
  const agentLabel = activeKey ? `${activeKey.name} · ${modelSelection === 'auto' ? 'Auto' : 'Manual'}` : 'Set up an agent';

  const agentItems: MenuItem[] = [
    { section: 'Agent profiles' },
    ...userApiKeys.map((k) => {
      const meta = SUPPORTED_AI_PROVIDERS.find((p) => p.id === k.provider);
      return {
        label: k.name,
        hint: meta?.shortName,
        checked: k.id === activeKeyId,
        onSelect: () => onSelectUserKey(k.id),
      };
    }),
    ...(userApiKeys.length ? [{ separator: true } as const] : []),
    { label: 'Models and providers', icon: SettingsIcon, onSelect: onOpenModels },
  ];

  const saveLabel =
    autosaveStatus === 'saving' || autosaveStatus === 'pending'
      ? 'Saving'
      : autosaveStatus === 'error'
        ? `Not saved to ${todoFileName}`
        : `Saved to ${todoFileName}`;

  return (
    <footer className="eg-statusbar">
      <button
        ref={setBridgeAnchor}
        type="button"
        className={`eg-sb-item ${state === 'unreachable' ? 'is-attention' : ''}`}
        onClick={() => setOpenPop(openPop === 'bridge' ? null : 'bridge')}
        aria-expanded={openPop === 'bridge'}
        title={state === 'connected' ? `Bridge connected at ${bridgeStatus.bridgeUrl}` : undefined}
      >
        <StatusDot state={state === 'connected' ? 'success' : state === 'connecting' ? 'live' : 'warning'} />
        {state === 'connected' ? 'Bridge' : state === 'connecting' ? 'Connecting' : <span className="eg-sb-strong">Bridge unreachable</span>}
      </button>

      <button
        ref={setAgentAnchor}
        type="button"
        className="eg-sb-item eg-hide-sm"
        onClick={() => setOpenPop(openPop === 'agent' ? null : 'agent')}
        aria-expanded={openPop === 'agent'}
        title={activeKey ? `${providerMeta?.shortName || activeKey.provider} · ${activeKey.generalModel || activeKey.model || ''}` : undefined}
      >
        <Icon icon={Cpu} size="sm" />
        {agentLabel}
      </button>

      {liveSession && <LiveAgent session={liveSession} onClick={onOpenLiveTask} />}

      <span className="eg-spacer" />

      {queuedCount > 0 && (
        <button type="button" className="eg-sb-item" onClick={onOpenQueue}>
          <Icon icon={Layers} size="sm" />
          {queuedCount} queued
        </button>
      )}
      <button type="button" className="eg-sb-item eg-hide-sm" onClick={onSaveNow} title="Save now">
        <Icon
          icon={autosaveStatus === 'error' ? CircleAlert : autosaveStatus === 'saving' || autosaveStatus === 'pending' ? LoaderCircle : Check}
          size="sm"
          className={autosaveStatus === 'saving' ? 'spin-animate' : undefined}
        />
        {saveLabel}
      </button>

      <Popover anchor={bridgeAnchor} open={openPop === 'bridge'} onClose={() => setOpenPop(null)} placement="above" width={380}>
        <div className="eg-menu eg-bridge-pop" role="dialog" aria-labelledby="eg-bridge-pop-title">
          <div className="eg-hstack">
            <StatusDot state={state === 'connected' ? 'success' : state === 'connecting' ? 'live' : 'warning'} />
            <span className="eg-banner-title" id="eg-bridge-pop-title">
              {state === 'connected' ? 'Bridge connected' : state === 'connecting' ? 'Connecting to the bridge' : 'Bridge unreachable'}
            </span>
            <span className="eg-spacer" />
            {state !== 'connected' && <span className="eg-subtle eg-caption">{sinceLabel(bridgeStatus.lastHeartbeat)}</span>}
          </div>
          {state === 'connected' ? (
            <p className="eg-bridge-pop-text">
              The bridge is the small Ergo helper on your computer that starts agents and reads your files. It's running at{' '}
              <code>{bridgeStatus.bridgeUrl}</code>
              {bridgeStatus.bridgeInfo?.version ? ` (version ${bridgeStatus.bridgeInfo.version})` : ''}.
            </p>
          ) : (
            <>
              <p className="eg-bridge-pop-text">
                The bridge is the small Ergo helper on your computer that starts agents and reads your files. Ergo is still saving your work;
                runs are paused until it's back.
              </p>
              {bridgeStatus.error && <p className="eg-bridge-pop-text eg-subtle">{bridgeStatus.error}</p>}
              <ol className="eg-steps">
                {hosted ? (
                  <>
                    <li>
                      <span>
                        Open <strong>Ergo Bridge</strong> on this computer, or install it if you don't have it yet
                      </span>
                    </li>
                    <li>
                      <span>When your browser asks, allow this site to access apps on this device</span>
                    </li>
                    <li>
                      <span>
                        Still stuck? Check that nothing blocks <code>{bridgeStatus.bridgeUrl}</code>
                      </span>
                    </li>
                  </>
                ) : (
                  <>
                    <li>
                      <span>
                        Start it from a terminal in the Ergo folder: <code>npm run dev</code>
                      </span>
                    </li>
                    <li>
                      <span>Check that terminal for errors if it is already running</span>
                    </li>
                  </>
                )}
              </ol>
            </>
          )}
          <div className="eg-banner-actions">
            {state !== 'connected' && (
              <Button size="sm" icon={RefreshCw} onClick={onReconnect} disabled={isReconnecting}>
                {isReconnecting ? 'Trying' : 'Try again'}
              </Button>
            )}
            {state !== 'connected' && hosted && download && (
              <Button size="sm" variant="ghost" icon={Download} onClick={() => window.open(download.url, '_blank', 'noopener')}>
                Download bridge
              </Button>
            )}
            <span className="eg-spacer" />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setOpenPop(null);
                onOpenBridgeSettings();
              }}
            >
              Bridge settings
            </Button>
          </div>
        </div>
      </Popover>

      <Popover anchor={agentAnchor} open={openPop === 'agent'} onClose={() => setOpenPop(null)} placement="above" width={260}>
        <Menu items={agentItems} onClose={() => setOpenPop(null)} />
      </Popover>
    </footer>
  );
};
