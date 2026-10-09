---
name: "Autonomous Task Scheduler & Sequencer"
description: "Automate task execution sequences, parallel runs, and time-based cron scheduling."
enabled: true
triggers: ["schedule", "cron", "run sequence", "run parallel", "execute tasks", "automate execution", "batch run"]
---

# Autonomous Task Scheduler & Sequencer

Automate task execution sequences, parallel runs, and time-based cron scheduling.

## Rules & Constraints
Verify dependencies before sequencing tasks. For scheduled runs, specify unambiguous ISO timestamps or standard 5-part cron expressions.

## Instructions
When automating task executions or scheduling runs:
1. To run tasks in order: Call `workspace_run_tasks_sequence({ taskIds })`.
2. To run independent tasks concurrently: Call `workspace_run_tasks_parallel({ taskIds })`.
3. To schedule a task: Call `workspace_schedule_task({ taskId, scheduledIso, cronExpr })`.
4. To cancel a schedule: Call `workspace_cancel_scheduled_task({ taskId })`.
