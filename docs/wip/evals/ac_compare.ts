import { buildLocalFimPrompt, localCompletionToSuggestion } from '/home/konur/Documents/Ergo/src/lib/autocompleteService';
import fs from 'node:fs';
const S = '/tmp/claude-1000/-home-konur-Documents-Ergo/e1fe1b28-ceb0-46bf-8fec-0def960702cc/scratchpad/actest';
const samples = JSON.parse(fs.readFileSync(`${S}/samples.json`, 'utf8'));
const CLOUD_N = 60;
const SYSTEM = `You are a real-time inline task autocomplete and copilot assistant like VS Code Copilot, operating inside a markdown task list.
You are given the full task/subtask text and the cursor position indicated by [CURSOR].
Your job:
1. Complete what the user is typing naturally.
2. Fix any obvious typos, grammatical errors, or awkward wording in the current task/subtask if appropriate.
3. Return ONLY a single line of text representing the improved, completed task/subtask content.
4. Do NOT output markdown list markers (- or * or numbers), quotes, markdown formatting, explanations, greetings, or extra lines.
5. Keep it concise, natural, and directly following user intent.`;
async function local(ctx: any) {
  const { prefix, suffix } = buildLocalFimPrompt({ ...ctx, suffixText: '' });
  const t = Date.now();
  const r = await (globalThis as any).__realFetch('http://127.0.0.1:11520/infill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input_prefix: prefix.slice(-4000), input_suffix: suffix, n_predict: 24, temperature: 0, stop: ['\n'] }) });
  const j: any = await r.json();
  const s = localCompletionToSuggestion((j.content || '').trim(), { ...ctx, suffixText: '' });
  return { text: s?.text?.trim() || '', ms: Date.now() - t };
}
async function cloud(ctx: any) {
  const parent = ctx.parentTaskTitle ? `\nParent Task: "${ctx.parentTaskTitle}"` : '';
  const prompt = `Current ${ctx.isSubtask ? 'subtask' : 'task'}: "${ctx.prefixText}[CURSOR]"${parent}\n\nOutput the completed and polished line:`;
  const t = Date.now();
  const r = await (globalThis as any).__realFetch('http://127.0.0.1:5173/api/cli/execute', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' }, body: JSON.stringify({ cli: 'claude', model: 'haiku', mode: 'completion', systemPrompt: SYSTEM, prompt, timeoutMs: 30000 }) });
  const j: any = await r.json();
  let c = (j.output || '').trim().replace(/^[-*•]\s*(\[[ xX]\]\s*)?/, '').replace(/^["'`]+|["'`]+$/g, '').trim();
  let kind = 'suffix';
  let text = '';
  if (c.startsWith(ctx.prefixText)) text = c.slice(ctx.prefixText.length).trim();
  else if (c.startsWith(ctx.prefixText.trim())) text = c.slice(ctx.prefixText.trim().length).trim();
  else { kind = 'rewrite'; const pw = ctx.prefixText.trim().split(/\s+/).length; text = c.split(/\s+/).slice(pw).join(' '); }
  return { text, kind, full: c, ms: Date.now() - t, usage: j.usage };
}
const out: any[] = [];
for (const s of samples) {
  const ctx = { ...s, suffixText: '' };
  const l = await local(ctx);
  const c = s.id < CLOUD_N ? await cloud(ctx) : null;
  out.push({ ...s, local: l, cloud: c });
  process.stdout.write('.');
}
fs.writeFileSync(`${S}/results.json`, JSON.stringify(out, null, 1));
console.log('\ndone');
