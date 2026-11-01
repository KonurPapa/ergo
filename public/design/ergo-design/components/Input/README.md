# Input

Single-line text entry, plus the `Field` wrapper, `Checkbox` and `Switch` that share its states.

**Consumer provides:** standard input props; `icon` for a leading glyph (search), `kbd` for a trailing shortcut hint, `mono` for paths, commands, keys and model IDs, `invalid` for error state. Wrap in `Field` with `label`, `help` or `error` — `error` replaces `help` and is announced via its icon and text, not color alone.

- Height `size-control` (28px), `surface-1` fill, `line-control` border (3:1 in both themes), `radius-sm`.
- Focus: 2px `focus` ring replaces the border. Never remove it.
- Placeholder text in `ink-subtle`; it is a hint, not a label — always give a label (visible or `aria-label`).
- `Checkbox` is for multi-select and opt-ins (approving drafted subtasks); `Switch` is for settings that apply immediately. Task completion uses `StatusIcon`, not a checkbox.
