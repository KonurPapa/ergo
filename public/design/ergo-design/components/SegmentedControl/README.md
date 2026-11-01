# SegmentedControl

Picks one of two to five mutually exclusive options that apply immediately.

**Consumer provides:** `options` (strings or `{id, label}`), `value`, `onChange`, an accessible `label`; `full` stretches it to its container.

Used for **Model: Auto / Manual**, **Effort: Low · Medium · High · Max** (replaces the old slider — four named stops are faster to hit and read), and the list's **Group by**. The selected segment lifts to `surface-3`; no accent.

**Don't** use it for more than five options or for choices that need a confirm step — use a `Menu` select instead.
