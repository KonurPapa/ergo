import React, { useState, useEffect } from 'react';
import {
  type MCPServer,
  type McpRootBoundary,
  type CliAgentConfig,
  type CliAgentPreset,
  type CliAgentSetup,
} from '../types';

import { getAllowedRoots, addAllowedRoot, removeAllowedRoot } from '../lib/mcpClient';
import {
  Unplug,
  Cpu,
  X,
  Shield,
  Plus,
  Code,
  Folder,
  FileText,
  MessageSquare,
  HardDrive,
  BarChart2,
  Database,
  Layers,
  Cloud,
  Calendar,
  Zap,
  BookOpen,
  FolderPlus,
  Trash2,
  Lock,
  Terminal,
  Check,
  CheckCircle2,
  ExternalLink,
  Edit3,
  Tag,
  AlertTriangle,
} from 'lucide-react';

interface McpHubModalProps {
  isOpen: boolean;
  onClose: () => void;
  mcpServers: MCPServer[];
  onToggleConnectServer: (serverId: string) => void;
  onToggleToolAutoApprove: (serverId: string, toolId: string) => void;
  onAddCustomServer: (newServer: MCPServer) => void;
  /** Persist CLI agent config when user clicks Save */
  cliAgentConfig: CliAgentConfig | null;
  onSaveCliAgent: (config: CliAgentConfig | null) => void;
  /** List of saved preconfigured CLI agent setups */
  cliAgents?: CliAgentSetup[];
  activeCliAgentId?: string | null;
  onSaveCliAgentSetup?: (setup: Omit<CliAgentSetup, 'id'> & { id?: string }) => void;
  onDeleteCliAgentSetup?: (id: string) => void;
  onSelectActiveCliAgent?: (id: string | null) => void;
}


// ─── Known CLI Coding Agent presets ─────────────────────────────────────────
const CLI_AGENT_PRESETS: CliAgentPreset[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    command: 'claude',
    defaultArgs: '',
    docsUrl: 'https://docs.anthropic.com/claude/docs/claude-code',
    description: "Anthropic's agentic coding assistant. Run `npm install -g @anthropic-ai/claude-code` to install.",
    badgeColor: '#d97706',
  },
  {
    id: 'antigravity',
    label: 'Antigravity (agy)',
    command: 'agy',
    defaultArgs: '',
    docsUrl: 'https://antigravity.dev',
    description: "Google Deepmind's Advanced Agentic Coding assistant. Install via the Antigravity IDE.",
    badgeColor: '#2563eb',
  },
  {
    id: 'aider',
    label: 'Aider',
    command: 'aider',
    defaultArgs: '--model gpt-4o',
    docsUrl: 'https://aider.chat',
    description: 'Open-source pair programming AI in the terminal. Install with `pip install aider-chat`.',
    badgeColor: '#059669',
  },
  {
    id: 'codex',
    label: 'OpenAI Codex CLI',
    command: 'codex',
    defaultArgs: '',
    docsUrl: 'https://github.com/openai/codex',
    description: "OpenAI's CLI coding agent. Install with `npm install -g @openai/codex`.",
    badgeColor: '#7c3aed',
  },
];

function renderServerIcon(server: MCPServer, isConnected: boolean) {
  if (server.iconUrl) {
    return (
      <div
        style={{
          width: 22,
          height: 22,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0
        }}
      >
        <img
          src={server.iconUrl}
          alt={server.name}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            opacity: isConnected ? 1 : 0.45,
            filter: isConnected ? 'none' : 'grayscale(100%)',
            transition: 'opacity 0.2s ease, filter 0.2s ease'
          }}
        />
      </div>
    );
  }
  const color = isConnected ? 'var(--accent-emerald)' : 'var(--text-dim)';
  const size = 18;
  switch (server.iconName) {
    case 'Cloud': return <Cloud size={size} color={color} />;
    case 'Calendar': return <Calendar size={size} color={color} />;
    case 'Zap': return <Zap size={size} color={color} />;
    case 'BookOpen': return <BookOpen size={size} color={color} />;
    case 'MessageSquare': return <MessageSquare size={size} color={color} />;
    case 'Github': return <Code size={size} color={color} />;
    case 'Code': return <Code size={size} color={color} />;
    case 'Folder': return <Folder size={size} color={color} />;
    case 'FileText': return <FileText size={size} color={color} />;
    case 'HardDrive': return <HardDrive size={size} color={color} />;
    case 'Figma': return <Layers size={size} color={color} />;
    case 'BarChart2': return <BarChart2 size={size} color={color} />;
    case 'Database': return <Database size={size} color={color} />;
    default: return <Cpu size={size} color={color} />;
  }
}

