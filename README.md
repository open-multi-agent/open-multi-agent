<br />

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/JackChen-me/open-multi-agent/main/.github/brand/logo-mark-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/JackChen-me/open-multi-agent/main/.github/brand/logo-mark-light.svg">
    <img alt="Open Multi-Agent" src="https://raw.githubusercontent.com/JackChen-me/open-multi-agent/main/.github/brand/logo-mark-light.svg" width="96">
  </picture>
</p>

<br />

<h1 align="center">Open Multi-Agent</h1>

<p align="center">
  <strong>From a goal to a task DAG, automatically.</strong><br/>
  TypeScript-native multi-agent orchestration. Three runtime dependencies.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@jackchen_me/open-multi-agent"><img src="https://img.shields.io/npm/v/@jackchen_me/open-multi-agent" alt="npm version"></a>
  <a href="https://github.com/JackChen-me/open-multi-agent/actions/workflows/ci.yml"><img src="https://github.com/JackChen-me/open-multi-agent/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/JackChen-me/open-multi-agent" alt="license"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.6-blue" alt="TypeScript"></a>
  <a href="https://codecov.io/gh/JackChen-me/open-multi-agent"><img src="https://codecov.io/gh/JackChen-me/open-multi-agent/graph/badge.svg" alt="codecov"></a>
  <a href="https://github.com/JackChen-me/open-multi-agent/blob/main/package.json"><img src="https://img.shields.io/badge/runtime_deps-3-brightgreen" alt="runtime deps"></a>
  <a href="https://github.com/JackChen-me/open-multi-agent/stargazers"><img src="https://img.shields.io/github/stars/JackChen-me/open-multi-agent" alt="GitHub stars"></a>
  <a href="https://github.com/JackChen-me/open-multi-agent/network/members"><img src="https://img.shields.io/github/forks/JackChen-me/open-multi-agent" alt="GitHub forks"></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/JackChen-me/open-multi-agent/main/.github/brand/demo-dashboard-hero.gif" alt="Animated task DAG dashboard: coordinator decomposes a goal into tasks, executes them in parallel, and synthesizes the result — with token breakdown and agent output log" width="960" height="456" loading="eager">
</p>

<br />

<p align="center">
  <strong>English</strong> · <a href="./README_zh.md">中文</a>
</p>

<br />

`open-multi-agent` is a multi-agent orchestration framework for TypeScript backends. Give it a goal; a coordinator agent decomposes it into a task DAG, parallelizes independents, and synthesizes the result. Three runtime dependencies, drops into any Node.js backend.

> **Your engineers describe the goal, not the graph.**

## Quick Start

Requires Node.js >= 18.

### Use it in your project

```bash
npm install @jackchen_me/open-multi-agent
export ANTHROPIC_API_KEY=sk-...
```

```typescript
import { OpenMultiAgent, type AgentConfig } from '@jackchen_me/open-multi-agent'

const agents: AgentConfig[] = [
  { name: 'architect', model: 'claude-sonnet-4-6', systemPrompt: 'Design clean API contracts.', tools: ['file_write'] },
  { name: 'developer', model: 'claude-sonnet-4-6', systemPrompt: 'Implement runnable TypeScript.', tools: ['bash', 'file_read', 'file_write', 'file_edit'] },
  { name: 'reviewer', model: 'claude-sonnet-4-6', systemPrompt: 'Review correctness and security.', tools: ['file_read', 'grep'] },
]

const orchestrator = new OpenMultiAgent({
  defaultModel: 'claude-sonnet-4-6',
  onProgress: (event) => console.log(event.type, event.task ?? event.agent ?? ''),
})

const team = orchestrator.createTeam('api-team', { name: 'api-team', agents, sharedMemory: true })
const result = await orchestrator.runTeam(team, 'Create a REST API for a todo list in /tmp/todo-api/')

console.log(result.success, result.totalTokenUsage.output_tokens)
```

### Run an example locally

```bash
git clone https://github.com/JackChen-me/open-multi-agent && cd open-multi-agent
npm install
export ANTHROPIC_API_KEY=sk-...
npx tsx examples/basics/team-collaboration.ts
```

Three agents collaborate on a REST API while `onProgress` streams the coordinator's task DAG:

