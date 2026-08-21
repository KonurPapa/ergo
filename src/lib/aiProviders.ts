import { type AIProviderId, type ProviderCredentials } from '../types';

export interface ProviderModel {
  id: string;
  name: string;
  description: string;
  tier?: 'light' | 'standard' | 'advanced' | 'reasoning';
}

export interface ProviderMeta {
  id: AIProviderId;
  name: string;
  shortName: string;
  description: string;
  icon: string;
  iconUrl?: string;
  badgeColor: string;
  requiresKey: boolean;
  requiresBaseUrl: boolean;
  defaultModel: string;
  defaultDiscoveryModel: string;
  defaultGeneralModel: string;
  defaultBaseUrl?: string;
  keyPlaceholder?: string;
  keyDocUrl?: string;
  models: ProviderModel[];
}

export const SUPPORTED_AI_PROVIDERS: ProviderMeta[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    shortName: 'OpenAI',
    description: 'GPT-4o, GPT-4o-mini & o3-mini models via OpenAI API',
    icon: '🤖',
    iconUrl: '/icons/providers/openai.svg',
    badgeColor: '#10a37f',
    requiresKey: true,
    requiresBaseUrl: false,
    defaultModel: 'gpt-4o',
    defaultDiscoveryModel: 'gpt-4o-mini',
    defaultGeneralModel: 'gpt-4o',
    keyPlaceholder: 'sk-proj-...',
    keyDocUrl: 'https://platform.openai.com/api-keys',
    models: [
      { id: 'gpt-4o-mini', name: 'GPT-4o mini', description: 'Fast, cost-efficient & responsive (Ideal for Discovery)', tier: 'light' },
      { id: 'gpt-4o', name: 'GPT-4o', description: 'Flagship high-intelligence multimodal model (Ideal for General Tasks)', tier: 'standard' },
      { id: 'o3-mini', name: 'o3-mini', description: 'High-reasoning small model for complex logic', tier: 'reasoning' },
      { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', description: 'Previous generation high-capability model', tier: 'standard' }
    ]
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    shortName: 'Anthropic',
    description: 'Claude 3.7 Sonnet, 3.5 Sonnet & Haiku models',
    icon: '🧠',
    iconUrl: '/icons/providers/anthropic.svg',
    badgeColor: '#d97706',
    requiresKey: true,
    requiresBaseUrl: false,
    defaultModel: 'claude-3-7-sonnet-20250219',
    defaultDiscoveryModel: 'claude-3-5-haiku-20241022',
    defaultGeneralModel: 'claude-3-7-sonnet-20250219',
    keyPlaceholder: 'sk-ant-api03-...',
    keyDocUrl: 'https://console.anthropic.com/settings/keys',
    models: [
      { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', description: 'Blazing fast intelligence for quick tasks (Ideal for Discovery)', tier: 'light' },
      { id: 'claude-3-7-sonnet-20250219', name: 'Claude 3.7 Sonnet', description: 'Hybrid reasoning and leading coding (Ideal for General Tasks)', tier: 'advanced' },
      { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', description: 'High performance for broad tasks and code', tier: 'standard' }
    ]
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    shortName: 'Gemini',
    description: 'Gemini 2.5 Flash & 1.5 Pro multimodal models',
    icon: '✨',
    iconUrl: '/icons/providers/gemini.svg',
    badgeColor: '#3b82f6',
    requiresKey: true,
    requiresBaseUrl: false,
    defaultModel: 'gemini-2.5-flash',
    defaultDiscoveryModel: 'gemini-2.5-flash',
    defaultGeneralModel: 'gemini-1.5-pro',
    keyPlaceholder: 'AIzaSy...',
    keyDocUrl: 'https://aistudio.google.com/app/apikey',
    models: [
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', description: 'Ultra-fast, next-gen multimodal AI (Ideal for Discovery)', tier: 'light' },
      { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', description: 'Complex reasoning with 2M token context (Ideal for General Tasks)', tier: 'advanced' },
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', description: 'High speed and low latency', tier: 'light' }
    ]
  },
  {
    id: 'ollama',
    name: 'Local (Ollama)',
    shortName: 'Ollama',
    description: 'Privacy-focused local LLMs running on your machine',
    icon: '💻',
    iconUrl: '/icons/providers/ollama.svg',
    badgeColor: '#8b5cf6',
    requiresKey: false,
    requiresBaseUrl: true,
    defaultModel: 'llama3.2',
    defaultDiscoveryModel: 'llama3.2',
    defaultGeneralModel: 'qwen2.5-coder',
    defaultBaseUrl: 'http://localhost:11434',
    keyDocUrl: 'https://ollama.com',
    models: [
      { id: 'llama3.2', name: 'Llama 3.2', description: 'Meta lightweight local open model (Ideal for Discovery)', tier: 'light' },
      { id: 'qwen2.5-coder', name: 'Qwen 2.5 Coder', description: 'Specialized high-accuracy coding model (Ideal for General Tasks)', tier: 'standard' },
      { id: 'deepseek-r1', name: 'DeepSeek R1', description: 'Advanced open reasoning model', tier: 'reasoning' },
      { id: 'mistral', name: 'Mistral 7B', description: 'Fast and high capability open weights', tier: 'standard' },
      { id: 'codellama', name: 'CodeLlama', description: 'Fine-tuned for code generation and refactoring', tier: 'standard' }
    ]
  }
];

/**
 * Tests connection to the specified AI provider using provided credentials.
 */
export async function testAiConnection(
  providerId: AIProviderId,
  credentials: ProviderCredentials
): Promise<{ success: boolean; message: string }> {
  try {
    if (providerId === 'mock' || providerId === 'none') {
      return { success: false, message: 'No active AI provider selected.' };
    }

    if (providerId === 'openai') {
      if (!credentials.apiKey) {
        return { success: false, message: 'OpenAI API Key is required.' };
      }
      const res = await fetch('https://api.openai.com/v1/models', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${credentials.apiKey}`
        }
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return { success: false, message: err.error?.message || `OpenAI returned status ${res.status}` };
      }
      return { success: true, message: 'Connected successfully to OpenAI API!' };
    }

    if (providerId === 'anthropic') {
      if (!credentials.apiKey) {
        return { success: false, message: 'Anthropic API Key is required.' };
      }
      // Send lightweight test message to Anthropic
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': credentials.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model: credentials.model || 'claude-3-5-haiku-20241022',
          max_tokens: 5,
          messages: [{ role: 'user', content: 'Ping' }]
        })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return { success: false, message: err.error?.message || `Anthropic returned status ${res.status}` };
      }
      return { success: true, message: 'Connected successfully to Anthropic API!' };
    }

    if (providerId === 'gemini') {
      if (!credentials.apiKey) {
        return { success: false, message: 'Google Gemini API Key is required.' };
      }
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${credentials.apiKey}`
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return { success: false, message: err.error?.message || `Gemini returned status ${res.status}` };
      }
      return { success: true, message: 'Connected successfully to Google Gemini API!' };
    }

    if (providerId === 'ollama') {
      const baseUrl = (credentials.baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
      const res = await fetch(`${baseUrl}/api/tags`, {
        method: 'GET'
      }).catch((e) => {
        throw new Error(`Failed to reach Ollama at ${baseUrl}. Ensure Ollama is running with CORS enabled (OLLAMA_ORIGINS="*"). ${e.message}`);
      });

      if (!res.ok) {
        return { success: false, message: `Ollama server at ${baseUrl} returned status ${res.status}` };
      }
      const data = await res.json().catch(() => ({ models: [] }));
      const modelCount = data.models?.length || 0;
      return {
        success: true,
        message: `Connected successfully to Local Ollama! Found ${modelCount} installed models.`
      };
    }

    return { success: false, message: 'Unsupported provider ID.' };
  } catch (error: any) {
    return {
      success: false,
      message: error.message || 'Connection failed. Please check network or CORS configuration.'
    };
  }
}
