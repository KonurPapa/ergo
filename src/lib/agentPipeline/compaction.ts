/**
 * Context compaction for Ergo's own API agent loops (Anthropic / OpenAI / Gemini API keys, Ollama).
 *
 * CLI agents (Claude Code, Codex, Gemini CLI) compact themselves and are left alone. For the API loops, compaction is a
 * safety net near the context window, not a cost saver: with prompt caching, re-reading old context is cheap and a
 * compaction re-writes the whole prefix, so compacting early costs more than it saves (replayed on real sessions: +2–28%
 * at 50–80k for sessions under 150k). Ollama is the case that matters: past num_ctx it silently drops the start of the
 * prompt, system prompt included.
 *
 * Strategy: the same model summarizes everything but the newest few tool exchanges, which stay verbatim. Replayed on
 * real sessions this kept the agent's next step on track; clearing old tool output instead (still the fallback when
 * the summary call fails) sent it off track or re-reading files. Pure functions, no browser or Node APIs.
 */
import type { ContextCompactionSetting } from '../../types';
import type { CatalogModel } from '../modelCatalog/types';
import { findModelPrice } from '../modelCatalog/pricing';

/** Message layouts of the three API loops. */
export type ConversationShape = 'anthropic' | 'openai' | 'gemini';

/** Automatic compaction triggers once the prompt fills this share of the window (the rest is room for the next turn). */
const AUTO_WINDOW_SHARE = 0.8;
/** What Ergo's Ollama loop used as num_ctx before it became configurable. */
export const DEFAULT_OLLAMA_CONTEXT = 16_384;
const FALLBACK_WINDOW = 128_000;
const MIN_MANUAL_TOKENS = 2_000;
/** Newest tool exchanges kept verbatim through a compaction: the agent is usually still working from them. */
export const KEEP_RECENT_EXCHANGES = 4;

export interface CompactionInput {
  provider?: string;
  model?: string;
  setting?: ContextCompactionSetting;
  models: readonly CatalogModel[];
}

/** The model's context window: the profile's value, else the catalog's, else a conservative guess. */
export function contextWindowFor({ provider, model, setting, models }: CompactionInput): number {
  if (setting?.windowTokens && setting.windowTokens > 0) return setting.windowTokens;
  if (provider === 'ollama') return DEFAULT_OLLAMA_CONTEXT;
  return findModelPrice(models, model)?.contextTokens || FALLBACK_WINDOW;
}

/** Prompt size (tokens) at which to compact, or null for never. */
export function compactionThreshold(input: CompactionInput): number | null {
  const setting = input.setting;
  if (setting?.mode === 'off') return null;
  const window = contextWindowFor(input);
  if (setting?.mode === 'manual' && setting.tokens && setting.tokens > 0) {
    return Math.min(Math.max(Math.round(setting.tokens), MIN_MANUAL_TOKENS), window);
  }
  return Math.floor(window * AUTO_WINDOW_SHARE);
}

// ─── Summarizing ────────────────────────────────────────────────────────────

export const SUMMARY_SYSTEM = 'You summarize a coding agent\'s conversation so the agent can continue its work from the summary alone.';

export const SUMMARY_INSTRUCTIONS =
  'Summarize the conversation above so the work can continue from the summary alone. Include: 1. the task and any ' +
  'instructions the user added; 2. files and code examined or changed, with the important function names, signatures, ' +
  'line numbers and snippets; 3. facts learned from tool output the rest of the task depends on; 4. errors hit and how they ' +
  'were fixed; 5. what is done, what is in progress, and the next step. Keep exact identifiers. Plain text, no preamble.';

