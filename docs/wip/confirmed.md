### C0 [medium] (overview) src/App.tsx:1735 — Stopping a CLI re-run while its overview is being generated leaves the task stuck executing and the Overview card spinning forever
SCENARIO: A task has already finished one CLI run in this session, so useCliAgentRuns.runsRef still holds its finalized run (only forgetTask deletes it, useCliAgentRuns.ts:2007). The user clicks Run again. The overview is a placeholder, so handleExecuteTask sets executingTaskId and an overview step with status 'running', then awaits syncTaskOverviewWithAi. The user clicks Stop. handleTerminateAgent aborts launchController, so the launch returns early at App.tsx:2009/2048 without cleaning anything up. Then cliRunsRef.current.stopCliRun(taskId) returns 'finalized' for the old run (useCliAgentRuns.ts:1927), and `if (cliOutcome !== 'none') { persist; return; }` exits before setExecutingTaskId(null) and before the running steps are cancelled. executingTaskId stays set and the overview step stays 'running'. BriefPane keeps isOverviewSynthesizing=true and shows 'Summary agent is synthesizing the overview…' with the 'working' chip indefinitely, and the task looks like it is still executing until a reload. The same happens if Stop lands during prepareCliLaunch.
CORRECTED FIX: In src/App.tsx `handleTerminateAgent`, change the early return at line 1735 so it is skipped when Stop cancelled a CLI launch that was still preparing. In that case `stopCliRun` sees only the previous, already-finished run.

```ts
-    if (cliOutcome !== 'none') {
+    // 'finalized' only refers to a previous finished run; if we just aborted a launch still preparing
+    // (overview synthesis / prepareCliLaunch), fall through so executingTaskId and running steps are cleaned up.
+    if (cliOutcome === 'stopping' || (cliOutcome === 'finalized' && !foundController)) {
       persistRunningJobsDoc(runningJobsRef.current, queuedTaskIdsRef.current, briefsRef.current, taskExecutionStepsRef.current);
       return;
     }
```

`foundController` is already in scope from step 1 of the same function.

### C1 [medium] (approvals) src/lib/cliPromptParser.ts:561 — Agent questions phrased 'Do you want to…' with Yes/No options are classed as approvals and auto-answered 'Yes' in Full access
SCENARIO: Claude's AskUserQuestion renders '☐ Legacy API / Do you want to keep the legacy API endpoints? / ❯ 1. Yes / 2. No / 3. Type something. / Enter to select · Esc to cancel'. buildMenuPrompt sets kind='approval' because the question matches APPROVAL_QUESTION_RE ('do you want to') and option 'Yes' matches APPROVE_LABEL_RE. No toolLabel or targetCommand is needed. I ran it through the parser and got kind 'approval', pick 'Yes', keys '\r'. Under bypass, tryAutoApprove (vite.config.ts:4531) then presses Enter, so the bridge answers the agent's design question for the user. The spec says question prompts must never be auto-answered. The same thing happens when a question has a backticked command ('Should I run `npm install`?') or labels starting with Run/Continue/OK.
CORRECTED FIX: In src/lib/cliPromptParser.ts buildMenuPrompt, veto 'approval' when the menu shows question-tool markers. Replace line 561 with:

  const agentQuestion =
    menu.options.some((o) => /^(?:type something|chat about this|other)\b/i.test(o.label.trim())) ||
    rows.slice(Math.max(0, menu.topIdx - 8), questionIdx + 1).some((r) => /[☐☒]/.test(r.text));
  const isApproval = hasApprove && !agentQuestion && (approvalQuestion || Boolean(panel.toolLabel) || Boolean(panel.targetCommand));

Real tool-permission menus from Claude, Codex and Gemini never offer a 'Type something', 'Chat about this' or 'Other' option and have no ☐/☒ tab header. With this check those prompts keep kind 'approval', and AskUserQuestion menus, including the backticked-command case, become 'question'. tryAutoApprove then leaves them for the user.

### C2 [medium] (approvals) vite.config.ts:4605 — Switching Claude to a stricter mode cycles through bypassPermissions, briefly running tools with no approval
SCENARIO: The installed Claude 2.1.296 cycle (C1t in the binary) is default→acceptEdits→plan→bypassPermissions (always available, since Ergo launches with --allow-dangerously-skip-permissions)→[auto]→default. If the user downgrades from Accept edits to Ask while the agent is working, switchClaudeMode presses shift+tab one key at a time, 350 ms apart: acceptEdits→plan→bypassPermissions→default. For at least 350 ms the session runs in bypass mode, so any Bash or Edit call Claude issues in that window runs without a prompt, which is the opposite of what the user asked for. Plan→Accept edits also passes through bypass. Both transitions also pass through plan, which can refuse an in-flight edit.
CORRECTED FIX: In vite.config.ts switchClaudeMode, never rest on bypass (or auto) when bypass is not the target. Replace the press block (lines 4628-4634):

    try {
      session.ptyProcess.write('\x1b[Z');
    } catch {
      return { ok: false, detail: 'Could not write to the terminal.' };
    }
    presses++;
    await sleep(MODE_SWITCH_STEP_MS);

with:

    // Claude's cycle is plan -> bypassPermissions -> [auto] -> default; never sit in bypass/auto unless that is the target.
    const skipPermissive = target !== 'bypass' && (mode === 'plan' || mode === 'bypass' || mode === 'auto');
    try {
      session.ptyProcess.write('\x1b[Z');
      presses++;
      if (mode === 'plan' && target !== 'bypass') {
        await sleep(40); // let Ink handle the first key separately, then move straight past bypass
        session.ptyProcess.write('\x1b[Z');
        presses++;
      }
    } catch {
      return { ok: false, detail: 'Could not write to the terminal.' };
    }
    await sleep(skipPermissive ? 60 : MODE_SWITCH_STEP_MS);

