/**
 * Context compaction for Ergo's own API agent loops (Anthropic / OpenAI / Gemini API keys, Ollama) and the thresholds
 * Ergo uses to rotate CLI agents (a worker that nears its threshold writes a handoff note and a fresh process continues).
 *
 * Two strategies:
 *  - Short context (every provider but Anthropic): "stop, summarize & restart" well before the window. Once the
 *    conversation reaches its threshold (DEFAULT_AUTO_COMPACT_TOKENS, or the user's), the agent writes a structured
 *    handoff note and the conversation restarts as the original task + that note + the newest tool exchange. Prompt
 *    caches survive it: the handoff is asked for on the agent's own conversation (same model, system prompt and tools,
 *    so the whole history is a cache read), and the restarted conversation keeps the task message byte-identical, so system + tools + task stay a cached prefix. OpenAI, Gemini and xAI cache prefixes automatically
 *    with no write premium; Ollama reuses its KV cache for the shared prefix (and skips re-evaluating it).
 *  - Near the window (Anthropic): a safety net at 80%. Anthropic reads cached context at 0.1x or less but writes it at
 *    1.25x, so re-reading old context is cheap and every restart re-writes the new prefix; compacting early cost more
 *    than it saved on replayed sessions (+2–28% at 50–80k for sessions under 150k).
 *
 * Summaries come from the same model; the newest tool exchanges stay verbatim. Clearing old tool output instead (the
 * fallback when the summary call fails) sent agents off track or re-reading files on replays. Pure functions, no
 * browser or Node APIs.
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
/** Newest tool exchanges kept verbatim through a near-window compaction: the agent is usually still working from them. */
export const KEEP_RECENT_EXCHANGES = 4;
/** Newest tool exchanges kept through a short-context restart: the one the agent is acting on right now. */
export const SHORT_CONTEXT_KEEP_EXCHANGES = 1;
/**
 * Short context, automatic: compact (or rotate a CLI worker) once the conversation reaches this many tokens, unless the
 * user set their own threshold.
 */
export const DEFAULT_AUTO_COMPACT_TOKENS = 60_000;
/**
 * Room a conversation always gets above its fixed start (system prompt, tools, task). Less thrashes: measured on Claude
 * Code (Sonnet 5.5, 2026-11-05), a ~33k start under a 60k trigger refilled within three file reads after every
 * compaction until the session gave up with the task unfinished.
 */
const MIN_WORKING_TOKENS = 40_000;
/**
 * Lowest trigger Ergo gives Claude Code. Its own start is ~20–35k tokens (system prompt, tools, task), so lower
 * triggers thrash (see above); 100k is also the floor of CLAUDE_CODE_AUTO_COMPACT_WINDOW, the documented setting.
 */
export const MIN_CLAUDE_CODE_COMPACT_TOKENS = 100_000;
/** A CLI rotation never waits past this share of the window (the CLIs' own compaction starts around here). */
const SHORT_CONTEXT_WINDOW_SHARE = 0.6;
/** A restarted conversation must grow at least this much before the next restart (no back-to-back summaries). */
const MIN_GROWTH_BETWEEN_COMPACTIONS = 4_000;

export interface CompactionInput {
  provider?: string;
  model?: string;
  setting?: ContextCompactionSetting;
  models: readonly CatalogModel[];
  /** Prompt tokens of the conversation's fixed start (its first call): short-context thresholds sit a budget above it. */
  baseTokens?: number;
  /** An Ergo API loop, or a CLI agent Ergo rotates. */
  kind?: 'api' | 'cli';
}

/**
 * Providers whose agents run short-context (stop, summarize & restart) instead of compacting only near the window.
 * Anthropic stays on the near-window safety net: its cache-write premium makes early restarts cost more (see top).
 */
export function usesShortContext(provider?: string): boolean {
  return provider !== 'anthropic';
}

/** The model's context window: the profile's value, else the catalog's, else a conservative guess. */
export function contextWindowFor({ provider, model, setting, models }: CompactionInput): number {
  if (setting?.windowTokens && setting.windowTokens > 0) return setting.windowTokens;
  if (provider === 'ollama') return DEFAULT_OLLAMA_CONTEXT;
  return findModelPrice(models, model)?.contextTokens || FALLBACK_WINDOW;
}

