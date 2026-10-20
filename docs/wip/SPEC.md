# Ergo task-run fix — implementation spec (shared contract)

Diagnosis files (READ the ones relevant to you; they contain verified file:line root causes and real PTY findings):
`/tmp/claude-1000/-home-konur-Documents-Ergo/e1fe1b28-ceb0-46bf-8fec-0def960702cc/scratchpad/diag-*.md`
(overview, approvals, approval-prompt-text, completion-log, per-agent-terminals, architecture).
Real Claude Code 2.1.296 PTY captures from the investigation are in the same scratchpad dir
(`claude_raw.txt`, `claude_chunks.json`, plus codex/gemini chunk files) — use them as test fixtures.

## User-reported problems (all must be fixed)
1. Overview card doesn't populate on task start.
2. Command approvals too frequent, even on "Full access" (should need none). Switching approval mode mid-task must take effect immediately.
3. Approval pop-up doesn't show WHAT command/tool it is asking about.
4. Completion logs are not piped from the embedded CLI terminal into the Completion Log card.
5. Actions card doesn't say which agent is running. Each agent (manager, workers, QA verifier) gets its own embedded terminal in the Steps view. Notes view shows the manager first, then the workers while the manager waits on them, then QA (if the task has QA) — always clearly labelled, never silently switching from one agent's CLI to another.

## Architecture decisions (fixed — do not redesign)
- **App owns agent PTY lifecycle.** App launches every agent via `POST /api/pty/spawn` (see `src/lib/cliRunClient.ts`, already written). Terminal views (AgentTerminal in Steps, CliAgentNotesBridge in Notes) only ATTACH by `sessionId = SpawnedSession.ptySessionId`. The legacy WS `spawn` message stays supported (login/onboarding modals use it) but task runs don't use it.
- **One PTY per agent.** Session ids: `${taskId}::manager`, `${taskId}::worker::${pieceId}`, `${taskId}::qa` (`agentSessionId()` in cliRunClient). All agents of one run share a `runId` (`${taskId}-${Date.now().toString(36)}`).
- **The bridge (server) is the source of truth for prompts.** It keeps a VT screen per session (rendered screen, not the stripped byte log), detects prompts on the rendered rows, auto-approves when the session's permission level is `bypass`, applies live permission changes, and watches signal files. It reports everything on WS (to attached views) and on a global SSE stream `/api/pty/events` (to App).
- **File-based signals, not stdout sentinels.** Agents write milestone files into `<cwd>/.ergo/runs/<runId>/` (the bridge creates the dir and a `.ergo/.gitignore` containing `*`). The bridge polls them. Formats:
  - manager → `delegate.json`: `{"workers":[{"id":"W1","title":"…","instructions":"…","files":["src/a.ts"]}]}` → signal `delegate`
  - manager → `completion.md`: markdown with sections `**Completed Work & Created Files:**`, `**Verification:**`, `**Human Review Required:**` → signal `complete` (may be rewritten after a QA FAIL → a new signal each time mtime changes)
  - worker → `worker-<pieceId>.md`: what it did / files touched / anything left → signal `worker-done`
  - qa → `qa.md`: first non-empty line `VERDICT: PASS` or `VERDICT: FAIL`, then findings → signal `qa-verdict` with `verdict`
- Workers are real CLI processes (same CLI as manager), orchestrated by App from the manager's `delegate.json`. The manager may skip delegation for small tasks.

## Shared contracts (already in the tree — use, don't change without need)
- `src/types/index.ts`: `AgentSessionRole`, `AgentSessionStatus`, `CliPromptOption`, `CliDetectedPrompt`, extended `SpawnedSession` (role, label, pieceId, ptySessionId, runId, status, permissionLevel, pendingPrompt, endedAt), `ExecutionStep.ptySessionId`, `AgentContextItem.completionRunId`.
- `src/lib/cliRunClient.ts`: REST/SSE client + `CliAgentEvent` union + `agentSessionId()` + `runDirRel()`. Bridge MUST implement exactly these shapes.
- `src/lib/overviewUtils.ts`: `isPlaceholderOverview(text, task)` / `isRealOverviewText(text, task)`.

