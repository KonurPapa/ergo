import { type AIProviderConfig } from '../types';
import { bridgeClient } from './bridgeClient';

/**
 * Generic API call handler for Bring-Your-Own-AI providers (OpenAI, Anthropic, Gemini, Ollama)
 */
export async function callAiEngine(
  prompt: string,
  systemPrompt: string,
  config: AIProviderConfig,
  taskType: 'summary' | 'general' | 'autocomplete' = 'general',
  responseFormat: 'text' | 'json' = taskType === 'summary' ? 'json' : 'text',
  signal?: AbortSignal
): Promise<string> {
  const { provider, apiKey, baseUrl } = config;
  const targetModel = taskType === 'autocomplete'
    ? (config.autocompleteModel || config.generalModel || config.model)
    : taskType === 'summary'
      ? (config.summaryModel || config.generalModel || config.model)
      : (config.generalModel || config.model);

  // Subscription (CLI) profiles first: they can carry an API provider id (e.g. 'anthropic' for a Claude Code login)
  // with a placeholder key, which the provider branches below would send to the API as if it were real.
  if (provider === 'cli_subscription' || config.authMode === 'cli_subscription' || config.apiKey === 'cli_subscription_active') {
    const cliTarget = config.cliCustomCommand || config.cliAgentId || (
      config.provider === 'gemini' ? 'antigravity' :
      config.provider === 'openai' ? 'codex' :
      config.provider === 'cursor' ? 'cursor-cli' :
      config.provider === 'grok' ? 'grok-cli' :
      config.provider === 'ollama' ? 'aider' :
      config.model || 'claude'
    );
    // Map preset IDs like 'claude-code' to binary 'claude'
    const binary = cliTarget === 'claude-code'
      ? 'claude'
      : cliTarget === 'antigravity'
        ? 'agy'
        : cliTarget === 'cursor-cli'
          ? 'cursor'
          : cliTarget === 'grok-cli'
            ? 'grok'
            : cliTarget;

    const env: Record<string, string> = {};
    // Only other providers' keys: the subscription CLI's own key would override the user's login.
    if (config.providerKeys) {
      if (config.providerKeys.anthropic?.apiKey && binary !== 'claude') env['ANTHROPIC_API_KEY'] = config.providerKeys.anthropic.apiKey.trim();
      if (config.providerKeys.openai?.apiKey && binary !== 'codex') env['OPENAI_API_KEY'] = config.providerKeys.openai.apiKey.trim();
      if (config.providerKeys.gemini?.apiKey && binary !== 'agy') env['GEMINI_API_KEY'] = config.providerKeys.gemini.apiKey.trim();
      if (config.providerKeys.grok?.apiKey && binary !== 'grok') env['XAI_API_KEY'] = config.providerKeys.grok.apiKey.trim();
    }

    const res = await fetch(bridgeClient.getApiUrl('/api/cli/execute'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cli: binary,
        prompt,
        systemPrompt,
        // A one-shot answer, not agent work: the bridge runs the CLI without its tools, MCP servers, project memory and
        // built-in system prompt (~25k tokens of overhead per call on Claude Code), with this system prompt instead.
        mode: 'completion',
        model: targetModel,
        responseFormat,
        timeoutMs: taskType === 'autocomplete' ? 12_000 : 60_000,
        env
      }),
      signal
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `CLI bridge returned HTTP ${res.status}`);
    }

    const data = await res.json();
    if (!data.success && !data.output) {
      throw new Error(data.stderr || data.error || `CLI execution failed with exit code ${data.exitCode}`);
    }

    return data.output || data.stderr || '';
  }

  if (provider === 'openai') {
    if (!apiKey) throw new Error('OpenAI API key missing.');
    const reqBody: any = {
      model: targetModel || (taskType === 'summary' ? 'gpt-4o' : 'gpt-5.4'),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ]
    };
    if (responseFormat === 'json') {
      reqBody.response_format = { type: 'json_object' };
    }
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(reqBody),
      signal
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `OpenAI API returned HTTP ${res.status}`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }

  if (provider === 'grok') {
    if (!apiKey) throw new Error('xAI Grok API key missing.');
    const reqBody: any = {
      model: targetModel || (taskType === 'summary' ? 'grok-3' : 'grok-3'),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ]
    };
    if (responseFormat === 'json') {
      reqBody.response_format = { type: 'json_object' };
    }
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(reqBody),
      signal
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `xAI API returned HTTP ${res.status}`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }

  if (provider === 'cursor') {
    // If API key is provided for Cursor, route through OpenAI-compatible endpoint or report configured state
    if (apiKey) {
      const reqBody: any = {
        model: targetModel || 'cursor-agent',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt }
        ]
      };
      if (responseFormat === 'json') {
        reqBody.response_format = { type: 'json_object' };
      }
      const host = (baseUrl || 'https://api.cursor.com/v1').replace(/\/+$/, '');
      const res = await fetch(`${host}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(reqBody),
        signal
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || `Cursor API returned HTTP ${res.status}`);
      }
      const data = await res.json();
      return data.choices?.[0]?.message?.content || '';
    }
  }

  if (provider === 'anthropic') {
    if (!apiKey) throw new Error('Anthropic API key missing.');
    // Bare family aliases (from older profiles) map to the current model of that family; real ids pass through.
    const ANTHROPIC_ALIASES: Record<string, string> = { 'claude-opus': 'claude-opus-5-5', 'claude-sonnet': 'claude-sonnet-5-5', 'claude-haiku': 'claude-haiku-5-5' };
    const requested = targetModel || 'claude-sonnet-5-5';
    const modelName = ANTHROPIC_ALIASES[requested] || requested;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: modelName,
        max_tokens: 4000,
        // Prompt caching: the system prompt (skill docs, instructions) is the stable prefix across calls.
        system: systemPrompt ? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }] : undefined,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `Anthropic API returned HTTP ${res.status}`);
    }
    const data = await res.json();
    return data.content?.[0]?.text || '';
  }

  if (provider === 'gemini') {
    if (!apiKey) throw new Error('Google Gemini API key missing.');
    const geminiModel = targetModel || (taskType === 'summary' ? 'gemini-3.7-flash' : 'gemini-4-argon');
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${systemPrompt}\n\nUSER PROMPT:\n${prompt}` }] }]
        }),
        signal
      }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `Gemini API returned HTTP ${res.status}`);
    }
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  if (provider === 'ollama') {
    const host = (baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
    const reqBody: any = {
      model: targetModel || (taskType === 'summary' ? 'llama3.2' : 'qwen2.5-coder'),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ],
      stream: false,
      options: {
        num_ctx: 16384,
        num_predict: 4096,
        temperature: 0.2
      }
    };
    if (responseFormat === 'json') {
      reqBody.format = 'json';
    }
    const res = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reqBody),
      signal
    });
    if (!res.ok) {
      await res.json().catch(() => ({}));
      throw new Error(`Ollama server at ${host} returned HTTP ${res.status}`);
    }
    const data = await res.json();
    return data.message?.content || '';
  }

  throw new Error('Simulated engine active.');
}

