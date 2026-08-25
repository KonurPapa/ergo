import React, { useState, useEffect } from 'react';
import { type AIProviderId, type UserApiKey } from '../types';
import { SUPPORTED_AI_PROVIDERS, testAiConnection, fetchOllamaModels, type ProviderModel } from '../lib/aiProviders';
import {
  Key,
  Globe,
  X,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ExternalLink,
  Eye,
  EyeOff,
  ShieldCheck,
  Trash2,
  Check,
  HelpCircle,
  Tag,
  Zap,
  Brain,
  Sparkles,
  Edit3,
  ChevronDown,
  Sliders,
  AlertTriangle
} from 'lucide-react';

interface AiCredentialsModalProps {
  isOpen: boolean;
  onClose: () => void;
  userApiKeys: UserApiKey[];
  activeKeyId: string | null;
  onSaveUserKey: (key: Omit<UserApiKey, 'id'> & { id?: string }) => void;
  onDeleteUserKey: (id: string) => void;
  onSelectActiveKey: (id: string) => void;
  editingKey?: UserApiKey | null;
}

export const AiCredentialsModal: React.FC<AiCredentialsModalProps> = ({
  isOpen,
  onClose,
  userApiKeys,
  activeKeyId,
  onSaveUserKey,
  onDeleteUserKey,
  onSelectActiveKey,
  editingKey
}) => {
  const [keyName, setKeyName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [providerId, setProviderId] = useState<AIProviderId>('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [discoveryModel, setDiscoveryModel] = useState('');
  const [summaryModel, setSummaryModel] = useState('');
  const [generalModel, setGeneralModel] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);
  const [keyPendingDelete, setKeyPendingDelete] = useState<UserApiKey | null>(null);

  // Dynamic Model Discovery State for Cloud and Local Providers
  const [discoveredModels, setDiscoveredModels] = useState<Record<string, ProviderModel[]>>({});

  // Ollama specific connection state
  const [ollamaModels, setOllamaModels] = useState<ProviderModel[]>([]);
  const [isOllamaConnected, setIsOllamaConnected] = useState(false);
  const [isLoadingOllamaModels, setIsLoadingOllamaModels] = useState(false);

  // Custom Model Manual Input Toggle State
  const [isCustomDiscovery, setIsCustomDiscovery] = useState(false);
  const [isCustomSummary, setIsCustomSummary] = useState(false);
  const [isCustomGeneral, setIsCustomGeneral] = useState(false);

  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  const providerMeta = SUPPORTED_AI_PROVIDERS.find((p) => p.id === providerId) || SUPPORTED_AI_PROVIDERS[0];

  // Helper to retrieve the current available models for the active provider
  const getEffectiveModels = (pId: AIProviderId): ProviderModel[] => {
    if (pId === 'ollama') return ollamaModels;
    const dynamic = discoveredModels[pId];
    if (dynamic && dynamic.length > 0) return dynamic;
    const p = SUPPORTED_AI_PROVIDERS.find((item) => item.id === pId);
    return p?.models || [];
  };

  const resetForm = (pId: AIProviderId = 'openai') => {
    const p = SUPPORTED_AI_PROVIDERS.find((item) => item.id === pId) || SUPPORTED_AI_PROVIDERS[0];
    setEditingId(null);
    setKeyName('');
    setApiKey('');
    setProviderId(pId);
    setBaseUrl(p.defaultBaseUrl || '');
    setDiscoveryModel(pId === 'ollama' ? '' : p.defaultDiscoveryModel);
    setSummaryModel(pId === 'ollama' ? '' : p.defaultSummaryModel);
    setGeneralModel(pId === 'ollama' ? '' : p.defaultGeneralModel);
    setTestResult(null);
    setShowApiKey(false);
    setOllamaModels([]);
    setIsOllamaConnected(false);
    setIsCustomDiscovery(false);
    setIsCustomSummary(false);
    setIsCustomGeneral(false);
  };

  const loadKeyForEditing = async (k: UserApiKey) => {
    const p = SUPPORTED_AI_PROVIDERS.find((item) => item.id === k.provider) || SUPPORTED_AI_PROVIDERS[0];
    setEditingId(k.id);
    setKeyName(k.name);
    setApiKey(k.apiKey || '');
    setProviderId(k.provider);
    const resolvedBaseUrl = k.baseUrl || p.defaultBaseUrl || '';
    setBaseUrl(resolvedBaseUrl);
    const currentDisc = k.discoveryModel || (k.provider === 'ollama' ? '' : p.defaultDiscoveryModel);
    const currentSumm = k.summaryModel || (k.provider === 'ollama' ? '' : p.defaultSummaryModel);
    const currentGen = k.generalModel || k.model || (k.provider === 'ollama' ? '' : p.defaultGeneralModel);
    setDiscoveryModel(currentDisc);
    setSummaryModel(currentSumm);
    setGeneralModel(currentGen);
    setTestResult(null);
    setShowApiKey(false);
    setIsCustomDiscovery(false);
    setIsCustomSummary(false);
    setIsCustomGeneral(false);

    if (k.provider === 'ollama') {
      setIsLoadingOllamaModels(true);
      try {
        const fetched = await fetchOllamaModels(resolvedBaseUrl);
        setOllamaModels(fetched);
        setIsOllamaConnected(true);
        if (fetched.length > 0) {
          if (!k.discoveryModel || !fetched.some((m) => m.id === k.discoveryModel)) {
            setDiscoveryModel(fetched[0].id);
          }
          if (!k.summaryModel || !fetched.some((m) => m.id === k.summaryModel)) {
            setSummaryModel(fetched[0].id);
          }
          if (!k.generalModel || !fetched.some((m) => m.id === (k.generalModel || k.model))) {
            setGeneralModel(fetched[0].id);
          }
        }
      } catch {
        setIsOllamaConnected(false);
        setOllamaModels([]);
      } finally {
        setIsLoadingOllamaModels(false);
      }
    } else if (k.apiKey && (k.provider === 'openai' || k.provider === 'gemini')) {
      // Auto-fetch live online models for OpenAI / Gemini on load
      testAiConnection(k.provider, { apiKey: k.apiKey })
        .then((res) => {
          if (res.models && res.models.length > 0) {
            setDiscoveredModels((prev) => ({ ...prev, [k.provider]: res.models! }));
          }
        })
        .catch(() => { });
    }
  };

  useEffect(() => {
    if (isOpen) {
      if (editingKey) {
        loadKeyForEditing(editingKey);
      } else {
        resetForm('openai');
      }
      setTestResult(null);
      setShowApiKey(false);
    }
  }, [isOpen, editingKey]);

  useEffect(() => {
    if (!editingId) {
      const p = SUPPORTED_AI_PROVIDERS.find((item) => item.id === providerId);
      if (p) {
        if (providerId === 'ollama') {
          setDiscoveryModel('');
          setGeneralModel('');
          setOllamaModels([]);
          setIsOllamaConnected(false);
          // Try background check to see if local Ollama is already running on default endpoint
          const checkUrl = baseUrl || p.defaultBaseUrl || 'http://localhost:11434';
          fetchOllamaModels(checkUrl)
            .then((models) => {
              setOllamaModels(models);
              setIsOllamaConnected(true);
              if (models.length > 0) {
                setDiscoveryModel(models[0].id);
                setGeneralModel(models[0].id);
              }
            })
            .catch(() => {
              setIsOllamaConnected(false);
              setOllamaModels([]);
            });
        } else {
          setDiscoveryModel(p.defaultDiscoveryModel);
          setGeneralModel(p.defaultGeneralModel);
          setIsCustomDiscovery(false);
          setIsCustomGeneral(false);
        }
        if (p.defaultBaseUrl) setBaseUrl(p.defaultBaseUrl);
      }
    }
  }, [providerId, editingId]);

  if (!isOpen) return null;

  // Auto-detect provider when user pastes key and auto-fetch live models
  const handleApiKeyChange = (val: string) => {
    setApiKey(val);
    const trimmed = val.trim();
    let detectedProvider = providerId;
    if (!keyName || keyName.endsWith('Key') || keyName.endsWith('Ollama')) {
      if (trimmed.startsWith('sk-ant-')) {
        detectedProvider = 'anthropic';
        setProviderId('anthropic');
        if (!keyName) setKeyName('Claude');
      } else if (trimmed.startsWith('sk-proj-') || trimmed.startsWith('sk-')) {
        detectedProvider = 'openai';
        setProviderId('openai');
        if (!keyName) setKeyName('ChatGPT');
      } else if (trimmed.startsWith('AIzaSy')) {
        detectedProvider = 'gemini';
        setProviderId('gemini');
        if (!keyName) setKeyName('Gemini');
      } else if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.includes('11434')) {
        detectedProvider = 'ollama';
        setProviderId('ollama');
        if (!keyName) setKeyName('Ollama');
      }
    }

    // Auto-fetch live models from API if key has reasonable length
    if (trimmed.length > 20 && (detectedProvider === 'openai' || detectedProvider === 'gemini' || detectedProvider === 'anthropic')) {
      testAiConnection(detectedProvider, { apiKey: trimmed })
        .then((res) => {
          if (res.models && res.models.length > 0) {
            setDiscoveredModels((prev) => ({ ...prev, [detectedProvider]: res.models! }));
          }
        })
        .catch(() => { });
    }
  };

  const handleTestConnection = async () => {
    setIsTesting(true);
    setTestResult(null);
    const res = await testAiConnection(providerId, {
      apiKey: apiKey.trim(),
      baseUrl: baseUrl.trim(),
      model: generalModel || discoveryModel
    });
    setTestResult(res);

    if (res.models && res.models.length > 0) {
      if (providerId === 'ollama') {
        setOllamaModels(res.models);
        setIsOllamaConnected(true);
        if (!discoveryModel || !res.models.some((m) => m.id === discoveryModel)) {
          setDiscoveryModel(res.models[0].id);
        }
        if (!summaryModel || !res.models.some((m) => m.id === summaryModel)) {
          setSummaryModel(res.models[0].id);
        }
        if (!generalModel || !res.models.some((m) => m.id === generalModel)) {
          setGeneralModel(res.models[0].id);
        }
      } else {
        setDiscoveredModels((prev) => ({ ...prev, [providerId]: res.models! }));
      }
    } else if (providerId === 'ollama' && !res.success) {
      setIsOllamaConnected(false);
      setOllamaModels([]);
    }

    setIsTesting(false);
  };

  const handleSave = () => {
    const finalName = keyName.trim() || `${providerMeta.name} Key`;
    const effectiveList = getEffectiveModels(providerId);
    const defaultDisc = providerId === 'ollama' ? (effectiveList[0]?.id || '') : providerMeta.defaultDiscoveryModel;
    const defaultSumm = providerId === 'ollama' ? (effectiveList[0]?.id || '') : providerMeta.defaultSummaryModel;
    const defaultGen = providerId === 'ollama' ? (effectiveList[0]?.id || '') : providerMeta.defaultGeneralModel;
    const resolvedDiscovery = discoveryModel || defaultDisc;
    const resolvedSummary = summaryModel || defaultSumm;
    const resolvedGeneral = generalModel || defaultGen;

    onSaveUserKey({
      id: editingId || undefined,
      name: finalName,
      provider: providerId,
      apiKey: apiKey.trim(),
      baseUrl: baseUrl.trim(),
      discoveryModel: resolvedDiscovery,
      summaryModel: resolvedSummary,
      generalModel: resolvedGeneral,
      model: resolvedGeneral,
      isConnected: true
    });
    resetForm();
  };

  const isConfigValid = () => {
    if (providerMeta.requiresKey && !apiKey.trim()) return false;
    if (providerMeta.requiresBaseUrl && !baseUrl.trim()) return false;
    return true;
  };

  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal-content"
        style={{ maxWidth: '720px', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
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
                boxShadow: '0 2px 8px rgba(99, 102, 241, 0.3)'
              }}
            >
              <Key size={20} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <h3 style={{ fontSize: '1.15rem', fontWeight: 700, color: 'var(--text-bright)', margin: 0 }}>
                  Manage AI Keys
                </h3>
                {/* <span className="badge badge-done" style={{ fontSize: '0.65rem', padding: '0.1rem 0.35rem' }}>
                  Stored in config/secrets.json
                </span> */}
              </div>
              <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: 0 }}>
                Keys are stored locally in your secrets file and never sent to a cloud database.
              </p>
            </div>
          </div>
          <button className="btn btn-secondary" style={{ padding: '0.35rem 0.6rem' }} onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="modal-body" style={{ overflowY: 'auto', flex: 1, padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {/* Card 1: Add New / Edit API Key Form Card */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '-0.75rem' }}>
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
              {/* {editingId ? <Edit3 size={17} color="var(--accent-cyan)" /> : <Plus size={17} color="var(--accent-cyan)" />} */}
              {editingId ? 'Edit Configured API Key' : 'Add New API Key'}
            </h4>
            {editingId && (
              <button
                type="button"
                onClick={() => resetForm()}
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
              border: editingId ? '1.5px solid var(--accent-cyan)' : '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
              padding: '1.25rem',
              boxShadow: editingId ? '0 0 16px rgba(6, 182, 212, 0.15)' : 'var(--shadow-card)',
              transition: 'all 0.2s ease'
            }}
          >
            {/* Provider Selector Tabs */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.5rem', marginBottom: '1.1rem' }}>
              {SUPPORTED_AI_PROVIDERS.filter((p) => p.id !== 'mock').map((p) => {
                const isSelected = p.id === providerId;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      setProviderId(p.id);
                      if (!keyName || keyName.endsWith('Key') || keyName.endsWith('Ollama')) {
                        setKeyName(p.id === 'ollama' ? 'Local Ollama' : `${p.shortName} Key`);
                      }
                      if (!editingId) {
                        setDiscoveryModel(p.defaultDiscoveryModel);
                        setGeneralModel(p.defaultGeneralModel);
                        if (p.defaultBaseUrl) setBaseUrl(p.defaultBaseUrl);
                      }
                    }}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: '0.35rem',
                      padding: '0.65rem 0.4rem',
                      borderRadius: 'var(--radius-sm)',
                      border: `1.5px solid ${isSelected ? 'var(--accent-primary)' : 'var(--btn-secondary-border)'}`,
                      background: isSelected ? 'rgba(99, 102, 241, 0.15)' : 'var(--btn-secondary-bg)',
                      color: isSelected ? 'var(--accent-primary)' : 'var(--text-main)',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                      boxShadow: isSelected ? '0 0 10px rgba(99, 102, 241, 0.2)' : '0 1px 2px rgba(0, 0, 0, 0.04)'
                    }}
                  >
                    <div style={{ width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      {p.iconUrl ? (
                        <img
                          src={p.iconUrl}
                          alt={p.shortName}
                          style={{
                            width: '100%',
                            height: '100%',
                            objectFit: 'contain',
                            opacity: isSelected ? 1 : 0.85,
                            transition: 'opacity 0.15s ease'
                          }}
                        />
                      ) : (
                        <span style={{ fontSize: '1.2rem' }}>{p.icon}</span>
                      )}
                    </div>
                    <span style={{ fontSize: '0.76rem', fontWeight: isSelected ? 700 : 600 }}>{p.shortName}</span>
                  </button>
                );
              })}
            </div>

            {/* Field 1: Key Name */}
            <div className="input-group" style={{ marginBottom: '0.85rem' }}>
              <label className="input-label" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.3rem' }}>
                <Tag size={13} color="var(--accent-cyan)" />
                <span style={{ fontWeight: 700, color: 'var(--text-bright)' }}>Key Label</span>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>(Name to identify this key)</span>
              </label>
              <input
                type="text"
                className="input-text"
                placeholder="e.g. Work OpenAI Key, Anthropic Claude, Gemini Flash..."
                value={keyName}
                onChange={(e) => setKeyName(e.target.value)}
              />
            </div>

            {/* Field 2: API Key */}
            {providerMeta.requiresKey && (
              <div className="input-group" style={{ marginBottom: '0.85rem' }}>
                <label className="input-label" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.3rem' }}>
                  <Key size={13} color="var(--accent-amber)" />
                  <span style={{ fontWeight: 700, color: 'var(--text-bright)' }}>API Key</span>
                </label>
                <div style={{ position: 'relative' }}>
                  <input
                    type={showApiKey ? 'text' : 'password'}
                    className="input-text"
                    placeholder={providerMeta.keyPlaceholder || 'Paste your API key here (sk-...)'}
                    value={apiKey}
                    onChange={(e) => handleApiKeyChange(e.target.value)}
                    style={{ paddingRight: '2.5rem', fontFamily: 'var(--font-mono)' }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiKey(!showApiKey)}
                    style={{
                      position: 'absolute',
                      right: '0.75rem',
                      top: '50%',
                      transform: 'translateY(-50%)',
                      background: 'none',
                      border: 'none',
                      color: 'var(--text-muted)',
                      cursor: 'pointer'
                    }}
                    title={showApiKey ? 'Hide Key' : 'Show Key'}
                  >
                    {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
            )}

            {/* Field 3: Base URL for Ollama */}
            {providerMeta.requiresBaseUrl && (
              <div className="input-group" style={{ marginBottom: '0.85rem' }}>
                <label className="input-label" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.3rem' }}>
                  <Globe size={13} color="var(--accent-violet)" />
                  <span style={{ fontWeight: 700, color: 'var(--text-bright)' }}>Ollama Host Endpoint</span>
                </label>
                <input
                  type="text"
                  className="input-text"
                  placeholder="http://localhost:11434"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  style={{ fontFamily: 'var(--font-mono)' }}
                />
              </div>
            )}

            {/* Field 4 & 5: Advanced Settings (Dual Model Configuration) */}
            <div style={{ marginTop: '0.85rem' }}>
              <button
                type="button"
                onClick={() => setShowAdvancedSettings(!showAdvancedSettings)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  width: '100%',
                  background: 'var(--btn-secondary-bg)',
                  border: '1px solid var(--btn-secondary-border)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '0.55rem 0.75rem',
                  color: 'var(--text-bright)',
                  cursor: 'pointer',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  transition: 'all 0.15s ease'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                  <Sliders size={14} color="var(--accent-cyan)" />
                  <span>Advanced Settings</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  {!showAdvancedSettings && (
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                      {providerId === 'ollama' ? (
                        isOllamaConnected ? (
                          ollamaModels.length > 0 ? (
                            `${discoveryModel || 'Select'} • ${summaryModel || 'Select'} • ${generalModel || 'Select'}`
                          ) : (
                            'Connected (No models)'
                          )
                        ) : (
                          'Not connected (Click Test Connection)'
                        )
                      ) : (
                        `${getEffectiveModels(providerId).find((m) => m.id === discoveryModel)?.name || discoveryModel || providerMeta.defaultDiscoveryModel} • ${getEffectiveModels(providerId).find((m) => m.id === summaryModel)?.name || summaryModel || providerMeta.defaultSummaryModel} • ${getEffectiveModels(providerId).find((m) => m.id === generalModel)?.name || generalModel || providerMeta.defaultGeneralModel}`
                      )}
                    </span>
                  )}
                  <ChevronDown
                    size={14}
                    style={{
                      transform: showAdvancedSettings ? 'rotate(180deg)' : 'rotate(0deg)',
                      transition: 'transform 0.2s ease',
                      color: 'var(--text-muted)'
                    }}
                  />
                </div>
              </button>

              {showAdvancedSettings && (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                    gap: '0.85rem',
                    marginTop: '0.5rem',
                    padding: '0.85rem',
                    background: 'var(--bg-pane)',
                    border: '1px solid var(--btn-secondary-border)',
                    borderRadius: 'var(--radius-sm)'
                  }}
                >
                  {/* Discovery Model */}
                  <div className="input-group" style={{ margin: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.35rem' }}>
                      <label className="input-label" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', margin: 0 }}>
                        <Zap size={13} color="var(--accent-amber)" />
                        <span style={{ fontWeight: 700, color: 'var(--text-bright)', fontSize: '0.82rem' }}>Discovery Model</span>
                        <span
                          style={{
                            fontSize: '0.62rem',
                            padding: '0.05rem 0.35rem',
                            borderRadius: '4px',
                            background: 'rgba(245, 158, 11, 0.15)',
                            color: 'var(--accent-amber)',
                            fontWeight: 600
                          }}
                        >
                          Lighter / Fast
                        </span>
                      </label>
                      <button
                        type="button"
                        onClick={() => setIsCustomDiscovery(!isCustomDiscovery)}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: 'var(--accent-cyan)',
                          fontSize: '0.68rem',
                          cursor: 'pointer',
                          textDecoration: 'underline',
                          padding: 0
                        }}
                      >
                        {isCustomDiscovery ? 'Select Preset' : 'Custom ID'}
                      </button>
                    </div>
                    <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', lineHeight: 1.25, display: 'block', marginBottom: '0.4rem' }}>
                      Scans task headers across lanes & archives
                    </span>

                    {isCustomDiscovery ? (
                      <input
                        type="text"
                        className="input-text"
                        placeholder="e.g. gpt-4.5-preview, claude-3-7-sonnet-20250219..."
                        value={discoveryModel}
                        onChange={(e) => setDiscoveryModel(e.target.value)}
                        style={{ fontSize: '0.82rem', fontFamily: 'var(--font-mono)' }}
                      />
                    ) : providerId === 'ollama' ? (
                      <div>
                        <select
                          className="input-text"
                          value={discoveryModel || providerMeta.defaultDiscoveryModel}
                          onChange={(e) => setDiscoveryModel(e.target.value)}
                          disabled={!isOllamaConnected || ollamaModels.length === 0 || isLoadingOllamaModels}
                          style={{
                            cursor: (!isOllamaConnected || ollamaModels.length === 0) ? 'not-allowed' : 'pointer',
                            fontSize: '0.82rem',
                            opacity: (!isOllamaConnected || ollamaModels.length === 0) ? 0.75 : 1
                          }}
                        >
                          {isLoadingOllamaModels ? (
                            <option value="">Checking local Ollama...</option>
                          ) : !isOllamaConnected ? (
                            <option value="">Click 'Test Connection' to discover local models</option>
                          ) : ollamaModels.length === 0 ? (
                            <option value="">No models installed locally</option>
                          ) : (
                            <>
                              {!discoveryModel && <option value="">Select a local model...</option>}
                              {ollamaModels.map((m) => (
                                <option key={`disc-ollama-${m.id}`} value={m.id}>
                                  {m.name}
                                </option>
                              ))}
                            </>
                          )}
                        </select>
                        {!isOllamaConnected && !isLoadingOllamaModels && (
                          <span style={{ display: 'block', fontSize: '0.68rem', color: 'var(--accent-amber)', marginTop: '0.3rem' }}>
                            Click "Test Connection" to see your local models
                          </span>
                        )}
                        {isOllamaConnected && ollamaModels.length === 0 && (
                          <span style={{ display: 'block', fontSize: '0.68rem', color: 'var(--accent-amber)', marginTop: '0.3rem' }}>
                            No models found. Run <code style={{ color: 'var(--text-bright)' }}>ollama pull llama3</code> in terminal.
                          </span>
                        )}
                      </div>
                    ) : (
                      <select
                        className="input-text"
                        value={discoveryModel || providerMeta.defaultDiscoveryModel}
                        onChange={(e) => setDiscoveryModel(e.target.value)}
                        style={{ cursor: 'pointer', fontSize: '0.82rem' }}
                      >
                        {getEffectiveModels(providerId).map((m) => (
                          <option key={`disc-${m.id}`} value={m.id}>
                            {m.name} {m.id === providerMeta.defaultDiscoveryModel ? '(Default)' : ''}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>

                  {/* Summary Model */}
                  <div className="input-group" style={{ margin: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.35rem' }}>
                      <label className="input-label" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', margin: 0 }}>
                        <Sparkles size={13} color="var(--accent-violet)" />
                        <span style={{ fontWeight: 700, color: 'var(--text-bright)', fontSize: '0.82rem' }}>Summary Model</span>
                        <span
                          style={{
                            fontSize: '0.62rem',
                            padding: '0.05rem 0.35rem',
                            borderRadius: '4px',
                            background: 'rgba(168, 85, 247, 0.15)',
                            color: 'var(--accent-violet)',
                            fontWeight: 600
                          }}
                        >
                          Standard / Balanced
                        </span>
                      </label>
                      <button
                        type="button"
                        onClick={() => setIsCustomSummary(!isCustomSummary)}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: 'var(--accent-cyan)',
                          fontSize: '0.68rem',
                          cursor: 'pointer',
                          textDecoration: 'underline',
                          padding: 0
                        }}
                      >
                        {isCustomSummary ? 'Select Preset' : 'Custom ID'}
                      </button>
                    </div>
                    <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', lineHeight: 1.25, display: 'block', marginBottom: '0.4rem' }}>
                      Synthesizes Overview & defines MCP requirements
                    </span>

                    {isCustomSummary ? (
                      <input
                        type="text"
                        className="input-text"
                        placeholder="e.g. claude-3-7-sonnet-20250219, gpt-5, gemini-3.7-flash..."
                        value={summaryModel}
                        onChange={(e) => setSummaryModel(e.target.value)}
                        style={{ fontSize: '0.82rem', fontFamily: 'var(--font-mono)' }}
                      />
                    ) : providerId === 'ollama' ? (
                      <div>
                        <select
                          className="input-text"
                          value={summaryModel || providerMeta.defaultSummaryModel}
                          onChange={(e) => setSummaryModel(e.target.value)}
                          disabled={!isOllamaConnected || ollamaModels.length === 0 || isLoadingOllamaModels}
                          style={{
                            cursor: (!isOllamaConnected || ollamaModels.length === 0) ? 'not-allowed' : 'pointer',
                            fontSize: '0.82rem',
                            opacity: (!isOllamaConnected || ollamaModels.length === 0) ? 0.75 : 1
                          }}
                        >
                          {isLoadingOllamaModels ? (
                            <option value="">Checking local Ollama...</option>
                          ) : !isOllamaConnected ? (
                            <option value="">Click 'Test Connection' to discover local models</option>
                          ) : ollamaModels.length === 0 ? (
                            <option value="">No models installed locally</option>
                          ) : (
                            <>
                              {!summaryModel && <option value="">Select a local model...</option>}
                              {ollamaModels.map((m) => (
                                <option key={`summ-ollama-${m.id}`} value={m.id}>
                                  {m.name}
                                </option>
                              ))}
                            </>
                          )}
                        </select>
                      </div>
                    ) : (
                      <select
                        className="input-text"
                        value={summaryModel || providerMeta.defaultSummaryModel}
                        onChange={(e) => setSummaryModel(e.target.value)}
                        style={{ cursor: 'pointer', fontSize: '0.82rem' }}
                      >
                        {getEffectiveModels(providerId).map((m) => (
                          <option key={`summ-${m.id}`} value={m.id}>
                            {m.name} {m.id === providerMeta.defaultSummaryModel ? '(Default)' : ''}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>

                  {/* Tasks Model */}
                  <div className="input-group" style={{ margin: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.35rem' }}>
                      <label className="input-label" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', margin: 0 }}>
                        <Brain size={13} color="var(--accent-cyan)" />
                        <span style={{ fontWeight: 700, color: 'var(--text-bright)', fontSize: '0.82rem' }}>Tasks Model</span>
                        <span
                          style={{
                            fontSize: '0.62rem',
                            padding: '0.05rem 0.35rem',
                            borderRadius: '4px',
                            background: 'rgba(6, 182, 212, 0.15)',
                            color: 'var(--accent-cyan)',
                            fontWeight: 600
                          }}
                        >
                          Mid / High Intelligence
                        </span>
                      </label>
                      <button
                        type="button"
                        onClick={() => setIsCustomGeneral(!isCustomGeneral)}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: 'var(--accent-cyan)',
                          fontSize: '0.68rem',
                          cursor: 'pointer',
                          textDecoration: 'underline',
                          padding: 0
                        }}
                      >
                        {isCustomGeneral ? 'Select Preset' : 'Custom ID'}
                      </button>
                    </div>
                    <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', lineHeight: 1.25, display: 'block', marginBottom: '0.4rem' }}>
                      Used for planning and running tasks
                    </span>

                    {isCustomGeneral ? (
                      <input
                        type="text"
                        className="input-text"
                        placeholder="e.g. gpt-4.5-preview, o3-mini, claude-3-7-sonnet-20250219..."
                        value={generalModel}
                        onChange={(e) => setGeneralModel(e.target.value)}
                        style={{ fontSize: '0.82rem', fontFamily: 'var(--font-mono)' }}
                      />
                    ) : providerId === 'ollama' ? (
                      <div>
                        <select
                          className="input-text"
                          value={generalModel}
                          onChange={(e) => setGeneralModel(e.target.value)}
                          disabled={!isOllamaConnected || ollamaModels.length === 0 || isLoadingOllamaModels}
                          style={{
                            cursor: (!isOllamaConnected || ollamaModels.length === 0) ? 'not-allowed' : 'pointer',
                            fontSize: '0.82rem',
                            opacity: (!isOllamaConnected || ollamaModels.length === 0) ? 0.75 : 1
                          }}
                        >
                          {isLoadingOllamaModels ? (
                            <option value="">Checking local Ollama...</option>
                          ) : !isOllamaConnected ? (
                            <option value="">Click 'Test Connection' to discover local models</option>
                          ) : ollamaModels.length === 0 ? (
                            <option value="">No models installed locally</option>
                          ) : (
                            <>
                              {!generalModel && <option value="">Select a local model...</option>}
                              {ollamaModels.map((m) => (
                                <option key={`gen-ollama-${m.id}`} value={m.id}>
                                  {m.name}
                                </option>
                              ))}
                            </>
                          )}
                        </select>
                        {!isOllamaConnected && !isLoadingOllamaModels && (
                          <span style={{ display: 'block', fontSize: '0.68rem', color: 'var(--accent-amber)', marginTop: '0.3rem' }}>
                            Click "Test Connection" to see your local models
                          </span>
                        )}
                        {isOllamaConnected && ollamaModels.length === 0 && (
                          <span style={{ display: 'block', fontSize: '0.68rem', color: 'var(--accent-amber)', marginTop: '0.3rem' }}>
                            No models found. Run <code style={{ color: 'var(--text-bright)' }}>ollama pull qwen2.5-coder</code> in terminal.
                          </span>
                        )}
                      </div>
                    ) : (
                      <select
                        className="input-text"
                        value={generalModel || providerMeta.defaultGeneralModel}
                        onChange={(e) => setGeneralModel(e.target.value)}
                        style={{ cursor: 'pointer', fontSize: '0.82rem' }}
                      >
                        {getEffectiveModels(providerId).map((m) => (
                          <option key={`gen-${m.id}`} value={m.id}>
                            {m.name} {m.id === providerMeta.defaultGeneralModel ? '(Default)' : ''}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Action Bar inside form */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '1.1rem' }}>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={handleTestConnection}
                disabled={isTesting || !isConfigValid()}
                style={{ fontSize: '0.82rem' }}
              >
                {isTesting ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    <span>Testing...</span>
                  </>
                ) : (
                  <span>Test Connection</span>
                )}
              </button>
              <button
                className="btn btn-primary"
                type="button"
                onClick={handleSave}
                disabled={!isConfigValid()}
                style={{ fontSize: '0.82rem' }}
              >
                <ShieldCheck size={16} />
                <span>{editingId ? 'Save Changes' : 'Save AI Key'}</span>
              </button>
            </div>

            {/* Connection Test Banner */}
            {testResult && (
              <div
                style={{
                  marginTop: '1rem',
                  padding: '0.75rem 0.9rem',
                  borderRadius: 'var(--radius-md)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.65rem',
                  fontSize: '0.82rem',
                  background: testResult.success ? 'rgba(16, 185, 129, 0.12)' : 'rgba(244, 63, 94, 0.12)',
                  border: `1px solid ${testResult.success ? 'rgba(16, 185, 129, 0.3)' : 'rgba(244, 63, 94, 0.3)'}`,
                  color: testResult.success ? 'var(--accent-emerald)' : 'var(--accent-rose)'
                }}
              >
                {testResult.success ? <CheckCircle2 size={16} style={{ flexShrink: 0 }} /> : <AlertCircle size={16} style={{ flexShrink: 0 }} />}
                <span>{testResult.message}</span>
              </div>
            )}
          </div>

          {/* Card 2: Configured API Keys List (Listed Directly Below the Add Form Card) */}
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
                Configured API Keys ({userApiKeys.length})
              </h4>
              {userApiKeys.length > 0 && (
                <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                  Click 'Edit' to adjust discovery/general models
                </span>
              )}
            </div>

            {userApiKeys.length === 0 ? (
              <div
                style={{
                  padding: '1.5rem',
                  textAlign: 'center',
                  background: 'var(--bg-dark)',
                  border: '1px dashed var(--border-subtle)',
                  borderRadius: 'var(--radius-md)'
                }}
              >
                <Key size={28} color="var(--text-muted)" style={{ margin: '0 auto 0.5rem auto', opacity: 0.6 }} />
                <p style={{ fontSize: '0.84rem', color: '#fff', fontWeight: 600, margin: '0 0 0.25rem 0' }}>
                  No API keys added yet
                </p>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: 0 }}>
                  Add your OpenAI, Anthropic, Gemini, or Ollama credentials in the card above to activate AI features.
                </p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                {userApiKeys.map((k) => {
                  const isActive = k.id === activeKeyId;
                  const isCurrentlyEditing = k.id === editingId;
                  const pMeta = SUPPORTED_AI_PROVIDERS.find((p) => p.id === k.provider);
                  const effectiveList = getEffectiveModels(k.provider);
                  const effectiveDiscModel = k.discoveryModel || pMeta?.defaultDiscoveryModel || 'Default';
                  const effectiveSummModel = k.summaryModel || pMeta?.defaultSummaryModel || 'Default';
                  const effectiveGenModel = k.generalModel || k.model || pMeta?.defaultGeneralModel || 'Default';
                  const discModelName = effectiveList.find((m) => m.id === effectiveDiscModel)?.name || pMeta?.models.find((m) => m.id === effectiveDiscModel)?.name || effectiveDiscModel;
                  const summModelName = effectiveList.find((m) => m.id === effectiveSummModel)?.name || pMeta?.models.find((m) => m.id === effectiveSummModel)?.name || effectiveSummModel;
                  const genModelName = effectiveList.find((m) => m.id === effectiveGenModel)?.name || pMeta?.models.find((m) => m.id === effectiveGenModel)?.name || effectiveGenModel;

                  return (
                    <div
                      key={k.id}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '0.6rem',
                        padding: '0.85rem 1rem',
                        background: 'var(--bg-card)',
                        border: `1.5px solid ${isCurrentlyEditing
                          ? 'var(--accent-cyan)'
                          : isActive
                            ? 'var(--accent-cyan)'
                            : 'var(--border-subtle)'
                          }`,
                        borderRadius: 'var(--radius-md)',
                        boxShadow: isActive ? '0 0 10px rgba(6, 182, 212, 0.12)' : 'var(--shadow-card)',
                        transition: 'all 0.15s ease'
                      }}
                    >
                      {/* Top Row: Provider info, Name, Active Badge & Action Buttons */}
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                          <div style={{ width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                            {pMeta?.iconUrl ? (
                              <img src={pMeta.iconUrl} alt={pMeta.shortName} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                            ) : (
                              <span style={{ fontSize: '1.2rem' }}>{pMeta?.icon || '🔑'}</span>
                            )}
                          </div>
                          <div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                              <span style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--text-bright)' }}>{k.name}</span>
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
                                {pMeta?.shortName || k.provider}
                              </span>
                              {isActive && (
                                <span
                                  className="badge badge-done"
                                  style={{
                                    fontSize: '0.65rem',
                                    background: 'rgba(6, 182, 212, 0.2)',
                                    color: 'var(--accent-cyan)',
                                    borderColor: 'var(--accent-cyan)'
                                  }}
                                >
                                  Active Key
                                </span>
                              )}
                              {isCurrentlyEditing && (
                                <span
                                  className="badge"
                                  style={{
                                    fontSize: '0.65rem',
                                    background: 'rgba(245, 158, 11, 0.2)',
                                    color: 'var(--accent-amber)',
                                    borderColor: 'var(--accent-amber)'
                                  }}
                                >
                                  Editing Above
                                </span>
                              )}
                            </div>
                            <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                              {k.provider === 'ollama'
                                ? k.baseUrl || 'http://localhost:11434'
                                : k.apiKey
                                  ? `${k.apiKey.slice(0, 7)}...${k.apiKey.slice(-4)}`
                                  : 'No Key'}
                            </span>
                          </div>
                        </div>

                        {/* Action Buttons */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                          {!isActive && (
                            <button
                              type="button"
                              className="btn btn-secondary"
                              style={{ padding: '0.25rem 0.55rem', fontSize: '0.75rem' }}
                              onClick={() => onSelectActiveKey(k.id)}
                            >
                              <Check size={12} />
                              Use Key
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn-secondary"
                            style={{
                              padding: '0.25rem 0.55rem',
                              fontSize: '0.75rem',
                              background: isCurrentlyEditing ? 'rgba(6, 182, 212, 0.15)' : undefined,
                              borderColor: isCurrentlyEditing ? 'var(--accent-cyan)' : undefined,
                              color: isCurrentlyEditing ? 'var(--accent-cyan)' : undefined
                            }}
                            onClick={() => loadKeyForEditing(k)}
                          >
                            <Edit3 size={12} />
                            Edit
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            style={{
                              padding: '0.25rem 0.45rem',
                              fontSize: '0.75rem',
                              color: 'var(--accent-rose)',
                              borderColor: 'rgba(244, 63, 94, 0.3)'
                            }}
                            onClick={() => setKeyPendingDelete(k)}
                            title="Delete Key"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>

                      {/* Bottom Row: Configured Models Display */}
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          flexWrap: 'wrap',
                          gap: '0.65rem',
                          paddingTop: '0.4rem',
                          borderTop: '1px solid var(--border-subtle)',
                          fontSize: '0.72rem'
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', color: 'var(--text-muted)' }}>
                          <Zap size={12} color="var(--accent-amber)" />
                          <span>Discovery:</span>
                          <span style={{ fontWeight: 600, color: 'var(--text-bright)', background: 'var(--btn-secondary-bg)', border: '1px solid var(--btn-secondary-border)', padding: '0.1rem 0.4rem', borderRadius: '4px' }}>
                            {discModelName}
                          </span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', color: 'var(--text-muted)' }}>
                          <Sparkles size={12} color="var(--accent-violet)" />
                          <span>Summary:</span>
                          <span style={{ fontWeight: 600, color: 'var(--text-bright)', background: 'var(--btn-secondary-bg)', border: '1px solid var(--btn-secondary-border)', padding: '0.1rem 0.4rem', borderRadius: '4px' }}>
                            {summModelName}
                          </span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', color: 'var(--text-muted)' }}>
                          <Brain size={12} color="var(--accent-cyan)" />
                          <span>Task / Builder:</span>
                          <span style={{ fontWeight: 600, color: 'var(--text-bright)', background: 'var(--btn-secondary-bg)', border: '1px solid var(--btn-secondary-border)', padding: '0.1rem 0.4rem', borderRadius: '4px' }}>
                            {genModelName}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Card 3: Dedicated Section: Don't know where to get an API key? */}
          <div
            style={{
              padding: '1.1rem 1.25rem',
              background: 'rgba(99, 102, 241, 0.06)',
              border: '1px solid rgba(99, 102, 241, 0.2)',
              borderRadius: 'var(--radius-md)'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.4rem' }}>
              <HelpCircle size={18} color="var(--accent-cyan)" />
              <h4 style={{ fontSize: '0.92rem', fontWeight: 700, color: 'var(--text-bright)', margin: 0 }}>
                Don't know where to get an API key?
              </h4>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '0 0 0.85rem 0' }}>
              Access the developer dashboard of your AI provider to create or copy an API key:
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.6rem' }}>
              <a
                href="https://platform.openai.com/api-keys"
                target="_blank"
                rel="noreferrer"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '0.6rem 0.85rem',
                  background: 'var(--btn-secondary-bg)',
                  border: '1px solid var(--btn-secondary-border)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-bright)',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  textDecoration: 'none',
                  transition: 'all 0.15s ease'
                }}
                className="provider-key-link"
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: '0.55rem' }}>
                  <img src="/icons/providers/openai.svg" alt="OpenAI" style={{ width: 16, height: 16, objectFit: 'contain' }} />
                  <span>OpenAI API Keys</span>
                </span>
                <ExternalLink size={13} color="var(--accent-cyan)" />
              </a>

              <a
                href="https://console.anthropic.com/settings/keys"
                target="_blank"
                rel="noreferrer"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '0.6rem 0.85rem',
                  background: 'var(--btn-secondary-bg)',
                  border: '1px solid var(--btn-secondary-border)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-bright)',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  textDecoration: 'none',
                  transition: 'all 0.15s ease'
                }}
                className="provider-key-link"
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: '0.55rem' }}>
                  <img src="/icons/providers/anthropic.svg" alt="Anthropic" style={{ width: 16, height: 16, objectFit: 'contain' }} />
                  <span>Anthropic Keys</span>
                </span>
                <ExternalLink size={13} color="var(--accent-cyan)" />
              </a>

              <a
                href="https://aistudio.google.com/app/apikey"
                target="_blank"
                rel="noreferrer"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '0.6rem 0.85rem',
                  background: 'var(--btn-secondary-bg)',
                  border: '1px solid var(--btn-secondary-border)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-bright)',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  textDecoration: 'none',
                  transition: 'all 0.15s ease'
                }}
                className="provider-key-link"
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: '0.55rem' }}>
                  <img src="/icons/providers/gemini.svg" alt="Gemini" style={{ width: 16, height: 16, objectFit: 'contain' }} />
                  <span>Google Gemini Keys</span>
                </span>
                <ExternalLink size={13} color="var(--accent-cyan)" />
              </a>

              <a
                href="https://ollama.com"
                target="_blank"
                rel="noreferrer"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '0.6rem 0.85rem',
                  background: 'var(--btn-secondary-bg)',
                  border: '1px solid var(--btn-secondary-border)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-bright)',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  textDecoration: 'none',
                  transition: 'all 0.15s ease'
                }}
                className="provider-key-link"
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: '0.55rem' }}>
                  <img src="/icons/providers/ollama.svg" alt="Ollama" style={{ width: 16, height: 16, objectFit: 'contain' }} />
                  <span>Ollama Local AI</span>
                </span>
                <ExternalLink size={13} color="var(--accent-cyan)" />
              </a>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="modal-footer">
          <button className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>

      {/* Irreversible Delete Warning Confirmation Dialog */}
      {keyPendingDelete && (
        <div
          className="modal-overlay"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.8)',
            backdropFilter: 'blur(5px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1200
          }}
          onClick={() => setKeyPendingDelete(null)}
        >
          <div
            className="modal-content"
            style={{
              maxWidth: '450px',
              width: '90%',
              background: 'var(--bg-card)',
              border: '1px solid rgba(244, 63, 94, 0.45)',
              borderRadius: 'var(--radius-md)',
              padding: '1.5rem',
              boxShadow: '0 20px 40px rgba(0, 0, 0, 0.7), 0 0 25px rgba(244, 63, 94, 0.2)'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem', marginBottom: '1rem' }}>
              <div
                style={{
                  width: '42px',
                  height: '42px',
                  borderRadius: '10px',
                  background: 'rgba(244, 63, 94, 0.15)',
                  border: '1px solid rgba(244, 63, 94, 0.35)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--accent-rose)',
                  flexShrink: 0
                }}
              >
                <AlertTriangle size={22} />
              </div>
              <div>
                <h4 style={{ fontSize: '1.05rem', fontWeight: 700, color: '#fff', margin: 0 }}>
                  Delete API Key?
                </h4>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  Irreversible action confirmation
                </span>
              </div>
            </div>

            <p style={{ fontSize: '0.86rem', color: 'var(--text-main)', margin: '0 0 0.85rem 0', lineHeight: 1.45 }}>
              Are you sure you want to disconnect and delete <strong style={{ color: '#fff' }}>"{keyPendingDelete.name}"</strong>?
            </p>

            <div
              style={{
                padding: '0.75rem 0.95rem',
                borderRadius: 'var(--radius-sm)',
                background: 'rgba(244, 63, 94, 0.1)',
                border: '1px solid rgba(244, 63, 94, 0.3)',
                fontSize: '0.78rem',
                color: '#fca5a5',
                lineHeight: 1.45,
                marginBottom: '1.25rem'
              }}
            >
              ⚠️ <strong>This action is irreversible.</strong> The stored API key credentials and model configurations will be permanently removed from your workspace settings (<code style={{ color: '#fff', fontSize: '0.74rem' }}>config/secrets.json</code>).
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.65rem' }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setKeyPendingDelete(null)}
                style={{ padding: '0.45rem 0.9rem', fontSize: '0.82rem' }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn"
                style={{
                  background: 'var(--accent-rose)',
                  borderColor: 'var(--accent-rose)',
                  color: '#fff',
                  padding: '0.45rem 1rem',
                  fontSize: '0.82rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
                onClick={() => {
                  onDeleteUserKey(keyPendingDelete.id);
                  if (editingId === keyPendingDelete.id) {
                    resetForm();
                  }
                  setKeyPendingDelete(null);
                }}
              >
                <Trash2 size={14} />
                <span>Delete Permanently</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
