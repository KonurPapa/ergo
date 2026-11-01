# Toast

A transient message about something that happened outside the user's focus — a run finishing, a permission request, a failure.

**Consumer provides:** `title` (subject + outcome: "ERG-142 finished"), optional `text`, `tone`, `actions` (at most two small buttons).

- Bottom-right, stacked, max three visible. `surface-2`, `shadow-popover`, `radius-md`, 360px.
- Success and neutral auto-dismiss after 6s (paused on hover); warning and danger stay until acted on.
- `role="status"`, or `role="alert"` for danger.

**Don't** toast things the user just did themselves ("Task saved"). Autosave is shown in the status bar, not in toasts.