export const McpHubModal: React.FC<McpHubModalProps> = ({
  isOpen,
  onClose,
  mcpServers,
  onToggleConnectServer,
  onToggleToolAutoApprove,
  onAddCustomServer,
  cliAgentConfig,
  onSaveCliAgent,
  cliAgents = [],
  activeCliAgentId = null,
  onSaveCliAgentSetup,
  onDeleteCliAgentSetup,
  onSelectActiveCliAgent,
}) => {
  const [activeTab, setActiveTab] = useState<'harnesses' | 'roots' | 'external' | 'cli'>('harnesses');

  const [showAddForm, setShowAddForm] = useState(false);
  const [newServerName, setNewServerName] = useState('');
  const [newServerEndpoint, setNewServerEndpoint] = useState('');
  const [roots, setRoots] = useState<McpRootBoundary[]>([]);
  const [newRootPath, setNewRootPath] = useState('');
  const [newRootName, setNewRootName] = useState('');

  // CLI agent local state
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [cliAgentName, setCliAgentName] = useState('');
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(cliAgentConfig?.presetId ?? null);
  const [cliCommand, setCliCommand] = useState(cliAgentConfig?.command ?? '');
  const [cliExtraArgs, setCliExtraArgs] = useState(cliAgentConfig?.extraArgs ?? '');
  const [cliSaved, setCliSaved] = useState(false);
  const [agentPendingDelete, setAgentPendingDelete] = useState<CliAgentSetup | null>(null);

  const resetCliForm = () => {
    setEditingAgentId(null);
    setCliAgentName('');
    setSelectedPresetId('claude-code');
    setCliCommand('claude');
    setCliExtraArgs('');
    setCliSaved(false);
  };

  const loadAgentForEditing = (agent: CliAgentSetup) => {
    setEditingAgentId(agent.id);
    setCliAgentName(agent.name);
    setSelectedPresetId(agent.presetId ?? (CLI_AGENT_PRESETS.some((p) => p.command === agent.command) ? CLI_AGENT_PRESETS.find((p) => p.command === agent.command)!.id : 'custom'));
    setCliCommand(agent.command);
    setCliExtraArgs(agent.extraArgs || '');
    setCliSaved(false);
  };

  useEffect(() => {
    if (isOpen) {
      getAllowedRoots().then(setRoots);
      if (!editingAgentId) {
        setSelectedPresetId(cliAgentConfig?.presetId ?? (cliAgentConfig?.command ? (CLI_AGENT_PRESETS.find((p) => p.command === cliAgentConfig.command)?.id || 'custom') : null));
        setCliAgentName(cliAgentConfig?.name ?? '');
        setCliCommand(cliAgentConfig?.command ?? '');
        setCliExtraArgs(cliAgentConfig?.extraArgs ?? '');
        setCliSaved(false);
      }
    }
  }, [isOpen, cliAgentConfig]);

  if (!isOpen) return null;

  const handleAddRootSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRootPath.trim()) return;
    const updated = await addAllowedRoot(newRootPath.trim(), newRootName.trim() || undefined);
    setRoots(updated);
    setNewRootPath('');
    setNewRootName('');
  };

  const handleRemoveRoot = async (id: string) => {
    const updated = await removeAllowedRoot(id);
    setRoots(updated);
  };

  const handleAddSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newServerName || !newServerEndpoint) return;

    const created: MCPServer = {
      id: `custom-${Date.now()}`,
      name: newServerName,
      description: 'Custom MCP connection.',
      iconName: 'Cpu',
      category: 'developer',
      status: 'connected',
      transport: 'OAuth 2.1',
      endpoint: newServerEndpoint,
      serverType: 'external_oauth',
      tools: [
        { id: `tool-1-${Date.now()}`, name: 'execute_remote_tool', description: 'Execute remote action on custom server', autoApprove: false }
      ]
    };

    onAddCustomServer(created);
    setNewServerName('');
    setNewServerEndpoint('');
    setShowAddForm(false);
  };

  const bundledHarnesses = mcpServers.filter((s) => s.serverType === 'bundled_harness' || s.transport === 'Local Stdio');
  const externalServers = mcpServers.filter((s) => s.serverType !== 'bundled_harness' && s.transport !== 'Local Stdio');

  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-content" style={{ maxWidth: '920px', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
        {/* Modal Header */}
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div
              style={{
                width: '38px',
                height: '38px',
                borderRadius: '10px',
                background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-cyan))',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                boxShadow: '0 2px 8px rgba(99, 102, 241, 0.3)',
                flexShrink: 0
              }}
            >
              <Unplug size={20} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <h3 style={{ fontSize: '1.15rem', fontWeight: 700, color: '#fff', margin: 0 }}>Connections</h3>
              </div>
              <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '0.15rem 0 0 0' }}>
                Manage local connections & folders, external MCPs, and cloud coding tools
              </p>
            </div>
          </div>
          <button className="btn btn-secondary" style={{ padding: '0.35rem 0.6rem' }} onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {/* Tab Navigation */}
        <div style={{ display: 'flex', gap: '0.25rem', borderBottom: '1px solid var(--border-subtle)', padding: '0 1.5rem', background: 'var(--bg-darkest)' }}>
          <button
            className={`tab-btn ${activeTab === 'harnesses' ? 'active' : ''}`}
            onClick={() => setActiveTab('harnesses')}
            style={{
              padding: '0.75rem 1rem',
              border: 'none',
              borderBottom: activeTab === 'harnesses' ? '2px solid var(--accent-cyan)' : '2px solid transparent',
              color: activeTab === 'harnesses' ? '#fff' : 'var(--text-muted)',
              fontWeight: 600,
              fontSize: '0.84rem',
              background: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '0.45rem',
              transition: 'all 0.15s ease'
            }}
          >
            <span>Default Connections</span>
            <span style={{ fontSize: '0.68rem', padding: '0.1rem 0.45rem', borderRadius: '10px', background: activeTab === 'harnesses' ? 'rgba(6, 182, 212, 0.18)' : 'rgba(255, 255, 255, 0.05)', color: activeTab === 'harnesses' ? 'var(--accent-cyan)' : 'var(--text-dim)', fontWeight: 700 }}>
              {bundledHarnesses.length}
            </span>
          </button>

          <button
            className={`tab-btn ${activeTab === 'roots' ? 'active' : ''}`}
            onClick={() => setActiveTab('roots')}
            style={{
              padding: '0.75rem 1rem',
              border: 'none',
              borderBottom: activeTab === 'roots' ? '2px solid var(--accent-cyan)' : '2px solid transparent',
              color: activeTab === 'roots' ? '#fff' : 'var(--text-muted)',
              fontWeight: 600,
              fontSize: '0.84rem',
              background: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '0.45rem',
              transition: 'all 0.15s ease'
            }}
          >
            <span>Allowed Folders</span>
            <span style={{ fontSize: '0.68rem', padding: '0.1rem 0.45rem', borderRadius: '10px', background: activeTab === 'roots' ? 'rgba(6, 182, 212, 0.18)' : 'rgba(255, 255, 255, 0.05)', color: activeTab === 'roots' ? 'var(--accent-cyan)' : 'var(--text-dim)', fontWeight: 700 }}>
              {roots.length}
            </span>
          </button>

          <button
            className={`tab-btn ${activeTab === 'external' ? 'active' : ''}`}
            onClick={() => setActiveTab('external')}
            style={{
              padding: '0.75rem 1rem',
              border: 'none',
              borderBottom: activeTab === 'external' ? '2px solid var(--accent-cyan)' : '2px solid transparent',
              color: activeTab === 'external' ? '#fff' : 'var(--text-muted)',
              fontWeight: 600,
              fontSize: '0.84rem',
              background: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '0.45rem',
              transition: 'all 0.15s ease'
            }}
          >
            <span>External Apps</span>
            <span style={{ fontSize: '0.68rem', padding: '0.1rem 0.45rem', borderRadius: '10px', background: activeTab === 'external' ? 'rgba(6, 182, 212, 0.18)' : 'rgba(255, 255, 255, 0.05)', color: activeTab === 'external' ? 'var(--accent-cyan)' : 'var(--text-dim)', fontWeight: 700 }}>
              {externalServers.length}
            </span>
          </button>

          <button
            className={`tab-btn ${activeTab === 'cli' ? 'active' : ''}`}
            onClick={() => setActiveTab('cli')}
            style={{
              padding: '0.75rem 1rem',
              border: 'none',
              borderBottom: activeTab === 'cli' ? '2px solid var(--accent-emerald)' : '2px solid transparent',
              color: activeTab === 'cli' ? 'var(--accent-emerald)' : 'var(--text-muted)',
              fontWeight: 600,
              fontSize: '0.84rem',
              background: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '0.45rem',
              transition: 'all 0.15s ease'
            }}
          >
            <Terminal size={14} />
            <span>Coding Agents</span>
            {cliAgentConfig && <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent-emerald)', display: 'inline-block' }} />}
          </button>
        </div>

        <div className="modal-body" style={{ overflowY: 'auto', flex: 1, padding: '1.25rem 1.5rem' }}>
          {/* Header Action Bar */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
            {/* <h4
              style={{
                fontSize: '0.85rem',
                fontWeight: 700,
                color: 'var(--text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                margin: 0,
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem'
              }}
            >
              <span>MCP Server Connections</span>
              <span className="badge badge-done" style={{ fontSize: '0.68rem', textTransform: 'none', letterSpacing: 'normal' }}>
                {mcpServers.filter((s) => s.status === 'connected').length} / {mcpServers.length} Active
              </span>
            </h4> */}
            <span></span>

            <div style={{ display: 'flex', gap: '0.5rem' }}>
              {/* <button
                className="btn btn-secondary"
                style={{ fontSize: '0.8rem', padding: '0.35rem 0.75rem', gap: '0.4rem' }}
                onClick={handleSyncAllTools}
                title="Call tools/list across all servers to discover latest tools and update signatures"
              >
                <RefreshCw size={13} className={isSyncing ? 'animate-spin' : ''} />
                <span>{isSyncing ? 'Syncing tools/list...' : 'Sync tools/list'}</span>
              </button> */}

              {activeTab === 'external' && (
                <button className="btn btn-primary" style={{ fontSize: '0.8rem', padding: '0.35rem 0.75rem' }} onClick={() => setShowAddForm(!showAddForm)}>
                  <Plus size={14} />
                  <span>Connect Other</span>
                </button>
              )}
            </div>
          </div>

          {/* TAB 1: BUNDLED AGENT HARNESSES */}
          {activeTab === 'harnesses' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              <div style={{ background: 'rgba(255, 255, 255, 0.02)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', padding: '0.85rem 1rem', fontSize: '0.82rem', color: 'var(--text-muted)', lineHeight: '1.5' }}>
                <strong style={{ color: '#fff' }}>Open-Source Agent Harnesses:</strong> Ergo bundles standard Node.js MCP servers (<span style={{ color: 'var(--accent-cyan)', fontFamily: 'var(--font-mono)' }}>server-filesystem</span>, <span style={{ color: 'var(--accent-cyan)', fontFamily: 'var(--font-mono)' }}>server-fetch</span>, and <span style={{ color: 'var(--accent-cyan)', fontFamily: 'var(--font-mono)' }}>mcp-server-git</span>) communicating via synchronous Local Stdio IPC. These operate browser-agnostically with zero database required.
              </div>

              <div className="mcp-grid">
                {bundledHarnesses.map((server) => {
                  const isConnected = server.status === 'connected';
                  return (
                    <div key={server.id} className={`mcp-card ${isConnected ? 'connected' : ''}`}>
                      <div className="mcp-header">
                        <div className="mcp-title">
                          {renderServerIcon(server, isConnected)}
                          <span>{server.name}</span>
                        </div>

                        <span className="badge badge-done" style={{ fontSize: '0.7rem' }}>
                          Default Connection
                        </span>
                      </div>

                      <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', margin: 0, lineHeight: 1.45 }}>{server.description}</p>

                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-dim)', paddingTop: '0.4rem', borderTop: '1px solid var(--border-subtle)' }}>
                        <span>Transport: <strong style={{ color: 'var(--accent-emerald)' }}>{server.transport}</strong></span>
                        <span style={{ fontFamily: 'var(--font-mono)' }}>{server.tools.length} tools registered</span>
                      </div>

                      {/* Discovered Tools List */}
                      {isConnected && server.tools.length > 0 && (
                        <div style={{ background: 'rgba(0, 0, 0, 0.25)', border: '1px solid var(--border-subtle)', padding: '0.65rem 0.75rem', borderRadius: 'var(--radius-sm)', marginTop: '0.2rem' }}>
                          <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--accent-cyan)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.4rem', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                            <Shield size={12} />
                            <span>Tools & Security Auto-Approval Policies</span>
                          </div>

                          {server.tools.map((tool) => (
                            <div key={tool.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.78rem', padding: '0.3rem 0', borderTop: '1px solid rgba(255, 255, 255, 0.04)' }}>
                              <span style={{ fontFamily: 'var(--font-mono)', color: '#fff', fontSize: '0.76rem' }}>{tool.name}</span>
                              <button
                                style={{
                                  background: tool.autoApprove ? 'rgba(16, 185, 129, 0.15)' : 'rgba(245, 158, 11, 0.15)',
                                  color: tool.autoApprove ? 'var(--accent-emerald)' : 'var(--accent-amber)',
                                  border: '1px solid ' + (tool.autoApprove ? 'rgba(16, 185, 129, 0.3)' : 'rgba(245, 158, 11, 0.3)'),
                                  padding: '0.15rem 0.5rem',
                                  borderRadius: '4px',
                                  fontSize: '0.7rem',
                                  cursor: 'pointer',
                                  fontWeight: 600,
                                  transition: 'all 0.15s ease'
                                }}
                                onClick={() => onToggleToolAutoApprove(server.id, tool.id)}
                              >
                                {tool.autoApprove ? 'Auto-Approve' : 'Ask Permission'}
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* TAB 2: SAFE DIRECTORY ROOTS */}
          {activeTab === 'roots' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              <div style={{ background: 'rgba(255, 255, 255, 0.02)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', padding: '0.85rem 1rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.35rem' }}>
                  <Lock size={15} color="var(--accent-cyan)" />
                  <span style={{ fontWeight: 700, fontSize: '0.88rem', color: '#fff' }}>Filesystem MCP Boundary Sandboxing (Roots)</span>
                </div>
                <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', margin: 0, lineHeight: 1.5 }}>
                  To protect your hard drive, the Filesystem MCP server (<span style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent-cyan)' }}>server-filesystem</span>) is strictly constrained to the directory paths configured below. AI agents cannot read or write outside these approved boundaries.
                </p>
              </div>

              {/* Add Root Form */}
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
                  <h4
                    style={{
                      fontSize: '0.85rem',
                      fontWeight: 700,
                      color: 'var(--text-muted)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      margin: 0
                    }}
                  >
                    Add Allowed Directory Root
                  </h4>
                </div>
                <form onSubmit={handleAddRootSubmit} style={{ display: 'flex', gap: '0.75rem' }}>
                  <input
                    type="text"
                    className="input-text"
                    placeholder="Folder Path (e.g. /home/user/my-project or ../other-repo)"
                    value={newRootPath}
                    onChange={(e) => setNewRootPath(e.target.value)}
                    style={{ flex: 2 }}
                  />
                  <input
                    type="text"
                    className="input-text"
                    placeholder="Label / Nickname (optional)"
                    value={newRootName}
                    onChange={(e) => setNewRootName(e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <button type="submit" className="btn btn-primary" disabled={!newRootPath.trim()} style={{ whiteSpace: 'nowrap' }}>
                    <FolderPlus size={14} />
                    <span>Add Allowed Root</span>
                  </button>
                </form>
              </div>

              {/* Roots List */}
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
                  <h4
                    style={{
                      fontSize: '0.85rem',
                      fontWeight: 700,
                      color: 'var(--text-muted)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      margin: 0
                    }}
                  >
                    Configured Directory Roots ({roots.length})
                  </h4>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                  {roots.map((root) => (
                    <div
                      key={root.id}
                      style={{
                        background: 'var(--bg-card)',
                        border: '1px solid var(--border-subtle)',
                        borderRadius: 'var(--radius-sm)',
                        padding: '0.75rem 1rem',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between'
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        <Folder size={18} color="var(--accent-cyan)" />
                        <div>
                          <div style={{ fontWeight: 600, fontSize: '0.88rem', color: '#fff', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                            <span>{root.name}</span>
                            {root.isDefault && (
                              <span className="badge badge-done" style={{ fontSize: '0.65rem' }}>
                                Default Storage
                              </span>
                            )}
                          </div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', marginTop: '0.1rem' }}>
                            {root.path}
                          </div>
                        </div>
                      </div>

                      {!root.isDefault && (
                        <button
                          className="btn btn-secondary"
                          style={{ padding: '0.3rem 0.5rem', color: 'var(--accent-rose)' }}
                          onClick={() => handleRemoveRoot(root.id)}
                          title="Remove allowed root"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: EXTERNAL SAAS MCPS */}
          {activeTab === 'external' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              {showAddForm && (
                <form onSubmit={handleAddSubmit} style={{ background: 'var(--bg-card)', border: '1px solid var(--border-glow)', borderRadius: 'var(--radius-md)', padding: '1.25rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
                    <h4 style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: 0 }}>
                      Add Remote MCP Endpoint (OAuth 2.1 PKCE)
                    </h4>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.85rem' }}>
                    <div>
                      <label className="input-label">Server Name</label>
                      <input type="text" className="input-text" placeholder="e.g. Asana MCP" value={newServerName} onChange={(e) => setNewServerName(e.target.value)} />
                    </div>
                    <div>
                      <label className="input-label">MCP SSE Endpoint URL</label>
                      <input type="text" className="input-text" placeholder="https://mcp.asana.com/sse" value={newServerEndpoint} onChange={(e) => setNewServerEndpoint(e.target.value)} />
                    </div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
                    <button type="button" className="btn btn-secondary" style={{ fontSize: '0.8rem' }} onClick={() => setShowAddForm(false)}>Cancel</button>
                    <button type="submit" className="btn btn-primary" style={{ fontSize: '0.8rem' }}>Authorize & Connect</button>
                  </div>
                </form>
              )}

              <div className="mcp-grid">
                {externalServers.map((server) => {
                  const isConnected = server.status === 'connected';
                  return (
                    <div key={server.id} className={`mcp-card ${isConnected ? 'connected' : ''}`}>
                      <div className="mcp-header">
                        <div className="mcp-title">
                          {renderServerIcon(server, isConnected)}
                          <span>{server.name}</span>
                        </div>

                        <button
                          className={isConnected ? 'btn btn-secondary' : 'btn btn-primary'}
                          style={{ padding: '0.25rem 0.6rem', fontSize: '0.75rem' }}
                          onClick={() => onToggleConnectServer(server.id)}
                        >
                          {isConnected ? 'Disconnect' : 'Connect'}
                        </button>
                      </div>

                      <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', margin: 0, lineHeight: 1.45 }}>{server.description}</p>

                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-dim)', paddingTop: '0.4rem', borderTop: '1px solid var(--border-subtle)' }}>
                        <span>Transport: {server.transport}</span>
                        <span style={{ fontFamily: 'var(--font-mono)' }}>{server.endpoint.replace('https://', '')}</span>
                      </div>

                      {/* Discovered Tools List */}
                      {isConnected && server.tools.length > 0 && (
                        <div style={{ background: 'rgba(0, 0, 0, 0.25)', border: '1px solid var(--border-subtle)', padding: '0.65rem 0.75rem', borderRadius: 'var(--radius-sm)', marginTop: '0.2rem' }}>
                          <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--accent-cyan)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.4rem', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                            <Shield size={12} />
                            <span>Available MCP Tools & Security Policies</span>
                          </div>

                          {server.tools.map((tool) => (
                            <div key={tool.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.78rem', padding: '0.3rem 0', borderTop: '1px solid rgba(255, 255, 255, 0.04)' }}>
                              <span style={{ fontFamily: 'var(--font-mono)', color: '#fff', fontSize: '0.76rem' }}>{tool.name}</span>
                              <button
                                style={{
                                  background: tool.autoApprove ? 'rgba(16, 185, 129, 0.15)' : 'rgba(245, 158, 11, 0.15)',
                                  color: tool.autoApprove ? 'var(--accent-emerald)' : 'var(--accent-amber)',
                                  border: '1px solid ' + (tool.autoApprove ? 'rgba(16, 185, 129, 0.3)' : 'rgba(245, 158, 11, 0.3)'),
                                  padding: '0.15rem 0.5rem',
                                  borderRadius: '4px',
                                  fontSize: '0.7rem',
                                  cursor: 'pointer',
                                  fontWeight: 600,
                                  transition: 'all 0.15s ease'
                                }}
                                onClick={() => onToggleToolAutoApprove(server.id, tool.id)}
                              >
                                {tool.autoApprove ? 'Auto-Approve' : 'Ask Permission'}
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* TAB 4: CLI CODING AGENTS */}
          {activeTab === 'cli' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              {/* Explainer */}
              <div style={{ background: 'rgba(255, 255, 255, 0.02)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', padding: '0.85rem 1rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.35rem' }}>
                  <Terminal size={15} color="var(--accent-emerald)" />
                  <span style={{ fontWeight: 700, fontSize: '0.88rem', color: '#fff' }}>Native Agent Execution</span>
                </div>
                <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', margin: 0, lineHeight: '1.5' }}>
                  When you click <strong style={{ color: '#fff' }}>Execute Task</strong>, Ergo spawns your active coding agent in a real PTY terminal inside the AI Workspace — identical to running it in your IDE's integrated terminal. You can save multiple agent presets and switch between them anytime.
                </p>
              </div>

              {/* Form Card: Add / Edit CLI Agent Setup */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '-0.5rem' }}>
                <h4
                  style={{
                    fontSize: '0.85rem',
                    fontWeight: 700,
                    color: 'var(--text-muted)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    margin: 0
                  }}
                >
                  {editingAgentId ? 'Edit Coding Agent Setup' : 'Configure & Save Coding Agent'}
                </h4>
                {editingAgentId && (
                  <button
                    type="button"
                    onClick={() => resetCliForm()}
                    style={{
                      background: 'rgba(244, 63, 94, 0.1)',
                      border: '1px solid rgba(244, 63, 94, 0.3)',
                      color: 'var(--accent-rose)',
                      borderRadius: 'var(--radius-sm)',
                      padding: '0.2rem 0.6rem',
                      fontSize: '0.75rem',
                      cursor: 'pointer',
                      fontWeight: 600
                    }}
                  >
                    Cancel Edit
                  </button>
                )}
              </div>

              <div
                style={{
                  background: 'var(--bg-dark)',
                  border: editingAgentId ? '1px solid var(--accent-cyan)' : '1px solid var(--border-glow)',
                  borderRadius: 'var(--radius-md)',
                  padding: '1.25rem',
                  boxShadow: editingAgentId ? '0 0 16px rgba(6, 182, 212, 0.15)' : 'none',
                  transition: 'all 0.2s ease',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '1rem'
                }}
              >
                {/* Preset cards selection */}
                <div>
                  <label className="input-label" style={{ marginBottom: '0.5rem' }}>
                    Choose a Preset or Custom
                  </label>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: '0.75rem' }}>
                    {CLI_AGENT_PRESETS.map((preset) => {
                      const isSelected = selectedPresetId === preset.id;
                      return (
                        <button
                          key={preset.id}
                          type="button"
                          onClick={() => {
                            setSelectedPresetId(preset.id);
                            setCliCommand(preset.command);
                            setCliExtraArgs(preset.defaultArgs);
                            if (!cliAgentName || CLI_AGENT_PRESETS.some((p) => p.label === cliAgentName) || cliAgentName === 'Custom Agent') {
                              setCliAgentName(preset.label);
                            }
                            setCliSaved(false);
                          }}
                          style={{
                            textAlign: 'left',
                            background: isSelected ? 'rgba(6, 182, 212, 0.08)' : 'var(--bg-card)',
                            border: `1px solid ${isSelected ? 'var(--accent-cyan)' : 'var(--border-subtle)'}`,
                            borderRadius: 'var(--radius-md)',
                            padding: '0.85rem 1rem',
                            cursor: 'pointer',
                            transition: 'all 0.15s ease',
                            position: 'relative',
                          }}
                        >
                          {isSelected && (
                            <span style={{ position: 'absolute', top: '0.65rem', right: '0.65rem' }}>
                              <Check size={14} color="var(--accent-cyan)" />
                            </span>
                          )}
                          <div style={{ fontWeight: 700, fontSize: '0.88rem', color: '#fff', marginBottom: '0.25rem' }}>{preset.label}</div>
                          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--accent-cyan)', marginBottom: '0.4rem' }}>{preset.command}{preset.defaultArgs ? ' ' + preset.defaultArgs : ''}</div>
                          <p style={{ fontSize: '0.77rem', color: 'var(--text-muted)', lineHeight: '1.4', margin: 0 }}>{preset.description}</p>
                          <a
                            href={preset.docsUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', marginTop: '0.6rem', fontSize: '0.72rem', color: 'var(--accent-primary)', textDecoration: 'none' }}
                          >
                            <ExternalLink size={10} /> Docs
                          </a>
                        </button>
                      );
                    })}

                    {/* Custom Command Card */}
                    {(() => {
                      const isCustomSelected = selectedPresetId === 'custom' || (!selectedPresetId && !!cliCommand.trim());
                      return (
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedPresetId('custom');
                            if (selectedPresetId && selectedPresetId !== 'custom') {
                              setCliCommand('');
                              setCliExtraArgs('');
                            }
                            if (!cliAgentName || CLI_AGENT_PRESETS.some((p) => p.label === cliAgentName)) {
                              setCliAgentName('Custom Agent');
                            }
                            setCliSaved(false);
                          }}
                          style={{
                            textAlign: 'left',
                            background: isCustomSelected ? 'rgba(16, 185, 129, 0.08)' : 'var(--bg-card)',
                            border: `1px dashed ${isCustomSelected ? 'var(--accent-emerald)' : 'var(--border-subtle)'}`,
                            borderRadius: 'var(--radius-md)',
                            padding: '0.85rem 1rem',
                            cursor: 'pointer',
                            transition: 'all 0.15s ease',
                            position: 'relative',
                            display: 'flex',
                            flexDirection: 'column',
                            justifyContent: 'space-between'
                          }}
                        >
                          {isCustomSelected && (
                            <span style={{ position: 'absolute', top: '0.65rem', right: '0.65rem' }}>
                              <Check size={14} color="var(--accent-emerald)" />
                            </span>
                          )}
                          <div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.25rem' }}>
                              <Code size={14} color={isCustomSelected ? "var(--accent-emerald)" : "var(--text-muted)"} />
                              <span style={{ fontWeight: 700, fontSize: '0.88rem', color: '#fff' }}>Custom Command</span>
                            </div>
                            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--accent-emerald)', marginBottom: '0.4rem' }}>
                              {cliCommand.trim() ? `${cliCommand}${cliExtraArgs.trim() ? ' ' + cliExtraArgs.trim() : ''}` : 'your-own-agent'}
                            </div>
                            <p style={{ fontSize: '0.77rem', color: 'var(--text-muted)', lineHeight: '1.4', margin: 0 }}>
                              Run any custom terminal command, CLI agent (e.g. goose, cline, cursor-agent), or custom shell script.
                            </p>
                          </div>
                          <div style={{ marginTop: '0.6rem', fontSize: '0.72rem', color: isCustomSelected ? 'var(--accent-emerald)' : 'var(--text-dim)', fontWeight: 600 }}>
                            {isCustomSelected ? 'Custom active' : 'Click to configure'}
                          </div>
                        </button>
                      );
                    })()}
                  </div>
                </div>

                {/* Setup Name / Label */}
                <div className="input-group" style={{ margin: 0 }}>
                  <label className="input-label" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.3rem' }}>
                    <Tag size={13} color="var(--accent-cyan)" />
                    <span style={{ fontWeight: 600, color: '#e2e8f0' }}>Configuration Label</span>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>(Name to identify this agent setup)</span>
                  </label>
                  <input
                    type="text"
                    className="input-text"
                    placeholder="e.g. Claude Code (Production), Aider Local, Custom Goose Agent..."
                    value={cliAgentName}
                    onChange={(e) => { setCliAgentName(e.target.value); setCliSaved(false); }}
                  />
                </div>

                {/* Command & Flags Inputs */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.85rem' }}>
                  <div>
                    <label className="input-label">
                      Shell Command <span style={{ color: 'var(--accent-rose)' }}>*</span>
                    </label>
                    <input
                      type="text"
                      className="input-text"
                      placeholder="e.g. claude, agy, aider, goose, ./run-agent.sh"
                      value={cliCommand}
                      onChange={(e) => {
                        setCliCommand(e.target.value);
                        if (selectedPresetId && selectedPresetId !== 'custom') {
                          const matching = CLI_AGENT_PRESETS.find((p) => p.command === e.target.value.trim());
                          if (!matching) {
                            setSelectedPresetId(null);
                          }
                        }
                        setCliSaved(false);
                      }}
                    />
                  </div>
                  <div>
                    <label className="input-label">Extra Flags / Arguments (optional)</label>
                    <input
                      type="text"
                      className="input-text"
                      placeholder="e.g. --model gpt-4o --verbose"
                      value={cliExtraArgs}
                      onChange={(e) => { setCliExtraArgs(e.target.value); setCliSaved(false); }}
                    />
                  </div>
                </div>

                {/* Actions */}
                <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginTop: '0.25rem' }}>
                  <button
                    className="btn btn-primary"
                    disabled={!cliCommand.trim()}
                    onClick={() => {
                      const finalName = cliAgentName.trim() || (selectedPresetId ? (CLI_AGENT_PRESETS.find((p) => p.id === selectedPresetId)?.label || 'Custom Agent') : 'Custom Agent');
                      const resolvedPresetId = selectedPresetId ? (selectedPresetId === 'custom' ? undefined : selectedPresetId) : undefined;
                      
                      // Save to saved list if onSaveCliAgentSetup is provided
                      if (onSaveCliAgentSetup) {
                        onSaveCliAgentSetup({
                          id: editingAgentId || undefined,
                          name: finalName,
                          presetId: resolvedPresetId,
                          command: cliCommand.trim(),
                          extraArgs: cliExtraArgs.trim(),
                        });
                      }

                      // Also set as active config
                      const config: CliAgentConfig = {
                        id: editingAgentId || undefined,
                        name: finalName,
                        presetId: resolvedPresetId,
                        command: cliCommand.trim(),
                        extraArgs: cliExtraArgs.trim(),
                      };
                      onSaveCliAgent(config);
                      setCliSaved(true);
                      setEditingAgentId(null);
                    }}
                  >
                    <Check size={14} />
                    <span>{editingAgentId ? 'Update Agent Setup' : 'Save Agent Setup'}</span>
                  </button>
                  {editingAgentId ? (
                    <button
                      className="btn btn-secondary"
                      onClick={() => resetCliForm()}
                    >
                      Cancel
                    </button>
                  ) : (
                    cliAgentConfig && (
                      <button
                        className="btn btn-secondary"
                        style={{ color: 'var(--accent-rose)', fontSize: '0.8rem' }}
                        onClick={() => {
                          onSaveCliAgent(null);
                          if (onSelectActiveCliAgent) onSelectActiveCliAgent(null);
                          setCliCommand('');
                          setCliExtraArgs('');
                          setCliAgentName('');
                          setSelectedPresetId(null);
                          setCliSaved(false);
                        }}
                      >
                        Deactivate Agent
                      </button>
                    )
                  )}
                  {cliSaved && (
                    <span style={{ fontSize: '0.82rem', color: 'var(--accent-emerald)', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                      <CheckCircle2 size={14} /> Saved & Activated
                    </span>
                  )}
                </div>
              </div>

              {/* Card 2: Saved Configured Coding Agents List */}
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
                  <h4
                    style={{
                      fontSize: '0.85rem',
                      fontWeight: 700,
                      color: 'var(--text-muted)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      margin: 0
                    }}
                  >
                    Configured Coding Agents ({cliAgents.length})
                  </h4>
                  {cliAgents.length > 0 && (
                    <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                      Click 'Set Active' to choose which agent runs on task execution
                    </span>
                  )}
                </div>

                {cliAgents.length === 0 ? (
                  <div
                    style={{
                      padding: '1.5rem',
                      textAlign: 'center',
                      background: 'var(--bg-dark)',
                      border: '1px dashed var(--border-subtle)',
                      borderRadius: 'var(--radius-md)'
                    }}
                  >
                    <Terminal size={28} color="var(--text-muted)" style={{ margin: '0 auto 0.5rem auto', opacity: 0.6 }} />
                    <p style={{ fontSize: '0.84rem', color: '#fff', fontWeight: 600, margin: '0 0 0.25rem 0' }}>
                      No coding agent setups saved yet
                    </p>
                    <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: 0 }}>
                      Configure Claude Code, Antigravity (agy), Aider, Codex, or your own custom terminal command above and click Save.
                    </p>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                    {cliAgents.map((agent) => {
                      const isActive = activeCliAgentId === agent.id || (!activeCliAgentId && cliAgentConfig?.command === agent.command && (cliAgentConfig?.extraArgs || '') === (agent.extraArgs || ''));
                      const isCurrentlyEditing = agent.id === editingAgentId;
                      const preset = CLI_AGENT_PRESETS.find((p) => p.id === agent.presetId || p.command === agent.command);

                      return (
                        <div
                          key={agent.id}
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '0.6rem',
                            padding: '0.85rem 1rem',
                            background: 'var(--bg-dark)',
                            border: `1px solid ${isCurrentlyEditing
                              ? 'var(--accent-cyan)'
                              : isActive
                                ? 'rgba(16, 185, 129, 0.4)'
                                : 'var(--border-subtle)'
                              }`,
                            borderRadius: 'var(--radius-md)',
                            boxShadow: isActive ? '0 0 10px rgba(16, 185, 129, 0.08)' : 'none',
                            transition: 'all 0.15s ease'
                          }}
                        >
                          {/* Top Row: Preset icon/name, Name, Active Badge & Action Buttons */}
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                              <div
                                style={{
                                  width: 28,
                                  height: 28,
                                  borderRadius: '6px',
                                  background: preset ? (preset.badgeColor ? `${preset.badgeColor}22` : 'rgba(6, 182, 212, 0.15)') : 'rgba(16, 185, 129, 0.15)',
                                  border: `1px solid ${preset?.badgeColor || 'var(--accent-emerald)'}`,
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  flexShrink: 0
                                }}
                              >
                                <Terminal size={14} color={preset?.badgeColor || 'var(--accent-emerald)'} />
                              </div>
                              <div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                                  <span style={{ fontWeight: 700, fontSize: '0.9rem', color: '#fff' }}>{agent.name}</span>
                                  <span
                                    className="badge"
                                    style={{
                                      fontSize: '0.65rem',
                                      padding: '0.1rem 0.4rem',
                                      background: 'rgba(255, 255, 255, 0.06)',
                                      color: '#cbd5e1',
                                      borderColor: 'var(--border-subtle)'
                                    }}
                                  >
                                    {preset?.label || 'Custom'}
                                  </span>
                                  {isActive && (
                                    <span
                                      className="badge badge-done"
                                      style={{
                                        fontSize: '0.65rem',
                                        padding: '0.1rem 0.4rem',
                                        background: 'rgba(16, 185, 129, 0.15)',
                                        color: 'var(--accent-emerald)',
                                        borderColor: 'rgba(16, 185, 129, 0.3)'
                                      }}
                                    >
                                      Active Agent
                                    </span>
                                  )}
                                </div>
                                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.76rem', color: 'var(--accent-cyan)', marginTop: '0.15rem' }}>
                                  {agent.command} {agent.extraArgs ? <span style={{ color: 'var(--text-muted)' }}>{agent.extraArgs}</span> : null}
                                </div>
                              </div>
                            </div>

                            {/* Actions on this setup */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                              {!isActive && (
                                <button
                                  type="button"
                                  className="btn btn-secondary"
                                  style={{ fontSize: '0.74rem', padding: '0.25rem 0.6rem' }}
                                  onClick={() => {
                                    if (onSelectActiveCliAgent) {
                                      onSelectActiveCliAgent(agent.id);
                                    }
                                    onSaveCliAgent({
                                      id: agent.id,
                                      name: agent.name,
                                      presetId: agent.presetId,
                                      command: agent.command,
                                      extraArgs: agent.extraArgs,
                                    });
                                  }}
                                >
                                  Set Active
                                </button>
                              )}

                              <button
                                type="button"
                                className="btn btn-secondary"
                                style={{
                                  fontSize: '0.74rem',
                                  padding: '0.25rem 0.6rem',
                                  background: isCurrentlyEditing ? 'rgba(6, 182, 212, 0.15)' : undefined,
                                  borderColor: isCurrentlyEditing ? 'var(--accent-cyan)' : undefined,
                                  color: isCurrentlyEditing ? 'var(--accent-cyan)' : undefined
                                }}
                                onClick={() => loadAgentForEditing(agent)}
                                title="Edit this setup"
                              >
                                <Edit3 size={12} />
                                <span>Edit</span>
                              </button>

                              <button
                                type="button"
                                className="btn btn-secondary"
                                style={{
                                  fontSize: '0.74rem',
                                  padding: '0.25rem 0.5rem',
                                  color: 'var(--accent-rose)',
                                  borderColor: 'rgba(244, 63, 94, 0.2)'
                                }}
                                onClick={() => setAgentPendingDelete(agent)}
                                title="Delete this setup"
                              >
                                <Trash2 size={12} />
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Delete Agent Setup Confirmation Modal */}
              {agentPendingDelete && (
                <div
                  style={{
                    position: 'fixed',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    background: 'rgba(0, 0, 0, 0.75)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    zIndex: 10000,
                    backdropFilter: 'blur(3px)'
                  }}
                  onClick={() => setAgentPendingDelete(null)}
                >
                  <div
                    style={{
                      background: 'var(--bg-card)',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: 'var(--radius-md)',
                      padding: '1.5rem',
                      maxWidth: '420px',
                      width: '90%',
                      boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '1rem'
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                      <div
                        style={{
                          width: '32px',
                          height: '32px',
                          borderRadius: '8px',
                          background: 'rgba(244, 63, 94, 0.15)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          color: 'var(--accent-rose)'
                        }}
                      >
                        <AlertTriangle size={18} />
                      </div>
                      <h4 style={{ margin: 0, fontSize: '1rem', color: '#fff', fontWeight: 700 }}>
                        Delete Agent Setup?
                      </h4>
                    </div>
                    <p style={{ margin: 0, fontSize: '0.84rem', color: 'var(--text-muted)', lineHeight: '1.45' }}>
                      Are you sure you want to delete <strong style={{ color: '#fff' }}>{agentPendingDelete.name}</strong> ({agentPendingDelete.command})? This cannot be undone.
                    </p>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.6rem', marginTop: '0.25rem' }}>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => setAgentPendingDelete(null)}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary"
                        style={{ background: 'var(--accent-rose)', borderColor: 'var(--accent-rose)' }}
                        onClick={() => {
                          if (onDeleteCliAgentSetup) {
                            onDeleteCliAgentSetup(agentPendingDelete.id);
                          }
                          if (editingAgentId === agentPendingDelete.id) {
                            resetCliForm();
                          }
                          setAgentPendingDelete(null);
                        }}
                      >
                        Delete Setup
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
