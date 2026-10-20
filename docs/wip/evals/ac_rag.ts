import { localCompletionToSuggestion } from '/home/konur/Documents/Ergo/src/lib/autocompleteService';
import fs from 'node:fs';
const S = '/tmp/claude-1000/-home-konur-Documents-Ergo/e1fe1b28-ceb0-46bf-8fec-0def960702cc/scratchpad/actest';
const F = (globalThis as any).__realFetch;
const samples = JSON.parse(fs.readFileSync(`${S}/samples.json`, 'utf8')).slice(0, 60);
const norm = (t: string) => t.toLowerCase().replace(/[’']/g, "'").replace(/[^\w']+/g, ' ').trim();
async function related(s: any): Promise<string[]> {
  const query = (s.isSubtask && s.parentTaskTitle ? `${s.parentTaskTitle}: ` : '') + s.prefixText.trim();
  const r = await F('http://127.0.0.1:5173/api/memory/search', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' }, body: JSON.stringify({ query, namespace: 'workspace', projectId: 'ergo-todos', topK: 8, minSimilarity: 0.35 }) });
  const j: any = await r.json();
  const full = norm(s.prefixText + s.truth);
  const truth = norm(s.truth);
  const out: string[] = [];
  for (const x of j.results || []) {
    const text: string = (x.chunk?.text || x.text || '').replace(/\s+/g, ' ').trim();
    const n = norm(text);
    // Leak guard: the line being typed exists in full in the index; while typing it only holds the typed part.
    if (!text || n.includes(full) || (truth.length > 12 && n.includes(truth))) continue;
    out.push(text.slice(0, 160));
    if (out.length >= 4) break;
  }
  return out;
}
async function local(s: any, rel: string[]) {
  const marker = s.isSubtask ? '  - ' : '- ';
  const prefix = `${rel.map((t) => `- ${t}`).join('\n')}${rel.length ? '\n' : ''}${s.isSubtask && s.parentTaskTitle ? `- ${s.parentTaskTitle}\n` : ''}${marker}${s.prefixText.replace(/[ \t]+$/, '')}`;
  const t = Date.now();
  const r = await F('http://127.0.0.1:11520/infill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input_prefix: prefix, input_suffix: '\n', n_predict: 24, temperature: 0, stop: ['\n'] }) });
  const j: any = await r.json();
  const sug = localCompletionToSuggestion((j.content || '').trim(), { ...s, suffixText: '' } as any);
  return { text: sug?.text?.trim() || '', ms: Date.now() - t };
}
const SYS_OLD = `You are a real-time inline task autocomplete and copilot assistant like VS Code Copilot, operating inside a markdown task list.
You are given the full task/subtask text and the cursor position indicated by [CURSOR].
Your job:
1. Complete what the user is typing naturally.
2. Fix any obvious typos, grammatical errors, or awkward wording in the current task/subtask if appropriate.
3. Return ONLY a single line of text representing the improved, completed task/subtask content.
4. Do NOT output markdown list markers (- or * or numbers), quotes, markdown formatting, explanations, greetings, or extra lines.
5. Keep it concise, natural, and directly following user intent.`;
const SYS_CONT = `You autocomplete the line a user is typing in a project's to-do list, like an editor's inline suggestion.
Reply with ONLY the words that should come next after the cursor — not the text before it, no quotes, no list markers, no explanation. Keep it short (a few words up to the end of the line) and in the user's own style. Use the related items from the same project to guess what they mean.`;
async function cloud(s: any, rel: string[], system: string) {
  const parent = s.isSubtask && s.parentTaskTitle ? `\nParent Task: "${s.parentTaskTitle}"` : '';
  const relText = rel.length ? `Related items from this project:\n${rel.map((t) => `- ${t}`).join('\n')}\n\n` : '';
  const prompt = `${relText}Current ${s.isSubtask ? 'subtask' : 'task'}: "${s.prefixText}[CURSOR]"${parent}\n\n${system === SYS_OLD ? 'Output the completed and polished line:' : 'Continuation:'}`;
  const t = Date.now();
  const r = await F('http://127.0.0.1:5173/api/cli/execute', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' }, body: JSON.stringify({ cli: 'claude', model: 'haiku', mode: 'completion', systemPrompt: system, prompt, timeoutMs: 30000 }) });
  const j: any = await r.json();
  let c = (j.output || '').trim().split('\n')[0].replace(/^[-*•]\s*(\[[ xX]\]\s*)?/, '').replace(/^["'`]+|["'`]+$/g, '').trim();
  let kind = 'suffix';
  let text = c;
  if (system === SYS_OLD) {
    if (c.startsWith(s.prefixText)) text = c.slice(s.prefixText.length).trim();
    else if (c.startsWith(s.prefixText.trim())) text = c.slice(s.prefixText.trim().length).trim();
    else { kind = 'rewrite'; const pw = s.prefixText.trim().split(/\s+/).length; text = c.split(/\s+/).slice(pw).join(' '); }
  } else if (c.startsWith(s.prefixText.trim())) text = c.slice(s.prefixText.trim().length).trim();
  return { text, kind, ms: Date.now() - t, usage: j.usage };
}
const out: any[] = [];
for (const s of samples) {
  const rel = await related(s);
  out.push({ ...s, related: rel, localRag: await local(s, rel), cloudRag: await cloud(s, rel, SYS_OLD), cloudRagCont: await cloud(s, rel, SYS_CONT) });
  process.stdout.write('.');
}
fs.writeFileSync(`${S}/results_rag.json`, JSON.stringify(out, null, 1));
console.log('\ndone');
