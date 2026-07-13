# Ctrl+Alt+Space Advanced RAG and Prompt Autopilot

`Ctrl+Alt+Space` is the trigger for an adaptive, context-aware prompt pipeline. With Prompt Autopilot enabled, the pipeline creates multiple grounded candidates in one model request, validates and ranks them locally, then inserts the strongest candidate. When the Prompt Optimizer window is focused, the same shortcut opens the ranked candidate comparison instead of silently choosing for the user.

The desktop process remains available from the system tray when its window is hidden. `Ctrl+Alt+F10` globally pauses or resumes optimization without terminating that background process. The toggle remains registered while `Ctrl+Shift+Space` and `Ctrl+Alt+Space` are paused.

## Active Pipeline

1. Capture the foreground process, window title, nearby workspace heading, central chat text, and active textbox with Windows UI Automation.
2. Sanitize control characters, redact credentials, detect prompt-injection patterns, and enforce section and token budgets.
3. Route the request to `feature`, `debug`, `refactor`, `test`, `review`, `explain`, or `general` intent.
4. Build three local HyDE-style retrieval hypotheses. For vague prompts or weak initial recall, ask Groq for three bounded retrieval hypotheses.
5. Retrieve local memory using BM25 plus a privacy-preserving local feature-vector similarity search.
6. Fuse rankings with Reciprocal Rank Fusion, rerank for token coverage, source quality, and recency, then remove near-duplicates.
7. Apply a CRAG-style `high`, `medium`, or `low` relevance grade. Low-confidence memory cannot override live chat or current project state.
8. Spotlight retrieved chunks in delimited, source-labelled evidence blocks. Treat every block as untrusted data.
9. Add workspace-matched project files, git state, and scoped optimizer history within a 17,000-character request budget.
10. Generate two to four strategy-diverse candidates in one Groq request using quality-first model fallback.
11. Parse strict JSON, validate and redact every candidate, remove duplicates, and reject malformed or oversized output.
12. Grade intent preservation, grounding, specificity, actionability, and verification coverage. Rank candidates locally so candidate selection does not require another network call.
13. If the best candidate misses the configurable quality gate, run one bounded self-reflection repair and rerank.
14. Create an expiring Autopilot session. The external shortcut automatically accepts the best candidate; the in-app workflow lets the user compare, accept, copy, or explicitly send a candidate to the selected IDE.
15. Restore the target window, replace the textbox content, learn from the accepted result, and update privacy-preserving local product metrics.

## Workspace Isolation

Every context-mode run derives a stable scope such as `app:antigravity:workspace:running-app-using-ai-models`. The scope is carried through project selection, prompt history, memory documents, retrieval, HyDE, diagnostics, and cache keys.

- `Match Active Workspace` is the default project policy. A repository is included only when its folder/name matches the detected workspace or the user creates an explicit workspace binding.
- `Always Use Active Project` is an opt-in pinned policy for users who intentionally work on one repository from several applications.
- Newly learned memory is tagged with the current scope. Legacy unscoped memory and memory from another application/workspace are excluded by default.
- Cross-workspace memory and optimizer history are separate, explicit Settings options and are disabled by default.
- If workspace detection succeeds but no project matches, context mode continues with the live chat and that workspace's memory. It does not fall back to an unrelated selected repository.

## Shortcut Contract

- `Ctrl+Shift+Space` remains the fast, no-memory LLM optimizer.
- `Ctrl+Alt+Space` runs advanced RAG and Prompt Autopilot when enabled, or the original single-result RAG flow when Autopilot is disabled.
- `Ctrl+Alt+F10` remains the global pause/resume control. It releases both action shortcuts while paused and does not cancel an already-running request.

No shortcut uses polling. Registration is handled by Electron's main process and remains available while the window is minimized or hidden in the tray.

## Product Metrics

Autopilot records only counters and dates: optimization totals, context-mode totals, candidate sessions, accepted sessions, IDE handoffs, and active days. Prompt text, retrieved context, model output, API keys, filenames, and IDE responses are never stored in product metrics. Metrics remain local and can be disabled in Settings.

## Five Cache Tiers

- `intent`: 24 hours
- `hyde`: 6 hours
- `retrieval`: 20 minutes and keyed by memory revision plus application/workspace scope
- `generation`: 1 hour
- `final`: 1 hour

All cache and memory data is local under `%USERPROFILE%\.prompt-optimizer`. Clearing memory also clears the pipeline caches.

## Diagram Mapping

The desktop release implements the diagram's algorithmic RAG stages locally: input and output guardrails, intent routing, HyDE, hybrid retrieval, RRF, reranking, CRAG grading, spotlighting, answer generation, self-reflection, caching, and persistent memory.

The following diagram components are server deployment options and are intentionally not claimed as running in this desktop build: FastAPI, JWT, Redis, PostgreSQL, Qdrant, Text2SQL, Tavily web fallback, AWS ECS, and OpenAI embeddings. They become relevant for a multi-user cloud edition with account isolation, shared corpora, billing, remote observability, and horizontal scaling. The desktop app uses local JSON persistence and a local feature-vector index so it works with the existing Groq key and does not upload memory to additional vendors.
