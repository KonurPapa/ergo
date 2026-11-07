/**
 * Context-compaction benchmark: the same worker pieces run on a real CLI twice and are compared on tokens,
 * API-equivalent cost, wall time and hidden-test accuracy.
 *   baseline: one session for the whole piece, on the CLI's own defaults;
 *   rotate:   (gemini, codex) Ergo's short-context rotation (useCliAgentRuns.ts): past the threshold the worker is asked
 *             for a handoff note and a fresh session on the same model continues from it;
 *   compact:  (claude) Claude Code's own auto-compaction moved to the threshold (claudeCodeCompactionEnv), as Ergo does.
 *
 * It drives the CLI in a PTY directly (no bridge, no Ergo app data or memory), with Ergo's real worker prompt, handoff
 * request, rotation note and threshold. Run it where the CLI is signed in:
 *
 *   npm run bench:compaction -- --cli gemini --tasks bugs,save,combined --model gemini-3-flash-preview
 *   npm run bench:compaction -- --cli claude --tasks bugs,save,combined --model sonnet
 *
 * Options: --cli gemini|claude --tasks <ids> --conditions <list> --reps N --threshold N --model <id> --parallel N
 *          --timeout-min N --out <dir> --cli-cmd <path> (a stand-in CLI, see mock-cli.mjs) --gemini-home <dir>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as spawnChild } from 'node:child_process';
import * as pty from 'node-pty';
import { TASKS, prepareWorkspace, type BenchTask, type GradeResult } from './tasks.ts';
import { buildCliArgsForTask, buildWorkerCliPrompt, buildWorkerHandoffRequest, buildWorkerRotationNote, workerHandoffFile, type CliRunPromptContext } from '../../src/lib/cliAgents.ts';
import { claudeCodeCompactionEnv, compactionThreshold } from '../../src/lib/agentPipeline/compaction.ts';
import { PRICE_SNAPSHOT } from '../../src/lib/modelCatalog/priceSnapshot.ts';
import { priceUsage, resolveAliasModelId } from '../../src/lib/modelCatalog/pricing.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

// ─── Options ────────────────────────────────────────────────────────────────

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

type Condition = 'baseline' | 'rotate' | 'compact';
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const cli = arg('cli', 'gemini') as 'gemini' | 'claude';
if (cli !== 'gemini' && cli !== 'claude') throw new Error('--cli must be gemini or claude');
const opts = {
  cli,
  tasks: arg('tasks', 'bugs,save,combined').split(',').map((s) => s.trim()).filter(Boolean),
  conditions: arg('conditions', cli === 'claude' ? 'baseline,compact' : 'baseline,rotate').split(',').map((s) => s.trim()) as Condition[],
  reps: Math.max(1, Number(arg('reps', '1'))),
  threshold: Math.max(10_000, Number(arg('threshold', '60000'))),
  model: arg('model', cli === 'claude' ? 'sonnet' : 'gemini-3-flash-preview'),
  parallel: Math.max(1, Number(arg('parallel', '2'))),
  timeoutMs: Math.max(1, Number(arg('timeout-min', '40'))) * 60_000,
  // Outside any git repository: a CLI respects the repo's .gitignore and would refuse to read ignored workspaces.
  out: path.resolve(arg('out', path.join(os.tmpdir(), 'ergo-compaction-bench', stamp))),
  cliCmd: arg('cli-cmd', cli),
  geminiHome: path.resolve(arg('gemini-home', path.join(os.homedir(), '.gemini'))),
  source: path.resolve(arg('source', path.join(REPO, 'ergo-tests'))),
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const k = (n: number) => `${(n / 1000).toFixed(1)}k`;

// ─── Gemini CLI session logs ────────────────────────────────────────────────

interface LogMessage { type?: string; role?: string; content?: any; parts?: any; tokens?: any; model?: string; id?: string }

/** A Gemini CLI chat log: one JSON document (older CLIs) or JSONL with message records and $set / $rewindTo patches. */
function readGeminiChat(file: string): LogMessage[] {
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf-8'); } catch { return []; }
  if (!file.endsWith('.jsonl')) {
    try { return JSON.parse(raw)?.messages ?? []; } catch { return []; }
  }
  let messages: LogMessage[] = [];
  const index = new Map<string, number>();
  const reindex = () => { index.clear(); messages.forEach((m, i) => m?.id && index.set(String(m.id), i)); };
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec?.$set?.messages) { messages = [...rec.$set.messages]; reindex(); }
    else if (rec?.$rewindTo !== undefined) {
      const at = index.get(String(rec.$rewindTo?.messageId ?? rec.$rewindTo));
      if (at !== undefined) { messages = messages.slice(0, at); reindex(); }
    } else if (rec?.type) {
      const at = rec.id !== undefined ? index.get(String(rec.id)) : undefined;
      if (at !== undefined) messages[at] = rec;
      else { messages.push(rec); if (rec.id !== undefined) index.set(String(rec.id), messages.length - 1); }
    }
  }
  return messages;
}

