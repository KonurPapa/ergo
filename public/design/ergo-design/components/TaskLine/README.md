# TaskLine

One block of the TODO.md document — a checklist task, a bullet, a numbered item or a line of text — rendered and edited in place like a Google Doc. `DocHeading` renders the `#`/`##`/`###` headings between them; `RunState` is the run indicator at a task's right edge.

The human side of Ergo is a document, not a list view: the user types, indents, reorders and checks things off as they would in any editor, and every edit is saved straight to TODO.md as markdown. These components only add what a plain doc can't show — whether a task is running, queued or waiting for review, and a way to open its brief.

**Consumer provides:** `children` (the line's inline markdown, rendered: text, `code`, **strong**, links, `@file` chips), `kind` (`task` = `- [ ]`, `bullet`, `number`, `text`), `depth` (list indentation), `done` (`- [x]`), `num`, `current` (holds the caret), `selected`, `hasChildren` / `collapsed` / `childCount`, `run` (`RunState` props), `actions`. `DocHeading` takes `level` and an optional `count` ("3 of 5 open", shown on hover).

**Anatomy:** hover gutter on the left (`+` insert, `⋮⋮` drag; then the fold twisty for lines with children) · marker (16px checkbox, bullet dot or number in `ink-subtle`) · text in `body-lg` (14/22) · right edge: `RunState`, then **Open brief** and **Run** on hover and on the current line.

**States**
- Hover and the caret's line (`current`) get a soft `surface-1` band — the current task is the one the detail pane shows. A multi-line selection uses `selection`.
- `done`: the checkbox fills with `ink-subtle` and the text strikes through in `ink-disabled`. Deliberately neutral: a document full of finished work shouldn't turn green or blue.
- `RunState` — live: pulsing dot + "Editing `Bullet.tsx` 2m 14s" in `accent-text`; queued: dashed ring + "Queued 2"; review: `warning` dot + "Review"; failed: `danger` dot + "Failed". Always a word next to the color.
- Collapsed: the fold twisty points right and a small "3 more" chip follows the text.

**Rules**
- The text is the user's. Ergo never rewrites, reorders or reformats it; AI changes to the document arrive as drafts to approve (see Draft tasks).
- No IDs, priority glyphs, badges or per-heading colors in the document. Priority, dependencies and related tasks live in the detail pane, so the file stays clean markdown.
- Indent is 26px per level; the gutter sits outside the text column so lines never shift when it appears.
- Blank lines, paragraphs and spacing are kept exactly as typed — nothing is auto-pruned.

**Editing:** markdown shortcuts (`[] ` checklist, `- ` bullet, `1. ` numbered, `## ` heading, `` ` `` code) · `Tab`/`⇧Tab` indent · `⌥↑/↓` move a line · `⌘↵` toggle done · `↵` at the end of a collapsed task makes an empty sibling · `/` opens the insert menu (blocks and skills) · `⌘.` opens the brief · `⌘R` runs the current task.
