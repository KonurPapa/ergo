**AI/ML Features (Future Roadmap)**
    - The AI should have the ability to add new tasks to the user's TODO list, if it discovers something important that the user didn't explicitly task it with
        - but it should always tell the user what it added (and maybe the task is indicated with a 'review' tag or something)
        - this should happen primarily when it finds something along the way that's out of scope for its current task
        - make sure what's put in the human task list is always succinct, clear and easily readable - make sure what it stores in its vector DB is verbose enough to be useful for the AI
    - **Autocomplete**
        - pull from other tasks (using vector DB) to determine the most relevant suggestion
        - autocomplete should not start if the user simply moved their cursor to another task, but hasn't started typing anything yet
        - should have an immediate autocomplete (after 1 second of no input) for the current word being typed (after the user has typed 4+ chars without a space), and a delayed autocomplete for the rest of the user's sentence if the user pauses for 3+ seconds
        - autocomplete should never start on an empty task
            - subtasks it can, based on the rest of the task/subtasks, but after the 3+ second sentence-delay
        - autocomplete should keybind to Tab by default - this should be configurable in settings
        - should be able to be toggled on/off completely in settings
    - **MCP**:
        - MCP authentication when user clicks 'connect'
        - after connection, the app needs to call `tools/list` and store all available tools for that particular MCP
        - when user creates a task, if there's an MCP connected, show a list of tools from that MCP (use `tools/list` to get the tools) that the user can select to use for that task
        - only use tools that are actually relevant to the task (ask for clarification if needed, but try to guess based on the task brief and list of tools)
        - this also helps the AI know which relevant tools are available
        - we should routinely check for updates. what happens if the MCP receives new updates that our AI doesn't know about because we haven't called `tools/list` again?
    - rework the 'new task' button for using the AI to perform general tasks on the human workspace
        - create new task w/ subtasks
        - refine existing tasks (remove, replace, or edit wording)
    - AI is NEVER allowed to delete things from the user's side, but they should ALWAYS keep their agent context side in parity w/ the user's side
        - I.e. if a user deletes a task or subtask from the human side, or reorders tasks, the AI should also delete it from the agent context side as well, and reorder the tasks there as well
    - **CLI mode for coding agents**
        - connection to coding CLIs like Claude Code, Antigravity, Cursor, Codex, etc.
        - when the user clicks 'execute' on a task, it spawns a CLI agent that performs the task in a windowed terminal in the AI side
        - then on completion it writes back to the AI and user's side, and updates the task and subtasks to reflect what happened; the user can then also look back at the terminal to see more details
        - **terminal persistence**:
            - Terminal session history is in-memory — when you close or reload the app, the PTY process is killed and the tab is gone. The config (which agent to use) persists. Reconnecting to a live PTY after a page reload would require a full server-side session registry
        - can it write out to the user's IDE?
            - if so, it needs to have a way to jump to the files that were changed (and ideally a diff log)
    - local AI should auto-compact by detault (configurable in AI profile panel advanced settings, under the Ollama section)
    - commands/words in tasks that trigger custom AI logic (skills)
    - AI should be allowed to created its own tasks on the human side, but these should be clearly marked as AI-generated so the user can approve/dismiss them
    - look for an `AGENTS.md` or `CLAUDE.md` file at the project folder and use it as the AI's baseline agent context if found
    - an undo button to revert back to the previous diff
        - how is this handled for non-code tasks?
        - maybe this starts out in V1 just for code
    - some sort of master list of which files in a codebase are being accessed and by which agents
        - this would give the user a view of what's actually being edited
        - more importantly, this can be used for the agents to coordinate amongst each other to prevent write/edit conflicts
    - add 'grill-me' to the list of AI assistant abilities, so user can refine their task list
    - global rules markdown file needs to be added at execution runtime to the AGENTS.md / CLAUDE.md files, which should also store the list of model routing
        - these files also need to be exportable so the user can take them elsewhere if they want
    - user needs to easily be able to create skills, and call them in tasks with '/'
    - user needs to be able to reference files with '@'
        - does this open a modal to select the file, which is a deep link to the file on disk?
    - needs a `/remember` skill that the user can call to force the AI to store that knowledge in its vector DB
    - **can we use a lightweight AI for scanning files (i.e. Sonnet), and then pass that to a more powerful AI that actually does the work (i.e. Opus)?**
        - see if we can do this w/ Laya instead
    - **Run as...**
        - Single task
        - Tasks in sequence
        - Tasks in parallel
        - Schedule tasks...
    - Upon completion of a task, the AI should write/update a spec-file (for whatever new thing was built/modified) that gets saved to the vector DB for future runs to read and learn from before they start work
        - this way, future executions will get better and more informed the more work gets done, and because it's in a vector DB, none of it costs anything to retrieve
    - when the autosave triggers, this needs to update the local vector DB automatically as well
    - AI should run /grill-me type skill when first working on a task, to fill any uncertainty gaps before it actually starts work
        - maybe implement an 'assistance' slider, which determines how much it asks for clarification and details vs. just autonomously assuming
        - there should also be an 'effort' slider, which will automatically use less/more powerful models depending on what the user sets that task to
            - the AI should select the best model for the job by default, unless the user explicitly sets it
            - these effort-levels should be automatically created when the user sets up a new AI profile, and configurable from the advanced settings in the AI profile panel
            - we should use the same model throughout work tasks, so we can cache tokens


