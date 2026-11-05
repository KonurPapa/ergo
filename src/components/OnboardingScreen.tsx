import React, { useState, useEffect, useRef } from 'react';
import { getPref, removePref } from '../lib/userPrefs';
import { type AIProviderId, type UserApiKey } from '../types';
import {
  fetchCliAuthStatus,
  installCli,
  triggerCliLogin,
  testAiConnection,
  type CliAuthStatus
} from '../lib/aiProviders';
import { AgentTerminal } from './AgentTerminal';
import { ResizableTerminalContainer } from './ResizableTerminalContainer';
import {
  isLocalModelInstalled,
  useLocalModelInstall,
  type LocalModelMode
} from './LocalModelSetup';
import { bridgeClient, type BridgeStatus, BRIDGE_LAUNCH_URL, DEFAULT_BRIDGE_URL, getBridgeDownload } from '../lib/bridgeClient';
import {
  Check,
  ArrowRight,
  ArrowLeft,
  ArrowUpRight,
  Plug,
  Cpu,
  Download,
  Folder,
  Shield,
  Hash,
  Terminal,
  ChevronDown,
  ChevronRight,
  Loader2,
  Copy,
  ExternalLink,
  RefreshCw,
  AlertCircle,
  MoreHorizontal
} from 'lucide-react';

export interface OnboardingScreenProps {
  isOpen: boolean;
  onClose: () => void;
  onSaveUserKey: (key: Omit<UserApiKey, 'id'> & { id?: string }) => void;
  onResetSubscription?: (cliAgentId: string) => void;
  onCompleteOnboarding: (key?: UserApiKey) => void;
  /** Local AI model preference ('unset' until the user picks or Settings). */
  localModelMode?: LocalModelMode;
  onSetLocalModelMode?: (mode: 'local' | 'cloud') => void;
  /** What "Skip" uses instead, e.g. "Claude Haiku". */
  tinyCloudModelLabel?: string;
}

export type ProviderChoice = 'claude' | 'codex' | 'gemini' | 'other';

interface ProviderConfig {
  id: ProviderChoice;
  name: string;
  subPlan: string;
  iconUrl?: string;
  cli: string;
  cliName: string;
  packageName: string;
  loginArgs: string[];
}

const PROVIDERS: ProviderConfig[] = [
  {
    id: 'claude',
    name: 'Claude',
    subPlan: 'Pro or Max plan',
    iconUrl: '/icons/providers/anthropic.svg',
    cli: 'claude',
    cliName: 'Claude',
    packageName: '@anthropic-ai/claude-code',
    loginArgs: ['login']
  },
  {
    id: 'codex',
    name: 'ChatGPT',
    subPlan: 'Plus or Pro plan',
    iconUrl: '/icons/providers/openai.svg',
    cli: 'codex',
    cliName: 'OpenAI Codex CLI',
    packageName: '@openai/codex',
    loginArgs: ['login']
  },
  {
    id: 'gemini',
    name: 'Gemini',
    subPlan: 'Google AI plan',
    iconUrl: '/icons/providers/gemini.svg',
    cli: 'agy',
    cliName: 'Antigravity CLI (agy)',
    packageName: 'Antigravity Suite',
    loginArgs: []
  },
  {
    id: 'other',
    name: 'Other',
    subPlan: 'OpenRouter, Cursor, Grok…',
    iconUrl: '',
    cli: '',
    cliName: 'Other Provider',
    packageName: '',
    loginArgs: []
  }
];

const STEPS = ['Bridge', 'AI', 'Local model'] as const;

