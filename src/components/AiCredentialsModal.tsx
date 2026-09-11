import React, { useState, useEffect } from 'react';
import { type AIProviderId, type AgentRole, type UserApiKey, type CliDetectedAgent } from '../types';
import {
  SUPPORTED_AI_PROVIDERS,
  AGENT_ROLES,
  AGENT_ROLE_INFO,
  getDefaultModelForRole,
  testAiConnection,
  fetchOllamaModels,
  fetchDetectedCliAgents,
  type ProviderModel
} from '../lib/aiProviders';
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
  AlertTriangle,
  Info,
  ShieldAlert,
  FileText,
  Wrench,
  Layers,
  Cpu,
  Terminal
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

interface RoleFormState {
  provider: AIProviderId;
  model: string;
  isCustom?: boolean;
}

const ROLE_ICONS: Record<AgentRole, React.ReactNode> = {
  discovery: <Zap size={14} color="var(--accent-amber)" />,
  summary: <Sparkles size={14} color="var(--accent-violet)" />,
  manager: <Brain size={14} color="var(--accent-cyan)" />,
  worker: <Cpu size={14} color="var(--accent-primary)" />,
  cleaner: <Wrench size={14} color="var(--accent-emerald)" />,
  hardener: <ShieldAlert size={14} color="var(--accent-rose)" />,
  logger: <FileText size={14} color="var(--accent-cyan)" />
};

