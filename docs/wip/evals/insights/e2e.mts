// End-to-end replay of the A/B scenario through the shipped code: insights.ts (trivial filter, prompt, parser,
// rule block) + memoryStore.ts (apply, duplicate guard, read path). Only the model transport differs: Haiku via
// `claude -p` instead of callAiEngine. Writes results/ergoprod-<rep>.json in the harness format (judge.mjs scores it).
//   node e2e.mts <rep>
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryStore } from '/home/konur/Documents/Ergo/src/lib/memory/memoryStore.ts';
import { EVENTS, PROBES } from './data.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const rep = process.argv[2] || '1';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ergo-e2e-'));
const io = {
  readText: async (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null),
  readBytes: async (f: string) => (fs.existsSync(f) ? new Uint8Array(fs.readFileSync(f)) : null),
  writeAtomic: async (f: string, d: string | Uint8Array) => fs.writeFileSync(f, d),
  writeAtomicSync: (f: string, d: string | Uint8Array) => fs.writeFileSync(f, d),
};
const store = createMemoryStore({ dir, chunksFile: path.join(dir, 'c.json'), vectorsFile: path.join(dir, 'v.f32'), modelsDir: path.join(os.homedir(), '.ergo', 'models'), io, log: () => {} });

// The embedding model loads first: the browser stubs insights.ts needs would make transformers.js think it's in a browser.
await store.embed(['warm up']);
await import('./env.mjs');
const ins = await import('./insights.bundle.mjs');

const usage = { calls: 0, cost: 0, inTok: 0, outTok: 0 };
function llm(system: string, user: string): string {
  const p = spawnSync('claude', ['-p', '--model', 'haiku', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands',
    '--output-format', 'json', '--system-prompt', system], { input: user, encoding: 'utf8' });
  const d = JSON.parse(p.stdout);
  usage.calls++;
  usage.cost += d.total_cost_usd || 0;
  usage.inTok += (d.usage?.input_tokens || 0) + (d.usage?.cache_read_input_tokens || 0) + (d.usage?.cache_creation_input_tokens || 0);
  usage.outTok += d.usage?.output_tokens || 0;
  return String(d.result || '');
}

const result: any = { route: 'ergoprod', rep, writes: [], store: {}, probes: [] };
for (const [i, ev] of EVENTS.entries()) {
  const t0 = Date.now();
  const fb = { projectId: ev.p, taskId: String(i), taskTitle: ev.task, summary: ev.summary, runId: `run${i}`, phase: 'post-run', message: ev.followup };
  if (ins.isTrivialFeedback(fb.message)) {
    result.writes.push({ i, p: ev.p, ms: 0, calls: 0, ops: [], skipped: 'trivial' });
    console.log(`[e2e] ${i}: skipped (trivial)`);
    continue;
  }
  const rules = await store.listInsights(ev.p);
  const { prompt, ids } = ins.buildDistillPrompt(rules, fb);
  const raw = llm(ins.DISTILL_SYSTEM, prompt);
  const ops = ins.parseDistillOps(raw, ids);
  const res = await store.applyInsightOps(ev.p, ops, { origin: 'learned', taskId: fb.taskId, taskTitle: fb.taskTitle, runId: fb.runId });
  result.writes.push({ i, p: ev.p, ms: Date.now() - t0, calls: 1, ops: res.changes.map((c: any) => ({ op: c.kind, text: c.insight.text })) });
  console.log(`[e2e] ${i}: ${res.changes.map((c: any) => c.kind).join(', ') || '-'}`);
}
for (const p of ['ledgerly', 'inkwell']) result.store[p] = (await store.listInsights(p)).map((r: any) => ({ id: r.id, text: r.text, scope: r.scope, confirms: r.confirms }));
const blocks: number[] = [];
for (const pr of PROBES) {
  // The bridge's /api/memory/related builds the rule query from the task's title, subtasks and text.
  const hits = await store.insightsForTask(pr.p, [pr.title, ...pr.subtasks].join('\n'));
  blocks.push(ins.formatProjectRules(hits).length);
  result.probes.push({ title: pr.title, p: pr.p, hits: hits.map((r: any) => ({ id: r.id, text: r.text })) });
}
result.usage = usage;
result.ruleBlockChars = blocks;
fs.writeFileSync(path.join(HERE, 'results', `ergoprod-${rep}.json`), JSON.stringify(result, null, 2));
fs.rmSync(dir, { recursive: true, force: true });
console.log(`[e2e] done: ${usage.calls} calls, $${usage.cost.toFixed(4)}, rule block ${Math.min(...blocks)}–${Math.max(...blocks)} chars`);
process.exit(0);
