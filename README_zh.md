<br />

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/JackChen-me/open-multi-agent/main/.github/brand/logo-mark-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/JackChen-me/open-multi-agent/main/.github/brand/logo-mark-light.svg">
    <img alt="Open Multi-Agent" src="https://raw.githubusercontent.com/JackChen-me/open-multi-agent/main/.github/brand/logo-mark-light.svg" width="96">
  </picture>
</p>

<br />

<h1 align="center">Open Multi-Agent</h1>

<p align="center">
  <strong>给一个目标，自动得到任务 DAG。</strong><br/>
  原生 TypeScript 多智能体编排，3 个运行时依赖。<br/>
  9 个原生 LLM 适配器 · MCP · token 预算 · 重试 · 上下文压缩 · 实时追踪。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@jackchen_me/open-multi-agent"><img src="https://img.shields.io/npm/v/@jackchen_me/open-multi-agent" alt="npm version"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/JackChen-me/open-multi-agent" alt="license"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.6-blue" alt="TypeScript"></a>
  <a href="https://codecov.io/gh/JackChen-me/open-multi-agent"><img src="https://codecov.io/gh/JackChen-me/open-multi-agent/graph/badge.svg" alt="codecov"></a>
  <a href="https://github.com/JackChen-me/open-multi-agent/blob/main/package.json"><img src="https://img.shields.io/badge/runtime_deps-3-brightgreen" alt="runtime deps"></a>
  <a href="https://github.com/JackChen-me/open-multi-agent/stargazers"><img src="https://img.shields.io/github/stars/JackChen-me/open-multi-agent" alt="GitHub stars"></a>
  <a href="https://github.com/JackChen-me/open-multi-agent/network/members"><img src="https://img.shields.io/github/forks/JackChen-me/open-multi-agent" alt="GitHub forks"></a>
</p>

<p align="center">
  <a href="./README.md">English</a> · <strong>中文</strong>
</p>

<br />

`open-multi-agent` 是面向 TypeScript 后端的多智能体编排框架。给定一个目标，协调者 agent 会将其拆解为任务 DAG，并行执行独立任务，合成最终结果。仅 3 个运行时依赖，可直接嵌入任意现有 Node.js 后端。

> **工程师只描述目标，不画任务图。**

通过 `onProgress` 实时流出来的一次典型运行：

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

## 功能一览

