import React, { useState, useEffect, useRef } from 'react';
import { getPref, removePref, setPref } from '../lib/userPrefs';
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
import {
  LocalModelOnboardingStep,
  isLocalModelInstalled,
  useLocalModelInstall,
  type LocalModelMode
} from './LocalModelSetup';
import { bridgeClient, type BridgeStatus, BRIDGE_LAUNCH_URL, DEFAULT_BRIDGE_URL, getBridgeDownload } from '../lib/bridgeClient';
import { BridgeDownloadButton } from './BridgeDownloadButton';
import ergoIcon from '../assets/ergo_icon_2.png';
import {
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
  X,
  RefreshCw,
  RotateCcw,
  Check,
  Copy,
  MoreHorizontal
} from 'lucide-react';
import { Banner, Button, Field, IconButton, Input, SegmentedControl } from './ui';

interface OnboardingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaveUserKey: (key: Omit<UserApiKey, 'id'> & { id?: string }) => void;
  onResetSubscription?: (cliAgentId: string) => void;
  onCompleteOnboarding: (key?: UserApiKey) => void;
  /** Local AI model preference ('unset' until the user picks in step 2 or Settings). */
  localModelMode?: LocalModelMode;
  onSetLocalModelMode?: (mode: 'local' | 'cloud') => void;
  /** What "Skip" uses instead, e.g. "Claude Haiku". */
  tinyCloudModelLabel?: string;
}

export type ProviderChoice = 'claude' | 'codex' | 'gemini' | 'other';

