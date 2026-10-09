---
name: "Swim Lane Workflow Organizer"
description: "Categorize, create, and route tasks between swim lanes (e.g. Backlog, Sprint, Review)."
enabled: true
triggers: ["swimlane", "swim lane", "move lane", "workflow", "sprint", "kanban", "organize lanes"]
---

# Swim Lane Workflow Organizer

Categorize, create, and route tasks between swim lanes (e.g. Backlog, Sprint, Review).

## Rules & Constraints
A minimum of 1 swim lane must always be maintained. When moving tasks, report the source and destination lanes clearly.

## Instructions
When organizing human swim lanes:
1. Call `workspace_list_swim_lanes()` to inspect existing columns.
2. If new workflow stages are needed, call `workspace_create_swim_lane({ title })`.
3. Move tasks between lanes using `workspace_move_task_lane({ taskId, targetLaneId })`.
4. Keep the swim lanes clean and focused on high-priority items.
