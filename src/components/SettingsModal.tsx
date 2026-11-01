import React, { useEffect, useState } from 'react';
import { askConfirm } from './ui/askDialogs';
import { type ProjectData, type FolderMetadata, type AgentPipelineOptions, type ModelDataSettings, type AutocompleteSettings } from '../types';
import { Button, IconButton, Input, Switch, SegmentedControl, SettingsGroup, SettingsRow, StatusDot } from './ui';
import { setProjectDisplayName } from '../lib/projectNames';
import { type AutosaveStatus } from '../hooks/useAutosave';
import {
  Settings,
  X,
  HardDrive,
  Save,
  Check,
  Folder,
  CheckSquare,
  Clock,
  RotateCw,
  CheckCheck,
  AlertCircle,
  FolderOpen,
  Lock,
  RefreshCw,
  Sun,
  Moon,
  Palette,
  Workflow,
  Users,
  Repeat,
  Sparkles,
  Database,
  Trash2,
  Laptop,
  Beaker,
  Download,
  BarChart3,
  Eye,
  EyeOff,
  Loader2,
  ExternalLink
} from 'lucide-react';
import { getChunkCount } from '../lib/memory';
import { getCalibration, resetCalibration, subscribeCalibration } from '../lib/agentPipeline/calibrationStore';
import { buildSummary, CALIBRATION_FILE_PATH, type CalibrationFile } from '../lib/agentPipeline/calibration';
import { bridgeClient, type BridgeStatus, BRIDGE_LAUNCH_URL, getBridgeDownload } from '../lib/bridgeClient';
import { BridgeDownloadButton } from './BridgeDownloadButton';
import { useBeta } from '../context/BetaContext';
import { LocalModelSettingsSection, useLocalModelInstall, type LocalModelMode, type LocalModelInstallController } from './LocalModelSetup';
import { getModelCatalog, formatCatalogAge, snapshotDate, usesArtificialAnalysis } from '../lib/modelCatalog/catalog';
import type { ModelCatalog } from '../lib/modelCatalog/types';
import { BUILTIN_STRENGTHS_AS_OF } from '../lib/modelCatalog/builtinStrengths';

/** Which part of the workspace settings a Settings page shows when the modal is embedded. */
export type SettingsModalSection = 'general' | 'bridge' | 'appearance' | 'models' | 'memory';

export interface SettingsModalProps {
  isOpen: boolean;
  /** Render one section's body inline (Settings page) instead of the modal. */
  embedded?: boolean;
  section?: SettingsModalSection;
  onClose: () => void;
  activeProject: ProjectData;
  folderMetadata: FolderMetadata;
  onOpenFolderPicker: () => void;
  onRescanProjects: () => Promise<void>;
  onUpdateStorageDirectory?: (newPath: string) => Promise<void>;
  autosaveStatus: AutosaveStatus;
  autosaveDelaySec: number;
  isAutosaveEnabled: boolean;
  lastSavedAt: string | null;
  onSetAutosaveDelay: (seconds: number) => void;
  onToggleAutosave: (enabled: boolean) => void;
  onSaveImmediately: () => void;
  theme: 'light' | 'dark';
  onThemeChange: (theme: 'light' | 'dark') => void;
  agentPipelineOptions: AgentPipelineOptions;
  onSetAgentPipelineOptions: (next: AgentPipelineOptions) => void;
  onClearProjectMemory?: () => Promise<number>;
  onClearAllMemory?: () => Promise<number>;
  autocompleteSettings?: import('../types').AutocompleteSettings;
  onSetAutocompleteSettings?: (next: import('../types').AutocompleteSettings) => void;
  onExportProject?: () => void;
  onOpenRawMarkdownModal?: () => void;
  /** Local AI model preference; 'unset' behaves like cloud. */
  localModelMode?: LocalModelMode;
  onSetLocalModelMode?: (mode: 'local' | 'cloud') => void;
  /** The provider's tiny cloud model used instead of the local one, e.g. "Claude Haiku". */
  tinyCloudModelLabel?: string;
  /** Data sources for Auto model selection (Artificial Analysis key). */
  modelData?: ModelDataSettings;
  onSetModelData?: (next: ModelDataSettings) => void;
}

const AA_URL = 'https://artificialanalysis.ai/';

/** "Prices: LiteLLM, updated 3 h ago" — where the catalog's prices came from. */
function priceSourceText(catalog: ModelCatalog): string {
  const age = formatCatalogAge(catalog.fetchedAt);
  if (catalog.sources.prices === 'litellm') return `Live prices from LiteLLM${age ? `, updated ${age}` : ''}.`;
  if (catalog.sources.prices === 'litellm-cache') return `Prices from LiteLLM, cached${age ? ` ${age}` : ''} (couldn't refresh).`;
  return `Bridge offline: using bundled prices${snapshotDate(catalog.fetchedAt)}.`;
}

/**
 * Settings → Model data: where Auto model selection gets model strengths (built-in table, or live Artificial
 * Analysis scores with a free key) and prices (LiteLLM, live).
 */
const ModelDataSettingsSection: React.FC<{
  modelData: ModelDataSettings;
  onSetModelData?: (next: ModelDataSettings) => void;
  embedded?: boolean;
}> = ({ modelData, onSetModelData, embedded }) => {
  const savedKey = modelData.artificialAnalysisKey || '';
  const [draftKey, setDraftKey] = useState(savedKey);
  const [showKey, setShowKey] = useState(false);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => setDraftKey(savedKey), [savedKey]);

  useEffect(() => {
    let cancelled = false;
    void getModelCatalog().then((c) => {
      if (!cancelled) setCatalog(c);
    });
    return () => {
      cancelled = true;
    };
  }, [savedKey]);

  const commitKey = (key: string) => {
    if (key.trim() !== savedKey) onSetModelData?.({ artificialAnalysisKey: key.trim() || undefined });
  };

  const handleCheck = async () => {
    const key = draftKey.trim();
    commitKey(key);
    setChecking(true);
    setCheckResult(null);
    try {
      const c = await getModelCatalog({ artificialAnalysisKey: key, refresh: true });
      setCatalog(c);
      if (!key) {
        setCheckResult({ ok: c.sources.prices !== 'snapshot', text: `Prices for ${c.models.length} models.` });
      } else if (usesArtificialAnalysis(c)) {
        const matched = c.models.filter((m) => m.benchmarks).length;
        setCheckResult({ ok: true, text: `Matched ${matched} model${matched === 1 ? '' : 's'}.` });
      } else {
        setCheckResult({ ok: false, text: c.sources.benchmarksError || "Couldn't reach Artificial Analysis." });
      }
    } finally {
      setChecking(false);
    }
  };

  const aaInUse = Boolean(catalog && usesArtificialAnalysis(catalog));
  const strengthsText = savedKey
    ? aaInUse
      ? 'Using live benchmark scores and live prices.'
      : catalog?.sources.benchmarksError
        ? `Artificial Analysis unavailable (${catalog.sources.benchmarksError}). Using built-in strengths.`
        : 'Using live benchmark scores when available, and live prices.'
    : `Using built-in strengths${BUILTIN_STRENGTHS_AS_OF ? ` (as of ${BUILTIN_STRENGTHS_AS_OF})` : ''} and live prices.`;

  if (embedded) {
    return (
      <>
        <SettingsGroup title="Model data">
          <SettingsRow
            title="Artificial Analysis key"
            help={
              checkResult ? (
                <span className={checkResult.ok ? 'eg-settings-ok' : 'eg-settings-bad'}>{checkResult.text}</span>
              ) : (
                'Optional. With a free key, Auto uses live benchmark scores to pick models.'
              )
            }
          >
            <div className="eg-settings-actions">
              <Input
                id="settings-aa-key"
                type={showKey ? 'text' : 'password'}
                mono
                value={draftKey}
                placeholder="Paste your key"
                autoComplete="off"
                spellCheck={false}
                aria-label="Artificial Analysis key"
                style={{ width: 180 }}
                onChange={(e) => {
                  setDraftKey(e.target.value);
                  setCheckResult(null);
                }}
                onBlur={() => commitKey(draftKey)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleCheck();
                }}
              />
              <IconButton icon={showKey ? EyeOff : Eye} label={showKey ? 'Hide key' : 'Show key'} size="sm" onClick={() => setShowKey((v) => !v)} />
              <Button size="sm" icon={checking ? Loader2 : RefreshCw} onClick={() => void handleCheck()} disabled={checking}>
                {checking ? 'Checking…' : 'Check'}
              </Button>
            </div>
          </SettingsRow>
          <SettingsRow
            title="Sources"
            help={
              <>
                {strengthsText} {catalog ? priceSourceText(catalog) : ''}{' '}
                <a href={AA_URL} target="_blank" rel="noopener noreferrer">
                  Benchmark data: Artificial Analysis
                </a>
              </>
            }
          />
        </SettingsGroup>
        <SettingsGroup title="What Auto has learned">
          <LearnedModelsPanel embedded />
        </SettingsGroup>
      </>
    );
  }

  return (
    <div className="lm-settings">
      <div className="lm-settings-head">
        <div className="lm-settings-title">
          <BarChart3 size={16} color="var(--accent-cyan)" aria-hidden="true" />
          <span>Model data</span>
        </div>
      </div>
      <p className="lm-settings-desc">
        When Models is set to Auto, Ergo picks each stage's model from model strengths and prices. Add a free
        Artificial Analysis key to use their live benchmark scores.
      </p>

      <div className="md-key-row">
        <label htmlFor="settings-aa-key" className="md-key-label">Artificial Analysis key (optional)</label>
        <div className="md-key-field">
          <input
            id="settings-aa-key"
            type={showKey ? 'text' : 'password'}
            className="md-key-input"
            value={draftKey}
            placeholder="Paste your API key"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setDraftKey(e.target.value);
              setCheckResult(null);
            }}
            onBlur={() => commitKey(draftKey)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleCheck();
            }}
          />
          <button
            type="button"
            className="md-key-toggle"
            onClick={() => setShowKey((v) => !v)}
            aria-label={showKey ? 'Hide key' : 'Show key'}
            title={showKey ? 'Hide key' : 'Show key'}
          >
            {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
          <button type="button" className="btn btn-secondary lm-settings-btn" onClick={() => void handleCheck()} disabled={checking}>
            {checking ? <Loader2 size={12} className="spin-animate" /> : <RefreshCw size={12} />}
            <span>{checking ? 'Checking…' : 'Check'}</span>
          </button>
        </div>
        {checkResult && (
          <div className={`md-check ${checkResult.ok ? 'is-ok' : 'is-error'}`} role="status">
            {checkResult.ok ? <Check size={12} aria-hidden="true" /> : <AlertCircle size={12} aria-hidden="true" />}
            <span>{checkResult.text}</span>
          </div>
        )}
      </div>

      <div className="lm-settings-status md-status">
        <span>{strengthsText}</span>
        {catalog && <span>{priceSourceText(catalog)}</span>}
        <a className="md-attribution" href={AA_URL} target="_blank" rel="noopener noreferrer">
          Benchmark data: Artificial Analysis <ExternalLink size={11} aria-hidden="true" />
        </a>
      </div>

      <LearnedModelsPanel />
    </div>
  );
};

