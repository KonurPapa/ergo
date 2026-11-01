# Terminal

The live output of an agent run, plus `RunRow` for run history and the queue.

**Consumer provides:** `lines` (strings or `{t, k}` where `k` is `cmd`, `dim`, `ok`, `err`, `acc`, `ask`), `title`, `live`, `height`, `actions`, and an optional `prompt` row for sending the agent a message. `RunRow` takes `title`, `detail`, `meta`, `status` or `live`.

- A well on `canvas` with a hairline edge, `radius-md`, `mono` text. Commands in `ink`, agent narration in `accent-text`, passing output in `success`, errors in `danger`, permission questions in `warning`.
- Auto-scrolls while live; scrolling up pauses it and shows "Jump to latest".
- `aria-live="polite"` on the body so screen readers hear new lines without being flooded.

The terminal sits behind the Run tab and is collapsed by default — `AgentStatus` is the summary, the terminal is the evidence.
