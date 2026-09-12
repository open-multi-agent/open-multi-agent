<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/open-multi-agent/open-multi-agent/main/.github/brand/logo-mark-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/open-multi-agent/open-multi-agent/main/.github/brand/logo-mark-light.svg">
    <img alt="" src="https://raw.githubusercontent.com/open-multi-agent/open-multi-agent/main/.github/brand/logo-mark-light.svg" width="72">
  </picture>
  <br>Open Multi-Agent
</h1>

<p align="center">
  <strong>Agent 的所有权、审批权与审计权，归于使用它的组织。</strong><br/>
  自托管的 TypeScript Agent 运行时：关键操作要等一条持久化、防篡改的审批，每次运行留下一份可离线逐字节核验的记录。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@open-multi-agent/core"><img src="https://img.shields.io/npm/v/@open-multi-agent/core" alt="npm version"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/node/v/@open-multi-agent/core" alt="Node.js version"></a>
  <a href="https://github.com/open-multi-agent/open-multi-agent/actions/workflows/ci.yml"><img src="https://github.com/open-multi-agent/open-multi-agent/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/open-multi-agent/open-multi-agent/actions/workflows/supply-chain-audit.yml"><img src="https://github.com/open-multi-agent/open-multi-agent/actions/workflows/supply-chain-audit.yml/badge.svg" alt="Supply chain audit"></a>
  <a href="https://codecov.io/gh/open-multi-agent/open-multi-agent"><img src="https://codecov.io/gh/open-multi-agent/open-multi-agent/graph/badge.svg" alt="codecov"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License"></a>
</p>

<p align="center">
  <a href="https://open-multi-agent.com/zh/?utm_source=github&utm_medium=readme">官网</a> ·
  <a href="https://open-multi-agent.com/zh/getting-started/introduction/?utm_source=github&utm_medium=readme">文档</a> ·
  <a href="./packages/core/examples/">示例</a> ·
  <a href="https://www.npmjs.com/package/@open-multi-agent/core">npm</a>
</p>

<p align="center">
  <a href="./README.md">English</a> · <strong>中文</strong>
</p>

<br />

不上报遥测，没有托管控制面。你的密钥、你的模型（云端、本地 Ollama / vLLM / llama-server、国产模型）、你的环境。建它的人走了，系统照常跑。

## 快速开始

要求 Node.js 20 或更高版本。生产环境请使用仍处于维护期的 Node.js LTS 版本。Node.js 20 上游已停止维护，OMA 仅将其保留为迁移过渡窗口，会在下一个 major 版本移除，最早不早于 2026-10-31。

初始化 PR 审查 Agent、安全分析 Agent 或教学用 DAG：

```bash
npm create oma-app@latest my-oma
```

在交互式终端中，这一条命令会完成 starter 与 runtime 选择、依赖安装，并运行确定性的本地 Demo。Demo 不需要 API Key，也不会发起模型请求：预置模型响应负责模拟生成边界，OMA 的调度、结果聚合与离线 Dashboard 均真实运行。

也可以把 OMA 直接加入现有后端：

```bash
npm install @open-multi-agent/core
```

```typescript
import { FileStore, OpenMultiAgent } from '@open-multi-agent/core'

// 密钥与端点都是你自己的：托管模型，或通过 baseURL 接本地服务。
const oma = new OpenMultiAgent({
  defaultProvider: 'openai',
  defaultModel: 'gpt-5.4',
  // 有实际副作用的工具调用（写文件、执行 shell）挂起，等待人工决定。
  onToolCall: ({ consequential }) => (consequential ? { action: 'suspend' } : { action: 'allow' }),
})

const team = oma.createTeam('ops', {
  name: 'ops',
  agents: [{ name: 'operator', systemPrompt: '核对逾期发票。', toolPreset: 'readwrite' }],
})

// checkpoint store 让整次运行和待审批请求一起持久化。
const result = await oma.runTeam(team, '找出逾期发票并起草催款提醒。', {
  checkpoint: { store: new FileStore('./.oma/run.json') },
})

// 在审批人处理 result.pendingApprovals 之前，result.status?.code 保持为 'suspended'；
// 每条待审批请求都绑定审批人实际看到内容的哈希。
```

