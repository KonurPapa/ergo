// Store tests for learned rules: the real memoryStore (bridge side) with the real MiniLM model, in a temp dir.
//   node store-test.mts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryStore } from '/home/konur/Documents/Ergo/src/lib/memory/memoryStore.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ergo-insights-'));
const io = {
  readText: async (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null),
  readBytes: async (f: string) => (fs.existsSync(f) ? new Uint8Array(fs.readFileSync(f)) : null),
  writeAtomic: async (f: string, d: string | Uint8Array) => fs.writeFileSync(f, d),
  writeAtomicSync: (f: string, d: string | Uint8Array) => fs.writeFileSync(f, d),
};
const mk = () =>
  createMemoryStore({ dir, chunksFile: path.join(dir, 'chunks.json'), vectorsFile: path.join(dir, 'vectors.f32'), modelsDir: path.join(os.homedir(), '.ergo', 'models'), io, log: () => {} });

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  — ${detail}`}`);
  if (!ok) failures++;
};

const store = mk();
const src = { origin: 'learned' as const, taskId: '7', taskTitle: 'CSV import', runId: 'r1' };

// add, then the same rule reworded → the guard confirms instead of adding
let r = await store.applyInsightOps('A', [{ op: 'add', text: 'Use pnpm for every install in this repo; never run npm install.', scope: 'always' }], src);
check('add creates a rule', r.changes[0]?.kind === 'added' && r.insights.length === 1);
const pnpm = r.insights[0];
check('rule metadata (scope, confirms, source task)', pnpm.scope === 'always' && pnpm.confirms === 1 && pnpm.taskTitle === 'CSV import' && pnpm.origin === 'learned');
r = await store.applyInsightOps('A', [{ op: 'add', text: 'Use pnpm for every install in this repo, never npm install.' }], src);
check('near-duplicate add → confirmed, not added', r.changes[0]?.kind === 'confirmed' && r.insights.length === 1 && r.insights[0].confirms === 2, JSON.stringify(r.changes));
r = await store.applyInsightOps('A', [{ op: 'add', text: 'Store money as integer cents; use toCents / formatCents from src/lib/money.ts.' }], src);
check('distinct rule is added', r.changes[0]?.kind === 'added' && r.insights.length === 2);
const money = r.insights.find((x) => x.text.includes('cents'))!;

// update + undo
r = await store.applyInsightOps('A', [{ op: 'update', id: pnpm.id, text: 'Use bun only: bun install and bun run <script>; never npm or pnpm.' }], src);
const upd = r.changes[0];
check('update rewrites the rule and keeps its id', upd?.kind === 'updated' && r.insights.some((x) => x.id === pnpm.id && x.text.startsWith('Use bun')));
check('learned update reinforces it', r.insights.find((x) => x.id === pnpm.id)!.confirms === 3);
r = await store.applyInsightOps('A', [upd.undo], { origin: 'user' });
check('undo of update restores text and confirms', r.insights.some((x) => x.id === pnpm.id && x.text === pnpm.text && x.confirms === 2), JSON.stringify(r.insights));

// the restored vector is right: the bun wording no longer matches as a duplicate of it
r = await store.applyInsightOps('A', [{ op: 'add', text: 'Use pnpm for every install in this repo; never run npm install.' }], src);
check('restored rule still catches its duplicate (vector restored)', r.changes[0]?.kind === 'confirmed');
await store.applyInsightOps('A', [r.changes[0].undo], { origin: 'user' });

// delete + undo
r = await store.applyInsightOps('A', [{ op: 'delete', id: money.id }], src);
check('delete removes it', r.changes[0]?.kind === 'deleted' && !r.insights.some((x) => x.id === money.id));
r = await store.applyInsightOps('A', [r.changes[0].undo], { origin: 'user' });
check('undo of delete brings it back with the same id', r.insights.some((x) => x.id === money.id && x.text === money.text));