/** The user's own threshold (auto mode with a size, or the older "custom size" mode), if any. */
export function userCompactionTokens(setting?: ContextCompactionSetting): number | undefined {
  return setting && setting.mode !== 'off' && setting.tokens && setting.tokens > 0 ? Math.max(Math.round(setting.tokens), MIN_MANUAL_TOKENS) : undefined;
}

/** Prompt size (tokens) at which to compact, or null for never. */
export function compactionThreshold(input: CompactionInput): number | null {
  const setting = input.setting;
  if (setting?.mode === 'off') return null;
  const window = contextWindowFor(input);
  const nearWindow = Math.floor(window * AUTO_WINDOW_SHARE);
  const chosen = userCompactionTokens(setting);
  // Anthropic: the near-window safety net unless the user picked a size (its cache economics, see top).
  if (!usesShortContext(input.provider)) return chosen ? Math.min(chosen, window) : nearWindow;
  const kind = input.kind ?? 'api';
  const target = Math.max(chosen ?? DEFAULT_AUTO_COMPACT_TOKENS, Math.max(0, input.baseTokens ?? 0) + MIN_WORKING_TOKENS);
  // A CLI rotation has to beat the CLI's own compaction; an API loop only has to stay inside the window.
  const cap = kind === 'cli' ? Math.floor(window * SHORT_CONTEXT_WINDOW_SHARE) : nearWindow;
  return Math.min(cap, target);
}

/**
 * Environment that makes Claude Code auto-compact at the user's threshold (it keeps its own compaction; Ergo only
 * moves the trigger). CLAUDE_CODE_AUTO_COMPACT_WINDOW takes 100k–1M and is capped at the model's window; thresholds
 * under MIN_CLAUDE_CODE_COMPACT_TOKENS are raised to it. Empty when the user set no threshold: Claude Code's defaults stand.
 */
export function claudeCodeCompactionEnv(setting?: ContextCompactionSetting): Record<string, string> {
  const tokens = userCompactionTokens(setting);
  if (!tokens) return {};
  return { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(Math.min(Math.max(tokens, MIN_CLAUDE_CODE_COMPACT_TOKENS), 1_000_000)) };
}

/**
 * When a loop compacts. Short-context loops learn their fixed start from the first call and restart a budget above it;
 * after a compaction the conversation has to grow again before the next one, so a restart that could not shrink the
 * prompt enough (a huge kept tool result) is not repeated every round.
 */
export class CompactionGate {
  private base = 0;
  private floor = 0;
  private awaitingFloor = false;
  private readonly input: CompactionInput;
  constructor(input: CompactionInput) {
    this.input = input;
  }

  /** The short-context strategy (restart from a structured handoff), or the near-window safety net. */
  get shortContext(): boolean {
    return usesShortContext(this.input.provider);
  }

  /** Newest tool exchanges a compaction keeps verbatim. */
  get keepExchanges(): number {
    return this.shortContext ? SHORT_CONTEXT_KEEP_EXCHANGES : KEEP_RECENT_EXCHANGES;
  }

  /** The threshold for the conversation seen so far (null: never). */
  threshold(): number | null {
    return compactionThreshold({ ...this.input, baseTokens: this.base });
  }

  /** Records the prompt size of a call that was just made. */
  observe(promptTokens: number): void {
    if (promptTokens <= 0) return;
    if (!this.base) this.base = promptTokens;
    if (this.awaitingFloor) {
      this.floor = promptTokens;
      this.awaitingFloor = false;
    }
  }

  /** Should the loop compact before sending a prompt of this size? */
  due(promptTokens: number): boolean {
    const at = this.threshold();
    if (!at || promptTokens < at || this.awaitingFloor) return false;
    return !this.floor || promptTokens >= this.floor + MIN_GROWTH_BETWEEN_COMPACTIONS;
  }

  /** The conversation was just compacted: the next call's size is the new floor. */
  compacted(): void {
    this.awaitingFloor = true;
  }
}

/**
 * Rough size of a request in tokens, counted before it is sent: ~3.5 characters a token, the dense end for code and
 * JSON, so it errs toward compacting a little early rather than overflowing.
 */
export function estimatePromptTokens(messages: any[], tools?: any[]): number {
  return Math.ceil((JSON.stringify(messages).length + (tools ? JSON.stringify(tools).length : 0)) / 3.5);
}

// ─── Summarizing ────────────────────────────────────────────────────────────

