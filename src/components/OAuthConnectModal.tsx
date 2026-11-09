import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  ExternalLink,
  Copy,
  Check,
  CheckCircle2,
  RefreshCw,
  AlertTriangle,
  Key,
  Shield,
  Lock,
  ArrowRight,
  Sparkles
} from 'lucide-react';
import {
  type MCPServer
} from '../types';
import {
  startGithubDeviceOAuth,
  pollGithubDeviceOAuth,
  connectGithubMcp,
  connectProviderOAuth,
  type DeviceFlowStartResult
} from '../lib/mcpClient';
import { GITHUB_MCP_TOOLS } from '../lib/githubMcpTools';

export interface OAuthConnectModalProps {
  isOpen: boolean;
  server: MCPServer | null;
  onClose: () => void;
  onConnected: (updatedServer: MCPServer) => void;
}

interface ProviderMeta {
  title: string;
  subtitle: string;
  scopes: { icon: string; label: string; desc: string }[];
  accentColor: string;
  docsUrl?: string;
  tokenLabel?: string;
  tokenPlaceholder?: string;
  tokenHelp?: string;
}

const PROVIDER_METADATA: Record<string, ProviderMeta> = {
  'mcp-github': {
    title: 'Connect GitHub',
    subtitle: 'Sign in to let AI agents search repositories, review pull requests, create issues, and manage commits.',
    accentColor: '#3b82f6',
    docsUrl: 'https://github.com/settings/tokens/new?scopes=repo,read:org,user&description=Ergo%20MCP',
    tokenLabel: 'Personal Access Token',
    tokenPlaceholder: 'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    tokenHelp: 'Classic token with repo, read:org, user scopes.',
    scopes: [
      { icon: '📦', label: 'Repositories', desc: 'Inspect source code, diffs, branches, and commit histories' },
      { icon: '🔀', label: 'Pull Requests & Issues', desc: 'Read PR reviews, triage tickets, and submit automated fixes' },
      { icon: '👤', label: 'User Identity', desc: 'Attribute commits and actions to your verified GitHub profile' }
    ]
  },
  'mcp-gcal': {
    title: 'Connect Google Calendar',
    subtitle: 'Connect your Google account to give agents visibility into meetings, milestones, and team schedules.',
    accentColor: '#4285f4',
    docsUrl: 'https://calendar.google.com',
    tokenLabel: 'Google OAuth Client Secret / Token',
    tokenPlaceholder: 'Optional: leave blank for 1-click account access',
    tokenHelp: 'Used for scheduled meeting sync and agent calendar booking.',
    scopes: [
      { icon: '📅', label: 'Calendar Events', desc: 'Query upcoming schedules, events, and milestones' },
      { icon: '⏰', label: 'Team Availability', desc: 'Check free/busy time slots for scheduling task deadlines' },
      { icon: '✉️', label: 'Event Creation', desc: 'Create milestone meetings with conference links' }
    ]
  },
  'mcp-slack': {
    title: 'Connect Slack Workspace',
    subtitle: 'Allow agents to broadcast progress digests, notify channels of completions, and draft messages.',
    accentColor: '#4a154b',
    docsUrl: 'https://api.slack.com/apps',
    tokenLabel: 'Bot User OAuth Token (xoxb-...)',
    tokenPlaceholder: 'xoxb-xxxxxxxxxxxx-xxxxxxxxxxxx-xxxxxxxxxxxxxxxx',
    tokenHelp: 'From your Slack App under OAuth & Permissions (channels:read, chat:write).',
    scopes: [
      { icon: '💬', label: 'Send Messages', desc: 'Post status announcements and alerts to designated project channels' },
      { icon: '📢', label: 'Channel Listing', desc: 'Discover accessible public channels for status digests' },
      { icon: '📝', label: 'Draft Composers', desc: 'Render message preview cards before sending' }
    ]
  },
  'mcp-notion': {
    title: 'Connect Notion Workspace',
    subtitle: 'Index documentation briefs, sync database tables, and append requirements directly into Notion pages.',
    accentColor: '#000000',
    docsUrl: 'https://www.notion.so/my-integrations',
    tokenLabel: 'Internal Integration Secret',
    tokenPlaceholder: 'ntn_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    tokenHelp: 'Created at notion.so/my-integrations with Read & Write content access.',
    scopes: [
      { icon: '📄', label: 'Page Reading', desc: 'Query documentation, specifications, and architecture notes' },
      { icon: '🗄️', label: 'Databases', desc: 'Read and sync tasks in project tracker databases' },
      { icon: '✏️', label: 'Append Content', desc: 'Export agent summaries and plans directly into Notion' }
    ]
  },
  'mcp-salesforce': {
    title: 'Connect Salesforce CRM',
    subtitle: 'Query CRM accounts, sync deals, and update pipeline stages using Model Context Protocol.',
    accentColor: '#00a1e0',
    docsUrl: 'https://help.salesforce.com',
    tokenLabel: 'Access Token / Connected App Key',
    tokenPlaceholder: 'Paste Salesforce OAuth token or Connected App secret',
    tokenHelp: 'Obtain from your Salesforce Connected App with API permissions.',
    scopes: [
      { icon: '🏢', label: 'Accounts & Leads', desc: 'Run SOQL queries to view pipeline records' },
      { icon: '💼', label: 'Opportunities', desc: 'Update deal stages and close dates' }
    ]
  }
};

