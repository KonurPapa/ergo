# Banner

An inline, persistent message attached to the place it affects — the detail pane, a settings page — for conditions that last: the bridge being offline, a run waiting for review.

**Consumer provides:** `title` (what is true now), `text` (what it means for the user), optional numbered `steps` to fix it, `actions`, `icon`, `tone`.

- `neutral` (`surface-2`) for the bridge: being offline is a state, not an error. `warning` (`warning-subtle`) only when the user must act to continue.
- Write calmly and concretely: say what still works ("You can keep editing tasks"), then how to fix it. No "Error:", no exclamation marks, no red.

**Don't** stack banners; show the most important one. Don't use a banner for transient events — that is a `Toast`.
