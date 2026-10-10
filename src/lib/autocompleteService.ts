import { type AIProviderConfig } from '../types';
import { callAiEngine } from './llmClient';

export interface AutocompleteContext {
  taskText: string;
  prefixText: string;
  suffixText: string;
  isSubtask: boolean;
  parentTaskTitle?: string;
  projectId?: string;
}

/**
 * Return lightweight default models for quick autocomplete calls if not explicitly configured
 */
function getLightweightModel(config: AIProviderConfig): string | undefined {
  if (config.autocompleteModel) return config.autocompleteModel;
  if (config.roleConfigs?.autocomplete?.model) return config.roleConfigs.autocomplete.model;
  if (config.provider === 'openai') return 'gpt-5-mini';
  if (config.provider === 'anthropic') return 'claude-3-5-haiku-20241022';
  if (config.provider === 'gemini') return 'gemini-3.8-flash-low';
  if (config.provider === 'grok') return 'grok-3-mini';
  if (config.provider === 'ollama') return 'llama3.2';
  if (config.provider === 'cli_subscription' || config.authMode === 'cli_subscription') {
    const target = config.cliAgentId || config.cliCustomCommand || '';
    if (target === 'antigravity' || target === 'agy') return 'gemini-3.8-flash-low';
    if (target === 'claude-code' || target === 'claude') return 'claude-3-5-haiku-20241022';
    if (target === 'codex' || target === 'openai') return 'gpt-5-mini';
    return 'gemini-3.8-flash-low';
  }
  return config.model || 'gemini-3.8-flash-low';
}

export interface AutocompleteSuggestionResult {
  replacementRange: 'line' | 'suffix';
  text: string;
}

/**
 * Generate autocomplete completion string based on minimal lightweight AI query.
 * Can return either an inline suffix or a full replacement line (with rewording/grammar/typo fixes).
 */
