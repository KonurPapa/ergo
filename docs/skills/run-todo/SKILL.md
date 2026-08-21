---
name: run-todo
description: Implement one specific entry from TODO.md, end to end. Use when the user points at a todo and wants it built ("do todo 7", "implement the XLSX export item", "run-todo zones legend"). Indexes both todo files by heading and reads only the target's brief in AGENT_CONTEXT.md — never the whole file — then skims the other todo titles to place the work in the bigger picture, so it doesn't polish a surface another todo is about to overhaul, and asks about ordering when a different item should land first. Then reads the real code, implements, verifies, and logs one line in TODO.md with the detail in AGENT_CONTEXT.md.
argument-hint: <todo number, or a phrase that identifies it — e.g. "7" or "xlsx export formatting">
allowed-tools: Read Edit Write Grep Glob Bash AskUserQuestion TodoWrite
---

# run-todo — implement one TODO entry, in context of all the others

Take one entry out of the TODO file and actually build it. Two things separate
this from just reading a ticket and typing:

1. **You work from a brief.** Before touching code you write down what "done"
   means, and you keep checking back against it once you're deep in a 3000-line
   component. Otherwise the implementation drifts into whatever the code in front
   of you suggested.
2. **You place the work in the bigger picture first.** The user holds the whole
   roadmap in their head; the single entry you were handed doesn't. A neighboring
   todo may be about to rewrite the exact surface you're working on — building
   carefully there is wasted effort, and nobody will tell you that unless you go
   look.
3. **You navigate by heading, not by reading.** The context file is a growing
   archive of finished work; ~90% of it is irrelevant to any one item. Index it,
   read your own section, grep for the rest. Context spent on other people's build
   records is context not spent on the code you're changing.

## Flow

```
0. Build the index               (headings only — never read either file end to end)
1. Resolve the target            (which entry; confirm it back before working)
2. Write the brief               (from TODO.md + your item's AGENT_CONTEXT section)
3. Skim every other todo         (titles + seam grep → ASK if ordering/depth changes)
4. Read the real code            (verify the entry's notes are still true)
5. Implement                     (dependency order; additive + back-compat)
6. Verify                        (tests, grep new identifiers, load the app)
7. Log it                        (1 line in TODO.md, detail in AGENT_CONTEXT.md, + docs)
8. Report                        (what's done, what was left deliberately minimal + why)
```

---

## Step 0 — Build the index (headings only)

The todos live in **two** files. `docs/TODO.md` (root `TODO.md` in other repos) is
the human-readable list of asks — short. `docs/AGENT_CONTEXT.md` is the verbose
agent-facing mirror — briefs, build records, test notes, **thousands of lines**, of
which one section is yours and the rest is other people's finished work.

**Never read `AGENT_CONTEXT.md` end to end.** Reading 5,000 lines to use 300 is the
single most wasteful thing this skill can do. Work from an index instead:

```bash
wc -l docs/TODO.md docs/AGENT_CONTEXT.md
grep -nE '^#{1,3} ' docs/AGENT_CONTEXT.md     # section index, with line numbers
grep -nE '^[0-9]+\. |^# ' docs/TODO.md        # item titles, with line numbers
```

That's ~40 lines of output and it tells you everything you need to route:

- which items exist, live and archived, and what each is *about*;
- the line number where your target's section starts, and where the next one
  starts — the two numbers that make a scoped `Read` possible;
- whether your target has a context section at all.

Then read **only**:

- `AGENT_CONTEXT.md` lines 1 → end of the `## Coverage` table (~65 lines): the
  split rules and the `TODO.md` item → section map. Once, at the start.
- your target's section: `Read` with `offset` = its heading line, `limit` = the
  next heading's line minus it. One section, not the file.