/**
 * Strips YAML frontmatter (--- ... ---) from a SKILL.md document so only the instructions remain.
 */
export function stripSkillFrontmatter(raw?: string | null): string {
  if (!raw) return '';
  if (raw.startsWith('---')) {
    const parts = raw.split('---');
    if (parts.length >= 3) {
      return parts.slice(2).join('---').trim();
    }
  }
  return raw.trim();
}

/**
 * Safely extracts a clean string from an arbitrary AI JSON property (string, array of strings/objects, etc.)
 */
export function extractStringFromAiValue(val: any, fallback: string = ''): string {
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'string') return val.trim();
  if (Array.isArray(val)) {
    const list = val
      .map((item) => {
        if (typeof item === 'string') return item.trim();
        if (typeof item === 'object' && item !== null) {
          return Object.values(item)
            .filter((v) => typeof v === 'string')
            .join(' ')
            .trim();
        }
        return String(item).trim();
      })
      .filter(Boolean);
    if (list.length === 0) return fallback;
    return list
      .map((line, idx) => (/^[0-9]+[.)-]/.test(line) ? line : `${idx + 1}. ${line}`))
      .join('\n');
  }
  if (typeof val === 'object') {
    const joined = Object.values(val)
      .filter((v) => typeof v === 'string')
      .join(' ')
      .trim();
    return joined || fallback;
  }
  return String(val).trim() || fallback;
}

/**
 * Parses JSON from an AI response, tolerating markdown fences and leading/trailing prose.
 * Returns null if nothing parseable is found.
 */
export function parseJsonLoose<T = any>(raw: string): T | null {
  if (!raw) return null;
  const cleaned = raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {}
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1)) as T;
    } catch {}
  }
  const firstBracket = cleaned.indexOf('[');
  const lastBracket = cleaned.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    try {
      return JSON.parse(cleaned.slice(firstBracket, lastBracket + 1)) as T;
    } catch {}
  }
  return null;
}