If the double press lands on 'auto', the next loop iteration reads it within about 60 ms and presses once more, to default. The rollback loop at lines 4637-4646 should skip quickly the same way. Then, as defence in depth, only pass --allow-dangerously-skip-permissions when the launch level is 'bypass' (src/lib/cliAgents.ts:628): `return [...(level === 'bypass' ? ['--allow-dangerously-skip-permissions'] : []), '--permission-mode', CLAUDE_PERMISSION_MODES[level] || 'acceptEdits'];`. With that change, a live upgrade to bypass in a non-bypass session already falls back to auto-approve-only through the "not in Claude Code's shift+tab cycle" path and policyFallback.

### C3 [medium] (approvals) vite.config.ts:4665 — Gemini: turning YOLO off lands in DEFAULT mode, but the bridge reports 'live' at the launch level
SCENARIO: Gemini is launched under Accept edits (--approval-mode auto_edit). The user switches to Full access, and Ctrl+Y turns YOLO on. The user then switches back to Accept edits, and Ctrl+Y turns YOLO off. In the installed gemini-cli (interactiveCli bundle, TOGGLE_YOLO handler), Ctrl+Y from YOLO sets ApprovalMode.DEFAULT, not the launch mode. readGeminiMode returns 'ask', but `target === session.launchPermissionLevel` returns ok, so the result is 'live'. Gemini now asks for every file edit while Ergo shows Accept edits. With a plan launch, the same path leaves Gemini in DEFAULT, which can edit files after approval, instead of read-only.
CORRECTED FIX: In vite.config.ts:

1) In readGeminiMode (line ~4591), make plan detection match the real indicator ("plan" followed by "<cycle key> to manual"):
   if (/plan mode|^plan\b.*to manual/im.test(text)) return 'plan';

2) In switchGeminiMode, replace lines 4665-4668 (the "With YOLO off, Gemini runs under its launch flags" block) so it never trusts launchPermissionLevel. Instead, check the screen and cycle with shift+tab (DEFAULT -> AUTO_EDIT -> PLAN, when plan is allowed -> DEFAULT):

  for (let presses = 0; ; presses++) {
    if (!session.isActive || session.superseded) return { ok: false, detail: 'The session has ended.' };
    if (session.modeTarget !== target) return { ok: false, detail: 'Superseded by a newer permission change.' };
    if (readGeminiMode(session.screen.visibleRows()) === target) return { ok: true };
    if (presses >= 3) break;
    if (promptOnScreen(session)) return { ok: false, queued: true };
    try { session.ptyProcess.write('\x1b[Z'); } catch { return { ok: false, detail: 'Could not write to the terminal.' }; }
    await sleep(MODE_SWITCH_STEP_MS);
  }
  return { ok: false, detail: 'Gemini CLI did not reach this mode with shift+tab; this level needs a restart.' };

When the loop fails, policyFallback reports 'restart-required' instead of a false 'live'. Three presses cover the whole three-mode cycle.

### C4 [medium] (approvals) src/lib/cliPromptParser.ts:581 — Line-mode confirmations are still detected after they are answered, which re-sends 'y\r'
SCENARIO: aider (or any line-mode CLI) running in Full access through auto-approve-only shows 'Run shell command? (Y)es/(N)o [Yes]: '. The bridge sends 'y\r', and the row becomes 'Run shell command? (Y)es/(N)o [Yes]: y'. detectConfirmation still matches CONFIRM_RE in the last 2 rows. The question text has changed, so the signature is new (verified: p10kthp6mkdcni → p1fonbbj1eowxon). After two evaluations it is confirmed as a new approval and auto-approved again, sending a second 'y\r'. That keystroke goes to the running command's stdin, the next confirmation, or aider's chat input as a 'y' message. Outside bypass, the answered prompt pops up again as a new card and toast.
CORRECTED FIX: In src/lib/cliPromptParser.ts, treat a confirmation row as pending only when nothing has been typed after its prompt terminator. Add a helper and use it in place of the bare CONFIRM_RE test at line 581:

/** True when the row is a y/n confirmation still waiting for an answer (no answer typed after the marker or the trailing ':' / '?'). */
function isPendingConfirmRow(text: string): boolean {
  const m = CONFIRM_RE.exec(text);
  if (!m) return false;
  const rest = text.slice(m.index + m[0].length);
  // "…[Yes]: y", "…(y/n)? n"  → answered;  "[y/N] y" → answered
  if (/[:?]\s*\S+\s*$/.test(rest) || /^\s+\S+\s*$/.test(rest)) return false;
  return true;
}

and change line 581 to:
  const hit = [...last].reverse().find((x) => isPendingConfirmRow(x.r.text));

This still matches unanswered prompts with extra options after the marker, such as "(Y)es/(N)o/(D)on't ask again [Yes]: " (rest = "/(D)on't ask again [Yes]: "), "[y/N] " and "(y/n)? ". It rejects answered rows such as "…[Yes]: y", "…? y" and "[y/N] y", so the echoed answer is no longer reported as a new prompt.

### C5 [medium] (prompt-text) src/lib/cliPromptParser.ts:666 — Echo filter removes the command or file-path row, so the card shows the description as the command or drops the path
SCENARIO: parseCliScreenPrompt drops every screen row whose normalized text matches a line of echoedText. The bridge sets echoedText to the agent's full launch args (vite.config.ts:4891 `echoedText: args.join('\n')`), which include the task prompt. (1) Every worker prompt lists its files as `- src/app.ts`, which normalizes to `src/app.ts`. When that worker asks to Edit or Create src/app.ts, the path row ' src/app.ts' under 'Edit file' is filtered out. Probe result: detailLines = only the diff lines, and promptSummary = 'Edit file: 1 import { run } from "./run";'. The file being edited never appears in the card or the toast. (2) The task checklist contains `- [ ] npm test` and the agent asks to run `npm test`. The command row inside the ╌ box is filtered, the box is empty, and branch (5) takes the first row after the header. Probe on the real Claude capture with echoedText '- [ ] python3 -c "print(6*7)" && echo ergo-probe-done' gives targetCommand = 'Print 6*7 with Python and echo completion marker'. The card then shows '$ <description>' under 'Command to execute', and the real command is gone.
CORRECTED FIX: In src/lib/cliPromptParser.ts `parseCliScreenPrompt`, stop deleting echoed rows before parsing. Parse the raw rows first, and use the echo set only to reject a result whose question or options come from the echoed prompt:

