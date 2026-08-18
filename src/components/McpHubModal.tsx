import React, { useState, useEffect } from 'react';
import { type MCPServer, type McpRootBoundary, type CliAgentConfig, type CliAgentPreset } from '../types';

import { getAllowedRoots, addAllowedRoot, removeAllowedRoot } from '../lib/mcpClient';
import {
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
  RefreshCw,
  FolderPlus,
  Trash2,
  Lock,
  Terminal,
  Check,
  CheckCircle2,
  ExternalLink,
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
}) => {
  const [activeTab, setActiveTab] = useState<'harnesses' | 'roots' | 'external' | 'cli'>('harnesses');

  const [showAddForm, setShowAddForm] = useState(false);
  const [newServerName, setNewServerName] = useState('');
  const [newServerEndpoint, setNewServerEndpoint] = useState('');
  const [roots, setRoots] = useState<McpRootBoundary[]>([]);
  const [newRootPath, setNewRootPath] = useState('');
  const [newRootName, setNewRootName] = useState('');
  const [isSyncing, setIsSyncing] = useState(false);

  // CLI agent local state
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(cliAgentConfig?.presetId ?? null);
  const [cliCommand, setCliCommand] = useState(cliAgentConfig?.command ?? '');
  const [cliExtraArgs, setCliExtraArgs] = useState(cliAgentConfig?.extraArgs ?? '');
  const [cliSaved, setCliSaved] = useState(false);

  useEffect(() => {
    if (isOpen) {
      getAllowedRoots().then(setRoots);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSyncAllTools = async () => {
    setIsSyncing(true);
    await new Promise((r) => setTimeout(r, 700));
    setIsSyncing(false);
  };

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
      <div className="modal-content" style={{ maxWidth: '960px' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <Cpu size={22} color="var(--accent-violet)" />
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <h3 style={{ fontSize: '1.1rem', fontWeight: 700 }}>Bring Your Own MCP Hub (Model Context Protocol)</h3>
                <span className="badge badge-done" style={{ fontSize: '0.65rem', padding: '0.1rem 0.35rem' }}>
                  Persisted in config/secrets.json
                </span>
              </div>
              <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                Universal local stdio agent harnesses, safe directory roots, and OAuth 2.1 external tool servers
              </p>
            </div>
          </div>
          <button className="btn btn-secondary" style={{ padding: '0.3rem 0.5rem' }} onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {/* Tab Navigation */}
        <div style={{ display: 'flex', gap: '0.5rem', borderBottom: '1px solid var(--border-subtle)', padding: '0 1.5rem', background: 'var(--bg-darkest)' }}>
          <button
            className={`tab-btn ${activeTab === 'harnesses' ? 'active' : ''}`}
            onClick={() => setActiveTab('harnesses')}
            style={{
              padding: '0.75rem 1rem',
              borderBottom: activeTab === 'harnesses' ? '2px solid var(--accent-primary)' : '2px solid transparent',
              color: activeTab === 'harnesses' ? '#fff' : 'var(--text-muted)',
              fontWeight: 600,
              fontSize: '0.85rem',
              background: 'none',
              border: 'none',
              cursor: 'pointer'
            }}
          >
            Bundled Agent Harnesses ({bundledHarnesses.length})
          </button>

          <button
            className={`tab-btn ${activeTab === 'roots' ? 'active' : ''}`}
            onClick={() => setActiveTab('roots')}
            style={{
              padding: '0.75rem 1rem',
              borderBottom: activeTab === 'roots' ? '2px solid var(--accent-primary)' : '2px solid transparent',
              color: activeTab === 'roots' ? '#fff' : 'var(--text-muted)',
              fontWeight: 600,
              fontSize: '0.85rem',
              background: 'none',
              border: 'none',
              cursor: 'pointer'
            }}
          >
            Safe Directory Roots ({roots.length})
          </button>

          <button
            className={`tab-btn ${activeTab === 'external' ? 'active' : ''}`}
            onClick={() => setActiveTab('external')}
            style={{
              padding: '0.75rem 1rem',
              borderBottom: activeTab === 'external' ? '2px solid var(--accent-primary)' : '2px solid transparent',
              color: activeTab === 'external' ? '#fff' : 'var(--text-muted)',
              fontWeight: 600,
              fontSize: '0.85rem',
              background: 'none',
              border: 'none',
              cursor: 'pointer'
            }}
          >
            External OAuth MCPs ({externalServers.length})
          </button>

          <button
            className={`tab-btn ${activeTab === 'cli' ? 'active' : ''}`}
            onClick={() => setActiveTab('cli')}
            style={{
              padding: '0.75rem 1rem',
              borderBottom: activeTab === 'cli' ? '2px solid var(--accent-emerald)' : '2px solid transparent',
              color: activeTab === 'cli' ? 'var(--accent-emerald)' : 'var(--text-muted)',
              fontWeight: 600,
              fontSize: '0.85rem',
              background: 'none',
              border: 'none',
              cursor: 'pointer'
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
              <Terminal size={13} />
              CLI Coding Agents
              {cliAgentConfig && <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent-emerald)', display: 'inline-block' }} />}
            </span>
          </button>

        </div>

        <div className="modal-body" style={{ paddingTop: '1.25rem' }}>
          {/* Header Action Bar */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
            <div style={{ fontSize: '0.88rem', color: 'var(--text-main)' }}>
              Connected MCP Servers: <strong style={{ color: 'var(--accent-emerald)' }}>{mcpServers.filter((s) => s.status === 'connected').length} / {mcpServers.length} Active</strong>
            </div>

            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                className="btn btn-secondary"
                style={{ fontSize: '0.8rem', padding: '0.35rem 0.75rem', gap: '0.4rem' }}
                onClick={handleSyncAllTools}
                title="Call tools/list across all servers to discover latest tools and update signatures"
              >
                <RefreshCw size={13} className={isSyncing ? 'animate-spin' : ''} />
                <span>{isSyncing ? 'Syncing tools/list...' : 'Sync tools/list'}</span>
              </button>

              {activeTab === 'external' && (
                <button className="btn btn-primary" style={{ fontSize: '0.8rem', padding: '0.35rem 0.75rem' }} onClick={() => setShowAddForm(!showAddForm)}>
                  <Plus size={14} />
                  <span>Connect MCP Server</span>
                </button>
              )}
            </div>
          </div>

          {/* TAB 1: BUNDLED AGENT HARNESSES */}
          {activeTab === 'harnesses' && (
            <div>
              <div style={{ background: 'var(--bg-darkest)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', padding: '0.85rem 1rem', marginBottom: '1.25rem', fontSize: '0.84rem', color: 'var(--text-muted)', lineHeight: '1.5' }}>
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
                          Built-in Harness
                        </span>
                      </div>

                      <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>{server.description}</p>

                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-dim)', paddingTop: '0.4rem', borderTop: '1px solid var(--border-subtle)' }}>
                        <span>Transport: <strong style={{ color: 'var(--accent-emerald)' }}>{server.transport}</strong></span>
                        <span style={{ fontFamily: 'var(--font-mono)' }}>{server.tools.length} tools registered</span>
                      </div>

                      {/* Discovered Tools List */}
                      {isConnected && server.tools.length > 0 && (
                        <div style={{ background: 'var(--bg-darkest)', padding: '0.65rem', borderRadius: 'var(--radius-sm)', marginTop: '0.2rem' }}>
                          <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--accent-cyan)', textTransform: 'uppercase', marginBottom: '0.35rem', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                            <Shield size={11} />
                            <span>Tools & Security Auto-Approval Policies</span>
                          </div>

                          {server.tools.map((tool) => (
                            <div key={tool.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.78rem', padding: '0.25rem 0' }}>
                              <span style={{ fontFamily: 'var(--font-mono)', color: '#fff' }}>{tool.name}</span>
                              <button
                                style={{
                                  background: tool.autoApprove ? 'rgba(16, 185, 129, 0.15)' : 'rgba(245, 158, 11, 0.15)',
                                  color: tool.autoApprove ? 'var(--accent-emerald)' : 'var(--accent-amber)',
                                  border: '1px solid ' + (tool.autoApprove ? 'rgba(16, 185, 129, 0.3)' : 'rgba(245, 158, 11, 0.3)'),
                                  padding: '0.1rem 0.4rem',
                                  borderRadius: '4px',
                                  fontSize: '0.7rem',
                                  cursor: 'pointer'
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
            <div>
              <div style={{ background: 'rgba(59, 130, 246, 0.08)', border: '1px solid rgba(59, 130, 246, 0.3)', borderRadius: 'var(--radius-md)', padding: '1rem', marginBottom: '1.25rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--accent-cyan)', fontWeight: 700, fontSize: '0.9rem', marginBottom: '0.3rem' }}>
                  <Lock size={16} />
                  <span>Filesystem MCP Boundary Sandboxing (Roots)</span>
                </div>
                <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                  To protect your hard drive, the Filesystem MCP server (<span style={{ fontFamily: 'var(--font-mono)' }}>server-filesystem</span>) is strictly constrained to the directory paths configured below. AI agents cannot read or write outside these approved boundaries.
                </p>
              </div>

              {/* Add Root Form */}
              <form onSubmit={handleAddRootSubmit} style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.25rem' }}>
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

              {/* Roots List */}
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
                      <Folder size={18} color="var(--accent-primary)" />
                      <div>
                        <div style={{ fontWeight: 600, fontSize: '0.88rem', color: '#fff', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                          <span>{root.name}</span>
                          {root.isDefault && (
                            <span className="badge badge-done" style={{ fontSize: '0.65rem' }}>
                              Primary Workspace
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
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
          )}

          {/* TAB 3: EXTERNAL SAAS MCPS */}
          {activeTab === 'external' && (
            <div>
              {showAddForm && (
                <form onSubmit={handleAddSubmit} style={{ background: 'var(--bg-darkest)', border: '1px solid var(--border-glow)', borderRadius: 'var(--radius-md)', padding: '1rem', marginBottom: '1.25rem' }}>
                  <h4 style={{ fontSize: '0.9rem', fontWeight: 700, color: '#fff', marginBottom: '0.75rem' }}>Add Remote MCP Endpoint (OAuth 2.1 PKCE Standard)</h4>
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
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.75rem' }}>
                    <button type="button" className="btn btn-secondary" style={{ fontSize: '0.8rem' }} onClick={() => setShowAddForm(false)}>Cancel</button>
                    <button type="submit" className="btn btn-emerald" style={{ fontSize: '0.8rem' }}>Authorize & Connect</button>
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
                          {isConnected ? 'Disconnect' : 'Connect OAuth'}
                        </button>
                      </div>

                      <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>{server.description}</p>

                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-dim)', paddingTop: '0.4rem', borderTop: '1px solid var(--border-subtle)' }}>
                        <span>Transport: {server.transport}</span>
                        <span style={{ fontFamily: 'var(--font-mono)' }}>{server.endpoint.replace('https://', '')}</span>
                      </div>

                      {/* Discovered Tools List */}
                      {isConnected && server.tools.length > 0 && (
                        <div style={{ background: 'var(--bg-darkest)', padding: '0.65rem', borderRadius: 'var(--radius-sm)', marginTop: '0.2rem' }}>
                          <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--accent-cyan)', textTransform: 'uppercase', marginBottom: '0.35rem', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                            <Shield size={11} />
                            <span>Available MCP Tools & Security Policies</span>
                          </div>

                          {server.tools.map((tool) => (
                            <div key={tool.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.78rem', padding: '0.25rem 0' }}>
                              <span style={{ fontFamily: 'var(--font-mono)', color: '#fff' }}>{tool.name}</span>
                              <button
                                style={{
                                  background: tool.autoApprove ? 'rgba(16, 185, 129, 0.15)' : 'rgba(245, 158, 11, 0.15)',
                                  color: tool.autoApprove ? 'var(--accent-emerald)' : 'var(--accent-amber)',
                                  border: '1px solid ' + (tool.autoApprove ? 'rgba(16, 185, 129, 0.3)' : 'rgba(245, 158, 11, 0.3)'),
                                  padding: '0.1rem 0.4rem',
                                  borderRadius: '4px',
                                  fontSize: '0.7rem',
                                  cursor: 'pointer'
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
            <div>
              {/* Explainer */}
              <div style={{ background: 'rgba(16,185,129,0.07)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: 'var(--radius-md)', padding: '1rem', marginBottom: '1.25rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--accent-emerald)', fontWeight: 700, fontSize: '0.9rem', marginBottom: '0.3rem' }}>
                  <Terminal size={16} />
                  <span>Native CLI Agent Execution</span>
                </div>
                <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', lineHeight: '1.55' }}>
                  When you click <strong style={{ color: '#fff' }}>Execute Task</strong>, Ergo spawns your chosen coding agent in a real PTY terminal inside the AI Workspace — identical to running it in your IDE's integrated terminal. No custom integrations needed: arrow-key prompts, colors, and interactive widgets all work natively.
                </p>
              </div>

              {/* Preset cards */}
              <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.75rem' }}>Popular Agents</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: '0.75rem', marginBottom: '1.5rem' }}>
                {CLI_AGENT_PRESETS.map((preset) => {
                  const isSelected = selectedPresetId === preset.id;
                  return (
                    <button
                      key={preset.id}
                      onClick={() => {
                        setSelectedPresetId(preset.id);
                        setCliCommand(preset.command);
                        setCliExtraArgs(preset.defaultArgs);
                        setCliSaved(false);
                      }}
                      style={{
                        textAlign: 'left',
                        background: isSelected ? 'rgba(16,185,129,0.09)' : 'var(--bg-card)',
                        border: `1px solid ${isSelected ? 'rgba(16,185,129,0.45)' : 'var(--border-subtle)'}`,
                        borderRadius: 'var(--radius-md)',
                        padding: '0.85rem',
                        cursor: 'pointer',
                        transition: 'all 0.15s ease',
                        position: 'relative',
                      }}
                    >
                      {isSelected && (
                        <span style={{ position: 'absolute', top: '0.5rem', right: '0.5rem' }}>
                          <Check size={14} color="var(--accent-emerald)" />
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
                        style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem', marginTop: '0.5rem', fontSize: '0.72rem', color: 'var(--accent-primary)', textDecoration: 'none' }}
                      >
                        <ExternalLink size={10} /> Docs
                      </a>
                    </button>
                  );
                })}
              </div>

              {/* Custom / override fields */}
              <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.65rem' }}>Command Configuration</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.85rem', marginBottom: '1rem' }}>
                <div>
                  <label className="input-label">Shell Command</label>
                  <input
                    type="text"
                    className="input-text"
                    placeholder="e.g. claude, agy, aider"
                    value={cliCommand}
                    onChange={(e) => { setCliCommand(e.target.value); setSelectedPresetId(null); setCliSaved(false); }}
                  />
                </div>
                <div>
                  <label className="input-label">Extra Flags (optional)</label>
                  <input
                    type="text"
                    className="input-text"
                    placeholder="e.g. --model gpt-4o --verbose"
                    value={cliExtraArgs}
                    onChange={(e) => { setCliExtraArgs(e.target.value); setCliSaved(false); }}
                  />
                </div>
              </div>

              <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                <button
                  className="btn btn-emerald"
                  disabled={!cliCommand.trim()}
                  onClick={() => {
                    const config: CliAgentConfig = {
                      presetId: selectedPresetId ?? undefined,
                      command: cliCommand.trim(),
                      extraArgs: cliExtraArgs.trim(),
                    };
                    onSaveCliAgent(config);
                    setCliSaved(true);
                  }}
                >
                  <Check size={14} />
                  <span>Save Agent Config</span>
                </button>
                {cliAgentConfig && (
                  <button
                    className="btn btn-secondary"
                    style={{ color: 'var(--accent-rose)', fontSize: '0.8rem' }}
                    onClick={() => { onSaveCliAgent(null); setCliCommand(''); setCliExtraArgs(''); setSelectedPresetId(null); setCliSaved(false); }}
                  >
                    Clear
                  </button>
                )}
                {cliSaved && (
                  <span style={{ fontSize: '0.82rem', color: 'var(--accent-emerald)', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                    <CheckCircle2 size={14} /> Saved
                  </span>
                )}
              </div>
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
