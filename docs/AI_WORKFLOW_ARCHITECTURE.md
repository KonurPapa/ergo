# Ergo AI Step Logic & Workflow Architecture

This document details the step-by-step logic, data flow, context boundaries, and agent handoffs for both core AI pipelines in Ergo:
1. **The Human AI Assistant Pipeline** (`runHumanAiAssistant`) — Workspace drafting, task structuring, and context synchronization.
2. **The Task Execution Pipeline** (`executeTaskWithAi`) — The 3-stage execution engine invoked when running a task.

---

## 1. Human AI Assistant Pipeline (`runHumanAiAssistant`)

The Human AI Assistant uses a **3-agent sequential pipeline** to translate user intent into structured markdown across `TODO.md` (human view) and `AGENT_CONTEXT.md` (agent view), following the core principle: **Human-Side First**.

```mermaid
flowchart TD
    UserPrompt([User Prompt / Instruction]) --> SkillLoad[Load Skill Docs & MCP Runtime Summary]
    SkillLoad --> AI1[AI 1: Context & Relevance Analyzer]
    
    subgraph S1 [Step 1: Analysis]
        AI1 -->|Skims TODO & AGENT_CONTEXT| AnalysisText["Relevance & Context Output (< 200 words)"]
    end
    
    AnalysisText --> AI2[AI 2: TODO.md Task Builder]
    UserPrompt --> AI2
    
    subgraph S2 [Step 2: Task Scaffolding]
        AI2 -->|Enforces Task or Architect Mode| UpdatedTodo["Complete Updated TODO.md"]
    end
    
    UpdatedTodo --> AI3[AI 3: Context Syncer & Overview Drafter]
    UserPrompt --> AI3
    AnalysisText --> AI3
    
    subgraph S3 [Step 3: Agent Context Sync]
        AI3 -->|Generates Done-State, In Context, Seams| UpdatedAgentContext["Complete Updated AGENT_CONTEXT.md"]
    end
    
    UpdatedTodo --> Result([Apply Changes / Sync Project])
    UpdatedAgentContext --> Result
```

### Modes of Operation
- **Task Mode (Default):** Strict single-task isolation. Fleshes out one selected or newly created task with concrete domain subtasks without touching or reordering any other tasks in `TODO.md`.
- **Architect Mode:** Broad roadmap planning. Assumes a higher-level scope, generating or reorganizing multiple categories, tasks, and sequential milestones.

---

### Step 1: AI 1 — Context & Relevance Analyzer (`assistant-context-analyzer`)
- **Role:** Fast, read-only reconnaissance.
- **Model Target:** Discovery model (e.g. `gpt-4o-mini`, `claude-3-5-haiku`, `gemini-2.5-flash`, or `llama3.2`).
- **Inputs & Context:**
  - Full current `TODO.md` and `AGENT_CONTEXT.md` content.
  - Active MCP connections list and allowed directory boundaries (`getAllowedRoots`).
  - Dedicated skill instructions (`skills/assistant-context-analyzer/SKILL.md`).
  - The raw user prompt.
- **Execution Logic:**
  - Scans categories, task numbers, existing subtasks, and briefs to identify structural patterns to mirror.
  - Identifies the target category and computes next task numbers.
  - Identifies relevant connected MCP tools that can help fulfill the task.
- **Output:** A strict, concise brief (< 200 words) detailing relevance, target category, numbering, constraints, and tool candidates.

---

### Step 2: AI 2 — TODO.md Task Builder (`assistant-todo-builder`)
- **Role:** Crafts the human-facing task list in native markdown.
- **Model Target:** Primary/General model (e.g. `gpt-4o`, `claude-3-7-sonnet`, `gemini-1.5-pro`, `qwen2.5-coder`).
- **Inputs & Context:**
  - Current `TODO.md`.
  - User prompt + AI 1 Context & Relevance Analysis.
  - Dedicated skill instructions (`skills/assistant-todo-builder/SKILL.md`).
- **Execution Logic:**
  - Implements **Human-Side First**: Full functional details and subtasks live in `TODO.md`.
  - Applies strict formatting: 4-space indented subtasks (`    - `), numbered lists restarting per category (`1.`, `2.`), markdown headings (`## Category`), and `~~` strikethroughs for done items.
  - Strictly prevents generic filler subtasks (e.g., forbids *"Research and plan..."* in favor of concrete domain steps).
- **Output:** The complete updated `TODO.md` document inside a fenced code block (`markdown:TODO.md`).

---

