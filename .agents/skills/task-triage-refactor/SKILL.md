---
name: "Task Triage & Refactor"
description: "Directly refine, organize, and break down complex tasks into clear subtasks in the human workspace."
enabled: true
triggers: ["refactor tasks", "break down", "triage", "subtasks", "clean up backlog", "organize tasks"]
---

# Task Triage & Refactor

Directly refine, organize, and break down complex tasks into clear subtasks in the human workspace.

## Rules & Constraints
Always preserve human intent. When breaking down tasks, ensure each subtask has a verifiable definition of done. Do not delete user tasks without explicit instruction.

## Instructions
When user asks to clean up, refactor, or structure workspace tasks:
1. Call `workspace_list_swim_lanes()` and read active tasks.
2. For large or vague tasks, call `workspace_create_subtask()` to add concrete checklist items.
3. Update task titles to be actionable verbs (e.g. "Implement authentication flow" instead of "Auth").
4. Mark completed items using `workspace_update_task()` or `workspace_update_subtask()`.
