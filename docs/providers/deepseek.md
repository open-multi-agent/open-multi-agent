# DeepSeek setup guide

DeepSeek V4 models can be used in OMA's TypeScript multi-agent workflows with a simple provider config.

## About DeepSeek V4

DeepSeek V4 is DeepSeek's latest model series, offering both an economical flash variant and a flagship pro variant. Both models support a 1M context window and include a thinking (reasoning) mode.

Legacy `deepseek-chat` and `deepseek-reasoner` model identifiers are mapped to the non-thinking and thinking modes of `deepseek-v4-flash` respectively, and will be fully retired by DeepSeek on **2026-07-24**. New deployments should use `deepseek-v4-flash` or `deepseek-v4-pro`.

## Setup

### Environment variables

```bash
export DEEPSEEK_API_KEY=your-api-key
```

The adapter defaults to the official DeepSeek endpoint (`https://api.deepseek.com/v1`). You can override the base URL if needed (e.g., for proxies):

```bash
export DEEPSEEK_BASE_URL=https://your-proxy.example.com/v1
```

### Agent config

```typescript
const agent: AgentConfig = {
  name: 'my-agent',
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  systemPrompt: 'You are a helpful assistant.',
}
```

Full example:

```typescript
import { OpenMultiAgent, type AgentConfig } from '@open-multi-agent/core'

const agent: AgentConfig = {
  name: 'coder',
  provider: 'deepseek',
  model: 'deepseek-v4-pro',
  systemPrompt: 'Write clean, well-documented TypeScript code.',
  tools: ['bash', 'file_read', 'file_write'],
}

const orchestrator = new OpenMultiAgent()
// Built-in filesystem tools default to a `<cwd>/.agent-workspace` sandbox;
// point the agent at an absolute path inside that root.
const result = await orchestrator.runAgent(
  agent,
  `Create a TypeScript utility module in ${process.cwd()}/.agent-workspace/utils.ts`,
)
console.log(result.output)
```

## Model reference

| Model               | Description                                                |
|---------------------|------------------------------------------------------------|
| `deepseek-v4-flash` | Economical variant, 1M context, supports thinking mode     |
| `deepseek-v4-pro`   | Flagship variant, 1M context, highest capability           |

When using thinking mode, the adapter automatically echoes `reasoning_content` on every intermediate assistant message in tool-calling conversations as required by the DeepSeek API. Non-tool conversations drop reasoning content to avoid context bloat.

## Disclosure

- The DeepSeek adapter is a thin wrapper around the OpenAI adapter, configured with DeepSeek's official endpoint.
- OMA does not bundle an API key — you must provide your own via the `DEEPSEEK_API_KEY` environment variable.
