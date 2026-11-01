# Tabs

Switches between views of one object — in Ergo, the task detail pane's **Brief · Runs · Notes · Activity**.

**Consumer provides:** `items` (`id`, `label`, optional `count`, `icon`), `value`, `onChange`.

- Labels in `label` style; inactive `ink-subtle`, active `ink` with a 2px `ink` underline (not accent — accent is reserved for actions and live state).
- Counts sit beside the label in `ink-subtle`, no pill.
- Arrow keys move between tabs; the panel is `role="tabpanel"`.

**Don't** use tabs to switch between unrelated settings pages — that is the settings nav.
