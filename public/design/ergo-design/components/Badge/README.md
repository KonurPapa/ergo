# Badge

A short, non-interactive label for a state or category.

**Consumer provides:** `children` (one or two words), optional `tone`, `outline`, `icon`.

- `neutral` (default) for labels and categories; `outline` for queue positions and counts.
- `accent` only for the current model mode or a live state.
- `success`, `warning`, `danger` only when the state needs the user — a failed run, a pending approval. Semantic badges always carry an icon or a word that says the state, so color is never the only signal.

**Don't** stack more than two badges on a task row. Ergo's old UI badged everything (counts, "Global", "Task CRUD", "Subscription"); in the redesign most of those become plain `ink-subtle` text or disappear.
