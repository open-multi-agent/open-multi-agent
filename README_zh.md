<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/brand/logo-mark-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset=".github/brand/logo-mark-light.svg">
    <img alt="Open Multi-Agent" src=".github/brand/logo-mark-light.svg" width="96">
  </picture>
</p>

<h1 align="center">Open Multi-Agent</h1>

<p align="center">
  面向 TypeScript 的轻量多智能体编排框架。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@jackchen_me/open-multi-agent"><img src="https://img.shields.io/npm/v/@jackchen_me/open-multi-agent" alt="npm version"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/JackChen-me/open-multi-agent" alt="license"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.6-blue" alt="TypeScript"></a>
  <a href="https://codecov.io/gh/JackChen-me/open-multi-agent"><img src="https://codecov.io/gh/JackChen-me/open-multi-agent/graph/badge.svg" alt="codecov"></a>
  <a href="https://github.com/JackChen-me/open-multi-agent/blob/main/package.json"><img src="https://img.shields.io/badge/runtime_deps-3-brightgreen" alt="runtime deps"></a>
  <a href="https://github.com/JackChen-me/open-multi-agent/stargazers"><img src="https://img.shields.io/github/stars/JackChen-me/open-multi-agent" alt="GitHub stars"></a>
</p>

<p align="center">
  <a href="./README.md">English</a> · <strong>中文</strong>
</p>

---

`open-multi-agent` 是面向 TypeScript 后端的多智能体编排框架。给定一个目标，协调者 agent 会将其拆解为任务 DAG，并行执行独立任务，合成最终结果。仅 3 个运行时依赖，可直接嵌入任意现有 Node.js 后端，让工程师专注于目标，而非任务图。

## 功能一览