export const SUMMARY_SYSTEM = 'You summarize a coding agent\'s conversation so the agent can continue its work from the summary alone.';

export const SUMMARY_INSTRUCTIONS =
  'Summarize the conversation above so the work can continue from the summary alone. Include: 1. the task and any ' +
  'instructions the user added; 2. files and code examined or changed, with the important function names, signatures, ' +
  'line numbers and snippets; 3. facts learned from tool output the rest of the task depends on; 4. errors hit and how they ' +
  'were fixed; 5. what is done, what is in progress, and the next step. Keep exact identifiers. Plain text, no preamble.';

/**
 * The structured handoff note of a short-context restart (and of a CLI worker's rotation). Unstructured summaries
 * drop operational detail (exact paths, failed attempts, the next step); a fixed template keeps it.
 */
export const HANDOFF_TEMPLATE =
  '# Task State Handoff\n' +
  '- Goal: the objective and scope, plus every instruction the user added along the way\n' +
  '- Progress & Discoveries: files read or changed (exact paths, line ranges), root causes confirmed, facts from tool output the rest of the task depends on\n' +
  '- Current Blockers & Failed Attempts: errors hit and approaches that did not work, so they are not tried again\n' +
  '- Next Immediate Actions: the exact next 1-2 steps\n' +
  '- Key Workspace Context: branches, running servers, build / test commands and anything else in the environment you rely on';

/** Asked on the agent's own conversation, so the history it summarizes is read from the prompt cache. */
export const HANDOFF_INSTRUCTIONS =
  'CONTEXT HANDOFF. Do not call any tools in this reply. To keep your context short, this conversation is about to be ' +
  'reset: you will continue the same task from the original task message, the note you write now, and your newest ' +
  'tool result. Write the note in exactly this structure, keeping exact file paths, identifiers, line numbers, commands ' +
  'and error messages:\n\n' +
  HANDOFF_TEMPLATE +
  '\n\nReply with the note only, no preamble.';

/** Summary prompt for the fallback call that reads a rendered transcript (the same structure). */
export const HANDOFF_SUMMARY_INSTRUCTIONS =
  'Write a handoff note for the conversation above so the agent can continue the task from it alone. Use exactly this ' +
  'structure, keeping exact file paths, identifiers, line numbers, commands and error messages:\n\n' +
  HANDOFF_TEMPLATE +
  '\n\nThe note only, no preamble.';

/**
 * System-prompt rule for short-context agents: their older turns are replaced, so they should look things up on
 * demand instead of loading large files into the conversation.
 */
export const SHORT_CONTEXT_RULE =
  'CONTEXT IS KEPT SHORT: your older turns are periodically replaced by a handoff note you write. Look things up with ' +
  'tools when you need them (search, then read the specific lines) rather than reading whole large files or dumping ' +
  'long command output, and name exact paths and identifiers in your replies.';

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

/** Each conversation's task message as it was before its first compaction (the note of a later one replaces it). */
const originalTasks = new WeakMap<any[], any>();

/**
 * Replaces everything between the task and `tail` with the summary, in place. The task message keeps its original
 * content first and byte for byte (so it stays a cached prefix); the summary follows it, replacing an earlier one.
 */
export function applySummary(messages: any[], shape: ConversationShape, summary: string, tail: number): void {
  const head = headLength(shape);
  const current = messages[head - 1];
  if (!originalTasks.has(messages)) originalTasks.set(messages, shape === 'gemini' ? [...(current.parts || [])] : current.content);
  const original = originalTasks.get(messages);
  const note = `\n\n[Handoff note from your earlier work on this task — older messages were compacted to save context]\n${summary.trim()}`;
  const task = { ...current };
  if (shape === 'gemini') task.parts = [...original, { text: note }];
  else if (typeof original === 'string') task.content = original + note;
  else task.content = [...(Array.isArray(original) ? original : []), { type: 'text', text: note }];
  messages.splice(0, messages.length, ...messages.slice(0, head - 1), task, ...messages.slice(tail));
}

/**
 * The conversation plus one closing instruction, for a summary asked on the conversation itself: the history stays a
 * byte-identical prefix of the request. Returns a new array; `messages` is not changed.
 */
