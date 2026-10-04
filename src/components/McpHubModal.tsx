import React, { useState, useEffect } from 'react';
import {
  type MCPServer,
  type McpRootBoundary,
  type CliAgentConfig,
  type CliAgentPreset,
  type CliAgentSetup,
} from '../types';

import {
  getAllowedRoots,
  addAllowedRoot,
  removeAllowedRoot,
  callMcpTool,
  discoverRemoteMcpTools,
  connectGithubMcp,
  disconnectGithubMcp,
  getGithubMcpStatus
} from '../lib/mcpClient';
import { GITHUB_MCP_TOOLS } from '../lib/githubMcpTools';
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
  RefreshCw,
  Activity,
  Globe,
  Key,
  Eye,
  EyeOff,
  Search,
  ChevronDown,
  ChevronRight
} from 'lucide-react';

interface McpHubModalProps {
  isOpen: boolean;
  onClose: () => void;
  mcpServers: MCPServer[];
  onToggleConnectServer: (serverId: string) => void;
  onToggleToolAutoApprove: (serverId: string, toolId: string) => void;
  onAddCustomServer: (newServer: MCPServer) => void;
  onDeleteCustomServer?: (serverId: string) => void;
  onUpdateServer?: (server: MCPServer) => void;
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
  onDeleteCustomServer,
  onUpdateServer,
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
  const [newServerAuthHeader, setNewServerAuthHeader] = useState('');
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [discoveredPreview, setDiscoveredPreview] = useState<{
    serverName: string;
    toolsCount: number;
    tools: any[];
  } | null>(null);

  const [connectingServerId, setConnectingServerId] = useState<string | null>(null);
  const [roots, setRoots] = useState<McpRootBoundary[]>([]);
  const [newRootPath, setNewRootPath] = useState('');
  const [newRootName, setNewRootName] = useState('');

  // GitHub connection modal state
  const [isGhAuthModalOpen, setIsGhAuthModalOpen] = useState(false);
  const [ghTokenInput, setGhTokenInput] = useState('');
  const [isGhTesting, setIsGhTesting] = useState(false);
  const [ghAuthError, setGhAuthError] = useState<string | null>(null);
  const [showGhToken, setShowGhToken] = useState(false);
  const [ghAccountInfo, setGhAccountInfo] = useState<{ username?: string; name?: string; avatarUrl?: string } | null>(null);

  // Generic External Server modal state (for Slack, Notion, GCal, etc.)
  const [selectedExternalModalServer, setSelectedExternalModalServer] = useState<MCPServer | null>(null);
  const [genericEndpointInput, setGenericEndpointInput] = useState('');
  const [genericTokenInput, setGenericTokenInput] = useState('');
  const [genericAuthError, setGenericAuthError] = useState<string | null>(null);
  const [isGenericTesting, setIsGenericTesting] = useState(false);

  // Per-server tool search query
  const [toolSearchQueries, setToolSearchQueries] = useState<Record<string, string>>({});

  // Collapsed / Expanded state for connection cards (collapsed by default)
  const [expandedServerIds, setExpandedServerIds] = useState<Record<string, boolean>>({});

  const toggleExpandedServer = (serverId: string) => {
    setExpandedServerIds((prev) => ({
      ...prev,
      [serverId]: !prev[serverId]
    }));
  };

  // CLI agent local state
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [cliAgentName, setCliAgentName] = useState('');
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(cliAgentConfig?.presetId ?? null);
  const [cliCommand, setCliCommand] = useState(cliAgentConfig?.command ?? '');
  const [cliExtraArgs, setCliExtraArgs] = useState(cliAgentConfig?.extraArgs ?? '');
  const [cliSaved, setCliSaved] = useState(false);
  const [agentPendingDelete, setAgentPendingDelete] = useState<CliAgentSetup | null>(null);

  // Laya local test latency state
  const [layaTestStatus, setLayaTestStatus] = useState<{
    testing: boolean;
    latencyMs?: number;
    source?: string;
    error?: string;
  } | null>(null);

  const handleTestLaya = async () => {
    setLayaTestStatus({ testing: true });
    const startTime = performance.now();
    try {
      const res = await callMcpTool('mcp-laya', 'laya_choice', {
        prompt: 'Task priority evaluation test',
        options: ['critical', 'normal', 'low']
      });
      const latencyMs = Math.round(performance.now() - startTime);
      if (res.success) {
        const sourceLabel = res.data?.source === 'laya_local_service'
          ? 'laya-serve daemon (:8440)'
          : 'local fast head (CPU)';
        setLayaTestStatus({
          testing: false,
          latencyMs,
          source: sourceLabel
        });
      } else {
        setLayaTestStatus({
          testing: false,
          error: res.error || 'Failed to ping Laya bridge'
        });
      }
    } catch (e: any) {
      setLayaTestStatus({
        testing: false,
        error: e.message || 'Connection test error'
      });
    }
  };

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
      getGithubMcpStatus()
        .then((st) => {
          if (st.configured) {
            setGhAccountInfo({ username: st.username, name: st.name, avatarUrl: st.avatarUrl });
          }
        })
        .catch(() => { });
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