| 能力 | 说明 |
|------|------|
| **工具与委托** | 6 个内置工具（`bash`、`file_read`、`file_write`、`file_edit`、`grep`、`glob`），加可选启用的 `delegate_to_agent`。用 `defineTool()` + Zod 自定义工具。 |
| **MCP 集成** | 通过 `connectMCPTools()` 接入任意 MCP server。([`mcp-github`](examples/integrations/mcp-github.ts)) |
| **同队混用 provider** | Anthropic、OpenAI、Azure、Gemini、Grok、DeepSeek、MiniMax、Qiniu、Copilot 原生支持；Ollama / vLLM / LM Studio / OpenRouter / Groq 走 OpenAI 兼容协议。([完整列表](#支持的-provider)) |
| **流式 + 结构化输出** | 每个 adapter 都支持 token 级流式输出；用 Zod schema 校验最终答复，解析失败自动重试。([`structured-output`](examples/patterns/structured-output.ts)) |
| **上下文策略** | `sliding-window`、`summarize`、`compact`，或自定义压缩函数，把长跑 agent 控制在 token 上限内。 |
| **任务重试** | 每个任务可设 `maxRetries`，指数退避封顶 30 秒。([`task-retry`](examples/patterns/task-retry.ts)) |
| **可观测性** | `onProgress` 事件、`onTrace` span，运行结束后渲染任务 DAG 的 HTML dashboard。([`trace-observability`](examples/integrations/trace-observability.ts)) |
| **循环检测** | 滑动窗口检测器对工具调用签名和文本输出做哈希，提前发现卡死的 agent。 |
| **工具输出控制** | 单工具截断、消费后压缩、可选用 Zod 校验工具返回值。 |
| **可插拔共享记忆** | 默认进程内 KV；实现 `MemoryStore` 接口即可换 Redis / Postgres / Engram。 |

## 快速开始

要求 Node.js >= 18。

### 30 秒跑通一个团队

最快的体验路径，克隆、安装、跑就行：

```bash
git clone https://github.com/JackChen-me/open-multi-agent && cd open-multi-agent
npm install
export ANTHROPIC_API_KEY=sk-...
npx tsx examples/basics/team-collaboration.ts
```

三个 agent（architect、developer、reviewer）协作产出 `/tmp/express-api/` 下的 REST API。你能看到协调者拆解目标、并行调度任务的实时进度事件。

通过 Ollama 跑本地模型不用 key，见 [`providers/ollama`](examples/providers/ollama.ts)。其他 provider（`OPENAI_API_KEY`、`GEMINI_API_KEY` 等）见[支持的 Provider](#支持的-provider)。

### 在你的项目里使用

```bash
npm install @jackchen_me/open-multi-agent
```

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

const developer: AgentConfig = {
  name: 'developer',
  model: 'claude-sonnet-4-6',
  systemPrompt: 'You implement what the architect specifies. Write clean, runnable TypeScript.',
  tools: ['bash', 'file_read', 'file_write', 'file_edit'],
}

const reviewer: AgentConfig = {
  name: 'reviewer',
  model: 'claude-sonnet-4-6',
  systemPrompt: 'You review code for correctness, security, and clarity.',
  tools: ['file_read', 'grep'],
}

const orchestrator = new OpenMultiAgent({
  defaultModel: 'claude-sonnet-4-6',
  onProgress: (event) => console.log(event.type, event.task ?? event.agent ?? ''),
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
task_start design-api
task_complete design-api
task_start implement-handlers
task_start scaffold-tests         // 无依赖的任务并行执行
task_complete scaffold-tests
task_complete implement-handlers
task_start review-code            // 实现完成后自动解锁
task_complete review-code
agent_complete coordinator        // 综合所有结果
Success: true
Tokens: 12847 output tokens
```

### 从命令行运行

包里还自带一个叫 `oma` 的命令行工具，给 shell 和 CI 场景用，输出都是 JSON。`oma run`、`oma task`、`oma provider`、退出码、文件格式都在 [docs/cli.md](./docs/cli.md) 里。

## 三种运行模式

| 模式 | 方法 | 适用场景 | 示例 |
|------|------|----------|------|
| 单智能体 | `runAgent()` | 一个智能体，一个提示词，最简入口 | [`basics/single-agent`](examples/basics/single-agent.ts) |
| 自动编排团队 | `runTeam()` | 给一个目标，框架自动规划和执行 | [`basics/team-collaboration`](examples/basics/team-collaboration.ts) |
| 显式任务管线 | `runTasks()` | 你自己定义任务图和分配 | [`basics/task-pipeline`](examples/basics/task-pipeline.ts) |

要 MapReduce 风格的 fan-out 但不需要任务依赖，直接用 `AgentPool.runParallel()`。例子见 [`patterns/fan-out-aggregate`](examples/patterns/fan-out-aggregate.ts)。

## 示例

[`examples/`](./examples/) 按类别分了 basics、cookbook、patterns、providers、integrations、production。完整索引见 [`examples/README.md`](./examples/README.md)。

### 真实业务流程（[`cookbook/`](./examples/cookbook/)）

端到端可直接跑的场景，每个都是完整、有主见的工作流。

- [`contract-review-dag`](examples/cookbook/contract-review-dag.ts)：四任务 DAG 做合同审阅，分支并行 + 出错按步骤重试。
- [`meeting-summarizer`](examples/cookbook/meeting-summarizer.ts)：三个专精 agent 并行处理会议转录稿，聚合 agent 合成含行动项和情绪分析的 Markdown 报告。
- [`competitive-monitoring`](examples/cookbook/competitive-monitoring.ts)：三个来源 agent 并行从信息流抽取声明，聚合 agent 跨源校对、标记矛盾。
- [`translation-backtranslation`](examples/cookbook/translation-backtranslation.ts)：用一个 provider 翻译 EN 到目标语言，另一个 provider 回译，标记语义漂移。

### 模式与集成

- [`basics/team-collaboration`](examples/basics/team-collaboration.ts)：`runTeam()` 协调者模式。
- [`patterns/structured-output`](examples/patterns/structured-output.ts)：任意 agent 产出 Zod 校验过的 JSON。
- [`patterns/agent-handoff`](examples/patterns/agent-handoff.ts)：`delegate_to_agent` 同步子智能体委派。
- [`integrations/trace-observability`](examples/integrations/trace-observability.ts)：`onTrace` 回调，给 LLM 调用、工具、任务发结构化 span。
- [`integrations/mcp-github`](examples/integrations/mcp-github.ts)：用 `connectMCPTools()` 把 MCP 服务器的工具暴露给 agent。
- [`integrations/with-vercel-ai-sdk`](examples/integrations/with-vercel-ai-sdk/)：Next.js 应用，OMA `runTeam()` 配合 AI SDK `useChat` 流式输出。
- **Provider 示例**：[`examples/providers/`](examples/providers/) 下的三智能体团队示例，覆盖托管 provider、OpenAI 兼容端点和本地模型。

跑任意脚本：`npx tsx examples/<path>.ts`。

## 和其他框架怎么选

**对比 [LangGraph JS](https://github.com/langchain-ai/langgraphjs)。** LangGraph 是声明式图编排：自己定义节点、边、条件路由，再 `compile()` + `invoke()`。`open-multi-agent` 是目标驱动：协调者在运行时把目标拆成任务 DAG。要锁定生产拓扑、有成熟 checkpoint 选 LangGraph；想少写代码、快速迭代多智能体方案选这边。

**对比 [Mastra](https://github.com/mastra-ai/mastra)。** Mastra 走 Supervisor 模式，agent、workflow、Supervisor 都得手接；`open-multi-agent` 走 Coordinator 自动拆解，入口就是一句 `runTeam(team, "构建一个 REST API")`。流程已经定型选显式拓扑（Mastra），还是给目标让框架决策（这边），按工作流是否已知来定。

**对比 [CrewAI](https://github.com/crewAIInc/crewAI)。** CrewAI 是 Python 阵营成熟方案，栈是 Python 用它就行。`open-multi-agent` 走 TypeScript 原生：3 个运行时依赖、直接嵌入 Node.js、编排能力大致持平。按语言栈选。

**对比 [Vercel AI SDK](https://github.com/vercel/ai)。** AI SDK 是 LLM 调用层：统一的 TypeScript 客户端，覆盖 60+ provider，支持流式、tool call、结构化输出。它不做多智能体编排。两者互补：单智能体用 AI SDK，需要团队协作叠在上面用这个。

## 生态

项目 2026-04-01 发布，MIT 协议。生态还在成型，下面的列表不长，但都是真的。

### 生产环境在用

- **[temodar-agent](https://github.com/xeloxa/temodar-agent)**（约 50 stars）。WordPress 安全分析平台，作者 [Ali Sünbül](https://github.com/xeloxa)。在 Docker runtime 里直接用我们的内置工具（`bash`、`file_*`、`grep`）。已确认生产环境使用。
- **家用服务器 Cybersecurity SOC。** 本地完全离线跑 Qwen 2.5 + DeepSeek Coder（通过 Ollama），在 Wazuh + Proxmox 上搭自主 SOC 流水线。早期用户，未公开。

如果你在生产或 side project 里用了 `open-multi-agent`，[请开个 Discussion](https://github.com/JackChen-me/open-multi-agent/discussions)，我加上来。

### 集成

- **[Engram](https://www.engram-memory.com)** — "Git for AI memory." Syncs knowledge across agents instantly and flags conflicts. ([repo](https://github.com/Agentscreator/engram-memory))

做了 `open-multi-agent` 集成？[开个 Discussion](https://github.com/JackChen-me/open-multi-agent/discussions)，我加上来。

### Featured partner

面向已经深度集成 `open-multi-agent` 的产品和平台。条款和申请方式见 [Featured partner 计划](./docs/featured-partner.md)。

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
│  - run()          │    ┌────────────────────────┐
│  - prompt()       │───►│  LLMAdapter            │
│  - stream()       │    │  - AnthropicAdapter    │
└────────┬──────────┘    │  - OpenAIAdapter       │
         │               │  - AzureOpenAIAdapter  │
         │               │  - CopilotAdapter      │
         │               │  - GeminiAdapter       │
         │               │  - GrokAdapter         │
         │               │  - MiniMaxAdapter      │
         │               │  - DeepSeekAdapter     │
         │               │  - QiniuAdapter        │
         │               └────────────────────────┘
┌────────▼──────────┐
│  AgentRunner      │    ┌──────────────────────┐
│  - conversation   │───►│  ToolRegistry        │
│    loop           │    │  - defineTool()      │
│  - tool dispatch  │    │  - 6 built-in tools  │
└───────────────────┘    │  + delegate (opt-in) │
                         └──────────────────────┘
```

## 可观测性

三层遥测，每一层都可以独立消费。

| 层级 | 你拿到什么 | 怎么接 |
|------|------------|--------|
| **`onProgress`** | 任务生命周期事件：`task_start`、`task_complete`、`task_retry`、`task_skipped`、`agent_start`、`agent_complete`、`budget_exceeded`、`error`。轻量、同步。 | `OrchestratorConfig.onProgress`，接你自己的 logger 或实时 dashboard。 |
| **`onTrace`** | 给 LLM 调用、工具执行、任务发结构化 span，带父子关系、耗时、token 数和工具入参出参。 | `OrchestratorConfig.onTrace`，转发到 OpenTelemetry、Datadog、Honeycomb、Langfuse 等。([`integrations/trace-observability`](examples/integrations/trace-observability.ts)) |
| **运行结束后的 HTML dashboard** | 一段静态 HTML，把执行过的任务 DAG、耗时、token 用量、每个任务的状态都画出来。不用起服务，不用 D3，纯字符串。 | `import { renderTeamRunDashboard } from '@jackchen_me/open-multi-agent'`，然后 `fs.writeFileSync('run.html', renderTeamRunDashboard(result))`。 |

合在一起：用 `onProgress` 给运维实时看进度，用 `onTrace` 给调试和成本归因留痕迹，用 dashboard 留一份可分享的事后复盘产物。

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
  inputSchema: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ data: await fetchWeather(city) }),
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

**校验（可选）。** 给工具加 `outputSchema`，在结果回传前拦截结构错误：

> **注意 —— 有两个同名的 `outputSchema`。** 这里 `defineTool()` / `ToolDefinition`
> 上的 `outputSchema`（下例所示）校验的是单个**工具**的 `ToolResult.data`，类型
> 固定为 `ZodSchema<string>`，因为工具输出始终以字符串形式序列化。
> [`AgentConfig`](examples/patterns/structured-output.ts) 上同名的 `outputSchema`
> 则完全不同：它把 **agent 的最终回答**按 JSON 解析后，用任意 Zod schema 进行
> 校验（详见 `examples/` 里的"结构化输出"示例）。两者类型和作用域都不一样，
> 且 TypeScript 不会提示混用，请根据所处层级选用对应的那个。

```typescript
const jsonTool = defineTool({
  name: 'json_tool',
  description: '以字符串返回 JSON 载荷。',
  inputSchema: z.object({}),
  outputSchema: z.string().refine((value) => {
    try {
      JSON.parse(value)
      return true
    } catch {
      return false
    }
  }, '输出必须是合法 JSON'),
  execute: async () => ({ data: '{"ok": true}' }),
})
```

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

## 共享内存

团队可以共用一个命名空间化的 key-value 存储，让后续 agent 看到前面 agent 的发现。用布尔值启用默认的进程内存储：

```typescript
const team = orchestrator.createTeam('research-team', {
  name: 'research-team',
  agents: [researcher, writer],
  sharedMemory: true,
})
```

需要持久化或跨进程的后端（Redis、Postgres、Engram 等）？实现 `MemoryStore` 接口并通过 `sharedMemoryStore` 注入，键仍会在到达 store 前按 `<agentName>/<key>` 做命名空间封装：

```typescript
import type { MemoryStore } from '@jackchen_me/open-multi-agent'

class RedisStore implements MemoryStore { /* get/set/list/delete/clear */ }

const team = orchestrator.createTeam('durable-team', {
  name: 'durable-team',
  agents: [researcher, writer],
  sharedMemoryStore: new RedisStore(),
})
```

两者都提供时，`sharedMemoryStore` 优先。此字段仅 SDK 可用，CLI 无法序列化运行时对象。

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

各家 provider 写法基本一致，改 `provider`、`model`，设好对应的环境变量：

```typescript
const agent: AgentConfig = {
  name: 'my-agent',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  systemPrompt: 'You are a helpful assistant.',
}
```

### 一类：内置快捷方式（写名字就能用）

框架替你写好了 endpoint，你只需要设 `provider` + 环境变量。

> 底层只有 Anthropic 和 Gemini 真用了各自的 SDK；其余都是 OpenAI Chat Completions 协议的预配置壳子。和下面第二张表协议一样，区别只是「框架替你写好了 baseURL」还是「你自己写」。

| Provider | 配置 | 环境变量 | 示例 model | 备注 |
|----------|------|----------|-----------|------|
| Anthropic (Claude) | `provider: 'anthropic'` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-6` | 原生 Anthropic SDK。 |
| Gemini | `provider: 'gemini'` | `GEMINI_API_KEY` | `gemini-2.5-pro` | 原生 Google GenAI SDK，需 `npm install @google/genai`。 |
| OpenAI (GPT) | `provider: 'openai'` | `OPENAI_API_KEY` | `gpt-4o` | |
| Azure OpenAI | `provider: 'azure-openai'` | `AZURE_OPENAI_API_KEY`、`AZURE_OPENAI_ENDPOINT` | `gpt-4` | 可选 `AZURE_OPENAI_API_VERSION`、`AZURE_OPENAI_DEPLOYMENT`。 |
| GitHub Copilot | `provider: 'copilot'` | `GITHUB_TOKEN` | `gpt-4o` | OpenAI 协议 + 自定义 token 交换流程。 |
| Grok (xAI) | `provider: 'grok'` | `XAI_API_KEY` | `grok-4` | OpenAI 兼容，端点 `api.x.ai/v1`。 |
| DeepSeek | `provider: 'deepseek'` | `DEEPSEEK_API_KEY` | `deepseek-chat` | OpenAI 兼容。`deepseek-chat`（V3，写代码）或 `deepseek-reasoner`（思考模式）。 |
| MiniMax（全球） | `provider: 'minimax'` | `MINIMAX_API_KEY` | `MiniMax-M2.7` | OpenAI 兼容。 |
| MiniMax（国内） | `provider: 'minimax'` + `MINIMAX_BASE_URL` | `MINIMAX_API_KEY` | `MiniMax-M2.7` | 设 `MINIMAX_BASE_URL=https://api.minimaxi.com/v1`。 |
| Qiniu | `provider: 'qiniu'` | `QINIU_API_KEY` | `deepseek-v3` | OpenAI 兼容。端点 `https://api.qnaigc.com/v1`；多模型族，见 [Qiniu AI 文档](https://developer.qiniu.com/aitokenapi/12882/ai-inference-api)。 |

### 二类：其他 OpenAI 兼容服务（自己写 `baseURL`）

没有内置快捷方式但协议一样。`provider: 'openai'` + `baseURL` 指向目标服务，就是任何说 OpenAI Chat Completions 协议的服务的接入方式。

| 服务 | 配置 | 环境变量 | 示例 model |
|------|------|----------|-----------|
| Ollama（本地） | `provider: 'openai'` + `baseURL: 'http://localhost:11434/v1'` | 无 | `llama3.1` |
| vLLM（本地） | `provider: 'openai'` + `baseURL` | 无 | （由 server 加载） |
| LM Studio（本地） | `provider: 'openai'` + `baseURL` | 无 | （由 server 加载） |
| llama.cpp server（本地） | `provider: 'openai'` + `baseURL` | 无 | （由 server 加载） |
| OpenRouter | `provider: 'openai'` + `baseURL: 'https://openrouter.ai/api/v1'` + `apiKey` | `OPENROUTER_API_KEY` | `openai/gpt-4o-mini` |
| Groq | `provider: 'openai'` + `baseURL: 'https://api.groq.com/openai/v1'` | `GROQ_API_KEY` | `llama-3.3-70b-versatile` |

Mistral、Qwen、Moonshot、Doubao、Together AI、Fireworks 等都是同样的接法。OpenRouter 这种 key 名不是 `OPENAI_API_KEY` 的，把 key 显式传给 `apiKey` 字段；否则 `openai` 适配器默认读环境里的 `OPENAI_API_KEY`。

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

**量化模型调参。** 消费级硬件上跑高度量化的 MoE 模型（Qwen2.5-MoE @ Q4、DeepSeek-MoE @ Q4 等）默认采样下容易陷入重复循环或编造工具调用 schema。`AgentConfig` 上有 `topK`、`minP`、`frequencyPenalty`、`presencePenalty`、`parallelToolCalls`（不稳的 tool-caller 设 `false`，强制一轮只调一个工具），以及 `extraBody` 这个口子，用来传 server 自家参数（比如 vLLM 的 `repetition_penalty`）。云端 OpenAI 用户不用动这些，默认是按全精度模型调好的。完整示例见 [`providers/local-quantized`](examples/providers/local-quantized.ts)。

**常见问题：**
- 模型不调用工具？先确认它在 Ollama 的 [Tools 分类](https://ollama.com/search?c=tools) 里，不是所有模型都支持。
- 把 Ollama 升到最新版（`ollama update`），旧版本有 tool-calling bug。
- 代理挡住了？本地服务用 `no_proxy=localhost` 跳过代理。

## 生产化清单

上 prod 之前把这几件事做了：保护 token 花费、能从失败里恢复、出问题能查。

| 关注点 | 配置项 | 作用域 |
|--------|--------|--------|
| 控制对话长度 | `maxTurns`（每个 agent）+ `contextStrategy`（`sliding-window` / `summarize` / `compact` / `custom`） | `AgentConfig` |
| 限制工具输出 | `maxToolOutputChars`（或单工具 `maxOutputChars`）+ `compressToolResults: true` | `AgentConfig` 和 `defineTool()` |
| 失败重试 | 任务级 `maxRetries`、`retryDelayMs`、`retryBackoff`（指数退避倍率） | 通过 `runTasks()` 用的任务配置 |
| 总额封顶 | orchestrator 上设 `maxTokenBudget` | `OrchestratorConfig` |
| 卡死检测 | `loopDetection` + `onLoopDetected: 'terminate'`（或自定义 handler） | `AgentConfig` |
| 追踪与审计 | `onTrace` 接你的 tracing 后端；落盘 `renderTeamRunDashboard(result)` | `OrchestratorConfig` |

完整的端到端生产化样例都在 [`examples/production/`](./examples/production/) 下。

## 参与贡献

Issue、feature request、PR 都欢迎。特别想要：

- **生产级示例。** 端到端跑通的真实场景工作流。收录条件和提交格式见 [`examples/production/README.md`](./examples/production/README.md)。
- **文档。** 指南、教程、API 文档。
- **翻译。** 把这份 README 翻译成其他语言。[提个 PR](https://github.com/JackChen-me/open-multi-agent/pulls)。

## 贡献者

<a href="https://github.com/JackChen-me/open-multi-agent/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=JackChen-me/open-multi-agent&max=20&v=20260425" />
</a>

## Star 趋势

<a href="https://star-history.com/#JackChen-me/open-multi-agent&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=JackChen-me/open-multi-agent&type=Date&theme=dark&v=20260425" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=JackChen-me/open-multi-agent&type=Date&v=20260425" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=JackChen-me/open-multi-agent&type=Date&v=20260425" />
 </picture>
</a>

## 许可证

MIT