const STAGE_WORDS: Record<string, string> = { manager: 'Manager', worker: 'Workers', verifier: 'Verifier' };
const EFFORT_SHORT: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra High', max: 'Max' };

/** What Auto mode has learned from past runs (config/model-calibration.json), with a reset. */
const LearnedModelsPanel: React.FC<{ embedded?: boolean }> = ({ embedded }) => {
  const [file, setFile] = useState<CalibrationFile | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => {
    let alive = true;
    void getCalibration().then((f) => alive && setFile(f));
    const off = subscribeCalibration((f) => setFile(f));
    return () => {
      alive = false;
      off();
    };
  }, []);
  const rows = file ? buildSummary(file) : [];
  const runCount = file ? file.runs.filter((r) => r.outcome).length : 0;
  return (
    <div className={embedded ? 'md-learned eg-settings-learned' : 'md-learned'}>
      <div className="md-learned-head">
        {!embedded && <span className="md-learned-title">What Ergo has learned</span>}
        <span className="md-learned-meta">
          {runCount === 0 ? 'No runs recorded yet' : `${runCount} run${runCount === 1 ? '' : 's'} recorded`} · <code>{CALIBRATION_FILE_PATH}</code>
        </span>
      </div>
      {rows.length > 0 ? (
        <div className="md-learned-table" role="table" aria-label="Model results by task group">
          <div className="md-learned-row is-head" role="row">
            <span role="columnheader">Task group</span>
            <span role="columnheader">Stage</span>
            <span role="columnheader">Model · effort</span>
            <span role="columnheader">Passed</span>
          </div>
          {rows.slice(0, 24).map((r) => (
            <div className="md-learned-row" role="row" key={`${r.group}|${r.stage}|${r.model}|${r.effort}`}>
              <span role="cell">{r.group}</span>
              <span role="cell">{STAGE_WORDS[r.stage] || r.stage}</span>
              <span role="cell">{r.model} · {EFFORT_SHORT[r.effort] || r.effort}</span>
              <span role="cell" className={r.failed > r.passed ? 'is-bad' : ''}>{r.passed} of {r.runs}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="md-learned-empty">
          After each run, Ergo notes which models did the work and how it went, and adjusts future picks for similar tasks.
        </p>
      )}
      {runCount > 0 && (
        <div className="md-learned-actions">
          {confirmReset ? (
            <>
              <span>Forget everything Ergo has learned?</span>
              <button type="button" className="btn btn-secondary lm-settings-btn" onClick={() => setConfirmReset(false)}>Cancel</button>
              <button
                type="button"
                className="btn btn-secondary lm-settings-btn md-learned-reset"
                onClick={() => {
                  void resetCalibration();
                  setConfirmReset(false);
                }}
              >
                <Trash2 size={12} /> <span>Reset</span>
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-secondary lm-settings-btn" onClick={() => setConfirmReset(true)}>
              <Trash2 size={12} /> <span>Reset what Ergo has learned</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
};

/** Bounds for the numeric pipeline knobs (kept in sync with the helper text below). */
const PIPELINE_LIMITS = {
  maxConcurrentAgents: { min: 1, max: 8 },
  maxVerifierRetries: { min: 0, max: 5 },
  maxToolRoundsPerAgent: { min: 5, max: 120 }
} as const;

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

const pipelineInputBoxStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.6rem',
  background: 'var(--canvas)',
  padding: '0.5rem 0.85rem',
  borderRadius: '6px',
  border: '1px solid var(--border-subtle)',
  width: 'fit-content'
};

const pipelineNumberInputStyle: React.CSSProperties = {
  width: '65px',
  background: 'transparent',
  border: 'none',
  outline: 'none',
  color: 'var(--accent-cyan)',
  fontFamily: 'var(--font-mono)',
  fontSize: '0.9rem',
  fontWeight: 600
};

const pipelineHelpStyle: React.CSSProperties = {
  fontSize: '0.74rem',
  color: 'var(--text-muted)',
  lineHeight: '1.4',
  marginTop: '0.4rem'
};

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  activeProject,
  folderMetadata,
  onOpenFolderPicker,
  onRescanProjects,
  onUpdateStorageDirectory,
  autosaveStatus,
  autosaveDelaySec,
  isAutosaveEnabled,
  lastSavedAt,
  onSetAutosaveDelay,
  onToggleAutosave,
  onSaveImmediately,
  theme,
  onThemeChange,
  agentPipelineOptions,
  onSetAgentPipelineOptions,
  onClearProjectMemory,
  onClearAllMemory,
  autocompleteSettings = { enabled: true, keybinding: 'Tab' },
  onSetAutocompleteSettings,
  onExportProject,
  onOpenRawMarkdownModal,
  localModelMode = 'unset',
  onSetLocalModelMode,
  tinyCloudModelLabel,
  modelData = {},
  onSetModelData,
  embedded = false,
  section = 'general'
}) => {
  const active = isOpen || embedded;
  const [isScanning, setIsScanning] = useState(false);
  const [storagePathInput, setStoragePathInput] = useState(
    folderMetadata.storageDirectory || '~/.ergo'
  );
  const [isSavingPath, setIsSavingPath] = useState(false);
  const [pathSaveSuccess, setPathSaveSuccess] = useState(false);
  const [projectChunkCount, setProjectChunkCount] = useState<number | null>(null);
  const [totalChunkCount, setTotalChunkCount] = useState<number | null>(null);
  const [isClearingProjectMemory, setIsClearingProjectMemory] = useState(false);
  const [isClearingAllMemory, setIsClearingAllMemory] = useState(false);
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>(() => bridgeClient.getStatus());
  const [bridgeUrlInput, setBridgeUrlInput] = useState<string>(() => bridgeClient.getBridgeUrl() || 'http://localhost:5173');
  const { isBetaEnabled, setIsBetaEnabled } = useBeta();
  const [isTestingBridge, setIsTestingBridge] = useState(false);
  const [bridgeNotice, setBridgeNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  // Installing from Settings switches to the local model once it finishes (even if the modal was closed).
  const localModel = useLocalModelInstall({
    enabled: active,
    onInstalled: () => onSetLocalModelMode?.('local')
  });

  React.useEffect(() => {
    const unsub = bridgeClient.subscribe((status) => {
      setBridgeStatus(status);
    });
    return unsub;
  }, []);

  const handleTestBridge = async () => {
    setIsTestingBridge(true);
    setBridgeNotice(null);
    try {
      const res = await bridgeClient.checkConnection(bridgeUrlInput.trim(), { exclusive: true });
      if (res.success) {
        setBridgeNotice({ type: 'success', text: `Connected successfully to ${bridgeUrlInput.trim()}` });
      } else {
        setBridgeNotice({ type: 'error', text: res.error || 'Connection failed' });
      }
    } finally {
      setIsTestingBridge(false);
    }
  };

  React.useEffect(() => {
    if (!active) return;
    let mounted = true;
    void getChunkCount(undefined, activeProject.id).then((c) => {
      if (mounted) setProjectChunkCount(c);
    });
    void getChunkCount().then((c) => {
      if (mounted) setTotalChunkCount(c);
    });
    return () => {
      mounted = false;
    };
  }, [active, activeProject.id]);

  const handleClearProjectMemoryClick = async () => {
    if (!onClearProjectMemory) return;
    const ok = await askConfirm({
      title: `Clear memory for ${activeProject.name || activeProject.id}?`,
      text: 'All task summaries and learnings for this project are removed. Other projects keep theirs.',
      confirmLabel: 'Clear memory',
      danger: true,
    });
    if (!ok) return;
    setIsClearingProjectMemory(true);
    try {
      await onClearProjectMemory();
      const nextProjectCount = await getChunkCount(undefined, activeProject.id);
      const nextTotalCount = await getChunkCount();
      setProjectChunkCount(nextProjectCount);
      setTotalChunkCount(nextTotalCount);
    } catch (err) {
      console.error('[SettingsModal] Failed to clear project memory:', err);
    } finally {
      setIsClearingProjectMemory(false);
    }
  };

  const handleClearAllMemoryClick = async () => {
    if (!onClearAllMemory) return;
    const ok = await askConfirm({
      title: 'Reset memory for every project?',
      text: "This deletes Ergo's whole local memory database.",
      confirmLabel: 'Reset all memory',
      danger: true,
    });
    if (!ok) return;
    setIsClearingAllMemory(true);
    try {
      await onClearAllMemory();
      setProjectChunkCount(0);
      setTotalChunkCount(0);
    } catch (err) {
      console.error('[SettingsModal] Failed to clear all memory:', err);
    } finally {
      setIsClearingAllMemory(false);
    }
  };

  if (!active) return null;

  const todoPath = activeProject?.todoFilePath || `${activeProject?.folderPath}/TODO.md`;

  const setPipelineOption = <K extends keyof AgentPipelineOptions>(key: K, value: AgentPipelineOptions[K]) => {
    onSetAgentPipelineOptions({ ...agentPipelineOptions, [key]: value });
  };
  const setPipelineNumber = (key: 'maxConcurrentAgents' | 'maxVerifierRetries' | 'maxToolRoundsPerAgent', raw: string) => {
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed)) return;
    const { min, max } = PIPELINE_LIMITS[key];
    setPipelineOption(key, clampInt(parsed, min, max));
  };

  const handleScan = async () => {
    setIsScanning(true);
    try {
      await onRescanProjects();
    } finally {
      setIsScanning(false);
    }
  };

  const handleSaveStoragePath = async () => {
    if (!storagePathInput.trim() || !onUpdateStorageDirectory) return;
    setIsSavingPath(true);
    setPathSaveSuccess(false);
    try {
      await onUpdateStorageDirectory(storagePathInput.trim());
      setPathSaveSuccess(true);
      setTimeout(() => setPathSaveSuccess(false), 3000);
    } finally {
      setIsSavingPath(false);
    }
  };

  const handleResetStoragePath = async () => {
    setStoragePathInput('~/.ergo');
    if (onUpdateStorageDirectory) {
      setIsSavingPath(true);
      try {
        await onUpdateStorageDirectory('~/.ergo');
        setPathSaveSuccess(true);
        setTimeout(() => setPathSaveSuccess(false), 3000);
      } finally {
        setIsSavingPath(false);
      }
    }
  };

  if (embedded) {
    return (
      <EmbeddedSettingsSection
        section={section}
        activeProject={activeProject}
        todoPath={todoPath}
        folderMetadata={folderMetadata}
        onOpenFolderPicker={onOpenFolderPicker}
        isScanning={isScanning}
        onScan={handleScan}
        storagePathInput={storagePathInput}
        setStoragePathInput={setStoragePathInput}
        isSavingPath={isSavingPath}
        pathSaveSuccess={pathSaveSuccess}
        onSaveStoragePath={handleSaveStoragePath}
        onResetStoragePath={handleResetStoragePath}
        canSaveStoragePath={!!onUpdateStorageDirectory}
        autosaveStatus={autosaveStatus}
        autosaveDelaySec={autosaveDelaySec}
        isAutosaveEnabled={isAutosaveEnabled}
        lastSavedAt={lastSavedAt}
        onSetAutosaveDelay={onSetAutosaveDelay}
        onToggleAutosave={onToggleAutosave}
        onSaveImmediately={onSaveImmediately}
        theme={theme}
        onThemeChange={onThemeChange}
        agentPipelineOptions={agentPipelineOptions}
        setPipelineOption={setPipelineOption}
        setPipelineNumber={setPipelineNumber}
        autocompleteSettings={autocompleteSettings}
        onSetAutocompleteSettings={onSetAutocompleteSettings}
        isBetaEnabled={isBetaEnabled}
        setIsBetaEnabled={setIsBetaEnabled}
        onExportProject={onExportProject}
        onOpenRawMarkdownModal={onOpenRawMarkdownModal}
        bridgeStatus={bridgeStatus}
        bridgeUrlInput={bridgeUrlInput}
        setBridgeUrlInput={setBridgeUrlInput}
        isTestingBridge={isTestingBridge}
        bridgeNotice={bridgeNotice}
        onTestBridge={handleTestBridge}
        localModel={localModel}
        localModelMode={localModelMode}
        onSetLocalModelMode={onSetLocalModelMode}
        tinyCloudModelLabel={tinyCloudModelLabel}
        modelData={modelData}
        onSetModelData={onSetModelData}
        projectChunkCount={projectChunkCount}
        totalChunkCount={totalChunkCount}
        isClearingProjectMemory={isClearingProjectMemory}
        isClearingAllMemory={isClearingAllMemory}
        onClearProjectMemory={onClearProjectMemory ? handleClearProjectMemoryClick : undefined}
        onClearAllMemory={onClearAllMemory ? handleClearAllMemoryClick : undefined}
      />
    );
  }

  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-content" style={{ maxWidth: '640px' }} onClick={(e) => e.stopPropagation()}>
        {/* Modal Header */}
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <Settings size={22} color="var(--accent-cyan)" />
            <div>
              <h3 style={{ fontSize: '1.1rem', fontWeight: 600 }}>Workspace Settings</h3>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.1rem' }}>
                Appearance theme, local directory, secrets storage, and disk synchronization
              </p>
            </div>
          </div>
          <button className="btn btn-secondary" style={{ padding: '0.3rem 0.5rem' }} onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {/* Modal Body */}
        <div className="modal-body" style={{ gap: '1.25rem', display: 'flex', flexDirection: 'column' }}>

          {/* Ergo Bridge: the app that connects Ergo to this computer */}
          {(() => {
            const download = getBridgeDownload();
            return (
              <div
                style={{
                  background: 'var(--surface-1)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: '8px',
                  padding: '1.1rem'
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <Laptop size={16} color="var(--accent-primary)" />
                    <span style={{ fontSize: '0.92rem', fontWeight: 600 }}>Ergo Bridge</span>
                  </div>
                  <span
                    className={`badge ${bridgeStatus.isConnected ? 'badge-done' : 'badge-warning'}`}
                    style={{ fontSize: '0.65rem', padding: '0.1rem 0.4rem', textTransform: 'none' }}
                  >
                    {bridgeStatus.isConnected ? 'Connected' : 'Not connected'}
                  </span>
                </div>

                <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '0.9rem', lineHeight: '1.45' }}>
                  {bridgeStatus.isConnected
                    ? `Connected to this computer at ${bridgeStatus.url}. Ergo can reach your local files and run AI tools here.`
                    : 'A small app that lets Ergo reach your files and run AI tools on this computer. Install it once: it starts by itself whenever you turn on your computer, and Ergo connects to it automatically.'}
                </p>

                {download ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem', flexWrap: 'wrap' }}>
                    <BridgeDownloadButton subtle={bridgeStatus.isConnected} />
                    {!bridgeStatus.isConnected && (
                      <a href={BRIDGE_LAUNCH_URL} style={{ fontSize: '0.74rem', fontWeight: 600, color: 'var(--accent-primary)' }}>
                        Already installed? Open it
                      </a>
                    )}
                  </div>
                ) : (
                  <p style={{ fontSize: '0.76rem', color: 'var(--text-muted)', margin: 0 }}>
                    Ergo Bridge runs on Windows, macOS and Linux computers. Open Ergo on one of those to connect it.
                  </p>
                )}
              </div>
            );
          })()}

          {/* Section 0: Appearance & Theme */}
          <div
            style={{
              background: 'var(--surface-1)',
              border: '1px solid var(--border-subtle)',
              borderRadius: '8px',
              padding: '1.1rem'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Palette size={16} color="var(--accent-cyan)" />
                <span style={{ fontSize: '0.92rem', fontWeight: 600 }}>Appearance & Theme</span>
              </div>
              <span
                className="badge badge-done"
                style={{ fontSize: '0.65rem', padding: '0.1rem 0.4rem', textTransform: 'none' }}
              >
                {theme === 'light' ? 'Light Mode (Default)' : 'Dark Mode'}
              </span>
            </div>

            <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '0.9rem', lineHeight: '1.45' }}>
              Choose your preferred visual aesthetic. Changes apply immediately and are saved across workspaces.
            </p>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              {/* Light Theme Card */}
              <button
                type="button"
                onClick={() => onThemeChange('light')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.75rem',
                  padding: '0.75rem 0.9rem',
                  borderRadius: 'var(--radius-md, 8px)',
                  border: theme === 'light' ? '2px solid var(--accent-primary)' : '1px solid var(--border-subtle)',
                  background: theme === 'light' ? 'var(--accent-subtle)' : 'var(--bg-darkest)',
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'all 0.2s ease',
                  boxShadow: 'none'
                }}
              >
                <div
                  style={{
                    width: '32px',
                    height: '32px',
                    borderRadius: '6px',
                    background: theme === 'light' ? 'var(--accent-amber)' : 'var(--warning-subtle)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: theme === 'light' ? 'var(--ink)' : 'var(--accent-amber)',
                    flexShrink: 0
                  }}
                >
                  <Sun size={18} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                    <span style={{ fontSize: '0.86rem', fontWeight: 600, color: 'var(--text-main)' }}>Light Mode</span>
                    <span style={{ fontSize: '0.65rem', background: 'var(--accent-subtle)', color: 'var(--accent-primary)', padding: '0.05rem 0.3rem', borderRadius: '3px', fontWeight: 600 }}>Default</span>
                  </div>
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Crisp, clean high-contrast</span>
                </div>
                {theme === 'light' && <Check size={16} color="var(--accent-primary)" style={{ flexShrink: 0 }} />}
              </button>

              {/* Dark Theme Card */}
              <button
                type="button"
                onClick={() => onThemeChange('dark')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.75rem',
                  padding: '0.75rem 0.9rem',
                  borderRadius: 'var(--radius-md, 8px)',
                  border: theme === 'dark' ? '2px solid var(--accent-primary)' : '1px solid var(--border-subtle)',
                  background: theme === 'dark' ? 'var(--accent-subtle)' : 'var(--bg-darkest)',
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'all 0.2s ease',
                  boxShadow: 'none'
                }}
              >
                <div
                  style={{
                    width: '32px',
                    height: '32px',
                    borderRadius: '6px',
                    background: theme === 'dark' ? 'var(--accent-violet)' : 'var(--surface-2)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: theme === 'dark' ? 'var(--ink)' : 'var(--accent-violet)',
                    flexShrink: 0
                  }}
                >
                  <Moon size={18} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: '0.86rem', fontWeight: 600, color: 'var(--text-main)', display: 'block' }}>Dark Mode</span>
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Sleek deep navy aesthetic</span>
                </div>
                {theme === 'dark' && <Check size={16} color="var(--accent-primary)" style={{ flexShrink: 0 }} />}
              </button>
            </div>
          </div>

          {/* Section 1: Local Directory & Storage Location */}
          <div
            style={{
              background: 'var(--surface-1)',
              border: '1px solid var(--border-subtle)',
              borderRadius: '8px',
              padding: '1.1rem'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.6rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <FolderOpen size={16} color="var(--accent-cyan)" />
                <span style={{ fontSize: '0.92rem', fontWeight: 600, color: 'var(--text-bright)' }}>App Storage Folder (Default: ~/.ergo)</span>
                <span
                  className={`badge ${folderMetadata.status === 'connected' ? 'badge-done' : ''}`}
                  style={{ fontSize: '0.65rem', padding: '0.1rem 0.4rem' }}
                >
                  {folderMetadata.status === 'connected'
                    ? 'ACTIVE'
                    : folderMetadata.status === 'needs_permission'
                      ? 'PERMISSION NEEDED'
                      : 'SERVER WORKSPACE'}
                </span>
              </div>

              <div style={{ display: 'flex', gap: '0.4rem' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}
                  onClick={handleScan}
                  disabled={isScanning}
                  title="Rescan project folders on disk"
                >
                  <RefreshCw size={12} className={isScanning ? 'spin-animate' : ''} />
                  <span>Rescan</span>
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ fontSize: '0.75rem', padding: '0.25rem 0.6rem' }}
                  onClick={() => {
                    onOpenFolderPicker();
                  }}
                  title="Select custom folder via browser picker"
                >
                  <span>Pick Folder...</span>
                </button>
              </div>
            </div>

            <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '0.75rem', lineHeight: '1.45' }}>
              By default, all tasks, briefs, AI keys, and settings are saved in your user home directory at <code style={{ color: 'var(--accent-cyan)' }}>~/.ergo</code>. You can customize the storage directory path below:
            </p>

            {/* Storage Path Input Controls */}
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
              <input
                type="text"
                className="input-text"
                value={storagePathInput}
                onChange={(e) => setStoragePathInput(e.target.value)}
                placeholder="~/.ergo"
                style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: '0.85rem' }}
              />
              <button
                type="button"
                className="btn btn-primary"
                style={{ fontSize: '0.8rem', padding: '0.35rem 0.75rem', whiteSpace: 'nowrap' }}
                onClick={handleSaveStoragePath}
                disabled={isSavingPath || storagePathInput === (folderMetadata.storageDirectory || '~/.ergo')}
              >
                {isSavingPath ? 'Saving...' : 'Apply Path'}
              </button>
              {storagePathInput !== '~/.ergo' && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ fontSize: '0.8rem', padding: '0.35rem 0.6rem', whiteSpace: 'nowrap' }}
                  onClick={handleResetStoragePath}
                  title="Reset to default ~/.ergo"
                >
                  Reset Default
                </button>
              )}
            </div>

            {pathSaveSuccess && (
              <div style={{ fontSize: '0.75rem', color: 'var(--accent-emerald)', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                <Check size={13} />
                <span>Storage directory updated and re-initialized successfully!</span>
              </div>
            )}

            {folderMetadata.resolvedPath && (
              <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginBottom: '0.75rem', fontFamily: 'var(--font-mono)' }}>
                Resolved path on disk: <strong style={{ color: 'var(--text-bright)' }}>{folderMetadata.resolvedPath}</strong>
              </div>
            )}

            <div
              style={{
                background: 'var(--canvas)',
                padding: '0.65rem 0.85rem',
                borderRadius: '6px',
                border: '1px solid var(--border-subtle)',
                fontFamily: 'var(--font-mono)',
                fontSize: '0.78rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.3rem'
              }}
            >
              <div style={{ color: 'var(--text-bright)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <Folder size={13} color="var(--accent-amber)" />
                <span>{folderMetadata.storageDirectory || '~/.ergo'}/</span>
              </div>
              <div style={{ paddingLeft: '1.2rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <Settings size={12} color="var(--accent-cyan)" />
                <span>config/settings.json</span>
                <span style={{ color: 'var(--text-dim)', fontSize: '0.7rem' }}>(UI Preferences & Active Storage Path)</span>
              </div>
              <div style={{ paddingLeft: '1.2rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <Lock size={12} color="var(--accent-amber)" />
                <span>config/secrets.json</span>
                <span style={{ color: 'var(--text-dim)', fontSize: '0.7rem' }}>(AI Keys & MCP Tokens)</span>
              </div>
              <div style={{ paddingLeft: '1.2rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <Folder size={12} color="var(--accent-violet)" />
                <span>projects/</span>
                <span style={{ color: 'var(--text-dim)', fontSize: '0.7rem' }}>(Task Lists & Context Briefs)</span>
              </div>
            </div>

            {/* Local Device Bridge Configuration */}
            <div
              style={{
                marginTop: '0.85rem',
                paddingTop: '0.85rem',
                borderTop: '1px solid var(--border-subtle)',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.5rem'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                  <Laptop size={15} color="var(--accent-primary)" />
                  <span style={{ fontSize: '0.86rem', fontWeight: 600, color: 'var(--text-bright)' }}>
                    Local Device Bridge
                  </span>
                  <span
                    className={`badge ${bridgeStatus.isConnected ? 'badge-done' : ''}`}
                    style={{ fontSize: '0.65rem', padding: '0.1rem 0.4rem' }}
                  >
                    {bridgeStatus.isConnected ? 'CONNECTED' : 'DISCONNECTED'}
                  </span>
                </div>

                <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>
                  {bridgeStatus.lastHeartbeat
                    ? `Last ping: ${new Date(bridgeStatus.lastHeartbeat).toLocaleTimeString()}`
                    : 'No pings yet'}
                </div>
              </div>

              <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', lineHeight: '1.4' }}>
                Enables this web app to interact with your local computer, stream terminal PTY sessions, and read/write your <code>~/.ergo</code> folders.
              </div>

              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.2rem' }}>
                <input
                  type="text"
                  className="input-text"
                  value={bridgeUrlInput}
                  onChange={(e) => setBridgeUrlInput(e.target.value)}
                  placeholder="http://localhost:5173"
                  style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: '0.82rem' }}
                />
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ fontSize: '0.78rem', padding: '0.35rem 0.75rem', whiteSpace: 'nowrap' }}
                  onClick={handleTestBridge}
                  disabled={isTestingBridge}
                >
                  <RefreshCw size={12} className={isTestingBridge ? 'spin-animate' : ''} />
                  <span>{isTestingBridge ? 'Connecting...' : 'Test Connection'}</span>
                </button>
              </div>

              {bridgeNotice && (
                <div
                  style={{
                    fontSize: '0.75rem',
                    color: bridgeNotice.type === 'success' ? 'var(--accent-emerald)' : 'var(--danger)',
                    marginTop: '0.2rem',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.35rem'
                  }}
                >
                  {bridgeNotice.type === 'success' ? <Check size={13} /> : <AlertCircle size={13} />}
                  <span>{bridgeNotice.text}</span>
                </div>
              )}
            </div>
          </div>

          {/* Section 2: Sync to Local Files Toggle */}
          <div
            style={{
              background: 'var(--surface-1)',
              border: '1px solid var(--border-subtle)',
              borderRadius: '8px',
              padding: '1.1rem'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <HardDrive size={16} color="var(--accent-cyan)" />
                  <span style={{ fontSize: '0.92rem', fontWeight: 600, color: 'var(--text-bright)' }}>Sync to Local Files</span>
                  <span
                    className={`badge ${isAutosaveEnabled ? 'badge-done' : ''}`}
                    style={{
                      fontSize: '0.65rem',
                      padding: '0.1rem 0.4rem',
                      background: isAutosaveEnabled ? undefined : 'var(--surface-2)',
                      color: isAutosaveEnabled ? undefined : 'var(--text-muted)'
                    }}
                  >
                    {isAutosaveEnabled ? 'ACTIVE' : 'DISABLED'}
                  </span>
                </div>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.35rem', lineHeight: '1.45' }}>
                  Automatically writes markdown changes directly to <code style={{ color: 'var(--accent-cyan)' }}>TODO.md</code> on disk when you stop typing.
                </p>
              </div>

              <button
                type="button"
                className={`toggle-switch-btn ${isAutosaveEnabled ? 'is-active' : ''}`}
                onClick={() => onToggleAutosave(!isAutosaveEnabled)}
                aria-label="Toggle sync to local files"
                style={{ flexShrink: 0, marginTop: '0.2rem' }}
              >
                <div className="toggle-switch-thumb" />
              </button>
            </div>
          </div>

          {/* Section 3: Inactivity Delay Setting */}
          <div
            style={{
              background: 'var(--surface-1)',
              border: '1px solid var(--border-subtle)',
              borderRadius: '8px',
              padding: '1.1rem',
              opacity: isAutosaveEnabled ? 1 : 0.5,
              pointerEvents: isAutosaveEnabled ? 'auto' : 'none',
              transition: 'opacity 0.2s ease'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.4rem' }}>
              <Clock size={16} color="var(--accent-amber)" />
              <span style={{ fontSize: '0.92rem', fontWeight: 600, color: 'var(--text-bright)' }}>Inactivity Delay</span>
            </div>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.85rem', lineHeight: '1.4' }}>
              Amount of time the app waits after you stop typing before writing to the markdown files.
            </p>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.6rem',
                background: 'var(--canvas)',
                padding: '0.5rem 0.85rem',
                borderRadius: '6px',
                border: '1px solid var(--border-subtle)',
                width: 'fit-content'
              }}
            >
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 500 }}>Delay:</span>
              <input
                type="number"
                min="0.5"
                max="300"
                step="0.5"
                value={autosaveDelaySec}
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  if (!isNaN(val)) onSetAutosaveDelay(val);
                }}
                style={{
                  width: '65px',
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  color: 'var(--accent-cyan)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.9rem',
                  fontWeight: 600
                }}
              />
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>seconds</span>
            </div>
          </div>

          {/* Section 3b: Agent Execution Pipeline Tuning */}
          <div
            style={{
              background: 'var(--surface-1)',
              border: '1px solid var(--border-subtle)',
              borderRadius: '8px',
              padding: '1.1rem'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.4rem' }}>
              <Workflow size={16} color="var(--accent-violet)" />
              <span style={{ fontSize: '0.92rem', fontWeight: 600, color: 'var(--text-bright)' }}>Agent Pipeline</span>
            </div>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.85rem', lineHeight: '1.4' }}>
              Tuning for the task execution engine (Vector Context → Summary → Manager fan-out → Cleaner → Verifier). Every knob trades tokens and latency against thoroughness.
            </p>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '0.85rem' }}>
              {/* Max concurrent sub-agents */}
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.4rem' }}>
                  <Users size={13} color="var(--accent-primary)" />
                  <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-bright)' }}>Max concurrent sub-agents</span>
                </div>
                <div style={pipelineInputBoxStyle}>
                  <input
                    type="number"
                    min={PIPELINE_LIMITS.maxConcurrentAgents.min}
                    max={PIPELINE_LIMITS.maxConcurrentAgents.max}
                    step="1"
                    value={agentPipelineOptions.maxConcurrentAgents}
                    onChange={(e) => setPipelineNumber('maxConcurrentAgents', e.target.value)}
                    style={pipelineNumberInputStyle}
                    aria-label="Maximum concurrent sub-agents"
                  />
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>workers (1–8)</span>
                </div>
                <p style={pipelineHelpStyle}>More workers finish faster but share the prompt cache less well and can hit rate limits.</p>
              </div>

              {/* Verifier retries */}
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.4rem' }}>
                  <RotateCw size={13} color="var(--accent-rose)" />
                  <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-bright)' }}>Verifier retries</span>
                </div>
                <div style={pipelineInputBoxStyle}>
                  <input
                    type="number"
                    min={PIPELINE_LIMITS.maxVerifierRetries.min}
                    max={PIPELINE_LIMITS.maxVerifierRetries.max}
                    step="1"
                    value={agentPipelineOptions.maxVerifierRetries}
                    onChange={(e) => setPipelineNumber('maxVerifierRetries', e.target.value)}
                    style={pipelineNumberInputStyle}
                    aria-label="Maximum verifier retries"
                  />
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>retries (0–5)</span>
                </div>
                <p style={pipelineHelpStyle}>For tasks with Verification switched on (task menu): each verifier failure sends the work back to the manager with the diagnostics; 0 means report and stop.</p>
              </div>

              {/* Tool rounds per agent */}
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.4rem' }}>
                  <Repeat size={13} color="var(--accent-cyan)" />
                  <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-bright)' }}>Tool rounds per agent</span>
                </div>
                <div style={pipelineInputBoxStyle}>
                  <input
                    type="number"
                    min={PIPELINE_LIMITS.maxToolRoundsPerAgent.min}
                    max={PIPELINE_LIMITS.maxToolRoundsPerAgent.max}
                    step="5"
                    value={agentPipelineOptions.maxToolRoundsPerAgent}
                    onChange={(e) => setPipelineNumber('maxToolRoundsPerAgent', e.target.value)}
                    style={pipelineNumberInputStyle}
                    aria-label="Maximum tool-call rounds per agent"
                  />
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>rounds (5–120)</span>
                </div>
                <p style={pipelineHelpStyle}>Upper bound on LLM round-trips per agent loop; higher lets long jobs finish but each round re-reads the whole context.</p>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', marginTop: '0.9rem', paddingTop: '0.75rem', borderTop: '1px solid var(--border-subtle)' }}>
              {/* Cleaner pass toggle */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <Sparkles size={13} color="var(--accent-amber)" />
                    <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-bright)' }}>Cleaner pass for coding tasks</span>
                    <span
                      className={`badge ${agentPipelineOptions.enableCleaner ? 'badge-done' : ''}`}
                      style={{
                        fontSize: '0.62rem',
                        padding: '0.05rem 0.35rem',
                        background: agentPipelineOptions.enableCleaner ? undefined : 'var(--surface-2)',
                        color: agentPipelineOptions.enableCleaner ? undefined : 'var(--text-muted)'
                      }}
                    >
                      {agentPipelineOptions.enableCleaner ? 'ON' : 'OFF'}
                    </span>
                  </div>
                  <p style={{ ...pipelineHelpStyle, marginTop: '0.25rem' }}>Lint/format sweep over newly written code — one extra agent run, skipped automatically for non-coding tasks.</p>
                </div>
                <button
                  type="button"
                  className={`toggle-switch-btn ${agentPipelineOptions.enableCleaner ? 'is-active' : ''}`}
                  onClick={() => setPipelineOption('enableCleaner', !agentPipelineOptions.enableCleaner)}
                  aria-label="Toggle cleaner pass for coding tasks"
                  style={{ flexShrink: 0, marginTop: '0.1rem' }}
                >
                  <div className="toggle-switch-thumb" />
                </button>
              </div>

            </div>
          </div>

          {/* Section 4: Vector Memory & Knowledge Store */}
          <div
            style={{
              background: 'var(--accent-subtle)',
              border: '1px solid var(--line-strong)',
              borderRadius: '8px',
              padding: '1rem'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4rem', flexWrap: 'wrap', gap: '0.5rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Database size={16} color="var(--accent-cyan)" />
                <span style={{ fontSize: '0.92rem', fontWeight: 600, color: 'var(--text-bright)' }}>Vector Memory & Baseline Context</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                <span
                  style={{
                    fontSize: '0.68rem',
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--accent-cyan)',
                    background: 'var(--accent-subtle)',
                    border: '1px solid var(--line-strong)',
                    borderRadius: '4px',
                    padding: '0.1rem 0.4rem'
                  }}
                  title="Chunks stored for this active project"
                >
                  {projectChunkCount ?? '…'} chunk{projectChunkCount === 1 ? '' : 's'} (active project)
                </span>
                <span
                  style={{
                    fontSize: '0.68rem',
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--text-muted)',
                    background: 'var(--surface-2)',
                    borderRadius: '4px',
                    padding: '0.1rem 0.4rem'
                  }}
                  title="Total chunks across all projects in the local memory store"
                >
                  {totalChunkCount ?? '…'} total
                </span>
              </div>
            </div>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.85rem', lineHeight: '1.4' }}>
              Local on-disk vector store run by the Ergo bridge (`all-MiniLM-L6-v2`, 384-dim), so the browser stays light as projects grow. Every task item is keyed strictly on its internal ID, isolated by project, and automatically overwrites on rerun.
            </p>

            <div style={{ display: 'flex', gap: '0.65rem', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-secondary"
                style={{
                  fontSize: '0.8rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                  color: 'var(--accent-amber)',
                  borderColor: 'var(--line-strong)'
                }}
                onClick={handleClearProjectMemoryClick}
                disabled={isClearingProjectMemory || !onClearProjectMemory}
              >
                <Trash2 size={13} />
                <span>{isClearingProjectMemory ? 'Clearing…' : `Clear "${activeProject.name || activeProject.id}" Memory`}</span>
              </button>

              <button
                type="button"
                className="btn btn-secondary"
                style={{
                  fontSize: '0.8rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                  color: 'var(--accent-rose)',
                  borderColor: 'var(--line-strong)'
                }}
                onClick={handleClearAllMemoryClick}
                disabled={isClearingAllMemory || !onClearAllMemory}
              >
                <RotateCw size={13} />
                <span>{isClearingAllMemory ? 'Resetting…' : 'Reset Entire Vector DB'}</span>
              </button>
            </div>
          </div>

          {/* Section: Local AI model (Qwen 2.5 Coder 0.5B) — also for people who skipped it in onboarding */}
          <div
            style={{
              background: 'var(--surface-1)',
              border: '1px solid var(--border-subtle)',
              borderRadius: '8px',
              padding: '1.1rem'
            }}
          >
            <LocalModelSettingsSection
              controller={localModel}
              mode={localModelMode}
              cloudLabel={tinyCloudModelLabel?.trim() || 'a small cloud model'}
              onSetMode={(mode) => onSetLocalModelMode?.(mode)}
            />
          </div>

          {/* Section: Model data for Auto model selection (strengths + prices) */}
          <div
            style={{
              background: 'var(--surface-1)',
              border: '1px solid var(--border-subtle)',
              borderRadius: '8px',
              padding: '1.1rem'
            }}
          >
            <ModelDataSettingsSection modelData={modelData} onSetModelData={onSetModelData} />
          </div>

          {/* Section: Task Autocomplete Settings */}
          <div
            style={{
              background: 'var(--surface-1)',
              border: '1px solid var(--border-subtle)',
              borderRadius: '8px',
              padding: '1.1rem'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', marginBottom: '0.8rem' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Sparkles size={16} color="var(--accent-cyan)" />
                  <span style={{ fontSize: '0.92rem', fontWeight: 600, color: 'var(--text-bright)' }}>AI & Vector Autocomplete</span>
                  <span
                    className={`badge ${autocompleteSettings.enabled ? 'badge-done' : ''}`}
                    style={{
                      fontSize: '0.65rem',
                      padding: '0.1rem 0.4rem',
                      background: autocompleteSettings.enabled ? undefined : 'var(--surface-2)',
                      color: autocompleteSettings.enabled ? undefined : 'var(--text-muted)'
                    }}
                  >
                    {autocompleteSettings.enabled ? 'ENABLED' : 'DISABLED'}
                  </span>
                </div>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.35rem', lineHeight: '1.45' }}>
                  Suggests the rest of a task as you type, after you pause on a space, using your AI profile's small model. Suggestions from the local AI model are a beta feature.
                </p>
              </div>

              <button
                type="button"
                className={`toggle-switch-btn ${autocompleteSettings.enabled ? 'is-active' : ''}`}
                onClick={() => onSetAutocompleteSettings?.({ ...autocompleteSettings, enabled: !autocompleteSettings.enabled })}
                aria-label="Toggle autocomplete"
                style={{ flexShrink: 0, marginTop: '0.2rem' }}
              >
                <div className="toggle-switch-thumb" />
              </button>
            </div>

            {autocompleteSettings.enabled && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginTop: '0.8rem', paddingTop: '0.8rem', borderTop: '1px solid var(--line)' }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 500 }}>Accept Keybinding:</span>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  {(['Tab', 'ArrowRight', 'Enter'] as const).map((key) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => onSetAutocompleteSettings?.({ ...autocompleteSettings, keybinding: key })}
                      style={{
                        padding: '0.25rem 0.65rem',
                        fontSize: '0.75rem',
                        fontFamily: 'var(--font-mono)',
                        borderRadius: '4px',
                        border: '1px solid',
                        borderColor: autocompleteSettings.keybinding === key ? 'var(--accent-cyan)' : 'var(--border-subtle)',
                        background: autocompleteSettings.keybinding === key ? 'var(--accent-subtle)' : 'var(--canvas)',
                        color: autocompleteSettings.keybinding === key ? 'var(--accent-cyan)' : 'var(--text-muted)',
                        cursor: 'pointer'
                      }}
                    >
                      {key}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Section: Experimental & Beta Features */}
          <div
            style={{
              background: isBetaEnabled ? 'var(--warning-subtle)' : 'var(--surface-1)',
              border: isBetaEnabled ? '1px solid var(--line-strong)' : '1px solid var(--border-subtle)',
              borderRadius: '8px',
              padding: '1.1rem',
              transition: 'border-color 0.2s ease, background 0.2s ease'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Beaker size={16} color="var(--accent-amber)" />
                  <span style={{ fontSize: '0.92rem', fontWeight: 600, color: 'var(--text-bright)' }}>Enable Beta features</span>
                  <span
                    className={`badge ${isBetaEnabled ? 'badge-done' : ''}`}
                    style={{
                      fontSize: '0.65rem',
                      padding: '0.1rem 0.4rem',
                      background: isBetaEnabled ? 'var(--warning-subtle)' : 'var(--surface-2)',
                      color: isBetaEnabled ? 'var(--warning)' : 'var(--text-muted)',
                      border: isBetaEnabled ? '1px solid var(--line-strong)' : undefined
                    }}
                  >
                    {isBetaEnabled ? 'BETA ACTIVE' : 'OFF'}
                  </span>
                </div>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.35rem', lineHeight: '1.45' }}>
                  Unlock experimental capabilities and preview upcoming tools before they are enabled by default. Early-access features (like the human workspace action tray) will be visible across the app while active.
                </p>
              </div>

              <button
                type="button"
                className={`toggle-switch-btn ${isBetaEnabled ? 'is-active' : ''}`}
                onClick={() => setIsBetaEnabled(!isBetaEnabled)}
                aria-label="Enable Beta features"
                style={{ flexShrink: 0, marginTop: '0.2rem' }}
              >
                <div className="toggle-switch-thumb" />
              </button>
            </div>
          </div>

          {/* Section 5: Target File Paths & Status */}
          <div
            style={{
              background: 'var(--surface-1)',
              border: '1px solid var(--border-subtle)',
              borderRadius: '8px',
              padding: '1rem'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.6rem' }}>
              <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'none', letterSpacing: 'normal' }}>
                Active Project Target Files
              </span>

              {/* Live Status indicator in modal */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem' }}>
                {autosaveStatus === 'saving' && (
                  <>
                    <RotateCw size={13} className="spin-animate" color="var(--accent-cyan)" />
                    <span style={{ color: 'var(--accent-cyan)', fontWeight: 600 }}>Saving...</span>
                  </>
                )}
                {autosaveStatus === 'pending' && (
                  <>
                    <Clock size={13} color="var(--accent-amber)" />
                    <span style={{ color: 'var(--accent-amber)', fontWeight: 600 }}>Queued ({autosaveDelaySec}s)</span>
                  </>
                )}
                {autosaveStatus === 'saved' && (
                  <>
                    <CheckCheck size={13} color="var(--accent-emerald)" />
                    <span style={{ color: 'var(--accent-emerald)', fontWeight: 600 }}>In Sync</span>
                  </>
                )}
                {autosaveStatus === 'error' && (
                  <>
                    <AlertCircle size={13} color="var(--danger)" />
                    <span style={{ color: 'var(--danger)', fontWeight: 600 }}>Save Error</span>
                  </>
                )}
                {autosaveStatus === 'idle' && (
                  <span style={{ color: 'var(--text-muted)' }}>Ready</span>
                )}
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-bright)' }}>
                <Folder size={14} color="var(--accent-amber)" />
                <span>{activeProject?.folderPath || 'projects/default-workspace'}/</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-cyan)', paddingLeft: '1.2rem' }}>
                <CheckSquare size={13} color="var(--accent-cyan)" />
                <span>{todoPath}</span>
              </div>
            </div>

            {lastSavedAt && (
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.65rem', borderTop: '1px solid var(--line)', paddingTop: '0.5rem' }}>
                Last disk write: <strong>{new Date(lastSavedAt).toLocaleTimeString()}</strong> ({new Date(lastSavedAt).toLocaleDateString()})
              </div>
            )}

            {/* Workspace File Downloads & Export */}
            <div
              style={{
                marginTop: '0.85rem',
                paddingTop: '0.75rem',
                borderTop: '1px solid var(--line)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '0.6rem'
              }}
            >
              <div>
                <div style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-bright)' }}>
                  Workspace File Downloads
                </div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                  Download and export workspace markdown files (.md) directly to your system.
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                {onOpenRawMarkdownModal && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ fontSize: '0.78rem', padding: '0.35rem 0.65rem' }}
                    onClick={() => {
                      onClose();
                      onOpenRawMarkdownModal();
                    }}
                    title="Preview and edit raw workspace markdown files before downloading"
                  >
                    <FolderOpen size={13} color="var(--accent-cyan)" />
                    <span>Preview Markdown</span>
                  </button>
                )}
                {onExportProject && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ fontSize: '0.78rem', padding: '0.35rem 0.75rem' }}
                    onClick={onExportProject}
                    title="Download all workspace markdown files (.md)"
                  >
                    <Download size={13} color="var(--accent-cyan)" />
                    <span>Download Files (.md)</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="modal-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
            <button
              type="button"
              className="btn btn-outline-glow"
              style={{ fontSize: '0.82rem' }}
              onClick={() => onSaveImmediately()}
            >
              <Save size={14} />
              <span>Save to Disk Now</span>
            </button>
            {onExportProject && (
              <button
                type="button"
                className="btn btn-secondary"
                style={{ fontSize: '0.82rem' }}
                onClick={onExportProject}
                title="Download all workspace markdown files (.md)"
              >
                <Download size={14} color="var(--accent-cyan)" />
                <span>Download (.md)</span>
              </button>
            )}
          </div>

          <button type="button" className="btn btn-primary" onClick={onClose}>
            <Check size={15} />
            <span>Done</span>
          </button>
        </div>
      </div>
    </div>
  );
};


