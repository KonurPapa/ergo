# Dialog

A modal for a decision that blocks the flow: confirmations, AI task drafting review, connecting an integration.

**Consumer provides:** `title`, optional `description`, `children` (body), `footer` (buttons, right-aligned, primary last), `onClose`. `inline` renders without the scrim (previews, docs).

- `surface-2`, `radius-lg`, `shadow-dialog` over the `overlay` scrim. 560px default width, 12vh from the top so it doesn't jump with content height.
- Focus moves to the first field or the primary button; `Esc` and the close button dismiss; focus returns to the trigger.
- Title says the decision ("Stop this run?"), the primary button says the outcome ("Stop and keep changes") — never "OK".

**Don't** use a dialog for settings or management screens; those are full pages under Settings. Ergo's old Connections, Profiles, Archives and Workspace Settings modals all move there.
