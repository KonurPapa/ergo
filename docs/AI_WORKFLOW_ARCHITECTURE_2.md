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

1. discovery agent
    - fast, read-only reconnaissance using a lightweight/fast model (e.g. `gpt-4o-mini`, `gemini-2.5-flash`, `claude-3-5-haiku`, `llama3.2`) to acquire context quickly and cheaply
    - scans task given by user and skims task headers **strictly across human swim lane documents** (e.g. `TODO.md` and user swim lanes) — does NOT read or index verbose `AGENT_CONTEXT.md` to prevent prompt bloat
    - checks for project-level guideline files (e.g. `AGENTS.md` or `CLAUDE.md`) to establish baseline context
    - detects dependencies, shared schemas, architectural precedents, and connected MCP tools
    - assembles a clean, structured baseline **Markdown context document** (the start of the "Master Bible"), separating the byte-stable prefix (system prompt, static schemas, prompt caching anchors) from volatile per-task data
    - once candidate tasks are confirmed as relevant, imports the full task context (including `AGENT_CONTEXT.md` details) only for those specific relevant tasks into the summary payload
    - adheres to "pass pointers over payloads": passes concise summaries, task references, and file paths rather than dumping raw file blobs
2. summary agent
    - ingests the baseline Markdown context from discovery alongside active MCP tools
    - synthesizes the authoritative **Overview & Execution Brief** directly into the structured Markdown context document:
        - **Gherkin scenarios (Given-When-Then structure)**:
            - use this as the basis for the 'brief' section in the output: https://www.geeksforgeeks.org/software-testing/writing-scenarios-with-gherkin-syntax/
            - make sure to include examples in the skill (like the above webpage has), so the AI knows how it's supposed to format the Overview
            - the gherkin should be written in a way that is easy to understand for a human, so that they can verify that it is correct
            - covers happy paths, alternate flows, and edge cases (with preconditions in `Given`, triggers in `When`, verifiable outcomes in `Then`/`And`, ensuring zero silent failures)
        - **Goals checklist**: explicit numbered list of core deliverables and subtasks
        - **Output destination (`output_as`)**: exact method, file paths, and tool destination based on available MCPs
        - **Required MCPs**: strictly filters to only the specific MCP servers/tools needed for this task (avoiding prompt bloat and tool hallucinations)
    - outputs the finalized, master **Markdown Context Document / Bible Prompt** ready for execution handoff
