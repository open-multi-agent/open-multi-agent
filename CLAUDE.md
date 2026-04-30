# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

Tests live in `tests/` (vitest); E2E suite under `tests/e2e/`. Examples in `examples/` are standalone scripts requiring API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.) and are organized by intent: `basics/`, `cookbook/`, `patterns/`, `providers/`, `integrations/`, `production/`, with shared `fixtures/`. CLI usage and JSON schemas: `docs/cli.md`.

## Architecture

ES module TypeScript framework for multi-agent orchestration. Three runtime dependencies: `@anthropic-ai/sdk`, `openai`, `zod`. Optional peer deps `@google/genai` (Gemini) and `@modelcontextprotocol/sdk` (MCP) are loaded lazily so users only install what they use; the three-dependency promise covers `dependencies` only.

### Core Execution Flow

**`OpenMultiAgent`** (`src/orchestrator/orchestrator.ts`) is the top-level public API with three execution modes:

1. **`runAgent(config, prompt)`** — single agent, one-shot
2. **`runTeam(team, goal)`** — automatic orchestration: a temporary "coordinator" agent decomposes the goal into a task DAG via LLM call, then tasks execute in dependency order
3. **`runTasks(team, tasks)`** — explicit task pipeline with user-defined dependencies

### The Coordinator Pattern (runTeam)

This is the framework's key feature. When `runTeam()` is called:
1. A coordinator agent receives the goal + agent roster and produces a JSON task array (title, description, assignee, dependsOn)
2. `TaskQueue` resolves dependencies topologically — independent tasks run in parallel, dependent tasks wait
3. `Scheduler` auto-assigns any unassigned tasks (strategies: `dependency-first` default, `round-robin`, `least-busy`, `capability-match`)
4. Each task result is written to `SharedMemory` so subsequent agents see prior results
5. The coordinator synthesizes all task results into a final output

### Layer Map

| Layer | Files | Responsibility |
|-------|-------|----------------|
| Orchestrator | `orchestrator/orchestrator.ts`, `orchestrator/scheduler.ts` | Top-level API, task decomposition, coordinator pattern |
| Team | `team/team.ts`, `team/messaging.ts` | Agent roster, MessageBus (point-to-point + broadcast), SharedMemory binding |
| Agent | `agent/agent.ts`, `agent/runner.ts`, `agent/pool.ts`, `agent/structured-output.ts`, `agent/loop-detector.ts` | Agent lifecycle (idle→running→completed/error), conversation loop, concurrency pool with Semaphore, structured output validation, sliding-window loop detection |
| Task | `task/queue.ts`, `task/task.ts` | Dependency-aware queue, auto-unblock on completion, cascade failure to dependents |
| Tool | `tool/framework.ts`, `tool/executor.ts`, `tool/mcp.ts`, `tool/text-tool-extractor.ts`, `tool/built-in/` | `defineTool()` with Zod schemas, ToolRegistry, parallel batch execution with concurrency semaphore, MCP integration, fallback text-format tool-call extraction for local models |
| LLM | `llm/adapter.ts` + per-provider files (`anthropic`, `openai`, `azure-openai`, `bedrock`, `gemini`, `grok`, `deepseek`, `minimax`, `qiniu`, `copilot`) + `openai-common.ts` | `LLMAdapter` interface (`chat` + `stream`); async `createAdapter()` factory imports the chosen adapter lazily so unused SDKs aren't loaded; `baseURL` parameter targets OpenAI-compatible servers (Ollama, vLLM, LM Studio) |
| Memory | `memory/shared.ts`, `memory/store.ts` | Namespaced key-value store (`agentName/key`), markdown summary injection into prompts. Custom backends via `TeamConfig.sharedMemoryStore` (any `MemoryStore` impl); `sharedMemory: true` uses the default in-process store |
| Dashboard | `dashboard/render-team-run-dashboard.ts`, `dashboard/layout-tasks.ts` | Pure HTML renderer for the post-run team task DAG (no I/O) |
| CLI | `cli/oma.ts` | Shell/CI entry; built to `dist/cli/oma.js` and exposed as the `oma` npm bin |
| Utils | `utils/semaphore.ts`, `utils/tokens.ts`, `utils/keywords.ts`, `utils/trace.ts` | Concurrency primitive, token accounting, keyword helpers, trace plumbing |
| Errors | `errors.ts` | Shared error types |
| Types | `types.ts` | All interfaces in one file to avoid circular deps |
| Exports | `index.ts` (root, `'open-multi-agent'`), `mcp.ts` (subpath, `'open-multi-agent/mcp'`) | Public API surface; MCP integration is a separate entry point so non-MCP users don't pay the import cost |

### Agent Conversation Loop (AgentRunner)

