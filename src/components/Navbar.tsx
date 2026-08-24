import React, { useState, useRef, useEffect } from 'react';
import { type ProjectData, type MCPServer, type AIProviderConfig, type UserApiKey, type FolderMetadata } from '../types';
import { SUPPORTED_AI_PROVIDERS } from '../lib/aiProviders';
import { type AutosaveStatus } from '../hooks/useAutosave';
import {
  Unplug,
  Download,
  Brain,
  ChevronDown,
  Check,
  Plus,
  Folder,
  Key,
  HardDrive,
  RotateCw,
  CheckCheck,
  AlertCircle,
  Clock,
  Settings
} from 'lucide-react';

interface NavbarProps {
  projects: ProjectData[];
  activeProject: ProjectData;
  onSelectProject: (proj: ProjectData) => void;
  onNewProject: () => void;
  folderMetadata?: FolderMetadata;
  onOpenFolderPicker?: () => void;
  mcpServers: MCPServer[];
  onOpenMcpHub: () => void;
  userApiKeys: UserApiKey[];
  activeKeyId: string | null;
  aiConfig: AIProviderConfig;
  onSelectUserKey: (keyId: string | null) => void;
  onOpenAiScreen: () => void;
  onOpenRawMarkdownModal: () => void;
  onOpenSettingsModal: () => void;
  onSaveImmediately: () => void;
  // Autosave Status
  autosaveStatus: AutosaveStatus;
  autosaveDelaySec: number;
  isAutosaveEnabled: boolean;
}

