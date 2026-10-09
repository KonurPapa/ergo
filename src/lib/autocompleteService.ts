import { type AIProviderConfig } from '../types';
import { searchMemory, type SearchResult } from './memory';
import { callAiEngine } from './llmClient';

export interface AutocompleteContext {
  fullLineText: string;
  prefixText: string;
  isSubtask: boolean;
  parentTaskTitle?: string;
  neighboringTasks?: string[];
  projectId?: string;
  mode: 'word' | 'sentence';
}

/**
 * Return lightweight default models for quick autocomplete calls
 */
function getLightweightModel(config: AIProviderConfig): string | undefined {
  if (config.provider === 'openai') return 'gpt-5-mini';
  if (config.provider === 'anthropic') return 'claude-3-5-haiku-20241022';
  if (config.provider === 'gemini') return 'gemini-2.5-flash';
  if (config.provider === 'grok') return 'grok-3-mini';
  if (config.provider === 'ollama') return 'llama3.2';
  return config.model;
}

/**
 * Generate autocomplete completion string based on vector memory and minimal lightweight AI query.
 * Returns only the suffix to be appended at the cursor position.
 */
export async function getAutocompleteSuggestion(
  ctx: AutocompleteContext,
  aiConfig?: AIProviderConfig,
  signal?: AbortSignal
): Promise<string> {
  const trimmedPrefix = ctx.prefixText.trim();
  if (!trimmedPrefix && !ctx.isSubtask) {
    return '';
  }

  // 1. Pull relevant suggestions from local vector database (0 tokens)
  const searchQuery = trimmedPrefix || ctx.parentTaskTitle || 'task';
  let memorySnippets: string[] = [];

  try {
    const memoryHits: SearchResult[] = await searchMemory(searchQuery, {
      topK: 3,
      minSimilarity: 0.25,
      projectId: ctx.projectId,
    });

    memorySnippets = memoryHits.map((h) => {
      // If task title exists in metadata, favor that
      const title = h.chunk.metadata.taskTitle;
      const text = h.chunk.text.slice(0, 150).replace(/\n+/g, ' ');
      return title ? `Task: ${title} (${text})` : text;
    });
  } catch (err) {
    console.warn('[Autocomplete] Vector memory retrieval error:', err);
  }

  // 2. Check if local vector memory directly contains an obvious high-confidence word completion without calling LLM
  if (ctx.mode === 'word') {
    const lastWord = ctx.prefixText.match(/([a-zA-Z0-9_\-]+)$/)?.[1] || '';
    if (lastWord && lastWord.length >= 4) {
      const lowerLastWord = lastWord.toLowerCase();
      for (const snippet of memorySnippets) {
        const words = snippet.split(/[^a-zA-Z0-9_\-]+/);
        for (const w of words) {
          if (w.toLowerCase().startsWith(lowerLastWord) && w.length > lastWord.length) {
            // Found local word candidate directly from vector DB
            return w.slice(lastWord.length);
          }
        }
      }
    }
  }

  // 3. If AI is configured, use lightweight model with strict token-efficiency
  if (!aiConfig || !aiConfig.isConnected || aiConfig.provider === 'none') {
    return '';
  }

  const lightweightConfig: AIProviderConfig = {
    ...aiConfig,
    model: getLightweightModel(aiConfig) || aiConfig.model,
  };

  const systemPrompt = `You are a fast, token-efficient autocomplete assistant inside a markdown task list.
Instructions:
- Return ONLY the exact text completion string that completes what the user is currently typing.
- Do NOT repeat the prefix they already typed.
- Do NOT output explanations, quotes, markdown formatting, or greetings.
- Keep it concise: ${ctx.mode === 'word' ? '1 to 3 words max' : '5 to 12 words max'}.
- Parity with user's style.`;

  const memoryContextText = memorySnippets.length > 0
    ? `\nRelevant existing project context from vector DB:\n${memorySnippets.map((s) => `- ${s}`).join('\n')}`
    : '';

  const parentContextText = ctx.parentTaskTitle
    ? `\nParent Task: "${ctx.parentTaskTitle}"`
    : '';

  const prompt = `Current input: "${ctx.prefixText}"
Type: ${ctx.isSubtask ? 'Subtask item' : 'Task title'}
Mode: ${ctx.mode === 'word' ? 'Current word/phrase completion' : 'Rest of sentence completion'}${parentContextText}${memoryContextText}

Complete the phrase seamlessly:`;

  try {
    const rawResult = await callAiEngine(
      prompt,
      systemPrompt,
      lightweightConfig,
      'general',
      'text',
      signal
    );

    let completion = (rawResult || '').trim();
    // Clean quotes or markdown wrappers if model hallucinated any
    completion = completion.replace(/^["'`]+|["'`]+$/g, '');

    // If model repeated the prefix, strip it
    if (completion.toLowerCase().startsWith(ctx.prefixText.toLowerCase())) {
      completion = completion.slice(ctx.prefixText.length);
    }

    return completion;
  } catch (err: any) {
    if (err?.name === 'AbortError') return '';
    console.warn('[Autocomplete] AI completion error:', err);
    return '';
  }
}
