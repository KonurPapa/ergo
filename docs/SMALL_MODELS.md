# Small background jobs: which model does what

Besides the agents that do the actual work, Ergo runs several small jobs: suggestions while you type, quick decisions before a run, and a search for the files a task needs. They use cheap models so they cost almost nothing. There are three of them:

- **Qwen** — Qwen 2.5 Coder 0.5B, running privately on your computer. Free. Optional: you install it during onboarding or in Settings.
- **The small cloud model** — the cheapest capable model of your AI profile's provider: Claude Haiku, GPT Luna, Gemini Flash-Lite or Grok. It costs a fraction of a cent per job and is billed to your profile (or counted against your subscription).
- **MiniLM** — a small embedding model that runs inside Ergo's bridge on your computer. It turns text into vectors for searching. Free, always installed.

## The jobs

| Job | When it runs | Model | If that isn't available |
|---|---|---|---|
| **Autocomplete** | While you type a task | Qwen, if local mode is on | Small cloud model, then no suggestion |
| **Run plan** — split the work across workers? run the QA checker? | Just before a CLI task run starts | Qwen, if local mode is on | Small cloud model, then built-in rules |
| **Task overview + rating** | Before a run (Auto model selection) | Small cloud model | Your profile's model |
| **Task overview** | Before a run (Manual model selection) | Your profile's Summary model | — |
| **Related tasks** — first pass | Before a run | MiniLM (vector search) | — |
| **Related tasks** — final pick | Before a run | Same call as the overview | Built-in cut-off on the vector scores |
| **File scout** — which files the task needs | Start of a CLI task run, if the folder has a code index | Small cloud model | The run starts without a list |
| **Steering check** — does your mid-run message change the plan? | When you message a running task | Small cloud model | Built-in rules |
| **Code index** for `code_search` | When a folder is added to Allowed Folders, then on every file change | MiniLM | Keyword search only |
| **Workspace memory** | As tasks and notes change | MiniLM | — |

Two details:

- **A pinned autocomplete model.** If you set an autocomplete model in your AI profile, autocomplete and the file scout use it instead of the default small cloud model. The other small cloud jobs always use the default.
- **Subscription profiles.** Small cloud jobs run through the CLI (for example Claude Code with `--model haiku`), unless the profile also holds an API key, which answers faster. The file scout runs on Claude Code subscriptions only: Codex and Antigravity have no small model with tools, so their runs start without a file list.

## Why Qwen does only two of them

Qwen was measured on every job before it was given any (details in `docs/wip/evals/README.md`). The rule: Qwen gets a job only if it does it about as well as the small cloud model.

| Job | Qwen 0.5B | Small cloud model (Claude Haiku) | Verdict |
|---|---|---|---|
| Split the work or not | 90% correct | 82% | Qwen |
| QA checker needed | 83% | 92% | Qwen (close; it's free) |
| Autocomplete | usable, ~100 ms | usable, slower | Qwen |
| Task kind (coding, writing…) | 48% | 100% | Cloud |
| Which MCP tools a task needs | ≤60% | 88% | Cloud |
| Related tasks (F1 score) | 0.40 | 0.70 | Cloud |
| File scout: edited files found | 7 of 11 (no better than plain search) | 8.5 of 11 | Cloud |

### File scout: local vs cloud (tested 2026-10-22)

Four real Ergo tasks. Each option was scored on whether its list contained the files the agents actually edited:

| Scout | Edited files found | Time | Cost |
|---|---|---|---|
| No model: the top `code_search` files for the task text | 7 of 11 | 0.1–0.3 s | free |
| Qwen picks from those candidates | 7 of 11 | 2–4 s | free |
| Qwen writes search queries | 7 of 11 | 0.6–2.6 s | free |
| Small cloud model searching on its own | 8.5 of 11 | 7–19 s | ~$0.006 |

Qwen added nothing over plain search. It mostly repeated the task text as its queries. The cloud scout finds more because it follows the code, for example into the stylesheet a component uses.

What decides it is the cost of the whole run (8 runs of the same tasks, Sonnet as the working agent):

| Starting point for the agent | Run cost | Agent API time |
|---|---|---|
| No file list (`code_search` only) | $2.32 | 420 s |
| List from plain search (free, local) | $2.31 | 432 s |
| List from the small cloud model | $1.99 (incl. $0.05 for the scouts) | 399 s |

A list from plain search saved nothing. The cloud scout's more complete list is what makes the run 14% cheaper, so the file scout stays on the small cloud model.

## Settings

- **Local mode (Qwen):** Settings → Local model, or onboarding. Skip it, and the small cloud model does autocomplete and the run plan too.
- **Small cloud model:** follows your active AI profile. To use a specific model for autocomplete and the file scout, set an autocomplete model in the profile.
- **Code index:** Connections → Allowed Folders shows each folder's indexing progress.
