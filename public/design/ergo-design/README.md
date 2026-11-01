Ergo is a task workspace where a developer and an AI agent work from one shared document: a TODO.md the human edits like a Google Doc, with each task carrying an AI-written brief and its runs. The interface should feel like a serious developer tool: dense, fast, calm, and honest about what the agent is doing. Structure comes from alignment, type and whitespace — not from boxes, badges and color.

## Principles

1. **One document, two layers.** The human layer is TODO.md itself — headings, checklists, bullets and notes, typed and formatted freely and saved as plain markdown. The AI layer (brief, runs, notes) hangs off each checklist item in the detail pane, one shortcut away (`⌘J`), and never writes into the document without approval.
2. **Action → Pause → Review → Execute.** Every AI action stops for review before anything runs. The UI makes the pause visible: drafted tasks arrive as proposals you check, edit or drop, finished runs land in `review` status, and **Run** is the only primary button in the detail pane.
3. **Quiet transparency.** A running agent is always visible as one `AgentStatus` line — a dot, a verb, a file — at the end of the task's line, in the detail pane and in the status bar. The terminal is the evidence, kept one click behind it.
4. **Progressive disclosure.** Defaults are simple: model **Auto**, effort **Medium**, terminal collapsed, brief closed. Per-stage models, permissions, logs and the built-in tool list live in Settings.
5. **Keyboard first.** Every action has a shortcut, and every place that offers an action shows its `Kbd`. Because the document is a text editor, shortcuts that work while typing carry a modifier (`⇧⌘↵` run, `⌘J` brief); `⌘K` reaches everything.

## Voice and copy

- Sentence case everywhere: "Draft tasks", "Run queue", "Allowed folders". No Title Case, no ALL CAPS labels.
- Address the user as **you**; Ergo speaks as **Ergo**, the agent by its name ("Claude Code", "Gemini CLI", "Local model"). Never "the AI" in UI copy, and no "✨", "magic" or "smart" language. No emoji.
- Buttons are verbs that name the outcome: **Run**, **Add 3 tasks**, **Stop and keep changes** — never "OK", "Submit" or "Execute".
- Status lines are present-tense and specific: "Editing `src/editor/Bullet.tsx`", "Waiting for approval to run `pnpm test`".
- Problems are stated calmly: what is true, what still works, how to fix it. "Runs are paused — the bridge isn't reachable. Tasks still save to TODO.md." No "Error:", no exclamation marks.
- The document is the user's writing. Ergo never rewrites, reorders, reformats or prunes it — not even blank lines. AI changes arrive as drafts to approve.

## Color

Neutral first, one accent. Dark is the primary theme; light mirrors it step for step.

- **Ground and surfaces.** Lay the app on `canvas`. Lift the detail pane, settings nav, inputs and code wells to `surface-1`. Use `surface-2` for hover, menus and dialogs, `surface-3` for selection and pressed states only. Never skip a step to make something "pop".
- **Lines.** Separate panes and groups with a single `line` hairline. Use `line-strong` only for the edge of a floating surface or a secondary button. Use `line-control` (3:1) for anything that identifies a control: checkbox outlines, input borders, the to-do ring.
- **Text.** `ink` for titles and anything the user reads first; `ink-muted` for body copy and briefs; `ink-subtle` for meta, labels, icons and placeholders; `ink-disabled` only for disabled controls and checked-off task text. Every text token holds 4.5:1 on every surface it is documented for, in both themes.
- **Accent.** `accent` fills exactly one thing per view: the primary button (Run, Approve, Add). `accent-text` marks live state and references: the running dot, the agent name, `@file` chips, links. `accent-subtle` washes chips and the live run row. Never use accent for headers, section colors, decoration or selection backgrounds.
- **Semantic.** `success`, `warning`, `danger` appear only where they carry state — a passed run, a needs-review marker, a failed run — and always beside a shape, icon or word, so nothing relies on hue alone. The `-subtle` versions back badges and banners. Urgent priority is the only colored priority (`warning`).
- **Focus.** Every focusable element shows a solid 2px `focus` ring (4.4:1 or better on every surface). Never remove it; inputs replace their border with it.
- **The document stays neutral.** Checked items fill with `ink-subtle` and strike through; headings are `ink`; nothing in TODO.md is colored except a task's run state and `@file` references.
- **Removed from the old UI:** per-header colors, text color and highlight, purple/teal/green/orange competing accents, gradient icon tiles, colored tool badges.

## Typography

One sans, one mono. **Geist** for the interface, **Geist Mono** for code, terminal output, task IDs and file paths. Both ship as files in `fonts/`.

