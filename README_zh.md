# Open Multi-Agent

TypeScript 多智能体编排框架。一次 `runTeam()` 调用从目标到结果——框架自动拆解任务、解析依赖、并行执行。

3 个运行时依赖 · 27 个源文件 · Node.js 能跑的地方都能部署 · 被 [Latent Space](https://www.latent.space/p/ainews-a-quiet-april-fools) AI News 提及（AI 工程领域头部 Newsletter，17 万+订阅者）

[![GitHub stars](https://img.shields.io/github/stars/JackChen-me/open-multi-agent)](https://github.com/JackChen-me/open-multi-agent/stargazers)
[![license](https://img.shields.io/github/license/JackChen-me/open-multi-agent)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue)](https://www.typescriptlang.org/)

[English](./README.md) | **中文**

## 为什么选择 Open Multi-Agent？

- **目标进，结果出** — `runTeam(team, "构建一个 REST API")`。协调者智能体自动将目标拆解为带依赖关系的任务图，分配给对应智能体，独立任务并行执行，最终合成输出。无需手动定义任务或编排流程图。
- **TypeScript 原生** — 为 Node.js 生态而生。`npm install` 即用，无需 Python 运行时、无子进程桥接、无额外基础设施。可嵌入 Express、Next.js、Serverless 函数或 CI/CD 流水线。
- **可审计、极轻量** — 3 个运行时依赖（`@anthropic-ai/sdk`、`openai`、`zod`），27 个源文件。一个下午就能读完全部源码。
- **模型无关** — Claude、GPT、Gemma 4 和本地模型（Ollama、vLLM、LM Studio）可以在同一个团队中使用。通过 `baseURL` 即可接入任何 OpenAI 兼容服务。
- **多智能体协作** — 定义不同角色、工具和模型的智能体，通过消息总线和共享内存协作。
- **结构化输出** — 为任意智能体添加 `outputSchema`（Zod），输出自动解析为 JSON 并校验，校验失败自动重试一次。通过 `result.structured` 获取类型化结果。
- **任务重试** — 为任务设置 `maxRetries`，失败时自动指数退避重试。所有尝试的 token 用量累计，确保计费准确。
- **可观测性** — 可选的 `onTrace` 回调为每次 LLM 调用、工具执行、任务和智能体运行发出结构化 span 事件——包含耗时、token 用量和共享的 `runId` 用于关联追踪。未订阅时零开销，零额外依赖。

## 快速开始

需要 Node.js >= 18。

```bash
npm install @jackchen_me/open-multi-agent
```

在环境变量中设置 `ANTHROPIC_API_KEY`（以及可选的 `OPENAI_API_KEY` 或用于 Copilot 的 `GITHUB_TOKEN`）。通过 Ollama 使用本地模型无需 API key — 参见 [example 06](examples/06-local-model.ts)。

三个智能体，一个目标——框架处理剩下的一切：

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

// 描述一个目标——框架将其拆解为任务并编排执行
const result = await orchestrator.runTeam(team, 'Create a REST API for a todo list in /tmp/todo-api/')

console.log(`成功: ${result.success}`)
console.log(`Token 用量: ${result.totalTokenUsage.output_tokens} output tokens`)
```

执行过程：

```
agent_start coordinator
task_start architect
task_complete architect
task_start developer
task_start developer              // 无依赖的任务并行执行
task_complete developer
task_start reviewer               // 实现完成后自动解锁
task_complete developer
task_complete reviewer
agent_complete coordinator        // 综合所有结果
Success: true
Tokens: 12847 output tokens
```

## 三种运行模式

| 模式 | 方法 | 适用场景 |
|------|------|----------|
| 单智能体 | `runAgent()` | 一个智能体，一个提示词——最简入口 |
| 自动编排团队 | `runTeam()` | 给一个目标，框架自动规划和执行 |
| 显式任务管线 | `runTasks()` | 你自己定义任务图和分配 |

## 示例

所有示例都是可运行脚本，位于 [`examples/`](./examples/) 目录。使用 `npx tsx` 运行：

```bash
npx tsx examples/01-single-agent.ts
```

| 示例 | 展示内容 |
|------|----------|
| [01 — 单智能体](examples/01-single-agent.ts) | `runAgent()` 单次调用、`stream()` 流式输出、`prompt()` 多轮对话 |
| [02 — 团队协作](examples/02-team-collaboration.ts) | `runTeam()` 自动编排 + 协调者模式 |
| [03 — 任务流水线](examples/03-task-pipeline.ts) | `runTasks()` 显式依赖图（设计 → 实现 → 测试 + 评审） |
| [04 — 多模型团队](examples/04-multi-model-team.ts) | `defineTool()` 自定义工具、Anthropic + OpenAI 混合、`AgentPool` |
| [05 — Copilot](examples/05-copilot-test.ts) | GitHub Copilot 作为 LLM 提供者 |
| [06 — 本地模型](examples/06-local-model.ts) | Ollama + Claude 混合流水线，通过 `baseURL` 接入（兼容 vLLM、LM Studio 等） |
| [07 — 扇出聚合](examples/07-fan-out-aggregate.ts) | `runParallel()` MapReduce — 3 个分析师并行，然后综合 |
| [08 — Gemma 4 本地](examples/08-gemma4-local.ts) | `runTasks()` + `runTeam()` 本地 Gemma 4 via Ollama — 零 API 费用 |
| [09 — 结构化输出](examples/09-structured-output.ts) | `outputSchema`（Zod）— 校验 JSON 输出，通过 `result.structured` 获取 |
| [10 — 任务重试](examples/10-task-retry.ts) | `maxRetries` / `retryDelayMs` / `retryBackoff` + `task_retry` 进度事件 |
| [11 — 可观测性](examples/11-trace-observability.ts) | `onTrace` 回调 — LLM 调用、工具、任务、智能体的结构化 span 事件 |

## 架构

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

## 内置工具

| 工具 | 说明 |
|------|------|
| `bash` | 执行 Shell 命令。返回 stdout + stderr。支持超时和工作目录设置。 |
| `file_read` | 读取指定绝对路径的文件内容。支持偏移量和行数限制以处理大文件。 |
| `file_write` | 写入或创建文件。自动创建父目录。 |
| `file_edit` | 通过精确字符串匹配编辑文件。 |
| `grep` | 使用正则表达式搜索文件内容。优先使用 ripgrep，回退到 Node.js 实现。 |

## 支持的 Provider

| Provider | 配置 | 环境变量 | 状态 |
|----------|------|----------|------|
| Anthropic (Claude) | `provider: 'anthropic'` | `ANTHROPIC_API_KEY` | 已验证 |
| OpenAI (GPT) | `provider: 'openai'` | `OPENAI_API_KEY` | 已验证 |
| GitHub Copilot | `provider: 'copilot'` | `GITHUB_TOKEN` | 已验证 |
| Gemini | `provider: 'gemini'` | `GEMINI_API_KEY` | 已验证 |
| Ollama / vLLM / LM Studio | `provider: 'openai'` + `baseURL` | — | 已验证 |

已验证支持 tool-calling 的本地模型：**Gemma 4**（见[示例 08](examples/08-gemma4-local.ts)）。

任何 OpenAI 兼容 API 均可通过 `provider: 'openai'` + `baseURL` 接入（DeepSeek、Groq、Mistral、Qwen、MiniMax 等）。这些 Provider 尚未完整验证——欢迎通过 [#25](https://github.com/JackChen-me/open-multi-agent/issues/25) 贡献验证。

## 参与贡献

欢迎提 Issue、功能需求和 PR。以下方向的贡献尤其有价值：

- **Provider 集成** — 验证并文档化 OpenAI 兼容 Provider（DeepSeek、Groq、Qwen、MiniMax 等）通过 `baseURL` 接入。详见 [#25](https://github.com/JackChen-me/open-multi-agent/issues/25)。对于非 OpenAI 兼容的 Provider（如 Gemini），欢迎贡献新的 `LLMAdapter` 实现——接口只需两个方法：`chat()` 和 `stream()`。
- **示例** — 真实场景的工作流和用例。
- **文档** — 指南、教程和 API 文档。

## 作者

> JackChen — 前 WPS 产品经理，现独立创业者。关注小红书[「杰克西｜硅基杠杆」](https://www.xiaohongshu.com/user/profile/5a1bdc1e4eacab4aa39ea6d6)，持续获取我的 AI Agent 观点和思考。

## 贡献者

<a href="https://github.com/JackChen-me/open-multi-agent/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=JackChen-me/open-multi-agent" />
</a>

## Star 趋势

<a href="https://star-history.com/#JackChen-me/open-multi-agent&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=JackChen-me/open-multi-agent&type=Date&theme=dark&v=20260403" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=JackChen-me/open-multi-agent&type=Date&v=20260403" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=JackChen-me/open-multi-agent&type=Date&v=20260403" />
 </picture>
</a>

## 许可证

MIT
