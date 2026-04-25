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
| [`providers/local-quantized`](providers/local-quantized.ts) | Quantized MoE on vLLM / llama-server with tuned sampling (`topK` / `minP` / `frequencyPenalty` / `parallelToolCalls` / `extraBody.repetition_penalty`) | — |
| [`providers/copilot`](providers/copilot.ts) | GitHub Copilot (GPT-4o + Claude) | `GITHUB_TOKEN` |
| [`providers/azure-openai`](providers/azure-openai.ts) | Azure OpenAI | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT` (+ optional `AZURE_OPENAI_API_VERSION`, `AZURE_OPENAI_DEPLOYMENT`) |
| [`providers/grok`](providers/grok.ts) | xAI Grok | `XAI_API_KEY` |
| [`providers/gemini`](providers/gemini.ts) | Google Gemini | `GEMINI_API_KEY` |
| [`providers/minimax`](providers/minimax.ts) | MiniMax M2.7 | `MINIMAX_API_KEY` |
| [`providers/deepseek`](providers/deepseek.ts) | DeepSeek Chat | `DEEPSEEK_API_KEY` |
| [`providers/openrouter`](providers/openrouter.ts) | OpenRouter (OpenAI-compatible) | `OPENROUTER_API_KEY` |
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
| [`patterns/cost-tiered-pipeline`](patterns/cost-tiered-pipeline.ts) | Run the same four-stage pipeline twice to compare flagship vs tiered model cost. |
| [`patterns/agent-handoff`](patterns/agent-handoff.ts) | Synchronous sub-agent delegation via `delegate_to_agent`. |

## cookbook — use-case recipes

End-to-end examples framed around a concrete problem (meeting summarization, translation QA, competitive monitoring, etc.) rather than a single orchestration primitive. Lighter bar than `production/`: no tests or pinned model versions required. Good entry point if you want to see how the patterns compose on a real task.

| Example | Problem solved |
|---------|----------------|
| [`cookbook/meeting-summarizer`](cookbook/meeting-summarizer.ts) | Fan-out post-processing of a transcript into summary, structured action items, and sentiment. |
| [`cookbook/contract-review-dag`](cookbook/contract-review-dag.ts) | 4-task DAG (extract → compliance-check + summary → notify) with step-level retry. Run normally or with `FORCE_FAIL=task2` to exercise retry. |
| [`cookbook/competitive-monitoring`](cookbook/competitive-monitoring.ts) | Parallel source monitoring (Twitter/Reddit/News), contradiction detection, and aggregated intelligence reporting. |

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
| A use-case-driven example (problem-first, uses one or more patterns) | `cookbook/` | `<use-case>.ts` |
| Integration with an outside system (MCP server, observability backend, framework, app) | `integrations/` | `<system>.ts` or `<system>/` for multi-file |
| A real-world end-to-end use case, production-grade | `production/` | `<use-case>/` directory with its own README |

Conventions:

- **No numeric prefixes.** Folders signal category; reading order is set by this README.
- **File header docstring** with one-line title, `Run:` block, and prerequisites.
- **Imports** should resolve as `from '../../src/index.js'` (one level deeper than the old flat layout).
- **Match the provider template** when adding a provider: three-agent team (architect / developer / reviewer) building a small REST API. Keeps comparisons honest.
- **Add a row** to the table in this file for the corresponding category.
