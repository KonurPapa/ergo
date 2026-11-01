# StatusIcon

14px glyphs for a task's status and priority (`PriorityIcon`). Used in the detail pane, run lists, the Draft dialog and menus. In the document itself a task is just its markdown checkbox; its run state shows as `RunState` at the end of the line.

**Consumer provides:** `status` (`todo`, `queued`, `progress`, `review`, `done`, `failed`) or `priority` (`none`, `low`, `medium`, `high`, `urgent`). Both render `role="img"` with an `aria-label`.

**Status** — shape carries the meaning, color reinforces it:
- `todo` ring in `line-control` · `queued` dashed ring · `progress` half-filled in `accent-text` (also used while an agent runs)
- `review` ring with a center dot in `warning` — the agent finished and the human must look. This is the Pause in Action → Pause → Review → Execute.
- `done` filled check in `success` · `failed` filled cross in `danger`

**Priority** — three signal bars in `ink-subtle`; `urgent` is the only colored one (`warning`). `none` shows three dashes so rows stay aligned.

In the detail pane, clicking the status opens the status menu; priority is set there or from the line menu.
