import React, { useState, useEffect, useRef } from 'react';
import { type AIProviderId, type UserApiKey } from '../types';
import {
  fetchCliAuthStatus,
  installCli,
  resetCliAuth,
  triggerCliLogin,
  testAiConnection,
  type CliAuthStatus
} from '../lib/aiProviders';
import { AgentTerminal } from './AgentTerminal';
import { ResizableTerminalContainer } from './ResizableTerminalContainer';
import { bridgeClient, type BridgeStatus, DEFAULT_BRIDGE_URL } from '../lib/bridgeClient';
import ergoIcon from '../assets/ergo_icon_2.png';
import {
  Zap,
  Key,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ExternalLink,
  ArrowRight,
  Terminal,
  ShieldCheck,
  ChevronRight,
  ChevronDown,
  Settings2,
  X,
  RefreshCw,
  RotateCcw,
  Cpu,
  Laptop,
  Monitor,
  Check,
  Copy,
  MoreHorizontal
} from 'lucide-react';

interface OnboardingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaveUserKey: (key: Omit<UserApiKey, 'id'> & { id?: string }) => void;
  onResetSubscription?: (cliAgentId: string) => void;
  onCompleteOnboarding: (key?: UserApiKey) => void;
}

export type ProviderChoice = 'claude' | 'codex' | 'gemini' | 'other';

interface ProviderMeta {
  id: ProviderChoice;
  name: string;
  badge: string;
  iconUrl: string;
  brandColor: string;
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
  codex: {
    id: 'codex',
    name: 'ChatGPT',
    badge: 'Plus / Team / Pro',
    iconUrl: '/icons/providers/openai.svg',
    brandColor: '#10a37f',
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
  },
  claude: {
    id: 'claude',
    name: 'Claude',
    badge: 'Pro / Team / Max',
    iconUrl: '/icons/providers/anthropic.svg',
    brandColor: '#D97757',
    cli: 'claude',
    cliName: 'Claude',
    packageName: '@anthropic-ai/claude-code',
    installCommand: 'npm install -g @anthropic-ai/claude-code',
    loginCommand: 'claude login',
    loginArgs: ['login'],
    signInLabel: 'Sign In with Anthropic',
    description: 'Anthropic Claude Pro, Max, Team, or Enterprise subscription.',
    accountHelp: 'Authenticates with your Claude account.',
    keyDocUrl: 'https://console.anthropic.com/settings/keys'
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini',
    badge: 'Google Gemini / Gemini Code Assist',
    iconUrl: '/icons/providers/gemini.svg',
    brandColor: '#3b82f6',
    cli: 'agy',
    cliName: 'Antigravity CLI (agy)',
    packageName: 'Antigravity Suite',
    installCommand: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    loginCommand: 'agy',
    loginArgs: [],
    signInLabel: 'Sign In with Google Gemini',
    description: 'Google Gemini subscription.',
    accountHelp: 'Authenticates with your Google account.',
    keyDocUrl: 'https://antigravity.google'
  },
  other: {
    id: 'other',
    name: 'Other',
    badge: 'Cursor, Ollama, Grok, etc.',
    iconUrl: '',
    brandColor: '#8b5cf6',
    cli: '',
    cliName: 'Other Provider',
    packageName: '',
    installCommand: '',
    loginCommand: '',
    loginArgs: [],
    signInLabel: "I'll set this up later",
    description: 'Configure Cursor, Local Ollama, Grok, or a custom subscription later in Settings.',
    accountHelp: 'You can configure additional subscriptions or custom CLI agents anytime.',
    keyDocUrl: ''
  }
};

