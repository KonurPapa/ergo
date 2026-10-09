import {
  type MCPServer,
  type MCPTool,
  type TaskItem,
  type AgentContextItem,
  type SwimLaneDoc,
  type McpToolExecutionResult
} from '../types';

/**
 * Interface for live React workspace context callbacks
 */
export interface WorkspaceActionBridge {
  getState: () => {
    tasks: TaskItem[];
    briefs: AgentContextItem[];
    swimLanes: SwimLaneDoc[];
    mcpServers: MCPServer[];
  };
  saveProject: (
    tasks: TaskItem[],
    briefs: AgentContextItem[],
    swimLanes?: SwimLaneDoc[]
  ) => void;
  executeAiTask?: (taskId: string | number) => void;
  runTasksSequence?: (tasks: TaskItem[], laneId: string, laneTitle: string) => void;
  runTasksParallel?: (tasks: TaskItem[], laneId: string, laneTitle: string) => void;
  scheduleTask?: (taskId: string | number, iso: string, cron?: string) => void;
  cancelScheduledTask?: (taskId: string | number) => void;
}

// Module-level bridge holding the latest live app context
let activeBridge: WorkspaceActionBridge | null = null;

export function registerWorkspaceActionBridge(bridge: WorkspaceActionBridge): () => void {
  activeBridge = bridge;
  return () => {
    if (activeBridge === bridge) {
      activeBridge = null;
    }
  };
}

export function getActiveWorkspaceBridge(): WorkspaceActionBridge | null {
  return activeBridge;
}

/**
 * Built-in Ergo Workspace MCP Tools specifications
 */
