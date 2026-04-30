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
  TypeScript-native multi-agent orchestration. Three runtime dependencies.<br/>
  9 native LLM adapters · MCP · token budgets · retries · context compaction · live tracing.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@jackchen_me/open-multi-agent"><img src="https://img.shields.io/npm/v/@jackchen_me/open-multi-agent" alt="npm version"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/JackChen-me/open-multi-agent" alt="license"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.6-blue" alt="TypeScript"></a>
  <a href="https://codecov.io/gh/JackChen-me/open-multi-agent"><img src="https://codecov.io/gh/JackChen-me/open-multi-agent/graph/badge.svg" alt="codecov"></a>
  <a href="https://github.com/JackChen-me/open-multi-agent/blob/main/package.json"><img src="https://img.shields.io/badge/runtime_deps-3-brightgreen" alt="runtime deps"></a>
  <a href="https://github.com/JackChen-me/open-multi-agent/stargazers"><img src="https://img.shields.io/github/stars/JackChen-me/open-multi-agent" alt="GitHub stars"></a>
  <a href="https://github.com/JackChen-me/open-multi-agent/network/members"><img src="https://img.shields.io/github/forks/JackChen-me/open-multi-agent" alt="GitHub forks"></a>
</p>

<p align="center">
  <strong>English</strong> · <a href="./README_zh.md">中文</a>
</p>

<br />

`open-multi-agent` is a multi-agent orchestration framework for TypeScript backends. Give it a goal; a coordinator agent decomposes it into a task DAG, parallelizes independents, and synthesizes the result. Three runtime dependencies, drops into any Node.js backend.

> **Your engineers describe the goal, not the graph.**

A typical run, streamed live through `onProgress`:

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

## Features