运行这段示例需要设置 `OPENAI_API_KEY`。其他云端模型、本地服务、OpenAI 兼容端点与 AI SDK provider 的配置见 [Provider 文档](docs/providers.md)。

`runAgent()` 运行单个 Agent，`runTasks()` 执行显式流水线，`runTeam()` 从目标自动规划。三种模式、Provider 与凭证配置、生产检查清单见[核心包使用指南](packages/core/README_zh.md)。[示例索引](packages/core/examples/README.md)收录全部可运行示例，覆盖基础、cookbook 流程、模式、Provider 与集成。

## 持久化审批

计划、任务派发和工具调用 gate 都可以返回 `suspend`。审批请求写在 checkpoint 旁边，绑定审批人实际看到内容的 SHA-256 哈希，进程重启后从这份内容继续。决定原子、先到先得；内容被篡改，或存储不支持 compare-and-set，直接失败关闭。

[`approval/durable.ts`](packages/core/src/approval/durable.ts) · [`durable-approval.test.ts`](packages/core/tests/durable-approval.test.ts)（16 条）· [`durable-approval-validation.test.ts`](packages/core/tests/durable-approval-validation.test.ts)（7 条）· [文档](docs/durable-approvals.md)

## 可核验日志

接上 journal 后端，运行会记下模型看到的每个 block、每次工具调用及结果、每次上下文改写。`verifyRun()` 离线冷读整份日志，检查每个 block 引用的来源事件是否仍能逐字节复现它；日志窗口被淘汰只报"无法判定"，不算失败。它证明的是血缘与内容，不是文件从未被改过。

[`journal/verify.ts`](packages/core/src/journal/verify.ts) · [`journal/hash.ts`](packages/core/src/journal/hash.ts) · [`verify-run.test.ts`](packages/core/tests/verify-run.test.ts)（11 条）· [文档](docs/run-journal.md)

## 治理底线

声明 `governanceIntent: 'required'` 与 `requiredRoles`，运行就按执行回执判定：哪些角色真正执行、先后顺序、依赖边、是否发生独立审查。评估器拿不到 Agent 输出文本；运行可以成功结束，同时报 `unsatisfied`。