- your target's bullets in `TODO.md` — plus, if the whole file is under ~200
  lines, just read it (it's cheaper than three greps and Step 3 wants the titles).

Everything else in `AGENT_CONTEXT.md` is reached by **targeted grep**, never by
scrolling: when you need to know whether anything else touches a seam, grep the
seam (Step 3), not the file.

The other headings are worth two seconds each even so — a title like
"Takeoff layering / z-order" in the Archive tells you the build record exists and
where to find it *if* your work lands there. Note it; don't open it.

If `AGENT_CONTEXT.md` doesn't exist in a given repo, everything lives in `TODO.md`
and you create the context file when you first write to it (copy the header,
coverage table and per-item shape from this repo's copy).

---

## Step 1 — Resolve the target

Match the user's argument to one entry, using the Step 0 index: a bare number is
the numbered item; a phrase matches on title and sub-bullet text. If the phrase
matches no title, `grep -ni '<phrase>' docs/TODO.md` — sub-bullet text is where the
real wording usually is. Then:

- **Ambiguous or matches several** — ask which one. Don't guess and burn an hour
  on the wrong item.
- **Whole item already `~~struck through~~`** — it's done. Say so and ask whether
  they meant its remaining live bullets or the `Follow-ups` in its context section.
- **Partially struck through** — implement only the live sub-bullets.
- **Huge item** (the sort with three levels of sub-bullets and several
  independent deliverables) — propose splitting it: name the slice you'd do now,
  and get a nod before starting.

State the resolved target in one line before moving on, so a
misresolution gets caught immediately.

---

## Step 2 — Write the brief (before any code)

Your brief is the **`Brief` section in `AGENT_CONTEXT.md`** for this item — the one
section you read in full in Step 0. `new-todo` writes it there precisely so you
don't have to reconstruct it. Restate it compactly (5–10 lines) in your response so
it's in front of you:

- **Done =** the user-visible behavior, phrased so you could verify it by hand.
- **Acceptance checks** — the concrete things you'll confirm in Step 6.
- **Files/functions** it names, and the pattern it says to copy.
- **Data model** change, if any.
- **Connections & Tools required** — which default or external MCP connections this task relies on.
- **Seams** that need to stay threaded.
- **Out of scope** — so you can point at it later.

### Resolving MCP Connections & Runtime Tools

Ergo provides an integrated MCP host environment with active tool discovery and security boundaries:

1. **Only Connected MCPs Are Visible at Runtime:**
   - The AI is **only ever presented with the list of MCPs and tools that are currently connected**. It is never told what is disconnected, and cannot assume any fixed list of possibilities (users can configure and add arbitrary custom MCPs at any time).
   - **Default Local Connections** (Filesystem MCP `server-filesystem`, Web Fetcher `server-fetch`, Git `mcp-server-git` over Local Stdio IPC) are always on by default and constrained to allowed directory roots (default `~/.ergo` sandbox + workspace paths).

2. **Default Assumption on Tools:**
   - If a specific or specialized MCP tool is not in the active connections list, **proceed under the assumption that you have the tools you need to do the job** using standard code implementation, local filesystem tools, git operations, web fetches, and native CLI execution.
   - Do not halt or prompt the user for missing tools unless the task's acceptance criteria **clearly and unmistakably require** an external integration (e.g., dispatching a live Slack notification, querying a remote CRM) that has no active connection. In that rare case, ask the user to connect the required MCP via the **Connections** screen (`McpHubModal`).

3. **Tool Permission Policies & Security Gates:**
   - Query tools (`read_file`, `fetch_markdown`, `git_status`, `list_directory`, `search_files`) are auto-approved by default.
   - Mutating/destructive actions (`write_file`, `git_commit`, external writes) trigger user permission confirmation prompts unless explicitly configured for auto-approval.

4. **Native Coding Agents:**
   - When executing via a configured CLI agent (Antigravity `agy`, Claude Code, Aider, Codex CLI), tasks run inside the real PTY terminal within the AI Workspace.

If the Step 0 index showed **no** context section (an older or hand-written entry —
the `## Coverage` table marks these "not written up"), derive the brief from the
`TODO.md` bullets plus a quick read of the code, and **write it into
`AGENT_CONTEXT.md`** under the item's number before you start, adding its row to
the coverage table. That's the file's whole purpose: the next agent shouldn't have
to re-derive it.

Then load the subtasks into `TodoWrite` in dependency order, so progress stays
visible and nothing silently drops.

Two kinds of bullet are **blocking**, and both come from how these entries get
written:

- **`Open question:`** — unresolved by design. Resolve it with the user (batch
  into the Step 3 question call) before coding the part it governs.
- **`Assumption:`** — someone's guess, recorded so it could be challenged.
  Sanity-check it against the code in Step 4; if it's wrong, surface it rather
  than quietly building on it.

`Related (not asked for):` bullets are **not** in scope. Leave them alone unless
the user says otherwise.

**The brief is your anchor.** Re-read it when you're deep in the weeds and again
before you call the work done. If what you're building no longer matches it,
stop and say so — either the brief was wrong or you drifted, and both are worth
a sentence to the user.

---

## Step 3 — Skim every other todo, then decide order and depth

One question: **does any other entry change how, how deeply, or whether I should do
this one now?** This is the step that gives you the developer's mental model
instead of a ticket's tunnel vision — and you answer it from titles and greps, not
by reading either file through.

**a. Titles first.** You already have every `TODO.md` item title from Step 0 (and
they're deliberately descriptive — "UI", "zones/breakouts", "Comparisons between
revisions"). Most items are obviously unrelated to your surface; dismiss them on
the title alone and say nothing. Expand only the two or three that plausibly touch
it, by reading *those* line ranges.

**b. Then grep the seam, not the file.** Once Step 4 tells you which files and
identifiers you'll actually touch, that's your search key — it finds the
interactions a title never would:

```bash
grep -niE 'totals\.js|worksheet|export' docs/TODO.md            # live asks on this seam
grep -niE 'totals\.js|worksheet|export' docs/AGENT_CONTEXT.md | head -40
```

A hit in `TODO.md` is a live item to classify below. A hit in `AGENT_CONTEXT.md` is
usually a finished build record — read the ±30 lines around it, and only then the
section, if it says something about your seam you didn't know. A grep that returns
nothing is a real answer: nobody else is on this surface.

**c. The `## Questions for team:` section** — it's a dozen lines at the end of
`TODO.md`; read it. An unanswered question there that bears on your entry is worth
raising before you build around it.

If a scan tempts you into opening a 400-line section "just to be safe", stop:
the thing you're protecting against is *another live item rewriting your surface*,
and live items are in `TODO.md`, which is short. Archived context sections can't
supersede anything — they already shipped.

### Classify the ones that touch your work

| Relationship | Signal | What it means for you |
|---|---|---|
| **Supersedes** | another item rewrites/overhauls the surface you'd build on (UI overhaul, export rewrite, storage migration) | anything you polish there is throwaway — go minimal, deliberately |
| **Prerequisite** | your item is much cheaper, or only correct, after that one lands | flag it and **ask** about ordering |
| **Shared seam** | both items touch the same file, field, or exporter | build so both can land: don't hardcode what the other needs to vary |
| **Overlapping** | the two items are partly the same work | say so before coding; maybe they should merge |
| **Downstream** | another item consumes what you're building | leave the hook, don't build their half |

### The ordering decision

**Interrupt and ask** (single batched `AskUserQuestion`, *before* writing code) when:

- the other item is a genuine prerequisite and doing yours first means real
  rework, or
- doing yours first produces substantial throwaway work in a surface the other
  item rewrites, or
- the two overlap enough that one of them should probably absorb the other.

Give them the actual trade-off: what you'd build now, what gets redone later,
roughly how much. Offer the concrete options — do the prerequisite first, do this
one minimally, do this one fully anyway.

**Go minimal, then report** (don't interrupt) when:

- the overlap sits in a layer that's cheap to redo — styling, polish, copy — and
  ordering is preference rather than correctness.

The user's example is the canonical case: a new panel, with a UI overhaul sitting
in another todo. Don't spend the afternoon on that panel's chrome. Either ask
whether they want the overhaul first, or build the panel functional-and-plain and
tell them why at the end.

### What "minimal" means here

Minimal is a scope choice, never a quality excuse:

- **Fully functional.** Every behavior in the brief works. Minimal ≠ half-wired.
- **Maximally conventional.** Reuse the existing components, tokens, and layout
  primitives rather than inventing anything — then the later overhaul sweeps your
  code up for free instead of having to unpick it.
- **No bespoke anything** in the superseded layer: no one-off CSS, no custom
  widget where a standard one fits.
- **Recorded.** One `Minimal:` line in the entry naming the todo you deferred to
  (format in Step 7), and raise it in the Step 8 report as an offered follow-up.

Never silently do a half job, and never silently expand into another todo's
scope. Both are the failure modes this step exists to prevent.

---

## Step 4 — Read the real code before editing it

The entry's notes were written at some point in the past; the code has moved
since. Open the files it names and confirm its claims — the function still
exists, the gap is still the gap, the pattern it says to copy is still the
pattern.

If the notes are **stale or wrong**, fix them as part of the work — the `Brief` in
`AGENT_CONTEXT.md` is usually where the wrong detail lives, so correct it there and
leave `TODO.md` alone unless the *ask itself* changed. Tell the user what changed.
A todo that lies is worse than one that's thin.

Skim [`AGENTS.md`](../../../AGENTS.md) ("Where things live" + "Conventions") if
it isn't already in context.

---

## Step 5 — Implement

Work the `TodoWrite` list in dependency order — data model, then logic, then UI,
then the other consumers of that data. Land it in coherent pieces rather than one
sprawling edit.

Non-negotiables in this repo:

- **Additive and back-compat.** New persisted fields must be optional; a project
  saved before your change must still load, with the old behavior when the field
  is absent.
- **Single-source shared logic.** Anything the canvas *and* an exporter both need
  goes in `web/src/lib/*.js` once, and both call it. Copy-pasting the math is how
  the canvas and the PDF end up disagreeing.
- **No native dialogs.** `dialog.alert/confirm/prompt` from
  `web/src/components/Dialog.jsx` for blocking prompts, `setCommitMsg(...)`
  toasts for transient status. A test fails the build otherwise.
- **Canvas performance.** Cursor-following UI writes to the DOM directly
  (`moveCrosshair`); never add React state that updates per mousemove.
- **Don't re-theme user data.** Condition colors and palettes belong to the user.
- **UI chrome conventions.** `data-tip` + `TooltipLayer` (not `title=`),
  `SelectMenu` (not native `<select>`), colors from `web/src/styles/tokens.css`.
  SVG presentation attributes need literal colors, not CSS vars.
- **MCP Tool Execution & Sandbox Boundaries.** Execute file and disk operations
  strictly within approved directory roots (`~/.ergo` default storage + workspace paths).
  Call registered tools via the local MCP host IPC bridge (`callMcpTool`). Respect
  user permission gates for mutating tools (`write_file`, `git_commit`, external writes).

Thread the seams the brief listed. The usual suspects: persistence
(`web/src/lib/store.js`), the canvas overlay
(`web/src/pages/TakeoffCanvas.jsx`), the schedules→groups→conditions and
zones hierarchies, `web/src/lib/totals.js`, every export channel in scope (CSV,
JSON, XLSX, report PDF, marked-set PDF, Bluebeam PDF+FDF), Bluebeam import
(`web/src/lib/bluebeam.js`), the MCP & Connections surface (`src/lib/mcpClient.ts`, `McpHubModal`),
the keybind registry (`web/src/lib/keybinds.js`), and Settings if it's toggleable.

If you hit something that makes the entry's plan unworkable, stop and say so with
the reason — don't quietly substitute a different feature.

---

## Step 6 — Verify

```bash
cd web && npm test          # pure geometry + totals math, and the no-native-dialogs guard
npm run build               # catches import-level breakage
```

Then, because **Vite does not flag undefined identifiers in JSX**: grep every new
identifier you introduced to confirm it's defined and imported where it's used.
This repo has been bitten by exactly that.

Add tests to `web/test/*.test.ts` for any new pure math.

Then check the brief's acceptance list by hand. The fastest end-to-end path is
the bundled sample plan ("Load sample plan"): load it, press `A`, trace a room,
open Report. If verifying needs the running app, the `run` skill covers launching
it.

Report failures as failures, with the output. Do not describe unverified work as
done.

---

## Step 7 — Write the log: one line in `TODO.md`, the detail in `AGENT_CONTEXT.md`

Two files, two audiences. Get this backwards and the TODO file becomes a wall of
text a human stops reading.

| | `docs/TODO.md` | `docs/AGENT_CONTEXT.md` |
|---|---|---|
| for | the human, at a glance | you, next time |
| budget | **1 line**, +1 if you deferred something | as long as it needs to be |
| holds | what works now, and where | why, how, what you tested, what you rejected |

### `TODO.md` — mark done, then one line

- `~~Strike through~~` the sub-bullets you finished; leave the rest live.
- Strike the item title only when the whole thing is done. Never strike anything
  you couldn't verify.
- A finished sub-bullet needs **no** note. The strikethrough *is* the log.
- Then add **one** line, ≤ ~160 chars, ending in a context link:

```
    - DONE: `lib/thing.js` — <what works now, one clause>. [context](AGENT_CONTEXT.md#<n>-<slug>)
```

- Add a **second** line only if Step 3 left something deliberately plain:

```
    - Minimal: <what's plain> — deferring to #<n>
```

- Genuine remaining work becomes a **live sub-bullet in the user's own voice** —
  terse, unstruck, indistinguishable from a bullet they'd write. Do *not* write a
  `Follow-ups:` prose line; if it's real work say it as work, and if it's merely
  context it belongs in the other file.

That's the whole `TODO.md` writeback. Two lines, worst case.

### What never goes in `TODO.md`

Cut it if a reader could get it from the struck text or by opening the file you
named — that's most of what wants to be written. Specifically banned:

- **Testing and validation notes.** "Validated round-trip against a real Revu
  export", "opens in LibreOffice", "tests pass". → context file.
- Function/constant names, seam-by-seam accounting, how it works internally.
- Rejected alternatives and reasoning. → context file.
- Dates, "successfully", "I implemented", line counts, restating the subtasks.

Style for the one line that survives: telegraphic. Fragments, `→ + ; w/`,
backticked paths, no sentences.

### `AGENT_CONTEXT.md` — the detail

Mirror the item by **number and title** and follow the shape documented at the top
of that file (`Status` / `Brief` / `Built` / `Validation` / `Follow-ups`, omitting
empty headings). Update the section you briefed in Step 2 rather than appending a
second one — `Edit` inside it; you don't need to re-read the file to write to it.
Everything you wanted to write in `TODO.md` goes here — decisions, rejected
options, what you tested and how, which MCP connections/tools were executed and their
outcomes, and the follow-up detail a one-liner can't carry.

Keep the file's own navigation honest, since Step 0 depends on it:

- **New section** → add its row to the `## Coverage` table.
- **Item finished and dropped from `TODO.md`** → move the section to the
  `## Archive` at the bottom, retitle it by name with its old number in an italic
  subtitle, and drop its coverage row.
- **`TODO.md` renumbered** → realign the active headings and the table in the same
  pass. Two numbering schemes in one file is how the last drift started.
- Write for grep: name the real files, functions and fields in the prose, because
  a targeted grep is how the next agent will find this section at all.

Anchors are GitHub-style slugs of the `### <n>. <title>` heading — lowercase,
spaces → `-`, punctuation dropped (`### 7. Import/Export` → `#7-importexport`).
Verify the link matches the heading you actually wrote.

### Good vs. bad

```
BAD  - DONE (one column spec, five consumers): `WORKSHEET_COLUMNS` in `web/src/lib/totals.js` is now
       the single column model — `Item · Notes · Qty 1–3/UOM 1–3 · Shapes · Waste % · Tag` (Tag off by
       default) — and the on-screen table, the XLSX, the JSON, the CSV builder and the marked-set PDF's
       worksheet page all render from it via `walkWorksheet`/`worksheetColumns`/... [+9 more lines]
     - Deliberately minimal: the **Item** column can't be switched off (a row with no identity is...
     - Notes: the TOTAL row only sums what totals honestly — the shape count, and a Qty slot whose...
     - Follow-ups (not blocking): a per-section subtotal row (the demo has none); a second XLSX...

GOOD - DONE: `totals.js` `WORKSHEET_COLUMNS` = one column spec → table + XLSX + JSON + CSV + marked-set PDF; new `lib/xlsx.js` writer matches the demo format. [context](AGENT_CONTEXT.md#importexport)
     - per-section subtotal row; a second XLSX sheet per zone; column choice into the Bluebeam legend
```

Nothing was lost — every clause of the BAD version now lives in `AGENT_CONTEXT.md`,
where it's still one click away and doesn't cost a human anything to skip.

Apply the same brevity to any entry you correct in Step 4 and to the `Minimal:`
line from Step 3.

### Docs

Sync what the change touches — `README.md` (Features / What's in the box),
`docs/USER_GUIDE.md` (shortcuts + the relevant section), `CHANGELOG.md`.

Don't commit or push unless the user asks.

---

## Step 8 — Report

Close with:

1. **What now works** — the acceptance checks, and how each was verified (test,
   build, by hand in the app). Failures stated plainly.
2. **Files changed**, as clickable links.
3. **What was left deliberately minimal, and why** — naming the todo you deferred
   to. Then ask whether they want that follow-up done now. This is the whole
   point of Step 3; don't let it evaporate into the diff.
4. **Anything the entry got wrong** that you corrected, and any `Assumption:` you
   found to be false.
5. **Any other todo this newly unblocks or collides with** — cheap to say, and
   it's the roadmap context they're holding in their head anyway.