## New shared modules (owned by the BRIDGE implementer; others import these exact signatures)
`src/lib/cliScreen.ts` — dependency-free (no DOM, no node imports; runs in browser AND in vite.config.ts):
```ts
export function stripAnsi(str: string): string;               // moved from CliAgentNotesBridge (same behaviour)
export class TerminalScreen {
  constructor(cols?: number /*120*/, rows?: number /*40*/, scrollback?: number /*2000*/);
  readonly cols: number; readonly rows: number;
  write(data: string): void;                                    // VT reducer: CR/LF/BS/TAB, CUP/HVP, CUU/CUD/CUF/CUB, CHA/HPA, VPA, CNL/CPL, EL, ED, ECH, DCH, ICH, IL, DL, SU/SD, DECSTBM, save/restore cursor (ESC7/8, CSI s/u), ?1049h/l ?47 ?1047 alt screen, SGR ignored, OSC/DCS/APC skipped, UTF-8 wide chars (emoji/CJK = 2 cols) best-effort, chunk boundaries in the middle of an escape sequence handled
  resize(cols: number, rows: number): void;
  visibleRows(): string[];                                      // right-trimmed rows of the active screen
  tailRows(n: number): string[];                                // last n rows of scrollback+visible (main screen) or visible (alt screen)
  isAltScreen(): boolean;
}
export class ScreenTranscript {                                 // ordered, de-duplicated history of rendered rows (TUI repaints collapse)
  constructor(maxLines?: number /*4000*/);
  observe(rows: string[]): void;
  lines(): string[];
  tail(n: number): string[];
}
```
`src/lib/cliPromptParser.ts` — dependency-free:
```ts
export function unframe(line: string): string;                  // strips │┃║▌▎|╭╮╰╯╔╗╚╝ edges
export function parseCliScreenPrompt(rows: string[], opts?: { echoedText?: string }): CliDetectedPrompt | null;
export function keystrokesForOption(prompt: CliDetectedPrompt, option: CliPromptOption): string;
export function pickApproveOption(prompt: CliDetectedPrompt): CliPromptOption | null; // plain "Yes"/"Allow once" style; never "No"; prefers once-only over "don't ask again"
export function isBypassAcceptanceDialog(prompt: CliDetectedPrompt): boolean;        // Claude's "Bypass Permissions mode … Yes, I accept" — never auto-answered
export function promptSummary(prompt: CliDetectedPrompt): string; // targetCommand || toolLabel+detail || question, one line, ≤200 chars
```

