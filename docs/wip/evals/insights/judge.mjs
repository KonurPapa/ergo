// Labels every stored memory of every results/*.json with a Sonnet judge, then scores store quality and retrieval.
//   node judge.mjs            → results/labels.json (cached per run+project) and the score table
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ALWAYS, GOLD, PROBES, SUPERSEDED } from './data.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const RES = path.join(HERE, 'results');
const labelsFile = path.join(RES, 'labels.json');
const labels = fs.existsSync(labelsFile) ? JSON.parse(fs.readFileSync(labelsFile, 'utf8')) : {};

const SYSTEM = `You grade the contents of an AI coding agent's long-term memory for one software project. The memory should hold only durable rules about how the user wants work done in that project, so that future tasks follow them.

You get the project's GOLD rules (the current truth), the SUPERSEDED instructions (true once, wrong now), and the stored memories. Label every memory:
- gold: ids of the GOLD rules the memory states or clearly instructs (partial or older wording counts). Empty if none.
- stale: true if the memory tells the agent to follow a SUPERSEDED instruction (e.g. use pnpm, run a pnpm command, don't commit) without saying it no longer applies. A memory can be both gold and stale (e.g. "never hand-edit generated code; regenerate with pnpm gen:api").
- noise: true if the memory is not a durable rule for future tasks: a narrative of what the agent did, a one-off change to a single task (a colour, a chart type, a wording fix, a bug in one feature), or a fact with no instruction value. A memory that states a gold rule is not noise even if it also contains narrative.`;

const SCHEMA = {
  type: 'object',
  properties: {
    labels: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, gold: { type: 'array', items: { type: 'string' } }, stale: { type: 'boolean' }, noise: { type: 'boolean' } },
        required: ['id', 'gold', 'stale', 'noise'],
      },
    },
  },
  required: ['labels'],
};

function judge(project, store) {
  const user = [
    `PROJECT: ${project}`,
    `GOLD RULES:\n${Object.entries(GOLD[project]).map(([k, v]) => `${k}: ${v}`).join('\n')}`,
    `SUPERSEDED INSTRUCTIONS:\n${SUPERSEDED.filter((s) => s.startsWith(project)).join('\n') || '(none)'}`,
    `STORED MEMORIES:\n${store.map((m) => `[${m.id}] ${m.text}`).join('\n')}`,
  ].join('\n\n');
  const p = spawnSync('claude', ['-p', '--model', 'sonnet', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands',
    '--output-format', 'json', '--system-prompt', SYSTEM, '--json-schema', JSON.stringify(SCHEMA)], { input: user, encoding: 'utf8', maxBuffer: 1 << 26 });
  const d = JSON.parse(p.stdout);
  return Object.fromEntries(d.structured_output.labels.map((l) => [l.id, l]));
}

const runs = fs.readdirSync(RES).filter((f) => /^(ergo|ergoprod|mem0|mem0custom)-\d+\.json$/.test(f)).sort();
for (const f of runs) {
  const r = JSON.parse(fs.readFileSync(path.join(RES, f), 'utf8'));
  for (const project of Object.keys(GOLD)) {
    const key = `${f}:${project}`;
    if (labels[key] || !r.store[project]?.length) continue;
    console.error(`judging ${key} (${r.store[project].length} memories)`);
    labels[key] = judge(project, r.store[project]);
    fs.writeFileSync(labelsFile, JSON.stringify(labels, null, 2));
  }
}

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const rows = [];
for (const f of runs) {
  const r = JSON.parse(fs.readFileSync(path.join(RES, f), 'utf8'));
  // The judge sometimes echoes long ids without their prefix: match on the suffix.
  const lab = (p, id) => {
    const set = labels[`${f}:${p}`] || {};
    return set[id] || Object.entries(set).find(([k]) => k.length >= 8 && id.endsWith(k))?.[1] || { gold: [], stale: false, noise: true };
  };
  const s = { size: 0, covered: 0, goldTotal: 0, stale: 0, noise: 0, dup: 0 };
  for (const p of Object.keys(GOLD)) {
    const store = r.store[p] || [];
    s.size += store.length;
    s.goldTotal += Object.keys(GOLD[p]).length;
    const per = {};
    for (const m of store) {
      const l = lab(p, m.id);
      if (l.stale) s.stale++;
      if (l.noise) s.noise++;
      if (!l.stale) for (const g of l.gold) per[g] = (per[g] || 0) + 1;
    }
    s.covered += Object.keys(per).length;
    s.dup += Object.values(per).reduce((a, n) => a + Math.max(0, n - 1), 0);
  }
  const scoreProbes = (list) => {
    const out = { recall: [], stale: [], noise: [], n: [], chars: [] };
    for (const [i, pr] of PROBES.entries()) {
      const hits = list?.[i]?.hits || [];
      const need = new Set([...pr.gold, ...ALWAYS[pr.p]]);
      const got = new Set();
      let stale = 0, noise = 0;
      for (const h of hits) {
        const l = lab(pr.p, h.id);
        if (l.stale) stale++;
        if (l.noise) noise++;
        if (!l.stale) l.gold.forEach((g) => need.has(g) && got.add(g));
      }
      out.recall.push(got.size / need.size);
      out.stale.push(stale);
      out.noise.push(noise);
      out.n.push(hits.length);
      out.chars.push(hits.reduce((a, h) => a + h.text.length, 0));
    }
    return { recall: avg(out.recall), stale: avg(out.stale), noise: avg(out.noise), n: avg(out.n), chars: avg(out.chars) };
  };
  const writes = r.writes || [];
  rows.push({
    run: f.replace('.json', ''),
    ...s,
    cost: r.usage.cost,
    inTokPerWrite: r.usage.inTok / Math.max(1, writes.length),
    msPerWrite: avg(writes.map((w) => w.ms)),
    retrieval: scoreProbes(r.probes),
    retrievalAlt: scoreProbes(r.probesSim || r.probesT0),
  });
}

const fmt = (x, d = 2) => (typeof x === 'number' ? x.toFixed(d) : x);
console.log('\nSTORE (both projects, 14 gold rules)');
console.log('run           size  gold-covered  stale  noise  dups   $total  in-tok/write  s/write');
for (const r of rows) {
  console.log(`${r.run.padEnd(13)} ${String(r.size).padStart(4)}  ${`${r.covered}/${r.goldTotal}`.padStart(12)}  ${String(r.stale).padStart(5)}  ${String(r.noise).padStart(5)}  ${String(r.dup).padStart(4)}  ${fmt(r.cost, 4).padStart(7)}  ${fmt(r.inTokPerWrite, 0).padStart(12)}  ${fmt(r.msPerWrite / 1000, 1).padStart(7)}`);
}
console.log('\nRETRIEVAL (7 upcoming tasks, K=8; recall of needed rules incl. always-rules; per-probe averages)');
console.log('run           variant      recall  stale  noise  hits  chars');
for (const r of rows) {
  for (const [name, v] of [['main', r.retrieval], [r.run.startsWith("ergo") ? "plain-sim" : 'threshold0', r.retrievalAlt]]) {
    console.log(`${r.run.padEnd(13)} ${name.padEnd(11)}  ${fmt(v.recall).padStart(6)}  ${fmt(v.stale).padStart(5)}  ${fmt(v.noise).padStart(5)}  ${fmt(v.n, 1).padStart(4)}  ${fmt(v.chars, 0).padStart(5)}`);
  }
}
fs.writeFileSync(path.join(RES, 'scores.json'), JSON.stringify(rows, null, 2));
