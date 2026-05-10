# MiniMax setup guide

<img src="../../.github/brand/minimax-banner.png" alt="MiniMax" width="600">

MiniMax M2.7 can be used in OMA's TypeScript multi-agent workflows with a simple provider config.

## Community offer

OMA users get **12% off** the MiniMax Token Plan. Valid until **2026-06-30**.

| Region | Link |
|--------|------|
| Global | [platform.minimax.io](https://platform.minimax.io/subscribe/coding-plan?code=6ZoOY13DDV&source=link) |
| China | [platform.minimaxi.com](https://platform.minimaxi.com/subscribe/token-plan?code=98qruMqQhL&source=link) |

This is a limited-time community offer, not a paid endorsement.

## About MiniMax M2.7

MiniMax describes M2.7 as:

> MiniMax M2.7 is MiniMax's first self-evolution model, capable of autonomously building complex Agent Harnesses and completing high-complexity productivity tasks via Agent Teams, advanced Skills, and Tool Search Tool. It excels in software engineering, end-to-end project delivery, and office scenarios, with stable task execution, environment interaction, and identity-preserving capabilities.

MiniMax 对 M2.7 的描述：

> MiniMax M2.7 是 MiniMax 首个深度参与自我迭代的模型，可自主构建复杂 Agent Harness，并基于 Agent Teams、复杂 Skills、Tool Search Tool 等能力完成高复杂度生产力任务；其在软件工程、端到端项目交付及办公场景中表现优异，多项评测接近行业领先水平，同时具备稳定的复杂任务执行、环境交互能力以及良好的情商与身份保持能力。

## Setup

### Environment variables

```bash
export MINIMAX_API_KEY=your-api-key
```

The adapter defaults to the global endpoint (`https://api.minimax.io/v1`). China users should override the base URL:

```bash
export MINIMAX_BASE_URL=https://api.minimaxi.com/v1
```

### Agent config

```typescript
const agent: AgentConfig = {
  name: 'my-agent',
  provider: 'minimax',
  model: 'MiniMax-M2.7',
  systemPrompt: 'You are a helpful assistant.',
}
```

Full example:

```typescript
import { OpenMultiAgent, type AgentConfig } from '@open-multi-agent/core'

const agent: AgentConfig = {
  name: 'analyst',
  provider: 'minimax',
  model: 'MiniMax-M2.7',
  systemPrompt: 'Analyze data and produce concise reports.',
  tools: ['bash', 'file_read', 'file_write'],
}

const orchestrator = new OpenMultiAgent()
const result = await orchestrator.runAgent(agent, 'Summarize /tmp/report.csv')
console.log(result.output)
```

## Disclosure

- This is a limited-time community offer valid through 2026-06-30.
- Listings are not paid endorsements.
- Some provider offers may include referral credits that help maintain the project.
