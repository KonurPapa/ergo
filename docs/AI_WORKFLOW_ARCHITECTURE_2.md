# Ergo AI Step Logic & Workflow Architecture

This document details the step-by-step logic, data flow, context boundaries, and agent handoffs for both core AI pipelines in Ergo:
1. **AI Assistant Pipeline** (`runHumanAiAssistant`) — Workspace drafting, task structuring, and context synchronization.
2. **Agent Execution Pipeline** (`executeTaskWithAi`) — The 3-stage execution engine invoked when running a task.

---

## AI Assistant Pipeline (`runHumanAiAssistant`)

### Flow of logic:
1. 


## Agent Execution Pipeline (`executeTaskWithAi`)

### Flow of logic:

1. User's task/selection sent to Discovery AI
2. Discovery AI scans task headers in each lane (including archived tasks), and adds relevant tasks as part of the job's context
3. Summary AI then creates the 'Overview' for that task, which is the exact doc that will be handed off to the Builder AI to execute
  - this will include the sections 'brief', 'goals', 'output as'
  - it also checks available MCPs, and defines the output format/location based on what seems most likely and what's available for use
4. Builder AI receives the 'Overview' and runs the task
  - everything it should need to run the task is in the 'Overview' - it should always refer back to this doc mid-work, instead of keeping its own ephemeral copy, so the user can edit it mid-task to steer the AI
  - it needs to make all its choices from the very start of execution centered around the 'output as' field, since this determines what MCPs it will be using, how it formats data for final output, etc.
  - it needs to maintain a running log of the task execution as it works, written to AGENT_CONTEXT.md in the workspace
  - if the AI is ever stuck mid-task at a step that needs human input, this needs to flag in an obvious way, where the user can provide that input (similar to how Claude Code asks for input)
  - the user should ALWAYS be able to steer the AI's goals with additional prompts mid-task, again similar to how coding AIs like Claude Code allow the user to input prompts mid-task
  - whatever files the AI is currently touching should be stored/updated in a markdown doc (a separate one specifically for tracking what's being edited)
    - this will prevent other agents from attempting to access files that are already being used and potentially writing over other changes
    - this also means the agents can then wait in a queue for access to a particular file, thus keeping things orderly
5. Builder AI completes the task and outputs its success message/summary
6. Summary AI writes the summary to the 'Completion' section of the task in AGENT_CONTEXT.md, and writes a 'human review' card back into the human side if the particular task requires human verification
  - it should move this task to the next swim lane by default after completion (or to another swim lane if specified as part of the task)