```ts
export function parseCliScreenPrompt(rows: string[], opts: { echoedText?: string } = {}): CliDetectedPrompt | null {
  const echoed = new Set(
    (opts.echoedText || '').split('\n').map(normalizeForEcho).filter((l) => l.length > 3)
  );
  const isEcho = (t: string) => echoed.has(normalizeForEcho(t));
  const parse = (dropEcho: boolean): CliDetectedPrompt | null => {
    let parsed = rows.map(toRow);
    if (dropEcho) parsed = parsed.filter((r) => r.blank || isRule(r) || !isEcho(r.text));
    let end = parsed.length;
    while (end > 0 && parsed[end - 1].blank) end--;
    if (end === 0) return null;
    parsed = parsed.slice(Math.max(0, end - 60), end);
    const numbered = findNumberedMenu(parsed);
    const numberedPrompt = numbered ? buildMenuPrompt(parsed, numbered) : null;
    if (numberedPrompt) return numberedPrompt;
    const arrow = findArrowMenu(parsed);
    const arrowPrompt = arrow ? buildMenuPrompt(parsed, arrow) : null;
    if (arrowPrompt) return arrowPrompt;
    return detectConfirmation(parsed) || detectNotice(parsed);
  };
  if (echoed.size > 0) {
    const raw = parse(false);
    // Keep the raw parse (panel rows intact) unless its menu, question or notice came from the echoed prompt.
    if (raw && raw.kind !== 'notice' && !isEcho(raw.question) && !(raw.options || []).some((o) => isEcho(o.label))) return raw;
  }
  return parse(true);
}
```

This keeps the original purpose: an echoed numbered list, question or notice is still never read as a live prompt, because the code falls back to the filtered parse. The path, command and diff rows inside a real panel are no longer removed.