/** Per tool result in the text the summarizer reads: the summary call itself has to fit in the window. */
const SUMMARY_RESULT_CHARS = 3_000;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…[${text.length - max} more chars]` : text;
}

function partsText(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b: any) => {
      if (typeof b?.text === 'string') return b.text;
      if (b?.type === 'tool_use') return `[tool call] ${b.name} ${JSON.stringify(b.input ?? {})}`;
      if (b?.type === 'tool_result') return `[tool result]\n${clip(typeof b.content === 'string' ? b.content : JSON.stringify(b.content), SUMMARY_RESULT_CHARS)}`;
      if (b?.functionCall) return `[tool call] ${b.functionCall.name} ${JSON.stringify(b.functionCall.args ?? {})}`;
      if (b?.functionResponse) return `[tool result]\n${clip(JSON.stringify(b.functionResponse.response ?? {}), SUMMARY_RESULT_CHARS)}`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Plain-text transcript of `messages` for the summarizer (system message left out). */
export function renderForSummary(messages: any[]): string {
  const out: string[] = [];
  for (const msg of messages) {
    if (msg?.role === 'system') continue;
    if (msg?.role === 'tool') {
      out.push(`[TOOL RESULT]\n${clip(String(msg.content ?? ''), SUMMARY_RESULT_CHARS)}`);
      continue;
    }
    const role = msg?.role === 'user' ? 'USER' : 'ASSISTANT';
    const body = msg?.parts ? partsText(msg.parts) : partsText(msg?.content);
    const calls = Array.isArray(msg?.tool_calls)
      ? msg.tool_calls.map((c: any) => `[tool call] ${c.function?.name} ${c.function?.arguments ?? ''}`).join('\n')
      : '';
    const text = [body, calls].filter(Boolean).join('\n');
    if (text) out.push(`[${role}]\n${text}`);
  }
  return out.join('\n\n');
}

function isAssistant(msg: any): boolean {
  return msg?.role === 'assistant' || msg?.role === 'model';
}

/** Messages before the conversation proper: OpenAI's system message, then the task (first user message). */
function headLength(shape: ConversationShape): number {
  return shape === 'openai' ? 2 : 1;
}

/**
 * Index of the first message kept verbatim: the assistant turn that starts the newest `keep` exchanges, so every kept
 * tool result still follows its tool call. -1 when there is nothing older to compact.
 */
export function tailStart(messages: any[], shape: ConversationShape, keep = KEEP_RECENT_EXCHANGES): number {
  let seen = 0;
  for (let i = messages.length - 1; i >= headLength(shape); i--) {
    if (!isAssistant(messages[i])) continue;
    seen++;
    if (seen === keep) return i > headLength(shape) ? i : -1;
  }
  return -1;
}

/** Replaces everything between the task and `tail` with the summary, in place. */
export function applySummary(messages: any[], shape: ConversationShape, summary: string, tail: number): void {
  const head = headLength(shape);
  const note = `\n\n[Summary of your earlier work on this task — older messages were compacted to save context]\n${summary.trim()}`;
  const task = { ...messages[head - 1] };
  if (shape === 'gemini') task.parts = [...(task.parts || []), { text: note }];
  else if (typeof task.content === 'string') task.content += note;
  else task.content = [...(Array.isArray(task.content) ? task.content : []), { type: 'text', text: note }];
  messages.splice(0, messages.length, ...messages.slice(0, head - 1), task, ...messages.slice(tail));
}

// ─── Fallback: clearing old tool output ─────────────────────────────────────

/** Results at or under this size aren't worth replacing. */
const MIN_CLEAR_CHARS = 400;

function stub(chars: number): string {
  return `[earlier tool output cleared to save context (${chars} chars) — run the tool again if you need it]`;
}

/**
 * Replaces the content of all but the newest tool results with a one-line stub, in place. Used when the summary call
 * fails. Handles Anthropic tool_result blocks, OpenAI / Ollama "tool" messages and Gemini functionResponse parts.
 * Returns how many results were cleared.
 */
export function clearOldToolResults(messages: any[]): number {
  type Slot = { size: number; clear: () => void };
  const slots: Slot[] = [];
  for (const msg of messages) {
    if (msg?.role === 'tool' && typeof msg.content === 'string') {
      slots.push({ size: msg.content.length, clear: () => { msg.content = stub(msg.content.length); } });
    } else if (msg?.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block?.type === 'tool_result' && typeof block.content === 'string') {
          slots.push({ size: block.content.length, clear: () => { block.content = stub(block.content.length); } });
        }
      }
    } else if (msg?.role === 'user' && Array.isArray(msg.parts)) {
      for (const part of msg.parts) {
        const response = part?.functionResponse?.response;
        const key = typeof response?.content === 'string' ? 'content' : typeof response?.error === 'string' ? 'error' : null;
        if (key) slots.push({ size: response[key].length, clear: () => { response[key] = stub(response[key].length); } });
      }
    }
  }
  let cleared = 0;
  for (const slot of slots.slice(0, Math.max(0, slots.length - KEEP_RECENT_EXCHANGES))) {
    if (slot.size < MIN_CLEAR_CHARS) continue;
    slot.clear();
    cleared++;
  }
  return cleared;
}
