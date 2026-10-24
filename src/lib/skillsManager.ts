import { type WorkspaceSkill } from '../types';
import { readFilesFromDisk, writeFilesToDisk } from './fileSystem';

export const BUILTIN_WORKSPACE_SKILLS: WorkspaceSkill[] = [
  {
    id: 'skill-task-triage-refactor',
    name: 'Task Triage & Refactor',
    description: 'Directly refine, organize, and break down complex tasks into clear subtasks in the human workspace.',
    rules: 'Always preserve human intent. When breaking down tasks, ensure each subtask has a verifiable definition of done. Do not delete user tasks without explicit instruction.',
    instructions: `When user asks to clean up, refactor, or structure workspace tasks:
1. Call \`workspace_list_swim_lanes()\` and read active tasks.
2. For large or vague tasks, call \`workspace_create_subtask()\` to add concrete checklist items.
3. Update task titles to be actionable verbs (e.g. "Implement authentication flow" instead of "Auth").
4. Mark completed items using \`workspace_update_task()\` or \`workspace_update_subtask()\`.`,
    triggerKeywords: ['refactor tasks', 'break down', 'triage', 'subtasks', 'clean up backlog', 'organize tasks'],
    enabled: true,
    isBuiltIn: true,
    filePath: '.agents/skills/task-triage-refactor/SKILL.md',
    createdAt: '2026-01-01T00:00:00.000Z'
  },
  {
    id: 'skill-swim-lane-organizer',
    name: 'Swim Lane Workflow Organizer',
    description: 'Categorize, create, and route tasks between swim lanes (e.g. Backlog, Sprint, Review).',
    rules: 'A minimum of 1 swim lane must always be maintained. When moving tasks, report the source and destination lanes clearly.',
    instructions: `When organizing human swim lanes:
1. Call \`workspace_list_swim_lanes()\` to inspect existing columns.
2. If new workflow stages are needed, call \`workspace_create_swim_lane({ title })\`.
3. Move tasks between lanes using \`workspace_move_task_lane({ taskId, targetLaneId })\`.
4. Keep the swim lanes clean and focused on high-priority items.`,
    triggerKeywords: ['swimlane', 'swim lane', 'move lane', 'workflow', 'sprint', 'kanban', 'organize lanes'],
    enabled: true,
    isBuiltIn: true,
    filePath: '.agents/skills/swim-lane-organizer/SKILL.md',
    createdAt: '2026-01-01T00:00:00.000Z'
  },
  {
    id: 'skill-ai-execution-scheduler',
    name: 'Autonomous Task Scheduler & Sequencer',
    description: 'Automate task execution sequences, parallel runs, and time-based cron scheduling.',
    rules: 'Verify dependencies before sequencing tasks. For scheduled runs, specify unambiguous ISO timestamps or standard 5-part cron expressions.',
    instructions: `When automating task executions or scheduling runs:
1. To run tasks in order: Call \`workspace_run_tasks_sequence({ taskIds })\`.
2. To run independent tasks concurrently: Call \`workspace_run_tasks_parallel({ taskIds })\`.
3. To schedule a task: Call \`workspace_schedule_task({ taskId, scheduledIso, cronExpr })\`.
4. To cancel a schedule: Call \`workspace_cancel_scheduled_task({ taskId })\`.`,
    triggerKeywords: ['schedule', 'cron', 'run sequence', 'run parallel', 'execute tasks', 'automate execution', 'batch run'],
    enabled: true,
    isBuiltIn: true,
    filePath: '.agents/skills/ai-execution-scheduler/SKILL.md',
    createdAt: '2026-01-01T00:00:00.000Z'
  },
  {
    id: 'skill-external-mcp-inspector',
    name: 'External MCP Connector & Tool Inspector',
    description: 'Inspect connected MCP servers, discover capabilities, and mobilize tools for the task.',
    rules: 'Tool and server permissions or removals are strictly manual and human-controlled. You may read tools and server status, but do not attempt administrative removal.',
    instructions: `When exploring or utilizing external tools:
1. Call \`workspace_list_mcp_servers()\` to see available connections (filesystem, github, remote APIs).
2. Call \`workspace_read_mcp_tools({ serverId })\` to discover exact schemas for needed tools.
3. Call specific external tools (e.g. read_file, create_issue) as required to solve the task.`,
    triggerKeywords: ['mcp', 'tools list', 'external tools', 'inspect mcp', 'github mcp', 'filesystem tools'],
    enabled: true,
    isBuiltIn: true,
    filePath: '.agents/skills/external-mcp-inspector/SKILL.md',
    createdAt: '2026-01-01T00:00:00.000Z'
  }
];