function textOf(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((p: any) => (typeof p === 'string' ? p : String(p?.text ?? ''))).join('\n');
}

function sessionFiles(root: string): Array<{ file: string; mtime: number }> {
  const out: Array<{ file: string; mtime: number }> = [];
  const tmp = path.join(root, 'tmp');
  for (const d of fs.existsSync(tmp) ? fs.readdirSync(tmp) : []) {
    const chats = path.join(tmp, d, 'chats');
    for (const f of fs.existsSync(chats) ? fs.readdirSync(chats) : []) {
      if (!f.startsWith('session-')) continue;
      const file = path.join(chats, f);
      try { out.push({ file, mtime: fs.statSync(file).mtimeMs }); } catch {}
    }
  }
  return out;
}

const claimedLogs = new Set<string>();

/**
 * The log of the session launched with `marker` after `since`, claimed for one spawn. Any user message counts: Gemini
 * CLI's first one is its own session context, the launch prompt follows.
 */
function findGeminiLog(marker: string, since: number): string | null {
  for (const { file, mtime } of sessionFiles(opts.geminiHome).sort((a, b) => b.mtime - a.mtime)) {
    if (mtime < since - 5_000 || claimedLogs.has(file)) continue;
    const users = readGeminiChat(file).filter((m) => m.type === 'user' || m.role === 'user');
    if (users.some((m) => textOf(m.content ?? m.parts).includes(marker))) {
      claimedLogs.add(file);
      return file;
    }
  }
  return null;
}

interface LogStats {
  calls: number;
  input: number;
  cached: number;
  cacheWrite: number;
  cacheWrite1h: number;
  output: number;
  /** Times the CLI compacted its own conversation (Claude Code: compact_boundary), with the prompt size it fired at. */
  compactions: number[];
  /** The newest call's prompt, and the first one's (the session's fixed start). */
  context: number;
  start: number;
  peak: number;
  models: Set<string>;
  sawRotationRequest: boolean;
}

function emptyStats(): LogStats {
  return { calls: 0, input: 0, cached: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, compactions: [], context: 0, start: 0, peak: 0, models: new Set(), sawRotationRequest: false };
}

function geminiStats(file: string | null): LogStats {
  const s = emptyStats();
  if (!file) return s;
  for (const m of readGeminiChat(file)) {
    if ((m.type === 'user' || m.role === 'user') && textOf(m.content ?? m.parts).includes('CONTEXT ROTATION')) s.sawRotationRequest = true;
    const t = m.tokens;
    if (!t || typeof t.input !== 'number') continue;
    s.calls++;
    s.input += t.input;
    s.cached += Number(t.cached) || 0;
    s.output += (Number(t.output) || 0) + (Number(t.thoughts) || 0);
    s.context = t.input;
    if (!s.start) s.start = t.input;
    s.peak = Math.max(s.peak, t.input);
    if (m.model) s.models.add(m.model);
  }
  return s;
}

// ─── Claude Code session logs ───────────────────────────────────────────────