```
agent_start coordinator
task_start design-api
task_complete design-api
task_start implement-handlers
task_start scaffold-tests         // independent tasks run in parallel
task_complete scaffold-tests
task_complete implement-handlers
task_start review-code            // unblocked after implementation
task_complete review-code
agent_complete coordinator        // synthesizes final result
Success: true
Tokens: 12847 output tokens
```

Local models via Ollama need no API key, see [`providers/ollama`](examples/providers/ollama.ts). For hosted providers (`OPENAI_API_KEY`, `GEMINI_API_KEY`, etc.), see [Supported Providers](#supported-providers).

### Three Ways to Run

| Mode | Method | When to use | Example |
|------|--------|-------------|---------|
| Single agent | `runAgent()` | One agent, one prompt | [`basics/single-agent`](examples/basics/single-agent.ts) |
| Auto-orchestrated team | `runTeam()` | Give a goal, let the coordinator plan and execute | [`basics/team-collaboration`](examples/basics/team-collaboration.ts) |
| Explicit pipeline | `runTasks()` | You define the task graph and assignments | [`basics/task-pipeline`](examples/basics/task-pipeline.ts) |

Preview the coordinator's task DAG without executing agents:

```ts
const plan = await orchestrator.runTeam(team, goal, { planOnly: true })
```

For MapReduce-style fan-out without task dependencies, use `AgentPool.runParallel()` directly. See [`patterns/fan-out-aggregate`](examples/patterns/fan-out-aggregate.ts).

For shell and CI, use the JSON-first `oma` binary. See [docs/cli.md](./docs/cli.md).

## Features

| Capability | What you get |
|------------|--------------|
| **Goal-driven coordinator** | One `runTeam(team, goal)` call. The coordinator decomposes the goal into a task DAG, parallelizes independents, and synthesizes the result. |
| **Mix providers in one team** | 10 built-in: Anthropic, OpenAI, Azure, Bedrock, Gemini, Grok, DeepSeek, MiniMax, Qiniu, Copilot. Ollama / vLLM / LM Studio / OpenRouter / Groq via OpenAI-compatible. ([full setup](./docs/providers.md)) |
| **Tools + MCP** | 6 built-in (`bash`, `file_*`, `grep`, `glob`), opt-in `delegate_to_agent`, custom tools via `defineTool()` + Zod, stdio MCP servers via `connectMCPTools()`. ([tool config](./docs/tool-configuration.md)) |
| **Streaming + structured output** | Token-by-token streaming on every adapter; Zod-validated final answer with auto-retry on parse failure. ([`structured-output`](examples/patterns/structured-output.ts)) |
| **Observability** | `onProgress` events, `onTrace` spans, post-run HTML dashboard rendering the executed task DAG. ([observability guide](./docs/observability.md)) |
| **Pluggable shared memory** | Default in-process KV; swap in Redis / Postgres / your own backend by implementing `MemoryStore`. ([shared memory](./docs/shared-memory.md)) |

Production controls (context strategies, task retry with backoff, loop detection, tool output truncation/compression) are covered in the [Production Checklist](#production-checklist).

## Examples

[`examples/`](./examples/) is organized by category: basics, cookbook, patterns, providers, integrations, and production. See [`examples/README.md`](./examples/README.md) for the full index.

### Real-world workflows ([`cookbook/`](./examples/cookbook/))

End-to-end scenarios you can run today. Each one is a complete, opinionated workflow.

- [`contract-review-dag`](examples/cookbook/contract-review-dag.ts): four-task DAG for contract review with parallel branches and step-level retry on failure.
- [`meeting-summarizer`](examples/cookbook/meeting-summarizer.ts): three specialised agents fan out on a transcript, an aggregator merges them into one Markdown report with action items and sentiment.
- [`competitive-monitoring`](examples/cookbook/competitive-monitoring.ts): three parallel source agents extract claims from feeds; an aggregator cross-checks them and flags contradictions.
- [`translation-backtranslation`](examples/cookbook/translation-backtranslation.ts): translate EN to target with one provider, back-translate with another, flag semantic drift.

### Patterns and integrations

- [`basics/team-collaboration`](examples/basics/team-collaboration.ts): `runTeam()` coordinator pattern.
- [`patterns/structured-output`](examples/patterns/structured-output.ts): any agent returns Zod-validated JSON.
- [`patterns/fan-out-aggregate`](examples/patterns/fan-out-aggregate.ts): MapReduce-style fan-out via `AgentPool.runParallel()`.
- [`patterns/agent-handoff`](examples/patterns/agent-handoff.ts): synchronous sub-agent delegation via `delegate_to_agent`.
- [`integrations/trace-observability`](examples/integrations/trace-observability.ts): `onTrace` spans for LLM calls, tools, and tasks.
- [`integrations/mcp-github`](examples/integrations/mcp-github.ts): expose an MCP server's tools to an agent via `connectMCPTools()`.
- [`integrations/with-vercel-ai-sdk`](examples/integrations/with-vercel-ai-sdk/): Next.js app combining OMA `runTeam()` with AI SDK `useChat` streaming.
- **Provider examples**: scripts under [`examples/providers/`](examples/providers/) covering hosted providers, OpenAI-compatible endpoints, and local models.

Run any script with `npx tsx examples/<path>.ts`.

## How is this different from X?

A quick router. Mechanism breakdown follows.

| If you need | Pick |
|-------------|------|
| Fixed production topology with mature checkpointing | LangGraph JS |
| Explicit Supervisor + hand-wired workflows | Mastra |
| Python stack with mature multi-agent ecosystem | CrewAI |
| AI app toolkit with broad model-provider support | Vercel AI SDK |
| **TypeScript, goal to result with auto task decomposition** | **open-multi-agent** |

**vs. LangGraph JS.** LangGraph compiles a declarative graph (nodes, edges, conditional routing) into an invokable. `open-multi-agent` runs a Coordinator that decomposes the goal into a task DAG at runtime, then auto-parallelizes independents. Same end (orchestrated execution), opposite directions: LangGraph is graph-first, OMA is goal-first.

**vs. Mastra.** Both are TypeScript-native. Mastra's Supervisor pattern requires you to wire agents and workflows by hand; OMA's Coordinator does the wiring at runtime from the goal string. If the workflow is known up front, Mastra's explicitness pays off. If you'd rather not enumerate every step, OMA's `runTeam(team, goal)` is one call.

**vs. CrewAI.** CrewAI is the mature multi-agent option in Python. OMA targets TypeScript backends with three runtime dependencies and direct Node.js embedding. Roughly comparable orchestration surface; the choice is the language stack.

**vs. Vercel AI SDK.** AI SDK provides the LLM-call layer — provider abstraction, streaming, tool calls, and structured outputs. It does not orchestrate goal-driven multi-agent teams. The two are complementary: AI SDK for app surfaces and single-agent calls, OMA when you need a team.

## Ecosystem

`open-multi-agent` launched 2026-04-01 under MIT. Known users and integrations to date:

### In production

- **[temodar-agent](https://github.com/xeloxa/temodar-agent)** (~60 stars). WordPress security analysis platform by [Ali Sünbül](https://github.com/xeloxa). Uses our built-in tools (`bash`, `file_*`, `grep`) directly inside a Docker runtime. Confirmed production use.
- **Cybersecurity SOC (home lab).** A private setup running Qwen 2.5 + DeepSeek Coder entirely offline via Ollama, building an autonomous SOC pipeline on Wazuh + Proxmox. Early user, not yet public.

Using `open-multi-agent` in production or a side project? [Open a discussion](https://github.com/JackChen-me/open-multi-agent/discussions) and we will list it here.

### Integrations

- **[Engram](https://www.engram-memory.com)** — "Git for AI memory." Syncs knowledge across agents instantly and flags conflicts. ([repo](https://github.com/Agentscreator/engram-memory))
- **[@agentsonar/oma](https://github.com/agentsonar/agentsonar-oma)** — Sidecar detecting cross-run delegation cycles, repetition, and rate bursts.

Built an integration? [Open a discussion](https://github.com/JackChen-me/open-multi-agent/discussions) to get listed.

### Featured partner

For products and platforms with a deep `open-multi-agent` integration. See the [Featured partner program](./docs/featured-partner.md) for terms and how to apply.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  OpenMultiAgent (Orchestrator)                                  │
│                                                                 │
│  createTeam()  runTeam()  runTasks()  runAgent()  getStatus()   │
└──────────────────────┬──────────────────────────────────────────┘
                       │
            ┌──────────▼──────────┐
            │  Team               │
            │  - AgentConfig[]    │
            │  - MessageBus       │
            │  - TaskQueue        │
            │  - SharedMemory     │
            └──────────┬──────────┘
                       │
         ┌─────────────┴─────────────┐
         │                           │
┌────────▼──────────┐    ┌───────────▼───────────┐
│  AgentPool        │    │  TaskQueue             │
│  - Semaphore      │    │  - dependency graph    │
│  - runParallel()  │    │  - auto unblock        │
└────────┬──────────┘    │  - cascade failure     │
         │               └───────────────────────┘
┌────────▼──────────┐
│  Agent            │
│  - run()          │    ┌────────────────────────┐
│  - prompt()       │───►│  LLMAdapter            │
│  - stream()       │    │  - AnthropicAdapter    │
└────────┬──────────┘    │  - OpenAIAdapter       │
         │               │  - AzureOpenAIAdapter  │
         │               │  - BedrockAdapter      │
         │               │  - CopilotAdapter      │
         │               │  - GeminiAdapter       │
         │               │  - GrokAdapter         │
         │               │  - MiniMaxAdapter      │
         │               │  - DeepSeekAdapter     │
         │               │  - QiniuAdapter        │
         │               └────────────────────────┘
┌────────▼──────────┐
│  AgentRunner      │    ┌──────────────────────┐
│  - conversation   │───►│  ToolRegistry        │
│    loop           │    │  - defineTool()      │
│  - tool dispatch  │    │  - 6 built-in tools  │
└───────────────────┘    │  + delegate (opt-in) │
                         └──────────────────────┘
```

## Core Concepts

- **Tools + MCP.** Built-ins cover `bash`, `file_read`, `file_write`, `file_edit`, `grep`, and `glob`; custom tools use `defineTool()` + Zod; stdio MCP servers connect through `connectMCPTools()`. See [tool configuration](./docs/tool-configuration.md).
- **Observability.** Wire `onProgress` for live lifecycle events, `onTrace` for structured spans, and `renderTeamRunDashboard(result)` for a static DAG dashboard. See [observability](./docs/observability.md).
- **Shared memory.** Use the default in-process KV or bring Redis, Postgres, Engram, or any `MemoryStore`. See [shared memory](./docs/shared-memory.md).
- **Context management.** Use sliding windows, summarization, rule-based compaction, or a custom compressor for long-running agents. See [context management](./docs/context-management.md).

## Supported Providers

Change `provider`, `model`, and set the env var. The agent config shape stays the same.

```typescript
const agent: AgentConfig = {
  name: 'my-agent',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  systemPrompt: 'You are a helpful assistant.',
}
```

| Kind | How to configure | Services |
|------|------------------|----------|
| Built-in shortcuts | Set `provider` to `anthropic`, `gemini`, `openai`, `azure-openai`, `copilot`, `grok`, `deepseek`, `minimax`, `qiniu`, or `bedrock`; the framework supplies the endpoint. | Anthropic, Gemini, OpenAI, Azure OpenAI, GitHub Copilot, xAI Grok, DeepSeek, MiniMax, Qiniu, AWS Bedrock |
| OpenAI-compatible endpoints | Set `provider: 'openai'` plus `baseURL` and, when needed, `apiKey`. | Ollama, vLLM, LM Studio, llama.cpp server, OpenRouter, Groq, Mistral |

See [docs/providers.md](./docs/providers.md) for env vars, model examples, local tool-calling, timeouts, and troubleshooting.

## Production Checklist

Before going live, wire up the controls that protect token spend, recover from failure, and let you debug.

| Concern | Knob | Where it lives |
|---------|------|----------------|
| Bound the conversation | `maxTurns` per agent + `contextStrategy` (`sliding-window` / `summarize` / `compact` / `custom`) | `AgentConfig` |
| Cap tool output | `maxToolOutputChars` (or per-tool `maxOutputChars`) + `compressToolResults: true` | `AgentConfig` and `defineTool()` |
| Recover from failure | Per-task `maxRetries`, `retryDelayMs`, `retryBackoff` (exponential multiplier) | Task config used via `runTasks()` |
| Hard-cap spend | `maxTokenBudget` on the orchestrator | `OrchestratorConfig` |
| Catch stuck agents | `loopDetection` with `onLoopDetected: 'terminate'` (or a custom handler) | `AgentConfig` |
| Trace and audit | `onTrace` to your tracing backend; persist `renderTeamRunDashboard(result)` | `OrchestratorConfig` |

## Contributing

Issues, feature requests, and PRs are welcome. Some areas where contributions would be especially valuable:

- **Production examples.** Real-world end-to-end workflows. See [`examples/production/README.md`](./examples/production/README.md) for the acceptance criteria and submission format.
- **Documentation.** Guides, tutorials, and API docs.
- **Translations.** Help translate this README into other languages. [Open a PR](https://github.com/JackChen-me/open-multi-agent/pulls).

## Contributors

<a href="https://github.com/JackChen-me/open-multi-agent/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=JackChen-me/open-multi-agent&max=100&v=20260507" />
</a>

<details>
<summary>Contributor credits by area</summary>

**Framework features**

- [@ibrahimkzmv](https://github.com/ibrahimkzmv) (token budget, context strategy, dependency-scoped context, tool presets, glob, MCP integration, configurable coordinator, CLI, dashboard rendering, trace event types)
- [@apollo-mg](https://github.com/apollo-mg) (context compaction fix, sampling parameters)
- [@tizerluo](https://github.com/tizerluo) (onPlanReady, onAgentStream)
- [@CodingBangboo](https://github.com/CodingBangboo) (planOnly mode)
- [@Xin-Mai](https://github.com/Xin-Mai) (output schema validation)
- [@JasonOA888](https://github.com/JasonOA888) (AbortSignal support)
- [@EchoOfZion](https://github.com/EchoOfZion) (coordinator skip for simple goals)
- [@voidborne-d](https://github.com/voidborne-d) (OpenAI mixed content fix)
- [@NamelessNATM](https://github.com/NamelessNATM) (agent delegation base implementation)
- [@MyPrototypeWhat](https://github.com/MyPrototypeWhat) (reasoning blocks, reasoning_effort, sampling parity, trace input/output)
- [@SiMinus](https://github.com/SiMinus) (streaming reasoning events)

**Provider integrations**

- [@ibrahimkzmv](https://github.com/ibrahimkzmv) (Gemini)
- [@hkalex](https://github.com/hkalex) (DeepSeek, MiniMax)
- [@marceloceccon](https://github.com/marceloceccon) (Grok)
- [@Klarline](https://github.com/Klarline) (Azure OpenAI)
- [@Deathwing](https://github.com/Deathwing) (GitHub Copilot)
- [@JackChiang233](https://github.com/JackChiang233) (Qiniu)
- [@CodingBangboo](https://github.com/CodingBangboo) (AWS Bedrock)

**Examples & cookbook**

- [@mvanhorn](https://github.com/mvanhorn) (research aggregation, code review, meeting summarizer, Groq example, Mistral example)
- [@Kinoo0](https://github.com/Kinoo0) (code review upgrade)
- [@Optimisttt](https://github.com/Optimisttt) (research aggregation upgrade)
- [@Agentscreator](https://github.com/Agentscreator) (Engram memory integration)
- [@fault-segment](https://github.com/fault-segment) (contract-review DAG)
- [@HuXiangyu123](https://github.com/HuXiangyu123) (cost-tiered example)
- [@zouhh22333-beep](https://github.com/zouhh22333-beep) (translation/backtranslation)
- [@pei-pei45](https://github.com/pei-pei45) (competitive monitoring)
- [@mmjwxbc](https://github.com/mmjwxbc) (interview simulator)
- [@binghuaren96](https://github.com/binghuaren96) (incident postmortem DAG)
- [@DaiMao-UT](https://github.com/DaiMao-UT) (paper replication triage)
- [@oooooowoooooo](https://github.com/oooooowoooooo) (rare disease information triage)
- [@CodingBangboo](https://github.com/CodingBangboo) (Express customer support pipeline)

**Docs & tests**

- [@tmchow](https://github.com/tmchow) (llama.cpp docs)
- [@kenrogers](https://github.com/kenrogers) (OpenRouter docs)
- [@jadegold55](https://github.com/jadegold55) (LLM adapter test coverage)

</details>

## Star History

<a href="https://star-history.com/#JackChen-me/open-multi-agent&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=JackChen-me/open-multi-agent&type=Date&theme=dark&v=20260425" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=JackChen-me/open-multi-agent&type=Date&v=20260425" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=JackChen-me/open-multi-agent&type=Date&v=20260425" />
 </picture>
</a>

## License

MIT