export function withClosingInstruction(messages: any[], shape: ConversationShape, text: string): any[] {
  if (shape === 'anthropic') {
    const last = messages[messages.length - 1];
    // Anthropic turns alternate too: the instruction follows the newest tool results in their user message (after
    // the cache marker on the last result, so everything before it is still read from cache).
    if (last?.role === 'user') {
      const content = Array.isArray(last.content) ? last.content : [{ type: 'text', text: String(last.content ?? '') }];
      return [...messages.slice(0, -1), { ...last, content: [...content, { type: 'text', text }] }];
    }
    return [...messages, { role: 'user', content: text }];
  }
  if (shape !== 'gemini') return [...messages, { role: 'user', content: text }];
  const last = messages[messages.length - 1];
  // Gemini turns alternate: a conversation that ends on the user's tool results gets the instruction as one more part.
  if (last?.role === 'user') return [...messages.slice(0, -1), { ...last, parts: [...(last.parts || []), { text }] }];
  return [...messages, { role: 'user', parts: [{ text }] }];
}

// ─── Fallback: clearing old tool output ─────────────────────────────────────

/** Results at or under this size aren't worth replacing. */
const MIN_CLEAR_CHARS = 400;

function stub(chars: number): string {
  return `[earlier tool output cleared to save context (${chars} chars) — run the tool again if you need it]`;
}

/** Each tool result's text in a conversation, readable and replaceable in place. Handles Anthropic tool_result blocks,
 * OpenAI / Ollama "tool" messages and Gemini functionResponse parts. */
function toolResultSlots(messages: any[]): Array<{ text: () => string; set: (text: string) => void }> {
  const slots: Array<{ text: () => string; set: (text: string) => void }> = [];
  for (const msg of messages) {
    if (msg?.role === 'tool' && typeof msg.content === 'string') {
      slots.push({ text: () => msg.content, set: (t) => { msg.content = t; } });
    } else if (msg?.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block?.type === 'tool_result' && typeof block.content === 'string') {
          slots.push({ text: () => block.content, set: (t) => { block.content = t; } });
        }
      }
    } else if (msg?.role === 'user' && Array.isArray(msg.parts)) {
      for (const part of msg.parts) {
        const response = part?.functionResponse?.response;
        const key = typeof response?.content === 'string' ? 'content' : typeof response?.error === 'string' ? 'error' : null;
        if (key) slots.push({ text: () => response[key], set: (t) => { response[key] = t; } });
      }
    }
  }
  return slots;
}

/**
 * Replaces the content of all but the newest tool results with a one-line stub, in place. Used when the summary call
 * fails. Returns how many results were cleared.
 */
export function clearOldToolResults(messages: any[]): number {
  const slots = toolResultSlots(messages).map((slot) => ({ size: slot.text().length, clear: () => slot.set(stub(slot.text().length)) }));
  let cleared = 0;
  for (const slot of slots.slice(0, Math.max(0, slots.length - KEEP_RECENT_EXCHANGES))) {
    if (slot.size < MIN_CLEAR_CHARS) continue;
    slot.clear();
    cleared++;
  }
  return cleared;
}

/** What a cut tool result keeps at least, so the agent still sees what kind of output it was. */
const MIN_KEPT_RESULT_CHARS = 1_500;

/**
 * Last resort for small windows (Ollama), after compaction: the newest tool results stay verbatim through a compaction,
 * so one huge result can still overflow the window, and Ollama would then drop the start of the prompt (the system
 * prompt and task first). Cuts the middle out of the largest results, keeping their start and end, until the request
 * fits `maxTokens`. Returns true when anything was cut.
 */
export function clipToolResultsToFit(messages: any[], tools: any[] | undefined, maxTokens: number): boolean {
  let overChars = Math.ceil((estimatePromptTokens(messages, tools) - maxTokens) * 3.5);
  if (overChars <= 0) return false;
  let clipped = false;
  const slots = toolResultSlots(messages).sort((a, b) => b.text().length - a.text().length);
  for (const slot of slots) {
    if (overChars <= 0) break;
    const text = slot.text();
    const cut = Math.min(text.length - MIN_KEPT_RESULT_CHARS, overChars + 200);
    if (cut <= 0) continue;
    const keep = text.length - cut;
    const head = Math.ceil(keep * 0.6);
    slot.set(`${text.slice(0, head)}\n…[${cut} chars cut to fit the model's context window — narrow the request to see them]…\n${text.slice(text.length - (keep - head))}`);
    overChars -= cut;
    clipped = true;
  }
  return clipped;
}