3. manager executes tasks (context & state machine management)
    - **Master Blueprint & Single Source of Truth**:
        - uses the structured **Markdown Context Document / Bible (`TASK_CONTEXT.md`)** assembled in steps 1 and 2 as its single source of truth and append-only state log
        - **Slim Manager Context**: Manager receives a slimmed context containing Gherkin acceptance criteria, deliverable goals, and output destination (omitting verbose historical task dumps and guideline excerpts, which are passed directly to worker sub-agents)
    - **Dual Execution Models (Solo Mode vs Multi-Agent Fan-Out)**:
        - **Direct (Solo) Execution Mode (Straightforward / Standalone Deliverables)**:
            - when the task produces a single deliverable (e.g. single HTML game, standalone script, single component, non-coding task with <= 3 subtasks, or small task flagged with `requiresHardener: false`), the Manager executes the task **directly**
            - completely bypasses Step A decomposition LLM calls, skips spawning worker sub-agents, and eliminates redundant Step D verification loops
            - the Manager writes the deliverable cleanly and verifies its own work via commands/evidence in a single, strictly bounded tool loop (max 5 rounds)
            - drops token usage by ~90% (from ~139k tokens down to ~8k–15k tokens) for straightforward tasks
            - **Dedicated Direct Prompt & Tool Pruning**: uses `MANAGER_DIRECT_STABLE` (a focused builder prompt free of multi-agent decomposition JSON schemas) and prunes available tools for local models down to the essential core (`write_file`, `edit_file`, `read_file`, `list_directory`, `get_file_info`, `run_command`, `ask_human`) to prevent schema overload
            - **Code Block Fallback & Recovery Turn**: if local models emit deliverable code in markdown blocks or raw HTML (`<!DOCTYPE html>` / `<html>`) instead of calling `write_file`, the harness automatically extracts and writes the code; if the model finished without saving, a targeted recovery turn requests the deliverable source code
            - **Empirical Verification**: empirically verifies the file exists on disk with `get_file_info` before accepting completion
        - **Multi-Agent Fan-Out Mode (Complex / Multi-File Systems)**:
            - for large or multi-file systems, decomposes the scope into discrete, verifiable puzzle pieces executed by isolated worker sub-agents in waves
            - **Local AI / Ollama Serialization**: for local Ollama instances, worker execution is strictly serialized (`maxConcurrentAgents: 1`) to prevent VRAM exhaustion and timeouts
    - **Gherkin Puzzle Piece Decomposition (Multi-Agent Mode)**:
        - directly references the Gherkin scenarios to decompose the full scope into discrete, verifiable "puzzle pieces":
            - *Piece 1 (Preconditions & Dependencies)*: fulfills all `Given` clauses (reading existing files, verifying schemas, initializing states)
            - *Piece 2 (Actions & Implementation)*: executes all `When` actions via tools (code edits, API calls, component creation, business logic)
            - *Piece 3 (Acceptance Checks & Verifications)*: validates all `Then` and `And` outcomes against strict assertions (zero silent failures)
            - *Piece 4 (Edge Cases & Failure Recovery)*: implements and verifies alternate flows, error boundaries, and recovery paths
    - **Context Engineering & Model Routing Rules** (from *The State Machine Nobody Designed*):
        - **Route at task boundaries, NOT turn boundaries**: avoid naive mid-loop routing which invalidates prompt cache and incurs expensive re-prefill penalties on return journeys
        - **Clean sub-contexts (Clean Hand-offs)**: when spawning subagents/workers, do not dump the full manager history (90k+ tokens); provide a fresh, minimal Markdown context (byte-stable prefix, explicit input/output contract, and minimal tool surface)
        - **Sequential cache warming before fan-out**: when launching parallel subagents with identical prefixes, fire one subagent first to warm the KV cache, wait for its first token, then fire the remaining concurrent subagents to prevent simultaneous cache-write cache misses
        - **Tool stability & masking**: keep tool schemas static and byte-stable at position 0 to prevent cache invalidation and dangling-reference hallucinations; constrain available actions per phase/role via state gating / logit masking rather than dynamically adding/removing tool definitions
        - **Pass pointers over payloads**: output file paths + concise summaries rather than dumping large file blobs into context; agents pull full payloads on demand
        - **Payload Trimming**: tool results are strictly capped (`TOOL_RESULT_CHAR_CAP = 5_000` chars) to eliminate quadratic accumulation ($Δ \cdot N^2 / 2$) in multi-turn tool calling
        - **Preserve high-signal errors**: keep failure logs, stack traces, and test error outputs in context during retries so the model learns from mistakes rather than scrubbing them and looping
        - **Bounded Verification**: Verification tool rounds are capped (max 2 rounds for single completed pieces, max 4 rounds otherwise) to prevent exploration loops
        - **Local Ollama Optimization**:
            - **Full Context Sizing (`num_ctx: 16384`)**: Ollama API calls explicitly specify `options: { num_ctx: 16384, num_predict: 4096 }` to eliminate silent prompt truncation caused by Ollama's default 2048-token context window
            - **Text-Based Tool Call Parsing**: falls back to parsing `<tool_call>`, fenced JSON blocks, and raw JSON emitted in message content when local models omit native `message.tool_calls`
            - **Conversational Reminder Nudges**: on round 1 with mutating tools, nudges models to call `write_file` if they initially output conversational acknowledgments
            - **Tool Response Format**: native Ollama `/api/chat` requires `tool_name` on tool responses to preserve conversation coherence across turns
            - **File vs Directory Tracking**: directory creation is decoupled from file creation tracking so empty folders never fool the pipeline into running downstream lint/QA passes
    - **Subagent & Worker Execution Pattern (Multi-Agent Fan-Out)**:
        - markdown bible contains all metadata necessary for the manager to spin up and coordinate multiple worker agents
        - worker tool rounds are strictly bounded (max 5 rounds for single pieces, max 8 rounds for multi-worker pieces) to prevent quadratic context blowup
        - when manager spawns a subagent, the child:
            - receives an isolated, scoped markdown sub-context tailored strictly to its specific puzzle piece
            - executes work, writes unit tests, and validates its output against the Gherkin criteria
            - writes its condensed summary piece back to the append-only Markdown bible log
            - terminates cleanly (clean teardown)
        - **Concurrency Limit**: maximum of X agents running concurrently (configurable; strictly 1 for local Ollama)
        - **File Locking & Access Coordination**: maintains a master markdown tracking document of active file modifications to prevent edit collisions and queue write operations across agents
    - **Interactive Human Clarification (`ask_human`)**:
        - if blocked by missing credentials, ambiguous specifications, or architectural forks, invokes `ask_human` immediately
        - pauses execution with interactive badges and prompt cards in the UI; resumes execution upon user response without losing cache
    - **Strict Filesystem Boundaries**:
        - writes strictly constrained to `.ergo` (`~/.ergo`) and explicitly permitted directory roots
        - unauthorized write attempts are blocked and reported with high-signal errors
    - **Accumulation & Completion Rule**:
        - manager is **only finished** with the complete task when it has accumulated all completed pieces of the puzzle and verified that all Gherkin acceptance scenarios pass cleanly
