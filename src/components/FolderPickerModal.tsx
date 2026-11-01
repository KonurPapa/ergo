import React, { useState } from 'react';
import { type FolderMetadata } from '../types';
import { Folder, HardDrive, CircleCheck, CircleX, FileCode, Lock, Loader2 } from 'lucide-react';
import { Banner, Button, Dialog, Icon } from './ui';

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
        setErrorMsg(err?.message || 'Ergo couldn’t open that folder.');
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
      setErrorMsg(err?.message || 'The browser didn’t grant permission.');
    } finally {
      setIsLoading(false);
    }
  };

  const isConnected = folderMetadata.status === 'connected';
  const needsPermission = folderMetadata.status === 'needs_permission';

  const folderName = folderMetadata.name || 'Selected-Folder';
  const tree: Array<{ depth: number; name: string; note?: string }> = [
    { depth: 0, name: `/${folderName}` },
    { depth: 1, name: 'config/' },
    { depth: 2, name: 'settings.json', note: 'UI preferences and active project' },
    { depth: 2, name: 'secrets.json', note: 'AI keys and MCP auth tokens' },
    { depth: 1, name: 'projects/' },
    { depth: 2, name: 'default-workspace/' },
    { depth: 3, name: 'TODO.md', note: 'your task list' },
  ];

  return (
    <Dialog
      title="Local folder and secrets"
      description="Nothing is stored in the cloud: Ergo keeps everything in a folder you own."
      onClose={onClose}
      width={600}
      footer={
        <>
          <Button
            variant="ghost"
            size="lg"
            onClick={() => {
              onUseServerFallback();
              onClose();
            }}
          >
            Use the default workspace
          </Button>
          <span className="eg-spacer" />
          <Button variant="primary" size="lg" icon={isLoading ? undefined : Folder} onClick={handlePick} disabled={isLoading}>
            {isLoading && <Loader2 size={14} strokeWidth={1.75} className="spin-animate" />}
            {isLoading ? 'Opening the picker…' : 'Choose a folder'}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <Banner
          tone={needsPermission ? 'warning' : 'neutral'}
          icon={isConnected ? CircleCheck : needsPermission ? undefined : HardDrive}
          title={
            isConnected
              ? `Connected to ${folderMetadata.name}`
              : needsPermission
                ? `Ergo needs permission to open ${folderMetadata.name}`
                : `Using ${folderMetadata.name}`
          }
          text={folderMetadata.mode === 'file_system_api' ? 'Browser File System Access' : 'Local dev server workspace'}
          actions={
            needsPermission ? (
              <Button size="sm" onClick={handleGrant} disabled={isLoading}>
                {isLoading && <Loader2 size={14} strokeWidth={1.75} className="spin-animate" />}
                Grant permission
              </Button>
            ) : undefined
          }
        />

        {errorMsg && (
          <div className="eg-field-error" role="alert">
            <Icon icon={CircleX} size="sm" />
            {errorMsg}
          </div>
        )}

        <div>
          <div className="eg-section-label" style={{ marginTop: 0 }}>Folder layout</div>
          <div className="dlg-tree">
            {tree.map((n, i) => (
              <div key={i} style={{ paddingLeft: n.depth * 18 }}>
                <span style={{ color: n.depth === 0 ? 'var(--ink)' : 'var(--ink-muted)' }}>{n.name}</span>
                {n.note && <span style={{ color: 'var(--ink-subtle)' }}>  {n.note}</span>}
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 'var(--space-4)' }}>
          <div>
            <div className="eg-hstack" style={{ color: 'var(--ink)', fontWeight: 500 }}>
              <Icon icon={Lock} size="sm" style={{ color: 'var(--ink-subtle)' }} />
              Keys stay on your disk
            </div>
            <p style={{ margin: '2px 0 0', fontSize: 'calc(12px * var(--type-scale))', lineHeight: 'calc(16px * var(--type-scale))' }}>
              AI API keys and MCP tokens are saved in <code className="eg-mono" style={{ fontSize: 'calc(11px * var(--type-scale))' }}>secrets.json</code> and never sent to our servers.
            </p>
          </div>
          <div>
            <div className="eg-hstack" style={{ color: 'var(--ink)', fontWeight: 500 }}>
              <Icon icon={FileCode} size="sm" style={{ color: 'var(--ink-subtle)' }} />
              Plain markdown files
            </div>
            <p style={{ margin: '2px 0 0', fontSize: 'calc(12px * var(--type-scale))', lineHeight: 'calc(16px * var(--type-scale))' }}>
              Tasks and briefs are portable markdown files that work with Obsidian, VS Code and Git.
            </p>
          </div>
        </div>
      </div>
    </Dialog>
  );
};
