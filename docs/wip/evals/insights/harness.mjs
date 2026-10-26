// Insight-memory A/B: Mem0 OSS (3.3.1) vs an in-house reconcile-on-write store.
// Both routes get the same LLM (Claude Haiku via `claude -p`) and the same embedder (Ergo's all-MiniLM-L6-v2);
// only the memory algorithm differs.
//   node harness.mjs <route> <rep>      route: mem0 | mem0custom | ergo
// Writes results/<route>-<rep>.json: final store, per-write cost / latency, probe retrievals.
process.env.MEM0_TELEMETRY = 'false';

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { EVENTS, PROBES } from './data.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const [route, rep = '1'] = process.argv.slice(2);
const K = 8;

// ── LLM: Claude Haiku through the CLI ──
const usage = { calls: 0, cost: 0, inTok: 0, outTok: 0 };
function llm(system, user) {
  const sysFile = path.join(os.tmpdir(), `sys-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(sysFile, system);
  return new Promise((resolve, reject) => {
    const p = spawn('claude', ['-p', '--model', 'haiku', '--tools', '', '--strict-mcp-config', '--no-session-persistence',
      '--disable-slash-commands', '--output-format', 'json', '--system-prompt-file', sysFile], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', () => {
      fs.rmSync(sysFile, { force: true });
      try {
        const d = JSON.parse(out);
        usage.calls++;
        usage.cost += d.total_cost_usd || 0;
        usage.inTok += (d.usage?.input_tokens || 0) + (d.usage?.cache_read_input_tokens || 0) + (d.usage?.cache_creation_input_tokens || 0);
        usage.outTok += d.usage?.output_tokens || 0;
        resolve(String(d.result || ''));
      } catch (e) {
        reject(new Error(`claude -p failed: ${err.slice(0, 300)} ${out.slice(0, 300)}`));
      }
    });
    p.stdin.end(user);
  });
}

// ── Embeddings: same model, pooling and cache dir as Ergo's bridge ──
const tf = await import('/home/konur/Documents/Ergo/node_modules/@huggingface/transformers/dist/transformers.node.mjs');
tf.env.cacheDir = path.join(os.homedir(), '.ergo', 'models');
tf.env.allowLocalModels = false;
const pipe = await tf.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'fp32' });
async function embed(texts) {
  const out = await pipe(texts, { pooling: 'mean', normalize: true });
  return out.tolist();
}
const cos = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

const probeQuery = (pr) => [pr.title, ...pr.subtasks].join('\n');
const result = { route, rep, writes: [], store: {}, probes: [] };

// ═══ Route: Mem0 ═══
async function runMem0(custom) {
  // OpenAI-compatible shim so Mem0's stock openai LLM and huggingface (TEI) embedder providers reach Haiku / MiniLM.
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const j = JSON.parse(body || '{}');
    res.setHeader('Content-Type', 'application/json');
    try {
      if (req.url.endsWith('/embeddings')) {
        const inputs = Array.isArray(j.input) ? j.input : [j.input];
        const vecs = await embed(inputs);
        // The OpenAI SDK asks for base64 by default and decodes it itself.
        const enc = (v) => (j.encoding_format === 'base64' ? Buffer.from(new Float32Array(v).buffer).toString('base64') : v);
        res.end(JSON.stringify({ object: 'list', data: vecs.map((v, index) => ({ object: 'embedding', embedding: enc(v), index })), model: 'minilm' }));
      } else {
        const system = j.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
        const user = j.messages.filter((m) => m.role !== 'system').map((m) => m.content).join('\n\n');
        const text = await llm(`${system}\n\nRespond with a single JSON object only.`, user);
        res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 0, model: 'haiku',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }] }));
      }
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { message: String(e) } }));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const dir = path.join(HERE, 'stores', `${route}-${rep}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const { Memory } = await import('mem0ai/oss');
  const memory = new Memory({
    embedder: { provider: 'huggingface', config: { baseURL: base, model: 'minilm', embeddingDims: 384 } },
    vectorStore: { provider: 'memory', config: { collectionName: 'insights', dimension: 384, dbPath: path.join(dir, 'vectors.db') } },
    llm: { provider: 'openai', config: { baseURL: base, apiKey: 'local', model: 'haiku' } },
    historyDbPath: path.join(dir, 'history.db'),
    // Mem0's supported customization: steer extraction to our use case (fair best effort).
    ...(custom ? { customInstructions: CUSTOM_INSTRUCTIONS } : {}),
  });

  for (const [i, ev] of EVENTS.slice(0, Number(process.env.LIMIT) || EVENTS.length).entries()) {
    const before = { ...usage };
    const t0 = Date.now();
    const r = await memory.add(
      [
        { role: 'assistant', content: `Finished the task "${ev.task}". What I did: ${ev.summary}` },
        { role: 'user', content: ev.followup },
      ],
      { userId: ev.p }
    );
    result.writes.push({ i, p: ev.p, ms: Date.now() - t0, calls: usage.calls - before.calls, cost: usage.cost - before.cost,
      ops: (r.results || []).map((m) => ({ op: m.metadata?.event || 'ADD', text: m.memory })) });
    console.log(`[${route}] write ${i} (${ev.p}): +${(r.results || []).length}`);
  }
  for (const p of ['ledgerly', 'inkwell']) {
    const all = await memory.getAll({ filters: { user_id: p }, topK: 500 });
    result.store[p] = (all.results || all).map((m) => ({ id: m.id, text: m.memory }));
  }
  for (const pr of PROBES) {
    const t0 = Date.now();
    const r = await memory.search(probeQuery(pr), { filters: { user_id: pr.p }, topK: K });
    result.probes.push({ title: pr.title, p: pr.p, ms: Date.now() - t0, hits: (r.results || r).map((m) => ({ id: m.id, text: m.memory, score: m.score })) });
    // Mem0's default threshold (0.1) often returns fewer than K: also record it with the threshold off.
    const r0 = await memory.search(probeQuery(pr), { filters: { user_id: pr.p }, topK: K, threshold: 0 });
    (result.probesT0 ||= []).push({ title: pr.title, p: pr.p, hits: (r0.results || r0).map((m) => ({ id: m.id, text: m.memory, score: m.score })) });
  }
  server.close();
}

const CUSTOM_INSTRUCTIONS = `These conversations are between an AI coding agent that just finished a task in a software project and the project's owner, who reviews the result.
Extract ONLY durable requirements, conventions and preferences that should change how FUTURE tasks in this project are done: tooling and commands, code conventions, architecture rules, where things live, things never to do, workflow rules (verification, git), product rules (locale, copy style).
Do NOT extract: one-off changes to the task just finished (colours, wording, chart types, layout of one screen), bug reports about it, scope additions, approvals, questions, or what the agent did.
Write each memory as one imperative, specific rule (names, paths, commands), at most 30 words.`;

// ═══ Route: in-house (reconcile on write) ═══
const ERGO_SYSTEM = `You maintain a short list of durable lessons about how the user wants work done in ONE software project. An AI agent just finished a task and the user sent the follow-up below. Decide whether it reveals a lasting requirement, convention or preference that should change how FUTURE tasks in this project are done.

Save only what still applies to other tasks: tooling and commands, code conventions, architecture rules, where things live, things never to do, workflow rules (verification, git), product rules (locale, copy style).
Do NOT save: one-off changes to this task (colours, wording, chart type, layout of one screen), bug reports about this task, scope additions, approvals, questions, or what the agent did.

Keep the list small and current. The project's existing lessons are listed with ids:
- The follow-up repeats an existing lesson → {"op":"confirm","id"} (never add it again).
- It refines or extends an existing lesson → {"op":"update","id","text","scope"} with the full new text.
- It makes an existing lesson wrong → update it if part of it still holds, else {"op":"delete","id"}. Also update lessons that mention something the follow-up replaced (an old tool, command or path).
- Something new and durable → {"op":"add","text","scope"}.
Each lesson: one imperative sentence, specific (names, paths, commands), at most 30 words.
scope: "always" if it applies to nearly every task in this project (package manager, verification steps, git workflow), else "topical".

Reply with one JSON object only: {"ops":[...]} — {"ops":[]} when nothing durable.`;

const DUP_COS = 0.9; // zero-token guard: an "add" this close to an existing lesson is a confirm
const MAX_CONTEXT_LESSONS = 40; // whole list when small (typical), else the nearest ones + every "always" lesson

async function runErgo() {
  const lessons = []; // { id, p, text, scope, vec, confirms, updatedAt }
  let seq = 0;
  for (const [i, ev] of EVENTS.slice(0, Number(process.env.LIMIT) || EVENTS.length).entries()) {
    const before = { ...usage };
    const t0 = Date.now();
    let mine = lessons.filter((l) => l.p === ev.p);
    if (mine.length > MAX_CONTEXT_LESSONS) {
      const [q] = await embed([`${ev.task}\n${ev.followup}`]);
      const always = mine.filter((l) => l.scope === 'always');
      const near = mine.filter((l) => l.scope !== 'always').sort((a, b) => cos(q, b.vec) - cos(q, a.vec));
      mine = [...always, ...near].slice(0, MAX_CONTEXT_LESSONS);
    }
    const user = [
      `EXISTING LESSONS:\n${mine.length ? mine.map((l) => `[${l.id}] (${l.scope}) ${l.text}`).join('\n') : '(none)'}`,
      `TASK JUST FINISHED: ${ev.task}\nWHAT THE AGENT DID: ${ev.summary}`,
      `USER'S FOLLOW-UP:\n${ev.followup}`,
    ].join('\n\n');
    const raw = await llm(ERGO_SYSTEM, user);
    let ops = [];
    try {
      ops = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)).ops || [];
    } catch {
      console.warn(`[ergo] unparseable: ${raw.slice(0, 200)}`);
    }
    const applied = [];
    for (const op of ops) {
      const target = lessons.find((l) => l.id === op.id && l.p === ev.p);
      if (op.op === 'add' && op.text) {
        const [v] = await embed([op.text]);
        const dup = lessons.filter((l) => l.p === ev.p).find((l) => cos(v, l.vec) >= DUP_COS);
        if (dup) {
          dup.confirms++;
          applied.push({ op: 'CONFIRM(guard)', id: dup.id, text: dup.text });
          continue;
        }
        const l = { id: `L${++seq}`, p: ev.p, text: op.text, scope: op.scope === 'always' ? 'always' : 'topical', vec: v, confirms: 1, updatedAt: i };
        lessons.push(l);
        applied.push({ op: 'ADD', id: l.id, text: l.text, scope: l.scope });
      } else if (op.op === 'update' && target && op.text) {
        const prev = target.text;
        target.text = op.text;
        [target.vec] = await embed([op.text]);
        if (op.scope) target.scope = op.scope === 'always' ? 'always' : 'topical';
        target.updatedAt = i;
        target.confirms++;
        applied.push({ op: 'UPDATE', id: target.id, text: op.text, prev });
      } else if (op.op === 'delete' && target) {
        lessons.splice(lessons.indexOf(target), 1);
        applied.push({ op: 'DELETE', id: target.id, text: target.text });
      } else if (op.op === 'confirm' && target) {
        target.confirms++;
        applied.push({ op: 'CONFIRM', id: target.id, text: target.text });
      }
    }
    result.writes.push({ i, p: ev.p, ms: Date.now() - t0, calls: usage.calls - before.calls, cost: usage.cost - before.cost, ops: applied });
    console.log(`[ergo] write ${i} (${ev.p}): ${applied.map((a) => a.op).join(', ') || '-'}`);
  }
  for (const p of ['ledgerly', 'inkwell']) {
    result.store[p] = lessons.filter((l) => l.p === p).map((l) => ({ id: l.id, text: l.text, scope: l.scope, confirms: l.confirms }));
  }
  // Retrieval: "always" lessons first (at most 4, most-confirmed), then the nearest topical ones; K in total.
  // `probesSim` = the same store with plain similarity top-K (ablation: does the scope flag matter?).
  result.probesSim = [];
  for (const pr of PROBES) {
    const t0 = Date.now();
    const [q] = await embed([probeQuery(pr)]);
    const mine = lessons.filter((l) => l.p === pr.p).map((l) => ({ ...l, score: cos(q, l.vec) }));
    const always = mine.filter((l) => l.scope === 'always').sort((a, b) => b.confirms - a.confirms).slice(0, 4);
    const topical = mine.filter((l) => !always.includes(l) && l.score >= 0.2).sort((a, b) => b.score - a.score);
    const hits = [...always, ...topical].slice(0, K);
    result.probes.push({ title: pr.title, p: pr.p, ms: Date.now() - t0, hits: hits.map((l) => ({ id: l.id, text: l.text, score: l.score })) });
    const sim = [...mine].sort((a, b) => b.score - a.score).slice(0, K);
    result.probesSim.push({ title: pr.title, p: pr.p, hits: sim.map((l) => ({ id: l.id, text: l.text, score: l.score })) });
  }
}

if (route === 'mem0') await runMem0(false);
else if (route === 'mem0custom') await runMem0(true);
else if (route === 'ergo') await runErgo();
else throw new Error(`unknown route ${route}`);

result.usage = usage;
fs.mkdirSync(path.join(HERE, 'results'), { recursive: true });
fs.writeFileSync(path.join(HERE, 'results', `${route}-${rep}.json`), JSON.stringify(result, null, 2));
console.log(`[${route}] done: ${usage.calls} calls, $${usage.cost.toFixed(4)}`);
process.exit(0);