`AgentRunner.run()`: send messages → extract tool-use blocks → execute tools in parallel batch → append results → loop until `end_turn` or `maxTurns` exhausted. Accumulates `TokenUsage` across all turns.

### Concurrency Control

Three semaphore layers: `AgentPool` pool-level (max concurrent agent runs, default 5), `AgentPool` per-agent mutex (serializes concurrent runs on the same `Agent` instance), and `ToolExecutor` (max concurrent tool calls, default 4).

### Structured Output

Optional `outputSchema` (Zod) on `AgentConfig`. When set, the agent's final output is parsed as JSON and validated. On validation failure, one retry with error feedback is attempted. Validated data is available via `result.structured`. Logic lives in `agent/structured-output.ts`, wired into `Agent.executeRun()`.

### Task Retry

Optional `maxRetries`, `retryDelayMs`, `retryBackoff` on task config (used via `runTasks()`). `executeWithRetry()` in `orchestrator.ts` handles the retry loop with exponential backoff (capped at 30s). Token usage is accumulated across all attempts. Emits `task_retry` event via `onProgress`.

### Error Handling

- Tool errors → caught, returned as `ToolResult(isError: true)`, never thrown
- Task failures → retry if `maxRetries > 0`, then cascade to all dependents; independent tasks continue
- LLM API errors → propagate to caller

### Built-in Tools

`bash`, `file_read`, `file_write`, `file_edit`, `grep`, `glob` — registered via `registerBuiltInTools(registry)`. `grep` and `glob` share a recursive directory walker in `tool/built-in/fs-walk.ts` (with a `SKIP_DIRS` set for `.git`, `node_modules`, `dist`, etc.) so their filtering rules stay consistent. `delegate_to_agent` is opt-in (`registerBuiltInTools(registry, { includeDelegateTool: true })`) and only wired up inside pool workers by `runTeam`/`runTasks` — see "Agent Delegation" below.

### Local Model Support

`tool/text-tool-extractor.ts` is a safety-net fallback for OpenAI-compatible local servers (Ollama thinking-model bug, vLLM, LM Studio) that emit tool calls as plain text instead of native `tool_calls` blocks. It recognises raw JSON, markdown-fenced JSON, Hermes-style `<tool_call>` tags, and JSON leaked inside unclosed `<think>` tags. Native `tool_calls` from the server always win; this only runs when none are present.

### MCP Integration

`connectMCPTools()` (in `tool/mcp.ts`) bridges Model Context Protocol servers into the `ToolRegistry`. Imported lazily and exposed via the dedicated `open-multi-agent/mcp` package subpath (`src/mcp.ts`) so users who don't need MCP don't load `@modelcontextprotocol/sdk`.

### Loop Detection

Optional `LoopDetectionConfig` on the agent runner triggers `agent/loop-detector.ts`, a sliding-window detector that hashes tool-call signatures (with sorted JSON keys) and text outputs to catch agents stuck repeating the same actions across turns.

### Agent Delegation

`delegate_to_agent` (in `src/tool/built-in/delegate.ts`) lets an agent synchronously hand a sub-prompt to another roster agent and receive its final output as a tool result. Only active during orchestrated runs; standalone `runAgent` and the `runTeam` short-circuit path (`isSimpleGoal` hit) do not inject it.

Guards (all enforced in the tool itself, before `runDelegatedAgent` is called):

- **Self-delegation:** rejected (`target === context.agent.name`)
- **Unknown agent:** rejected (target not in team roster)
- **Cycle detection:** rejected if target already in `TeamInfo.delegationChain` (prevents `A → B → A` from burning tokens up to the depth cap)
- **Depth cap:** `OrchestratorConfig.maxDelegationDepth` (default 3)
- **Pool deadlock:** rejected when `AgentPool.availableRunSlots < 1`, without calling the pool

The delegated run's `AgentRunResult.tokenUsage` is surfaced via `ToolResult.metadata.tokenUsage`; the runner accumulates it into `totalUsage` before the next `maxTokenBudget` check, so delegation cannot silently bypass the parent's budget. Delegation tool_result blocks are exempt from `compressToolResults` and the `compact` context strategy so the parent agent retains the full sub-agent output across turns. Best-effort SharedMemory audit writes at `{caller}/delegation:{target}:{timestamp}-{rand}` if the team has shared memory enabled.

### Adding an LLM Adapter

Implement `LLMAdapter` interface with `chat(messages, options)` and `stream(messages, options)`, add the provider name to the `SupportedProvider` union, then register a new `case` in the `createAdapter()` factory in `src/llm/adapter.ts`. Use a dynamic `await import('./your-provider.js')` so the SDK only loads when that provider is requested. OpenAI-compatible providers should accept the `baseURL` parameter and reuse helpers from `openai-common.ts`.
