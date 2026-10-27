/**
 * Step 5 — Verifier: independent verification harness. Read-only for files, may run commands.
 * Returns a strict verdict; failures carry actionable diagnostics that feed a fresh Step 3 retry.
 */
import { type TaskKind, type TokenUsage } from '../../types';
import { parseJsonLoose } from '../llmClient';
import { type PipelineContext, type ToolDefinition, addUsage, emptyUsage, buildToolLoopRequest } from './contracts';
import { type BibleStore } from './bible';
import { runToolLoop } from './providerLoop';
import { createToolExecutor } from './toolExecutor';
import { loadPipelineSkill } from './skills';

export interface VerifierResult {
  verdict: 'pass' | 'fail' | 'inconclusive';
  failures: Array<{ criterion: string; diagnostics: string }>;
  evidence: string;
  usage: TokenUsage;
}

const VERIFIER_RULES = `EXECUTION RULES (harness-enforced)
- File writes are rejected in this phase; you may inspect and run commands only.
- run_command may pause for user approval; a rejection is final for that call.
- Return ONLY the verdict JSON from your skill — no prose, no fences.`;

export async function runVerifier(
  ctx: PipelineContext,
  bible: BibleStore,
  tools: ToolDefinition[],
  taskKind: TaskKind,
  createdFiles: string[],
  attempt: number
): Promise<VerifierResult> {
  const usage = emptyUsage();
  const stepId = `step-verifier-a${attempt}`;
  ctx.emit({
    id: stepId,
    stage: 'verifier',
    agentRole: 'verifier',
    title: 'Verifier: verification harness',
    detail: taskKind === 'coding'
      ? 'Acting as a human verifier engineer: running the system through its UI/CLI to prove every "Done when" criterion holds…'
      : 'Acting as the human recipient: verifying every "Done when" criterion against the produced artifacts…',
    status: 'running'
  });

  const skill = await loadPipelineSkill('verifier-agent');
  // Full tool list (byte-stable prefix shared with the manager/workers); the scope blocks file writes.
  const executor = createToolExecutor({
    ctx,
    tools,
    scope: { actorLabel: 'verifier', readOnly: false, allowedWritePaths: [] },
    agentRole: 'verifier',
    stepIdPrefix: `step-tool-verifier-a${attempt}`
  });
  const message =
    `Perform verifier for this run and return the verdict JSON.\n\n` +
    (createdFiles.length > 0 ? `### Files written this run\n${createdFiles.map((f) => `- ${f}`).join('\n')}\n\n` : '### Files written this run\n- (none recorded)\n\n') +
    `${bible.renderPieces()}\n${bible.renderEventLog({ last: 40 })}`;

  const result = await runToolLoop(
    buildToolLoopRequest(ctx, 'verifier', {
      stableSystem: `${skill}\n\n${VERIFIER_RULES}`,
      sharedContext: bible.renderStable(),
      // Persona selection lives in the uncached tail so both cached blocks stay byte-identical across task kinds.
      volatileSystem:
        taskKind === 'coding'
          ? createdFiles.some((f) => /\.(html|htm|jsx|tsx|vue|svelte)$/i.test(f))
            ? 'ACTIVE PERSONA: Coding / Web tasks (human verifier engineer operating the system via UI/CLI; use headless browser / Playwright via run_command to verify rendering and interactions if tooling is available).'
            : 'ACTIVE PERSONA: Coding tasks (human verifier engineer operating the system via UI/CLI).'
          : 'ACTIVE PERSONA: Non-coding tasks (human recipient verifying the deliverable).',
      tools,
      initialUserMessage: message,
      // Cap Verifier rounds strictly: 6 rounds max to prevent endless loops and token burns
      maxRounds: Math.min(6, Math.max(3, ctx.options.maxToolRoundsPerAgent)),
      maxTokens: 8000,
      responseFormat: 'json',
      onToolCalls: executor,
      // Once the manager is done, the user's messages for it reach verifier (e.g. "also check X").
      drainSteering: () => ctx.steering?.drainTexts('verifier') ?? []
    })
  );
  addUsage(usage, result.usage);
  addUsage(ctx.usage, usage);

  const parsed = parseJsonLoose<any>(result.text);
  let verdict: VerifierResult['verdict'] = 'inconclusive';
  let failures: VerifierResult['failures'] = [];
  let evidence = '';
  if (parsed && typeof parsed === 'object') {
    const v = String(parsed.verdict ?? '').toLowerCase();
    if (v === 'pass' || v === 'fail' || v === 'inconclusive') verdict = v;
    failures = Array.isArray(parsed.failures)
      ? parsed.failures
          .map((f: any) => ({ criterion: String(f?.criterion ?? 'unspecified criterion'), diagnostics: String(f?.diagnostics ?? '') }))
          .filter((f: { diagnostics: string }) => f.diagnostics.trim().length > 0 || verdict === 'fail')
      : [];
    evidence = typeof parsed.evidence === 'string' ? parsed.evidence : JSON.stringify(parsed.evidence ?? '');
    if (verdict === 'fail' && failures.length === 0) failures = [{ criterion: 'unspecified', diagnostics: evidence || 'Verifier reported fail without details.' }];
  } else {
    evidence = result.error ? `Verifier call failed: ${result.error}` : result.text.slice(0, 1500);
  }

  bible.appendEvent({
    actor: 'verifier',
    kind: verdict === 'fail' ? 'verifier_fail' : 'verifier_pass',
    text: `${verdict.toUpperCase()}${failures.length ? ` — ${failures.map((f) => `[${f.criterion}] ${f.diagnostics}`).join(' || ')}` : ''}${evidence ? ` | evidence: ${evidence.slice(0, 700)}` : ''}`
  });
  await bible.persist();
  ctx.emit({
    id: stepId,
    stage: 'verifier',
    agentRole: 'verifier',
    title: verdict === 'pass' ? 'Verifier: Verifier Passed' : verdict === 'fail' ? `Verifier: Verifier Failed (${failures.length} issue${failures.length === 1 ? '' : 's'})` : 'Verifier: Verifier Inconclusive',
    detail: (failures.length > 0 ? failures.map((f) => `✗ ${f.criterion}: ${f.diagnostics}`).join('\n') + '\n\n' : '') + evidence.slice(0, 800),
    status: verdict === 'pass' ? 'success' : 'warning',
    usage: { ...usage }
  });
  return { verdict, failures, evidence, usage };
}
