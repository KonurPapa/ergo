#!/usr/bin/env node
/**
 * Stand-in for Gemini CLI, to check run.ts's control flow without a model: writes a Gemini-style session log under
 * $MOCK_GEMINI_HOME, grows its context each step, answers Ergo's handoff request by writing the note, and after
 * MOCK_STEPS steps (counted across rotations) restores the original sources from $MOCK_SOLUTION and writes the
 * worker's result file. Never touches the real ~/.gemini.
 *
 *   MOCK_GEMINI_HOME=/tmp/x MOCK_SOLUTION=ergo-tests npm run bench:compaction -- --cli-cmd scripts/compaction-bench/mock-cli.mjs --gemini-home /tmp/x
 */
import fs from 'node:fs';
import path from 'node:path';

const prompt = process.argv[process.argv.length - 1];
const home = process.env.MOCK_GEMINI_HOME;
const solution = process.env.MOCK_SOLUTION;
const totalSteps = Number(process.env.MOCK_STEPS || 16);
if (!home || !solution) { console.error('MOCK_GEMINI_HOME and MOCK_SOLUTION are required'); process.exit(2); }

const chats = path.join(home, 'tmp', 'mock', 'chats');
fs.mkdirSync(chats, { recursive: true });
const logFile = path.join(chats, `session-${Date.now()}-${process.pid}.jsonl`);
let id = 0;
const append = (rec) => fs.appendFileSync(logFile, JSON.stringify({ id: String(++id), ...rec }) + '\n');
fs.writeFileSync(logFile, JSON.stringify({ sessionId: String(process.pid), projectHash: 'mock', startTime: new Date().toISOString() }) + '\n');
append({ type: 'user', content: [{ text: prompt }] });

const resultFile = prompt.match(/\.ergo\/runs\/[^\s"`]+\/worker-1\.md/)?.[0];
const stateFile = path.join(process.cwd(), '.mock-state.json');
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf-8')) : { steps: 0 };
const base = 14_000 + Math.ceil(prompt.length / 4);
let local = 0;
let stopped = false;
process.stdout.write('mock gemini ready\r\n');

const timer = setInterval(() => {
  if (stopped) return;
  local++;
  state.steps++;
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const input = base + local * 9_000;
  append({ type: 'gemini', content: 'working', model: 'gemini-3-flash-preview', tokens: { input, output: 400, cached: Math.floor(input * 0.75), thoughts: 150, tool: 0, total: input + 550 } });
  process.stdout.write(`step ${state.steps} (ctx ${input})\r\n`);
  if (state.steps >= totalSteps && resultFile) {
    for (const f of fs.readdirSync(path.join(solution, 'src'))) fs.copyFileSync(path.join(solution, 'src', f), path.join(process.cwd(), 'src', f));
    fs.writeFileSync(resultFile, `# Worker 1\nSTATUS: DONE after ${state.steps} steps\n`);
    stopped = true;
  }
}, 700);

let typed = '';
process.stdin.setRawMode?.(true);
process.stdin.on('data', (d) => {
  typed += d.toString();
  if (!typed.includes('\r')) return;
  const line = typed;
  typed = '';
  append({ type: 'user', content: [{ text: line }] });
  const target = line.match(/write a handoff note to (\S+handoff-1\.md)/)?.[1];
  if (line.includes('CONTEXT ROTATION') && target) {
    stopped = true;
    setTimeout(() => {
      fs.mkdirSync(path.dirname(path.join(process.cwd(), target)), { recursive: true });
      fs.writeFileSync(path.join(process.cwd(), target), `# Task State Handoff\n- Goal: mock\n- Progress & Discoveries: ${state.steps} steps done\n- Next Immediate Actions: keep going\n`);
    }, 1200);
  }
});
process.on('SIGHUP', () => process.exit(0));
setInterval(() => {}, 1 << 30);
void timer;
