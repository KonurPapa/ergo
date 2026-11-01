# Kbd

A keyboard key or chord, shown wherever a shortcut exists: in buttons, menus, tooltips and the command palette.

**Consumer provides:** `keys` — one string or an array for a chord (`["⌘","K"]`). Use symbols on macOS (⌘ ⌥ ⇧ ↵) and words elsewhere (Ctrl, Alt).

Set in `mono-sm` on `surface-1` with a `line-strong` edge, `radius-xs`. Never use it for anything that is not a key.

**Core shortcuts** (keep these stable). The document is a text editor, so every shortcut that works while typing has a modifier: `⌘K` palette · `⇧⌘D` draft tasks · `⌘↵` toggle done · `⇧⌘↵` run the current task · `⌥⌘↵` add it to the queue · `⌘J` open or close its brief · `⇧⌘.` stop the run · `⌥↑/↓` move a line · `Tab`/`⇧Tab` indent · `⇧⌘T` formatting toolbar · `⌘,` settings. Press `Esc` to leave the document; then single keys work too: `J/K` move between tasks, `X` select, `R` run, `B` brief, `↵` back to editing.
