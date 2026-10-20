# Local decision model (Qwen 2.5 Coder 0.5B) + Laya removal — implementation contract

## Decisions already made (user + measured data — do not redesign)
- **Laya is removed from Ergo entirely:** code, MCP server entry, onboarding step, UI copy, bridge endpoints.
- **New local model:** Qwen 2.5 Coder 0.5B Instruct, GGUF **Q4_K_M** (491,400,064 bytes), run by **llama.cpp `llama-server`** (CPU build, 12–20 MB). It is installed per user under Ergo's storage dir:
  - no system install, no sudo;
  - its own process, bound to **127.0.0.1 only**.
  - Ollama was rejected: its Linux / Windows downloads are 1.4–1.6 GB of GPU libraries.
- **Measured** (40 labelled tasks + the user's related-task answer key; scratchpad `qwen/`):

  | Decision | Qwen 0.5B local | Claude Haiku (tiny cloud) |
  |---|---|---|
  | single deliverable vs split | **90%** | 82% |
  | needs QA verifier | **83%** | 92% |
  | task kind | 48% ✗ | 100% |
  | MCP selection exact | ≤60% ✗ | 88% |
  | related tasks F1 | 0.40 ✗ | 0.70 |

  - Autocomplete via Qwen FIM: median **~100 ms**, usable quality.
- **Hybrid design** (the user chose it):
  - **Local Qwen** handles: (1) the CLI-run **shape decision** — `single` (no worker delegation) and `needsQa` (launch the QA verifier or not); (2) **autocomplete**.
  - **Task kind, MCP selection, related-task selection** stay where they are now: inside the Summary / overview call that already runs on the provider's model. No change there, except removing Laya leftovers.
  - **Fallback order** for every local-model job: local Qwen → the provider's **tiny cloud model** (tier-1 of the active family in `modelRouter.ts`'s CATALOG: claude-haiku-5-5 / haiku / gpt-5-mini / gemini-3.7-flash / grok-3-mini / gemini-3.8-flash-low) → deterministic heuristics (autocomplete: no suggestion). A missing local model must never make a task fail.
  - **"Skip" in onboarding** (and mode `cloud` in Settings): nothing is downloaded, and the tiny cloud model does those jobs. This also covers low-powered / mobile users.
- **In-app pipeline:** its Summary call already outputs `requiresHardener` / straightforwardness in the same call, from a stronger model, so the local shape decision is NOT added there. It is used for CLI runs, which have no triage call before launch.

## Pinned downloads (verify SHA-256 before use; refuse on mismatch)
**llama.cpp build `b11669`**, base URL `https://github.com/ggml-org/llama.cpp/releases/download/b11669/`:

| platform-arch | asset | bytes | sha256 |
|---|---|---|---|
| linux-x64 | llama-b11669-bin-ubuntu-x64.tar.gz | 17851611 | cf07c1c112d709bd67e522017471de57ed0ec8bea031d732c5422351c07f65ac |
| linux-arm64 | llama-b11669-bin-ubuntu-arm64.tar.gz | 13900160 | 9ac6fda2058d35677608a06f751a50122ddfa4ce0ddb7f084466b8e79b6d4a99 |
| darwin-arm64 | llama-b11669-bin-macos-arm64.tar.gz | 12191582 | dbed55493d72bc1ba2babc8770d669c2289b5bc4ee9fb2a4dfc158d45b7d13fd |
| darwin-x64 | llama-b11669-bin-macos-x64.tar.gz | 11677404 | cab28238d78158109b48deb27b05d50e0dcef56275d2e76da9ca8281526c7532 |
| win32-x64 | llama-b11669-bin-win-cpu-x64.zip | 19537886 | 37b3efcf962847ca869745fd4ccf7f5e7e8dacfeff9fa3523b4ca8cdc66d632b |
| win32-arm64 | llama-b11669-bin-win-cpu-arm64.zip | 12442177 | 9cff39ffed17edcd03a7d876073f74d7b48cd43a1e5eafdd59ee094185ad871b |