export const Navbar: React.FC<NavbarProps> = ({
  projects,
  activeProject,
  onSelectProject,
  onNewProject,
  folderMetadata: _folderMetadata,
  onOpenFolderPicker: _onOpenFolderPicker,
  mcpServers,
  onOpenMcpHub,
  userApiKeys,
  activeKeyId,
  aiConfig: _aiConfig,
  onSelectUserKey,
  onOpenAiScreen,
  onOpenRawMarkdownModal,
  onOpenSettingsModal,
  onSaveImmediately,
  autosaveStatus,
  autosaveDelaySec,
  isAutosaveEnabled
}) => {
  const connectedCount = mcpServers.filter((s) => s.status === 'connected').length;

  // Custom Dropdown States
  const [isProjectDropdownOpen, setIsProjectDropdownOpen] = useState(false);
  const [isAiDropdownOpen, setIsAiDropdownOpen] = useState(false);

  const projectDropdownRef = useRef<HTMLDivElement>(null);
  const aiDropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdowns on click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (projectDropdownRef.current && !projectDropdownRef.current.contains(event.target as Node)) {
        setIsProjectDropdownOpen(false);
      }
      if (aiDropdownRef.current && !aiDropdownRef.current.contains(event.target as Node)) {
        setIsAiDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const activeUserKey = userApiKeys.find((k) => k.id === activeKeyId);
  const activeProviderMeta = activeUserKey
    ? SUPPORTED_AI_PROVIDERS.find((p) => p.id === activeUserKey.provider)
    : undefined;

  const activeLabel = activeUserKey
    ? activeUserKey.name
    : 'Select AI Key';

  return (
    <header className="app-header">
      {/* Brand */}
      <div className="brand-logo">
        <div className="brand-badge">Ergo</div>
      </div>

      <div className="header-center">
        {/* Root Folder / Vault Selector Button */}
        {/* <button
          className="folder-selector-btn"
          onClick={onOpenFolderPicker}
          type="button"
          title={`Root Folder: ${folderMetadata.name} (${folderMetadata.status === 'connected'
            ? 'Local Folder Connected'
            : folderMetadata.status === 'needs_permission'
              ? 'Permission Required'
              : 'Local Dev Server Workspace'
            }) - Click to configure`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.45rem',
            background: 'var(--bg-input)',
            border: `1px solid ${folderMetadata.status === 'connected'
              ? 'rgba(16, 185, 129, 0.35)'
              : folderMetadata.status === 'needs_permission'
                ? 'rgba(245, 158, 11, 0.4)'
                : 'var(--border-subtle)'
              }`,
            padding: '0.4rem 0.65rem',
            borderRadius: 'var(--radius-sm)',
            cursor: 'pointer',
            fontSize: '0.8rem',
            color: '#fff',
            transition: 'all 0.15s ease'
          }}
        >
          <FolderOpen
            size={15}
            color={
              folderMetadata.status === 'connected'
                ? 'var(--accent-emerald)'
                : folderMetadata.status === 'needs_permission'
                  ? 'var(--accent-amber)'
                  : 'var(--accent-cyan)'
            }
          />
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', textAlign: 'left', lineHeight: 1.15 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
              <span style={{ fontWeight: 600, fontSize: '0.82rem', maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {folderMetadata.name || 'Select Folder'}
              </span>
              <span
                style={{
                  width: '6px',
                  height: '6px',
                  borderRadius: '50%',
                  background:
                    folderMetadata.status === 'connected'
                      ? 'var(--accent-emerald)'
                      : folderMetadata.status === 'needs_permission'
                        ? 'var(--accent-amber)'
                        : 'var(--accent-cyan)',
                  boxShadow:
                    folderMetadata.status === 'connected'
                      ? '0 0 6px var(--accent-emerald)'
                      : 'none'
                }}
              />
            </div>
            <span style={{ fontSize: '0.66rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
              {folderMetadata.mode === 'file_system_api' ? 'Local-First' : 'Server FS'}
            </span>
          </div>
        </button> */}

        {/* Custom Project Selector Dropdown */}
        <div ref={projectDropdownRef} style={{ position: 'relative' }}>
          <button
            className="project-selector-custom"
            onClick={() => setIsProjectDropdownOpen(!isProjectDropdownOpen)}
            type="button"
            title={`Active Directory: ${activeProject?.folderPath || 'projects/default-workspace'}`}
          >
            <Folder size={18} color="var(--accent-cyan)" />
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', textAlign: 'left', lineHeight: 1.2 }}>
              <span style={{ fontWeight: 600, fontSize: '0.88rem' }}>{activeProject?.name || 'Default Workspace'}</span>
              <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                {activeProject?.folderPath || 'projects/default-workspace'}
              </span>
            </div>
            <ChevronDown
              size={15}
              style={{
                transform: isProjectDropdownOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                transition: 'transform 0.2s ease',
                color: 'var(--text-muted)'
              }}
            />
          </button>

          {isProjectDropdownOpen && (
            <div className="custom-dropdown-menu" style={{ width: '340px' }}>
              <div className="custom-dropdown-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>Switch Project</span>
                <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                  {projects.length > 0 ? `${projects.length} Project${projects.length > 1 ? 's' : ''} Configured` : 'No Projects'}
                </span>
              </div>

              <div style={{ maxHeight: '260px', overflowY: 'auto' }}>
                {projects.map((p) => {
                  const isSelected = p.id === activeProject.id;
                  return (
                    <div
                      key={p.id}
                      className={`custom-dropdown-item ${isSelected ? 'selected' : ''}`}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', padding: '0.65rem 0.85rem' }}
                      onClick={() => {
                        onSelectProject(p);
                        setIsProjectDropdownOpen(false);
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', flex: 1, minWidth: 0 }}>
                        <div style={{ width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          <Folder size={18} color={isSelected ? 'var(--accent-cyan)' : 'var(--text-muted)'} />
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.25, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                            <span style={{ fontWeight: 600, fontSize: '0.88rem', color: 'var(--text-bright)' }}>{p.name}</span>
                            {isSelected && <Check size={14} color="var(--accent-cyan)" />}
                          </div>
                          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                            {p.folderPath || `projects/${p.id}`}
                          </span>
                        </div>
                      </div>

                      {isSelected && (
                        <span className="badge badge-done" style={{ fontSize: '0.65rem' }}>
                          Current
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>

              <div style={{ padding: '0.65rem 0.75rem', borderTop: '1px solid var(--border-subtle)' }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ width: '100%', justifyContent: 'center', fontSize: '0.85rem' }}
                  onClick={() => {
                    setIsProjectDropdownOpen(false);
                    onNewProject();
                  }}
                >
                  <Plus size={15} />
                  <span>Create New Project...</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Custom AI Engine / Key Selector Dropdown */}
        <div ref={aiDropdownRef} style={{ position: 'relative' }}>
          <button
            className="ai-selector-custom"
            onClick={() => setIsAiDropdownOpen(!isAiDropdownOpen)}
            type="button"
            title={`Current AI Key: ${activeLabel}`}
          >
            {activeProviderMeta?.iconUrl ? (
              <img
                src={activeProviderMeta.iconUrl}
                alt={activeProviderMeta.shortName}
                style={{ width: 18, height: 18, objectFit: 'contain', display: 'inline-block' }}
              />
            ) : (
              <Brain size={18} color={activeUserKey ? 'var(--accent-cyan)' : 'var(--text-muted)'} />
            )}
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <span style={{ fontWeight: activeUserKey ? 600 : 500, color: activeUserKey ? 'var(--text-bright)' : 'var(--text-muted)' }}>
                {activeLabel}
              </span>
            </span>
            <ChevronDown
              size={15}
              style={{
                transform: isAiDropdownOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                transition: 'transform 0.2s ease',
                color: 'var(--text-muted)'
              }}
            />
          </button>

          {isAiDropdownOpen && (
            <div className="custom-dropdown-menu" style={{ width: '340px' }}>
              <div className="custom-dropdown-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>AI Keys</span>
                <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                  {userApiKeys.length > 0 ? `${userApiKeys.length} Key${userApiKeys.length > 1 ? 's' : ''} Configured` : 'No Keys Specified'}
                </span>
              </div>

              {/* If User Has Not Specified Any API Keys Yet */}
              {userApiKeys.length === 0 ? (
                <div style={{ padding: '1rem', textAlign: 'center' }}>
                  <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '0.5rem', color: 'var(--accent-amber)' }}>
                    <Key size={24} />
                  </div>
                  <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginBottom: '0.85rem', lineHeight: 1.4 }}>
                    You haven't added any API keys yet.
                  </p>
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ width: '100%', justifyContent: 'center', fontSize: '0.85rem' }}
                    onClick={() => {
                      setIsAiDropdownOpen(false);
                      onOpenAiScreen();
                    }}
                  >
                    <Plus size={15} />
                    <span>Add Key</span>
                  </button>
                </div>
              ) : (
                /* User Has Specified Keys */
                <div style={{ maxHeight: '260px', overflowY: 'auto' }}>
                  {userApiKeys.map((key) => {
                    const isSelected = key.id === activeKeyId;
                    const pMeta = SUPPORTED_AI_PROVIDERS.find((p) => p.id === key.provider);

                    return (
                      <div
                        key={key.id}
                        className={`custom-dropdown-item ${isSelected ? 'selected' : ''}`}
                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', padding: '0.65rem 0.85rem' }}
                        onClick={() => {
                          onSelectUserKey(key.id);
                          setIsAiDropdownOpen(false);
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', flex: 1, minWidth: 0 }}>
                          <div style={{ width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                            {pMeta?.iconUrl ? (
                              <img src={pMeta.iconUrl} alt={pMeta.shortName} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                            ) : (
                              <span style={{ fontSize: '1.15rem' }}>{pMeta?.icon || '🔑'}</span>
                            )}
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.25, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                              <span style={{ fontWeight: 600, fontSize: '0.88rem', color: 'var(--text-bright)' }}>{key.name}</span>
                              {isSelected && <Check size={14} color="var(--accent-cyan)" />}
                            </div>
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                              {pMeta?.shortName || key.provider} ({key.generalModel || key.model || pMeta?.defaultGeneralModel})
                            </span>
                          </div>
                        </div>

                        {isSelected && (
                          <span className="badge badge-done" style={{ fontSize: '0.65rem', padding: '0.1rem 0.35rem' }}>
                            Active
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Button at the Bottom of the AI selection dropdown to open AI Screen */}
              {userApiKeys.length > 0 && (
                <div style={{ padding: '0.65rem 0.75rem', borderTop: '1px solid var(--border-subtle)' }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ width: '100%', justifyContent: 'center', fontSize: '0.85rem' }}
                    onClick={() => {
                      setIsAiDropdownOpen(false);
                      onOpenAiScreen();
                    }}
                  >
                    <Settings size={15} />
                    <span>Manage AI Keys...</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Auto-save Status Indicator (Click to trigger manual save to disk) ── */}
        <button
          className={`autosave-status-btn status-${autosaveStatus}`}
          onClick={onSaveImmediately}
          type="button"
          title={`Autosave: ${isAutosaveEnabled ? `${autosaveDelaySec}s` : 'Off'} - save now`}
        >
          {autosaveStatus === 'saving' && <RotateCw size={16} className="spin-animate" color="var(--accent-cyan)" />}
          {autosaveStatus === 'pending' && <Clock size={16} color="var(--accent-amber)" />}
          {autosaveStatus === 'saved' && <CheckCheck size={16} color="var(--accent-emerald)" />}
          {autosaveStatus === 'error' && <AlertCircle size={16} color="#ef4444" />}
          {autosaveStatus === 'idle' && (
            <HardDrive size={16} color={isAutosaveEnabled ? 'var(--accent-cyan)' : 'var(--text-muted)'} />
          )}

          <span className="autosave-label">
            {autosaveStatus === 'saving' && 'Saving...'}
            {autosaveStatus === 'pending' && `Saving...`}
            {autosaveStatus === 'saved' && 'Saved'}
            {autosaveStatus === 'error' && 'Save Error'}
            {/* {autosaveStatus === 'idle' && (isAutosaveEnabled ? `Autosave: ${autosaveDelaySec}s` : 'Autosave: Off')} */}
          </span>
        </button>
      </div>

      {/* Right Header Actions */}
      <div className="header-actions">
        {/* Connected MCPs Trigger */}
        <button className="btn btn-secondary" onClick={onOpenMcpHub} title="Configure Connections (MCPs, Folders, Coding Agents)">
          <Unplug size={20} color="var(--accent-violet)" />
          {/* <span>Connections</span> */}
          <span className="badge badge-done" style={{ marginLeft: '-0.2rem', padding: '0.15rem 0.4rem' }}>
            {/* {connectedCount > 0 ? `${connectedCount} MCP` : 'MCP Hub'} */}
            {connectedCount > 0 ? 'Connections' : 'Add Connections'}
          </span>
        </button>

        {/* Download & Preview Markdown Files Button */}
        <button className="btn btn-secondary btn-icon-only" onClick={onOpenRawMarkdownModal} title="Preview and Download TODO.md & AGENT_CONTEXT.md">
          <Download size={16} color="var(--accent-cyan)" />
          {/* <span>Download</span> */}
        </button>

        {/* Settings Button (Gear Icon next to Download Button) */}
        <button className="btn btn-secondary btn-icon-only" onClick={onOpenSettingsModal} title="Workspace Settings (Auto-Save Delay & Disk Sync)">
          <Settings size={16} color="var(--accent-cyan)" />
          {/* <span>Settings</span> */}
        </button>
      </div>
    </header>
  );
};
