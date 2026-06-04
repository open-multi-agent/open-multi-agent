# Grok (xAI) setup guide

Grok models by xAI can be used in OMA's TypeScript multi-agent workflows with a simple provider config.

## About Grok

Grok is xAI's series of frontier LLMs. The adapter wraps the OpenAI-compatible xAI API endpoint and works with the grok-4 model family.

## Setup

### Environment variables

```bash
export XAI_API_KEY=your-api-key
```

The adapter defaults to the official xAI endpoint (`https://api.x.ai/v1`). You can override the base URL if needed (e.g., for proxies):

```bash
export XAI_BASE_URL=https://your-proxy.example.com/v1
```

### Agent config

```typescript
const agent: AgentConfig = {
  name: 'my-agent',
  provider: 'grok',
  model: 'grok-4',
  systemPrompt: 'You are a helpful assistant.',
}
```

Full example:

```typescript
import { OpenMultiAgent, type AgentConfig } from '@open-multi-agent/core'

const agent: AgentConfig = {
  name: 'researcher',
  provider: 'grok',
  model: 'grok-4',
  systemPrompt: 'Research topics and produce detailed reports.',
  tools: ['bash', 'file_read', 'file_write'],
}

const orchestrator = new OpenMultiAgent()
// Built-in filesystem tools default to a `<cwd>/.agent-workspace` sandbox;
// point the agent at an absolute path inside that root.
const result = await orchestrator.runAgent(
  agent,
  `Summarize the file ${process.cwd()}/.agent-workspace/report.csv`,
)
console.log(result.output)
```

## Supported models

Any model available through the xAI API can be used. Set the `model` field on your agent config to the desired model name (e.g., `grok-4` or future model identifiers).

## Disclosure

- The Grok adapter is a thin wrapper around the OpenAI adapter, configured with xAI's official endpoint.
- OMA does not bundle an API key — you must provide your own via the `XAI_API_KEY` environment variable.
