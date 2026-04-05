# Open Multi-Agent

TypeScript framework for multi-agent orchestration. One `runTeam()` call from goal to result — the framework decomposes it into tasks, resolves dependencies, and runs agents in parallel.

3 runtime dependencies · 27 source files · Deploys anywhere Node.js runs · Mentioned in [Latent Space](https://www.latent.space/p/ainews-a-quiet-april-fools) AI News

[![GitHub stars](https://img.shields.io/github/stars/JackChen-me/open-multi-agent)](https://github.com/JackChen-me/open-multi-agent/stargazers)
[![license](https://img.shields.io/github/license/JackChen-me/open-multi-agent)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue)](https://www.typescriptlang.org/)

**English** | [中文](./README_zh.md)

## Why Open Multi-Agent?

- **Goal In, Result Out** — `runTeam(team, "Build a REST API")`. A coordinator agent auto-decomposes the goal into a task DAG with dependencies and assignees, runs independent tasks in parallel, and synthesizes the final output. No manual task definitions or graph wiring required.
- **TypeScript-Native** — Built for the Node.js ecosystem. `npm install`, import, run. No Python runtime, no subprocess bridge, no sidecar services. Embed in Express, Next.js, serverless functions, or CI/CD pipelines.
- **Auditable and Lightweight** — 3 runtime dependencies (`@anthropic-ai/sdk`, `openai`, `zod`). 27 source files. The entire codebase is readable in an afternoon.
- **Model Agnostic** — Claude, GPT, Gemma 4, and local models (Ollama, vLLM, LM Studio, llama.cpp server) in the same team. Swap models per agent via `baseURL`.
- **Multi-Agent Collaboration** — Agents with different roles, tools, and models collaborate through a message bus and shared memory.
- **Structured Output** — Add `outputSchema` (Zod) to any agent. Output is parsed as JSON, validated, and auto-retried once on failure. Access typed results via `result.structured`.
- **Task Retry** — Set `maxRetries` on tasks for automatic retry with exponential backoff. Failed attempts accumulate token usage for accurate billing.
- **Observability** — Optional `onTrace` callback emits structured spans for every LLM call, tool execution, task, and agent run — with timing, token usage, and a shared `runId` for correlation. Zero overhead when not subscribed, zero extra dependencies.

## Quick Start

Requires Node.js >= 18.

```bash
npm install @jackchen_me/open-multi-agent
```

Set the API key for your provider. Local models via Ollama require no API key — see [example 06](examples/06-local-model.ts).

- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `GEMINI_API_KEY`
- `GITHUB_TOKEN` (for Copilot)

Three agents, one goal — the framework handles the rest:

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
  systemPrompt: 'You implement what the architect designs.',
  tools: ['bash', 'file_read', 'file_write', 'file_edit'],
}

const reviewer: AgentConfig = {
  name: 'reviewer',
  model: 'claude-sonnet-4-6',
  systemPrompt: 'You review code for correctness and clarity.',
  tools: ['file_read', 'grep'],
}

const orchestrator = new OpenMultiAgent({
  defaultModel: 'claude-sonnet-4-6',
  onProgress: (event) => console.log(event.type, event.agent ?? event.task ?? ''),
})

const team = orchestrator.createTeam('api-team', {
  name: 'api-team',
  agents: [architect, developer, reviewer],
  sharedMemory: true,
})

// Describe a goal — the framework breaks it into tasks and orchestrates execution
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
task_start reviewer               // unblocked after implementation
task_complete developer
task_complete reviewer
agent_complete coordinator        // synthesizes final result
Success: true
Tokens: 12847 output tokens
```

## Three Ways to Run

| Mode | Method | When to use |
|------|--------|-------------|
| Single agent | `runAgent()` | One agent, one prompt — simplest entry point |
| Auto-orchestrated team | `runTeam()` | Give a goal, framework plans and executes |
| Explicit pipeline | `runTasks()` | You define the task graph and assignments |

## Examples

All examples are runnable scripts in [`examples/`](./examples/). Run any of them with `npx tsx`:

```bash
npx tsx examples/01-single-agent.ts
```

| Example | What it shows |
|---------|---------------|
| [01 — Single Agent](examples/01-single-agent.ts) | `runAgent()` one-shot, `stream()` streaming, `prompt()` multi-turn |
| [02 — Team Collaboration](examples/02-team-collaboration.ts) | `runTeam()` auto-orchestration with coordinator pattern |
| [03 — Task Pipeline](examples/03-task-pipeline.ts) | `runTasks()` explicit dependency graph (design → implement → test + review) |
| [04 — Multi-Model Team](examples/04-multi-model-team.ts) | `defineTool()` custom tools, mixed Anthropic + OpenAI providers, `AgentPool` |
| [05 — Copilot](examples/05-copilot-test.ts) | GitHub Copilot as an LLM provider |
| [06 — Local Model](examples/06-local-model.ts) | Ollama + Claude in one pipeline via `baseURL` (works with vLLM, LM Studio, etc.) |
| [07 — Fan-Out / Aggregate](examples/07-fan-out-aggregate.ts) | `runParallel()` MapReduce — 3 analysts in parallel, then synthesize |
| [08 — Gemma 4 Local](examples/08-gemma4-local.ts) | `runTasks()` + `runTeam()` with local Gemma 4 via Ollama — zero API cost |
| [09 — Structured Output](examples/09-structured-output.ts) | `outputSchema` (Zod) on AgentConfig — validated JSON via `result.structured` |
| [10 — Task Retry](examples/10-task-retry.ts) | `maxRetries` / `retryDelayMs` / `retryBackoff` with `task_retry` progress events |
| [11 — Trace Observability](examples/11-trace-observability.ts) | `onTrace` callback — structured spans for LLM calls, tools, tasks, and agents |
| [12 — Grok](examples/12-grok.ts) | Same as example 02 (`runTeam()` collaboration) with Grok (`XAI_API_KEY`) |

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
         │               └──────────────────────┘
┌────────▼──────────┐
│  AgentRunner      │    ┌──────────────────────┐
│  - conversation   │───►│  ToolRegistry        │
│    loop           │    │  - defineTool()      │
│  - tool dispatch  │    │  - 5 built-in tools  │
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

## Supported Providers

| Provider | Config | Env var | Status |
|----------|--------|---------|--------|
| Anthropic (Claude) | `provider: 'anthropic'` | `ANTHROPIC_API_KEY` | Verified |
| OpenAI (GPT) | `provider: 'openai'` | `OPENAI_API_KEY` | Verified |
| Grok (xAI)   | `provider: 'grok'` | `XAI_API_KEY` | Verified |
| GitHub Copilot | `provider: 'copilot'` | `GITHUB_TOKEN` | Verified |
| Gemini | `provider: 'gemini'` | `GEMINI_API_KEY` | Verified |
| Ollama / vLLM / LM Studio | `provider: 'openai'` + `baseURL` | — | Verified |
| llama.cpp server | `provider: 'openai'` + `baseURL` | — | Verified |

Verified local models with tool-calling: **Gemma 4** (see [example 08](examples/08-gemma4-local.ts)).

Any OpenAI-compatible API should work via `provider: 'openai'` + `baseURL` (DeepSeek, Groq, Mistral, Qwen, MiniMax, etc.). **Grok now has first-class support** via `provider: 'grok'`.

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
- Using Ollama? Update to the latest version (`ollama update`) — older versions have known tool-calling bugs.
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

(Set your `XAI_API_KEY` environment variable — no `baseURL` needed anymore.)

## Contributing

Issues, feature requests, and PRs are welcome. Some areas where contributions would be especially valuable:

- **Provider integrations** — Verify and document OpenAI-compatible providers (DeepSeek, Groq, Qwen, MiniMax, etc.) via `baseURL`. See [#25](https://github.com/JackChen-me/open-multi-agent/issues/25). For providers that are NOT OpenAI-compatible (e.g. Gemini), a new `LLMAdapter` implementation is welcome — the interface requires just two methods: `chat()` and `stream()`.
- **Examples** — Real-world workflows and use cases.
- **Documentation** — Guides, tutorials, and API docs.

## Author

> JackChen — Ex PM (¥100M+ revenue), now indie builder. Follow on [X](https://x.com/JackChen_x) for AI Agent insights.

## Contributors

<a href="https://github.com/JackChen-me/open-multi-agent/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=JackChen-me/open-multi-agent" />
</a>

## Star History

<a href="https://star-history.com/#JackChen-me/open-multi-agent&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=JackChen-me/open-multi-agent&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=JackChen-me/open-multi-agent&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=JackChen-me/open-multi-agent&type=Date" />
 </picture>
</a>

## License

MIT