[`orchestrator/governance.ts`](packages/core/src/orchestrator/governance.ts) · [`observability/execution-receipt.ts`](packages/core/src/observability/execution-receipt.ts) · [`governance-floor.test.ts`](packages/core/tests/governance-floor.test.ts)（16 条）· [文档](docs/tool-configuration.md#declared-governance-roles-in-runteam) · [执行回执](docs/observability.md#execution-receipts)

## 在你自己的环境里跑

- **不上报遥测，没有托管控制面。** 它是一个库，没有 OMA 后端和账号，也没有这样的计划；不发统计、许可证、更新或任何回连请求。[自托管与数据驻留](docs/self-hosting.md)
- **你的密钥、你的模型。** 内置 Anthropic、OpenAI、Azure OpenAI、Bedrock、Gemini、Grok、Copilot 适配器，以及 DeepSeek、豆包、混元、MiniMax、MiMo、七牛；Ollama、vLLM、llama-server 通过 `baseURL` 接入；另支持任意 OpenAI 兼容端点与 Vercel AI SDK provider。[Provider 文档](docs/providers.md)
- **出网策略。** `offline` 或 `allowlist`，在内置适配器建立连接前生效；下级策略只能收紧上级，无法完整约束的传输层直接失败关闭，process 与 ACP backend 不在覆盖范围内。[LLM 出网策略](docs/egress-policy.md)

## 基于 OMA 构建

`open-multi-agent` 2026-04-01 发布，MIT 协议。当前公开在用与集成的项目：

- **[temodar-agent](https://github.com/xeloxa/temodar-agent)**，作者 [Ali Sünbül](https://github.com/xeloxa)。WordPress 安全分析平台，在 Docker runtime 里直接使用 OMA 内置工具（`bash`、`file_*`、`grep`）。已确认生产环境使用。(约 60 stars)
- **[Mark Galyan](https://github.com/apollo-mg)** 在本地量化模型上完全离线运行 OMA，借助 Coordinator 与上下文压缩，在显存受限的条件下维持自治 Agent 循环持续运行。自框架发布首月起持续贡献。
- **[Engram](https://www.engram-memory.com)**："AI 记忆的 Git"。在 agent 之间即时同步知识并标记冲突。([repo](https://github.com/Agentscreator/engram-memory)，约 80 stars)

<details>
<summary>更多用户与集成</summary>

**用户**

- **[PR-Copilot](https://github.com/kidoom/PR-Copilot)**，作者 [kidoom](https://github.com/kidoom)。AI pull request 审查助手，运行 OMA 审查 team，用 `defineTool` 定义仓库上下文工具，并加入自定义 `ContextStrategy` 做 token-aware 的 diff 压缩。
- **[StuFlow](https://github.com/znc15/StuFlow)**，作者 [znc15](https://github.com/znc15)。终端 AI 编码助手，以 OMA 为编排内核，通过 `runAgent` / `runTasks` / `runTeam` 驱动自定义 coordinator，搭配 DeepSeek。
- **[Reports to Charts Studio](https://github.com/NARNIX0/Evident-Project)**。把文档和研究表格转换成可直接用于幻灯片的图表，使用由五个角色组成的数据提取评审组，结合结构化输出与确定性校验。

**集成**

- **[@agentsonar/oma](https://github.com/agentsonar/agentsonar-oma)**：Sidecar，检测跨运行的委派环、重复和速率突增。
- **[CodingScaffold](https://github.com/JRS1986/CodingScaffold)**：agentic-coding 脚手架，把 OMA 列为可选编排后端，附带 `runTeam` 工作流模板。
- **[baize-oma](https://github.com/timywel/baize-oma)**：HTTP 适配层，把 OMA 的 `runAgent()` 和 `runTeam()` 暴露为 Baize slot 能力。

</details>

我们为需要的组织在 OMA 上构建由客户自己拥有的 AI 系统。邮件 [jack@yuanasi.com](mailto:jack@yuanasi.com)，或微信 13760249135。

## 赞助商

支持 `open-multi-agent` 的付费赞助商。赞助不影响技术决策与模型推荐。

**Provider**

- **[Atlas Cloud](https://www.atlascloud.ai/console/coding-plan)**：全模态 AI 推理平台，单一 API 打通视频、图像与 LLM，覆盖 300+ 精选模型。$5 credit 兑换码面向 OMA 用户开放，先到先得。见 [Atlas Cloud 接入指南](docs/providers-atlascloud_zh.md)。

## 可选的 Coordinator

`runTeam()` 把一个目标分解为跨 Agent 的任务图。一次模型调用把目标转成带负责人和依赖关系的任务规格，确定性调度器负责执行，第二次调用基于已完成任务的输出写出最终答案。Coordinator 在运行中途不会再被咨询，运行结束后整个过程都是可以读回的数据。已经知道要做什么时，用 `runAgent()` 或 `runTasks()`。

```typescript
import { OpenMultiAgent } from '@open-multi-agent/core'

const oma = new OpenMultiAgent({ defaultProvider: 'openai', defaultModel: 'gpt-5.4' })

const team = oma.createTeam('research-team', {
  name: 'research-team',
  agents: [
    { name: 'researcher', systemPrompt: 'Find the relevant facts.' },
    { name: 'analyst', systemPrompt: 'Compare evidence and identify tradeoffs.' },
  ],
  sharedMemory: true,
})

const result = await oma.runTeam(team, 'Compare three approaches and recommend one.')

// 以上代码没有声明任何任务图，任务 DAG 由 Coordinator 在运行时生成，
// 运行结束后整个过程都是可以读回的数据。
for (const task of result.tasks ?? []) {
  console.log(`[${task.status}] ${task.title} → ${task.assignee ?? 'unassigned'}`, task.dependsOn)
}

console.log(result.agentResults.get('coordinator')?.output)
console.log(result.totalTokenUsage)
```

<p align="center">
  <img src="https://raw.githubusercontent.com/open-multi-agent/open-multi-agent/main/.github/brand/demo-dashboard-hero.gif" alt="OMA Run Viewer 回放真实运行：任务 DAG 与 span 瀑布双视图，展示每个任务的状态、负责人、token 与工具调用" width="960" height="540" loading="lazy">
</p>
<p align="center"><em>内置离线 Run Viewer 基于 trace store 回放一次真实运行：任务 DAG、span 瀑布与逐任务证据，不依赖任何托管服务。</em></p>

[Coordinator](docs/coordinator.md) 说明它决定什么、能看到什么。[计划回放](docs/plan-replay.md)固化已审批的计划，[Consensus](docs/consensus.md) 用独立评审 Agent 验证输出，[外部 Agent](docs/external-agents.md) 通过 process 与 ACP backend 把 Claude Code、Gemini CLI、Codex 放到同一张任务图上。

## 包

- **[`@open-multi-agent/core`](packages/core/README_zh.md)**：运行时、工具、记忆、checkpoint、审批、journal、trace、CLI 和离线 Run Viewer。
- **[`@open-multi-agent/otel`](packages/otel/README.md)**：面向已建立 OpenTelemetry 统一监控体系团队的可选 OpenTelemetry 适配器。
- **[`create-oma-app`](packages/create-oma-app/README.md)**：`npm create oma-app` 背后的脚手架；提供自带免 API Key 本地 Demo 的 starter 模板。

Core 用户可以在本地保存 trace，并用离线 Run Viewer 查看。只有当 OMA trace 需要进入应用现有的统一监控平台时，才需要安装 OTel 包。

## 文档

| 目标 | 从这里开始 |
|---|---|
| 安装与运行 | [文档索引](docs/README.md) · [核心包使用指南](packages/core/README_zh.md) · [示例](packages/core/examples/README.md) · [CLI](docs/cli.md) · [术语表](docs/glossary.md) · [生产检查清单](docs/production-checklist.md) |
| 配置模型与工具 | [Provider](docs/providers.md) · [LLM 出网策略](docs/egress-policy.md) · [工具配置](docs/tool-configuration.md) · [沙箱与 shell 执行](docs/sandbox-and-shell.md) · [MCP](docs/mcp.md) · [结构化输入](docs/structured-input.md) · [外部 Agent](docs/external-agents.md) |
| 稳定运行 | [可观测性](docs/observability.md) · [Run Viewer](docs/run-viewer.md) · [运行事件日志](docs/run-journal.md) · [评测](docs/evaluation.md) · [Checkpoint 与恢复](docs/checkpoint.md) · [Run store 与执行租约](docs/run-store.md) · [持久化审批](docs/durable-approvals.md) · [自适应恢复](docs/adaptive-recovery.md) · [上下文管理](docs/context-management.md) · [错误](docs/errors.md) |
| 控制编排 | [Coordinator](docs/coordinator.md) · [Consensus](docs/consensus.md) · [执行路由](docs/execution-routing.md) · [模型路由](docs/model-routing.md) · [任务调度](docs/task-scheduling.md) · [计划回放](docs/plan-replay.md) · [共享记忆](docs/shared-memory.md) · [流式输出](docs/streaming.md) · [预算与限制](docs/budgets-and-limits.md) |

## 参与贡献

欢迎提交 Issue 和 Pull Request。Workspace 边界、验证要求和提交流程见 [CONTRIBUTING.md](.github/CONTRIBUTING.md)。

<a href="https://github.com/open-multi-agent/open-multi-agent/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=open-multi-agent/open-multi-agent&max=100" />
</a>

按领域展开的贡献者致谢见 [CONTRIBUTORS.md](CONTRIBUTORS.md)。

## 许可证

MIT

由[深圳元定义科技有限公司（YuanASI）](https://yuanasi.com/?utm_source=github&utm_medium=readme_footer&utm_campaign=open_multi_agent)维护。
