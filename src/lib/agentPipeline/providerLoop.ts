/**
 * Provider-agnostic multi-turn tool loop (Anthropic / OpenAI / Gemini / Ollama) over raw fetch.
 *
 * Context-engineering rules satisfied here:
 *  - Byte-stable prefix + prompt caching: the system prompt is rendered as
 *    [stableSystem][sharedContext][volatileSystem]. On Anthropic the first two are separate
 *    cached blocks (`cache_control: ephemeral`); a third, moving breakpoint sits on the newest
 *    tool_result so each round re-reads the growing transcript from cache. OpenAI / Gemini cache
 *    identical prefixes automatically, so the same ordering pays off there too.
 *  - Parallel tool calls: every tool_use of a turn is executed in one batch and returned in ONE
 *    user message (splitting them would train the model to stop parallelising).
 *  - Preserve high-signal errors: tool errors travel back as `is_error` results, API errors are
 *    returned (not thrown) with the provider's message so callers can log them into the bible.
 *  - Route at task boundaries: the model is fixed for the whole loop.
 */
import {
  type ToolCallRequest,
  type ToolCallResult,
  type ToolDefinition,
  type ToolLoopRequest,
  type ToolLoopResult,
  type ToolLoopStopReason,
  addUsage,
  emptyUsage,
  throwIfAborted
} from './contracts';
import { toAnthropicTools, toGeminiTools, toOpenAiTools } from './toolSchemas';
import { type TokenUsage } from '../../types';

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
const MAX_ATTEMPTS = 3;

interface FetchOutcome {
  ok: boolean;
  status: number;
  json: any;
  errorMessage?: string;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('Agent terminated by user.', 'AbortError'));
      },
      { once: true }
    );
  });
}

function extractErrorMessage(json: any, status: number, fallback: string): string {
  if (!json) return `${fallback} HTTP ${status}`;
  return (
    json?.error?.message ||
    (typeof json?.error === 'string' ? json.error : undefined) ||
    json?.message ||
    `${fallback} HTTP ${status}`
  );
}

/** POST JSON with retry on transient failures. Never throws for HTTP errors; throws only on abort. */
async function postJsonWithRetry(url: string, headers: Record<string, string>, body: any, signal: AbortSignal | undefined, providerLabel: string): Promise<FetchOutcome> {
  let lastOutcome: FetchOutcome = { ok: false, status: 0, json: null, errorMessage: 'No response' };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    throwIfAborted(signal);
    try {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
      const json = await res.json().catch(() => null);
      if (res.ok) return { ok: true, status: res.status, json };
      lastOutcome = { ok: false, status: res.status, json, errorMessage: extractErrorMessage(json, res.status, `${providerLabel} API error`) };
      if (!RETRYABLE_STATUS.has(res.status) || attempt === MAX_ATTEMPTS) return lastOutcome;
      const retryAfter = Number(res.headers.get('retry-after'));
      const backoffMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 30_000) : 1000 * 2 ** (attempt - 1);
      await sleep(backoffMs, signal);
    } catch (err: any) {
      if (err?.name === 'AbortError') throw err;
      lastOutcome = { ok: false, status: 0, json: null, errorMessage: `${providerLabel} network error: ${err?.message || String(err)}` };
      if (attempt === MAX_ATTEMPTS) return lastOutcome;
      await sleep(1000 * 2 ** (attempt - 1), signal);
    }
  }
  return lastOutcome;
}

function joinSystem(req: ToolLoopRequest): string {
  return [req.sharedContext, req.stableSystem, req.volatileSystem].filter((s) => s && s.trim().length > 0).join('\n\n');
}

function makeResult(text: string, rounds: number, toolCallCount: number, usage: TokenUsage, stopReason: ToolLoopStopReason, error?: string): ToolLoopResult {
  return { text: text.trim(), rounds, toolCallCount, usage, stopReason, error };
}