**Uncle Bob's Notes**:
    - write a function, then write the test for that function
        - once it passes the test(s), the agent can move on
    - Implementing Agile framework for agents
        - make as many small changes/iterations as possible to try to best reach the goal
        - maybe this looks like implementation plans by multiple agents, and then a judge AI decides which plan is the best
            - each agent should approach its plan in a different way from the previous plans, so there are varied approaches and ideas
                - how do we do this without bloating a new agent's context with every other previous plan?
            - "best" is determined by which one adheres most strictly to the outcome/goal already determined by the initial context assembly AI
        - research this more and/or have AI put together a plan on what it thinks this should look like



**Why Software Factories Fail video notes**:
This video, by Dex Horthy of HumanLayer, addresses the failure of "lights-off" software factories—agentic systems where code is generated and merged without human review. Horthy argues that while these systems can increase raw output, they fail to maintain long-term codebase health because current models are trained primarily to pass tests rather than ensure architectural maintainability. He posits that maintainability is a model training problem that cannot be solved through more tokens or complex harness engineering alone.
Highlights for your application:

    Planning as a First-Class Citizen (15:00-16:45): Horthy advocates for "turning the lights back on" by integrating human-led planning stages before agent execution. This includes:
        Product Review: Defining requirements and mockups.
        System Architecture: Mapping component contracts and data models.
        Program Design (Underemphasized): Designing types, method signatures, and call graphs specifically for the agent to follow.
        Vertical Slices: Implementing and verifying features in cohesive, testable units.
    Transparency through Alignment (16:45-17:30): Horthy notes that 30 minutes of upfront alignment can save hours of review. If you are building a collaborative workspace, prioritize tools that allow humans to verify the design of the code before it is written, rather than just reviewing the final PR.
    The "Bad PR" Bottleneck (17:05-17:30): If teams feel overwhelmed by PR volume, it is often due to "bad PRs"—code that requires significant rework. A collaborative workspace should aim to reduce rework by making the agent's intent and design explicit upfront.
    Future of Verifiers (13:18-14:31): He emphasizes that better benchmarks and verifiers are needed to measure maintainability, suggesting that the industry is still moving toward models that can truly understand "good code".

For your collaborative workspace, focus on model-assisted planning, where the AI helps create the structural design (types, call graphs) before it writes the implementation. This increases transparency, ensures the human retains ownership, and prevents the "code slop" typical of purely agentic loops.



**UI/UX Features (Future Roadmap)**
    - copy Kiro Crew's UI and paste it onto our project
    - **Organization Redesign**: Better task/subtask draggability/regrouping
    - Add reminders for tasks, which should ping the user at a specific time with their set prompt
    - **Visual Storytelling**: Use visual cues to show progress and achievements
    - **Customizable Dashboard**: Allow users to customize their dashboard with different widgets and layouts.
    - **Themes**: Dark/Light mode, custom
    - Card coloring, so user can mark certain cards as different (e.g. red = important)
        - this should probably add something in markdown to delineate... possibly in the agent context only?
    - branding info text should emphasize 2 pain points: lack of control over architecture AI is going to implement to solve X task, and the black-box nature of not being able to directly supervise the AI while it's working
    - **global rules** - these would get added as part of the skill the AI runs when it executes
    - using AI to draft new tasks/edit existing should always attempt to mimic the user's writing style based on other tasks the user has written
    - tasks should be executable w/ keybinding as well as button press
        - Ctrl+Enter by default for the 'execute' button, maybe Ctrl+Alt+E for the 'new task' button?
        - this should be configurable
    - a way in the UI to specify fallback conditions for tasks/subtasks
    - a 'human review' card _inside_ task cards, created by the AI after it finishes execution of a task
    - make sure AI is instructed explicitly on _how_ it should return human review and other text
    - **give the user a 'how-to' of best practices**
        - how to structure tasks
        - putting down a number of tasks first before running, so the AI has enough context to work effectively
        - for the optimal workflow, the user should verify tasks the AI kicked back for human review _while_ a task is executing, so that the user is always doing the higher-level architecting/verification, while the AI is doing the lower-level task execution
    - when a code CLI has paused prompting the user for clarification, this should show up as a status icon on both the humand and AI sides of the task, so the user knows they need to intervene
    - support for codeblocks (not just code lines)
    - copy/cut/delete for tasks needs to be better
    - ability to create a code-formatting doc
        - is this just part of global rules?
    - microphone access to add/edit tasks
    - we need a screen for reading what the AI has saved in vector storage, and modifying as the user wants
    - given/when/then UI for tasks, which users can fill out themselves and can be accepted directly by the AI without it needing to build that piece of the gherkin



**GO LIVE**:
- working on the web
    - verify none of the local-first features now break when it's being hosted
- get subscription connection working
- get MCP connectors working
- ~~get scheduled tasks working~~