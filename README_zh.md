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
  原生 TypeScript 多智能体编排，3 个运行时依赖。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@jackchen_me/open-multi-agent"><img src="https://img.shields.io/npm/v/@jackchen_me/open-multi-agent" alt="npm version"></a>
  <a href="https://github.com/JackChen-me/open-multi-agent/actions/workflows/ci.yml"><img src="https://github.com/JackChen-me/open-multi-agent/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/JackChen-me/open-multi-agent" alt="license"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.6-blue" alt="TypeScript"></a>
  <a href="https://codecov.io/gh/JackChen-me/open-multi-agent"><img src="https://codecov.io/gh/JackChen-me/open-multi-agent/graph/badge.svg" alt="codecov"></a>
  <a href="https://github.com/JackChen-me/open-multi-agent/blob/main/package.json"><img src="https://img.shields.io/badge/runtime_deps-3-brightgreen" alt="runtime deps"></a>
  <a href="https://github.com/JackChen-me/open-multi-agent/stargazers"><img src="https://img.shields.io/github/stars/JackChen-me/open-multi-agent" alt="GitHub stars"></a>
  <a href="https://github.com/JackChen-me/open-multi-agent/network/members"><img src="https://img.shields.io/github/forks/JackChen-me/open-multi-agent" alt="GitHub forks"></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/JackChen-me/open-multi-agent/main/.github/brand/demo-dashboard-hero.gif" alt="Animated task DAG dashboard: coordinator decomposes a goal into tasks, executes them in parallel, and synthesizes the result — with token breakdown and agent output log" width="960" height="456" loading="eager">
</p>

<br />

<p align="center">
  <a href="./README.md">English</a> · <strong>中文</strong>
</p>

<br />

`open-multi-agent` 是面向 TypeScript 后端的多智能体编排框架。给定一个目标，协调者 agent 会将其拆解为任务 DAG，并行执行独立任务，合成最终结果。仅 3 个运行时依赖，可直接嵌入任意现有 Node.js 后端。

> **工程师只描述目标，不画任务图。**

## 快速开始

要求 Node.js >= 18。

### 在你的项目里使用

```bash
npm install @jackchen_me/open-multi-agent
export ANTHROPIC_API_KEY=sk-...
```

```typescript
import { OpenMultiAgent, type AgentConfig } from '@jackchen_me/open-multi-agent'

const agents: AgentConfig[] = [
  { name: 'architect', model: 'claude-sonnet-4-6', systemPrompt: 'Design clean API contracts.', tools: ['file_write'] },
  { name: 'developer', model: 'claude-sonnet-4-6', systemPrompt: 'Implement runnable TypeScript.', tools: ['bash', 'file_read', 'file_write', 'file_edit'] },
  { name: 'reviewer', model: 'claude-sonnet-4-6', systemPrompt: 'Review correctness and security.', tools: ['file_read', 'grep'] },
]

const orchestrator = new OpenMultiAgent({
  defaultModel: 'claude-sonnet-4-6',
  onProgress: (event) => console.log(event.type, event.task ?? event.agent ?? ''),
})

const team = orchestrator.createTeam('api-team', { name: 'api-team', agents, sharedMemory: true })
const result = await orchestrator.runTeam(team, 'Create a REST API for a todo list in /tmp/todo-api/')

console.log(result.success, result.totalTokenUsage.output_tokens)
```

### 本地试跑

```bash
git clone https://github.com/JackChen-me/open-multi-agent && cd open-multi-agent
npm install
export ANTHROPIC_API_KEY=sk-...
npx tsx examples/basics/team-collaboration.ts
```

三个 agent（architect、developer、reviewer）协作产出 REST API，`onProgress` 实时输出协调者的任务 DAG：

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