export const OAuthConnectModal: React.FC<OAuthConnectModalProps> = ({
  isOpen,
  server,
  onClose,
  onConnected
}) => {
  const [activeTab, setActiveTab] = useState<'oauth' | 'token'>('oauth');
  const [copiedCode, setCopiedCode] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isPolling, setIsPolling] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // GitHub Device flow state
  const [deviceData, setDeviceData] = useState<DeviceFlowStartResult | null>(null);
  const [authSuccessUser, setAuthSuccessUser] = useState<{
    login: string;
    name?: string;
    avatarUrl?: string;
  } | null>(null);

  // Manual Token / PAT state
  const [manualToken, setManualToken] = useState('');
  const [isTestingToken, setIsTestingToken] = useState(false);

  // Direct 1-Click state for Google / Slack / Notion
  const [accountEmailInput, setAccountEmailInput] = useState('');
  const [isSubmittingDirect, setIsSubmittingDirect] = useState(false);

  const pollTimerRef = useRef<any>(null);

  useEffect(() => {
    if (!isOpen) {
      // Reset state on close
      setDeviceData(null);
      setAuthSuccessUser(null);
      setErrorMsg(null);
      setIsStarting(false);
      setIsPolling(false);
      setManualToken('');
      setAccountEmailInput('');
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    } else {
      setActiveTab('oauth');
      setErrorMsg(null);
    }
  }, [isOpen, server?.id]);

  useEffect(() => {
    return () => {
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
      }
    };
  }, []);

  if (!isOpen || !server) return null;

  const isGitHub = server.id === 'mcp-github';
  const meta: ProviderMeta = PROVIDER_METADATA[server.id] || {
    title: `Connect ${server.name}`,
    subtitle: server.description || 'Connect your account to allow AI agents access to these tools.',
    accentColor: '#3b82f6',
    scopes: [
      { icon: '⚡', label: 'Tools Access', desc: 'Execute tools provided by this server with your approval' }
    ]
  };

  // 1. Start GitHub Device OAuth Flow
  const handleStartGithubOAuth = async () => {
    setIsStarting(true);
    setErrorMsg(null);
    try {
      const res = await startGithubDeviceOAuth();
      if (!res.success || !res.deviceCode || !res.userCode) {
        setErrorMsg(res.error || 'Failed to initiate GitHub authorization.');
        setIsStarting(false);
        return;
      }

      setDeviceData(res);
      setIsStarting(false);

      // Automatically copy code to clipboard
      try {
        await navigator.clipboard.writeText(res.userCode);
        setCopiedCode(true);
        setTimeout(() => setCopiedCode(false), 3000);
      } catch {}

      // Automatically launch GitHub verification page in a new window/tab
      const targetUrl = res.verificationUriComplete || res.verificationUri || 'https://github.com/login/device';
      window.open(targetUrl, '_blank', 'noopener,noreferrer');

      // Start polling
      startPollingGithub(res.deviceCode, res.interval || 5);
    } catch (err: any) {
      setErrorMsg(err.message || 'Error starting GitHub sign in');
      setIsStarting(false);
    }
  };

  // 2. Poll for GitHub authorization
  const startPollingGithub = (deviceCode: string, intervalSeconds: number) => {
    setIsPolling(true);

    const poll = async () => {
      try {
        const pollRes = await pollGithubDeviceOAuth(deviceCode);

        if (pollRes.status === 'completed' && pollRes.user) {
          // Success!
          setIsPolling(false);
          setAuthSuccessUser(pollRes.user);

          const toolsToUse = pollRes.tools && pollRes.tools.length > 0 ? pollRes.tools : GITHUB_MCP_TOOLS;
          const updated: MCPServer = {
            ...server,
            status: 'connected',
            authUsername: pollRes.user.login,
            authAvatarUrl: pollRes.user.avatarUrl,
            authEmail: pollRes.user.email,
            tools: toolsToUse.map((t) => ({ ...t, serverId: 'mcp-github' })),
            lastSyncedAt: new Date().toISOString(),
            error: undefined
          };

          onConnected(updated);

          // Close modal automatically after brief success celebration
          setTimeout(() => {
            onClose();
          }, 1800);
          return;
        }

        if (pollRes.status === 'pending' || pollRes.status === 'slow_down') {
          const nextInterval = (pollRes.interval || intervalSeconds) * 1000;
          pollTimerRef.current = setTimeout(poll, nextInterval);
          return;
        }

        if (!pollRes.success) {
          setIsPolling(false);
          setErrorMsg(pollRes.error || 'Authorization timed out or was rejected.');
          return;
        }
      } catch (err: any) {
        setIsPolling(false);
        setErrorMsg(err.message || 'Connection lost while waiting for authorization.');
      }
    };

    pollTimerRef.current = setTimeout(poll, (intervalSeconds || 5) * 1000);
  };

  // 3. Connect via Manual Personal Access Token (for GitHub or generic providers)
  const handleConnectToken = async (e: React.FormEvent) => {
    e.preventDefault();
    const token = manualToken.trim();
    if (!token) {
      setErrorMsg('Please enter a valid authentication token.');
      return;
    }

    setIsTestingToken(true);
    setErrorMsg(null);

    try {
      if (isGitHub) {
        const res = await connectGithubMcp(token);
        if (!res.success) {
          setErrorMsg(res.error || 'Failed to authenticate token with GitHub.');
          setIsTestingToken(false);
          return;
        }

        const toolsToUse = res.tools && res.tools.length > 0 ? res.tools : GITHUB_MCP_TOOLS;
        const updated: MCPServer = {
          ...server,
          status: 'connected',
          authUsername: res.user?.login,
          authAvatarUrl: res.user?.avatarUrl,
          authHeader: token,
          tools: toolsToUse.map((t) => ({ ...t, serverId: 'mcp-github' })),
          lastSyncedAt: new Date().toISOString(),
          error: undefined
        };

        onConnected(updated);
        onClose();
      } else {
        const res = await connectProviderOAuth(server.id, { token });
        if (!res.success) {
          setErrorMsg(res.error || `Failed to authenticate ${server.name}.`);
          setIsTestingToken(false);
          return;
        }

        const updated: MCPServer = {
          ...server,
          status: 'connected',
          authUsername: res.user?.username || 'Connected',
          authAvatarUrl: res.user?.avatarUrl,
          authHeader: token,
          lastSyncedAt: new Date().toISOString(),
          error: undefined
        };

        onConnected(updated);
        onClose();
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Error authenticating credentials');
    } finally {
      setIsTestingToken(false);
    }
  };

  // 4. 1-Click Connect for Google, Slack, Notion
  const handleDirectConnectProvider = async () => {
    setIsSubmittingDirect(true);
    setErrorMsg(null);
    try {
      const email = accountEmailInput.trim() || undefined;
      const res = await connectProviderOAuth(server.id, {
        username: email || `${server.name} User`,
        email,
        authType: 'oauth_direct'
      });

      if (!res.success) {
        setErrorMsg(res.error || `Failed to connect ${server.name}.`);
        setIsSubmittingDirect(false);
        return;
      }

      const updated: MCPServer = {
        ...server,
        status: 'connected',
        authUsername: res.user?.username || email || 'Connected',
        authAvatarUrl: res.user?.avatarUrl,
        lastSyncedAt: new Date().toISOString(),
        error: undefined
      };

      onConnected(updated);
      onClose();
    } catch (err: any) {
      setErrorMsg(err.message || 'Error connecting account');
    } finally {
      setIsSubmittingDirect(false);
    }
  };

  return (
    <div
      className="modal-overlay"
      style={{
        zIndex: 1200,
        backgroundColor: 'rgba(0, 0, 0, 0.7)',
        backdropFilter: 'blur(4px)',
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem'
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !isPolling && !isStarting && !isTestingToken) {
          onClose();
        }
      }}
    >
      <div
        className="modal-content"
        style={{
          width: '100%',
          maxWidth: '520px',
          background: 'var(--bg-pane, #1a1d25)',
          border: '1px solid var(--border-subtle, #27272a)',
          borderRadius: '12px',
          boxShadow: '0 20px 40px rgba(0, 0, 0, 0.5)',
          padding: 0,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header with Provider Branding */}
        <div
          style={{
            padding: '1.25rem 1.5rem',
            borderBottom: '1px solid var(--border-subtle, #27272a)',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            background: 'var(--bg-canvas, #12141a)'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem' }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 10,
                background: 'var(--card-bg, #181b22)',
                border: '1px solid var(--border-subtle, #27272a)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0
              }}
            >
              {server.iconUrl ? (
                <img
                  src={server.iconUrl}
                  alt={server.name}
                  style={{ width: 26, height: 26, objectFit: 'contain' }}
                />
              ) : (
                <Shield size={22} color="var(--accent-cyan, #06b6d4)" />
              )}
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                <h3
                  style={{
                    margin: 0,
                    fontSize: '1.05rem',
                    fontWeight: 600,
                    color: 'var(--text-bright, #fafafa)',
                    fontFamily: "'Space Grotesk', sans-serif"
                  }}
                >
                  {meta.title}
                </h3>
                <span
                  style={{
                    fontSize: '0.65rem',
                    fontWeight: 600,
                    padding: '1px 6px',
                    borderRadius: '9999px',
                    background: 'rgba(6, 182, 212, 0.12)',
                    color: 'var(--accent-cyan, #06b6d4)',
                    border: '1px solid rgba(6, 182, 212, 0.25)'
                  }}
                >
                  OAuth Direct
                </span>
              </div>
              <p
                style={{
                  margin: '0.2rem 0 0',
                  fontSize: '0.78rem',
                  color: 'var(--text-muted, #71717a)',
                  lineHeight: 1.4
                }}
              >
                {meta.subtitle}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            disabled={isPolling}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-muted, #71717a)',
              cursor: isPolling ? 'not-allowed' : 'pointer',
              padding: '0.25rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '6px',
              transition: 'color 0.15s ease'
            }}
            aria-label="Close dialog"
          >
            <X size={18} />
          </button>
        </div>

        {/* Tab Selection (1-Click OAuth vs Manual Token) */}
        <div
          style={{
            display: 'flex',
            background: 'var(--bg-canvas, #12141a)',
            padding: '0.35rem 1.5rem 0',
            borderBottom: '1px solid var(--border-subtle, #27272a)',
            gap: '1rem'
          }}
        >
          <button
            type="button"
            onClick={() => {
              if (!isPolling) setActiveTab('oauth');
            }}
            style={{
              background: 'none',
              border: 'none',
              padding: '0.5rem 0.2rem',
              fontSize: '0.8rem',
              fontWeight: 600,
              color: activeTab === 'oauth' ? 'var(--text-bright, #fafafa)' : 'var(--text-muted, #71717a)',
              borderBottom: activeTab === 'oauth' ? '2px solid var(--accent, #00d492)' : '2px solid transparent',
              cursor: isPolling ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              transition: 'all 0.15s ease'
            }}
          >
            <Sparkles size={14} color={activeTab === 'oauth' ? 'var(--accent, #00d492)' : 'currentColor'} />
            <span>1-Click Sign In (Recommended)</span>
          </button>

          <button
            type="button"
            onClick={() => {
              if (!isPolling) setActiveTab('token');
            }}
            style={{
              background: 'none',
              border: 'none',
              padding: '0.5rem 0.2rem',
              fontSize: '0.8rem',
              fontWeight: 500,
              color: activeTab === 'token' ? 'var(--text-bright, #fafafa)' : 'var(--text-muted, #71717a)',
              borderBottom: activeTab === 'token' ? '2px solid var(--accent-cyan, #06b6d4)' : '2px solid transparent',
              cursor: isPolling ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              transition: 'all 0.15s ease'
            }}
          >
            <Key size={14} />
            <span>Manual Token (Advanced)</span>
          </button>
        </div>

        {/* Modal Body */}
        <div style={{ padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {/* Error Banner */}
          {errorMsg && (
            <div
              style={{
                background: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                borderRadius: '8px',
                padding: '0.65rem 0.85rem',
                color: 'var(--danger, #ef4444)',
                fontSize: '0.78rem',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem'
              }}
            >
              <AlertTriangle size={15} style={{ flexShrink: 0 }} />
              <span style={{ lineHeight: 1.4 }}>{errorMsg}</span>
            </div>
          )}

          {/* TAB 1: 1-CLICK OAUTH SIGN IN */}
          {activeTab === 'oauth' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              {/* Permission Badges in plain English */}
              <div
                style={{
                  background: 'var(--card-bg, #181b22)',
                  border: '1px solid var(--border-subtle, #27272a)',
                  borderRadius: '8px',
                  padding: '0.85rem 1rem'
                }}
              >
                <div
                  style={{
                    fontSize: '0.72rem',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    color: 'var(--text-muted, #71717a)',
                    marginBottom: '0.65rem'
                  }}
                >
                  Permissions Granted To Your Agents
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
                  {meta.scopes.map((scope, idx) => (
                    <div key={idx} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.55rem' }}>
                      <span style={{ fontSize: '0.9rem', lineHeight: 1 }}>{scope.icon}</span>
                      <div style={{ fontSize: '0.76rem', lineHeight: 1.35 }}>
                        <strong style={{ color: 'var(--text-main, #e4e4e7)', marginRight: '0.35rem' }}>
                          {scope.label}:
                        </strong>
                        <span style={{ color: 'var(--text-muted, #71717a)' }}>{scope.desc}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* GITHUB FLOW */}
              {isGitHub && (
                <>
                  {!deviceData && !authSuccessUser && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem', alignItems: 'center' }}>
                      <button
                        type="button"
                        onClick={handleStartGithubOAuth}
                        disabled={isStarting}
                        style={{
                          width: '100%',
                          height: '42px',
                          borderRadius: '8px',
                          background: '#238636',
                          border: '1px solid rgba(255, 255, 255, 0.15)',
                          color: '#ffffff',
                          fontSize: '0.88rem',
                          fontWeight: 600,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: '0.6rem',
                          cursor: isStarting ? 'not-allowed' : 'pointer',
                          boxShadow: '0 4px 12px rgba(35, 134, 54, 0.3)',
                          transition: 'all 0.15s ease'
                        }}
                      >
                        {isStarting ? (
                          <>
                            <RefreshCw size={16} className="animate-spin" />
                            <span>Connecting to GitHub…</span>
                          </>
                        ) : (
                          <>
                            <img src="/icons/github.svg" alt="" style={{ width: 18, height: 18, filter: 'invert(1)' }} />
                            <span>Continue with GitHub</span>
                            <ArrowRight size={16} />
                          </>
                        )}
                      </button>

                      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted, #71717a)', textAlign: 'center' }}>
                        Opens GitHub in your default browser. No copy-pasting API keys or tokens required.
                      </div>
                    </div>
                  )}

                  {/* ACTIVE CODE / POLLING STATE */}
                  {deviceData && !authSuccessUser && (
                    <div
                      style={{
                        background: 'var(--card-bg, #181b22)',
                        border: '1px solid rgba(0, 212, 146, 0.3)',
                        borderRadius: '10px',
                        padding: '1.25rem',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: '1rem',
                        textAlign: 'center'
                      }}
                    >
                      <div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted, #71717a)', marginBottom: '0.35rem' }}>
                          Enter this one-time code on GitHub:
                        </div>
                        <div
                          style={{
                            fontFamily: "'JetBrains Mono', monospace",
                            fontSize: '1.6rem',
                            fontWeight: 700,
                            letterSpacing: '0.12em',
                            color: 'var(--accent, #00d492)',
                            background: 'var(--bg-canvas, #12141a)',
                            padding: '0.5rem 1.25rem',
                            borderRadius: '8px',
                            border: '1px dashed rgba(0, 212, 146, 0.4)',
                            display: 'inline-block'
                          }}
                        >
                          {deviceData.userCode}
                        </div>
                      </div>

                      <div style={{ display: 'flex', gap: '0.5rem', width: '100%' }}>
                        <button
                          type="button"
                          onClick={() => {
                            if (deviceData.userCode) {
                              navigator.clipboard.writeText(deviceData.userCode);
                              setCopiedCode(true);
                              setTimeout(() => setCopiedCode(false), 2500);
                            }
                            const target = deviceData.verificationUriComplete || deviceData.verificationUri || 'https://github.com/login/device';
                            window.open(target, '_blank', 'noopener,noreferrer');
                          }}
                          style={{
                            flex: 1,
                            height: '36px',
                            borderRadius: '6px',
                            background: '#238636',
                            border: '1px solid rgba(255, 255, 255, 0.2)',
                            color: '#ffffff',
                            fontSize: '0.8rem',
                            fontWeight: 600,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '0.45rem',
                            cursor: 'pointer'
                          }}
                        >
                          {copiedCode ? <Check size={14} /> : <Copy size={14} />}
                          <span>{copiedCode ? 'Copied! Opening GitHub ↗' : 'Copy Code & Open GitHub ↗'}</span>
                        </button>
                      </div>

                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.5rem',
                          fontSize: '0.74rem',
                          color: 'var(--accent-cyan, #06b6d4)'
                        }}
                      >
                        <RefreshCw size={13} className="animate-spin" />
                        <span>Waiting for your authorization in the browser…</span>
                      </div>
                    </div>
                  )}

                  {/* SUCCESS STATE */}
                  {authSuccessUser && (
                    <div
                      style={{
                        background: 'rgba(0, 212, 146, 0.1)',
                        border: '1px solid var(--accent, #00d492)',
                        borderRadius: '10px',
                        padding: '1.25rem',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: '0.75rem',
                        textAlign: 'center'
                      }}
                    >
                      <div
                        style={{
                          width: 48,
                          height: 48,
                          borderRadius: '50%',
                          background: 'rgba(0, 212, 146, 0.2)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center'
                        }}
                      >
                        <CheckCircle2 size={28} color="var(--accent, #00d492)" />
                      </div>
                      <div>
                        <div style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-bright, #fafafa)' }}>
                          Connected to GitHub!
                        </div>
                        <div style={{ fontSize: '0.78rem', color: 'var(--text-muted, #71717a)', marginTop: '0.2rem' }}>
                          Logged in as <strong style={{ color: 'var(--accent, #00d492)' }}>@{authSuccessUser.login}</strong>
                        </div>
                      </div>
                      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted, #71717a)' }}>
                        26 official GitHub tools activated and ready for AI agents.
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* NON-GITHUB DIRECT PROVIDERS (Google, Slack, Notion) */}
              {!isGitHub && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
                  <div>
                    <label
                      style={{
                        display: 'block',
                        fontSize: '0.76rem',
                        fontWeight: 600,
                        color: 'var(--text-muted, #71717a)',
                        marginBottom: '0.35rem'
                      }}
                    >
                      Account Email or Workspace Name <span style={{ color: 'var(--text-dim, #52525b)', fontWeight: 400 }}>(optional)</span>
                    </label>
                    <input
                      type="text"
                      placeholder={`e.g. user@${server.id === 'mcp-gcal' ? 'gmail.com' : 'company.com'}`}
                      value={accountEmailInput}
                      onChange={(e) => setAccountEmailInput(e.target.value)}
                      style={{
                        width: '100%',
                        height: '36px',
                        padding: '0 0.75rem',
                        borderRadius: '6px',
                        background: 'var(--bg-canvas, #12141a)',
                        border: '1px solid var(--border-subtle, #27272a)',
                        color: 'var(--text-bright, #fafafa)',
                        fontSize: '0.82rem'
                      }}
                    />
                  </div>

                  <button
                    type="button"
                    onClick={handleDirectConnectProvider}
                    disabled={isSubmittingDirect}
                    style={{
                      width: '100%',
                      height: '40px',
                      borderRadius: '8px',
                      background: 'var(--accent-primary, #2563eb)',
                      border: '1px solid rgba(255, 255, 255, 0.15)',
                      color: '#ffffff',
                      fontSize: '0.85rem',
                      fontWeight: 600,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '0.5rem',
                      cursor: isSubmittingDirect ? 'not-allowed' : 'pointer'
                    }}
                  >
                    {isSubmittingDirect ? (
                      <>
                        <RefreshCw size={15} className="animate-spin" />
                        <span>Connecting…</span>
                      </>
                    ) : (
                      <>
                        <Check size={16} />
                        <span>Sign In & Activate {server.name}</span>
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* TAB 2: MANUAL PERSONAL ACCESS TOKEN */}
          {activeTab === 'token' && (
            <form onSubmit={handleConnectToken} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {meta.docsUrl && (
                <div
                  style={{
                    background: 'var(--card-bg, #181b22)',
                    border: '1px solid var(--border-subtle, #27272a)',
                    borderRadius: '8px',
                    padding: '0.75rem 0.85rem',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '0.75rem'
                  }}
                >
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted, #71717a)' }}>
                    Need to generate a token with appropriate permissions?
                  </div>
                  <a
                    href={meta.docsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      fontSize: '0.74rem',
                      color: 'var(--accent-cyan, #06b6d4)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.3rem',
                      textDecoration: 'none',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    <span>Generate Token</span>
                    <ExternalLink size={12} />
                  </a>
                </div>
              )}

              <div>
                <label
                  style={{
                    display: 'block',
                    fontSize: '0.76rem',
                    fontWeight: 600,
                    color: 'var(--text-muted, #71717a)',
                    marginBottom: '0.35rem'
                  }}
                >
                  {meta.tokenLabel || 'API Token'} <span style={{ color: 'var(--danger, #ef4444)' }}>*</span>
                </label>
                <input
                  type="password"
                  placeholder={meta.tokenPlaceholder || 'Paste secret token'}
                  value={manualToken}
                  onChange={(e) => setManualToken(e.target.value)}
                  disabled={isTestingToken}
                  autoFocus
                  style={{
                    width: '100%',
                    height: '36px',
                    padding: '0 0.75rem',
                    borderRadius: '6px',
                    background: 'var(--bg-canvas, #12141a)',
                    border: '1px solid var(--border-subtle, #27272a)',
                    color: 'var(--text-bright, #fafafa)',
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: '0.8rem'
                  }}
                />
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted, #71717a)', marginTop: '0.35rem' }}>
                  {meta.tokenHelp || 'Stored encrypted in your local config/secrets.json file.'}
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
                <button
                  type="button"
                  onClick={onClose}
                  style={{
                    height: '32px',
                    padding: '0 0.85rem',
                    borderRadius: '6px',
                    background: 'transparent',
                    border: '1px solid var(--border-subtle, #27272a)',
                    color: 'var(--text-main, #e4e4e7)',
                    fontSize: '0.78rem',
                    cursor: 'pointer'
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!manualToken.trim() || isTestingToken}
                  style={{
                    height: '32px',
                    padding: '0 1rem',
                    borderRadius: '6px',
                    background: 'var(--accent-primary, #2563eb)',
                    border: '1px solid rgba(255, 255, 255, 0.15)',
                    color: '#ffffff',
                    fontSize: '0.78rem',
                    fontWeight: 600,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.35rem',
                    cursor: !manualToken.trim() || isTestingToken ? 'not-allowed' : 'pointer'
                  }}
                >
                  {isTestingToken ? (
                    <>
                      <RefreshCw size={13} className="animate-spin" />
                      <span>Verifying…</span>
                    </>
                  ) : (
                    <>
                      <Check size={14} />
                      <span>Connect with Token</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          )}
        </div>

        {/* Footer info note */}
        <div
          style={{
            padding: '0.75rem 1.5rem',
            borderTop: '1px solid var(--border-subtle, #27272a)',
            background: 'var(--bg-canvas, #12141a)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: '0.72rem',
            color: 'var(--text-muted, #71717a)'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <Lock size={12} color="var(--accent-cyan, #06b6d4)" />
            <span>Tokens are saved locally on your device and never sent to Ergo cloud.</span>
          </div>
        </div>
      </div>
    </div>
  );
};
