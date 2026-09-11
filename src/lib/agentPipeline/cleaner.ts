/**
 * Step 4 — Cleaner (coding tasks only): lint/format/tidy the files written this run without
 * changing behaviour. One isolated agent, write scope = exactly the created files.
 */
import { type TokenUsage } from '../../types';
import { type PipelineContext, type ToolDefinition, addUsage, emptyUsage, resolveRoleTarget } from './contracts';
import { type BibleStore } from './bible';
import { parseWorkerStatus } from './manager';
import { runToolLoop } from './providerLoop';
import { createToolExecutor } from './toolExecutor';
import { loadPipelineSkill } from './skills';

const CLEANER_RULES = `EXECUTION RULES (harness-enforced)
- You may modify ONLY the files listed in your input; other writes are rejected with an error.
- run_command may pause for user approval; a rejection is final for that call.
- Behaviour must not change. End with the condensed summary and the exact final line "STATUS: DONE" or "STATUS: FAILED — <reason>".`;

export async function runCleaner(
  ctx: PipelineContext,
  bible: BibleStore,
  tools: ToolDefinition[],
  createdFiles: string[],
  attempt: number
): Promise<{ summary: string; usage: TokenUsage }> {
  const usage = emptyUsage();
  const stepId = `step-cleaner-a${attempt}`;
  ctx.emit({
    id: stepId,
    stage: 'cleaner',
    agentRole: 'cleaner',
    title: 'Cleaner: Lint, Format & Tidy New Code',
    detail: `Tidying ${createdFiles.length} file(s) and running the project's lint/format scripts if present…`,
    status: 'running'
  });

  const cleanerTarget = resolveRoleTarget(ctx.aiConfig, 'cleaner');
  const skill = await loadPipelineSkill('cleaner-agent');
  const executor = createToolExecutor({
    ctx,
    tools,
    scope: { actorLabel: 'cleaner', readOnly: false, allowedWritePaths: createdFiles },
    agentRole: 'cleaner',
    stepIdPrefix: `step-tool-cleaner-a${attempt}`
  });
  const message =
    `## Files created or modified this run (your write scope)\n${createdFiles.map((f) => `- ${f}`).join('\n')}\n\n` +
    `Look for a package.json (or equivalent) in the nearest project root of these files; if it exposes format/lint/type-check scripts, run them with run_command and fix what they report in these files. Otherwise do a careful manual pass. Do not change behaviour.\n\n` +
    `${bible.renderEventLog({ last: 15 })}\n` +
    'Finish with a ≤150-word summary and the STATUS line.';

  const result = await runToolLoop({
    provider: cleanerTarget.provider,
    apiKey: cleanerTarget.apiKey,
    baseUrl: cleanerTarget.baseUrl,
    signal: ctx.signal,
    model: cleanerTarget.model,
    stableSystem: `${skill}\n\n${CLEANER_RULES}`,
    sharedContext: bible.renderStable(),
    tools,
    initialUserMessage: message,
    // Cap Cleaner rounds strictly: 4 rounds max for lint/formatting fixes
    maxRounds: Math.min(4, Math.max(2, ctx.options.maxToolRoundsPerAgent)),
    onToolCalls: executor
  });
  addUsage(usage, result.usage);
  addUsage(ctx.usage, usage);

  const status = parseWorkerStatus(result.text);
  const summary = result.text.replace(/^\s*STATUS:.*$/im, '').trim() || (result.error ? `Cleaner call failed: ${result.error}` : '(no summary)');
  const ok = result.stopReason !== 'error' && status.status !== 'FAILED';
  bible.appendEvent({ actor: 'cleaner', kind: 'cleaner', text: `${ok ? 'done' : `failed: ${status.reason || result.error || 'unknown'}`} — ${summary.slice(0, 600)}` });
  await bible.persist();
  ctx.emit({
    id: stepId,
    stage: 'cleaner',
    agentRole: 'cleaner',
    title: ok ? 'Cleaner: Code Tidied' : 'Cleaner: Finished With Issues',
    detail: summary.slice(0, 600),
    status: ok ? 'success' : 'warning',
    usage: { ...usage }
  });
  return { summary, usage };
}
