import json, time, urllib.request, sys
PORT = int(sys.argv[1])
def post(path, body):
    req = urllib.request.Request(f'http://127.0.0.1:{PORT}{path}', data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
    t = time.time(); out = json.load(urllib.request.urlopen(req, timeout=60)); return out, (time.time() - t) * 1000
CASES = [
 ("a right-click context menu should show up in the human side task list, with options for", "Collapsed tasks that have 1 or more subtasks completed should show a little muted (n/n) hint"),
 ("Tasks that are completely checked should", "Draggable task cards"),
 ("the last-used project needs to be the one that restores when", "the AI profile and project need to be synced"),
 ("Built-in search (so users don", "Draggable task cards"),
 ("Execution cards in the AI workspace need to be archived if the user", "Clicking Tab inside a task should indent it"),
 ("support for codeblocks (not just", "copy/cut/delete for tasks needs to be better"),
 ("Add reminders for tasks, which should ping the user at a specific time with", "Visual Storytelling"),
 ("allowed folders should be grouped into either", "a right-click context menu should show up"),
]
CTX = "- Hovering over text that has markdown formatting over it should pop up the markdown characters around it\n- Draggable task cards\n- Built-in search (so users don't have to use Ctrl+F)\n"
lat_fim, lat_chat = [], []
for prefix, nxt in CASES:
    # Fill-in-the-middle (Qwen-Coder native): text before the cursor + the next line after it.
    o, ms = post('/infill', {"input_prefix": CTX + "- " + prefix, "input_suffix": "\n- " + nxt + "\n", "n_predict": 24, "temperature": 0, "stop": ["\n"]}); lat_fim.append(ms)
    fim = o.get('content', '')
    o, ms2 = post('/v1/chat/completions', {"messages": [{"role": "system", "content": "You autocomplete a to-do list item. Continue the user's text from exactly where it stops, in the same style. Reply with only the continuation (a few words), no quotes."}, {"role": "user", "content": "Other items:\n" + CTX + "\nComplete: " + prefix}], "max_tokens": 24, "temperature": 0}); lat_chat.append(ms2)
    chat = o['choices'][0]['message']['content'].split('\n')[0]
    print(f'"{prefix[-45:]}"\n   FIM  ({ms:4.0f} ms): {fim!r}\n   chat ({ms2:4.0f} ms): {chat!r}')
lat_fim.sort(); lat_chat.sort()
print(f'median latency  FIM {lat_fim[len(lat_fim)//2]:.0f} ms   chat {lat_chat[len(lat_chat)//2]:.0f} ms')