  const handleDiscoverEndpoint = async (url: string, auth?: string) => {
    if (!url.trim()) return null;
    setIsDiscovering(true);
    setDiscoveryError(null);
    try {
      const res = await discoverRemoteMcpTools(url.trim(), auth?.trim() || undefined);
      if (res.success) {
        setDiscoveredPreview({
          serverName: res.serverInfo?.name || new URL(url.startsWith('http') ? url : `https://${url}`).hostname,
          toolsCount: res.tools.length,
          tools: res.tools
        });
        if (!newServerName && res.serverInfo?.name) {
          setNewServerName(res.serverInfo.name);
        }
        return res;
      } else {
        setDiscoveryError(res.error || 'Failed to discover tools on target endpoint.');
        return res;
      }
    } catch (err: any) {
      setDiscoveryError(err.message || 'Discovery error');
      return null;
    } finally {
      setIsDiscovering(false);
    }
  };

  const handleAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newServerEndpoint.trim()) return;

    let targetUrl = newServerEndpoint.trim();
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      targetUrl = `https://${targetUrl}`;
    }

    let defaultName = newServerName.trim();
    if (!defaultName) {
      try {
        defaultName = new URL(targetUrl).hostname.replace(/^mcp\./, '');
      } catch {
        defaultName = 'Remote MCP';
      }
    }

    setIsDiscovering(true);
    setDiscoveryError(null);

    const discovery = await discoverRemoteMcpTools(targetUrl, newServerAuthHeader.trim() || undefined);
    setIsDiscovering(false);

    let toolsToRegister = discovery.tools;
    if (!toolsToRegister || toolsToRegister.length === 0) {
      toolsToRegister = [
        {
          id: `tool-1-${Date.now()}`,
          name: 'execute_remote_tool',
          description: 'Execute remote action on custom server',
          autoApprove: false
        }
      ];
    }

    const created: MCPServer = {
      id: `custom-${Date.now()}`,
      name: discovery.serverInfo?.name || defaultName,
      description: `Remote MCP server (${targetUrl})`,
      iconName: 'Cpu',
      category: 'developer',
      status: 'connected',
      transport: 'SSE',
      endpoint: targetUrl,
      serverType: 'external_oauth',
      isCustom: true,
      authHeader: newServerAuthHeader.trim() || undefined,
      lastSyncedAt: new Date().toISOString(),
      tools: toolsToRegister.map((t) => ({ ...t, serverId: `custom-${Date.now()}` }))
    };

    onAddCustomServer(created);
    setNewServerName('');
    setNewServerEndpoint('');
    setNewServerAuthHeader('');
    setDiscoveredPreview(null);
    setShowAddForm(false);
  };

  const handleConnectExternal = async (server: MCPServer) => {
    // 1. GitHub Server Handling
    if (server.id === 'mcp-github') {
      if (server.status === 'connected') {
        // Disconnect GitHub
        setConnectingServerId(server.id);
        try {
          await disconnectGithubMcp();
          if (onUpdateServer) {
            onUpdateServer({
              ...server,
              status: 'disconnected',
              authUsername: undefined,
              authHeader: undefined,
              error: undefined
            });
          } else {
            onToggleConnectServer(server.id);
          }
          setGhAccountInfo(null);
        } finally {
          setConnectingServerId(null);
        }
        return;
      }

      // If disconnected, open the GitHub Authentication modal
      setGhAuthError(null);
      setIsGhAuthModalOpen(true);
      return;
    }

    // 2. Custom User-Added Server
    if (server.isCustom && server.endpoint) {
      if (server.status === 'connected') {
        onToggleConnectServer(server.id);
        return;
      }

      setConnectingServerId(server.id);
      try {
        const disc = await discoverRemoteMcpTools(server.endpoint, server.authHeader);
        if (disc.success && disc.tools.length > 0 && onUpdateServer) {
          const updated: MCPServer = {
            ...server,
            status: 'connected',
            lastSyncedAt: new Date().toISOString(),
            tools: disc.tools.map((t) => ({ ...t, serverId: server.id })),
            error: undefined
          };
          onUpdateServer(updated);
        } else {
          if (onUpdateServer) {
            onUpdateServer({
              ...server,
              status: 'disconnected',
              error: disc.error || 'Failed to connect to endpoint'
            });
          }
        }
      } catch (err: any) {
        if (onUpdateServer) {
          onUpdateServer({
            ...server,
            status: 'disconnected',
            error: err.message
          });
        }
      } finally {
        setConnectingServerId(null);
      }
      return;
    }

    // 3. Other Preset External Apps (Slack, GCal, Salesforce, Notion)
    if (server.status === 'connected') {
      onToggleConnectServer(server.id);
      return;
    }

    // Prompt user for credentials / endpoint URL
    setSelectedExternalModalServer(server);
    setGenericEndpointInput(server.endpoint || '');
    setGenericTokenInput(server.authHeader || '');
    setGenericAuthError(null);
  };

  const handleConnectGithub = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const token = ghTokenInput.trim();
    if (!token) {
      setGhAuthError('Please enter a GitHub Personal Access Token.');
      return;
    }

    setIsGhTesting(true);
    setGhAuthError(null);

    try {
      const res = await connectGithubMcp(token);
      if (!res.success) {
        setGhAuthError(res.error || 'Authentication failed. Please verify your token.');
        setIsGhTesting(false);
        return;
      }

      const githubServer = mcpServers.find((s) => s.id === 'mcp-github');
      if (githubServer && onUpdateServer) {
        const toolsToSet = res.tools && res.tools.length > 0 ? res.tools : GITHUB_MCP_TOOLS;
        onUpdateServer({
          ...githubServer,
          status: 'connected',
          authUsername: res.user?.login,
          authHeader: token,
          tools: toolsToSet.map((t) => ({ ...t, serverId: 'mcp-github' })),
          lastSyncedAt: new Date().toISOString(),
          error: undefined
        });
      }

      setGhAccountInfo({
        username: res.user?.login,
        name: res.user?.name,
        avatarUrl: res.user?.avatarUrl
      });
      setIsGhAuthModalOpen(false);
      setGhTokenInput('');
    } catch (err: any) {
      setGhAuthError(err.message || 'Unexpected connection error');
    } finally {
      setIsGhTesting(false);
    }
  };

  const bundledHarnesses = mcpServers
    .filter((s) => s.serverType === 'bundled_harness' && s.id !== 'mcp-github' && s.id !== 'mcp-slack')
    .sort((a, b) => {
      if (a.id === 'mcp-laya') return -1;
      if (b.id === 'mcp-laya') return 1;
      return 0;
    });
  const externalServers = mcpServers.filter((s) => s.serverType !== 'bundled_harness' || s.id === 'mcp-github' || s.id === 'mcp-slack');

  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-content" style={{ maxWidth: '920px', height: '85vh', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
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
                <h3 style={{ fontSize: '1.15rem', fontWeight: 700, color: 'var(--text-bright)', margin: 0 }}>Connections</h3>
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
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
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
                <button className="btn btn-primary" style={{ fontSize: '0.8rem', padding: '0.35rem 0.75rem', marginTop: '-0.5rem', marginBottom: '0.75rem' }} onClick={() => setShowAddForm(!showAddForm)}>
                  <Plus size={14} />
                  <span>Connect Other</span>
                </button>
              )}
            </div>
          </div>

          {/* TAB 1: BUNDLED AGENT HARNESSES */}
          {activeTab === 'harnesses' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              {/* <div style={{ background: 'rgba(255, 255, 255, 0.02)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', padding: '0.85rem 1rem', fontSize: '0.82rem', color: 'var(--text-muted)', lineHeight: '1.5' }}>
                <strong style={{ color: '#fff' }}>Open-Source Agent Harnesses:</strong> Ergo bundles standard Node.js MCP servers (<span style={{ color: 'var(--accent-cyan)', fontFamily: 'var(--font-mono)' }}>server-filesystem</span>, <span style={{ color: 'var(--accent-cyan)', fontFamily: 'var(--font-mono)' }}>server-fetch</span>, and <span style={{ color: 'var(--accent-cyan)', fontFamily: 'var(--font-mono)' }}>mcp-server-git</span>) communicating via synchronous Local Stdio IPC. These operate browser-agnostically with zero database required.
              </div> */}

              <div className="mcp-grid">
                {bundledHarnesses.map((server) => {
                  const isConnected = server.status === 'connected';
                  const isExpanded = !!expandedServerIds[server.id];

                  return (
                    <div
                      key={server.id}
                      className={`mcp-card ${isConnected ? 'connected' : ''} ${!isExpanded ? 'collapsed' : ''}`}
                      onClick={() => {
                        if (!isExpanded) {
                          toggleExpandedServer(server.id);
                        }
                      }}
                    >
                      <div className="mcp-header">
                        <div className="mcp-title">
                          <button
                            type="button"
                            className="mcp-collapse-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleExpandedServer(server.id);
                            }}
                            title={isExpanded ? 'Collapse card' : 'Expand permissions & details'}
                            aria-label={isExpanded ? 'Collapse card' : 'Expand permissions & details'}
                          >
                            {isExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                          </button>
                          {renderServerIcon(server, isConnected)}
                          <span>{server.name}</span>
                          {!isExpanded && server.tools.length > 0 && (
                            <span style={{ fontSize: '0.68rem', color: 'var(--text-dim)', fontWeight: 500, fontFamily: 'var(--font-mono)' }}>
                              ({server.tools.length} {server.tools.length === 1 ? 'tool' : 'tools'})
                            </span>
                          )}
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                          <button
                            type="button"
                            className={isConnected ? 'btn btn-secondary' : 'btn btn-primary'}
                            style={{ padding: '0.2rem 0.5rem', fontSize: '0.72rem' }}
                            onClick={(e) => {
                              e.stopPropagation();
                              onToggleConnectServer(server.id);
                              if (!isConnected) {
                                setTimeout(() => handleTestLaya(), 150);
                              }
                            }}
                          >
                            {isConnected ? 'Disable' : 'Enable'}
                          </button>
                        </div>
                      </div>

                      {isExpanded && (
                        <>
                          <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', margin: 0, lineHeight: 1.45 }}>{server.description}</p>

                          {server.id === 'mcp-laya' && isConnected && (
                            <div
                              style={{
                                background: 'rgba(16, 185, 129, 0.08)',
                                border: '1px solid rgba(16, 185, 129, 0.25)',
                                borderRadius: 'var(--radius-sm)',
                                padding: '0.5rem 0.75rem',
                                fontSize: '0.75rem',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: '0.5rem',
                                marginTop: '0.45rem'
                              }}
                            >
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-bright)' }}>
                                <Activity size={14} color="var(--accent-emerald)" />
                                <span>
                                  {layaTestStatus?.testing ? (
                                    'Testing local decision engine latency…'
                                  ) : layaTestStatus?.latencyMs !== undefined ? (
                                    <>
                                      <strong style={{ color: 'var(--accent-emerald)' }}>Connected & Active:</strong> {layaTestStatus.latencyMs}ms latency ({layaTestStatus.source})
                                    </>
                                  ) : layaTestStatus?.error ? (
                                    <span style={{ color: '#ef4444' }}>Notice: {layaTestStatus.error}</span>
                                  ) : (
                                    <>
                                      <strong style={{ color: 'var(--accent-emerald)' }}>Engine Online ($0 Cost):</strong> High-speed System-1 micro-decisions active
                                    </>
                                  )}
                                </span>
                              </div>
                              <button
                                type="button"
                                className="btn btn-secondary"
                                style={{ padding: '0.2rem 0.55rem', fontSize: '0.7rem', display: 'flex', alignItems: 'center', gap: '0.3rem' }}
                                onClick={handleTestLaya}
                                disabled={layaTestStatus?.testing}
                                title="Ping local Laya engine to measure response latency"
                              >
                                <RefreshCw size={11} className={layaTestStatus?.testing ? 'animate-spin' : ''} />
                                <span>{layaTestStatus?.testing ? 'Testing…' : 'Ping Latency'}</span>
                              </button>
                            </div>
                          )}

                          {/* Discovered Tools List & Permissions */}
                          {isConnected && server.tools.length > 0 && (
                            <div style={{ background: 'var(--code-bg)', border: '1px solid var(--code-border)', padding: '0.75rem 0.85rem', borderRadius: 'var(--radius-sm)', marginTop: '0.35rem', boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)' }}>
                              <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--accent-cyan)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.35rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                <Shield size={13} />
                                <span>Auto-Approval & Permissions</span>
                              </div>
                              <p style={{ fontSize: '0.72rem', color: 'var(--text-dim)', margin: '0 0 0.5rem 0', lineHeight: 1.4 }}>
                                Control AI action permissions globally. Toggle Auto-Approve to allow agents to run commands automatically.
                              </p>

                              {server.tools.map((tool) => (
                                <div key={tool.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.78rem', padding: '0.35rem 0', borderTop: '1px solid rgba(255, 255, 255, 0.08)' }}>
                                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--code-text)', fontSize: '0.78rem', fontWeight: 500 }}>{tool.name}</span>
                                  <button
                                    style={{
                                      background: tool.autoApprove ? 'rgba(16, 185, 129, 0.2)' : 'rgba(245, 158, 11, 0.2)',
                                      color: tool.autoApprove ? '#34d399' : '#fbbf24',
                                      border: '1px solid ' + (tool.autoApprove ? 'rgba(16, 185, 129, 0.45)' : 'rgba(245, 158, 11, 0.45)'),
                                      padding: '0.2rem 0.55rem',
                                      borderRadius: '4px',
                                      fontSize: '0.72rem',
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
                        </>
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
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.35rem' }}>
                  <Lock size={25} color="var(--accent-cyan)" />
                  {/* <span style={{ fontWeight: 700, fontSize: '0.88rem', color: '#fff' }}>Allowed Filesystem Directories</span> */}
                  <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', margin: 0, lineHeight: 1.5 }}>
                    To protect your data, the filesystem connection (<span style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent-cyan)' }}>server-filesystem</span>) is strictly constrained to the folders you approve. AI agents cannot read or write outside these approved boundaries.
                  </p>
                </div>

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
                    Add Allowed Folder
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
                    <span>Add Folder</span>
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
                    Configured Folders ({roots.length})
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
                <form
                  onSubmit={handleAddSubmit}
                  style={{
                    background: 'var(--bg-card)',
                    border: '1px solid var(--accent-cyan)',
                    boxShadow: '0 0 20px rgba(6, 182, 212, 0.15)',
                    borderRadius: 'var(--radius-md)',
                    padding: '1.25rem',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.85rem'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <Globe size={16} color="var(--accent-cyan)" />
                      <h4 style={{ fontSize: '0.88rem', fontWeight: 700, color: '#fff', margin: 0 }}>
                        Connect Custom MCP Endpoint
                      </h4>
                    </div>
                    <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                      Non-technical? Just paste your MCP URL below and click Connect
                    </span>
                  </div>

                  <div>
                    <label className="input-label" style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.35rem', display: 'block' }}>
                      MCP Endpoint URL <span style={{ color: 'var(--accent-rose)' }}>*</span>
                    </label>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <input
                        type="text"
                        className="input-text"
                        placeholder="https://mcp.my-tool.com/sse or http://localhost:3000/sse"
                        value={newServerEndpoint}
                        onChange={(e) => {
                          setNewServerEndpoint(e.target.value);
                          setDiscoveryError(null);
                        }}
                        style={{ flex: 1 }}
                      />
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={!newServerEndpoint.trim() || isDiscovering}
                        onClick={() => handleDiscoverEndpoint(newServerEndpoint, newServerAuthHeader)}
                        style={{ fontSize: '0.78rem', whiteSpace: 'nowrap' }}
                      >
                        <RefreshCw size={13} className={isDiscovering ? 'animate-spin' : ''} />
                        <span>{isDiscovering ? 'Testing…' : 'Test Endpoint'}</span>
                      </button>
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.85rem' }}>
                    <div>
                      <label className="input-label" style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.35rem', display: 'block' }}>
                        Display Name <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>(auto-detected if blank)</span>
                      </label>
                      <input
                        type="text"
                        className="input-text"
                        placeholder="e.g. Asana, Linear, Airtable"
                        value={newServerName}
                        onChange={(e) => setNewServerName(e.target.value)}
                      />
                    </div>
                    <div>
                      <label className="input-label" style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.35rem', display: 'block' }}>
                        API Key / Bearer Token <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>(optional)</span>
                      </label>
                      <input
                        type="password"
                        className="input-text"
                        placeholder="Leave blank if public / unauthenticated"
                        value={newServerAuthHeader}
                        onChange={(e) => setNewServerAuthHeader(e.target.value)}
                      />
                    </div>
                  </div>

                  {discoveryError && (
                    <div style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.25)', borderRadius: 'var(--radius-sm)', padding: '0.5rem 0.75rem', color: '#f87171', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      <AlertTriangle size={14} />
                      <span>{discoveryError}</span>
                    </div>
                  )}

                  {discoveredPreview && (
                    <div style={{ background: 'rgba(16, 185, 129, 0.08)', border: '1px solid rgba(16, 185, 129, 0.25)', borderRadius: 'var(--radius-sm)', padding: '0.5rem 0.75rem', color: 'var(--accent-emerald)', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <CheckCircle2 size={15} />
                      <span>
                        Discovered <strong>{discoveredPreview.toolsCount}</strong> tools from <strong>{discoveredPreview.serverName}</strong>: {discoveredPreview.tools.slice(0, 4).map((t) => t.name).join(', ')}{discoveredPreview.toolsCount > 4 ? '…' : ''}
                      </span>
                    </div>
                  )}

                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.25rem' }}>
                    <button type="button" className="btn btn-secondary" style={{ fontSize: '0.8rem' }} onClick={() => setShowAddForm(false)}>
                      Cancel
                    </button>
                    <button type="submit" className="btn btn-primary" disabled={!newServerEndpoint.trim() || isDiscovering} style={{ fontSize: '0.8rem', gap: '0.35rem' }}>
                      <Check size={14} />
                      <span>{isDiscovering ? 'Connecting…' : 'Connect & Discover Tools'}</span>
                    </button>
                  </div>
                </form>
              )}

              <div className="mcp-grid">
                {externalServers.map((server) => {
                  const isConnected = server.status === 'connected';
                  const isConnecting = connectingServerId === server.id;
                  const isExpanded = !!expandedServerIds[server.id];

                  return (
                    <div
                      key={server.id}
                      className={`mcp-card ${isConnected ? 'connected' : ''} ${!isExpanded ? 'collapsed' : ''}`}
                      onClick={() => {
                        if (!isExpanded) {
                          toggleExpandedServer(server.id);
                        }
                      }}
                    >
                      <div className="mcp-header">
                        <div className="mcp-title">
                          <button
                            type="button"
                            className="mcp-collapse-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleExpandedServer(server.id);
                            }}
                            title={isExpanded ? 'Collapse card' : 'Expand permissions & details'}
                            aria-label={isExpanded ? 'Collapse card' : 'Expand permissions & details'}
                          >
                            {isExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                          </button>
                          {renderServerIcon(server, isConnected)}
                          <span>{server.name}</span>
                          {server.isCustom && (
                            <span style={{ fontSize: '0.62rem', background: 'rgba(255,255,255,0.06)', padding: '1px 5px', borderRadius: '3px', color: 'var(--accent-cyan)' }}>
                              Custom
                            </span>
                          )}
                          {!isExpanded && server.tools.length > 0 && (
                            <span style={{ fontSize: '0.68rem', color: 'var(--text-dim)', fontWeight: 500, fontFamily: 'var(--font-mono)' }}>
                              ({server.tools.length} {server.tools.length === 1 ? 'tool' : 'tools'})
                            </span>
                          )}
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                          {server.id === 'mcp-github' && isConnected && (
                            <button
                              type="button"
                              className="btn btn-secondary"
                              style={{ padding: '0.25rem 0.45rem', fontSize: '0.72rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}
                              onClick={(e) => {
                                e.stopPropagation();
                                setGhAuthError(null);
                                setIsGhAuthModalOpen(true);
                              }}
                              title="Configure GitHub Token"
                            >
                              <Key size={12} />
                              <span>Key</span>
                            </button>
                          )}

                          <button
                            className={isConnected ? 'btn btn-secondary' : 'btn btn-primary'}
                            style={{ padding: '0.25rem 0.65rem', fontSize: '0.75rem', minWidth: '75px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.3rem' }}
                            disabled={isConnecting}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleConnectExternal(server);
                            }}
                          >
                            {isConnecting ? (
                              <>
                                <RefreshCw size={12} className="animate-spin" />
                                <span>Syncing…</span>
                              </>
                            ) : isConnected ? (
                              <span>Disconnect</span>
                            ) : (
                              <span>Connect</span>
                            )}
                          </button>

                          {server.isCustom && onDeleteCustomServer && (
                            <button
                              type="button"
                              className="btn btn-secondary"
                              style={{ padding: '0.25rem 0.45rem', color: 'var(--accent-rose)', fontSize: '0.72rem' }}
                              onClick={(e) => {
                                e.stopPropagation();
                                onDeleteCustomServer(server.id);
                              }}
                              title="Remove custom connection"
                            >
                              <Trash2 size={13} />
                            </button>
                          )}
                        </div>
                      </div>

                      {isExpanded && (
                        <>
                          <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', margin: 0, lineHeight: 1.45 }}>{server.description}</p>

                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-dim)', paddingTop: '0.4rem', borderTop: '1px solid var(--border-subtle)' }}>
                            <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                              <span style={{ width: 6, height: 6, borderRadius: '50%', background: isConnected ? 'var(--accent-emerald)' : 'var(--text-dim)' }} />
                              <span>{isConnected ? 'Active & Ready' : 'Disconnected'}</span>
                              {isConnected && (server.authUsername || (server.id === 'mcp-github' && ghAccountInfo?.username)) && (
                                <span style={{ color: 'var(--accent-cyan)', fontWeight: 600, fontSize: '0.72rem', background: 'rgba(6, 182, 212, 0.1)', padding: '1px 6px', borderRadius: '4px' }}>
                                  @{server.authUsername || ghAccountInfo?.username}
                                </span>
                              )}
                            </span>
                            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem', maxWidth: '240px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={server.endpoint}>
                              {server.id === 'mcp-github'
                                ? (isConnected ? 'Stdio MCP (@modelcontextprotocol/server-github)' : 'Personal Token Required')
                                : (server.endpoint ? server.endpoint.replace('https://', '').replace('http://', '') : 'Configuration Required')}
                            </span>
                          </div>

                          {server.error && (
                            <div style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.25)', borderRadius: 'var(--radius-sm)', padding: '0.4rem 0.6rem', color: '#f87171', fontSize: '0.72rem', display: 'flex', alignItems: 'center', gap: '0.35rem', marginTop: '0.35rem' }}>
                              <AlertTriangle size={13} style={{ flexShrink: 0 }} />
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{server.error}</span>
                            </div>
                          )}

                          {/* Tools List & Permissions */}
                          {server.tools.length > 0 && (
                            <div style={{ background: 'var(--code-bg)', border: '1px solid var(--code-border)', padding: '0.75rem 0.85rem', borderRadius: 'var(--radius-sm)', marginTop: '0.35rem', boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)' }}>
                              <div style={{ fontSize: '0.72rem', fontWeight: 700, color: isConnected ? 'var(--accent-cyan)' : 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.35rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                  <Shield size={13} />
                                  <span>{isConnected ? `Discovered Tools (${server.tools.length})` : `Available Tools (${server.tools.length})`}</span>
                                </div>
                                {isConnected && (
                                  <button
                                    type="button"
                                    onClick={async () => {
                                      setConnectingServerId(server.id);
                                      if (server.id === 'mcp-github') {
                                        const st = await getGithubMcpStatus();
                                        if (st.configured && onUpdateServer) {
                                          onUpdateServer({
                                            ...server,
                                            status: 'connected',
                                            authUsername: st.username,
                                            lastSyncedAt: new Date().toISOString()
                                          });
                                        }
                                      } else if (server.endpoint) {
                                        const disc = await discoverRemoteMcpTools(server.endpoint, server.authHeader);
                                        if (disc.success && disc.tools.length > 0 && onUpdateServer) {
                                          onUpdateServer({
                                            ...server,
                                            lastSyncedAt: new Date().toISOString(),
                                            tools: disc.tools.map((t) => ({ ...t, serverId: server.id })),
                                            error: undefined
                                          });
                                        }
                                      }
                                      setConnectingServerId(null);
                                    }}
                                    disabled={connectingServerId === server.id}
                                    style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.68rem' }}
                                    title="Sync latest tools from endpoint"
                                  >
                                    <RefreshCw size={11} className={connectingServerId === server.id ? 'animate-spin' : ''} />
                                    <span>Refresh</span>
                                  </button>
                                )}
                              </div>

                              {server.tools.length > 6 && (
                                <div style={{ position: 'relative', marginBottom: '0.4rem' }}>
                                  <Search size={11} style={{ position: 'absolute', left: '0.5rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-dim)' }} />
                                  <input
                                    type="text"
                                    className="input-text"
                                    placeholder={`Filter ${server.tools.length} tools...`}
                                    value={toolSearchQueries[server.id] || ''}
                                    onChange={(e) => setToolSearchQueries({ ...toolSearchQueries, [server.id]: e.target.value })}
                                    style={{
                                      width: '100%',
                                      paddingLeft: '1.6rem',
                                      paddingRight: '0.5rem',
                                      paddingTop: '0.2rem',
                                      paddingBottom: '0.2rem',
                                      fontSize: '0.72rem',
                                      height: '24px'
                                    }}
                                  />
                                </div>
                              )}

                              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', maxHeight: '180px', overflowY: 'auto' }}>
                                {server.tools
                                  .filter((tool) => {
                                    const q = (toolSearchQueries[server.id] || '').toLowerCase().trim();
                                    if (!q) return true;
                                    return tool.name.toLowerCase().includes(q) || (tool.description && tool.description.toLowerCase().includes(q));
                                  })
                                  .map((tool) => (
                                    <div key={tool.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.78rem', padding: '0.3rem 0', borderTop: '1px solid rgba(255, 255, 255, 0.06)' }}>
                                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.1rem', overflow: 'hidden' }}>
                                        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--code-text)', fontSize: '0.76rem', fontWeight: 600 }}>{tool.name}</span>
                                        {tool.description && (
                                          <span style={{ fontSize: '0.68rem', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '280px' }} title={tool.description}>
                                            {tool.description}
                                          </span>
                                        )}
                                      </div>
                                      <button
                                        type="button"
                                        style={{
                                          background: tool.autoApprove ? 'rgba(16, 185, 129, 0.2)' : 'rgba(245, 158, 11, 0.2)',
                                          color: tool.autoApprove ? '#34d399' : '#fbbf24',
                                          border: '1px solid ' + (tool.autoApprove ? 'rgba(16, 185, 129, 0.45)' : 'rgba(245, 158, 11, 0.45)'),
                                          padding: '0.2rem 0.55rem',
                                          borderRadius: '4px',
                                          fontSize: '0.7rem',
                                          cursor: 'pointer',
                                          fontWeight: 600,
                                          flexShrink: 0,
                                          transition: 'all 0.15s ease'
                                        }}
                                        onClick={() => onToggleToolAutoApprove(server.id, tool.id)}
                                      >
                                        {tool.autoApprove ? 'Auto-Approve' : 'Ask Permission'}
                                      </button>
                                    </div>
                                  ))}
                              </div>
                            </div>
                          )}
                        </>
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
              {/* <div style={{ background: 'rgba(255, 255, 255, 0.02)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', padding: '0.85rem 1rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.35rem' }}>
                  <Terminal size={15} color="var(--accent-emerald)" />
                  <span style={{ fontWeight: 700, fontSize: '0.88rem', color: '#fff' }}>Coding Agent Execution</span>
                </div>
                <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', margin: 0, lineHeight: '1.5' }}>
                  When you execute a coding task, a coding agent runs in its own embedded terminal.
                </p>
              </div> */}

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
                  background: 'var(--bg-card)',
                  border: editingAgentId ? '1.5px solid var(--accent-cyan)' : '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-md)',
                  padding: '1.25rem',
                  boxShadow: editingAgentId ? '0 0 16px rgba(6, 182, 212, 0.15)' : 'var(--shadow-card)',
                  transition: 'all 0.2s ease',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '1rem'
                }}
              >
                {/* Preset cards selection */}
                <div>
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
                            background: isSelected ? 'rgba(99, 102, 241, 0.12)' : 'var(--btn-secondary-bg)',
                            border: `1.5px solid ${isSelected ? 'var(--accent-primary)' : 'var(--btn-secondary-border)'}`,
                            borderRadius: 'var(--radius-md)',
                            padding: '0.75rem 0.85rem',
                            cursor: 'pointer',
                            transition: 'all 0.15s ease',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '0.35rem'
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
                            background: 'var(--bg-card)',
                            border: `1.5px solid ${isCurrentlyEditing
                              ? 'var(--accent-cyan)'
                              : isActive
                                ? 'var(--accent-emerald)'
                                : 'var(--border-subtle)'
                              }`,
                            borderRadius: 'var(--radius-md)',
                            boxShadow: isActive ? '0 0 10px rgba(16, 185, 129, 0.12)' : 'var(--shadow-card)',
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
                                  <span style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--text-bright)' }}>{agent.name}</span>
                                  <span
                                    className="badge"
                                    style={{
                                      fontSize: '0.65rem',
                                      padding: '0.1rem 0.4rem',
                                      background: 'var(--btn-secondary-bg)',
                                      color: 'var(--text-muted)',
                                      borderColor: 'var(--btn-secondary-border)'
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

      {/* GitHub Authentication Modal */}
      {isGhAuthModalOpen && (
        <div
          className="modal-overlay"
          style={{ zIndex: 1100, backgroundColor: 'rgba(0,0,0,0.78)', backdropFilter: 'blur(4px)' }}
          onClick={(e) => {
            if (e.target === e.currentTarget && !isGhTesting) setIsGhAuthModalOpen(false);
          }}
        >
          <div
            className="modal-content"
            style={{
              maxWidth: '560px',
              padding: '1.75rem',
              borderRadius: 'var(--radius-lg)',
              border: '1px solid rgba(255,255,255,0.14)',
              boxShadow: '0 25px 60px rgba(0,0,0,0.6)',
              position: 'relative'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <div
                  style={{
                    width: '42px',
                    height: '42px',
                    borderRadius: '10px',
                    background: 'linear-gradient(135deg, #24292e 0%, #0d1117 100%)',
                    border: '1px solid rgba(255,255,255,0.18)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.3)'
                  }}
                >
                  <Code size={22} color="#fff" />
                </div>
                <div>
                  <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700, color: '#fff' }}>
                    Connect GitHub MCP
                  </h3>
                  <p style={{ margin: '0.15rem 0 0', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                    Execute the official GitHub Model Context Protocol server locally
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => !isGhTesting && setIsGhAuthModalOpen(false)}
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '0.25rem' }}
              >
                <X size={18} />
              </button>
            </div>

            {/* Quick 1-Click Helper Banner for Non-Techies */}
            <div
              style={{
                background: 'rgba(56, 189, 248, 0.08)',
                border: '1px solid rgba(56, 189, 248, 0.25)',
                borderRadius: 'var(--radius-md)',
                padding: '1rem',
                marginBottom: '1.25rem'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem' }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--accent-cyan)', marginBottom: '0.25rem' }}>
                    Need a Personal Access Token?
                  </div>
                  <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', lineHeight: 1.45 }}>
                    Generate a token on GitHub with recommended scopes (<code style={{ color: '#fff', fontSize: '0.72rem' }}>repo</code>, <code style={{ color: '#fff', fontSize: '0.72rem' }}>read:org</code>, <code style={{ color: '#fff', fontSize: '0.72rem' }}>user</code>) already pre-checked.
                  </div>
                </div>
                <a
                  href="https://github.com/settings/tokens/new?scopes=repo,read:org,user&description=Ergo%20MCP"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-secondary"
                  style={{
                    fontSize: '0.76rem',
                    whiteSpace: 'nowrap',
                    gap: '0.35rem',
                    flexShrink: 0,
                    color: 'var(--accent-cyan)',
                    borderColor: 'rgba(56, 189, 248, 0.4)'
                  }}
                >
                  <ExternalLink size={13} />
                  <span>Generate Token ↗</span>
                </a>
              </div>
            </div>

            {/* Token Form */}
            <form onSubmit={handleConnectGithub}>
              <div style={{ marginBottom: '1rem' }}>
                <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.4rem' }}>
                  Personal Access Token <span style={{ color: 'var(--accent-rose)' }}>*</span>
                </label>
                <div style={{ position: 'relative' }}>
                  <input
                    type={showGhToken ? 'text' : 'password'}
                    className="input-text"
                    placeholder="ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                    value={ghTokenInput}
                    onChange={(e) => {
                      setGhTokenInput(e.target.value);
                      setGhAuthError(null);
                    }}
                    disabled={isGhTesting}
                    autoFocus
                    style={{
                      width: '100%',
                      paddingRight: '2.5rem',
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.82rem'
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowGhToken(!showGhToken)}
                    style={{
                      position: 'absolute',
                      right: '0.65rem',
                      top: '50%',
                      transform: 'translateY(-50%)',
                      background: 'none',
                      border: 'none',
                      color: 'var(--text-muted)',
                      cursor: 'pointer',
                      padding: 0
                    }}
                  >
                    {showGhToken ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '0.35rem' }}>
                  Stored securely in your workspace <code style={{ color: 'var(--accent-amber)' }}>config/secrets.json</code> and never transmitted to Ergo cloud servers.
                </div>
              </div>

              {ghAuthError && (
                <div
                  style={{
                    background: 'rgba(239, 68, 68, 0.1)',
                    border: '1px solid rgba(239, 68, 68, 0.3)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '0.6rem 0.8rem',
                    color: '#f87171',
                    fontSize: '0.76rem',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    marginBottom: '1rem'
                  }}
                >
                  <AlertTriangle size={15} style={{ flexShrink: 0 }} />
                  <span>{ghAuthError}</span>
                </div>
              )}

              {/* Actions */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.65rem', marginTop: '1.25rem' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setIsGhAuthModalOpen(false)}
                  disabled={isGhTesting}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={!ghTokenInput.trim() || isGhTesting}
                  style={{ gap: '0.4rem', minWidth: '160px', justifyContent: 'center' }}
                >
                  {isGhTesting ? (
                    <>
                      <RefreshCw size={13} className="animate-spin" />
                      <span>Connecting…</span>
                    </>
                  ) : (
                    <>
                      <Check size={14} />
                      <span>Authenticate & Connect</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Generic External Server Modal */}
      {selectedExternalModalServer && (
        <div
          className="modal-overlay"
          style={{ zIndex: 1100, backgroundColor: 'rgba(0,0,0,0.78)', backdropFilter: 'blur(4px)' }}
          onClick={(e) => {
            if (e.target === e.currentTarget && !isGenericTesting) setSelectedExternalModalServer(null);
          }}
        >
          <div
            className="modal-content"
            style={{
              maxWidth: '540px',
              padding: '1.75rem',
              borderRadius: 'var(--radius-lg)',
              border: '1px solid rgba(255,255,255,0.14)',
              boxShadow: '0 25px 60px rgba(0,0,0,0.6)'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                {renderServerIcon(selectedExternalModalServer, false)}
                <div>
                  <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700, color: '#fff' }}>
                    Connect {selectedExternalModalServer.name}
                  </h3>
                  <p style={{ margin: '0.15rem 0 0', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                    Provide endpoint URL or credentials to connect
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedExternalModalServer(null)}
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
              >
                <X size={18} />
              </button>
            </div>

            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (!genericEndpointInput.trim()) {
                  setGenericAuthError('Endpoint URL is required');
                  return;
                }
                setIsGenericTesting(true);
                setGenericAuthError(null);
                const disc = await discoverRemoteMcpTools(genericEndpointInput, genericTokenInput);
                if (disc.success && disc.tools.length > 0 && onUpdateServer) {
                  onUpdateServer({
                    ...selectedExternalModalServer,
                    status: 'connected',
                    endpoint: genericEndpointInput.trim(),
                    authHeader: genericTokenInput.trim() || undefined,
                    tools: disc.tools.map((t) => ({ ...t, serverId: selectedExternalModalServer.id })),
                    lastSyncedAt: new Date().toISOString(),
                    error: undefined
                  });
                  setSelectedExternalModalServer(null);
                } else {
                  setGenericAuthError(disc.error || 'Failed to connect and discover tools at this endpoint');
                }
                setIsGenericTesting(false);
              }}
            >
              <div style={{ marginBottom: '1rem' }}>
                <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.35rem' }}>
                  MCP Server Endpoint URL <span style={{ color: 'var(--accent-rose)' }}>*</span>
                </label>
                <input
                  type="text"
                  className="input-text"
                  placeholder="https://mcp.your-service.com/sse or http://localhost:3000/sse"
                  value={genericEndpointInput}
                  onChange={(e) => {
                    setGenericEndpointInput(e.target.value);
                    setGenericAuthError(null);
                  }}
                  style={{ width: '100%', fontSize: '0.82rem' }}
                />
              </div>

              <div style={{ marginBottom: '1rem' }}>
                <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.35rem' }}>
                  API Key / Bot Token <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>(optional)</span>
                </label>
                <input
                  type="password"
                  className="input-text"
                  placeholder="Leave empty if not required"
                  value={genericTokenInput}
                  onChange={(e) => setGenericTokenInput(e.target.value)}
                  style={{ width: '100%', fontSize: '0.82rem' }}
                />
              </div>

              {genericAuthError && (
                <div style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: 'var(--radius-sm)', padding: '0.6rem 0.8rem', color: '#f87171', fontSize: '0.76rem', display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
                  <AlertTriangle size={15} style={{ flexShrink: 0 }} />
                  <span>{genericAuthError}</span>
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.65rem', marginTop: '1.25rem' }}>
                <button type="button" className="btn btn-secondary" onClick={() => setSelectedExternalModalServer(null)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={!genericEndpointInput.trim() || isGenericTesting}>
                  {isGenericTesting ? 'Connecting…' : 'Connect & Discover'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