| Capability | What you get |
|------------|--------------|
| **Goal-driven coordinator** | One `runTeam(team, goal)` call. The coordinator decomposes the goal into a task DAG, parallelizes independents, and synthesizes the result. |
| **Mix providers in one team** | 9 native: Anthropic, OpenAI, Azure, Gemini, Grok, DeepSeek, MiniMax, Qiniu, Copilot. Ollama / vLLM / LM Studio / OpenRouter / Groq via OpenAI-compatible. ([full list](#supported-providers)) |
| **Tools + MCP** | 6 built-in (`bash`, `file_*`, `grep`, `glob`), opt-in `delegate_to_agent`, custom tools via `defineTool()` + Zod, any MCP server via `connectMCPTools()`. |
| **Streaming + structured output** | Token-by-token streaming on every adapter; Zod-validated final answer with auto-retry on parse failure. ([`structured-output`](examples/patterns/structured-output.ts)) |
| **Observability** | `onProgress` events, `onTrace` spans, post-run HTML dashboard rendering the executed task DAG. ([`trace-observability`](examples/integrations/trace-observability.ts)) |
| **Pluggable shared memory** | Default in-process KV; swap in Redis / Postgres / your own backend by implementing `MemoryStore`. |

Production controls (context strategies, task retry with backoff, loop detection, tool output truncation/compression) are covered in the [Production Checklist](#production-checklist).

## Quick Start

Requires Node.js >= 18.

### Try it locally

Clone, install, run.

```bash
git clone https://github.com/JackChen-me/open-multi-agent && cd open-multi-agent
npm install
export ANTHROPIC_API_KEY=sk-...
npx tsx examples/basics/team-collaboration.ts
```

Three agents (architect, developer, reviewer) collaborate on a REST API in `/tmp/express-api/`. You watch the coordinator decompose the goal and run independent tasks in parallel as the progress events stream in.

Local models via Ollama need no API key, see [`providers/ollama`](examples/providers/ollama.ts). For other providers (`OPENAI_API_KEY`, `GEMINI_API_KEY`, etc.), check [Supported Providers](#supported-providers).

### Use it in your project

```bash
npm install @jackchen_me/open-multi-agent
```

Three agents, one goal. The framework handles the rest:

```typescript
import { OpenMultiAgent } from '@jackchen_me/open-multi-agent'
import type { AgentConfig } from '@jackchen_me/open-multi-agent'

const architect: AgentConfig = {
  name: 'architect',
  model: 'claude-sonnet-4-6',
  systemPrompt: 'You design clean API contracts and file structures.',
  tools: ['file_write'],
}

const developer: AgentConfig = {
  name: 'developer',
  model: 'claude-sonnet-4-6',
  systemPrompt: 'You implement what the architect specifies. Write clean, runnable TypeScript.',
  tools: ['bash', 'file_read', 'file_write', 'file_edit'],
}

const reviewer: AgentConfig = {
  name: 'reviewer',
  model: 'claude-sonnet-4-6',
  systemPrompt: 'You review code for correctness, security, and clarity.',
  tools: ['file_read', 'grep'],
}

const orchestrator = new OpenMultiAgent({
  defaultModel: 'claude-sonnet-4-6',
  onProgress: (event) => console.log(event.type, event.task ?? event.agent ?? ''),
})

const team = orchestrator.createTeam('api-team', {
  name: 'api-team',
  agents: [architect, developer, reviewer],
  sharedMemory: true,
})

// Describe a goal. The framework breaks it into tasks and orchestrates execution
const result = await orchestrator.runTeam(team, 'Create a REST API for a todo list in /tmp/todo-api/')

console.log(`Success: ${result.success}`)
console.log(`Tokens: ${result.totalTokenUsage.output_tokens} output tokens`)
```

### Three Ways to Run

| Mode | Method | When to use | Example |
|------|--------|-------------|---------|
| Single agent | `runAgent()` | One agent, one prompt. Simplest entry point | [`basics/single-agent`](examples/basics/single-agent.ts) |
| Auto-orchestrated team | `runTeam()` | Give a goal, framework plans and executes | [`basics/team-collaboration`](examples/basics/team-collaboration.ts) |
| Explicit pipeline | `runTasks()` | You define the task graph and assignments | [`basics/task-pipeline`](examples/basics/task-pipeline.ts) |

For MapReduce-style fan-out without task dependencies, use `AgentPool.runParallel()` directly. See [`patterns/fan-out-aggregate`](examples/patterns/fan-out-aggregate.ts).

### Run from the shell

For shell and CI, the package exposes a JSON-first binary. See [docs/cli.md](./docs/cli.md) for `oma run`, `oma task`, `oma provider`, exit codes, and file formats.

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
- [`patterns/agent-handoff`](examples/patterns/agent-handoff.ts): synchronous sub-agent delegation via `delegate_to_agent`.
- [`integrations/trace-observability`](examples/integrations/trace-observability.ts): `onTrace` spans for LLM calls, tools, and tasks.
- [`integrations/mcp-github`](examples/integrations/mcp-github.ts): expose an MCP server's tools to an agent via `connectMCPTools()`.
- [`integrations/with-vercel-ai-sdk`](examples/integrations/with-vercel-ai-sdk/): Next.js app combining OMA `runTeam()` with AI SDK `useChat` streaming.
- **Provider examples**: three-agent teams under [`examples/providers/`](examples/providers/), including hosted providers, OpenAI-compatible endpoints, and local models.

Run any script with `npx tsx examples/<path>.ts`.

## How is this different from X?

A quick router. Mechanism breakdown follows.

| If you need | Pick |
|-------------|------|
| Fixed production topology with mature checkpointing | [LangGraph JS](https://github.com/langchain-ai/langgraphjs) |
| Explicit Supervisor + hand-wired workflows | [Mastra](https://github.com/mastra-ai/mastra) |
| Python stack with mature multi-agent ecosystem | [CrewAI](https://github.com/crewAIInc/crewAI) |
| Single-agent LLM call layer for 60+ providers | [Vercel AI SDK](https://github.com/vercel/ai) |
| **TypeScript, goal to result with auto task decomposition** | **open-multi-agent** |

**vs. LangGraph JS.** LangGraph compiles a declarative graph (nodes, edges, conditional routing) into an invokable. `open-multi-agent` runs a Coordinator that decomposes the goal into a task DAG at runtime, then auto-parallelizes independents. Same end (orchestrated execution), opposite directions: LangGraph is graph-first, OMA is goal-first.

**vs. Mastra.** Both are TypeScript-native. Mastra's Supervisor pattern requires you to wire agents and workflows by hand; OMA's Coordinator does the wiring at runtime from the goal string. If the workflow is known up front, Mastra's explicitness pays off. If you'd rather not enumerate every step, OMA's `runTeam(team, goal)` is one call.

**vs. CrewAI.** CrewAI is the mature multi-agent option in Python. OMA targets TypeScript backends with three runtime dependencies and direct Node.js embedding. Roughly comparable orchestration surface; the choice is language stack.

**vs. Vercel AI SDK.** AI SDK is the LLM call layer (unified client for 60+ providers, streaming, tool calls, structured outputs). It does not orchestrate multi-agent teams. The two compose: AI SDK for single-agent work, OMA when you need a team.

## Ecosystem

`open-multi-agent` launched 2026-04-01 under MIT. Public users and integrations to date:

### In production

- **[temodar-agent](https://github.com/xeloxa/temodar-agent)** (~60 stars). WordPress security analysis platform by [Ali Sünbül](https://github.com/xeloxa). Uses our built-in tools (`bash`, `file_*`, `grep`) directly in its Docker runtime. Confirmed production use.
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

## Observability

Three layers of telemetry, each independently consumable.

| Layer | What it gives you | Where to wire it |
|-------|-------------------|------------------|
| **`onProgress`** | Per-task lifecycle events: `task_start`, `task_complete`, `task_retry`, `task_skipped`, `agent_start`, `agent_complete`, `budget_exceeded`, `error`. Lightweight, sync. | `OrchestratorConfig.onProgress`; pipe to your logger or a live dashboard. |
| **`onTrace`** | Structured spans for LLM calls, tool executions, and tasks. Each span carries parent IDs, durations, token counts, and tool I/O. | `OrchestratorConfig.onTrace`; forward to OpenTelemetry, Datadog, Honeycomb, Langfuse, etc. ([`integrations/trace-observability`](examples/integrations/trace-observability.ts)) |
| **Post-run HTML dashboard** | Static HTML page rendering the executed task DAG with timing, token usage, and per-task status. No server, no D3, just `string`. | `import { renderTeamRunDashboard } from '@jackchen_me/open-multi-agent'`, then `fs.writeFileSync('run.html', renderTeamRunDashboard(result))`. |

Together: live progress for ops, traces for debugging and cost attribution, a shareable post-mortem artifact for any run.

## Built-in Tools

| Tool | Description |
|------|-------------|
| `bash` | Execute shell commands. Returns stdout + stderr. Supports timeout and cwd. |
| `file_read` | Read file contents at an absolute path. Supports offset/limit for large files. |
| `file_write` | Write or create a file. Auto-creates parent directories. |
| `file_edit` | Edit a file by replacing an exact string match. |
| `grep` | Search file contents with regex. Uses ripgrep when available, falls back to Node.js. |
| `glob` | Find files by glob pattern. Returns matching paths sorted by modification time. |

## Tool Configuration

- **Pick a preset.** `toolPreset: 'readonly' | 'readwrite' | 'full'` covers most agents.
- **Narrow further.** Combine `tools` (allowlist) and `disallowedTools` (denylist) on top of the preset.
- **Bring your own.** `defineTool()` + `customTools`, or `agent.addTool()` at runtime.
- **Cap output cost.** `outputSchema`, `maxToolOutputChars`, and `compressToolResults`.
- **MCP.** Connect external servers via `connectMCPTools()` from `open-multi-agent/mcp`.

Full details in [docs/tool-configuration.md](./docs/tool-configuration.md).

## Shared Memory

Teams can share a namespaced key-value store so later agents see earlier agents' findings. Use `sharedMemory: true` for the default in-process store, or implement `MemoryStore` and pass it via `sharedMemoryStore` for Redis, Postgres, Engram, etc. Keys are namespaced as `<agentName>/<key>` before they reach the store. SDK-only: the CLI cannot pass runtime objects.

See [docs/shared-memory.md](./docs/shared-memory.md).

## Context Management

Long-running agents hit input token ceilings fast. `AgentConfig.contextStrategy` controls how the conversation shrinks:

- `sliding-window`: keep the last N turns, drop the rest. Cheapest.
- `summarize`: send old turns to a summary model, keep the summary in place.
- `compact`: rule-based truncation, no extra LLM call.
- `custom`: supply your own `compress(messages, estimatedTokens)`.

See [docs/context-management.md](./docs/context-management.md).

## Supported Providers

Change `provider`, `model`, and set the env var. The agent config shape stays the same:

```typescript
const agent: AgentConfig = {
  name: 'my-agent',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  systemPrompt: 'You are a helpful assistant.',
}
```

### First-class providers (named shortcuts)

The framework ships a wired-in provider name for each of these. You set `provider` and the env var, that's it.

> Under the hood, Anthropic and Gemini use their own SDKs; the rest are pre-configured shortcuts on top of the OpenAI Chat Completions protocol. Same wire format as the second table, the framework just wrote the `baseURL` for you.

| Provider | Config | Env var | Example model | Notes |
|----------|--------|---------|--------------|-------|
| Anthropic (Claude) | `provider: 'anthropic'` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-6` | Native Anthropic SDK. |
| Gemini | `provider: 'gemini'` | `GEMINI_API_KEY` | `gemini-2.5-pro` | Native Google GenAI SDK. Requires `npm install @google/genai`. |
| OpenAI (GPT) | `provider: 'openai'` | `OPENAI_API_KEY` | `gpt-4o` | |
| Azure OpenAI | `provider: 'azure-openai'` | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT` | `gpt-4` | Optional `AZURE_OPENAI_API_VERSION`, `AZURE_OPENAI_DEPLOYMENT`. |
| GitHub Copilot | `provider: 'copilot'` | `GITHUB_COPILOT_TOKEN` (falls back to `GITHUB_TOKEN`) | `gpt-4o` | Custom token-exchange flow on top of OpenAI protocol. |
| Grok (xAI) | `provider: 'grok'` | `XAI_API_KEY` | `grok-4` | OpenAI-compatible; endpoint is `api.x.ai/v1`. |
| DeepSeek | `provider: 'deepseek'` | `DEEPSEEK_API_KEY` | `deepseek-chat` | OpenAI-compatible. `deepseek-chat` (V3, coding) or `deepseek-reasoner` (thinking mode). |
| MiniMax (global) | `provider: 'minimax'` | `MINIMAX_API_KEY` | `MiniMax-M2.7` | OpenAI-compatible. |
| MiniMax (China) | `provider: 'minimax'` + `MINIMAX_BASE_URL` | `MINIMAX_API_KEY` | `MiniMax-M2.7` | Set `MINIMAX_BASE_URL=https://api.minimaxi.com/v1`. |
| Qiniu | `provider: 'qiniu'` | `QINIU_API_KEY` | `deepseek-v3` | OpenAI-compatible. Endpoint `https://api.qnaigc.com/v1`; multiple model families, see [Qiniu AI docs](https://developer.qiniu.com/aitokenapi/12882/ai-inference-api). |
| AWS Bedrock | `provider: 'bedrock'` | none (AWS SDK credential chain) | `anthropic.claude-3-5-haiku-20241022-v1:0` | No API key. Set `AWS_REGION` or pass `region` as the 4th arg to `createAdapter`. Credentials from env vars, shared config, or IAM role. Newer Claude models (Sonnet 4.x, Haiku 4.x) require a cross-region inference profile prefix like `us.` — check the Bedrock console for IDs available in your region. Also supports Llama, Mistral, Cohere — see [`providers/bedrock`](examples/providers/bedrock.ts) example. Requires `npm install @aws-sdk/client-bedrock-runtime`. |

### Anything else OpenAI-compatible (manual `baseURL`)

No bundled shortcut, but it works the same. Use `provider: 'openai'` and point `baseURL` at any server that speaks OpenAI Chat Completions.

| Service | Config | Env var | Example model |
|---------|--------|---------|---------------|
| Ollama (local) | `provider: 'openai'` + `baseURL: 'http://localhost:11434/v1'` | none | `llama3.1` |
| vLLM (local) | `provider: 'openai'` + `baseURL` | none | (server-loaded) |
| LM Studio (local) | `provider: 'openai'` + `baseURL` | none | (server-loaded) |
| llama.cpp server (local) | `provider: 'openai'` + `baseURL` | none | (server-loaded) |
| OpenRouter | `provider: 'openai'` + `baseURL: 'https://openrouter.ai/api/v1'` + `apiKey` | `OPENROUTER_API_KEY` | `openai/gpt-4o-mini` |
| Groq | `provider: 'openai'` + `baseURL: 'https://api.groq.com/openai/v1'` | `GROQ_API_KEY` | `llama-3.3-70b-versatile` |

Mistral, Qwen, Moonshot, Doubao, Together AI, Fireworks, etc. all plug in the same way. For services where the key is not `OPENAI_API_KEY` (OpenRouter is one), pass it explicitly via the `apiKey` config field; otherwise the `openai` adapter falls back to `OPENAI_API_KEY` from the environment.

### Local Model Tool-Calling

The framework supports tool-calling with local models served by Ollama, vLLM, LM Studio, or llama.cpp. Tool-calling is handled natively by these servers via the OpenAI-compatible API.

**Verified models:** Gemma 4, Llama 3.1, Qwen 3, Mistral, Phi-4. See the full list at [ollama.com/search?c=tools](https://ollama.com/search?c=tools).

**Fallback extraction:** If a local model returns tool calls as text instead of using the `tool_calls` wire format (common with thinking models or misconfigured servers), the framework automatically extracts them from the text output.

**Timeout:** Local inference can be slow. Use `timeoutMs` on `AgentConfig` to prevent indefinite hangs:

```typescript
const localAgent: AgentConfig = {
  name: 'local',
  model: 'llama3.1',
  provider: 'openai',
  baseURL: 'http://localhost:11434/v1',
  apiKey: 'ollama',
  tools: ['bash', 'file_read'],
  timeoutMs: 120_000, // abort after 2 minutes
}
```

**Quantized model tuning.** Highly quantized MoE models on consumer hardware (Qwen2.5-MoE @ Q4, DeepSeek-MoE @ Q4, etc.) tend to fall into repetition loops or hallucinate tool-call schemas under default sampling. `AgentConfig` exposes `topK`, `minP`, `frequencyPenalty`, `presencePenalty`, `parallelToolCalls` (set `false` to force one tool call per turn on shaky tool-callers), and an `extraBody` escape hatch for server-specific knobs (e.g. vLLM's `repetition_penalty`). Cloud OpenAI users do not need these — defaults are tuned for full-precision models. See [`providers/local-quantized`](examples/providers/local-quantized.ts) for a full setup.

**Troubleshooting:**
- Model not calling tools? Ensure it appears in Ollama's [Tools category](https://ollama.com/search?c=tools). Not all models support tool-calling.
- Using Ollama? Update to the latest version (`ollama update`). Older versions have known tool-calling bugs.
- Proxy interfering? Use `no_proxy=localhost` when running against local servers.

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

**Project lead:** [Jack Chen](https://github.com/JackChen-me)

**Framework features**

- [@ibrahimkzmv](https://github.com/ibrahimkzmv) (token budget, context strategy, dependency-scoped context, tool presets, glob, MCP integration, configurable coordinator, CLI, dashboard rendering)
- [@apollo-mg](https://github.com/apollo-mg) (context compaction fix, sampling parameters)
- [@tizerluo](https://github.com/tizerluo) (onPlanReady, onAgentStream)
- [@Xin-Mai](https://github.com/Xin-Mai) (output schema validation)
- [@JasonOA888](https://github.com/JasonOA888) (AbortSignal support)
- [@EchoOfZion](https://github.com/EchoOfZion) (coordinator skip for simple goals)
- [@voidborne-d](https://github.com/voidborne-d) (OpenAI mixed content fix)
- [@hamzarstar](https://github.com/hamzarstar) (agent delegation co-author)

**Provider integrations**

- [@ibrahimkzmv](https://github.com/ibrahimkzmv) (Gemini)
- [@hkalex](https://github.com/hkalex) (DeepSeek, MiniMax)
- [@marceloceccon](https://github.com/marceloceccon) (Grok)
- [@Klarline](https://github.com/Klarline) (Azure OpenAI)
- [@Deathwing](https://github.com/Deathwing) (GitHub Copilot)
- [@JackChiang233](https://github.com/JackChiang233) and [@jiangzhuo](https://github.com/jiangzhuo) (Qiniu)

**Examples & cookbook**

- [@mvanhorn](https://github.com/mvanhorn) (research aggregation, code review, meeting summarizer, Groq example)
- [@Kinoo0](https://github.com/Kinoo0) (code review upgrade)
- [@Optimisttt](https://github.com/Optimisttt) (research aggregation upgrade)
- [@Agentscreator](https://github.com/Agentscreator) (Engram memory integration)
- [@fault-segment](https://github.com/fault-segment) and yanzizheng (contract-review DAG)
- [@HuXiangyu123](https://github.com/HuXiangyu123) (cost-tiered example)
- [@zouhh22333-beep](https://github.com/zouhh22333-beep) (translation/backtranslation)
- [@pei-pei45](https://github.com/pei-pei45) (competitive monitoring)

**Docs & tests**

- [@tmchow](https://github.com/tmchow) (llama.cpp docs)
- [@kenrogers](https://github.com/kenrogers) (OpenRouter docs)
- [@jadegold55](https://github.com/jadegold55) (LLM adapter test coverage)

<a href="https://github.com/JackChen-me/open-multi-agent/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=JackChen-me/open-multi-agent&max=100&v=20260427" />
</a>

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