### C6 [medium] (prompt-text) src/lib/cliPromptParser.ts:339 — Multi-line commands (about 17 lines or more) lose the header and command; the 'don't ask again' prefix is shown as the command
SCENARIO: extractPanel walks up at most PANEL_SEARCH_ROWS = 25 rows from the question to find the tool header or a solid rule, and dashed rules don't count as boundaries. For a Claude 2.1 Bash prompt with a heredoc or `python - <<EOF` command of about 17 lines or more, 'Bash command' is out of reach. Then topIdx = questionIdx, the body is empty, and no dashed box is found. Fallback (7) at :466-474 sets targetCommand from the option label 'Yes, and don't ask again for: cat:*'. Probe with n=19..30 command lines: toolLabel undefined, description undefined, targetCommand 'cat:*', summary 'cat:*'. The Notes card and the toast show '$ cat:*' as 'Command to execute' for a 20-line heredoc. This is exactly the 'doesn't show WHAT is being approved' bug, for long commands.
CORRECTED FIX: In extractPanel (src/lib/cliPromptParser.ts ~line 338), count a dashed command or diff box as one unit, so its rows do not use up PANEL_SEARCH_ROWS. Replace the loop header and its first lines:

    for (let i = questionIdx - 1; i >= 0 && i >= questionIdx - PANEL_SEARCH_ROWS; i--) {
      const row = rows[i];
      if (isBoundary(row)) {

with:

    let budget = PANEL_SEARCH_ROWS;
    let inDashedBox = false;
    for (let i = questionIdx - 1; i >= 0 && budget > 0; i--) {
      const row = rows[i];
      if (DASHED_RULE_RE.test(row.text)) {
        inDashedBox = !inDashedBox;
        continue;
      }
      if (inDashedBox) continue;
      budget--;
      if (isBoundary(row)) {

(The rest of the loop stays the same. parseCliScreenPrompt already caps the walk at the last 60 rows.)

Optional extra hardening: in fallback (7) at ~line 466, set `description = description ?? \`Rule offered: ${m[1].trim()}\`` instead of assigning the prefix to targetCommand. Then a panel that is still unrecoverable, for example when the header has scrolled off screen, never shows a permission rule pattern as 'Command to execute'.

### C7 [medium] (prompt-text) src/hooks/useCliAgentRuns.ts:1177 — Under Full access, a prompt the bridge hands back to the user gets no toast, and the Notes card says it will be auto-approved
SCENARIO: The bridge makes an approval prompt visible in bypass mode in two cases: tryAutoApprove gave up after AUTO_APPROVE_MAX_ATTEMPTS (vite.config.ts:4548-4550, 'asking the user'), or pickApproveOption found no safe option. handlePrompt still returns early for every `kind === 'approval' && level === 'bypass'` prompt, so no toast appears. CliAgentNotesBridge.tsx:530-531 computes willAutoApprove from permissionLevel alone and shows 'Full access is on — Ergo approves this automatically.' The agent stays blocked, and the UI tells the user they don't need to act.
CORRECTED FIX: The bridge never sends a visible approval prompt in bypass mode unless it has given up, so a visible approval prompt always needs the user.

1) src/hooks/useCliAgentRuns.ts:1177: delete the early return
   `if (prompt.kind === 'approval' && level === 'bypass' && !bypassDialog) return;`
   The `level` variable is then unused, so remove it too (line 1174). Every visible prompt then gets a toast, keeping the signature dedupe.

2) src/components/CliAgentNotesBridge.tsx:530-531 and 694-699: a visible approval prompt under bypass means auto-approve failed. Keep the condition and change the note text, for example rename `willAutoApprove` to `autoApproveFailed` and render:
   `<div className="prompt-auto-note is-warning"><AlertTriangle size={12} /><span>Full access is on, but Ergo couldn't approve this automatically — please answer it.</span></div>`

Optional: for an explicit signal, have tryAutoApprove's false paths in vite.config.ts set `prompt.autoApproveFailed = true` (add an optional field to CliDetectedPrompt) before broadcasting. Then key both the toast and the note on that flag rather than on the level.

### C8 [medium] (completion) src/hooks/useCliAgentRuns.ts:891 — A Stop finalize still in progress overwrites the next run of the same task
SCENARIO: The user presses Stop. stopCliRun enqueues finalizeRun('stopped'), which sets run.finalized=true and then sleeps 1.5 s (line 891) before fetching the transcript. Within that window the user presses Run again. launchCliRun only retires runs that are not finalized (lines 1742-1747), so the new run starts at once. It resets the brief, sets the task in_progress, creates a new job and spawns the new `${taskId}::manager`. The old finalize then resumes and does six things. (1) fetchAgentTranscript(run.managerSessionId) reads the NEW manager's live transcript, because the pty id is the same. (2) It writes task status partly_done over the running task (line 1045). (3) It writes brief.completion = 'stopped by user' with completionRunId set to the old run (lines 1053-1074). (4) updateJobs marks the NEW run's in_progress job 'cancelled' (lines 1100-1106), and the new run's own finalize later only changes in_progress jobs, so the job stays cancelled. (5) clearExecuting clears the new run's executingTaskId (line 1107). (6) It upserts the old 'Completion Log' step (success) into the new run's steps, so the Completion card shows Done with stale text while the new agent is still working.
CORRECTED FIX: In src/hooks/useCliAgentRuns.ts finalizeRun, place this immediately after the `if (!body) { ... fetchAgentTranscript ... }` block. That is the last await, just before the `// ── Everything below reads the latest App state (after all awaits). ──` comment:

```ts
    // A newer launch of this task (e.g. Restart pressed during the post-stop flush) owns the task/brief/job/steps now.
    if (runsRef.current.get(run.taskKey) !== run) {
      run.resolveDone();
      return;
    }
```

The check works for every caller. launchCliRun replaces runsRef's entry with the new run, so an old finalize stops there. stopCliRun, the event handlers and the deferred/restored paths all finalize the run that runsRef currently holds; the restored path calls runsRef.current.set before it enqueues. If forgetTask deleted the entry, skipping the writes is also correct.

The other fix would be for launchCliRun to wait for the pending finalize before it resets anything: `await taskQueuesRef.current.get(taskKey)?.catch(() => {});` at the top, before the retire block. That adds up to about 2 s of delay before a restart starts, so the guard above is the minimal fix.

### C9 [medium] (completion) src/hooks/useCliAgentRuns.ts:844 — Completion is written into another project if the user switches projects during finalize
SCENARIO: The project-ownership check runs only once, at the top of finalizeRun (lines 843-856). The function then awaits usage fetches, the transcript and, for stop or exit, a 1.5 s sleep. Example: the user stops a run in project A (or it completes) and switches to project B inside that window. Afterwards d.tasksRef/d.briefsRef hold project B's data (lines 1014-1074). If B has a task with the same id (ids are only unique per project, as the code comments note), that unrelated task is marked done/partly_done and its brief receives A's completion log. Otherwise a new brief `brief_<id>` is appended to B's briefs. In both cases d.syncAndSaveProject writes the result into project B's TODO.md and RUNNING_JOBS.json. Project A never gets its completion, because run.finalized=true has already been saved. updateSteps is guarded per project but the task and brief writes are not.
CORRECTED FIX: In src/hooks/useCliAgentRuns.ts finalizeRun, insert a re-check right after the transcript block. It goes just before `// ── Everything below reads the latest App state (after all awaits). ──` / `const d = depsRef.current;` (around line 915):

```ts
    if (run.projectId && run.projectId !== depsRef.current.projectId) {
      // The user switched projects while we awaited: finish this run when its project is open again.
      run.finalized = false;
      run.deferredFinalize = opts;
      saveRunState(run);
      return;
    }
```

That is all the fix needs, and it must come before any read of d.tasksRef/d.briefsRef or any call to updateJobs/clearExecuting/syncAndSaveProject.

The existing restore path then picks the run up when project A is loaded again:
- An in-memory run goes through line 1631 (`run.deferredFinalize && !run.finalized` → finalizeRun(run, deferred)).
- A persisted run goes through line 1641/1658, which uses state.deferredFinalize.

On that second call, briefAtStart.completionRunId is not yet this run's id, so the full log is written to A. Workers and QA were already cancelled and killed in the first pass, so repeating that is harmless.

Do not call run.resolveDone() in this branch. The deferred finalize resolves it later, the same way the top-of-function deferral path does.

### C10 [medium] (completion) src/hooks/useCliAgentRuns.ts:1402 — Manager exit finalizes the run while the QA verifier or workers are still running
SCENARIO: Example with a one-shot CLI: gemini with a positional prompt, or aider --message. The manager writes completion.md and exits. The bridge's final poll emits 'complete' before 'exit', so handleSignal calls launchQa. 2.5 s later the exit handler runs finalizeRun({reason:'exit'}) without checking run.qaActive or running workers. finalizeRun then cancels the QA step ('Run ended before QA reported'), kills the QA PTY and marks the task done; status is not partly_done because exitCode is 0. The completion log has no QA verdict even though QA was enabled. The same happens after delegate.json: the workers just launched are cancelled and killed 2.5 s later, and the completion log says only 'agent exited'.
CORRECTED FIX: 1) src/hooks/useCliAgentRuns.ts, in the deferred exit handler (around line 1401), replace the manager `else` branch with:

        } else {
          const workersOpen = currentRoundWorkers(run).some((w) => w.status === 'queued' || w.status === 'running');
          if (run.qaActive || workersOpen) {
            // The run finalizes when QA reports (qa-verdict, QA exit, or the QA-FAIL fallback when the manager is gone) or when the workers finish.
            run.managerExitCode = ev.code;
            saveRunState(run);
            return;
          }
          await finalizeRun(run, { reason: 'exit', exitCode: ev.code, completionMarkdown: run.lastCompletion });
        }