/* ───────────── Embedded sections (Settings page) ───────────── */

interface EmbeddedSettingsSectionProps {
  section: SettingsModalSection;
  activeProject: ProjectData;
  todoPath: string;
  folderMetadata: FolderMetadata;
  onOpenFolderPicker: () => void;
  isScanning: boolean;
  onScan: () => void;
  storagePathInput: string;
  setStoragePathInput: (v: string) => void;
  isSavingPath: boolean;
  pathSaveSuccess: boolean;
  onSaveStoragePath: () => void;
  onResetStoragePath: () => void;
  canSaveStoragePath: boolean;
  autosaveStatus: AutosaveStatus;
  autosaveDelaySec: number;
  isAutosaveEnabled: boolean;
  lastSavedAt: string | null;
  onSetAutosaveDelay: (seconds: number) => void;
  onToggleAutosave: (enabled: boolean) => void;
  onSaveImmediately: () => void;
  theme: 'light' | 'dark';
  onThemeChange: (theme: 'light' | 'dark') => void;
  agentPipelineOptions: AgentPipelineOptions;
  setPipelineOption: <K extends keyof AgentPipelineOptions>(key: K, value: AgentPipelineOptions[K]) => void;
  setPipelineNumber: (key: 'maxConcurrentAgents' | 'maxVerifierRetries' | 'maxToolRoundsPerAgent', raw: string) => void;
  autocompleteSettings: AutocompleteSettings;
  onSetAutocompleteSettings?: (next: AutocompleteSettings) => void;
  isBetaEnabled: boolean;
  setIsBetaEnabled: (v: boolean) => void;
  onExportProject?: () => void;
  onOpenRawMarkdownModal?: () => void;
  bridgeStatus: BridgeStatus;
  bridgeUrlInput: string;
  setBridgeUrlInput: (v: string) => void;
  isTestingBridge: boolean;
  bridgeNotice: { type: 'success' | 'error'; text: string } | null;
  onTestBridge: () => void;
  localModel: LocalModelInstallController;
  localModelMode: LocalModelMode;
  onSetLocalModelMode?: (mode: 'local' | 'cloud') => void;
  tinyCloudModelLabel?: string;
  modelData: ModelDataSettings;
  onSetModelData?: (next: ModelDataSettings) => void;
  projectChunkCount: number | null;
  totalChunkCount: number | null;
  isClearingProjectMemory: boolean;
  isClearingAllMemory: boolean;
  onClearProjectMemory?: () => void;
  onClearAllMemory?: () => void;
}

