> I have an idea for essentially an AI-powered todo list. The concept is that instead of writing individual prompts and holding the context for the entire project mostly in the human's head while spoon-feeding work to the AI piecemeal, this would help both the human and the AI to be more closely aligned to the project's goals in a holistic way.


I've currently been using this in a rough sense within a markdown todo list file in my codebase. I have 2 skills for this: one which assists in creating todos, the other which assists in executing them. So the next logical iteration of this is giving it some sort of UI that's a little more user-friendly for both developers using it directly in a codebase, and ordinary users who might be working on a graphic design project, general admin tasks for work, etc. I'm thinking it has all the general features of a simple todo list, but with added buttons like 'draft tasks with AI' and 'execute task', which will perform those skills, respectively.


Firstly, is there a tool out there like this already? I know there's a ton of AI-powered everything, but specifically I'm wondering if there's a tool that fills this particular niche in terms of task-management alongside an AI, with the goal of better, more efficient AI usage and giving the AI a bigger picture of how its tasks fit into the larger project. I'm not talking a full CRM, just a lightweight way of achieving this goal. I'm not going to go to the trouble of actually trying to build this for anyone else if this exact thing is already out there, though.


Secondly, if this does seem like a niche that's currently untapped, what would be the best way to build this? I use my current workflow within VS Code, but I'm thinking something more extensible that's easier for the average person to use, regardless of their exact application.
Does This Tool Already Exist?

The short answer is no, not in the specific, lightweight way you are describing. While there are enterprise tools like Asana that use AI to summarize notes or suggest assignees, and raw developer agents like AutoGPT that run blindly in the terminal, the middle ground is essentially empty.

A dedicated UI where humans and AI act as co-workers sharing the exact same context—where the AI can take a rough idea and flesh it out into a terse human-facing ask and a full implementation brief, and then explicitly execute the task while skimming other entries to understand the broader roadmap—is an untapped niche. Existing tools either entirely lack the execution capability, or they bury the context in abstract chat windows rather than anchoring it in a shared, unified task list.  
How to Build It for the Average User

To make this accessible outside of a developer's IDE, it needs to look and feel like a standard productivity app while hiding the agentic complexity under the hood.

    Frontend UI: A clean, responsive interface built with React and Tailwind CSS would provide the familiar, accessible experience required for non-developers.

    Backend & Orchestration: Node.js can handle the routing of the AI skills, while Supabase provides lightweight data persistence and cross-device syncing.

    Context Architecture: Instead of using a complex RAG database architecture to manage the AI's memory and state, you can stick to a straightforward AI skills methodology based on structured markdown documentation. The app's database would simply generate and maintain the exact dual-layer structure you already use—keeping the human-facing UI scannable in seconds, while feeding the verbose, dependency-ordered briefs to the agent when it executes.  

    Non-Developer Execution: For average users, the "execute" button would trigger skills mapped to typical digital actions (e.g., sorting inbox data, summarizing web research, manipulating local file systems) rather than writing code. The AI would still verify its constraints, write the brief, and implement the steps end-to-end, just in a different environment.  

Since average users won't be modifying a codebase, what specific native integrations or environments do you envision the "execute" skill interacting with for general administrative or creative tasks?

