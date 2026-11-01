# Simplification

What the redesign merges, hides or removes, and why. Every feature from the brief stays reachable; these changes cut the number of places a user has to look.

## Merge

- **Human Workspace + AI Workspace → one document with a detail pane.** Today the same work appears twice: a task in the human document and a lane card (`#lane-todo_task_2`) in the AI panel, each with its own done count. Keeping the document as the single home for tasks — each checklist line carrying its run state — removes the duplication. The right side becomes the current line's detail; the AI panel's run cards become the **Runs** tab and the run queue. `HumanWorkspace` keeps its name; `AIWorkspace` survives as the run queue and history model.
- **Execution Settings + Manage AI Profiles → Settings › Models and Permissions.** Permissions, effort and model choice are one decision ("how should agents run?") split across a popover and a modal. Effort becomes four named stops instead of a slider. Per-run overrides stay one click away on the model chip beside Run.
- **Connections, Workspace Settings, Archives & Learnings → one Settings page.** Four modals with their own tab bars become one left nav. Allowed Folders, MCP integrations, skills, rules, memory and archive each get a page.
- **Learnings + AI Notes + Global Rules → Rules and Memory.** "Rules" are instructions the agent follows (user-editable, from `/remember` or corrections); "Memory" is reference knowledge. Two clear concepts instead of four tabs.
- **Category / Date added toggle → nothing.** The document's own headings are the categories and its order is the order; the only view option is **Hide done**.

## Hide (progressive disclosure)

- **Per-agent model assignments** (summary, manager, worker, cleaner, verifier, logger, autocomplete) collapse into four stages — Plan & verify, Work, Summarize, Background — shown only in **Manual** mode. Auto mode shows one line explaining what it picks.
- **The 21 built-in Ergo MCP tools** move under Settings › Integrations › *Built-in tools* as a read-only reference. Users don't configure them, so they shouldn't be the first thing in Connections.
- **The terminal** is behind the Runs tab; `AgentStatus` is the summary everywhere else.
- **The working brief** is behind the Brief tab, never in the document.
- **Storage folder, disk sync and secrets** move to Settings › General › Advanced.

## Remove

- **Toolbar controls markdown can't store** — text color, highlight, line-spacing presets. TODO.md is plain markdown and the agent reads the same file, so these were lost on save anyway. The toolbar itself **stays, on by default**, quieter: one row of ghost icons in five groups, toggleable with `⇧⌘T`. A selection toolbar and markdown shortcuts cover the rest. In the document, `/` opens an insert menu that lists blocks first and skills second.
- **Per-header colors.** They flashed while typing and carried no meaning. Section headers are neutral.
- **Duplicated state on task lines.** A line keeps the user's own markers (checkbox, bullet or number) and gains only one Ergo marker: its run state. IDs, priority glyphs and badges move to the detail pane so the file stays clean.
- **The Saved button and "Save to Disk Now".** Saving is automatic; the status bar says "Saved to TODO.md". Export moves to the project menu and `⌘K`.
- **The floating + button.** A new task is a new line: type `[] ` anywhere, or use the `+` in the line gutter.
- **Decorative badges:** "Global", "Task CRUD", "Global AI Engine", "N params", "ACTIVE", "DARK MODE", "CONNECTED" pills. State is shown with a dot and a word only where it matters.
- **Gradient icon tiles and the purple/teal accents.** One accent, used for the next action.

## Open questions for the team

- **How a line keeps its brief.** Briefs, runs and priority attach to a checklist line, but users retype, split and move lines freely. The design assumes a hidden anchor per task (for example a trailing `<!-- ergo:7f3a -->` comment, never shown in the editor) that survives edits and moves; if a line is deleted, its brief goes to Archive. This needs an engineering decision.
- Should **Review** be a status users can set themselves, or only the result of an agent run? The design assumes both.
- **Queue scope:** per project (designed) or global across projects? A global queue would need a status-bar popover listing projects.
- **Interactive MCP widgets** inside tasks are specified as a slot in the Brief and Notes tabs (a `surface-1` well, `radius-md`, with the integration's name in the header). They need a sandboxing decision before visual detail.
