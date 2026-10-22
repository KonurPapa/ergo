# Ergo

## Work together with AI

**The AI Problem:** It's often an invisible black-box agent that you have to micromanage with prompts, or a token-hungry over-thinker that spends too much time planning and not enough time building.

**Ergo** is an AI-powered task workspace, designed to align humans and AI in a shared, holistic project environment. 

It provides a clean, scannable task list paired alongside rich, technical briefs. This means you and the AI **share the same working model of your project**, enabling the AI to function more like an actual collaborator and less like a mindless drone. Your output is better because the AI is **closer to your understanding of the whole project**.

Beyond the human/AI synchronization, Ergo also acts as a **Model Context Protocol hub**, allowing **seamless execution of your real-world tools, all from one interface**.

---

## 💡 The Core Vision & Philosophy

Modern AI workflows often suffer from the **"Agent Tax"**: autonomous agents loop indefinitely through hidden planning steps, consuming tokens rapidly while leaving users unable to inspect or redirect wrong assumptions before execution.

Ergo keeps the human in the loop:
1. **Shared Context**: Dual-layer task architecture ensures humans see a clean, simple task list while AI receives complete, dependency-ordered technical briefs. You're no longer overwhelmed by paragraphs of AI text, and the AI doesn't lose the specificity needed to be effective.
2. **Action → Pause → Review → Execution**: The AI can draft and organize tasks for you, giving you full visibility to tweak or approve anything before triggering execution. You're always in the driver's seat.
3. **Unified Workspace**: Task management and task execution occur in the exact same window, so you can manage and execute tasks without ever leaving your workspace.

---

## ✨ Key Features

- 📋 **Dual-Layer Architecture**:
  - **Human Layer (`TODO.md`)**: Terse, clean, scannable tasks for immediate human readability.
  - **AI Layer (`AGENT_CONTEXT.md`)**: Rich technical briefs, execution constraints, and architectural roadmaps for AI context alignment.
- 🤖 **AI Task Drafting**: Turn high-level prompts or rough ideas into structured, prioritized subtasks and implementation plans automatically.
- 🔌 **Connections & MCP Hub (BYO-MCP)**:
  - Connect external services (VS Code, Google Workspace, Slack, Asana, Figma, local tools) via standardized Model Context Protocol (MCP) integrations.
- 🖼️ **Interactive MCP Apps**:
  - Render live interactive widgets (charts, message composers, calendars, visual boards) directly inside task items upon execution.
- ⚡ **Bi-Directional Persistence & Live Sync**:
  - Keep state in sync across UI and local workspace markdown files.

---

## 🛠️ Architecture & Stack

- **Frontend**: React, TypeScript, Vite, Vanilla/Tailwind CSS
- **Protocol & Integration**: Model Context Protocol (MCP) Client supporting standard JSON-RPC over WebSockets/SSE and MCP Apps (Interactive UIs)
- **Data & Storage**: File-system markdown synchronization with structured local state

---

## 🚀 Getting Started

### Prerequisites
- Node.js (v18+ recommended)
- npm or yarn

### Installation & Running Locally

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the development server:
   ```bash
   npm run dev
   ```

3. Open your browser and navigate to `http://localhost:5173`.

### Using the hosted web app with your local device

The local server doubles as the device bridge: it lets AI agents run CLIs and read/write files on your machine. It only accepts requests from this machine (loopback), and only from Ergo's own page or from allowed origins. The hosted app at `https://ergo.appwrite.network` is allowed by default — no setup needed.

To change the default (e.g. after moving to a new domain), edit `HOSTED_APP_ORIGINS` at the top of `vite.config.ts`. To allow additional origins without editing code, create `.env.local` in the project root:

```bash
# Exact https:// origins only — no wildcards, no trailing paths. Comma-separate multiple entries.
ERGO_ALLOWED_ORIGINS=https://another-ergo-site.example.com
```

Restart `npm run dev` after changing it. Requests from any other website are refused (and logged in the terminal).

If the hosted app says it can't reach your local bridge: make sure `npm run dev` is running in your Ergo folder (the hosted app scans ports 5173–5180 and 3000, since Vite moves to the next free port when 5173 is busy) and keep your local copy up to date (`git pull`).

Chrome, Edge, Brave and Firefox also ask before a website may reach apps on your computer. When the browser asks to let the hosted site "access other apps and services on this device", click **Allow** — until you answer, the browser holds every request to the bridge. If you blocked it earlier, allow it again in the site's settings: **Apps on device** in Chrome, Edge and Brave (click the icon left of the address bar → Site settings), or **Access this device** in Firefox's address-bar permissions panel. Safari is not supported.

---

## 📄 License

MIT License.
