# EmptyState

What a view shows when it has nothing in it yet: a quiet icon, a title, one sentence explaining what will appear, and the one or two actions that fill it.

**Consumer provides:** `title` (what to do: "Open a project"), `text` (one sentence, why or what happens next), `icon`, `actions`.

- Centered, `space-12` vertical padding. Icon in a 40px `surface-2` tile — no illustrations.
- Show the shortcut on the action so the empty state teaches the keyboard.
- Used for: no project, no tasks, no runs, no rules learned, no integrations, no search results ("No tasks match 'bullet'" + Clear search).
