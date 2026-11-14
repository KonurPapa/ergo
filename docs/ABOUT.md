# Why Ergo?

## The Problem with Modern AI

Working with AI today often feels like pulling the lever on an expensive slot machine:
1. **The Prompt Slot Machine:** You type an instruction into a chat box, hit enter, and pray. It isn't clear what the AI is thinking, which files it actually looked at, or why it chose a particular approach.
2. **The "Agent Tax":** Modern autonomous agents swing to the opposite extreme. Left on their own, they loop through endless hidden planning cycles—burning thousands of tokens before writing a single line of code, only to drift off-course because nobody caught their faulty initial assumptions.
3. **The Big-Picture Blindspot:** An AI only knows what fits in its current context window. As soon as a conversation gets long or a project gets complex, it forgets prior architectural decisions, contradicts past tasks, and offers generic guesses.

When you're forced to pick between **tedious micromanagement** and **expensive, unguided black-box automation**, you have to choose your poison.

---

## The Solution: Shared Working Memory

Ergo was built on a simple premise: **AI produces far better results when it shares the same mental model of your project that you have.**

Instead of hiding the AI's thoughts behind a chat curtain or overwhelming you with walls of technical jargon, Ergo aligns human and machine through three foundational pillars:

### 1. The Dual-Layer Markdown Model
- **Human Layer (`TODO.md`):** Terse, scannable, and clean. You get a distraction-free checklist of tasks and subtasks you can read in seconds.
- **AI Layer (`TASK_CONTEXT.md` / Working Brief):** The moment you run a task, Ergo synthesizes a structured technical brief containing the task goal, constraints, checklist criteria, and relevant project guidelines (`AGENTS.md` / `CLAUDE.md`).
- **You stay in control:** You manage your project in simple English; the AI receives the deep technical context it needs to execute without hallucinations.

### 2. Zero-Token Local-First Semantic Memory
Most agent systems burn your budget just figuring out where to look. Ergo doesn't:
- A disk-backed local vector store (`.ergo/memory/`) computes embeddings locally on your machine using `all-MiniLM-L6-v2` paired with a fast BM25 keyword index.
- **Before an LLM call is even made**, Ergo deterministically retrieves relevant historical context, architectural decisions, and related code sections at **zero token cost**.
- The AI starts every task with pre-warmed, highly accurate context instead of starting from scratch.

### 3. Killing the "Agent Tax" (Direct Execution vs. Fan-Out)
- Easy, straightforward deliverables (a standalone script, a single UI component, a doc update) run in **Direct (Solo) Mode** with strict tool budgets (max 5 rounds), dropping token usage by ~90%.
- Complex multi-file systems automatically decompose into verifiable criteria puzzle pieces (`setup`, `build`, `verify`, `edge`), ensuring quality without unbounded loops.
- You can inspect, tweak, or pause the plan before or during execution.

---

## Designed for Coders and Non-Techies Alike

Whether you're an experienced engineer orchestrating CLI agents (like Claude Code, Antigravity, or Cursor) or a non-technical creator building an app with plain Markdown:

- **No prompt gymnastics:** Write down what you need done like you would for a human teammate.
- **Zero lock-in:** Everything lives in standard, open Markdown files on your local drive. Your project is yours.
- **Complete visibility:** Action → Pause → Review → Execution. You are always in the driver's seat.

Ergo turns the AI from an unpredictable black box into a reliable, transparent collaborator that truly understands your big picture.
