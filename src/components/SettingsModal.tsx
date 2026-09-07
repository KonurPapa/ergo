import React, { useState } from 'react';
import { type ProjectData, type FolderMetadata, type AgentPipelineOptions } from '../types';
import { type AutosaveStatus } from '../hooks/useAutosave';
import {
  Settings,
  X,
  HardDrive,
  Save,
  Check,
  Folder,
  FileText,
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
  FlaskConical,
  Search
} from 'lucide-react';

interface SettingsModalProps {
  isOpen: boolean;
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
}

/** Bounds for the numeric pipeline knobs (kept in sync with the helper text below). */
const PIPELINE_LIMITS = {
  maxConcurrentAgents: { min: 1, max: 8 },
  maxQaRetries: { min: 0, max: 5 },
  maxToolRoundsPerAgent: { min: 5, max: 120 },
  discoveryRelevanceThreshold: { min: 10, max: 90 }
} as const;

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

const pipelineInputBoxStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.6rem',
  background: 'rgba(0, 0, 0, 0.3)',
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
  onSetAgentPipelineOptions
}) => {
  const [isScanning, setIsScanning] = useState(false);
  const [storagePathInput, setStoragePathInput] = useState(
    folderMetadata.storageDirectory || '~/.ergo'
  );
  const [isSavingPath, setIsSavingPath] = useState(false);
  const [pathSaveSuccess, setPathSaveSuccess] = useState(false);

  if (!isOpen) return null;

  const todoPath = activeProject?.todoFilePath || `${activeProject?.folderPath}/TODO.md`;
  const agentPath = activeProject?.agentContextFilePath || `${activeProject?.folderPath}/AGENT_CONTEXT.md`;

  const setPipelineOption = <K extends keyof AgentPipelineOptions>(key: K, value: AgentPipelineOptions[K]) => {
    onSetAgentPipelineOptions({ ...agentPipelineOptions, [key]: value });
  };
  const setPipelineNumber = (key: 'maxConcurrentAgents' | 'maxQaRetries' | 'maxToolRoundsPerAgent' | 'discoveryRelevanceThreshold', raw: string) => {
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
              <h3 style={{ fontSize: '1.1rem', fontWeight: 700 }}>Workspace Settings</h3>
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

          {/* Section 0: Appearance & Theme */}
          <div
            style={{
              background: 'rgba(255, 255, 255, 0.025)',
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
                style={{ fontSize: '0.65rem', padding: '0.1rem 0.4rem', textTransform: 'uppercase' }}
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
                  background: theme === 'light' ? 'rgba(99, 102, 241, 0.12)' : 'var(--bg-darkest, rgba(0, 0, 0, 0.2))',
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'all 0.2s ease',
                  boxShadow: theme === 'light' ? '0 0 14px rgba(99, 102, 241, 0.2)' : 'none'
                }}
              >
                <div
                  style={{
                    width: '32px',
                    height: '32px',
                    borderRadius: '6px',
                    background: theme === 'light' ? 'var(--accent-amber)' : 'rgba(245, 158, 11, 0.15)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: theme === 'light' ? '#fff' : 'var(--accent-amber)',
                    flexShrink: 0
                  }}
                >
                  <Sun size={18} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                    <span style={{ fontSize: '0.86rem', fontWeight: 700, color: 'var(--text-main)' }}>Light Mode</span>
                    <span style={{ fontSize: '0.65rem', background: 'rgba(99, 102, 241, 0.15)', color: 'var(--accent-primary)', padding: '0.05rem 0.3rem', borderRadius: '3px', fontWeight: 600 }}>Default</span>
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
                  background: theme === 'dark' ? 'rgba(99, 102, 241, 0.12)' : 'var(--bg-darkest, rgba(0, 0, 0, 0.2))',
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'all 0.2s ease',
                  boxShadow: theme === 'dark' ? '0 0 14px rgba(99, 102, 241, 0.2)' : 'none'
                }}
              >
                <div
                  style={{
                    width: '32px',
                    height: '32px',
                    borderRadius: '6px',
                    background: theme === 'dark' ? 'var(--accent-violet)' : 'rgba(139, 92, 246, 0.15)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: theme === 'dark' ? '#fff' : 'var(--accent-violet)',
                    flexShrink: 0
                  }}
                >
                  <Moon size={18} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: '0.86rem', fontWeight: 700, color: 'var(--text-main)', display: 'block' }}>Dark Mode</span>
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Sleek deep navy aesthetic</span>
                </div>
                {theme === 'dark' && <Check size={16} color="var(--accent-primary)" style={{ flexShrink: 0 }} />}
              </button>
            </div>
          </div>

          {/* Section 1: Local Directory & Storage Location */}
          <div
            style={{
              background: 'rgba(255, 255, 255, 0.025)',
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
                background: 'rgba(0, 0, 0, 0.1)',
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
          </div>

          {/* Section 2: Sync to Local Files Toggle */}
          <div
            style={{
              background: 'rgba(255, 255, 255, 0.025)',
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
                      background: isAutosaveEnabled ? undefined : 'rgba(255,255,255,0.06)',
                      color: isAutosaveEnabled ? undefined : 'var(--text-muted)'
                    }}
                  >
                    {isAutosaveEnabled ? 'ACTIVE' : 'DISABLED'}
                  </span>
                </div>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.35rem', lineHeight: '1.45' }}>
                  Automatically writes markdown changes directly to <code style={{ color: 'var(--accent-cyan)' }}>TODO.md</code> and <code style={{ color: 'var(--accent-violet)' }}>AGENT_CONTEXT.md</code> on disk when you stop typing.
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
              background: 'rgba(255, 255, 255, 0.025)',
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
                background: 'rgba(0, 0, 0, 0.3)',
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
              background: 'rgba(255, 255, 255, 0.025)',
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
              Tuning for the task execution engine (Discovery → Summary → Manager fan-out → Cleaner → Hardener). Every knob trades tokens and latency against thoroughness.
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

              {/* QA retries */}
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.4rem' }}>
                  <RotateCw size={13} color="var(--accent-rose)" />
                  <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-bright)' }}>QA retries</span>
                </div>
                <div style={pipelineInputBoxStyle}>
                  <input
                    type="number"
                    min={PIPELINE_LIMITS.maxQaRetries.min}
                    max={PIPELINE_LIMITS.maxQaRetries.max}
                    step="1"
                    value={agentPipelineOptions.maxQaRetries}
                    onChange={(e) => setPipelineNumber('maxQaRetries', e.target.value)}
                    style={pipelineNumberInputStyle}
                    aria-label="Maximum QA retries"
                  />
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>retries (0–5)</span>
                </div>
                <p style={pipelineHelpStyle}>Each Hardener failure re-runs the Manager with fresh context plus the diagnostics; 0 means report and stop.</p>
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

              {/* Discovery Relevance Threshold */}
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.4rem' }}>
                  <Search size={13} color="var(--accent-emerald)" />
                  <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-bright)' }}>Discovery Title Threshold</span>
                </div>
                <div style={pipelineInputBoxStyle}>
                  <input
                    type="number"
                    min={PIPELINE_LIMITS.discoveryRelevanceThreshold.min}
                    max={PIPELINE_LIMITS.discoveryRelevanceThreshold.max}
                    step="5"
                    value={agentPipelineOptions.discoveryRelevanceThreshold ?? 50}
                    onChange={(e) => setPipelineNumber('discoveryRelevanceThreshold', e.target.value)}
                    style={pipelineNumberInputStyle}
                    aria-label="Discovery candidate task title match threshold percentage"
                  />
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>% match (10–90%)</span>
                </div>
                <p style={pipelineHelpStyle}>Minimum title match probability before Discovery inspects candidate subtasks; halts upon finding the first matching subtask.</p>
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
                        background: agentPipelineOptions.enableCleaner ? undefined : 'rgba(255,255,255,0.06)',
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

              {/* Hardener QA toggle */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <FlaskConical size={13} color="#a78bfa" />
                    <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-bright)' }}>Hardener QA pass</span>
                    <span
                      className={`badge ${agentPipelineOptions.enableHardener ? 'badge-done' : ''}`}
                      style={{
                        fontSize: '0.62rem',
                        padding: '0.05rem 0.35rem',
                        background: agentPipelineOptions.enableHardener ? undefined : 'rgba(255,255,255,0.06)',
                        color: agentPipelineOptions.enableHardener ? undefined : 'var(--text-muted)'
                      }}
                    >
                      {agentPipelineOptions.enableHardener ? 'ON' : 'OFF'}
                    </span>
                  </div>
                  <p style={{ ...pipelineHelpStyle, marginTop: '0.25rem' }}>Independent QA agent proves the Gherkin scenarios pass; catches silent failures at the cost of one more read-only run (plus any retries above).</p>
                </div>
                <button
                  type="button"
                  className={`toggle-switch-btn ${agentPipelineOptions.enableHardener ? 'is-active' : ''}`}
                  onClick={() => setPipelineOption('enableHardener', !agentPipelineOptions.enableHardener)}
                  aria-label="Toggle hardener QA pass"
                  style={{ flexShrink: 0, marginTop: '0.1rem' }}
                >
                  <div className="toggle-switch-thumb" />
                </button>
              </div>
            </div>
          </div>

          {/* Section 4: Target File Paths & Status */}
          <div
            style={{
              background: 'rgba(255, 255, 255, 0.02)',
              border: '1px solid var(--border-subtle)',
              borderRadius: '8px',
              padding: '1rem'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.6rem' }}>
              <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
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
                    <AlertCircle size={13} color="#ef4444" />
                    <span style={{ color: '#ef4444', fontWeight: 600 }}>Save Error</span>
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
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-violet)', paddingLeft: '1.2rem' }}>
                <FileText size={13} color="var(--accent-violet)" />
                <span>{agentPath}</span>
              </div>
            </div>

            {lastSavedAt && (
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.65rem', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '0.5rem' }}>
                Last disk write: <strong>{new Date(lastSavedAt).toLocaleTimeString()}</strong> ({new Date(lastSavedAt).toLocaleDateString()})
              </div>
            )}
          </div>
        </div>

        {/* Modal Footer */}
        <div className="modal-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <button
            type="button"
            className="btn btn-outline-glow"
            style={{ fontSize: '0.82rem' }}
            onClick={() => onSaveImmediately()}
          >
            <Save size={14} />
            <span>Save to Disk Now</span>
          </button>

          <button type="button" className="btn btn-primary" onClick={onClose}>
            <Check size={15} />
            <span>Done</span>
          </button>
        </div>
      </div>
    </div>
  );
};

