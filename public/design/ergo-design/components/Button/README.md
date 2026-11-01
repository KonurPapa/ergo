# Button

Buttons trigger actions; one `primary` per view marks the action the user most likely wants next.

**Consumer provides:** `children` (a verb, sentence case: "Run", "Approve 4", "Draft tasks"), optional `icon`, `kbd` shortcut hint, `variant`, `size`, and the usual button props. `IconButton` needs `icon` and a `label` (becomes `aria-label` and tooltip).

**Variants**
- `primary` — accent fill. Only the next step in the Action → Pause → Review → Execute flow: **Run**, **Approve**, **Save**. Never two in one view.
- `secondary` — surface-1 with a `line-strong` edge. Default for everything else that deserves a box.
- `ghost` — no box until hover. Toolbars, row actions, dialog dismissals.
- `danger` — Stop a run, Delete, Remove connection. Text in `danger`, not a red fill.

**Sizes** — `sm` 24px in rows and the composer, `md` 28px default, `lg` 32px in dialogs and empty states.

**Do** put the shortcut in the button (`kbd="R"`) when one exists — that is how users learn the keyboard. **Don't** use icon-only buttons for anything destructive, or pill-round any button.
