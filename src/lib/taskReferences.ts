/**
 * Commands in task text: `@path` references a file (or folder) and `/skill-name` invokes a workspace skill.
 *
 *  - `@src/app.ts`, `@"notes/meeting notes.md"`, `@/home/me/spec.pdf`: relative paths are relative to the project's
 *    working folder. The editor's dropdown inserts them as inline code (`` `@src/app.ts` ``), which the markdown
 *    round trip keeps byte for byte (no autolinking of `app.ts`, no escaping, no smart quotes); typed ones work too.
 *  - `/task-triage-refactor`: the slug of an enabled skill's name. A slash word that names no enabled skill is plain
 *    text ("and/or", "/home", "a / b" are never commands).
 *
 * At run time the references are resolved once (resolveTaskReferences) and the manager gets them as prompt sections
 * (formatReferenceSections); both run paths (CLI and in-app) use the same text.
 */
import type { AgentContextItem, ProjectData, TaskItem, WorkspaceSkill } from '../types';
import { bridgeClient } from './bridgeClient';
import { scopedSkillsFor } from './scopedRules';

/** Bridge protocol that serves /api/files/search, /api/files/pick, /api/files/refs and the workspace-tool relay. */
export const TASK_REFERENCES_PROTOCOL = 4;

export function bridgeSupportsTaskReferences(): boolean {
  return (bridgeClient.getStatus().bridgeInfo?.protocol ?? 0) >= TASK_REFERENCES_PROTOCOL;
}

/**
 * The folder a project's agents work in (the cwd CLI runs launch with); relative paths in `@` references start here.
 * The first of the project's own Allowed Folders (its repo), else its folder in Ergo's storage.
 */
export function projectWorkingFolder(project: Pick<ProjectData, 'folderPath' | 'folders'> | null | undefined): string {
  return project?.folders?.[0]?.path || project?.folderPath || '~';
}

// ── Skills ──