interface ProviderMeta {
  id: ProviderChoice;
  name: string;
  badge: string;
  iconUrl: string;
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
    cli: 'codex',
    cliName: 'OpenAI Codex CLI',
    packageName: '@openai/codex',
    installCommand: 'npm install -g @openai/codex',
    loginCommand: 'codex login',
    loginArgs: ['login'],
    signInLabel: 'Sign in with OpenAI',
    description: 'OpenAI ChatGPT Plus, Team, or Pro subscription.',
    accountHelp: 'Authenticates with your OpenAI account in browser.',
    keyDocUrl: 'https://platform.openai.com/api-keys'
  },
  claude: {
    id: 'claude',
    name: 'Claude',
    badge: 'Pro / Team / Max',
    iconUrl: '/icons/providers/anthropic.svg',
    cli: 'claude',
    cliName: 'Claude',
    packageName: '@anthropic-ai/claude-code',
    installCommand: 'curl -fsSL https://claude.ai/install.sh | bash',
    loginCommand: 'claude login',
    loginArgs: ['login'],
    signInLabel: 'Sign in with Anthropic',
    description: 'Anthropic Claude Pro, Max, Team, or Enterprise subscription.',
    accountHelp: 'Authenticates with your Claude account.',
    keyDocUrl: 'https://console.anthropic.com/settings/keys'
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini',
    badge: 'Google Gemini / Gemini Code Assist',
    iconUrl: '/icons/providers/gemini.svg',
    cli: 'agy',
    cliName: 'Antigravity CLI (agy)',
    packageName: 'Antigravity Suite',
    installCommand: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    loginCommand: 'agy',
    loginArgs: [],
    signInLabel: 'Sign in with Google Gemini',
    description: 'Google Gemini subscription.',
    accountHelp: 'Authenticates with your Google account.',
    keyDocUrl: 'https://antigravity.google'
  },
  other: {
    id: 'other',
    name: 'Other',
    badge: 'Cursor, Ollama, Grok, etc.',
    iconUrl: '',
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
  onCompleteOnboarding,
  localModelMode = 'unset',
  onSetLocalModelMode,
  tinyCloudModelLabel
}) => {
  // Wizard Steps: 1 = AI Account Connection, 2 = Optional Local AI Model, 3 = Local Device Bridge
  const [currentStep, setCurrentStep] = useState<1 | 2 | 3>(1);


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

  // Step 2: Local AI model (managed install through the bridge). An install started here keeps
  // being watched after the wizard moves on/closes, so finishing it still switches the mode to local.
  const cloudModelLabel = tinyCloudModelLabel?.trim() || 'a small cloud model';
  const localModel = useLocalModelInstall({
    enabled: isOpen && currentStep === 3,
    onInstalled: () => onSetLocalModelMode?.('local')
  });

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

  // Start at step 1 each time the wizard opens
  useEffect(() => {
    if (isOpen) setCurrentStep(1);
  }, [isOpen]);

  const checkStatus = async (cliName: string) => {
    setIsCheckingAuth(true);
    try {
      const isExplicitlyDisconnected = getPref(`ergo_disconnected_${selectedProvider}`) === 'true';
      const status = await fetchCliAuthStatus(cliName);
      if (isExplicitlyDisconnected) {
        setAuthStatus({
          ...status,
          isAuthenticated: false,
          userEmail: null,
          message: 'Not connected. Sign in to connect.'
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
        setPref(`ergo_disconnected_${currentMeta.id}`, 'true');
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
      setLoginError(err.message || 'Ergo couldn’t sign out of this account.');
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

  // Errors from a connect attempt made while the bridge was unreachable go stale once it answers (e.g. after the
  // user allows local access in the browser prompt): clear them and refresh the CLI status.
  const wasBridgeConnected = useRef(bridgeStatus.isConnected);
  useEffect(() => {
    const was = wasBridgeConnected.current;
    wasBridgeConnected.current = bridgeStatus.isConnected;
    if (was || !bridgeStatus.isConnected || !isOpen) return;
    setInstallError(null);
    setLoginError(null);
    setBridgeConnectError(null);
    if (activeTab === 'subscription' && currentMeta.cli) checkStatus(currentMeta.cli);
  }, [bridgeStatus.isConnected]);

  // Step 1: look for the bridge every few seconds while the user installs and opens it (the app heartbeat is slower).
  useEffect(() => {
    if (!isOpen || currentStep !== 1 || bridgeStatus.isConnected || !bridgeClient.isHostedWeb()) return;
    const timer = setInterval(() => {
      bridgeClient.checkConnection().catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [isOpen, currentStep, bridgeStatus.isConnected]);

  // Clean up polling
  useEffect(() => {
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, []);

  if (!isOpen) return null;

  // Nothing answers on this computer: offer the Ergo Bridge installer, and a link that opens an installed one.
  const bridgeDownload = getBridgeDownload();
  const bridgeInstallActions = bridgeClient.isHostedWeb() && !bridgeStatus.isConnected && bridgeStatus.diagnosis === 'unreachable' && bridgeDownload ? (
    <div className="eg-hstack" style={{ flexWrap: 'wrap', gap: 'var(--space-3)' }}>
      <BridgeDownloadButton size="sm" />
      <a href={BRIDGE_LAUNCH_URL} className="dlg-link">
        Already installed? Open it
      </a>
    </div>
  ) : null;

  // Complete helper: advances to the Local AI model step (2) instead of exiting immediately
  const proceedToLocalModelStep = (key?: UserApiKey) => {
    if (key) {
      setConnectedUserKey(key);
      onSaveUserKey(key);
    }
    setCurrentStep(3);
  };

  const getFullBridgeUrl = (portStr: string) => {
    const cleanPort = portStr.replace(/\D/g, '').trim();
    if (!cleanPort) return DEFAULT_BRIDGE_URL;
    return `http://localhost:${cleanPort}`;
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
      setBridgeConnectError(res.error || 'Ergo couldn’t reach the bridge on this computer.');
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
      proceedToLocalModelStep();
      return;
    }

    try {
      removePref(`ergo_disconnected_${selectedProvider}`);
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
        proceedToLocalModelStep(newKey);
        return;
      }

      // 2. If not installed, trigger auto-install
      if (!authStatus?.isInstalled) {
        const res = await installCli(currentMeta.cli);
        const refreshed = await fetchCliAuthStatus(currentMeta.cli);
        setAuthStatus(refreshed);

        if (!refreshed.isInstalled && !res.success) {
          setInstallError(
            res.error || `Ergo couldn’t install ${currentMeta.packageName} automatically. You can also connect with an API key.`
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
            setLoginError('The browser blocked the sign-in window. Use “Open the sign-in window” below.');
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
          setLoginError(`Sign-in is taking longer than expected. If you finished signing in, click “Connect ${currentMeta.name}” again or use the terminal below.`);
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
          proceedToLocalModelStep(newKey);
        }
      }, 2000);
    } catch (err: any) {
      setLoginError(err.message || 'Sign-in stopped unexpectedly. Try again.');
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
        setKeyValidationError(res.message || 'That key didn’t work. Check it and try again.');
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

      proceedToLocalModelStep(newKey);
    } catch (err: any) {
      setKeyValidationError(err.message || 'Ergo couldn’t reach the provider to check the key.');
    } finally {
      setIsValidatingKey(false);
    }
  };

  // Step 3 → cloud: "Skip — use <tiny cloud model> instead" (nothing is downloaded), which also finishes onboarding.
  const handleUseCloudModel = () => {
    onSetLocalModelMode?.('cloud');
    handleFinishOnboarding();
  };

  // Step 3 footer "Enter Workspace": finishing without installing counts as skipping, unless the user already chose.
  const handleLocalModelNext = () => {
    const st = localModel.status;
    const installingOrInstalled = st?.state === 'installing' || isLocalModelInstalled(st);
    if (!installingOrInstalled && localModelMode === 'unset') onSetLocalModelMode?.('cloud');
    handleFinishOnboarding();
  };

  // Finish onboarding (last step: Local AI Model)
  const handleFinishOnboarding = () => {
    // A download started in step 2 is still running: the user chose local, and the fallback covers
    // the gap until it's ready (also survives a page reload, which would drop the completion watcher).
    if (localModel.installRequested && localModel.status?.state === 'installing') {
      onSetLocalModelMode?.('local');
    }
    onCompleteOnboarding(connectedUserKey || undefined);
  };

  const steps: Array<{ n: 1 | 2 | 3; label: string }> = [
    { n: 1, label: 'Install bridge' },
    { n: 2, label: 'Connect AI' },
    { n: 3, label: 'Local AI model' }
  ];

  return (
    <div className="eg-scrim dlg-onboarding-scrim">
      <div className="eg-dialog dlg-onboarding" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
        <div className="eg-dialog-head">
          <img src={ergoIcon} alt="" width={28} height={28} style={{ objectFit: 'contain', flex: 'none', marginTop: -2 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 className="eg-dialog-title" id="onboarding-title">Set up Ergo</h2>
            <p className="eg-dialog-desc">Human and AI collaborative workspace</p>
          </div>
          <IconButton icon={X} label="Close" size="sm" onClick={onClose} />
        </div>

        {/* Steps */}
        <nav className="dlg-steps" aria-label="Setup steps">
          {steps.map((st, i) => (
            <React.Fragment key={st.n}>
              {i > 0 && <span className="dlg-steps-line" aria-hidden="true" />}
              <button
                type="button"
                className="dlg-step"
                aria-current={currentStep === st.n ? 'step' : undefined}
                data-done={currentStep > st.n ? 'true' : undefined}
                onClick={() => setCurrentStep(st.n)}
                title={`Go to step ${st.n}: ${st.label}`}
              >
                <span className="dlg-step-num">{currentStep > st.n ? <Check size={12} strokeWidth={2} /> : st.n}</span>
                {st.label}
              </button>
            </React.Fragment>
          ))}
        </nav>

        {/* Modal Main Body */}
        <div className="eg-dialog-body dlg-onboarding-body">
          {/* STEP 1: Install and start Ergo Bridge, which everything after this step runs through */}
          {currentStep === 1 && (
            <div className="dlg-ob-step">
              <div>
                <h3 className="dlg-ob-title">Install Ergo Bridge</h3>
                <p className="dlg-ob-lead">A small app that lets Ergo use your AI subscription, your files and your tools on this computer.</p>
              </div>

              {bridgeStatus.isConnected ? (
                <Banner
                  icon={CheckCircle2}
                  title="Ergo Bridge is running"
                  text={
                    <>
                      Connected at {bridgeStatus.url}. Your work is saved in <code className="eg-mono" style={{ fontSize: 'calc(11px * var(--type-scale))' }}>{bridgeStatus.storageDir}</code>.
                    </>
                  }
                  className="dlg-banner-success"
                />
              ) : !getBridgeDownload() || !bridgeClient.isHostedWeb() ? (
                <Banner
                  title={bridgeClient.isHostedWeb() ? 'Ergo Bridge isn’t available for this device' : 'The local Ergo server isn’t running'}
                  text={
                    bridgeClient.isHostedWeb()
                      ? 'Ergo Bridge runs on Windows, macOS and Linux computers. On this device you can still use Ergo with an API key: skip this step.'
                      : 'Start the local Ergo server (npm run dev) to continue.'
                  }
                />
              ) : (
                <div className="dlg-ob-panel">
                  <ol className="eg-steps" style={{ margin: 0 }}>
                    <li>
                      <span>Download Ergo Bridge and open the file to install it.</span>
                    </li>
                    <li>
                      <span>Come back to this page. It finds Ergo Bridge by itself once it's running.</span>
                    </li>
                    <li>
                      <span>
                        When your browser asks to let this site access apps on this device, click <strong>Allow</strong>.
                      </span>
                    </li>
                  </ol>
                  <div className="eg-hstack" style={{ flexWrap: 'wrap', gap: 'var(--space-3)', marginTop: 'var(--space-4)' }}>
                    <BridgeDownloadButton size="lg" />
                    <a href={BRIDGE_LAUNCH_URL} className="dlg-link">
                      Already installed? Open it
                    </a>
                  </div>
                  <div className="eg-hstack" style={{ marginTop: 'var(--space-3)', fontSize: 'calc(12px * var(--type-scale))', color: 'var(--ink-subtle)' }}>
                    <Loader2 size={14} strokeWidth={1.75} className="animate-spin" />
                    <span>
                      {bridgeStatus.awaitingPermission
                        ? 'Found Ergo Bridge: click Allow in the browser prompt next to the address bar.'
                        : 'Waiting for Ergo Bridge to start on this computer…'}
                    </span>
                    <Button variant="ghost" size="sm" onClick={() => handleTestBridgeConnection()} disabled={isTestingBridge}>
                      {isTestingBridge ? 'Checking…' : 'Check again'}
                    </Button>
                  </div>
                </div>
              )}

              {bridgeConnectError && (
                <Banner
                  tone="warning"
                  title="Ergo can’t reach the bridge yet"
                  text={
                    <>
                      {bridgeConnectError}
                      {bridgeStatus.isMixedContentBlocked && (
                        <span style={{ display: 'block', marginTop: 'var(--space-2)' }}>
                          Why: mobile browsers and HTTPS sites can’t connect to <code className="eg-mono" style={{ fontSize: 'calc(11px * var(--type-scale))' }}>localhost</code> over
                          plain HTTP. To use Ergo on this device, use an API key in step 2, or open Ergo on your computer at{' '}
                          <code className="eg-mono" style={{ fontSize: 'calc(11px * var(--type-scale))' }}>http://localhost:5173</code>.
                        </span>
                      )}
                    </>
                  }
                />
              )}

              {!bridgeConnectError &&
                !bridgeStatus.isConnected &&
                (bridgeStatus.diagnosis === 'permission-denied' || bridgeStatus.diagnosis === 'origin-refused') &&
                bridgeStatus.error && <Banner tone="warning" title="The browser is blocking the bridge" text={bridgeStatus.error} />}

              {/* Advanced: port and the launch command */}
              <div>
                <button type="button" className="dlg-disclosure" aria-expanded={showAdvancedBridge} onClick={() => setShowAdvancedBridge((prev) => !prev)}>
                  {showAdvancedBridge ? <ChevronDown size={14} strokeWidth={1.75} /> : <ChevronRight size={14} strokeWidth={1.75} />}
                  <span>Advanced</span>
                  <span className="eg-subtle" style={{ fontWeight: 400 }}>Port and launch command</span>
                </button>

                {showAdvancedBridge && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', padding: 'var(--space-3) 0 0 22px' }}>
                    <div className="eg-field">
                      <span className="eg-field-label">Bridge port</span>
                      <div className="eg-hstack">
                        <span className="dlg-prefix-input" style={{ flex: 1 }}>
                          <span className="dlg-prefix-input-prefix">http://localhost:</span>
                          <input
                            type="text"
                            value={bridgePortInput}
                            aria-label="Bridge port"
                            onChange={(e) => {
                              const cleaned = e.target.value.replace(/\D/g, '').slice(0, 5);
                              setBridgePortInput(cleaned);
                              const fullUrl = getFullBridgeUrl(cleaned);
                              bridgeClient.setBridgeUrl(fullUrl);
                            }}
                            placeholder="5173"
                          />
                        </span>
                        <Button
                          icon={RefreshCw}
                          onClick={() => handleTestBridgeConnection(bridgePortInput)}
                          disabled={isTestingBridge}
                          className={isTestingBridge ? 'dlg-spin-icon' : undefined}
                        >
                          Use this port
                        </Button>
                      </div>
                      <span className="eg-field-help">Change it if your bridge runs on a custom port.</span>
                    </div>

                    <div className="eg-field">
                      <span className="eg-field-label">Launch command</span>
                      <span className="eg-field-help" style={{ marginTop: -2 }}>
                        Developers working from a copy of the Ergo repository can run the bridge from it instead:
                      </span>
                      {(() => {
                        // The Ergo checkout the bridge last ran from (not the ~/.ergo data folder). Two lines rather
                        // than `&&`, which Windows PowerShell 5.1 rejects.
                        const appFolder = bridgeStatus.appDir || '<your Ergo folder>';
                        const launchCmd = `cd ${appFolder.includes(' ') ? `"${appFolder}"` : appFolder}\nnpm run dev`;
                        return (
                          <div className="dlg-code-well dlg-code-row">
                            <pre>{launchCmd}</pre>
                            <Button
                              variant="ghost"
                              size="sm"
                              icon={copiedBridgeCmd ? Check : Copy}
                              onClick={() => {
                                navigator.clipboard.writeText(launchCmd);
                                setCopiedBridgeCmd(true);
                                setTimeout(() => setCopiedBridgeCmd(false), 2000);
                              }}
                              title="Copy command"
                            >
                              {copiedBridgeCmd ? 'Copied' : 'Copy'}
                            </Button>
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* STEP 2: Connect AI Account (Subscription or API Key) */}
          {currentStep === 2 && (
            <div className="dlg-ob-step">
              <div>
                <h3 className="dlg-ob-title">Connect AI</h3>
                <p className="dlg-ob-lead">Connect Ergo to your AI subscription, or provide an API key to pay per usage.</p>
              </div>

              <SegmentedControl<'subscription' | 'apikey'>
                full
                label="How to connect"
                value={activeTab}
                onChange={setActiveTab}
                options={[
                  { id: 'subscription', label: 'AI subscription' },
                  { id: 'apikey', label: 'API key' }
                ]}
              />

              {activeTab === 'subscription' ? (
                <>
                  <div className="dlg-provider-grid" role="radiogroup" aria-label="Provider">
                    {(['codex', 'claude', 'gemini', 'other'] as ProviderChoice[]).map((pId) => {
                      const p = PROVIDER_METAS[pId];
                      const isSelected = selectedProvider === pId;
                      return (
                        <button
                          type="button"
                          role="radio"
                          aria-checked={isSelected}
                          key={p.id}
                          className="dlg-provider"
                          onClick={() => {
                            setSelectedProvider(pId);
                            setGeminiTerminalActive(false);
                            setLoginError(null);
                            setInstallError(null);
                          }}
                        >
                          <span className="dlg-provider-logo">
                            {p.iconUrl ? <img src={p.iconUrl} alt="" /> : <MoreHorizontal size={16} strokeWidth={1.75} />}
                          </span>
                          <span>{p.name}</span>
                        </button>
                      );
                    })}
                  </div>

                  {bridgeStatus.awaitingPermission && (
                    <Banner tone="warning" title="Allow Ergo to reach the bridge" text={bridgeClient.describeUnreachable('permission-prompt')} />
                  )}

                  {(loginError || installError) && (
                    <div style={{ position: 'relative' }}>
                      <Banner
                        tone="warning"
                        title={`${currentMeta.name} isn’t connected yet`}
                        text={loginError || installError}
                        actions={
                          bridgeInstallActions || !bridgeStatus.isConnected ? (
                            <>
                              {bridgeInstallActions}
                              {!bridgeStatus.isConnected && (
                                <Button
                                  size="sm"
                                  icon={Key}
                                  onClick={() => {
                                    setActiveTab('apikey');
                                    setLoginError(null);
                                    setInstallError(null);
                                  }}
                                >
                                  Use an API key instead
                                </Button>
                              )}
                            </>
                          ) : undefined
                        }
                      />
                      <IconButton
                        icon={X}
                        label="Dismiss"
                        size="sm"
                        style={{ position: 'absolute', top: 8, right: 8 }}
                        onClick={() => {
                          setLoginError(null);
                          setInstallError(null);
                        }}
                      />
                    </div>
                  )}

                  {resetSuccessMessage && (
                    <div style={{ position: 'relative' }}>
                      <Banner icon={CheckCircle2} title="Subscription disconnected" text={resetSuccessMessage} className="dlg-banner-success" />
                      <IconButton
                        icon={X}
                        label="Dismiss"
                        size="sm"
                        style={{ position: 'absolute', top: 8, right: 8 }}
                        onClick={() => setResetSuccessMessage(null)}
                      />
                    </div>
                  )}

                  {/* Connect */}
                  <div className="dlg-ob-panel" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                    {selectedProvider !== 'other' && (
                      <div className="eg-hstack">
                        <ShieldCheck size={16} strokeWidth={1.75} style={{ color: 'var(--ink-subtle)' }} />
                        <span style={{ color: 'var(--ink)', fontWeight: 500 }}>Subscription</span>
                        <span className="eg-spacer" />
                        {isCheckingAuth && (
                          <span className="eg-hstack eg-subtle" style={{ fontSize: 'calc(12px * var(--type-scale))', gap: 6 }}>
                            <Loader2 size={14} strokeWidth={1.75} className="animate-spin" />
                            Checking…
                          </span>
                        )}
                        {!isCheckingAuth && authStatus?.isInstalled && authStatus.isAuthenticated && (
                          <span className="eg-hstack" style={{ fontSize: 'calc(12px * var(--type-scale))', gap: 6, color: 'var(--ink-muted)' }}>
                            <span className="eg-dot eg-dot-success" />
                            Connected
                          </span>
                        )}
                      </div>
                    )}

                    <p style={{ margin: 0 }}>
                      {selectedProvider === 'other' ? (
                        'Using Grok, a local Ollama model, or another AI provider? You can skip this step and configure it later from the AI profile menu.'
                      ) : authStatus?.isInstalled && authStatus.isAuthenticated ? (
                        <span>
                          Connected to your {currentMeta.name} subscription
                          {authStatus.userEmail ? (
                            <>
                              {' '}
                              (<span style={{ color: 'var(--ink)' }}>{authStatus.userEmail}</span>).
                            </>
                          ) : (
                            '.'
                          )}
                        </span>
                      ) : (
                        'Connect in one click. Ergo handles sign-in and stores the credentials locally.'
                      )}
                    </p>

                    <div className="eg-hstack" style={{ flexWrap: 'wrap' }}>
                      <Button
                        variant="primary"
                        size="lg"
                        onClick={handleOneClickSubscriptionConnect}
                        disabled={isConnectingSubscription || isResettingAuth}
                        style={{ flex: 1, minWidth: 220 }}
                      >
                        {isConnectingSubscription && selectedProvider !== 'other' && (
                          <Loader2 size={14} strokeWidth={1.75} className="animate-spin" />
                        )}
                        {selectedProvider === 'other'
                          ? "I'll set this up later"
                          : isConnectingSubscription
                            ? `Connecting ${currentMeta.name}…`
                            : authStatus?.isInstalled && authStatus.isAuthenticated
                              ? 'Continue'
                              : `Connect ${currentMeta.name}`}
                      </Button>

                      {selectedProvider !== 'other' && (
                        <Button
                          size="lg"
                          icon={isResettingAuth ? undefined : RotateCcw}
                          onClick={handleResetAuth}
                          disabled={isResettingAuth || isConnectingSubscription}
                          title="Remove the saved sign-in for this provider so you can use another account"
                        >
                          {isResettingAuth && <Loader2 size={14} strokeWidth={1.75} className="animate-spin" />}
                          Sign out
                        </Button>
                      )}

                      {isConnectingSubscription && (
                        <Button
                          variant="ghost"
                          size="lg"
                          onClick={() => {
                            if (pollingRef.current) {
                              clearInterval(pollingRef.current);
                              pollingRef.current = null;
                            }
                            setIsConnectingSubscription(false);
                          }}
                        >
                          Cancel
                        </Button>
                      )}
                    </div>

                    {/* Quick access to the OAuth link if the window was blocked or closed */}
                    {isConnectingSubscription && loginAuthUrl && (
                      <div className="eg-hstack" style={{ fontSize: 'calc(12px * var(--type-scale))' }}>
                        <span>Sign-in window didn't open?</span>
                        <a href={loginAuthUrl} target="_blank" rel="noreferrer" className="dlg-link eg-hstack" style={{ gap: 4 }}>
                          Open the sign-in window
                          <ExternalLink size={12} strokeWidth={1.75} />
                        </a>
                      </div>
                    )}

                    {/* Interactive terminal - only for Gemini while connecting and sign-in is needed */}
                    {selectedProvider === 'gemini' && (isConnectingSubscription || (authStatus && !authStatus.isAuthenticated && geminiTerminalActive)) && (
                      <div style={{ borderTop: '1px solid var(--line)', paddingTop: 'var(--space-3)' }}>
                        <p style={{ margin: '0 0 var(--space-2)', fontSize: 'calc(12px * var(--type-scale))', lineHeight: 'calc(16px * var(--type-scale))' }}>
                          Antigravity CLI signs in through the console below. Follow its prompt:
                        </p>
                        <ResizableTerminalContainer
                          defaultHeight={280}
                          minHeight={180}
                          maxHeight={550}
                          maximizedHeight={480}
                          storageKey="ergo_terminal_height_onboarding"
                          style={{
                            border: '1px solid var(--line)',
                            borderRadius: 'var(--radius-md)',
                            overflow: 'hidden'
                          }}
                          headerLeft={
                            <div className="eg-hstack" style={{ gap: 6, fontSize: 'calc(12px * var(--type-scale))', fontWeight: 500, color: 'var(--ink-muted)' }}>
                              <Terminal size={14} strokeWidth={1.75} />
                              <span>Sign in · {currentMeta.cliName}</span>
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
                </>
              ) : (
                /* Developer API key */
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
                  <div className="eg-field">
                    <span className="eg-field-label">API key</span>
                    <Input
                      type="password"
                      mono
                      aria-label="API key"
                      placeholder="sk-ant-…, sk-proj-… or AIzaSy…"
                      value={apiKeyInput}
                      invalid={!!keyValidationError}
                      onChange={(e) => handleApiKeyChange(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleOneClickApiKeyConnect();
                      }}
                      style={{ height: 'var(--size-control-lg)' }}
                    />
                    <div className="eg-hstack" style={{ flexWrap: 'wrap', fontSize: 'calc(12px * var(--type-scale))', color: 'var(--ink-subtle)' }}>
                      {apiKeyProvider !== 'none' && (
                        <span>
                          Detected: <span style={{ color: 'var(--ink)' }}>{apiKeyProvider}</span>
                        </span>
                      )}
                      <span className="eg-spacer" />
                      <span>Get a key:</span>
                      {[
                        { id: 'openai', label: 'OpenAI', href: 'https://platform.openai.com/api-keys', icon: '/icons/providers/openai.svg' },
                        { id: 'anthropic', label: 'Anthropic', href: 'https://console.anthropic.com/settings/keys', icon: '/icons/providers/anthropic.svg' },
                        { id: 'gemini', label: 'Gemini', href: 'https://aistudio.google.com/app/apikey', icon: '/icons/providers/gemini.svg' }
                      ].map((k) => (
                        <a
                          key={k.id}
                          href={k.href}
                          target="_blank"
                          rel="noreferrer"
                          className="eg-btn eg-btn-ghost eg-btn-sm"
                          style={{ textDecoration: 'none', color: apiKeyProvider === k.id ? 'var(--ink)' : undefined }}
                        >
                          <img src={k.icon} alt="" style={{ width: 12, height: 12 }} />
                          {k.label}
                          <ExternalLink size={12} strokeWidth={1.75} />
                        </a>
                      ))}
                    </div>
                    {keyValidationError && (
                      <span className="eg-field-error" role="alert">
                        <AlertCircle size={14} strokeWidth={1.75} />
                        {keyValidationError}
                      </span>
                    )}
                  </div>

                  <Field label="Profile name (optional)">
                    <Input type="text" placeholder="Work key" value={apiKeyProfileName} onChange={(e) => setApiKeyProfileName(e.target.value)} />
                  </Field>

                  <Button
                    variant="primary"
                    size="lg"
                    onClick={handleOneClickApiKeyConnect}
                    disabled={isValidatingKey || !apiKeyInput.trim()}
                    style={{ alignSelf: 'flex-start' }}
                  >
                    {isValidatingKey && <Loader2 size={14} strokeWidth={1.75} className="animate-spin" />}
                    {isValidatingKey ? 'Checking the key…' : 'Connect API key'}
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* STEP 3: Optional Local AI Model */}
          {currentStep === 3 && (
            <div>
              <LocalModelOnboardingStep
                controller={localModel}
                mode={localModelMode}
                cloudLabel={cloudModelLabel}
                onUseCloud={handleUseCloudModel}
                onUseLocal={() => onSetLocalModelMode?.('local')}
              />
            </div>
          )}

        </div>

        {/* Footer: skip on the left, the next step on the right */}
        <div className="eg-dialog-foot">
          {currentStep === 1 ? (
            <>
              {!bridgeStatus.isConnected && (
                <Button variant="ghost" size="lg" onClick={() => setCurrentStep(2)}>
                  Skip for now (API keys only)
                </Button>
              )}
              <span className="eg-spacer" />
              <Button variant="primary" size="lg" iconRight={ArrowRight} onClick={() => setCurrentStep(2)} disabled={!bridgeStatus.isConnected}>
                Next: connect AI
              </Button>
            </>
          ) : currentStep === 2 ? (
            <>
              <span className="eg-subtle" style={{ fontSize: 'calc(12px * var(--type-scale))' }}>
                Preferences are saved locally in <code className="eg-mono" style={{ fontSize: 'calc(11px * var(--type-scale))' }}>.ergo/config/</code>
              </span>
              <span className="eg-spacer" />
              <Button variant="ghost" size="lg" iconRight={ChevronRight} onClick={() => proceedToLocalModelStep()}>
                Skip this step
              </Button>
            </>
          ) : (
            <>
              <span className="eg-subtle" style={{ fontSize: 'calc(12px * var(--type-scale))' }}>You can change this anytime in Settings.</span>
              <span className="eg-spacer" />
              <Button variant="primary" size="lg" iconRight={ArrowRight} onClick={handleLocalModelNext}>
                Open the workspace
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
