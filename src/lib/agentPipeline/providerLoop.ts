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
  throwIfAborted,
  isCliPlaceholderModel,
  resolveCliBinary
} from './contracts';
import { bridgeClient } from '../bridgeClient';
import { toAnthropicTools, toGeminiTools, toOpenAiTools } from './toolSchemas';
import {
  applySummary,
  clearOldToolResults,
  compactionThreshold,
  contextWindowFor,
  renderForSummary,
  SUMMARY_INSTRUCTIONS,
  SUMMARY_SYSTEM,
  tailStart,
  estimatePromptTokens,
  clipToolResultsToFit,
  type ConversationShape
} from './compaction';
import { peekModelCatalog } from '../modelCatalog/catalog';
import { PRICE_SNAPSHOT } from '../modelCatalog/priceSnapshot';
import { priceUsage, resolveAliasModelId } from '../modelCatalog/pricing';

/** Prompt size at which this loop compacts its conversation (null: never). */
function compactionTokensFor(req: ToolLoopRequest): number | null {
  const models = (peekModelCatalog() ?? PRICE_SNAPSHOT).models;
  return compactionThreshold({ provider: req.provider, model: req.model, setting: req.compaction, models });
}

/**
 * Compacts a loop's conversation in place: the same model summarizes all but the newest tool exchanges (one extra call,
 * no tools); if that fails, old tool output is cleared instead. Returns true when the conversation changed.
 */
async function compactConversation(req: ToolLoopRequest, messages: any[], shape: ConversationShape, usage: TokenUsage): Promise<boolean> {
  const tail = tailStart(messages, shape);
  if (tail < 0) return clearOldToolResults(messages) > 0;
  try {
    const res = await runToolLoop({
      ...req,
      tools: [],
      maxRounds: 1,
      maxTokens: 4000,
      responseFormat: 'text',
      compaction: { mode: 'off' },
      sharedContext: '',
      stableSystem: SUMMARY_SYSTEM,
      volatileSystem: undefined,
      initialUserMessage: `${renderForSummary(messages.slice(0, tail))}\n\n---\n${SUMMARY_INSTRUCTIONS}`,
      onToolCalls: undefined,
      onFirstResponse: undefined,
      drainSteering: undefined
    });
    addUsage(usage, res.usage);
    if (res.stopReason !== 'error' && res.text.trim()) {
      applySummary(messages, shape, res.text, tail);
      return true;
    }
    console.warn('[Ergo Provider] Compaction summary failed; clearing old tool output instead.', res.error);
  } catch (err) {
    if (req.signal?.aborted) throw err;
    console.warn('[Ergo Provider] Compaction summary failed; clearing old tool output instead.', err);
  }
  return clearOldToolResults(messages) > 0;
}

/** Adds the call's API-price cost to a usage delta (live catalog when loaded, else the bundled snapshot). */
function priceDelta(delta: TokenUsage, model: string | undefined): void {
  if (!model) return;
  const models = (peekModelCatalog() ?? PRICE_SNAPSHOT).models;
  const cost = priceUsage(models, resolveAliasModelId(models, model), delta);
  if (typeof cost === 'number') delta.costUsd = cost;
}
import { type EffortLevel, type TokenUsage } from '../../types';

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

/** A 400 that names the effort/thinking parameter — retry the round without it. */
function isEffortRejection(outcome: FetchOutcome): boolean {
  return outcome.status === 400 && /effort|reasoning|thinking|output_config/i.test(outcome.errorMessage || '');
}

/** The provider doesn't know or won't serve this model — retry with the role's un-routed model. */
function isModelRejection(outcome: FetchOutcome): boolean {
  return (outcome.status === 404 || outcome.status === 400 || outcome.status === 403) && /model/i.test(outcome.errorMessage || '');
}

