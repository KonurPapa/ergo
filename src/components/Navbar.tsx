import React, { useState, useRef, useEffect } from 'react';
import { type ProjectData, type MCPServer, type AIProviderConfig } from '../types';
import { Cpu, Download, Bot, ChevronDown, Check, Plus, Folder } from 'lucide-react';

interface NavbarProps {
  projects: ProjectData[];
  activeProject: ProjectData;
  onSelectProject: (proj: ProjectData) => void;
  onNewProject: () => void;
  mcpServers: MCPServer[];
  onOpenMcpHub: () => void;
  aiConfig: AIProviderConfig;
  onChangeAiConfig: (config: AIProviderConfig) => void;
  onOpenRawMarkdownModal: () => void;
}

const AI_OPTIONS = [
  { id: 'mock', name: 'Ergo AI Native Engine (Simulated)', icon: '⚡' },
  { id: 'anthropic', name: 'Anthropic Claude (3.7 Sonnet)', icon: '🧠' },
  { id: 'openai', name: 'OpenAI (GPT-4o)', icon: '🤖' },
  { id: 'gemini', name: 'Google Gemini (2.5 Flash)', icon: '✨' },
  { id: 'ollama', name: 'Ollama / Local LLM', icon: '💻' }
] as const;

export const Navbar: React.FC<NavbarProps> = ({
  projects,
  activeProject,
  onSelectProject,
  onNewProject,
  mcpServers,
  onOpenMcpHub,
  aiConfig,
  onChangeAiConfig,
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

  const selectedAiOption = AI_OPTIONS.find((o) => o.id === aiConfig.provider) || AI_OPTIONS[0];

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
          >
            <Folder size={16} color="var(--accent-cyan)" />
            <span style={{ fontWeight: 600 }}>{activeProject.name}</span>
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
            <div className="custom-dropdown-menu">
              <div className="custom-dropdown-header">Switch Workspace Project</div>
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
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <Folder size={14} color={isSelected ? 'var(--accent-cyan)' : 'var(--text-muted)'} />
                      <span>{p.name}</span>
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
                <span>Create New Project...</span>
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
          >
            <Bot size={16} color="var(--accent-cyan)" />
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <span>{selectedAiOption.icon}</span>
              <span>{selectedAiOption.name}</span>
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
            <div className="custom-dropdown-menu" style={{ width: '320px' }}>
              <div className="custom-dropdown-header">Select AI Intelligence Engine</div>
              {AI_OPTIONS.map((option) => {
                const isSelected = option.id === aiConfig.provider;
                return (
                  <div
                    key={option.id}
                    className={`custom-dropdown-item ${isSelected ? 'selected' : ''}`}
                    onClick={() => {
                      onChangeAiConfig({ ...aiConfig, provider: option.id as any });
                      setIsAiDropdownOpen(false);
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                      <span style={{ fontSize: '1.05rem' }}>{option.icon}</span>
                      <span>{option.name}</span>
                    </div>
                    {isSelected && <Check size={14} color="var(--accent-cyan)" />}
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