const AUTOSAVE_TEXT: Record<AutosaveStatus, string> = {
  idle: 'Up to date.',
  pending: 'Waiting for you to stop typing.',
  saving: 'Saving…',
  saved: 'Saved to TODO.md.',
  error: "The last save didn't reach the disk. Your edits are still here; Ergo tries again on the next change."
};

const ACCEPT_KEYS: Array<{ id: AutocompleteSettings['keybinding']; label: string }> = [
  { id: 'Tab', label: 'Tab' },
  { id: 'ArrowRight', label: '→' },
  { id: 'Enter', label: '↵' }
];

const numberInputStyle: React.CSSProperties = { width: 80, fontVariantNumeric: 'tabular-nums' };

/** Settings › General › Name: the project's display name (its folder and id don't change). */
const ProjectNameRow: React.FC<{ projectId: string; name: string }> = ({ projectId, name }) => {
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);
  const changed = draft.trim() !== '' && draft.trim() !== name;
  const save = () => {
    if (changed) setProjectDisplayName(projectId, draft);
  };
  return (
    <SettingsRow title="Name" help="What Ergo calls this project in the top bar and project menu.">
      <div className="eg-settings-actions">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') setDraft(name);
          }}
          aria-label="Project name"
          style={{ width: 200 }}
        />
        <Button size="sm" variant={changed ? 'primary' : 'secondary'} disabled={!changed} onClick={save}>
          Rename
        </Button>
      </div>
    </SettingsRow>
  );
};

