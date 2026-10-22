/**
 * File scout — the profile's small model finds the files a task will need before the manager starts.
 *
 * The scout searches (code_search first) and returns file PATHS only; the manager gets them as "likely files" and
 * focuses its own code_search on them, searching the whole repository for anything they don't cover. Paths only:
 * when the scout's one-line reasons were passed along too, they decided how managers read an ambiguous task.
 * Measured on real Ergo tasks: 14% cheaper runs than code_search alone, same graded quality; the scout itself is
 * ~$0.006 and ~10 s. Pure (no browser or Node APIs): shared by the bridge (CLI scout) and the app (API scout).
 */

/** Most files handed to the manager. */
export const MAX_SCOUT_FILES = 12;
/** Tool rounds the scout may take (it usually needs 4-11). */
export const SCOUT_MAX_TURNS = 15;
/** The run starts without a list if the scout takes longer. */
export const SCOUT_TIMEOUT_MS = 30_000;

/** System prompt for the scout. `tools`: the tool names it has, e.g. "code_search, Read, Grep, Glob". */
export function scoutSystemPrompt(tools: string): string {
  return (
    'You are a file scout for a coding agent. You do NOT change code and you do NOT need to understand every detail. ' +
    'Your only job: identify the files the agent will need to read or change to complete the task below.\n\n' +
    `Tools: ${tools}. code_search is semantic + keyword search over this repository — use it first.\n` +
    '- Search for the feature/behaviour the task is about and follow it just far enough to know which files hold the code ' +
    'that will change, its callers, and the state, types, styles and storage it depends on.\n' +
    '- Be generous: include a file if it is plausibly relevant. Missing a file is far worse than an extra one. Usually 3-10 files.\n' +
    '- Be quick: stop as soon as you know the files.\n\n' +
    'Final answer: ONLY JSON, no prose:\n{"files":[{"file":"path/relative/to/repo","why":"<one line>"}]}'
  );
}

/** The task text the scout gets (title, description, checklist — not Ergo's run protocol). */
export function scoutUserPrompt(taskText: string): string {
  return `TASK:\n${taskText.trim().slice(0, 12_000)}`;
}

/**
 * Repository-relative file paths from the scout's answer (absolute paths under `root` are made relative; anything
 * outside the repository, or unparseable, is dropped). Empty when the answer has no usable list.
 */
export function parseScoutFiles(answer: string, root: string): string[] {
  const match = answer.match(/\{[\s\S]*\}/);
  if (!match) return [];
  let list: unknown;
  try {
    list = JSON.parse(match[0])?.files;
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const base = root.replace(/\/+$/, '');
  const out: string[] = [];
  for (const item of list) {
    let p = typeof item === 'string' ? item : typeof item?.file === 'string' ? item.file : '';
    p = p.trim().replace(/\\/g, '/');
    if (p.startsWith(`${base}/`)) p = p.slice(base.length + 1);
    p = p.replace(/^\.\/+/, '');
    if (!p || p.startsWith('/') || p.split('/').includes('..') || out.includes(p)) continue;
    out.push(p);
    if (out.length >= MAX_SCOUT_FILES) break;
  }
  return out;
}
