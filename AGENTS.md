# AGENTS.md

## Commands

```bash
npm run build          # tsc, src/ → dist/
npm run dev            # tsc --watch
npm run lint           # tsc --noEmit (type-check only, NOT a linter)
npm test               # vitest run
npm run test:watch     # vitest
```

CI gate: `npm run lint && npm test` — must pass on Node 18, 20, 22.

Run a single test file: `npx vitest run tests/task-queue.test.ts`

## Key Facts

- **ES modules only** — `"type": "module"` in package.json. All local imports use `.js` extensions despite writing `.ts` files.
- **`npm run lint` is type-check, not ESLint.** No linter or formatter is configured. Follow existing patterns.
- **Strict TypeScript** (`strict: true`), but `noUnusedLocals` and `noUnusedParameters` are intentionally `false`.
- **3 runtime deps only** (`@anthropic-ai/sdk`, `openai`, `zod`). Do not add runtime dependencies without strong justification — see `DECISIONS.md` for the project's minimal-dependency philosophy.
- **Optional `redis` peer dependency** — only needed when using `RedisStore`. Not installing it has zero impact on core functionality.
- **Storage is pluggable** — `KVStore` (low-level) and `MessageStore` (messages) are injectable via `TeamConfig.store` / `TeamConfig.messageStore`. Defaults are in-memory.
- **Tests require no API keys or network.** They exercise core modules (TaskQueue, SharedMemory, ToolExecutor, Semaphore) in pure unit-test fashion. Examples in `examples/` are the ones needing `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `XAI_API_KEY`.
- **`tsconfig.json` excludes `tests/` and `examples/`** from the build. Tests import directly from `../src/*.js`.

## Architecture Quick Reference

Top-level API: `OpenMultiAgent` (`src/orchestrator/orchestrator.ts`)

- `runAgent(config, prompt)` — single agent, one-shot
- `runTeam(team, goal)` — coordinator agent decomposes goal → task DAG → parallel execution
- `runTasks(team, tasks)` — explicit user-defined task pipeline

All public types live in `src/types.ts` (single file to avoid circular deps). Public surface exported from `src/index.ts`.

### Directory Map

| Dir | Purpose |
|-----|---------|
| `src/orchestrator/` | Top-level API, coordinator pattern, scheduler, retry logic |
| `src/agent/` | Agent lifecycle, conversation loop (`runner.ts`), pool (`pool.ts`), structured output |
| `src/team/` | Agent roster, MessageBus, SharedMemory binding |
| `src/task/` | Dependency-aware TaskQueue, task creation helpers |
| `src/tool/` | `defineTool()` + Zod schemas, ToolRegistry, parallel batch executor, built-in tools |
| `src/llm/` | LLMAdapter interface + lazy-loaded adapters (anthropic, openai, grok, copilot) |
| `src/memory/` | Namespaced key-value store, markdown summary injection |
| `src/utils/` | Semaphore, trace/observability utilities |

### Adding an LLM Adapter

Implement `LLMAdapter` (`chat` + `stream`), add to `SupportedProvider` union and `createAdapter()` switch in `src/llm/adapter.ts`. Adapters are lazy-imported.

## Conventions

- No comments unless asked — existing codebase uses JSDoc on public APIs only.
- PRs target `main`.
- See `DECISIONS.md` for features deliberately excluded (agent handoffs, persistence, A2A, MCP, dashboard). Do not implement these without prior discussion.