/** The command name of a skill: its name in kebab case ("Task Triage & Refactor" → "task-triage-refactor"). */
export function skillSlug(skill: Pick<WorkspaceSkill, 'name' | 'id'>): string {
  const slug = (skill.name || '')
    .toLowerCase()
    .replace(/&/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || skill.id.replace(/^skill-/, '');
}

/** Enabled skills by command name; a later skill whose name gives the same slug is left out. */
export function skillsBySlug(skills: WorkspaceSkill[]): Map<string, WorkspaceSkill> {
  const out = new Map<string, WorkspaceSkill>();
  for (const s of skills) {
    if (!s.enabled) continue;
    const slug = skillSlug(s);
    if (!out.has(slug)) out.set(slug, s);
  }
  return out;
}

/** `/slug` at the start of the text or after whitespace / an opening bracket, ending at a word boundary. */
const SKILL_TOKEN_RE = /(^|[\s([{"'`])\/([a-z0-9][a-z0-9-]*)(?=$|[\s.,;:!?)\]}"'`])/gi;

/** The enabled skills the text invokes, in order of first use. Slash words that name no skill are ignored. */
export function findInvokedSkills(text: string, skills: WorkspaceSkill[]): WorkspaceSkill[] {
  const bySlug = skillsBySlug(skills);
  const out: WorkspaceSkill[] = [];
  for (const m of text.matchAll(SKILL_TOKEN_RE)) {
    const skill = bySlug.get(m[2].toLowerCase());
    if (skill && !out.includes(skill)) out.push(skill);
  }
  return out;
}

/** Ranges of the `/slug` commands in a text that name an enabled skill (for highlighting them in the editor). */
export function skillTokenRanges(text: string, slugs: Set<string>): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  for (const m of text.matchAll(SKILL_TOKEN_RE)) {
    if (!slugs.has(m[2].toLowerCase())) continue;
    const from = (m.index ?? 0) + m[1].length;
    out.push({ from, to: from + 1 + m[2].length });
  }
  return out;
}

/** True when a skill calls Ergo's workspace tools (workspace_create_task, …): CLI agents then get them for the run. */
export function skillUsesWorkspaceTools(skill: WorkspaceSkill): boolean {
  return /\bworkspace_[a-z_]+/.test(`${skill.instructions}\n${skill.rules || ''}`);
}

// ── Files ──

/** `@path` or `@"path with spaces"` at the start of the text or after whitespace / an opening bracket / a backtick. */
const FILE_TOKEN_RE = /(^|[\s([{`])@(?:"([^"\n]+)"|([^\s"`]+))/g;

/** The file paths the text references, in order of first use (as written: relative, absolute or `~/`). */
export function findFileReferences(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(FILE_TOKEN_RE)) {
    // Sentence punctuation after an unquoted path isn't part of it ("see @src/app.ts.").
    const raw = (m[2] ?? m[3].replace(/[.,;:!?)\]}]+$/, '')).trim();
    if (!raw || raw.includes('@')) continue; // an email-like word, not a path
    if (!out.includes(raw)) out.push(raw);
  }
  return out;
}

/** How the editor writes a reference: quoted when the path has whitespace. */
export function formatFileReference(path: string): string {
  return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

// ── The command being typed (editor dropdown) ──

export interface ActiveCommand {
  trigger: '@' | '/';
  /** What follows the trigger so far. */
  query: string;
  /** Offset of the trigger in the text. */
  start: number;
}

/**
 * The `@…` / `/…` command the cursor is in, from the text of its line up to the cursor; null when there is none.
 * `@"…` (an open quote) keeps spaces in the query.
 */
export function activeCommandAt(textBefore: string): ActiveCommand | null {
  const quoted = textBefore.match(/(^|[\s([{])@"([^"\n]*)$/);
  if (quoted) return { trigger: '@', query: quoted[2], start: textBefore.length - quoted[2].length - 2 };
  const m = textBefore.match(/(^|[\s([{])([@/])([^\s@`"]*)$/);
  if (!m) return null;
  const trigger = m[2] as '@' | '/';
  // A skill name has no slashes or dots: "/home/me" or "/1.5" is a path or a number, not a skill being typed.
  if (trigger === '/' && /[^a-z0-9-]/i.test(m[3])) return null;
  return { trigger, query: m[3], start: textBefore.length - m[3].length - 1 };
}

// ── Resolution at run time ──

export interface ResolvedFileReference {
  /** As written in the task. */
  ref: string;
  /** Absolute path on the user's machine (when the bridge could resolve it). */
  absPath?: string;
  /** Path relative to the working folder, when inside it. */
  relPath?: string;
  exists: boolean;
  isDirectory?: boolean;
  size?: number;
  /** Outside the working folder: agents may not be able to read it, so its text is included (small text files only). */
  outside?: boolean;
  content?: string;
  /** Why an outside file's text isn't included. */
  note?: string;
}

export interface InvokedSkillRef {
  id: string;
  slug: string;
  name: string;
  description: string;
  rules?: string;
  instructions: string;
  usesWorkspaceTools: boolean;
}

/** A task's commands, resolved when its run starts (persisted with a CLI run, so a resumed manager sees the same). */
export interface TaskReferenceContext {
  skills: InvokedSkillRef[];
  files: ResolvedFileReference[];
}

/** The task text the commands are read from: title, subtasks, and a freeform brief's source text. */
export function taskCommandText(task: Pick<TaskItem, 'title' | 'subtasks'>, brief?: Pick<AgentContextItem, 'sourceContent'>): string {
  return [task.title, ...(task.subtasks || []).map((s) => s.text), brief?.sourceContent || ''].filter(Boolean).join('\n');
}

export function hasTaskReferences(refs: TaskReferenceContext | undefined): refs is TaskReferenceContext {
  return Boolean(refs && (refs.skills.length > 0 || refs.files.length > 0));
}

/**
 * Resolves a task's commands: the skills from the given (enabled) workspace skills, the files through the bridge
 * (relative to `cwd`). Never throws: files the bridge can't check are passed on as written. Undefined when the task
 * has no commands.
 */
export async function resolveTaskReferences(
  task: Pick<TaskItem, 'title' | 'subtasks' | 'swimLaneId'>,
  brief: Pick<AgentContextItem, 'sourceContent' | 'sourceLaneId'> | undefined,
  skills: WorkspaceSkill[],
  cwd: string
): Promise<TaskReferenceContext | undefined> {
  const text = taskCommandText(task, brief);
  const bySlug = skillsBySlug(skills);
  // Invoked with /name in the task, or set by the user for every task or for the task's lane.
  const named = findInvokedSkills(text, skills);
  const scoped = scopedSkillsFor(task.swimLaneId ?? brief?.sourceLaneId, skills).filter((s) => !named.includes(s));
  const invoked: InvokedSkillRef[] = [...named, ...scoped].map((s) => ({
    id: s.id,
    slug: [...bySlug.entries()].find(([, v]) => v === s)?.[0] || skillSlug(s),
    name: s.name,
    description: s.description,
    ...(s.rules ? { rules: s.rules } : {}),
    instructions: s.instructions,
    usesWorkspaceTools: skillUsesWorkspaceTools(s),
  }));
  const refs = findFileReferences(text);
  let files: ResolvedFileReference[] = refs.map((ref) => ({ ref, exists: true }));
  if (refs.length > 0 && bridgeSupportsTaskReferences()) {
    try {
      const res = await bridgeClient.fetch('/api/files/refs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root: cwd, refs }),
      });
      const json = await res.json();
      if (res.ok && Array.isArray(json?.files)) files = json.files as ResolvedFileReference[];
    } catch (err) {
      console.warn('[Ergo References] Could not resolve the referenced files:', err);
    }
  }
  if (invoked.length === 0 && files.length === 0) return undefined;
  return { skills: invoked, files };
}

// ── Prompt sections ──

export interface ReferenceSectionOptions {
  /** The agent can call Ergo's workspace_* tools (in-app runs always; CLI runs through the bridge relay). */
  workspaceTools: boolean;
}

/** The SKILLS and REFERENCED FILES sections of a manager prompt (empty when the task has no commands). */
export function formatReferenceSections(refs: TaskReferenceContext | undefined, opts: ReferenceSectionOptions): string[] {
  if (!hasTaskReferences(refs)) return [];
  const sections: string[] = [];
  if (refs.skills.length > 0) {
    const blocks = refs.skills.map((s) => {
      const lines = [`### /${s.slug} — ${s.name}`, s.description];
      if (s.rules) lines.push(`Rules: ${s.rules}`);
      lines.push('Instructions:', s.instructions.trim());
      return lines.join('\n');
    });
    const needsTools = refs.skills.some((s) => s.usesWorkspaceTools);
    const toolsNote = !needsTools
      ? ''
      : opts.workspaceTools
        ? `\nThe Ergo workspace tools these skills call (workspace_list_swim_lanes, workspace_create_subtask, …) are available to you as tools; they act on the user's task board in Ergo.`
        : `\nThe Ergo workspace tools these skills mention (workspace_*) are NOT available in this run. Do every part you can without them, and list the steps you could not do in your completion record.`;
    sections.push(
      `SKILLS THE USER INVOKED (written as /name in the task, or set by the user for every task or for this task's swim lane; apply each one as part of this task, following its rules):${toolsNote}\n\n${blocks.join('\n\n')}`
    );
  }
  if (refs.files.length > 0) {
    const lines: string[] = [];
    const bodies: string[] = [];
    for (const f of refs.files) {
      const shown = f.relPath || f.absPath || f.ref;
      if (!f.exists) {
        lines.push(`- ${f.ref} — not found${f.absPath ? ` (looked for ${f.absPath})` : ''}; ask or proceed without it`);
        continue;
      }
      const kind = f.isDirectory ? ' (folder)' : '';
      if (f.outside) {
        if (f.content !== undefined) {
          lines.push(`- ${shown}${kind} — outside your working folder; its contents are below`);
          bodies.push(`<file path="${shown}">\n${f.content}\n</file>`);
        } else {
          lines.push(`- ${shown}${kind} — outside your working folder${f.note ? ` (${f.note})` : ''}`);
        }
      } else {
        lines.push(`- ${shown}${kind}`);
      }
    }
    sections.push(
      `FILES THE USER REFERENCED (written as @path in the task; read them before you start: they are what the task is about or what it should follow):\n${lines.join('\n')}` +
        (bodies.length ? `\n\n${bodies.join('\n\n')}` : '')
    );
  }
  return sections;
}

/** One paragraph for the brief writer, so it reads the commands as references rather than as requirements. */
export function formatReferenceNoteForBrief(refs: TaskReferenceContext | undefined): string {
  if (!hasTaskReferences(refs)) return '';
  const parts: string[] = [];
  if (refs.skills.length > 0) {
    parts.push(
      `Skills invoked (the manager receives their full instructions; mention them in Constraints only as "Apply /<name>"): ` +
        refs.skills.map((s) => `/${s.slug} = ${s.name}: ${s.description}`).join('; ')
    );
  }
  if (refs.files.length > 0) {
    parts.push(`Files referenced with @ (the manager reads them; list them under Known context): ${refs.files.map((f) => f.relPath || f.absPath || f.ref).join(', ')}`);
  }
  return parts.join('\n');
}

/** The run step that shows what the task's commands resolved to. */
export function describeTaskReferences(refs: TaskReferenceContext): string {
  const lines: string[] = [];
  for (const s of refs.skills) lines.push(`Skill /${s.slug}: ${s.name}`);
  for (const f of refs.files) {
    const shown = f.relPath || f.absPath || f.ref;
    lines.push(
      !f.exists
        ? `File @${f.ref}: not found`
        : `${f.isDirectory ? 'Folder' : 'File'} @${shown}${f.outside ? (f.content !== undefined ? ' (outside the project; contents included)' : ` (outside the project${f.note ? `; ${f.note}` : ''})`) : ''}`
    );
  }
  return lines.join('\n');
}
