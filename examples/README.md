# Examples

Runnable scripts demonstrating `open-multi-agent`. Organized by category — pick one that matches what you're trying to do.

All scripts run with `npx tsx examples/<category>/<name>.ts` and require the corresponding API key in your environment.

---

## basics — start here

The four core execution modes. Read these first.

| Example | What it shows |
|---------|---------------|
| [`basics/single-agent`](basics/single-agent.ts) | One agent with bash + file tools, then streaming via the `Agent` class. |
| [`basics/team-collaboration`](basics/team-collaboration.ts) | `runTeam()` coordinator pattern — goal in, results out. |
| [`basics/task-pipeline`](basics/task-pipeline.ts) | `runTasks()` with explicit task DAG and dependencies. |
| [`basics/multi-model-team`](basics/multi-model-team.ts) | Different models per agent in one team. |

## providers — model & adapter examples

One example per supported provider. All follow the same three-agent (architect / developer / reviewer) shape so they're easy to compare.

| Example | Provider | Env var |
|---------|----------|---------|
| [`providers/ollama`](providers/ollama.ts) | Ollama (local) + Claude | `ANTHROPIC_API_KEY` |
| [`providers/gemma4-local`](providers/gemma4-local.ts) | Gemma 4 via Ollama (100% local) | — |
| [`providers/copilot`](providers/copilot.ts) | GitHub Copilot (GPT-4o + Claude) | `GITHUB_TOKEN` |
| [`providers/grok`](providers/grok.ts) | xAI Grok | `XAI_API_KEY` |
| [`providers/gemini`](providers/gemini.ts) | Google Gemini | `GEMINI_API_KEY` |
| [`providers/minimax`](providers/minimax.ts) | MiniMax M2.7 | `MINIMAX_API_KEY` |
| [`providers/deepseek`](providers/deepseek.ts) | DeepSeek Chat | `DEEPSEEK_API_KEY` |
| [`providers/groq`](providers/groq.ts) | Groq (OpenAI-compatible) | `GROQ_API_KEY` |

## patterns — orchestration patterns

Reusable shapes for common multi-agent problems.

| Example | Pattern |
|---------|---------|
| [`patterns/fan-out-aggregate`](patterns/fan-out-aggregate.ts) | MapReduce-style fan-out via `AgentPool.runParallel()`. |
| [`patterns/structured-output`](patterns/structured-output.ts) | Zod-validated JSON output from an agent. |
| [`patterns/task-retry`](patterns/task-retry.ts) | Per-task retry with exponential backoff. |
| [`patterns/multi-perspective-code-review`](patterns/multi-perspective-code-review.ts) | Multiple reviewer agents in parallel, then synthesis. |
| [`patterns/research-aggregation`](patterns/research-aggregation.ts) | Multi-source research collated by a synthesis agent. |
| [`patterns/agent-handoff`](patterns/agent-handoff.ts) | Synchronous sub-agent delegation via `delegate_to_agent`. |
| [`patterns/meeting-summarizer`](patterns/meeting-summarizer.ts) | Fan-out post-processing of a transcript into summary, structured action items, and sentiment. |

## integrations — external systems

Hooking the framework up to outside-the-box tooling.

| Example | Integrates with |
|---------|-----------------|
| [`integrations/trace-observability`](integrations/trace-observability.ts) | `onTrace` spans for LLM calls, tools, and tasks. |
| [`integrations/mcp-github`](integrations/mcp-github.ts) | An MCP server's tools exposed to an agent via `connectMCPTools()`. |
| [`integrations/with-vercel-ai-sdk/`](integrations/with-vercel-ai-sdk/) | Next.js app — OMA `runTeam()` + AI SDK `useChat` streaming. |

## production — real-world use cases

End-to-end examples wired to real workflows. Higher bar than the categories above. See [`production/README.md`](production/README.md) for the acceptance criteria and how to contribute.

---

## Adding a new example

| You're adding… | Goes in… | Filename |
|----------------|----------|----------|
| A new model provider | `providers/` | `<provider-name>.ts` (lowercase, hyphenated) |
| A reusable orchestration pattern | `patterns/` | `<pattern-name>.ts` |
| Integration with an outside system (MCP server, observability backend, framework, app) | `integrations/` | `<system>.ts` or `<system>/` for multi-file |
| A real-world end-to-end use case | `production/` | `<use-case>/` directory with its own README |

Conventions:

- **No numeric prefixes.** Folders signal category; reading order is set by this README.
- **File header docstring** with one-line title, `Run:` block, and prerequisites.
- **Imports** should resolve as `from '../../src/index.js'` (one level deeper than the old flat layout).
- **Match the provider template** when adding a provider: three-agent team (architect / developer / reviewer) building a small REST API. Keeps comparisons honest.
- **Add a row** to the table in this file for the corresponding category.
