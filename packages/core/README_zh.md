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
  原生 TypeScript 多智能体编排。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@open-multi-agent/core"><img src="https://img.shields.io/npm/v/@open-multi-agent/core" alt="npm version"></a>
  <a href="https://github.com/open-multi-agent/open-multi-agent/actions/workflows/ci.yml"><img src="https://github.com/open-multi-agent/open-multi-agent/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.6-blue" alt="TypeScript"></a>
  <a href="https://codecov.io/gh/open-multi-agent/open-multi-agent"><img src="https://codecov.io/gh/open-multi-agent/open-multi-agent/graph/badge.svg" alt="codecov"></a>
  <a href="https://github.com/open-multi-agent/open-multi-agent/stargazers"><img src="https://img.shields.io/github/stars/open-multi-agent/open-multi-agent" alt="GitHub stars"></a>
  <a href="https://github.com/open-multi-agent/open-multi-agent/network/members"><img src="https://img.shields.io/github/forks/open-multi-agent/open-multi-agent" alt="GitHub forks"></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/open-multi-agent/open-multi-agent/main/.github/brand/demo-dashboard-hero.gif" alt="Post-run dashboard replaying a completed team run: task DAG with per-node assignee, status, token breakdown, and agent output log" width="960" height="456" loading="eager">
</p>

<br />

<p align="center">
  <a href="https://open-multi-agent.com/zh/">官网</a> ·
  <a href="https://open-multi-agent.com/zh/getting-started/introduction/">文档</a> ·
  <a href="https://www.npmjs.com/package/@open-multi-agent/core">npm</a> ·
  <a href="https://github.com/open-multi-agent/open-multi-agent/discussions">讨论区</a>
</p>

<p align="center">
  <a href="./README.md">English</a> · <strong>中文</strong>
</p>

<br />

`open-multi-agent` 是面向 TypeScript 后端的多智能体编排框架，可直接嵌入任意 Node.js 应用。

> **工程师只描述目标，不画任务图。**

图优先的框架要求你预先列出每个节点与每条边。OMA 是**动态工作流**（dynamic workflow）：协调者在运行时把目标拆成任务 DAG，并行执行独立任务并合成结果；这份计划以数据形式交给确定性调度器执行，因此始终可审查、可回放。这与 Anthropic 在 2026 年 5 月为 Claude Code 推出的 [dynamic workflows](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code) 是同一押注；OMA 以开源库的形式把它带到任意 provider、你自己的后端。

轻量内核：编排引擎加上 Anthropic、OpenAI 及任意 OpenAI 兼容端点开箱即用；Gemini、Bedrock、MCP、Vercel AI SDK bridge 为可选 peer 依赖，按需安装。OpenTelemetry 通过独立可选包 `@open-multi-agent/otel` 集成：OTel API、SDK、semantic convention 映射和 exporter 集成均不进入 core root import，应用显式提供自己的 provider。

## 目录