export const OnboardingScreen: React.FC<OnboardingScreenProps> = ({
  isOpen,
  onClose,
  onSaveUserKey,
  onResetSubscription: _onResetSubscription,
  onCompleteOnboarding,
  localModelMode = 'unset',
  onSetLocalModelMode,
  tinyCloudModelLabel
}) => {
  // 3-step sequence: 0 = Bridge, 1 = AI, 2 = Local Model
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [slideDir, setSlideDir] = useState<1 | -1>(1);
  const [hasRenderedStep, setHasRenderedStep] = useState<number>(-1);

  // Step 1: Bridge state
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>(() => bridgeClient.getStatus());
  const [showAdvancedBridge, setShowAdvancedBridge] = useState(false);
  const [bridgePortInput, setBridgePortInput] = useState<string>(() => {
    try {
      const url = new URL(bridgeClient.getBridgeUrl() || DEFAULT_BRIDGE_URL);
      return url.port || '5174';
    } catch {
      return '5174';
    }
  });
  const [isTestingBridge, setIsTestingBridge] = useState(false);
  const [bridgeConnectError, setBridgeConnectError] = useState<string | null>(null);
  const [copiedBridgeCmd, setCopiedBridgeCmd] = useState(false);

  // Step 2: AI state
  const [mode, setMode] = useState<'sub' | 'key'>('sub');
  const [provider, setProvider] = useState<ProviderChoice>('claude');
  const [authStatus, setAuthStatus] = useState<CliAuthStatus | null>(null);
  const [isCheckingAuth, setIsCheckingAuth] = useState(false);
  const [isConnectingSubscription, setIsConnectingSubscription] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [geminiTerminalActive, setGeminiTerminalActive] = useState<boolean>(false);
  const [geminiTerminalSessionId, setGeminiTerminalSessionId] = useState<string>(`gemini-auth-${Date.now()}`);
  const [loginAuthUrl, setLoginAuthUrl] = useState<string | null>(null);
  const [connectedUserKey, setConnectedUserKey] = useState<UserApiKey | null>(null);

  // API Key mode
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [apiKeyProvider, setApiKeyProvider] = useState<AIProviderId>('anthropic');
  const [isValidatingKey, setIsValidatingKey] = useState(false);
  const [keyValidationError, setKeyValidationError] = useState<string | null>(null);

  // Step 3: Local Model state
  const localModel = useLocalModelInstall({
    enabled: isOpen && step === 2,
    onInstalled: () => onSetLocalModelMode?.('local')
  });

  const pollingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentProvider = PROVIDERS.find((p) => p.id === provider) || PROVIDERS[0];

  // Reset to step 0 on open
  useEffect(() => {
    if (isOpen) {
      setStep(0);
      setSlideDir(1);
      setHasRenderedStep(-1);
    }
  }, [isOpen]);

  // Subscribe to bridge status
  useEffect(() => {
    const unsub = bridgeClient.subscribe((status) => {
      setBridgeStatus(status);
    });
    return unsub;
  }, []);

  // Poll for bridge while looking in step 0
  useEffect(() => {
    if (!isOpen || step !== 0 || bridgeStatus.isConnected || !bridgeClient.isHostedWeb()) return;
    const timer = setInterval(() => {
      bridgeClient.checkConnection().catch(() => {});
    }, 2500);
    return () => clearInterval(timer);
  }, [isOpen, step, bridgeStatus.isConnected]);

  // Check provider CLI auth status
  const checkStatus = async (cliName: string) => {
    if (!cliName) {
      setAuthStatus(null);
      return;
    }
    setIsCheckingAuth(true);
    try {
      const isExplicitlyDisconnected = getPref(`ergo_disconnected_${provider}`) === 'true';
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
        }
      }
    } catch {
      // Ignored
    } finally {
      setIsCheckingAuth(false);
    }
  };

  useEffect(() => {
    if (isOpen && mode === 'sub') {
      setLoginError(null);
      if (currentProvider.cli) {
        checkStatus(currentProvider.cli);
      } else {
        setAuthStatus(null);
      }
    }
  }, [isOpen, mode, provider]);

  // Clean up polling on unmount
  useEffect(() => {
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, []);

  if (!isOpen) return null;

  const navigateTo = (nextStep: 0 | 1 | 2) => {
    setSlideDir(nextStep > step ? 1 : -1);
    setStep(nextStep);
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

  // Connect subscription
  const handleConnectSubscription = async () => {
    if (provider === 'other') {
      navigateTo(2);
      return;
    }

    try {
      removePref(`ergo_disconnected_${provider}`);
    } catch {}

    setIsConnectingSubscription(true);
    setLoginError(null);

    try {
      if (authStatus?.isInstalled && authStatus.isAuthenticated) {
        const newKey: UserApiKey = {
          id: `key_sub_${Date.now()}`,
          name: `${currentProvider.name} (${authStatus?.userEmail || 'Subscription'})`,
          provider: 'cli_subscription',
          apiKey: 'cli_subscription_active',
          authMode: 'cli_subscription',
          cliAgentId: currentProvider.id === 'gemini' ? 'antigravity' : currentProvider.id === 'codex' ? 'codex' : 'claude-code',
          cliExecutionMode: 'interactive',
          model: currentProvider.id === 'gemini' ? 'antigravity' : currentProvider.id === 'codex' ? 'codex' : 'claude-code',
          isConnected: true,
          createdAt: new Date().toISOString()
        };
        setConnectedUserKey(newKey);
        onSaveUserKey(newKey);
        navigateTo(2);
        return;
      }

      if (!authStatus?.isInstalled) {
        const res = await installCli(currentProvider.cli);
        const refreshed = await fetchCliAuthStatus(currentProvider.cli);
        setAuthStatus(refreshed);

        if (!refreshed.isInstalled && !res.success) {
          setLoginError(res.error || `Ergo couldn’t install ${currentProvider.packageName} automatically. You can also connect with an API key.`);
          setIsConnectingSubscription(false);
          return;
        }
      }

      if (currentProvider.id === 'gemini') {
        setGeminiTerminalActive(true);
        setGeminiTerminalSessionId(`gemini-auth-${Date.now()}`);
      } else {
        const loginRes = await triggerCliLogin(currentProvider.cli);
        if (!loginRes.success || loginRes.error) {
          setLoginError(loginRes.error || `Could not launch login for ${currentProvider.name}.`);
          setIsConnectingSubscription(false);
          return;
        }

        if (loginRes.authUrl) {
          setLoginAuthUrl(loginRes.authUrl);
          const popup = window.open(loginRes.authUrl, 'ai_auth_window', 'width=650,height=750,noopener,noreferrer');
          if (!popup) {
            setLoginError('The browser blocked the sign-in window. Use “Open sign-in window” below.');
          }
        }
      }

      if (pollingRef.current) clearInterval(pollingRef.current);
      const pollStartTime = Date.now();
      pollingRef.current = setInterval(async () => {
        if (Date.now() - pollStartTime > 90_000) {
          if (pollingRef.current) clearInterval(pollingRef.current);
          setIsConnectingSubscription(false);
          setLoginError(`Sign-in is taking longer than expected. Try clicking “Connect ${currentProvider.name}” again.`);
          return;
        }

        const st = await fetchCliAuthStatus(currentProvider.cli);
        if (st.isAuthenticated) {
          if (pollingRef.current) clearInterval(pollingRef.current);
          setAuthStatus(st);
          setIsConnectingSubscription(false);
          setLoginError(null);

          const newKey: UserApiKey = {
            id: `key_sub_${Date.now()}`,
            name: `${currentProvider.name} (${st.userEmail || 'Subscription'})`,
            provider: 'cli_subscription',
            apiKey: 'cli_subscription_active',
            authMode: 'cli_subscription',
            cliAgentId: currentProvider.id === 'gemini' ? 'antigravity' : currentProvider.id === 'codex' ? 'codex' : 'claude-code',
            cliExecutionMode: 'interactive',
            model: currentProvider.id === 'gemini' ? 'antigravity' : currentProvider.id === 'codex' ? 'codex' : 'claude-code',
            isConnected: true,
            createdAt: new Date().toISOString()
          };
          setConnectedUserKey(newKey);
          onSaveUserKey(newKey);
          navigateTo(2);
        }
      }, 2000);
    } catch (err: any) {
      setLoginError(err.message || 'Sign-in stopped unexpectedly. Try again.');
      setIsConnectingSubscription(false);
    }
  };

  const handleApiKeyChange = (val: string) => {
    setApiKeyInput(val);
    setKeyValidationError(null);
    const trimmed = val.trim();
    if (trimmed.startsWith('sk-ant-')) {
      setApiKeyProvider('anthropic');
    } else if (trimmed.startsWith('sk-proj-') || trimmed.startsWith('sk-')) {
      setApiKeyProvider('openai');
    } else if (trimmed.startsWith('AIzaSy')) {
      setApiKeyProvider('gemini');
    } else if (trimmed.startsWith('http://') || trimmed.includes('11434')) {
      setApiKeyProvider('ollama');
    }
  };

  const handleConnectApiKey = async () => {
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
        name: `${currentProvider.name} Key`,
        provider: apiKeyProvider,
        apiKey: trimmed,
        authMode: 'api_key',
        model: apiKeyProvider === 'gemini' ? 'gemini-2.5-flash' : undefined,
        isConnected: true,
        createdAt: new Date().toISOString()
      };

      setConnectedUserKey(newKey);
      onSaveUserKey(newKey);
      navigateTo(2);
    } catch (err: any) {
      setKeyValidationError(err.message || 'Ergo couldn’t reach the provider to verify the key.');
    } finally {
      setIsValidatingKey(false);
    }
  };

  const handleUseCloudModel = () => {
    onSetLocalModelMode?.('cloud');
    handleFinish();
  };

  const handleFinish = () => {
    if (localModel.installRequested && localModel.status?.state === 'installing') {
      onSetLocalModelMode?.('local');
    } else if (localModelMode === 'unset' && !isLocalModelInstalled(localModel.status)) {
      onSetLocalModelMode?.('cloud');
    }
    onCompleteOnboarding(connectedUserKey || undefined);
  };

  // Bridge detection flags
  const isBridgeOk = bridgeStatus.isConnected;
  const bridgeDownload = getBridgeDownload();
  const bridgePort = (() => {
    try {
      const url = new URL(bridgeStatus.url || bridgeClient.getBridgeUrl() || DEFAULT_BRIDGE_URL);
      return url.port || '5174';
    } catch {
      return '5174';
    }
  })();

  const appFolder = bridgeStatus.appDir || '';
  const launchCmd = appFolder ? `cd "${appFolder}" && npm run dev` : `ergo-bridge start --port ${bridgePort}`;

  // Local model status flags
  const isModelInstalled = isLocalModelInstalled(localModel.status);
  const isModelBusy = localModel.status?.state === 'installing' || localModel.busy === 'install';
  const modelBytesDone = localModel.status?.bytesDone ?? 0;
  const modelBytesTotal = localModel.status?.bytesTotal || 509 * 1024 * 1024;
  const modelPct = modelBytesTotal > 0 ? Math.max(0, Math.min(100, Math.round((modelBytesDone / modelBytesTotal) * 100))) : 0;
  const modelMbDone = Math.round(modelBytesDone / (1024 * 1024));

  const isPanelStatic = hasRenderedStep === step;

  return (
    <div className="eg-onb" role="dialog" aria-modal="true" aria-label="First-run setup">
      {/* Top Header */}
      <header className="eg-onb-top">
        <span className="eg-onb-brand">
          <span className="eg-brand-mark" aria-hidden="true">E</span>
          Ergo
        </span>
        <button
          type="button"
          className="eg-btn eg-btn-ghost"
          id="skipall"
          onClick={onClose}
        >
          Set up later
        </button>
      </header>

      {/* Main 560px column */}
      <main className="eg-onb-main">
        {/* Progress bars with step names */}
        <nav className="eg-onb-steps" aria-label="Setup steps" id="steps">
          {STEPS.map((s, i) => {
            const isDone = i < step;
            const isCurrent = i === step;
            const className = `eg-onb-step ${isDone ? 'is-done' : ''} ${isCurrent ? 'is-current' : ''}`.trim();
            return (
              <button
                key={s}
                type="button"
                className={className}
                data-go={i}
                aria-current={isCurrent ? 'step' : undefined}
                onClick={() => {
                  if (isDone) navigateTo(i as 0 | 1 | 2);
                }}
              >
                <span className="eg-onb-bar">
                  <i />
                </span>
                {i + 1} · {s}
              </button>
            );
          })}
        </nav>

        {/* Step Panel */}
        <div id="panel">
          <div
            className={`eg-onb-panel ${isPanelStatic ? 'is-static' : slideDir < 0 ? 'is-back' : ''}`}
            key={step}
          >
            {/* ──────── STEP 1: Connect Ergo to this computer (Bridge) ──────── */}
            {step === 0 && (
              <>
                <div className="eg-onb-eyebrow">Step 1 of 3</div>
                <h1 className="eg-onb-title">Connect Ergo to this computer</h1>
                <p className="eg-onb-lede">
                  Ergo Bridge is a small helper app. It lets Ergo use your AI subscription, read your project files and run tools — all locally.
                </p>

                <div className="eg-onb-body">
                  <div className="eg-onb-status">
                    <span className={`eg-onb-orb ${isBridgeOk ? 'is-ok' : 'is-searching'}`}>
                      {isBridgeOk ? <Check size={22} strokeWidth={2.25} /> : <Plug size={22} strokeWidth={1.75} />}
                    </span>
                    <div>
                      {isBridgeOk ? (
                        <>
                          <div className="eg-onb-status-title">Ergo Bridge is running</div>
                          <div className="eg-onb-status-text">
                            Connected at <code>localhost:{bridgePort}</code>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="eg-onb-status-title">Looking for Ergo Bridge…</div>
                          <div className="eg-onb-status-text">
                            Not installed yet?{' '}
                            {bridgeDownload ? (
                              <a
                                href={bridgeDownload.url}
                                download
                                style={{ color: 'var(--accent-text)', textDecoration: 'none' }}
                              >
                                Download for {bridgeDownload.platform}
                              </a>
                            ) : (
                              <a
                                href={BRIDGE_LAUNCH_URL}
                                style={{ color: 'var(--accent-text)', textDecoration: 'none' }}
                              >
                                Already installed? Open it
                              </a>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  </div>

                  {bridgeConnectError && (
                    <div style={{ fontSize: 12, color: 'var(--warning)', marginTop: -4 }}>
                      {bridgeConnectError}
                    </div>
                  )}

                  <button
                    type="button"
                    className="eg-onb-disclose"
                    id="adv"
                    onClick={() => setShowAdvancedBridge((prev) => !prev)}
                  >
                    {showAdvancedBridge ? <ChevronDown size={14} strokeWidth={1.75} /> : <ChevronRight size={14} strokeWidth={1.75} />}
                    Advanced: port and launch command
                  </button>

                  {showAdvancedBridge && (
                    <div className="eg-onb-facts">
                      <div style={{ gap: 8, alignItems: 'center' }}>
                        <Hash size={14} strokeWidth={1.75} />
                        <span>Port</span>
                        <input
                          type="text"
                          value={bridgePortInput}
                          onChange={(e) => {
                            const cleaned = e.target.value.replace(/\D/g, '').slice(0, 5);
                            setBridgePortInput(cleaned);
                            bridgeClient.setBridgeUrl(getFullBridgeUrl(cleaned));
                          }}
                          className="eg-input eg-input-mono"
                          style={{ width: 80, height: 26, padding: '0 6px', fontSize: 12 }}
                          aria-label="Bridge port"
                        />
                        <button
                          type="button"
                          className="eg-btn eg-btn-ghost eg-btn-sm"
                          onClick={() => handleTestBridgeConnection(bridgePortInput)}
                          disabled={isTestingBridge}
                          style={{ height: 26 }}
                        >
                          {isTestingBridge ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                          Check
                        </button>
                      </div>
                      <div style={{ justifyContent: 'space-between' }}>
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                          <Terminal size={14} strokeWidth={1.75} />
                          <code>{launchCmd}</code>
                        </div>
                        <button
                          type="button"
                          className="eg-btn eg-btn-ghost eg-btn-sm"
                          onClick={() => {
                            navigator.clipboard.writeText(launchCmd);
                            setCopiedBridgeCmd(true);
                            setTimeout(() => setCopiedBridgeCmd(false), 2000);
                          }}
                          style={{ height: 24, fontSize: 11 }}
                        >
                          {copiedBridgeCmd ? <Check size={12} /> : <Copy size={12} />}
                          {copiedBridgeCmd ? 'Copied' : 'Copy'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}

            {/* ──────── STEP 2: Choose the AI that does the work ──────── */}
            {step === 1 && (
              <>
                <div className="eg-onb-eyebrow">Step 2 of 3</div>
                <h1 className="eg-onb-title">Choose the AI that does the work</h1>
                <p className="eg-onb-lede">
                  Use a plan you already pay for, or an API key billed per use. You can add more later.
                </p>

                <div className="eg-onb-body">
                  {/* Segmented control: My subscription / API key */}
                  <div className="eg-seg" role="radiogroup" style={{ alignSelf: 'flex-start' }}>
                    <button
                      type="button"
                      className="eg-seg-item"
                      role="radio"
                      data-mode="sub"
                      aria-checked={mode === 'sub'}
                      onClick={() => setMode('sub')}
                    >
                      My subscription
                    </button>
                    <button
                      type="button"
                      className="eg-seg-item"
                      role="radio"
                      data-mode="key"
                      aria-checked={mode === 'key'}
                      onClick={() => setMode('key')}
                    >
                      API key
                    </button>
                  </div>

                  {/* 2x2 Provider tiles */}
                  <div className="eg-onb-tiles" role="radiogroup" aria-label="Provider">
                    {PROVIDERS.map((p) => {
                      const isSelected = p.id === provider;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          className="eg-onb-tile"
                          role="radio"
                          data-prov={p.id}
                          aria-checked={isSelected}
                          onClick={() => {
                            setProvider(p.id);
                            setLoginError(null);
                            setGeminiTerminalActive(false);
                            if (mode === 'key') {
                              if (p.id === 'claude') setApiKeyProvider('anthropic');
                              else if (p.id === 'codex') setApiKeyProvider('openai');
                              else if (p.id === 'gemini') setApiKeyProvider('gemini');
                            }
                          }}
                        >
                          <span className="eg-onb-tile-mark">
                            {p.iconUrl ? (
                              <img
                                src={p.iconUrl}
                                alt=""
                                className="eg-onb-tile-icon"
                                width={20}
                                height={20}
                              />
                            ) : (
                              <MoreHorizontal size={18} strokeWidth={2} style={{ color: 'var(--ink-subtle)' }} />
                            )}
                          </span>
                          <span>
                            <span className="eg-onb-tile-name" style={{ display: 'block' }}>
                              {p.name}
                            </span>
                            <span className="eg-onb-tile-sub">
                              {mode === 'sub' ? p.subPlan : 'Paste a key'}
                            </span>
                          </span>
                          <span className="eg-onb-tile-check">
                            <Check size={12} strokeWidth={2.5} />
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  {/* Mode-specific content */}
                  {mode === 'key' ? (
                    <label className="eg-field" style={{ marginTop: 4 }}>
                      <span className="eg-field-label">{currentProvider.name} API key</span>
                      <input
                        className={`eg-input eg-input-mono ${keyValidationError ? 'is-invalid' : ''}`}
                        style={{ height: 40 }}
                        type="password"
                        placeholder="Paste your key"
                        value={apiKeyInput}
                        onChange={(e) => handleApiKeyChange(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleConnectApiKey();
                        }}
                      />
                      {keyValidationError ? (
                        <span className="eg-field-error" role="alert">
                          <AlertCircle size={13} strokeWidth={1.75} />
                          {keyValidationError}
                        </span>
                      ) : (
                        <span className="eg-field-help">
                          Stored in ~/.ergo/config, never sent anywhere but {currentProvider.name}.
                        </span>
                      )}
                    </label>
                  ) : (
                    <>
                      <div className="eg-onb-facts">
                        <div>
                          <Shield size={14} strokeWidth={1.75} />
                          <span>You sign in on {currentProvider.name}'s own page. Ergo never sees your password.</span>
                        </div>
                        {isCheckingAuth && (
                          <div style={{ color: 'var(--ink-subtle)' }}>
                            <Loader2 size={13} className="animate-spin" />
                            <span>Checking connection…</span>
                          </div>
                        )}
                        {authStatus?.isInstalled && authStatus.isAuthenticated && (
                          <div style={{ color: 'var(--success)' }}>
                            <Check size={14} strokeWidth={2} />
                            <span>
                              Connected to your {currentProvider.name} subscription
                              {authStatus.userEmail ? ` (${authStatus.userEmail})` : ''}.
                            </span>
                          </div>
                        )}
                        {loginError && (
                          <div style={{ color: 'var(--warning)' }}>
                            <AlertCircle size={14} strokeWidth={1.75} />
                            <span>{loginError}</span>
                          </div>
                        )}
                      </div>

                      {/* Gemini CLI interactive terminal console */}
                      {provider === 'gemini' && (isConnectingSubscription || geminiTerminalActive) && (
                        <div style={{ borderTop: '1px solid var(--line)', paddingTop: 'var(--space-2)' }}>
                          <p style={{ margin: '0 0 var(--space-2)', fontSize: 12, color: 'var(--ink-muted)' }}>
                            Sign in through the console below. Follow the prompt:
                          </p>
                          <ResizableTerminalContainer
                            defaultHeight={220}
                            minHeight={150}
                            maxHeight={400}
                            storageKey="ergo_terminal_height_onboarding"
                            style={{
                              border: '1px solid var(--line)',
                              borderRadius: 'var(--radius-md)',
                              overflow: 'hidden'
                            }}
                            headerLeft={
                              <div className="eg-hstack" style={{ gap: 6, fontSize: 12, color: 'var(--ink-muted)' }}>
                                <Terminal size={14} strokeWidth={1.75} />
                                <span>Sign in · {currentProvider.cliName}</span>
                              </div>
                            }
                          >
                            <AgentTerminal
                              key={geminiTerminalSessionId}
                              cmd={currentProvider.cli}
                              args={currentProvider.loginArgs}
                              cwd="~"
                              sessionId={geminiTerminalSessionId}
                              forceRestart={true}
                              killOnUnmount={true}
                              onExit={(code) => {
                                if (code === 0) {
                                  checkStatus(currentProvider.cli);
                                }
                              }}
                            />
                          </ResizableTerminalContainer>
                        </div>
                      )}

                      {/* OAuth popup helper */}
                      {isConnectingSubscription && loginAuthUrl && (
                        <div className="eg-hstack" style={{ fontSize: 12, color: 'var(--ink-subtle)' }}>
                          <span>Sign-in window didn't open?</span>
                          <a href={loginAuthUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-text)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            Open sign-in window
                            <ExternalLink size={12} strokeWidth={1.75} />
                          </a>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </>
            )}

            {/* ──────── STEP 3: Add a small local model (optional) ──────── */}
            {step === 2 && (
              <>
                <div className="eg-onb-eyebrow">Step 3 of 3 · Optional</div>
                <h1 className="eg-onb-title">Add a small local model</h1>
                <p className="eg-onb-lede">
                  Qwen 2.5 Coder 0.5B runs on this computer for quick background decisions and autocomplete. What it reads stays here.
                </p>

                <div className="eg-onb-body">
                  <div className="eg-onb-status" style={{ alignItems: 'flex-start' }}>
                    <span className={`eg-onb-orb ${isModelInstalled ? 'is-ok' : isModelBusy ? 'is-searching' : ''}`}>
                      {isModelInstalled ? <Check size={22} strokeWidth={2.25} /> : <Cpu size={22} strokeWidth={1.75} />}
                    </span>
                    <div style={{ flex: 1 }}>
                      {isModelInstalled ? (
                        <>
                          <div className="eg-onb-status-title">Installed</div>
                          <div className="eg-onb-status-text">It starts automatically when Ergo needs it.</div>
                        </>
                      ) : isModelBusy ? (
                        <>
                          <div className="eg-onb-status-title">Downloading… {modelPct}%</div>
                          <div className="eg-onb-status-text">
                            {modelMbDone} of 509 MB · you can continue meanwhile
                          </div>
                          <div className="eg-onb-meter">
                            <i style={{ width: `${modelPct}%` }} />
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="eg-onb-status-title">509 MB download</div>
                          <div className="eg-onb-status-text">Model 491 MB + runner 18 MB</div>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="eg-onb-facts">
                    <div>
                      <Folder size={14} strokeWidth={1.75} />
                      <span>
                        Saved in <code>~/.ergo/local-model</code>
                      </span>
                    </div>
                    <div>
                      <Shield size={14} strokeWidth={1.75} />
                      <span>No admin rights needed · remove it anytime in Settings</span>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Footer: Back, Skip and 40px Primary Action */}
        <div className="eg-onb-foot">
          {step > 0 ? (
            <button
              type="button"
              className="eg-btn eg-btn-ghost eg-btn-lg"
              id="back"
              onClick={() => navigateTo((step - 1) as 0 | 1)}
            >
              <ArrowLeft size={16} strokeWidth={1.75} />
              Back
            </button>
          ) : (
            <div style={{ visibility: 'hidden' }}>
              <button type="button" className="eg-btn eg-btn-ghost eg-btn-lg">
                <ArrowLeft size={16} strokeWidth={1.75} />
                Back
              </button>
            </div>
          )}

          <span className="eg-spacer" />

          {/* Skip button: hidden on step 0, and hidden on step 2 once download begins */}
          {step === 1 ? (
            <button
              type="button"
              className="eg-btn eg-btn-ghost eg-btn-lg"
              id="skip"
              onClick={() => navigateTo(2)}
            >
              Skip
            </button>
          ) : step === 2 && !isModelBusy && !isModelInstalled ? (
            <button
              type="button"
              className="eg-btn eg-btn-ghost eg-btn-lg"
              id="skip"
              title={tinyCloudModelLabel ? `Use ${tinyCloudModelLabel} instead` : undefined}
              onClick={handleUseCloudModel}
            >
              Skip
            </button>
          ) : null}

          {/* Primary next action */}
          {step === 0 && (
            <button
              type="button"
              className="eg-btn eg-btn-primary eg-btn-lg"
              id="next"
              disabled={!isBridgeOk}
              onClick={() => navigateTo(1)}
            >
              Continue
              <ArrowRight size={16} strokeWidth={1.75} />
            </button>
          )}

          {step === 1 && (
            <button
              type="button"
              className="eg-btn eg-btn-primary eg-btn-lg"
              id="next"
              disabled={mode === 'key' ? isValidatingKey || !apiKeyInput.trim() : isConnectingSubscription}
              onClick={mode === 'key' ? handleConnectApiKey : handleConnectSubscription}
            >
              {mode === 'key' ? (
                <>
                  {isValidatingKey && <Loader2 size={14} strokeWidth={2} className="animate-spin" />}
                  {isValidatingKey ? 'Checking key…' : 'Save key'}
                  <ArrowRight size={16} strokeWidth={1.75} />
                </>
              ) : provider === 'other' ? (
                <>
                  I'll set this up later
                  <ArrowRight size={16} strokeWidth={1.75} />
                </>
              ) : isConnectingSubscription ? (
                <>
                  <Loader2 size={14} strokeWidth={2} className="animate-spin" />
                  Connecting {currentProvider.name}…
                </>
              ) : authStatus?.isInstalled && authStatus.isAuthenticated ? (
                <>
                  Continue
                  <ArrowRight size={16} strokeWidth={1.75} />
                </>
              ) : (
                <>
                  Connect {currentProvider.name}
                  <ArrowUpRight size={16} strokeWidth={1.75} />
                </>
              )}
            </button>
          )}

          {step === 2 && (
            <button
              type="button"
              className="eg-btn eg-btn-primary eg-btn-lg"
              id="next"
              onClick={() => {
                if (!isModelInstalled && !isModelBusy) {
                  localModel.install();
                } else {
                  handleFinish();
                }
              }}
            >
              {!isModelInstalled && !isModelBusy ? (
                <>
                  Download
                  <Download size={16} strokeWidth={1.75} />
                </>
              ) : (
                <>
                  Open the workspace
                  <ArrowRight size={16} strokeWidth={1.75} />
                </>
              )}
            </button>
          )}
        </div>
      </main>

      {/* Single bottom privacy note */}
      <footer className="eg-onb-note">
        Everything stays on this computer, in <code>~/.ergo</code>. You can change any of this later in Settings.
      </footer>
    </div>
  );
};