export const OnboardingModal: React.FC<OnboardingModalProps> = ({
  isOpen,
  onClose,
  onSaveUserKey,
  onResetSubscription,
  onCompleteOnboarding
}) => {
  // Wizard Steps: 1 = AI Account Connection, 2 = Optional Laya Download Step, 3 = Local Device Bridge
  const [currentStep, setCurrentStep] = useState<1 | 2 | 3>(1);

  // Splash Animation state: show centered brand, then slide to top & fade in content
  const [isIntroAnimating, setIsIntroAnimating] = useState<boolean>(true);

  // Connection Mode Tab
  const [activeTab, setActiveTab] = useState<'subscription' | 'apikey'>('subscription');
  const [selectedProvider, setSelectedProvider] = useState<ProviderChoice>('codex');

  // Subscription Auth State
  const [authStatus, setAuthStatus] = useState<CliAuthStatus | null>(null);
  const [isCheckingAuth, setIsCheckingAuth] = useState(false);
  const [isResettingAuth, setIsResettingAuth] = useState(false);
  const [isConnectingSubscription, setIsConnectingSubscription] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [resetSuccessMessage, setResetSuccessMessage] = useState<string | null>(null);
  const [geminiTerminalSessionId, setGeminiTerminalSessionId] = useState<string>(`gemini-auth-${Date.now()}`);
  const [geminiTerminalActive, setGeminiTerminalActive] = useState<boolean>(false);
  const [loginAuthUrl, setLoginAuthUrl] = useState<string | null>(null);
  const [connectedUserKey, setConnectedUserKey] = useState<UserApiKey | null>(null);

  // API Key Tab State
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [apiKeyProvider, setApiKeyProvider] = useState<AIProviderId>('none');
  const [apiKeyProfileName, setApiKeyProfileName] = useState('');
  const [isValidatingKey, setIsValidatingKey] = useState(false);
  const [keyValidationError, setKeyValidationError] = useState<string | null>(null);

  // Step 2: Laya Local Decision Engine Optional Download State
  const [showLayaTerminal, setShowLayaTerminal] = useState(false);
  const [layaInstallDone, setLayaInstallDone] = useState(false);

  // Step 3: Local Device Bridge State
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>(() => bridgeClient.getStatus());
  const [bridgePortInput, setBridgePortInput] = useState<string>(() => {
    try {
      const url = new URL(bridgeClient.getBridgeUrl() || DEFAULT_BRIDGE_URL);
      return url.port || '5173';
    } catch {
      return '5173';
    }
  });
  const [showAdvancedBridge, setShowAdvancedBridge] = useState(false);
  const [isTestingBridge, setIsTestingBridge] = useState(false);
  const [bridgeConnectError, setBridgeConnectError] = useState<string | null>(null);
  const [copiedBridgeCmd, setCopiedBridgeCmd] = useState(false);

  const pollingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentMeta = PROVIDER_METAS[selectedProvider];

  // Subscribe to bridge status changes
  useEffect(() => {
    const unsub = bridgeClient.subscribe((status) => {
      setBridgeStatus(status);
    });
    return unsub;
  }, []);

  // Splash animation timer on opening
  useEffect(() => {
    if (isOpen) {
      setCurrentStep(1);
      setIsIntroAnimating(true);
      const timer = setTimeout(() => {
        setIsIntroAnimating(false);
      }, 850);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  const checkStatus = async (cliName: string) => {
    setIsCheckingAuth(true);
    try {
      const isExplicitlyDisconnected = localStorage.getItem(`ergo_disconnected_${selectedProvider}`) === 'true';
      const status = await fetchCliAuthStatus(cliName);
      if (isExplicitlyDisconnected) {
        setAuthStatus({
          ...status,
          isAuthenticated: false,
          userEmail: null,
          message: 'Not connected (Sign in to connect)'
        });
      } else {
        setAuthStatus(status);
        if (status.isAuthenticated) {
          setLoginError(null);
          setInstallError(null);
        }
      }
    } catch {
      // Ignored
    } finally {
      setIsCheckingAuth(false);
    }
  };

  const handleResetAuth = async () => {
    if (!currentMeta.cli) return;
    setIsResettingAuth(true);
    setLoginError(null);
    setInstallError(null);
    setResetSuccessMessage(null);
    setGeminiTerminalActive(false);
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
    setIsConnectingSubscription(false);

    const targetId = currentMeta.id === 'gemini' ? 'antigravity' : currentMeta.id === 'codex' ? 'codex' : 'claude-code';

    try {
      // 1. Reset remote CLI daemon credentials
      await resetCliAuth(currentMeta.cli).catch(() => { });

      // 2. Clean up saved subscription keys in localStorage matching this provider
      try {
        const savedKeysRaw = localStorage.getItem('ergo_user_api_keys');
        if (savedKeysRaw) {
          const keys: UserApiKey[] = JSON.parse(savedKeysRaw);
          const filtered = keys.filter(
            k => !(k.provider === 'cli_subscription' && (k.cliAgentId === targetId || k.model === targetId || k.cliAgentId === currentMeta.cli))
          );
          localStorage.setItem('ergo_user_api_keys', JSON.stringify(filtered));
        }
        localStorage.setItem(`ergo_disconnected_${currentMeta.id}`, 'true');
      } catch { }

      // 3. Notify parent app to purge secrets and active keys in memory and storageManager
      if (onResetSubscription) {
        onResetSubscription(targetId);
      }

      setConnectedUserKey(null);
      setAuthStatus({
        cli: currentMeta.cli,
        isInstalled: authStatus?.isInstalled ?? true,
        isAuthenticated: false,
        userEmail: null,
        message: 'Subscription disconnected. You can now connect a different profile.'
      });
    } catch (err: any) {
      setLoginError(err.message || 'Failed to reset authentication.');
    } finally {
      setIsResettingAuth(false);
    }
  };

  // Check auth status on mount and when provider changes
  useEffect(() => {
    if (isOpen && activeTab === 'subscription') {
      setLoginError(null);
      setInstallError(null);
      if (currentMeta.cli) {
        checkStatus(currentMeta.cli);
      } else {
        setAuthStatus(null);
      }
    }
  }, [isOpen, activeTab, selectedProvider]);

  // Clean up polling
  useEffect(() => {
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, []);

  if (!isOpen) return null;

  // Complete helper: advances to Laya Step 2 instead of exiting immediately
  const proceedToLayaStep = (key?: UserApiKey) => {
    if (key) {
      setConnectedUserKey(key);
      onSaveUserKey(key);
    }
    setCurrentStep(2);
  };

  const getFullBridgeUrl = (portStr: string) => {
    const cleanPort = portStr.replace(/\D/g, '').trim();
    if (!cleanPort) return DEFAULT_BRIDGE_URL;
    return `http://localhost:${cleanPort}`;
  };

  // Move from Step 2 to Step 3: Local Device Bridge
  const proceedToBridgeStep = () => {
    setCurrentStep(3);
    const targetUrl = getFullBridgeUrl(bridgePortInput);
    bridgeClient.setBridgeUrl(targetUrl);
    // Auto-check bridge connection on entering Step 3
    setIsTestingBridge(true);
    setBridgeConnectError(null);
    bridgeClient.checkConnection(targetUrl)
      .then((res) => {
        if (!res.success) {
          setBridgeConnectError(res.error || 'Bridge not detected yet.');
        }
      })
      .finally(() => {
        setIsTestingBridge(false);
      });
  };

  const handleTestBridgeConnection = async (overridePort?: string) => {
    const portToUse = overridePort !== undefined ? overridePort : bridgePortInput;
    const targetUrl = getFullBridgeUrl(portToUse);
    bridgeClient.setBridgeUrl(targetUrl);
    setIsTestingBridge(true);
    setBridgeConnectError(null);
    const res = await bridgeClient.checkConnection(targetUrl);
    setIsTestingBridge(false);
    if (!res.success) {
      setBridgeConnectError(res.error || 'Could not connect to device bridge.');
    } else {
      setBridgeConnectError(null);
    }
  };

  // True One-Click Connection to Subscription Account:
  // - If provider is 'other', proceeds to step 2 as requested ("I'll set this up later")
  // - If CLI is already installed & authenticated, connects immediately and proceeds to Step 2
  // - If CLI is installed but unauthenticated, triggers instant browser login and polls
  // - If CLI is not installed, installs CLI and automatically starts browser login in a single click
  const handleOneClickSubscriptionConnect = async () => {
    if (selectedProvider === 'other') {
      proceedToLayaStep();
      return;
    }

    try {
      localStorage.removeItem(`ergo_disconnected_${selectedProvider}`);
    } catch { }

    setIsConnectingSubscription(true);
    setInstallError(null);
    setLoginError(null);

    try {
      // 1. If already installed and authenticated, connect right away!
      if (authStatus?.isInstalled && authStatus.isAuthenticated) {
        const newKey: UserApiKey = {
          id: `key_sub_${Date.now()}`,
          name: `${currentMeta.name} (${authStatus?.userEmail || 'Subscription'})`,
          provider: 'cli_subscription',
          apiKey: 'cli_subscription_active',
          authMode: 'cli_subscription',
          cliAgentId: currentMeta.id === 'gemini' ? 'antigravity' : currentMeta.id === 'codex' ? 'codex' : 'claude-code',
          cliExecutionMode: 'interactive',
          model: currentMeta.id === 'gemini' ? 'antigravity' : currentMeta.id === 'codex' ? 'codex' : 'claude-code',
          isConnected: true,
          createdAt: new Date().toISOString()
        };
        proceedToLayaStep(newKey);
        return;
      }

      // 2. If not installed, trigger auto-install
      if (!authStatus?.isInstalled) {
        const res = await installCli(currentMeta.cli);
        const refreshed = await fetchCliAuthStatus(currentMeta.cli);
        setAuthStatus(refreshed);

        if (!refreshed.isInstalled && !res.success) {
          setInstallError(
            res.error || `Could not automatically install ${currentMeta.packageName}. You can also connect directly via the API Key tab.`
          );
          setIsConnectingSubscription(false);
          return;
        }
      }

      // 3. Initiate browser login
      if (currentMeta.id === 'gemini') {
        // Antigravity CLI runs interactively in the embedded terminal below.
        // Regenerating sessionId guarantees a clean, active terminal process.
        setGeminiTerminalActive(true);
        setGeminiTerminalSessionId(`gemini-auth-${Date.now()}`);
      } else {
        const loginRes = await triggerCliLogin(currentMeta.cli);
        if (!loginRes.success || loginRes.error) {
          setLoginError(loginRes.error || `Could not launch login for ${currentMeta.name}.`);
          setIsConnectingSubscription(false);
          return;
        }

        if (loginRes.authUrl) {
          setLoginAuthUrl(loginRes.authUrl);
          const popup = window.open(loginRes.authUrl, 'ai_auth_window', 'width=650,height=750,noopener,noreferrer');
          if (!popup) {
            setLoginError('Popup window was blocked by the browser. Click "Open Authorization Window" below.');
          }
        }
      }

      // Polling for completed OAuth with a safety timeout (90s)
      if (pollingRef.current) clearInterval(pollingRef.current);
      const pollStartTime = Date.now();
      pollingRef.current = setInterval(async () => {
        // Timeout after 90 seconds
        if (Date.now() - pollStartTime > 90_000) {
          if (pollingRef.current) clearInterval(pollingRef.current);
          setIsConnectingSubscription(false);
          setLoginError(`Authentication timed out. If you completed signing in, click "Connect with ${currentMeta.name}" again or use the terminal below.`);
          return;
        }

        const st = await fetchCliAuthStatus(currentMeta.cli);
        if (st.isAuthenticated) {
          if (pollingRef.current) clearInterval(pollingRef.current);
          setAuthStatus(st);
          setIsConnectingSubscription(false);
          setLoginError(null);

          const newKey: UserApiKey = {
            id: `key_sub_${Date.now()}`,
            name: `${currentMeta.name} (${st.userEmail || 'Subscription'})`,
            provider: 'cli_subscription',
            apiKey: 'cli_subscription_active',
            authMode: 'cli_subscription',
            cliAgentId: currentMeta.id === 'gemini' ? 'antigravity' : currentMeta.id === 'codex' ? 'codex' : 'claude-code',
            cliExecutionMode: 'interactive',
            model: currentMeta.id === 'gemini' ? 'antigravity' : currentMeta.id === 'codex' ? 'codex' : 'claude-code',
            isConnected: true,
            createdAt: new Date().toISOString()
          };
          proceedToLayaStep(newKey);
        }
      }, 2000);
    } catch (err: any) {
      setLoginError(err.message || 'One-click sign in encountered an unexpected error.');
      setIsConnectingSubscription(false);
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

  // True One-Click Connection to Developer API Key
  const handleOneClickApiKeyConnect = async () => {
    const trimmed = apiKeyInput.trim();
    if (!trimmed) {
      setKeyValidationError('Paste your API key to connect.');
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
        model: apiKeyProvider === 'gemini' ? 'gemini-3.7-flash' : undefined,
        isConnected: true,
        createdAt: new Date().toISOString()
      };

      proceedToLayaStep(newKey);
    } catch (err: any) {
      setKeyValidationError(err.message || 'Connection error.');
    } finally {
      setIsValidatingKey(false);
    }
  };

  // Finish Onboarding from Step 2
  const handleFinishOnboarding = () => {
    onCompleteOnboarding(connectedUserKey || undefined);
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'rgba(5, 7, 12, 0.88)',
        backdropFilter: 'blur(16px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1.5rem',
        animation: 'fadeIn 0.25s ease-out'
      }}
    >
      <div
        style={{
          background: 'linear-gradient(180deg, #131722 0%, #0d1017 100%)',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          borderRadius: '20px',
          width: '100%',
          maxWidth: '680px',
          minHeight: '520px',
          maxHeight: '92vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 30px 80px -15px rgba(0, 0, 0, 0.9), 0 0 40px rgba(99, 102, 241, 0.18)',
          overflow: 'hidden',
          position: 'relative',
          transition: 'all 0.3s cubic-bezier(0.16, 1, 0.3, 1)'
        }}
      >
        {/* Animated Brand Header */}
        <div
          style={{
            padding: isIntroAnimating ? '0 2rem' : '1.75rem 2rem 1.25rem 2rem',
            borderBottom: isIntroAnimating ? 'none' : '1px solid rgba(255, 255, 255, 0.08)',
            position: isIntroAnimating ? 'absolute' : 'relative',
            inset: isIntroAnimating ? '0' : 'auto',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: isIntroAnimating ? 'center' : 'flex-start',
            alignItems: isIntroAnimating ? 'center' : 'stretch',
            zIndex: isIntroAnimating ? 10 : 'auto',
            pointerEvents: isIntroAnimating ? 'none' : 'auto',
            transition: 'all 0.65s cubic-bezier(0.16, 1, 0.3, 1)',
            background: isIntroAnimating
              ? 'transparent'
              : 'linear-gradient(180deg, rgba(255, 255, 255, 0.03) 0%, transparent 100%)'
          }}
        >
          {/* Top Brand Line: Logo Icon + Stylized Name */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: isIntroAnimating ? 'center' : 'space-between',
              width: '100%',
              transform: isIntroAnimating ? 'scale(1.2)' : 'scale(1)',
              transition: 'all 0.65s cubic-bezier(0.16, 1, 0.3, 1)'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem' }}>
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: '12px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0
                }}
              >
                <img
                  src={ergoIcon}
                  alt="Ergo Logo"
                  style={{
                    width: isIntroAnimating ? 56 : 48,
                    height: isIntroAnimating ? 56 : 48,
                    objectFit: 'contain',
                    filter: 'drop-shadow(0 2px 8px rgba(0, 0, 0, 0.5))',
                    transition: 'all 0.65s cubic-bezier(0.16, 1, 0.3, 1)'
                  }}
                />
              </div>

              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span
                    className="brand-title"
                    style={{
                      fontSize: '1.5rem',
                      fontWeight: 500,
                      letterSpacing: '-0.02em',
                      color: 'var(--text-bright)',
                      textTransform: 'uppercase'
                    }}
                  >
                    Ergo
                  </span>
                  <span
                    style={{
                      fontSize: '0.6rem',
                      margin: '4px',
                      padding: '2px 8px',
                      borderRadius: '999px',
                      background: 'rgba(0, 212, 146, 0.15)',
                      color: 'var(--accent)',
                      border: '1px solid rgba(0, 212, 146, 0.35)',
                      fontWeight: 700,
                      letterSpacing: '0.04em'
                    }}
                  >
                    ALPHA
                  </span>
                </div>
                <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: '-2px', fontWeight: 500 }}>
                  Human & AI Collaborative Workspace
                </div>
              </div>
            </div>

            {!isIntroAnimating && (
              <button
                type="button"
                onClick={onClose}
                style={{
                  background: 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  borderRadius: '10px',
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
            )}
          </div>

          {/* Stepper Progress Indicator (Step 1 vs Step 2 vs Step 3) */}
          {!isIntroAnimating && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.65rem',
                marginTop: '1.25rem',
                paddingTop: '0.85rem',
                borderTop: '1px solid rgba(255, 255, 255, 0.06)'
              }}
            >
              {/* Step 1: Connect AI */}
              <div
                onClick={() => setCurrentStep(1)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.45rem',
                  fontSize: '0.76rem',
                  fontWeight: currentStep === 1 ? 700 : 600,
                  color: currentStep === 1 ? 'var(--text-bright)' : 'var(--accent-emerald)',
                  cursor: 'pointer',
                  userSelect: 'none',
                  transition: 'opacity 0.15s ease'
                }}
                role="button"
                tabIndex={0}
                title="Go to Step 1: Connect AI"
              >
                <div
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: '50%',
                    background: currentStep === 1 ? 'var(--accent-primary)' : 'rgba(16, 185, 129, 0.2)',
                    border: `1.5px solid ${currentStep === 1 ? 'var(--accent-primary)' : 'var(--accent-emerald)'}`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '0.72rem',
                    color: '#ffffff'
                  }}
                >
                  {currentStep > 1 ? <CheckCircle2 size={13} color="var(--accent-emerald)" /> : '1'}
                </div>
                <span>Connect AI</span>
              </div>

              <div style={{ flex: 1, height: '1.5px', background: currentStep > 1 ? 'var(--accent-emerald)' : 'rgba(255, 255, 255, 0.1)' }} />

              {/* Step 2: Local Verifier */}
              <div
                onClick={() => setCurrentStep(2)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.45rem',
                  fontSize: '0.76rem',
                  fontWeight: currentStep === 2 ? 700 : 500,
                  color: currentStep === 2 ? 'var(--text-bright)' : currentStep > 2 ? 'var(--accent-emerald)' : 'var(--text-dim)',
                  cursor: 'pointer',
                  userSelect: 'none',
                  transition: 'opacity 0.15s ease'
                }}
                role="button"
                tabIndex={0}
                title="Go to Step 2: Local Verifier"
              >
                <div
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: '50%',
                    background: currentStep === 2 ? 'var(--accent-cyan)' : currentStep > 2 ? 'rgba(16, 185, 129, 0.2)' : 'rgba(255, 255, 255, 0.05)',
                    border: `1.5px solid ${currentStep === 2 ? 'var(--accent-cyan)' : currentStep > 2 ? 'var(--accent-emerald)' : 'rgba(255, 255, 255, 0.2)'}`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '0.72rem',
                    color: currentStep === 2 ? '#ffffff' : currentStep > 2 ? 'var(--accent-emerald)' : 'var(--text-dim)'
                  }}
                >
                  {currentStep > 2 ? <CheckCircle2 size={13} color="var(--accent-emerald)" /> : '2'}
                </div>
                <span>Local Verifier</span>
              </div>

              <div style={{ flex: 1, height: '1.5px', background: currentStep > 2 ? 'var(--accent-emerald)' : 'rgba(255, 255, 255, 0.1)' }} />

              {/* Step 3: Connect Device Bridge */}
              <div
                onClick={() => setCurrentStep(3)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.45rem',
                  fontSize: '0.76rem',
                  fontWeight: currentStep === 3 ? 700 : 500,
                  color: currentStep === 3 ? 'var(--text-bright)' : 'var(--text-dim)',
                  cursor: 'pointer',
                  userSelect: 'none',
                  transition: 'opacity 0.15s ease'
                }}
                role="button"
                tabIndex={0}
                title="Go to Step 3: Connect Device"
              >
                <div
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: '50%',
                    background: currentStep === 3 ? 'var(--accent-primary)' : 'rgba(255, 255, 255, 0.05)',
                    border: `1.5px solid ${currentStep === 3 ? 'var(--accent-primary)' : 'rgba(255, 255, 255, 0.2)'}`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '0.72rem',
                    color: currentStep === 3 ? '#ffffff' : 'var(--text-dim)'
                  }}
                >
                  3
                </div>
                <span>Connect Device</span>
              </div>
            </div>
          )}
        </div>

        {/* Modal Main Body */}
        <div
          style={{
            padding: '1.5rem 2rem',
            overflowY: 'auto',
            flex: 1,
            opacity: isIntroAnimating ? 0 : 1,
            transform: isIntroAnimating ? 'translateY(16px)' : 'translateY(0)',
            transition: 'all 0.45s ease-out 0.15s'
          }}
        >
          {/* STEP 1: Connect AI Account (Subscription or API Key) */}
          {currentStep === 1 && (
            <div>
              {/* Header explanation */}
              <p style={{ fontSize: '0.86rem', color: 'var(--text-main)', lineHeight: 1.5, margin: '0 0 1.25rem 0' }}>
                Connect Ergo to your AI subscription, or provide an API key to pay per usage.
              </p>

              {/* Navigation Tabs: Subscription vs Developer API Key */}
              <div
                style={{
                  display: 'flex',
                  gap: '0.5rem',
                  marginBottom: '1.25rem',
                  background: 'rgba(0, 0, 0, 0.35)',
                  padding: '0.3rem',
                  borderRadius: '10px',
                  border: '1px solid rgba(255, 255, 255, 0.08)'
                }}
              >
                <button
                  type="button"
                  onClick={() => setActiveTab('subscription')}
                  style={{
                    flex: 1,
                    padding: '0.65rem 0.75rem',
                    borderRadius: '8px',
                    border: 'none',
                    background: activeTab === 'subscription' ? 'var(--accent-primary)' : 'transparent',
                    color: activeTab === 'subscription' ? '#ffffff' : 'var(--text-muted)',
                    fontWeight: activeTab === 'subscription' ? 700 : 500,
                    fontSize: '0.84rem',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '0.45rem',
                    transition: 'all 0.15s ease',
                    boxShadow: activeTab === 'subscription' ? '0 2px 10px rgba(37, 99, 235, 0.35)' : 'none'
                  }}
                >
                  <Zap size={15} color={activeTab === 'subscription' ? '#ffffff' : 'var(--accent-emerald)'} />
                  <span>AI Subscription</span>
                </button>

                <button
                  type="button"
                  onClick={() => setActiveTab('apikey')}
                  style={{
                    flex: 1,
                    padding: '0.65rem 0.75rem',
                    borderRadius: '8px',
                    border: 'none',
                    background: activeTab === 'apikey' ? 'var(--accent-primary)' : 'transparent',
                    color: activeTab === 'apikey' ? '#ffffff' : 'var(--text-muted)',
                    fontWeight: activeTab === 'apikey' ? 700 : 500,
                    fontSize: '0.84rem',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '0.45rem',
                    transition: 'all 0.15s ease',
                    boxShadow: activeTab === 'apikey' ? '0 2px 10px rgba(37, 99, 235, 0.35)' : 'none'
                  }}
                >
                  <Key size={15} color={activeTab === 'apikey' ? '#ffffff' : 'var(--accent-amber)'} />
                  <span>API Key</span>
                </button>
              </div>

              {activeTab === 'subscription' ? (
                <div>
                  {/* Provider Grid with Authentic SVG Logos */}
                  <div style={{ marginBottom: '1.25rem' }}>
                    {/* <label style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-bright)', marginBottom: '0.6rem', display: 'block' }}>
                      Select Your Subscription Provider:
                    </label> */}

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.65rem' }}>
                      {(['codex', 'claude', 'gemini', 'other'] as ProviderChoice[]).map((pId) => {
                        const p = PROVIDER_METAS[pId];
                        const isSelected = selectedProvider === pId;
                        return (
                          <div
                            key={p.id}
                            onClick={() => {
                              setSelectedProvider(pId);
                              setGeminiTerminalActive(false);
                              setLoginError(null);
                              setInstallError(null);
                            }}
                            style={{
                              padding: '0.65rem 0.8rem',
                              borderRadius: '12px',
                              border: `1.5px solid ${isSelected ? p.brandColor : 'rgba(255, 255, 255, 0.08)'}`,
                              background: isSelected ? 'rgba(255, 255, 255, 0.04)' : 'rgba(255, 255, 255, 0.015)',
                              cursor: 'pointer',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '0.45rem',
                              transition: 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
                              boxShadow: isSelected ? `0 0 20px ${p.brandColor}33` : 'none',
                              position: 'relative'
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                              {/* Official Provider SVG Icon or Fallback Icon */}
                              <div
                                style={{
                                  width: 32,
                                  height: 32,
                                  borderRadius: '8px',
                                  background: 'rgba(255, 255, 255, 0.06)',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  padding: p.iconUrl ? '5px' : '0px',
                                  color: p.brandColor
                                }}
                              >
                                {p.iconUrl ? (
                                  <img
                                    src={p.iconUrl}
                                    alt={p.name}
                                    style={{
                                      width: '100%',
                                      height: '100%',
                                      objectFit: 'contain'
                                    }}
                                  />
                                ) : (
                                  <MoreHorizontal size={20} />
                                )}
                              </div>

                              <div
                                style={{
                                  width: 16,
                                  height: 16,
                                  borderRadius: '50%',
                                  border: `2px solid ${isSelected ? p.brandColor : 'rgba(255, 255, 255, 0.25)'}`,
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  transition: 'all 0.15s ease'
                                }}
                              >
                                {isSelected && (
                                  <div
                                    style={{
                                      width: 8,
                                      height: 8,
                                      borderRadius: '50%',
                                      background: p.brandColor
                                    }}
                                  />
                                )}
                              </div>
                            </div>

                            <div style={{ fontSize: '0.84rem', fontWeight: 700, color: 'var(--text-bright)', marginTop: '0.2rem' }}>
                              {p.name}
                            </div>
                            {/* <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', lineHeight: 1.3 }}>
                              {p.badge}
                            </div> */}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Prominent Error Banner */}
                  {(loginError || installError) && (
                    <div
                      style={{
                        marginBottom: '1.25rem',
                        padding: '0.85rem 1rem',
                        borderRadius: '10px',
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
                          Connection Notice
                        </div>
                        <div style={{ fontSize: '0.78rem', color: 'var(--text-main)', lineHeight: 1.45 }}>
                          {loginError || installError}
                        </div>
                        {((loginError || installError || '').includes('Browser security') || (loginError || installError || '').includes('hosted web address') || (loginError || installError || '').includes('Cannot reach your local device') || (loginError || installError || '').includes('Unable to reach your local Ergo bridge') || (loginError || installError || '').includes('refuses requests from')) && (
                          <div style={{ marginTop: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <button
                              type="button"
                              onClick={() => {
                                setActiveTab('apikey');
                                setLoginError(null);
                                setInstallError(null);
                              }}
                              style={{
                                padding: '0.35rem 0.75rem',
                                borderRadius: '6px',
                                background: 'rgba(255, 255, 255, 0.12)',
                                border: '1px solid rgba(255, 255, 255, 0.2)',
                                color: '#ffffff',
                                fontSize: '0.74rem',
                                fontWeight: 600,
                                cursor: 'pointer',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '0.35rem'
                              }}
                            >
                              <Key size={13} />
                              <span>Switch to API Key Tab</span>
                            </button>
                          </div>
                        )}
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

                  {/* Reset Confirmation Notice */}
                  {resetSuccessMessage && (
                    <div
                      style={{
                        background: 'rgba(16, 185, 129, 0.08)',
                        border: '1px solid rgba(16, 185, 129, 0.25)',
                        borderRadius: '10px',
                        padding: '0.85rem 1rem',
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: '0.65rem'
                      }}
                    >
                      <CheckCircle2 size={18} color="var(--accent-emerald)" style={{ marginTop: '2px', flexShrink: 0 }} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--accent-emerald)', marginBottom: '0.2rem' }}>
                          Subscription Disconnected
                        </div>
                        <div style={{ fontSize: '0.78rem', color: 'var(--text-main)', lineHeight: 1.45 }}>
                          {resetSuccessMessage}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setResetSuccessMessage(null)}
                        style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 2 }}
                        title="Dismiss"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  )}

                  {/* 1-Click Connection Card */}
                  <div
                    style={{
                      background: 'rgba(255, 255, 255, 0.025)',
                      border: '1px solid rgba(255, 255, 255, 0.08)',
                      borderRadius: '14px',
                      padding: '1.35rem',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '1rem'
                    }}
                  >
                    {selectedProvider !== 'other' && <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                        <ShieldCheck size={18} color="var(--accent-emerald)" />
                        <span style={{ fontSize: '0.86rem', fontWeight: 700, color: 'var(--text-bright)' }}>
                          Subscription Connection
                        </span>
                      </div>

                      {isCheckingAuth && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.72rem', color: 'var(--accent-cyan)' }}>
                          <Loader2 size={12} className="animate-spin" />
                          <span>Checking status...</span>
                        </div>
                      )}
                    </div>}

                    <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: 0, lineHeight: 1.45 }}>
                      {selectedProvider === 'other'
                        ? 'Using Grok, a local Ollama model, or another AI provider? You can skip this step and configure it later from the AI Profile dropdown.'
                        : authStatus?.isInstalled && authStatus.isAuthenticated
                          ? (
                            <span>
                              Successfully connected to your {currentMeta.name} subscription
                              {authStatus.userEmail ? (
                                <>
                                  {' '}(<strong style={{ color: 'var(--text-bright)' }}>{authStatus.userEmail}</strong>).
                                </>
                              ) : (
                                '.'
                              )}
                            </span>
                          )
                          : `Connect in one click. Handles authentication and secure local storage automatically.`}
                    </p>

                    {/* Single 1-Click Action Button & Reset Auth Button */}
                    <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        onClick={handleOneClickSubscriptionConnect}
                        disabled={isConnectingSubscription || isResettingAuth}
                        style={{
                          flex: 1,
                          minWidth: '240px',
                          padding: '0.75rem 1.4rem',
                          borderRadius: '10px',
                          background: authStatus?.isInstalled && authStatus.isAuthenticated
                            ? 'var(--accent-emerald)'
                            : 'var(--accent-primary)',
                          color: '#ffffff',
                          fontWeight: 700,
                          fontSize: '0.88rem',
                          border: 'none',
                          cursor: (isConnectingSubscription || isResettingAuth) ? 'not-allowed' : 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: '0.55rem',
                          boxShadow: authStatus?.isInstalled && authStatus.isAuthenticated
                            ? '0 4px 16px rgba(16, 185, 129, 0.35)'
                            : '0 4px 16px rgba(37, 99, 235, 0.35)',
                          transition: 'all 0.15s ease',
                          opacity: (isConnectingSubscription || isResettingAuth) ? 0.8 : 1
                        }}
                      >
                        {selectedProvider === 'other' ? (
                          <>
                            {/* <ChevronRight size={20} /> */}
                            <span>I'll set this up later</span>
                          </>
                        ) : isConnectingSubscription ? (
                          <>
                            <Loader2 size={20} className="animate-spin" />
                            <span>Connecting {currentMeta.name}...</span>
                          </>
                        ) : authStatus?.isInstalled && authStatus.isAuthenticated ? (
                          <>
                            {/* <CheckCircle2 size={20} /> */}
                            <span>Confirm & Continue</span>
                          </>
                        ) : (
                          <>
                            {/* <Zap size={20} /> */}
                            <span>Connect with {currentMeta.name}</span>
                          </>
                        )}
                      </button>

                      {selectedProvider !== 'other' && (
                        <button
                          type="button"
                          onClick={handleResetAuth}
                          disabled={isResettingAuth || isConnectingSubscription}
                          style={{
                            padding: '0.75rem 1rem',
                            borderRadius: '10px',
                            background: 'rgba(255, 255, 255, 0.05)',
                            border: '1px solid rgba(255, 255, 255, 0.12)',
                            color: 'var(--text-muted)',
                            fontSize: '0.8rem',
                            fontWeight: 600,
                            cursor: (isResettingAuth || isConnectingSubscription) ? 'not-allowed' : 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '0.45rem',
                            transition: 'all 0.15s ease',
                            whiteSpace: 'nowrap'
                          }}
                          title="Wipe saved credentials for this provider and sign in under another account"
                        >
                          {isResettingAuth ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : (
                            <RotateCcw size={14} />
                          )}
                          <span>Reset</span>
                        </button>
                      )}

                      {/* Cancel button if currently in connecting state */}
                      {isConnectingSubscription && (
                        <button
                          type="button"
                          onClick={() => {
                            if (pollingRef.current) {
                              clearInterval(pollingRef.current);
                              pollingRef.current = null;
                            }
                            setIsConnectingSubscription(false);
                          }}
                          style={{
                            padding: '0.75rem 1rem',
                            borderRadius: '10px',
                            background: 'rgba(255, 255, 255, 0.05)',
                            border: '1px solid rgba(255, 255, 255, 0.15)',
                            color: 'var(--text-dim)',
                            fontSize: '0.8rem',
                            fontWeight: 600,
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.35rem'
                          }}
                        >
                          <X size={14} />
                          <span>Cancel</span>
                        </button>
                      )}
                    </div>

                    {/* Quick Access to OAuth Link if window was blocked or closed */}
                    {isConnectingSubscription && loginAuthUrl && (
                      <div
                        style={{
                          background: 'rgba(37, 99, 235, 0.08)',
                          border: '1px solid rgba(37, 99, 235, 0.25)',
                          borderRadius: '8px',
                          padding: '0.65rem 0.85rem',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: '0.5rem',
                          marginTop: '0.25rem'
                        }}
                      >
                        <span style={{ fontSize: '0.76rem', color: 'var(--text-main)' }}>
                          Sign-in window didn't open?
                        </span>
                        <a
                          href={loginAuthUrl}
                          target="_blank"
                          rel="noreferrer"
                          style={{
                            fontSize: '0.76rem',
                            fontWeight: 600,
                            color: 'var(--accent-primary)',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '0.3rem',
                            textDecoration: 'none'
                          }}
                        >
                          <span>Open Authorization Window</span>
                          <ExternalLink size={12} />
                        </a>
                      </div>
                    )}

                    {/* Interactive terminal container - only shown for Gemini when user initiates connection and authentication is needed */}
                    {selectedProvider === 'gemini' && (isConnectingSubscription || (authStatus && !authStatus.isAuthenticated && geminiTerminalActive)) && (
                      <div style={{ marginTop: '0.5rem', borderTop: '1px solid rgba(255, 255, 255, 0.08)', paddingTop: '0.85rem' }}>
                        <div style={{ marginBottom: '0.5rem', fontSize: '0.76rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                          Antigravity CLI authenticates directly via the interactive console below. Follow the on-screen prompt:
                        </div>
                        <ResizableTerminalContainer
                          defaultHeight={280}
                          minHeight={180}
                          maxHeight={550}
                          maximizedHeight={480}
                          storageKey="ergo_terminal_height_onboarding"
                          style={{
                            border: '1px solid rgba(255, 255, 255, 0.1)',
                            borderRadius: '8px',
                            overflow: 'hidden'
                          }}
                          headerLeft={
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.73rem', fontWeight: 700, color: 'var(--accent-cyan)' }}>
                              <Terminal size={13} />
                              <span>Console Authentication ({currentMeta.cliName})</span>
                            </div>
                          }
                        >
                          <AgentTerminal
                            key={geminiTerminalSessionId}
                            cmd={currentMeta.cli}
                            args={currentMeta.loginArgs}
                            cwd="~"
                            sessionId={geminiTerminalSessionId}
                            forceRestart={true}
                            killOnUnmount={true}
                            onExit={(code) => {
                              if (code === 0) {
                                checkStatus(currentMeta.cli);
                              }
                            }}
                          />
                        </ResizableTerminalContainer>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                /* Developer API Key Tab */
                <div
                  style={{
                    background: 'rgba(255, 255, 255, 0.025)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    borderRadius: '14px',
                    padding: '1.0rem',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '1.25rem'
                  }}
                >
                  <div>
                    {/* <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-bright)', marginBottom: '0.45rem', display: 'block' }}>
                      Paste API Key:
                    </label> */}
                    <input
                      type="password"
                      className="input-text"
                      placeholder="sk-ant-... or sk-proj-... or AIzaSy..."
                      value={apiKeyInput}
                      onChange={(e) => handleApiKeyChange(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleOneClickApiKeyConnect();
                      }}
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: '0.88rem',
                        padding: '0.75rem 0.95rem',
                        width: '100%',
                        borderRadius: '10px'
                      }}
                    />
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '0.65rem', flexWrap: 'wrap', gap: '0.5rem' }}>
                      {apiKeyProvider === "none" ? (
                        <span></span>
                      ) : (
                        <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>
                          Provider auto-detected: <strong style={{ color: 'var(--text-bright)' }}>{apiKeyProvider.toUpperCase()}</strong>
                        </span>
                      )}

                      {/* 3-Button Tab to Get API Keys */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                        <span style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginRight: '0.15rem' }}>Get Key:</span>
                        <a
                          href="https://platform.openai.com/api-keys"
                          target="_blank"
                          rel="noreferrer"
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '0.25rem',
                            padding: '0.22rem 0.55rem',
                            borderRadius: '6px',
                            background: apiKeyProvider === 'openai' ? 'rgba(16, 163, 127, 0.2)' : 'rgba(255, 255, 255, 0.05)',
                            border: `1px solid ${apiKeyProvider === 'openai' ? 'rgba(16, 163, 127, 0.4)' : 'rgba(255, 255, 255, 0.1)'}`,
                            color: apiKeyProvider === 'openai' ? '#10b981' : 'var(--text-muted)',
                            fontSize: '0.72rem',
                            fontWeight: 600,
                            textDecoration: 'none',
                            transition: 'all 0.15s ease'
                          }}
                        >
                          <img src="/icons/providers/openai.svg" alt="OpenAI" style={{ width: 11, height: 11 }} />
                          <span>OpenAI</span>
                          <ExternalLink size={10} />
                        </a>

                        <a
                          href="https://console.anthropic.com/settings/keys"
                          target="_blank"
                          rel="noreferrer"
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '0.25rem',
                            padding: '0.22rem 0.55rem',
                            borderRadius: '6px',
                            background: apiKeyProvider === 'anthropic' ? 'rgba(217, 119, 87, 0.2)' : 'rgba(255, 255, 255, 0.05)',
                            border: `1px solid ${apiKeyProvider === 'anthropic' ? 'rgba(217, 119, 87, 0.4)' : 'rgba(255, 255, 255, 0.1)'}`,
                            color: apiKeyProvider === 'anthropic' ? '#D97757' : 'var(--text-muted)',
                            fontSize: '0.72rem',
                            fontWeight: 600,
                            textDecoration: 'none',
                            transition: 'all 0.15s ease'
                          }}
                        >
                          <img src="/icons/providers/anthropic.svg" alt="Anthropic" style={{ width: 11, height: 11 }} />
                          <span>Anthropic</span>
                          <ExternalLink size={10} />
                        </a>

                        <a
                          href="https://aistudio.google.com/app/apikey"
                          target="_blank"
                          rel="noreferrer"
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '0.25rem',
                            padding: '0.22rem 0.55rem',
                            borderRadius: '6px',
                            background: apiKeyProvider === 'gemini' ? 'rgba(59, 130, 246, 0.2)' : 'rgba(255, 255, 255, 0.05)',
                            border: `1px solid ${apiKeyProvider === 'gemini' ? 'rgba(59, 130, 246, 0.4)' : 'rgba(255, 255, 255, 0.1)'}`,
                            color: apiKeyProvider === 'gemini' ? '#60a5fa' : 'var(--text-muted)',
                            fontSize: '0.72rem',
                            fontWeight: 600,
                            textDecoration: 'none',
                            transition: 'all 0.15s ease'
                          }}
                        >
                          <img src="/icons/providers/gemini.svg" alt="Gemini" style={{ width: 11, height: 11 }} />
                          <span>Gemini</span>
                          <ExternalLink size={10} />
                        </a>
                      </div>
                    </div>
                  </div>

                  {keyValidationError && (
                    <div
                      style={{
                        fontSize: '0.78rem',
                        color: 'var(--accent-rose)',
                        background: 'rgba(244, 63, 94, 0.1)',
                        border: '1px solid rgba(244, 63, 94, 0.25)',
                        padding: '0.65rem 0.85rem',
                        borderRadius: '8px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.45rem'
                      }}
                    >
                      <AlertCircle size={14} />
                      <span>{keyValidationError}</span>
                    </div>
                  )}

                  <div>
                    <label style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.35rem', display: 'block' }}>
                      Profile Name (Optional):
                    </label>
                    <input
                      type="text"
                      className="input-text"
                      placeholder="e.g. Work Key"
                      value={apiKeyProfileName}
                      onChange={(e) => setApiKeyProfileName(e.target.value)}
                      style={{ fontSize: '0.84rem', padding: '0.6rem 0.85rem', width: '100%', borderRadius: '8px' }}
                    />
                  </div>

                  {/* Single 1-Click Connect Button for API Key */}
                  <button
                    type="button"
                    onClick={handleOneClickApiKeyConnect}
                    disabled={isValidatingKey || !apiKeyInput.trim()}
                    style={{
                      padding: '0.75rem 1.4rem',
                      borderRadius: '10px',
                      background: 'var(--accent-primary)',
                      color: '#ffffff',
                      fontWeight: 700,
                      fontSize: '0.88rem',
                      border: 'none',
                      cursor: isValidatingKey || !apiKeyInput.trim() ? 'not-allowed' : 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '0.5rem',
                      boxShadow: '0 4px 16px rgba(37, 99, 235, 0.35)',
                      opacity: isValidatingKey || !apiKeyInput.trim() ? 0.6 : 1
                    }}
                  >
                    {isValidatingKey ? (
                      <>
                        <Loader2 size={16} className="animate-spin" />
                        <span>Validating & Connecting...</span>
                      </>
                    ) : (
                      <>
                        <CheckCircle2 size={16} />
                        <span>Connect API Key</span>
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* STEP 2: Optional Laya Engine Download Screen */}
          {currentStep === 2 && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '1.25rem',
                animation: 'fadeIn 0.25s ease-out'
              }}
            >
              {/* Laya Engine Feature Showcase */}
              <div
                style={{
                  background: 'rgba(6, 182, 212, 0.04)',
                  border: '1.5px solid rgba(6, 182, 212, 0.25)',
                  borderRadius: '16px',
                  padding: '1.5rem',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '1rem'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <div
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: '10px',
                      background: 'rgba(6, 182, 212, 0.15)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: 'var(--accent-cyan)'
                    }}
                  >
                    <Cpu size={22} />
                  </div>

                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span style={{ fontSize: '1rem', fontWeight: 800, color: '#ffffff' }}>
                        Local Verifier Engine
                      </span>
                      {/* <span
                        style={{
                          fontSize: '0.68rem',
                          fontWeight: 700,
                          background: 'rgba(16, 185, 129, 0.15)',
                          color: 'var(--accent-emerald)',
                          border: '1px solid rgba(16, 185, 129, 0.3)',
                          borderRadius: '4px',
                          padding: '1px 7px'
                        }}
                      >
                        $0 Token Cost
                      </span> */}
                    </div>
                    <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                      Laya local decision engine for agent verification
                    </div>
                  </div>
                </div>

                <p style={{ fontSize: '0.82rem', color: 'var(--text-main)', lineHeight: 1.5, margin: 0 }}>
                  Laya is a zero-cost decision engine that runs locally in the background.
                  It makes decisions for AI agents on relevant knowledge, task classification, tool routing, etc. without spending any of your AI usage.
                </p>

                {/* <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.75rem' }}>
                  <div
                    style={{
                      padding: '0.75rem',
                      borderRadius: '8px',
                      background: 'rgba(255, 255, 255, 0.02)',
                      border: '1px solid rgba(255, 255, 255, 0.06)'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--accent-cyan)', fontSize: '0.78rem', fontWeight: 700 }}>
                      <Zap size={14} />
                      <span>Instant Subtasks</span>
                    </div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginTop: '4px' }}>
                      Splits and classifies human workspace tasks locally in 40ms.
                    </div>
                  </div>

                  <div
                    style={{
                      padding: '0.75rem',
                      borderRadius: '8px',
                      background: 'rgba(255, 255, 255, 0.02)',
                      border: '1px solid rgba(255, 255, 255, 0.06)'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--accent-emerald)', fontSize: '0.78rem', fontWeight: 700 }}>
                      <Layers size={14} />
                      <span>Dual-Layer Context</span>
                    </div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginTop: '4px' }}>
                      Zero external API calls for routing decisions.
                    </div>
                  </div>
                </div> */}

                {/* Download Action Area */}
                {!showLayaTerminal && !layaInstallDone && (
                  <button
                    type="button"
                    onClick={() => setShowLayaTerminal(true)}
                    style={{
                      padding: '0.75rem 1.25rem',
                      borderRadius: '10px',
                      background: 'rgba(6, 182, 212, 0.18)',
                      color: 'var(--accent-cyan)',
                      border: '1.5px solid rgba(6, 182, 212, 0.4)',
                      fontSize: '0.85rem',
                      fontWeight: 700,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '0.45rem',
                      transition: 'all 0.15s ease'
                    }}
                  >
                    <Terminal size={15} />
                    <span>Download (one-click install)</span>
                  </button>
                )}

                {layaInstallDone && (
                  <div
                    style={{
                      background: 'rgba(16, 185, 129, 0.1)',
                      border: '1px solid rgba(16, 185, 129, 0.3)',
                      borderRadius: '8px',
                      padding: '0.75rem 1rem',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      color: 'var(--accent-emerald)',
                      fontSize: '0.82rem',
                      fontWeight: 700
                    }}
                  >
                    <CheckCircle2 size={16} />
                    <span>Laya Engine successfully installed & enabled!</span>
                  </div>
                )}

                {/* Embedded Terminal for pip install laya */}
                {showLayaTerminal && !layaInstallDone && (
                  <div style={{ marginTop: '0.25rem' }}>
                    <ResizableTerminalContainer
                      defaultHeight={240}
                      minHeight={180}
                      maxHeight={450}
                      maximizedHeight={400}
                      storageKey="ergo_terminal_height_laya_onboarding"
                      style={{
                        border: '1px solid rgba(6, 182, 212, 0.3)',
                        borderRadius: '8px',
                        overflow: 'hidden'
                      }}
                      headerLeft={
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.73rem', fontWeight: 700, color: 'var(--accent-cyan)' }}>
                          <Terminal size={13} />
                          <span>Installing Laya Local Engine (pip install laya)</span>
                        </div>
                      }
                      headerRight={
                        <button
                          type="button"
                          onClick={() => setShowLayaTerminal(false)}
                          style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.72rem' }}
                        >
                          Dismiss
                        </button>
                      }
                    >
                      <AgentTerminal
                        cmd="pip"
                        args={['install', '--break-system-packages', 'laya']}
                        cwd="~"
                        sessionId="onboarding-laya-installer"
                        forceRestart={true}
                        killOnUnmount={true}
                        onExit={(code) => {
                          if (code === 0) {
                            setLayaInstallDone(true);
                            setShowLayaTerminal(false);
                          }
                        }}
                      />
                    </ResizableTerminalContainer>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* STEP 3: Connect Local Device Bridge */}
          {currentStep === 3 && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', marginBottom: '0.5rem' }}>
                <div
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: '8px',
                    background: 'rgba(99, 102, 241, 0.15)',
                    border: '1px solid rgba(99, 102, 241, 0.3)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--accent-primary)'
                  }}
                >
                  <Laptop size={18} />
                </div>
                <div>
                  <h3 style={{ fontSize: '1.05rem', fontWeight: 700, margin: 0, color: 'var(--text-bright)' }}>
                    Connect to Your Computer
                  </h3>
                  <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '2px 0 0 0' }}>
                    Grant permission to read your projects and run local coding agents autonomously.
                  </p>
                </div>
              </div>

              {/* Status Banner */}
              <div
                style={{
                  marginTop: '1.25rem',
                  padding: '1rem 1.25rem',
                  borderRadius: '12px',
                  background: bridgeStatus.isConnected
                    ? 'rgba(16, 185, 129, 0.1)'
                    : 'rgba(234, 179, 8, 0.08)',
                  border: bridgeStatus.isConnected
                    ? '1.5px solid rgba(16, 185, 129, 0.35)'
                    : '1.5px solid rgba(234, 179, 8, 0.25)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '1rem'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: '50%',
                      background: bridgeStatus.isConnected ? 'rgba(16, 185, 129, 0.2)' : 'rgba(234, 179, 8, 0.15)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: bridgeStatus.isConnected ? 'var(--accent-emerald)' : '#eab308'
                    }}
                  >
                    {bridgeStatus.isConnected ? <Check size={20} /> : <Monitor size={20} />}
                  </div>
                  <div>
                    <div style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-bright)' }}>
                      {bridgeStatus.isConnected ? 'Device Connected & Ready' : 'Bridge Not Detected Yet'}
                    </div>
                    <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                      {bridgeStatus.isConnected
                        ? `Connection active at ${bridgeStatus.url}`
                        : 'Click below to establish connection with your local workspace.'}
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => handleTestBridgeConnection()}
                  disabled={isTestingBridge}
                  style={{
                    padding: '0.55rem 1rem',
                    borderRadius: '8px',
                    background: bridgeStatus.isConnected ? 'rgba(255, 255, 255, 0.06)' : 'var(--accent-primary)',
                    color: '#ffffff',
                    border: '1px solid rgba(255, 255, 255, 0.15)',
                    fontSize: '0.78rem',
                    fontWeight: 600,
                    cursor: isTestingBridge ? 'wait' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.4rem',
                    whiteSpace: 'nowrap',
                    transition: 'all 0.15s ease'
                  }}
                >
                  <RefreshCw size={13} className={isTestingBridge ? 'animate-spin' : ''} />
                  <span>{isTestingBridge ? 'Checking...' : bridgeStatus.isConnected ? 'Re-check' : 'Connect Now'}</span>
                </button>
              </div>

              {/* Error Alert if any */}
              {bridgeConnectError && (
                <div
                  style={{
                    marginTop: '0.85rem',
                    padding: '0.75rem 1rem',
                    borderRadius: '8px',
                    background: 'rgba(239, 68, 68, 0.1)',
                    border: '1px solid rgba(239, 68, 68, 0.3)',
                    color: '#f87171',
                    fontSize: '0.78rem',
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '0.5rem'
                  }}
                >
                  <AlertCircle size={15} style={{ flexShrink: 0, marginTop: '2px' }} />
                  <div>
                    <div style={{ fontWeight: 600 }}>Connection Notice</div>
                    <div style={{ marginTop: '2px', color: 'rgba(255, 255, 255, 0.75)', lineHeight: 1.45 }}>
                      {bridgeConnectError}
                    </div>
                    {bridgeStatus.isMixedContentBlocked && (
                      <div style={{ marginTop: '0.5rem', padding: '0.45rem 0.65rem', background: 'rgba(0, 0, 0, 0.3)', borderRadius: '6px', border: '1px solid rgba(255, 255, 255, 0.08)', color: 'var(--text-bright)', fontSize: '0.74rem' }}>
                        💡 <strong>Why this happens:</strong> Mobile browsers and HTTPS websites restrict connecting to <code>localhost</code> over unencrypted HTTP. To use Ergo on this device, either use an <strong>API Key</strong> in Step 1, or open Ergo directly on your computer at <code>http://localhost:5173</code>.
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Easy Instructions for Non-Technical Users */}
              <div
                style={{
                  marginTop: '1.25rem',
                  padding: '1rem 1.15rem',
                  borderRadius: '10px',
                  background: 'rgba(0, 0, 0, 0.25)',
                  border: '1px solid rgba(255, 255, 255, 0.06)'
                }}
              >
                <div style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-bright)', marginBottom: '0.5rem' }}>
                  How does the local connection work?
                </div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.5, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
                    <div style={{ color: 'var(--accent-primary)', fontWeight: 700 }}>1.</div>
                    <div>
                      <strong>Your work stays on your device.</strong> Ergo automatically stores data locally in your personal <code>~/.ergo</code> workspace folder, created fresh on your computer.
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
                    <div style={{ color: 'var(--accent-primary)', fontWeight: 700 }}>2.</div>
                    <div>
                      <strong>Run AI tools natively.</strong> Autonomous agents like Claude Code and Codex run in real embedded terminals, so they behave like local tools.
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
                    <div style={{ color: 'var(--accent-primary)', fontWeight: 700 }}>3.</div>
                    <div>
                      <strong>Automatic reconnects.</strong> When you revisit or refresh this web page, Ergo will quietly reconnect to your local daemon.
                    </div>
                  </div>
                </div>
              </div>

              {/* Collapsible Advanced Settings Dropdown */}
              <div
                style={{
                  marginTop: '0.85rem',
                  borderRadius: '10px',
                  background: 'rgba(0, 0, 0, 0.2)',
                  border: '1px solid rgba(255, 255, 255, 0.07)',
                  overflow: 'hidden',
                  transition: 'all 0.2s ease'
                }}
              >
                <button
                  type="button"
                  onClick={() => setShowAdvancedBridge((prev) => !prev)}
                  style={{
                    width: '100%',
                    padding: '0.75rem 1rem',
                    background: 'transparent',
                    border: 'none',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    cursor: 'pointer',
                    color: 'var(--text-muted)',
                    fontSize: '0.78rem',
                    fontWeight: 600,
                    transition: 'color 0.15s ease'
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text-bright)')}
                  onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-muted)')}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <Settings2 size={14} color="#8b5cf6" />
                    <span>Advanced Settings</span>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-dim)', fontWeight: 400 }}>
                      (Port configuration & helper commands)
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center' }}>
                    {showAdvancedBridge ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </div>
                </button>

                {showAdvancedBridge && (
                  <div
                    style={{
                      padding: '0.85rem 1rem 1rem 1rem',
                      borderTop: '1px solid rgba(255, 255, 255, 0.05)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.9rem'
                    }}
                  >
                    {/* Port Customization */}
                    <div>
                      <div style={{ fontSize: '0.74rem', fontWeight: 600, color: 'var(--text-bright)', marginBottom: '0.35rem' }}>
                        Local Bridge Port
                      </div>
                      <div style={{ fontSize: '0.71rem', color: 'var(--text-dim)', marginBottom: '0.45rem' }}>
                        Change the port number if your local Ergo bridge is running on a custom port.
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            background: 'rgba(0, 0, 0, 0.4)',
                            border: '1px solid rgba(255, 255, 255, 0.12)',
                            borderRadius: '6px',
                            padding: '0 0.5rem',
                            flex: 1
                          }}
                        >
                          <span style={{ fontSize: '0.76rem', color: 'var(--text-dim)', fontFamily: 'monospace', userSelect: 'none' }}>
                            http://localhost:
                          </span>
                          <input
                            type="text"
                            value={bridgePortInput}
                            onChange={(e) => {
                              const cleaned = e.target.value.replace(/\D/g, '').slice(0, 5);
                              setBridgePortInput(cleaned);
                              const fullUrl = getFullBridgeUrl(cleaned);
                              bridgeClient.setBridgeUrl(fullUrl);
                            }}
                            placeholder="5173"
                            style={{
                              width: '70px',
                              fontSize: '0.78rem',
                              fontFamily: 'monospace',
                              fontWeight: 700,
                              padding: '0.4rem 0.35rem',
                              background: 'transparent',
                              border: 'none',
                              color: 'var(--accent-primary)',
                              outline: 'none'
                            }}
                          />
                        </div>

                        <button
                          type="button"
                          onClick={() => handleTestBridgeConnection(bridgePortInput)}
                          disabled={isTestingBridge}
                          style={{
                            padding: '0.42rem 0.85rem',
                            borderRadius: '6px',
                            background: 'rgba(255, 255, 255, 0.06)',
                            border: '1px solid rgba(255, 255, 255, 0.12)',
                            color: 'var(--text-bright)',
                            fontSize: '0.74rem',
                            fontWeight: 600,
                            cursor: isTestingBridge ? 'wait' : 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.35rem',
                            whiteSpace: 'nowrap'
                          }}
                        >
                          <RefreshCw size={11} className={isTestingBridge ? 'animate-spin' : ''} />
                          <span>Apply Port</span>
                        </button>
                      </div>
                    </div>

                    {/* Terminal Launch Command */}
                    <div>
                      <div style={{ fontSize: '0.74rem', fontWeight: 600, color: 'var(--text-bright)', marginBottom: '0.35rem' }}>
                        Manual Helper Launch Command
                      </div>
                      <div style={{ fontSize: '0.71rem', color: 'var(--text-dim)', marginBottom: '0.45rem' }}>
                        If the bridge isn't running automatically, run this in a terminal to start it:
                      </div>
                      {(() => {
                        const localFolder = bridgeStatus.storageDir || (typeof window !== 'undefined' && window.location.hostname === 'localhost' ? 'Ergo' : '<folder where Ergo is stored>');
                        const launchCmd = `cd ${localFolder.includes(' ') ? `"${localFolder}"` : localFolder} && npm run dev`;
                        return (
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              background: 'rgba(0, 0, 0, 0.45)',
                              padding: '0.45rem 0.75rem',
                              borderRadius: '6px',
                              border: '1px solid rgba(255, 255, 255, 0.08)',
                              fontFamily: 'monospace',
                              fontSize: '0.75rem',
                              color: 'var(--accent-emerald)',
                              overflowX: 'auto',
                              gap: '0.5rem'
                            }}
                          >
                            <span style={{ whiteSpace: 'nowrap' }}>{launchCmd}</span>
                            <button
                              type="button"
                              onClick={() => {
                                navigator.clipboard.writeText(launchCmd);
                                setCopiedBridgeCmd(true);
                                setTimeout(() => setCopiedBridgeCmd(false), 2000);
                              }}
                              style={{
                                background: 'none',
                                border: 'none',
                                color: 'var(--text-muted)',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.25rem',
                                fontSize: '0.72rem',
                                flexShrink: 0
                              }}
                              title="Copy command"
                            >
                              {copiedBridgeCmd ? <Check size={12} color="var(--accent-emerald)" /> : <Copy size={12} />}
                              <span>{copiedBridgeCmd ? 'Copied' : 'Copy'}</span>
                            </button>
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer with Actions and Skip option */}
        <div
          style={{
            padding: '1.15rem 2rem',
            borderTop: '1px solid rgba(255, 255, 255, 0.08)',
            background: 'rgba(0, 0, 0, 0.3)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '1rem'
          }}
        >
          {currentStep === 1 ? (
            <>
              <div style={{ fontSize: '0.74rem', color: 'var(--text-dim)' }}>
                Preferences are saved locally in <code>.ergo/config/</code>
              </div>

              <button
                type="button"
                onClick={() => proceedToLayaStep()}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-muted)',
                  fontSize: '0.78rem',
                  cursor: 'pointer',
                  textDecoration: 'underline',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  transition: 'color 0.15s ease'
                }}
              >
                <span>Skip Step</span>
                <ChevronRight size={14} />
              </button>
            </>
          ) : currentStep === 2 ? (
            <>
              <button
                type="button"
                onClick={proceedToBridgeStep}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-muted)',
                  fontSize: '0.8rem',
                  cursor: 'pointer',
                  textDecoration: 'underline',
                  padding: '0.4rem 0'
                }}
              >
                Skip for now
              </button>

              <button
                type="button"
                onClick={proceedToBridgeStep}
                style={{
                  padding: '0.65rem 1.4rem',
                  borderRadius: '10px',
                  background: 'var(--accent-primary)',
                  color: '#ffffff',
                  fontSize: '0.85rem',
                  fontWeight: 700,
                  border: 'none',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.45rem',
                  boxShadow: '0 4px 16px rgba(37, 99, 235, 0.35)',
                  transition: 'all 0.2s ease'
                }}
              >
                <span>Next: Connect Device</span>
                <ArrowRight size={15} />
              </button>
            </>
          ) : (
            /* Step 3: Finish Onboarding */
            <>
              <button
                type="button"
                onClick={handleFinishOnboarding}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-muted)',
                  fontSize: '0.8rem',
                  cursor: 'pointer',
                  textDecoration: 'underline',
                  padding: '0.4rem 0'
                }}
              >
                Continue without Connection
              </button>

              <button
                type="button"
                onClick={handleFinishOnboarding}
                style={{
                  padding: '0.65rem 1.4rem',
                  borderRadius: '10px',
                  background: bridgeStatus.isConnected ? 'var(--accent-emerald)' : 'var(--accent-primary)',
                  color: '#ffffff',
                  fontSize: '0.85rem',
                  fontWeight: 700,
                  border: 'none',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.45rem',
                  boxShadow: bridgeStatus.isConnected
                    ? '0 4px 16px rgba(16, 185, 129, 0.35)'
                    : '0 4px 16px rgba(37, 99, 235, 0.35)',
                  transition: 'all 0.2s ease'
                }}
              >
                <span>Enter Workspace</span>
                <ArrowRight size={15} />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