## Bridge protocol (vite.config.ts, ergo-pty plugin) — BRIDGE implementer
REST (all behind `guardBridgeRequest`):
- `POST /api/pty/spawn` body = `SpawnAgentRequest` → `SpawnAgentResponse`. Kills an existing session with the same id first (remember as ended). Creates run dir + `.ergo/.gitignore` (`*`). Spawns PTY (keep existing claude `syncClaudeConfig` + `--settings` handling and the agy flag cleanup — factor the spawn code into one function shared with the WS spawn path). Broadcasts SSE `spawned`.
- `POST /api/pty/input {sessionId, data}` → writes to PTY.
- `POST /api/pty/kill` `{sessionId}` kills exactly that session; `{taskId}` (no sessionId) kills EVERY session whose `String(taskId)` matches (plus a legacy session keyed by the bare taskId). Ended sessions keep meta (incl. exitCode, role, label, runId, buffer) in `endedPtySessions`; raise that cap to ~100.
- `POST /api/pty/policy {permissionLevel, sessionId? | taskId? | all?}` → `{success, results: PolicyResult[]}`; also SSE `policy` per session.
- `GET /api/pty/transcript?sessionId=` → `AgentTranscript`. finalMessage readers: Claude (last assistant text blocks from `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`, same discovery as readClaudeSessionUsage), Codex (last `agent_message` / assistant `output_text` in the rollout chosen like readCodexSessionUsage), Gemini (last `gemini`/`model` message). Fallback `transcript`: last assistant-looking block from ScreenTranscript; else `none`. All fail soft.
- `GET /api/pty/sessions` → add `role, label, pieceId, runId, spawnId, permissionLevel, prompt, signals` (see `BridgeAgentSessionInfo`). Include ended sessions that still have meta? → No: active only (as today), but ended sessions must remain attachable/replayable via WS attach.
- `GET /api/pty/events` → SSE (`text/event-stream`, same style/CORS as `/api/files/events`), first message `{"type":"connected"}`, then `CliAgentEvent` JSON per `data:` line; heartbeat comment every 20s.
WebSocket `/api/pty`:
- NEW `{type:'attach', sessionId, cols?, rows?, observe?: boolean}`: subscribe; reply `ready`, `replay` (buffer), current `{type:'prompt', prompt}` if any, and `exit` if ended (works for sessions in endedPtySessions too, replaying their buffer and real exit code). `observe: true` (Notes view) never resizes the PTY. Non-observe attach resizes PTY + VT screen.
- Existing `spawn` (legacy, login modals): key = `msg.sessionId || msg.taskId || 'default'` (sessionId wins now).
- `input`/`resize`/`kill` keep working on `currentSessionKey`. `resize` also resizes the session's VT screen.
- Server → subscribers: existing `data`/`replay`/`exit`/`ready`/`error`, plus `{type:'prompt', prompt: CliDetectedPrompt|null}` and `{type:'auto-approved', summary}`.
Per-session intelligence:
- `session.screen = new TerminalScreen(cols, rows)`, fed every PTY chunk; `session.transcript = new ScreenTranscript()` observing visibleRows on each evaluation.
- Prompt evaluation: throttle ≤ every 300 ms while output flows + one 250 ms after the last chunk (do NOT require output silence — Claude's spinner/blink repaints every ~600 ms). A prompt is confirmed when the same `signature` is seen in two consecutive evaluations; it clears when two consecutive evaluations return null/different. On change → WS `prompt` + SSE `prompt`.
- Auto-approve: if `session.permissionLevel === 'bypass'`, prompt.kind === 'approval', `!isBypassAcceptanceDialog`, and `pickApproveOption` returns an option → write `keystrokesForOption`, dedupe by signature for 5 s, send WS+SSE `auto-approved` with `promptSummary`. Never auto-answer `question`/`notice` prompts.
- Live permission (`/api/pty/policy`): set `session.permissionLevel`; if switching to bypass and an approval prompt is on screen → auto-approve it now. Mode switch per CLI:
  - claude: send shift+tab (`\x1b[Z`) one press at a time, ~350 ms apart, reading the screen footer after each press until it matches the target (`acceptEdits` → /accept edits on/i, `plan` → /plan mode on/i, `bypass` → /bypass permissions on/i, `ask` → none of those and not /auto mode/i); max 6 presses; only when no prompt is on screen (otherwise queue the target and retry after the prompt clears). Result `live` on success; for bypass target fall back to `auto-approve-only`; else `restart-required`.
  - gemini: Ctrl+Y (`\x19`) toggles YOLO; verify via footer /YOLO/i. `live` / fallback as above.
  - others: `bypass` → `auto-approve-only`; other levels → `restart-required` when different from the launch level, else `unchanged`.
- Signal watcher: per active session poll every 1.5 s (and once at exit/kill): manager → `delegate.json`, `completion.md`; worker → `worker-<pieceId>.md`; qa → `qa.md`. Emit when mtime > last emitted mtime, mtime ≥ startedAt − 2 s, file non-empty, and mtime is ≥ 400 ms old (finished writing). `delegate.json` must parse as JSON (else wait for next poll). Content capped at 64 KB. Keep latest per file in `session.signals` for `/api/pty/sessions`.
- The project file watcher (`broadcastFileChange`) must IGNORE any path containing `/.ergo/`.
- Exit: SSE `exit` + WS `exit` (existing).

## CLI launch flags & prompts (src/lib/cliAgents.ts) — CLIENT-LIB implementer
- claude: always `--allow-dangerously-skip-permissions` + `--permission-mode <manual|acceptEdits|plan|bypassPermissions>` (ask→manual; installed claude 2.1.296 accepts: acceptEdits, auto, bypassPermissions, manual, dontAsk, plan). Treat `--allow-dangerously-skip-permissions` as a permission flag.
- gemini plan → `--approval-mode plan`. Others unchanged.
- Export `hasUserPermissionOverride(extraArgs: string): boolean` (true when user extra args contain a permission flag — App warns once).
- Prompt builders (exact signatures):
```ts
export interface CliRunPromptContext { runId: string; runDirRel: string; maxWorkers: number; qaEnabled: boolean; }
export interface CliWorkerPiece { id: string; title: string; instructions: string; files: string[] }
export function buildManagerCliPrompt(task: TaskItem, brief: AgentContextItem | undefined, ctx: CliRunPromptContext): string;
export function buildWorkerCliPrompt(task: TaskItem, brief: AgentContextItem | undefined, piece: CliWorkerPiece, ctx: CliRunPromptContext): string;
export function buildQaCliPrompt(task: TaskItem, brief: AgentContextItem | undefined, ctx: CliRunPromptContext & { completionMarkdown: string; attempt: number }): string;
export function buildWorkersDoneMessage(results: Array<{ pieceId: string; title: string; fileRel: string; ok: boolean }>, ctx: CliRunPromptContext): string; // ONE line, no newlines
export function buildQaFailMessage(qaFileRel: string, attempt: number, maxRetries: number): string;                        // ONE line
export function parseDelegatePlan(json: string, maxWorkers: number): CliWorkerPiece[];  // validates, sanitizes ids to /^[A-Za-z0-9_-]{1,12}$/, drops invalid, caps count at 8
```
  Manager prompt: existing task content (buildTaskCliPrompt body) + run protocol: optional delegation (only for clearly separable pieces with DISJOINT file sets; ≤ maxWorkers; write delegate.json then stop and wait — Ergo will type a message when workers finish; never edit workers' files meanwhile), final step: write completion.md (format above) as the LAST action after verifying. If qaEnabled, mention a QA verifier will check the work and may send findings to fix, after which it must rewrite completion.md. Keep `buildTaskCliPrompt` exported (wrapper) for compatibility.
  Worker prompt: only its piece, only listed files, no delegation, write worker-<id>.md as last action.
  QA prompt: verify, do NOT implement fixes; run tests/build/lint as appropriate; check acceptance criteria (Gherkin if present) and the completion record; write qa.md with VERDICT line first.

## In-app pipeline live permission — CLIENT-LIB implementer
- `executeTaskWithAi` options gain optional `getPermissionLevel?: () => PermissionLevel`; `ctx.getPermissionLevel()` used by toolExecutor on every call AND re-checked inside the permission lock before prompting (allow → run without prompt; plan/block → refuse). Headless CLI providers (`providerLoop.ts` → `/api/cli/execute`) send the live level each round.
- `agentPipeline/index.ts` abort/error branches keep the Summary-generated overview instead of restoring the pre-run one.
- toolExecutor: populate `diffPreview` for edit_file (−old/+new, ≤40 lines) and write_file (first ≤40 lines). Read-only command detection: allow `2>&1`, `>/dev/null`, and `&&`/`;` chains where every part is read-only.
- ExecutionSettingsBar copy: changes apply immediately to running agents (for CLIs that can't switch live, Ergo says so).

## App orchestration — APP implementer (`src/App.tsx` + new `src/hooks/useCliAgentRuns.ts`)
- `agentPipelineOptionsRef` (kept in sync synchronously by a wrapper setter passed to BriefPane/SettingsModal). Read the ref (not the closure) when launching; pass `getPermissionLevel` to executeTaskWithAi. On permissionLevel change: `applyPermissionPolicy(level)` for all sessions; toast listing sessions with `restart-required`; for pipeline pending permission prompts: switching to bypass resolves them all as approved, switching to plan rejects them.
- Pipeline permission toast: title "Approve <tool>? — <task>", message = the actual command (`$ <args.command>`) / path / summary (≤280 chars). Selecting the toast's task should open its card.
- CLI run launch (`handleExecuteTask` CLI branch): overview fix (below); new runId; `killAgentSessions({taskId})`; drop the task's old sessions; clear brief completion/validation/humanReview/followUps for the new run; spawn manager (`spawnAgentSession`) with `buildManagerCliPrompt`; steps: context, overview (WITH `overviewDocument`), manager step `{agentRole:'manager', ptySessionId}`.
- SSE handling (`subscribeAgentEvents`, resync from `listAgentSessions()` on reconnect/load; dedupe signals by `${sessionId}:${signal}:${mtime}`):
  - `prompt` → session.pendingPrompt + status `awaiting_approval` (back to previous running/waiting status when null). Toast for approval prompts when not bypass, message = `promptSummary` (command shown).
  - `delegate` (manager) → `parseDelegatePlan`; manager status `waiting`; launch workers up to `maxConcurrentAgents` (queue the rest); each worker gets a step `{agentRole:'worker', pieceId, ptySessionId}`.
  - `worker-done` → worker `done`, its step success with the first ~12 lines of the file; kill that worker PTY after ~3 s; launch next queued; when all done → `sendAgentInput(manager, buildWorkersDoneMessage(...))` then `\r` ~150 ms later; manager `running`.
  - worker `exit` without done → `failed`, counts as finished (ok:false).
  - `complete` (manager) → if `run.qaEnabled` (the task menu's QA verification switch, off by default) and QA attempts left: manager `waiting`, launch QA (`buildQaCliPrompt` with the completion content; step `{agentRole:'hardener', title:'QA Verifier', ptySessionId}`); else finalize.
  - `qa-verdict` PASS → QA done, kill QA, finalize(pass). FAIL → kill QA; if attempts < `maxQaRetries`: `sendAgentInput(manager, buildQaFailMessage…)`, manager `running`, next `complete` relaunches QA; else finalize(partly_done, QA findings into Human Review).
  - manager `exit` before finalize → finalize(reason exit, transcript fallback).
- `finalizeCliRun(taskId, runId, {completionMarkdown?, qa?, reason})`: once per runId (in-memory set + `brief.completionRunId`). Uses `tasksRef`/`briefsRef` (never render closures). Completion text = agent's completion.md (or `fetchAgentTranscript` finalMessage, or a deterministic record with the transcript tail in a collapsible block), + QA verdict section, + usage. Sets `brief.completion`, `brief.completionRunId`, task status (`done` or `partly_done` when stopped/failed/QA failed/human review needed). `syncAndSaveProject(..., true)`. Adds a `built_record` step (running → success). Marks manager step success, clears executingTaskId, completes the running job. Kills remaining worker/QA sessions; leaves the manager PTY alive with status `done` (user may keep steering).
- Stop (`handleTerminateAgent` / kill) → `killAgentSessions({taskId})`, sessions `cancelled`, finalize(reason stopped) if not finalized.
- Remove the old `handleSessionExit` flow (exits now arrive via SSE); views no longer report exits.
- Restore on load: map `listAgentSessions()` rows to SpawnedSession (role default 'manager', label default by role, ptySessionId = id, runId default '', status from prompt/isActive) and merge by ptySessionId; replay their `signals` through the same deduped handler (finalize is idempotent via completionRunId).
- Use String() comparisons for task ids everywhere you touch.
- Usage polling: per agent session (`fetchCliSessionUsage(ptySessionId)`), per-agent step usage + task total.
- Overview: fix the stale-closure clobber (read `briefsRef`/`tasksRef` after every await; merge by String(sourceTaskId)); use `isPlaceholderOverview` for `hasValidOverview`; persist the generated overview immediately; attach an `overviewDocument` (`{ brief: <gherkin or ''>, goals: <overview markdown>, output_as: '', raw: <overview> }` — check the real OverviewDocument type) to the CLI overview step; one stable overview step id (running → success). Pipeline path: merge the overview into briefsRef by String ids; final save uses briefsRef.
- BriefPane wiring: pass `onKillAgentSession(ptySessionId)` and the wrapper setter; stop passing `onSessionExit`.

## UI — VIEWS implementer (BriefPane.tsx, CliAgentNotesBridge.tsx, AgentTerminal.tsx, new AgentSessionTabs.tsx, CSS in src/index.css)
- AiTaskCard gets `agentSessions: SpawnedSession[]` (String-id filtered, ordered manager → workers (by pieceId, numeric) → qa) instead of a single `terminalSession`; keep a derived manager `terminalSession` for existing status logic. "Working" = any session in starting/running/awaiting_approval/waiting (not merely `isActive`). New BriefPane/AiTaskCard prop `onKillAgentSession?: (ptySessionId: string) => void`. `onSessionExit` stays optional but unused.
- `hasPendingAlert` also true when any agent session has a pendingPrompt. Auto-expand the Actions card once per new pending permission id / new prompt signature.
- Pipeline permission card: structured details — run_command: `<pre>$ command</pre>` (+ cwd, copy); write/edit: path + diffPreview; else summary + collapsible JSON args.
- Steps view: every step with `ptySessionId` (or legacy `step-manager-*` without one → manager session) embeds that agent's terminal (`<AgentTerminal attachOnly sessionId={ptySessionId} …/>` inside ResizableTerminalContainer, `key=ptySessionId`, storageKey per role) with header `<AgentRoleBadge/> label · cmd · status`, per-agent Stop (`onKillAgentSession`), Restart only on manager (restarts the run). Sessions with no matching step render in an "Agent terminals" list. Each step card shows a role badge derived from `agentRole` (manager / worker+piece / hardener → "QA" / summary / cleaner / logger) — also labels the in-app pipeline path.
- Notes view: `<AgentSessionTabs sessions selectedId followLive …/>` (role badge, label, status dot incl. amber "needs approval" pulsing) above ONE `<CliAgentNotesBridge key={shown.ptySessionId} …/>`. Follow-live (default on) picks: first session awaiting approval → else if manager `waiting`: first running worker, else running QA → else manager if running → else any running → else last. Debounce ~800 ms. Every auto-switch shows a banner "Now showing <label> — <reason>" with "Back to <previous>" (pins selection, turns follow off). When the manager is waiting, show a row "Manager is waiting on N worker(s)" / "… on QA".
- Actions header chip: "Now running: <badge> <label>" for the shown agent; switcher label "Notes · <label>".
- CliAgentNotesBridge: props `sessionId` (ptySessionId), `role`, `label`, `cmd`, `isActive`, `status`, `permissionLevel`, `initialPrompt` (session.pendingPrompt), `onSwitchToSteps`, `onKill`, `onRestart?`. Attaches with `{type:'attach', observe:true}`; no client-side prompt parsing — uses server `prompt` messages; answers with `keystrokesForOption`. Card: title = toolLabel or "Action Requires Approval"/"Agent is asking"; command in `<pre>` (pre-wrap) with Copy; description/detailLines; collapsible "Show what the agent is asking" with rawSnippet; Raw Terminal link. `auto-approved` messages become feed entries "Auto-approved: …". Activity feed built from a client-side `TerminalScreen` + `ScreenTranscript` (fixes joined words) through `extractActivityEntries(lines)`; default texts use the label, not "Manager AI". Callback props held in refs; WS effect depends only on sessionId.
- AgentTerminal: `attachOnly` → sends `{type:'attach', sessionId, cols, rows}`; legacy spawn path unchanged for other callers; `onExit` via ref.
- Overview card: gate with `isRealOverviewText` (summaryDoc still wins); add a working state (spinner "Summary agent is synthesizing the overview…") when the overview step is running and no real overview yet; when a real overview exists while refreshing, show it with a small "Refreshing…" tag. Render `summaryDoc.goals || summaryDoc.raw` when `output_as` empty.
- Completion card: hint "The completion log is written when the agent finishes (or when you stop it)."; working state while a `built_record` step is running.

## Rules for implementers
- Only edit the files you own (listed in your prompt). Other implementers are editing other files concurrently; their new exports may not exist yet — code against the signatures above.
- Never run git commands that change state (no checkout/stash/reset/commit). Don't run `npm install`.
- Match surrounding code style (comment density, naming, inline styles vs CSS classes as the file already does).
- Type-check your files with `npx tsc -p tsconfig.app.json --noEmit` (and `-p tsconfig.node.json` for vite.config.ts); errors that only come from other implementers' unfinished files are expected — report them, don't fix them.
- Finish with a concise report: what you changed (file:line ranges), any deviation from this spec and why, open risks.
