import React, { useState, useEffect } from 'react';
import { type AIProviderId, type UserApiKey } from '../types';
import { SUPPORTED_AI_PROVIDERS, testAiConnection } from '../lib/aiProviders';
import { Key, Globe, X, CheckCircle2, AlertCircle, Loader2, ExternalLink, Eye, EyeOff, ShieldCheck, Plus, Trash2, Check, HelpCircle, Tag } from 'lucide-react';

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
  const [model, setModel] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  const providerMeta = SUPPORTED_AI_PROVIDERS.find((p) => p.id === providerId) || SUPPORTED_AI_PROVIDERS[0];

  const resetForm = (pId: AIProviderId = 'openai') => {
    const p = SUPPORTED_AI_PROVIDERS.find((item) => item.id === pId) || SUPPORTED_AI_PROVIDERS[0];
    setEditingId(null);
    setKeyName('');
    setApiKey('');
    setProviderId(pId);
    setBaseUrl(p.defaultBaseUrl || '');
    setModel(p.defaultModel);
    setTestResult(null);
    setShowApiKey(false);
  };

  useEffect(() => {
    if (isOpen) {
      if (editingKey) {
        setEditingId(editingKey.id);
        setKeyName(editingKey.name);
        setApiKey(editingKey.apiKey);
        setProviderId(editingKey.provider);
        setBaseUrl(editingKey.baseUrl || '');
        setModel(editingKey.model || SUPPORTED_AI_PROVIDERS.find((p) => p.id === editingKey.provider)?.defaultModel || '');
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
        setModel(p.defaultModel);
        if (p.defaultBaseUrl) setBaseUrl(p.defaultBaseUrl);
      }
    }
  }, [providerId]);

  if (!isOpen) return null;

  // Auto-detect provider when user pastes key
  const handleApiKeyChange = (val: string) => {
    setApiKey(val);
    const trimmed = val.trim();
    if (!keyName || keyName.endsWith('Key') || keyName.endsWith('Ollama')) {
      if (trimmed.startsWith('sk-ant-')) {
        setProviderId('anthropic');
        if (!keyName) setKeyName('Anthropic Claude Key');
      } else if (trimmed.startsWith('sk-proj-') || trimmed.startsWith('sk-')) {
        setProviderId('openai');
        if (!keyName) setKeyName('OpenAI Key');
      } else if (trimmed.startsWith('AIzaSy')) {
        setProviderId('gemini');
        if (!keyName) setKeyName('Google Gemini Key');
      } else if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.includes('11434')) {
        setProviderId('ollama');
        if (!keyName) setKeyName('Local Ollama');
      }
    }
  };

  const handleTestConnection = async () => {
    setIsTesting(true);
    setTestResult(null);
    const res = await testAiConnection(providerId, {
      apiKey: apiKey.trim(),
      baseUrl: baseUrl.trim(),
      model
    });
    setTestResult(res);
    setIsTesting(false);
  };

  const handleSave = () => {
    const finalName = keyName.trim() || `${providerMeta.name} Key`;
    onSaveUserKey({
      id: editingId || undefined,
      name: finalName,
      provider: providerId,
      apiKey: apiKey.trim(),
      baseUrl: baseUrl.trim(),
      model,
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
    <div className="modal-overlay">
      <div className="modal-content" style={{ maxWidth: '680px', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
        {/* Header */}
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{ width: '38px', height: '38px', borderRadius: '10px', background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-cyan))', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}>
              <Key size={20} />
            </div>
            <div>
              <h3 style={{ fontSize: '1.15rem', fontWeight: 700, color: '#fff', margin: 0 }}>
                AI Engine Screen & Key Setup
              </h3>
              <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: 0 }}>
                Name and paste your API key to enable AI task drafting & automated execution.
              </p>
            </div>
          </div>
          <button className="btn btn-secondary" style={{ padding: '0.35rem 0.6rem' }} onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="modal-body" style={{ overflowY: 'auto', flex: 1, padding: '1.25rem 1.5rem' }}>
          {/* Key Form Card */}
          <div style={{ background: 'var(--bg-dark)', border: '1px solid var(--border-glow)', borderRadius: 'var(--radius-md)', padding: '1.25rem', marginBottom: '1.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
              <span style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--accent-cyan)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <Plus size={16} />
                {editingId ? 'Edit Configured API Key' : 'Add New API Key'}
              </span>
              {editingId && (
                <button
                  type="button"
                  onClick={() => resetForm()}
                  style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '0.75rem', cursor: 'pointer', textDecoration: 'underline' }}
                >
                  Cancel Edit
                </button>
              )}
            </div>

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
                      if (!keyName || keyName.endsWith('Key')) {
                        setKeyName(`${p.shortName} Key`);
                      }
                    }}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: '0.25rem',
                      padding: '0.6rem 0.4rem',
                      borderRadius: 'var(--radius-sm)',
                      border: `1px solid ${isSelected ? 'var(--accent-cyan)' : 'var(--border-subtle)'}`,
                      background: isSelected ? 'rgba(6, 182, 212, 0.12)' : 'var(--bg-card)',
                      color: isSelected ? '#fff' : 'var(--text-muted)',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease'
                    }}
                  >
                    <span style={{ fontSize: '1.2rem' }}>{p.icon}</span>
                    <span style={{ fontSize: '0.76rem', fontWeight: isSelected ? 700 : 500 }}>{p.shortName}</span>
                  </button>
                );
              })}
            </div>

            {/* Field 1: Key Name */}
            <div className="input-group">
              <label className="input-label" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <Tag size={13} color="var(--accent-cyan)" />
                <span>Key Name</span>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>(Give this key a label to recognize it)</span>
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
              <div className="input-group">
                <label className="input-label" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <Key size={13} color="var(--accent-amber)" />
                  <span>Paste API Key</span>
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
                    style={{ position: 'absolute', right: '0.75rem', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
                    title={showApiKey ? 'Hide Key' : 'Show Key'}
                  >
                    {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
            )}

            {/* Field 3: Base URL for Ollama */}
            {providerMeta.requiresBaseUrl && (
              <div className="input-group">
                <label className="input-label" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <Globe size={13} color="var(--accent-violet)" />
                  <span>Ollama Host Endpoint</span>
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

            {/* Field 4: Model Selection */}
            <div className="input-group">
              <label className="input-label">Target Model</label>
              <select
                className="input-text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                style={{ cursor: 'pointer' }}
              >
                {providerMeta.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} — {m.description}
                  </option>
                ))}
              </select>
            </div>

            {/* Action Bar inside form */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '1rem' }}>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={handleTestConnection}
                disabled={isTesting || !isConfigValid()}
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
              >
                <ShieldCheck size={16} />
                <span>{editingId ? 'Save Changes' : 'Save & Set Active Key'}</span>
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

          {/* Configured Keys List */}
          {userApiKeys.length > 0 && (
            <div style={{ marginBottom: '1.5rem' }}>
              <h4 style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.75rem' }}>
                Your Specified API Keys ({userApiKeys.length})
              </h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {userApiKeys.map((k) => {
                  const isActive = k.id === activeKeyId;
                  const pMeta = SUPPORTED_AI_PROVIDERS.find((p) => p.id === k.provider);
                  return (
                    <div
                      key={k.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '0.75rem 1rem',
                        background: 'var(--bg-dark)',
                        border: `1px solid ${isActive ? 'var(--accent-cyan)' : 'var(--border-subtle)'}`,
                        borderRadius: 'var(--radius-md)'
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        <span style={{ fontSize: '1.2rem' }}>{pMeta?.icon || '🔑'}</span>
                        <div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                            <span style={{ fontWeight: 700, fontSize: '0.88rem', color: '#fff' }}>{k.name}</span>
                            <span className="badge badge-done" style={{ fontSize: '0.65rem', padding: '0.1rem 0.35rem' }}>
                              {pMeta?.shortName || k.provider}
                            </span>
                            {isActive && (
                              <span className="badge badge-done" style={{ fontSize: '0.65rem', background: 'rgba(6, 182, 212, 0.2)', color: 'var(--accent-cyan)', borderColor: 'var(--accent-cyan)' }}>
                                Active
                              </span>
                            )}
                          </div>
                          <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                            {k.provider === 'ollama' ? k.baseUrl : (k.apiKey ? `${k.apiKey.slice(0, 7)}...${k.apiKey.slice(-4)}` : 'No Key')} • {k.model}
                          </span>
                        </div>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
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
                          style={{ padding: '0.25rem 0.45rem', fontSize: '0.75rem' }}
                          onClick={() => {
                            setEditingId(k.id);
                            setKeyName(k.name);
                            setApiKey(k.apiKey);
                            setProviderId(k.provider);
                            setBaseUrl(k.baseUrl || '');
                            setModel(k.model || pMeta?.defaultModel || '');
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ padding: '0.25rem 0.45rem', fontSize: '0.75rem', color: 'var(--accent-rose)', borderColor: 'rgba(244, 63, 94, 0.3)' }}
                          onClick={() => onDeleteUserKey(k.id)}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Dedicated Section: Don't know where to get an API key? */}
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
              <h4 style={{ fontSize: '0.92rem', fontWeight: 700, color: '#fff', margin: 0 }}>
                Don't know where to get an API key?
              </h4>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '0 0 0.85rem 0' }}>
              Create an account or access your developer dashboard directly with official providers:
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
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-sm)',
                  color: '#fff',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  textDecoration: 'none',
                  transition: 'all 0.15s ease'
                }}
                className="provider-key-link"
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <span>🤖</span>
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
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-sm)',
                  color: '#fff',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  textDecoration: 'none',
                  transition: 'all 0.15s ease'
                }}
                className="provider-key-link"
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <span>🧠</span>
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
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-sm)',
                  color: '#fff',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  textDecoration: 'none',
                  transition: 'all 0.15s ease'
                }}
                className="provider-key-link"
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <span>✨</span>
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
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-sm)',
                  color: '#fff',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  textDecoration: 'none',
                  transition: 'all 0.15s ease'
                }}
                className="provider-key-link"
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <span>💻</span>
                  <span>Ollama Local AI</span>
                </span>
                <ExternalLink size={13} color="var(--accent-cyan)" />
              </a>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>
            Close AI Screen
          </button>
        </div>
      </div>
    </div>
  );
};
