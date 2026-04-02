# Open Multi-Agent

Open Multi-Agent is an open-source multi-agent orchestration framework. Build autonomous AI agent teams that can collaborate, communicate, schedule tasks with dependencies, and execute complex multi-step workflows — all model-agnostic.

Unlike single-agent SDKs like `@anthropic-ai/claude-agent-sdk` which run one agent per process, Open Multi-Agent orchestrates **multiple specialized agents** working together in-process — deploy anywhere: cloud servers, serverless functions, Docker containers, CI/CD pipelines.

[![npm version](https://img.shields.io/npm/v/open-multi-agent)](https://www.npmjs.com/package/open-multi-agent)
[![license](https://img.shields.io/npm/l/open-multi-agent)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue)](https://www.typescriptlang.org/)

## Features

- **Multi-Agent Teams** — Create teams of specialized agents that collaborate toward a shared goal
- **Automatic Orchestration** — Describe a goal in plain English; the framework decomposes it into tasks and assigns them
- **Task Dependencies** — Define tasks with `dependsOn` chains; the `TaskQueue` resolves them topologically
- **Inter-Agent Communication** — Agents message each other via `MessageBus` and share knowledge through `SharedMemory`
- **Model Agnostic** — Works with Anthropic Claude, OpenAI GPT, or any custom `LLMAdapter`
- **Tool Framework** — Define custom tools with Zod schemas, or use 5 built-in tools (bash, file_read, file_write, file_edit, grep)
- **Parallel Execution** — Independent tasks run concurrently with configurable `maxConcurrency`
- **4 Scheduling Strategies** — Round-robin, least-busy, capability-match, dependency-first
- **Streaming** — Stream incremental text deltas from any agent via `AsyncGenerator<StreamEvent>`
- **Full Type Safety** — Strict TypeScript with Zod validation throughout

## Quick Start

```bash
npm install open-multi-agent
```

```typescript
import { OpenMultiAgent } from 'open-multi-agent'

const orchestrator = new OpenMultiAgent({ defaultModel: 'claude-sonnet-4-6' })

// One agent, one task
const result = await orchestrator.runAgent(
  {
    name: 'coder',
    model: 'claude-sonnet-4-6',
    tools: ['bash', 'file_write'],
  },
  'Write a TypeScript function that reverses a string, save it to /tmp/reverse.ts, and run it.',
)

console.log(result.output)
```

Set `ANTHROPIC_API_KEY` (and optionally `OPENAI_API_KEY`) in your environment before running.

## Usage

### Multi-Agent Team

```typescript
import { OpenMultiAgent } from 'open-multi-agent'
import type { AgentConfig } from 'open-multi-agent'

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

### Task Pipeline

Use `runTasks()` when you want explicit control over the task graph and assignments:

```typescript
const result = await orchestrator.runTasks(team, [
  {
    title: 'Design the data model',
    description: 'Write a TypeScript interface spec to /tmp/spec.md',
    assignee: 'architect',
  },
  {
    title: 'Implement the module',
    description: 'Read /tmp/spec.md and implement the module in /tmp/src/',
    assignee: 'developer',
    dependsOn: ['Design the data model'], // blocked until design completes
  },
  {
    title: 'Write tests',
    description: 'Read the implementation and write Vitest tests.',
    assignee: 'developer',
    dependsOn: ['Implement the module'],
  },
  {
    title: 'Review code',
    description: 'Review /tmp/src/ and produce a structured code review.',
    assignee: 'reviewer',
    dependsOn: ['Implement the module'], // can run in parallel with tests
  },
])
```

### Custom Tools

```typescript
import { z } from 'zod'
import { defineTool, Agent, ToolRegistry, ToolExecutor, registerBuiltInTools } from 'open-multi-agent'

const searchTool = defineTool({
  name: 'web_search',
  description: 'Search the web and return the top results.',
  inputSchema: z.object({
    query: z.string().describe('The search query.'),
    maxResults: z.number().optional().describe('Number of results (default 5).'),
  }),
  execute: async ({ query, maxResults = 5 }) => {
    const results = await mySearchProvider(query, maxResults)
    return { data: JSON.stringify(results), isError: false }
  },
})

const registry = new ToolRegistry()
registerBuiltInTools(registry)
registry.register(searchTool)

const executor = new ToolExecutor(registry)
const agent = new Agent(
  { name: 'researcher', model: 'claude-sonnet-4-6', tools: ['web_search'] },
  registry,
  executor,
)

const result = await agent.run('Find the three most recent TypeScript releases.')
```

### Multi-Model Teams

```typescript
const claudeAgent: AgentConfig = {
  name: 'strategist',
  model: 'claude-opus-4-6',
  provider: 'anthropic',
  systemPrompt: 'You plan high-level approaches.',
  tools: ['file_write'],
}

const gptAgent: AgentConfig = {
  name: 'implementer',
  model: 'gpt-5.4',
  provider: 'openai',
  systemPrompt: 'You implement plans as working code.',
  tools: ['bash', 'file_read', 'file_write'],
}

const team = orchestrator.createTeam('mixed-team', {
  name: 'mixed-team',
  agents: [claudeAgent, gptAgent],
  sharedMemory: true,
})

const result = await orchestrator.runTeam(team, 'Build a CLI tool that converts JSON to CSV.')
```

### Local Ollama Support

```typescript
const orchestrator = new OpenMultiAgent({
  defaultProvider: 'ollama',
  defaultModel: 'llama2',
})

const localAgent: AgentConfig = {
  name: 'assistant',
  model: 'llama2',
  provider: 'ollama',
  systemPrompt: 'You are a local assistant running on Ollama.',
  tools: ['bash', 'file_read', 'file_write'],
}

const team = orchestrator.createTeam('local-team', {
  name: 'local-team',
  agents: [localAgent],
  sharedMemory: true,
})

const result = await orchestrator.runTeam(team, 'Create a small script that lists files in the current directory.')
```

Set `OLLAMA_API_KEY` when your local Ollama instance requires authentication. The adapter defaults to `http://localhost:11434`.

### Streaming Output

```typescript
import { Agent, ToolRegistry, ToolExecutor, registerBuiltInTools } from 'open-multi-agent'

const registry = new ToolRegistry()
registerBuiltInTools(registry)
const executor = new ToolExecutor(registry)

const agent = new Agent(
  { name: 'writer', model: 'claude-sonnet-4-6', maxTurns: 3 },
  registry,
  executor,
)

for await (const event of agent.stream('Explain monads in two sentences.')) {
  if (event.type === 'text' && typeof event.data === 'string') {
    process.stdout.write(event.data)
  }
}
```

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

## Design Inspiration

The architecture draws from common multi-agent orchestration patterns seen in modern AI coding tools.

| Pattern | open-multi-agent | What it does |
|---------|-----------------|--------------|
| Conversation loop | `AgentRunner` | Drives the model → tool → model turn loop |
| Tool definition | `defineTool()` | Typed tool definition with Zod validation |
| Coordinator | `OpenMultiAgent` | Decomposes goals, assigns tasks, manages concurrency |
| Team / sub-agent | `Team` + `MessageBus` | Inter-agent communication and shared state |
| Task scheduling | `TaskQueue` | Topological task scheduling with dependency resolution |

## License

MIT
