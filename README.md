# Ergo

## Work together with AI

**Ergo** is an AI-powered visual todo list and task workspace designed to align humans and AI in a shared, holistic project environment. 

Rather than treating AI as an invisible black-box agent or burying context inside chat windows, Ergo provides a scannable visual dashboard paired with structured, agentic technical briefs. It acts as an **MCP Host** (Model Context Protocol client) with support for interactive **MCP Apps**, enabling seamless execution of real-world tools across developer and non-developer workflows alike.

---

## 💡 The Core Vision & Philosophy

Modern AI workflows often suffer from the **"Agent Tax"**: autonomous agents loop indefinitely through hidden planning steps, consuming tokens rapidly while leaving users unable to inspect or redirect wrong directions before execution.

Ergo decouples planning from execution:
1. **Shared Context**: Dual-layer task architecture ensures humans see a scannable task list while AI receives complete, dependency-ordered technical briefs (`AGENT_CONTEXT.md`).
2. **Action → Pause → Review → Execution**: The AI drafts and organizes tasks, giving the user full visibility to tweak or approve before triggering execution.
3. **Unified Workspace**: Task management and task execution occur in the exact same pane of glass using interactive MCP App widgets.

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

---

## 📄 License

MIT License.
