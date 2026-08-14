import React, { useState, useRef, useEffect } from 'react';
import { type ProjectData, type MCPServer, type AIProviderConfig, type AIProviderId, type AICredentialsMap } from '../types';
import { SUPPORTED_AI_PROVIDERS } from '../lib/aiProviders';
import { Cpu, Download, Bot, ChevronDown, Check, Plus, Folder, Settings, Key } from 'lucide-react';

interface NavbarProps {
  projects: ProjectData[];
  activeProject: ProjectData;
  onSelectProject: (proj: ProjectData) => void;
  onNewProject: () => void;
  mcpServers: MCPServer[];
  onOpenMcpHub: () => void;
  aiConfig: AIProviderConfig;
  credentialsMap: AICredentialsMap;
  onSelectAiProvider: (providerId: AIProviderId) => void;
  onOpenCredentialsModal: (providerId: AIProviderId) => void;
  onOpenRawMarkdownModal: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  projects,
  activeProject,
  onSelectProject,
  onNewProject,
  mcpServers,
  onOpenMcpHub,
  aiConfig,
  credentialsMap,
  onSelectAiProvider,
  onOpenCredentialsModal,
  onOpenRawMarkdownModal
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

  const selectedAiProvider = SUPPORTED_AI_PROVIDERS.find((p) => p.id === aiConfig.provider) || SUPPORTED_AI_PROVIDERS[0];
  const activeCreds = credentialsMap[aiConfig.provider];
  const activeIsConnected = aiConfig.provider === 'mock' || !!activeCreds?.isConnected;

  const handleAiOptionClick = (providerId: AIProviderId) => {
    setIsAiDropdownOpen(false);
    const creds = credentialsMap[providerId];
    const isConnected = providerId === 'mock' || !!creds?.isConnected;

    if (!isConnected) {
      // Prompt user to sign in / configure credentials for this provider
      onOpenCredentialsModal(providerId);
    } else {
      // Switch active provider
      onSelectAiProvider(providerId);
    }
  };

