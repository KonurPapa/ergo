# EditorToolbar

The formatting toolbar for the TODO.md document, plus `SelectionToolbar`, the small floating bar that appears over selected text.

**Consumer provides:** `active` (formats on at the caret, as icon names), `block` (the block type at the caret: Task, Text, Heading 1–3, Bulleted, Numbered, Quote, Code), and optional `right` content. `SelectionToolbar` takes `runCount` (runnable tasks in the selection) and `draftLabel`.

- On by default, one 40px row under the document header, on `canvas` between two `line` hairlines. Toggle it with the **T** button in the header or `⇧⌘T`; the choice is remembered per user.
- Groups, separated by `line-strong` ticks: undo/redo · block type · bold, italic, strikethrough, code, link · checklist, bulleted, numbered, outdent, indent · quote, code block, divider.
- Ghost icon buttons in `ink-subtle`; a format that is on at the caret gets `surface-3` and `ink` (`aria-pressed`). Every button's tooltip names its shortcut.
- Only formats that survive in markdown are offered. No text color, highlight, font size or alignment — TODO.md can't store them, and the agent reads the same file.
- Below 640px it collapses to the block type, bold, italic, checklist, indent and a "More" menu.

**SelectionToolbar** appears above a text selection after a short pause: inline formats, then **Draft tasks from this** (turns the selected notes into proposed checklist items in the Draft dialog) and **Run N** when the selection holds runnable tasks. `Esc` dismisses it.
