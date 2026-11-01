# Composer

The input for prompts to the AI (tasks themselves are written straight into the document). Type `@` to reference a project file or folder, `/` to invoke a skill.

**Consumer provides:** `parts` (text, `{file}`, `{skill}`), `placeholder`, `model` (shows the model picker chip; "Auto" by default), `submitLabel` and `submitKbd`.

- `@file` references render as `accent-subtle` chips in mono with `accent-text`; `/skill` chips are neutral (`surface-3`, `ink`). Both delete as one unit with Backspace.
- `@` and `/` open the suggestion `Menu` anchored at the caret: files ranked by recency within Allowed Folders, skills with their one-line description.
- `⌘↵` submits; `↵` is a newline. Submit never runs anything — it creates a draft or a task for review.

**Where it appears:** in the Draft tasks dialog (`⇧⌘D`, submit "Draft"), in the detail pane's Notes tab, and in the terminal's message prompt.
