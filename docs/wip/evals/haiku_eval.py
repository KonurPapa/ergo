import json, re, subprocess
from concurrent.futures import ThreadPoolExecutor
from data import T, SERVERS
S = '/tmp/claude-1000/-home-konur-Documents-Ergo/e1fe1b28-ceb0-46bf-8fec-0def960702cc/scratchpad'
KINDS = ['coding', 'writing', 'research', 'ops', 'data', 'other']
cost = [0.0]
def claude(system, user, schema):
    p = subprocess.run(['claude', '-p', '--model', 'haiku', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands',
                        '--output-format', 'json', '--system-prompt', system, '--json-schema', json.dumps(schema), user], capture_output=True, text=True, timeout=180)
    d = json.loads(p.stdout); cost[0] += d.get('total_cost_usd') or 0
    return d['structured_output']
def tt(title, subs): return title + ('\nSubtasks:\n' + '\n'.join('- ' + s for s in subs) if subs else '')
srv = '\n'.join(f'- {sid}: {label}: {desc}' for sid, label, desc in SERVERS)
SYS = f"""You triage tasks from a software project's to-do list. For the task, decide:
1. kind — the ONE best category: coding (writing/changing code: features, UI, fixes, refactors, scripts, tests, schemas, game logic), writing (prose: posts, emails, docs, release notes, guides, translations), research (investigating or looking things up; output is findings), ops (deployment, CI/CD, config, infrastructure, backups, git operations, dependency upgrades, setting up automations), data (analyzing/cleaning/transforming data, reports with numbers, queries, charts), other (actions in external apps: scheduling, messaging, CRM updates).
2. single — true if it is one focused deliverable one person finishes in a single pass; false if it has several distinct parts better split up.
3. needs_qa — true only for coding changes that span several parts of a codebase or carry risk (architecture, data migration, security/permissions, new subsystems); false otherwise.
4. tools — external services the task CANNOT be done without. Editing local files and running shell commands are always available, so never list a tool for those. Most tasks need none.
Services:
{srv}"""
SCHEMA = {"type": "object", "properties": {"kind": {"type": "string", "enum": KINDS}, "single": {"type": "boolean"}, "needs_qa": {"type": "boolean"},
          "tools": {"type": "array", "items": {"type": "string", "enum": [s[0] for s in SERVERS]}}}, "required": ["kind", "single", "needs_qa", "tools"]}
with ThreadPoolExecutor(4) as ex:
    res = list(ex.map(lambda t: claude(SYS, 'Task:\n' + tt(t[0], t[1]), SCHEMA), T))
n = len(T); acc = lambda f: 100 * sum(f(r, t) for r, t in zip(res, T)) / n
print('TASK KIND        %.0f%%' % acc(lambda r, t: r['kind'] == t[2]))
print('STRAIGHTFORWARD  %.0f%%' % acc(lambda r, t: r['single'] == t[3]))
cod = [(r, t) for r, t in zip(res, T) if t[2] == 'coding']
print('QA NEEDED (12 coding) %.0f%%' % (100 * sum(r['needs_qa'] == t[5] for r, t in cod) / len(cod)))
tp = fp = fn = exact = 0
for r, t in zip(res, T):
    g, p = set(t[4]), set(r['tools']); tp += len(p & g); fp += len(p - g); fn += len(g - p); exact += p == g
print('MCP exact set %.0f%%  precision %.2f  recall %.2f  (tp %d fp %d fn %d)' % (100 * exact / n, tp / max(tp + fp, 1), tp / max(tp + fn, 1), tp, fp, fn))

gold = {21: [56, 1, 17, 19, 14, 43], 56: [1, 21], 60: [41, 55, 34, 9, 65], 73: [40, 52, 42], 11: [8, 69, 32], 69: [8, 11, 32], 8: [69, 11, 32], 41: [60], 22: [1, 6, 20], 20: [1, 22], 17: [21, 19, 14, 43], 63: [5, 14], 40: [73, 52, 42], 32: [11, 69, 8]}
clean = lambda s: re.sub(r'\s+', ' ', re.sub(r'[~*`]', '', s)).strip()
tasks = {str(t['id']): t for t in json.load(open(S + '/rel/tasks.json'))}
REL = "You help an AI agent prepare to work on a task from a project's to-do list. You get the task and a list of other tasks from the same project. Pick the tasks whose content would genuinely help with this one: the same feature or part of the app, a dependency, earlier work to build on, or something that could conflict. Do not pick tasks that only share generic words like 'task' or 'AI'. Picking none is fine."
def rel_one(pid):
    t = tasks[str(pid)]; cands = json.load(open(f'{S}/rel/cands-{pid}.json')); lines = []
    for c in cands:
        line = f'[{c["taskId"]}] {clean(c["title"])[:90]}'; m = clean(c.get('matchedOn') or '')
        if m and not clean(c['title']).lower().startswith(m.lower()[:40]): line += f' (matched: {m[:90]})'
        lines.append(line)
    user = 'Task:\n' + tt(clean(t['title']), [clean(s['text']) for s in t.get('subtasks') or []][:6]) + '\n\nOther tasks:\n' + '\n'.join(lines)
    return set(claude(REL, user, {"type": "object", "properties": {"useful": {"type": "array", "items": {"type": "string", "enum": [c['taskId'] for c in cands]}}}, "required": ["useful"]})['useful'])
with ThreadPoolExecutor(4) as ex:
    sel = dict(zip(gold, ex.map(rel_one, gold)))
tp = fp = fn = 0
for pid, rel in gold.items():
    want = {str(x) for x in rel}; got = sel[pid]; tp += len(got & want); fp += len(got - want); fn += len(want - got)
P, R = tp / max(tp + fp, 1), tp / max(tp + fn, 1)
print('RELATED TASKS precision %.2f recall %.2f F1 %.2f (tp %d fp %d fn %d)' % (P, R, 2 * P * R / max(P + R, 1e-9), tp, fp, fn))
print('TOTAL COST $%.3f for %d calls' % (cost[0], n + len(gold)))
json.dump({'triage': res, 'related': {k: sorted(v) for k, v in sel.items()}}, open('haiku_out.json', 'w'))
