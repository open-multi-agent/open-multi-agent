<br />

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/open-multi-agent/open-multi-agent/main/.github/brand/logo-mark-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/open-multi-agent/open-multi-agent/main/.github/brand/logo-mark-light.svg">
    <img alt="Open Multi-Agent" src="https://raw.githubusercontent.com/open-multi-agent/open-multi-agent/main/.github/brand/logo-mark-light.svg" width="96">
  </picture>
</p>

<br />

<h1 align="center">Open Multi-Agent</h1>

<p align="center">
  <strong>给一个目标，自动得到任务 DAG。</strong><br/>
  原生 TypeScript 多智能体编排，3 个运行时依赖。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@open-multi-agent/core"><img src="https://img.shields.io/npm/v/@open-multi-agent/core" alt="npm version"></a>
  <a href="https://github.com/open-multi-agent/open-multi-agent/actions/workflows/ci.yml"><img src="https://github.com/open-multi-agent/open-multi-agent/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.6-blue" alt="TypeScript"></a>
  <a href="https://codecov.io/gh/open-multi-agent/open-multi-agent"><img src="https://codecov.io/gh/open-multi-agent/open-multi-agent/graph/badge.svg" alt="codecov"></a>
  <a href="https://github.com/open-multi-agent/open-multi-agent/blob/main/packages/core/package.json"><img src="https://img.shields.io/badge/runtime_deps-3-brightgreen" alt="runtime deps"></a>
  <a href="https://github.com/open-multi-agent/open-multi-agent/stargazers"><img src="https://img.shields.io/github/stars/open-multi-agent/open-multi-agent" alt="GitHub stars"></a>
  <a href="https://github.com/open-multi-agent/open-multi-agent/network/members"><img src="https://img.shields.io/github/forks/open-multi-agent/open-multi-agent" alt="GitHub forks"></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/open-multi-agent/open-multi-agent/main/.github/brand/demo-dashboard-hero.gif" alt="Post-run dashboard replaying a completed team run: task DAG with per-node assignee, status, token breakdown, and agent output log" width="960" height="456" loading="eager">
</p>

<br />

<p align="center">
  <a href="./README.md">English</a> · <strong>中文</strong>
</p>

<br />

`open-multi-agent` 是面向 TypeScript 后端的多智能体编排框架。给定一个目标，协调者 agent 会将其拆解为任务 DAG，并行执行独立任务，合成最终结果。仅 3 个运行时依赖，可直接嵌入任意现有 Node.js 后端。

> **工程师只描述目标，不画任务图。**

图优先的框架要求你预先列出每个节点和每条边。`open-multi-agent` 是目标优先：你描述想要的结果，协调者在运行时构建任务 DAG，编排随目标自适应，而不必为某一个流程硬接线。

## 目录