> I have a clear picture of how developers would use this (as I'm doing it myself), but not how this would work for users performing other tasks. How would an ordinary user bring their own AI? And how would they connect it to their own data/services/tools? Is this the job of MCP connections? What would this look like? Assume the role of several different users with varying use-cases trying to use this, and how that would affect the implementation.

You are asking all the right questions. What you're pointing to is the core difference between the initial vision of the Model Context Protocol (MCP) as a backend integration layer and its more recent evolution into a frontend user experience.

The answer to "how does an ordinary user bring their own AI and connect it?" is indeed MCP, but specifically an extension that landed in early 2026 called MCP Apps (or interactive UI).

Here is how the dynamic works for ordinary users, breaking down the roles of the client, the server, and the UI.
The Ecosystem: How Non-Developers Use MCP

To understand how a non-developer uses this, you have to separate the "Host" (the AI app they are using) from the "Server" (the tool they are connecting to).

    The Host (The Client): For developers, the host is often an IDE like Cursor, VS Code, or Windsurf. For a non-developer, the host is a consumer-facing AI application. Claude Desktop and ChatGPT are currently the most popular general-purpose MCP clients. The user opens Claude or ChatGPT and interacts with the AI there.

    The Server (The Connection): The MCP server is the bridge to the external tool (e.g., Google Drive, Slack, Figma, a CRM). Previously, configuring this required a developer to edit JSON files and run local Node or Python scripts. Now, many enterprise and consumer tools offer remote, hosted MCP servers that connect via simple OAuth flows. For example, a user just goes into Claude's settings, clicks "Connect," and pastes a URL like [https://mcp.productive.io/mcp](https://mcp.productive.io/mcp) to authenticate their account.

    The App (The Interactive UI): This is the game-changer for your todo list idea. With the MCP Apps extension, when an AI calls a tool on a connected server, it doesn't just return a block of JSON data or a text summary. It returns a sandboxed, interactive HTML interface directly into the chat window.

Use Cases: What It Looks Like in Practice

Because the AI and the user are sharing a live, bidirectional interface, the "execute task" button in your idea doesn't just run code in a terminal; it renders a workspace right in the chat.

Here is how varying users would experience this:

    The Marketer (Using Amplitude & Slack):

        The Goal: Analyze a drop in user signups and report to the team.

        The Execution: The AI runs a query via the Amplitude MCP server. Instead of just listing numbers, the server returns an MCP App—an interactive product-analytics chart rendered inside Claude. The marketer clicks the chart to adjust the date range and drill down into the data. Once they find the insight, they click a button in your todo app that says "Draft Report." The AI writes the summary and then uses the Slack MCP server to render a message composer right in the chat. The user reviews the draft, hits "Send" on the interactive widget, and the task is marked done.

    The Product Manager (Using Asana & Figma):

        The Goal: Turn a brainstorming session into a visual project plan.

        The Execution: The user pastes a rough text brief into your todo list. They click "draft tasks with AI." The AI uses the Asana MCP server to flesh out the tickets, returning an interactive kanban board view directly in the chat. The PM can drag and drop tickets to adjust priorities. Next, they need a wireframe. The AI uses the Figma MCP server to generate a diagram based on the tickets, rendering an editable Figma canvas right there in the window.

    The Personal User (Using Reclaim.ai & Expedia):

        The Goal: Plan a business trip.

        The Execution: The user tells the AI they need to travel to Chicago next Thursday. The AI uses the Reclaim.ai MCP server to check their calendar, rendering an interactive calendar widget in the chat where the user clicks to approve the time block. Then, the AI uses the Expedia MCP server to fetch flights and hotels, rendering an interactive map and booking cards. The user clicks "Book" directly on the UI widget inside the chat.

The Implementation Takeaway for Your App

If you want to build this for the average person, you don't need to build the integrations (the M×N problem). You just need to build a lightweight Host that supports the MCP Apps extension.

Your application would serve as the unified task list and orchestration layer. It would handle the state management of the projects and allow users to authenticate with whatever public MCP servers they already use for their jobs (Google Workspace, Salesforce, Canva, etc.).

When the user clicks "execute task," your app reads the brief, calls the relevant tool on the user's connected MCP server, and renders the resulting interactive UI (the MCP App) right there in your application, allowing the user to approve, tweak, or finalize the work the AI just did.

Does the idea of building an MCP Host that orchestrates these interactive widgets align with how you want users to experience the "execute" phase of your app?

> So let me see if I understand. Since it will be its own standalone app, the AI will essentially have to call an MCP for actually executing any task - whatever the external service is that it's working in, like VS Code, Google Docs, Excel, Unity, etc. So the user would connect their MCP(s), and then the AI would select the right MCP(s) for the task it's working on.


If this is a correct understanding, the next question becomes how to actually connect these MCPs into the app? How do I build a versatile bring-your-own-MCP environment and make sure the task-list skills can actually call the MCPs? And I also need more clarity on how a user would bring their AI too; in a programming context, this would just be an API key, but that doesn't seem user-friendly enough for non-devs.

Your understanding is spot on. The app acts as the MCP client, the MCP server acts as the secure bridge, and the external service is where the actual work happens.
Connecting the MCPs

To build a seamless BYO-MCP environment for average users, you must move away from the local, environment-based credentials used by developers.

    The Standard: The standard for securing remote MCP servers is OAuth 2.1 with PKCE, which was formally mandated in the March 2025 MCP specification update.

    The User Experience: This provides a secure and standardized way for users to authorize access to resources via an interactive, browser-based consent flow. The user clicks "Connect Asana," a standard login window pops up, and they approve the connection.

    The Architecture: These remote MCP servers are designed for HTTP-based transports. Implementations typically use Server-Sent Events (SSE) to maintain the connection.

    State Management: Your Node.js backend handles the OAuth handshake, receives the scoped access token, and securely stores it in Supabase or Neon DB. When your React frontend triggers an "execute task" action, the backend attaches this token to the request, verifying the user's identity before the MCP server executes the tool.

Solving the "Bring Your Own AI" Problem

You are absolutely right that handing out API keys is a non-starter for consumer applications. There are two viable paths for non-developers:

    OAuth for AI Providers: Just like connecting an MCP, major AI providers support OAuth flows. A user clicks "Sign in with Anthropic" or "Connect ChatGPT Plus." Your app receives an access token that allows it to route inferences through the user's existing consumer subscription. This is true "BYO-AI" without the UX nightmare of managing keys.

    Abstraction via SaaS: The most common approach is abandoning BYO-AI entirely for the end-user. You handle the AI infrastructure on your backend using your own enterprise API keys. The user simply pays a flat monthly subscription for your app, and you abstract away the token costs and model routing entirely.

Would you prefer to abstract the AI costs behind a standard SaaS subscription, or are you set on building a BYO-AI flow where users authenticate their own provider accounts?

> So the app will be a sort of MCP hub, where users can visually write out and see all the components of their tasks/projects in one organized list-like format. What differentiates this from OpenClaw, for example? Isn't this just another flavor of agentic flow? Or does this logic approach things in a different way?

This is a fantastic question because it gets right to the heart of how AI tool-use is evolving. Your concept is fundamentally different from OpenClaw, and it represents a completely different logic in human-computer interaction.

While both involve an AI using tools to accomplish goals, the difference lies in the paradigm: OpenClaw acts as an invisible autonomous employee, while your app acts as a shared visual workspace.

Here is how the logic of your app breaks away from standard agentic frameworks:
1. Breaking the "Agent Tax" Loop

OpenClaw is designed to function via a chatbot within messaging services like WhatsApp, Telegram, Discord, or Slack. When you give it a prompt, it enters a continuous, autonomous agentic workflow consisting of Plan -> Think -> Act -> Observe -> Repeat Until Completion.

The problem with this standard flow is what developers call the "Agent Tax"—this looping process is input-heavy, burns through tokens rapidly, and can become incredibly sluggish. If the AI misunderstands the goal on step one, it spends five minutes executing the wrong plan.

Your logic decouples this loop. By having one specific skill to "draft tasks" and a separate one to "execute task," you insert a natural, frictionless pause. The AI does the heavy lifting of the planning phase, but the execution phase doesn't begin until the human looks at the list and clicks the button.
2. Shared Holistic Context vs. Hidden Internal State

Standard agents keep their plans hidden. OpenClaw relies on a single configuration file called SOUL.md to define its identity and rules, but its active "thoughts" during a task are just internal scratchpad data.

In your app, the AI's internal state is the user interface. By utilizing your dual-file structure—the terse TODO.md for the human-facing ask and the verbose AGENT_CONTEXT.md for the brief—the human and the AI share the exact same mental map of the project. If the AI misses an edge case, the human sees it immediately in the UI and can adjust the task before any execution happens.
3. Interactive UI vs. Textual Output

Because OpenClaw lives in messaging apps, its output is largely conversational text. If it runs a data analysis script, it sends you a summary message.

Because your app is an MCP hub utilizing the MCP Apps extension, execution isn't just text—it's interactive. When the user clicks "execute," the AI doesn't just say "I did it." It renders the Figma board, the calendar widget, or the spreadsheet directly in the todo list item. The task management and the task execution happen in the same pane of glass.

In short, standard agentic flows ask the human to relinquish control to a black box. Your approach uses the AI to organize the box, opens the lid so the human can verify the contents, and then uses the AI to execute the individual pieces.