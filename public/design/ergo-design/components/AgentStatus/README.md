# AgentStatus

One line that says what the agent is doing right now: a dot, a verb, a target, elapsed time and tokens. It is the only always-visible trace of a running agent — quiet, but never absent.

**Consumer provides:** `action` (present tense: "Editing", "Running tests in", "Reading"), optional `agent`, `target` (file or command, set in mono), `elapsed`, `tokens`, `state`, and `onClick` to open the run.

- `running` — pulsing `accent-text` dot (static under reduced motion). `waiting` — `warning` dot; the agent needs a permission answer. `done` / `failed` — `success` / `danger` dot, shown for 10s then the line clears.
- Appears in three places: the status bar (most recent run), the task row (that task's run), and the top of the Run tab (full width).
- `StatusDot` is the bare 6px dot, also used for the bridge state.

**Don't** turn this into a panel, add spinners, or animate the text. Tokens and time update in place with tabular numerals so the line doesn't jitter.
