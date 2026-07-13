# Prompt Optimizer

A Windows desktop application that turns rough prompts into high-quality, actionable requests. It combines global keyboard shortcuts, active-window context capture, workspace-scoped RAG, local memory, and prompt quality checks while keeping unrelated projects isolated.

## Why It Is Different

Most prompt tools treat every conversation as one shared bucket of context. Prompt Optimizer detects the active application and workspace, then limits memory, prompt history, and project context to that scope by default. A request in Antigravity cannot silently inherit Prompt Optimizer or Codex project context.

## Highlights

- `Ctrl+Shift+Space`: optimize the active textbox without RAG context.
- `Ctrl+Alt+Space`: capture the current chat, identify the active workspace, retrieve only matching local memory, and insert an optimized prompt.
- `Ctrl+Alt+F10`: pause or resume the optimizer while the application is minimized or hidden in the tray.
- Workspace-scoped RAG with hybrid retrieval, reranking, relevance grading, cache tiers, and optional cross-workspace reuse.
- Guardrails for prompt injection, secret redaction, token limits, and output validation.
- Windows UI Automation fallback for reliable copy, focus, and verified text insertion in external AI tools.
- Prompt Autopilot: generates and ranks multiple prompt candidates using local product metrics.

## Architecture

The system separates active-window detection, scope derivation, context assembly, RAG retrieval, generation, security checks, and verified insertion. See [ADVANCED_RAG_ARCHITECTURE.md](ADVANCED_RAG_ARCHITECTURE.md) and [RELEASE_READINESS.md](RELEASE_READINESS.md) for the design and release checklist.

## Quick Start

```powershell
npm install
npm test
npm start
```

Set your model API key in the application Settings screen. Never commit API keys, local app configuration, conversation history, or RAG indexes.

## Build

```powershell
$env:CSC_IDENTITY_AUTO_DISCOVERY='false'
npm run build
```

The Windows package is generated outside the source directory in `../dist-advanced-rag-release/win-unpacked`.

## Validation

Version 1.1.1 includes automated tests for scoped retrieval, RAG diagnostics, security guardrails, shortcut state, prompt Autopilot, and local product metrics. The release flow also includes a RAG smoke test and dependency audit.

## Portfolio Notes

This project demonstrates practical AI engineering beyond a simple API wrapper: retrieval quality, context isolation, application integration, safe automation, testing, release packaging, and measurable product workflows.

## License

MIT. See [LICENSE](LICENSE).