Add `managerExitCode?: number | null;` to RunState (near line 336).

2) In reportWorkersToManager (line 715), right after the `round.some(... queued/running) return` check, finalize when the manager is gone instead of typing into a dead PTY:

    if (!findSession(run.managerSessionId)?.session.isActive) {
      // eslint-disable-next-line @typescript-eslint/no-use-before-define
      await finalizeRun(run, { reason: 'exit', exitCode: run.managerExitCode ?? null, completionMarkdown: run.lastCompletion });
      return;
    }

finishWorker calls reportWorkersToManager with `void`, outside the task queue. If that matters, wrap the call in `void enqueue(run.taskKey, () => finalizeRun(...))`.

3) Optional, for consistency in reconcile (line 1599): make the manager-gone finalize also skip when `run.qaActive` is set, since the QA-gone check just above already covers a dead QA.

### C11 [medium] (completion) src/App.tsx:1734 — Stop during launch preparation leaves the task stuck as executing when the task had an earlier CLI run
SCENARIO: Example: a task already ran once in this session, or a run was restored for it, so runsRef holds a finalized RunState. The user re-runs it and presses Stop while handleExecuteTask is still in syncTaskOverviewWithAi or prepareCliLaunch/routeModelsForRun. stopCliRun returns 'finalized' rather than 'none', so handleTerminateAgent returns at line 1736. It skips setExecutingTaskId(null), the cancellation of running steps and the status reset. handleExecuteTask sees the aborted controller and returns silently (lines 2014, 2043, 2048, 2072). executingTaskId stays set, and the Summary step stays 'running' when Stop hit during synthesis. The card shows 'working' indefinitely, and pressing Stop again takes the same early return.
CORRECTED FIX: In src/App.tsx, handleTerminateAgent (around line 1734), replace
    if (cliOutcome !== 'none') {
with
    // A finalized run left over from an earlier launch must not swallow a Stop that aborted a launch still preparing (foundController).
    if (cliOutcome === 'stopping' || (cliOutcome === 'finalized' && !foundController)) {
The rest of the block stays the same. With an aborted preparing launch, the function now falls through to the existing cleanup. That cleanup clears executingTaskId, cancels the running Summary step, cancels in-progress jobs and resets the task status.

### C12 [medium] (per-agent) src/hooks/useCliAgentRuns.ts:1742 — Agent runs and PTY sessions are keyed by task id only, so the same task id in two projects collides (silent kill, wrong agents shown)
SCENARIO: Task ids are sequential per project (App.tsx:2777), so project A and project B both have a task 3. Task 3 is running in project A. The user switches to project B, which the run code supports (deferredFinalize, projectId on the run), and runs B's task 3. launchCliRun then does four things. (1) runsRef.get('3') returns A's run, and line 1742 marks it finalized with no completion log, so A's task stays in progress forever. (2) killAgentSessions({taskId: 3}) at line 1759 kills A's manager, workers and QA on the bridge, because the bridge matches only String(taskId). (3) B's agents reuse the same PTY keys ('3::manager' from agentSessionId at cliRunClient.ts:210). (4) Even without launching anything, terminalSessions is never filtered by project: after the switch, B's task-3 card (BriefPane sessionsByTask, line 2474) shows A's task-3 manager and worker tabs and terminals as 'Working', and its Stop button kills A's run.
CORRECTED FIX: Give runs and sessions an identity scoped to the project, and kill by session id instead of by task id.

1. **cliRunClient.ts**
   - Change `agentSessionId(taskId, role, pieceId)` to `agentSessionId(projectId, taskId, role, pieceId)`, returning `` `${projectId}:${taskId}::${role}${pieceId ? `::${pieceId}` : ''}` ``.
   - Send `projectId` in the spawn request body.

2. **vite.config.ts**
   - Store `projectId` on `PtySessionState` and return it in the sessions list.
   - In `/api/pty/kill` and `/api/pty/policy`, when the body has `projectId`, also require `s.projectId === body.projectId` for taskId matches.

3. **useCliAgentRuns.ts**
   - Add `projectId` to `SpawnedSession`. Set it at spawn (`run.projectId`) and at restore (`r.projectId ?? owner`).
   - Key `runsRef` by `runKey = `${projectId}::${taskKey}`` through a helper. Use it for every `runsRef.get`/`set`/`delete` (lines 1712, 1742, 1789, 1500, 1652, 2000, 2007).
   - In `launchCliRun` (lines 1759-1767) and `stopCliRun` (lines 2009-2017), select sessions with `String(s.session.taskId) === taskKey && s.projectId === d.projectId`. Kill each with `killAgentSessions({ sessionId: s.ptySessionId })` instead of `{ taskId }`.
   - Make the `commitSessions` filters in those two places project-scoped too.
   - Update `taskKeyOf`/`split('::')[0]` (lines 1446-1447) to strip the `projectId:` prefix.

4. **App.tsx**
   - Add `const projectSessions = useMemo(() => terminalSessions.filter((s) => !s.projectId || s.projectId === activeProjectId), [terminalSessions, activeProjectId])`.
   - Use `projectSessions` instead of `terminalSessions` in `runningTaskIds` (line 3828), the BriefPane prop (line 4064) and the lookup at line 2460.

### C13 [medium] (per-agent) src/hooks/useCliAgentRuns.ts:552 — Worker and QA prompts take task and brief content from the open project, which may be a different one
SCENARIO: A run of project A's task 2 is in progress when the user switches to project B, which also has a task 2. The manager then writes delegate.json, or completion.md with QA enabled. startWorker (line 755) and launchQa (line 826) build prompts from latestTask(run) and latestBrief(run). Those look up tasksRef and briefsRef, which now hold project B, by id or title only and find B's task 2. The workers get B's task description, and the QA verifier checks A's code against B's acceptance criteria and Gherkin. Its verdict and any fix loop are then based on the wrong task.
CORRECTED FIX: In src/hooks/useCliAgentRuns.ts:

1) Add `briefSnapshot?: AgentContextItem;` to `PersistedRunState` (around line 323, next to `taskSnapshot`).

2) Fill it in wherever `taskSnapshot` is set from the open project:
- At launch (around line 1777): `briefSnapshot: (() => { const b = d.briefsRef.current; const i = findBriefIndex(b, task.id, task.title); return i === -1 ? undefined : b[i]; })(),`
- In the restore fallback (around line 1517): `briefSnapshot: brief,`