// project isolation
r = await store.applyInsightOps('B', [{ op: 'update', id: pnpm.id, text: 'hijack' }, { op: 'delete', id: money.id }], src);
check("ops on another project's rule are ignored", r.changes.length === 0 && (await store.listInsights('A')).length === 2);
r = await store.applyInsightOps('B', [{ op: 'put', insight: { id: pnpm.id, text: 'hijack', scope: 'always', confirms: 1, origin: 'user' } }], src);
check("put can't take over another project's id", r.changes.length === 0 && (await store.listInsights('A')).find((x) => x.id === pnpm.id)!.text === pnpm.text);
r = await store.applyInsightOps('B', [{ op: 'add', text: 'Use pnpm for every install in this repo; never run npm install.' }], src);
check('same rule in another project is its own rule', r.changes[0]?.kind === 'added' && (await store.listInsights('B')).length === 1);

// user edit: origin user, no reinforcement
const before = (await store.listInsights('A')).find((x) => x.id === money.id)!;
r = await store.applyInsightOps('A', [{ op: 'update', id: money.id, scope: 'always' }], { origin: 'user' });
const after = r.insights.find((x) => x.id === money.id)!;
check('user scope change: scope set, origin user, confirms unchanged', after.scope === 'always' && after.origin === 'user' && after.confirms === before.confirms);

// clearing project / task memory keeps rules; agent searches skip them
await store.add([{ id: 'note1', namespace: 'agent-notes', text: 'Use pnpm for installs, a run note', metadata: { projectId: 'A', taskId: '7' } }]);
await store.remove({ taskId: '7', projectId: 'A' });
check("purging a task's memory keeps the rules its feedback produced", (await store.listInsights('A')).length === 2);
const hits = await store.search({ query: 'pnpm install', projectId: 'A', includeHidden: true, minSimilarity: 0 });
check('agent memory searches skip rules', !hits.some((h) => h.chunk.namespace === 'insights'));
await store.remove({ projectId: 'A' });
check("clearing the project's memory keeps its rules", (await store.listInsights('A')).length === 2);

// read path: whole list while small; beyond 25: every `always` rule + 6 nearest topical
let forTask = await store.insightsForTask('A', 'Fix rounding in totals');
check('small list → whole list, always rules first', forTask.length === 2 && forTask[0].scope === 'always');
const many = ["Keep React components under 200 lines; split larger ones.", "Name hooks useSomething and keep them in src/hooks.", "Never log personal data such as emails to the console.", "Use Zod schemas for every API response.", "Write commit messages in the imperative mood.", "Prefer CSS modules over inline styles.", "Keep translations in src/i18n/en-GB.json.", "Debounce search inputs by 300 ms.", "Use date-fns, never moment.js.", "Every new page needs a route test in tests/routes.", "Feature flags live in src/flags.ts.", "Use the Logger from src/lib/log.ts instead of console.log.", "Images must have alt text.", "Wrap fetch calls in src/lib/http.ts.", "Store secrets only in .env.local, never in code.", "Use SVG icons from lucide-react only.", "Keep SQL migrations in db/migrations with timestamps.", "Charts use recharts with the theme palette.", "Accessibility: every button needs an aria-label if it has no text.", "Use pagination of 50 rows in tables.", "Error messages are written for end users, not developers.", "Keep Storybook stories next to components.", "Use optimistic updates for list mutations.", "Websocket code lives in src/realtime.", "Background jobs go through the queue in src/jobs.", "Use the Toast component for user notifications.", "Never block the main thread with sync XHR.", "Analytics events are named object_action.", "Use Playwright for end-to-end tests.", "PDF exports use the template in templates/report.html."].map((text) => ({ op: 'add' as const, text }));
many.push({ op: 'add', text: 'Format all currency amounts with formatCents and show the pound sign.' });
await store.applyInsightOps('C', many, src);
await store.applyInsightOps('C', [{ op: 'add', text: 'Run bun run lint before finishing.', scope: 'always' }], src);
forTask = await store.insightsForTask('C', 'Show currency totals on the dashboard');
const n = (await store.listInsights('C')).length;
check(`large list (${n}) → always + 6 topical`, n > 25 && forTask.length === 7 && forTask[0].scope === 'always', `${forTask.length}`);
check('nearest topical rule is included', forTask.some((x) => x.text.includes('formatCents')));

// persistence
await store.flush();
const reloaded = mk();
check('rules survive a reload', (await reloaded.listInsights('A')).length === 2 && (await reloaded.listInsights('C')).length === n);

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`);
process.exit(failures ? 1 : 0);
