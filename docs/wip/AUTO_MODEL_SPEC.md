# Auto model selection — implementation contract

## What the user asked for
- **Auto** (the default) picks each stage's model per task from: the active profile provider's *available* models, each model's strengths, live prices, and the task's type and complexity. It overrides the per-stage models in the AI profile.
- **Manual** runs exactly the per-stage models set in the AI profile's advanced settings ("Execution Agents (7 Roles)" in AiCredentialsModal).
- **The user's decisions:**
  1. Strengths come from a built-in table, replaced by live Artificial Analysis (AA) scores when the user adds a free AA key. Prices are always live (LiteLLM's public JSON, no key).
  2. The tiny model *rates* the task; deterministic code *picks* the models.
  3. In Auto, Effort is a quality-vs-cost dial (and still sets reasoning depth). In Manual it only sets reasoning depth.
  4. The rating is produced *inside the overview call* (no extra call) and saved with the overview, so reruns cost nothing.

## Shared files (already written)
- `src/lib/modelCatalog/types.ts` — `CatalogModel`, `ModelCatalog`, request/response types.
- `src/lib/modelCatalog/builtinStrengths.ts` — `BuiltinStrength` table. The research agent fills it in; the code must work while it is empty.

## Bridge — `POST /api/models/catalog` (vite.config.ts, own plugin)
- **Request:** body `ModelCatalogRequest`. Response: `ModelCatalogResponse`. Guarded with `guardBridgeRequest`; non-POST → 405.
- **Prices:**
  - Source: `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`.
  - Keep `mode === "chat"` entries for `litellm_provider` `anthropic` → `anthropic`, `openai` → `openai`, `gemini` → `gemini` (key prefix `gemini/` stripped), and `xai` → `grok` (prefix `xai/` stripped).
  - Drop keys containing `/` after stripping, and fine-tune / batch / realtime / audio / image / tts / embedding / search-preview variants.
  - Field mapping:

    | CatalogModel field | LiteLLM field |
    |---|---|
    | `inputPerM` | `input_cost_per_token × 1e6` |
    | `outputPerM` | `output_cost_per_token × 1e6` |
    | `contextTokens` | `max_input_tokens` |
    | `supportsTools` | `supports_function_calling` |
    | `supportsReasoning` | `supports_reasoning` |
    | `deprecationDate` | `deprecation_date` |

  - Drop entries without both prices.
- **Benchmarks** (only when a key is given):
  - Call `GET https://artificialanalysis.ai/api/v2/data/llms/models` with header `x-api-key`.
  - Match each AA model to catalog ids by normalized name and slug. Normalize: lowercase, map `.` → `-`, strip the creator prefix, then compare token sets, so that `claude-5-5-opus` ≈ `claude-opus-5-5`. Require all numeric version tokens to match.
  - Attach `benchmarks` to matched models.
  - Never log or persist the key.
- **Cache** under `<storage>/.ergo/model-catalog/`:
  - `prices.json`: the normalized models + `fetchedAt`. Fresh for 12 h.
  - `benchmarks.json`: normalized AA rows + `fetchedAt`, stored without the key. Fresh for 24 h; the free tier allows 1,000 requests/day.
  - Stale-while-revalidate: serve the cache and refresh in the background; concurrent requests share one fetch. `refresh: true` bypasses the age check at most once per 5 min.
  - Fetch timeout 10 s, max body 20 MB.
- **Fallback for prices:** network → stale cache (`litellm-cache`) → bundled snapshot `src/lib/modelCatalog/priceSnapshot.ts` (`export const PRICE_SNAPSHOT: ModelCatalog`; a .ts module so no tsconfig JSON-import change is needed) (`snapshot`). AA failure: `benchmarks: 'none'` + `benchmarksError` (e.g. "Artificial Analysis rejected the key (401)"), or the stale AA cache (`artificial-analysis-cache`).
- **Snapshot:** `scripts/update-model-snapshot.mjs` writes `priceSnapshot.ts` (a `ModelCatalog` with `sources.prices: 'snapshot'`, no benchmarks) using the same normalization. Generate it once now.

## Client
### Catalog — `src/lib/modelCatalog/catalog.ts`
- `getModelCatalog({ artificialAnalysisKey?, refresh?, signal? })` → `ModelCatalog`. The in-memory cache lasts 10 min.
- If the bridge is unreachable, it returns the bundled `PRICE_SNAPSHOT`. Never throws.

### Availability — `availableModelsFor(target, catalog)`
Returns the candidate models for one role target:
- **API-key profiles (anthropic / openai / gemini / grok):**
  - Start from the catalog models of that provider. Require `supportsTools` and no `deprecationDate` in the past.
  - Intersect with the provider's model list (existing `fetchAnthropicModels` / `fetchOpenAIModels` / `fetchGeminiModels` / `fetchGrokModels`, cached 1 h per provider+key). If listing fails, skip the intersection.
  - Collapse dated duplicates, preferring the undated alias.
- **Claude Code CLI:**
  - Candidates are the aliases `haiku`, `sonnet` and `opus`. Each is priced and scored as the newest catalog model matching `claude-haiku-*` / `claude-sonnet-*` / `claude-opus-*`.
  - Add the newest `claude-fable-*` id, passed as a full id.
- **Antigravity CLI (`agy`):**
  - `agy models` ids (existing `/api/cli/models?cli=agy`), each mapped to its base catalog model with the thinking suffix removed (`gemini-3.8-flash-high` → `gemini-3.8-flash`).
  - Prefer the `-high` variant when the stage's effort is high or above.
- **Codex CLI:** the newest-generation OpenAI catalog models (same family prefix as the newest `gpt-*` id).
- **Ollama, Cursor, custom CLIs and unknown providers:** none. Auto behaves like Manual for them, and the routing step says so.

### Task rating
- **Type:** `TaskRating { kind: TaskKind; complexity: 1|2|3|4|5; reasoning: 1|2|3|4|5; source: 'overview' | 'tiny' | 'heuristic' }`, saved as `OverviewDocument.taskRating`.
- **Overview call (CLI path):** `syncTaskOverviewWithAi` in `src/lib/ai.ts`.
  - The system prompt asks for one extra final line: `TASK_RATING: kind=<coding|writing|research|ops|data|other>; complexity=<1-5>; reasoning=<1-5>`.
  - Include a short scale for each number:
    - **complexity:** 1 = trivial one-liner, 3 = a feature touching a few files, 5 = large multi-part / architectural.
    - **reasoning:** 1 = mechanical, 5 = hard design / debugging.
  - Strip and parse the line like the `RELATED_TASK_IDS` line. Return `taskRating` (undefined when missing or invalid).
- **Pipeline summary** (`src/lib/agentPipeline/summary.ts`): add `taskRating` to its JSON output schema and save it on the overview doc.
- **Auto mode overview model:** the overview / summary call runs on the tiny cloud model, via `tinyCloudCallConfig(aiConfig)`, falling back to `aiConfig` when that returns null.
- **When there is no rating** (a reused overview saved before this feature, a user-written overview, or a parse failure), `rateTask(task, aiConfig, { signal })` in `src/lib/agentPipeline/taskRating.ts` provides one:
  - One tiny-model JSON call with an 8 s cap.
  - Failing that, a heuristic based on subtask count, title length and code keywords (reuse `explicit_code`-style regexes from `localModel/decisions.ts` if present).
  - Save the result to the brief's `overviewDocument.taskRating`, so it is asked once.

### Auto router — `src/lib/agentPipeline/autoRouter.ts`
- **Model quality per axis** (`intelligence`, `coding`, 0–100):
  1. AA benchmarks if present, rescaled so the catalog's best AA score on that axis = 100.
  2. Otherwise the first `BUILTIN_STRENGTHS` match for the id, or for the alias's resolved id.
  3. Otherwise an estimate. Interpolate log(blended price) against the provider's scored models, clamped to the provider's scored range ± 10. With no scored model for that provider, use 50.

  Blended price = (3·input + output) / 4.
- **Stage needs** (axis = `coding` when `rating.kind === 'coding'`, else `intelligence`; c = complexity, r = reasoning):

  | Stage | Axis | Need |
  |---|---|---|
  | manager | axis | 40 + 12·(max(c, r) − 1) |
  | worker | axis | 35 + 12·(c − 1) |
  | hardener (QA) | coding | 45 + 10·(c − 1) |
  | cleaner, logger, summary | intelligence | 30 |

- **Effort offset:** low −10, medium 0, high +8, xhigh +16, max = "best available" (highest quality on the axis, ties → cheaper).
- **Pick:** the cheapest model (by blended price) with quality ≥ need + offset. Ties go to higher quality, then higher speed. If none qualifies, take the highest-quality model.
- **Effort** per role still comes from `effortForRole`.
- **Decision record:** `{ role, model, effort, via: 'auto', reason }`. The reason reads like "coding 82 ≥ 76 needed · $4.00/$20.00 per M · cheapest that qualifies" (or "strongest available" / "best available (Max effort)"). Also record the scores' source: `aa`, `builtin` or `estimated`.

### `modelRouter.ts`
- Replace `autoModelRouting: boolean` with `mode: 'auto' | 'manual'` in `routeModelsForRun`, and add an optional `rating`.
- **Manual:** profile models (pinned) with the effort filled in. A role without a model uses the provider default (`via: 'provider-default'`).
- **Auto:** autoRouter for every requested role. Roles the router can't serve (no candidates) fall back to the manual behaviour, with `via: 'pinned' | 'provider-default'` and a note.
- **Effort-tier routing (`ROLE_TIER_BY_EFFORT`) goes away.**
  - Keep a small static tiny-model table for `tinyCloudModelFor`, with ids updated per the research agent's recommendation.
  - Remove the stale tier data that's no longer used.
- `describeRouting` shows the mode, the rating ("coding · complexity 3/5 · reasoning 4/5 (from overview)"), each role's model · effort · reason, and the price / benchmark source. Include "Benchmarks: Artificial Analysis" when AA was used.

### Run flows
- **CLI path** (`src/App.tsx`, the CLI task run around `syncTaskOverviewWithAi` and `prepareCliLaunch`):
  - Auto: run the overview on the tiny model; get the rating (from the overview, the saved doc, or `rateTask`); pass it to `prepareCliLaunch`, which routes manager / worker / hardener with mode + rating.
  - Manual: routing uses profile models. `decision.model` is passed to the CLI as today. Today's code passes `undefined` for pinned models; in Manual, pass the pinned model so the CLI actually uses the profile's choice. Pins that are not valid for the CLI family stay undefined (CLI default).
- **In-app pipeline** (`src/lib/agentPipeline/index.ts`):
  - Auto: route `summary` (tiny) first, run `runSummary`, then route manager / worker / cleaner / hardener / logger with the rating.
  - Manual: route all roles up front, as today.
  - Emit one "Model routing" step after the second routing (update the same step id).

### Settings and types
- **Pipeline options:** `AgentPipelineOptions.modelSelection: 'auto' | 'manual'` replaces `autoModelRouting`.
  - Default `'auto'` (contracts.ts defaults).
  - Settings migration in App.tsx `normalizePipelineOptions` or equivalent: `autoModelRouting === false` → `'manual'`, otherwise `'auto'`.
- **Secrets:** `AppSecrets.modelData?: { artificialAnalysisKey?: string }` in config/secrets.json, next to the other API keys. The legacy `AppSettings.modelData` is read once to migrate it.
- **ExecutionSettingsBar:** replace the "Pick a model per stage" checkbox with a two-option segmented control **Models: Auto | Manual**, with one line of detail each:
  - Auto: "Picks each stage's model for the task from your provider's models, live prices and model strengths. Effort sets the quality/cost balance."
  - Manual: "Uses the models set per stage in your AI profile. Effort sets reasoning depth."
  - Update `EFFORT_DETAIL` copy to match both modes.
- **SettingsModal:** new "Model data" section.
  - Optional AA key field (password input, show/hide), a "Check" button that refreshes the catalog and reports "Matched N models" or the error, the price source and age, and the attribution link "Benchmark data: Artificial Analysis" (required by their terms).
  - Without a key: "Using built-in strengths (as of <date>) and live prices."
- **AiCredentialsModal:** add one line in the per-role section: "Used when Models is set to Manual. In Auto, Ergo picks these per task."

## Out of scope
- Picking across several providers in one profile.
- Prices for subscriptions. CLI subscription users get relative cost as a proxy for usage-limit burn, so say "relative cost" in their routing step.

## Revision 2 (2026-10-16): tiers, per-stage effort, escalation
The user pushed back on the score-threshold picker: it chose models that were too weak. It has been replaced.

- **Tier ladder** (`buildTierLadder`): the provider's lineup on the stage's axis, with dominated models dropped.
  - Top: the strongest model.
  - Standard: the cheapest model within 5 points of top.
  - Light: the cheapest model scoring at least 60.
- **Stage plan** (`basePlan`): the tier comes from scope, the effort from difficulty (`rating.reasoning`). At Medium, for coding:

  | Task | Manager | Workers | QA |
  |---|---|---|---|
  | c1 | standard | light | standard |
  | c2–3 | standard | standard | standard |
  | c4 or r ≥ 4 | top | standard | top |
  | c5 | top | top | top |

  - **Floors:** the manager and QA never go below standard for coding; workers never go below standard from c3 up.
  - **Effort by reasoning** (manager / QA): low, medium, medium, high, xhigh. Workers run one step lower. QA for coding runs at least at medium.
- **Slider:**
  - Low: −1 tier (down to the floors) and −1 effort.
  - High: +1 tier for manager and QA, +1 effort.
  - Extra High: +1 tier for everyone, +2 effort.
  - Max: top tier at max effort.
  - Bookkeeping stays light at low/medium effort.
- **Collapsed top:** when top is the same model as standard, top tier adds one effort step.
- **Escalation** (`escalation.ts`), for the manager and workers only:
  - Each step moves up one tier, or adds one effort step once at the top tier.
  - **QA retry:** in the pipeline, the manager and workers are re-routed. In CLI runs, the precomputed `launch.retryRoles` are used: new workers pick them up, and a Claude Code manager is switched with `/model`.
  - **Rerun after a qa_failed, failed or stopped run:** start one step higher (at most 2), based on `brief.lastRunOutcome`.
  - **Manual:** keeps the profile's models and raises effort instead.
- **Run record:** `AgentContextItem.lastRunOutcome` (`RunOutcomeRecord`) stores the outcome, escalation, QA retries, rating and the models / efforts used.

## Revision 3 (2026-10-20): "How did this task do?" surveys and cheaper tries

- **Survey** (`calibration.ts` `surveyReason`, decided when `recordRunCalibration` stores a run): the task card (`RunSurveyCard`) asks for a Good or Bad answer after an Auto run (a stage with a `tier`) that passed, completed or got no QA verdict. The user mustn't have judged the run already, in a steering message or an earlier answer. Reasons:
  - `no_verdict`: QA was unverified.
  - `thin`: a manager or worker setting has fewer than 3 weighted results for this group (`MIN_RUNS_UP`).
  - `cheaper`: a stage started a rung down (`calibrated: -1`) and that setting has fewer than 3 answers.
- **Answer** (`CalibrationRun.verdict`): replaces the automatic verdict and counts double (`CONFIRMED_WEIGHT`).
  - Bad blames the end models, and QA if it passed the work.
  - Starting models that a QA retry stepped up from still count as failures.
  - Closing the survey with × sets `survey.dismissed`.
- **Cheaper try** (`PROBE_*` in `calibrationAdjustment`): the user approved this, and it replaces the old "never experiments" rule.
  - Conditions: manager or workers only, at most one stage per run (`modelRouter` `probed`), on about 25% of the runs where the other conditions hold. The planned rung's Wilson lower bound must be ≥ 0.7. The cheaper rung must have fewer than 5 weighted results and a success estimate ≥ 0.5.
  - Never with escalation > 0, never at Max, never below the floors.
- **Plumbing:** `RoutingDecision.calibrated` → `RunStageModel.calibrated` (`lastRunOutcome.models` / `startModels`, and the CLI launch roles, which now also carry `tier`) → `CalibrationStage.calibrated`.