### Step 3: AI 3 — AGENT_CONTEXT.md Syncer & Overview Drafter (`assistant-context-syncer`)
- **Role:** Synchronizes the agent's technical overview and counterpart records.
- **Model Target:** Primary/General model.
- **Inputs & Context:**
  - Current `AGENT_CONTEXT.md`.
  - Newly generated `TODO.md` (from AI 2).
  - User prompt + AI 1 Context Analysis.
  - Dedicated skill instructions (`skills/assistant-context-syncer/SKILL.md`).
- **Execution Logic:**
  - Ensures exact 1:1 numerical and title parity (`### N. Title`) matching the new `TODO.md`.
  - Drafts rich, structured `Overview` sections for new or modified tasks, covering:
    - **Done-State:** Concrete completion criteria matching subtasks.
    - **In Context:** Relationship to other tasks, dependencies, and workspace architecture.
    - **Seams:** Specific files, APIs, and connected MCP tools involved.
  - Preserves unmodified sections and leaves `Build & Verification` / `Completion` ready for the execution phase.
- **Output:** The complete updated `AGENT_CONTEXT.md` document inside a fenced code block (`markdown:AGENT_CONTEXT.md`).

---

## 2. Task Execution Pipeline (`executeTaskWithAi`)

When a user clicks **Run Task** on an individual task item (without an active CLI PTY agent), Ergo initiates the **4-stage execution pipeline**.

```mermaid
flowchart TD
    RunTask([Run Task Triggered]) --> Step1[Step 1: Discovery AI]
    
    subgraph Discovery [Step 1: Context Relevance Scan]
        Step1 -->|Ingests Task Header Index only| HeaderIndex["Task Header Index (Active + Archived)"]
        HeaderIndex --> RelevanceJson["JSON: { relevantTaskIds }"]
        RelevanceJson --> FullContext["Discovery Payload:\n- Target Task & Subtasks\n- Additional Context Entries\n- Connected MCPs"]
    end
    
    FullContext --> Step2[Step 2: Summary AI / summary-agent]
    
    subgraph Synthesis [Step 2: Overview & Gherkin Brief]
        Step2 -->|Synthesizes full context| OverviewDoc["Structured Overview Document:\n- brief: Gherkin Scenarios (Given-When-Then)\n- goals: Numbered Checklist\n- output_as: Tool Destination\n- requiredMcps: Filtered MCPs"]
    end
    
    OverviewDoc --> Step3[Step 3: Manager AI / manager-agent]
    
    subgraph Execution [Step 3: Task Execution & Puzzle Piece Assembly]
        Step3 -->|Ingests Structured Bible Prompt| BiblePrompt["Bible Prompt JSON:\n- Task & Subtasks\n- Overview & Gherkin Scenarios\n- Discovered Context Snippets\n- Environment & Active MCPs"]
        BiblePrompt --> ProviderBranch{Provider Engine}
        ProviderBranch -->|Anthropic / OpenAI / Gemini| ToolLoop[Native MCP Tool Call Loop\n(Max 8 Rounds)]
        ProviderBranch -->|Ollama with Tool Calling| ToolLoop
        ProviderBranch -->|Ollama without Tool Calling| WorkerPattern[Ollama Worker AI Pattern\nPlan -> Worker AIs -> Synthesis]
        ToolLoop --> ManagerSummary[Manager Output & Assembled Solution]
        WorkerPattern --> ManagerSummary
    end
    
    ManagerSummary --> Step4[Step 4: Logger AI]
    
    subgraph Logging [Step 4: Completion Record]
        Step4 -->|JSON Schema Prompt| FinalJson["JSON:\n{ buildAndVerification, completion, humanReview }"]
        FinalJson --> Persist["Mark Task DONE\nAppend Records to AGENT_CONTEXT.md"]
    end
```

---

### Step 1: Discovery AI (Context Relevance Scan)
- **Objective:** Find applicable knowledge from other workspace tasks (including completed and archived tasks) without reading the entire repository or entire context documents.
- **Token Efficiency Safeguard:** Does **NOT** ingest full `TODO.md` or `AGENT_CONTEXT.md`.
- **Context Provided:**
  - A lightweight **Task Header Index** containing `#N. Title (Category) [ARCHIVED] [DONE]` and truncated overview snippets (~150 chars).
  - Target task title, category, and subtasks.
- **Execution Logic:**
  - Calls `callAiEngine` with `taskType: 'discovery'`, `responseFormat: 'json'`.
  - Determines if any prior tasks contain architectural decisions, shared schemas, or dependencies relevant to the current task.
