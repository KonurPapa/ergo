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
  defaultSummaryModel: string;
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
    description: 'GPT-5.4, GPT-5.2, GPT-5, o3, o3-pro, o3-mini & GPT-4.5 models via OpenAI API',
    icon: '🤖',
    iconUrl: '/icons/providers/openai.svg',
    badgeColor: '#10a37f',
    requiresKey: true,
    requiresBaseUrl: false,
    defaultModel: 'gpt-5.4',
    defaultDiscoveryModel: 'gpt-5-mini',
    defaultSummaryModel: 'gpt-5',
    defaultGeneralModel: 'gpt-5.4',
    keyPlaceholder: 'sk-proj-...',
    keyDocUrl: 'https://platform.openai.com/api-keys',
    models: [
      { id: 'gpt-5.4', name: 'GPT-5.4', description: 'Flagship frontier frontier model with state-of-the-art coding and agentic execution', tier: 'advanced' },
      { id: 'gpt-5.2', name: 'GPT-5.2', description: 'Next-generation high-capability frontier model', tier: 'advanced' },
      { id: 'gpt-5', name: 'GPT-5', description: 'Frontier standard multimodal intelligence', tier: 'advanced' },
      { id: 'gpt-5-mini', name: 'GPT-5 mini', description: 'Fast, cost-efficient next-gen model (Ideal for Discovery)', tier: 'light' },
      { id: 'o3-pro', name: 'o3-pro', description: 'Maximum depth reasoning model for complex STEM, math and architecture', tier: 'reasoning' },
      { id: 'o3', name: 'o3', description: 'Flagship deep reasoning model', tier: 'reasoning' },
      { id: 'o3-mini', name: 'o3-mini', description: 'High-speed reasoning model for coding and logic', tier: 'reasoning' },
      { id: 'gpt-4.5-preview', name: 'GPT-4.5 Preview', description: 'Large-scale world knowledge frontier model', tier: 'advanced' },
      { id: 'o1', name: 'o1 (Full Reasoning)', description: 'Complex reasoning and multi-step logic', tier: 'reasoning' },
      { id: 'gpt-4o', name: 'GPT-4o', description: 'High-intelligence multimodal flagship model', tier: 'standard' },
      { id: 'gpt-4o-mini', name: 'GPT-4o mini', description: 'Lightweight & responsive model', tier: 'light' }
    ]
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    shortName: 'Anthropic',
    description: 'Claude Mythos 5, Claude Fable 5, Claude Opus 5 & Claude Sonnet 5',
    icon: '🧠',
    iconUrl: '/icons/providers/anthropic.svg',
    badgeColor: '#D97757',
    requiresKey: true,
    requiresBaseUrl: false,
    defaultModel: 'claude-opus-5',
    defaultDiscoveryModel: 'claude-3-5-haiku-20241022',
    defaultSummaryModel: 'claude-3-7-sonnet-20250219',
    defaultGeneralModel: 'claude-opus-5',
    keyPlaceholder: 'sk-ant-api03-...',
    keyDocUrl: 'https://console.anthropic.com/settings/keys',
    models: [
      { id: 'claude-fable-5', name: 'Claude Fable 5', description: 'Anthropic’s most capable widely released frontier model', tier: 'advanced' },
      { id: 'claude-opus-5', name: 'Claude Opus 5', description: 'Complex agentic coding, deep architecture and enterprise work', tier: 'advanced' },
      { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', description: 'State-of-the-art balance of speed, intelligence and coding', tier: 'standard' },
      { id: 'claude-mythos-5', name: 'Claude Mythos 5', description: 'High-assurance cybersecurity & specialized reasoning', tier: 'reasoning' },
      { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', description: 'Deep analysis and advanced agentic execution', tier: 'advanced' },
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', description: 'High capability model with extended output support', tier: 'advanced' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', description: 'High performance coding and workflow execution', tier: 'standard' },
      { id: 'claude-3-7-sonnet-20250219', name: 'Claude 3.7 Sonnet', description: 'Hybrid standard and extended thinking reasoning', tier: 'standard' },
      { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', description: 'Previous-generation workhorse coding model', tier: 'standard' },
      { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', description: 'Fast, lightweight responsiveness', tier: 'light' }
    ]
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    shortName: 'Gemini',
    description: 'Gemini 3.7 Flash, Gemini 3.7 Pro, Gemini 3.5 & 3.0 multimodal models',
    icon: '✨',
    iconUrl: '/icons/providers/gemini.svg',
    badgeColor: '#3b82f6',
    requiresKey: true,
    requiresBaseUrl: false,
    defaultModel: 'gemini-3.7-flash',
    defaultDiscoveryModel: 'gemini-2.0-flash',
    defaultSummaryModel: 'gemini-3.7-flash',
    defaultGeneralModel: 'gemini-3.7-pro',
    keyPlaceholder: 'AIzaSy...',
    keyDocUrl: 'https://aistudio.google.com/app/apikey',
    models: [
      { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', description: 'Next-gen flagship hybrid reasoning and ultra-fast generation', tier: 'standard' },
      { id: 'gemini-3.7-pro', name: 'Gemini 3.7 Pro', description: 'Deep reasoning, agentic coding and complex logic', tier: 'advanced' },
      { id: 'gemini-3.7-flash-thinking', name: 'Gemini 3.7 Flash Thinking', description: 'Explicit thinking process with adjustable budget', tier: 'reasoning' },
      { id: 'gemini-3.5-pro', name: 'Gemini 3.5 Pro', description: 'Advanced reasoning and multi-modal architecture', tier: 'advanced' },
      { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', description: 'Ultra-fast frontier intelligence', tier: 'light' },
      { id: 'gemini-3.0-flash', name: 'Gemini 3.0 Flash', description: 'High-speed modern multimodal generation', tier: 'light' },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: 'Deep complex reasoning with 2M+ token context', tier: 'advanced' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', description: 'Ultra-fast, responsive multimodal model', tier: 'light' },
      { id: 'gemini-2.0-flash-thinking-exp', name: 'Gemini 2.0 Flash Thinking', description: 'Explicit thinking and multi-step reasoning', tier: 'reasoning' },
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', description: 'High speed and low latency', tier: 'light' },
      { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', description: 'Long context reasoning model', tier: 'advanced' }
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
    defaultSummaryModel: 'llama3.2',
    defaultGeneralModel: 'qwen2.5-coder',
    defaultBaseUrl: 'http://localhost:11434',
    keyDocUrl: 'https://ollama.com',
    models: []
  }
];

export async function fetchOpenAIModels(apiKey: string): Promise<ProviderModel[]> {
  const res = await fetch('https://api.openai.com/v1/models', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`
    }
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `OpenAI returned status ${res.status}`);
  }

  const data = await res.json();
  const rawList: any[] = data.data || [];

  // Filter for chat completion relevant models
  const chatModels = rawList
    .map((m: any) => m.id as string)
    .filter((id: string) => {
      const lower = id.toLowerCase();
      return (
        (lower.startsWith('gpt-') || lower.startsWith('o1') || lower.startsWith('o3') || lower.startsWith('o4') || lower.startsWith('chatgpt-')) &&
        !lower.includes('realtime') &&
        !lower.includes('audio') &&
        !lower.includes('embedding') &&
        !lower.includes('tts') &&
        !lower.includes('whisper') &&
        !lower.includes('dall-e') &&
        !lower.includes('moderation') &&
        !lower.includes('instruct')
      );
    });

  // Sort prioritizing newest frontier models
  chatModels.sort((a, b) => {
    const score = (id: string) => {
      if (id.startsWith('gpt-5.4')) return 120;
      if (id.startsWith('gpt-5.2')) return 115;
      if (id.startsWith('gpt-5')) return 110;
      if (id.startsWith('o3-pro')) return 105;
      if (id.startsWith('o3')) return 100;
      if (id.startsWith('gpt-4.5')) return 95;
      if (id === 'o1') return 90;
      if (id.startsWith('o1')) return 85;
      if (id.startsWith('gpt-4o-mini')) return 70;
      if (id.startsWith('gpt-4o')) return 75;
      if (id.startsWith('chatgpt-4o')) return 65;
      return 10;
    };
    return score(b) - score(a);
  });

  // Combine with presets in case newly released models aren't indexed yet
  const fetchedSet = new Set(chatModels);
  const staticOpenAI = SUPPORTED_AI_PROVIDERS.find((p) => p.id === 'openai')?.models || [];
  const merged: ProviderModel[] = [];

  for (const id of chatModels) {
    const isReasoning = id.startsWith('o1') || id.startsWith('o3') || id.startsWith('o4');
    const isLight = id.includes('mini') || id.includes('flash');
    const isAdv = id.startsWith('gpt-5') || id.startsWith('gpt-4.5') || id.includes('pro') || id === 'o1';
    merged.push({
      id,
      name: id,
      description: isReasoning ? 'Reasoning model' : isLight ? 'Lightweight / Fast' : isAdv ? 'Frontier intelligence' : 'General intelligence',
      tier: isReasoning ? 'reasoning' : isLight ? 'light' : isAdv ? 'advanced' : 'standard'
    });
  }

  for (const sm of staticOpenAI) {
    if (!fetchedSet.has(sm.id)) {
      merged.push(sm);
    }
  }

  return merged;
}

export async function fetchAnthropicModels(apiKey: string): Promise<ProviderModel[]> {
  try {
    const res = await fetch('https://api.anthropic.com/v1/models', {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      }
    });

    if (res.ok) {
      const data = await res.json();
      const rawModels: any[] = data.data || [];
      if (rawModels.length > 0) {
        return rawModels.map((m: any) => {
          const id = m.id || m.name || '';
          const displayName = m.display_name || id;
          const isReasoning = id.includes('mythos') || id.includes('thinking');
          const isLight = id.includes('haiku') || id.includes('flash');
          const isAdv = id.includes('fable') || id.includes('opus') || id.includes('5');
          return {
            id,
            name: displayName,
            description: m.description || (isReasoning ? 'High-assurance reasoning model' : isAdv ? 'Frontier model' : 'General task intelligence'),
            tier: (isReasoning ? 'reasoning' : isLight ? 'light' : isAdv ? 'advanced' : 'standard') as ProviderModel['tier']
          };
        });
      }
    }
  } catch {}

  // Fallback to latest comprehensive frontier models list
  const anthropicProvider = SUPPORTED_AI_PROVIDERS.find((p) => p.id === 'anthropic');
  return anthropicProvider?.models || [];
}

export async function fetchGeminiModels(apiKey: string): Promise<ProviderModel[]> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Gemini returned status ${res.status}`);
  }

  const data = await res.json();
  const rawList: any[] = data.models || [];

  const geminiModels: ProviderModel[] = rawList
    .filter((m: any) => {
      const methods: string[] = m.supportedGenerationMethods || [];
      return methods.includes('generateContent') && m.name && !m.name.includes('embedding') && !m.name.includes('aqa');
    })
    .map((m: any) => {
      const cleanId = (m.name || '').replace(/^models\//, '');
      const isReasoning = cleanId.includes('thinking');
      const isLight = cleanId.includes('flash') && !isReasoning;
      const isAdv = cleanId.includes('pro') || cleanId.includes('3.5') || cleanId.includes('3.0');
      return {
        id: cleanId,
        name: m.displayName || cleanId,
        description: m.description ? (m.description.length > 80 ? `${m.description.slice(0, 77)}...` : m.description) : 'Gemini Model',
        tier: isReasoning ? 'reasoning' : isLight ? 'light' : isAdv ? 'advanced' : 'standard'
      };
    });

  // Sort prioritizing newer 3.7, 3.5, 3.0, 2.5 and 2.0 models
  geminiModels.sort((a, b) => {
    const score = (id: string) => {
      if (id.includes('3.7-pro')) return 140;
      if (id.includes('3.7-flash-thinking')) return 135;
      if (id.includes('3.7-flash')) return 130;
      if (id.includes('3.7')) return 125;
      if (id.includes('3.5-pro')) return 120;
      if (id.includes('3.5-flash')) return 115;
      if (id.includes('3.0-flash')) return 110;
      if (id.includes('2.5-pro')) return 100;
      if (id.includes('2.5-flash')) return 95;
      if (id.includes('2.0-flash-thinking')) return 90;
      if (id.includes('2.0-flash')) return 85;
      if (id.includes('1.5-pro')) return 70;
      if (id.includes('1.5-flash')) return 65;
      return 10;
    };
    return score(b.id) - score(a.id);
  });

  // Combine with static presets in case of API filtering
  const staticGemini = SUPPORTED_AI_PROVIDERS.find((p) => p.id === 'gemini')?.models || [];
  const fetchedSet = new Set(geminiModels.map((m) => m.id));
  for (const sm of staticGemini) {
    if (!fetchedSet.has(sm.id)) {
      geminiModels.push(sm);
    }
  }

  return geminiModels;
}

export async function fetchOllamaModels(baseUrl: string): Promise<ProviderModel[]> {
  const cleanUrl = (baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
  const res = await fetch(`${cleanUrl}/api/tags`, {
    method: 'GET'
  });

  if (!res.ok) {
    throw new Error(`Ollama server at ${cleanUrl} returned status ${res.status}`);
  }

  const data = await res.json().catch(() => ({ models: [] }));
  const rawModels: any[] = data.models || [];

  return rawModels.map((m: any) => {
    const modelName = m.name || m.model || 'unknown';
    const sizeDetails = m.details?.parameter_size ? ` (${m.details.parameter_size})` : '';
    return {
      id: modelName,
      name: `${modelName}${sizeDetails}`,
      description: `Local model (${m.details?.family || 'ollama'})`,
      tier: 'standard'
    };
  });
}

/**
 * Tests connection to the specified AI provider using provided credentials.
 */
export async function testAiConnection(
  providerId: AIProviderId,
  credentials: ProviderCredentials
): Promise<{ success: boolean; message: string; models?: ProviderModel[] }> {
  try {
    if (providerId === 'mock' || providerId === 'none') {
      return { success: false, message: 'No active AI provider selected.' };
    }

    if (providerId === 'openai') {
      if (!credentials.apiKey) {
        return { success: false, message: 'OpenAI API Key is required.' };
      }
      try {
        const models = await fetchOpenAIModels(credentials.apiKey);
        return {
          success: true,
          message: `Connected successfully to OpenAI API! Loaded ${models.length} available models.`,
          models
        };
      } catch (e: any) {
        return { success: false, message: e.message || 'Failed to connect to OpenAI API.' };
      }
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
          model: credentials.model || 'claude-sonnet-5',
          max_tokens: 5,
          messages: [{ role: 'user', content: 'Ping' }]
        })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        // If claude-sonnet-5 is not accessible, test with claude-3-5-haiku
        const fallbackRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': credentials.apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true'
          },
          body: JSON.stringify({
            model: 'claude-3-5-haiku-20241022',
            max_tokens: 5,
            messages: [{ role: 'user', content: 'Ping' }]
          })
        });
        if (!fallbackRes.ok) {
          const fallbackErr = await fallbackRes.json().catch(() => ({}));
          return { success: false, message: fallbackErr.error?.message || err.error?.message || `Anthropic returned status ${res.status}` };
        }
      }

      const models = await fetchAnthropicModels(credentials.apiKey);
      return {
        success: true,
        message: `Connected successfully to Anthropic API! Available models loaded.`,
        models
      };
    }

    if (providerId === 'gemini') {
      if (!credentials.apiKey) {
        return { success: false, message: 'Google Gemini API Key is required.' };
      }
      try {
        const models = await fetchGeminiModels(credentials.apiKey);
        return {
          success: true,
          message: `Connected successfully to Google Gemini API! Loaded ${models.length} models.`,
          models
        };
      } catch (e: any) {
        return { success: false, message: e.message || 'Failed to connect to Google Gemini API.' };
      }
    }

    if (providerId === 'ollama') {
      const baseUrl = (credentials.baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
      try {
        const models = await fetchOllamaModels(baseUrl);
        const modelCount = models.length;
        return {
          success: true,
          message: modelCount > 0
            ? `Connected successfully to Local Ollama! Found ${modelCount} installed model${modelCount === 1 ? '' : 's'}.`
            : `Connected to Local Ollama, but no installed models were found. Run 'ollama pull <model>' to download one.`,
          models
        };
      } catch (e: any) {
        return {
          success: false,
          message: `Failed to reach Ollama at ${baseUrl}. Ensure Ollama is running (e.g. 'ollama serve') and CORS allows browser requests (OLLAMA_ORIGINS="*"). ${e.message || ''}`
        };
      }
    }

    return { success: false, message: 'Unsupported provider ID.' };
  } catch (error: any) {
    return {
      success: false,
      message: error.message || 'Connection failed. Please check network or CORS configuration.'
    };
  }
}
