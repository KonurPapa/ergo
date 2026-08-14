import React, { useState, useEffect } from 'react';
import { type AIProviderId, type ProviderCredentials } from '../types';
import { SUPPORTED_AI_PROVIDERS, testAiConnection } from '../lib/aiProviders';
import { Key, Globe, Cpu, X, CheckCircle2, AlertCircle, Loader2, ExternalLink, Eye, EyeOff, ShieldCheck } from 'lucide-react';

interface AiCredentialsModalProps {
  isOpen: boolean;
  onClose: () => void;
  providerId: AIProviderId | null;
  currentCredentials?: ProviderCredentials;
  onSaveCredentials: (providerId: AIProviderId, credentials: ProviderCredentials) => void;
  onClearCredentials?: (providerId: AIProviderId) => void;
}

export const AiCredentialsModal: React.FC<AiCredentialsModalProps> = ({
  isOpen,
  onClose,
  providerId,
  currentCredentials,
  onSaveCredentials,
  onClearCredentials
}) => {
  const provider = SUPPORTED_AI_PROVIDERS.find((p) => p.id === providerId) || SUPPORTED_AI_PROVIDERS[0];

  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);

  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  useEffect(() => {
    if (isOpen && provider) {
      setApiKey(currentCredentials?.apiKey || '');
      setBaseUrl(currentCredentials?.baseUrl || provider.defaultBaseUrl || '');
      setModel(currentCredentials?.model || provider.defaultModel);
      setTestResult(null);
      setShowApiKey(false);
    }
  }, [isOpen, providerId, currentCredentials]);

  if (!isOpen || !provider) return null;

  const handleTestConnection = async () => {
    setIsTesting(true);
    setTestResult(null);
    const creds: ProviderCredentials = {
      apiKey: apiKey.trim(),
      baseUrl: baseUrl.trim(),
      model: model,
      isConnected: false
    };
    const res = await testAiConnection(provider.id, creds);
    setTestResult(res);
    setIsTesting(false);
  };

  const handleSave = () => {
    const creds: ProviderCredentials = {
      apiKey: apiKey.trim(),
      baseUrl: baseUrl.trim(),
      model: model,
      isConnected: true
    };
    onSaveCredentials(provider.id, creds);
    onClose();
  };

  const handleClear = () => {
    if (onClearCredentials) {
      onClearCredentials(provider.id);
    }
    onClose();
  };

  const isConfigValid = () => {
    if (provider.requiresKey && !apiKey.trim()) return false;
    if (provider.requiresBaseUrl && !baseUrl.trim()) return false;
    return true;
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ maxWidth: '620px' }}>
        {/* Header */}
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <span style={{ fontSize: '1.6rem', lineHeight: 1 }}>{provider.icon}</span>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <h3 style={{ fontSize: '1.15rem', fontWeight: 700, color: '#fff' }}>
                  Sign in to {provider.name}
                </h3>
                {currentCredentials?.isConnected && (
                  <span className="badge badge-done" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem' }}>
                    <ShieldCheck size={12} />
                    Connected
                  </span>
                )}
              </div>
              <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                {provider.description}
              </p>
            </div>
          </div>
          <button className="btn btn-secondary" style={{ padding: '0.35rem 0.6rem' }} onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="modal-body">
          <div style={{ background: 'rgba(99, 102, 241, 0.08)', border: '1px solid var(--border-glow)', borderRadius: 'var(--radius-md)', padding: '0.85rem 1rem', marginBottom: '1.25rem', fontSize: '0.82rem', color: 'var(--text-main)', display: 'flex', alignItems: 'flex-start', gap: '0.6rem' }}>
            <Cpu size={16} color="var(--accent-cyan)" style={{ marginTop: '0.1rem', flexShrink: 0 }} />
            <div>
              Connecting <strong>{provider.name}</strong> grants Ergo permission to invoke this model to draft tasks, summarize briefs, and run automated task execution steps on your behalf.
            </div>
          </div>

          {/* Model Selection */}
          <div className="input-group">
            <label className="input-label" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span>Target Model</span>
              <span style={{ fontSize: '0.75rem', color: 'var(--accent-cyan)', fontFamily: 'var(--font-mono)' }}>{model}</span>
            </label>
            <select
              className="input-text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              style={{ cursor: 'pointer' }}
            >
              {provider.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} — {m.description}
                </option>
              ))}
            </select>
          </div>

          {/* API Key Input */}
          {provider.requiresKey && (
            <div className="input-group">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.3rem' }}>
                <label className="input-label" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <Key size={14} color="var(--accent-amber)" />
                  <span>API Key</span>
                </label>
                {provider.keyDocUrl && (
                  <a
                    href={provider.keyDocUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={{ fontSize: '0.75rem', color: 'var(--accent-cyan)', display: 'inline-flex', alignItems: 'center', gap: '0.2rem', textDecoration: 'none' }}
                  >
                    <span>Get API Key</span>
                    <ExternalLink size={12} />
                  </a>
                )}
              </div>
              <div style={{ position: 'relative' }}>
                <input
                  type={showApiKey ? 'text' : 'password'}
                  className="input-text"
                  placeholder={provider.keyPlaceholder || 'Enter API Key...'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
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
              <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginTop: '0.25rem' }}>
                Your credentials are stored locally in your browser workspace and never leave your machine.
              </span>
            </div>
          )}

          {/* Base URL Input for Ollama / Custom Endpoint */}
          {provider.requiresBaseUrl && (
            <div className="input-group">
              <label className="input-label" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <Globe size={14} color="var(--accent-violet)" />
                <span>Ollama Host Server Endpoint</span>
              </label>
              <input
                type="text"
                className="input-text"
                placeholder="http://localhost:11434"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                style={{ fontFamily: 'var(--font-mono)' }}
              />
              <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginTop: '0.25rem' }}>
                Make sure Ollama is running locally. For cross-origin requests, set <code style={{ color: 'var(--accent-cyan)' }}>OLLAMA_ORIGINS="*"</code> in your environment.
              </span>
            </div>
          )}

          {/* Connection Test Banner */}
          {testResult && (
            <div
              style={{
                marginTop: '1rem',
                padding: '0.85rem 1rem',
                borderRadius: 'var(--radius-md)',
                display: 'flex',
                alignItems: 'center',
                gap: '0.65rem',
                fontSize: '0.85rem',
                background: testResult.success ? 'rgba(16, 185, 129, 0.12)' : 'rgba(244, 63, 94, 0.12)',
                border: `1px solid ${testResult.success ? 'rgba(16, 185, 129, 0.3)' : 'rgba(244, 63, 94, 0.3)'}`,
                color: testResult.success ? 'var(--accent-emerald)' : 'var(--accent-rose)'
              }}
            >
              {testResult.success ? (
                <CheckCircle2 size={18} style={{ flexShrink: 0 }} />
              ) : (
                <AlertCircle size={18} style={{ flexShrink: 0 }} />
              )}
              <span>{testResult.message}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
          <div>
            {currentCredentials?.isConnected && onClearCredentials && (
              <button className="btn btn-secondary" style={{ color: 'var(--accent-rose)', borderColor: 'rgba(244, 63, 94, 0.3)' }} onClick={handleClear}>
                Disconnect & Clear
              </button>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <button className="btn btn-secondary" onClick={handleTestConnection} disabled={isTesting || !isConfigValid()}>
              {isTesting ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  <span>Testing...</span>
                </>
              ) : (
                <span>Test Connection</span>
              )}
            </button>
            <button className="btn btn-primary" onClick={handleSave} disabled={!isConfigValid()}>
              <ShieldCheck size={16} />
              <span>Connect AI Provider</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
