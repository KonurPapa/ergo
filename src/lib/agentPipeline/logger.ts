/**
 * Final step — Logger: writes the Build & Verification and Completion records from the CONDENSED
 * bible (pieces table + event log + QA verdict), never from raw transcripts.
 */
import { type AgentContextItem, type Subtask, type TaskItem, type OverviewDocument } from '../../types';
import { parseJsonLoose } from '../llmClient';
import { runSessionRetrospective, type RetrospectiveInput } from '../memory';
import { type PipelineContext, addUsage, emptyUsage, formatUsage, buildToolLoopRequest } from './contracts';
import { type BibleStore } from './bible';
import { type HardenerResult } from './hardener';
import { runToolLoop } from './providerLoop';
import { formatOverviewDocToMarkdown } from './summary';

const LOGGER_SYSTEM =
  `You are the Logger AI in Ergo's task execution pipeline. Write the completion log for a task that was just executed by a manager and its worker sub-agents.\n` +
  `The completion log is a SHORT note a human scans in a few seconds to confirm the work is right — not a log of the execution. ` +
  `Be accurate — do NOT fabricate details that are not in the event log, verification or QA sections. No code, no command output, no narrative of the process.\n\n` +
  `"completion" (markdown, under 120 words) uses exactly these bold headings:\n` +
  `**Summary:** one or two plain sentences: what now works.\n` +
  `**Changed:** at most 5 bullets, \`path\` — a few words (group related files).\n` +
  `**Verified:** one line: what was checked and the result (QA verdict included).\n` +
  `**Needs your review:** at most 3 "- [ ]" items, or "None".\n\n` +
  `"buildAndVerification" (markdown, at most 4 short bullets): pieces done, retries, how it was verified.\n` +
  `"createdFiles": every file created, written or modified (paths only).\n\n` +
  `HUMAN REVIEW:\n` +
  `- Needed for complex tasks, sensitive changes (auth, database schemas, billing, deletion, external API integrations, production deployments), QA verdicts other than pass, or if the task asked for human review.\n` +
  `- If needed: "needsHumanReview": true and at most 3 concrete, actionable "humanReviewSteps". Otherwise false and [].\n\n` +
  `Return ONLY valid JSON (no markdown fences) with exactly these fields:\n` +
  `{\n` +
  `  "buildAndVerification": "<at most 4 short bullets>",\n` +
  `  "completion": "<the short note described above>",\n` +
  `  "createdFiles": ["<path 1>", "<path 2>"],\n` +
  `  "needsHumanReview": <boolean>,\n` +
  `  "humanReviewSteps": ["<step 1>"]\n` +
  `}`;

export interface LoggerArgs {
  createdFiles: string[];
  usedToolCalling: boolean;
  hardener?: HardenerResult;
  qaAttempts: number;
  allScenariosPass: boolean;
  overviewDoc?: OverviewDocument;
}

