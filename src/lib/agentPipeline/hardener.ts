/**
 * Step 5 — Hardener: independent QA / eval harness. Read-only for files, may run commands.
 * Returns a strict verdict; failures carry actionable diagnostics that feed a fresh Step 3 retry.
 */
import { type TaskKind, type TokenUsage } from '../../types';
import { parseJsonLoose } from '../llmClient';
import { type PipelineContext, type ToolDefinition, addUsage, emptyUsage, buildToolLoopRequest } from './contracts';
import { type BibleStore } from './bible';
import { runToolLoop } from './providerLoop';
import { createToolExecutor } from './toolExecutor';
import { loadPipelineSkill } from './skills';

export interface HardenerResult {
  verdict: 'pass' | 'fail' | 'inconclusive';
  failures: Array<{ scenario: string; diagnostics: string }>;
  evidence: string;
  usage: TokenUsage;
}

const HARDENER_RULES = `EXECUTION RULES (harness-enforced)
- File writes are rejected in this phase; you may inspect and run commands only.
- run_command may pause for user approval; a rejection is final for that call.
- Return ONLY the verdict JSON from your skill — no prose, no fences.`;

export async function runHardener(
  ctx: PipelineContext,
  bible: BibleStore,
  tools: ToolDefinition[],
  taskKind: TaskKind,
  createdFiles: string[],
  attempt: number
): Promise<HardenerResult> {
  const usage = emptyUsage();
  const stepId = `step-hardener-a${attempt}`;
  ctx.emit({
    id: stepId,
    stage: 'hardener',
    agentRole: 'hardener',
    title: 'Hardener: QA / Eval Harness',
    detail: taskKind === 'coding'
      ? 'Acting as a human QA engineer: running the system through its UI/CLI to prove the scenarios pass…'
      : 'Acting as the human recipient: verifying every Then/And clause against the produced artifacts…',
    status: 'running'
  });

  const skill = await loadPipelineSkill('hardener-agent');
  // Full tool list (byte-stable prefix shared with the manager/workers); the scope blocks file writes.
  const executor = createToolExecutor({
    ctx,
    tools,
    scope: { actorLabel: 'hardener', readOnly: false, allowedWritePaths: [] },
    agentRole: 'hardener',
    stepIdPrefix: `step-tool-hardener-a${attempt}`
  });
  const message =
    `Perform QA for this run and return the verdict JSON.\n\n` +
    (createdFiles.length > 0 ? `### Files written this run\n${createdFiles.map((f) => `- ${f}`).join('\n')}\n\n` : '### Files written this run\n- (none recorded)\n\n') +
    `${bible.renderPieces()}\n${bible.renderEventLog({ last: 40 })}`;

  const result = await runToolLoop(
    buildToolLoopRequest(ctx, 'hardener', {
      stableSystem: `${skill}\n\n${HARDENER_RULES}`,
      sharedContext: bible.renderStable(),
      // Persona selection lives in the uncached tail so both cached blocks stay byte-identical across task kinds.
      volatileSystem:
        taskKind === 'coding'
          ? createdFiles.some((f) => /\.(html|htm|jsx|tsx|vue|svelte)$/i.test(f))
            ? 'ACTIVE PERSONA: Coding / Web tasks (human QA engineer operating the system via UI/CLI; use headless browser / Playwright via run_command to verify rendering and interactions if tooling is available).'
            : 'ACTIVE PERSONA: Coding tasks (human QA engineer operating the system via UI/CLI).'
          : 'ACTIVE PERSONA: Non-coding tasks (human recipient verifying the deliverable).',
      tools,
      initialUserMessage: message,
      // Cap Hardener rounds strictly: 6 rounds max to prevent endless loops and token burns
      maxRounds: Math.min(6, Math.max(3, ctx.options.maxToolRoundsPerAgent)),
      maxTokens: 8000,
      responseFormat: 'json',
      onToolCalls: executor
    })
  );
  addUsage(usage, result.usage);
  addUsage(ctx.usage, usage);

  const parsed = parseJsonLoose<any>(result.text);
  let verdict: HardenerResult['verdict'] = 'inconclusive';
  let failures: HardenerResult['failures'] = [];
  let evidence = '';
  if (parsed && typeof parsed === 'object') {
    const v = String(parsed.verdict ?? '').toLowerCase();
    if (v === 'pass' || v === 'fail' || v === 'inconclusive') verdict = v;
    failures = Array.isArray(parsed.failures)
      ? parsed.failures
          .map((f: any) => ({ scenario: String(f?.scenario ?? 'unspecified scenario'), diagnostics: String(f?.diagnostics ?? '') }))
          .filter((f: { diagnostics: string }) => f.diagnostics.trim().length > 0 || verdict === 'fail')
      : [];
    evidence = typeof parsed.evidence === 'string' ? parsed.evidence : JSON.stringify(parsed.evidence ?? '');
    if (verdict === 'fail' && failures.length === 0) failures = [{ scenario: 'unspecified', diagnostics: evidence || 'Hardener reported fail without details.' }];
  } else {
    evidence = result.error ? `Hardener call failed: ${result.error}` : result.text.slice(0, 1500);
  }

  bible.appendEvent({
    actor: 'hardener',
    kind: verdict === 'fail' ? 'qa_fail' : 'qa_pass',
    text: `${verdict.toUpperCase()}${failures.length ? ` — ${failures.map((f) => `[${f.scenario}] ${f.diagnostics}`).join(' || ')}` : ''}${evidence ? ` | evidence: ${evidence.slice(0, 700)}` : ''}`
  });
  await bible.persist();
  ctx.emit({
    id: stepId,
    stage: 'hardener',
    agentRole: 'hardener',
    title: verdict === 'pass' ? 'Hardener: QA Passed' : verdict === 'fail' ? `Hardener: QA Failed (${failures.length} issue${failures.length === 1 ? '' : 's'})` : 'Hardener: QA Inconclusive',
    detail: (failures.length > 0 ? failures.map((f) => `✗ ${f.scenario}: ${f.diagnostics}`).join('\n') + '\n\n' : '') + evidence.slice(0, 800),
    status: verdict === 'pass' ? 'success' : 'warning',
    usage: { ...usage }
  });
  return { verdict, failures, evidence, usage };
}