[快速开始](#快速开始) · [三种运行模式](#三种运行模式) · [功能一览](#功能一览) · [编排控制](#编排控制) · [生态](#生态) · [示例](#示例) · [与其他框架对比](#与其他框架对比) · [架构](#架构) · [支持的 Provider](#支持的-provider) · [生产级检查清单](#生产级检查清单) · [文档](#文档) · [参与贡献](#参与贡献)

## 快速开始

要求 Node.js >= 18（可选的 Vercel AI SDK 7 桥接需要 Node.js >= 22）。

一条命令即可初始化项目并启动多 agent 运行：

```bash
npm create oma-app@latest
```

首次运行便会展示协调者将目标拆解为多 agent DAG，并打开本次运行的 dashboard。若要将库集成到现有项目：

```bash
npm install @open-multi-agent/core
```

*若正从 `@jackchen_me/open-multi-agent` 迁移：该包已弃用，请改用 `@open-multi-agent/core`。*

```typescript
import { OpenMultiAgent, type AgentConfig } from '@open-multi-agent/core'

// 适配任意 OpenAI 兼容 provider：用 OpenAI 就设 OPENAI_API_KEY；
// 用 Groq / DeepSeek / Ollama 等就设 OPENAI_BASE_URL + OMA_MODEL。
const model = process.env.OMA_MODEL ?? 'gpt-5.4'

// 内置工具默认拒绝（default-deny）：每个 agent 只拿到自己在 `tools`（或 `toolPreset`）
// 里列出的工具；两者都不写就一个都不给。
const agents: AgentConfig[] = [
  { name: 'architect', model, systemPrompt: 'Design clean API contracts.', tools: ['file_write'] },
  { name: 'developer', model, systemPrompt: 'Implement runnable TypeScript.', tools: ['bash', 'file_read', 'file_write', 'file_edit'] },
  { name: 'reviewer', model, systemPrompt: 'Review correctness and security.', tools: ['file_read', 'grep'] },
]

const orchestrator = new OpenMultiAgent({
  defaultProvider: 'openai',
  defaultModel: model,
  defaultBaseURL: process.env.OPENAI_BASE_URL, // 不设 = OpenAI
  onProgress: (event) => console.log(event.type, event.task ?? event.agent ?? ''),
})

const team = orchestrator.createTeam('api-team', { name: 'api-team', agents, sharedMemory: true })

// 内置文件系统工具默认沙箱根目录为 `<cwd>/.agent-workspace`。
const result = await orchestrator.runTeam(
  team,
  `Create a REST API for a todo list in ${process.cwd()}/.agent-workspace/todo-api/`,
)

console.log(result.success, result.status?.code, result.identity?.runId)
console.log(result.totalTokenUsage.output_tokens)
```

### 本地运行示例

```bash
git clone https://github.com/open-multi-agent/open-multi-agent && cd open-multi-agent
npm install
export OPENAI_API_KEY=sk-...
npx tsx packages/core/examples/basics/team-collaboration.ts
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

对需要严格把关的回答，`runConsensus()` 运行一个 proposer→judge 校验循环（可选的按任务 `verify` 钩子）。见 [Consensus](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/consensus.md)。

不执行 agent，只预览协调者拆解出的任务 DAG；也可将这份计划固定下来，之后无需再次调用协调者即可重放同一张图：

```ts
// 先拆解一次，审阅计划
const preview = await orchestrator.runTeam(team, goal, { planOnly: true })

// 转成可 diff、可纳入版本控制的产物（纯 JSON）
const plan = orchestrator.createPlanArtifact(preview)

// 之后：重放完全相同的图（task id、依赖、assignee 都不变），不经过协调者
const result = await orchestrator.runFromPlan(team, plan)
```

用一份可选的 `modelRouting` 策略，将不同编排阶段路由到不同模型：旗舰模型负责规划，廉价模型运行叶子任务。可按 phase、agent、任务 role/priority 或 leaf 状态匹配；first match wins，不设置则模型选择保持不变。见 [模型路由](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/model-routing.md)。

## 功能一览

| 能力 | 说明 |
|------|------|
| **目标驱动协调者** | 一个 `runTeam(team, goal)` 调用，将目标拆解为任务 DAG，并行执行独立任务，合成最终结果。未分配的任务自动调度：`dependency-first`（默认）、`round-robin`、`least-busy` 或 `capability-match`。 |
| **同队混用 provider** | 13 家内置 provider，外加任意 OpenAI 兼容端点（Ollama、vLLM、LM Studio、OpenRouter、Groq），同队可自由混用。将 tool call 作为纯文本输出的本地 server，由 fallback 解析器解析。([完整清单](#支持的-provider) · [配置](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/providers.md)) |
| **扩展思考 / 推理** | 一份 `thinking` 配置映射到 Anthropic thinking、Gemini `thinkingConfig` 和 OpenAI `reasoning_effort`；推理以事件流式输出，并可选在切换 provider 时保留。([`cross-provider-reasoning`](examples/patterns/cross-provider-reasoning.ts)) |
| **工具 + MCP** | 6 个内置（`bash`、`file_*`、`grep`、`glob`），全部**默认拒绝**（default-deny，用 `tools` / `toolPreset` 授予），外加 `delegate_to_agent` handoff（带 cycle + depth 护栏），用 `defineTool()` + Zod 自定义，任意 MCP server 通过 `connectMCPTools()` 接入。([工具配置](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/tool-configuration.md)) |
| **流式 + 结构化输出** | 每个 adapter 都支持 token 级流式输出（团队运行时通过 `onAgentStream` 拿到每个 agent 的流）；用 Zod schema 校验最终答复，解析失败自动重试。([`structured-output`](examples/patterns/structured-output.ts)) |
| **人工介入（Human-in-the-loop）** | 用 `onPlanReady`（任何 agent 执行前审批整个计划）和 `onApproval`（每轮任务之间审批）把关，或用 `planOnly` 先行预览。 |
| **固定并重放计划** | 用 `createPlanArtifact` 将 `planOnly` 的拆解结果序列化，之后 `runFromPlan` 不再调用协调者，直接重放完全相同的任务图。（[`patterns/plan-replay`](examples/patterns/plan-replay.ts)） |
| **生命周期钩子 + 取消** | `beforeRun` 改写 prompt，`afterRun` 后处理或拒绝结果；传入 `AbortSignal` 即可中途取消运行。 |
| **可配置协调者** | 通过 `runTeam(team, goal, { coordinator })` 覆盖协调者的 model、provider、adapter、system prompt 或工具。 |
| **外部编码 agent（ACP）** | 把某个 agent 的 LLM 循环换成通过 [Agent Client Protocol](https://agentclientprotocol.com) 驱动的外部编码 CLI：设置 `backend: { kind: 'acp', … }`，子进程自行运行其回合，而 pool、scheduler、queue、共享记忆与预算全部与 backend 无关。([外部 agent](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/external-agents.md)) |
| **可观测性** | 每个顶层结果都包含稳定的 `identity`（`runId`、`attempt`、`traceId`、`rootSpanId`）和标准化 `status`，即使未配置 `onTrace` 也不例外；同时继续提供 `onProgress` 事件、trace span、运行后 HTML dashboard 和 `TeamRunResult.metrics`。API key 和 token 会从 trace、错误、bash 输出和 dashboard 中自动脱敏。([可观测性指南](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/observability.md)) |
| **可插拔共享记忆** | 默认进程内 KV；实现 `MemoryStore` 接口即可换 Redis / Postgres / 自有后端。([共享记忆](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/shared-memory.md)) |
| **Checkpoint & resume** | 可选的按运行 checkpoint，运行于任意 `MemoryStore` 之上：每个任务完成时快照，`restore()` 跳过已完成任务，崩溃或重启后可恢复运行。Checkpoint v2 保留 `runId`、递增 `attempt`，并启动新的 trace；v1 快照仍可读取。内置的零依赖 `FileStore` 让 checkpoint 无需额外后端即可持久化；存盘 best-effort，不会拖慢运行。([checkpoint & resume](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/checkpoint.md)) |
| **沙箱化文件系统工作目录** | 内置文件系统工具默认沙箱化在 `<cwd>/.agent-workspace`；继承默认配置的 agent 共享同一根目录。需要 per-agent 隔离时显式设置 `AgentConfig.cwd`；改换共享根目录用 `OrchestratorConfig.defaultCwd`；传 `null` 关闭沙箱。([沙箱配置](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/tool-configuration.md)) |

生产级控制（[上下文策略](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/context-management.md)、任务重试退避、循环检测、工具输出截断/压缩）见 [生产级检查清单](#生产级检查清单)。

## 编排控制

对一次 `runTeam` 运行的精细控制。全部可选；默认行为不变。

**注入团队上下文。** 将目标、roster、当前 worker 的角色注入每个 worker 的 prompt：帮助 worker 与整体目标保持一致，也让多步运行更易调试。默认关闭；省略时 worker prompt 保持逐字节不变。

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

**封顶预估成本。** 价格表由应用侧维护，并提供估价函数；OMA 会将生效的 `model`、`provider`、执行阶段与 `taskId`（若有）一并传入，以便按模型计价。成本上限在与 `maxTokenBudget` 相同的轮次/任务边界处校验，单次运行至多可能超出一个模型轮次，并非精确到分的即时中止。

```ts
const prices = {
  'gpt-5.4-mini': { input: 0.75, output: 4.5 }, // 美元，每百万 tokens
}

const orchestrator = new OpenMultiAgent({
  maxCostBudget: 0.25,
  estimateCost: (usage, { model }) => {
    const price = prices[model] ?? { input: 0, output: 0 }
    return (usage.input_tokens / 1_000_000) * price.input
      + (usage.output_tokens / 1_000_000) * price.output
  },
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

**无依赖 fan-out。** 需要 MapReduce 风格的并行时，直接用 `AgentPool.runParallel()`。见 [`patterns/fan-out-aggregate`](examples/patterns/fan-out-aggregate.ts)。

**Shell 和 CI。** 使用 JSON-first 的 `oma` 命令行工具。详见 [docs/cli.md](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/cli.md)。

## 生态

`open-multi-agent` 2026-04-01 发布，MIT 协议。当前公开在用与集成的项目：

### 基于 OMA 构建

- **[temodar-agent](https://github.com/xeloxa/temodar-agent)**（约 60 stars）。WordPress 安全分析平台，作者 [Ali Sünbül](https://github.com/xeloxa)。在 Docker runtime 里直接用我们的内置工具（`bash`、`file_*`、`grep`）。已确认生产环境使用。
- **[Mark Galyan](https://github.com/apollo-mg)** 在本地量化模型上完全离线运行 OMA，借助 coordinator 与上下文压缩，在显存受限的条件下维持自治 agent 循环持续运行。自框架发布首月起持续贡献，涵盖上下文压缩、采样与工具调用解析。
- **[PR-Copilot](https://github.com/kidoom/PR-Copilot)**。AI pull request 审查助手，作者 [kidoom](https://github.com/kidoom)。运行一个 OMA 审查 team（coordinator + 限定范围的 reviewer agent），用 `defineTool` 定义仓库上下文工具，并加入自定义 `ContextStrategy` 做 token-aware 的 PR diff 压缩。公开代码，基于 `@open-multi-agent/core`。
- **[StuFlow](https://github.com/znc15/StuFlow)**。终端 AI 编码助手，作者 [znc15](https://github.com/znc15)。以 OMA 为编排内核：构建 team 并通过 `runAgent` / `runTasks` / `runTeam` 驱动，配自定义 `RunTeamOptions` coordinator，搭配 DeepSeek。公开代码，基于 `@open-multi-agent/core`。

如果在生产或 side project 中使用了 `open-multi-agent`，[请开个 Discussion](https://github.com/open-multi-agent/open-multi-agent/discussions)，我们会将其列在这里。

### 集成

- **[Engram](https://www.engram-memory.com)** — "AI 记忆的 Git"。在 agent 之间即时同步知识并标记冲突。([repo](https://github.com/Agentscreator/engram-memory))
- **[@agentsonar/oma](https://github.com/agentsonar/agentsonar-oma)** — Sidecar，检测跨运行的委派环、重复和速率突增。
- **[CodingScaffold](https://github.com/JRS1986/CodingScaffold)** — agentic-coding 脚手架，把 OMA 列为可选编排后端，附带 `runTeam` 工作流模板。

做了 `open-multi-agent` 集成？见[集成提交指南](examples/integrations/README.md)：如何提交 reference / vendor 示例，以及如何被列入这里。

### Featured partner

面向已经深度集成 `open-multi-agent` 的产品和平台。条款和申请方式见 [Featured partner 计划](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/featured-partner.md)。

## 示例

[`examples/`](./examples/) 按类别分为 basics、cookbook、patterns、providers、integrations。完整索引见 [`examples/README.md`](./examples/README.md)。（[`production/`](./examples/production/README.md) 正在征集贡献，见收录标准。）

### 真实业务流程（[`cookbook/`](./examples/cookbook/)）

端到端可直接运行的场景，每个都是完整、开箱即用的工作流。

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
- [`patterns/plan-replay`](examples/patterns/plan-replay.ts)：用 `planOnly` 将目标拆解一次，用 `createPlanArtifact` 序列化，再用 `runFromPlan` 重放同一张 DAG，不再调用协调者。
- [`integrations/trace-observability`](examples/integrations/trace-observability.ts)：`onTrace` 回调，给 LLM 调用、工具、任务发结构化 span。
- [`integrations/mcp-github`](examples/integrations/mcp-github.ts)：用 `connectMCPTools()` 把 MCP 服务器的工具暴露给 agent。
- **Provider 示例**：[`examples/providers/`](examples/providers/) 下的脚本，覆盖托管 provider、OpenAI 兼容端点和本地模型。

### 完整应用

带有独立 `package.json` 的克隆即可运行的应用，而非 `npx tsx` 脚本。每个都将 OMA 嵌入了真实后端。

- [`integrations/express-customer-support`](examples/integrations/express-customer-support/)：Express REST API。`runTasks()` 驱动 `POST /tickets`，每个 agent 用 Zod schema，provider 通过环境变量可切换，并提供 HTTP 错误码映射。一个 DeepSeek key 即可运行（`npm install && npm start`）。
- [`integrations/with-vercel-ai-sdk`](examples/integrations/with-vercel-ai-sdk/)：Next.js 应用。OMA `runTeam()` 配合 AI SDK `useChat` 流式输出（`npm install && npm run dev`）。

运行任意脚本：`npx tsx packages/core/examples/<path>.ts`；上面的完整应用用各自的 `npm` 脚本运行。

## 与其他框架对比

大多数 TypeScript 团队在选择多智能体编排层时，实际是在 OMA、LangGraph JS、Mastra 之间取舍。差异在于机制：动态规划，而非僵化的手工连线图。

**对比 LangGraph JS。** LangGraph 需先设计好声明式图（节点、边、条件路由），再编译为可调用对象；OMA 的 Coordinator 则在运行时将目标拆解为任务 DAG，并自动并行其中的无依赖项。两者均支持 checkpoint 与 resume，只是 LangGraph 的持久化生态更为完善。若需让编排随目标自适应、而非预先固定图结构，OMA 更为合适。

**对比 Mastra。** 两者均为原生 TypeScript，差异在于由谁驱动编排。Mastra 需手工连接工作流；OMA 则是目标驱动：将目标交给 Coordinator，即可在运行时自动构建任务 DAG。`runTeam(team, goal)` 一行调用即可。

**对比 CrewAI。** CrewAI 是 Python 生态中成熟的多智能体方案。OMA 将目标驱动的任务拆解引入 TypeScript 后端，以受治理的依赖边界直接嵌入 Node.js，无需在既有技术栈之外另行部署独立的 Python 服务。新增依赖必须证明安全、体积、维护与兼容成本合理；可选或平台特定 SDK 在边界有价值时继续隔离。

**对比 Vercel AI SDK。** AI SDK 是 LLM 调用层（provider 抽象、流式、tool call、结构化输出），而非多智能体编排器。单 agent 调用单独用它即可；一旦需要协同的团队，则选用 OMA。OMA 亦提供可选的 AI SDK bridge。

**对比 Claude Code 的 dynamic workflows。** Anthropic 于 2026 年 5 月在 Claude Code 中推出 [dynamic workflows](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code)：由 Claude 自行编写编排脚本，在会话内并行派生子 agent。差异在于形态：dynamic workflows 运行于 Claude Code 内部、面向 Claude 子 agent，而 OMA 以 MIT 协议的库形式，把同一套目标到 DAG 的机制嵌入你自己的 Node.js 后端，可用任意 provider。计划始终是可审查、可回放的数据（`planOnly`、`createPlanArtifact`、`runFromPlan`）；通过 [ACP](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/external-agents.md)，OMA 团队甚至可以把 Claude Code 本身作为其中一个 agent 来编排。

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
│  - stream()       │    │  - 13 built-in         │
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

可观测性是跨越所有执行模式的并行、可选数据面；即使没有配置 sink，
稳定的 identity 与 status 仍属于运行结果契约：

```
执行运行时 (runAgent / runTeam / runTasks / restore)
├─ RunIdentity + RunStatus ─────────────────────────► 结果 / checkpoint 延续
├─ legacy TraceEvent ────────────────────────────► onTrace / LegacyCallbackTraceSink
└─ TraceRecord v2 (start / event / end + links)
   └─ metadata-only 隐私处理器（默认）
      └─ TraceSink（快速 emit + stats / diagnostics）
         ├─ BatchingTraceSink ─► TraceExporter
         │                      ├─ 自定义后端
         │                      └─ TraceStoreExporter
         │                         ├─ InMemoryTraceStore
         │                         └─ FileTraceStore (/observability/file)
         └─ @open-multi-agent/otel ─► 应用自有 TracerProvider
```

这些存储的职责刻意分离：`TraceStore` 保存可查询的 telemetry，checkpoint
store 保存可恢复的执行状态，dashboard 则渲染运行后产物。应用负责
`forceFlush()` / `shutdown()`、文件 store 的 `flush()` / `close()`，以及关闭
自己传入的 OpenTelemetry provider。详见[可观测性指南](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/observability.md)
与[迁移指南](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/observability-migration.md)。

## 支持的 Provider

修改 `provider`、`model`，并设置对应的环境变量。agent 配置结构不变。

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
| 内置，无需额外安装 | 设 `provider` 为 `anthropic`、`openai`、`azure-openai`、`copilot`、`grok`、`deepseek`、`doubao`、`hunyuan`、`minimax`、`mimo`、`qiniu`；由自带的 `@anthropic-ai/sdk` / `openai` SDK 提供 endpoint。 | Anthropic、OpenAI、Azure OpenAI、GitHub Copilot、xAI Grok、DeepSeek、Doubao（火山引擎）、Hunyuan（腾讯混元 MaaS）、MiniMax、MiMo、Qiniu |
| 内置，需装 peer | `npm i @google/genai` 后设 `provider: 'gemini'`；`npm i @aws-sdk/client-bedrock-runtime` 后设 `provider: 'bedrock'`。 | Google Gemini、AWS Bedrock |
| OpenAI 兼容端点 | 设 `provider: 'openai'` + `baseURL`，必要时加 `apiKey`。无需额外安装。 | Ollama、vLLM、LM Studio、llama.cpp server、OpenRouter、Groq、Mistral、Moonshot（Kimi）、Qwen、Zhipu（智谱） |
| Vercel AI SDK | 从 `@open-multi-agent/core/ai-sdk` 导入 `AISdkAdapter`；安装可选 peer `ai` 加一个 `@ai-sdk/*` provider。 | [任意 AI SDK provider](https://ai-sdk.dev/providers)（60+ 模型与平台） |

详见 [docs/providers.md](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/providers.md)，含环境变量、模型示例、本地模型工具调用、超时设置、常见问题。

### 依赖

目前安装 `@open-multi-agent/core` 会直接引入 `@anthropic-ai/sdk`、`openai`、`zod`；这是实现细节，而非固定依赖数量的承诺。Anthropic、OpenAI 及所有 OpenAI 兼容端点目前即由这些包支撑。

依赖变更按明确价值以及安全、安装体积、维护和兼容成本治理。可选或平台特定能力在有助于避免主入口 eager import 未使用 SDK 时继续隔离；这个边界是架构选择，不是永久数字上限。

其余 provider 集成均为可选 peer 依赖，按需安装；每个都是懒加载，未用到的项目不会引入。OpenTelemetry 集成是独立安装的包：OTel API、SDK、semantic convention 映射和 exporter 集成都在 `@open-multi-agent/otel` 中，导入或运行 core 不需要 OpenTelemetry。

| 能力 | 安装 | 触发 |
|------|------|------|
| Gemini provider | `npm i @google/genai` | `provider: 'gemini'` |
| Bedrock provider | `npm i @aws-sdk/client-bedrock-runtime` | `provider: 'bedrock'` |
| MCP 工具 | `npm i @modelcontextprotocol/sdk` | `connectMCPTools()` |
| Vercel AI SDK bridge | `npm i ai @ai-sdk/<provider>` | `new AISdkAdapter(...)` |
| OpenTelemetry trace | `npm i @open-multi-agent/otel`，另装应用自选的 OTel SDK/exporter | `createOtelTraceSink(...)` |

### Vercel AI SDK（可选）

安装好 bridge 的 peer 后（见上方表格），在 `AgentConfig` 上传入 `adapter: new AISdkAdapter(model)`，即可让该 agent 改用 AI SDK，而非内置的 `provider` 工厂。设置 `adapter` 后，`provider`、`apiKey`、`baseURL`、`region` 均被忽略。混合团队照常工作：只有带 `adapter` 的 agent 才使用 AI SDK。

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

上线前逐一配置以下项目：控制 token 开销、从失败中恢复、问题可排查。

| 关注点 | 配置项 | 作用域 |
|--------|--------|--------|
| 控制对话长度 | `maxTurns`（每个 agent）+ `contextStrategy`（`sliding-window` / `summarize` / `compact` / `custom`） | `AgentConfig` |
| 控制运行时长 | `timeoutMs`（每个 agent，运行挂起时中止；本地模型常见） | `AgentConfig` |
| 控制单次调用 | `callTimeoutMs`（每个 agent，单次 `adapter.chat()` 卡住时中止；跨 provider 统一） | `AgentConfig` |
| 限制工具输出 | `maxToolOutputChars`（或单工具 `maxOutputChars`）+ `compressToolResults: true` | `AgentConfig` 和 `defineTool()` |
| 失败重试 | 任务级 `maxRetries`、`retryDelayMs`、`retryBackoff`（指数退避倍率） | 通过 `runTasks()` 用的任务配置 |
| 崩溃/重启后恢复 | `checkpoint`（给 `runId`，或内置 `FileStore` 等持久化 `MemoryStore`）+ `restore()` 恢复运行，跳过已完成任务 | `OrchestratorConfig` / 运行选项 |
| token 用量封顶 | orchestrator 上设 `maxTokenBudget` | `OrchestratorConfig` |
| 预估成本封顶 | `maxCostBudget` + `estimateCost`；每个模型的价格表由应用侧维护，校验发生在轮次/任务边界，而非精确到分的调用中途中止 | `OrchestratorConfig` |
| 卡死检测 | `loopDetection` + `onLoopDetected: 'terminate'`（或自定义 handler） | `AgentConfig` |
| 追踪与审计 | 保留 legacy `onTrace`，或在 `observability.sinks` 中配置 batching + exporter、TraceStore 或 OTel adapter；落盘 `renderTeamRunDashboard(result)`，并显式 flush/shutdown 应用自有 telemetry | `OrchestratorConfig` + 应用生命周期 |
| 脱敏密钥 | 自动：API key、token、Authorization header 从 trace、bash 输出、dashboard payload 中剥除 | 内置（默认开启） |
| 按需授予工具 | 内置工具默认拒绝（default-deny）：agent 只拿到自己在 `tools` / `toolPreset` 里列出的工具，都不写则一个都没有。`bash` 一旦授予仍无沙箱，且每次工具结果都会发给你的模型 provider，因此读取/执行权限需刻意授予。`defaultToolPreset` 可一行恢复旧的「全部工具」行为 | `AgentConfig` / `OrchestratorConfig` |
| 限定 agent 文件操作范围 | `cwd` / `defaultCwd`（默认 `.agent-workspace` 子目录；用 `process.cwd()` 放宽、`null` 关闭） | `AgentConfig` / `OrchestratorConfig` |

## 文档

- [Provider](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/providers.md) — 环境变量、模型示例、本地模型工具调用、超时、常见问题。
- [工具配置](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/tool-configuration.md) — 工具预设、自定义工具、文件系统沙箱、MCP。
- [可观测性](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/observability.md) — 稳定 identity/status、TraceRecord v2、有界 sink/exporter 生命周期、InMemory/File TraceStore 与运行后 dashboard。旧 callback 可按 [`onTrace` 分阶段迁移指南](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/observability-migration.md) 无停机迁移；[`@open-multi-agent/otel`](https://github.com/open-multi-agent/open-multi-agent/blob/main/packages/otel/README.md) 使用应用自有 provider。
- [共享记忆](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/shared-memory.md) — 默认存储与自定义 `MemoryStore` 后端。
- [Checkpoint & resume](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/checkpoint.md) — checkpoint v2 identity 规则、v1 兼容，以及基于任意 `MemoryStore` 的恢复流程。
- [上下文管理](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/context-management.md) — 滑动窗口、摘要、压缩、自定义压缩器。
- [CLI](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/cli.md) — 面向 shell 和 CI 的 JSON-first `oma` 命令行。
- [Consensus](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/consensus.md) — `runConsensus` proposer→judge 原语、按任务的 `verify` 钩子，以及预算不变量。
- [模型路由](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/model-routing.md) — 可选的 `modelRouting` 策略：按 phase / agent / role / priority / leaf 匹配，first match wins。
- [计划预览与回放](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/plan-replay.md) — 用 `planOnly` 预览协调者拆解的任务 DAG，`createPlanArtifact` 将其固化，之后 `runFromPlan` 不再调用协调者即可回放同一张图。

## 参与贡献

Issue、feature request、PR 都欢迎。特别欢迎以下方面的贡献：

- **生产级示例。** 端到端可运行的真实场景工作流。收录条件与提交格式见 [`examples/production/README.md`](./examples/production/README.md)。
- **文档。** 指南、教程、API 文档。
- **翻译。** 将这份 README 翻译为其他语言。[提交 PR](https://github.com/open-multi-agent/open-multi-agent/pulls)。

## 贡献者

<a href="https://github.com/open-multi-agent/open-multi-agent/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=open-multi-agent/open-multi-agent&max=100" />
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
- voidborne-d（OpenAI 混合内容修复、text-tool-extractor 深度修复）
- [@NamelessNATM](https://github.com/NamelessNATM)（agent 委派基础实现）
- [@MyPrototypeWhat](https://github.com/MyPrototypeWhat)（reasoning blocks、reasoning_effort、采样参数对齐、trace 输入输出）
- [@SiMinus](https://github.com/SiMinus)（流式 reasoning 事件）
- [@matthewYang08](https://github.com/matthewYang08)（OpenAI reasoning 转文本回退）
- [@dvirarad](https://github.com/dvirarad)（OpenAI 系列 adapter 健壮性）
- [@cat0825](https://github.com/cat0825)（model routing 策略、plan 重放、结构化共享记忆 handoff）
- [@mvanhorn](https://github.com/mvanhorn)（checkpoint & resume）
- [@lesbass](https://github.com/lesbass)（`TeamRunResult` 运行级 metrics 汇总）
- [@tlysanhuo](https://github.com/tlysanhuo)（trace span 父级链接）
- [@LambIessz](https://github.com/LambIessz)（orchestrator 成本预算、MessageBus 持久化进 checkpoint）
- [@Bobuyoucrypto](https://github.com/Bobuyoucrypto)（Windows bash 超时杀进程树）

**Provider 集成**

- [@ibrahimkzmv](https://github.com/ibrahimkzmv)（Gemini）
- [@hkalex](https://github.com/hkalex)（DeepSeek、MiniMax）
- [@marceloceccon](https://github.com/marceloceccon)（Grok）
- [@Klarline](https://github.com/Klarline)（Azure OpenAI）
- [@Deathwing](https://github.com/Deathwing)（GitHub Copilot）
- [@JackChiang233](https://github.com/JackChiang233)（Qiniu）
- [@CodingBangboo](https://github.com/CodingBangboo)（AWS Bedrock）
- [@kidoom](https://github.com/kidoom)（MiMo、Doubao）
- [@KaitlynFeng](https://github.com/KaitlynFeng)（Hunyuan）
- [@octo-patch](https://github.com/octo-patch)（MiniMax-M3 模型升级）

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
- [@Oxygen56](https://github.com/Oxygen56)（errors.ts 测试、Grok/DeepSeek/Doubao provider 文档）
- [@RheagalFire](https://github.com/RheagalFire)（LiteLLM 网关文档）

</details>

## 许可证

MIT
