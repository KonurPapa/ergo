# Menu

A floating list of actions: row context menus, the project switcher, selects and the `@`/`/` suggestion list.

**Consumer provides:** `items` — `{label, icon?, hint?, danger?, checked?, onSelect?}`, `{separator:true}`, or `{section:"Title"}`.

- `surface-2` with `shadow-popover`, `radius-md`, 28px items in `body`, icons and hints in `ink-subtle`.
- Hover and keyboard focus lift the item to `surface-3`. Type-ahead filters; `↵` selects; `Esc` closes and returns focus.
- `danger` items go last, after a separator.
- Every row action that has a shortcut shows it as the hint — the menu teaches the keyboard.

**Project switcher** is this menu anchored to the project name in the top bar; each project maps to its own folder.
