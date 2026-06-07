<br />

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/open-multi-agent/open-multi-agent/main/.github/brand/logo-mark-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/open-multi-agent/open-multi-agent/main/.github/brand/logo-mark-light.svg">
    <img alt="Open Multi-Agent" src="https://raw.githubusercontent.com/open-multi-agent/open-multi-agent/main/.github/brand/logo-mark-light.svg" width="96">
  </picture>
</p>

<br />

<h1 align="center">Open Multi-Agent</h1>

<p align="center">
  <strong>From a goal to a task DAG, automatically.</strong><br/>
  TypeScript-native multi-agent orchestration. Three runtime dependencies.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@open-multi-agent/core"><img src="https://img.shields.io/npm/v/@open-multi-agent/core" alt="npm version"></a>
  <a href="https://github.com/open-multi-agent/open-multi-agent/actions/workflows/ci.yml"><img src="https://github.com/open-multi-agent/open-multi-agent/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.6-blue" alt="TypeScript"></a>
  <a href="https://codecov.io/gh/open-multi-agent/open-multi-agent"><img src="https://codecov.io/gh/open-multi-agent/open-multi-agent/graph/badge.svg" alt="codecov"></a>
  <a href="https://github.com/open-multi-agent/open-multi-agent/blob/main/package.json"><img src="https://img.shields.io/badge/runtime_deps-3-brightgreen" alt="runtime deps"></a>
  <a href="https://github.com/open-multi-agent/open-multi-agent/stargazers"><img src="https://img.shields.io/github/stars/open-multi-agent/open-multi-agent" alt="GitHub stars"></a>
  <a href="https://github.com/open-multi-agent/open-multi-agent/network/members"><img src="https://img.shields.io/github/forks/open-multi-agent/open-multi-agent" alt="GitHub forks"></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/open-multi-agent/open-multi-agent/main/.github/brand/demo-dashboard-hero.gif" alt="Post-run dashboard replaying a completed team run: task DAG with per-node assignee, status, token breakdown, and agent output log" width="960" height="456" loading="eager">
</p>

<br />

<p align="center">
  <strong>English</strong> · <a href="./README_zh.md">中文</a>
</p>

<br />

`open-multi-agent` is a multi-agent orchestration framework for TypeScript backends. Give it a goal; a coordinator agent decomposes it into a task DAG, parallelizes independents, and synthesizes the result. Three runtime dependencies, drops into any Node.js backend.

> **Your engineers describe the goal, not the graph.**

Graph-first frameworks make you enumerate every node and edge up front. `open-multi-agent` is goal-first: you describe the outcome and the coordinator builds the task DAG at runtime, so the orchestration adapts to the goal instead of being hand-wired for one.

## Contents

