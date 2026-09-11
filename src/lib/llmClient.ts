import { type AIProviderConfig } from '../types';

/**
 * Generic API call handler for Bring-Your-Own-AI providers (OpenAI, Anthropic, Gemini, Ollama)
 */
export async function callAiEngine(
  prompt: string,
  systemPrompt: string,
  config: AIProviderConfig,
  taskType: 'discovery' | 'summary' | 'general' = 'general',
  responseFormat: 'text' | 'json' = (taskType === 'discovery' || taskType === 'summary') ? 'json' : 'text',
  signal?: AbortSignal
): Promise<string> {
  const { provider, apiKey, baseUrl } = config;
  const targetModel = taskType === 'discovery'
    ? (config.discoveryModel || config.generalModel || config.model)
    : taskType === 'summary'
      ? (config.summaryModel || config.generalModel || config.model)
      : (config.generalModel || config.model);

  if (provider === 'openai') {
    if (!apiKey) throw new Error('OpenAI API key missing.');
    const reqBody: any = {
      model: targetModel || (taskType === 'discovery' ? 'gpt-4o-mini' : taskType === 'summary' ? 'gpt-4o' : 'gpt-5.4'),
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

  if (provider === 'anthropic') {
    if (!apiKey) throw new Error('Anthropic API key missing.');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: targetModel || (taskType === 'discovery' ? 'claude-3-5-haiku-20241022' : taskType === 'summary' ? 'claude-3-7-sonnet-20250219' : 'claude-opus-5'),
        max_tokens: 4000,
        system: systemPrompt,
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
    const geminiModel = targetModel || (taskType === 'discovery' ? 'gemini-2.0-flash' : taskType === 'summary' ? 'gemini-3.7-flash' : 'gemini-3.7-pro');
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
      model: targetModel || (taskType === 'discovery' ? 'llama3.2' : taskType === 'summary' ? 'llama3.2' : 'qwen2.5-coder'),
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

  if (provider === 'cli_subscription' || config.authMode === 'cli_subscription') {
    const cliCommand = config.cliCustomCommand || config.model || 'claude';
    // Map preset IDs like 'claude-code' to binary 'claude'
    const binary = cliCommand === 'claude-code'
      ? 'claude'
      : cliCommand === 'antigravity'
        ? 'agy'
        : cliCommand;

    const res = await fetch('/api/cli/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cli: binary,
        prompt,
        systemPrompt,
        responseFormat,
        timeoutMs: 180_000
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