3) Replace lines 552-558 with:
```ts
const isForeignRun = (run: RunState) => Boolean(run.projectId) && run.projectId !== depsRef.current.projectId;

const latestTask = (run: RunState): TaskItem =>
  isForeignRun(run)
    ? run.taskSnapshot
    : depsRef.current.tasksRef.current.find((t) => String(t.id) === run.taskKey) || run.taskSnapshot;

const latestBrief = (run: RunState): AgentContextItem | undefined => {
  if (isForeignRun(run)) return run.briefSnapshot;
  const briefs = depsRef.current.briefsRef.current;
  const idx = findBriefIndex(briefs, run.taskId, latestTask(run).title);
  return idx === -1 ? undefined : briefs[idx];
};
```
`finalizeRun` returns early for foreign runs before it calls `latestBrief`, so its `completionRunId` check still reads the live brief.

### C14 [medium] (per-agent) src/components/AgentSessionTabs.tsx:118 — Follow-live ends a delegated run on the last worker or QA with a false 'ran last' reason, hiding the manager that is still running
SCENARIO: In a run with workers W1 and W2 and no QA, the workers finish and are killed (status 'done'). The manager integrates their work and writes completion.md, and finalizeRun sets the manager to status 'done' while leaving it alive so the user can keep steering it. pickLiveAgent then finds no prompt, no waiting manager and nothing running. It falls back to ordered[ordered.length-1], and since ordering is by role rather than by time, that is Worker W2. After 800 ms the Notes view switches from the manager to W2's dead terminal with the banner 'Now showing Worker W2 — Worker W2 ran last', even though the manager ran last. The same happens after a Stop. With QA enabled it always lands on the QA terminal.
CORRECTED FIX: In src/components/AgentSessionTabs.tsx, replace lines 118-119:

  if (manager?.session.isActive) return { session: manager, reason: 'the Manager is still open' };
  const last = ordered.reduce((a, b) =>
    String(b.endedAt || b.session.spawnedAt || '') > String(a.endedAt || a.session.spawnedAt || '') ? b : a
  );
  return { session: last, reason: `${last.label} ran last` };

The live manager PTY stays shown after finalize. Otherwise the agent with the latest end time (or launch time, when it has none) is chosen, not the last one in role order.