function safeParseArgs(raw: any): Record<string, any> {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

async function dispatchToolCalls(req: ToolLoopRequest, calls: ToolCallRequest[]): Promise<ToolCallResult[]> {
  if (!req.onToolCalls) {
    return calls.map((c) => ({ id: c.id, name: c.name, content: 'ERROR: no tools are available in this phase.', isError: true }));
  }
  return req.onToolCalls(calls);
}

/** Runs one agent loop against the configured provider. */
export async function runToolLoop(req: ToolLoopRequest): Promise<ToolLoopResult> {
  const usage = emptyUsage();
  if (req.provider === 'none' || req.provider === 'mock') {
    return makeResult('', 0, 0, usage, 'error', 'No live AI provider configured.');
  }
  const tools = req.tools || [];
  switch (req.provider) {
    case 'anthropic':
      return runAnthropic(req, tools, usage);
    case 'openai':
      return runOpenAiCompatible(req, tools, usage, 'openai');
    case 'ollama':
      return runOpenAiCompatible(req, tools, usage, 'ollama');
    case 'gemini':
      return runGemini(req, tools, usage);
    default:
      return makeResult('', 0, 0, usage, 'error', `Unsupported provider: ${req.provider}`);
  }
}

// ─── Anthropic ──────────────────────────────────────────────────────────────

async function runAnthropic(req: ToolLoopRequest, tools: ToolDefinition[], usage: TokenUsage): Promise<ToolLoopResult> {
  if (!req.apiKey) return makeResult('', 0, 0, usage, 'error', 'Anthropic API key missing.');
  const system: any[] = [];
  // Block order: shared bible (identical for every agent in the run) → role prompt → volatile tail.
  if (req.sharedContext?.trim()) system.push({ type: 'text', text: req.sharedContext, cache_control: { type: 'ephemeral' } });
  if (req.stableSystem?.trim()) system.push({ type: 'text', text: req.stableSystem, cache_control: { type: 'ephemeral' } });
  if (req.volatileSystem?.trim()) system.push({ type: 'text', text: req.volatileSystem });

  const messages: any[] = [{ role: 'user', content: req.initialUserMessage }];
  const anthropicTools = tools.length > 0 ? toAnthropicTools(tools) : undefined;
  let lastText = '';
  let toolCallCount = 0;
  let firstResponseFired = false;
  let lastToolResultMessage: any | null = null;

  for (let round = 1; round <= req.maxRounds; round++) {
    throwIfAborted(req.signal);
    const body: any = {
      model: req.model || 'claude-opus-5',
      max_tokens: req.maxTokens ?? 16000,
      system,
      messages
    };
    if (anthropicTools) body.tools = anthropicTools;

    const outcome = await postJsonWithRetry(
      'https://api.anthropic.com/v1/messages',
      {
        'Content-Type': 'application/json',
        'x-api-key': req.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body,
      req.signal,
      'Anthropic'
    );
    if (!outcome.ok) return makeResult(lastText, round, toolCallCount, usage, 'error', outcome.errorMessage);

    const data = outcome.json || {};
    const delta: TokenUsage = {
      inputTokens: data.usage?.input_tokens || 0,
      outputTokens: data.usage?.output_tokens || 0,
      cachedInputTokens: data.usage?.cache_read_input_tokens || 0,
      cacheWriteTokens: data.usage?.cache_creation_input_tokens || 0,
      calls: 1
    };
    addUsage(usage, delta);
    req.onUsage?.(delta);
    if (!firstResponseFired) {
      firstResponseFired = true;
      req.onFirstResponse?.();
    }

    const content: any[] = Array.isArray(data.content) ? data.content : [];
    const textBlocks = content.filter((b) => b.type === 'text' && typeof b.text === 'string');
    if (textBlocks.length > 0) lastText = textBlocks.map((b) => b.text).join('\n');

    if (data.stop_reason === 'refusal') {
      const why = data.stop_details?.explanation || 'The model declined this request.';
      return makeResult(lastText, round, toolCallCount, usage, 'error', `Model refusal: ${why}`);
    }

    const toolUses = content.filter((b) => b.type === 'tool_use');
    if (data.stop_reason !== 'tool_use' || toolUses.length === 0) {
      return makeResult(lastText, round, toolCallCount, usage, 'end');
    }

    messages.push({ role: 'assistant', content });
    const calls: ToolCallRequest[] = toolUses.map((b) => ({ id: b.id, name: b.name, args: safeParseArgs(b.input) }));
    toolCallCount += calls.length;
    const results = await dispatchToolCalls(req, calls);
    const byId = new Map(results.map((r) => [r.id, r]));

    // Moving cache breakpoint: only the newest tool_result message carries cache_control.
    if (lastToolResultMessage && Array.isArray(lastToolResultMessage.content)) {
      for (const block of lastToolResultMessage.content) delete block.cache_control;
    }
    const resultBlocks = calls.map((c) => {
      const r = byId.get(c.id);
      return {
        type: 'tool_result',
        tool_use_id: c.id,
        content: r ? r.content || '(no output)' : 'Tool produced no result.',
        is_error: r ? Boolean(r.isError) : true
      } as any;
    });
    resultBlocks[resultBlocks.length - 1].cache_control = { type: 'ephemeral' };
    lastToolResultMessage = { role: 'user', content: resultBlocks };
    messages.push(lastToolResultMessage);
  }
  return makeResult(lastText, req.maxRounds, toolCallCount, usage, 'max_rounds');
}

// ─── OpenAI + Ollama (chat completions shape) ───────────────────────────────

async function runOpenAiCompatible(req: ToolLoopRequest, tools: ToolDefinition[], usage: TokenUsage, flavour: 'openai' | 'ollama'): Promise<ToolLoopResult> {
  const isOllama = flavour === 'ollama';
  if (!isOllama && !req.apiKey) return makeResult('', 0, 0, usage, 'error', 'OpenAI API key missing.');
  const host = (req.baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
  const url = isOllama ? `${host}/api/chat` : 'https://api.openai.com/v1/chat/completions';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (!isOllama) headers.Authorization = `Bearer ${req.apiKey}`;

  const messages: any[] = [
    { role: 'system', content: joinSystem(req) },
    { role: 'user', content: req.initialUserMessage }
  ];
  let oaTools: any[] | undefined = tools.length > 0 ? toOpenAiTools(tools) : undefined;
  let lastText = '';
  let toolCallCount = 0;
  let firstResponseFired = false;
  let noToolSupport = false;

  for (let round = 1; round <= req.maxRounds; round++) {
    throwIfAborted(req.signal);
    const body: any = { model: req.model || (isOllama ? 'llama3.2' : 'gpt-5.4'), messages };
    if (isOllama) body.stream = false;
    if (oaTools) {
      body.tools = oaTools;
      if (!isOllama) body.tool_choice = 'auto';
    } else if (req.responseFormat === 'json') {
      if (isOllama) body.format = 'json';
      else body.response_format = { type: 'json_object' };
    }

    let outcome = await postJsonWithRetry(url, headers, body, req.signal, isOllama ? 'Ollama' : 'OpenAI');
    if (!outcome.ok && isOllama && oaTools && /does not support tools/i.test(outcome.errorMessage || '')) {
      // Model lacks tool calling: degrade to a single-shot answer and report it.
      noToolSupport = true;
      oaTools = undefined;
      delete body.tools;
      if (req.responseFormat === 'json') body.format = 'json';
      outcome = await postJsonWithRetry(url, headers, body, req.signal, 'Ollama');
    }
    if (!outcome.ok) return makeResult(lastText, round, toolCallCount, usage, 'error', outcome.errorMessage);

    const data = outcome.json || {};
    const delta: TokenUsage = isOllama
      ? { inputTokens: data.prompt_eval_count || 0, outputTokens: data.eval_count || 0, cachedInputTokens: 0, cacheWriteTokens: 0, calls: 1 }
      : {
          inputTokens: data.usage?.prompt_tokens || 0,
          outputTokens: data.usage?.completion_tokens || 0,
          cachedInputTokens: data.usage?.prompt_tokens_details?.cached_tokens || 0,
          cacheWriteTokens: 0,
          calls: 1
        };
    addUsage(usage, delta);
    req.onUsage?.(delta);
    if (!firstResponseFired) {
      firstResponseFired = true;
      req.onFirstResponse?.();
    }

    const message = isOllama ? data.message : data.choices?.[0]?.message;
    if (!message) return makeResult(lastText, round, toolCallCount, usage, 'error', `${isOllama ? 'Ollama' : 'OpenAI'} returned no message.`);
    if (typeof message.content === 'string' && message.content.trim()) lastText = message.content;

    const toolCalls: any[] = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (noToolSupport) return makeResult(lastText, round, toolCallCount, usage, 'no_tool_support');
    if (toolCalls.length === 0) return makeResult(lastText, round, toolCallCount, usage, 'end');

    const normalizedCalls = toolCalls.map((tc, i) => ({
      id: tc.id || `call_${round}_${i}`,
      name: tc.function?.name || tc.name,
      args: safeParseArgs(tc.function?.arguments ?? tc.arguments)
    }));
    messages.push({
      role: 'assistant',
      content: message.content || (isOllama ? '' : null),
      tool_calls: toolCalls.map((tc, i) => (isOllama ? tc : { ...tc, id: tc.id || normalizedCalls[i].id }))
    });
    toolCallCount += normalizedCalls.length;
    const results = await dispatchToolCalls(req, normalizedCalls);
    const byId = new Map(results.map((r) => [r.id, r]));
    for (const c of normalizedCalls) {
      const r = byId.get(c.id);
      const content = r ? r.content || '(no output)' : 'Tool produced no result.';
      if (isOllama) messages.push({ role: 'tool', name: c.name, content });
      else messages.push({ role: 'tool', tool_call_id: c.id, content });
    }
  }
  return makeResult(lastText, req.maxRounds, toolCallCount, usage, 'max_rounds');
}

// ─── Gemini ─────────────────────────────────────────────────────────────────

async function runGemini(req: ToolLoopRequest, tools: ToolDefinition[], usage: TokenUsage): Promise<ToolLoopResult> {
  if (!req.apiKey) return makeResult('', 0, 0, usage, 'error', 'Google Gemini API key missing.');
  const model = req.model || 'gemini-3.7-pro';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(req.apiKey)}`;
  const contents: any[] = [{ role: 'user', parts: [{ text: req.initialUserMessage }] }];
  const geminiTools = tools.length > 0 ? [{ functionDeclarations: toGeminiTools(tools) }] : undefined;
  let lastText = '';
  let toolCallCount = 0;
  let firstResponseFired = false;

  for (let round = 1; round <= req.maxRounds; round++) {
    throwIfAborted(req.signal);
    const body: any = {
      systemInstruction: { parts: [{ text: joinSystem(req) }] },
      contents
    };
    if (geminiTools) body.tools = geminiTools;
    else if (req.responseFormat === 'json') body.generationConfig = { responseMimeType: 'application/json' };

    const outcome = await postJsonWithRetry(url, { 'Content-Type': 'application/json' }, body, req.signal, 'Gemini');
    if (!outcome.ok) return makeResult(lastText, round, toolCallCount, usage, 'error', outcome.errorMessage);

    const data = outcome.json || {};
    const delta: TokenUsage = {
      inputTokens: data.usageMetadata?.promptTokenCount || 0,
      outputTokens: data.usageMetadata?.candidatesTokenCount || 0,
      cachedInputTokens: data.usageMetadata?.cachedContentTokenCount || 0,
      cacheWriteTokens: 0,
      calls: 1
    };
    addUsage(usage, delta);
    req.onUsage?.(delta);
    if (!firstResponseFired) {
      firstResponseFired = true;
      req.onFirstResponse?.();
    }

    const candidate = data.candidates?.[0];
    const parts: any[] = candidate?.content?.parts || [];
    if (!candidate || parts.length === 0) {
      const reason = candidate?.finishReason || data.promptFeedback?.blockReason || 'empty response';
      return makeResult(lastText, round, toolCallCount, usage, 'error', `Gemini returned no content (${reason}).`);
    }
    const textParts = parts.filter((p) => typeof p.text === 'string' && p.text.trim());
    if (textParts.length > 0) lastText = textParts.map((p) => p.text).join('\n');

    const fnParts = parts.filter((p) => p.functionCall);
    if (fnParts.length === 0) return makeResult(lastText, round, toolCallCount, usage, 'end');

    contents.push({ role: 'model', parts });
    const calls: ToolCallRequest[] = fnParts.map((p, i) => ({
      id: p.functionCall.id || `gemini_${round}_${i}`,
      name: p.functionCall.name,
      args: safeParseArgs(p.functionCall.args)
    }));
    toolCallCount += calls.length;
    const results: ToolCallResult[] = await dispatchToolCalls(req, calls);
    const byId = new Map(results.map((r) => [r.id, r]));
    contents.push({
      role: 'user',
      parts: calls.map((c) => {
        const r = byId.get(c.id);
        return {
          functionResponse: {
            name: c.name,
            response: r ? (r.isError ? { error: r.content } : { content: r.content || '(no output)' }) : { error: 'Tool produced no result.' }
          }
        };
      })
    });
  }
  return makeResult(lastText, req.maxRounds, toolCallCount, usage, 'max_rounds');
}
