import React, { useState, useEffect, useRef } from 'react';
import { type AIProviderId, type UserApiKey } from '../types';
import {
  fetchCliAuthStatus,
  installCli,
  triggerCliLogin,
  testAiConnection,
  type CliAuthStatus
} from '../lib/aiProviders';
import { AgentTerminal } from './AgentTerminal';
import {
  Sparkles,
  Zap,
  Key,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ExternalLink,
  ArrowRight,
  Terminal,
  ShieldCheck,
  Check,
  Copy,
  ChevronRight,
  X,
  RefreshCw
} from 'lucide-react';

interface OnboardingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaveUserKey: (key: Omit<UserApiKey, 'id'> & { id?: string }) => void;
  onCompleteOnboarding: (key?: UserApiKey) => void;
}

export type ProviderChoice = 'claude' | 'codex' | 'gemini';

interface ProviderMeta {
  id: ProviderChoice;
  name: string;
  badge: string;
  icon: string;
  color: string;
  cli: string;
  cliName: string;
  packageName: string;
  installCommand: string;
  loginCommand: string;
  loginArgs: string[];
  signInLabel: string;
  description: string;
  accountHelp: string;
  keyDocUrl: string;
}

const PROVIDER_METAS: Record<ProviderChoice, ProviderMeta> = {
  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    badge: 'Google One AI / Pro / Ultra',
    icon: '✨',
    color: '#3b82f6',
    cli: 'gemini',
    cliName: 'Gemini CLI',
    packageName: '@google/gemini-cli',
    installCommand: 'npm install -g @google/gemini-cli',
    loginCommand: 'gemini',
    loginArgs: ['--login'],
    signInLabel: 'Sign In with Google Account',
    description: 'Google One AI Premium, Gemini Advanced, or Google Account.',
    accountHelp: 'Authenticates with your Google Account in browser or instant Google AI Studio key.',
    keyDocUrl: 'https://aistudio.google.com/app/apikey'
  },
  claude: {
    id: 'claude',
    name: 'Anthropic Claude',
    badge: 'Pro / Team / Max',
    icon: '🧠',
    color: '#D97757',
    cli: 'claude',
    cliName: 'Claude Code',
    packageName: '@anthropic-ai/claude-code',
    installCommand: 'npm install -g @anthropic-ai/claude-code',
    loginCommand: 'claude login',
    loginArgs: ['login'],
    signInLabel: 'Sign In with Anthropic',
    description: 'Anthropic Claude Pro, Team, or Enterprise subscription.',
    accountHelp: 'Authenticates with your Claude Pro/Team account in browser.',
    keyDocUrl: 'https://console.anthropic.com/settings/keys'
  },
  codex: {
    id: 'codex',
    name: 'ChatGPT Codex',
    badge: 'Plus / Team / Pro',
    icon: '🤖',
    color: '#10a37f',
    cli: 'codex',
    cliName: 'OpenAI Codex CLI',
    packageName: '@openai/codex',
    installCommand: 'npm install -g @openai/codex',
    loginCommand: 'codex login',
    loginArgs: ['login'],
    signInLabel: 'Sign In with OpenAI',
    description: 'OpenAI ChatGPT Plus, Team, or Pro subscription.',
    accountHelp: 'Authenticates with your OpenAI account in browser.',
    keyDocUrl: 'https://platform.openai.com/api-keys'
  }
};

