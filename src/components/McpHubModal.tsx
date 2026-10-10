import React, { useState, useEffect } from 'react';
import {
  type MCPServer,
  type McpRootBoundary,
  type WorkspaceSkill
} from '../types';

import {
  getAllowedRoots,
  addAllowedRoot,
  removeAllowedRoot,
  callMcpTool,
  discoverRemoteMcpTools,
  connectGithubMcp,
  disconnectGithubMcp,
  getGithubMcpStatus,
  checkAllMcpUpdates
} from '../lib/mcpClient';
import { GITHUB_MCP_TOOLS } from '../lib/githubMcpTools';
import { WORKSPACE_MCP_TOOLS } from '../lib/workspaceMcp';
import {
  getWorkspaceSkills,
  addCustomSkill,
  updateSkill,
  deleteSkill,
  toggleSkill,
  syncSkillsToWorkspace
} from '../lib/skillsManager';
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
  Check,
  CheckCircle2,
  ExternalLink,
  Edit3,
  AlertTriangle,
  RefreshCw,
  Activity,
  Globe,
  Key,
  Eye,
  EyeOff,
  Search,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Sparkles,
  Wrench,
  FileCode,
  HelpCircle,
  Copy
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
}

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

interface McpSetupGuide {
  title: string;
  badge: string;
  description: string;
  docsUrl: string;
  docsLabel: string;
  defaultEndpoint?: string;
  endpointPlaceholder: string;
  tokenLabel: string;
  tokenPlaceholder: string;
  tokenHelpText: string;
  quickRunCommand?: string;
  setupSteps: string[];
}

const MCP_EXTERNAL_SETUP_GUIDES: Record<string, McpSetupGuide> = {
  'mcp-gcal': {
    title: 'Google Calendar MCP Setup',
    badge: 'Official Google Calendar Server',
    description: 'Connect Google Calendar using an MCP SSE or HTTP bridge server. You can run the official local bridge with npx or point to your hosted endpoint.',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/gdrive',
    docsLabel: 'View Setup Guide ↗',
    defaultEndpoint: 'http://localhost:3000/sse',
    endpointPlaceholder: 'http://localhost:3000/sse or https://your-bridge.domain/sse',
    tokenLabel: 'Google OAuth Client Secret or Bearer Token',
    tokenPlaceholder: 'Leave blank if local bridge already authenticated via browser OAuth',
    tokenHelpText: 'If running locally with the official MCP bridge, browser OAuth logs you in automatically. Credentials remain safe on your device.',
    quickRunCommand: 'npx -y @modelcontextprotocol/server-google-calendar',
    setupSteps: [
      'Option A (Recommended): Run the local MCP bridge with: npx -y @modelcontextprotocol/server-google-calendar',
      'Option B (Hosted): Deploy an SSE MCP bridge and paste its URL below.',
      'Sign in once with your Google Account when prompted in the browser.',
      'Click "Fill Recommended Default" below to auto-fill http://localhost:3000/sse and click Connect.'
    ]
  },
  'mcp-slack': {
    title: 'Slack MCP Setup',
    badge: 'Slack Bot & Channels',
    description: 'Allow Ergo to post project updates, compose message drafts, and read announcements from your Slack workspace.',
    docsUrl: 'https://api.slack.com/apps',
    docsLabel: 'Slack App Console ↗',
    defaultEndpoint: 'http://localhost:3001/sse',
    endpointPlaceholder: 'http://localhost:3001/sse or https://mcp.your-slack-bot.com/sse',
    tokenLabel: 'Bot User OAuth Token (xoxb-...)',
    tokenPlaceholder: 'xoxb-xxxxxxxxxxxx-xxxxxxxxxxxx-xxxxxxxxxxxxxxxx',
    tokenHelpText: 'Generate a Bot User OAuth Token in your Slack App under "OAuth & Permissions". Must have channels:read, chat:write scopes.',
    quickRunCommand: 'npx -y @modelcontextprotocol/server-slack',
    setupSteps: [
      'Create or select an app at api.slack.com/apps.',
      'Add chat:write and channels:read scopes under OAuth & Permissions.',
      'Install to workspace and copy the "Bot User OAuth Token" (starts with xoxb-).',
      'Paste the token below and connect via your local or remote SSE server.'
    ]
  },
  'mcp-notion': {
    title: 'Notion MCP Setup',
    badge: 'Notion Workspace API',
    description: 'Index Notion pages, sync database tables, and draft roadmap briefs directly from Ergo AI agents.',
    docsUrl: 'https://www.notion.so/my-integrations',
    docsLabel: 'Notion Integrations ↗',
    defaultEndpoint: 'http://localhost:3002/sse',
    endpointPlaceholder: 'http://localhost:3002/sse or https://mcp.your-domain.com/sse',
    tokenLabel: 'Internal Integration Secret (ntn_... or secret_...)',
    tokenPlaceholder: 'ntn_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    tokenHelpText: 'Create an integration at notion.so/my-integrations and grant access to pages/databases you want Ergo to reach.',
    quickRunCommand: 'npx -y @modelcontextprotocol/server-notion',
    setupSteps: [
      'Visit notion.so/my-integrations and click "+ New integration".',
      'Copy your "Internal Integration Secret".',
      'In Notion, open the page or database you want to share, click "..." -> "Connect to" -> select your integration.',
      'Enter the bridge endpoint and token below, then click Connect.'
    ]
  },
  'mcp-salesforce': {
    title: 'Salesforce MCP Setup',
    badge: 'Salesforce CRM Connected App',
    description: 'Query CRM accounts, leads, deals, and opportunities using the Model Context Protocol Salesforce bridge.',
    docsUrl: 'https://help.salesforce.com/s/articleView?id=sf.connected_app_overview.htm',
    docsLabel: 'Salesforce Setup Guide ↗',
    defaultEndpoint: 'http://localhost:3003/sse',
    endpointPlaceholder: 'http://localhost:3003/sse or https://salesforce-mcp.company.internal/sse',
    tokenLabel: 'Access Token or Connected App Secret',
    tokenPlaceholder: 'Paste Salesforce OAuth Access Token or API Token',
    tokenHelpText: 'Obtain an Access Token or API Token from your Salesforce Connected App under Setup -> App Manager.',
    setupSteps: [
      'Log into Salesforce Setup and navigate to App Manager -> New Connected App.',
      'Enable OAuth Settings with API / Web access permissions.',
      'Deploy the Salesforce MCP bridge with your Connected App credentials.',
      'Enter your bridge endpoint URL below to sync CRM tools.'
    ]
  },
  'mcp-zapier': {
    title: 'Zapier MCP Setup',
    badge: '5,000+ App Actions via Zapier',
    description: 'Execute thousands of third-party actions with Zapier AI Actions & MCP server.',
    docsUrl: 'https://actions.zapier.com/',
    docsLabel: 'Zapier Actions Console ↗',
    defaultEndpoint: 'https://actions.zapier.com/mcp/sse',
    endpointPlaceholder: 'https://actions.zapier.com/mcp/sse',
    tokenLabel: 'Zapier API Key / Personal Access Key',
    tokenPlaceholder: 'ak_xxxxxxxxxxxxxxxxxxxxxxxx',
    tokenHelpText: 'Get your Zapier AI Actions API key from actions.zapier.com and configure the actions you want available to AI.',
    setupSteps: [
      'Visit actions.zapier.com and sign in with your Zapier account.',
      'Create and configure enabled actions (e.g., Send Gmail, Create Linear Issue, etc.).',
      'Copy your API Key and paste it into the token field below.',
      'Endpoint is prefilled to https://actions.zapier.com/mcp/sse. Click Connect.'
    ]
  }
};

