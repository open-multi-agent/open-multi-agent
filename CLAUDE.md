# CLAUDE.md

This file is the working map for editing this repository: the conventions, the layer layout, the non-obvious invariants, and pointers into `docs/`. It stays lean because it loads into every Claude Code session. Conceptual architecture, the provider table, and the production checklist live in [README.md](README.md); detailed subsystem behavior lives in [`docs/`](docs/) and is linked inline below rather than duplicated here.

## Commands

```bash
npm run build          # Compile TypeScript (src/ → dist/)
npm run dev            # Watch mode compilation
npm run lint           # Type-check only (tsc --noEmit)
npm test               # Run all tests (vitest run)
npm run test:watch     # Vitest watch mode
npm run test:coverage  # Vitest with v8 coverage
npm run test:e2e       # E2E suite (requires RUN_E2E=1, real API keys)
node dist/cli/oma.js help   # After build: shell/CI CLI (`oma` when installed via npm bin)
```

Tests live in `tests/` (vitest), E2E under `tests/e2e/`. Standalone `examples/` need real API keys and are grouped by intent (`basics/`, `cookbook/`, `patterns/`, `providers/`, `integrations/`, `production/`).

## Code style & workflow

- **ESM imports need `.js` extensions**: `import { X } from './foo.js'` even though the source is `foo.ts`. TypeScript strict; no eslint/prettier, so match existing patterns.
- **After a change**, run `npm run lint` (typecheck) + the relevant tests. `tests/` need no API keys; `examples/` and `tests/e2e/` do.
- **Keep runtime deps at three** (`@anthropic-ai/sdk`, `openai`, `zod`); new SDKs enter as lazy optional peers.
- **PRs** must pass `npm run lint && npm test` (CI on Node 18/20/22). Conventional commits, reference PR/issue #. Full flow: [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md).

## Architecture

ES module TypeScript framework for multi-agent orchestration. **Three runtime dependencies only**: `@anthropic-ai/sdk`, `openai`, `zod`. Optional peers (`@aws-sdk/client-bedrock-runtime`, `@google/genai`, `@modelcontextprotocol/sdk`, `ai`) load lazily via dynamic `import()` so unused SDKs never resolve; the three-dependency promise covers `dependencies` only.

**`OpenMultiAgent`** (`src/orchestrator/orchestrator.ts`) is the top-level public API with three execution modes:

1. **`runAgent(config, prompt)`** — single agent, one-shot
2. **`runTeam(team, goal)`** — a temporary "coordinator" agent decomposes the goal into a task DAG (a single coordinator pass), then tasks run in dependency order
3. **`runTasks(team, tasks)`** — explicit task pipeline with user-defined `dependsOn`

### The Coordinator Pattern (runTeam)

The framework's key feature. The coordinator receives goal + roster → emits a JSON task array (title, description, assignee, dependsOn) → `TaskQueue` resolves dependencies topologically (independent tasks run in parallel, dependents wait) → `Scheduler` auto-assigns unassigned tasks (`dependency-first` default; also `round-robin`, `least-busy`, `capability-match`) → each result is written to `SharedMemory` for later agents → the coordinator synthesizes the final output.

### Layer Map

| Layer | Files | Responsibility |
|-------|-------|----------------|
| Orchestrator | `orchestrator/orchestrator.ts`, `scheduler.ts` | Top-level API, task decomposition, retry/backoff, coordinator |
| Team | `team/team.ts`, `messaging.ts` | Agent roster, MessageBus (point-to-point + broadcast), SharedMemory binding |
| Agent | `agent/agent.ts`, `runner.ts`, `pool.ts`, `structured-output.ts`, `loop-detector.ts` | Lifecycle (idle→running→completed/error), conversation loop, concurrency pool + per-agent mutex, structured-output validation, loop detection |
| Task | `task/queue.ts`, `task.ts` | Dependency-aware queue, auto-unblock on completion, cascade failure to dependents |
| Tool | `tool/framework.ts`, `executor.ts`, `mcp.ts`, `text-tool-extractor.ts`, `built-in/` | `defineTool()` + Zod, ToolRegistry, parallel batch exec, MCP bridge, local-model text tool-call fallback, filesystem sandbox |
| LLM | `llm/adapter.ts` + 12 per-provider files + `openai-common.ts` + `reasoning-fallback.ts` | `LLMAdapter` (`chat` + `stream`); lazy `createAdapter()` factory; `baseURL` for OpenAI-compatible servers; cross-provider reasoning round-tripping |
| Memory | `memory/shared.ts`, `store.ts` | Namespaced KV store (`agentName/key`), markdown summary injection; pluggable `MemoryStore` backends |
| Dashboard | `dashboard/*.ts` | Pure HTML renderer for the post-run task DAG (no I/O) |
| CLI | `cli/oma.ts` | Shell/CI entry; built to `dist/cli/oma.js`, exposed as the `oma` npm bin |
| Utils | `utils/*.ts` | Semaphore, token accounting, keyword helpers, trace plumbing, secret/PII redaction |
| Types / Errors | `types.ts`, `errors.ts` | All interfaces in one file (avoids circular deps); shared error types |
| Exports | `index.ts`, `mcp.ts`, `ai-sdk.ts` | Root + `/mcp` + `/ai-sdk` subpaths so optional peers don't break the main import |

