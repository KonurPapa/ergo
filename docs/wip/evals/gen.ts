import fs from 'node:fs';
import path from 'node:path';
import { createMemoryStore } from '/home/konur/Documents/Ergo/src/lib/memory/memoryStore';
import { parseTodoMarkdown } from '/home/konur/Documents/Ergo/src/lib/parser';
import { buildWorkspaceIndexItems } from '/home/konur/Documents/Ergo/src/hooks/useWorkspaceMemorySync';
const dir = path.resolve('store');
const w = (f: string, d: any) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.tmp', d); fs.renameSync(f + '.tmp', f); };
const io = { readText: async (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null), readBytes: async (f: string) => (fs.existsSync(f) ? new Uint8Array(fs.readFileSync(f)) : null), writeAtomic: async (f: string, d: any) => w(f, d), writeAtomicSync: w };
const store: any = createMemoryStore({ dir, chunksFile: path.join(dir, 'chunks.json'), vectorsFile: path.join(dir, 'vectors.f32'), modelsDir: process.env.HOME + '/.ergo/models', io } as any);
const md = fs.readFileSync(process.env.HOME + '/.ergo/projects/ergo-todos/TODO.md', 'utf8');
const tasks: any[] = parseTodoMarkdown(md).items.map((t: any) => ({ ...t, swimLaneId: 'lane-default' }));
fs.writeFileSync('tasks.json', JSON.stringify(tasks, null, 1));
await store.syncWorkspace('ergo-todos', buildWorkspaceIndexItems({ tasks, briefs: [], swimLanes: [{ id: 'lane-default', title: 'Human Workspace', filePath: 'TODO.md', markdown: md }] } as any));
for (const id of ['21', '56', '60', '73', '11', '69', '8', '41', '22', '20', '17', '63', '40', '32']) {
  const t = tasks.find((x) => String(x.id) === id);
  const res = await store.relatedTasks({ projectId: 'ergo-todos', taskId: id, title: t.title, subtasks: t.subtasks.map((s: any) => s.text), topK: 10 });
  fs.writeFileSync(`cands-${id}.json`, JSON.stringify(res.candidates));
}
console.log('tasks', tasks.length);
