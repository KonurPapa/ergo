import React, { useState } from 'react';
import { type MCPServer } from '../types';
import { Cpu, X, Shield, Plus, Code, Folder, FileText, MessageSquare, HardDrive, BarChart2, Database, Layers } from 'lucide-react';

interface McpHubModalProps {
  isOpen: boolean;
  onClose: () => void;
  mcpServers: MCPServer[];
  onToggleConnectServer: (serverId: string) => void;
  onToggleToolAutoApprove: (serverId: string, toolId: string) => void;
  onAddCustomServer: (newServer: MCPServer) => void;
}

function renderServerIcon(iconName: string, isConnected: boolean) {
  const color = isConnected ? 'var(--accent-emerald)' : 'var(--text-dim)';
  const size = 18;
  switch (iconName) {
    case 'Code': return <Code size={size} color={color} />;
    case 'Folder': return <Folder size={size} color={color} />;
    case 'FileText': return <FileText size={size} color={color} />;
    case 'MessageSquare': return <MessageSquare size={size} color={color} />;
    case 'HardDrive': return <HardDrive size={size} color={color} />;
    case 'Figma': return <Layers size={size} color={color} />;
    case 'BarChart2': return <BarChart2 size={size} color={color} />;
    case 'Database': return <Database size={size} color={color} />;
    case 'Github': return <Code size={size} color={color} />;
    default: return <Cpu size={size} color={color} />;
  }
}

export const McpHubModal: React.FC<McpHubModalProps> = ({
  isOpen,
  onClose,
  mcpServers,
  onToggleConnectServer,
  onToggleToolAutoApprove,
  onAddCustomServer
}) => {
  const [showAddForm, setShowAddForm] = useState(false);
  const [newServerName, setNewServerName] = useState('');
  const [newServerEndpoint, setNewServerEndpoint] = useState('');

  if (!isOpen) return null;

  const handleAddSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newServerName || !newServerEndpoint) return;

    const created: MCPServer = {
      id: `custom-${Date.now()}`,
      name: newServerName,
      description: 'Custom remote MCP server connection.',
      iconName: 'Cpu',
      category: 'developer',
      status: 'connected',
      transport: 'OAuth 2.1',
      endpoint: newServerEndpoint,
      tools: [
        { id: `tool-1-${Date.now()}`, name: 'execute_remote_tool', description: 'Execute remote action on custom server', autoApprove: false }
      ]
    };

    onAddCustomServer(created);
    setNewServerName('');
    setNewServerEndpoint('');
    setShowAddForm(false);
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ maxWidth: '950px' }}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <Cpu size={22} color="var(--accent-violet)" />
            <div>
              <h3 style={{ fontSize: '1.1rem', fontWeight: 700 }}>Bring Your Own MCP Hub (Model Context Protocol)</h3>
              <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                Mandated OAuth 2.1 PKCE transport & SSE endpoint authorization standard
              </p>
            </div>
          </div>
          <button className="btn btn-secondary" style={{ padding: '0.3rem 0.5rem' }} onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="modal-body">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
            <div style={{ fontSize: '0.88rem', color: 'var(--text-main)' }}>
              Connected MCP Servers: <strong style={{ color: 'var(--accent-emerald)' }}>{mcpServers.filter((s) => s.status === 'connected').length} / {mcpServers.length} Active</strong>
            </div>

            <button className="btn btn-primary" style={{ fontSize: '0.8rem', padding: '0.35rem 0.75rem' }} onClick={() => setShowAddForm(!showAddForm)}>
              <Plus size={14} />
              <span>Connect Remote MCP Server</span>
            </button>
          </div>

          {showAddForm && (
            <form onSubmit={handleAddSubmit} style={{ background: 'var(--bg-darkest)', border: '1px solid var(--border-glow)', borderRadius: 'var(--radius-md)', padding: '1rem', marginBottom: '1.25rem' }}>
              <h4 style={{ fontSize: '0.9rem', fontWeight: 700, color: '#fff', marginBottom: '0.75rem' }}>Add Remote MCP Endpoint (March 2025 OAuth 2.1 Standard)</h4>
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

          {/* MCP Server Cards Grid */}
          <div className="mcp-grid">
            {mcpServers.map((server) => {
              const isConnected = server.status === 'connected';
              return (
                <div key={server.id} className={`mcp-card ${isConnected ? 'connected' : ''}`}>
                  <div className="mcp-header">
                    <div className="mcp-title">
                      {renderServerIcon(server.iconName, isConnected)}
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

        <div className="modal-footer">
          <button className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