4. cleaner (only if coding)
    - clean up the newly-written code so it is well-organized and passes lint/format rules
    - strictly capped to 4 rounds max; automatically skipped for standalone static deliverables (e.g. single HTML/MD files) without project lint scripts and tasks with 0 files modified
5. hardener
    - QA procedure & eval harness (how to know the task is completed)
    - strictly capped (max 6 rounds) to prevent runaway token expenditure
    - **Web / UI Deliverables**: prioritizes verifying in a **headless browser (e.g. Playwright)** via `run_command` to inspect canvas, DOM nodes, event handlers, and console logs
    - **Standalone / Straightforward Deliverables**: straightforward single-deliverable tasks verified by the manager cleanly skip Hardener (saving ~10k tokens), even across retry attempts
    - **Manager Verification Retry Policy**: if Hardener is skipped for a standalone deliverable, but Manager execution failed verification (e.g. deliverable missing on disk), the pipeline retries the Manager with failure diagnostics instead of aborting the run
    - QA failure records the failure diagnostics into the append-only Markdown bible log and triggers a retry from step 3
    - any repeat causes subagent context to be cleanly torn down and re-instantiated with fresh context containing the failure diagnosis



**Structured Markdown Context File Format (`TASK_CONTEXT.md` / Bible Prompt)**:
  - Example layout of the assembled markdown context document:
    ```markdown
    # TASK EXECUTION BIBLE: [Task Title]

    ## Metadata
    - **Task ID**: #[ID]
    - **Category**: [Category]
    - **Status**: [Status]
    - **Source**: [Document / Lane]
    - **Project**: [Project Name] ([Project Path])

    ## Target Task & Subtasks
    - [ ] [Subtask 1]
    - [ ] [Subtask 2]

    ## Overview & Acceptance Criteria (Gherkin Scenarios)
    ```gherkin
    Feature: [Feature Name]
      Scenario: [Primary Success Path]
        Given [Preconditions and discovered context]
        When [Action triggered]
        Then [Expected verifiable outcome]
        And [Additional verification]

      Scenario: [Edge Case / Failure Mode]
        Given [Initial state]
        When [Edge condition occurs]
        Then [Graceful handling with zero silent failures]
    ```

    ## Deliverable Goals
    1. [Deliverable 1]
    2. [Deliverable 2]

    ## Output Destination & Method
    - **Destination**: [Target file paths / MCP write method / Notes]
    - **Required MCPs**: [Filtered MCP list]
    - **Allowed Boundaries**: [Allowed directory roots]

    ## Discovered Context References
    - **Task #[ID] ([Title])** [from `[Source]`]: [Concise summary / schema pointer]

    ## Execution Event Log (Append-Only)
    - [Manager / sub-agents append progress notes, test results, and failure diagnostics here]
    ```