/** Anthropic output_config.effort support: 4.6+ Opus/Sonnet, Haiku 5.5+, every Fable/Mythos. xhigh needs Opus 4.7+ / Sonnet 5+. */
export function anthropicEffortFor(model: string, effort?: EffortLevel): EffortLevel | undefined {
  if (!effort) return undefined;
  const m = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?/.exec(model);
  if (!m) return undefined;
  const version = Number(m[2]) + (m[3] && m[3].length <= 2 ? Number(m[3]) / 10 : 0);
  const family = m[1];
  let supported = false;
  let xhigh = false;
  if (family === 'fable' || family === 'mythos') supported = xhigh = true;
  else if (family === 'opus') { supported = version >= 4.6; xhigh = version >= 4.7; }
  else if (family === 'sonnet') { supported = version >= 4.6; xhigh = version >= 5; }
  else if (family === 'haiku') supported = xhigh = version >= 5.5;
  if (!supported) return undefined;
  return effort === 'xhigh' && !xhigh ? 'high' : effort;
}

/** OpenAI reasoning_effort (gpt-5 family and o-series only; low/medium/high). */
export function openAiEffortFor(model: string, effort?: EffortLevel): 'low' | 'medium' | 'high' | undefined {
  if (!effort || !/^(gpt-5|o\d)/i.test(model)) return undefined;
  return effort === 'low' ? 'low' : effort === 'medium' ? 'medium' : 'high';
}

/** Gemini thinkingConfig: thinkingLevel on Gemini 3+, a thinking-token budget on 2.5. */
export function geminiThinkingFor(model: string, effort?: EffortLevel): Record<string, any> | undefined {
  if (!effort) return undefined;
  const ver = /gemini-(\d+(?:\.\d+)?)/.exec(model);
  if (!ver) return undefined;
  const v = Number(ver[1]);
  if (v >= 3) return { thinkingLevel: effort === 'low' || effort === 'medium' ? 'low' : 'high' };
  if (v >= 2.5) {
    const budgets: Record<EffortLevel, number> = { low: 1024, medium: 4096, high: 8192, xhigh: 16384, max: 24576 };
    return { thinkingBudget: budgets[effort] };
  }
  return undefined;
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

/**
 * Parses tool calls formatted inside message text/content (common in local Ollama models like Llama, Qwen, DeepSeek).
 */
export function extractToolCallsFromContent(content: string, tools: ToolDefinition[]): ToolCallRequest[] {
  if (!content || !content.trim()) return [];
  const validToolNames = new Set(tools.map((t) => t.name));
  const calls: ToolCallRequest[] = [];

  // 1. Tag format: <tool_call> ... </tool_call>
  const tagRegex = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = tagRegex.exec(content)) !== null) {
    const raw = tagMatch[1].trim();
    try {
      const parsed = JSON.parse(raw);
      const name = parsed.name || parsed.tool || parsed.function?.name;
      if (name && validToolNames.has(name)) {
        calls.push({
          id: `call_text_${calls.length + 1}`,
          name,
          args: safeParseArgs(parsed.arguments ?? parsed.parameters ?? parsed.args ?? parsed)
        });
      }
    } catch {}
  }
  if (calls.length > 0) return calls;

  // 2. Fenced json/tool_call block format: ```json ... ``` or ```tool_call ... ```
  const fenceRegex = /```(?:json|tool_call)?\s*([\s\S]*?)```/gi;
  let fenceMatch: RegExpExecArray | null;
  while ((fenceMatch = fenceRegex.exec(content)) !== null) {
    const raw = fenceMatch[1].trim();
    try {
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const name = item.name || item.tool || item.function?.name;
        if (name && validToolNames.has(name)) {
          calls.push({
            id: `call_text_${calls.length + 1}`,
            name,
            args: safeParseArgs(item.arguments ?? item.parameters ?? item.args ?? item)
          });
        }
      }
    } catch {}
  }
  if (calls.length > 0) return calls;

  // 3. Raw JSON object format in content: {"name": "write_file", "arguments": ...}
  try {
    const jsonMatch = content.match(/\{\s*"(?:name|tool|function)"\s*:\s*"([a-zA-Z0-9_-]+)"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const name = parsed.name || parsed.tool || parsed.function?.name;
      if (name && validToolNames.has(name)) {
        calls.push({
          id: `call_text_1`,
          name,
          args: safeParseArgs(parsed.arguments ?? parsed.parameters ?? parsed.args ?? parsed)
        });
      }
    }
  } catch {}

  return calls;
}