/**
 * Workspace skills live on the user's machine, in <storage root>/config/workspace-skills.json (read and written through
 * the bridge): the user's own skills plus their changes to the built-ins. The built-ins themselves ship with the app.
 * The app keeps the loaded list in memory; nothing about skills is kept in the browser.
 */
const SKILLS_FILE = 'config/workspace-skills.json';
/** Where skills used to be kept (browser localStorage): moved to SKILLS_FILE once, then cleared. */
const LEGACY_STORAGE_KEY = 'ergo_workspace_skills';

interface SkillsFile {
  version: 1;
  /** The user's own skills. */
  custom: WorkspaceSkill[];
  /** The user's changes to built-in skills (enabled flag, edited text), by id. */
  builtinOverrides: Record<string, Partial<WorkspaceSkill>>;
}

let cache: WorkspaceSkill[] = BUILTIN_WORKSPACE_SKILLS;
const listeners = new Set<(skills: WorkspaceSkill[]) => void>();

const OVERRIDABLE: Array<keyof WorkspaceSkill> = ['name', 'description', 'rules', 'instructions', 'triggerKeywords', 'enabled', 'updatedAt'];

function fromFile(file: Partial<SkillsFile> | null): WorkspaceSkill[] {
  const overrides = file?.builtinOverrides || {};
  const builtins = BUILTIN_WORKSPACE_SKILLS.map((b) => ({ ...b, ...(overrides[b.id] || {}), id: b.id, isBuiltIn: true }));
  const custom = (Array.isArray(file?.custom) ? file!.custom : []).filter((s) => s && s.id && !BUILTIN_WORKSPACE_SKILLS.some((b) => b.id === s.id));
  return [...builtins, ...custom.map((s) => ({ ...s, isBuiltIn: false }))];
}

function toFile(skills: WorkspaceSkill[]): SkillsFile {
  const builtinOverrides: Record<string, Partial<WorkspaceSkill>> = {};
  for (const b of BUILTIN_WORKSPACE_SKILLS) {
    const current = skills.find((s) => s.id === b.id);
    if (!current) continue;
    const diff: Partial<WorkspaceSkill> = {};
    for (const key of OVERRIDABLE) {
      if (JSON.stringify(current[key]) !== JSON.stringify(b[key])) (diff as any)[key] = current[key];
    }
    if (Object.keys(diff).length > 0) builtinOverrides[b.id] = diff;
  }
  return { version: 1, custom: skills.filter((s) => !s.isBuiltIn), builtinOverrides };
}

function setCache(skills: WorkspaceSkill[]) {
  cache = skills;
  listeners.forEach((cb) => cb(skills));
}

/** The workspace skills as last loaded from (or saved to) disk; the built-ins until the first load finishes. */
export function getWorkspaceSkills(): WorkspaceSkill[] {
  return cache;
}

