# Atlas Cloud setup guide

Atlas Cloud is a full-modal AI inference platform that gives developers a single AI API to access video generation, image generation, and LLM APIs. Instead of managing multiple vendor integrations, you connect once and get unified access to 300+ curated models across all modalities.

Atlas Cloud 是一个全模态 AI 推理平台，通过单一 API 为开发者提供视频生成、图像生成及 LLM 接入。免去繁琐的多供应商对接，一次连接即可调用 300+ 款全模态精选模型。

## OMA user vouchers

20 limited vouchers ($5 each) available to OMA users on a first-come-first-serve basis.

**How to apply**: Email [jack@yuanasi.com](mailto:jack@yuanasi.com) with your GitHub username and a one-line use case. We'll reply with a voucher code by email (limited supply).

Disclosure: Sponsorship from Atlas Cloud; vouchers are limited and don't constitute paid endorsement of any model or feature.

### OMA 用户专属兑换码

OMA 用户可申请 20 张 $5 兑换码（先到先得）。

**申请方式**：邮件 [jack@yuanasi.com](mailto:jack@yuanasi.com)，附 GitHub 用户名 + 一句话用途。我们会邮件回复 code（数量有限）。

声明：赞助来自 Atlas Cloud；兑换码数量有限，不构成对任何模型或功能的付费背书。

## Setup

Atlas Cloud exposes an OpenAI-compatible Chat Completions API ("a drop-in replacement for the OpenAI SDK"), so OMA connects to it through the built-in `openai` provider with a custom `baseURL`. This is the same pattern OMA uses for OpenRouter, Groq, Mistral, and the other OpenAI-compatible endpoints in [Providers](../providers.md).

### Environment variable

Create an API key from the [Atlas Cloud console](https://www.atlascloud.ai/console/coding-plan), then export it:

```bash
export ATLASCLOUD_API_KEY=your-api-key
```

`ATLASCLOUD_API_KEY` is the variable name Atlas Cloud uses in its own documentation. OMA's OpenAI-compatible setup reads it in your code and passes it to `apiKey`.

### Agent config

Because the credential is not `OPENAI_API_KEY`, pass it explicitly via `apiKey`; the `openai` adapter otherwise falls back to `OPENAI_API_KEY`.

```typescript
import { OpenMultiAgent, type AgentConfig } from '@open-multi-agent/core'

const agent: AgentConfig = {
  name: 'analyst',
  provider: 'openai',
  baseURL: 'https://api.atlascloud.ai/v1',
  apiKey: process.env.ATLASCLOUD_API_KEY,
  model: 'deepseek-v3', // pick a current ID from the model library
  systemPrompt: 'Analyze data and produce concise reports.',
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

Atlas Cloud serves hundreds of models across LLM, image, and video modalities; OMA orchestrates the text LLMs. The catalog changes often, so treat Atlas Cloud's own listing as the source of truth instead of pinning versions here. Browse the [model library](https://www.atlascloud.ai/models/llm) for the current catalog and copy a model's exact ID string into the `model` field.

Current families include DeepSeek, Qwen (Alibaba), Kimi (MoonshotAI), GLM (Zhipu), MiniMax, Doubao (ByteDance), and Grok (xAI), alongside hosted Claude and Gemini.

Because Atlas Cloud serves every model behind one OpenAI-compatible endpoint, a single Atlas Cloud key lets an OMA team mix model families across agents, including hosted Claude and Gemini, through the same `provider: 'openai'` + `baseURL` setup above, with no per-vendor wiring.

Atlas Cloud's image and video generation models are not text LLMs and are outside OMA's agent-orchestration scope.

## Native adapter

Atlas Cloud native adapter is **available if Atlas Cloud submits an adapter PR** following OMA's existing provider patterns (see `src/llm/minimax.ts` for reference). Until then, use the OpenAI-compatible setup above.

## Disclosure

- Atlas Cloud is a paid sponsor of `open-multi-agent`. Sponsorship does not affect technical decisions or model recommendations.
- Vouchers are limited and do not constitute a paid endorsement of any model or feature.