  return (
    <header className="app-header">
      {/* Brand */}
      <div className="brand-logo">
        <div className="brand-badge">Ergo</div>
      </div>

      <div className="header-center">
        {/* Custom Project Selector Dropdown */}
        <div ref={projectDropdownRef} style={{ position: 'relative' }}>
          <button
            className="project-selector-custom"
            onClick={() => setIsProjectDropdownOpen(!isProjectDropdownOpen)}
            type="button"
            title={`Active Directory: ${activeProject?.folderPath || 'projects/default-workspace'}`}
          >
            <Folder size={16} color="var(--accent-cyan)" />
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
            <div className="custom-dropdown-menu" style={{ minWidth: '260px' }}>
              <div className="custom-dropdown-header">Switch Project Directory</div>
              {projects.map((p) => {
                const isSelected = p.id === activeProject.id;
                return (
                  <div
                    key={p.id}
                    className={`custom-dropdown-item ${isSelected ? 'selected' : ''}`}
                    onClick={() => {
                      onSelectProject(p);
                      setIsProjectDropdownOpen(false);
                    }}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.1rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <Folder size={14} color={isSelected ? 'var(--accent-cyan)' : 'var(--text-muted)'} />
                        <span style={{ fontWeight: 600 }}>{p.name}</span>
                      </div>
                      <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', paddingLeft: '1.4rem' }}>
                        {p.folderPath || `projects/${p.id}`}
                      </span>
                    </div>
                    {isSelected && <Check size={14} color="var(--accent-cyan)" />}
                  </div>
                );
              })}
              <div className="custom-dropdown-divider" />
              <div
                className="custom-dropdown-item create-action"
                onClick={() => {
                  onNewProject();
                  setIsProjectDropdownOpen(false);
                }}
              >
                <Plus size={14} color="var(--accent-emerald)" />
                <span>Create New Project Directory...</span>
              </div>
            </div>
          )}
        </div>

        {/* Custom AI Provider Selector Dropdown */}
        <div ref={aiDropdownRef} style={{ position: 'relative' }}>
          <button
            className="ai-selector-custom"
            onClick={() => setIsAiDropdownOpen(!isAiDropdownOpen)}
            type="button"
            title={`Active Engine: ${selectedAiProvider.name} (${aiConfig.model})`}
          >
            <Bot size={16} color={selectedAiProvider.badgeColor || 'var(--accent-cyan)'} />
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <span>{selectedAiProvider.icon}</span>
              <span style={{ fontWeight: 600 }}>{selectedAiProvider.name}</span>
            </span>
            {activeIsConnected ? (
              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--accent-emerald)', boxShadow: '0 0 8px var(--accent-emerald)' }} title="Connected" />
            ) : (
              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--accent-amber)' }} title="Sign in required" />
            )}
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
            <div className="custom-dropdown-menu" style={{ width: '360px' }}>
              <div className="custom-dropdown-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>Bring Your Own AI Engine</span>
                <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>Sign in to connect</span>
              </div>
              {SUPPORTED_AI_PROVIDERS.map((provider) => {
                const isSelected = provider.id === aiConfig.provider;
                const creds = credentialsMap[provider.id];
                const isConnected = provider.id === 'mock' || !!creds?.isConnected;

                return (
                  <div
                    key={provider.id}
                    className={`custom-dropdown-item ${isSelected ? 'selected' : ''}`}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', padding: '0.65rem 0.85rem' }}
                    onClick={() => handleAiOptionClick(provider.id)}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', flex: 1, minWidth: 0 }}>
                      <span style={{ fontSize: '1.15rem' }}>{provider.icon}</span>
                      <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.25, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                          <span style={{ fontWeight: 600, fontSize: '0.88rem', color: '#fff' }}>{provider.name}</span>
                          {isSelected && <Check size={14} color="var(--accent-cyan)" />}
                        </div>
                        <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {provider.id === 'mock'
                            ? 'Simulated Engine'
                            : isConnected
                            ? `Connected (${creds?.model || provider.defaultModel})`
                            : 'Sign in to connect'}
                        </span>
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }} onClick={(e) => e.stopPropagation()}>
                      {provider.id !== 'mock' && (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ padding: '0.2rem 0.45rem', fontSize: '0.72rem', borderRadius: '4px' }}
                          title={`Configure ${provider.name} credentials`}
                          onClick={() => {
                            setIsAiDropdownOpen(false);
                            onOpenCredentialsModal(provider.id);
                          }}
                        >
                          {isConnected ? <Settings size={12} color="var(--accent-cyan)" /> : <Key size={12} color="var(--accent-amber)" />}
                        </button>
                      )}
                      {isConnected ? (
                        <span className="badge badge-done" style={{ fontSize: '0.65rem', padding: '0.1rem 0.4rem' }}>
                          Ready
                        </span>
                      ) : (
                        <span className="badge badge-in_progress" style={{ fontSize: '0.65rem', padding: '0.1rem 0.4rem', color: 'var(--accent-amber)', borderColor: 'rgba(245, 158, 11, 0.3)' }}>
                          Sign In
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>


      {/* Right Header Actions */}
      <div className="header-actions">
        {/* Connected MCPs Trigger */}
        <button className="btn btn-secondary" onClick={onOpenMcpHub} title="Configure Connected MCP Servers">
          <Cpu size={16} color="var(--accent-violet)" />
          <span>Connections</span>
          <span className="badge badge-done" style={{ marginLeft: '0.2rem', padding: '0.15rem 0.4rem' }}>
            {connectedCount} Live
          </span>
        </button>

        {/* Download & Preview Markdown Files Button */}
        <button className="btn btn-secondary" onClick={onOpenRawMarkdownModal} title="Preview and Download TODO.md & AGENT_CONTEXT.md">
          <Download size={16} color="var(--accent-cyan)" />
          <span>Download</span>
        </button>
      </div>
    </header>
  );
};