export function subscribeWorkspaceSkills(cb: (skills: WorkspaceSkill[]) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Reads the skills from the user's machine (moving any browser-kept skills there once). Never throws. */
export async function loadWorkspaceSkills(): Promise<WorkspaceSkill[]> {
  try {
    const files = await readFilesFromDisk([SKILLS_FILE]);
    const raw = files[SKILLS_FILE];
    if (raw) {
      setCache(fromFile(JSON.parse(raw)));
      return cache;
    }
    let legacy: WorkspaceSkill[] | null = null;
    try {
      const saved = localStorage.getItem(LEGACY_STORAGE_KEY);
      legacy = saved ? JSON.parse(saved) : null;
    } catch {}
    if (Array.isArray(legacy) && legacy.length > 0) {
      const merged = fromFile(toFile(legacy.map((s) => ({ ...s, isBuiltIn: BUILTIN_WORKSPACE_SKILLS.some((b) => b.id === s.id) }))));
      if (await writeSkillsFile(merged)) {
        try {
          localStorage.removeItem(LEGACY_STORAGE_KEY);
        } catch {}
      }
      setCache(merged);
    }
  } catch (err) {
    console.warn('[Skills Manager] Could not load workspace skills from disk:', err);
  }
  return cache;
}

async function writeSkillsFile(skills: WorkspaceSkill[]): Promise<boolean> {
  const res = await writeFilesToDisk([{ filePath: SKILLS_FILE, content: JSON.stringify(toFile(skills), null, 2) }]);
  return res.success;
}

/** Saves the skills to the user's machine. */
export function saveWorkspaceSkills(skills: WorkspaceSkill[]): void {
  setCache(skills);
  writeSkillsFile(skills).catch((err) => console.warn('[Skills Manager] Could not save workspace skills to disk:', err));
}

/**
 * Create a new custom skill
 */
export function addCustomSkill(
  skillData: Omit<WorkspaceSkill, 'id' | 'createdAt' | 'updatedAt' | 'isBuiltIn'>
): WorkspaceSkill {
  const current = getWorkspaceSkills();
  const id = `skill-custom-${Date.now().toString(36)}`;
  const dirName = id.replace(/^skill-/, '');
  const now = new Date().toISOString();

  const newSkill: WorkspaceSkill = {
    ...skillData,
    id,
    isBuiltIn: false,
    filePath: `.agents/skills/${dirName}/SKILL.md`,
    createdAt: now,
    updatedAt: now
  };

  const next = [...current, newSkill];
  saveWorkspaceSkills(next);
  return newSkill;
}

/**
 * Update an existing skill
 */
export function updateSkill(id: string, patch: Partial<WorkspaceSkill>): WorkspaceSkill | null {
  const current = getWorkspaceSkills();
  const idx = current.findIndex((s) => s.id === id);
  if (idx === -1) return null;

  const updated: WorkspaceSkill = {
    ...current[idx],
    ...patch,
    updatedAt: new Date().toISOString()
  };

  current[idx] = updated;
  saveWorkspaceSkills(current);
  return updated;
}

/**
 * Delete a custom skill (built-ins cannot be deleted, only disabled)
 */
export function deleteSkill(id: string): boolean {
  const current = getWorkspaceSkills();
  const target = current.find((s) => s.id === id);
  if (!target || target.isBuiltIn) return false;

  const next = current.filter((s) => s.id !== id);
  saveWorkspaceSkills(next);
  return true;
}

/**
 * Toggle enabled state of a skill
 */
export function toggleSkill(id: string): boolean {
  const current = getWorkspaceSkills();
  const target = current.find((s) => s.id === id);
  if (!target) return false;

  target.enabled = !target.enabled;
  target.updatedAt = new Date().toISOString();
  saveWorkspaceSkills(current);
  return true;
}

/**
 * Format enabled workspace skills into structured Markdown for injection into the AI's baseline system prompt.
 */
export function formatSkillsForAiContext(skills?: WorkspaceSkill[]): string {
  const allSkills = skills || getWorkspaceSkills();
  const active = allSkills.filter((s) => s.enabled);
  if (active.length === 0) return '';

  const skillEntries = active.map((s, idx) => {
    const triggerStr = s.triggerKeywords.length > 0 ? `Trigger keywords: \`${s.triggerKeywords.join('`, `')}\`` : '';
    const rulesStr = s.rules ? `\n   - **Rules & Constraints**: ${s.rules}` : '';
    return `${idx + 1}. **${s.name}** (\`${s.id}\`)
   - **Description**: ${s.description}${rulesStr}
   - ${triggerStr}
   - **Workflow Instructions**:
${s.instructions.split('\n').map((line) => `     ${line}`).join('\n')}`;
  }).join('\n\n');

  return `### Active Workspace Skills & Rules
You have direct access to Ergo Workspace MCP tools to execute these actions inside the app. When addressing user goals, apply the corresponding skill workflows:

${skillEntries}

You can invoke Ergo Workspace MCP tools directly at any time:
- Tasks & Subtasks: \`workspace_create_task\`, \`workspace_update_task\`, \`workspace_delete_task\`, \`workspace_create_subtask\`, \`workspace_update_subtask\`, \`workspace_delete_subtask\`
- Swim Lanes: \`workspace_list_swim_lanes\`, \`workspace_create_swim_lane\`, \`workspace_update_swim_lane\`, \`workspace_delete_swim_lane\`, \`workspace_move_task_lane\`
- Execution & Scheduler: \`workspace_execute_ai_task\`, \`workspace_run_tasks_sequence\`, \`workspace_run_tasks_parallel\`, \`workspace_schedule_task\`, \`workspace_cancel_scheduled_task\`, \`workspace_create_ai_brief\`, \`workspace_update_ai_brief\`
- MCP Inspection: \`workspace_list_mcp_servers\`, \`workspace_read_mcp_server\`, \`workspace_read_mcp_tools\` (Note: tool permissions and server removals are strictly manual human-only actions).
`;
}