- `body-lg` (14/22) is the document's text size: every line of TODO.md, plus briefs and notes. Document headings use `title-lg` (#), `title` (##) and 14px 600 (###).
- `body` (13/20) is the default for the interface: menus, inputs, settings, the detail pane's properties. `body-strong` (500) for button labels and emphasis.
- `title-lg` (20/28, 600, −0.3px) for the task title in the detail pane and page titles; `title` (15/22, 600) for dialogs and brief h2.
- `label` (12/16, 500) for section headers, tabs and property labels; `caption` (12/16) for meta; `micro` (11/14, 500) for counters and badges only.
- `mono` (12/18) for code and terminal; `mono-sm` (11/16) for IDs and inline paths in meta.
- Use three weights only: 400, 500, 600. Never bold (700) in the UI. Tighten tracking only at 15px and up.
- Numbers that update live (elapsed time, tokens, counts) use tabular numerals.

## Spacing, size and layout

- 4px base: `space-1` 4 · `space-2` 8 · `space-3` 12 · `space-4` 16 · `space-6` 24 · `space-8` 32 · `space-12` 48.
- Controls are dense; the document breathes. Document lines are 30px minimum (22px line + 4px above and below), indented 26px per level, in a text column up to 760px with a 72px left gutter for the insert, drag and fold handles; controls are `size-control` (28px), `size-control-sm` (24px) in rows and toolbars, `size-control-lg` (32px) in dialogs.
- **App frame:** `size-topbar` (44px) top bar · the document (header, formatting toolbar, text) · detail pane (`size-detail`, 480px, resizable 380–720) · `size-statusbar` (28px) status bar. Pane content padding `space-6`; settings content max 680px wide.
- **Responsive:** below 960px the detail pane becomes a sheet over the document; below 640px the toolbar compacts, run states shorten to a dot and a word, the gutter hides, the top bar collapses to icons, and padding drops to `space-4`. Nothing scrolls horizontally except code.

## Shape and depth

- Radii: `radius-xs` 4 (badges, checkboxes, chips) · `radius-sm` 6 (buttons, inputs, line highlights) · `radius-md` 8 (menus, code, terminal, toasts) · `radius-lg` 12 (dialogs, palette) · `radius-full` only for dots. Never pill-shaped buttons.
- Depth comes from the surface ladder, not shadows. `shadow-popover` for menus and toasts, `shadow-dialog` for dialogs and the palette — nothing else casts a shadow.
- No gradients, glows, glass, or colored left-border cards.

## Motion

- `duration-fast` (100ms) for hover and press, `duration-base` (160ms) for menus, row expand and the pane, `duration-slow` (220ms) for dialogs and toasts; enter with `ease-out`, leave with `ease-in` at `duration-fast`.
- The live dot pulses; nothing else loops. Under `prefers-reduced-motion` all transitions drop to 0 and the dot is static.

## Iconography

- **Lucide** line icons, 1.75 stroke, at 16px (14px in rows, menus and small buttons), colored `ink-subtle` by default and `ink` when active. The icons used are bundled in `window.Ergo.icons`; static HTML can use `<i data-i="name">` and `Ergo.hydrateIcons()`.
- Status and priority have their own 14px glyphs (`StatusIcon`, `PriorityIcon`) for the detail pane, run lists and menus — shape carries meaning, color reinforces it. In the document a task is just its checkbox.
- The formatting toolbar uses Lucide's editor set (`bold`, `list-todo`, `heading-2`, `indent-increase`…).
- No emoji, no sparkle or wand icons for AI features: drafting uses `list-plus`, models use `cpu`.
- No Ergo logo file was provided: the brand mark is the letter **E** set in `ink` on a `radius-xs` tile beside the word "Ergo". Replace it when a real mark exists.

## Components

`Button` · `Input` (with `Field`, `Checkbox`, `Switch`) · `Kbd` · `Badge` · `StatusIcon` (with `PriorityIcon`) · `AgentStatus` (with `StatusDot`) · `Tabs` · `SegmentedControl` · `Menu` · `Dialog` · `Toast` · `EditorToolbar` (with `SelectionToolbar`) · `TaskLine` (with `DocHeading`, `RunState`) · `Composer` · `Terminal` (with `RunRow`) · `Banner` · `EmptyState` · `CodeBlock` (with `.eg-md` markdown styles).

Load `tokens.css`, `components/bundle.css` and `components/bundle.js` (React 18 as `window.React`); components are on `window.Ergo`. Class names are prefixed `eg-`. Each component's guidelines say what you provide.

## Screens

`WorkspaceScreen`, `DocSelectionScreen`, `RunningScreen`, `DraftReviewScreen`, `SettingsScreen`, `BridgeOfflineScreen`, `CommandPalette` and `NarrowWindow` show the system applied. The **Screens** section maps every Ergo feature to where it lives; **Simplification** lists what was merged, hidden or removed and why.
