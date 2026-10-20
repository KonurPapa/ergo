import json, re, sys, time, urllib.request
from data import T, SERVERS
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 11501
S = '/tmp/claude-1000/-home-konur-Documents-Ergo/e1fe1b28-ceb0-46bf-8fec-0def960702cc/scratchpad'
KINDS = ['coding', 'writing', 'research', 'ops', 'data', 'other']
lat = []
def ask(system, user, schema, max_tokens=120):
    body = {"messages": [{"role": "system", "content": system}, {"role": "user", "content": user}], "temperature": 0, "max_tokens": max_tokens,
            "response_format": {"type": "json_schema", "json_schema": {"name": "a", "schema": schema}}}
    t = time.time()
    req = urllib.request.Request(f'http://127.0.0.1:{PORT}/v1/chat/completions', data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
    out = json.load(urllib.request.urlopen(req, timeout=120)); lat.append(time.time() - t)
    return json.loads(out['choices'][0]['message']['content'])
def explicit_code(t):
    t = t.lower()
    return bool(re.search(r'\.(py|ts|tsx|js|jsx|sh|bash|rs|go|c|cpp|h|hpp|rb|php|java|cs|gd|tscn|tres|html|css|json|yaml|yml|sql)\b', t) or
        re.search(r'\b(script|scripts|scaffold|scaffolding|compile|compiling|parser|function|class|method|endpoint|refactor|unit\s+test|integration\s+test)\b', t) or
        re.search(r'\b(python|typescript|javascript|bash|shell|golang|rust|c\+\+|godot|gdscript|node|react)\b', t))
def task_text(title, subs): return title + ('\nSubtasks:\n' + '\n'.join('- ' + s for s in subs) if subs else '')

KIND_SYS = """You classify tasks from a software project's to-do list. Pick the ONE category that best describes the work:
- coding: writing or changing code in a codebase: features, UI, bug fixes, refactors, scripts, tests, schemas, game logic.
- writing: producing prose: blog posts, emails, documentation pages, release notes, guides, translations.
- research: investigating or looking things up; the result is findings or a recommendation.
- ops: deployment, CI/CD, configuration, infrastructure, backups, git operations, dependency upgrades, setting up automations.
- data: analyzing, cleaning or transforming data; reports with numbers, queries, charts.
- other: actions in external apps: scheduling meetings, sending messages, updating CRM records.
Reply with JSON."""
SIMPLE_SYS = """You judge the size of a task from a software project's to-do list. Answer single=true if one person can finish it in one focused pass as a single deliverable (one page, one script, one document, one isolated fix or small feature). Answer single=false if it has several distinct parts that would be better split up and worked on separately. Reply with JSON."""
QA_SYS = """You judge risk for a coding task. Answer needs_qa=true if the change spans several parts of a codebase or carries risk (architecture changes, data migrations, security or permissions, new subsystems, many files), so an independent reviewer should verify it. Answer needs_qa=false for small, contained changes. Reply with JSON."""
srv_lines = '\n'.join(f'- {sid}: {label}: {desc}' for sid, label, desc in SERVERS)
MCP_SYS = f"""You decide which external tools a task needs. Editing local files and running shell commands are ALWAYS available, so never pick a tool for those. Pick a tool only if the task cannot be done without it (for example: posting to Slack needs Slack; reading a web page needs Web Fetch; a pull request needs GitHub). Most tasks need no tools: return an empty list then.
Tools:
{srv_lines}
Reply with JSON."""
ids = [s[0] for s in SERVERS]
res = []
for i, (title, subs, kind, simple, mcps, hard) in enumerate(T):
    tt = task_text(title, subs)
    k = ask(KIND_SYS, 'Task:\n' + tt, {"type": "object", "properties": {"kind": {"type": "string", "enum": KINDS}}, "required": ["kind"]})['kind']
    sm = ask(SIMPLE_SYS, 'Task:\n' + tt, {"type": "object", "properties": {"single": {"type": "boolean"}}, "required": ["single"]})['single']
    qa = ask(QA_SYS, 'Task:\n' + tt, {"type": "object", "properties": {"needs_qa": {"type": "boolean"}}, "required": ["needs_qa"]})['needs_qa']
    tools = ask(MCP_SYS, 'Task:\n' + tt, {"type": "object", "properties": {"tools": {"type": "array", "items": {"type": "string", "enum": ids}, "uniqueItems": True, "maxItems": 3}}, "required": ["tools"]})['tools']
    res.append(dict(i=i, kind=k, kind_rule='coding' if explicit_code(tt) else k, simple=sm, qa=qa, tools=tools))
from collections import Counter
n = len(T)
acc = lambda f: 100 * sum(f(r) for r in res) / n
print('TASK KIND (model only)        %.0f%%' % acc(lambda r: r['kind'] == T[r['i']][2]), dict(Counter(r['kind'] for r in res)))
print('TASK KIND (code rule + model) %.0f%%' % acc(lambda r: r['kind_rule'] == T[r['i']][2]))
print('STRAIGHTFORWARD               %.0f%%  (always-yes baseline 70%%)' % acc(lambda r: r['simple'] == T[r['i']][3]))
qs = [r for r in res if T[r['i']][2] == 'coding' and not T[r['i']][3]]
print('QA NEEDED (complex coding n=%d) %.0f%%  — all gold=yes, so not discriminative' % (len(qs), 100 * sum(r['qa'] == T[r['i']][5] for r in qs) / max(len(qs), 1)))
smallc = [r for r in res if T[r['i']][2] == 'coding' and T[r['i']][3]]
print('QA on simple coding (gold=no, n=%d) %.0f%% correct' % (len(smallc), 100 * sum(not r['qa'] for r in smallc) / max(len(smallc), 1)))
tp = fp = fn = ex = 0
for r in res:
    g = set(T[r['i']][4]); p = set(r['tools'])
    tp += len(p & g); fp += len(p - g); fn += len(g - p); ex += p == g
print('MCP exact set %.0f%%  precision %.2f  recall %.2f  (tp %d fp %d fn %d)' % (100 * ex / n, tp / max(tp + fp, 1), tp / max(tp + fn, 1), tp, fp, fn))

# ── related tasks: select from the stage-1 candidates ──
gold = {21: [56, 1, 17, 19, 14, 43], 56: [1, 21], 60: [41, 55, 34, 9, 65], 73: [40, 52, 42], 11: [8, 69, 32], 69: [8, 11, 32], 8: [69, 11, 32], 41: [60], 22: [1, 6, 20], 20: [1, 22], 17: [21, 19, 14, 43], 63: [5, 14], 40: [73, 52, 42], 32: [11, 69, 8]}
clean = lambda s: re.sub(r'\s+', ' ', re.sub(r'[~*`]', '', s)).strip()
tasks = {str(t['id']): t for t in json.load(open(S + '/rel/tasks.json'))}
REL_SYS = """You help an AI agent prepare to work on a task from a project's to-do list. You get the task and a numbered list of other tasks from the same project. Pick the tasks whose content would genuinely help with this one: the same feature or part of the app, a dependency, earlier work to build on, or something that could conflict. Do not pick tasks that only share generic words like "task" or "AI". Picking none is fine. Reply with JSON."""
tp = fp = fn = 0; rel_rows = []
for pid, rel in gold.items():
    t = tasks[str(pid)]
    cands = json.load(open(f'{S}/rel/cands-{pid}.json'))
    lines = []
    for c in cands:
        line = f'[{c["taskId"]}] {clean(c["title"])[:90]}'
        m = clean(c.get('matchedOn') or '')
        if m and not clean(c['title']).lower().startswith(m.lower()[:40]): line += f' (matched: {m[:90]})'
        lines.append(line)
    user = 'Task:\n' + task_text(clean(t['title']), [clean(s['text']) for s in t.get('subtasks') or []][:6]) + '\n\nOther tasks:\n' + '\n'.join(lines)
    sel = ask(REL_SYS, user, {"type": "object", "properties": {"useful": {"type": "array", "items": {"type": "string", "enum": [c['taskId'] for c in cands]}, "uniqueItems": True, "maxItems": 5}}, "required": ["useful"]}, 80)['useful']
    got, want = set(sel), {str(x) for x in rel}
    tp += len(got & want); fp += len(got - want); fn += len(want - got); rel_rows.append((pid, sorted(got), sorted(want)))
P, R = tp / max(tp + fp, 1), tp / max(tp + fn, 1)
print('RELATED TASKS  precision %.2f recall %.2f F1 %.2f (tp %d fp %d fn %d)   [stage-1 strict cut-off: P .59 R .53 F1 .56]' % (P, R, 2 * P * R / max(P + R, 1e-9), tp, fp, fn))
for row in rel_rows[:5]: print('   #%s picked %s  gold %s' % row)
lat.sort(); print('LATENCY per call: median %.0f ms, p90 %.0f ms (%d calls)' % (1000 * lat[len(lat) // 2], 1000 * lat[int(len(lat) * .9)], len(lat)))
json.dump(res, open(f'res-{PORT}.json', 'w'))
