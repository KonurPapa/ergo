# Task timeline & follow-ups — locked spec (2026-11-06)

Decisions confirmed by the user. Every UI piece uses existing ergo-design tokens/components (Tabs, Composer, onboarding step bars).

## Header
- Keep: the TODO.md section label, the task title (about 15% smaller than now), and one status line (e.g. "Queued 2nd · Medium · Details").
- Remove: subtask text and the brief preview.

## Stage bars (replace underline tabs)
- Order: **Related · Brief · Runs · Notes**.
- Each tab has a bar above its label, styled like the onboarding steps (`.eg-onb-bar`).
- **Run progress:** completed stages are filled with `ink`; the running stage animates its `ink` fill and shows a live dot.
- **Your view:** the tab you are viewing is `accent` (green). Where it overlaps progress, green wins.
- **Following:**
  - The view follows the run by default and slides between panels the way onboarding does.
  - A manual click stops following. Clicking the running stage starts following again.
  - Your view never affects the run.
- A stage you haven't reached yet stays disabled.

## Timeline (vertical, oldest at the top)
- **Cycle 0:** the original run, with all four stage tabs.
- **Each follow-up** is one cycle block. Its header is "Follow-up N · timestamp", followed by your message, then a two-tab bar: **Runs · Notes** (the related picks and brief are reused).
- **Earlier cycles** collapse to one line: timestamp · your message · outcome. Click a line to expand it. Only the newest cycle is open.
- When a follow-up starts, the card scrolls smoothly to the new block.
- **Saving:** the thread is saved on the brief (`cycles[]`), so it survives a reload. It is no longer only component state.

## Prompt box
- It is pinned above the footer (the model chip and the Run/Stop row) and is visible during every stage.
- **Placeholder:**
  - While running: "Give direction to the current task…"
  - When finished: "Add a follow-up to the task…"
- **Delivery:**
  - Mid-run is always steering. "Queued" only means the agent can't take input yet; the message is delivered as soon as it can.
  - After the task finishes, a message is always a follow-up. There are no follow-ups queued ahead of time.

## Steering in every stage
- **Related / Brief:** if the brief is still being written, the call restarts with your message included. After the brief is done, the message goes to the manager as direction from you.
- **Runs:** the manager or a worker gets it, as today.
- **Notes (verifier or completion note):** the manager gets the message and resumes work, then the verifier and completion note run again. It stays the same cycle.
- Applies to both CLI runs and the in-app pipeline.

## Task status
- While a follow-up runs, the task shows as running in the task list and in TODO.md. It is still one task, with the follow-up as its child cycle.

## Completion notes
- Same short ethos as before (under about 120 words).
- Each cycle's note is the agent's "reply" in the thread.
- Your message is stored in full, not cut to 240 characters.

## Separate task (later)
- **"Follow up as new task"** links back to the original. Its brief always includes the original's brief, completion notes and agent notes, looked up by task ID, not by similarity. Not part of this build unless asked.