export async function getAutocompleteSuggestion(
  ctx: AutocompleteContext,
  aiConfig?: AIProviderConfig,
  signal?: AbortSignal
): Promise<AutocompleteSuggestionResult | null> {
  const trimmedTask = ctx.taskText.trim();
  if (!trimmedTask) {
    return null;
  }

  // If AI is not configured or not connected, skip
  if (!aiConfig || !aiConfig.isConnected || aiConfig.provider === 'none') {
    return null;
  }

  // Determine provider and model for autocomplete (supporting roleConfigs override)
  const roleOverride = aiConfig.roleConfigs?.autocomplete;
  let effectiveProvider = roleOverride?.provider || aiConfig.provider;
  let effectiveModel = roleOverride?.model || aiConfig.autocompleteModel || getLightweightModel(aiConfig) || aiConfig.model || 'gemini-3.8-flash-low';
  
  // If the active profile is using CLI subscription without direct API keys,
  // fallback to direct API if keys are present anywhere in the environment for sub-second responses
  let effectiveAuthMode = aiConfig.authMode;
  if (aiConfig.authMode === 'cli_subscription' || aiConfig.provider === 'cli_subscription' || aiConfig.apiKey === 'cli_subscription_active') {
    if (aiConfig.providerKeys?.gemini?.apiKey) {
      effectiveProvider = 'gemini';
      effectiveModel = roleOverride?.model || aiConfig.autocompleteModel || 'gemini-3.8-flash-low';
      effectiveAuthMode = 'api_key';
    } else if (aiConfig.providerKeys?.anthropic?.apiKey) {
      effectiveProvider = 'anthropic';
      effectiveModel = roleOverride?.model || aiConfig.autocompleteModel || 'claude-3-5-haiku-20241022';
      effectiveAuthMode = 'api_key';
    } else if (aiConfig.providerKeys?.openai?.apiKey) {
      effectiveProvider = 'openai';
      effectiveModel = roleOverride?.model || aiConfig.autocompleteModel || 'gpt-5-mini';
      effectiveAuthMode = 'api_key';
    } else if (aiConfig.providerKeys?.grok?.apiKey) {
      effectiveProvider = 'grok';
      effectiveModel = roleOverride?.model || aiConfig.autocompleteModel || 'grok-3-mini';
      effectiveAuthMode = 'api_key';
    } else if (aiConfig.provider === 'gemini' && aiConfig.apiKey && aiConfig.apiKey !== 'cli_subscription_active') {
      effectiveProvider = 'gemini';
      effectiveModel = roleOverride?.model || aiConfig.autocompleteModel || 'gemini-3.8-flash-low';
      effectiveAuthMode = 'api_key';
    } else if (aiConfig.provider === 'anthropic' && aiConfig.apiKey && aiConfig.apiKey !== 'cli_subscription_active') {
      effectiveProvider = 'anthropic';
      effectiveModel = roleOverride?.model || aiConfig.autocompleteModel || 'claude-3-5-haiku-20241022';
      effectiveAuthMode = 'api_key';
    } else if (aiConfig.provider === 'openai' && aiConfig.apiKey && aiConfig.apiKey !== 'cli_subscription_active') {
      effectiveProvider = 'openai';
      effectiveModel = roleOverride?.model || aiConfig.autocompleteModel || 'gpt-5-mini';
      effectiveAuthMode = 'api_key';
    } else {
      // Local CLI subscription: ensure model is fast lightweight model
      effectiveModel = roleOverride?.model || aiConfig.autocompleteModel || getLightweightModel(aiConfig) || 'gemini-3.8-flash-low';
    }
  }

  const providerKeyEntry = aiConfig.providerKeys?.[effectiveProvider];
  const effectiveApiKey = effectiveProvider === aiConfig.provider
    ? (aiConfig.apiKey || providerKeyEntry?.apiKey)
    : (providerKeyEntry?.apiKey || aiConfig.apiKey);
  const effectiveBaseUrl = effectiveProvider === aiConfig.provider
    ? (aiConfig.baseUrl || providerKeyEntry?.baseUrl)
    : (providerKeyEntry?.baseUrl || aiConfig.baseUrl);

  const lightweightConfig: AIProviderConfig = {
    ...aiConfig,
    authMode: effectiveAuthMode,
    provider: effectiveProvider,
    model: effectiveModel,
    generalModel: effectiveModel,
    autocompleteModel: effectiveModel,
    apiKey: effectiveApiKey,
    baseUrl: effectiveBaseUrl,
  };

  const systemPrompt = `You are a real-time inline task autocomplete and copilot assistant like VS Code Copilot, operating inside a markdown task list.
You are given the full task/subtask text and the cursor position indicated by [CURSOR].
Your job:
1. Complete what the user is typing naturally.
2. Fix any obvious typos, grammatical errors, or awkward wording in the current task/subtask if appropriate.
3. Return ONLY a single line of text representing the improved, completed task/subtask content.
4. Do NOT output markdown list markers (- or * or numbers), quotes, markdown formatting, explanations, greetings, or extra lines.
5. Keep it concise, natural, and directly following user intent.`;

  const parentContextText = ctx.parentTaskTitle
    ? `\nParent Task: "${ctx.parentTaskTitle}"`
    : '';

  const taskWithCursor = `${ctx.prefixText}[CURSOR]${ctx.suffixText}`;
  const prompt = `Current ${ctx.isSubtask ? 'subtask' : 'task'}: "${taskWithCursor}"${parentContextText}

Output the completed and polished line:`;

  try {
    // 8-second timeout controller combined with parent abort signal so completions never hang
    const timeoutController = new AbortController();
    const timerId = setTimeout(() => timeoutController.abort(), 8000);
    if (signal) {
      signal.addEventListener('abort', () => timeoutController.abort(), { once: true });
    }

    const rawResult = await callAiEngine(
      prompt,
      systemPrompt,
      lightweightConfig,
      'autocomplete',
      'text',
      timeoutController.signal
    );
    clearTimeout(timerId);

    let completion = (rawResult || '').trim();
    if (!completion) return null;

    // Clean markdown list bullets, quotes, or wrappers
    completion = completion.replace(/^[-*•]\s*(\[[ xX]\]\s*)?/, '');
    completion = completion.replace(/^["'`]+|["'`]+$/g, '').trim();

    // If result is identical to original line, no suggestion
    if (completion === ctx.taskText.trim()) {
      return null;
    }

    // VS Code Copilot behavior:
    // If the suggestion starts with the prefix verbatim, treat it as a suffix insertion at cursor pos!
    if (completion.startsWith(ctx.prefixText)) {
      const suffix = completion.slice(ctx.prefixText.length);
      if (!suffix) return null;
      return {
        replacementRange: 'suffix',
        text: suffix,
      };
    }

    // Otherwise, it reworded or fixed earlier typos/grammar across the line
    return {
      replacementRange: 'line',
      text: completion,
    };
  } catch (err: any) {
    if (err?.name === 'AbortError') return null;
    console.warn('[Autocomplete] AI completion error:', err);
    return null;
  }
}