[快速开始](#快速开始) · [三种运行模式](#三种运行模式) · [功能一览](#功能一览) · [编排控制](#编排控制) · [生态](#生态) · [示例](#示例) · [与其他框架对比](#与其他框架对比) · [架构](#架构) · [支持的 Provider](#支持的-provider) · [生产级检查清单](#生产级检查清单) · [文档](#文档) · [参与贡献](#参与贡献)

## 快速开始

要求 Node.js >= 18。

```bash
npm install @open-multi-agent/core
```

*正在从 `@jackchen_me/open-multi-agent` 迁移？该包已弃用，请改用 `@open-multi-agent/core`。*

```typescript
import { OpenMultiAgent, type AgentConfig } from '@open-multi-agent/core'

// 内置工具默认拒绝（default-deny）：每个 agent 只拿到自己在 `tools`（或 `toolPreset`）
// 里列出的工具；两者都不写就一个都不给。
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

// 内置文件系统工具默认沙箱根目录为 `<cwd>/.agent-workspace`，
// 给 agent 的 prompt 里需要使用该目录内的绝对路径。
const result = await orchestrator.runTeam(
  team,
  `Create a REST API for a todo list in ${process.cwd()}/.agent-workspace/todo-api/`,
)

console.log(result.success, result.totalTokenUsage.output_tokens)
```

### 本地试跑

```bash
git clone https://github.com/open-multi-agent/open-multi-agent && cd open-multi-agent
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

## 三种运行模式

| 模式 | 方法 | 适用场景 | 示例 |
|------|------|----------|------|
| 单智能体 | `runAgent()` | 一个智能体，一个提示词，最简入口 | [`basics/single-agent`](examples/basics/single-agent.ts) |
| 自动编排团队 | `runTeam()` | 给一个目标，框架自动规划和执行 | [`basics/team-collaboration`](examples/basics/team-collaboration.ts) |
| 显式任务管线 | `runTasks()` | 你自己定义任务图和分配 | [`basics/task-pipeline`](examples/basics/task-pipeline.ts) |

不执行 agent，只预览协调者拆出的任务 DAG；也可以把这份计划固定下来，之后无需再次调用协调者就重放同一张图：

```ts
// 先拆解一次，审阅计划
const preview = await orchestrator.runTeam(team, goal, { planOnly: true })

// 转成可 diff、可纳入版本控制的产物（纯 JSON）
const plan = orchestrator.createPlanArtifact(preview)

// 之后：重放完全相同的图（task id、依赖、assignee 都不变），不经过协调者
const result = await orchestrator.runFromPlan(team, plan)
```

用一份可选的 `modelRouting` 策略，把不同编排阶段路由到不同模型：旗舰模型负责规划，便宜模型跑叶子任务。可按 phase、agent、任务 role/priority 或 leaf 状态匹配；first match wins，不设置则模型选择保持不变。见 [模型路由](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/model-routing.md)。

## 功能一览

| 能力 | 说明 |
|------|------|
| **目标驱动协调者** | 一个 `runTeam(team, goal)` 调用，把目标拆成任务 DAG，并行执行独立任务，合成最终结果。未分配的任务自动调度——`dependency-first`（默认）、`round-robin`、`least-busy` 或 `capability-match`。 |
| **同队混用 provider** | 12 家内置 provider，外加任意 OpenAI 兼容端点（Ollama、vLLM、LM Studio、OpenRouter、Groq），同队可自由混用。把 tool call 当纯文本输出的本地 server 会由 fallback 解析器兜底。([完整清单](#支持的-provider) · [配置](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/providers.md)) |
| **扩展思考 / 推理** | 一份 `thinking` 配置映射到 Anthropic thinking、Gemini `thinkingConfig` 和 OpenAI `reasoning_effort`；推理以事件流式输出，并可选在切换 provider 时保留。([`cross-provider-reasoning`](examples/patterns/cross-provider-reasoning.ts)) |
| **工具 + MCP** | 6 个内置（`bash`、`file_*`、`grep`、`glob`），全部**默认拒绝**（default-deny——用 `tools` / `toolPreset` 授予），外加 `delegate_to_agent` handoff（带 cycle + depth 护栏），用 `defineTool()` + Zod 自定义，任意 MCP server 通过 `connectMCPTools()` 接入。([工具配置](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/tool-configuration.md)) |
| **流式 + 结构化输出** | 每个 adapter 都支持 token 级流式输出（团队运行时通过 `onAgentStream` 拿到每个 agent 的流）；用 Zod schema 校验最终答复，解析失败自动重试。([`structured-output`](examples/patterns/structured-output.ts)) |
| **人工介入（Human-in-the-loop）** | 用 `onPlanReady`（任何 agent 执行前审批整个计划）和 `onApproval`（每轮任务之间审批）卡点，或用 `planOnly` 先预览。 |
| **固定并重放计划** | 用 `createPlanArtifact` 把 `planOnly` 的拆解结果序列化，之后 `runFromPlan` 不再调用协调者，直接重放完全相同的任务图。（[`patterns/plan-replay`](examples/patterns/plan-replay.ts)） |
| **生命周期钩子 + 取消** | `beforeRun` 改写 prompt，`afterRun` 后处理或拒绝结果；传入 `AbortSignal` 即可中途取消运行。 |
| **可配置协调者** | 通过 `runTeam(team, goal, { coordinator })` 覆盖协调者的 model、provider、adapter、system prompt 或工具。 |
| **可观测性** | `onProgress` 事件、`onTrace` span，运行结束后渲染任务 DAG 的 HTML dashboard。API key 和 token 会从 trace、bash 输出和 dashboard 中自动脱敏。([可观测性指南](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/observability.md)) |
| **可插拔共享记忆** | 默认进程内 KV；实现 `MemoryStore` 接口即可换 Redis / Postgres / 自家后端。([共享记忆](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/shared-memory.md)) |
| **沙箱化文件系统工作目录** | 内置文件系统工具默认沙箱化在 `<cwd>/.agent-workspace`；继承默认配置的 agent 共享同一根目录。需要 per-agent 隔离时显式设置 `AgentConfig.cwd`；改换共享根目录用 `OrchestratorConfig.defaultCwd`；传 `null` 关闭沙箱。([沙箱配置](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/tool-configuration.md)) |

生产级控制（[上下文策略](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/context-management.md)、任务重试退避、循环检测、工具输出截断/压缩）见 [生产级检查清单](#生产级检查清单)。

## 编排控制

对一次 `runTeam` 运行的精细控制。全部可选；默认行为不变。

**注入团队上下文。** 把目标、roster、当前 worker 的角色注入每个 worker 的 prompt——帮助 worker 与整体目标保持一致，也让多步运行更易调试。默认关闭；省略时 worker prompt 保持逐字节不变。

```ts
await orchestrator.runTeam(team, goal, { revealCoordinator: true })
```

**执行前审批。** 在任何 agent 执行前检查协调者的计划，并在每轮任务之间再次审批。这两个钩子在 orchestrator 上。返回 `false` 即中止，剩余任务标记为 `skipped`。

```ts
const orchestrator = new OpenMultiAgent({
  onPlanReady: async (tasks) => tasks.length <= 10,        // 审批整个计划
  onApproval:  async (completed, next) => next.length > 0, // 审批每一轮
})
```

**取消运行。** 传入 `AbortSignal`；触发 abort 即中止运行。

```ts
const controller = new AbortController()
const run = orchestrator.runTeam(team, goal, { abortSignal: controller.signal })
// 在别处调用 controller.abort() 取消
```

**配置协调者。** 给规划者单独指定 model、adapter 或额外指令，不影响 worker agent。

```ts
await orchestrator.runTeam(team, goal, {
  coordinator: { model: 'claude-opus-4-6', instructions: 'Prefer fewer, larger tasks.' },
})
```

**无依赖 fan-out。** 要 MapReduce 风格的并行，直接用 `AgentPool.runParallel()`。见 [`patterns/fan-out-aggregate`](examples/patterns/fan-out-aggregate.ts)。

**Shell 和 CI。** 使用 JSON-first 的 `oma` 命令行工具。详见 [docs/cli.md](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/cli.md)。

## 生态

`open-multi-agent` 2026-04-01 发布，MIT 协议。当前公开在用与集成的项目：

### 生产环境在用

- **[temodar-agent](https://github.com/xeloxa/temodar-agent)**（约 60 stars）。WordPress 安全分析平台，作者 [Ali Sünbül](https://github.com/xeloxa)。在 Docker runtime 里直接用我们的内置工具（`bash`、`file_*`、`grep`）。已确认生产环境使用。

如果在生产或 side project 中使用了 `open-multi-agent`，[请开个 Discussion](https://github.com/open-multi-agent/open-multi-agent/discussions)，我们会将其列在这里。

### 集成

- **[Engram](https://www.engram-memory.com)** — "AI 记忆的 Git"。在 agent 之间即时同步知识并标记冲突。([repo](https://github.com/Agentscreator/engram-memory))
- **[@agentsonar/oma](https://github.com/agentsonar/agentsonar-oma)** — Sidecar，检测跨运行的委派环、重复和速率突增。

做了 `open-multi-agent` 集成？见[集成提交指南](examples/integrations/README.md)：如何提交 reference / vendor 示例，以及如何被列入这里。

### Provider 社区优惠

面向 `open-multi-agent` 用户的限时 provider 优惠。该列表不代表付费背书或唯一官方推荐。

- **[MiniMax](https://platform.minimaxi.com/subscribe/token-plan?code=98qruMqQhL&source=link)** — 在 OMA 的 TypeScript 多智能体工作流中使用 MiniMax M3。OMA 用户可在 2026-06-30 前享 MiniMax Token Plan 专属 88 折优惠。见 [MiniMax 接入指南](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/providers/minimax.md)。

### Featured partner

面向已经深度集成 `open-multi-agent` 的产品和平台。条款和申请方式见 [Featured partner 计划](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/featured-partner.md)。

## 示例

[`examples/`](./examples/) 按类别分为 basics、cookbook、patterns、providers、integrations。完整索引见 [`examples/README.md`](./examples/README.md)。（[`production/`](./examples/production/README.md) 正在征集贡献——见收录标准。）

### 真实业务流程（[`cookbook/`](./examples/cookbook/)）

端到端可直接跑的场景，每个都是完整、开箱即用的工作流。

- [`contract-review-dag`](examples/cookbook/contract-review-dag.ts)：四任务 DAG 做合同审阅，分支并行 + 出错按步骤重试。
- [`meeting-summarizer`](examples/cookbook/meeting-summarizer.ts)：三个专精 agent 并行处理会议转录稿，聚合 agent 合成含行动项和情绪分析的 Markdown 报告。
- [`competitive-monitoring`](examples/cookbook/competitive-monitoring.ts)：三个来源 agent 并行从信息流抽取声明，聚合 agent 跨源校对、标记矛盾。
- [`translation-backtranslation`](examples/cookbook/translation-backtranslation.ts)：用一个 provider 翻译 EN 到目标语言，另一个 provider 回译，标记语义漂移。
- [`incident-postmortem-dag`](examples/cookbook/incident-postmortem-dag.ts)：三个独立根任务在 t=0 并行展开，再由 root-cause 假设器和复盘撰写器合成为一份文档。
- [`personalized-interview-simulator`](examples/cookbook/personalized-interview-simulator.ts)：有状态的面试官（跨轮次用 `Agent.prompt()`）加一个读取完整转录的观察者，用 `readline` 接入人工输入，结束时产出 Zod 校验的复盘。

### 模式与集成

- [`basics/team-collaboration`](examples/basics/team-collaboration.ts)：`runTeam()` 协调者模式。
- [`patterns/structured-output`](examples/patterns/structured-output.ts)：任意 agent 产出 Zod 校验过的 JSON。
- [`patterns/multi-perspective-code-review`](examples/patterns/multi-perspective-code-review.ts)：生成器产出代码，安全、性能、风格三个评审并行，再由合成器返回 Zod 校验的发现列表。
- [`patterns/cross-provider-reasoning`](examples/patterns/cross-provider-reasoning.ts)：通过 `preserveReasoningAsText` 在切换 provider 时保留推理模型的思考流。
- [`patterns/cost-tiered-pipeline`](examples/patterns/cost-tiered-pipeline.ts)：每个阶段分配不同 model，用 `onTrace` 的 token 计数估算各 model 的 USD 成本。
- [`patterns/fan-out-aggregate`](examples/patterns/fan-out-aggregate.ts)：`AgentPool.runParallel()` 做 MapReduce 风格 fan-out。
- [`patterns/agent-handoff`](examples/patterns/agent-handoff.ts)：`delegate_to_agent` 同步子智能体委派。
- [`patterns/plan-replay`](examples/patterns/plan-replay.ts)：用 `planOnly` 把目标拆解一次，用 `createPlanArtifact` 序列化，再用 `runFromPlan` 重放同一张 DAG，不重跑协调者。
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
│  - stream()       │    │  - 12 built-in         │
└────────┬──────────┘    │    providers           │
         │               │  - OpenAI-compatible   │
         │               │  - AI SDK bridge       │
         │               └────────────────────────┘
┌────────▼──────────┐
│  AgentRunner      │    ┌──────────────────────┐
│  - conversation   │───►│  ToolRegistry        │
│    loop           │    │  - defineTool()      │
│  - tool dispatch  │    │  - 6 built-in tools  │
└───────────────────┘    │  + delegate (opt-in) │
                         └──────────────────────┘
```

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
| 内置快捷方式 | 设 `provider` 为 `anthropic`、`gemini`、`openai`、`azure-openai`、`copilot`、`grok`、`deepseek`、`doubao`、`hunyuan`、`minimax`、`mimo`、`qiniu`、`bedrock`；框架自带 endpoint。 | Anthropic、Gemini、OpenAI、Azure OpenAI、GitHub Copilot、xAI Grok、DeepSeek、Doubao（火山引擎）、Hunyuan（腾讯混元 MaaS）、MiniMax、MiMo、Qiniu、AWS Bedrock |
| OpenAI 兼容端点 | 设 `provider: 'openai'` + `baseURL`，必要时加 `apiKey`。 | Ollama、vLLM、LM Studio、llama.cpp server、OpenRouter、Groq、Mistral、Moonshot（Kimi）、Qwen、Zhipu（智谱） |
| Vercel AI SDK | 从 `@open-multi-agent/core/ai-sdk` 导入 `AISdkAdapter`；安装可选 peer `ai` 加一个 `@ai-sdk/*` provider。 | [任意 AI SDK provider](https://ai-sdk.dev/providers)（60+ 模型与平台） |

详见 [docs/providers.md](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/providers.md)，含环境变量、模型示例、本地模型工具调用、超时设置、常见问题。

### Vercel AI SDK（可选）

安装可选 peer [`ai`](https://www.npmjs.com/package/ai) 以及你需要的任意 [`@ai-sdk` provider](https://ai-sdk.dev/providers)（例如 [`@ai-sdk/openai`](https://www.npmjs.com/package/@ai-sdk/openai)）。在 `AgentConfig` 上传入 `adapter: new AISdkAdapter(model)`，即可让该 agent 走 AI SDK，而不是内置的 `provider` 工厂。设置了 `adapter` 时，`provider`、`apiKey`、`baseURL`、`region` 都会被忽略。混合团队照常工作：只有带 `adapter` 的 agent 才走 AI SDK。

```typescript
import { openai } from '@ai-sdk/openai'
import { AISdkAdapter } from '@open-multi-agent/core/ai-sdk'
import { OpenMultiAgent } from '@open-multi-agent/core'

const oma = new OpenMultiAgent()
await oma.runAgent(
  {
    name: 'researcher',
    model: 'gpt-4o',
    adapter: new AISdkAdapter(openai('gpt-4o')),
    systemPrompt: 'You are a researcher.',
  },
  'What are the latest AI trends?',
)
```

协调者也支持同样的钩子：`runTeam(team, goal, { coordinator: { adapter: new AISdkAdapter(...) } })`。

## 生产级检查清单

上线前逐一配置以下项目：控制 token 开销、能从失败中恢复、出了问题能排查。

| 关注点 | 配置项 | 作用域 |
|--------|--------|--------|
| 控制对话长度 | `maxTurns`（每个 agent）+ `contextStrategy`（`sliding-window` / `summarize` / `compact` / `custom`） | `AgentConfig` |
| 控制运行时长 | `timeoutMs`（每个 agent，运行挂起时中止；本地模型常见） | `AgentConfig` |
| 限制工具输出 | `maxToolOutputChars`（或单工具 `maxOutputChars`）+ `compressToolResults: true` | `AgentConfig` 和 `defineTool()` |
| 失败重试 | 任务级 `maxRetries`、`retryDelayMs`、`retryBackoff`（指数退避倍率） | 通过 `runTasks()` 用的任务配置 |
| 总额封顶 | orchestrator 上设 `maxTokenBudget` | `OrchestratorConfig` |
| 卡死检测 | `loopDetection` + `onLoopDetected: 'terminate'`（或自定义 handler） | `AgentConfig` |
| 追踪与审计 | `onTrace` 接你的 tracing 后端；落盘 `renderTeamRunDashboard(result)` | `OrchestratorConfig` |
| 脱敏密钥 | 自动——API key、token、Authorization header 从 trace、bash 输出、dashboard payload 中剥除 | 内置（默认开启） |
| 按需授予工具 | 内置工具默认拒绝（default-deny）：agent 只拿到自己在 `tools` / `toolPreset` 里列出的工具，都不写就一个都没有。`bash` 一旦授予仍是无沙箱的，且每次工具结果都会发给你的模型 provider——所以读取/执行权限要刻意授予。`defaultToolPreset` 可一行恢复旧的「全部工具」行为 | `AgentConfig` / `OrchestratorConfig` |
| 限定 agent 文件操作范围 | `cwd` / `defaultCwd`（默认 `.agent-workspace` 子目录；用 `process.cwd()` 放宽、`null` 关闭） | `AgentConfig` / `OrchestratorConfig` |

## 文档

- [Provider](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/providers.md) — 环境变量、模型示例、本地模型工具调用、超时、常见问题。
- [工具配置](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/tool-configuration.md) — 工具预设、自定义工具、文件系统沙箱、MCP。
- [可观测性](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/observability.md) — `onProgress` 事件、`onTrace` span、运行后 dashboard。
- [共享记忆](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/shared-memory.md) — 默认存储与自定义 `MemoryStore` 后端。
- [上下文管理](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/context-management.md) — 滑动窗口、摘要、压缩、自定义压缩器。
- [CLI](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/cli.md) — 面向 shell 和 CI 的 JSON-first `oma` 命令行。
- [模型路由](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/model-routing.md) — 可选的 `modelRouting` 策略：按 phase / agent / role / priority / leaf 匹配，first match wins。

## 参与贡献

Issue、feature request、PR 都欢迎。特别欢迎以下方面的贡献：

- **生产级示例。** 端到端跑通的真实场景工作流。收录条件和提交格式见 [`examples/production/README.md`](./examples/production/README.md)。
- **文档。** 指南、教程、API 文档。
- **翻译。** 把这份 README 翻译成其他语言。[提个 PR](https://github.com/open-multi-agent/open-multi-agent/pulls)。

## 贡献者

<a href="https://github.com/open-multi-agent/open-multi-agent/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=open-multi-agent/open-multi-agent&max=100&v=20260529" />
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
- [@matthewYang08](https://github.com/matthewYang08)（OpenAI reasoning 转文本回退）
- [@dvirarad](https://github.com/dvirarad)（OpenAI 系列 adapter 健壮性）

**Provider 集成**

- [@ibrahimkzmv](https://github.com/ibrahimkzmv)（Gemini）
- [@hkalex](https://github.com/hkalex)（DeepSeek、MiniMax）
- [@marceloceccon](https://github.com/marceloceccon)（Grok）
- [@Klarline](https://github.com/Klarline)（Azure OpenAI）
- [@Deathwing](https://github.com/Deathwing)（GitHub Copilot）
- [@JackChiang233](https://github.com/JackChiang233)（Qiniu）
- [@CodingBangboo](https://github.com/CodingBangboo)（AWS Bedrock）
- [@kidoom](https://github.com/kidoom)（MiMo、Doubao）

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
- [@nuthalapativarun](https://github.com/nuthalapativarun)（Doubao、Zhipu provider 示例）
- [@goodneamtakenbydogs](https://github.com/goodneamtakenbydogs)（Moonshot、Qwen provider 示例）
- [@suans4746-del](https://github.com/suans4746-del)（叙事谜题提示仲裁）
- [@gregkonush](https://github.com/gregkonush)（Bilig WorkPaper MCP 集成）

**文档与测试**

- [@tmchow](https://github.com/tmchow)（llama.cpp 文档）
- [@kenrogers](https://github.com/kenrogers)（OpenRouter 文档）
- [@jadegold55](https://github.com/jadegold55)（LLM adapter 测试覆盖）
- [@btroops](https://github.com/btroops)（DeepSeek 工具调用测试）
- [@nuthalapativarun](https://github.com/nuthalapativarun)（上下文管理文档）

</details>

## 许可证

MIT