export const WORKSPACE_MCP_TOOLS: MCPTool[] = [
  // ── 1. Tasks & Subtasks CRUD ────────────────────────
  {
    id: 'tool-workspace-create-task',
    name: 'workspace_create_task',
    description: 'Create a new task with optional subtasks in the human workspace swim lane.',
    autoApprove: true,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The task title or action headline' },
        subtasks: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of subtask strings'
        },
        swimLaneId: { type: 'string', description: 'ID of the destination swim lane (optional, defaults to first lane)' },
        category: { type: 'string', description: 'Optional task category, e.g. "Tasks", "Bugfix", "Feature"' }
      },
      required: ['title']
    }
  },
  {
    id: 'tool-workspace-update-task',
    name: 'workspace_update_task',
    description: 'Update an existing task title, completion state, or status.',
    autoApprove: true,
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'ID or number of the task to update' },
        title: { type: 'string', description: 'New task title (optional)' },
        isDone: { type: 'boolean', description: 'Whether the task is marked completed' },
        status: { type: 'string', description: 'Status string: "not_started", "working", "done", or "partly_done"' }
      },
      required: ['taskId']
    }
  },
  {
    id: 'tool-workspace-delete-task',
    name: 'workspace_delete_task',
    description: 'Delete a task from the human workspace by its ID.',
    autoApprove: false,
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'ID or number of the task to delete' }
      },
      required: ['taskId']
    }
  },
  {
    id: 'tool-workspace-create-subtask',
    name: 'workspace_create_subtask',
    description: 'Add a new subtask item under an existing task.',
    autoApprove: true,
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Parent task ID' },
        text: { type: 'string', description: 'Subtask description or checklist text' }
      },
      required: ['taskId', 'text']
    }
  },
  {
    id: 'tool-workspace-update-subtask',
    name: 'workspace_update_subtask',
    description: 'Update or check off a specific subtask under a task.',
    autoApprove: true,
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Parent task ID' },
        subtaskIndex: { type: 'number', description: '0-based index of the subtask under the parent' },
        text: { type: 'string', description: 'New text for the subtask (optional)' },
        isDone: { type: 'boolean', description: 'Whether the subtask is checked' }
      },
      required: ['taskId', 'subtaskIndex']
    }
  },
  {
    id: 'tool-workspace-delete-subtask',
    name: 'workspace_delete_subtask',
    description: 'Remove a subtask from a parent task.',
    autoApprove: true,
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Parent task ID' },
        subtaskIndex: { type: 'number', description: '0-based index of the subtask to delete' }
      },
      required: ['taskId', 'subtaskIndex']
    }
  },

  // ── 2. Swim Lane CRUD & Task Movement ────────────────
  {
    id: 'tool-workspace-list-swim-lanes',
    name: 'workspace_list_swim_lanes',
    description: 'List all swim lanes in the active project with IDs, titles, and task counts.',
    autoApprove: true,
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    id: 'tool-workspace-create-swim-lane',
    name: 'workspace_create_swim_lane',
    description: 'Create a new swim lane column in the human workspace.',
    autoApprove: true,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Title of the new swim lane, e.g. "Sprint 2", "Review"' }
      },
      required: ['title']
    }
  },
  {
    id: 'tool-workspace-update-swim-lane',
    name: 'workspace_update_swim_lane',
    description: 'Rename an existing swim lane column.',
    autoApprove: true,
    inputSchema: {
      type: 'object',
      properties: {
        laneId: { type: 'string', description: 'ID of the swim lane to rename' },
        title: { type: 'string', description: 'New title for the swim lane' }
      },
      required: ['laneId', 'title']
    }
  },
  {
    id: 'tool-workspace-delete-swim-lane',
    name: 'workspace_delete_swim_lane',
    description: 'Delete a swim lane column. A minimum of 1 swim lane must always remain; deletion will be rejected if only 1 exists.',
    autoApprove: false,
    inputSchema: {
      type: 'object',
      properties: {
        laneId: { type: 'string', description: 'ID of the swim lane to remove' }
      },
      required: ['laneId']
    }
  },
  {
    id: 'tool-workspace-move-task-lane',
    name: 'workspace_move_task_lane',
    description: 'Move a task from one swim lane to another (e.g. from Backlog to In Progress).',
    autoApprove: true,
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'ID of the task to move' },
        targetLaneId: { type: 'string', description: 'Destination swim lane ID' },
        targetIndex: { type: 'number', description: 'Optional target index within the new lane' }
      },
      required: ['taskId', 'targetLaneId']
    }
  },

  // ── 3. Connecting / Reading External MCPs ──────────
  {
    id: 'tool-workspace-list-mcp-servers',
    name: 'workspace_list_mcp_servers',
    description: 'List all registered MCP servers, connection statuses, and tool summaries. (Permissions and deletions are strictly manual).',
    autoApprove: true,
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    id: 'tool-workspace-read-mcp-server',
    name: 'workspace_read_mcp_server',
    description: 'Inspect configuration, connection status, and details of a specific MCP server.',
    autoApprove: true,
    inputSchema: {
      type: 'object',
      properties: {
        serverId: { type: 'string', description: 'ID of the MCP server' }
      },
      required: ['serverId']
    }
  },
  {
    id: 'tool-workspace-read-mcp-tools',
    name: 'workspace_read_mcp_tools',
    description: 'Call tools/list on a connected MCP server to view all available tool schemas.',
    autoApprove: true,
    inputSchema: {
      type: 'object',
      properties: {
        serverId: { type: 'string', description: 'ID of the MCP server' }
      },
      required: ['serverId']
    }
  },

  // ── 4. Task Executions & Scheduler ──────────────────
  {
    id: 'tool-workspace-execute-ai-task',
    name: 'workspace_execute_ai_task',
    description: 'Execute an AI agent run on a specified workspace task.',
    autoApprove: true,
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'ID of the task to execute' }
      },
      required: ['taskId']
    }
  },
  {
    id: 'tool-workspace-run-tasks-sequence',
    name: 'workspace_run_tasks_sequence',
    description: 'Run multiple tasks in sequence (one after another) in the AI workspace.',
    autoApprove: true,
    inputSchema: {
      type: 'object',
      properties: {
        taskIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of task IDs to run in sequence'
        },
        laneId: { type: 'string', description: 'Optional swim lane ID containing the tasks' }
      },
      required: ['taskIds']
    }
  },
  {
    id: 'tool-workspace-run-tasks-parallel',
    name: 'workspace_run_tasks_parallel',
    description: 'Run multiple tasks concurrently in parallel in the AI workspace.',
    autoApprove: true,
    inputSchema: {
      type: 'object',
      properties: {
        taskIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of task IDs to run in parallel'
        },
        laneId: { type: 'string', description: 'Optional swim lane ID' }
      },
      required: ['taskIds']
    }
  },
  {
    id: 'tool-workspace-schedule-task',
    name: 'workspace_schedule_task',
    description: 'Schedule a task to run automatically at a specific time (ISO timestamp) or recurring cron expression.',
    autoApprove: true,
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'ID of the task to schedule' },
        scheduledIso: { type: 'string', description: 'ISO 8601 timestamp for one-time execution' },
        cronExpr: { type: 'string', description: 'Optional standard 5-part cron expression (e.g. "0 9 * * *")' }
      },
      required: ['taskId', 'scheduledIso']
    }
  },
  {
    id: 'tool-workspace-cancel-scheduled-task',
    name: 'workspace_cancel_scheduled_task',
    description: 'Cancel a pending scheduled task execution.',
    autoApprove: true,
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'ID of the task whose schedule to cancel' }
      },
      required: ['taskId']
    }
  },
  {
    id: 'tool-workspace-create-ai-brief',
    name: 'workspace_create_ai_brief',
    description: 'Create or update the AI workspace brief document for a task.',
    autoApprove: true,
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID associated with this brief' },
        overview: { type: 'string', description: 'Overview goals and plan' },
        brief: { type: 'string', description: 'Gherkin acceptance criteria or brief text' }
      },
      required: ['taskId', 'overview']
    }
  },
  {
    id: 'tool-workspace-update-ai-brief',
    name: 'workspace_update_ai_brief',
    description: 'Update an existing AI task brief document in the AI workspace.',
    autoApprove: true,
    inputSchema: {
      type: 'object',
      properties: {
        briefId: { type: 'string', description: 'Brief ID or source task ID' },
        overview: { type: 'string', description: 'Updated overview' },
        buildAndVerification: { type: 'string', description: 'Verification steps or logs' },
        completion: { type: 'string', description: 'Completion summary' }
      },
      required: ['briefId']
    }
  }
];