- **Archive layout:** the Linux archive extracts to `llama-b11669/llama-server` plus `.so` libraries next to it (verified). Other platforms may differ, so locate `llama-server` / `llama-server.exe` after extraction. Keep the libraries next to it. Set an executable bit and macOS quarantine handling as needed (`xattr -dr com.apple.quarantine` best-effort).
- **Model:** `https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF/resolve/ebb2015119c907b064c512bf053e945850b5875f/qwen2.5-coder-0.5b-instruct-q4_k_m.gguf`
  - 491400064 bytes; sha256 `1d9614638d18024d0fbb36575a15f1302a3adf044df10345688ec4f6e1c4ff32` (verified).
  - Pinned to that revision.
- **Install layout:** `<ergo storage root>/.ergo/local-model/` (same base rule as the memory store: if the root's basename is `.ergo` use `<root>/local-model`):
  - `runtime/llama-b11669/…`
  - `models/qwen2.5-coder-0.5b-instruct-q4_k_m.gguf`
  - `install.json` (versions, checksums, installedAt)
- **Downloading:** stream to `*.part`, hash while streaming, rename on success. Resume is optional. Download the runtime and the model sequentially; report byte progress. Unsupported platform → a clear error, and the UI offers cloud mode.
- **Extraction:** use the system `tar` (`tar -xzf`; on Windows 10+, `tar -xf` handles .zip). Extract into a temp dir, then move into place.

## Bridge (vite.config.ts) — RUNTIME implementer
- **Endpoints** (all behind `guardBridgeRequest`, JSON, same style as `/api/memory/*`):
  - `GET /api/local-model/status` → `{ success, state: 'not_installed'|'installing'|'installed'|'starting'|'ready'|'error', phase?: 'runtime'|'model'|'verifying'|'extracting', bytesDone?, bytesTotal?, error?, platformSupported: boolean, sizes: { runtimeBytes, modelBytes }, installDir, version: { runtime: 'b11669', model: 'qwen2.5-coder-0.5b-instruct-q4_k_m' } }`
  - `POST /api/local-model/install` → starts a background install (idempotent: a second call while installing just reports state). On completion the server starts.
  - `POST /api/local-model/cancel` → aborts the install and removes partial files.
  - `POST /api/local-model/uninstall` → stops the server and deletes the install dir.
  - `POST /api/local-model/shape` `{ title, subtasks?: string[] }` → `{ success, single, needsQa, source: 'local', ms }`, or `{ success:false, error }` when not installed / not ready. Two calls to llama-server (`/v1/chat/completions`, temperature 0, `response_format` json_schema, `cache_prompt: true`) with EXACTLY the few-shot prompts below.
  - `POST /api/local-model/complete` `{ prefix, suffix?, maxTokens? (default 24, max 48) }` → `{ success, text, source: 'local', ms }`, via llama-server `/infill`: `{ input_prefix, input_suffix, n_predict, temperature: 0, stop: ["\n"] }`. Trim the result; empty → `text: ''`.
- **Lifecycle:**
  - Start `llama-server -m <gguf> --host 127.0.0.1 --port <free port in 11500-11599> -c 4096 --parallel 2 -t <max(1, min(8, cpus-1))>` lazily on the first request, or at bridge start when installed. Wait for `/health` with a 20 s timeout.
  - Restart once on crash, with crash-loop protection (give up after 3 crashes in 2 min → state `error`).
  - Kill it on bridge exit / SIGINT / SIGTERM (reuse the bridge's existing shutdown hooks).
  - Never bind anything but 127.0.0.1.
  - Per-request timeout 15 s. Serialize starts.
- **Remove all Laya:** `/api/mcp/laya/status`, the `mcp-laya` MCP harness branch, `laya_*` tool lists in the bundled-harness listing, port 8440 references, and anything else (grep -i laya).

## Client — CLIENT implementer (lib + App wiring + Laya removal outside UI components)
- **NEW `src/lib/localModel/client.ts`:** `getLocalModelStatus()`, `installLocalModel()`, `cancelLocalModelInstall()`, `uninstallLocalModel()`, `localShapeDecision(req)`, `localComplete(req)` via `bridgeClient.fetch`. All fail soft (`null` / `{success:false}`).
- **NEW `src/lib/localModel/preference.ts`:** a module-level store `getLocalModelMode(): 'local'|'cloud'|'unset'` / `setLocalModelMode(mode)`. App sets it from settings on load and on change.
- **NEW `src/lib/localModel/decisions.ts`:**
  - `decideRunShape(task, aiConfig, opts?: { signal? }): Promise<{ single: boolean; needsQa: boolean; source: 'local'|'cloud'|'heuristic'; model?: string; ms: number }>`
    - mode `local` → `localShapeDecision`. Any other mode, or local failure → the tiny cloud model.
    - **Cloud:** ONE call through the existing `llmClient` / `callAiEngine` path. It must work for API-key and CLI-subscription profiles; check how autocomplete and other light calls do it. Use the combined prompt below with JSON output and the tier-1 model. Cap it at about 8 s.
    - **Heuristic:** `single` = no subtasks or ≤2 subtasks and not `isExplicitCodeTask` multi-file, or reuse `isStraightforwardTask`-like rules; `needsQa` = coding with ≥4 subtasks.
  - `tinyCloudModelFor(aiConfig)`: export a helper from `modelRouter.ts` returning the tier-1 model id of the active family. The CLI families use the CLI names (haiku, gemini-3.8-flash-low).
- **Autocomplete** (`src/lib/autocompleteService.ts`): when mode is `local`, try `localComplete` first with prefix = surrounding list context plus the current line up to the cursor, and suffix = the rest of the line plus the next line. Keep the existing word / sentence modes and output shape.
  - On failure or empty, fall back to the existing cloud path, whose lightweight model should become `tinyCloudModelFor(aiConfig)` instead of its hard-coded outdated list (`claude-3-5-haiku-20241022` etc.). Keep the explicit overrides (`autocompleteModel`, `roleConfigs.autocomplete`).
- **CLI runs** (`App.tsx` `handleExecuteTask` CLI branch → `useCliAgentRuns.launchCliRun`):
  - Before launch (after the related-task step, in parallel with overview generation where possible), call `decideRunShape`.
  - Pass `qaEnabled = brief.qaVerification === true` (the task menu's QA switch, off by default; superseded `enableHardener && needsQa` on 2026-10-20) and `maxWorkers = single ? 1 : configured`.
  - The manager prompt already says "do it yourself, no delegate.json" when maxWorkers < 2.
  - Record the decision visibly: add one line to the manager step's detail, e.g. `Run plan: single deliverable · QA verifier skipped — decided locally by Qwen 0.5B (110 ms)`, or `… by claude-haiku-5-5` / `… by heuristics`.
  - `LaunchCliRunParams` gets optional `qaEnabled` / `maxWorkers` overrides; they default to the current option-based values.
- **Settings:** `AppSettings.localModel?: { mode: 'local' | 'cloud' }`. Load and persist through the existing settings flow, and call `setLocalModelMode`.
  - App passes to OnboardingModal and SettingsModal: `localModelMode`, `onSetLocalModelMode(mode)`.
  - It also passes `tinyCloudModelLabel` (e.g. "Claude Haiku", or the tier-1 id), so the UI can say what Skip uses.
- **Remove Laya everywhere outside the UI components:**
  - delete `src/lib/layaClient.ts`;
  - `modelRouter.ts`: remove the Laya pick and keep effort tiers. Update the comments and the `blurb` "shown to Laya" wording;
  - `demoData.ts`: remove the `mcp-laya` server;
  - `mcpClient.ts`;
  - `summary.ts` (leftover comment OK);
  - `App.tsx`;
  - `docs/FUTURE_FEATURES.md` mentions — leave docs/wip alone.
  - Migration: filter `mcp-laya` out of any persisted MCP server list on load, so existing users lose it cleanly.

## UI — UI implementer (components + CSS)
- **`OnboardingModal.tsx`:** replace "STEP 2: Optional Laya Engine Download Screen" (and its state `showLayaTerminal`, `layaInstallDone`, `proceedToLayaStep` naming → `proceedToLocalModelStep`) with **"Local AI model"**:
  - **Explains:** Qwen 2.5 Coder 0.5B runs privately on this computer for small background decisions and autocomplete; the download is ~510 MB (show exact `sizes` from status), stays in Ergo's folder, and needs no admin rights.
  - **"Download & install":** calls `installLocalModel()` and polls status every 500 ms. Shows a phase label, a progress bar with MB done / total, and "Cancel". On `ready`, show a success state and set mode `local`.
  - **"Skip — use {tinyCloudModelLabel} instead":** nothing is downloaded; set mode `cloud`; note one line "You can install it later in Settings."
  - **Errors:** a clear message plus "Use {tinyCloudModelLabel} instead". Unsupported platform → the same.
  - Continue to the next onboarding step either way. Match the existing modal's styling.
- **`SettingsModal.tsx`:** a "Local AI model" section:
  - status (Installed · ready / Not installed / Installing x%);
  - a mode toggle (Local model / Cloud — {label}); "Local" is disabled until installed;
  - Install / Uninstall buttons with confirmation for uninstall;
  - one line on what it's used for.
- **Remove Laya UI:** `McpHubModal.tsx` (its Laya test), `ExecutionSettingsBar.tsx` copy, any Laya badges / labels (grep -i laya in src/components).
- `src/index.css` for new styles (light + dark).

## Rules
- Three implementers work concurrently on DISJOINT files (ownership above). Code against these signatures.
- No git state changes. Don't npm-install new deps.
- Type-check both configs and run `npm run build`; the browser bundle must not include node-only code.
- Never touch the user's real `~/.ergo/local-model` in tests: use a scratch storage root.
- Final report: what changed (file:line ranges), deviations, tests, risks.

## Prompts (exact; from the evaluation — scratchpad qwen/qeval2.py round 2)
**Local split (`single`)** — system: `Decide if a to-do item is one small, self-contained job (single=true) or a bigger job with several distinct parts (single=false). Reply with JSON.`
- Few-shot pairs (user → assistant JSON):
  - "Fix the typo in the footer" → {"single": true}
  - "Build user accounts | Subtasks: sign-up; login; password reset; profile page" → {"single": false}
  - "Write a short release announcement" → {"single": true}
  - "Migrate the app to the new payment provider | Subtasks: API client; webhooks; data migration; remove old SDK" → {"single": false}
- Query text: `<title>` plus ` | Subtasks: a; b; c` when there are subtasks. Schema: `{single: boolean}`.

**Local QA (`needsQa`)** — system: `Decide if a coding change is risky or broad enough that an independent reviewer should test it (needs_qa=true), or a small contained change (needs_qa=false). Reply with JSON.`
- Few-shot pairs:
  - "Change the button color on the settings page" → {"needs_qa": false}
  - "Rewrite the authentication system to use OAuth | Subtasks: providers; token storage; migrate sessions" → {"needs_qa": true}
  - "Add a tooltip to the export icon" → {"needs_qa": false}
  - "Move all data from SQLite to Postgres with a migration script" → {"needs_qa": true}
- Schema: `{needs_qa: boolean}`.
- Only ask it for tasks that aren't clearly non-coding. When the client already knows the task kind (e.g. `isExplicitCodeTask` is false and there are no code signals), it may pass `kindHint` and the bridge may skip the QA question (`needsQa: false`).

**Cloud combined (tiny model)** — system: `You triage a task from a software project's to-do list. Decide: single — true if it is one focused deliverable one person finishes in a single pass; false if it has several distinct parts better split up. needs_qa — true only for coding changes that span several parts of a codebase or carry risk (architecture, data migration, security/permissions, new subsystems); false otherwise. Reply with JSON {"single": boolean, "needs_qa": boolean}.`
- User: `Task:\n<title>\nSubtasks:\n- …`
