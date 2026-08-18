import React, { useState } from 'react';
import { type ProjectData, type FolderMetadata } from '../types';
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
  ShieldCheck,
  Lock,
  RefreshCw
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
}

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
  onSaveImmediately
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
                Local filesystem directory, secrets storage, and disk synchronization
              </p>
            </div>
          </div>
          <button className="btn btn-secondary" style={{ padding: '0.3rem 0.5rem' }} onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {/* Modal Body */}
        <div className="modal-body" style={{ gap: '1.25rem', display: 'flex', flexDirection: 'column' }}>

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
                <span style={{ fontSize: '0.92rem', fontWeight: 600, color: '#fff' }}>App Storage Folder (Default: ~/.ergo)</span>
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
                Resolved path on disk: <strong style={{ color: '#fff' }}>{folderMetadata.resolvedPath}</strong>
              </div>
            )}

            <div
              style={{
                background: 'rgba(0, 0, 0, 0.3)',
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
              <div style={{ color: '#fff', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
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
                  <span style={{ fontSize: '0.92rem', fontWeight: 600, color: '#fff' }}>Sync to Local Files</span>
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
              <span style={{ fontSize: '0.92rem', fontWeight: 600, color: '#fff' }}>Inactivity Delay</span>
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

          {/* Privacy Note */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', fontSize: '0.75rem', color: 'var(--accent-emerald)', opacity: 0.9 }}>
            <ShieldCheck size={14} />
            <span>Local-First Design: No database accounts, cloud storage bills, or remote API key honeypots.</span>
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

