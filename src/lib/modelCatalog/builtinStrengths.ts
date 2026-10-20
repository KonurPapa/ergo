/**
 * Built-in model strengths — used by Auto model selection when no Artificial Analysis key is set (or a model
 * wasn't matched there). Updated with Ergo releases; models released later are placed by provider and price
 * (see autoRouter.ts).
 *
 * Scores are 0–100 on a shared scale where 100 is the strongest model in this table on that axis.
 */
import type { CatalogProvider } from './types';

export interface BuiltinStrength {
  provider: CatalogProvider;
  /**
   * Matches catalog / CLI model ids: an exact id, or a prefix ending in "*" (e.g. "claude-opus-5-5*" also covers
   * dated ids like "claude-opus-5-5-20260101"). The first matching entry wins, so list specific ids first.
   */
  match: string;
  /** General reasoning / planning (Artificial Analysis Intelligence Index, rescaled). */
  intelligence: number;
  /** Agentic coding (Artificial Analysis Coding Index, rescaled). */
  coding: number;
  /** Relative output speed, 0–100 (100 = fastest in this table). */
  speed: number;
  /** One line on what it's good at (shown in routing explanations). */
  note: string;
}

/** Date the scores were compiled, and where from (shown in Settings). */
export const BUILTIN_STRENGTHS_AS_OF = '2026-10-15';
export const BUILTIN_STRENGTHS_SOURCES: string[] = [
  'https://artificialanalysis.ai/leaderboards/models',
  'https://artificialanalysis.ai/methodology/intelligence-benchmarking',
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json',
  'https://openrouter.ai/api/v1/models',
  'https://developers.openai.com/api/docs/models/gpt-daybreak-blue-latest'
];

/*
 * How the numbers were made (2026-10-15):
 * - intelligence = Artificial Analysis Intelligence Index v4.3.2 ÷ 57.6 (Claude Opus 5.5, the table max) × 100.
 * - coding = AA's coding category of that index — mean of Terminal-Bench 4.0 and SciCode — ÷ 63.25 (Claude
 *   Opus 5.5) × 100. AA no longer publishes a separate per-model Coding Index on its public pages; this is the same
 *   pair of evals, equally weighted.
 * - speed = AA median output tokens/s ÷ 437.8 (Gemini 3.5 Flash-Lite) × 100.
 * - Each id uses AA's highest-effort variant of that model (Max / Xhigh / High), the one on its AA model page.
 * - The comment above each entry gives the raw values. "(estimated)" entries have no full AA measurement; the note
 *   says what the estimate is based on. Legacy and specialist ids get deliberately low or sibling-equal scores so
 *   the price-based fallback in autoRouter.ts can't rate them above current models.
 */
