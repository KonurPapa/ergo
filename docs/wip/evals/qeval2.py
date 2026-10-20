import json, re, sys, time, urllib.request
from data import T, SERVERS
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 11501
S = '/tmp/claude-1000/-home-konur-Documents-Ergo/e1fe1b28-ceb0-46bf-8fec-0def960702cc/scratchpad'
KINDS = ['coding', 'writing', 'research', 'ops', 'data', 'other']
lat = []
def ask(messages, schema, max_tokens=60):
    body = {"messages": messages, "temperature": 0, "max_tokens": max_tokens, "cache_prompt": True,
            "response_format": {"type": "json_schema", "json_schema": {"name": "a", "schema": schema}}}
    t = time.time()
    req = urllib.request.Request(f'http://127.0.0.1:{PORT}/v1/chat/completions', data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
    out = json.load(urllib.request.urlopen(req, timeout=120)); lat.append(time.time() - t)
    return json.loads(out['choices'][0]['message']['content'])
def shots(system, examples, query):
    m = [{"role": "system", "content": system}]
    for q, a in examples: m += [{"role": "user", "content": q}, {"role": "assistant", "content": json.dumps(a)}]
    return m + [{"role": "user", "content": query}]
def explicit_code(t):
    t = t.lower()
    return bool(re.search(r'\.(py|ts|tsx|js|jsx|sh|bash|rs|go|c|cpp|h|hpp|rb|php|java|cs|gd|tscn|tres|html|css|json|yaml|yml|sql)\b', t) or
        re.search(r'\b(script|scripts|scaffold|scaffolding|compile|compiling|parser|function|class|method|endpoint|refactor|unit\s+test|integration\s+test)\b', t) or
        re.search(r'\b(python|typescript|javascript|bash|shell|golang|rust|c\+\+|godot|gdscript|node|react)\b', t))
def tt(title, subs): return title + (' | Subtasks: ' + '; '.join(subs) if subs else '')

# Few-shot examples: all different from the 40 test tasks.
KIND_SYS = "Classify each to-do item by the kind of work: coding, writing, research, ops, data or other. Reply with JSON."
KIND_EX = [
 ("Add pagination to the users table component", {"kind": "coding"}),
 ("Fix the crash when uploading an empty file", {"kind": "coding"}),
 ("Write a FAQ page about subscription billing", {"kind": "writing"}),
 ("Draft a cover letter for the backend role", {"kind": "writing"}),
 ("Find out which payment providers support SEPA and compare their fees", {"kind": "research"}),
 ("Investigate why login is slow on Safari", {"kind": "research"}),
 ("Set up staging environment variables on the server", {"kind": "ops"}),
 ("Tag and publish version 2.3.0 of the package", {"kind": "ops"}),
 ("Make a chart of weekly signups from the analytics export", {"kind": "data"}),
 ("Merge the two customer spreadsheets and remove duplicate rows", {"kind": "data"}),
 ("Book a call with the accountant for Friday", {"kind": "other"}),
 ("Send the invoice reminder email to Globex", {"kind": "other"}),
]
SIMPLE_SYS = "Decide if a to-do item is one small, self-contained job (single=true) or a bigger job with several distinct parts (single=false). Reply with JSON."
SIMPLE_EX = [
 ("Fix the typo in the footer", {"single": True}),
 ("Build user accounts | Subtasks: sign-up; login; password reset; profile page", {"single": False}),
 ("Write a short release announcement", {"single": True}),
 ("Migrate the app to the new payment provider | Subtasks: API client; webhooks; data migration; remove old SDK", {"single": False}),
]
QA_SYS = "Decide if a coding change is risky or broad enough that an independent reviewer should test it (needs_qa=true), or a small contained change (needs_qa=false). Reply with JSON."
QA_EX = [
 ("Change the button color on the settings page", {"needs_qa": False}),
 ("Rewrite the authentication system to use OAuth | Subtasks: providers; token storage; migrate sessions", {"needs_qa": True}),
 ("Add a tooltip to the export icon", {"needs_qa": False}),
 ("Move all data from SQLite to Postgres with a migration script", {"needs_qa": True}),
]
def tool_q(sid, label, desc):
    return (f"Decide if a to-do item REQUIRES the external service \"{label}\" ({desc}). "
            "Local files and terminal commands are always available without it. Answer true only if the item cannot be done without this service. Reply with JSON.")
TOOL_EX = {
 "generic": [
   ("Item: Add a loading spinner to the dashboard", {"required": False}),
   ("Item: Write the privacy policy page", {"required": False}),
 ],
}
TOOL_POS = {
 "mcp-fetch": "Item: Read the Stripe API docs online and list the webhook events",
 "mcp-git": "Item: Commit the staged changes",
 "mcp-github": "Item: Comment on the open GitHub issue about dark mode",
 "mcp-gcal": "Item: Add the team offsite to my calendar",
 "mcp-salesforce": "Item: Log the call with Initech as a Salesforce activity",
 "mcp-slack": "Item: Tell the team in Slack that the release is out",
 "mcp-notion": "Item: Add today's meeting notes to the Notion wiki",
 "mcp-zapier": "Item: Trigger the Zapier zap that syncs new leads",
 "mcp-godot": "Item: Run the Godot scene tests in headless mode",
}
res = []
for i, (title, subs, kind, simple, mcps, hard) in enumerate(T):
    q = tt(title, subs)
    k = ask(shots(KIND_SYS, KIND_EX, q), {"type": "object", "properties": {"kind": {"type": "string", "enum": KINDS}}, "required": ["kind"]})['kind']
    sm = ask(shots(SIMPLE_SYS, SIMPLE_EX, q), {"type": "object", "properties": {"single": {"type": "boolean"}}, "required": ["single"]})['single']
    qa = ask(shots(QA_SYS, QA_EX, q), {"type": "object", "properties": {"needs_qa": {"type": "boolean"}}, "required": ["needs_qa"]})['needs_qa']
    tools = []
    for sid, label, desc in SERVERS:
        ex = [(TOOL_POS[sid], {"required": True})] + TOOL_EX["generic"] + [(TOOL_POS[[s for s in TOOL_POS if s != sid][0]], {"required": False})]
        if ask(shots(tool_q(sid, label, desc), ex, 'Item: ' + q), {"type": "object", "properties": {"required": {"type": "boolean"}}, "required": ["required"]})['required']:
            tools.append(sid)
    res.append(dict(i=i, kind=k, kind_rule='coding' if explicit_code(q) else k, simple=sm, qa=qa, tools=tools))
from collections import Counter
n = len(T); acc = lambda f: 100 * sum(f(r) for r in res) / n
print('TASK KIND (model only)        %.0f%%' % acc(lambda r: r['kind'] == T[r['i']][2]), dict(Counter(r['kind'] for r in res)))
print('TASK KIND (code rule + model) %.0f%%' % acc(lambda r: r['kind_rule'] == T[r['i']][2]))
print('STRAIGHTFORWARD               %.0f%%  (always-yes baseline 70%%)' % acc(lambda r: r['simple'] == T[r['i']][3]))
cod = [r for r in res if T[r['i']][2] == 'coding']
print('QA NEEDED (all 12 coding tasks) %.0f%%  (always-yes baseline 50%%)' % (100 * sum(r['qa'] == T[r['i']][5] for r in cod) / len(cod)))
tp = fp = fn = ex = 0
for r in res:
    g = set(T[r['i']][4]); p = set(r['tools']); tp += len(p & g); fp += len(p - g); fn += len(g - p); ex += p == g
print('MCP exact set %.0f%%  precision %.2f  recall %.2f  (tp %d fp %d fn %d)  [no-tools baseline exact 55%%]' % (100 * ex / n, tp / max(tp + fp, 1), tp / max(tp + fn, 1), tp, fp, fn))

gold = {21: [56, 1, 17, 19, 14, 43], 56: [1, 21], 60: [41, 55, 34, 9, 65], 73: [40, 52, 42], 11: [8, 69, 32], 69: [8, 11, 32], 8: [69, 11, 32], 41: [60], 22: [1, 6, 20], 20: [1, 22], 17: [21, 19, 14, 43], 63: [5, 14], 40: [73, 52, 42], 32: [11, 69, 8]}
clean = lambda s: re.sub(r'\s+', ' ', re.sub(r'[~*`]', '', s)).strip()
tasks = {str(t['id']): t for t in json.load(open(S + '/rel/tasks.json'))}
REL_SYS = "Decide if knowing about the OTHER to-do item would genuinely help someone working on the CURRENT item: the same feature or screen, a dependency, earlier work to reuse, or a possible conflict. Sharing generic words is not enough. Reply with JSON."
REL_EX = [
 ("CURRENT: Add a dark mode toggle to settings\nOTHER: Store user preferences in local storage", {"helps": True}),
 ("CURRENT: Add a dark mode toggle to settings\nOTHER: Write the onboarding email", {"helps": False}),
 ("CURRENT: Export invoices as PDF\nOTHER: Invoice totals are rounded wrong", {"helps": True}),
 ("CURRENT: Export invoices as PDF\nOTHER: Add keyboard shortcuts for navigation", {"helps": False}),
]
tp = fp = fn = 0
for pid, rel in gold.items():
    t = tasks[str(pid)]; cur = tt(clean(t['title']), [clean(s['text']) for s in t.get('subtasks') or []][:5])
    for c in json.load(open(f'{S}/rel/cands-{pid}.json')):
        other = clean(c['title']); m = clean(c.get('matchedOn') or '')
        if m and not other.lower().startswith(m.lower()[:40]): other += ' | ' + m
        h = ask(shots(REL_SYS, REL_EX, f'CURRENT: {cur}\nOTHER: {other}'), {"type": "object", "properties": {"helps": {"type": "boolean"}}, "required": ["helps"]})['helps']
        hit = int(c['taskId']) in rel
        tp += h and hit; fp += h and not hit; fn += (not h) and hit
P, R = tp / max(tp + fp, 1), tp / max(tp + fn, 1)
print('RELATED TASKS precision %.2f recall %.2f F1 %.2f (tp %d fp %d fn %d)  [stage-1 strict cut-off F1 .56]' % (P, R, 2 * P * R / max(P + R, 1e-9), tp, fp, fn))
lat.sort(); print('LATENCY per call: median %.0f ms, p90 %.0f ms (%d calls)' % (1000 * lat[len(lat) // 2], 1000 * lat[int(len(lat) * .9)], len(lat)))
