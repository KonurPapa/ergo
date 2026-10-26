# Learned project rules: Mem0 vs in-house (2026-10-26)

Question: should Ergo learn from the user's corrections with Mem0, or with its own memory store?

**Answer: use the in-house store.**

## Setup

- **Scenario:** 23 task follow-ups across two synthetic projects (Ledgerly: React and TS; Inkwell: Astro blog). The follow-ups include:
  - durable rules;
  - repeats of a rule;
  - superseded rules (pnpm → bun; "don't commit" → "commit once per task, never push");
  - one-off tweaks that should not be stored, and approvals;
  - a rule that is opposite in each project (pnpm in one, npm in the other).
- **Probes:** 7 upcoming tasks, each with the rules it needs. Rules that apply to every task count as needed for every probe.
- **Same models for both routes:**
  - LLM: Claude Haiku through `claude -p`.
  - Embedder: all-MiniLM-L6-v2, the same as the bridge.
  - Mem0 reaches both through an OpenAI-compatible shim inside `harness.mjs`.
- **Routes:**
  - `mem0`: Mem0 OSS 3.3.1, out of the box.
  - `mem0custom`: Mem0 with `customInstructions` written for this use case.
  - `ergo`: one call per follow-up. The call sees the project's whole lesson list (when it has at most 40 lessons) and returns add, update, delete or confirm operations. A zero-token guard turns an add into a confirm when the new lesson is within cosine 0.9 of an existing one.
- **Judging:** Sonnet labels each stored memory with the gold rule it states, and whether it is stale or noise (`judge.mjs`). I spot-checked the labels by hand.
- **Reps:** 2 per route.

Re-run: run `npm i mem0ai@3.3.1 better-sqlite3@12 natural@8 compromise@14` in a scratch folder. Then run `node harness.mjs <ergo|mem0|mem0custom> <rep>` followed by `node judge.mjs`.

## Results (mean of 2 reps)

**What ends up in the store** (both projects, 14 gold rules in total):

| Route | Size | Gold rules covered | Stale | Noise | Duplicates | $ per write | Input tokens per write | Seconds per write |
|---|---|---|---|---|---|---|---|---|
| ergo | 15 | 14 / 14 | 0 | 0 | 1 | 0.0005 | 1.8k | 3.4 |
| mem0 | 48 | 14 / 14 | 8.5 | 14.5 | 14 | 0.0013 | 14.2k | 7.4 |
| mem0custom | 20.5 | 13 / 14 | 4 | 0 | 4.5 | 0.0011 | 14.2k | 4.8 |

**What a task gets back** (K = 8, averaged per probe; recall counts the rules that apply to every task):

| Route / retrieval | Recall | Stale hits | Noise hits | Tokens |
|---|---|---|---|---|
| ergo, whole lesson list (11 or 4 rules) | **1.00** | 0 | 0 | ~290 |
| ergo, every-task rules + top-5 topical, no floor | 0.95 | 0 | 0 | ~218 |
| ergo, plain similarity top-8 | 0.84 | 0 | 0 | ~218 |
| ergo, every-task rules + topical with a 0.2 floor | 0.75 | 0 | 0 | ~112 |
| mem0, threshold off | 0.58 | 0.9 | 2.9 | ~400 |
| mem0custom, threshold off | 0.69 | 1.1 | 0 | ~220 |

The 0.2 floor is too high for MiniLM: short task titles score 0.1–0.2 against the rules they need.

## Why Mem0 loses

1. **Mem0 3.x only ever adds.** Its prompt's "sole operation is ADD". A contradiction is only linked to the old memory, never resolved. After the pnpm → bun switch, Mem0 stores both rules, and both come back in the same search. The same happens with "never commit" next to "commit once per task".
2. **Its prompt is built for chat-assistant memory.** It is told to capture "every piece of memorable information", so out of the box it stored a narrative of every task ("On 2026-10-26 the assistant completed…"). `customInstructions` removes that noise but cannot fix point 1.
3. **Every write costs about 8 times the input tokens**, because its 34 KB extraction prompt is sent each time.
4. **It is a poor fit for packaging.** It needs the native module `better-sqlite3` in the bridge and desktop builds, and its telemetry (to PostHog) is on unless `MEM0_TELEMETRY=false`.

Reconciling at write time keeps the list small. That is the main design gain: a small, clean list can simply be injected whole, so the related-tasks step needs no retrieval tuning for rules.

Mem0's hybrid search (BM25 plus entity boost) did not make up the difference.

## Shipped implementation (2026-10-26)

The code in `src/lib/memory/insights.ts` and `memoryStore.ts` (namespace `insights`) was tested in two ways.

**`store-test.mts`** runs the real store with MiniLM in a temp folder. 21 of 21 checks pass:
- the duplicate guard;
- update, delete and undo (text, confirm counts and vectors all restored);
- isolation between projects;
- purging a task's memory or clearing a project's memory keeps the rules;
- agent searches skip the rules;
- the read path (whole list up to 25 rules, otherwise the every-task rules plus the 6 nearest topical ones);
- the rules survive a reload.

**`e2e.mts`** replays the scenario above through the shipped prompt, parser, store and read path. `bundle.mjs` builds `insights.ts` for Node; `env.mjs` stubs the browser globals it needs.

| Run | Size | Gold rules covered | Stale | Noise | Recall per task | Rule block | $ per message |
|---|---|---|---|---|---|---|---|
| ergoprod-1 | 14 | 14 / 14 | 0 | 0 | 1.00 | ~290 tokens | 0.0005 |
| ergoprod-2 | 15 | 14 / 14 | 0 | 0 | 1.00 | ~300 tokens | 0.0006 |

**A bug this caught.** The first production run showed rules as `[insight:<project>:<id>]`. Haiku echoed those ids without the prefix, so every update and confirm was dropped, and 4 stale rules survived. The prompt now labels rules `R1`, `R2`, … and maps them back to real ids.

The Sonnet judge had the same problem with long ids, so `judge.mjs` matches labels on the id suffix.

## Limits

- The data is synthetic, there are only 2 reps, and Haiku was the only LLM tested.
- Mem0's default LLM (gpt-5-mini) was not tested.
- At 50 or more rules per project, the whole-list read would need the "every-task rules + top-5 topical" read instead (0.95 recall here).