function readJsonl(file: string): any[] {
  try {
    return fs.readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/** ~/.claude/projects/<cwd with non-alphanumerics as "-">/<session id>.jsonl (+ its subagents' logs). */
function claudeLog(cwd: string, sessionId: string): string | null {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const direct = path.join(root, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
  if (fs.existsSync(direct)) return direct;
  for (const d of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const f = path.join(root, d, `${sessionId}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function claudeStats(file: string | null): LogStats {
  const s = emptyStats();
  if (!file) return s;
  const sub = path.join(file.replace(/\.jsonl$/, ''), 'subagents');
  const files = [file, ...(fs.existsSync(sub) ? fs.readdirSync(sub).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(sub, f)) : [])];
  for (const f of files) {
    // One response is logged as one line per content block, sharing message.id: count it once (the fullest line).
    const byId = new Map<string, any>();
    const order: string[] = [];
    for (const e of readJsonl(f)) {
      if (f === file && e?.type === 'system' && e?.subtype === 'compact_boundary') s.compactions.push(Number(e?.compactMetadata?.preTokens) || 0);
      if (f === file && e?.type === 'user' && textOf(e?.message?.content).includes('CONTEXT ROTATION')) s.sawRotationRequest = true;
      const u = e?.message?.usage;
      if (e?.type !== 'assistant' || !u) continue;
      const key = String(e.message.id || e.uuid);
      if (!byId.has(key)) order.push(key);
      const prev = byId.get(key);
      if (!prev || (u.output_tokens || 0) >= (prev.usage.output_tokens || 0)) byId.set(key, { usage: u, model: e.message.model });
    }
    for (const key of order) {
      const { usage: u, model } = byId.get(key);
      const read = u.cache_read_input_tokens || 0;
      const write = u.cache_creation_input_tokens || 0;
      const prompt = (u.input_tokens || 0) + read + write;
      s.calls++;
      s.input += prompt;
      s.cached += read;
      s.cacheWrite += write;
      s.cacheWrite1h += Number(u.cache_creation?.ephemeral_1h_input_tokens) || 0;
      s.output += u.output_tokens || 0;
      if (model && !String(model).startsWith('<')) s.models.add(model);
      if (f === file) {
        s.context = prompt;
        if (!s.start) s.start = prompt;
        s.peak = Math.max(s.peak, prompt);
      }
    }
  }
  return s;
}

// ─── One run ────────────────────────────────────────────────────────────────

interface RunResult {
  task: string;
  condition: Condition;
  rep: number;
  outcome: 'done' | 'timeout' | 'exited' | 'error';
  wallMs: number;
  spawns: number;
  rotations: number;
  rotationRequests: number;
  calls: number;
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  peakContext: number;
  /** The CLI's own compactions, at the prompt size each fired. */
  compactions: number[];
  costUsd?: number;
  models: string[];
  grade: GradeResult;
  workspace: string;
  error?: string;
}

const strip = (s: string) => s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b[@-Z\\-_]/g, '');

class SignInError extends Error {}
/** Set when the CLI turned out not to be signed in: the remaining runs would only fail the same way. */
let signInFailed: string | null = null;

async function runOne(task: BenchTask, condition: Condition, rep: number): Promise<RunResult> {
  const name = `${task.id}-${condition}-r${rep}`;
  const dir = path.join(opts.out, name);
  prepareWorkspace(task, opts.source, dir);
  const runId = `bench-${stamp}-${name}`.replace(/[^A-Za-z0-9-]/g, '-');
  const ctx: CliRunPromptContext = { runId, runDirRel: `.ergo/runs/${runId}`, maxWorkers: 1, verifierEnabled: false, memoryToolsAvailable: false };
  const runDir = path.join(dir, ctx.runDirRel);
  fs.mkdirSync(runDir, { recursive: true });
  const piece = { id: '1', title: task.title, instructions: task.instructions, files: task.files };
  const taskItem: any = { id: name, title: task.title, description: task.instructions, status: 'in_progress', subtasks: [] };
  const basePrompt = buildWorkerCliPrompt(taskItem, undefined, piece, ctx);
  const resultFile = path.join(runDir, 'worker-1.md');
  const handoffFile = path.join(dir, workerHandoffFile(ctx, '1'));
  const log = (msg: string) => console.log(`[${new Date().toLocaleTimeString()}] ${name}: ${msg}`);

  const spawns: Array<{ log: string | null; started: number; marker: string; sessionId?: string; transcript?: string }> = [];
  /** The running CLI: a PTY (Gemini CLI, interactive like Ergo's agents) or a child process (`claude -p`). */
  let proc: { write: (data: string) => void; kill: () => void } | null = null;
  let exited = false;
  const start = Date.now();
  const findLog = (s: (typeof spawns)[number]) => (opts.cli === 'claude' ? claudeLog(dir, s.sessionId!) : findGeminiLog(s.marker, s.started));
  const statsOf = (file: string | null) => (opts.cli === 'claude' ? claudeStats(file) : geminiStats(file));

  const launch = (prompt: string) => {
    exited = false;
    const n = spawns.length + 1;
    const transcript = path.join(dir, `.bench-screen-${n}.log`);
    const env: Record<string, string> = { ...(process.env as Record<string, string>), TERM: 'xterm-256color' };
    if (opts.cli === 'claude') {
      // Non-interactive Claude Code: no folder-trust prompt to answer, and a narrow permission set instead of bypass —
      // edits inside the workspace plus node / npm commands (to run the tests). Its auto-compaction is the same engine
      // as in a terminal session. No user plugins or MCP servers (Ergo's agents drop the plugins too: ~9k tokens).
      const sessionId = crypto.randomUUID();
      if (condition === 'compact') Object.assign(env, claudeCodeCompactionEnv({ mode: 'auto', tokens: opts.threshold }));
      const args = ['-p', prompt, '--session-id', sessionId, '--model', opts.model, '--permission-mode', 'acceptEdits',
        '--allowedTools', 'Bash(node:*)', 'Bash(npm test:*)', 'Bash(npm run:*)', '--setting-sources', 'project,local', '--strict-mcp-config', '--output-format', 'json'];
      const child = spawnChild(opts.cliCmd, args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', (d) => fs.appendFileSync(transcript, d));
      child.stderr.on('data', (d) => fs.appendFileSync(transcript, d));
      child.on('exit', () => { exited = true; });
      proc = { write: () => {}, kill: () => { try { child.kill('SIGTERM'); } catch {} } };
      spawns.push({ log: null, started: Date.now(), marker: runId, sessionId });
      return;
    }
    const args = buildCliArgsForTask(opts.cli, '', prompt, false, { permissionLevel: 'bypass', model: opts.model });
    // --skip-trust: the workspace is a fresh copy made for this run (Ergo's bridge handles trust for its agents).
    const term = pty.spawn(opts.cliCmd, ['--skip-trust', ...args], { name: 'xterm-256color', cols: 120, rows: 40, cwd: dir, env });
    term.onData((d) => fs.appendFileSync(transcript, strip(d)));
    term.onExit(() => { exited = true; });
    proc = { write: (d) => term.write(d), kill: () => term.kill() };
    spawns.push({ log: null, started: Date.now(), marker: runId, transcript });
  };

  const type = async (text: string) => {
    proc?.write(text.replace(/[\r\n]+/g, ' '));
    await sleep(150);
    proc?.write('\r');
  };

  const cleanup = () => { try { proc?.kill(); } catch {} };

  let rotations = 0;
  let rotationRequests = 0;
  let outcome: RunResult['outcome'] = 'timeout';
  let error: string | undefined;
  try {
    launch(basePrompt);
    log(`started (${condition}, model ${opts.model})`);
    let asked: { at: number; retries: number } | null = null;
    while (Date.now() - start < opts.timeoutMs) {
      await sleep(3000);
      const current = spawns[spawns.length - 1];
      if (!current.log) current.log = findLog(current);
      // Done: the worker wrote its result file.
      if (fs.existsSync(resultFile) && fs.statSync(resultFile).size > 0 && fs.statSync(resultFile).mtimeMs >= start) {
        await sleep(4000); // let the CLI flush its log
        outcome = 'done';
        break;
      }
      if (exited) {
        // `claude -p` ends when the piece is done; its result file decides whether it was.
        await sleep(2000);
        outcome = fs.existsSync(resultFile) && fs.statSync(resultFile).size > 0 ? 'done' : 'exited';
        break;
      }
      // A CLI parked on its sign-in screen never starts; fail now instead of waiting out the timeout.
      if (current.transcript && fs.existsSync(current.transcript)) {
        const screen = fs.readFileSync(current.transcript, 'utf-8').slice(-4000);
        if (/Failed to sign in|Authentication consent could not be obtained|no longer supported/i.test(screen)) {
          throw new SignInError(`${opts.cli} is not signed in: run \`${opts.cli}\` once in a terminal and sign in, then rerun`);
        }
      }
      if (condition !== 'rotate' || !current.log) continue;
      const stats = statsOf(current.log);
      // The handoff note it was asked for: a fresh session on the same model continues from it.
      if (asked && fs.existsSync(handoffFile) && fs.statSync(handoffFile).mtimeMs >= asked.at && fs.statSync(handoffFile).size > 0) {
        await sleep(1500);
        const note = fs.readFileSync(handoffFile, 'utf-8');
        rotations++;
        log(`rotation ${rotations} at ${k(stats.context)} tokens; restarting from the handoff note (${note.length} chars)`);
        cleanup();
        await sleep(1000);
        launch(`${basePrompt}\n\n${buildWorkerRotationNote(note, rotations)}`);
        asked = null;
        continue;
      }
      if (!asked) {
        const at = compactionThreshold({ provider: opts.cli, model: opts.model, setting: { mode: 'auto', tokens: opts.threshold }, models: PRICE_SNAPSHOT.models, baseTokens: stats.start, kind: 'cli' });
        if (at && stats.context >= at) {
          asked = { at: Date.now(), retries: 0 };
          rotationRequests++;
          log(`context ${k(stats.context)} ≥ ${k(at)}: asking for a handoff note`);
          await type(buildWorkerHandoffRequest(ctx, '1'));
        }
      } else if (!stats.sawRotationRequest && Date.now() - asked.at > 45_000 && asked.retries < 3) {
        // The CLI dropped the typed request (busy, or a dialog had focus): type it again.
        asked.retries++;
        asked.at = Date.now();
        log(`handoff request not in the log yet; retyping (${asked.retries})`);
        await type(buildWorkerHandoffRequest(ctx, '1'));
      }
    }
  } catch (err) {
    outcome = 'error';
    error = (err as Error).message;
    if (err instanceof SignInError) { signInFailed = error; log(error); }
  } finally {
    cleanup();
  }
  await sleep(1500);
  for (const s of spawns) if (!s.log) s.log = findLog(s);

  const all = spawns.map((s) => statsOf(s.log));
  const sum = (f: (s: LogStats) => number) => all.reduce((a, s) => a + f(s), 0);
  const models = Array.from(new Set(all.flatMap((s) => Array.from(s.models))));
  const usage = { inputTokens: sum((s) => s.input), outputTokens: sum((s) => s.output), cachedInputTokens: sum((s) => s.cached), cacheWriteTokens: sum((s) => s.cacheWrite), cacheWrite1hTokens: sum((s) => s.cacheWrite1h), calls: sum((s) => s.calls) };
  const costUsd = priceUsage(PRICE_SNAPSHOT.models, resolveAliasModelId(PRICE_SNAPSHOT.models, models[0] || opts.model), usage);
  let grade: GradeResult;
  try { grade = task.grade(dir); } catch (err) { grade = { score: 0, max: 1, checks: [{ name: 'grading', ok: false, error: (err as Error).message }] }; }
  const result: RunResult = {
    task: task.id, condition, rep, outcome, wallMs: Date.now() - start, spawns: spawns.length, rotations, rotationRequests,
    calls: usage.calls, inputTokens: usage.inputTokens, cachedTokens: usage.cachedInputTokens, cacheWriteTokens: usage.cacheWriteTokens, outputTokens: usage.outputTokens,
    peakContext: Math.max(0, ...all.map((s) => s.peak)), compactions: all.flatMap((s) => s.compactions), ...(typeof costUsd === 'number' ? { costUsd } : {}), models, grade, workspace: dir,
    ...(error ? { error } : {}),
  };
  fs.writeFileSync(path.join(dir, 'bench-result.json'), JSON.stringify({ ...result, logs: spawns.map((s) => s.log) }, null, 2));
  log(`${outcome} in ${(result.wallMs / 60000).toFixed(1)} min · ${result.calls} calls · ${k(result.inputTokens)} in (${k(result.cachedTokens)} cached) · ${k(result.outputTokens)} out · peak ${k(result.peakContext)} · ${rotations} rotation(s) · ${result.compactions.length} CLI compaction(s) · score ${grade.score}/${grade.max}`);
  return result;
}