| 能力 | 说明 |
|------|------|
| **目标驱动协调者** | 一句 `runTeam(team, goal)`，协调者把目标拆成任务 DAG，并行执行独立任务，合成最终结果。 |
| **同队混用 provider** | 9 家原生：Anthropic、OpenAI、Azure、Gemini、Grok、DeepSeek、MiniMax、Qiniu、Copilot；Ollama / vLLM / LM Studio / OpenRouter / Groq 走 OpenAI 兼容协议。([完整列表](#支持的-provider)) |
| **工具 + MCP** | 6 个内置（`bash`、`file_*`、`grep`、`glob`），可选启用 `delegate_to_agent`，用 `defineTool()` + Zod 自定义，任意 MCP server 通过 `connectMCPTools()` 接入。 |
| **流式 + 结构化输出** | 每个 adapter 都支持 token 级流式输出；用 Zod schema 校验最终答复，解析失败自动重试。([`structured-output`](examples/patterns/structured-output.ts)) |
| **可观测性** | `onProgress` 事件、`onTrace` span，运行结束后渲染任务 DAG 的 HTML dashboard。([`trace-observability`](examples/integrations/trace-observability.ts)) |
| **可插拔共享记忆** | 默认进程内 KV；实现 `MemoryStore` 接口即可换 Redis / Postgres / 自家后端。 |

生产化控制（上下文策略、任务重试退避、循环检测、工具输出截断/压缩）见 [生产化清单](#生产化清单)。

## 快速开始

要求 Node.js >= 18。

### 本地试跑

克隆、安装、跑：

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

### 三种运行模式

| 模式 | 方法 | 适用场景 | 示例 |
|------|------|----------|------|
| 单智能体 | `runAgent()` | 一个智能体，一个提示词，最简入口 | [`basics/single-agent`](examples/basics/single-agent.ts) |
| 自动编排团队 | `runTeam()` | 给一个目标，框架自动规划和执行 | [`basics/team-collaboration`](examples/basics/team-collaboration.ts) |
| 显式任务管线 | `runTasks()` | 你自己定义任务图和分配 | [`basics/task-pipeline`](examples/basics/task-pipeline.ts) |

要 MapReduce 风格的 fan-out 但不需要任务依赖，直接用 `AgentPool.runParallel()`。例子见 [`patterns/fan-out-aggregate`](examples/patterns/fan-out-aggregate.ts)。

### 从命令行运行

包里还自带一个叫 `oma` 的命令行工具，给 shell 和 CI 场景用，输出都是 JSON。`oma run`、`oma task`、`oma provider`、退出码、文件格式都在 [docs/cli.md](./docs/cli.md) 里。

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

按需求快速选型。下面有逐个机制对比。

| 你的需求 | 选 |
|----------|----|
| 固定的生产拓扑 + 成熟的 checkpoint | [LangGraph JS](https://github.com/langchain-ai/langgraphjs) |
| 显式 Supervisor + 手写 workflow | [Mastra](https://github.com/mastra-ai/mastra) |
| Python 栈 + 成熟多智能体生态 | [CrewAI](https://github.com/crewAIInc/crewAI) |
| 60+ provider 的单智能体 LLM 调用层 | [Vercel AI SDK](https://github.com/vercel/ai) |
| **TypeScript + 一句话从目标到结果，自动拆任务** | **open-multi-agent** |

**对比 LangGraph JS。** LangGraph 把声明式图（节点、边、条件路由）编译成可调用对象。`open-multi-agent` 是 Coordinator 在运行时把目标拆成任务 DAG，再自动并行无依赖项。终点一样（编排执行），方向相反：LangGraph 图优先，OMA 目标优先。

**对比 Mastra。** 两者都原生 TypeScript。Mastra 的 Supervisor 模式要你手接 agent 和 workflow；OMA 的 Coordinator 在运行时从目标字符串自动接好。流程已经定型，Mastra 的显式性能赚回成本；不想枚举每一步，OMA 一句 `runTeam(team, goal)` 就够。

**对比 CrewAI。** CrewAI 是 Python 阵营成熟的多智能体方案。OMA 面向 TypeScript 后端，3 个运行时依赖，直接嵌入 Node.js。编排能力大致持平，按语言栈选。

**对比 Vercel AI SDK。** AI SDK 是 LLM 调用层（统一客户端，覆盖 60+ provider，支持流式、tool call、结构化输出）。它不做多智能体编排。两者互补：单智能体用 AI SDK，需要团队协作叠在上面用 OMA。

## 生态

2026-04-01 发布，MIT 协议。当前公开在用与集成的项目：

### 生产环境在用

- **[temodar-agent](https://github.com/xeloxa/temodar-agent)**（约 60 stars）。WordPress 安全分析平台，作者 [Ali Sünbül](https://github.com/xeloxa)。在 Docker runtime 里直接用我们的内置工具（`bash`、`file_*`、`grep`）。已确认生产环境使用。
- **家用服务器 Cybersecurity SOC。** 本地完全离线跑 Qwen 2.5 + DeepSeek Coder（通过 Ollama），在 Wazuh + Proxmox 上搭自主 SOC 流水线。早期用户，未公开。

如果你在生产或 side project 里用了 `open-multi-agent`，[请开个 Discussion](https://github.com/JackChen-me/open-multi-agent/discussions)，我加上来。

### 集成

- **[Engram](https://www.engram-memory.com)** — "Git for AI memory." Syncs knowledge across agents instantly and flags conflicts. ([repo](https://github.com/Agentscreator/engram-memory))
- **[@agentsonar/oma](https://github.com/agentsonar/agentsonar-oma)** — Sidecar detecting cross-run delegation cycles, repetition, and rate bursts.

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

- **选预设。** `toolPreset: 'readonly' | 'readwrite' | 'full'` 覆盖大部分 agent。
- **再细化。** 在预设之上叠加 `tools`（白名单）和 `disallowedTools`（黑名单）。
- **接自家工具。** `defineTool()` + `customTools`，或运行时 `agent.addTool()`。
- **管输出成本。** `outputSchema`、`maxToolOutputChars`、`compressToolResults`。
- **MCP。** 通过 `open-multi-agent/mcp` 的 `connectMCPTools()` 接外部服务器。

完整文档：[docs/tool-configuration.md](./docs/tool-configuration.md)。

## 共享内存

团队可以共用一个命名空间化的 key-value 存储，让后续 agent 看到前面 agent 的发现。`sharedMemory: true` 启用默认的进程内存储；要 Redis、Postgres、Engram 这类后端，实现 `MemoryStore` 接口并通过 `sharedMemoryStore` 传入即可。键到 store 之前会按 `<agentName>/<key>` 做命名空间封装。仅 SDK 可用，CLI 无法序列化运行时对象。

详见 [docs/shared-memory.md](./docs/shared-memory.md)。

## 上下文管理

长时间运行的 agent 很容易撞上输入 token 上限。`AgentConfig.contextStrategy` 决定对话变长时怎么收缩：

- `sliding-window`：只保留最近 N 轮，其余丢弃。最省事。
- `summarize`：老对话发给摘要模型，用摘要替代原文。
- `compact`：基于规则截断，不额外调用 LLM。
- `custom`：传入自己的 `compress(messages, estimatedTokens)` 函数。

详见 [docs/context-management.md](./docs/context-management.md)。

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
| GitHub Copilot | `provider: 'copilot'` | `GITHUB_COPILOT_TOKEN`（回退到 `GITHUB_TOKEN`） | `gpt-4o` | OpenAI 协议 + 自定义 token 交换流程。 |
| Grok (xAI) | `provider: 'grok'` | `XAI_API_KEY` | `grok-4` | OpenAI 兼容，端点 `api.x.ai/v1`。 |
| DeepSeek | `provider: 'deepseek'` | `DEEPSEEK_API_KEY` | `deepseek-chat` | OpenAI 兼容。`deepseek-chat`（V3，写代码）或 `deepseek-reasoner`（思考模式）。 |
| MiniMax（全球） | `provider: 'minimax'` | `MINIMAX_API_KEY` | `MiniMax-M2.7` | OpenAI 兼容。 |
| MiniMax（国内） | `provider: 'minimax'` + `MINIMAX_BASE_URL` | `MINIMAX_API_KEY` | `MiniMax-M2.7` | 设 `MINIMAX_BASE_URL=https://api.minimaxi.com/v1`。 |
| Qiniu | `provider: 'qiniu'` | `QINIU_API_KEY` | `deepseek-v3` | OpenAI 兼容。端点 `https://api.qnaigc.com/v1`；多模型族，见 [Qiniu AI 文档](https://developer.qiniu.com/aitokenapi/12882/ai-inference-api)。 |
| AWS Bedrock | `provider: 'bedrock'` | 无（AWS SDK 凭证链） | `anthropic.claude-3-5-haiku-20241022-v1:0` | 无 API Key。通过 `AWS_REGION` 或 `createAdapter` 第 4 个参数传入 region；凭证来自环境变量、共享配置或 IAM 角色。较新的 Claude 模型（Sonnet 4.x、Haiku 4.x）需要跨区域推理配置前缀（如 `us.`）——具体可用 ID 请查看 Bedrock 控制台。同样支持 Llama、Mistral、Cohere——见 [`providers/bedrock`](examples/providers/bedrock.ts) 示例。需 `npm install @aws-sdk/client-bedrock-runtime`。 |

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

## 参与贡献

Issue、feature request、PR 都欢迎。特别想要：

- **生产级示例。** 端到端跑通的真实场景工作流。收录条件和提交格式见 [`examples/production/README.md`](./examples/production/README.md)。
- **文档。** 指南、教程、API 文档。
- **翻译。** 把这份 README 翻译成其他语言。[提个 PR](https://github.com/JackChen-me/open-multi-agent/pulls)。

## 贡献者

**项目负责人：** [Jack Chen](https://github.com/JackChen-me)

**框架功能**

- [@ibrahimkzmv](https://github.com/ibrahimkzmv)（token 预算、上下文策略、依赖隔离上下文、工具预设、glob、MCP 集成、可配置 Coordinator、CLI、Dashboard 渲染）
- [@apollo-mg](https://github.com/apollo-mg)（上下文压缩修复、采样参数）
- [@tizerluo](https://github.com/tizerluo)（onPlanReady、onAgentStream）
- [@Xin-Mai](https://github.com/Xin-Mai)（output schema 验证）
- [@JasonOA888](https://github.com/JasonOA888)（AbortSignal 支持）
- [@EchoOfZion](https://github.com/EchoOfZion)（简单目标跳过 Coordinator）
- [@voidborne-d](https://github.com/voidborne-d)（OpenAI 混合内容修复）
- [@hamzarstar](https://github.com/hamzarstar)（agent 委托机制共建）

**Provider 集成**

- [@ibrahimkzmv](https://github.com/ibrahimkzmv)（Gemini）
- [@hkalex](https://github.com/hkalex)（DeepSeek、MiniMax）
- [@marceloceccon](https://github.com/marceloceccon)（Grok）
- [@Klarline](https://github.com/Klarline)（Azure OpenAI）
- [@Deathwing](https://github.com/Deathwing)（GitHub Copilot）
- [@JackChiang233](https://github.com/JackChiang233) 与 [@jiangzhuo](https://github.com/jiangzhuo)（七牛云）

**示例与 Cookbook**

- [@mvanhorn](https://github.com/mvanhorn)（多源研究聚合、代码评审、会议总结、Groq 示例）
- [@Kinoo0](https://github.com/Kinoo0)（代码评审升级）
- [@Optimisttt](https://github.com/Optimisttt)（研究聚合升级）
- [@Agentscreator](https://github.com/Agentscreator)（Engram 记忆集成）
- [@fault-segment](https://github.com/fault-segment) 与 yanzizheng（合同审查 DAG）
- [@HuXiangyu123](https://github.com/HuXiangyu123)（分级成本示例）
- [@zouhh22333-beep](https://github.com/zouhh22333-beep)（翻译/回译）
- [@pei-pei45](https://github.com/pei-pei45)（竞品监测）

**文档与测试**

- [@tmchow](https://github.com/tmchow)（llama.cpp 文档）
- [@kenrogers](https://github.com/kenrogers)（OpenRouter 文档）
- [@jadegold55](https://github.com/jadegold55)（LLM adapter 测试覆盖）

<a href="https://github.com/JackChen-me/open-multi-agent/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=JackChen-me/open-multi-agent&max=100&v=20260427" />
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
