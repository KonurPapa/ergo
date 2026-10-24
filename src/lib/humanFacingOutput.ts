/**
 * How agents write the two things the user reads during and after a run: the completion record and a question
 * asked mid-run. Shared by the CLI run prompts (cliAgents.ts) and the in-app pipeline (Logger, ask_human).
 *
 * Distilled from docs/skills/i-have-adhd: lead with what to do or what now works, one concrete next action, no
 * tangents, no preamble / recap / pleasantries, matter-of-fact errors, lists capped. Only the rules that shape these
 * two outputs are here; the full skill is written for chat replies and would cost tokens on every run.
 */

/** Completion record headings, in order (the parsers in useCliAgentRuns / memoryStore read these). */
export const COMPLETION_RECORD_FORMAT =
  `**Done:** <one sentence, concrete: what now works. If the task is not finished: what works and what is left>\n\n` +
  `**Try it:** <one action under 2 minutes that shows it working: a command to run, a page to open, a button to press — or "Nothing to try: <why>">\n\n` +
  `**Changed:**\n` +
  `- \`path/to/file.ext\` — a few words\n` +
  `- (at most 5 bullets; group related files, e.g. "\`src/components/*\` — 4 files, menu wiring")\n\n` +
  `**Verified:** <one line: the check you ran and its result — or "Not verified: <why>">\n\n` +
  `**Needs your review:**\n` +
  `- [ ] <one bounded check the user does by hand, with where to look> (at most 3, most important first; or write "None")\n\n` +
  `**Separately:** <optional, one line: an unrelated problem you noticed and did not fix. Omit the heading when there is none>`;

/** Writing rules for the completion record (appended after the format). */
export const COMPLETION_RECORD_RULES =
  `Keep the whole record under 120 words. It is read by a person who scans it in seconds: the Done line says what now works, the Try it line says what to do next. ` +
  `No code, no command output, no narrative of your process, no recap, no opener ("I've…", "Great…"), no closer ("Let me know…"). ` +
  `Be accurate: list only files you actually changed and checks you actually ran, with their real results. ` +
  `State failures plainly as cause and effect ("Build fails at src/a.ts:42: missing import"), never "there seems to be an issue". ` +
  `Drop hedging words that add no information and figurative phrases; keep a hedge only when it carries real uncertainty. ` +
  `Assumptions you made in place of asking go under Needs your review when they matter.`;

/** How an agent decides whether to ask, and how to shape the question (any channel). */
export const QUESTION_RULES =
  `ASKING THE USER:\n` +
  `- First answer it yourself: read the files, run a command, or pick the reasonable default and note the assumption in the completion record. Ask only for what only the user can decide or provide (a credential, a product choice, approval for a destructive step).\n` +
  `- Ask once, one question, then wait. Never several questions in one message.\n` +
  `- Shape (under 60 words, no greeting, no apology, no "let me know"):\n` +
  `  1. First line: the decision you need, as a question.\n` +
  `  2. Where you are: "Done so far: <what works>. Blocked on: <the one thing>."\n` +
  `  3. 2–4 options, your recommendation first and marked "(recommended)", each with a one-line trade-off. Do not add an "Other" option: Ergo always offers one where the user types their own answer.\n` +
  `  4. What you will do if there is no answer (the default).`;

/** ask_human arguments in the same shape (in-app pipeline). */
export const ASK_HUMAN_DESCRIPTION =
  `Ask the user a question mid-task. Only when blocked by something no file, command or reasonable default can settle: a credential, a product choice, approval for a destructive step. ` +
  `One question per call. "question": the decision needed, as one short question. ` +
  `"options": 2–4 choices, recommended first with " (recommended)" appended, each "<choice> — <one-line trade-off>". Do not add an "Other" option: Ergo always offers one for a typed answer. ` +
  `"context": one line "Done so far: <what works>. Blocked on: <the one thing>. Default if unanswered: <what you will do>." ` +
  `No greeting, no apology, under 60 words in all.`;