export const OnboardingModal: React.FC<OnboardingModalProps> = ({
  isOpen,
  onClose,
  onSaveUserKey,
  onCompleteOnboarding
}) => {
  const [activeTab, setActiveTab] = useState<'subscription' | 'apikey'>('subscription');
  const [selectedProvider, setSelectedProvider] = useState<ProviderChoice>('gemini');

  // Subscription Auth State
  const [authStatus, setAuthStatus] = useState<CliAuthStatus | null>(null);
  const [isCheckingAuth, setIsCheckingAuth] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [showTerminal, setShowTerminal] = useState(false);
  const [loginAuthUrl, setLoginAuthUrl] = useState<string | null>(null);
  const [authSuccess, setAuthSuccess] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState(false);

  // Google Instant Connect State (Zero Terminal path)
  const [googleKeyInput, setGoogleKeyInput] = useState('');
  const [isConnectingGoogleKey, setIsConnectingGoogleKey] = useState(false);
  const [googleKeyError, setGoogleKeyError] = useState<string | null>(null);

  // API Key Tab State
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [apiKeyProvider, setApiKeyProvider] = useState<AIProviderId>('gemini');
  const [apiKeyProfileName, setApiKeyProfileName] = useState('');
  const [isValidatingKey, setIsValidatingKey] = useState(false);
  const [keyValidationError, setKeyValidationError] = useState<string | null>(null);

  const pollingRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentMeta = PROVIDER_METAS[selectedProvider];

  const checkStatus = async (cliName: string) => {
    setIsCheckingAuth(true);
    try {
      const status = await fetchCliAuthStatus(cliName);
      setAuthStatus(status);
      if (status.isAuthenticated) {
        setAuthSuccess(true);
        setLoginError(null);
        setInstallError(null);
      }
    } catch {
      // Ignored
    } finally {
      setIsCheckingAuth(false);
    }
  };

  // Check auth status on mount and when provider changes
  useEffect(() => {
    if (isOpen && activeTab === 'subscription') {
      setLoginError(null);
      setInstallError(null);
      checkStatus(currentMeta.cli);
    }
  }, [isOpen, activeTab, selectedProvider]);

  // Clean up polling
  useEffect(() => {
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, []);

  if (!isOpen) return null;

  // Handle 1-click Install
  const handleInstallCli = async () => {
    setIsInstalling(true);
    setInstallError(null);
    setLoginError(null);

    try {
      const res = await installCli(currentMeta.cli);
      if (res.success) {
        const refreshed = await fetchCliAuthStatus(currentMeta.cli);
        setAuthStatus(refreshed);
        if (refreshed.isInstalled) {
          // Immediately initiate sign in
          await handleStartSignIn();
        } else {
          setInstallError(
            `Installed ${currentMeta.packageName}, but '${currentMeta.cli}' was not found in system PATH. If you have a Google account, you can connect instantly below with your Google AI Studio key without needing terminal installation.`
          );
        }
      } else {
        setInstallError(
          res.error ||
            `Failed to install ${currentMeta.packageName}. You can connect your account instantly with a free Google AI Studio key below, or run '${currentMeta.installCommand}' in your shell.`
        );
      }
    } catch (err: any) {
      setInstallError(err.message || 'Installation encountered an unexpected network or execution error.');
    } finally {
      setIsInstalling(false);
    }
  };

  // Handle Sign In with Subscription
  const handleStartSignIn = async () => {
    setIsLoggingIn(true);
    setLoginAuthUrl(null);
    setLoginError(null);

    try {
      const res = await triggerCliLogin(currentMeta.cli);
      if (!res.success || res.error) {
        setLoginError(
          res.error || `Could not start sign-in with ${currentMeta.name}. Please ensure ${currentMeta.cliName} is installed.`
        );
        setIsLoggingIn(false);
        return;
      }

      if (res.authUrl) {
        setLoginAuthUrl(res.authUrl);
        // Open OAuth authorization in a popup/new window
        const popup = window.open(res.authUrl, '_blank', 'width=650,height=750,noopener,noreferrer');
        if (!popup) {
          setLoginError('Browser blocked the authorization popup window. Please allow popups or click "Re-open Authorization URL" below.');
        }
      }

      // Show terminal so user can see live login feedback if requested
      setShowTerminal(true);

      // Start polling for authentication completion
      if (pollingRef.current) clearInterval(pollingRef.current);
      pollingRef.current = setInterval(async () => {
        const status = await fetchCliAuthStatus(currentMeta.cli);
        if (status.isAuthenticated) {
          if (pollingRef.current) clearInterval(pollingRef.current);
          setAuthStatus(status);
          setAuthSuccess(true);
          setIsLoggingIn(false);
          setShowTerminal(false);
          setLoginError(null);
        }
      }, 2500);
    } catch (err: any) {
      console.warn('[Onboarding] Sign in trigger error:', err);
      setLoginError(err.message || `An error occurred while launching ${currentMeta.name} login.`);
      setIsLoggingIn(false);
    }
  };

  // Finalize Subscription Connection and Save Profile to .ergo
  const handleConnectSubscription = () => {
    const newKey: UserApiKey = {
      id: `key_sub_${Date.now()}`,
      name: `${currentMeta.name} (${authStatus?.userEmail || 'Subscription'})`,
      provider: 'cli_subscription',
      apiKey: 'cli_subscription_active',
      authMode: 'cli_subscription',
      cliAgentId: currentMeta.id === 'gemini' ? 'gemini' : currentMeta.id === 'codex' ? 'codex' : 'claude-code',
      cliExecutionMode: 'interactive',
      model: currentMeta.id === 'gemini' ? 'gemini' : currentMeta.id === 'codex' ? 'codex' : 'claude-code',
      isConnected: true,
      createdAt: new Date().toISOString()
    };

    onSaveUserKey(newKey);
    onCompleteOnboarding(newKey);
  };

  // Handle Google AI Studio Key Instant Connect (Zero Terminal)
  const handleConnectGoogleKey = async () => {
    const trimmed = googleKeyInput.trim();
    if (!trimmed) {
      setGoogleKeyError('Please paste your Gemini API key.');
      return;
    }

    setIsConnectingGoogleKey(true);
    setGoogleKeyError(null);

    try {
      const res = await testAiConnection('gemini', { apiKey: trimmed });
      if (!res.success) {
        setGoogleKeyError(res.message || 'Key verification failed. Please ensure the key starts with "AIzaSy" and is active.');
        setIsConnectingGoogleKey(false);
        return;
      }

      const newKey: UserApiKey = {
        id: `key_google_${Date.now()}`,
        name: 'Google Account (Gemini)',
        provider: 'gemini',
        apiKey: trimmed,
        authMode: 'api_key',
        model: 'gemini-3.7-flash',
        generalModel: 'gemini-3.7-pro',
        summaryModel: 'gemini-3.7-flash',
        isConnected: true,
        createdAt: new Date().toISOString()
      };

      onSaveUserKey(newKey);
      onCompleteOnboarding(newKey);
    } catch (err: any) {
      setGoogleKeyError(err.message || 'Failed to verify Google Gemini API key.');
    } finally {
      setIsConnectingGoogleKey(false);
    }
  };

  // Auto-detect API key provider in developer tab
  const handleApiKeyChange = (val: string) => {
    setApiKeyInput(val);
    setKeyValidationError(null);
    const trimmed = val.trim();
    if (trimmed.startsWith('sk-ant-')) {
      setApiKeyProvider('anthropic');
      if (!apiKeyProfileName) setApiKeyProfileName('Claude API Key');
    } else if (trimmed.startsWith('sk-proj-') || trimmed.startsWith('sk-')) {
      setApiKeyProvider('openai');
      if (!apiKeyProfileName) setApiKeyProfileName('OpenAI API Key');
    } else if (trimmed.startsWith('AIzaSy')) {
      setApiKeyProvider('gemini');
      if (!apiKeyProfileName) setApiKeyProfileName('Google Gemini Key');
    } else if (trimmed.startsWith('http://') || trimmed.includes('11434')) {
      setApiKeyProvider('ollama');
      if (!apiKeyProfileName) setApiKeyProfileName('Local Ollama');
    }
  };

  // Validate Developer API key & Save
  const handleConnectApiKey = async () => {
    const trimmed = apiKeyInput.trim();
    if (!trimmed) {
      setKeyValidationError('Please enter a valid API key.');
      return;
    }

    setIsValidatingKey(true);
    setKeyValidationError(null);

    try {
      const res = await testAiConnection(apiKeyProvider, { apiKey: trimmed });
      if (!res.success) {
        setKeyValidationError(res.message || 'Verification failed. Please check your API key.');
        setIsValidatingKey(false);
        return;
      }

      const newKey: UserApiKey = {
        id: `key_api_${Date.now()}`,
        name: apiKeyProfileName.trim() || `${apiKeyProvider.toUpperCase()} Key`,
        provider: apiKeyProvider,
        apiKey: trimmed,
        authMode: 'api_key',
        isConnected: true,
        createdAt: new Date().toISOString()
      };

      onSaveUserKey(newKey);
      onCompleteOnboarding(newKey);
    } catch (err: any) {
      setKeyValidationError(err.message || 'Connection error.');
    } finally {
      setIsValidatingKey(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'rgba(0, 0, 0, 0.82)',
        backdropFilter: 'blur(10px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1.5rem',
        animation: 'fadeIn 0.2s ease-out'
      }}
    >
      <div
        style={{
          background: '#0d1117',
          border: '1px solid rgba(255, 255, 255, 0.12)',
          borderRadius: '16px',
          width: '100%',
          maxWidth: '680px',
          maxHeight: '92vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 25px 65px -15px rgba(0, 0, 0, 0.85), 0 0 35px rgba(99, 102, 241, 0.15)',
          overflow: 'hidden'
        }}
      >
        {/* Modal Header */}
        <div
          style={{
            padding: '1.75rem 2rem 1.25rem 2rem',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            position: 'relative'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <div
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: '10px',
                  background: 'linear-gradient(135deg, var(--accent-primary) 0%, #4f46e5 100%)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 4px 12px rgba(99, 102, 241, 0.35)'
                }}
              >
                <Sparkles size={20} color="#ffffff" />
              </div>
              <div>
                <h2 style={{ fontSize: '1.35rem', fontWeight: 800, color: '#ffffff', margin: 0, letterSpacing: '-0.02em' }}>
                  Welcome to Ergo
                </h2>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: 0 }}>
                  Agentic Task Architecture with Dual-Layer Context
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={onClose}
              style={{
                background: 'rgba(255, 255, 255, 0.06)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                borderRadius: '8px',
                width: 32,
                height: 32,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text-muted)',
                cursor: 'pointer',
                transition: 'all 0.15s ease'
              }}
              title="Close"
            >
              <X size={16} />
            </button>
          </div>

          <p style={{ fontSize: '0.85rem', color: 'var(--text-main)', lineHeight: 1.5, margin: '0.6rem 0 0 0' }}>
            Connect your AI account to begin. Ergo can spend against your existing <strong>monthly subscription</strong> with zero pay-per-token API fees, or connect directly with an API key.
          </p>

          {/* Navigation Tabs */}
          <div
            style={{
              display: 'flex',
              gap: '0.5rem',
              marginTop: '1.25rem',
              background: 'rgba(0, 0, 0, 0.25)',
              padding: '0.25rem',
              borderRadius: '8px',
              border: '1px solid rgba(255, 255, 255, 0.06)'
            }}
          >
            <button
              type="button"
              onClick={() => setActiveTab('subscription')}
              style={{
                flex: 1,
                padding: '0.5rem 0.75rem',
                borderRadius: '6px',
                border: 'none',
                background: activeTab === 'subscription' ? 'var(--accent-primary)' : 'transparent',
                color: activeTab === 'subscription' ? '#ffffff' : 'var(--text-muted)',
                fontWeight: activeTab === 'subscription' ? 700 : 500,
                fontSize: '0.82rem',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.45rem',
                transition: 'all 0.15s ease'
              }}
            >
              <Zap size={15} color={activeTab === 'subscription' ? '#ffffff' : 'var(--accent-emerald)'} />
              <span>AI Subscription (Zero API Fees)</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('apikey')}
              style={{
                flex: 1,
                padding: '0.5rem 0.75rem',
                borderRadius: '6px',
                border: 'none',
                background: activeTab === 'apikey' ? 'var(--accent-primary)' : 'transparent',
                color: activeTab === 'apikey' ? '#ffffff' : 'var(--text-muted)',
                fontWeight: activeTab === 'apikey' ? 700 : 500,
                fontSize: '0.82rem',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.45rem',
                transition: 'all 0.15s ease'
              }}
            >
              <Key size={15} color={activeTab === 'apikey' ? '#ffffff' : 'var(--accent-amber)'} />
              <span>Developer API Key</span>
            </button>
          </div>
        </div>

        {/* Modal Body */}
        <div style={{ padding: '1.5rem 2rem', overflowY: 'auto', flex: 1 }}>
          {activeTab === 'subscription' ? (
            <div>
              {/* Provider Selection Row */}
              <div style={{ marginBottom: '1.25rem' }}>
                <label style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-bright)', marginBottom: '0.5rem', display: 'block' }}>
                  Choose Your Subscription Provider:
                </label>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.65rem' }}>
                  {(['gemini', 'claude', 'codex'] as ProviderChoice[]).map((pId) => {
                    const p = PROVIDER_METAS[pId];
                    const isSelected = selectedProvider === pId;
                    return (
                      <div
                        key={p.id}
                        onClick={() => {
                          setSelectedProvider(pId);
                          setAuthSuccess(false);
                          setShowTerminal(false);
                          setLoginError(null);
                          setInstallError(null);
                        }}
                        style={{
                          padding: '0.85rem 0.75rem',
                          borderRadius: '10px',
                          border: `1.5px solid ${isSelected ? 'var(--accent-primary)' : 'rgba(255, 255, 255, 0.08)'}`,
                          background: isSelected ? 'rgba(99, 102, 241, 0.12)' : 'rgba(255, 255, 255, 0.02)',
                          cursor: 'pointer',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '0.35rem',
                          transition: 'all 0.15s ease',
                          boxShadow: isSelected ? '0 0 16px rgba(99, 102, 241, 0.2)' : 'none'
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <span style={{ fontSize: '1.3rem' }}>{p.icon}</span>
                          <div
                            style={{
                              width: 14,
                              height: 14,
                              borderRadius: '50%',
                              border: `2px solid ${isSelected ? 'var(--accent-primary)' : 'rgba(255, 255, 255, 0.2)'}`,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center'
                            }}
                          >
                            {isSelected && (
                              <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent-primary)' }} />
                            )}
                          </div>
                        </div>
                        <div style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-bright)' }}>{p.name}</div>
                        <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>{p.badge}</div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Prominent Error Alert Banner */}
              {(loginError || installError) && (
                <div
                  style={{
                    marginBottom: '1rem',
                    padding: '0.85rem 1rem',
                    borderRadius: '8px',
                    background: 'rgba(239, 68, 68, 0.12)',
                    border: '1px solid rgba(239, 68, 68, 0.35)',
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '0.75rem',
                    animation: 'fadeIn 0.2s ease-out'
                  }}
                >
                  <AlertCircle size={18} color="var(--accent-rose)" style={{ marginTop: '2px', flexShrink: 0 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--accent-rose)', marginBottom: '0.25rem' }}>
                      {loginError ? 'Sign-In Notice' : 'Installation Notice'}
                    </div>
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-main)', lineHeight: 1.45 }}>
                      {loginError || installError}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setLoginError(null);
                      setInstallError(null);
                    }}
                    style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 2 }}
                    title="Dismiss"
                  >
                    <X size={14} />
                  </button>
                </div>
              )}

              {/* Status & Action Card */}
              <div
                style={{
                  background: 'rgba(255, 255, 255, 0.025)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  borderRadius: '12px',
                  padding: '1.25rem',
                  marginBottom: '1.25rem'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.85rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <ShieldCheck size={17} color="var(--accent-emerald)" />
                    <span style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-bright)' }}>
                      Local CLI Authentication Status ({currentMeta.name})
                    </span>
                  </div>
                  {isCheckingAuth && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.72rem', color: 'var(--accent-cyan)' }}>
                      <Loader2 size={12} className="animate-spin" />
                      <span>Checking...</span>
                    </div>
                  )}
                </div>

                {authSuccess || (authStatus?.isInstalled && authStatus.isAuthenticated) ? (
                  /* Authenticated State */
                  <div
                    style={{
                      background: 'rgba(16, 185, 129, 0.1)',
                      border: '1px solid rgba(16, 185, 129, 0.25)',
                      borderRadius: '8px',
                      padding: '1rem',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.75rem'
                    }}
                  >
                    <CheckCircle2 size={24} color="var(--accent-emerald)" />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: '0.86rem', fontWeight: 700, color: 'var(--accent-emerald)' }}>
                        Authenticated & Ready
                      </div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
                        {authStatus?.userEmail
                          ? `Logged in as ${authStatus.userEmail}. Tasks and planning will spend against your subscription.`
                          : `${currentMeta.name} is authenticated and linked to your workspace.`}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={handleConnectSubscription}
                      style={{
                        padding: '0.6rem 1.15rem',
                        borderRadius: '6px',
                        background: 'var(--accent-emerald)',
                        color: '#ffffff',
                        fontWeight: 700,
                        fontSize: '0.82rem',
                        border: 'none',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.4rem',
                        boxShadow: '0 4px 12px rgba(16, 185, 129, 0.3)'
                      }}
                    >
                      <span>Launch Workspace</span>
                      <ArrowRight size={14} />
                    </button>
                  </div>
                ) : authStatus?.isInstalled ? (
                  /* Installed but Needs Login */
                  <div>
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '0.85rem' }}>
                      {currentMeta.cliName} is installed at <code>{authStatus.cli}</code>. Click below to sign in via your browser with your {currentMeta.name} subscription.
                    </div>
                    <div style={{ display: 'flex', gap: '0.65rem' }}>
                      <button
                        type="button"
                        onClick={handleStartSignIn}
                        disabled={isLoggingIn}
                        style={{
                          padding: '0.65rem 1.25rem',
                          borderRadius: '6px',
                          background: 'var(--accent-primary)',
                          color: '#ffffff',
                          fontWeight: 700,
                          fontSize: '0.82rem',
                          border: 'none',
                          cursor: isLoggingIn ? 'not-allowed' : 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.45rem',
                          opacity: isLoggingIn ? 0.75 : 1
                        }}
                      >
                        {isLoggingIn ? <Loader2 size={14} className="animate-spin" /> : <ExternalLink size={14} />}
                        <span>{isLoggingIn ? 'Opening OAuth Window...' : currentMeta.signInLabel}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => checkStatus(currentMeta.cli)}
                        style={{
                          padding: '0.65rem 0.85rem',
                          borderRadius: '6px',
                          background: 'rgba(255, 255, 255, 0.05)',
                          color: 'var(--text-main)',
                          fontSize: '0.78rem',
                          border: '1px solid rgba(255, 255, 255, 0.1)',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.35rem'
                        }}
                      >
                        <RefreshCw size={13} />
                        <span>Verify Sign-In</span>
                      </button>
                    </div>
                  </div>
                ) : (
                  /* Not Installed */
                  <div>
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '0.85rem', lineHeight: 1.4 }}>
                      {currentMeta.cliName} (<code>{currentMeta.cli}</code>) was not detected in your system PATH. Ergo can automatically install it via npm, or you can run the command in your shell.
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', marginBottom: '0.85rem' }}>
                      <button
                        type="button"
                        onClick={handleInstallCli}
                        disabled={isInstalling}
                        style={{
                          padding: '0.65rem 1.25rem',
                          borderRadius: '6px',
                          background: 'var(--accent-primary)',
                          color: '#ffffff',
                          fontWeight: 700,
                          fontSize: '0.82rem',
                          border: 'none',
                          cursor: isInstalling ? 'not-allowed' : 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.45rem',
                          opacity: isInstalling ? 0.75 : 1
                        }}
                      >
                        {isInstalling ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
                        <span>{isInstalling ? 'Installing CLI via npm...' : `Install & ${currentMeta.signInLabel} (1-Click)`}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => checkStatus(currentMeta.cli)}
                        style={{
                          padding: '0.65rem 0.85rem',
                          borderRadius: '6px',
                          background: 'rgba(255, 255, 255, 0.05)',
                          color: 'var(--text-main)',
                          fontSize: '0.78rem',
                          border: '1px solid rgba(255, 255, 255, 0.1)',
                          cursor: 'pointer'
                        }}
                      >
                        Check Again
                      </button>
                    </div>

                    {/* Copyable manual command */}
                    <div
                      style={{
                        background: 'rgba(0, 0, 0, 0.35)',
                        border: '1px solid rgba(255, 255, 255, 0.06)',
                        borderRadius: '6px',
                        padding: '0.45rem 0.65rem',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        fontFamily: 'var(--font-mono)',
                        fontSize: '0.72rem',
                        color: 'var(--accent-cyan)'
                      }}
                    >
                      <code>{currentMeta.installCommand}</code>
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard.writeText(currentMeta.installCommand);
                          setCopiedCmd(true);
                          setTimeout(() => setCopiedCmd(false), 2000);
                        }}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: copiedCmd ? 'var(--accent-emerald)' : 'var(--text-muted)',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.25rem',
                          fontSize: '0.7rem'
                        }}
                      >
                        {copiedCmd ? <Check size={12} /> : <Copy size={12} />}
                        <span>{copiedCmd ? 'Copied' : 'Copy'}</span>
                      </button>
                    </div>
                  </div>
                )}

                {/* Embedded Interactive Terminal if Login Prompted */}
                {showTerminal && (
                  <div style={{ marginTop: '1rem', borderTop: '1px solid rgba(255, 255, 255, 0.08)', paddingTop: '0.85rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.73rem', fontWeight: 700, color: 'var(--accent-cyan)' }}>
                        <Terminal size={13} />
                        <span>Interactive Authentication Terminal ({currentMeta.cliName})</span>
                      </div>
                      {loginAuthUrl && (
                        <a
                          href={loginAuthUrl}
                          target="_blank"
                          rel="noreferrer"
                          style={{ fontSize: '0.7rem', color: 'var(--accent-primary)', textDecoration: 'underline' }}
                        >
                          Re-open Authorization URL
                        </a>
                      )}
                    </div>
                    <div
                      style={{
                        height: '140px',
                        borderRadius: '6px',
                        overflow: 'hidden',
                        border: '1px solid rgba(255, 255, 255, 0.1)'
                      }}
                    >
                      <AgentTerminal
                        cmd={currentMeta.cli}
                        args={currentMeta.loginArgs}
                        cwd="~"
                        onExit={(code) => {
                          if (code === 0) {
                            checkStatus(currentMeta.cli);
                          }
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Direct Google Account Instant Connect (Zero Terminal / No Install Path) */}
              {selectedProvider === 'gemini' && (
                <div
                  style={{
                    background: 'rgba(59, 130, 246, 0.07)',
                    border: '1.5px solid rgba(59, 130, 246, 0.25)',
                    borderRadius: '12px',
                    padding: '1.25rem',
                    marginBottom: '0.5rem'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.4rem' }}>
                    <span style={{ fontSize: '1.1rem' }}>✨</span>
                    <span style={{ fontSize: '0.86rem', fontWeight: 800, color: '#93c5fd' }}>
                      Instant Google Account Access (No Terminal Required)
                    </span>
                  </div>
                  <p style={{ fontSize: '0.77rem', color: 'var(--text-main)', margin: '0 0 0.85rem 0', lineHeight: 1.45 }}>
                    Google provides <strong>free direct API access</strong> with your Google Account / Google One subscription (60 free requests/minute, no credit card required). Click below to get your key and enter immediately:
                  </p>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <a
                        href="https://aistudio.google.com/app/apikey"
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          padding: '0.55rem 0.95rem',
                          borderRadius: '6px',
                          background: 'rgba(59, 130, 246, 0.2)',
                          border: '1px solid rgba(59, 130, 246, 0.4)',
                          color: '#ffffff',
                          fontSize: '0.78rem',
                          fontWeight: 700,
                          textDecoration: 'none',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.35rem',
                          cursor: 'pointer'
                        }}
                      >
                        <ExternalLink size={13} />
                        <span>1. Open Google AI Studio (Get Key)</span>
                      </a>
                    </div>

                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <input
                        type="password"
                        className="input-text"
                        placeholder="Paste AIzaSy... key here"
                        value={googleKeyInput}
                        onChange={(e) => {
                          setGoogleKeyInput(e.target.value);
                          setGoogleKeyError(null);
                        }}
                        style={{
                          flex: 1,
                          fontFamily: 'var(--font-mono)',
                          fontSize: '0.82rem',
                          padding: '0.55rem 0.75rem'
                        }}
                      />
                      <button
                        type="button"
                        onClick={handleConnectGoogleKey}
                        disabled={isConnectingGoogleKey || !googleKeyInput.trim()}
                        style={{
                          padding: '0.55rem 1.15rem',
                          borderRadius: '6px',
                          background: 'var(--accent-emerald)',
                          color: '#ffffff',
                          fontWeight: 700,
                          fontSize: '0.82rem',
                          border: 'none',
                          cursor: isConnectingGoogleKey || !googleKeyInput.trim() ? 'not-allowed' : 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.4rem',
                          opacity: isConnectingGoogleKey || !googleKeyInput.trim() ? 0.6 : 1
                        }}
                      >
                        {isConnectingGoogleKey ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                        <span>2. Connect & Enter</span>
                      </button>
                    </div>

                    {googleKeyError && (
                      <div style={{ fontSize: '0.74rem', color: 'var(--accent-rose)', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                        <AlertCircle size={13} />
                        <span>{googleKeyError}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : (
            /* Developer API Key Tab */
            <div>
              <div style={{ marginBottom: '1rem' }}>
                <label style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-bright)', marginBottom: '0.35rem', display: 'block' }}>
                  Paste API Key:
                </label>
                <input
                  type="password"
                  className="input-text"
                  placeholder="sk-ant-... or sk-proj-... or AIzaSy..."
                  value={apiKeyInput}
                  onChange={(e) => handleApiKeyChange(e.target.value)}
                  style={{ fontFamily: 'var(--font-mono)', fontSize: '0.85rem' }}
                />
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '0.3rem', display: 'block' }}>
                  Provider auto-detected: <strong>{apiKeyProvider.toUpperCase()}</strong>
                </span>
              </div>

              {keyValidationError && (
                <div
                  style={{
                    fontSize: '0.75rem',
                    color: 'var(--accent-rose)',
                    background: 'rgba(244, 63, 94, 0.1)',
                    padding: '0.5rem 0.75rem',
                    borderRadius: '6px',
                    marginBottom: '1rem',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.4rem'
                  }}
                >
                  <AlertCircle size={14} />
                  <span>{keyValidationError}</span>
                </div>
              )}

              <div style={{ marginBottom: '1.25rem' }}>
                <label style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-bright)', marginBottom: '0.35rem', display: 'block' }}>
                  Profile Name (Optional):
                </label>
                <input
                  type="text"
                  className="input-text"
                  placeholder="e.g. My Work Key"
                  value={apiKeyProfileName}
                  onChange={(e) => setApiKeyProfileName(e.target.value)}
                  style={{ fontSize: '0.85rem' }}
                />
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <button
                  type="button"
                  onClick={handleConnectApiKey}
                  disabled={isValidatingKey || !apiKeyInput.trim()}
                  style={{
                    padding: '0.65rem 1.25rem',
                    borderRadius: '6px',
                    background: 'var(--accent-primary)',
                    color: '#ffffff',
                    fontWeight: 700,
                    fontSize: '0.82rem',
                    border: 'none',
                    cursor: isValidatingKey || !apiKeyInput.trim() ? 'not-allowed' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.45rem',
                    opacity: isValidatingKey || !apiKeyInput.trim() ? 0.6 : 1
                  }}
                >
                  {isValidatingKey ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                  <span>{isValidatingKey ? 'Validating Key...' : 'Connect API Key & Enter'}</span>
                </button>

                <a
                  href={
                    apiKeyProvider === 'anthropic'
                      ? 'https://console.anthropic.com/settings/keys'
                      : apiKeyProvider === 'gemini'
                        ? 'https://aistudio.google.com/app/apikey'
                        : 'https://platform.openai.com/api-keys'
                  }
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    fontSize: '0.75rem',
                    color: 'var(--text-muted)',
                    textDecoration: 'underline',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.25rem'
                  }}
                >
                  <span>Get API Key</span>
                  <ExternalLink size={12} />
                </a>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div
          style={{
            padding: '1rem 2rem',
            borderTop: '1px solid rgba(255, 255, 255, 0.08)',
            background: 'rgba(0, 0, 0, 0.25)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between'
          }}
        >
          <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>
            Account and preferences are stored locally in <code>.ergo/config/</code>
          </div>

          <button
            type="button"
            onClick={() => onCompleteOnboarding()}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-muted)',
              fontSize: '0.75rem',
              cursor: 'pointer',
              textDecoration: 'underline',
              display: 'flex',
              alignItems: 'center',
              gap: '0.25rem'
            }}
          >
            <span>Explore Workspace Offline First</span>
            <ChevronRight size={13} />
          </button>
        </div>
      </div>
    </div>
  );
};
