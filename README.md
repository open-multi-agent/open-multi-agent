# Open Multi-Agent

The lightweight multi-agent orchestration engine for TypeScript. Three runtime dependencies, zero config, goal to result in one `runTeam()` call.

CrewAI is Python. LangGraph makes you draw the graph by hand. `open-multi-agent` is the `npm install` you drop into an existing Node.js backend when you need a team of agents to work on a goal together. Nothing more, nothing less.

[![GitHub stars](https://img.shields.io/github/stars/JackChen-me/open-multi-agent)](https://github.com/JackChen-me/open-multi-agent/stargazers)
[![license](https://img.shields.io/github/license/JackChen-me/open-multi-agent)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue)](https://www.typescriptlang.org/)
[![coverage](https://img.shields.io/badge/coverage-85%25-brightgreen)](https://github.com/JackChen-me/open-multi-agent/actions)

**English** | [中文](./README_zh.md)

## What you actually get

- **Goal to result in one call.** `runTeam(team, "Build a REST API")` kicks off a coordinator agent that decomposes the goal into a task DAG, resolves dependencies, runs independent tasks in parallel, and synthesizes the final output. No graph to draw, no tasks to wire up.
- **TypeScript-native, three runtime dependencies.** `@anthropic-ai/sdk`, `openai`, `zod`. That is the whole runtime. Embed in Express, Next.js, serverless functions, or CI/CD pipelines. No Python runtime, no subprocess bridge, no cloud sidecar.
- **Multi-model teams.** Claude, GPT, Gemini, Grok, MiniMax, DeepSeek, Copilot, or any OpenAI-compatible local model (Ollama, vLLM, LM Studio, llama.cpp) in the same team. Run the architect on Opus 4.6, the developer on GPT-5.4, the reviewer on local Gemma 4, all in one `runTeam()` call. Gemini ships as an optional peer dependency: `npm install @google/genai` to enable.

Other features (MCP integration, context strategies, structured output, task retry, human-in-the-loop, lifecycle hooks, loop detection, observability) live below the fold and in [`examples/`](./examples/).

## Philosophy: what we build, what we don't

Our goal is to be the simplest multi-agent framework for TypeScript. Simplicity does not mean closed. We believe the long-term value of a framework is the size of the network it connects to, not its feature checklist.

**We build:**
- A coordinator that decomposes a goal into a task DAG.
- A task queue that runs independent tasks in parallel and cascades failures to dependents.
- A shared memory and message bus so agents can see each other's output.
- Multi-model teams where each agent can use a different LLM provider.

**We don't build:**
- **Agent handoffs.** If agent A needs to transfer mid-conversation to agent B, use [OpenAI Agents SDK](https://github.com/openai/openai-agents-python). In our model, each agent owns one task end-to-end, with no mid-conversation transfers.
- **State persistence / checkpointing.** Not planned for now. Adding a storage backend would break the three-dependency promise, and our workflows run in seconds to minutes, not hours. If real usage shifts toward long-running workflows, we will revisit.

**Tracking:**
- **A2A protocol.** Watching, will move when production adoption is real.

See [`DECISIONS.md`](./DECISIONS.md) for the full rationale.

## How is this different from X?

**vs. [LangGraph JS](https://github.com/langchain-ai/langgraphjs).** LangGraph is declarative graph orchestration: you define nodes, edges, and conditional routing, then `compile()` and `invoke()`. `open-multi-agent` is goal-driven: you declare a team and a goal, a coordinator decomposes it into a task DAG at runtime. LangGraph gives you total control of topology (great for fixed production workflows). This gives you less typing and faster iteration (great for exploratory multi-agent work). LangGraph also has mature checkpointing; we do not.

**vs. [CrewAI](https://github.com/crewAIInc/crewAI).** CrewAI is the mature Python choice. If your stack is Python, use CrewAI. `open-multi-agent` is TypeScript-native: three runtime dependencies, embeds directly in Node.js without a subprocess bridge. Roughly comparable capability on the orchestration side. Choose on language fit.

**vs. [Vercel AI SDK](https://github.com/vercel/ai).** AI SDK is the LLM call layer: a unified TypeScript client for 60+ providers with streaming, tool calls, and structured outputs. It does not orchestrate multi-agent teams. `open-multi-agent` sits on top when you need that. They compose: use AI SDK for single-agent work, reach for this when you need a team.

## Used by

`open-multi-agent` is a new project (launched 2026-04-01, MIT, 5,500+ stars). The ecosystem is still forming, so the list below is short and honest:

- **[temodar-agent](https://github.com/xeloxa/temodar-agent)** (~50 stars). WordPress security analysis platform by [Ali Sünbül](https://github.com/xeloxa). Uses our built-in tools (`bash`, `file_*`, `grep`) directly in its Docker runtime. Confirmed production use.
- **Cybersecurity SOC (home lab).** A private setup running Qwen 2.5 + DeepSeek Coder entirely offline via Ollama, building an autonomous SOC pipeline on Wazuh + Proxmox. Early user, not yet public.

Using `open-multi-agent` in production or a side project? [Open a discussion](https://github.com/JackChen-me/open-multi-agent/discussions) and we will list it here.

## Quick Start

Requires Node.js >= 18.

```bash
npm install @jackchen_me/open-multi-agent
```

Set the API key for your provider. Local models via Ollama require no API key. See [`providers/ollama`](examples/providers/ollama.ts).

- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `GEMINI_API_KEY`
- `XAI_API_KEY` (for Grok)
- `MINIMAX_API_KEY` (for MiniMax)
- `MINIMAX_BASE_URL` (for MiniMax, optional, selects endpoint)
- `DEEPSEEK_API_KEY` (for DeepSeek)
- `GITHUB_TOKEN` (for Copilot)

**CLI (`oma`).** For shell and CI, the package exposes a JSON-first binary. See [docs/cli.md](./docs/cli.md) for `oma run`, `oma task`, `oma provider`, exit codes, and file formats.

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

const developer: AgentConfig = { /* same shape, tools: ['bash', 'file_read', 'file_write', 'file_edit'] */ }
const reviewer: AgentConfig = { /* same shape, tools: ['file_read', 'grep'] */ }

const orchestrator = new OpenMultiAgent({
  defaultModel: 'claude-sonnet-4-6',
  onProgress: (event) => console.log(event.type, event.agent ?? event.task ?? ''),
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

What happens under the hood:

```
agent_start coordinator
task_start architect
task_complete architect
task_start developer
task_start developer              // independent tasks run in parallel
task_complete developer
task_complete developer
task_start reviewer               // unblocked after implementation
task_complete reviewer
agent_complete coordinator        // synthesizes final result
Success: true
Tokens: 12847 output tokens
```

## Three Ways to Run

| Mode | Method | When to use |
|------|--------|-------------|
| Single agent | `runAgent()` | One agent, one prompt. Simplest entry point |
| Auto-orchestrated team | `runTeam()` | Give a goal, framework plans and executes |
| Explicit pipeline | `runTasks()` | You define the task graph and assignments |

For MapReduce-style fan-out without task dependencies, use `AgentPool.runParallel()` directly. See [`patterns/fan-out-aggregate`](examples/patterns/fan-out-aggregate.ts).

## Examples

[`examples/`](./examples/) is organized by category: basics, providers, patterns, integrations, and production. See [`examples/README.md`](./examples/README.md) for the full index. Highlights:

- [`basics/team-collaboration`](examples/basics/team-collaboration.ts): `runTeam()` coordinator pattern.
- [`patterns/structured-output`](examples/patterns/structured-output.ts): any agent returns Zod-validated JSON.
- [`patterns/agent-handoff`](examples/patterns/agent-handoff.ts): synchronous sub-agent delegation via `delegate_to_agent`.
- [`integrations/trace-observability`](examples/integrations/trace-observability.ts): `onTrace` spans for LLM calls, tools, and tasks.
- [`integrations/mcp-github`](examples/integrations/mcp-github.ts): expose an MCP server's tools to an agent via `connectMCPTools()`.
- [`integrations/with-vercel-ai-sdk`](examples/integrations/with-vercel-ai-sdk/): Next.js app combining OMA `runTeam()` with AI SDK `useChat` streaming.
- **Provider examples**: eight three-agent teams (one per supported provider) under [`examples/providers/`](examples/providers/).

Run scripts with `npx tsx examples/basics/team-collaboration.ts`.

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
│  - run()          │    ┌──────────────────────┐
│  - prompt()       │───►│  LLMAdapter          │
│  - stream()       │    │  - AnthropicAdapter  │
└────────┬──────────┘    │  - OpenAIAdapter     │
         │               │  - CopilotAdapter    │
         │               │  - GeminiAdapter     │
         │               │  - GrokAdapter       │
         │               │  - MiniMaxAdapter    │
         │               │  - DeepSeekAdapter   │
         │               └──────────────────────┘
┌────────▼──────────┐
│  AgentRunner      │    ┌──────────────────────┐
│  - conversation   │───►│  ToolRegistry        │
│    loop           │    │  - defineTool()      │
│  - tool dispatch  │    │  - 6 built-in tools  │
└───────────────────┘    └──────────────────────┘
```

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

Agents can be configured with fine-grained tool access control using presets, allowlists, and denylists.

### Tool Presets

Predefined tool sets for common use cases:

```typescript
const readonlyAgent: AgentConfig = {
  name: 'reader',
  model: 'claude-sonnet-4-6',
  toolPreset: 'readonly',  // file_read, grep, glob
}

const readwriteAgent: AgentConfig = {
  name: 'editor',
  model: 'claude-sonnet-4-6',
  toolPreset: 'readwrite',  // file_read, file_write, file_edit, grep, glob
}

const fullAgent: AgentConfig = {
  name: 'executor',
  model: 'claude-sonnet-4-6',
  toolPreset: 'full',  // file_read, file_write, file_edit, grep, glob, bash
}
```

### Advanced Filtering

Combine presets with allowlists and denylists for precise control:

```typescript
const customAgent: AgentConfig = {
  name: 'custom',
  model: 'claude-sonnet-4-6',
  toolPreset: 'readwrite',        // Start with: file_read, file_write, file_edit, grep, glob
  tools: ['file_read', 'grep'],   // Allowlist: intersect with preset = file_read, grep
  disallowedTools: ['grep'],      // Denylist: subtract = file_read only
}
```

**Resolution order:** preset → allowlist → denylist → framework safety rails.

### Custom Tools

Two ways to give an agent a tool that is not in the built-in set.

**Inject at config time** via `customTools` on `AgentConfig`. Good when the orchestrator wires up tools centrally. Tools defined here bypass preset/allowlist filtering but still respect `disallowedTools`.

```typescript
import { defineTool } from '@jackchen_me/open-multi-agent'
import { z } from 'zod'

const weatherTool = defineTool({
  name: 'get_weather',
  description: 'Look up current weather for a city.',
  schema: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ content: await fetchWeather(city) }),
})

const agent: AgentConfig = {
  name: 'assistant',
  model: 'claude-sonnet-4-6',
  customTools: [weatherTool],
}
```

**Register at runtime** via `agent.addTool(tool)`. Tools added this way are always available, regardless of filtering.

### Tool Output Control

Long tool outputs can blow up conversation size and cost. Two controls work together.

**Truncation.** Cap an individual tool result to a head + tail excerpt with a marker in between:

```typescript
const agent: AgentConfig = {
  // ...
  maxToolOutputChars: 10_000, // applies to every tool this agent runs
}

// Per-tool override (takes priority over AgentConfig.maxToolOutputChars):
const bigQueryTool = defineTool({
  // ...
  maxOutputChars: 50_000,
})
```

**Post-consumption compression.** Once the agent has acted on a tool result, compress older copies in the transcript so they stop costing input tokens on every subsequent turn. Error results are never compressed.

```typescript
const agent: AgentConfig = {
  // ...
  compressToolResults: true,                 // default threshold: 500 chars
  // or: compressToolResults: { minChars: 2_000 }
}
```

### MCP Tools (Model Context Protocol)

`open-multi-agent` can connect to any MCP server and expose its tools directly to agents.

```typescript
import { connectMCPTools } from '@jackchen_me/open-multi-agent/mcp'

const { tools, disconnect } = await connectMCPTools({
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN },
  namePrefix: 'github',
})

// Register each MCP tool in your ToolRegistry, then include their names in AgentConfig.tools
// Don't forget cleanup when done
await disconnect()
```

Notes:
- `@modelcontextprotocol/sdk` is an optional peer dependency, only needed when using MCP.
- Current transport support is stdio.
- MCP input validation is delegated to the MCP server (`inputSchema` is `z.any()`).

See [`integrations/mcp-github`](examples/integrations/mcp-github.ts) for a full runnable setup.

## Context Management

Long-running agents can hit input token ceilings fast. Set `contextStrategy` on `AgentConfig` to control how the conversation shrinks as it grows:

```typescript
const agent: AgentConfig = {
  name: 'long-runner',
  model: 'claude-sonnet-4-6',
  // Pick one:
  contextStrategy: { type: 'sliding-window', maxTurns: 20 },
  // contextStrategy: { type: 'summarize', maxTokens: 80_000, summaryModel: 'claude-haiku-4-5' },
  // contextStrategy: { type: 'compact', maxTokens: 100_000, preserveRecentTurns: 4 },
  // contextStrategy: { type: 'custom', compress: (messages, estimatedTokens, ctx) => ... },
}
```

| Strategy | When to reach for it |
|----------|----------------------|
| `sliding-window` | Cheapest. Keep the last N turns, drop the rest. |
| `summarize` | Send old turns to a summary model; keep the summary in place of the originals. |
| `compact` | Rule-based: truncate large assistant text blocks and tool results, keep recent turns intact. No extra LLM call. |
| `custom` | Supply your own `compress(messages, estimatedTokens, ctx)` function. |

Pairs well with `compressToolResults` and `maxToolOutputChars` above.

## Supported Providers

| Provider | Config | Env var | Status |
|----------|--------|---------|--------|
| Anthropic (Claude) | `provider: 'anthropic'` | `ANTHROPIC_API_KEY` | Verified |
| OpenAI (GPT) | `provider: 'openai'` | `OPENAI_API_KEY` | Verified |
| Grok (xAI)   | `provider: 'grok'` | `XAI_API_KEY` | Verified |
| MiniMax (global) | `provider: 'minimax'` | `MINIMAX_API_KEY` | Verified |
| MiniMax (China) | `provider: 'minimax'` + `MINIMAX_BASE_URL` | `MINIMAX_API_KEY` | Verified |
| DeepSeek | `provider: 'deepseek'` | `DEEPSEEK_API_KEY` | Verified |
| GitHub Copilot | `provider: 'copilot'` | `GITHUB_TOKEN` | Verified |
| Gemini | `provider: 'gemini'` | `GEMINI_API_KEY` | Verified |
| Ollama / vLLM / LM Studio | `provider: 'openai'` + `baseURL` | none | Verified |
| Groq | `provider: 'openai'` + `baseURL` | `GROQ_API_KEY` | Verified |
| llama.cpp server | `provider: 'openai'` + `baseURL` | none | Verified |

Gemini requires `npm install @google/genai` (optional peer dependency).

Verified local models with tool-calling: **Gemma 4** (see [`providers/gemma4-local`](examples/providers/gemma4-local.ts)).

Any OpenAI-compatible API should work via `provider: 'openai'` + `baseURL` (Mistral, Qwen, Moonshot, Doubao, etc.). Groq is now verified in [`providers/groq`](examples/providers/groq.ts). **Grok, MiniMax, and DeepSeek now have first-class support** via `provider: 'grok'`, `provider: 'minimax'`, and `provider: 'deepseek'`.

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

**Troubleshooting:**
- Model not calling tools? Ensure it appears in Ollama's [Tools category](https://ollama.com/search?c=tools). Not all models support tool-calling.
- Using Ollama? Update to the latest version (`ollama update`). Older versions have known tool-calling bugs.
- Proxy interfering? Use `no_proxy=localhost` when running against local servers.

### LLM Configuration Examples

```typescript
const grokAgent: AgentConfig = {
  name: 'grok-agent',
  provider: 'grok',
  model: 'grok-4',
  systemPrompt: 'You are a helpful assistant.',
}
```

(Set your `XAI_API_KEY` environment variable, no `baseURL` needed.)

```typescript
const minimaxAgent: AgentConfig = {
  name: 'minimax-agent',
  provider: 'minimax',
  model: 'MiniMax-M2.7',
  systemPrompt: 'You are a helpful assistant.',
}
```

Set `MINIMAX_API_KEY`. The adapter selects the endpoint via `MINIMAX_BASE_URL`:

- `https://api.minimax.io/v1` Global, default
- `https://api.minimaxi.com/v1` China mainland endpoint

You can also pass `baseURL` directly in `AgentConfig` to override the env var.

```typescript
const deepseekAgent: AgentConfig = {
  name: 'deepseek-agent',
  provider: 'deepseek',
  model: 'deepseek-chat',
  systemPrompt: 'You are a helpful assistant.',
}
```

Set `DEEPSEEK_API_KEY`. Available models: `deepseek-chat` (DeepSeek-V3, recommended for coding) and `deepseek-reasoner` (thinking mode).

## Contributing

Issues, feature requests, and PRs are welcome. Some areas where contributions would be especially valuable:

- **Production examples.** Real-world end-to-end workflows. See [`examples/production/README.md`](./examples/production/README.md) for the acceptance criteria and submission format.
- **Documentation.** Guides, tutorials, and API docs.

## Contributors

<a href="https://github.com/JackChen-me/open-multi-agent/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=JackChen-me/open-multi-agent&max=20&v=20260411" />
</a>

## Star History

<a href="https://star-history.com/#JackChen-me/open-multi-agent&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=JackChen-me/open-multi-agent&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=JackChen-me/open-multi-agent&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=JackChen-me/open-multi-agent&type=Date" />
 </picture>
</a>

## Translations

Help translate this README. [Open a PR](https://github.com/JackChen-me/open-multi-agent/pulls).

## License

MIT