function getScoreBadgeStyle(score: number): { bg: string; color: string; border: string } {
  if (score >= 8.5) {
    return {
      bg: 'rgba(245, 158, 11, 0.15)',
      color: 'var(--accent-amber)',
      border: 'rgba(245, 158, 11, 0.3)'
    };
  }
  if (score >= 6.0) {
    return {
      bg: 'rgba(6, 182, 212, 0.15)',
      color: 'var(--accent-cyan)',
      border: 'rgba(6, 182, 212, 0.3)'
    };
  }
  return {
    bg: 'rgba(16, 185, 129, 0.15)',
    color: 'var(--accent-emerald)',
    border: 'rgba(16, 185, 129, 0.3)'
  };
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
  const [showApiKey, setShowApiKey] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);
  const [keyPendingDelete, setKeyPendingDelete] = useState<UserApiKey | null>(null);

  // Per-Agent Role Configurations
  const [roleConfigs, setRoleConfigs] = useState<Record<AgentRole, RoleFormState>>(() => {
    const init: any = {};
    for (const role of AGENT_ROLES) {
      init[role] = {
        provider: 'openai',
        model: getDefaultModelForRole('openai', role),
        isCustom: false
      };
    }
    return init;
  });

  // Multi-Provider Keys Map
  const [providerKeys, setProviderKeys] = useState<Partial<Record<AIProviderId, { apiKey?: string; baseUrl?: string }>>>({
    openai: { apiKey: '', baseUrl: '' },
    anthropic: { apiKey: '', baseUrl: '' },
    gemini: { apiKey: '', baseUrl: '' },
    ollama: { apiKey: '', baseUrl: 'http://localhost:11434' }
  });

  // Dynamic Model Discovery State
  const [discoveredModels, setDiscoveredModels] = useState<Record<string, ProviderModel[]>>({});
  const [ollamaModels, setOllamaModels] = useState<ProviderModel[]>([]);
  const [isOllamaConnected, setIsOllamaConnected] = useState(false);

  // Active Tooltip Info State
  const [activeTooltipRole, setActiveTooltipRole] = useState<AgentRole | null>(null);

  // Subscription / CLI State
  const [detectedCliAgents, setDetectedCliAgents] = useState<CliDetectedAgent[]>([]);
  const [isDetectingCli, setIsDetectingCli] = useState(false);
  const [selectedCliId, setSelectedCliId] = useState<string>('claude-code');
  const [customCliCommand, setCustomCliCommand] = useState<string>('');
  const [cliExecutionMode, setCliExecutionMode] = useState<'interactive' | 'headless'>('interactive');
  const [copiedInstallCmd, setCopiedInstallCmd] = useState<string | null>(null);

  // Primary Provider Test State
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  // Individual Provider Test States
  const [testingProviders, setTestingProviders] = useState<Partial<Record<AIProviderId, boolean>>>({});
  const [providerTestResults, setProviderTestResults] = useState<Partial<Record<AIProviderId, { success: boolean; message: string }>>>({});

  const providerMeta = SUPPORTED_AI_PROVIDERS.find((p) => p.id === providerId) || SUPPORTED_AI_PROVIDERS[0];

  const getEffectiveModels = (pId: AIProviderId): ProviderModel[] => {
    if (pId === 'ollama') return ollamaModels;
    const dynamic = discoveredModels[pId];
    if (dynamic && dynamic.length > 0) return dynamic;
    const p = SUPPORTED_AI_PROVIDERS.find((item) => item.id === pId);
    return p?.models || [];
  };

  const initRoleConfigsForProvider = (pId: AIProviderId): Record<AgentRole, RoleFormState> => {
    const res: any = {};
    for (const role of AGENT_ROLES) {
      res[role] = {
        provider: pId,
        model: getDefaultModelForRole(pId, role),
        isCustom: false
      };
    }
    return res;
  };

  const resetForm = (pId: AIProviderId = 'openai') => {
    const p = SUPPORTED_AI_PROVIDERS.find((item) => item.id === pId) || SUPPORTED_AI_PROVIDERS[0];
    setEditingId(null);
    setKeyName('');
    setApiKey('');
    setProviderId(pId);
    setBaseUrl(p.defaultBaseUrl || '');
    setRoleConfigs(initRoleConfigsForProvider(pId));
    setProviderKeys({
      openai: { apiKey: '', baseUrl: '' },
      anthropic: { apiKey: '', baseUrl: '' },
      gemini: { apiKey: '', baseUrl: '' },
      ollama: { apiKey: '', baseUrl: 'http://localhost:11434' }
    });
    setTestResult(null);
    setProviderTestResults({});
    setShowApiKey(false);
    setOllamaModels([]);
    setIsOllamaConnected(false);
    setActiveTooltipRole(null);
    setSelectedCliId('claude-code');
    setCustomCliCommand('');
    setCliExecutionMode('interactive');
  };

  const loadKeyForEditing = async (k: UserApiKey) => {
    const p = SUPPORTED_AI_PROVIDERS.find((item) => item.id === k.provider) || SUPPORTED_AI_PROVIDERS[0];
    setEditingId(k.id);
    setKeyName(k.name);
    setApiKey(k.apiKey || '');
    setSelectedCliId(k.cliAgentId || 'claude-code');
    setCustomCliCommand(k.cliCustomCommand || '');
    setCliExecutionMode(k.cliExecutionMode || 'interactive');
    setProviderId(k.provider);
    const resolvedBaseUrl = k.baseUrl || p.defaultBaseUrl || '';
    setBaseUrl(resolvedBaseUrl);

    // Build role configs from saved roleConfigs or legacy fields
    const loadedRoles: any = {};
    for (const role of AGENT_ROLES) {
      const explicit = k.roleConfigs?.[role];
      if (explicit) {
        loadedRoles[role] = {
          provider: explicit.provider || k.provider,
          model: explicit.model || getDefaultModelForRole(explicit.provider || k.provider, role),
          isCustom: false
        };
      } else {
        // Fallback to legacy fields
        let legacyModel = '';
        if (role === 'discovery') legacyModel = k.discoveryModel || '';
        else if (role === 'summary') legacyModel = k.summaryModel || '';
        else if (role === 'manager') legacyModel = k.generalModel || k.model || '';
        else if (role === 'worker') legacyModel = k.workerModel || k.generalModel || k.model || '';
        else if (role === 'cleaner') legacyModel = k.cleanerModel || '';
        else if (role === 'hardener') legacyModel = k.hardenerModel || k.generalModel || k.model || '';
        else if (role === 'logger') legacyModel = k.loggerModel || '';

        loadedRoles[role] = {
          provider: k.provider,
          model: legacyModel || getDefaultModelForRole(k.provider, role),
          isCustom: false
        };
      }
    }
    setRoleConfigs(loadedRoles);

    // Multi-provider keys
    const mergedKeys: Partial<Record<AIProviderId, { apiKey?: string; baseUrl?: string }>> = {
      openai: { apiKey: '', baseUrl: '' },
      anthropic: { apiKey: '', baseUrl: '' },
      gemini: { apiKey: '', baseUrl: '' },
      ollama: { apiKey: '', baseUrl: 'http://localhost:11434' },
      ...(k.providerKeys || {})
    };
    if (k.provider) {
      mergedKeys[k.provider] = {
        apiKey: k.apiKey || mergedKeys[k.provider]?.apiKey || '',
        baseUrl: k.baseUrl || mergedKeys[k.provider]?.baseUrl || ''
      };
    }
    setProviderKeys(mergedKeys);

    setTestResult(null);
    setProviderTestResults({});
    setShowApiKey(false);

    if (k.provider === 'ollama' || Object.values(loadedRoles).some((r: any) => r.provider === 'ollama')) {
      try {
        const fetched = await fetchOllamaModels(resolvedBaseUrl || 'http://localhost:11434');
        setOllamaModels(fetched);
        setIsOllamaConnected(true);
      } catch {
        setIsOllamaConnected(false);
        setOllamaModels([]);
      }
    }

    // Auto-fetch models for key
    if (k.apiKey && (k.provider === 'openai' || k.provider === 'gemini')) {
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

      // Trigger automatic background detection of local CLI agents
      setIsDetectingCli(true);
      fetchDetectedCliAgents()
        .then((res) => {
          setDetectedCliAgents(res.agents);
          setIsDetectingCli(false);
        })
        .catch(() => setIsDetectingCli(false));
    }
  }, [isOpen, editingKey]);

  if (!isOpen) return null;

  // Auto-detect provider when user pastes key
  const handleApiKeyChange = (val: string) => {
    setApiKey(val);
    const trimmed = val.trim();
    let detectedProvider = providerId;
    if (!keyName || keyName.endsWith('Profile') || keyName.endsWith('Key') || keyName.endsWith('Ollama')) {
      if (trimmed.startsWith('sk-ant-')) {
        detectedProvider = 'anthropic';
        setProviderId('anthropic');
        if (!keyName) setKeyName('Claude Profile');
        setRoleConfigs(initRoleConfigsForProvider('anthropic'));
      } else if (trimmed.startsWith('sk-proj-') || trimmed.startsWith('sk-')) {
        detectedProvider = 'openai';
        setProviderId('openai');
        if (!keyName) setKeyName('OpenAI Profile');
        setRoleConfigs(initRoleConfigsForProvider('openai'));
      } else if (trimmed.startsWith('AIzaSy')) {
        detectedProvider = 'gemini';
        setProviderId('gemini');
        if (!keyName) setKeyName('Gemini Profile');
        setRoleConfigs(initRoleConfigsForProvider('gemini'));
      } else if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.includes('11434')) {
        detectedProvider = 'ollama';
        setProviderId('ollama');
        if (!keyName) setKeyName('Local Ollama Profile');
        setRoleConfigs(initRoleConfigsForProvider('ollama'));
      }
    }

    // Keep providerKeys synced
    setProviderKeys((prev) => ({
      ...prev,
      [detectedProvider]: {
        ...prev[detectedProvider],
        apiKey: val,
        baseUrl: prev[detectedProvider]?.baseUrl || ''
      }
    }));

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

  const handlePrimaryProviderChange = (pId: AIProviderId) => {
    setProviderId(pId);
    const pMeta = SUPPORTED_AI_PROVIDERS.find((p) => p.id === pId);
    if (!keyName || keyName.endsWith('Profile') || keyName.endsWith('Key') || keyName.endsWith('Ollama')) {
      setKeyName(pId === 'ollama' ? 'Local Ollama Profile' : `${pMeta?.shortName || pId} Profile`);
    }
    // Pull primary key/url from providerKeys if already entered
    const existing = providerKeys[pId];
    if (existing?.apiKey) setApiKey(existing.apiKey);
    if (existing?.baseUrl) setBaseUrl(existing.baseUrl);
    else if (pMeta?.defaultBaseUrl) setBaseUrl(pMeta.defaultBaseUrl);

    // Auto-update all agent roles to defaults of this provider
    setRoleConfigs(initRoleConfigsForProvider(pId));

    if (pId === 'cli_subscription') {
      if (!keyName || keyName.endsWith('Profile') || keyName.endsWith('Key')) {
        setKeyName('Subscription Profile');
      }
      setIsDetectingCli(true);
      fetchDetectedCliAgents(customCliCommand)
        .then((res) => {
          setDetectedCliAgents(res.agents);
          setIsDetectingCli(false);
        })
        .catch(() => setIsDetectingCli(false));
    }

    if (pId === 'ollama') {
      const checkUrl = existing?.baseUrl || baseUrl || pMeta?.defaultBaseUrl || 'http://localhost:11434';
      fetchOllamaModels(checkUrl)
        .then((models) => {
          setOllamaModels(models);
          setIsOllamaConnected(true);
        })
        .catch(() => {
          setIsOllamaConnected(false);
          setOllamaModels([]);
        });
    }
  };

  const handleRoleProviderChange = (role: AgentRole, newPId: AIProviderId) => {
    const defaultModel = getDefaultModelForRole(newPId, role);
    setRoleConfigs((prev) => ({
      ...prev,
      [role]: {
        ...prev[role],
        provider: newPId,
        model: defaultModel,
        isCustom: false
      }
    }));

    if (newPId === 'ollama' && ollamaModels.length === 0) {
      const checkUrl = providerKeys.ollama?.baseUrl || baseUrl || 'http://localhost:11434';
      fetchOllamaModels(checkUrl)
        .then((models) => {
          setOllamaModels(models);
          setIsOllamaConnected(true);
        })
        .catch(() => { });
    }
  };

  const handleRoleModelChange = (role: AgentRole, newModel: string) => {
    setRoleConfigs((prev) => ({
      ...prev,
      [role]: {
        ...prev[role],
        model: newModel
      }
    }));
  };

  const handleRoleCustomToggle = (role: AgentRole) => {
    setRoleConfigs((prev) => ({
      ...prev,
      [role]: {
        ...prev[role],
        isCustom: !prev[role].isCustom
      }
    }));
  };

  const handleProviderKeyChange = (pId: AIProviderId, field: 'apiKey' | 'baseUrl', value: string) => {
    setProviderKeys((prev) => ({
      ...prev,
      [pId]: {
        ...prev[pId],
        [field]: value
      }
    }));
    if (pId === providerId) {
      if (field === 'apiKey') setApiKey(value);
      if (field === 'baseUrl') setBaseUrl(value);
    }
  };

  const handleTestProvider = async (pId: AIProviderId) => {
    setTestingProviders((prev) => ({ ...prev, [pId]: true }));
    setProviderTestResults((prev) => ({ ...prev, [pId]: undefined }));

    const keyEntry = providerKeys[pId];
    const effectiveKey = pId === providerId ? (apiKey.trim() || keyEntry?.apiKey?.trim() || '') : (keyEntry?.apiKey?.trim() || '');
    const effectiveBaseUrl = pId === providerId ? (baseUrl.trim() || keyEntry?.baseUrl?.trim() || '') : (keyEntry?.baseUrl?.trim() || '');

    const res = await testAiConnection(pId, {
      apiKey: effectiveKey,
      baseUrl: effectiveBaseUrl,
      model: roleConfigs.manager?.provider === pId ? roleConfigs.manager.model : undefined
    });

    setProviderTestResults((prev) => ({ ...prev, [pId]: res }));

    if (res.models && res.models.length > 0) {
      if (pId === 'ollama') {
        setOllamaModels(res.models);
        setIsOllamaConnected(true);
      } else {
        setDiscoveredModels((prev) => ({ ...prev, [pId]: res.models! }));
      }
    } else if (pId === 'ollama' && !res.success) {
      setIsOllamaConnected(false);
      setOllamaModels([]);
    }

    setTestingProviders((prev) => ({ ...prev, [pId]: false }));
  };

  const handleTestPrimaryConnection = async () => {
    setIsTesting(true);
    setTestResult(null);
    const res = await testAiConnection(providerId, {
      apiKey: apiKey.trim(),
      baseUrl: baseUrl.trim(),
      model: roleConfigs.manager?.model || roleConfigs.discovery?.model
    });
    setTestResult(res);

    if (res.models && res.models.length > 0) {
      if (providerId === 'ollama') {
        setOllamaModels(res.models);
        setIsOllamaConnected(true);
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
    const finalName = keyName.trim() || `${providerMeta.name} Profile`;

    // Extract cleanly resolved role configs
    const finalRoleConfigs: Partial<Record<AgentRole, { provider: AIProviderId; model: string }>> = {};
    for (const r of AGENT_ROLES) {
      const entry = roleConfigs[r];
      finalRoleConfigs[r] = {
        provider: entry.provider,
        model: entry.model.trim() || getDefaultModelForRole(entry.provider, r)
      };
    }

    // Merge multi-provider keys ensuring primary key is included
    const finalProviderKeys: Partial<Record<AIProviderId, { apiKey?: string; baseUrl?: string }>> = {
      ...providerKeys,
      [providerId]: {
        apiKey: apiKey.trim() || providerKeys[providerId]?.apiKey,
        baseUrl: baseUrl.trim() || providerKeys[providerId]?.baseUrl
      }
    };

    onSaveUserKey({
      id: editingId || undefined,
      name: finalName,
      provider: providerId,
      apiKey: providerId === 'cli_subscription' ? 'cli_subscription_active' : apiKey.trim(),
      baseUrl: baseUrl.trim(),
      authMode: providerId === 'cli_subscription' ? 'cli_subscription' : 'api_key',
      cliAgentId: selectedCliId,
      cliCustomCommand: customCliCommand.trim() || undefined,
      cliExecutionMode: cliExecutionMode,
      discoveryModel: finalRoleConfigs.discovery?.model,
      summaryModel: finalRoleConfigs.summary?.model,
      generalModel: finalRoleConfigs.manager?.model,
      workerModel: finalRoleConfigs.worker?.model,
      cleanerModel: finalRoleConfigs.cleaner?.model,
      hardenerModel: finalRoleConfigs.hardener?.model,
      loggerModel: finalRoleConfigs.logger?.model,
      roleConfigs: finalRoleConfigs,
      providerKeys: finalProviderKeys,
      model: providerId === 'cli_subscription' ? selectedCliId : finalRoleConfigs.manager?.model,
      isConnected: true
    });
    resetForm();
  };

  // Find all distinct providers currently selected across roles
  const providersUsedInProfile = Array.from(new Set(AGENT_ROLES.map((r) => roleConfigs[r]?.provider || providerId)));
  const isMultiProvider = providersUsedInProfile.length > 1;

  const isConfigValid = () => {
    // CLI Subscription mode requires no API key or endpoint
    if (providerId === 'cli_subscription') return true;
    // Check primary provider requirement
    if (providerMeta.requiresKey && !apiKey.trim() && !providerKeys[providerId]?.apiKey?.trim()) return false;
    if (providerMeta.requiresBaseUrl && !baseUrl.trim() && !providerKeys[providerId]?.baseUrl?.trim()) return false;
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
        style={{ maxWidth: '840px', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}
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
                  Manage AI Profiles
                </h3>
              </div>
              <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: 0 }}>
                Configure execution profiles. Mix and match models and providers across workflow agents.
              </p>
            </div>
          </div>
          <button className="btn btn-secondary" style={{ padding: '0.35rem 0.6rem' }} onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="modal-body" style={{ overflowY: 'auto', flex: 1, padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {/* Card 1: Add New / Edit Profile Form Card */}
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
              {editingId ? 'Edit Configured AI Profile' : 'Create New AI Profile'}
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
            {/* Primary Provider Selector (1-Click Auto-Fill) */}
            <div style={{ marginBottom: '0.65rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-bright)' }}>
                  Primary Provider (1-Click Model Auto-Setup)
                </span>
                <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                  Auto-fills default recommended models for all 7 agents
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(115px, 1fr))', gap: '0.5rem' }}>
                {SUPPORTED_AI_PROVIDERS.filter((p) => p.id !== 'mock').map((p) => {
                  const isSelected = p.id === providerId;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => handlePrimaryProviderChange(p.id)}
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
            </div>

            {/* Profile Label */}
            <div className="input-group" style={{ marginBottom: '0.85rem' }}>
              <label className="input-label" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.3rem' }}>
                <Tag size={13} color="var(--accent-cyan)" />
                <span style={{ fontWeight: 700, color: 'var(--text-bright)' }}>Profile Label</span>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>(Name to identify this AI setup)</span>
              </label>
              <input
                type="text"
                className="input-text"
                placeholder="e.g. Hybrid Frontier, Claude + Gemini, Fast & Free..."
                value={keyName}
                onChange={(e) => setKeyName(e.target.value)}
              />
            </div>

            {/* Primary API Key / Endpoint */}
            {providerMeta.requiresKey && (
              <div className="input-group" style={{ marginBottom: '0.85rem' }}>
                <label className="input-label" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.3rem' }}>
                  <Key size={13} color="var(--accent-amber)" />
                  <span style={{ fontWeight: 700, color: 'var(--text-bright)' }}>{providerMeta.name} API Key</span>
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>(Primary)</span>
                </label>
                <div style={{ position: 'relative' }}>
                  <input
                    type={showApiKey ? 'text' : 'password'}
                    className="input-text"
                    placeholder={providerMeta.keyPlaceholder || 'Paste your API key here'}
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
                  onChange={(e) => {
                    setBaseUrl(e.target.value);
                    handleProviderKeyChange('ollama', 'baseUrl', e.target.value);
                  }}
                  style={{ fontFamily: 'var(--font-mono)' }}
                />
              </div>
            )}

            {/* Subscription Bridge / CLI Management Card */}
            {providerId === 'cli_subscription' && (
              <div
                style={{
                  background: 'rgba(16, 185, 129, 0.04)',
                  border: '1px solid rgba(16, 185, 129, 0.22)',
                  borderRadius: 'var(--radius-md)',
                  padding: '1rem',
                  marginBottom: '0.85rem'
                }}
              >
                {/* Banner */}
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.65rem', marginBottom: '0.85rem' }}>
                  <div
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 'var(--radius-sm)',
                      background: 'rgba(16, 185, 129, 0.15)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0
                    }}
                  >
                    <Zap size={16} color="var(--accent-emerald)" />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '0.84rem', fontWeight: 700, color: 'var(--accent-emerald)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span>Subscription Bridge Active</span>
                      <span
                        style={{
                          fontSize: '0.65rem',
                          fontWeight: 700,
                          padding: '0.15rem 0.45rem',
                          borderRadius: '10px',
                          background: 'rgba(16, 185, 129, 0.2)',
                          color: 'var(--accent-emerald)',
                          textTransform: 'uppercase',
                          letterSpacing: '0.04em'
                        }}
                      >
                        Zero API Fees
                      </span>
                    </div>
                    <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: '0.2rem', lineHeight: 1.4 }}>
                      Executes via your local CLI coding agent, spending directly against your monthly subscription (e.g. Claude Pro/Team or ChatGPT Plus). Context & planning agents run headlessly in the background.
                    </div>
                  </div>
                </div>

                {/* Detected Agents List */}
                <div style={{ marginBottom: '0.85rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                    <span style={{ fontSize: '0.73rem', fontWeight: 700, color: 'var(--text-bright)' }}>
                      Select Primary CLI Engine
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setIsDetectingCli(true);
                        fetchDetectedCliAgents(customCliCommand).then((res) => {
                          setDetectedCliAgents(res.agents);
                          setIsDetectingCli(false);
                        });
                      }}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--accent-cyan)',
                        fontSize: '0.68rem',
                        cursor: 'pointer',
                        padding: 0,
                        textDecoration: 'underline'
                      }}
                    >
                      {isDetectingCli ? 'Scanning...' : 'Re-scan CLI tools'}
                    </button>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
                    {(detectedCliAgents.length > 0 ? detectedCliAgents : [
                      {
                        id: 'claude-code',
                        name: 'Claude Code',
                        command: 'claude',
                        detectedPath: null,
                        isInstalled: false,
                        version: null,
                        provider: 'anthropic' as AIProviderId,
                        subscriptionTier: 'Claude Pro / Team / Enterprise',
                        installCommand: 'npm install -g @anthropic-ai/claude-code',
                        docsUrl: 'https://docs.anthropic.com/claude/docs/claude-code',
                        badgeColor: '#d97706',
                        supportsHeadless: true,
                        supportsInteractive: true
                      },
                      {
                        id: 'codex',
                        name: 'OpenAI Codex CLI',
                        command: 'codex',
                        detectedPath: null,
                        isInstalled: false,
                        version: null,
                        provider: 'openai' as AIProviderId,
                        subscriptionTier: 'ChatGPT Plus / Team / Pro',
                        installCommand: 'npm install -g @openai/codex',
                        docsUrl: 'https://github.com/openai/codex',
                        badgeColor: '#7c3aed',
                        supportsHeadless: true,
                        supportsInteractive: true
                      },
                      {
                        id: 'gemini',
                        name: 'Google Gemini CLI',
                        command: 'gemini',
                        detectedPath: null,
                        isInstalled: false,
                        version: null,
                        provider: 'gemini' as AIProviderId,
                        subscriptionTier: 'Google One AI / Gemini Advanced',
                        installCommand: 'npm install -g @google/gemini-cli',
                        docsUrl: 'https://geminicli.com',
                        badgeColor: '#2563eb',
                        supportsHeadless: true,
                        supportsInteractive: true
                      },
                      {
                        id: 'antigravity',
                        name: 'Antigravity (agy)',
                        command: 'agy',
                        detectedPath: null,
                        isInstalled: false,
                        version: null,
                        provider: 'gemini' as AIProviderId,
                        subscriptionTier: 'Google Antigravity Subscription',
                        installCommand: 'Available via Antigravity IDE',
                        docsUrl: 'https://antigravity.dev',
                        badgeColor: '#2563eb',
                        supportsHeadless: true,
                        supportsInteractive: true
                      }
                    ]).map((agent) => {
                      const isSelected = selectedCliId === agent.id;
                      return (
                        <div
                          key={agent.id}
                          onClick={() => setSelectedCliId(agent.id)}
                          style={{
                            padding: '0.55rem 0.75rem',
                            borderRadius: 'var(--radius-sm)',
                            border: `1.5px solid ${isSelected ? 'var(--accent-emerald)' : 'rgba(255, 255, 255, 0.08)'}`,
                            background: isSelected ? 'rgba(16, 185, 129, 0.12)' : 'rgba(0, 0, 0, 0.15)',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: '0.5rem',
                            transition: 'all 0.15s ease'
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.55rem' }}>
                            <div
                              style={{
                                width: 14,
                                height: 14,
                                borderRadius: '50%',
                                border: `2px solid ${isSelected ? 'var(--accent-emerald)' : 'var(--text-dim)'}`,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center'
                              }}
                            >
                              {isSelected && (
                                <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent-emerald)' }} />
                              )}
                            </div>
                            <div>
                              <div style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-bright)' }}>
                                {agent.name}
                              </div>
                              <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                                {agent.subscriptionTier}
                              </div>
                            </div>
                          </div>

                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            {agent.isInstalled ? (
                              <span
                                style={{
                                  fontSize: '0.66rem',
                                  padding: '0.15rem 0.45rem',
                                  borderRadius: 'var(--radius-sm)',
                                  background: 'rgba(16, 185, 129, 0.2)',
                                  color: 'var(--accent-emerald)',
                                  fontWeight: 600,
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '0.25rem'
                                }}
                              >
                                <CheckCircle2 size={11} />
                                Installed {agent.version ? `(${agent.version})` : ''}
                              </span>
                            ) : (
                              <span
                                style={{
                                  fontSize: '0.66rem',
                                  padding: '0.15rem 0.45rem',
                                  borderRadius: 'var(--radius-sm)',
                                  background: 'rgba(245, 158, 11, 0.15)',
                                  color: 'var(--accent-amber)',
                                  fontWeight: 600,
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '0.25rem'
                                }}
                              >
                                <AlertCircle size={11} />
                                Not Detected
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}

                    {/* Custom CLI option */}
                    <div
                      onClick={() => setSelectedCliId('custom')}
                      style={{
                        padding: '0.55rem 0.75rem',
                        borderRadius: 'var(--radius-sm)',
                        border: `1.5px solid ${selectedCliId === 'custom' ? 'var(--accent-emerald)' : 'rgba(255, 255, 255, 0.08)'}`,
                        background: selectedCliId === 'custom' ? 'rgba(16, 185, 129, 0.12)' : 'rgba(0, 0, 0, 0.15)',
                        cursor: 'pointer',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '0.35rem'
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.55rem' }}>
                        <div
                          style={{
                            width: 14,
                            height: 14,
                            borderRadius: '50%',
                            border: `2px solid ${selectedCliId === 'custom' ? 'var(--accent-emerald)' : 'var(--text-dim)'}`,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center'
                          }}
                        >
                          {selectedCliId === 'custom' && (
                            <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent-emerald)' }} />
                          )}
                        </div>
                        <span style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-bright)' }}>
                          Custom CLI Command or Path
                        </span>
                      </div>
                      {selectedCliId === 'custom' && (
                        <div style={{ marginTop: '0.3rem', paddingLeft: '1.4rem' }}>
                          <input
                            type="text"
                            className="input-text"
                            placeholder="e.g. /usr/local/bin/claude or custom-cli-agent"
                            value={customCliCommand}
                            onChange={(e) => setCustomCliCommand(e.target.value)}
                            style={{ fontSize: '0.75rem', fontFamily: 'var(--font-mono)' }}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Installation / Setup Guide when selected agent isn't installed */}
                {(() => {
                  const currentAgent = detectedCliAgents.find((a) => a.id === selectedCliId);
                  if (currentAgent && !currentAgent.isInstalled && currentAgent.installCommand) {
                    const isCopied = copiedInstallCmd === currentAgent.installCommand;
                    return (
                      <div
                        style={{
                          background: 'rgba(0, 0, 0, 0.25)',
                          border: '1px solid rgba(245, 158, 11, 0.25)',
                          borderRadius: 'var(--radius-sm)',
                          padding: '0.65rem 0.85rem',
                          marginBottom: '0.85rem'
                        }}
                      >
                        <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--accent-amber)', marginBottom: '0.3rem' }}>
                          Setup Required to use {currentAgent.name}:
                        </div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.4rem' }}>
                          Run this command in your terminal to install and log in with your subscription:
                        </div>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            background: 'rgba(0, 0, 0, 0.4)',
                            borderRadius: '4px',
                            padding: '0.35rem 0.55rem',
                            fontFamily: 'var(--font-mono)',
                            fontSize: '0.72rem',
                            color: 'var(--accent-cyan)'
                          }}
                        >
                          <code>{currentAgent.installCommand} && {currentAgent.command} login</code>
                          <button
                            type="button"
                            onClick={() => {
                              navigator.clipboard.writeText(`${currentAgent.installCommand} && ${currentAgent.command} login`);
                              setCopiedInstallCmd(currentAgent.installCommand);
                              setTimeout(() => setCopiedInstallCmd(null), 2000);
                            }}
                            style={{
                              background: 'none',
                              border: 'none',
                              color: isCopied ? 'var(--accent-emerald)' : 'var(--text-muted)',
                              cursor: 'pointer',
                              fontSize: '0.68rem',
                              fontWeight: 600,
                              marginLeft: '0.5rem'
                            }}
                          >
                            {isCopied ? 'Copied!' : 'Copy'}
                          </button>
                        </div>
                      </div>
                    );
                  }
                  return null;
                })()}

                {/* Code Tasks Execution Mode Selector */}
                <div>
                  <div style={{ fontSize: '0.73rem', fontWeight: 700, color: 'var(--text-bright)', marginBottom: '0.35rem' }}>
                    Coding Tasks Execution Mode:
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                    <div
                      onClick={() => setCliExecutionMode('interactive')}
                      style={{
                        padding: '0.5rem 0.65rem',
                        borderRadius: 'var(--radius-sm)',
                        border: `1.5px solid ${cliExecutionMode === 'interactive' ? 'var(--accent-cyan)' : 'rgba(255, 255, 255, 0.08)'}`,
                        background: cliExecutionMode === 'interactive' ? 'rgba(6, 182, 212, 0.1)' : 'rgba(0, 0, 0, 0.15)',
                        cursor: 'pointer'
                      }}
                    >
                      <div style={{ fontSize: '0.75rem', fontWeight: 700, color: cliExecutionMode === 'interactive' ? 'var(--accent-cyan)' : 'var(--text-main)', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                        <Terminal size={13} />
                        <span>Interactive Terminal</span>
                      </div>
                      <div style={{ fontSize: '0.67rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
                        Opens docked xterm window for live code inspection & typing
                      </div>
                    </div>

                    <div
                      onClick={() => setCliExecutionMode('headless')}
                      style={{
                        padding: '0.5rem 0.65rem',
                        borderRadius: 'var(--radius-sm)',
                        border: `1.5px solid ${cliExecutionMode === 'headless' ? 'var(--accent-cyan)' : 'rgba(255, 255, 255, 0.08)'}`,
                        background: cliExecutionMode === 'headless' ? 'rgba(6, 182, 212, 0.1)' : 'rgba(0, 0, 0, 0.15)',
                        cursor: 'pointer'
                      }}
                    >
                      <div style={{ fontSize: '0.75rem', fontWeight: 700, color: cliExecutionMode === 'headless' ? 'var(--accent-cyan)' : 'var(--text-main)', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                        <Zap size={13} />
                        <span>Headless Background</span>
                      </div>
                      <div style={{ fontSize: '0.67rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
                        Executes silently in background; updates files & briefs directly
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Advanced Settings Accordion Toggle */}
            <div style={{ marginTop: '0.85rem' }}>
              <button
                type="button"
                onClick={() => setShowAdvancedSettings(!showAdvancedSettings)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  width: '100%',
                  background: showAdvancedSettings ? 'rgba(99, 102, 241, 0.1)' : 'var(--btn-secondary-bg)',
                  border: `1px solid ${showAdvancedSettings ? 'var(--accent-primary)' : 'var(--btn-secondary-border)'}`,
                  borderRadius: 'var(--radius-sm)',
                  padding: '0.6rem 0.85rem',
                  color: 'var(--text-bright)',
                  cursor: 'pointer',
                  fontSize: '0.82rem',
                  fontWeight: 600,
                  transition: 'all 0.15s ease'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Sliders size={15} color="var(--accent-cyan)" />
                  <span>Advanced Settings: Per-Agent Models & Multi-Provider Keys</span>
                  {isMultiProvider && (
                    <span
                      style={{
                        fontSize: '0.65rem',
                        padding: '0.1rem 0.4rem',
                        borderRadius: '4px',
                        background: 'rgba(6, 182, 212, 0.2)',
                        color: 'var(--accent-cyan)',
                        fontWeight: 700
                      }}
                    >
                      Multi-Provider ({providersUsedInProfile.length})
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  {!showAdvancedSettings && (
                    <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                      {AGENT_ROLES.map((r) => roleConfigs[r]?.model).filter(Boolean).slice(0, 3).join(' • ') + '...'}
                    </span>
                  )}
                  <ChevronDown
                    size={15}
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
                    marginTop: '0.65rem',
                    padding: '1rem',
                    background: 'var(--bg-pane)',
                    border: '1px solid var(--btn-secondary-border)',
                    borderRadius: 'var(--radius-sm)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '1.25rem'
                  }}
                >
                  {/* Section A: Agent Workflow Representation */}
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.6rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                        <Layers size={14} color="var(--accent-cyan)" />
                        <span style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-bright)' }}>
                          Execution Agents (7 Roles)
                        </span>
                      </div>
                      <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                        Select custom providers & models per agent role. Click ℹ️ for performance benchmarks.
                      </span>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                      {AGENT_ROLES.map((role) => {
                        const meta = AGENT_ROLE_INFO[role];
                        const roleState = roleConfigs[role] || {
                          provider: providerId,
                          model: getDefaultModelForRole(providerId, role),
                          isCustom: false
                        };
                        const badgeStyle = getScoreBadgeStyle(meta.score);
                        const isTooltipOpen = activeTooltipRole === role;
                        const roleModels = getEffectiveModels(roleState.provider);

                        return (
                          <div
                            key={role}
                            style={{
                              background: 'var(--bg-card)',
                              border: isTooltipOpen ? '1.5px solid var(--accent-cyan)' : '1px solid var(--border-subtle)',
                              borderRadius: 'var(--radius-sm)',
                              padding: '0.75rem 0.9rem',
                              transition: 'all 0.15s ease'
                            }}
                          >
                            {/* Role Row Header */}
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                {ROLE_ICONS[role]}
                                <span style={{ fontWeight: 700, fontSize: '0.84rem', color: 'var(--text-bright)' }}>
                                  {meta.name}
                                </span>
                                <span
                                  style={{
                                    fontSize: '0.64rem',
                                    padding: '0.1rem 0.45rem',
                                    borderRadius: '4px',
                                    background: badgeStyle.bg,
                                    color: badgeStyle.color,
                                    border: `1px solid ${badgeStyle.border}`,
                                    fontWeight: 700
                                  }}
                                >
                                  Capability: {meta.scoreLabel}
                                </span>
                              </div>

                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                                <button
                                  type="button"
                                  onClick={() => setActiveTooltipRole(isTooltipOpen ? null : role)}
                                  style={{
                                    background: isTooltipOpen ? 'rgba(6, 182, 212, 0.2)' : 'none',
                                    border: `1px solid ${isTooltipOpen ? 'var(--accent-cyan)' : 'transparent'}`,
                                    borderRadius: '4px',
                                    color: isTooltipOpen ? 'var(--accent-cyan)' : 'var(--text-muted)',
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.25rem',
                                    fontSize: '0.68rem',
                                    padding: '0.15rem 0.4rem',
                                    fontWeight: 600
                                  }}
                                  title="View role benchmark details & description"
                                >
                                  <Info size={12} />
                                  <span>{isTooltipOpen ? 'Hide Info' : 'Agent Info'}</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleRoleCustomToggle(role)}
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
                                  {roleState.isCustom ? 'Use Presets' : 'Custom ID'}
                                </button>
                              </div>
                            </div>

                            {/* Tooltip / Info Popover */}
                            {isTooltipOpen && (
                              <div
                                style={{
                                  background: 'rgba(6, 182, 212, 0.07)',
                                  border: '1px solid rgba(6, 182, 212, 0.25)',
                                  borderRadius: 'var(--radius-sm)',
                                  padding: '0.6rem 0.8rem',
                                  marginBottom: '0.65rem',
                                  fontSize: '0.74rem',
                                  color: 'var(--text-main)',
                                  lineHeight: 1.45
                                }}
                              >
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.25rem' }}>
                                  <strong style={{ color: 'var(--text-bright)' }}>Role Purpose:</strong>
                                  <span>{meta.description}</span>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', marginTop: '0.35rem', color: 'var(--text-muted)' }}>
                                  <span>
                                    <strong>Ideal Tier:</strong> <code style={{ color: 'var(--accent-cyan)' }}>{meta.tier}</code>
                                  </span>
                                  <span>
                                    <strong>Recommended capability:</strong> <code style={{ color: badgeStyle.color }}>{meta.score}/10</code>
                                  </span>
                                </div>
                              </div>
                            )}

                            {/* Role Selectors: Provider & Model */}
                            <div style={{ display: 'grid', gridTemplateColumns: '150px 1fr', gap: '0.5rem' }}>
                              {/* Provider Dropdown */}
                              <div>
                                <select
                                  className="input-text"
                                  value={roleState.provider}
                                  onChange={(e) => handleRoleProviderChange(role, e.target.value as AIProviderId)}
                                  style={{ cursor: 'pointer', fontSize: '0.78rem', padding: '0.35rem 0.5rem' }}
                                >
                                  {SUPPORTED_AI_PROVIDERS.filter((p) => p.id !== 'mock').map((p) => (
                                    <option key={`${role}-prov-${p.id}`} value={p.id}>
                                      {p.shortName}
                                    </option>
                                  ))}
                                </select>
                              </div>

                              {/* Model Input or Dropdown */}
                              <div>
                                {roleState.isCustom ? (
                                  <input
                                    type="text"
                                    className="input-text"
                                    placeholder="Enter exact model ID (e.g. gpt-4.5-preview, claude-3-7-sonnet)"
                                    value={roleState.model}
                                    onChange={(e) => handleRoleModelChange(role, e.target.value)}
                                    style={{ fontSize: '0.78rem', fontFamily: 'var(--font-mono)', padding: '0.35rem 0.5rem' }}
                                  />
                                ) : roleState.provider === 'ollama' ? (
                                  <select
                                    className="input-text"
                                    value={roleState.model}
                                    onChange={(e) => handleRoleModelChange(role, e.target.value)}
                                    disabled={!isOllamaConnected || ollamaModels.length === 0}
                                    style={{
                                      cursor: (!isOllamaConnected || ollamaModels.length === 0) ? 'not-allowed' : 'pointer',
                                      fontSize: '0.78rem',
                                      padding: '0.35rem 0.5rem'
                                    }}
                                  >
                                    {!isOllamaConnected ? (
                                      <option value="">Ollama not connected — test endpoint below</option>
                                    ) : ollamaModels.length === 0 ? (
                                      <option value="">No local models installed in Ollama</option>
                                    ) : (
                                      ollamaModels.map((m) => (
                                        <option key={`${role}-ollama-${m.id}`} value={m.id}>
                                          {m.name}
                                        </option>
                                      ))
                                    )}
                                  </select>
                                ) : (
                                  <select
                                    className="input-text"
                                    value={roleState.model}
                                    onChange={(e) => handleRoleModelChange(role, e.target.value)}
                                    style={{ cursor: 'pointer', fontSize: '0.78rem', padding: '0.35rem 0.5rem' }}
                                  >
                                    {roleModels.map((m) => {
                                      const isDefault = m.id === meta.defaultModels[roleState.provider];
                                      return (
                                        <option key={`${role}-${m.id}`} value={m.id}>
                                          {m.name} {isDefault ? '★ (Recommended)' : ''}
                                        </option>
                                      );
                                    })}
                                  </select>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Section B: Multi-Provider API Credentials */}
                  <div style={{ paddingTop: '0.75rem', borderTop: '1px solid var(--btn-secondary-border)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.6rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                        <Key size={14} color="var(--accent-amber)" />
                        <span style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-bright)' }}>
                          Provider API Credentials & Host Endpoints
                        </span>
                      </div>
                      <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                        Provide keys for all providers referenced in this profile
                      </span>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '0.65rem' }}>
                      {SUPPORTED_AI_PROVIDERS.filter((p) => p.id !== 'mock').map((p) => {
                        const isUsed = providersUsedInProfile.includes(p.id);
                        const isPrimary = p.id === providerId;
                        const keyEntry = providerKeys[p.id] || { apiKey: '', baseUrl: '' };
                        const effectiveVal = isPrimary && p.requiresKey ? (apiKey || keyEntry.apiKey) : keyEntry.apiKey;
                        const effectiveUrl = isPrimary && p.requiresBaseUrl ? (baseUrl || keyEntry.baseUrl) : (keyEntry.baseUrl || p.defaultBaseUrl || '');
                        const isChecking = testingProviders[p.id] || false;
                        const testRes = providerTestResults[p.id];

                        return (
                          <div
                            key={`cred-${p.id}`}
                            style={{
                              background: 'var(--bg-card)',
                              border: `1.5px solid ${isUsed ? 'var(--border-subtle)' : 'transparent'}`,
                              opacity: isUsed ? 1 : 0.65,
                              borderRadius: 'var(--radius-sm)',
                              padding: '0.65rem 0.8rem',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '0.45rem',
                              transition: 'opacity 0.2s ease'
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                                <div style={{ width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                  {p.iconUrl ? <img src={p.iconUrl} alt={p.shortName} style={{ width: '100%', height: '100%', objectFit: 'contain' }} /> : p.icon}
                                </div>
                                <span style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-bright)' }}>
                                  {p.shortName}
                                </span>
                                {isPrimary && (
                                  <span style={{ fontSize: '0.62rem', padding: '0.05rem 0.35rem', borderRadius: '3px', background: 'rgba(99, 102, 241, 0.2)', color: 'var(--accent-primary)', fontWeight: 600 }}>
                                    Primary
                                  </span>
                                )}
                                {isUsed && !isPrimary && (
                                  <span style={{ fontSize: '0.62rem', padding: '0.05rem 0.35rem', borderRadius: '3px', background: 'rgba(6, 182, 212, 0.15)', color: 'var(--accent-cyan)', fontWeight: 600 }}>
                                    In Use
                                  </span>
                                )}
                              </div>

                              <button
                                type="button"
                                className="btn btn-secondary"
                                onClick={() => handleTestProvider(p.id)}
                                disabled={isChecking || (p.requiresKey && !effectiveVal) || (p.requiresBaseUrl && !effectiveUrl)}
                                style={{ padding: '0.15rem 0.45rem', fontSize: '0.68rem' }}
                              >
                                {isChecking ? <Loader2 size={11} className="animate-spin" /> : 'Test'}
                              </button>
                            </div>

                            {p.requiresKey && (
                              <input
                                type="password"
                                className="input-text"
                                placeholder={p.keyPlaceholder || 'API Key'}
                                value={effectiveVal}
                                onChange={(e) => handleProviderKeyChange(p.id, 'apiKey', e.target.value)}
                                style={{ fontSize: '0.76rem', fontFamily: 'var(--font-mono)', padding: '0.35rem 0.5rem' }}
                              />
                            )}

                            {p.requiresBaseUrl && (
                              <input
                                type="text"
                                className="input-text"
                                placeholder="http://localhost:11434"
                                value={effectiveUrl}
                                onChange={(e) => handleProviderKeyChange(p.id, 'baseUrl', e.target.value)}
                                style={{ fontSize: '0.76rem', fontFamily: 'var(--font-mono)', padding: '0.35rem 0.5rem' }}
                              />
                            )}

                            {testRes && (
                              <div
                                style={{
                                  fontSize: '0.68rem',
                                  color: testRes.success ? 'var(--accent-emerald)' : 'var(--accent-rose)',
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '0.3rem'
                                }}
                              >
                                {testRes.success ? <CheckCircle2 size={11} /> : <AlertCircle size={11} />}
                                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {testRes.message}
                                </span>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Action Bar inside form */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '1.1rem' }}>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={handleTestPrimaryConnection}
                disabled={isTesting || !isConfigValid()}
                style={{ fontSize: '0.82rem' }}
              >
                {isTesting ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    <span>Testing Primary...</span>
                  </>
                ) : (
                  <span>Test Primary Connection</span>
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
                <span>{editingId ? 'Save Profile Changes' : 'Save AI Profile'}</span>
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

          {/* Card 2: Configured AI Profiles List */}
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
                Configured AI Profiles ({userApiKeys.length})
              </h4>
              {userApiKeys.length > 0 && (
                <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                  Click 'Edit' to adjust per-agent model assignments
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
                  No AI profiles created yet
                </p>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: 0 }}>
                  Set up your OpenAI, Anthropic, Gemini, or Ollama credentials in the card above to activate AI features.
                </p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                {userApiKeys.map((k) => {
                  const isActive = k.id === activeKeyId;
                  const isCurrentlyEditing = k.id === editingId;
                  const pMeta = SUPPORTED_AI_PROVIDERS.find((p) => p.id === k.provider);

                  // Extract providers used across roleConfigs
                  const roleEntries = k.roleConfigs ? Object.entries(k.roleConfigs) : [];
                  const uniqueProviders = Array.from(
                    new Set([k.provider, ...roleEntries.map(([_, v]) => v?.provider).filter(Boolean)])
                  ) as AIProviderId[];

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
                      {/* Top Row */}
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
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap' }}>
                              <span style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--text-bright)' }}>{k.name}</span>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                                {uniqueProviders.map((uP) => {
                                  const uMeta = SUPPORTED_AI_PROVIDERS.find((p) => p.id === uP);
                                  return (
                                    <span
                                      key={uP}
                                      className="badge"
                                      style={{
                                        fontSize: '0.65rem',
                                        padding: '0.1rem 0.4rem',
                                        background: 'var(--btn-secondary-bg)',
                                        color: 'var(--text-muted)',
                                        borderColor: 'var(--btn-secondary-border)'
                                      }}
                                    >
                                      {uMeta?.shortName || uP}
                                    </span>
                                  );
                                })}
                              </div>

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
                                  Active Profile
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
                                  : 'No Primary Key'}
                            </span>
                          </div>
                        </div>

                        {/* Actions */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                          {!isActive && (
                            <button
                              type="button"
                              className="btn btn-secondary"
                              style={{ padding: '0.25rem 0.55rem', fontSize: '0.75rem' }}
                              onClick={() => onSelectActiveKey(k.id)}
                            >
                              <Check size={12} />
                              Use Profile
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
                            title="Delete Profile"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>

                      {/* Bottom Row: 7 Agent Models Display */}
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          flexWrap: 'wrap',
                          gap: '0.45rem',
                          paddingTop: '0.4rem',
                          borderTop: '1px solid var(--border-subtle)',
                          fontSize: '0.7rem'
                        }}
                      >
                        {AGENT_ROLES.map((role) => {
                          const rMeta = AGENT_ROLE_INFO[role];
                          const config = k.roleConfigs?.[role];
                          const modelVal =
                            config?.model ||
                            (role === 'discovery'
                              ? k.discoveryModel
                              : role === 'summary'
                                ? k.summaryModel
                                : role === 'cleaner'
                                  ? k.cleanerModel
                                  : role === 'hardener'
                                    ? k.hardenerModel
                                    : role === 'logger'
                                      ? k.loggerModel
                                      : role === 'worker'
                                        ? k.workerModel || k.generalModel || k.model
                                        : k.generalModel || k.model) ||
                            getDefaultModelForRole(k.provider, role);

                          return (
                            <div
                              key={`${k.id}-${role}`}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.25rem',
                                background: 'var(--btn-secondary-bg)',
                                border: '1px solid var(--btn-secondary-border)',
                                padding: '0.12rem 0.4rem',
                                borderRadius: '4px',
                                color: 'var(--text-muted)'
                              }}
                              title={`${rMeta.name} (Capability: ${rMeta.scoreLabel})`}
                            >
                              {ROLE_ICONS[role]}
                              <span style={{ fontWeight: 600, color: 'var(--text-bright)' }}>
                                {role}:
                              </span>
                              <span style={{ color: 'var(--accent-cyan)' }}>
                                {modelVal}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Card 3: Provider API Key Documentation Links */}
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
                  Delete AI Profile?
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
