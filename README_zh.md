# Open Multi-Agent

TypeScript 里的轻量多智能体编排引擎。3 个运行时依赖，零配置，一次 `runTeam()` 从目标拿到结果。

CrewAI 是 Python。LangGraph 要你自己画图。`open-multi-agent` 是你现有 Node.js 后端里 `npm install` 一下就能用的那一层：一支 agent 团队围绕一个目标协作，就这些。

[![GitHub stars](https://img.shields.io/github/stars/JackChen-me/open-multi-agent)](https://github.com/JackChen-me/open-multi-agent/stargazers)
[![license](https://img.shields.io/github/license/JackChen-me/open-multi-agent)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue)](https://www.typescriptlang.org/)
[![coverage](https://img.shields.io/badge/coverage-85%25-brightgreen)](https://github.com/JackChen-me/open-multi-agent/actions)

[English](./README.md) | **中文**

## 核心能力

- `runTeam(team, "构建一个 REST API")` 下去，协调者 agent 会把目标拆成任务 DAG，独立任务并行跑，再把结果合起来。不用画图，不用手动连依赖。
- 运行时依赖就三个：`@anthropic-ai/sdk`、`openai`、`zod`。能直接塞进 Express、Next.js、Serverless 或 CI/CD，不起 Python 进程，也不跑云端 sidecar。
- 同一个团队里的 agent 能挂不同模型：架构师用 Opus 4.6、开发用 GPT-5.4、评审跑本地 Gemma 4 都行。支持 Claude、GPT、Gemini、Grok、MiniMax、DeepSeek、Copilot，以及 OpenAI 兼容的本地模型（Ollama、vLLM、LM Studio、llama.cpp）。用 Gemini 要额外装 `@google/genai`。

还有 MCP、上下文策略、结构化输出、任务重试、human-in-the-loop、生命周期 hook、循环检测、可观测性等，下面章节或 [`examples/`](./examples/) 里都有。

## 做什么，不做什么

**做的事：**
- 一个协调者，把目标拆成任务 DAG。
- 一个任务队列，独立任务并行跑，失败级联到下游。
- 共享内存和消息总线，让 agent 之间能看到彼此的输出。
- 多模型团队，每个 agent 可以挂不同的 LLM provider。

**不做的事：**
- **Agent handoffs**：agent A 对话中途把控制权交给 agent B 这种模式不做。要这个用 [OpenAI Agents SDK](https://github.com/openai/openai-agents-python)。我们这边一个 agent 从头到尾负责一个任务。
- **状态持久化 / 检查点**：暂时不做。加存储后端会破坏 3 个依赖的承诺，而且我们的工作流是秒到分钟级，不是小时级。真有长时间工作流的需求再说。

A2A 协议在跟踪，观望中，等有人真用再跟。

完整理由见 [`DECISIONS.md`](./DECISIONS.md)。

## 和其他框架怎么选

如果你在看 [LangGraph JS](https://github.com/langchain-ai/langgraphjs)：它是声明式图编排，自己定义节点、边、路由，`compile()` + `invoke()`。`open-multi-agent` 反过来，目标驱动：给一个团队和一个目标，协调者在运行时拆 DAG。想完全控拓扑、流程定下来的用 LangGraph；想写得少、迭代快、还在探索的选这个。LangGraph 有成熟 checkpoint，我们没做。

Python 栈直接用 [CrewAI](https://github.com/crewAIInc/crewAI) 就行，编排层能力差不多。`open-multi-agent` 的定位是 TypeScript 原生：3 个依赖、直接进 Node.js、不用子进程桥接。按语言选。

和 [Vercel AI SDK](https://github.com/vercel/ai) 不冲突。AI SDK 是 LLM 调用层，统一的 TypeScript 客户端，60+ provider，带流式、tool call、结构化输出，但不做多智能体编排。要多 agent，把 `open-multi-agent` 叠在 AI SDK 上面就行。单 agent 用 AI SDK，多 agent 用这个。

## 谁在用

项目 2026-04-01 发布，目前 5,500+ stars，MIT 协议。目前能确认在用的：

- **[temodar-agent](https://github.com/xeloxa/temodar-agent)**（约 50 stars）。WordPress 安全分析平台，作者 [Ali Sünbül](https://github.com/xeloxa)。在 Docker runtime 里直接用我们的内置工具（`bash`、`file_*`、`grep`）。已确认生产环境使用。
- **家用服务器 Cybersecurity SOC。** 本地完全离线跑 Qwen 2.5 + DeepSeek Coder（通过 Ollama），在 Wazuh + Proxmox 上搭自主 SOC 流水线。早期用户，未公开。

如果你在生产或 side project 里用了 `open-multi-agent`，[请开个 Discussion](https://github.com/JackChen-me/open-multi-agent/discussions)，我加上来。

## 快速开始

需要 Node.js >= 18。

```bash
npm install @jackchen_me/open-multi-agent
```

根据用的 provider 设对应 API key。通过 Ollama 跑本地模型不用 key，见 [`providers/ollama`](examples/providers/ollama.ts)。

- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `GEMINI_API_KEY`
- `XAI_API_KEY`（Grok）
- `MINIMAX_API_KEY`（MiniMax）
- `MINIMAX_BASE_URL`（MiniMax，可选，选接入端点）
- `DEEPSEEK_API_KEY`（DeepSeek）
- `GITHUB_TOKEN`（Copilot）

包里还自带一个叫 `oma` 的命令行工具，给 shell 和 CI 场景用，输出都是 JSON。`oma run`、`oma task`、`oma provider`、退出码、文件格式都在 [docs/cli.md](./docs/cli.md) 里。

下面用三个 agent 协作做一个 REST API：

```typescript
import { OpenMultiAgent } from '@jackchen_me/open-multi-agent'
import type { AgentConfig } from '@jackchen_me/open-multi-agent'

const architect: AgentConfig = {
  name: 'architect',
  model: 'claude-sonnet-4-6',
  systemPrompt: 'You design clean API contracts and file structures.',
  tools: ['file_write'],
}

const developer: AgentConfig = { /* 同样结构，tools: ['bash', 'file_read', 'file_write', 'file_edit'] */ }
const reviewer: AgentConfig = { /* 同样结构，tools: ['file_read', 'grep'] */ }

const orchestrator = new OpenMultiAgent({
  defaultModel: 'claude-sonnet-4-6',
  onProgress: (event) => console.log(event.type, event.agent ?? event.task ?? ''),
})

const team = orchestrator.createTeam('api-team', {
  name: 'api-team',
  agents: [architect, developer, reviewer],
  sharedMemory: true,
})

// 描述一个目标，框架负责拆解成任务并编排执行
const result = await orchestrator.runTeam(team, 'Create a REST API for a todo list in /tmp/todo-api/')

console.log(`Success: ${result.success}`)
console.log(`Tokens: ${result.totalTokenUsage.output_tokens} output tokens`)
```

执行过程：

```
agent_start coordinator
task_start architect
task_complete architect
task_start developer
task_start developer              // 无依赖的任务并行执行
task_complete developer
task_complete developer
task_start reviewer               // 实现完成后自动解锁
task_complete reviewer
agent_complete coordinator        // 综合所有结果
Success: true
Tokens: 12847 output tokens
```

## 三种运行模式

| 模式 | 方法 | 适用场景 |
|------|------|----------|
| 单智能体 | `runAgent()` | 一个智能体，一个提示词，最简入口 |
| 自动编排团队 | `runTeam()` | 给一个目标，框架自动规划和执行 |
| 显式任务管线 | `runTasks()` | 你自己定义任务图和分配 |

要 MapReduce 风格的 fan-out 但不需要任务依赖，直接用 `AgentPool.runParallel()`。例子见 [`patterns/fan-out-aggregate`](examples/patterns/fan-out-aggregate.ts)。

## 示例

[`examples/`](./examples/) 按类别分了 basics、providers、patterns、integrations、production。完整索引见 [`examples/README.md`](./examples/README.md)，几个值得先看的：

- [`basics/team-collaboration`](examples/basics/team-collaboration.ts)：`runTeam()` 协调者模式。
- [`patterns/structured-output`](examples/patterns/structured-output.ts)：任意 agent 产出 Zod 校验过的 JSON。
- [`patterns/agent-handoff`](examples/patterns/agent-handoff.ts)：`delegate_to_agent` 同步子智能体委派。
- [`integrations/trace-observability`](examples/integrations/trace-observability.ts)：`onTrace` 回调，给 LLM 调用、工具、任务发结构化 span。
- [`integrations/mcp-github`](examples/integrations/mcp-github.ts)：用 `connectMCPTools()` 把 MCP 服务器的工具暴露给 agent。
- [`integrations/with-vercel-ai-sdk`](examples/integrations/with-vercel-ai-sdk/)：Next.js 应用，OMA `runTeam()` 配合 AI SDK `useChat` 流式输出。
- **Provider 示例**：8 个三智能体团队示例，每个 provider 一个，见 [`examples/providers/`](examples/providers/)。

跑脚本用 `npx tsx examples/basics/team-collaboration.ts`。

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
         │               │  - GrokAdapter       │
         │               │  - MiniMaxAdapter    │
         │               │  - DeepSeekAdapter   │
         │               └──────────────────────┘
┌────────▼──────────┐
│  AgentRunner      │    ┌──────────────────────┐
│  - conversation   │───►│  ToolRegistry        │
│    loop           │    │  - defineTool()      │
│  - tool dispatch  │    │  - 6 built-in tools  │
└───────────────────┘    └──────────────────────┘
```

## 内置工具

| 工具 | 说明 |
|------|------|
| `bash` | 跑 Shell 命令。返回 stdout + stderr。支持超时和工作目录设置。 |
| `file_read` | 按绝对路径读文件。支持偏移量和行数限制，能读大文件。 |
| `file_write` | 写入或创建文件。自动创建父目录。 |
| `file_edit` | 按精确字符串匹配改文件。 |
| `grep` | 用正则搜文件内容。优先走 ripgrep，没有就 fallback 到 Node.js。 |
| `glob` | 按 glob 模式查找文件。返回按修改时间排序的匹配路径。 |

## 工具配置

三层叠起来用：preset（预设）、tools（白名单）、disallowedTools（黑名单）。

### 工具预设

三种内置 preset：

```typescript
const readonlyAgent: AgentConfig = {
  name: 'reader',
  model: 'claude-sonnet-4-6',
  toolPreset: 'readonly',  // file_read, grep, glob
}

const readwriteAgent: AgentConfig = {
  name: 'editor',
  model: 'claude-sonnet-4-6',
  toolPreset: 'readwrite',  // file_read, file_write, file_edit, grep, glob
}

const fullAgent: AgentConfig = {
  name: 'executor',
  model: 'claude-sonnet-4-6',
  toolPreset: 'full',  // file_read, file_write, file_edit, grep, glob, bash
}
```

### 高级过滤

```typescript
const customAgent: AgentConfig = {
  name: 'custom',
  model: 'claude-sonnet-4-6',
  toolPreset: 'readwrite',        // 起点：file_read, file_write, file_edit, grep, glob
  tools: ['file_read', 'grep'],   // 白名单：与预设取交集 = file_read, grep
  disallowedTools: ['grep'],      // 黑名单：再减去 = 只剩 file_read
}
```

**解析顺序：** preset → allowlist → denylist → 框架安全护栏。

### 自定义工具

装一个不在内置集里的工具，有两种方式。

**配置时注入。** 通过 `AgentConfig.customTools` 传入。编排层统一挂工具的时候用这个。这里定义的工具会绕过 preset 和白名单，但仍受 `disallowedTools` 限制。

```typescript
import { defineTool } from '@jackchen_me/open-multi-agent'
import { z } from 'zod'

const weatherTool = defineTool({
  name: 'get_weather',
  description: '查询某城市当前天气。',
  schema: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ content: await fetchWeather(city) }),
})

const agent: AgentConfig = {
  name: 'assistant',
  model: 'claude-sonnet-4-6',
  customTools: [weatherTool],
}
```

**运行时注册。** `agent.addTool(tool)`。这种方式加的工具始终可用，不受任何过滤规则影响。

### 工具输出控制

工具返回太长会快速撑大对话和成本。两个开关配合着用。

**截断。** 把单次工具结果压成 head + tail 摘要（中间放一个标记）：

```typescript
const agent: AgentConfig = {
  // ...
  maxToolOutputChars: 10_000, // 该 agent 所有工具的默认上限
}

// 单工具覆盖（优先级高于 AgentConfig.maxToolOutputChars）：
const bigQueryTool = defineTool({
  // ...
  maxOutputChars: 50_000,
})
```

**消费后压缩。** agent 用完某个工具结果之后，把历史副本压缩掉，后续每轮就不再重复消耗输入 token。错误结果不压缩。

```typescript
const agent: AgentConfig = {
  // ...
  compressToolResults: true,                 // 默认阈值 500 字符
  // 或：compressToolResults: { minChars: 2_000 }
}
```

### MCP 工具（Model Context Protocol）

可以连任意 MCP 服务器，把它的工具直接给 agent 用。

```typescript
import { connectMCPTools } from '@jackchen_me/open-multi-agent/mcp'

const { tools, disconnect } = await connectMCPTools({
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN },
  namePrefix: 'github',
})

// 把每个 MCP 工具注册进你的 ToolRegistry，然后在 AgentConfig.tools 里引用它们的名字
// 用完别忘了清理
await disconnect()
```

注意事项：
- `@modelcontextprotocol/sdk` 是 optional peer dependency，只在用 MCP 时才要装。
- 当前只支持 stdio transport。
- MCP 的入参校验交给 MCP 服务器自己（`inputSchema` 是 `z.any()`）。

完整例子见 [`integrations/mcp-github`](examples/integrations/mcp-github.ts)。

## 上下文管理

长时间运行的 agent 很容易撞上输入 token 上限。在 `AgentConfig` 里设 `contextStrategy`，控制对话变长时怎么收缩：

```typescript
const agent: AgentConfig = {
  name: 'long-runner',
  model: 'claude-sonnet-4-6',
  // 选一种：
  contextStrategy: { type: 'sliding-window', maxTurns: 20 },
  // contextStrategy: { type: 'summarize', maxTokens: 80_000, summaryModel: 'claude-haiku-4-5' },
  // contextStrategy: { type: 'compact', maxTokens: 100_000, preserveRecentTurns: 4 },
  // contextStrategy: { type: 'custom', compress: (messages, estimatedTokens, ctx) => ... },
}
```

| 策略 | 什么时候用 |
|------|------------|
| `sliding-window` | 最省事。只保留最近 N 轮，其余丢弃。 |
| `summarize` | 老对话发给摘要模型，用摘要替代原文。 |
| `compact` | 基于规则：截断过长的 assistant 文本块和 tool 结果，保留最近若干轮。不额外调用 LLM。 |
| `custom` | 传入自己的 `compress(messages, estimatedTokens, ctx)` 函数。 |

和上面的 `compressToolResults`、`maxToolOutputChars` 搭着用效果更好。

## 支持的 Provider

| Provider | 配置 | 环境变量 | 状态 |
|----------|------|----------|------|
| Anthropic (Claude) | `provider: 'anthropic'` | `ANTHROPIC_API_KEY` | 已验证 |
| OpenAI (GPT) | `provider: 'openai'` | `OPENAI_API_KEY` | 已验证 |
| Grok (xAI)   | `provider: 'grok'` | `XAI_API_KEY` | 已验证 |
| MiniMax（全球） | `provider: 'minimax'` | `MINIMAX_API_KEY` | 已验证 |
| MiniMax（国内） | `provider: 'minimax'` + `MINIMAX_BASE_URL` | `MINIMAX_API_KEY` | 已验证 |
| DeepSeek | `provider: 'deepseek'` | `DEEPSEEK_API_KEY` | 已验证 |
| GitHub Copilot | `provider: 'copilot'` | `GITHUB_TOKEN` | 已验证 |
| Gemini | `provider: 'gemini'` | `GEMINI_API_KEY` | 已验证 |
| Ollama / vLLM / LM Studio | `provider: 'openai'` + `baseURL` | 无 | 已验证 |
| Groq | `provider: 'openai'` + `baseURL` | `GROQ_API_KEY` | 已验证 |
| llama.cpp server | `provider: 'openai'` + `baseURL` | 无 | 已验证 |

Gemini 需要 `npm install @google/genai`（optional peer dependency）。

已验证支持 tool-calling 的本地模型：**Gemma 4**（见 [`providers/gemma4-local`](examples/providers/gemma4-local.ts)）。

OpenAI 兼容的 API 都能用 `provider: 'openai'` + `baseURL` 接（Mistral、Qwen、Moonshot、Doubao 等）。Groq 在 [`providers/groq`](examples/providers/groq.ts) 里验证过。Grok、MiniMax、DeepSeek 直接用 `provider: 'grok'`、`provider: 'minimax'`、`provider: 'deepseek'`，不用配 `baseURL`。

### 本地模型 Tool-Calling

Ollama、vLLM、LM Studio、llama.cpp 跑的本地模型也能 tool-calling，走的是这些服务自带的 OpenAI 兼容接口。

**已验证模型：** Gemma 4、Llama 3.1、Qwen 3、Mistral、Phi-4。完整列表见 [ollama.com/search?c=tools](https://ollama.com/search?c=tools)。

**兜底提取：** 本地模型如果以文本形式返回工具调用，而不是 `tool_calls` 协议格式（thinking 模型或配置不对的服务常见），框架会自动从文本里提取。

**超时设置。** 本地推理可能慢。在 `AgentConfig` 里设 `timeoutMs`，避免一直卡住：

```typescript
const localAgent: AgentConfig = {
  name: 'local',
  model: 'llama3.1',
  provider: 'openai',
  baseURL: 'http://localhost:11434/v1',
  apiKey: 'ollama',
  tools: ['bash', 'file_read'],
  timeoutMs: 120_000, // 2 分钟后中止
}
```

**常见问题：**
- 模型不调用工具？先确认它在 Ollama 的 [Tools 分类](https://ollama.com/search?c=tools) 里，不是所有模型都支持。
- 把 Ollama 升到最新版（`ollama update`），旧版本有 tool-calling bug。
- 代理挡住了？本地服务用 `no_proxy=localhost` 跳过代理。

### LLM 配置示例

```typescript
const grokAgent: AgentConfig = {
  name: 'grok-agent',
  provider: 'grok',
  model: 'grok-4',
  systemPrompt: 'You are a helpful assistant.',
}
```

（设好 `XAI_API_KEY` 就行，不用配 `baseURL`。）

```typescript
const minimaxAgent: AgentConfig = {
  name: 'minimax-agent',
  provider: 'minimax',
  model: 'MiniMax-M2.7',
  systemPrompt: 'You are a helpful assistant.',
}
```

设好 `MINIMAX_API_KEY`。端点用 `MINIMAX_BASE_URL` 选：

- `https://api.minimax.io/v1` 全球端点，默认
- `https://api.minimaxi.com/v1` 中国大陆端点

也可以直接在 `AgentConfig` 里传 `baseURL`，覆盖环境变量。

```typescript
const deepseekAgent: AgentConfig = {
  name: 'deepseek-agent',
  provider: 'deepseek',
  model: 'deepseek-chat',
  systemPrompt: '你是一个有用的助手。',
}
```

设好 `DEEPSEEK_API_KEY`。两个模型：`deepseek-chat`（DeepSeek-V3，写代码选这个）和 `deepseek-reasoner`（思考模式）。

## 参与贡献

Issue、feature request、PR 都欢迎。特别想要：

- **生产级示例。** 端到端跑通的真实场景工作流。收录条件和提交格式见 [`examples/production/README.md`](./examples/production/README.md)。
- **文档。** 指南、教程、API 文档。

## 贡献者

<a href="https://github.com/JackChen-me/open-multi-agent/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=JackChen-me/open-multi-agent&max=20&v=20260411" />
</a>

## Star 趋势

<a href="https://star-history.com/#JackChen-me/open-multi-agent&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=JackChen-me/open-multi-agent&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=JackChen-me/open-multi-agent&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=JackChen-me/open-multi-agent&type=Date" />
 </picture>
</a>

## 许可证

MIT