// ─── Report ─────────────────────────────────────────────────────────────────

function report(results: RunResult[]): string {
  const lines: string[] = [];
  lines.push(`# Compaction benchmark — ${stamp}`, '');
  lines.push(`CLI \`${opts.cliCmd}\`, model \`${opts.model}\`, threshold ${opts.threshold.toLocaleString()} tokens, ${opts.reps} rep(s).`, '');
  lines.push('| task | condition | rep | outcome | min | calls | input | cached | cache writes | output | peak ctx | rotations | CLI compactions (at) | cost (API $) | score |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const compactions = r.compactions.length ? `${r.compactions.length} (${r.compactions.map(k).join(', ')})` : '0';
    lines.push(`| ${r.task} | ${r.condition} | ${r.rep} | ${r.outcome} | ${(r.wallMs / 60000).toFixed(1)} | ${r.calls} | ${k(r.inputTokens)} | ${k(r.cachedTokens)} | ${k(r.cacheWriteTokens)} | ${k(r.outputTokens)} | ${k(r.peakContext)} | ${r.rotations}${r.rotationRequests > r.rotations ? ` (${r.rotationRequests} asked)` : ''} | ${compactions} | ${r.costUsd !== undefined ? r.costUsd.toFixed(3) : '—'} | ${r.grade.score}/${r.grade.max} |`);
  }
  lines.push('', '## Per task (mean over reps)', '');
  lines.push('| task | condition | min | input | uncached input | output | cost | score |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const t of opts.tasks) {
    for (const c of opts.conditions) {
      const rs = results.filter((r) => r.task === t && r.condition === c);
      if (!rs.length) continue;
      const mean = (f: (r: RunResult) => number) => rs.reduce((a, r) => a + f(r), 0) / rs.length;
      lines.push(`| ${t} | ${c} | ${mean((r) => r.wallMs / 60000).toFixed(1)} | ${k(mean((r) => r.inputTokens))} | ${k(mean((r) => r.inputTokens - r.cachedTokens))} | ${k(mean((r) => r.outputTokens))} | ${mean((r) => r.costUsd ?? 0).toFixed(3)} | ${mean((r) => r.grade.score / r.grade.max * 100).toFixed(0)}% |`);
    }
  }
  lines.push('', '## Failed checks', '');
  for (const r of results) {
    const failed = r.grade.checks.filter((c) => !c.ok);
    if (failed.length) lines.push(`- **${r.task}-${r.condition}-r${r.rep}**: ${failed.map((c) => `${c.name} (${c.error})`).join('; ')}`);
  }
  return lines.join('\n') + '\n';
}