### Non-obvious invariants

Behavior that isn't visible from any single file and will cause bugs if missed:

- **Tool errors never throw** — they're caught and returned as `ToolResult(isError: true)`. Task failures cascade to dependents (independent tasks continue); LLM API errors propagate to the caller.
- **Built-in tools are default-deny** — `resolveTools()` (`agent/runner.ts`) grants a built-in (`bash`, `file_*`, `grep`, `glob`, `delegate_to_agent`) only when `AgentConfig.tools` or `toolPreset` is set; with neither, an agent resolves to **zero** built-in tools. Custom/runtime tools (`customTools` / `addTool`) are exempt — registration is the grant — but still honor `disallowedTools`. The runner gates execution on the same granted set, so a registered-but-ungranted call returns a `"not granted"` error instead of running. `OrchestratorConfig.defaultToolPreset` restores the prior allow-all. Uniform across `runAgent` / `runTeam` / `runTasks` / short-circuit / standalone `Agent`. → [docs/tool-configuration.md](docs/tool-configuration.md)
- **`delegate_to_agent` is orchestration-only and needs a grant** — registered only inside `runTeam`/`runTasks` pool workers (never in standalone `runAgent` or the `isSimpleGoal` short-circuit), and like every built-in it must be granted via `tools: ['delegate_to_agent']` to be callable. Self-delegation, cycles, unknown targets, depth > `maxDelegationDepth` (default 3), and pool-slot exhaustion are all rejected in the tool; delegated token usage counts against the parent budget. → [docs/tool-configuration.md](docs/tool-configuration.md)
- **Filesystem tools are sandboxed, `bash` is not** — `file_read/file_write/file_edit/grep/glob` resolve every path (symlinks included) within `AgentConfig.cwd` / `OrchestratorConfig.defaultCwd`, defaulting to `<cwd>/.agent-workspace`. `null` disables the sandbox; `process.cwd()` widens it. → [docs/tool-configuration.md](docs/tool-configuration.md)
- **Reasoning is dropped unless opted in** — provider-native `ReasoningBlock`s the target adapter can't echo are silently dropped unless `AgentConfig.preserveReasoningAsText` is on (then converted to inline `<thinking>` text). `<thinking>` text is never parsed back into a signed block. → [docs/context-management.md](docs/context-management.md)
- **Local-model tool-call fallback** — `text-tool-extractor.ts` only runs when the server emits no native `tool_calls` (Ollama/vLLM/LM Studio); native calls always win.
- **Secrets are auto-redacted** from traces, bash output, and dashboard payloads (`utils/redaction.ts`).

### Subsystem docs

Detailed behavior is documented in `docs/` — the single source of truth, so update it there rather than copying detail into this file:

| Topic | Code | Doc |
|-------|------|-----|
| Context strategies, summarization, reasoning round-tripping | `agent/runner.ts`, `llm/reasoning-fallback.ts` | [context-management.md](docs/context-management.md) |
| Tool presets, custom tools, sandbox, delegation, MCP | `tool/` | [tool-configuration.md](docs/tool-configuration.md) |
| Providers, env vars, local servers, AI SDK bridge | `llm/` | [providers.md](docs/providers.md) |
| Shared memory + custom backends | `memory/` | [shared-memory.md](docs/shared-memory.md) |
| Tracing, progress events, dashboard | `utils/trace.ts`, `dashboard/` | [observability.md](docs/observability.md) |
| CLI usage + JSON schemas | `cli/oma.ts` | [cli.md](docs/cli.md) |

### Adding an LLM Adapter

Implement `LLMAdapter` (`chat` + `stream`), add the provider name to the `SupportedProvider` union, then register a `case` in the `createAdapter()` factory in `src/llm/adapter.ts` using a dynamic `await import('./your-provider.js')` so the SDK loads only when that provider is requested. OpenAI-compatible providers should accept `baseURL` and reuse helpers from `openai-common.ts`.
