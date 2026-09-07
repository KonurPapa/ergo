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
    - **Gherkin Puzzle Piece Decomposition**:
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
        - **Preserve high-signal errors**: keep failure logs, stack traces, and test error outputs in context during retries so the model learns from mistakes rather than scrubbing them and looping
        - **Per-turn payload trimming**: minimize token payload (Δ) added per turn (diffs/summaries over raw files) to eliminate quadratic accumulation ($Δ \cdot N^2 / 2$)
        - **Bounded Verification**: Verification tool rounds are capped (max 4 rounds) to prevent exploration loops
    - **Subagent & Worker Execution Pattern (Multi-Agent Fan-Out)**:
        - markdown bible contains all metadata necessary for the manager to spin up and coordinate multiple worker agents
        - when manager spawns a subagent, the child:
            - receives an isolated, scoped markdown sub-context tailored strictly to its specific puzzle piece
            - executes work, writes unit tests, and validates its output against the Gherkin criteria
            - writes its condensed summary piece back to the append-only Markdown bible log
            - terminates cleanly (clean teardown)
        - **Concurrency Limit**: maximum of X agents running concurrently (configurable)
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
    - strictly capped to 4 rounds max; automatically skipped for standalone static deliverables (e.g. single HTML/MD files) without project lint scripts
5. hardener
    - QA procedure & eval harness (how to know the task is completed)
    - strictly capped (max 6 rounds) to prevent runaway token expenditure
    - **Web / UI Deliverables**: prioritizes verifying in a **headless browser (e.g. Playwright)** via `run_command` to inspect canvas, DOM nodes, event handlers, and console logs
    - **Non-web / Standalone Deliverables**: if non-web standalone deliverable with verified manager assertions and no test suite, skipped to conserve tokens
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