/**
 * Built-in Ergo Workspace MCP Server
 */
export const WORKSPACE_MCP_SERVER: MCPServer = {
  id: 'mcp-ergo-workspace',
  name: 'Ergo Workspace Actions',
  description: 'Built-in MCP server for direct workspace manipulation: Task CRUD, Swimlane CRUD, Task Movement, AI Executions, and Scheduler.',
  serverType: 'bundled_harness',
  category: 'productivity',
  transport: 'Local Stdio',
  endpoint: 'stdio://ergo-internal-workspace',
  status: 'connected',
  iconName: 'Folder',
  tools: WORKSPACE_MCP_TOOLS,
  lastSyncedAt: new Date().toISOString()
};

/**
 * Execute an Ergo Workspace action directly against the live project bridge.
 */
export async function executeWorkspaceToolAction(
  actionName: string,
  args: Record<string, any>
): Promise<McpToolExecutionResult> {
  const bridge = getActiveWorkspaceBridge();
  if (!bridge) {
    return {
      success: false,
      error: 'Workspace bridge is not active. Unable to execute workspace action.'
    };
  }

  const state = bridge.getState();
  const tasks = [...state.tasks];
  const briefs = [...state.briefs];
  const swimLanes = state.swimLanes && state.swimLanes.length > 0 ? [...state.swimLanes] : [
    { id: 'lane-default', title: 'Human Workspace', filePath: 'TODO.md', markdown: '' }
  ];

  try {
    switch (actionName) {
      // ── 1. Create Task ──
      case 'workspace_create_task': {
        const title = (args.title || '').trim();
        if (!title) return { success: false, error: 'Task title is required.' };
        const laneId = args.swimLaneId || swimLanes[0]?.id || 'lane-default';
        const subtaskStrings: string[] = Array.isArray(args.subtasks) ? args.subtasks : [];
        const nextId = tasks.length > 0 ? Math.max(...tasks.map((t) => Number(t.id) || 0)) + 1 : 1;

        const newTask: TaskItem = {
          id: nextId,
          title,
          category: args.category || 'Tasks',
          status: 'not_started',
          isDone: false,
          swimLaneId: laneId,
          subtasks: subtaskStrings.map((txt, idx) => ({
            id: `${nextId}-${idx + 1}`,
            text: txt,
            isDone: false
          }))
        };

        const nextTasks = [...tasks, newTask];
        bridge.saveProject(nextTasks, briefs, swimLanes);

        return {
          success: true,
          data: {
            message: `Created task #${nextId}: "${title}" in swim lane "${laneId}".`,
            task: newTask
          }
        };
      }

      // ── 2. Update Task ──
      case 'workspace_update_task': {
        const taskId = String(args.taskId);
        const idx = tasks.findIndex((t) => String(t.id) === taskId);
        if (idx === -1) return { success: false, error: `Task #${taskId} not found.` };

        const target = tasks[idx];
        const updatedTask: TaskItem = {
          ...target,
          title: args.title !== undefined ? String(args.title).trim() : target.title,
          isDone: args.isDone !== undefined ? Boolean(args.isDone) : target.isDone,
          status: args.status !== undefined ? args.status : (args.isDone ? 'done' : target.status)
        };

        tasks[idx] = updatedTask;
        bridge.saveProject(tasks, briefs, swimLanes);

        return {
          success: true,
          data: {
            message: `Updated task #${taskId}.`,
            task: updatedTask
          }
        };
      }

      // ── 3. Delete Task ──
      case 'workspace_delete_task': {
        const taskId = String(args.taskId);
        const nextTasks = tasks.filter((t) => String(t.id) !== taskId);
        if (nextTasks.length === tasks.length) {
          return { success: false, error: `Task #${taskId} not found.` };
        }

        const nextBriefs = briefs.filter(
          (b) => String(b.sourceTaskId) !== taskId && String(b.id) !== taskId
        );

        bridge.saveProject(nextTasks, nextBriefs, swimLanes);
        return {
          success: true,
          data: { message: `Deleted task #${taskId} from workspace.` }
        };
      }

      // ── 4. Create Subtask ──
      case 'workspace_create_subtask': {
        const taskId = String(args.taskId);
        const idx = tasks.findIndex((t) => String(t.id) === taskId);
        if (idx === -1) return { success: false, error: `Task #${taskId} not found.` };

        const text = String(args.text || '').trim();
        if (!text) return { success: false, error: 'Subtask text is required.' };

        const target = tasks[idx];
        const existingSubtasks = target.subtasks || [];
        const nextSubtasks = [
          ...existingSubtasks,
          {
            id: `${taskId}-${existingSubtasks.length + 1}`,
            text,
            isDone: false
          }
        ];

        tasks[idx] = { ...target, subtasks: nextSubtasks };
        bridge.saveProject(tasks, briefs, swimLanes);

        return {
          success: true,
          data: {
            message: `Added subtask "${text}" to task #${taskId}.`,
            subtasksCount: nextSubtasks.length
          }
        };
      }

      // ── 5. Update Subtask ──
      case 'workspace_update_subtask': {
        const taskId = String(args.taskId);
        const idx = tasks.findIndex((t) => String(t.id) === taskId);
        if (idx === -1) return { success: false, error: `Task #${taskId} not found.` };

        const target = tasks[idx];
        const subIndex = Number(args.subtaskIndex);
        if (isNaN(subIndex) || !target.subtasks || subIndex < 0 || subIndex >= target.subtasks.length) {
          return { success: false, error: `Invalid subtask index ${args.subtaskIndex} for task #${taskId}.` };
        }

        const updatedSubtasks = [...target.subtasks];
        const curSub = updatedSubtasks[subIndex];
        updatedSubtasks[subIndex] = {
          ...curSub,
          text: args.text !== undefined ? String(args.text).trim() : curSub.text,
          isDone: args.isDone !== undefined ? Boolean(args.isDone) : curSub.isDone
        };

        tasks[idx] = { ...target, subtasks: updatedSubtasks };
        bridge.saveProject(tasks, briefs, swimLanes);

        return {
          success: true,
          data: {
            message: `Updated subtask [${subIndex}] for task #${taskId}.`,
            subtask: updatedSubtasks[subIndex]
          }
        };
      }

      // ── 6. Delete Subtask ──
      case 'workspace_delete_subtask': {
        const taskId = String(args.taskId);
        const idx = tasks.findIndex((t) => String(t.id) === taskId);
        if (idx === -1) return { success: false, error: `Task #${taskId} not found.` };

        const target = tasks[idx];
        const subIndex = Number(args.subtaskIndex);
        if (isNaN(subIndex) || !target.subtasks || subIndex < 0 || subIndex >= target.subtasks.length) {
          return { success: false, error: `Invalid subtask index ${args.subtaskIndex} for task #${taskId}.` };
        }

        const updatedSubtasks = target.subtasks.filter((_, i) => i !== subIndex);
        tasks[idx] = { ...target, subtasks: updatedSubtasks };
        bridge.saveProject(tasks, briefs, swimLanes);

        return {
          success: true,
          data: {
            message: `Removed subtask [${subIndex}] from task #${taskId}.`,
            remainingCount: updatedSubtasks.length
          }
        };
      }

      // ── 7. List Swim Lanes ──
      case 'workspace_list_swim_lanes': {
        const laneDetails = swimLanes.map((lane) => {
          const laneTasks = tasks.filter(
            (t) => (t.swimLaneId && t.swimLaneId === lane.id) || (!t.swimLaneId && lane.id === 'lane-default')
          );
          return {
            id: lane.id,
            title: lane.title,
            filePath: lane.filePath,
            taskCount: laneTasks.length,
            completedTaskCount: laneTasks.filter((t) => t.isDone).length
          };
        });

        return {
          success: true,
          data: {
            totalLanes: swimLanes.length,
            swimLanes: laneDetails
          }
        };
      }

      // ── 8. Create Swim Lane ──
      case 'workspace_create_swim_lane': {
        const title = String(args.title || '').trim();
        if (!title) return { success: false, error: 'Swim lane title is required.' };

        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'lane';
        const newLaneId = `lane-${slug}-${Date.now().toString(36)}`;
        const newLane: SwimLaneDoc = {
          id: newLaneId,
          title,
          filePath: `${slug.toUpperCase()}.md`,
          markdown: `# ${title}\n\n`
        };

        const nextLanes = [...swimLanes, newLane];
        bridge.saveProject(tasks, briefs, nextLanes);

        return {
          success: true,
          data: {
            message: `Created swim lane "${title}" (ID: ${newLaneId}).`,
            swimLane: newLane
          }
        };
      }

      // ── 9. Update Swim Lane ──
      case 'workspace_update_swim_lane': {
        const laneId = String(args.laneId);
        const title = String(args.title || '').trim();
        if (!title) return { success: false, error: 'Swim lane title is required.' };

        const idx = swimLanes.findIndex((l) => l.id === laneId);
        if (idx === -1) return { success: false, error: `Swim lane "${laneId}" not found.` };

        swimLanes[idx] = { ...swimLanes[idx], title };
        bridge.saveProject(tasks, briefs, swimLanes);

        return {
          success: true,
          data: { message: `Renamed swim lane to "${title}".`, laneId }
        };
      }

      // ── 10. Delete Swim Lane (Enforcing minimum 1 lane) ──
      case 'workspace_delete_swim_lane': {
        const laneId = String(args.laneId);
        if (swimLanes.length <= 1) {
          return {
            success: false,
            error: 'Cannot delete swim lane. The workspace requires a minimum of 1 swim lane.'
          };
        }

        const nextLanes = swimLanes.filter((l) => l.id !== laneId);
        if (nextLanes.length === swimLanes.length) {
          return { success: false, error: `Swim lane "${laneId}" not found.` };
        }

        // Migrate any orphaned tasks from deleted lane to the primary remaining lane
        const primaryLaneId = nextLanes[0].id;
        const nextTasks = tasks.map((t) =>
          t.swimLaneId === laneId ? { ...t, swimLaneId: primaryLaneId } : t
        );

        bridge.saveProject(nextTasks, briefs, nextLanes);
        return {
          success: true,
          data: {
            message: `Deleted swim lane "${laneId}". Tasks moved to "${nextLanes[0].title}".`,
            remainingLanes: nextLanes.length
          }
        };
      }

      // ── 11. Move Task Lane ──
      case 'workspace_move_task_lane': {
        const taskId = String(args.taskId);
        const targetLaneId = String(args.targetLaneId);
        const targetLane = swimLanes.find((l) => l.id === targetLaneId);
        if (!targetLane) {
          return { success: false, error: `Target swim lane "${targetLaneId}" does not exist.` };
        }

        const taskIdx = tasks.findIndex((t) => String(t.id) === taskId);
        if (taskIdx === -1) return { success: false, error: `Task #${taskId} not found.` };

        const targetTask = { ...tasks[taskIdx], swimLaneId: targetLaneId };
        tasks[taskIdx] = targetTask;

        // If specific targetIndex provided, reorder
        if (typeof args.targetIndex === 'number' && args.targetIndex >= 0) {
          const removed = tasks.splice(taskIdx, 1)[0];
          const newIdx = Math.min(args.targetIndex, tasks.length);
          tasks.splice(newIdx, 0, removed);
        }

        bridge.saveProject(tasks, briefs, swimLanes);
        return {
          success: true,
          data: {
            message: `Moved task #${taskId} to "${targetLane.title}".`,
            taskId,
            targetLaneId
          }
        };
      }

      // ── 12. List MCP Servers ──
      case 'workspace_list_mcp_servers': {
        const servers = state.mcpServers.map((s) => ({
          id: s.id,
          name: s.name,
          status: s.status,
          serverType: s.serverType,
          toolsCount: s.tools.length,
          lastSyncedAt: s.lastSyncedAt
        }));

        return {
          success: true,
          data: {
            totalServers: servers.length,
            servers
          }
        };
      }

      // ── 13. Read MCP Server ──
      case 'workspace_read_mcp_server': {
        const serverId = String(args.serverId);
        const s = state.mcpServers.find((server) => server.id === serverId);
        if (!s) return { success: false, error: `MCP server "${serverId}" not found.` };

        return {
          success: true,
          data: {
            id: s.id,
            name: s.name,
            description: s.description,
            status: s.status,
            serverType: s.serverType,
            toolsCount: s.tools.length,
            tools: s.tools.map((t) => ({ name: t.name, description: t.description, autoApprove: t.autoApprove })),
            lastSyncedAt: s.lastSyncedAt
          }
        };
      }

      // ── 14. Read MCP Tools ──
      case 'workspace_read_mcp_tools': {
        const serverId = String(args.serverId);
        const s = state.mcpServers.find((server) => server.id === serverId);
        if (!s) return { success: false, error: `MCP server "${serverId}" not found.` };

        return {
          success: true,
          data: {
            serverId: s.id,
            serverName: s.name,
            tools: s.tools
          }
        };
      }

      // ── 15. Execute AI Task ──
      case 'workspace_execute_ai_task': {
        const taskId = String(args.taskId);
        const target = tasks.find((t) => String(t.id) === taskId);
        if (!target) return { success: false, error: `Task #${taskId} not found.` };

        if (bridge.executeAiTask) {
          bridge.executeAiTask(target.id);
          return {
            success: true,
            data: { message: `Started AI execution for task #${taskId}: "${target.title}".` }
          };
        }
        return { success: false, error: 'AI task execution handler not available.' };
      }

      // ── 16. Run Tasks Sequence ──
      case 'workspace_run_tasks_sequence': {
        const targetIds: string[] = Array.isArray(args.taskIds) ? args.taskIds.map(String) : [];
        if (targetIds.length === 0) return { success: false, error: 'taskIds array is required.' };

        const matchedTasks = tasks.filter((t) => targetIds.includes(String(t.id)));
        if (matchedTasks.length === 0) return { success: false, error: 'No matching tasks found.' };

        const lane = swimLanes.find((l) => l.id === (args.laneId || matchedTasks[0].swimLaneId)) || swimLanes[0];
        if (bridge.runTasksSequence) {
          bridge.runTasksSequence(matchedTasks, lane.id, lane.title);
          return {
            success: true,
            data: { message: `Queued ${matchedTasks.length} tasks in sequence.`, count: matchedTasks.length }
          };
        }
        return { success: false, error: 'Batch runner not available.' };
      }

      // ── 17. Run Tasks Parallel ──
      case 'workspace_run_tasks_parallel': {
        const targetIds: string[] = Array.isArray(args.taskIds) ? args.taskIds.map(String) : [];
        if (targetIds.length === 0) return { success: false, error: 'taskIds array is required.' };

        const matchedTasks = tasks.filter((t) => targetIds.includes(String(t.id)));
        if (matchedTasks.length === 0) return { success: false, error: 'No matching tasks found.' };

        const lane = swimLanes.find((l) => l.id === (args.laneId || matchedTasks[0].swimLaneId)) || swimLanes[0];
        if (bridge.runTasksParallel) {
          bridge.runTasksParallel(matchedTasks, lane.id, lane.title);
          return {
            success: true,
            data: { message: `Started ${matchedTasks.length} tasks in parallel.`, count: matchedTasks.length }
          };
        }
        return { success: false, error: 'Parallel runner not available.' };
      }

      // ── 18. Schedule Task ──
      case 'workspace_schedule_task': {
        const taskId = String(args.taskId);
        const iso = String(args.scheduledIso || '').trim();
        if (!iso) return { success: false, error: 'scheduledIso timestamp is required.' };

        if (bridge.scheduleTask) {
          bridge.scheduleTask(taskId, iso, args.cronExpr);
          return {
            success: true,
            data: {
              message: `Scheduled task #${taskId} for ${iso}${args.cronExpr ? ` (${args.cronExpr})` : ''}.`,
              taskId,
              scheduledIso: iso,
              cronExpr: args.cronExpr
            }
          };
        }
        return { success: false, error: 'Scheduler handler not available.' };
      }

      // ── 19. Cancel Scheduled Task ──
      case 'workspace_cancel_scheduled_task': {
        const taskId = String(args.taskId);
        if (bridge.cancelScheduledTask) {
          bridge.cancelScheduledTask(taskId);
          return {
            success: true,
            data: { message: `Cancelled schedule for task #${taskId}.` }
          };
        }
        return { success: false, error: 'Scheduler cancellation handler not available.' };
      }

      // ── 20. Create AI Brief ──
      case 'workspace_create_ai_brief': {
        const taskId = String(args.taskId);
        const targetTask = tasks.find((t) => String(t.id) === taskId);
        const overview = String(args.overview || '').trim();
        if (!overview) return { success: false, error: 'Overview text is required.' };

        const nextBrief: AgentContextItem = {
          id: `brief_${taskId}`,
          sourceTaskId: targetTask?.id || taskId,
          title: targetTask?.title || `Task #${taskId}`,
          status: 'not_started',
          overview,
          brief: args.brief || overview,
          buildAndVerification: '',
          completion: ''
        };

        const existingIdx = briefs.findIndex(
          (b) => String(b.sourceTaskId) === taskId || String(b.id) === taskId
        );

        let nextBriefs: AgentContextItem[];
        if (existingIdx >= 0) {
          nextBriefs = [...briefs];
          nextBriefs[existingIdx] = { ...nextBriefs[existingIdx], ...nextBrief };
        } else {
          nextBriefs = [...briefs, nextBrief];
        }

        bridge.saveProject(tasks, nextBriefs, swimLanes);
        return {
          success: true,
          data: { message: `Created AI brief for task #${taskId}.`, brief: nextBrief }
        };
      }

      // ── 21. Update AI Brief ──
      case 'workspace_update_ai_brief': {
        const briefId = String(args.briefId);
        const idx = briefs.findIndex(
          (b) => String(b.id) === briefId || String(b.sourceTaskId) === briefId
        );
        if (idx === -1) return { success: false, error: `AI brief "${briefId}" not found.` };

        const cur = briefs[idx];
        briefs[idx] = {
          ...cur,
          overview: args.overview !== undefined ? String(args.overview) : cur.overview,
          buildAndVerification: args.buildAndVerification !== undefined ? String(args.buildAndVerification) : cur.buildAndVerification,
          completion: args.completion !== undefined ? String(args.completion) : cur.completion
        };

        bridge.saveProject(tasks, briefs, swimLanes);
        return {
          success: true,
          data: { message: `Updated AI brief "${briefId}".`, brief: briefs[idx] }
        };
      }

      default:
        return {
          success: false,
          error: `Unknown workspace MCP action "${actionName}".`
        };
    }
  } catch (err: any) {
    return {
      success: false,
      error: `Error executing workspace tool "${actionName}": ${err?.message || String(err)}`
    };
  }
}