- **Output:**
  ```json
  {
    "relevantTaskIds": [2, 5]
  }
  ```
- **Handoff:** Ergo extracts the full data for the identified relevant task IDs to construct `DiscoveryJobPayload` for Step 2.

---

### Step 2: Summary AI (`summary-agent` — Overview & Gherkin Brief Synthesizer)
- **Objective:** Synthesize all discovered context into a structured Overview document (`brief`, `goals`, `output_as`, `requiredMcps`) that serves as the single source of truth for the Manager AI.
- **Gherkin Scenario Standard (Given-When-Then):**
  - Following the standard in `FUTURE_FEATURES.md`, the `"brief"` field is formatted as human-verifiable **Gherkin scenarios**.
  - Uses standard BDD keywords: `Feature:`, `Scenario:`, `Given:`, `When:`, `Then:`, `And:`, `But:`.
  - Structured in plain English so human reviewers can immediately read and verify acceptance criteria before and during execution.
  - Incorporates preconditions and discovered context in `Given` clauses, discrete triggers in `When` clauses, and observable verifiable outcomes in `Then`/`And` clauses (covering both happy paths and edge cases).
- **Output Schema:**
  ```json
  {
    "brief": "Feature: User Registration & Validation\n  Scenario: Successful registration\n    Given the user is on the registration page\n    When the user enters valid credentials and clicks register\n    Then the user is redirected to the welcome page\n    And a confirmation notice is displayed",
    "goals": "1. Implement registration form UI\n2. Add input validation rules\n3. Wire auth API handler",
    "output_as": "Write updated files to src/auth/... via Filesystem MCP, then record completion summary in AGENT_CONTEXT.md.",
    "requiredMcps": ["Filesystem MCP"]
  }
  ```

---

### Step 3: Manager AI (`manager-agent` — Task Execution & Puzzle Piece Assembly)
- **Objective:** Systematically execute the task using connected MCP tools against a concise, non-bloated **JSON Bible Prompt**, directly referencing the Gherkin scenarios to solve every "piece" of the puzzle.
- **The JSON Bible Prompt**:
  - The Manager receives a scoped, structured JSON master blueprint assembled from Discovery and Summary:
  ```json
  {
    "task": { "id": 1, "title": "User Registration", "category": "Auth", "status": "todo", "subtasks": [] },
    "overview": {
      "brief": "Feature: User Registration...",
      "goals": "1. Implement UI...",
      "output_as": "Write updated files...",
      "requiredMcps": ["Filesystem MCP"]
    },
    "discoveredContext": [
      { "taskId": 2, "title": "DB Schema", "category": "Database", "sourceDocument": "AGENT_CONTEXT.md" }
    ],
    "environment": {
      "projectName": "Default Workspace",
      "projectPath": "/workspace",
      "allowedRoots": ["/workspace/.ergo"],
      "activeMcps": ["Filesystem MCP"]
    }
  }
  ```
- **Gherkin Puzzle Piece Decomposition & Accumulation Rule**:
  - **Decomposition**: The Manager decomposes the Gherkin scenarios into discrete "puzzle pieces" (preconditions in `Given`, implementation actions in `When`, verifiable outcomes in `Then`/`And`, and edge case recovery).
  - **Accumulation Rule**: The Manager is **only finished** with the complete task when it has accumulated all completed pieces of the puzzle and assembled them into the finished task.
- **Strict Filesystem Boundaries:**
  - The AI has access **ONLY** to write files within the `.ergo` directory (`~/.ergo`) or folders explicitly permitted under **Connections -> Allowed Folders**.
  - Writing to the app's codebase repository or outside approved boundaries is strictly forbidden and rejected at the MCP host gateway with HTTP 403.
  - All project files, generated scripts, and artifacts live under `.ergo` (`projects/<project-id>/...`) or permitted external folders.
- **Interactive Mid-Build Human Clarification (`ask_human` Tool):**
  - All providers have access to the built-in `ask_human` tool (`{ question: string, options?: string[], context?: string, allowFreeform?: boolean }`).
  - When the Manager AI is missing critical information, credentials, or faces architectural forks, it invokes `ask_human`.
  - **Human Side:** The task card displays an amber, pulsing **Needs Input** indicator badge (`.task-needs-input-badge-pill`) and highlights the card.
  - **AI Side:** `BriefPane` and `ExecutionModal` render a Claude Code-style interactive prompt card (`.ai-human-input-card`) offering selectable option buttons, free-form text input, and Ctrl+Enter keyboard submission.
  - Submitting returns the user's answer directly back to the Manager loop as a tool result and resumes execution.