/** The user's mid-run messages for this agent since its last round (ToolLoopRequest.drainSteering). Never throws. */
function takeSteering(req: ToolLoopRequest): string[] {
  try {
    return (req.drainSteering?.() ?? []).filter((t) => typeof t === 'string' && t.trim());
  } catch {
    return [];
  }
}

/**
 * Appends steering notes to the END of an Anthropic conversation: as text blocks after the newest user turn's content
 * (after its tool_result blocks, as the API requires), or as a new user turn after an assistant turn. Earlier turns
 * are never rewritten, so the cached prefix stays valid.
 */
function appendAnthropicSteering(messages: any[], notes: string[]): void {
  if (notes.length === 0) return;
  const blocks = notes.map((text) => ({ type: 'text', text }));
  const last = messages[messages.length - 1];
  if (last?.role === 'user') {
    // Only the very first turn is still a plain string (nothing has been sent or cached after it yet).
    if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content }, ...blocks];
    else last.content.push(...blocks);
  } else {
    messages.push({ role: 'user', content: blocks });
  }
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

  const executeProvider = async (activeReq: ToolLoopRequest): Promise<ToolLoopResult> => {
    const tools = activeReq.tools || [];

    // Intercept subscription-based execution (authMode === 'cli_subscription' or apiKey === 'cli_subscription_active')
    const isSubscriptionMode =
      activeReq.provider === 'cli_subscription' ||
      activeReq.authMode === 'cli_subscription' ||
      activeReq.apiKey === 'cli_subscription_active';

    if (isSubscriptionMode) {
      return runCliSubscription(activeReq, tools, usage);
    }

    switch (activeReq.provider) {
      case 'anthropic':
        return runAnthropic(activeReq, tools, usage);
      case 'openai':
        return runOpenAiCompatible(activeReq, tools, usage, 'openai');
      case 'grok':
        return runOpenAiCompatible(
          {
            ...activeReq,
            baseUrl: activeReq.baseUrl || 'https://api.x.ai/v1'
          },
          tools,
          usage,
          'openai'
        );
      case 'cursor':
        // If API key is provided, execute OpenAI-compatible endpoint; otherwise route to CLI bridge
        if (activeReq.apiKey && !activeReq.model?.includes('cli')) {
          return runOpenAiCompatible(
            {
              ...activeReq,
              baseUrl: activeReq.baseUrl || 'https://api.cursor.com/v1'
            },
            tools,
            usage,
            'openai'
          );
        }
        return runCliSubscription(activeReq, tools, usage);
      case 'ollama':
        return runOpenAiCompatible(activeReq, tools, usage, 'ollama');
      case 'gemini':
        return runGemini(activeReq, tools, usage);
      case 'cli_subscription':
        return runCliSubscription(activeReq, tools, usage);
      default:
        return makeResult('', 0, 0, usage, 'error', `Unsupported provider: ${activeReq.provider}`);
    }
  };

  let currentReq = req;
  while (true) {
    throwIfAborted(currentReq.signal);
    const result = await executeProvider(currentReq);

    // Track consecutive Ollama network / connectivity failures
    if (currentReq.provider === 'ollama') {
      const isConnectionError =
        result.stopReason === 'error' &&
        /network error|failed to fetch|connection refused|connect econnrefused|failed to connect/i.test(result.error || '');

      if (isConnectionError) {
        if (currentReq.ollamaFailureState) {
          currentReq.ollamaFailureState.count = (currentReq.ollamaFailureState.count || 0) + 1;
        }

        const consecutiveFailures = currentReq.ollamaFailureState?.count || 1;
        if (consecutiveFailures >= 3 && currentReq.onRequestOllamaFallback) {
          const host = (currentReq.baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
          const choice = await currentReq.onRequestOllamaFallback({
            id: `ollama-fallback-${Date.now()}`,
            taskId: currentReq.taskId ?? 'current-task',
            consecutiveFailures,
            url: host,
            errorMessage: result.error
          });

          if (choice === 'terminate') {
            throw new DOMException('Task terminated by user due to unreachable local Ollama instance.', 'AbortError');
          }

          if (choice === 'switch_cloud' && currentReq.onSwitchToCloud) {
            const cloudTarget = await currentReq.onSwitchToCloud();
            if (cloudTarget && cloudTarget.provider !== 'ollama' && cloudTarget.provider !== 'none') {
              if (currentReq.ollamaFailureState) {
                currentReq.ollamaFailureState.count = 0;
              }
              // Switch current request to the cloud provider and retry
              currentReq = {
                ...currentReq,
                provider: cloudTarget.provider,
                model: cloudTarget.model,
                apiKey: cloudTarget.apiKey,
                baseUrl: cloudTarget.baseUrl
              };
              continue;
            }
          }
        }
      } else if (result.stopReason !== 'error') {
        // Successful call: reset consecutive Ollama failure count
        if (currentReq.ollamaFailureState) {
          currentReq.ollamaFailureState.count = 0;
        }
      }
    }

    return result;
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
  if (anthropicTools && anthropicTools.length > 0) {
    // Cache breakpoint on the last tool caches all tool definitions across turns
    anthropicTools[anthropicTools.length - 1].cache_control = { type: 'ephemeral' };
  }
  let lastText = '';
  let toolCallCount = 0;
  let firstResponseFired = false;
  let lastToolResultMessage: any | null = null;
  let activeModel = req.model || 'claude-opus-5-5';
  let effortDisabled = false;
  const compactAt = compactionTokensFor(req);
  let lastPromptTokens = 0;
  let lastCompactRound = -1;

  for (let round = 1; round <= req.maxRounds; round++) {
    throwIfAborted(req.signal);
    // Not on back-to-back rounds: a compaction that couldn't shrink the prompt enough shouldn't repeat every round.
    if (compactAt && lastPromptTokens >= compactAt && round > lastCompactRound + 1) {
      if (await compactConversation(req, messages, 'anthropic', usage)) lastCompactRound = round;
    }
    // Round boundary: the user's mid-run messages join the end of the conversation.
    appendAnthropicSteering(messages, takeSteering(req));
    const body: any = {
      model: activeModel,
      max_tokens: req.maxTokens ?? 16000,
      system,
      messages
    };
    if (anthropicTools) body.tools = anthropicTools;
    const effort = effortDisabled ? undefined : anthropicEffortFor(activeModel, req.effort);
    if (effort) body.output_config = { effort };

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
    if (!outcome.ok) {
      if (effort && isEffortRejection(outcome)) {
        effortDisabled = true;
        round--;
        continue;
      }
      if (req.fallbackModel && activeModel !== req.fallbackModel && isModelRejection(outcome)) {
        console.warn(`[Ergo Provider] Anthropic rejected model ${activeModel}; retrying with ${req.fallbackModel}.`, outcome.errorMessage);
        activeModel = req.fallbackModel;
        round--;
        continue;
      }
      return makeResult(lastText, round, toolCallCount, usage, 'error', outcome.errorMessage);
    }

    const data = outcome.json || {};
    const cacheRead = data.usage?.cache_read_input_tokens || 0;
    const cacheWrite = data.usage?.cache_creation_input_tokens || 0;
    const delta: TokenUsage = {
      // Anthropic's input_tokens excludes cache reads/writes; count them so totals reflect the real prompt size.
      inputTokens: (data.usage?.input_tokens || 0) + cacheRead + cacheWrite,
      outputTokens: data.usage?.output_tokens || 0,
      cachedInputTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      calls: 1
    };
    priceDelta(delta, activeModel);
    addUsage(usage, delta);
    req.onUsage?.(delta);
    lastPromptTokens = delta.inputTokens;
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
      // The user wrote while this turn was running: let the agent answer it instead of ending here.
      const late = round < req.maxRounds && data.stop_reason !== 'max_tokens' ? takeSteering(req) : [];
      if (late.length > 0) {
        messages.push({ role: 'assistant', content: content.length > 0 ? content : [{ type: 'text', text: '(no reply)' }] });
        appendAnthropicSteering(messages, late);
        continue;
      }
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
  // Grok / Cursor arrive here with their own OpenAI-compatible baseUrl.
  const url = isOllama
    ? `${host}/api/chat`
    : req.baseUrl
      ? `${req.baseUrl.replace(/\/+$/, '')}/chat/completions`
      : 'https://api.openai.com/v1/chat/completions';
  const providerLabel = isOllama ? 'Ollama' : req.baseUrl?.includes('x.ai') ? 'xAI' : req.baseUrl?.includes('cursor') ? 'Cursor' : 'OpenAI';
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
  let activeModel = req.model || (isOllama ? 'llama3.2' : 'gpt-5.4');
  let effortDisabled = false;
  const compactAt = compactionTokensFor(req);
  let lastPromptTokens = 0;
  let lastCompactRound = -1;

  for (let round = 1; round <= req.maxRounds; round++) {
    throwIfAborted(req.signal);
    // Ollama: also count what is about to be sent. Its reported prompt size is the last round's, without the tool
    // output just added (and can leave out cached tokens), and an overflow isn't an error: it drops the start of the prompt.
    const promptTokens = isOllama ? Math.max(lastPromptTokens, estimatePromptTokens(messages, oaTools)) : lastPromptTokens;
    if (compactAt && promptTokens >= compactAt && round > lastCompactRound + 1) {
      if (await compactConversation(req, messages, 'openai', usage)) lastCompactRound = round;
    }
    if (isOllama && compactAt) {
      // Still too big (the newest tool results stay verbatim through a compaction): cut the largest down so the prompt
      // plus the reply fit in num_ctx.
      const ctxWindow = contextWindowFor({ provider: 'ollama', model: activeModel, setting: req.compaction, models: [] });
      clipToolResultsToFit(messages, oaTools, ctxWindow - Math.min(req.maxTokens || 4096, Math.floor(ctxWindow / 4)));
    }
    // Round boundary: the user's mid-run messages join the end of the conversation.
    const steering = takeSteering(req);
    if (steering.length > 0) messages.push({ role: 'user', content: steering.join('\n\n') });
    const body: any = { model: activeModel, messages };
    const effort = isOllama || effortDisabled ? undefined : openAiEffortFor(activeModel, req.effort);
    if (isOllama) {
      body.stream = false;
      body.options = {
        num_ctx: contextWindowFor({ provider: 'ollama', model: activeModel, setting: req.compaction, models: [] }),
        num_predict: req.maxTokens || 4096,
        temperature: 0.2
      };
    } else {
      // Reasoning models (gpt-5 / o-series) reject max_tokens in favour of max_completion_tokens.
      if (req.maxTokens) {
        if (/^(gpt-5|o\d)/i.test(activeModel)) body.max_completion_tokens = req.maxTokens;
        else body.max_tokens = req.maxTokens;
      }
      if (effort) body.reasoning_effort = effort;
    }
    if (oaTools) {
      body.tools = oaTools;
      if (!isOllama) body.tool_choice = 'auto';
    } else if (req.responseFormat === 'json') {
      if (isOllama) body.format = 'json';
      else body.response_format = { type: 'json_object' };
    }

    let outcome = await postJsonWithRetry(url, headers, body, req.signal, providerLabel);
    if (!outcome.ok && isOllama && oaTools && /does not support tools/i.test(outcome.errorMessage || '')) {
      // Model lacks tool calling: degrade to a single-shot answer and report it.
      noToolSupport = true;
      oaTools = undefined;
      delete body.tools;
      if (req.responseFormat === 'json') body.format = 'json';
      outcome = await postJsonWithRetry(url, headers, body, req.signal, 'Ollama');
    }
    if (!outcome.ok) {
      if (effort && isEffortRejection(outcome)) {
        effortDisabled = true;
        round--;
        continue;
      }
      if (req.fallbackModel && activeModel !== req.fallbackModel && isModelRejection(outcome)) {
        console.warn(`[Ergo Provider] ${providerLabel} rejected model ${activeModel}; retrying with ${req.fallbackModel}.`, outcome.errorMessage);
        activeModel = req.fallbackModel;
        round--;
        continue;
      }
      return makeResult(lastText, round, toolCallCount, usage, 'error', outcome.errorMessage);
    }

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
    priceDelta(delta, isOllama ? undefined : activeModel);
    addUsage(usage, delta);
    req.onUsage?.(delta);
    lastPromptTokens = delta.inputTokens;
    if (!firstResponseFired) {
      firstResponseFired = true;
      req.onFirstResponse?.();
    }

    const message = isOllama ? data.message : data.choices?.[0]?.message;
    if (!message) return makeResult(lastText, round, toolCallCount, usage, 'error', `${providerLabel} returned no message.`);
    if (typeof message.content === 'string' && message.content.trim()) lastText = message.content;

    const toolCalls: any[] = Array.isArray(message.tool_calls) ? [...message.tool_calls] : [];
    if (noToolSupport) return makeResult(lastText, round, toolCallCount, usage, 'no_tool_support');

    // Fallback: If model returned no native tool_calls, check if tool calls were emitted in content (common in Ollama)
    if (toolCalls.length === 0 && message.content) {
      const textCalls = extractToolCallsFromContent(message.content, tools);
      if (textCalls.length > 0) {
        for (const tc of textCalls) {
          toolCalls.push({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.args)
            }
          });
        }
      }
    }

    if (toolCalls.length === 0) {
      // If mutating tools are available (e.g. write_file) and this is round 1 of a multi-turn run,
      // nudge the model instead of abruptly quitting.
      const hasMutatingTools = tools.some((t) => !t.readOnly);
      if (round === 1 && req.maxRounds > 1 && hasMutatingTools && !/STATUS:\s*FAILED/i.test(lastText)) {
        messages.push({ role: 'assistant', content: message.content || '(acknowledged)' });
        messages.push({
          role: 'user',
          content: 'You have not called any tools yet. If creating or updating deliverables, call the write_file tool now with the target path and complete content.'
        });
        continue;
      }
      const late = round < req.maxRounds ? takeSteering(req) : [];
      if (late.length > 0) {
        messages.push({ role: 'assistant', content: message.content || '' });
        messages.push({ role: 'user', content: late.join('\n\n') });
        continue;
      }
      return makeResult(lastText, round, toolCallCount, usage, 'end');
    }

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
      if (isOllama) messages.push({ role: 'tool', tool_name: c.name, name: c.name, content });
      else messages.push({ role: 'tool', tool_call_id: c.id, content });
    }
  }
  return makeResult(lastText, req.maxRounds, toolCallCount, usage, 'max_rounds');
}

