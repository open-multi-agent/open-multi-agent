# Azure OpenAI setup guide

Azure OpenAI Service hosts OpenAI models (GPT-4, GPT-4o, o-series, etc.) on Azure infrastructure. OMA routes to it via the `'azure-openai'` provider shortcut, which handles Azure's endpoint + deployment-name URL structure automatically.

## Setup

### Environment variables

```bash
export AZURE_OPENAI_API_KEY=your-api-key
export AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
```

Two optional overrides:

```bash
export AZURE_OPENAI_API_VERSION=2024-10-21   # defaults to 2024-10-21
export AZURE_OPENAI_DEPLOYMENT=gpt-4          # fallback deployment when model is blank
```

### Agent config

```typescript
const agent: AgentConfig = {
  name: 'my-agent',
  provider: 'azure-openai',
  model: 'gpt-4',           // your Azure deployment name, not the underlying model name
  systemPrompt: 'You are a helpful assistant.',
}
```

> **Important:** The `model` field must contain your Azure **deployment name**, not the underlying model name. If you deployed GPT-4 with the name `"my-gpt4-prod"`, use `model: 'my-gpt4-prod'`. Find deployment names in the Azure Portal under **Azure OpenAI → Your Resource → Model deployments**.

### Full example

```typescript
import { OpenMultiAgent, type AgentConfig } from '@open-multi-agent/core'

const agent: AgentConfig = {
  name: 'analyst',
  provider: 'azure-openai',
  model: 'gpt-4',           // your deployment name
  systemPrompt: 'Analyze data and produce concise reports.',
}

const orchestrator = new OpenMultiAgent({
  defaultProvider: 'azure-openai',
  defaultModel: 'gpt-4',
})

const result = await orchestrator.runAgent(agent, 'Summarize the current state of AI regulation in the EU.')
console.log(result.output)
```

Runnable three-agent example: [`examples/providers/azure-openai.ts`](../../examples/providers/azure-openai.ts)

## Available models

Any model you have deployed in your Azure resource. Common deployments:

| Deployment (example names) | Underlying model |
|---------------------------|-----------------|
| `gpt-4`, `gpt-4-prod` | GPT-4 |
| `gpt-4o`, `gpt-4o-mini` | GPT-4o / GPT-4o mini |
| `o3`, `o3-mini` | o3 / o3-mini (reasoning) |

Deployment names are chosen by you at creation time — they do not have to match the underlying model name.