export async function runLogger(
  ctx: PipelineContext,
  bible: BibleStore,
  args: LoggerArgs
): Promise<{ updatedBrief: AgentContextItem; updatedTask: TaskItem }> {
  const { task, brief, aiConfig } = ctx;
  const usage = emptyUsage();
  const buildDate = new Date().toISOString().split('T')[0];

  ctx.emit({
    id: 'step-logger',
    stage: 'built_record',
    agentRole: 'logger',
    title: 'Logger AI: Writing Completion Record',
    detail: 'Documenting what was built from the bible event log, listing artifacts, and evaluating human review requirements…',
    status: 'running'
  });

  const workerPatternNote = !args.usedToolCalling
    ? `\n\n> **Note — Text-Only Execution:** The configured model (${aiConfig.generalModel || aiConfig.model || 'unknown'}) does not support native tool-calling, so workers could only describe their work instead of executing tools. Results may differ from a full tool-calling execution — consider an Anthropic, OpenAI, Gemini or tool-capable Ollama model.`
    : '';

  const hardenerText = args.hardener
    ? `QA verdict: ${args.hardener.verdict.toUpperCase()}${args.hardener.failures.length ? `\nQA failures:\n${args.hardener.failures.map((f) => `- [${f.scenario}] ${f.diagnostics}`).join('\n')}` : ''}${args.hardener.evidence ? `\nQA evidence: ${args.hardener.evidence.slice(0, 1200)}` : ''}`
    : 'QA verdict: (hardener disabled)';

  const userPrompt =
    `TASK: "${task.title}" (#${task.id}) | Date: ${buildDate}\n` +
    `Provider: ${aiConfig.provider} / ${aiConfig.generalModel || aiConfig.model || 'default'}\n` +
    `Original Subtasks: ${task.subtasks.map((s) => `${s.isHumanReview ? '[human review] ' : ''}${s.text}`).join('; ') || 'none'}\n` +
    `Task is flagged for human review: ${task.isHumanReview ? 'YES' : 'NO'}\n` +
    `Manager attempts (QA retries): ${args.qaAttempts}\n` +
    `Manager verification: ${args.allScenariosPass ? 'all scenarios pass' : 'NOT all scenarios pass'}\n` +
    `Files written during execution: ${args.createdFiles.length > 0 ? args.createdFiles.join(', ') : 'none detected'}\n` +
    `Token usage (whole run): ${formatUsage(ctx.usage)}\n` +
    `Execution bible on disk: ${bible.filePath}\n\n` +
    `${hardenerText}\n\n` +
    `${bible.renderPieces()}\n${bible.renderEventLog()}\n` +
    `EXISTING OVERVIEW:\n${brief?.overview || brief?.brief || '(none)'}\n` +
    (workerPatternNote ? `\nIMPORTANT: At the END of the completion field, append this exact markdown note:\n${workerPatternNote}` : '');

  let buildAndVerificationContent = '';
  let completionContent = '';
  let needsHumanReview = false;
  let humanReviewSteps: string[] = [];
  let loggedCreatedFiles: string[] = [];

  try {
    const result = await runToolLoop(
      buildToolLoopRequest(ctx, 'logger', {
        stableSystem: LOGGER_SYSTEM,
        sharedContext: '',
        tools: [],
        initialUserMessage: userPrompt,
        maxRounds: 1,
        // A short note: a tight cap keeps a verbose model from spending output tokens on a log nobody reads.
        maxTokens: 1500,
        responseFormat: 'json'
      })
    );
    addUsage(usage, result.usage);
    const parsed = parseJsonLoose<any>(result.text);
    if (!parsed) throw new Error(result.error || 'Logger returned no JSON');
    buildAndVerificationContent = typeof parsed.buildAndVerification === 'string' ? parsed.buildAndVerification : '';
    completionContent = typeof parsed.completion === 'string' ? parsed.completion : '';
    needsHumanReview = Boolean(parsed.needsHumanReview);
    if (Array.isArray(parsed.humanReviewSteps)) humanReviewSteps = parsed.humanReviewSteps.filter((s: any) => typeof s === 'string' && s.trim().length > 0);
    if (Array.isArray(parsed.createdFiles)) loggedCreatedFiles = parsed.createdFiles.filter((s: any) => typeof s === 'string' && s.trim().length > 0);
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e;
    console.warn('[Ergo Logger] falling back to deterministic record:', e?.message || e);
    buildAndVerificationContent = `**Build Record (${buildDate}):**\n\n${bible.renderEventLog({ last: 6 })}`;
    completionContent = `**Completion (${buildDate}):**\n\n${args.allScenariosPass ? 'Manager verified all scenarios.' : 'Manager verification did not confirm all scenarios.'} ${hardenerText.split('\n')[0]}.${workerPatternNote}`;
  }
  addUsage(ctx.usage, usage);

  // Merge harness-detected files with Logger-reported ones.
  const allCreatedFiles = Array.from(new Set([...args.createdFiles, ...loggedCreatedFiles]));
  if (allCreatedFiles.length > 0 && !/\*\*changed:?\*\*|created file|artifacts/i.test(completionContent)) {
    const shown = allCreatedFiles.slice(0, 5).map((f) => `- [${f}](${f})`);
    if (allCreatedFiles.length > 5) shown.push(`- …and ${allCreatedFiles.length - 5} more`);
    completionContent += `\n\n**Changed:**\n${shown.join('\n')}`;
  }
  completionContent += `\n\nExecution bible: [TASK_CONTEXT.md](${bible.filePath})`;

  // QA outcome drives human review.
  if (args.hardener?.verdict === 'fail') {
    needsHumanReview = true;
    for (const f of args.hardener.failures) humanReviewSteps.push(`QA failed: ${f.scenario} — ${f.diagnostics.slice(0, 160)}`);
  } else if (args.hardener?.verdict === 'inconclusive') {
    needsHumanReview = true;
    humanReviewSteps.push(`Manually confirm QA: ${(args.hardener.evidence || 'the hardener could not obtain evidence').slice(0, 160)}`);
  }
  if (!args.allScenariosPass && !humanReviewSteps.some((s) => s.startsWith('Manager verification'))) {
    needsHumanReview = true;
    humanReviewSteps.push('Manager verification did not confirm every scenario — inspect the event log in TASK_CONTEXT.md.');
  }

  // Preserve existing human review subtasks and merge new ones.
  const existingHumanReviewSubtasks = task.subtasks.filter((s) => s.isHumanReview);
  const existingTexts = new Set(existingHumanReviewSubtasks.map((s) => s.text.trim().toLowerCase()));
  const combinedReviewSteps: string[] = [...existingHumanReviewSubtasks.map((s) => s.text)];
  for (const step of humanReviewSteps) {
    if (!existingTexts.has(step.trim().toLowerCase()) && !combinedReviewSteps.includes(step)) combinedReviewSteps.push(step);
  }

  const hasExplicitReviewRequest =
    Boolean(task.isHumanReview) ||
    task.title.toLowerCase().includes('human review') ||
    task.subtasks.some((s) => s.text.toLowerCase().includes('human review'));
  const hasAnyHumanReview = combinedReviewSteps.length > 0 || needsHumanReview || hasExplicitReviewRequest;

  const executedSubtasks = task.subtasks.filter((s) => !s.isHumanReview).map((s) => ({ ...s, isDone: true }));
  const reviewSubtasks: Subtask[] = combinedReviewSteps.map((stepText, idx) => ({
    id: `${task.id}-hr-${idx + 1}`,
    text: stepText,
    isDone: false,
    isHumanReview: true
  }));
  const allSubtasks = [...executedSubtasks, ...reviewSubtasks];

  // The review steps all become subtasks; the note only needs the first few.
  if (combinedReviewSteps.length > 0 && !/needs your review|human review/i.test(completionContent)) {
    const shown = combinedReviewSteps.slice(0, 3).map((s) => `- [ ] ${s}`);
    if (combinedReviewSteps.length > 3) shown.push(`- …and ${combinedReviewSteps.length - 3} more (see the task's review items)`);
    completionContent += `\n\n**Needs your review:**\n${shown.join('\n')}`;
  }

  // A user-written overview stays exactly as the user wrote it.
  const overviewContent =
    (brief?.overviewSource === 'user' ? brief.overview : '') ||
    (args.overviewDoc ? formatOverviewDocToMarkdown(args.overviewDoc) : '') ||
    brief?.overview ||
    brief?.brief ||
    '';

  ctx.emit({
    id: 'step-logger',
    stage: 'built_record',
    agentRole: 'logger',
    title: 'Logger AI: Completion Record Written',
    detail: reviewSubtasks.length > 0
      ? `Build record updated with ${reviewSubtasks.length} Human Review step(s) and ${allCreatedFiles.length} artifact(s).`
      : `Build & Verification and Completion sections updated for task #${task.id}.`,
    status: 'success',
    usage: { ...usage }
  });

  ctx.emit({
    id: 'step-done',
    stage: 'done',
    title: reviewSubtasks.length > 0 ? 'Task Built — Human Review Pending' : 'Task Execution Completed Successfully!',
    detail: (reviewSubtasks.length > 0
      ? `Task #${task.id} changes built. Generated ${reviewSubtasks.length} Human Review step(s) in TODO.md for user verification.`
      : `Item #${task.id} marked DONE. Agent build record saved to workspace.`) + ` Total usage: ${formatUsage(ctx.usage)}.`,
    status: 'success',
    usage: { ...ctx.usage },
    totalUsage: { ...ctx.usage },
    bibleFilePath: bible.filePath
  });

  const tokenComment = `<!-- task_token_usage: ${JSON.stringify(ctx.usage)} -->`;
  if (!buildAndVerificationContent.includes('<!-- task_token_usage:')) {
    buildAndVerificationContent = `${tokenComment}\n\n${buildAndVerificationContent}`.trim();
  }

  const updatedBrief: AgentContextItem = {
    ...brief,
    id: brief?.id || `brief_${task.id}`,
    sourceTaskId: task.id,
    sourceLaneId: task.swimLaneId || brief?.sourceLaneId,
    itemNumber: brief?.itemNumber,
    title: task.title,
    status: reviewSubtasks.length > 0 ? 'partly_done' : 'done',
    overview: overviewContent,
    buildAndVerification: buildAndVerificationContent,
    completion: completionContent,
    createdFiles: allCreatedFiles,
    totalUsage: { ...ctx.usage },
    brief: overviewContent,
    built: buildAndVerificationContent,
    validation: completionContent,
    humanReview: completionContent,
    followUps: completionContent
  };

  const updatedTask: TaskItem = {
    ...task,
    status: reviewSubtasks.length > 0 ? 'partly_done' : 'done',
    isDone: reviewSubtasks.length === 0,
    isHumanReview: hasAnyHumanReview,
    createdFiles: allCreatedFiles,
    totalUsage: { ...ctx.usage },
    subtasks: allSubtasks.length > 0 ? allSubtasks : task.subtasks.map((s) => ({ ...s, isDone: true }))
  };

  // ── Session Retrospective: distill durable learnings into vector memory ──
  try {
    const retroInput: RetrospectiveInput = {
      taskId: task.id,
      taskTitle: task.title,
      projectId: ctx.project.id,
      overview: overviewContent,
      buildLog: buildAndVerificationContent,
      completion: completionContent,
      createdFiles: allCreatedFiles,
      allScenariosPass: args.allScenariosPass,
      qaVerdict: args.hardener?.verdict,
      eventLog: bible.renderEventLog({ last: 20 }),
    };
    const storedCount = await runSessionRetrospective(retroInput);
    if (storedCount > 0) {
      ctx.emit({
        id: 'step-retrospective',
        stage: 'built_record',
        agentRole: 'logger',
        title: `Session Retrospective: ${storedCount} Learning(s) Stored`,
        detail: `Distilled ${storedCount} durable lesson(s) from this task execution into local vector memory (0 API tokens).`,
        status: 'success'
      });
    }
  } catch (err) {
    console.warn('[Ergo Logger] Session retrospective failed (non-fatal):', err);
  }

  return { updatedBrief, updatedTask };
}