// ─── Gemini ─────────────────────────────────────────────────────────────────

async function runGemini(req: ToolLoopRequest, tools: ToolDefinition[], usage: TokenUsage): Promise<ToolLoopResult> {
  if (!req.apiKey) return makeResult('', 0, 0, usage, 'error', 'Google Gemini API key missing.');
  let activeModel = req.model || 'gemini-4-argon';
  const urlFor = (model: string) =>
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(req.apiKey!)}`;
  const contents: any[] = [{ role: 'user', parts: [{ text: req.initialUserMessage }] }];
  const geminiTools = tools.length > 0 ? [{ functionDeclarations: toGeminiTools(tools) }] : undefined;
  let lastText = '';
  let toolCallCount = 0;
  let firstResponseFired = false;
  let effortDisabled = false;
  const compactAt = compactionTokensFor(req);
  let lastPromptTokens = 0;
  let lastCompactRound = -1;

  for (let round = 1; round <= req.maxRounds; round++) {
    throwIfAborted(req.signal);
    if (compactAt && lastPromptTokens >= compactAt && round > lastCompactRound + 1) {
      if (await compactConversation(req, contents, 'gemini', usage)) lastCompactRound = round;
    }
    // Round boundary: the user's mid-run messages join the end of the conversation.
    const steering = takeSteering(req);
    if (steering.length > 0) {
      const last = contents[contents.length - 1];
      if (last?.role === 'user') last.parts.push(...steering.map((text) => ({ text })));
      else contents.push({ role: 'user', parts: steering.map((text) => ({ text })) });
    }
    const body: any = {
      systemInstruction: { parts: [{ text: joinSystem(req) }] },
      contents
    };
    const generationConfig: Record<string, any> = {};
    if (geminiTools) body.tools = geminiTools;
    else if (req.responseFormat === 'json') generationConfig.responseMimeType = 'application/json';
    const thinkingConfig = effortDisabled ? undefined : geminiThinkingFor(activeModel, req.effort);
    if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;
    if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;

    const outcome = await postJsonWithRetry(urlFor(activeModel), { 'Content-Type': 'application/json' }, body, req.signal, 'Gemini');
    if (!outcome.ok) {
      if (thinkingConfig && isEffortRejection(outcome)) {
        effortDisabled = true;
        round--;
        continue;
      }
      if (req.fallbackModel && activeModel !== req.fallbackModel && isModelRejection(outcome)) {
        console.warn(`[Ergo Provider] Gemini rejected model ${activeModel}; retrying with ${req.fallbackModel}.`, outcome.errorMessage);
        activeModel = req.fallbackModel;
        round--;
        continue;
      }
      return makeResult(lastText, round, toolCallCount, usage, 'error', outcome.errorMessage);
    }

    const data = outcome.json || {};
    const delta: TokenUsage = {
      inputTokens: data.usageMetadata?.promptTokenCount || 0,
      // Thinking tokens are billed as output.
      outputTokens: (data.usageMetadata?.candidatesTokenCount || 0) + (data.usageMetadata?.thoughtsTokenCount || 0),
      cachedInputTokens: data.usageMetadata?.cachedContentTokenCount || 0,
      cacheWriteTokens: 0,
      calls: 1
    };
    priceDelta(delta, activeModel);
    addUsage(usage, delta);
    req.onUsage?.(delta);
    lastPromptTokens = delta.inputTokens;
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
    if (fnParts.length === 0) {
      const late = round < req.maxRounds ? takeSteering(req) : [];
      if (late.length > 0) {
        contents.push({ role: 'model', parts });
        contents.push({ role: 'user', parts: late.map((text) => ({ text })) });
        continue;
      }
      return makeResult(lastText, round, toolCallCount, usage, 'end');
    }

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

// ─── CLI Subscription Bridge (Headless) ──────────────────────────────────────

async function runCliSubscription(req: ToolLoopRequest, tools: ToolDefinition[], usage: TokenUsage): Promise<ToolLoopResult> {
  const binary = resolveCliBinary(req);
  // Only forward real model names; preset ids like "claude-code" are not valid --model values.
  let cliModel = isCliPlaceholderModel(req.model, binary) ? undefined : req.model;
  const cliFallbackModel = isCliPlaceholderModel(req.fallbackModel, binary) ? undefined : req.fallbackModel;

  const systemText = joinSystem(req);
  let conversationHistory = req.initialUserMessage;
  let lastText = '';
  let toolCallCount = 0;

  for (let round = 1; round <= req.maxRounds; round++) {
    throwIfAborted(req.signal);
    // Round boundary: the user's mid-run messages join the end of the conversation.
    const steering = takeSteering(req);
    if (steering.length > 0) conversationHistory += `\n\n${steering.join('\n\n')}`;

    let toolsInstruction = '';
    if (tools.length > 0) {
      toolsInstruction = `\n\n## Available Tools:\n` +
        tools.map((t) => `- ${t.name}: ${t.description}\n  Parameters: ${JSON.stringify(t.inputSchema)}`).join('\n') +
        `\n\nTo call a tool, you MUST output a tool call block formatted as:\n<tool_call>{"name": "<tool_name>", "args": {<arguments>}}</tool_call>\n` +
        `When you are finished, reply with your summary ending with "STATUS: DONE".`;
    }

    // Subscription runs sign in as the user: never hand the CLI its own provider's API key (req.apiKey can be a
    // stale per-provider key), or it bills that key instead and fails with "invalid API key".
    const cliEnv: Record<string, string> = {};

    const res = await fetch(bridgeClient.getApiUrl('/api/cli/execute'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cli: binary,
        prompt: conversationHistory + toolsInstruction,
        systemPrompt: systemText,
        responseFormat: req.responseFormat,
        model: cliModel,
        effort: req.effort,
        // Read the live level every round: each round is a fresh CLI process, so a mid-run change applies here.
        permissionLevel: req.getPermissionLevel?.() ?? req.permissionLevel,
        timeoutMs: 60_000,
        env: cliEnv
      }),
      signal: req.signal
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return makeResult(lastText, round, toolCallCount, usage, 'error', err.error || `CLI returned HTTP ${res.status}`);
    }

    const data = await res.json();
    if (!data.success && !data.output) {
      const failure = `${data.stderr || ''} ${data.error || ''}`;
      // A routed model the subscription can't use: retry this round with the un-routed model (or the CLI default).
      if (cliModel && /model/i.test(failure) && /not (?:found|available|supported)|invalid|unknown|access|permission|unsupported/i.test(failure)) {
        console.warn(`[Ergo Provider] ${binary} rejected model ${cliModel}; retrying with ${cliFallbackModel || 'the CLI default'}.`);
        cliModel = cliFallbackModel && cliFallbackModel !== cliModel ? cliFallbackModel : undefined;
        round--;
        continue;
      }
      return makeResult(lastText, round, toolCallCount, usage, 'error', data.stderr || 'CLI execution failed.');
    }

    lastText = data.output || '';
    req.onFirstResponse?.();

    // Prefer the usage the CLI reported (claude --output-format json, codex --json); otherwise estimate ~4 chars/token.
    const reported = data.usage;
    const delta: TokenUsage = reported && (reported.inputTokens > 0 || reported.outputTokens > 0)
      ? {
          inputTokens: reported.inputTokens || 0,
          outputTokens: reported.outputTokens || 0,
          cachedInputTokens: reported.cachedInputTokens || 0,
          cacheWriteTokens: reported.cacheWriteTokens || 0,
          calls: 1
        }
      : {
          inputTokens: Math.ceil((systemText.length + conversationHistory.length + toolsInstruction.length) / 4),
          outputTokens: Math.ceil(lastText.length / 4),
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          calls: 1,
          estimated: true
        };
    if (typeof reported?.costUsd === 'number') delta.costUsd = reported.costUsd;
    else priceDelta(delta, cliModel);
    addUsage(usage, delta);
    req.onUsage?.(delta);

    // Check for tool calls in response
    const calls = extractToolCallsFromContent(lastText, tools);
    if (calls.length === 0) {
      const late = round < req.maxRounds ? takeSteering(req) : [];
      if (late.length > 0) {
        conversationHistory += `\n\n${lastText}\n\n${late.join('\n\n')}`;
        continue;
      }
      return makeResult(lastText, round, toolCallCount, usage, 'end');
    }

    toolCallCount += calls.length;
    const results = await dispatchToolCalls(req, calls);
    const toolResultsText = results.map((r) => `Tool ${r.name} result:\n${r.content}`).join('\n\n');
    conversationHistory += `\n\n${lastText}\n\nTool Execution Results:\n${toolResultsText}\n\nPlease continue based on these results.`;
  }

  return makeResult(lastText, req.maxRounds, toolCallCount, usage, 'max_rounds');
}