export const BUILTIN_STRENGTHS: BuiltinStrength[] = [
  // ── Anthropic ──
  // AA II 57.6 · coding 63.25 · 95.2 t/s
  { provider: 'anthropic', match: 'claude-opus-5-5*', intelligence: 100, coding: 100, speed: 22,
    note: 'frontier agentic coding, long-horizon planning, hard debugging' },
  // AA II 56 · coding 62.3 · 130.7 t/s
  { provider: 'anthropic', match: 'claude-sonnet-5-5*', intelligence: 97, coding: 98, speed: 30,
    note: 'near-Opus coding and agents at Sonnet price, fast' },
  // AA II 43.4 · coding 43.9 · 239.2 t/s
  { provider: 'anthropic', match: 'claude-haiku-5-5*', intelligence: 75, coding: 69, speed: 55,
    note: 'very cheap and fast; solid everyday edits, JSON, triage' },
  // AA II 53.4 · coding 57.55 · 70.9 t/s
  { provider: 'anthropic', match: 'claude-fable-5-1*', intelligence: 93, coding: 91, speed: 16,
    note: 'deepest reasoning, long autonomous runs; premium price' },
  // AA II 53.4 · coding 57.55 · 70.9 t/s (estimated)
  { provider: 'anthropic', match: 'claude-mythos-5-1*', intelligence: 93, coding: 91, speed: 16,
    note: 'estimated = Fable 5.1 (same capabilities per Anthropic; Project Glasswing access only)' },
  // AA II 49.6 · coding 51.7 · 69.1 t/s (estimated)
  { provider: 'anthropic', match: 'claude-mythos-5*', intelligence: 86, coding: 82, speed: 16,
    note: 'estimated = Fable 5 (restricted-access counterpart)' },
  // AA II 49.6 · coding 51.7 · 69.1 t/s
  { provider: 'anthropic', match: 'claude-fable-5*', intelligence: 86, coding: 82, speed: 16,
    note: 'deep reasoning, long-horizon work; superseded by Fable 5.1' },
  // AA II 50.8 · coding 52.7 · 61.9 t/s
  { provider: 'anthropic', match: 'claude-opus-5*', intelligence: 88, coding: 83, speed: 14,
    note: 'strong agentic coding and planning; superseded by Opus 5.5 (cheaper)' },
  // AA II 38.2 · coding 34.2 · 74.9 t/s
  { provider: 'anthropic', match: 'claude-sonnet-5*', intelligence: 66, coding: 54, speed: 17,
    note: 'balanced coding and writing; superseded by Sonnet 5.5' },
  // AA II 41.8 · coding 38.05 · 66.2 t/s
  { provider: 'anthropic', match: 'claude-opus-4-8*', intelligence: 73, coding: 60, speed: 15,
    note: 'capable planner and coder; previous generation' },
  // AA II 40.7 · coding 36 · 57.7 t/s (estimated)
  { provider: 'anthropic', match: 'claude-opus-4-7*', intelligence: 71, coding: 57, speed: 13,
    note: 'capable planner and coder; previous generation (AA index estimated by AA; coding estimated from Terminal-Bench Hard vs Opus 4.8)' },
  // AA II 31.9 · coding 26 · 39.9 t/s (estimated)
  { provider: 'anthropic', match: 'claude-opus-4-6*', intelligence: 55, coding: 41, speed: 9,
    note: 'older Opus; reasoning and writing (AA index estimated by AA; coding estimated from Terminal-Bench Hard)' },
  // AA II 30.1 · coding 26.55 · 54.8 t/s
  { provider: 'anthropic', match: 'claude-sonnet-4-6*', intelligence: 52, coding: 42, speed: 13,
    note: 'older Sonnet; general coding and writing' },
  // AA II 29.1 · coding 24 · 67.3 t/s (estimated)
  { provider: 'anthropic', match: 'claude-opus-4-5*', intelligence: 51, coding: 38, speed: 15,
    note: 'legacy Opus (AA index estimated by AA; coding estimated from Terminal-Bench Hard)' },
  // AA II 20.7 · coding 22.85 · 47.3 t/s
  { provider: 'anthropic', match: 'claude-sonnet-4-5*', intelligence: 36, coding: 36, speed: 11,
    note: 'legacy Sonnet; retiring 2026-11-30' },
  // AA II 16.9 · coding 21.1 · 94.3 t/s
  { provider: 'anthropic', match: 'claude-haiku-4-5*', intelligence: 29, coding: 33, speed: 22,
    note: 'legacy Haiku; Haiku 5.5 is cheaper and stronger' },
  // ── OpenAI ──
  // AA II 51.8 · coding 55.15 · 53.5 t/s
  { provider: 'openai', match: 'gpt-6.1-sol*', intelligence: 90, coding: 87, speed: 12,
    note: 'frontier reasoning and agentic coding at mid price; slow output' },
  // AA II 52.7 · coding 57.8 · 44.6 t/s
  { provider: 'openai', match: 'gpt-6-astra*', intelligence: 91, coding: 91, speed: 10,
    note: 'top OpenAI reasoning and coding; premium price, slow' },
  // AA II 47.6 · coding 50.75 · 102.5 t/s
  { provider: 'openai', match: 'gpt-6-sol*', intelligence: 83, coding: 80, speed: 23,
    note: 'strong general reasoning and coding; superseded by GPT-6.1 Sol' },
  // AA II 38.1 · coding 33.6 · 118.2 t/s
  { provider: 'openai', match: 'gpt-6-luna*', intelligence: 66, coding: 53, speed: 27,
    note: 'very cheap; good classification, extraction, light edits' },
  // AA II 47 · coding 48.5 · 94.8 t/s (estimated)
  { provider: 'openai', match: 'gpt-5.6-cyber*', intelligence: 82, coding: 77, speed: 22,
    note: 'estimated = GPT-5.6 Sol (cybersecurity-specialized variant, restricted access)' },
  // AA II 47 · coding 48.5 · 94.8 t/s
  { provider: 'openai', match: 'gpt-5.6-sol*', intelligence: 82, coding: 77, speed: 22,
    note: 'strong reasoning and coding; superseded by GPT-6 Sol' },
  // AA II 42.1 · coding 45.2 · 129.3 t/s
  { provider: 'openai', match: 'gpt-5.6-terra*', intelligence: 73, coding: 71, speed: 30,
    note: 'mid-price all-rounder; good coding at max effort' },
  // AA II 37.3 · coding 32.6 · 120.6 t/s
  { provider: 'openai', match: 'gpt-5.6-luna*', intelligence: 65, coding: 52, speed: 28,
    note: 'cheap and fast; simple edits and JSON; superseded by GPT-6 Luna' },
  // AA II 47 · coding 48.5 · 94.8 t/s (estimated)
  { provider: 'openai', match: 'gpt-5.6', intelligence: 82, coding: 77, speed: 22,
    note: 'estimated = GPT-5.6 Sol (same price; unsuffixed id)' },
  // AA II 47 · coding 48.5 · 94.8 t/s (estimated)
  { provider: 'openai', match: 'daybreak-blue-latest', intelligence: 82, coding: 77, speed: 22,
    note: 'estimated = GPT-5.6 Sol (OpenAI docs: alias for gpt-5.6-sol with cyber safeguards; deprecated, Responses API only)' },
  // AA II 47 · coding 48.5 · 94.8 t/s (estimated)
  { provider: 'openai', match: 'daybreak-red-latest', intelligence: 82, coding: 77, speed: 22,
    note: 'estimated conservatively = GPT-5.6 Sol (restricted cybersecurity model, unscored)' },
  // AA II 26 · coding 32.55 · 159.1 t/s
  { provider: 'openai', match: 'chat-latest', intelligence: 45, coding: 51, speed: 36,
    note: 'ChatGPT chat model (GPT-5.5 Instant); conversational, weak for agents' },
  // AA II 38.4 · coding 35.2 · 98.5 t/s (estimated)
  { provider: 'openai', match: 'gpt-5.5-cyber*', intelligence: 67, coding: 56, speed: 22,
    note: 'estimated = GPT-5.5 (cybersecurity-specialized variant, restricted access)' },
  // AA II 38.4 · coding 35.2 · 98.5 t/s
  { provider: 'openai', match: 'gpt-5.5*', intelligence: 67, coding: 56, speed: 22,
    note: 'previous-generation flagship; expensive for its level' },
  // AA II 24.1 · coding 27.05 · 254.9 t/s
  { provider: 'openai', match: 'gpt-5.4-mini*', intelligence: 42, coding: 43, speed: 58,
    note: 'fast small model; superseded by GPT-5.6/6 Luna' },
  // AA II 20.7 · coding 23.85 · 165.9 t/s
  { provider: 'openai', match: 'gpt-5.4-nano*', intelligence: 36, coding: 38, speed: 38,
    note: 'tiny and cheap; superseded by GPT-6 Luna' },
  // AA II 39 · coding 33 · 87.7 t/s (estimated)
  { provider: 'openai', match: 'gpt-5.4*', intelligence: 68, coding: 52, speed: 20,
    note: 'older flagship (AA index estimated by AA; coding estimated from Terminal-Bench Hard vs GPT-5.5)' },
  // AA II 30.4 · coding 27 · 78.6 t/s (estimated)
  { provider: 'openai', match: 'gpt-5.2*', intelligence: 53, coding: 43, speed: 18,
    note: 'legacy flagship (AA index estimated by AA; coding estimated from Terminal-Bench Hard)' },
  // AA II 24.7 · coding 24 · 116.8 t/s (estimated)
  { provider: 'openai', match: 'gpt-5.1*', intelligence: 43, coding: 38, speed: 27,
    note: 'legacy flagship (AA index estimated by AA; coding estimated from Terminal-Bench Hard)' },
  // AA II 16.8 · coding 19.5 · 138.5 t/s
  { provider: 'openai', match: 'gpt-5-mini*', intelligence: 29, coding: 31, speed: 32,
    note: 'legacy small model; GPT-6 Luna is cheaper and stronger' },
  // AA II 13 · coding 17 · 145.6 t/s (estimated)
  { provider: 'openai', match: 'gpt-5-nano*', intelligence: 23, coding: 27, speed: 33,
    note: 'legacy tiny model (AA index estimated by AA; coding estimated)' },
  // AA II 23 · coding 21 · 101.7 t/s (estimated)
  { provider: 'openai', match: 'gpt-5', intelligence: 40, coding: 33, speed: 23,
    note: 'legacy GPT-5 (AA index estimated by AA; coding estimated from Terminal-Bench Hard)' },
  // AA II 23 · coding 21 · 101.7 t/s (estimated)
  { provider: 'openai', match: 'gpt-5-20*', intelligence: 40, coding: 33, speed: 23,
    note: 'legacy GPT-5 snapshot (estimated, as gpt-5)' },
  // AA II 11 · coding 21.4 · 183.6 t/s
  { provider: 'openai', match: 'o3-mini*', intelligence: 19, coding: 34, speed: 42,
    note: 'legacy reasoning mini; retiring 2026-10-23' },
  // AA II 20.2 · coding 21 · 119.8 t/s (estimated)
  { provider: 'openai', match: 'o3*', intelligence: 35, coding: 33, speed: 27,
    note: 'legacy reasoning model (AA index estimated by AA; coding estimated from Terminal-Bench Hard)' },
  // AA II 16.7 · coding 17 · 148.6 t/s (estimated)
  { provider: 'openai', match: 'o4-mini*', intelligence: 29, coding: 27, speed: 34,
    note: 'legacy reasoning mini; retiring 2026-10-23 (AA index estimated by AA; coding estimated)' },
  // AA II 7.8 · coding 10 · 211.9 t/s (estimated)
  { provider: 'openai', match: 'gpt-4.1-nano*', intelligence: 14, coding: 16, speed: 48,
    note: 'legacy non-reasoning tiny model (AA index estimated by AA; coding estimated)' },
  // AA II 10.2 · coding 13 · 151.3 t/s (estimated)
  { provider: 'openai', match: 'gpt-4.1-mini*', intelligence: 18, coding: 21, speed: 35,
    note: 'legacy non-reasoning small model (AA index estimated by AA; coding estimated)' },
  // AA II 12.7 · coding 16 · 155.1 t/s (estimated)
  { provider: 'openai', match: 'gpt-4.1*', intelligence: 22, coding: 25, speed: 35,
    note: 'legacy non-reasoning model (AA index estimated by AA; coding estimated)' },
  // AA II 6.7 · coding 10 · 111.4 t/s (estimated)
  { provider: 'openai', match: 'gpt-4o-mini*', intelligence: 12, coding: 16, speed: 25,
    note: 'legacy non-reasoning small model (AA index estimated by AA; coding estimated)' },
  // AA II 8.4 · coding 13 · 160.3 t/s (estimated)
  { provider: 'openai', match: 'gpt-4o*', intelligence: 15, coding: 21, speed: 37,
    note: 'legacy non-reasoning model (AA index estimated by AA; coding estimated)' },
  // AA II 5 · coding 8 · 60 t/s (estimated)
  { provider: 'openai', match: 'gpt-4*', intelligence: 9, coding: 13, speed: 14,
    note: 'legacy GPT-4 / Turbo; estimated floor, retiring 2026-10-23' },
  // AA II 3 · coding 5 · 100 t/s (estimated)
  { provider: 'openai', match: 'gpt-3.5-turbo*', intelligence: 5, coding: 8, speed: 23,
    note: 'legacy; estimated floor, retiring 2026-10-23' },
  // AA II 11.6 · coding 17 · 212.1 t/s
  { provider: 'openai', match: 'gpt-oss-120b*', intelligence: 20, coding: 27, speed: 48,
    note: 'open-weight model (Antigravity CLI); fast, weak at agentic coding' },
  // ── Google Gemini ──
  // AA II 52.6 · coding 59.45 · 100 t/s
  { provider: 'gemini', match: 'gemini-4-argon*', intelligence: 91, coding: 94, speed: 23,
    note: 'frontier reasoning and agentic coding at mid price (speed estimated; AA has no speed data yet)' },
  // AA II 29.7 · coding 31.35 · 140.1 t/s (estimated)
  { provider: 'gemini', match: 'gemini-pro-latest', intelligence: 52, coding: 50, speed: 32,
    note: 'estimated = Gemini 3.1 Pro (alias; price matches 3.1 Pro, may roll to Gemini 4 Argon)' },
  // AA II 29.7 · coding 31.35 · 140.1 t/s
  { provider: 'gemini', match: 'gemini-3.1-pro*', intelligence: 52, coding: 50, speed: 32,
    note: 'older Pro; long-context reasoning, multimodal' },
  // AA II 40.9 · coding 38.15 · 147.1 t/s (estimated)
  { provider: 'gemini', match: 'gemini-flash-latest', intelligence: 71, coding: 60, speed: 34,
    note: 'estimated = Gemini 3.8 Flash (rolling alias at the same price)' },
  // AA II 22.2 · coding 21.15 · 437.8 t/s (estimated)
  { provider: 'gemini', match: 'gemini-flash-lite-latest', intelligence: 39, coding: 33, speed: 100,
    note: 'estimated = Gemini 3.5 Flash-Lite (rolling alias at the same price)' },
  // AA II 40.9 · coding 38.15 · 147.1 t/s
  { provider: 'gemini', match: 'gemini-3.8-flash*', intelligence: 71, coding: 60, speed: 34,
    note: 'cheap capable all-rounder; good bulk edits, summaries, long context' },
  // AA II 39.1 · coding 35.4 · 285.3 t/s
  { provider: 'gemini', match: 'gemini-3.7-flash*', intelligence: 68, coding: 56, speed: 65,
    note: 'cheap and very fast; summaries, light coding; superseded by 3.8 Flash' },
  // AA II 34 · coding 30.25 · 214.7 t/s
  { provider: 'gemini', match: 'gemini-3.6-flash*', intelligence: 59, coding: 48, speed: 49,
    note: 'cheap and fast; superseded by 3.8 Flash' },
  // AA II 22.2 · coding 21.15 · 437.8 t/s
  { provider: 'gemini', match: 'gemini-3.5-flash-lite*', intelligence: 39, coding: 33, speed: 100,
    note: 'fastest and cheapest; classification, extraction, short JSON' },
  // AA II 32.6 · coding 30.25 · 187.9 t/s
  { provider: 'gemini', match: 'gemini-3.5-flash*', intelligence: 57, coding: 48, speed: 43,
    note: 'fast; pricier than newer Flash models' },
  // AA II 15.6 · coding 21.95 · 356.1 t/s
  { provider: 'gemini', match: 'gemini-3.1-flash-lite*', intelligence: 27, coding: 35, speed: 81,
    note: 'very cheap and fast; simple extraction; superseded by 3.5 Flash-Lite' },
  // AA II 26.3 · coding 22 · 204.8 t/s (estimated)
  { provider: 'gemini', match: 'gemini-3-flash*', intelligence: 46, coding: 35, speed: 47,
    note: 'legacy Flash preview (AA index estimated by AA; coding estimated from Terminal-Bench Hard)' },
  // AA II 16.1 · coding 23.15 · 118.4 t/s
  { provider: 'gemini', match: 'gemini-2.5-pro*', intelligence: 28, coding: 37, speed: 27,
    note: 'legacy Pro; long context' },
  // AA II 8.5 · coding 11 · 357.3 t/s (estimated)
  { provider: 'gemini', match: 'gemini-2.5-flash-lite*', intelligence: 15, coding: 17, speed: 82,
    note: 'legacy tiny model (AA index estimated by AA; coding estimated)' },
  // AA II 13.1 · coding 15 · 208.7 t/s (estimated)
  { provider: 'gemini', match: 'gemini-2.5-flash*', intelligence: 23, coding: 24, speed: 48,
    note: 'legacy Flash (AA index estimated by AA; coding estimated)' },
  // AA II 16.7 · coding 20 · 65.4 t/s (estimated)
  { provider: 'gemini', match: 'gemma-4-26b*', intelligence: 29, coding: 32, speed: 15,
    note: 'small open model; not for agentic work (AA index estimated by AA; coding estimated)' },
  // AA II 14.7 · coding 22.75 · 35.5 t/s
  { provider: 'gemini', match: 'gemma-4-31b*', intelligence: 26, coding: 36, speed: 8,
    note: 'small open model; slow, not for agentic work' },
  // AA II 6 · coding 6 · 40 t/s (estimated)
  { provider: 'gemini', match: 'gemma-*', intelligence: 10, coding: 9, speed: 9,
    note: 'older small open model; estimated floor' },
  // AA II 4 · coding 4 · 40 t/s (estimated)
  { provider: 'gemini', match: 'gemini-gemma-*', intelligence: 7, coding: 6, speed: 9,
    note: 'legacy hosted Gemma; estimated floor' },
  // AA II 20 · coding 10 · 100 t/s (estimated)
  { provider: 'gemini', match: 'gemini-robotics*', intelligence: 35, coding: 16, speed: 23,
    note: 'robotics / embodied-reasoning model, not for coding; estimated low so Auto skips it' },
  // AA II 10 · coding 10 · 100 t/s (estimated)
  { provider: 'gemini', match: 'gemini-exp*', intelligence: 17, coding: 16, speed: 23,
    note: 'legacy experimental model; estimated floor' },
  // AA II 5 · coding 5 · 100 t/s (estimated)
  { provider: 'gemini', match: 'learnlm*', intelligence: 9, coding: 8, speed: 23,
    note: 'legacy tutoring model; estimated floor' },
  // ── xAI Grok ──
  // AA II 46.4 · coding 41.6 · 90.8 t/s
  { provider: 'grok', match: 'grok-4.7*', intelligence: 81, coding: 66, speed: 21,
    note: 'strong reasoning at low output price; decent agentic coding' },
  // AA II 44.3 · coding 38.85 · 60.7 t/s
  { provider: 'grok', match: 'grok-4.6*', intelligence: 77, coding: 61, speed: 14,
    note: 'strong reasoning at low output price; superseded by Grok 4.7' },
  // AA II 38.8 · coding 32.8 · 60.4 t/s
  { provider: 'grok', match: 'grok-4.5*', intelligence: 67, coding: 52, speed: 14,
    note: 'general reasoning; superseded by Grok 4.6/4.7' },
  // AA II 40 · coding 36 · 75 t/s (estimated)
  { provider: 'grok', match: 'grok-build-latest', intelligence: 69, coding: 57, speed: 17,
    note: 'estimated from Grok 4.5-4.7 tier (same price and context; rolling coding alias, target unconfirmed)' },
  // AA II 27.2 · coding 25 · 73.6 t/s (estimated)
  { provider: 'grok', match: 'grok-build*', intelligence: 47, coding: 40, speed: 17,
    note: 'coding-tuned, cheap (AA index estimated by AA; coding estimated)' },
  // AA II 14.1 · coding 16 · 150 t/s (estimated)
  { provider: 'grok', match: 'grok-code-fast*', intelligence: 24, coding: 25, speed: 34,
    note: 'legacy fast coding model, now redirected to grok-build-0.1 (estimated)' },
  // AA II 24.9 · coding 24.15 · 111.6 t/s
  { provider: 'grok', match: 'grok-4.3*', intelligence: 43, coding: 38, speed: 25,
    note: 'cheap general model; fine for classification and JSON' },
  // AA II 14.2 · coding 14 · 104.3 t/s (estimated)
  { provider: 'grok', match: 'grok-4.20-non-reasoning*', intelligence: 25, coding: 22, speed: 24,
    note: 'legacy non-reasoning; cheap chat (AA index estimated by AA; coding estimated)' },
  // AA II 14.2 · coding 14 · 104.3 t/s (estimated)
  { provider: 'grok', match: 'grok-4.20-0309-non-reasoning', intelligence: 25, coding: 22, speed: 24,
    note: 'legacy non-reasoning; cheap chat (estimated)' },
  // AA II 14.2 · coding 14 · 104.3 t/s (estimated)
  { provider: 'grok', match: 'grok-4.20-beta-0309-non-reasoning', intelligence: 25, coding: 22, speed: 24,
    note: 'legacy non-reasoning; cheap chat (estimated)' },
  // AA II 14.2 · coding 14 · 104.3 t/s (estimated)
  { provider: 'grok', match: 'grok-4.20-beta-latest-non-reasoning', intelligence: 25, coding: 22, speed: 24,
    note: 'legacy non-reasoning; cheap chat (estimated)' },
  // AA II 14.2 · coding 14 · 104.3 t/s (estimated)
  { provider: 'grok', match: 'grok-4.20-beta-non-reasoning', intelligence: 25, coding: 22, speed: 24,
    note: 'legacy non-reasoning; cheap chat (estimated)' },
  // AA II 14.2 · coding 14 · 104.3 t/s (estimated)
  { provider: 'grok', match: 'grok-4.20-experimental-beta-0304-non-reasoning', intelligence: 25, coding: 22, speed: 24,
    note: 'legacy non-reasoning; cheap chat (estimated)' },
  // AA II 14.2 · coding 14 · 104.3 t/s (estimated)
  { provider: 'grok', match: 'grok-4.20-experimental-beta-non-reasoning-latest', intelligence: 25, coding: 22, speed: 24,
    note: 'legacy non-reasoning; cheap chat (estimated)' },
  // AA II 25.7 · coding 24 · 105.5 t/s (estimated)
  { provider: 'grok', match: 'grok-4.20*', intelligence: 45, coding: 38, speed: 24,
    note: 'legacy reasoning model; superseded by Grok 4.3 (AA index estimated by AA; coding estimated)' },
];
