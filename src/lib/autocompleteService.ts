import { type AIProviderConfig } from '../types';
import { callAiEngine } from './llmClient';
import { tinyCloudCallConfig } from './agentPipeline/modelRouter';
import { localComplete } from './localModel/client';
import { getLocalModelMode } from './localModel/preference';

/** Old built-in autocomplete defaults that profiles stored as pins. */
const RETIRED_AUTOCOMPLETE_DEFAULTS = new Set(['claude-3-5-haiku-20241022']);

export interface AutocompleteContext {
  taskText: string;
  prefixText: string;
  suffixText: string;
  isSubtask: boolean;
  parentTaskTitle?: string;
  projectId?: string;
  /** Markdown of the list lines just above the current one (with their "- " markers), for the local model. */
  contextBefore?: string;
  /** Markdown of the line just below the current one (with its marker), for the local model. */
  nextLine?: string;
}

export interface AutocompleteSuggestionResult {
  replacementRange: 'line' | 'suffix';
  text: string;
}

/** The parts of a ProseMirror document listContextAround reads (kept structural so this module has no editor dependency). */
interface DocNodeLike {
  isTextblock: boolean;
  textContent: string;
  type: { name: string };
}
interface DocLike {
  content: { size: number };
  nodesBetween(from: number, to: number, f: (node: DocNodeLike, pos: number) => boolean | void): void;
  resolve(pos: number): { depth: number; node(depth: number): DocNodeLike };
}

/**
 * List context for the local model around the line whose textblock starts at `linePos`: up to `maxBefore` lines
 * above it and the line below it, as markdown list lines ("- task", "  - subtask").
 */
export function listContextAround(doc: DocLike, linePos: number, maxBefore = 6): { contextBefore: string; nextLine: string } {
  const lines: Array<{ pos: number; text: string }> = [];
  doc.nodesBetween(Math.max(0, linePos - 2_000), Math.min(doc.content.size, linePos + 1_000), (node, pos) => {
    if (!node.isTextblock) return true;
    const $pos = doc.resolve(pos);
    let listDepth = 0;
    for (let d = $pos.depth; d > 0; d--) {
      const name = $pos.node(d).type.name;
      if (name === 'listItem' || name === 'taskItem') listDepth++;
    }
    const text = node.textContent.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (text || pos === linePos) lines.push({ pos, text: listDepth > 0 ? `${'  '.repeat(listDepth - 1)}- ${text}` : text });
    return false;
  });
  const idx = lines.findIndex((l) => l.pos === linePos);
  if (idx === -1) return { contextBefore: '', nextLine: '' };
  return {
    contextBefore: lines.slice(Math.max(0, idx - maxBefore), idx).map((l) => l.text).join('\n'),
    nextLine: lines[idx + 1]?.text || '',
  };
}

const LOCAL_COMPLETE_TIMEOUT_MS = 2_500;
const CLOUD_COMPLETE_TIMEOUT_MS = 8_000;

/**
 * Fill-in-the-middle prompt for the local model, in the list shape it was evaluated on: the lines above plus the
 * current line up to the cursor, then the rest of the line plus the next line.
 * The space the user just typed is left out of the prefix: the model's tokens carry their own leading space, and
 * with a trailing space it repeats words or starts new list items (checked against the pinned Qwen build).
 */
export function buildLocalFimPrompt(ctx: AutocompleteContext): { prefix: string; suffix: string } {
  const marker = ctx.isSubtask ? '  - ' : '- ';
  let before = (ctx.contextBefore || '').replace(/\s+$/, '');
  if (!before && ctx.isSubtask && ctx.parentTaskTitle) before = `- ${ctx.parentTaskTitle.trim()}`;
  const prefix = `${before ? `${before}\n` : ''}${marker}${ctx.prefixText.replace(/[ \t]+$/, '')}`;
  const next = (ctx.nextLine || '').replace(/\s+$/, '');
  const suffix = `${ctx.suffixText}\n${next ? `${next}\n` : ''}`;
  return { prefix, suffix };
}

const wordsOf = (text: string) => text.toLowerCase().split(/\s+/).filter(Boolean);

/** Drops words at the start of `insert` that repeat the last words before the cursor ("options for" + "options for …"). */
function dropRepeatedLead(insert: string, prefixText: string): string {
  const before = wordsOf(prefixText);
  const parts = insert.split(/(\s+)/); // words and the whitespace between them
  const lead = parts.filter((_, i) => i % 2 === 0).map((w) => w.toLowerCase());
  for (let k = Math.min(6, before.length, lead.length); k >= 1; k--) {
    const tail = before.slice(before.length - k);
    if (tail.every((w, i) => w === lead[i])) {
      return parts.slice(2 * k).join('').trim();
    }
  }
  return insert;
}

/** Turns the local model's insertion into a suggestion (null when there is nothing useful to show). */
export function localCompletionToSuggestion(text: string, ctx: AutocompleteContext): AutocompleteSuggestionResult | null {
  let insert = (text || '').split('\n')[0].replace(/^[-*•]\s+(\[[ xX]\]\s*)?/, '').trim();
  insert = dropRepeatedLead(insert, ctx.prefixText);
  if (!insert) return null;
  const rest = ctx.suffixText.trim();
  // The model sometimes repeats the text after the cursor; keep only the new part.
  if (rest && insert.endsWith(rest)) insert = insert.slice(0, insert.length - rest.length).trimEnd();
  if (!insert) return null;
  // The cursor sits after a space; keep a word boundary before any text that follows the cursor.
  if (ctx.suffixText && !/^\s/.test(ctx.suffixText) && !/[\s([{"'`]$/.test(insert)) insert += ' ';
  return { replacementRange: 'suffix', text: insert };
}

async function localSuggestion(ctx: AutocompleteContext, signal?: AbortSignal): Promise<AutocompleteSuggestionResult | null> {
  const { prefix, suffix } = buildLocalFimPrompt(ctx);
  const res = await localComplete({ prefix, suffix }, { signal, timeoutMs: LOCAL_COMPLETE_TIMEOUT_MS });
  if (!res.success) return null;
  return localCompletionToSuggestion(res.text, ctx);
}

/**
 * Generate autocomplete completion string based on minimal lightweight AI query.
 * Can return either an inline suffix or a full replacement line (with rewording/grammar/typo fixes).
 *
 * With the local model selected (Settings → Local AI model) it answers first; when it is unavailable or has no
 * suggestion, the tiny cloud model of the active AI profile is asked instead.
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

  if (getLocalModelMode() === 'local') {
    const local = await localSuggestion(ctx, signal);
    if (local || signal?.aborted) return local;
  }

  // Cloud: the tiny model of the active profile, unless an autocomplete model is pinned (role override / profile).
  const roleOverride = aiConfig?.roleConfigs?.autocomplete;
  // Profiles saved before the current model generation stored the old default as if it were a choice: treat it as
  // "no override" so they get the tiny model like everyone else.
  const pinned = [roleOverride?.model, aiConfig?.autocompleteModel].find((m) => m && !RETIRED_AUTOCOMPLETE_DEFAULTS.has(m));
  const lightweightConfig = tinyCloudCallConfig(aiConfig, {
    provider: pinned ? roleOverride?.provider : undefined,
    model: pinned,
  });
  // If AI is not configured or not connected, skip
  if (!lightweightConfig) {
    return null;
  }

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
    const timerId = setTimeout(() => timeoutController.abort(), CLOUD_COMPLETE_TIMEOUT_MS);
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