### C15 [high] (regressions) src/lib/agentPipeline/toolExecutor.ts:87 — Read-only command check can be bypassed with an escaped quote, so arbitrary commands run with no approval (even in Plan mode)
SCENARIO: The new splitCommandChain (line 87) and the pipe splitter in isReadOnlyPart (line 139) treat a backslash-escaped quote outside quotes (\' or \") as the start of a quoted string. Bash treats it as a literal character. I bundled the module with esbuild and ran it: isReadOnlyCommand("echo \\'; rm -rf x; echo \\'") returns true, and so do "echo \\'| rm -rf x |echo \\'" and "echo \\' && touch pwned && echo \\'". Bash, via runShellCommand, runs `rm -rf x`. permissionVerdict (line 195) then returns 'allow' for run_command at every level except 'ask'. In 'plan' (read-only), 'acceptEdits' and 'bypass' a model can run destructive commands with no prompt. The old check rejected any ';', '&', '<' or '>' anywhere in the string and split on every '|', so this is a regression and a security hole.
CORRECTED FIX: Two changes in src/lib/agentPipeline/toolExecutor.ts.

1. splitCommandChain (around line 87): reject any backslash outside quotes. A backslash inside double quotes is already handled, and inside single quotes it is a literal character. Insert this before the quote-opening branch:

    if (ch === '\\') return null; // bash reads an unquoted \' or \" as a literal, not a quote
    if (ch === '"' || ch === "'") {
      quote = ch;
      ...

Every part that reaches isReadOnlyPart comes from splitCommandChain. So once it rejects unquoted backslashes, the pipe splitter in isReadOnlyPart no longer sees fake quotes and needs no change.

2. stripQuoted (line 111-113): replace the two regexes, which go wrong when quote types are mixed (for example echo "it's" > x 'y'), with one left-to-right scan that matches the splitter:

function stripQuoted(segment: string): string {
  let out = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (ch === '\\' && quote === '"') { i++; continue; }
      if (ch === quote) { quote = null; out += ch; }
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    out += ch;
  }
  return out;
}

Add unit tests that expect false for: "echo \\'; rm -rf x; echo \\'", "echo \\'| rm -rf x |echo \\'", "echo \\' && touch pwned && echo \\'", `echo "it's" > x 'y'` and `echo 'a"b' > x "c"`. Add tests that expect true for: `grep "a|b" f`, `echo 'x > y'` and `ls && git status; cat f 2>/dev/null`.

### C16 [medium] (regressions) src/App.tsx:1734 — Stopping a CLI re-run during its launch phase leaves the task stuck as executing
SCENARIO: Task T has finished an earlier CLI run, so useCliAgentRuns.runsRef holds a finalized run for T. The user clicks Run again, and handleExecuteTask sets executingTaskId=T. While it is still in syncTaskOverviewWithAi or prepareCliLaunch/routeModelsForRun, the user clicks Stop. handleTerminateAgent aborts launchController, and handleExecuteTask returns at line 2014, 2043, 2048 or 2072 without cleaning up. stopCliRun(T) returns 'finalized' (the old run), not 'none', so the `if (cliOutcome !== 'none') return;` at line 1734 skips setExecutingTaskId(null), the step cancellation and the status reset. executingTaskId stays T: the card shows as working/executing indefinitely (runningTaskIds includes it), and a regenerating overview step stays 'running', so the overview spinner never stops. Before this change, terminate always cleared executingTaskId.
CORRECTED FIX: In src/App.tsx handleTerminateAgent, replace the early return at ~1733:

    if (cliOutcome !== 'none') {

with:

    // A finalized run from an earlier launch must not short-circuit cleanup of a launch/pipeline still in flight
    if (cliOutcome === 'stopping' || (cliOutcome === 'finalized' && !foundController)) {

Here foundController is the AbortController from step 1. It is set when a CLI launch is still preparing (before releaseLaunchController) or when an in-app pipeline is running. In those cases the code falls through to the existing cleanup: it clears executingTaskId, cancels in_progress jobs, cancels running steps and sets the task back to partly_done.

### C17 [medium] (regressions) src/hooks/useCliAgentRuns.ts:1671 — Agent event stream is opened once at mount with the bridge URL of that moment; on hosted web, if discovery later moves the bridge, prompts, signals and exits are never received
SCENARIO: The hosted web app loads with the saved bridge URL http://localhost:5173 while Ergo is actually running on 5174, or is not running yet and later starts on a fallback port. subscribeAgentEvents (cliRunClient.ts:188) creates EventSource(bridgeClient.getApiUrl('/api/pty/events')) once in a [] effect. bridgeClient.checkConnection then switches bridgeUrl to 5174, and launches go there through bridgeClient.fetch. The EventSource keeps retrying 5173 forever (or stops for good on an HTTP 403). No 'prompt', 'signal' or 'exit' events arrive: no approval toasts, completion.md is never picked up, finalizeRun never runs, the task stays in progress, and sequence runs block in waitForCliRun forever. Before this change, completion came through the per-terminal WebSocket, which was opened later with the current URL.
CORRECTED FIX: Fix this inside subscribeAgentEvents (src/lib/cliRunClient.ts:184) so the hook does not change. Track the URL the stream was opened with. When the bridge URL changes, or when the bridge reconnects after the stream has closed for good, close the stream and open a new one. Treat every open after the first as a reconnect, so the hook's existing onReconnect callback resyncs through restoreAgentSessions.

export function subscribeAgentEvents(onEvent: (ev: CliAgentEvent) => void, onReconnect?: () => void): () => void {
  let source: EventSource | null = null;
  let openedUrl = '';
  let everOpened = false;
  const open = () => {
    try { source?.close(); } catch {}
    source = null;
    openedUrl = bridgeClient.getApiUrl('/api/pty/events');
    try {
      const s = new EventSource(openedUrl);
      source = s;
      s.onopen = () => {
        if (everOpened) onReconnect?.();
        everOpened = true;
      };
      s.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data);
          if (data && typeof data.type === 'string' && data.type !== 'connected') onEvent(data as CliAgentEvent);
        } catch {}
      };
    } catch (err) {
      console.warn('[Ergo CLI runs] Could not open agent event stream:', err);
    }
  };
  open();
  // Follow the bridge if discovery moves it to another port, and reopen once it is back after a fatal stream error.
  const unsubBridge = bridgeClient.subscribe((status) => {
    const url = bridgeClient.getApiUrl('/api/pty/events');
    const closed = !source || source.readyState === 2; // EventSource.CLOSED
    if (url !== openedUrl || (status.isConnected && closed)) open();
  });
  return () => {
    unsubBridge();
    try { source?.close(); } catch {}
  };
}

bridgeClient.subscribe calls the callback once right away, with an unchanged URL and an open source, so that first call does nothing.

