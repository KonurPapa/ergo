# Screens

Where every Ergo feature lives after the redesign. Existing component names are kept where the concept survives; the right-hand column says what the user sees.

## App frame

| Region | Keeps the name | What it holds |
| --- | --- | --- |
| Top bar | `TopBar` | Brand, **project switcher** (`Menu`; one folder per project), search / `⌘K`, **Draft tasks** (`⇧⌘D`), detail-pane toggle, settings. Nothing else. |
| Document | `HumanWorkspace` | TODO.md, edited like a Google Doc: a header (file, path, open/done count, **Hide done**, toolbar toggle), the `EditorToolbar`, then the text — `DocHeading`s, checklist `TaskLine`s, bullets, numbered items and paragraphs, nested by indentation and reordered by typing, dragging or `⌥↑/↓`. Each task line shows its `RunState` and, on hover, **Open brief** and **Run**. Saved as markdown on every keystroke. |
| Detail pane | `TaskDetail` | Follows the caret: the task on the current line. Its text and nested notes (read-only here — edit them in the document), properties that markdown can't hold (status, priority, blocks / blocked by, related, queue, source line), tabs **Brief · Runs · Notes · Activity**, and the footer with model chip, **Queue** and **Run**. |
| Status bar | `StatusBar` | Bridge state, current agent + model mode, the latest `AgentStatus`, queue count, save state. Every item opens its detail. |

## (a) Workspace — `WorkspaceScreen`

The default view. The left is the document, exactly as the user wrote it: headings, checklists, sub-items and notes, with no IDs, numbers or badges added. Only two things are layered on: a task's run state at the right end of its line (Editing… · Queued 2 · Review), and the hover gutter (insert, drag, fold). Putting the caret on a task line shows that task on the right; the AI working brief sits under the **Brief** tab, labeled with who wrote and last edited it, with **Edit** to change it in place. Markdown and code render with `.eg-md` and `CodeBlock`. **Run** (`⇧⌘↵`) is the only accent fill on screen.

## (a2) Selecting text — `DocSelectionScreen`

Selecting part of the document shows the `SelectionToolbar`: inline formats, **Draft tasks from this** (sends the selected notes to the Draft dialog as the prompt) and **Run N** when the selection contains runnable tasks. Selected lines take the `selection` wash.

## (b) Running — `RunningScreen`

The task's line shows the live run state at its right end ("Editing `Bullet.tsx` 2m 14s"); the document stays editable while the agent works. The **Runs** tab opens on the current run: a full-width status line (agent, action, target, elapsed, tokens), one meta line (model, permission mode, files changed), the `Terminal` with a **Changes** diff toggle and a message prompt, **Up next** (the run queue for this project), and **Earlier runs** (history with outcomes). The footer swaps Run for **Pause** and **Stop** (`⇧⌘.`). A finished run moves the task to `review` and shows a review `Banner` with the completion note — or says plainly that the agent didn't write one.

## (c) Draft and review — `DraftReviewScreen`

`⇧⌘D` — or **Draft tasks from this** on a selection — opens **Draft tasks**: the `Composer` with the user's rough prompt (`@file`, `/skill`), then the proposed checklist items with a one-line reason each, priority and dependencies. Items are editable in place; unchecking strikes one through. The heading they are inserted under is chosen inline, and they land in TODO.md as ordinary `- [ ]` lines the user can then rewrite freely. **Regenerate** reruns the prompt, **Add 3 tasks** (`⌘↵`) adds only the checked ones — each with a working brief — and nothing runs until the user presses Run.

## (d) Settings — `SettingsScreen`

A full page with a left nav, replacing the four old modals:

- **Project:** General (name, folder, TODO.md path, export) · **Folders** (Allowed Folders for indexing, the file allow-list) · **Rules** (rules the AI has learned, each editable, deletable and showing where it came from) · **Memory** (knowledge and AI notes) · **Archive** (archived tasks, restorable).
- **Agents:** **Models** (provider, Auto / Manual, effort, per-stage models in Manual) · **Permissions** (Plan · Ask · Accept edits · Full access, as a select with a description of each) · **Skills** (global and custom skills; `/remember` lives here).
- **App:** **Integrations** (MCP servers: Google Workspace, Slack, Figma, VS Code; tokens and permissions; widget toggles) · **Bridge** · Appearance (theme) · Shortcuts.

## (e) Bridge not connected — `BridgeOfflineScreen`

States: **Connected** (`success` dot, the word "Bridge"), **Connecting** (live dot), **Unreachable** (`warning` dot, "Bridge unreachable" in `ink`), **Not installed** (neutral dot, "Set up bridge"). When unreachable, the status-bar item opens a popover that explains what the bridge is, what still works, and three numbered fixes, with **Try again**, **Download bridge** and **Bridge settings**. The detail pane shows a neutral `Banner`; **Run** is disabled and **Queue for later** takes its place. Editing never stops.

## Empty states — `EmptyState`

No project (Open folder) · Empty TODO.md (Start writing / Draft tasks) · No runs (Run task) · No learned rules ("Rules appear here when you use /remember or correct the agent") · No integrations (Browse integrations) · No search results (Clear search).

## Keyboard — `CommandPalette`

`⌘K` searches the document's tasks and headings, files (`@`) and commands (`>`), and runs the highlighted action with `↵`; `⇥` shows the action menu for a task. Choosing a task without an action jumps the caret to its line.

## Narrow windows — `NarrowWindow`

Below 640px the document stands alone: the toolbar compacts to its essentials and a More menu, run states shorten, the hover gutter hides (long-press a line for its menu), the top bar collapses to icons, the detail opens as a full-width sheet, and the status bar keeps the bridge dot and the live agent line.