[Quick Start](#quick-start) · [Three Ways to Run](#three-ways-to-run) · [Features](#features) · [Orchestration Controls](#orchestration-controls) · [Ecosystem](#ecosystem) · [Examples](#examples) · [How Is This Different?](#how-is-this-different-from-x) · [Architecture](#architecture) · [Supported Providers](#supported-providers) · [Production Checklist](#production-checklist) · [Documentation](#documentation) · [Contributing](#contributing)

## Quick Start

Requires Node.js >= 18.

```bash
npm install @open-multi-agent/core
```

*Migrating from `@jackchen_me/open-multi-agent`? That package is deprecated; install `@open-multi-agent/core` instead.*

```typescript
import { OpenMultiAgent, type AgentConfig } from '@open-multi-agent/core'

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

// Built-in filesystem tools default to a `<cwd>/.agent-workspace` sandbox.
// Point the agent at an absolute path inside that root.
const result = await orchestrator.runTeam(
  team,
  `Create a REST API for a todo list in ${process.cwd()}/.agent-workspace/todo-api/`,
)

console.log(result.success, result.totalTokenUsage.output_tokens)
```

### Run an example locally

```bash
git clone https://github.com/open-multi-agent/open-multi-agent && cd open-multi-agent
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

## Three Ways to Run

| Mode | Method | When to use | Example |
|------|--------|-------------|---------|
| Single agent | `runAgent()` | One agent, one prompt | [`basics/single-agent`](examples/basics/single-agent.ts) |
| Auto-orchestrated team | `runTeam()` | Give a goal, let the coordinator plan and execute | [`basics/team-collaboration`](examples/basics/team-collaboration.ts) |
| Explicit pipeline | `runTasks()` | You define the task graph and assignments | [`basics/task-pipeline`](examples/basics/task-pipeline.ts) |

For answers that need scrutiny, `runConsensus()` runs a proposer→judge verification loop (with an opt-in per-task `verify` hook). See [Consensus](./docs/consensus.md).

Preview the coordinator's task DAG without executing it, or pin that plan and replay the same graph later without another coordinator call:

```ts
// Decompose once and review the plan
const preview = await orchestrator.runTeam(team, goal, { planOnly: true })

// Turn it into a diffable, version-controllable artifact (plain JSON)
const plan = orchestrator.createPlanArtifact(preview)

// Later: replay the exact graph (same task ids, deps, assignees), no coordinator
const result = await orchestrator.runFromPlan(team, plan)
```

## Features

| Capability | What you get |
|------------|--------------|
| **Goal-driven coordinator** | One `runTeam(team, goal)` call decomposes the goal into a task DAG, parallelizes independents, and synthesizes the result. Unassigned tasks are auto-scheduled — `dependency-first` (default), `round-robin`, `least-busy`, or `capability-match`. |
| **Mix providers in one team** | 12 built-in providers plus any OpenAI-compatible endpoint (Ollama, vLLM, LM Studio, OpenRouter, Groq), mixed freely in one team. Local servers that emit tool calls as plain text are recovered by a fallback parser. ([full list](#supported-providers) · [setup](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/providers.md)) |
| **Extended thinking / reasoning** | One `thinking` config maps to Anthropic thinking, Gemini `thinkingConfig`, and OpenAI `reasoning_effort`; reasoning is streamed as events, with opt-in preservation across a provider switch. ([`cross-provider-reasoning`](examples/patterns/cross-provider-reasoning.ts)) |
| **Tools + MCP** | 6 built-in (`bash`, `file_*`, `grep`, `glob`), opt-in `delegate_to_agent` (cycle + depth guards), custom tools via `defineTool()` + Zod, stdio MCP servers via `connectMCPTools()`. ([tool config](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/tool-configuration.md)) |
| **Streaming + structured output** | Token-by-token streaming on every adapter (per-agent during team runs via `onAgentStream`); Zod-validated final answer with auto-retry on parse failure. ([`structured-output`](examples/patterns/structured-output.ts)) |
| **Human-in-the-loop** | Gate execution with `onPlanReady` (approve the plan before any agent runs) and `onApproval` (approve between task rounds), or inspect first with `planOnly`. |
| **Pin and replay plans** | Serialize a `planOnly` decomposition with `createPlanArtifact`, then `runFromPlan` replays the exact task graph without re-invoking the coordinator. ([`patterns/plan-replay`](examples/patterns/plan-replay.ts)) |
| **Lifecycle hooks + cancellation** | `beforeRun` rewrites the prompt, `afterRun` post-processes or rejects the result; pass an `AbortSignal` to cancel a run in flight. |
| **Configurable coordinator** | Override the coordinator's model, provider, adapter, system prompt, or tools via `runTeam(team, goal, { coordinator })`. |
| **Observability** | `onProgress` events, `onTrace` spans, post-run HTML dashboard rendering the executed task DAG. API keys and tokens are redacted from traces, bash output, and the dashboard. ([observability guide](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/observability.md)) |
| **Pluggable shared memory** | Default in-process KV; swap in Redis / Postgres / your own backend by implementing `MemoryStore`. ([shared memory](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/shared-memory.md)) |
| **Sandboxed filesystem workspace** | Built-in filesystem tools are sandboxed to `<cwd>/.agent-workspace` by default; agents sharing the default configuration share this root. For per-agent isolation, set `AgentConfig.cwd`; for a different shared root, set `OrchestratorConfig.defaultCwd`; pass `null` to disable. ([sandbox config](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/tool-configuration.md)) |

Production controls ([context strategies](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/context-management.md), task retry with backoff, loop detection, tool output truncation/compression) are covered in the [Production Checklist](#production-checklist).

## Orchestration Controls

Fine-grained control over a `runTeam` run. All optional; defaults keep behavior unchanged.

**Inject team context.** Prepend the goal, roster, and this worker's role to every worker prompt — helps workers stay aligned and makes multi-step runs easier to debug. Off by default; worker prompts stay byte-identical when omitted.

```ts
await orchestrator.runTeam(team, goal, { revealCoordinator: true })
```

**Approve before running.** Inspect the coordinator's plan before any agent executes, and again between task rounds. These live on the orchestrator. Returning `false` aborts; remaining tasks are marked `skipped`.

```ts
const orchestrator = new OpenMultiAgent({
  onPlanReady: async (tasks) => tasks.length <= 10,        // gate the whole plan
  onApproval:  async (completed, next) => next.length > 0, // gate each round
})
```

**Cancel a run.** Pass an `AbortSignal`; aborting stops the run in flight.

```ts
const controller = new AbortController()
const run = orchestrator.runTeam(team, goal, { abortSignal: controller.signal })
// controller.abort() from elsewhere to cancel
```

**Configure the coordinator.** Give the planner its own model, adapter, or extra instructions without touching the worker agents.

```ts
await orchestrator.runTeam(team, goal, {
  coordinator: { model: 'claude-opus-4-6', instructions: 'Prefer fewer, larger tasks.' },
})
```

**Fan-out without dependencies.** For MapReduce-style parallelism, use `AgentPool.runParallel()` directly. See [`patterns/fan-out-aggregate`](examples/patterns/fan-out-aggregate.ts).

**Shell & CI.** Use the JSON-first `oma` binary. See [docs/cli.md](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/cli.md).

## Ecosystem

`open-multi-agent` launched 2026-04-01 under MIT. Known users and integrations to date:

### In production

- **[temodar-agent](https://github.com/xeloxa/temodar-agent)** (~60 stars). WordPress security analysis platform by [Ali Sünbül](https://github.com/xeloxa). Uses our built-in tools (`bash`, `file_*`, `grep`) directly inside a Docker runtime. Confirmed production use.

Using `open-multi-agent` in production or a side project? [Open a discussion](https://github.com/open-multi-agent/open-multi-agent/discussions) and we will list it here.

### Integrations

- **[Engram](https://www.engram-memory.com)** — "Git for AI memory." Syncs knowledge across agents instantly and flags conflicts. ([repo](https://github.com/Agentscreator/engram-memory))
- **[@agentsonar/oma](https://github.com/agentsonar/agentsonar-oma)** — Sidecar detecting cross-run delegation cycles, repetition, and rate bursts.

Built an integration? See the [integration guide](examples/integrations/README.md) for how to submit a reference or vendor example and get your product listed.

### Provider community offers

Limited-time provider offers for `open-multi-agent` users. Listings are not paid endorsements.

- **[MiniMax](https://platform.minimax.io/subscribe/coding-plan?code=6ZoOY13DDV&source=link)** — Use MiniMax M3 in OMA's TypeScript multi-agent workflows. OMA users get 12% off the MiniMax Token Plan until 2026-06-30. See the [MiniMax setup guide](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/providers/minimax.md).

### Featured partner

For products and platforms with a deep `open-multi-agent` integration. See the [Featured partner program](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/featured-partner.md) for terms and how to apply.

## Examples

[`examples/`](./examples/) is organized by category: basics, cookbook, patterns, providers, and integrations. See [`examples/README.md`](./examples/README.md) for the full index. ([`production/`](./examples/production/README.md) is open for contributions — see the acceptance criteria.)

### Real-world workflows ([`cookbook/`](./examples/cookbook/))

End-to-end scenarios you can run today. Each one is a complete, opinionated workflow.

- [`contract-review-dag`](examples/cookbook/contract-review-dag.ts): four-task DAG for contract review with parallel branches and step-level retry on failure.
- [`meeting-summarizer`](examples/cookbook/meeting-summarizer.ts): three specialised agents fan out on a transcript, an aggregator merges them into one Markdown report with action items and sentiment.
- [`competitive-monitoring`](examples/cookbook/competitive-monitoring.ts): three parallel source agents extract claims from feeds; an aggregator cross-checks them and flags contradictions.
- [`translation-backtranslation`](examples/cookbook/translation-backtranslation.ts): translate EN to target with one provider, back-translate with another, flag semantic drift.
- [`incident-postmortem-dag`](examples/cookbook/incident-postmortem-dag.ts): three independent root tasks fan out at t=0, then a root-cause hypothesizer and postmortem writer synthesize them into one document.
- [`personalized-interview-simulator`](examples/cookbook/personalized-interview-simulator.ts): a stateful interviewer (`Agent.prompt()` across turns) plus a transcript-reading observer, with `readline` human input and a Zod-validated debrief.

### Patterns and integrations

- [`basics/team-collaboration`](examples/basics/team-collaboration.ts): `runTeam()` coordinator pattern.
- [`patterns/structured-output`](examples/patterns/structured-output.ts): any agent returns Zod-validated JSON.
- [`patterns/multi-perspective-code-review`](examples/patterns/multi-perspective-code-review.ts): a generator feeds security, performance, and style reviewers running in parallel, then a synthesizer returns Zod-validated findings.
- [`patterns/cross-provider-reasoning`](examples/patterns/cross-provider-reasoning.ts): preserve a reasoning model's thought stream across a provider switch via `preserveReasoningAsText`.
- [`patterns/cost-tiered-pipeline`](examples/patterns/cost-tiered-pipeline.ts): assign a different model per stage and estimate per-model USD cost from `onTrace` token counts.
- [`patterns/fan-out-aggregate`](examples/patterns/fan-out-aggregate.ts): MapReduce-style fan-out via `AgentPool.runParallel()`.
- [`patterns/agent-handoff`](examples/patterns/agent-handoff.ts): synchronous sub-agent delegation via `delegate_to_agent`.
- [`patterns/plan-replay`](examples/patterns/plan-replay.ts): decompose a goal once with `planOnly`, serialize it with `createPlanArtifact`, then replay the same DAG via `runFromPlan` without re-running the coordinator.
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
│  - stream()       │    │  - 12 built-in         │
└────────┬──────────┘    │    providers           │
         │               │  - OpenAI-compatible   │
         │               │  - AI SDK bridge       │
         │               └────────────────────────┘
┌────────▼──────────┐
│  AgentRunner      │    ┌──────────────────────┐
│  - conversation   │───►│  ToolRegistry        │
│    loop           │    │  - defineTool()      │
│  - tool dispatch  │    │  - 6 built-in tools  │
└───────────────────┘    │  + delegate (opt-in) │
                         └──────────────────────┘
```

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
| Built-in shortcuts | Set `provider` to `anthropic`, `gemini`, `openai`, `azure-openai`, `copilot`, `grok`, `deepseek`, `doubao`, `hunyuan`, `minimax`, `mimo`, `qiniu`, or `bedrock`; the framework supplies the endpoint. | Anthropic, Gemini, OpenAI, Azure OpenAI, GitHub Copilot, xAI Grok, DeepSeek, Doubao (Volcengine), Hunyuan (Tencent MaaS), MiniMax, MiMo, Qiniu, AWS Bedrock |
| OpenAI-compatible endpoints | Set `provider: 'openai'` plus `baseURL` and, when needed, `apiKey`. | Ollama, vLLM, LM Studio, llama.cpp server, OpenRouter, Groq, Mistral, Moonshot (Kimi), Qwen, Zhipu |
| Vercel AI SDK | Import `AISdkAdapter` from `@open-multi-agent/core/ai-sdk`; install optional peer `ai` plus an `@ai-sdk/*` provider. | [Any AI SDK provider](https://ai-sdk.dev/providers) (60+ models and hosts) |

See [docs/providers.md](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/providers.md) for env vars, model examples, local tool-calling, timeouts, and troubleshooting.

### Vercel AI SDK (optional)

Install the optional peer [`ai`](https://www.npmjs.com/package/ai) plus any [`@ai-sdk` provider](https://ai-sdk.dev/providers) you need (for example [`@ai-sdk/openai`](https://www.npmjs.com/package/@ai-sdk/openai)). Pass `adapter: new AISdkAdapter(model)` on `AgentConfig` to route that agent through the AI SDK instead of the built-in `provider` factory. `provider`, `apiKey`, `baseURL`, and `region` are ignored when `adapter` is set. Mixed teams work as usual: only agents with `adapter` use the AI SDK.

```typescript
import { openai } from '@ai-sdk/openai'
import { AISdkAdapter } from '@open-multi-agent/core/ai-sdk'
import { OpenMultiAgent } from '@open-multi-agent/core'

const oma = new OpenMultiAgent()
await oma.runAgent(
  {
    name: 'researcher',
    model: 'gpt-4o',
    adapter: new AISdkAdapter(openai('gpt-4o')),
    systemPrompt: 'You are a researcher.',
  },
  'What are the latest AI trends?',
)
```

The coordinator accepts the same hook via `runTeam(team, goal, { coordinator: { adapter: new AISdkAdapter(...) } })`.

## Production Checklist

Before going live, wire up the controls that protect token spend, recover from failure, and let you debug.

| Concern | Knob | Where it lives |
|---------|------|----------------|
| Bound the conversation | `maxTurns` per agent + `contextStrategy` (`sliding-window` / `summarize` / `compact` / `custom`) | `AgentConfig` |
| Bound wall-clock time | `timeoutMs` per agent (aborts a run that hangs, common with local models) | `AgentConfig` |
| Cap tool output | `maxToolOutputChars` (or per-tool `maxOutputChars`) + `compressToolResults: true` | `AgentConfig` and `defineTool()` |
| Recover from failure | Per-task `maxRetries`, `retryDelayMs`, `retryBackoff` (exponential multiplier) | Task config used via `runTasks()` |
| Hard-cap spend | `maxTokenBudget` on the orchestrator | `OrchestratorConfig` |
| Catch stuck agents | `loopDetection` with `onLoopDetected: 'terminate'` (or a custom handler) | `AgentConfig` |
| Trace and audit | `onTrace` to your tracing backend; persist `renderTeamRunDashboard(result)` | `OrchestratorConfig` |
| Redact secrets | Automatic — API keys, tokens, and Authorization headers stripped from traces, bash output, and dashboard payloads | built-in (on by default) |
| Bound filesystem reach | `cwd` / `defaultCwd` (default `.agent-workspace` subdir; widen with `process.cwd()`, disable with `null`) | `AgentConfig` / `OrchestratorConfig` |

## Documentation

- [Providers](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/providers.md) — env vars, model examples, local tool-calling, timeouts, troubleshooting.
- [Tool configuration](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/tool-configuration.md) — tool presets, custom tools, the filesystem sandbox, and MCP.
- [Observability](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/observability.md) — `onProgress` events, `onTrace` spans, and the post-run dashboard.
- [Shared memory](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/shared-memory.md) — the default store and custom `MemoryStore` backends.
- [Context management](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/context-management.md) — sliding window, summarization, compaction, and custom compressors.
- [CLI](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/cli.md) — the JSON-first `oma` binary for shell and CI.
- [Consensus](./docs/consensus.md) — the `runConsensus` proposer→judge primitive, the per-task `verify` hook, and the budget invariant.

## Contributing

Issues, feature requests, and PRs are welcome. Some areas where contributions would be especially valuable:

- **Production examples.** Real-world end-to-end workflows. See [`examples/production/README.md`](./examples/production/README.md) for the acceptance criteria and submission format.
- **Documentation.** Guides, tutorials, and API docs.
- **Translations.** Help translate this README into other languages. [Open a PR](https://github.com/open-multi-agent/open-multi-agent/pulls).

## Contributors

<a href="https://github.com/open-multi-agent/open-multi-agent/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=open-multi-agent/open-multi-agent&max=100&v=20260529" />
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
- [@matthewYang08](https://github.com/matthewYang08) (OpenAI reasoning-to-text fallback)
- [@dvirarad](https://github.com/dvirarad) (OpenAI-family adapter hardening)

**Provider integrations**

- [@ibrahimkzmv](https://github.com/ibrahimkzmv) (Gemini)
- [@hkalex](https://github.com/hkalex) (DeepSeek, MiniMax)
- [@marceloceccon](https://github.com/marceloceccon) (Grok)
- [@Klarline](https://github.com/Klarline) (Azure OpenAI)
- [@Deathwing](https://github.com/Deathwing) (GitHub Copilot)
- [@JackChiang233](https://github.com/JackChiang233) (Qiniu)
- [@CodingBangboo](https://github.com/CodingBangboo) (AWS Bedrock)
- [@kidoom](https://github.com/kidoom) (MiMo, Doubao)

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
- [@nuthalapativarun](https://github.com/nuthalapativarun) (Doubao and Zhipu provider examples)
- [@goodneamtakenbydogs](https://github.com/goodneamtakenbydogs) (Moonshot and Qwen provider examples)
- [@suans4746-del](https://github.com/suans4746-del) (narrative puzzle hint arbitration)
- [@gregkonush](https://github.com/gregkonush) (Bilig WorkPaper MCP integration)

**Docs & tests**

- [@tmchow](https://github.com/tmchow) (llama.cpp docs)
- [@kenrogers](https://github.com/kenrogers) (OpenRouter docs)
- [@jadegold55](https://github.com/jadegold55) (LLM adapter test coverage)
- [@btroops](https://github.com/btroops) (DeepSeek tool-calling tests)
- [@nuthalapativarun](https://github.com/nuthalapativarun) (context-management docs)

</details>

## License

MIT
