# Qiniu setup guide

Qiniu AI (`api.qnaigc.com`) is an OpenAI-compatible inference endpoint that aggregates multiple model families — DeepSeek, Qwen, Llama, and others — behind a single API key. OMA routes to it via `provider: 'qiniu'`, which pre-configures the base URL to `https://api.qnaigc.com/v1`.

## Setup

### Environment variables

```bash
export QINIU_API_KEY=your-api-key
```

Get an API key from the [Qiniu developer console](https://developer.qiniu.com/aitokenapi/12882/ai-inference-api).

### Agent config

```typescript
const agent: AgentConfig = {
  name: 'my-agent',
  provider: 'qiniu',
  model: 'deepseek-v3',
  systemPrompt: 'You are a helpful assistant.',
}
```

### Full example

```typescript
import { OpenMultiAgent, type AgentConfig } from '@open-multi-agent/core'

const agent: AgentConfig = {
  name: 'analyst',
  provider: 'qiniu',
  model: 'deepseek-v3',
  systemPrompt: 'Analyze data and produce concise reports.',
}

const orchestrator = new OpenMultiAgent({
  defaultProvider: 'qiniu',
  defaultModel: 'deepseek-v3',
})

const result = await orchestrator.runAgent(agent, 'What are the tradeoffs between DeepSeek V3 and R1?')
console.log(result.output)
```

Runnable three-agent example: [`examples/providers/qiniu.ts`](../../examples/providers/qiniu.ts)

## Available models

Qiniu exposes multiple model families. A representative subset:

| Model | Notes |
|-------|-------|
| `deepseek-v3` | DeepSeek Chat V3; good default for coding and reasoning tasks |
| `deepseek-r1` | DeepSeek R1 thinking-mode; emits reasoning blocks via native `<think>` text |
| `qwen-plus` | Qwen family; check the Qiniu catalog for current variant names |
| `llama-3.3-70b-instruct` | Meta Llama 3.3 70B |

See the [Qiniu AI inference catalog](https://developer.qiniu.com/aitokenapi/12882/ai-inference-api) for the full and up-to-date list.