// ─── Main ───────────────────────────────────────────────────────────────────

const tasks = opts.tasks.map((id) => {
  const t = TASKS.find((x) => x.id === id);
  if (!t) throw new Error(`Unknown task "${id}" (known: ${TASKS.map((x) => x.id).join(', ')})`);
  return t;
});
fs.mkdirSync(opts.out, { recursive: true });
console.log(`Compaction benchmark → ${opts.out}`);

// Conditions of one task + rep run side by side (same time of day, same load on the provider).
const jobs: Array<() => Promise<RunResult>> = [];
for (let rep = 1; rep <= opts.reps; rep++) for (const t of tasks) for (const c of opts.conditions) jobs.push(() => runOne(t, c, rep));
const results: RunResult[] = [];
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(opts.parallel, jobs.length) }, async () => {
    while (next < jobs.length && !signInFailed) {
      const job = jobs[next++];
      results.push(await job());
      fs.writeFileSync(path.join(opts.out, 'results.json'), JSON.stringify(results, null, 2));
      fs.writeFileSync(path.join(opts.out, 'report.md'), report(results));
    }
  })
);
results.sort((a, b) => a.task.localeCompare(b.task) || a.rep - b.rep || a.condition.localeCompare(b.condition));
fs.writeFileSync(path.join(opts.out, 'results.json'), JSON.stringify(results, null, 2));
fs.writeFileSync(path.join(opts.out, 'report.md'), report(results));
console.log(`\n${report(results)}\nReport: ${path.join(opts.out, 'report.md')}`);
if (signInFailed) { console.error(`\nStopped early: ${signInFailed}`); process.exit(1); }
process.exit(0);