### C18 [high] (security) src/lib/agentPipeline/toolExecutor.ts:72 — Read-only command check can be bypassed with a backslash-escaped quote, so arbitrary commands run unprompted (and even in Plan mode)
SCENARIO: splitCommandChain (line 72) and stripQuoted (line 112) treat a backslash-escaped quote outside quotes (\') as the start of a quoted string, but bash treats it as a literal character. I ran the extracted function: isReadOnlyCommand("echo \\'; touch /tmp/pwned; echo \\'") returns true, and the same for "echo \\' && touch y && echo \\'". In bash, `echo \'; touch /tmp/pwned; echo \'` runs the touch. permissionVerdict (line 195) returns 'allow' for read-only run_command whenever the level is not 'ask'. So a prompt-injected or misbehaving model can run any command without approval in acceptEdits, and even in Plan (read-only) mode. The old check rejected any raw `;`, `&`, `<`, `>` or backtick, so this is a regression introduced by the new chain support.
CORRECTED FIX: In src/lib/agentPipeline/toolExecutor.ts, isReadOnlyCommand (around line 154), reject any backslash next to the existing newline check. All three scanners (splitCommandChain, stripQuoted, and the stage splitter in isReadOnlyPart) assume an unescaped quote opens a quoted string, so a backslash anywhere can desync them from bash:

  if (/[\r\n]/.test(command)) return false;
+ // Backslash escapes (e.g. \' or \") would desync the quote-aware splitters below from bash; ask instead.
+ if (command.includes('\\')) return false;

The cost is that commands like grep 'a\|b' will ask for approval instead of being auto-allowed, which keeps the "errs on the side of asking" contract. The alternative, making all three scanners skip the escaped character outside single quotes (in stripQuoted, only match a quote that has no unescaped backslash before it), takes more code and is easier to get wrong.

### C19 [medium] (security) src/hooks/useCliAgentRuns.ts:667 — Hand-off messages typed into the manager end with Enter and can approve an open approval menu in non-bypass modes
SCENARIO: typeIntoAgent sends the message text and then '\r' 150 ms later, without checking the manager's pendingPrompt. It is called from reportWorkersToManager (line 732), the empty or invalid delegate.json path (line 1245) and the QA FAIL path (line 1319). Example: manager in Ask/acceptEdits mode writes an invalid delegate.json and goes on to a tool call, so Claude shows 'Do you want to proceed? ❯ 1. Yes 2. No'. Ergo then types 'Ergo: no valid workers… .ergo/runs/17-mg3x…/delegate.json…' followed by '\r'. The digits in the runId or worker count select a menu option, and the final Enter picks the highlighted 'Yes'. The command is approved without the user, in a mode where nothing should be auto-answered. Codex and Gemini menus have y/a/n hotkeys that the message's letters also hit.
CORRECTED FIX: The fix has two parts. Part 1 is required. Part 2 is an optional backstop for the ~600 ms detection lag, during which a new prompt is not yet in `pendingPrompt`.

**Part 1: defer hand-offs while a prompt is open** (src/hooks/useCliAgentRuns.ts)

1. Next to the other refs (~line 447), add:
```ts
const deferredInputRef = useRef<Map<string, string[]>>(new Map());
```

2. Replace `typeIntoAgent` (lines 667-672) with:
```ts
const typeLine = async (ptySessionId: string, message: string): Promise<boolean> => {
  const ok = await sendAgentInput(ptySessionId, message.replace(/[\r\n]+/g, ' '));
  if (!ok) return false;
  await sleep(150);
  return sendAgentInput(ptySessionId, '\r');
};
/** Type a one-line message into an agent's terminal and submit it — never into an open approval/question menu. */
const typeIntoAgent = async (ptySessionId: string, message: string): Promise<boolean> => {
  if (findSession(ptySessionId)?.pendingPrompt) {
    const q = deferredInputRef.current.get(ptySessionId) || [];
    q.push(message);
    deferredInputRef.current.set(ptySessionId, q);
    return true; // delivered once the prompt clears (see handlePrompt)
  }
  return typeLine(ptySessionId, message);
};
```

3. In `handlePrompt`, in the `if (!prompt) {` branch (~line 1169), before the `return`, add:
```ts
const queued = deferredInputRef.current.get(ptySessionId);
if (queued?.length) {
  deferredInputRef.current.delete(ptySessionId);
  void (async () => {
    for (const m of queued) {
      if (findSession(ptySessionId)?.pendingPrompt) {
        // a new prompt opened: re-queue the rest
        deferredInputRef.current.set(ptySessionId, [...(deferredInputRef.current.get(ptySessionId) || []), ...queued.slice(queued.indexOf(m))]);
        return;
      }
      await typeLine(ptySessionId, m);
    }
  })();
}
```

4. When a session is killed or cancelled (lines ~1923 and ~1946), also call:
```ts
deferredInputRef.current.delete(ptySessionId);
```

**Part 2 (optional): bridge backstop**

- In vite.config.ts `/api/pty/input` (~line 5138), after the session check, reject unflagged writes while a prompt is open:
```ts
if (session.prompt && body?.answer !== true) {
  return sendJson(res, 200, { success: false, error: 'An approval/question prompt is open.' });
}
```
- Make `sendAgentInput(sessionId, data, answer = false)` post `{ sessionId, data, answer }`.
- Pass `true` from the deliberate prompt answers:
  - the toast's Approve button (useCliAgentRuns.ts:1211)
  - `CliAgentNotesBridge` (CliAgentNotesBridge.tsx:287)

### C20 [medium] (security) vite.config.ts:5180 — /api/pty/policy with all:true also changes non-agent terminals (login/onboarding/credentials shells) to bypass and sends keystrokes to them
SCENARIO: applyPermissionLevel calls applyPermissionPolicy(level) with no target, which sends {all:true}. The bridge then targets every active session, including role-less legacy WS-spawned terminals: AiCredentialsModal/OnboardingModal `claude` login REPLs and any AgentTerminalPane shell. These keep running in the background after their WS closes. Setting Full access sets their permissionLevel to 'bypass', so tryAutoApprove answers 'y'/'Yes' to prompts in the user's own interactive terminals. For example, an apt '[Y/n]' in a bash terminal is detected as a confirmation with kind 'approval' and gets 'y'. runModeSwitch also injects shift+tab presses into a `claude` login REPL, or Ctrl+Y into a gemini one.
CORRECTED FIX: vite.config.ts, /api/pty/policy handler: change `targets = targets.filter((s) => s.isActive);` to `targets = targets.filter((s) => s.isActive && s.role);` so only task-agent sessions launched over REST get policy changes. Add a second guard in tryAutoApprove (vite.config.ts ~4531) to cover any path that sets permissionLevel: `if (!session.role || session.permissionLevel !== 'bypass' || prompt.kind !== 'approval' || isBypassAcceptanceDialog(prompt)) return false;`