- **Execution Logic by Provider:**

#### A. Anthropic (`runAnthropicBuilderLoop`)
- Uses Anthropic's native `tool_use` API.
- Converts MCP servers into Anthropic `input_schema` tools, injecting `ask_human`.
- Evaluates tool calls up to 8 conversation rounds. Handles permission prompts (`onRequestPermission`), human clarification prompts (`onRequestHumanInput`), executes via `callMcpTool`, feeds `tool_result` blocks back into the stream, and emits real-time `ExecutionStep` updates to the UI.

#### B. OpenAI (`runOpenAiBuilderLoop`)
- Uses OpenAI function calling (`tools: [{ type: "function", function: ... }]`).
- Loops through `tool_calls` responses, executes tools against local MCP servers or intercepts `ask_human`, and posts back `tool` message roles.

#### C. Gemini (`runGeminiBuilderLoop`)
- Uses Gemini `functionDeclarations` and processes `functionCall` / `functionResponse` part structures.

#### D. Ollama (`runOllamaBuilderLoop` & `runOllamaWorkerPattern`)
- First attempts native OpenAI-compatible tool calling with `ask_human`.
- **Worker AI Fallback:** If the local model does not return tool calls (lacks tool-calling capabilities):
  1. **Plan:** Main AI breaks down the task into a numbered list of concrete work items.
  2. **Workers:** Spawns separate worker AI calls for each work item with task context.
  3. **Synthesis:** Main AI aggregates worker results and outputs a consolidated completion summary.
  4. Flags `usedWorkerPattern = true` so Step 4 can document the lack of direct tool access.

---

### Step 4: Logger AI (Completion Recording, Artifacts, & Human Review Evaluation)
- **Objective:** Generate formal build documentation, list all created/modified files with direct IDE open links, evaluate human review requirements, and append records to `AGENT_CONTEXT.md` and `TODO.md`.
- **Inputs & Context:**
  - Current Task metadata, original subtasks, and human review flags.
  - Builder AI's execution summary.
  - Full tool call log and created files list (`builderResult.createdFiles`).
  - Existing Overview.
  - If Ollama worker pattern was used: an automated note explaining the fallback.
- **Execution Logic & Evaluation:**
  - Evaluates whether the user needs to inspect or verify changes at the end (for higher-order/complex tasks, sensitive architectural changes like auth, DB, payments, deletion, or tasks explicitly flagged for human review).
  - Collects all created/modified files and presents them in `createdFiles` and the completion markdown.
  - Returns strict JSON:
    ```json
    {
      "buildAndVerification": "Markdown detailing implementation journey and checks...",
      "completion": "Markdown detailing completion summary, what was built, and list of completed files...",
      "createdFiles": ["projects/sample/src/auth.ts", "projects/sample/README.md"],
      "needsHumanReview": true,
      "humanReviewSteps": ["Verify updated DB schema migrations", "Confirm payment webhook endpoint responds 200 OK"]
    }
    ```
- **Clickable File Links & IDE Integration:**
  - In `AGENT_CONTEXT.md` / `BriefPane` Section 3 (Completion), all created files and code artifacts are rendered in an interactive **Completed Work & Created Files** panel.
  - Clicking **"Open in IDE"** directly opens the file in the user's IDE (VS Code, Cursor, or system editor via `POST /api/files/open`).
  - Markdown links to files (`[filename](path)`) in the completion notes can also be clicked to open directly in the user's IDE.
- **Persistence & State Update:**
  - Regular executed subtasks are marked `isDone: true`.
  - Human review subtasks are output as `    - **human review** - <step>` with `isDone: false, isHumanReview: true`.
  - If human review steps exist, task status is set to `'partly_done'` with a dedicated **Human Review** purple badge in `TaskPane` and a verification checklist card in `BriefPane`.
  - If no human review is required, task is marked `'done'` (`isDone: true`).
  - Updates `AGENT_CONTEXT.md` with the new `Build & Verification` and `Completion` sections (including human review and artifacts list).
  - Persists both files to local workspace storage and syncs the UI.

---

### Offline / Fallback Execution (`runOfflineExecution`)
When no AI provider is configured (`provider: 'none'` or missing API keys):
- Ergo runs a deterministic step simulator that walks through the 5 UI stages (`Reading Context` → `Executing MCP Tool` → `Executing Subtasks` → `Rendering Widget Preview` → `Updating Markdown Files`).
- Preserves explicit `**human review**` subtasks, triggers simulation for interactive questions when tasks request clarification, and maintains UI responsiveness.