export const McpHubModal: React.FC<McpHubModalProps> = ({
  isOpen,
  onClose,
  mcpServers,
  onToggleConnectServer,
  onToggleToolAutoApprove,
  onAddCustomServer,
  onDeleteCustomServer,
  onUpdateServer,
}) => {
  const [activeTab, setActiveTab] = useState<'harnesses' | 'tools-skills' | 'roots' | 'external'>('harnesses');

  // Tools & Skills tab state
  const [skills, setSkills] = useState<WorkspaceSkill[]>(() => getWorkspaceSkills());
  const [skillsSubView, setSkillsSubView] = useState<'tools' | 'skills'>('tools');
  const [toolsSearchQuery, setToolsSearchQuery] = useState('');
  const [selectedToolsCategory, setSelectedToolsCategory] = useState<'all' | 'tasks' | 'lanes' | 'execution' | 'mcp'>('all');
  const [expandedToolIds, setExpandedToolIds] = useState<Record<string, boolean>>({});
  const [expandedSkillIds, setExpandedSkillIds] = useState<Record<string, boolean>>({});
  const [isSkillModalOpen, setIsSkillModalOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<WorkspaceSkill | null>(null);
  const [skillFormData, setSkillFormData] = useState({
    name: '',
    description: '',
    rules: '',
    instructions: '',
    triggerKeywords: ''
  });
  const [skillsSyncSuccessMsg, setSkillsSyncSuccessMsg] = useState<string | null>(null);

  const handleSyncSkillsNow = async () => {
    try {
      await syncSkillsToWorkspace(skills);
      setSkillsSyncSuccessMsg(`Synced ${skills.length} skills to .agents/skills/ in workspace codebase.`);
      setTimeout(() => setSkillsSyncSuccessMsg(null), 4000);
    } catch {
      setSkillsSyncSuccessMsg('Skills saved to workspace settings.');
      setTimeout(() => setSkillsSyncSuccessMsg(null), 4000);
    }
  };

  const handleToggleSkill = (skillId: string) => {
    toggleSkill(skillId);
    const updated = getWorkspaceSkills();
    setSkills(updated);
    syncSkillsToWorkspace(updated).catch(() => { });
  };

  const handleOpenAddSkill = () => {
    setEditingSkill(null);
    setSkillFormData({
      name: '',
      description: '',
      rules: '',
      instructions: '',
      triggerKeywords: ''
    });
    setIsSkillModalOpen(true);
  };

  const handleOpenEditSkill = (skill: WorkspaceSkill) => {
    setEditingSkill(skill);
    setSkillFormData({
      name: skill.name,
      description: skill.description,
      rules: skill.rules || '',
      instructions: skill.instructions,
      triggerKeywords: skill.triggerKeywords.join(', ')
    });
    setIsSkillModalOpen(true);
  };

  const handleDeleteCustomSkill = (skillId: string) => {
    if (window.confirm('Are you sure you want to delete this custom skill?')) {
      deleteSkill(skillId);
      const updated = getWorkspaceSkills();
      setSkills(updated);
      syncSkillsToWorkspace(updated).catch(() => { });
    }
  };

  const handleSaveSkillForm = (e: React.FormEvent) => {
    e.preventDefault();
    if (!skillFormData.name.trim() || !skillFormData.description.trim() || !skillFormData.instructions.trim()) {
      return;
    }

    const triggers = skillFormData.triggerKeywords
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);

    if (editingSkill) {
      updateSkill(editingSkill.id, {
        name: skillFormData.name.trim(),
        description: skillFormData.description.trim(),
        rules: skillFormData.rules.trim(),
        instructions: skillFormData.instructions.trim(),
        triggerKeywords: triggers
      });
    } else {
      addCustomSkill({
        name: skillFormData.name.trim(),
        description: skillFormData.description.trim(),
        rules: skillFormData.rules.trim(),
        instructions: skillFormData.instructions.trim(),
        triggerKeywords: triggers,
        enabled: true
      });
    }

    const updated = getWorkspaceSkills();
    setSkills(updated);
    syncSkillsToWorkspace(updated).catch(() => { });
    setIsSkillModalOpen(false);
    setEditingSkill(null);
  };

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
  const [showGenericToken, setShowGenericToken] = useState(false);
  const [isMcpGuideExpanded, setIsMcpGuideExpanded] = useState(false);
  const [copiedSnippet, setCopiedSnippet] = useState(false);

  // Routine update checking state
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
  const [updateStatusMsg, setUpdateStatusMsg] = useState<string | null>(null);

  const handleCheckAllUpdates = async () => {
    setIsCheckingUpdates(true);
    setUpdateStatusMsg(null);
    try {
      const result = await checkAllMcpUpdates(mcpServers);
      if (result.hasChanges) {
        if (onUpdateServer) {
          result.updatedServers.forEach((s) => onUpdateServer(s));
        }
        setUpdateStatusMsg(result.summaryMessage || 'Discovered new/updated MCP tools!');
      } else {
        setUpdateStatusMsg('All connected MCP tools are up-to-date.');
      }
    } catch (err: any) {
      setUpdateStatusMsg('Failed to check updates: ' + (err.message || 'Network error'));
    } finally {
      setIsCheckingUpdates(false);
      setTimeout(() => setUpdateStatusMsg(null), 5000);
    }
  };

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
    }
  }, [isOpen]);

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
    const guide = MCP_EXTERNAL_SETUP_GUIDES[server.id];
    setSelectedExternalModalServer(server);
    setGenericEndpointInput(server.endpoint || guide?.defaultEndpoint || '');
    setGenericTokenInput(server.authHeader || '');
    setGenericAuthError(null);
    setShowGenericToken(false);
    setIsMcpGuideExpanded(false);
    setCopiedSnippet(false);
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
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            {updateStatusMsg && (
              <span
                style={{
                  fontSize: '0.74rem',
                  color: updateStatusMsg.includes('Failed') ? 'var(--accent-red)' : 'var(--accent-emerald)',
                  fontWeight: 500,
                  maxWidth: '320px',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
                title={updateStatusMsg}
              >
                {updateStatusMsg}
              </span>
            )}
            <button
              className="btn btn-secondary"
              style={{
                padding: '0.35rem 0.65rem',
                fontSize: '0.75rem',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.4rem',
                borderRadius: '6px',
                border: '1px solid var(--border-subtle)',
                background: isCheckingUpdates ? 'rgba(99, 102, 241, 0.12)' : undefined,
                color: isCheckingUpdates ? 'var(--accent-primary)' : 'var(--text-muted)'
              }}
              onClick={handleCheckAllUpdates}
              disabled={isCheckingUpdates}
              title="Routinely query tools/list across connected MCP servers"
            >
              <RefreshCw size={13} style={{ animation: isCheckingUpdates ? 'spin 1s linear infinite' : 'none' }} />
              <span>{isCheckingUpdates ? 'Checking...' : 'Check Updates'}</span>
            </button>
            <button className="btn btn-secondary" style={{ padding: '0.35rem 0.6rem' }} onClick={onClose}>
              <X size={16} />
            </button>
          </div>
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
            className={`tab-btn ${activeTab === 'tools-skills' ? 'active' : ''}`}
            onClick={() => setActiveTab('tools-skills')}
            style={{
              padding: '0.75rem 1rem',
              border: 'none',
              borderBottom: activeTab === 'tools-skills' ? '2px solid #a855f7' : '2px solid transparent',
              color: activeTab === 'tools-skills' ? '#fff' : 'var(--text-muted)',
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
            <Sparkles size={14} color="#a855f7" />
            <span>Tools & Skills</span>
            <span style={{ fontSize: '0.68rem', padding: '0.1rem 0.45rem', borderRadius: '10px', background: activeTab === 'tools-skills' ? 'rgba(168, 85, 247, 0.2)' : 'rgba(255, 255, 255, 0.05)', color: activeTab === 'tools-skills' ? '#c084fc' : 'var(--text-dim)', fontWeight: 700 }}>
              {WORKSPACE_MCP_TOOLS.length} tools / {skills.length} skills
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

          {/* TAB: TOOLS & SKILLS */}
          {activeTab === 'tools-skills' && (() => {
            const getToolCategory = (name: string): 'tasks' | 'lanes' | 'execution' | 'mcp' => {
              if (name.includes('task') && !name.includes('execute') && !name.includes('run') && !name.includes('schedule') && !name.includes('cancel') && !name.includes('move')) {
                return 'tasks';
              }
              if (name.includes('swim_lane') || name.includes('move_task_lane')) {
                return 'lanes';
              }
              if (name.includes('execute') || name.includes('run_') || name.includes('schedule') || name.includes('cancel') || name.includes('brief')) {
                return 'execution';
              }
              return 'mcp';
            };

            const filteredWorkspaceTools = WORKSPACE_MCP_TOOLS.filter((t) => {
              const cat = getToolCategory(t.name);
              if (selectedToolsCategory !== 'all' && cat !== selectedToolsCategory) return false;
              if (toolsSearchQuery.trim()) {
                const q = toolsSearchQuery.toLowerCase();
                return t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q);
              }
              return true;
            });

            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                {/* Header Card */}
                <div
                  style={{
                    background: 'linear-gradient(135deg, rgba(168, 85, 247, 0.08) 0%, rgba(59, 130, 246, 0.04) 100%)',
                    border: '1px solid rgba(168, 85, 247, 0.25)',
                    borderRadius: 'var(--radius-md)',
                    padding: '1rem 1.25rem',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: '1rem'
                  }}
                >
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.35rem' }}>
                      <Sparkles size={18} color="#c084fc" />
                      <h3 style={{ fontSize: '1rem', fontWeight: 700, color: '#f3e8ff', margin: 0 }}>
                        Ergo Workspace Actions & Global Skills
                      </h3>
                      <span style={{ fontSize: '0.68rem', fontWeight: 700, padding: '0.15rem 0.55rem', borderRadius: '12px', background: 'rgba(168, 85, 247, 0.2)', color: '#d8b4fe', border: '1px solid rgba(168, 85, 247, 0.4)' }}>
                        Global AI Engine
                      </span>
                    </div>
                    <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: 0, maxWidth: '680px', lineHeight: 1.45 }}>
                      Built-in Ergo MCP tools enable the internal AI agent to interact directly with tasks, swim lanes, and executions.
                      Global skills define autonomous agent behaviors and are automatically synced to <code style={{ color: '#c084fc' }}>.agents/skills/</code> in your workspace.
                    </p>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={handleSyncSkillsNow}
                      style={{
                        fontSize: '0.78rem',
                        padding: '0.45rem 0.85rem',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.45rem',
                        borderColor: 'rgba(168, 85, 247, 0.35)',
                        color: '#e9d5ff'
                      }}
                      title="Write skill files to .agents/skills/ in the project folder"
                    >
                      <Folder size={14} color="#c084fc" />
                      <span>Sync Codebase (.agents/skills/)</span>
                    </button>

                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={handleOpenAddSkill}
                      style={{
                        fontSize: '0.78rem',
                        padding: '0.45rem 0.85rem',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.45rem',
                        background: 'linear-gradient(135deg, #9333ea 0%, #7c3aed 100%)',
                        borderColor: '#a855f7'
                      }}
                    >
                      <Plus size={14} />
                      <span>New Custom Skill</span>
                    </button>
                  </div>
                </div>

                {skillsSyncSuccessMsg && (
                  <div
                    style={{
                      background: 'rgba(16, 185, 129, 0.12)',
                      border: '1px solid rgba(16, 185, 129, 0.35)',
                      borderRadius: 'var(--radius-sm)',
                      padding: '0.55rem 0.85rem',
                      color: '#6ee7b7',
                      fontSize: '0.78rem',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem'
                    }}
                  >
                    <CheckCircle2 size={15} />
                    <span>{skillsSyncSuccessMsg}</span>
                  </div>
                )}

                {/* Sub-view switcher pills */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '0.75rem' }}>
                  <button
                    type="button"
                    onClick={() => setSkillsSubView('tools')}
                    style={{
                      padding: '0.4rem 0.9rem',
                      borderRadius: '20px',
                      fontSize: '0.78rem',
                      fontWeight: 600,
                      border: '1px solid',
                      cursor: 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.45rem',
                      transition: 'all 0.15s ease',
                      background: skillsSubView === 'tools' ? 'rgba(168, 85, 247, 0.2)' : 'rgba(255, 255, 255, 0.04)',
                      borderColor: skillsSubView === 'tools' ? '#a855f7' : 'var(--border-subtle)',
                      color: skillsSubView === 'tools' ? '#f3e8ff' : 'var(--text-muted)'
                    }}
                  >
                    <Wrench size={13} color={skillsSubView === 'tools' ? '#c084fc' : 'currentColor'} />
                    <span>Ergo Workspace MCP Tools ({WORKSPACE_MCP_TOOLS.length})</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setSkillsSubView('skills')}
                    style={{
                      padding: '0.4rem 0.9rem',
                      borderRadius: '20px',
                      fontSize: '0.78rem',
                      fontWeight: 600,
                      border: '1px solid',
                      cursor: 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.45rem',
                      transition: 'all 0.15s ease',
                      background: skillsSubView === 'skills' ? 'rgba(168, 85, 247, 0.2)' : 'rgba(255, 255, 255, 0.04)',
                      borderColor: skillsSubView === 'skills' ? '#a855f7' : 'var(--border-subtle)',
                      color: skillsSubView === 'skills' ? '#f3e8ff' : 'var(--text-muted)'
                    }}
                  >
                    <Sparkles size={13} color={skillsSubView === 'skills' ? '#c084fc' : 'currentColor'} />
                    <span>Global Rules & Skills ({skills.length})</span>
                  </button>
                </div>

                {/* ── SUB-VIEW A: WORKSPACE MCP TOOLS ── */}
                {skillsSubView === 'tools' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                    {/* Category Filter Pills & Search */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap' }}>
                        {[
                          { id: 'all', label: `All Actions (${WORKSPACE_MCP_TOOLS.length})` },
                          { id: 'tasks', label: 'Tasks & Subtasks (6)' },
                          { id: 'lanes', label: 'Swim Lanes & Routing (5)' },
                          { id: 'execution', label: 'Executions & Scheduler (7)' },
                          { id: 'mcp', label: 'External MCP Inspector (3)' }
                        ].map((cat) => (
                          <button
                            key={cat.id}
                            type="button"
                            onClick={() => setSelectedToolsCategory(cat.id as any)}
                            style={{
                              padding: '0.25rem 0.65rem',
                              borderRadius: '6px',
                              fontSize: '0.74rem',
                              fontWeight: 600,
                              border: '1px solid',
                              cursor: 'pointer',
                              background: selectedToolsCategory === cat.id ? 'rgba(168, 85, 247, 0.18)' : 'rgba(255, 255, 255, 0.03)',
                              borderColor: selectedToolsCategory === cat.id ? 'rgba(168, 85, 247, 0.45)' : 'var(--border-subtle)',
                              color: selectedToolsCategory === cat.id ? '#e9d5ff' : 'var(--text-muted)'
                            }}
                          >
                            {cat.label}
                          </button>
                        ))}
                      </div>

                      <div style={{ position: 'relative', width: '240px' }}>
                        <Search size={13} style={{ position: 'absolute', left: '0.65rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-dim)' }} />
                        <input
                          type="text"
                          className="input-text"
                          placeholder="Filter tools..."
                          value={toolsSearchQuery}
                          onChange={(e) => setToolsSearchQuery(e.target.value)}
                          style={{ paddingLeft: '2rem', paddingRight: '0.5rem', height: '28px', fontSize: '0.74rem', width: '100%' }}
                        />
                      </div>
                    </div>

                    {/* Security Notice */}
                    <div
                      style={{
                        background: 'rgba(59, 130, 246, 0.06)',
                        border: '1px solid rgba(59, 130, 246, 0.22)',
                        borderRadius: 'var(--radius-sm)',
                        padding: '0.65rem 0.95rem',
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: '0.65rem',
                        fontSize: '0.76rem',
                        color: '#93c5fd',
                        lineHeight: 1.45
                      }}
                    >
                      <Shield size={16} color="#60a5fa" style={{ flexShrink: 0, marginTop: '2px' }} />
                      <div>
                        <strong style={{ color: '#dbeafe' }}>Manual Security Policy:</strong> External MCP server connections, API tokens, tool permissions, and removal are strictly manual and human-controlled in the <em>External Apps</em> tab. The AI workspace can inspect available external tools via <code>workspace_read_mcp_tools</code>, but cannot modify permissions or remove servers.
                      </div>
                    </div>

                    {/* Tools Grid */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
                      {filteredWorkspaceTools.map((tool) => {
                        const isExpanded = !!expandedToolIds[tool.name];
                        const category = getToolCategory(tool.name);
                        const schemaProps = (tool.inputSchema as any)?.properties || {};
                        const requiredFields: string[] = (tool.inputSchema as any)?.required || [];
                        const propKeys = Object.keys(schemaProps);

                        const categoryBadges: Record<string, { label: string; color: string; bg: string }> = {
                          tasks: { label: 'Task CRUD', color: '#93c5fd', bg: 'rgba(59, 130, 246, 0.12)' },
                          lanes: { label: 'Swim Lanes', color: '#67e8f9', bg: 'rgba(6, 182, 212, 0.12)' },
                          execution: { label: 'AI Execution', color: '#6ee7b7', bg: 'rgba(16, 185, 129, 0.12)' },
                          mcp: { label: 'MCP Reader', color: '#c4b5fd', bg: 'rgba(139, 92, 246, 0.12)' }
                        };

                        const badge = categoryBadges[category] || categoryBadges.tasks;

                        return (
                          <div
                            key={tool.name}
                            style={{
                              background: '#15181e',
                              border: '1px solid rgba(255, 255, 255, 0.07)',
                              borderRadius: 'var(--radius-sm)',
                              padding: '0.75rem 1rem',
                              transition: 'all 0.15s ease'
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                                <span
                                  style={{
                                    fontFamily: 'var(--font-mono, monospace)',
                                    fontSize: '0.82rem',
                                    fontWeight: 700,
                                    color: '#f8fafc',
                                    background: 'rgba(255, 255, 255, 0.05)',
                                    padding: '0.2rem 0.55rem',
                                    borderRadius: '4px',
                                    border: '1px solid rgba(255, 255, 255, 0.1)'
                                  }}
                                >
                                  {tool.name}
                                </span>

                                <span
                                  style={{
                                    fontSize: '0.66rem',
                                    fontWeight: 700,
                                    padding: '0.12rem 0.45rem',
                                    borderRadius: '10px',
                                    background: badge.bg,
                                    color: badge.color
                                  }}
                                >
                                  {badge.label}
                                </span>

                                <span
                                  style={{
                                    fontSize: '0.66rem',
                                    fontWeight: 600,
                                    padding: '0.12rem 0.45rem',
                                    borderRadius: '10px',
                                    background: 'rgba(16, 185, 129, 0.12)',
                                    color: '#34d399'
                                  }}
                                >
                                  Global
                                </span>
                              </div>

                              <button
                                type="button"
                                className="btn btn-secondary"
                                onClick={() =>
                                  setExpandedToolIds((prev) => ({
                                    ...prev,
                                    [tool.name]: !prev[tool.name]
                                  }))
                                }
                                style={{
                                  padding: '0.2rem 0.55rem',
                                  fontSize: '0.7rem',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '0.35rem'
                                }}
                              >
                                <span>{propKeys.length} {propKeys.length === 1 ? 'param' : 'params'}</span>
                                {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                              </button>
                            </div>

                            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '0.35rem', lineHeight: 1.45 }}>
                              {tool.description}
                            </div>

                            {isExpanded && (
                              <div
                                style={{
                                  marginTop: '0.75rem',
                                  paddingTop: '0.65rem',
                                  borderTop: '1px solid rgba(255, 255, 255, 0.06)',
                                  display: 'flex',
                                  flexDirection: 'column',
                                  gap: '0.45rem'
                                }}
                              >
                                <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                  Parameters & Schema
                                </div>
                                {propKeys.length === 0 ? (
                                  <span style={{ fontSize: '0.74rem', color: 'var(--text-dim)', fontStyle: 'italic' }}>
                                    No required parameters.
                                  </span>
                                ) : (
                                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '0.45rem' }}>
                                    {propKeys.map((pk) => {
                                      const prop = schemaProps[pk] || {};
                                      const isReq = requiredFields.includes(pk);
                                      return (
                                        <div
                                          key={pk}
                                          style={{
                                            background: 'rgba(0, 0, 0, 0.25)',
                                            border: '1px solid rgba(255, 255, 255, 0.05)',
                                            borderRadius: '4px',
                                            padding: '0.4rem 0.6rem',
                                            fontSize: '0.72rem'
                                          }}
                                        >
                                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.2rem' }}>
                                            <code style={{ color: '#38bdf8', fontWeight: 700 }}>{pk}</code>
                                            <span style={{ color: 'var(--text-dim)', fontSize: '0.66rem' }}>
                                              ({prop.type || 'string'})
                                            </span>
                                            {isReq && (
                                              <span style={{ color: '#f87171', fontSize: '0.64rem', fontWeight: 700 }}>
                                                required
                                              </span>
                                            )}
                                          </div>
                                          <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem', lineHeight: 1.35 }}>
                                            {prop.description || 'No description.'}
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* ── SUB-VIEW B: GLOBAL RULES & SKILLS ── */}
                {skillsSubView === 'skills' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                    <div
                      style={{
                        background: 'rgba(255, 255, 255, 0.02)',
                        border: '1px solid var(--border-subtle)',
                        borderRadius: 'var(--radius-sm)',
                        padding: '0.75rem 1rem',
                        fontSize: '0.78rem',
                        color: 'var(--text-muted)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        flexWrap: 'wrap',
                        gap: '0.75rem'
                      }}
                    >
                      <span>
                        Skills guide the AI with specialized workflows, rules, and triggers. Active skills are automatically written to <code style={{ color: '#c084fc' }}>.agents/skills/</code> when work begins.
                      </span>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={handleOpenAddSkill}
                        style={{ fontSize: '0.74rem', padding: '0.3rem 0.65rem' }}
                      >
                        <Plus size={12} />
                        <span>Create New Skill</span>
                      </button>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                      {skills.map((skill) => {
                        const isExpanded = !!expandedSkillIds[skill.id];
                        return (
                          <div
                            key={skill.id}
                            style={{
                              background: '#15181e',
                              border: skill.enabled ? '1px solid rgba(168, 85, 247, 0.35)' : '1px solid rgba(255, 255, 255, 0.07)',
                              borderRadius: 'var(--radius-sm)',
                              padding: '0.85rem 1.15rem',
                              transition: 'all 0.15s ease'
                            }}
                          >
                            {/* Header row */}
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.65rem' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                                <Sparkles size={16} color={skill.enabled ? '#c084fc' : 'var(--text-dim)'} />
                                <span style={{ fontSize: '0.88rem', fontWeight: 700, color: '#f8fafc' }}>
                                  {skill.name}
                                </span>
                                <span
                                  style={{
                                    fontSize: '0.66rem',
                                    fontFamily: 'var(--font-mono, monospace)',
                                    color: 'var(--text-dim)',
                                    background: 'rgba(255, 255, 255, 0.04)',
                                    padding: '0.1rem 0.4rem',
                                    borderRadius: '4px'
                                  }}
                                >
                                  {skill.id}
                                </span>
                                {skill.isBuiltIn ? (
                                  <span style={{ fontSize: '0.65rem', fontWeight: 700, padding: '0.1rem 0.45rem', borderRadius: '10px', background: 'rgba(6, 182, 212, 0.15)', color: '#22d3ee' }}>
                                    Built-in
                                  </span>
                                ) : (
                                  <span style={{ fontSize: '0.65rem', fontWeight: 700, padding: '0.1rem 0.45rem', borderRadius: '10px', background: 'rgba(168, 85, 247, 0.15)', color: '#d8b4fe' }}>
                                    Custom
                                  </span>
                                )}
                              </div>

                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                                {/* Toggle switch */}
                                <button
                                  type="button"
                                  onClick={() => handleToggleSkill(skill.id)}
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '0.4rem',
                                    padding: '0.25rem 0.65rem',
                                    borderRadius: '16px',
                                    fontSize: '0.72rem',
                                    fontWeight: 600,
                                    cursor: 'pointer',
                                    border: '1px solid',
                                    background: skill.enabled ? 'rgba(16, 185, 129, 0.18)' : 'rgba(255, 255, 255, 0.04)',
                                    borderColor: skill.enabled ? 'rgba(16, 185, 129, 0.4)' : 'var(--border-subtle)',
                                    color: skill.enabled ? '#34d399' : 'var(--text-muted)'
                                  }}
                                >
                                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: skill.enabled ? '#10b981' : 'var(--text-dim)' }} />
                                  <span>{skill.enabled ? 'Active' : 'Disabled'}</span>
                                </button>

                                {!skill.isBuiltIn && (
                                  <>
                                    <button
                                      type="button"
                                      className="btn btn-secondary"
                                      onClick={() => handleOpenEditSkill(skill)}
                                      style={{ padding: '0.2rem 0.5rem', fontSize: '0.7rem' }}
                                      title="Edit custom skill"
                                    >
                                      <Edit3 size={11} />
                                      <span>Edit</span>
                                    </button>
                                    <button
                                      type="button"
                                      className="btn btn-secondary"
                                      onClick={() => handleDeleteCustomSkill(skill.id)}
                                      style={{ padding: '0.2rem 0.5rem', fontSize: '0.7rem', color: '#f87171' }}
                                      title="Delete custom skill"
                                    >
                                      <Trash2 size={11} />
                                      <span>Delete</span>
                                    </button>
                                  </>
                                )}

                                <button
                                  type="button"
                                  className="btn btn-secondary"
                                  onClick={() =>
                                    setExpandedSkillIds((prev) => ({
                                      ...prev,
                                      [skill.id]: !prev[skill.id]
                                    }))
                                  }
                                  style={{ padding: '0.2rem 0.5rem', fontSize: '0.7rem' }}
                                >
                                  <span>{isExpanded ? 'Hide Details' : 'View Instructions'}</span>
                                  {isExpanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                                </button>
                              </div>
                            </div>

                            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '0.45rem', lineHeight: 1.45 }}>
                              {skill.description}
                            </div>

                            {/* Trigger Keywords */}
                            {skill.triggerKeywords && skill.triggerKeywords.length > 0 && (
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
                                <span style={{ fontSize: '0.68rem', color: 'var(--text-dim)', fontWeight: 600 }}>Triggers:</span>
                                {skill.triggerKeywords.map((kw) => (
                                  <span
                                    key={kw}
                                    style={{
                                      fontSize: '0.68rem',
                                      padding: '0.1rem 0.45rem',
                                      borderRadius: '4px',
                                      background: 'rgba(168, 85, 247, 0.1)',
                                      color: '#d8b4fe',
                                      border: '1px solid rgba(168, 85, 247, 0.25)',
                                      fontFamily: 'var(--font-mono, monospace)'
                                    }}
                                  >
                                    #{kw}
                                  </span>
                                ))}
                              </div>
                            )}

                            {isExpanded && (
                              <div
                                style={{
                                  marginTop: '0.75rem',
                                  paddingTop: '0.75rem',
                                  borderTop: '1px solid rgba(255, 255, 255, 0.06)',
                                  display: 'flex',
                                  flexDirection: 'column',
                                  gap: '0.65rem'
                                }}
                              >
                                {skill.rules && (
                                  <div>
                                    <div style={{ fontSize: '0.7rem', fontWeight: 700, color: '#f59e0b', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.25rem' }}>
                                      Rules & Constraints
                                    </div>
                                    <div style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(245, 158, 11, 0.2)', borderRadius: '4px', padding: '0.5rem 0.75rem', fontSize: '0.74rem', color: '#fef3c7', lineHeight: 1.45 }}>
                                      {skill.rules}
                                    </div>
                                  </div>
                                )}

                                <div>
                                  <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.25rem' }}>
                                    Instructions & Workflow
                                  </div>
                                  <pre
                                    style={{
                                      background: 'rgba(0,0,0,0.35)',
                                      border: '1px solid rgba(255, 255, 255, 0.05)',
                                      borderRadius: '4px',
                                      padding: '0.65rem 0.75rem',
                                      fontSize: '0.72rem',
                                      color: '#e2e8f0',
                                      whiteSpace: 'pre-wrap',
                                      fontFamily: 'var(--font-mono, monospace)',
                                      margin: 0,
                                      lineHeight: 1.45
                                    }}
                                  >
                                    {skill.instructions}
                                  </pre>
                                </div>

                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', fontSize: '0.68rem', color: 'var(--text-dim)' }}>
                                  <FileCode size={12} />
                                  <span>Codebase file: <code>{skill.filePath || `.agents/skills/${skill.id.replace(/^skill-/, '')}/SKILL.md`}</code></span>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

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
                        Connect Other MCP
                      </h4>
                    </div>
                    {/* <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                      Non-technical? Just paste your MCP URL below and click Connect
                    </span> */}
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

      {/* Generic & Preset External Server Modal */}
      {selectedExternalModalServer && (() => {
        const guide = MCP_EXTERNAL_SETUP_GUIDES[selectedExternalModalServer.id];
        const isPreset = Boolean(guide);

        return (
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
                maxWidth: '580px',
                padding: '1.75rem',
                borderRadius: 'var(--radius-lg)',
                border: '1px solid rgba(255,255,255,0.14)',
                boxShadow: '0 25px 60px rgba(0,0,0,0.6)',
                maxHeight: '90vh',
                overflowY: 'auto'
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  {renderServerIcon(selectedExternalModalServer, false)}
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700, color: '#fff' }}>
                        Connect {selectedExternalModalServer.name}
                      </h3>
                      {isPreset && (
                        <span
                          style={{
                            fontSize: '0.68rem',
                            fontWeight: 600,
                            padding: '0.15rem 0.5rem',
                            borderRadius: '9999px',
                            background: 'rgba(56, 189, 248, 0.12)',
                            color: 'var(--accent-cyan)',
                            border: '1px solid rgba(56, 189, 248, 0.25)'
                          }}
                        >
                          MCP Bridge
                        </span>
                      )}
                    </div>
                    <p style={{ margin: '0.15rem 0 0', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                      {guide ? guide.description : 'Connect via a Model Context Protocol SSE or HTTP bridge endpoint.'}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedExternalModalServer(null)}
                  style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '0.25rem' }}
                >
                  <X size={18} />
                </button>
              </div>

              {/* Service Quick Setup Banner with Direct Link */}
              {guide && (
                <div
                  style={{
                    background: 'rgba(56, 189, 248, 0.07)',
                    border: '1px solid rgba(56, 189, 248, 0.22)',
                    borderRadius: 'var(--radius-md)',
                    padding: '0.85rem 1rem',
                    marginBottom: '1.25rem'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.75rem' }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.25rem' }}>
                        <Sparkles size={14} color="var(--accent-cyan)" />
                        <span style={{ fontWeight: 600, fontSize: '0.82rem', color: 'var(--accent-cyan)' }}>
                          {guide.title}
                        </span>
                      </div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.45 }}>
                        Need credentials or docs for {selectedExternalModalServer.name}? Open the setup guide or developer console.
                      </div>
                    </div>
                    <a
                      href={guide.docsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn btn-secondary"
                      style={{
                        fontSize: '0.75rem',
                        whiteSpace: 'nowrap',
                        gap: '0.35rem',
                        flexShrink: 0,
                        color: 'var(--accent-cyan)',
                        borderColor: 'rgba(56, 189, 248, 0.35)',
                        padding: '0.35rem 0.65rem'
                      }}
                    >
                      <ExternalLink size={13} />
                      <span>{guide.docsLabel}</span>
                    </a>
                  </div>

                  {guide.quickRunCommand && (
                    <div
                      style={{
                        marginTop: '0.65rem',
                        padding: '0.45rem 0.6rem',
                        background: 'rgba(0, 0, 0, 0.35)',
                        borderRadius: 'var(--radius-sm)',
                        border: '1px solid rgba(255, 255, 255, 0.08)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '0.5rem'
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', overflow: 'hidden' }}>
                        <span style={{ fontSize: '0.7rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Run Local:</span>
                        <code style={{ fontSize: '0.72rem', color: 'var(--accent-amber)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                          {guide.quickRunCommand}
                        </code>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard.writeText(guide.quickRunCommand || '');
                          setCopiedSnippet(true);
                          setTimeout(() => setCopiedSnippet(false), 2000);
                        }}
                        className="btn btn-secondary"
                        style={{ padding: '0.2rem 0.45rem', fontSize: '0.7rem', gap: '0.25rem', height: 'auto', flexShrink: 0 }}
                        title="Copy command"
                      >
                        {copiedSnippet ? <Check size={11} color="var(--accent-emerald)" /> : <Copy size={11} />}
                        <span>{copiedSnippet ? 'Copied' : 'Copy'}</span>
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Form */}
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!genericEndpointInput.trim()) {
                    setGenericAuthError('Endpoint URL is required');
                    return;
                  }
                  setIsGenericTesting(true);
                  setGenericAuthError(null);
                  try {
                    const disc = await discoverRemoteMcpTools(genericEndpointInput, genericTokenInput);
                    if (disc.success && onUpdateServer) {
                      const toolsToSet = disc.tools.length > 0
                        ? disc.tools.map((t) => ({ ...t, serverId: selectedExternalModalServer.id }))
                        : selectedExternalModalServer.tools;

                      onUpdateServer({
                        ...selectedExternalModalServer,
                        status: 'connected',
                        endpoint: genericEndpointInput.trim(),
                        authHeader: genericTokenInput.trim() || undefined,
                        tools: toolsToSet,
                        lastSyncedAt: new Date().toISOString(),
                        error: undefined
                      });
                      setSelectedExternalModalServer(null);
                    } else {
                      setGenericAuthError(disc.error || 'Failed to connect and discover tools at this endpoint. Ensure your MCP bridge server is running.');
                    }
                  } catch (err: any) {
                    setGenericAuthError(err?.message || 'Network error reaching MCP endpoint.');
                  } finally {
                    setIsGenericTesting(false);
                  }
                }}
              >
                {/* Endpoint Field */}
                <div style={{ marginBottom: '1.1rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.35rem' }}>
                    <label style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-muted)' }}>
                      MCP Server Endpoint URL <span style={{ color: 'var(--accent-rose)' }}>*</span>
                    </label>
                    {guide?.defaultEndpoint && (
                      <button
                        type="button"
                        onClick={() => {
                          setGenericEndpointInput(guide.defaultEndpoint || '');
                          setGenericAuthError(null);
                        }}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: 'var(--accent-cyan)',
                          fontSize: '0.72rem',
                          cursor: 'pointer',
                          padding: 0,
                          textDecoration: 'underline'
                        }}
                      >
                        Fill Recommended Default ({guide.defaultEndpoint})
                      </button>
                    )}
                  </div>
                  <input
                    type="text"
                    className="input-text"
                    placeholder={guide?.endpointPlaceholder || 'https://mcp.your-service.com/sse or http://localhost:3000/sse'}
                    value={genericEndpointInput}
                    onChange={(e) => {
                      setGenericEndpointInput(e.target.value);
                      setGenericAuthError(null);
                    }}
                    style={{ width: '100%', fontSize: '0.82rem', fontFamily: 'var(--font-mono)' }}
                  />
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '0.35rem' }}>
                    The Server-Sent Events (SSE) or HTTP stream exposed by your local or cloud MCP server.
                  </div>
                </div>

                {/* API Key / Bot Token Field */}
                <div style={{ marginBottom: '1.1rem' }}>
                  <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.35rem' }}>
                    {guide ? guide.tokenLabel : 'API Key / Bearer Token'}{' '}
                    <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>(optional)</span>
                  </label>
                  <div style={{ position: 'relative' }}>
                    <input
                      type={showGenericToken ? 'text' : 'password'}
                      className="input-text"
                      placeholder={guide?.tokenPlaceholder || 'Leave empty if not required'}
                      value={genericTokenInput}
                      onChange={(e) => setGenericTokenInput(e.target.value)}
                      style={{ width: '100%', fontSize: '0.82rem', fontFamily: 'var(--font-mono)', paddingRight: '2.5rem' }}
                    />
                    <button
                      type="button"
                      onClick={() => setShowGenericToken(!showGenericToken)}
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
                      {showGenericToken ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '0.35rem' }}>
                    {guide ? guide.tokenHelpText : 'Passed securely in the Authorization header. Kept local to your browser/workspace.'}
                  </div>
                </div>

                {/* Educational Accordion: "New to MCP? How does this work?" */}
                <div
                  style={{
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    borderRadius: 'var(--radius-md)',
                    background: 'rgba(255, 255, 255, 0.02)',
                    marginBottom: '1.25rem',
                    overflow: 'hidden'
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setIsMcpGuideExpanded(!isMcpGuideExpanded)}
                    style={{
                      width: '100%',
                      background: 'none',
                      border: 'none',
                      padding: '0.65rem 0.85rem',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      color: 'var(--text-muted)',
                      cursor: 'pointer',
                      fontSize: '0.76rem',
                      fontWeight: 600
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                      <HelpCircle size={14} color="var(--accent-cyan)" />
                      <span>New to MCP? How to connect {selectedExternalModalServer.name}</span>
                    </div>
                    {isMcpGuideExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </button>

                  {isMcpGuideExpanded && (
                    <div
                      style={{
                        padding: '0.75rem 0.85rem 0.95rem',
                        borderTop: '1px solid rgba(255, 255, 255, 0.06)',
                        background: 'rgba(0, 0, 0, 0.2)',
                        fontSize: '0.75rem',
                        lineHeight: 1.5,
                        color: 'var(--text-muted)'
                      }}
                    >
                      <div style={{ marginBottom: '0.6rem' }}>
                        <strong style={{ color: '#fff' }}>What is an MCP Server?</strong>
                        <p style={{ margin: '0.2rem 0 0.5rem', color: 'var(--text-dim)' }}>
                          MCP (Model Context Protocol) is an open standard that allows AI assistants like Ergo to safely talk to external tools (Google Calendar, Slack, Notion, databases) on your behalf.
                        </p>
                      </div>

                      {guide?.setupSteps && (
                        <div style={{ marginBottom: '0.6rem' }}>
                          <strong style={{ color: '#fff' }}>Step-by-Step Instructions:</strong>
                          <ol style={{ margin: '0.3rem 0 0.5rem', paddingLeft: '1.2rem', color: 'var(--text-muted)' }}>
                            {guide.setupSteps.map((step, idx) => (
                              <li key={idx} style={{ marginBottom: '0.25rem' }}>{step}</li>
                            ))}
                          </ol>
                        </div>
                      )}

                      <div style={{ background: 'rgba(56, 189, 248, 0.05)', borderRadius: 'var(--radius-sm)', padding: '0.5rem 0.7rem', border: '1px solid rgba(56, 189, 248, 0.15)' }}>
                        <span style={{ color: 'var(--accent-cyan)', fontWeight: 600 }}>💡 Tip for Non-Tech Users: </span>
                        If you are using tools like Zapier or a hosted bridge, you can simply paste the HTTPS webhook URL provided in their developer dashboard. No terminal commands needed.
                      </div>
                    </div>
                  )}
                </div>

                {genericAuthError && (
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
                    <span>{genericAuthError}</span>
                  </div>
                )}

                {/* Actions */}
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.65rem', marginTop: '1.25rem' }}>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setSelectedExternalModalServer(null)}
                    disabled={isGenericTesting}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={!genericEndpointInput.trim() || isGenericTesting}
                    style={{ gap: '0.4rem', minWidth: '150px', justifyContent: 'center' }}
                  >
                    {isGenericTesting ? (
                      <>
                        <RefreshCw size={13} className="animate-spin" />
                        <span>Connecting…</span>
                      </>
                    ) : (
                      <>
                        <Check size={14} />
                        <span>Connect & Discover</span>
                      </>
                    )}
                  </button>
                </div>
              </form>
            </div>
          </div>
        );
      })()}

      {/* ── CREATE / EDIT SKILL MODAL ── */}
      {isSkillModalOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.7)',
            backdropFilter: 'blur(3px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '1rem'
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setIsSkillModalOpen(false);
          }}
        >
          <div
            style={{
              background: '#12141a',
              border: '1px solid rgba(168, 85, 247, 0.35)',
              borderRadius: 'var(--radius-md)',
              width: '100%',
              maxWidth: '620px',
              padding: '1.25rem 1.5rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '1rem',
              boxShadow: '0 20px 45px rgba(0,0,0,0.6)'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Sparkles size={18} color="#c084fc" />
                <h3 style={{ fontSize: '1rem', fontWeight: 700, color: '#f3e8ff', margin: 0 }}>
                  {editingSkill ? `Edit Skill: ${editingSkill.name}` : 'Create Custom Workspace Skill'}
                </h3>
              </div>
              <button
                type="button"
                className="btn btn-secondary"
                style={{ padding: '0.25rem 0.5rem' }}
                onClick={() => setIsSkillModalOpen(false)}
              >
                <X size={15} />
              </button>
            </div>

            <form onSubmit={handleSaveSkillForm} style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.76rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
                  Skill Name *
                </label>
                <input
                  type="text"
                  className="input-text"
                  placeholder="e.g. Code Review & Verification"
                  value={skillFormData.name}
                  onChange={(e) => setSkillFormData((prev) => ({ ...prev, name: e.target.value }))}
                  required
                  style={{ width: '100%', fontSize: '0.82rem' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.76rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
                  Description *
                </label>
                <input
                  type="text"
                  className="input-text"
                  placeholder="e.g. Review code changes against project safety guidelines and run tests"
                  value={skillFormData.description}
                  onChange={(e) => setSkillFormData((prev) => ({ ...prev, description: e.target.value }))}
                  required
                  style={{ width: '100%', fontSize: '0.82rem' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.76rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
                  Rules & Constraints
                </label>
                <input
                  type="text"
                  className="input-text"
                  placeholder="e.g. Never delete user files without explicit human confirmation. Always check tests pass."
                  value={skillFormData.rules}
                  onChange={(e) => setSkillFormData((prev) => ({ ...prev, rules: e.target.value }))}
                  style={{ width: '100%', fontSize: '0.82rem' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.76rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
                  Workflow Instructions for AI *
                </label>
                <textarea
                  className="input-text"
                  placeholder={`1. Call workspace_list_swim_lanes() to inspect active columns.\n2. When tasks complete, call workspace_update_task({ taskId, status: 'done', isDone: true }).`}
                  value={skillFormData.instructions}
                  onChange={(e) => setSkillFormData((prev) => ({ ...prev, instructions: e.target.value }))}
                  required
                  rows={5}
                  style={{ width: '100%', fontSize: '0.78rem', fontFamily: 'var(--font-mono, monospace)', resize: 'vertical' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.76rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
                  Trigger Keywords (comma separated)
                </label>
                <input
                  type="text"
                  className="input-text"
                  placeholder="e.g. code review, verify, test run, safety check"
                  value={skillFormData.triggerKeywords}
                  onChange={(e) => setSkillFormData((prev) => ({ ...prev, triggerKeywords: e.target.value }))}
                  style={{ width: '100%', fontSize: '0.82rem' }}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.65rem', marginTop: '0.5rem' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setIsSkillModalOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  style={{ background: 'linear-gradient(135deg, #9333ea 0%, #7c3aed 100%)', borderColor: '#a855f7' }}
                >
                  {editingSkill ? 'Save Changes' : 'Create & Sync Skill'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
