import React, { useState } from 'react';
import { type FolderMetadata } from '../types';
import {
  Folder,
  X,
  HardDrive,
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
  FileCode,
  Lock,
  ArrowRight,
  RotateCw,
  FolderOpen
} from 'lucide-react';

interface FolderPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  folderMetadata: FolderMetadata;
  onSelectFolder: () => Promise<void>;
  onRequestPermission: () => Promise<void>;
  onUseServerFallback: () => void;
}

export const FolderPickerModal: React.FC<FolderPickerModalProps> = ({
  isOpen,
  onClose,
  folderMetadata,
  onSelectFolder,
  onRequestPermission,
  onUseServerFallback
}) => {
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!isOpen) return null;

  const handlePick = async () => {
    setIsLoading(true);
    setErrorMsg(null);
    try {
      await onSelectFolder();
      onClose();
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        setErrorMsg(err?.message || 'Failed to select directory');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleGrant = async () => {
    setIsLoading(true);
    setErrorMsg(null);
    try {
      await onRequestPermission();
      onClose();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Permission request failed');
    } finally {
      setIsLoading(false);
    }
  };

  const isConnected = folderMetadata.status === 'connected';
  const needsPermission = folderMetadata.status === 'needs_permission';

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
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: '8px',
                background: 'rgba(56, 189, 248, 0.12)',
                border: '1px solid rgba(56, 189, 248, 0.3)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--accent-cyan)'
              }}
            >
              <FolderOpen size={20} />
            </div>
            <div>
              <h3 style={{ fontSize: '1.1rem', fontWeight: 700 }}>Local Directory & Secrets Storage</h3>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.1rem' }}>
                Zero cloud database. 100% user-owned local filesystem architecture.
              </p>
            </div>
          </div>
          <button className="btn btn-secondary" style={{ padding: '0.3rem 0.5rem' }} onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {/* Modal Body */}
        <div className="modal-body" style={{ gap: '1.25rem', display: 'flex', flexDirection: 'column' }}>

          {/* Status Banner */}
          <div
            style={{
              background: isConnected
                ? 'rgba(16, 185, 129, 0.08)'
                : needsPermission
                ? 'rgba(245, 158, 11, 0.08)'
                : 'rgba(255, 255, 255, 0.03)',
              border: `1px solid ${
                isConnected
                  ? 'rgba(16, 185, 129, 0.3)'
                  : needsPermission
                  ? 'rgba(245, 158, 11, 0.3)'
                  : 'var(--border-subtle)'
              }`,
              borderRadius: '8px',
              padding: '0.9rem 1.1rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '1rem'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
              {isConnected ? (
                <CheckCircle2 size={20} color="var(--accent-emerald)" />
              ) : needsPermission ? (
                <AlertCircle size={20} color="var(--accent-amber)" />
              ) : (
                <HardDrive size={20} color="var(--accent-cyan)" />
              )}
              <div>
                <div style={{ fontSize: '0.88rem', fontWeight: 600, color: '#fff' }}>
                  {isConnected
                    ? `Connected: ${folderMetadata.name}`
                    : needsPermission
                    ? `Permission Required: ${folderMetadata.name}`
                    : `Active: ${folderMetadata.name}`}
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                  {folderMetadata.mode === 'file_system_api'
                    ? 'Native File System Access API'
                    : 'Local Dev Server Workspace'}
                </div>
              </div>
            </div>

            {needsPermission && (
              <button
                type="button"
                className="btn btn-emerald"
                style={{ fontSize: '0.8rem', padding: '0.35rem 0.75rem' }}
                onClick={handleGrant}
                disabled={isLoading}
              >
                {isLoading ? <RotateCw size={13} className="spin-animate" /> : 'Grant Permission'}
              </button>
            )}
          </div>

          {errorMsg && (
            <div
              style={{
                background: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                padding: '0.65rem 0.85rem',
                borderRadius: '6px',
                color: '#f87171',
                fontSize: '0.8rem',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem'
              }}
            >
              <AlertCircle size={15} />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Folder Architecture Visualization */}
          <div
            style={{
              background: 'rgba(0, 0, 0, 0.35)',
              border: '1px solid var(--border-subtle)',
              borderRadius: '8px',
              padding: '1.1rem'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
              <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Local Folder Architecture
              </span>
              <span style={{ fontSize: '0.72rem', color: 'var(--accent-emerald)', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                <ShieldCheck size={13} />
                No Cloud Keys / No DB
              </span>
            </div>

            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '0.8rem',
                lineHeight: '1.6',
                color: 'var(--text-main)',
                background: 'rgba(255, 255, 255, 0.02)',
                padding: '0.75rem 1rem',
                borderRadius: '6px',
                border: '1px solid rgba(255, 255, 255, 0.05)'
              }}
            >
              <div style={{ color: '#fff', fontWeight: 600 }}>
                📁 /{folderMetadata.name || 'Selected-Folder'}
              </div>
              <div style={{ paddingLeft: '1.2rem', color: 'var(--text-muted)' }}>
                ├── 📁 <span style={{ color: 'var(--accent-cyan)' }}>config/</span>
              </div>
              <div style={{ paddingLeft: '2.4rem', color: 'var(--text-dim)' }}>
                ├── 📄 <span style={{ color: 'var(--accent-cyan)' }}>settings.json</span> <span style={{ opacity: 0.6 }}>(UI preferences & active project)</span>
              </div>
              <div style={{ paddingLeft: '2.4rem', color: 'var(--text-dim)' }}>
                └── 🔒 <span style={{ color: 'var(--accent-amber)' }}>secrets.json</span> <span style={{ opacity: 0.6 }}>(AI keys & MCP auth tokens)</span>
              </div>
              <div style={{ paddingLeft: '1.2rem', color: 'var(--text-muted)' }}>
                └── 📁 <span style={{ color: 'var(--accent-violet)' }}>projects/</span>
              </div>
              <div style={{ paddingLeft: '2.4rem', color: 'var(--text-dim)' }}>
                └── 📁 <span style={{ color: 'var(--accent-violet)' }}>default-workspace/</span>
              </div>
              <div style={{ paddingLeft: '3.6rem', color: 'var(--text-cyan)' }}>
                ├── 📝 TODO.md <span style={{ opacity: 0.6 }}>(Human task list)</span>
              </div>
              <div style={{ paddingLeft: '3.6rem', color: 'var(--text-violet)' }}>
                └── 📝 AGENT_CONTEXT.md <span style={{ opacity: 0.6 }}>(AI implementation briefs)</span>
              </div>
            </div>
          </div>

          {/* Key Advantages Cards */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.85rem' }}>
            <div
              style={{
                background: 'rgba(255, 255, 255, 0.02)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '8px',
                padding: '0.85rem'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: '0.35rem' }}>
                <Lock size={15} color="var(--accent-emerald)" />
                <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#fff' }}>Local Key Privacy</span>
              </div>
              <p style={{ fontSize: '0.76rem', color: 'var(--text-muted)', lineHeight: '1.4' }}>
                AI API keys and MCP tokens are saved into <code style={{ color: 'var(--accent-amber)' }}>secrets.json</code> on your disk and never transmitted to our servers.
              </p>
            </div>

            <div
              style={{
                background: 'rgba(255, 255, 255, 0.02)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '8px',
                padding: '0.85rem'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: '0.35rem' }}>
                <FileCode size={15} color="var(--accent-cyan)" />
                <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#fff' }}>Plain Markdown Files</span>
              </div>
              <p style={{ fontSize: '0.76rem', color: 'var(--text-muted)', lineHeight: '1.4' }}>
                Your tasks and AI briefs are saved as portable Markdown files compatible with Obsidian, VS Code, and Git.
              </p>
            </div>
          </div>

        </div>

        {/* Modal Footer */}
        <div className="modal-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <button
            type="button"
            className="btn btn-secondary"
            style={{ fontSize: '0.82rem' }}
            onClick={() => {
              onUseServerFallback();
              onClose();
            }}
          >
            <span>Use Default Workspace</span>
          </button>

          <div style={{ display: 'flex', gap: '0.6rem' }}>
            <button
              type="button"
              className="btn btn-primary"
              style={{ fontSize: '0.85rem' }}
              onClick={handlePick}
              disabled={isLoading}
            >
              {isLoading ? (
                <>
                  <RotateCw size={14} className="spin-animate" />
                  <span>Opening Picker...</span>
                </>
              ) : (
                <>
                  <Folder size={15} />
                  <span>Select App Folder on Disk</span>
                  <ArrowRight size={14} />
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
