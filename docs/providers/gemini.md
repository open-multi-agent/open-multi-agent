# Gemini setup guide

Google Gemini is OMA's only non-OpenAI-compatible first-class adapter — it uses the official `@google/genai` SDK directly so native features (Gemini 2.5 thinking blocks, `thoughtSignature` round-tripping, grounding) work without transcoding through OpenAI's wire format.

## Setup

### Prerequisites

Gemini is an optional peer dependency. Install the SDK before use:

```bash
npm install @google/genai
```

### Environment variables

```bash
export GEMINI_API_KEY=your-api-key
```

Get an API key at [Google AI Studio](https://aistudio.google.com/apikey).

### Agent config

```typescript
const agent: AgentConfig = {
  name: 'my-agent',
  provider: 'gemini',
  model: 'gemini-2.5-flash',
  systemPrompt: 'You are a helpful assistant.',
}
```

### Full example

```typescript
import { OpenMultiAgent, type AgentConfig } from '@open-multi-agent/core'

const agent: AgentConfig = {
  name: 'analyst',
  provider: 'gemini',
  model: 'gemini-2.5-flash',
  systemPrompt: 'Analyze data and produce concise reports.',
}

const orchestrator = new OpenMultiAgent({
  defaultProvider: 'gemini',
  defaultModel: 'gemini-2.5-flash',
})

const result = await orchestrator.runAgent(agent, 'Explain the tradeoffs between Gemini 2.5 Pro and Flash.')
console.log(result.output)
```

Runnable three-agent example: [`examples/providers/gemini.ts`](../../examples/providers/gemini.ts)

## Available models

| Model | Notes |
|-------|-------|
| `gemini-2.5-flash` | Fast and cost-efficient; recommended default |
| `gemini-2.5-pro` | More capable; higher latency and cost; larger context |

See the [Gemini API model catalog](https://ai.google.dev/gemini-api/docs/models) for the full list including experimental and multimodal variants.

## Reasoning (thinking) support

Gemini 2.5 models support native thinking blocks. OMA round-trips `thoughtSignature` fields across multi-turn conversations so reasoning state is preserved within the same provider. Cross-provider reasoning preservation requires `AgentConfig.preserveReasoningAsText: true` (see [context-management.md](../context-management.md)).
