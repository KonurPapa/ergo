import { type WorkspaceSkill } from '../types';
import { writeFilesToDisk } from './fileSystem';

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

const STORAGE_KEY = 'ergo_workspace_skills';

/**
 * Load all workspace skills from storage or initialize with built-in skills.
 */
export function getWorkspaceSkills(): WorkspaceSkill[] {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed: WorkspaceSkill[] = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length > 0) {
        // Merge in any newly added built-ins that may not be present in saved
        const existingIds = new Set(parsed.map((s) => s.id));
        const missingBuiltins = BUILTIN_WORKSPACE_SKILLS.filter((b) => !existingIds.has(b.id));
        return [...parsed, ...missingBuiltins];
      }
    }
  } catch (err) {
    console.warn('[Skills Manager] Failed to load skills from localStorage:', err);
  }
  return BUILTIN_WORKSPACE_SKILLS;
}

/**
 * Persist skills to storage and write markdown skill files to disk.
 */
export function saveWorkspaceSkills(skills: WorkspaceSkill[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(skills));
  } catch (err) {
    console.warn('[Skills Manager] Failed to save skills to localStorage:', err);
  }

  // Asynchronously write active skill docs to workspace disk (.agents/skills/<id>/SKILL.md)
  syncSkillsToWorkspace(skills).catch((err) => {
    console.warn('[Skills Manager] Non-fatal: could not write skill markdown files to disk:', err);
  });
}

/**
 * Synchronize skill markdown files directly into the project's codebase (.agents/skills/<id>/SKILL.md)
 */
export async function syncSkillsToWorkspace(skills?: WorkspaceSkill[]): Promise<void> {
  const allSkills = skills || getWorkspaceSkills();
  const filesToWrite = allSkills.map((skill) => {
    const dirName = skill.id.replace(/^skill-/, '');
    const filePath = skill.filePath || `.agents/skills/${dirName}/SKILL.md`;
    const content = `---
name: "${skill.name}"
description: "${skill.description.replace(/"/g, '\\"')}"
enabled: ${skill.enabled}
triggers: [${skill.triggerKeywords.map((k) => `"${k}"`).join(', ')}]
---

# ${skill.name}

${skill.description}

## Rules & Constraints
${skill.rules || 'Follow standard workspace safety rules.'}

## Instructions
${skill.instructions}
`;
    return { filePath, content };
  });

  try {
    await writeFilesToDisk(filesToWrite);
  } catch (err) {
    console.warn('[Skills Manager] Failed to write skill files to disk:', err);
  }
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