通过 Ollama 运行本地模型不需要 API key，见 [`providers/ollama`](examples/providers/ollama.ts)。其他 provider（`OPENAI_API_KEY`、`GEMINI_API_KEY` 等）见[支持的 Provider](#支持的-provider)。

### 三种运行模式

| 模式 | 方法 | 适用场景 | 示例 |
|------|------|----------|------|
| 单智能体 | `runAgent()` | 一个智能体，一个提示词，最简入口 | [`basics/single-agent`](examples/basics/single-agent.ts) |
| 自动编排团队 | `runTeam()` | 给一个目标，框架自动规划和执行 | [`basics/team-collaboration`](examples/basics/team-collaboration.ts) |
| 显式任务管线 | `runTasks()` | 你自己定义任务图和分配 | [`basics/task-pipeline`](examples/basics/task-pipeline.ts) |

不执行 agent，只预览协调者拆出的任务 DAG：

```ts
const plan = await orchestrator.runTeam(team, goal, { planOnly: true })
```

要 MapReduce 风格的 fan-out 但不需要任务依赖，直接用 `AgentPool.runParallel()`。例子见 [`patterns/fan-out-aggregate`](examples/patterns/fan-out-aggregate.ts)。

Shell 和 CI 场景使用 JSON-first 的 `oma` 命令行工具。详见 [docs/cli.md](./docs/cli.md)。

## 功能一览

| 能力 | 说明 |
|------|------|
| **目标驱动协调者** | 一个 `runTeam(team, goal)` 调用，协调者把目标拆成任务 DAG，并行执行独立任务，合成最终结果。 |
| **同队混用 provider** | 10 家原生：Anthropic、OpenAI、Azure、Bedrock、Gemini、Grok、DeepSeek、MiniMax、Qiniu、Copilot；Ollama / vLLM / LM Studio / OpenRouter / Groq 走 OpenAI 兼容协议。([完整说明](./docs/providers.md)) |
| **工具 + MCP** | 6 个内置（`bash`、`file_*`、`grep`、`glob`），可选启用 `delegate_to_agent`，用 `defineTool()` + Zod 自定义，任意 MCP server 通过 `connectMCPTools()` 接入。([工具配置](./docs/tool-configuration.md)) |
| **流式 + 结构化输出** | 每个 adapter 都支持 token 级流式输出；用 Zod schema 校验最终答复，解析失败自动重试。([`structured-output`](examples/patterns/structured-output.ts)) |
| **可观测性** | `onProgress` 事件、`onTrace` span，运行结束后渲染任务 DAG 的 HTML dashboard。([可观测性指南](./docs/observability.md)) |
| **可插拔共享记忆** | 默认进程内 KV；实现 `MemoryStore` 接口即可换 Redis / Postgres / 自家后端。([共享记忆](./docs/shared-memory.md)) |

生产级控制（上下文策略、任务重试退避、循环检测、工具输出截断/压缩）见 [生产级检查清单](#生产级检查清单)。

## 示例

[`examples/`](./examples/) 按类别分为 basics、cookbook、patterns、providers、integrations、production。完整索引见 [`examples/README.md`](./examples/README.md)。

### 真实业务流程（[`cookbook/`](./examples/cookbook/)）

端到端可直接跑的场景，每个都是完整、开箱即用的工作流。

- [`contract-review-dag`](examples/cookbook/contract-review-dag.ts)：四任务 DAG 做合同审阅，分支并行 + 出错按步骤重试。
- [`meeting-summarizer`](examples/cookbook/meeting-summarizer.ts)：三个专精 agent 并行处理会议转录稿，聚合 agent 合成含行动项和情绪分析的 Markdown 报告。
- [`competitive-monitoring`](examples/cookbook/competitive-monitoring.ts)：三个来源 agent 并行从信息流抽取声明，聚合 agent 跨源校对、标记矛盾。
- [`translation-backtranslation`](examples/cookbook/translation-backtranslation.ts)：用一个 provider 翻译 EN 到目标语言，另一个 provider 回译，标记语义漂移。

### 模式与集成

- [`basics/team-collaboration`](examples/basics/team-collaboration.ts)：`runTeam()` 协调者模式。
- [`patterns/structured-output`](examples/patterns/structured-output.ts)：任意 agent 产出 Zod 校验过的 JSON。
- [`patterns/fan-out-aggregate`](examples/patterns/fan-out-aggregate.ts)：`AgentPool.runParallel()` 做 MapReduce 风格 fan-out。
- [`patterns/agent-handoff`](examples/patterns/agent-handoff.ts)：`delegate_to_agent` 同步子智能体委派。
- [`integrations/trace-observability`](examples/integrations/trace-observability.ts)：`onTrace` 回调，给 LLM 调用、工具、任务发结构化 span。
- [`integrations/mcp-github`](examples/integrations/mcp-github.ts)：用 `connectMCPTools()` 把 MCP 服务器的工具暴露给 agent。
- [`integrations/with-vercel-ai-sdk`](examples/integrations/with-vercel-ai-sdk/)：Next.js 应用，OMA `runTeam()` 配合 AI SDK `useChat` 流式输出。
- **Provider 示例**：[`examples/providers/`](examples/providers/) 下的脚本，覆盖托管 provider、OpenAI 兼容端点和本地模型。

运行任意脚本：`npx tsx examples/<path>.ts`。

## 与其他框架对比

按需求快速选型。以下逐一分析差异。

| 你的需求 | 选 |
|----------|----|
| 固定的生产拓扑 + 成熟的 checkpoint | LangGraph JS |
| 显式 Supervisor + 手写 workflow | Mastra |
| Python 栈 + 成熟多智能体生态 | CrewAI |
| AI 应用工具集，广泛 provider 支持 | Vercel AI SDK |
| **TypeScript + 一句话从目标到结果，自动拆任务** | **open-multi-agent** |

**对比 LangGraph JS。** LangGraph 把声明式图（节点、边、条件路由）编译成可调用对象。`open-multi-agent` 是 Coordinator 在运行时把目标拆成任务 DAG，再自动并行无依赖项。终点一样（编排执行），方向相反：LangGraph 图优先，OMA 目标优先。

**对比 Mastra。** 两者都是原生 TypeScript。Mastra 的 Supervisor 模式要你手接 agent 和 workflow；OMA 的 Coordinator 在运行时从目标字符串自动接好。如果流程已经明确，Mastra 的显式控制更有优势；如果不想每一步都自己写，OMA 一个 `runTeam(team, goal)` 调用即可。

**对比 CrewAI。** CrewAI 是 Python 阵营成熟的多智能体方案。OMA 面向 TypeScript 后端，3 个运行时依赖，直接嵌入 Node.js。编排能力大致持平，按语言栈选。

**对比 Vercel AI SDK。** AI SDK 是应用和 LLM 调用层（provider 抽象、流式、tool call、结构化输出）。它不做多智能体编排。两者互补：单 agent 调用使用 AI SDK，需要多 agent 协作时引入 OMA。

## 生态

`open-multi-agent` 2026-04-01 发布，MIT 协议。当前公开在用与集成的项目：

### 生产环境在用

- **[temodar-agent](https://github.com/xeloxa/temodar-agent)**（约 60 stars）。WordPress 安全分析平台，作者 [Ali Sünbül](https://github.com/xeloxa)。在 Docker runtime 里直接用我们的内置工具（`bash`、`file_*`、`grep`）。已确认生产环境使用。
- **家用服务器 Cybersecurity SOC。** 本地完全离线跑 Qwen 2.5 + DeepSeek Coder（通过 Ollama），在 Wazuh + Proxmox 上搭自主 SOC 流水线。早期用户，未公开。

如果在生产或 side project 中使用了 `open-multi-agent`，[请开个 Discussion](https://github.com/JackChen-me/open-multi-agent/discussions)，我们会将其列在这里。

### 集成

- **[Engram](https://www.engram-memory.com)** — "Git for AI memory." Syncs knowledge across agents instantly and flags conflicts. ([repo](https://github.com/Agentscreator/engram-memory))
- **[@agentsonar/oma](https://github.com/agentsonar/agentsonar-oma)** — Sidecar detecting cross-run delegation cycles, repetition, and rate bursts.

做了 `open-multi-agent` 集成？[开个 Discussion](https://github.com/JackChen-me/open-multi-agent/discussions)，我们会将其列在这里。

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
         │               │  - BedrockAdapter      │
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

## 核心概念

- **工具 + MCP。** 内置工具涵盖 `bash`、`file_read`、`file_write`、`file_edit`、`grep`、`glob`；自定义工具用 `defineTool()` + Zod；stdio MCP 服务器通过 `connectMCPTools()` 接入。详见 [工具配置](./docs/tool-configuration.md)。
- **可观测性。** 通过 `onProgress` 获取实时生命周期事件，通过 `onTrace` 获取结构化 span，调用 `renderTeamRunDashboard(result)` 生成静态 DAG dashboard。详见 [可观测性](./docs/observability.md)。
- **共享记忆。** 用默认的进程内 KV，或换 Redis、Postgres、Engram，或任何实现了 `MemoryStore` 的后端。详见 [共享记忆](./docs/shared-memory.md)。
- **上下文管理。** 对长时间运行的 agent 用滑动窗口、摘要、规则压缩或自定义压缩器。详见 [上下文管理](./docs/context-management.md)。

## 支持的 Provider

改 `provider`、`model`，设好对应的环境变量。agent 配置结构不变。

```typescript
const agent: AgentConfig = {
  name: 'my-agent',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  systemPrompt: 'You are a helpful assistant.',
}
```

| 类型 | 配置方式 | 服务 |
|------|--------|------|
| 内置快捷方式 | 设 `provider` 为 `anthropic`、`gemini`、`openai`、`azure-openai`、`copilot`、`grok`、`deepseek`、`minimax`、`qiniu`、`bedrock`；框架自带 endpoint。 | Anthropic、Gemini、OpenAI、Azure OpenAI、GitHub Copilot、xAI Grok、DeepSeek、MiniMax、Qiniu、AWS Bedrock |
| OpenAI 兼容端点 | 设 `provider: 'openai'` + `baseURL`，必要时加 `apiKey`。 | Ollama、vLLM、LM Studio、llama.cpp server、OpenRouter、Groq、Mistral |


详见 [docs/providers.md](./docs/providers.md)，含环境变量、模型示例、本地模型工具调用、超时设置、常见问题。

## 生产级检查清单

上线前逐一配置以下项目：控制 token 开销、能从失败中恢复、出了问题能排查。

| 关注点 | 配置项 | 作用域 |
|--------|--------|--------|
| 控制对话长度 | `maxTurns`（每个 agent）+ `contextStrategy`（`sliding-window` / `summarize` / `compact` / `custom`） | `AgentConfig` |
| 限制工具输出 | `maxToolOutputChars`（或单工具 `maxOutputChars`）+ `compressToolResults: true` | `AgentConfig` 和 `defineTool()` |
| 失败重试 | 任务级 `maxRetries`、`retryDelayMs`、`retryBackoff`（指数退避倍率） | 通过 `runTasks()` 用的任务配置 |
| 总额封顶 | orchestrator 上设 `maxTokenBudget` | `OrchestratorConfig` |
| 卡死检测 | `loopDetection` + `onLoopDetected: 'terminate'`（或自定义 handler） | `AgentConfig` |
| 追踪与审计 | `onTrace` 接你的 tracing 后端；落盘 `renderTeamRunDashboard(result)` | `OrchestratorConfig` |

## 参与贡献

Issue、feature request、PR 都欢迎。特别欢迎以下方面的贡献：

- **生产级示例。** 端到端跑通的真实场景工作流。收录条件和提交格式见 [`examples/production/README.md`](./examples/production/README.md)。
- **文档。** 指南、教程、API 文档。
- **翻译。** 把这份 README 翻译成其他语言。[提个 PR](https://github.com/JackChen-me/open-multi-agent/pulls)。

## 贡献者

<a href="https://github.com/JackChen-me/open-multi-agent/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=JackChen-me/open-multi-agent&max=100&v=20260507" />
</a>

<details>
<summary>按领域展开贡献者致谢</summary>

**框架功能**

- [@ibrahimkzmv](https://github.com/ibrahimkzmv)（token 预算、上下文策略、依赖隔离上下文、工具预设、glob、MCP 集成、可配置 Coordinator、CLI、Dashboard 渲染、trace 事件类型）
- [@apollo-mg](https://github.com/apollo-mg)（上下文压缩修复、采样参数）
- [@tizerluo](https://github.com/tizerluo)（onPlanReady、onAgentStream）
- [@CodingBangboo](https://github.com/CodingBangboo)（planOnly 模式）
- [@Xin-Mai](https://github.com/Xin-Mai)（output schema 验证）
- [@JasonOA888](https://github.com/JasonOA888)（AbortSignal 支持）
- [@EchoOfZion](https://github.com/EchoOfZion)（简单目标跳过 Coordinator）
- [@voidborne-d](https://github.com/voidborne-d)（OpenAI 混合内容修复）
- [@NamelessNATM](https://github.com/NamelessNATM)（agent 委派基础实现）
- [@MyPrototypeWhat](https://github.com/MyPrototypeWhat)（reasoning blocks、reasoning_effort、采样参数对齐、trace 输入输出）
- [@SiMinus](https://github.com/SiMinus)（流式 reasoning 事件）

**Provider 集成**

- [@ibrahimkzmv](https://github.com/ibrahimkzmv)（Gemini）
- [@hkalex](https://github.com/hkalex)（DeepSeek、MiniMax）
- [@marceloceccon](https://github.com/marceloceccon)（Grok）
- [@Klarline](https://github.com/Klarline)（Azure OpenAI）
- [@Deathwing](https://github.com/Deathwing)（GitHub Copilot）
- [@JackChiang233](https://github.com/JackChiang233)（Qiniu）
- [@CodingBangboo](https://github.com/CodingBangboo)（AWS Bedrock）

**示例与 Cookbook**

- [@mvanhorn](https://github.com/mvanhorn)（研究聚合、代码评审、会议总结、Groq 示例、Mistral 示例）
- [@Kinoo0](https://github.com/Kinoo0)（代码评审升级）
- [@Optimisttt](https://github.com/Optimisttt)（研究聚合升级）
- [@Agentscreator](https://github.com/Agentscreator)（Engram 记忆集成）
- [@fault-segment](https://github.com/fault-segment)（合同审查 DAG）
- [@HuXiangyu123](https://github.com/HuXiangyu123)（分级成本示例）
- [@zouhh22333-beep](https://github.com/zouhh22333-beep)（翻译/回译）
- [@pei-pei45](https://github.com/pei-pei45)（竞品监测）
- [@mmjwxbc](https://github.com/mmjwxbc)（面试模拟器）
- [@binghuaren96](https://github.com/binghuaren96)（事故复盘 DAG）
- [@DaiMao-UT](https://github.com/DaiMao-UT)（论文复现分诊）
- [@oooooowoooooo](https://github.com/oooooowoooooo)（罕见病信息分诊）
- [@CodingBangboo](https://github.com/CodingBangboo)（Express 客服流水线）

**文档与测试**

- [@tmchow](https://github.com/tmchow)（llama.cpp 文档）
- [@kenrogers](https://github.com/kenrogers)（OpenRouter 文档）
- [@jadegold55](https://github.com/jadegold55)（LLM adapter 测试覆盖）

</details>

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
