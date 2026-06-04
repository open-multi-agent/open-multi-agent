# Doubao setup guide

Doubao models by ByteDance (via Volcengine Ark) can be used in OMA's TypeScript multi-agent workflows with a simple provider config.

## About Doubao

Doubao is ByteDance's series of LLMs, accessed through the Volcengine Ark platform. The adapter wraps the OpenAI-compatible Ark endpoint and supports any model available to your Ark API key.

## Setup

### Environment variables

```bash
export ARK_API_KEY=your-api-key
```

The adapter defaults to the official Volcengine Ark endpoint (`https://ark.cn-beijing.volces.com/api/v3`). You can override the base URL if needed (e.g., for proxies or different regions):

```bash
export ARK_BASE_URL=https://your-proxy.example.com/api/v3
```

### Agent config

```typescript
const agent: AgentConfig = {
  name: 'my-agent',
  provider: 'doubao',
  model: 'doubao-seed-1-8-251228',
  systemPrompt: 'You are a helpful assistant.',
}
```

Full example:

```typescript
import { OpenMultiAgent, type AgentConfig } from '@open-multi-agent/core'

const agent: AgentConfig = {
  name: 'translator',
  provider: 'doubao',
  model: 'doubao-seed-1-8-251228',
  systemPrompt: 'Translate text accurately between Chinese and English.',
  tools: ['file_read', 'file_write'],
}

const orchestrator = new OpenMultiAgent()
// Built-in filesystem tools default to a `<cwd>/.agent-workspace` sandbox;
// point the agent at an absolute path inside that root.
const result = await orchestrator.runAgent(
  agent,
  `Translate the file ${process.cwd()}/.agent-workspace/document.txt to English`,
)
console.log(result.output)
```

## Supported models

Use any model identifier available to your Ark API key. Common models include:

| Model                        | Description                          |
|------------------------------|--------------------------------------|
| `doubao-seed-1-8-251228`     | Current recommended seed model       |

Check the [Volcengine Ark documentation](https://www.volcengine.com/docs/82379) for the latest available model IDs.

## Disclosure

- The Doubao adapter is a thin wrapper around the OpenAI adapter, configured with ByteDance Volcengine Ark's official endpoint.
- OMA does not bundle an API key — you must provide your own via the `ARK_API_KEY` environment variable.
