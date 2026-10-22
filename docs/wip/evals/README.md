# Decision-model evaluations (2026-10-15)

Labelled data and scripts behind the local-model decision. Scripts expect a scratch layout (`qwen/`, `rel/`); adjust paths to re-run.

Which model runs each small job today, and the file-scout test (2026-10-22): `docs/SMALL_MODELS.md`.

- `data.py` — 40 labelled tasks: task kind, single deliverable, needed MCP servers, QA verifier needed.
- `gen.ts` — parses `~/.ergo/projects/ergo-todos/TODO.md` and writes stage-1 related-task candidates for the 14-task related-task answer key (the key is inside the eval scripts).
- `qeval.py` / `qeval2.py` — llama.cpp `llama-server` evals (round 1: plain prompts; round 2: few-shot + per-item questions).
- `haiku_eval.py` — the same tests through `claude -p --model haiku` (the tiny cloud fallback).
- `ac.py` — autocomplete (fill-in-the-middle) latency and samples.
- `compare.out` — raw results for Coder 1.5B Q4, general 0.5B Q8 and Coder 0.5B Q4.
- `LOCAL_MODEL_SPEC.md` — the implementation contract that came out of it.

| Decision | Qwen Coder 0.5B | Claude Haiku |
|---|---|---|
| single deliverable vs split | 90% | 82% |
| needs QA verifier | 83% | 92% |
| task kind | 48% | 100% |
| MCP selection (exact set) | ≤60% | 88% |
| related tasks F1 | 0.40 | 0.70 (local search alone: 0.56) |

Qwen3 0.6B (Q4_K_M and Q8_0, thinking off) was also tested as a replacement and rejected: split 52/42%, needs QA 50/50%, no fill-in-the-middle output, task kind 55%, MCP exact ≤38%, related F1 ≤0.41 (`qwen3-compare.out`). No official Qwen3 coder model exists under 1 GB, so Ergo stays on Qwen2.5-Coder 0.5B.

Two Ollama community models were tested the same way and rejected (`ollama-finetunes.out`):
- `aikid123/qwen3-coder:0.6b` is byte-identical to the stock `qwen3:0.6b` weights (same SHA-256) with a system prompt added. Split 38%, needs QA 50%, no FIM; best task kind 62%, MCP exact 65% (thinking on, ~8 s per call), related F1 0.46.
- `Havenlon/Execution-Boundary-Qwen35-0.8B-Q4_K_M` is tuned for agent execution-policy questions. Needs QA 92% (11/12), but split 42%, no FIM, task kind 65%, MCP exact ≤38%, related F1 ≤0.22; with thinking on it stopped producing answers (53 of 54 unparseable).

## File scout: Qwen vs the small cloud model (2026-10-22)

Four real Ergo tasks, scored on the files the agents actually edited (11 in total). Plain search found 7 (top `code_search` files for the task text, no model). Qwen picking from those candidates found 7. Qwen writing queries found 7: it mostly echoed the task. The Haiku scout found 8.5 (average of 2 runs). In live runs (8 per condition, Sonnet manager), a list from plain search cost $2.31, the same as no list ($2.32). The Haiku list cost $1.99 including the scouts. The file scout stays on the small cloud model.
