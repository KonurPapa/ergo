# Ergo

### Human-in-the-Loop AI Task Workspace

**Ergo** is an AI-powered project workspace designed around a core principle: **aligning humans and AI in a shared, transparent mental model.**

Rather than treating AI as an unpredictable black-box chatbot or an expensive autonomous agent that burns tokens planning in loops, Ergo pairs a **clean, scannable human task list** with a **rich, automated technical brief**. Coders and non-technical builders alike get complete visibility and control over what the AI builds before, during, and after execution.

---

## 💡 The Core Vision: Ending the "Agent Tax"

Modern autonomous coding agents often suffer from the **"Agent Tax"**: they loop through hidden internal planning steps, consume tens of thousands of tokens, and wander off-course because the human can't inspect or redirect wrong assumptions until it's too late.

Ergo fixes this with three foundational design choices:

1. **Dual-Layer Markdown Architecture**:
   - **Human Layer (`TODO.md`)**: Terse, clean, and scannable. A native Markdown checklist with subtasks and categories that anyone can read at a glance.
   - **AI Layer (`TASK_CONTEXT.md` / Working Brief)**: The moment a task runs, Ergo synthesizes an immutable technical brief containing the task goal, constraints, criteria checklists, relevant project rules (`AGENTS.md` / `CLAUDE.md`), and historical learnings.
2. **Zero-Token Local-First Vector DB**:
   - A local-first semantic index (`.ergo/memory/`) computes embeddings on your machine using `all-MiniLM-L6-v2` alongside a BM25 keyword index.
   - **Zero tokens spent on discovery**: Over 85% of relevant code and project files are surfaced deterministically *before* firing an LLM prompt.
3. **Action → Pause → Review → Execution**:
   - The AI drafts, organizes, and prioritizes tasks, but you always retain ownership. Inspect, refine, or approve plans with single-click confidence.

---

## ✨ Where Ergo Stands Out

- 📋 **Steer AI via Native Markdown**: Everything lives in standard, open Markdown files on your local drive. No proprietary database lock-in, no hidden agent prompts.
- ⚡ **Direct (Solo) Mode vs. Multi-Agent Fan-Out**:
  - Simple deliverables (standalone scripts, components, quick fixes) execute directly in a lightweight tool loop (max 5 rounds), reducing token consumption by **~90%** (8k–15k tokens vs. 120k+).
  - Complex systems automatically decompose into verifiable criteria puzzle pieces (`setup`, `build`, `verify`, `edge`).
- 🖥️ **Hybrid Local Daemon (Ergo Bridge)**:
  - Run Ergo completely locally, or connect the hosted web app (`ergo.appwrite.network`) to your machine via the lightweight **Ergo Bridge** daemon.
  - Enjoy the slickness of a modern web workspace with full local filesystem access, private vector search, and interactive terminal PTYs.
- 🔌 **Universal MCP Hub (BYO-MCP)**:
  - Connect external tools and services (VS Code, GitHub, Google Workspace, Slack, Figma, local scripts) via the standardized Model Context Protocol (MCP).
  - Render interactive MCP UI widgets (charts, calendars, message composers) directly inside task cards.
- 💻 **Integrated CLI Agent Runner**:
  - Launch and orchestrate external coding agents—including **Claude Code, Antigravity (`agy`), Cursor CLI, Codex, and Aider**—inside embedded xterm.js terminals directly alongside your task list.
- 🎯 **Auto Model Routing**:
  - Automatically maps models to tasks based on size and difficulty: *"Size decides the model; difficulty decides the effort."*

---

## 🛠️ Architecture & Stack

- **Frontend**: React 19, TypeScript, Vite, Tiptap Rich Markdown Editor, xterm.js
- **Local Bridge Daemon**: Node.js, `node-pty`, WebSocket / SSE streaming, loopback security
- **Semantic Memory**: Local disk-backed vector store (`all-MiniLM-L6-v2`, 384-dim) + BM25 keyword code indexer
- **Protocol & Extensibility**: Model Context Protocol (MCP) Client (SSE / stdio / WebSockets) & Interactive MCP Apps
- **Storage**: Bi-directional local Markdown synchronization (`TODO.md`, `TASK_CONTEXT.md`, `.ergo/`)

---

## 🚀 Getting Started

### Prerequisites
- Node.js (v18+ recommended)
- npm or yarn

### Installation & Running Locally

1. **Clone the repository and install dependencies:**
   ```bash
   git clone https://github.com/KonurPapa/ergo.git
   cd ergo
   npm install
   ```

2. **Start the local app and bridge daemon:**
   ```bash
   npm run dev
   ```

3. **Open your browser** and navigate to `http://localhost:5173`.

---

## 🌐 Using the Hosted Web App with Your Local Device

The hosted version at `https://ergo.appwrite.network` connects to your local machine through **Ergo Bridge**, a small background daemon that runs CLI agents, reads and writes files in `~/.ergo`, and manages local memory.

### Installing Ergo Bridge
- Download the installer for Windows, macOS, or Linux directly from the onboarding screen in the web app (built from `desktop/`; see [desktop/README.md](desktop/README.md)).
- The bridge starts on login, lives quietly in your system tray, and connects automatically when you open Ergo in your browser.

### Developer Bridge Mode
Developers can run the bridge from source instead of installing the desktop binary:
```bash
# Starts both the bridge and local web app
npm run dev

# Or run the bridge daemon standalone:
npm run bridge
```

### Security & Local Permissions
- **Loopback Only:** The bridge only accepts requests originating from `localhost` and explicitly allowed origins.
- **Allowed Origins:** By default, the hosted app (`https://ergo.appwrite.network`) and local ports are allowed. To allow additional domains, create a `.env.local` file:
  ```bash
  # Exact https:// origins only (comma-separated, no trailing slashes)
  ERGO_ALLOWED_ORIGINS=https://another-ergo-site.example.com
  ```
- **Browser Device Permissions:** Browsers like Chrome (142+) and Firefox (149+) prompt for permission when a public website requests access to local network services. When prompted to *"access other apps and services on this device"*, click **Allow**.

---

## 📄 License

MIT License.