const EmbeddedSettingsSection: React.FC<EmbeddedSettingsSectionProps> = (p) => {
  const storageDir = p.folderMetadata.storageDirectory || '~/.ergo';

  if (p.section === 'appearance') {
    return (
      <SettingsGroup title="Theme">
        <SettingsRow title="Theme" help="Applies right away and is saved for every project.">
          <SegmentedControl
            label="Theme"
            options={[
              { id: 'dark', label: 'Dark' },
              { id: 'light', label: 'Light' }
            ]}
            value={p.theme}
            onChange={p.onThemeChange}
          />
        </SettingsRow>
      </SettingsGroup>
    );
  }

  if (p.section === 'bridge') {
    const download = getBridgeDownload();
    const connected = p.bridgeStatus.isConnected;
    return (
      <>
        <SettingsGroup title="Ergo Bridge">
          <SettingsRow
            title={
              <span className="eg-settings-inline">
                <StatusDot state={connected ? 'success' : p.bridgeStatus.isChecking ? 'live' : 'warning'} />
                {connected ? 'Connected' : p.bridgeStatus.isChecking ? 'Connecting' : 'Bridge unreachable'}
              </span>
            }
            help={
              connected
                ? `Connected to this computer at ${p.bridgeStatus.url}. Ergo can reach your local files and run agents here.`
                : download
                  ? 'A small app that lets Ergo reach your files and run agents on this computer. Install it once; it starts with your computer and Ergo connects to it automatically. Tasks still save while it is away.'
                  : 'Ergo Bridge runs on Windows, macOS and Linux. Open Ergo on one of those to connect it.'
            }
          >
            {download && (
              <div className="eg-settings-actions">
                {!connected && (
                  <a className="eg-btn eg-btn-ghost eg-btn-sm" href={BRIDGE_LAUNCH_URL}>
                    Open bridge
                  </a>
                )}
                <BridgeDownloadButton subtle={connected} size="sm" />
              </div>
            )}
          </SettingsRow>
          <SettingsRow
            title="Last heard from"
            help={p.bridgeStatus.lastHeartbeat ? new Date(p.bridgeStatus.lastHeartbeat).toLocaleTimeString() : 'No contact yet.'}
          />
        </SettingsGroup>
        <SettingsGroup title="Address">
          <SettingsRow
            title="Bridge address"
            help={
              p.bridgeNotice ? (
                <span className={p.bridgeNotice.type === 'success' ? 'eg-settings-ok' : 'eg-settings-bad'}>{p.bridgeNotice.text}</span>
              ) : (
                'Where Ergo looks for the bridge. Change it only if you run the bridge on another port.'
              )
            }
          >
            <div className="eg-settings-actions">
              <Input
                mono
                value={p.bridgeUrlInput}
                onChange={(e) => p.setBridgeUrlInput(e.target.value)}
                placeholder="http://localhost:5173"
                aria-label="Bridge address"
                style={{ width: 220 }}
              />
              <Button size="sm" icon={RefreshCw} onClick={p.onTestBridge} disabled={p.isTestingBridge}>
                {p.isTestingBridge ? 'Connecting…' : 'Test connection'}
              </Button>
            </div>
          </SettingsRow>
        </SettingsGroup>
      </>
    );
  }

  if (p.section === 'memory') {
    return (
      <SettingsGroup title="Search memory">
        <SettingsRow
          title={`This project · ${p.projectChunkCount ?? '…'} ${p.projectChunkCount === 1 ? 'entry' : 'entries'}`}
          help="Task summaries and notes the agent searches before it works. Stored by the bridge on this computer."
        >
          <Button size="sm" variant="secondary" icon={Trash2} onClick={p.onClearProjectMemory} disabled={p.isClearingProjectMemory || !p.onClearProjectMemory}>
            {p.isClearingProjectMemory ? 'Clearing…' : 'Clear project memory'}
          </Button>
        </SettingsRow>
        <SettingsRow title={`All projects · ${p.totalChunkCount ?? '…'} ${p.totalChunkCount === 1 ? 'entry' : 'entries'}`} help="Deletes the whole local memory database. Your tasks and TODO.md are not affected.">
          <Button size="sm" variant="danger" icon={RotateCw} onClick={p.onClearAllMemory} disabled={p.isClearingAllMemory || !p.onClearAllMemory}>
            {p.isClearingAllMemory ? 'Resetting…' : 'Reset all memory'}
          </Button>
        </SettingsRow>
      </SettingsGroup>
    );
  }

  if (p.section === 'models') {
    const o = p.agentPipelineOptions;
    return (
      <>
        <SettingsGroup title="Runs">
          <SettingsRow title="Parallel workers" help="1 to 8. More workers finish sooner but can hit rate limits.">
            <Input
              type="number"
              min={PIPELINE_LIMITS.maxConcurrentAgents.min}
              max={PIPELINE_LIMITS.maxConcurrentAgents.max}
              step={1}
              value={o.maxConcurrentAgents}
              onChange={(e) => p.setPipelineNumber('maxConcurrentAgents', e.target.value)}
              aria-label="Parallel workers"
              style={numberInputStyle}
            />
          </SettingsRow>
          <SettingsRow title="Verifier retries" help="0 to 5. For tasks with verification on, each failed check sends the work back once more; 0 reports and stops.">
            <Input
              type="number"
              min={PIPELINE_LIMITS.maxVerifierRetries.min}
              max={PIPELINE_LIMITS.maxVerifierRetries.max}
              step={1}
              value={o.maxVerifierRetries}
              onChange={(e) => p.setPipelineNumber('maxVerifierRetries', e.target.value)}
              aria-label="Verifier retries"
              style={numberInputStyle}
            />
          </SettingsRow>
          <SettingsRow title="Tool rounds per agent" help="5 to 120. Higher lets long jobs finish; each round re-reads the whole context.">
            <Input
              type="number"
              min={PIPELINE_LIMITS.maxToolRoundsPerAgent.min}
              max={PIPELINE_LIMITS.maxToolRoundsPerAgent.max}
              step={5}
              value={o.maxToolRoundsPerAgent}
              onChange={(e) => p.setPipelineNumber('maxToolRoundsPerAgent', e.target.value)}
              aria-label="Tool rounds per agent"
              style={numberInputStyle}
            />
          </SettingsRow>
          <SettingsRow title="Cleanup pass" help="Lints and formats new code after coding tasks. One extra agent run; skipped for other tasks.">
            <Switch checked={!!o.enableCleaner} onChange={() => p.setPipelineOption('enableCleaner', !o.enableCleaner)} aria-label="Cleanup pass" />
          </SettingsRow>
        </SettingsGroup>
        <LocalModelSettingsSection
          embedded
          controller={p.localModel}
          mode={p.localModelMode}
          cloudLabel={p.tinyCloudModelLabel?.trim() || 'a small cloud model'}
          onSetMode={(mode) => p.onSetLocalModelMode?.(mode)}
        />
        <ModelDataSettingsSection embedded modelData={p.modelData} onSetModelData={p.onSetModelData} />
      </>
    );
  }

  // general
  const ac = p.autocompleteSettings;
  return (
    <>
      <SettingsGroup title="Project">
        <ProjectNameRow projectId={p.activeProject.id} name={p.activeProject.name || p.activeProject.id} />
        <SettingsRow
          title="Folder"
          help="Renaming the folder isn't available yet: briefs and memory are keyed by it."
        >
          <Input mono disabled value={p.activeProject.folderPath || 'No folder'} aria-label="Project folder" style={{ width: 260 }} />
        </SettingsRow>
        <SettingsRow
          title="Task list file"
          help="Renaming the file isn't available yet: task ids and their briefs are keyed by it."
        >
          <Input mono disabled value={p.todoPath} aria-label="Task list file" style={{ width: 260 }} />
        </SettingsRow>
        {(p.onExportProject || p.onOpenRawMarkdownModal) && (
          <SettingsRow title="Export" help="Download the project's markdown files.">
            <div className="eg-settings-actions">
              {p.onOpenRawMarkdownModal && (
                <Button size="sm" variant="ghost" icon={Eye} onClick={p.onOpenRawMarkdownModal}>
                  Preview markdown
                </Button>
              )}
              {p.onExportProject && (
                <Button size="sm" icon={Download} onClick={p.onExportProject}>
                  Download files
                </Button>
              )}
            </div>
          </SettingsRow>
        )}
      </SettingsGroup>

      <SettingsGroup title="Editor">
        <SettingsRow title="Autocomplete" help="Suggests the rest of a task after you pause on a space, using your profile's small model or the local model.">
          <Switch
            checked={ac.enabled}
            onChange={() => p.onSetAutocompleteSettings?.({ ...ac, enabled: !ac.enabled })}
            aria-label="Autocomplete"
          />
        </SettingsRow>
        {ac.enabled && (
          <SettingsRow title="Accept a suggestion with">
            <SegmentedControl
              label="Accept a suggestion with"
              options={ACCEPT_KEYS}
              value={ac.keybinding}
              onChange={(k) => p.onSetAutocompleteSettings?.({ ...ac, keybinding: k })}
            />
          </SettingsRow>
        )}
        <SettingsRow title="Beta features" help="Preview features before they are on by default. They show up across the app while this is on.">
          <Switch checked={p.isBetaEnabled} onChange={() => p.setIsBetaEnabled(!p.isBetaEnabled)} aria-label="Beta features" />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Advanced">
        <SettingsRow
          title="Save to disk automatically"
          help={
            p.isAutosaveEnabled
              ? `${AUTOSAVE_TEXT[p.autosaveStatus]}${p.lastSavedAt ? ` Last written ${new Date(p.lastSavedAt).toLocaleTimeString()}.` : ''}`
              : 'Off. Changes stay in Ergo until you save them.'
          }
        >
          <div className="eg-settings-actions">
            {!p.isAutosaveEnabled && (
              <Button size="sm" icon={Save} onClick={p.onSaveImmediately}>
                Save now
              </Button>
            )}
            <Switch checked={p.isAutosaveEnabled} onChange={() => p.onToggleAutosave(!p.isAutosaveEnabled)} aria-label="Save to disk automatically" />
          </div>
        </SettingsRow>
        <SettingsRow title="Save delay" help="Seconds Ergo waits after you stop typing before writing TODO.md.">
          <Input
            type="number"
            min={0.5}
            max={300}
            step={0.5}
            value={p.autosaveDelaySec}
            disabled={!p.isAutosaveEnabled}
            onChange={(e) => {
              const val = parseFloat(e.target.value);
              if (!isNaN(val)) p.onSetAutosaveDelay(val);
            }}
            aria-label="Save delay in seconds"
            style={numberInputStyle}
          />
        </SettingsRow>
        <SettingsRow
          title="Storage folder"
          help={
            p.pathSaveSuccess ? (
              <span className="eg-settings-ok">Storage folder updated.</span>
            ) : (
              <>
                Where Ergo keeps tasks, briefs, settings and secrets.
                {p.folderMetadata.resolvedPath && (
                  <>
                    {' '}On disk: <span className="eg-settings-mono">{p.folderMetadata.resolvedPath}</span>
                  </>
                )}
                {p.folderMetadata.status === 'needs_permission' && ' Ergo needs permission to use this folder again.'}
              </>
            )
          }
        >
          <div className="eg-settings-actions">
            <Input
              mono
              value={p.storagePathInput}
              onChange={(e) => p.setStoragePathInput(e.target.value)}
              placeholder="~/.ergo"
              aria-label="Storage folder"
              style={{ width: 180 }}
            />
            <Button
              size="sm"
              onClick={p.onSaveStoragePath}
              disabled={!p.canSaveStoragePath || p.isSavingPath || p.storagePathInput === storageDir}
            >
              {p.isSavingPath ? 'Applying…' : 'Apply'}
            </Button>
          </div>
        </SettingsRow>
        <SettingsRow title="Choose another folder" help="Pick the storage folder with your system's folder picker, or rescan it for projects.">
          <div className="eg-settings-actions">
            {p.storagePathInput !== '~/.ergo' && (
              <Button size="sm" variant="ghost" onClick={p.onResetStoragePath}>
                Use default
              </Button>
            )}
            <Button size="sm" variant="ghost" icon={RefreshCw} onClick={p.onScan} disabled={p.isScanning}>
              {p.isScanning ? 'Scanning…' : 'Rescan'}
            </Button>
            <Button size="sm" icon={FolderOpen} onClick={p.onOpenFolderPicker}>
              Choose folder
            </Button>
          </div>
        </SettingsRow>
        <SettingsRow
          title="Secrets"
          help={
            <>
              API keys and integration tokens are stored in <span className="eg-settings-mono">{storageDir}/config/secrets.json</span>, next to{' '}
              <span className="eg-settings-mono">config/settings.json</span> and your <span className="eg-settings-mono">projects/</span>.
            </>
          }
        />
      </SettingsGroup>
    </>
  );
};
