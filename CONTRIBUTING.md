# Contributing

Thanks for your interest in contributing to Open Multi-Agent! This guide covers the basics to get you started.

## Setup

```bash
git clone https://github.com/JackChen-me/open-multi-agent.git
cd open-multi-agent
npm install
```

Requires Node.js >= 18.

## Development Commands

```bash
npm run build        # Compile TypeScript (src/ → dist/)
npm run dev          # Watch mode compilation
npm run lint         # Type-check (tsc --noEmit)
npm test             # Run all tests (vitest)
npm run test:watch   # Vitest watch mode
```

## Running Tests

All tests live in `tests/`. They test core modules (TaskQueue, SharedMemory, ToolExecutor, Semaphore) without requiring API keys or network access.

```bash
npm test
```

Every PR must pass `npm run lint && npm test`. CI runs both automatically on Node 18, 20, and 22.

## Making a Pull Request

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Add or update tests if you changed behavior
4. Run `npm run lint && npm test` locally
5. Open a PR against `main`

### PR Checklist

- [ ] `npm run lint` passes
- [ ] `npm test` passes
- [ ] New behavior has test coverage
- [ ] Linked to a relevant issue (if one exists)

## Code Style

- TypeScript strict mode, ES modules (`.js` extensions in imports)
- No additional linter/formatter configured — follow existing patterns
- Keep dependencies minimal (currently 3 runtime deps: `@anthropic-ai/sdk`, `openai`, `zod`)

## Architecture Overview

See the [README](./README.md#architecture) for an architecture diagram. Key entry points:

- **Orchestrator**: `src/orchestrator/orchestrator.ts` — top-level API
- **Task system**: `src/task/queue.ts`, `src/task/task.ts` — dependency DAG
- **Agent**: `src/agent/runner.ts` — conversation loop
- **Tools**: `src/tool/framework.ts`, `src/tool/executor.ts` — tool registry and execution
- **LLM adapters**: `src/llm/` — Anthropic, OpenAI, Copilot

## Where to Contribute

Check the [issues](https://github.com/JackChen-me/open-multi-agent/issues) page. Issues labeled `good first issue` are scoped and approachable. Issues labeled `help wanted` are larger but well-defined.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
