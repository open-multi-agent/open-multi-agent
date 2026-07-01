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
  <a href="./README.md">English</a> · <strong>中文</strong>
</p>

<br />

`open-multi-agent` 是面向 TypeScript 后端的多智能体编排框架。给定一个目标，协调者 agent 会将其拆解为任务 DAG，并行执行独立任务，合成最终结果。可直接嵌入任意现有 Node.js 后端。

> **工程师只描述目标，不画任务图。**

图优先的框架要求预先列出每个节点与每条边；OMA 是**动态工作流**（dynamic workflow）：任务 DAG 在运行时生成，随目标自适应，而非针对单一流程预先固化。协调者将该计划以数据形式交给确定性调度器执行，因此该计划可审查、可回放。

`@open-multi-agent/core` 坚持轻量内核：编排引擎加上主流模型 provider（Anthropic、OpenAI 及任意 OpenAI 兼容端点）开箱即用；额外的 provider（Gemini、Bedrock）、MCP、Vercel AI SDK bridge 均为可选 peer 依赖，按需安装。

## 快速开始

一条命令即可初始化项目并启动多 agent DAG：

```bash
npm create oma-app@latest
```

回答一个提示，首次运行便会展示协调者将目标拆解为多 agent DAG，并打开本次运行的 dashboard（OpenAI 或任意 OpenAI 兼容 provider）。若要将库集成到现有项目：

```bash
npm install @open-multi-agent/core
```

完整的 quickstart、三种运行模式、provider 接入、生产级检查清单与完整 API 参考详见包页：

**→ [`packages/core/README_zh.md`](packages/core/README_zh.md)**

其他运行方式：克隆仓库，以 `npx tsx packages/core/examples/basics/team-collaboration.ts` 运行任意[示例](packages/core/examples/)；或借助 [Express](packages/core/examples/integrations/express-customer-support/)、[Next.js](packages/core/examples/integrations/with-vercel-ai-sdk/) 应用将 OMA 嵌入真实后端。如需免去本地搭建，[Next.js 部署模板](https://github.com/open-multi-agent/oma-nextjs-starter)可一键部署至 Vercel；通过 [Ollama](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/providers.md) 运行本地模型则无需 API key。

## 与其他框架对比

大多数 TypeScript 团队在选择多智能体编排层时，实际是在 OMA、LangGraph JS、Mastra 之间取舍。差异在于机制。

**对比 LangGraph JS。** LangGraph 需先设计好声明式图（节点、边、条件路由），再编译为可调用对象；OMA 的 Coordinator 则在运行时将目标拆解为任务 DAG，并自动并行其中的无依赖项。两者均支持 checkpoint 与 resume，只是 LangGraph 的持久化生态更为完善。若需让编排随目标自适应、而非预先固定图结构，OMA 更为合适。

**对比 Mastra。** 两者均为原生 TypeScript，差异在于由谁驱动编排。Mastra 需手工连接工作流；OMA 则是目标驱动：将目标交给 Coordinator，即可在运行时自动构建任务 DAG。`runTeam(team, goal)` 一行调用即可。

**对比 CrewAI。** CrewAI 是 Python 生态中成熟的多智能体方案。OMA 将目标驱动的任务拆解引入 TypeScript 后端，运行时精简（三个核心依赖，外加按需安装的可选 peer），直接嵌入 Node.js，无需在既有技术栈之外另行部署独立的 Python 服务。

**对比 Vercel AI SDK。** AI SDK 是 LLM 调用层（provider 抽象、流式、tool call、结构化输出），而非多智能体编排器。单 agent 调用单独用它即可；一旦需要协同的团队，则选用 OMA。OMA 亦提供可选的 AI SDK bridge。

## 生态

`open-multi-agent` 2026-04-01 发布，MIT 协议。当前公开在用与集成的项目：

**基于 OMA 构建**

- **[temodar-agent](https://github.com/xeloxa/temodar-agent)**（约 60 stars）。WordPress 安全分析平台，作者 [Ali Sünbül](https://github.com/xeloxa)。在 Docker runtime 里直接用我们的内置工具（`bash`、`file_*`、`grep`）。已确认生产环境使用。
- **[Mark Galyan](https://github.com/apollo-mg)** 在本地量化模型上完全离线运行 OMA，借助 coordinator 与上下文压缩，在显存受限的条件下维持自治 agent 循环持续运行。自框架发布首月起持续贡献，涵盖上下文压缩、采样与工具调用解析。
- **[PR-Copilot](https://github.com/kidoom/PR-Copilot)**。AI pull request 审查助手，作者 [kidoom](https://github.com/kidoom)。运行一个 OMA 审查 team（coordinator + 限定范围的 reviewer agent），用 `defineTool` 定义仓库上下文工具，并加入自定义 `ContextStrategy` 做 token-aware 的 PR diff 压缩。公开代码，基于 `@open-multi-agent/core`。
- **[StuFlow](https://github.com/znc15/StuFlow)**。终端 AI 编码助手，作者 [znc15](https://github.com/znc15)。以 OMA 为编排内核：构建 team 并通过 `runAgent` / `runTasks` / `runTeam` 驱动，配自定义 `RunTeamOptions` coordinator，搭配 DeepSeek。公开代码，基于 `@open-multi-agent/core`。

**集成**

- **[Engram](https://www.engram-memory.com)** — "AI 记忆的 Git"。在 agent 之间即时同步知识并标记冲突。([repo](https://github.com/Agentscreator/engram-memory))
- **[@agentsonar/oma](https://github.com/agentsonar/agentsonar-oma)** — Sidecar，检测跨运行的委派环、重复和速率突增。
- **[CodingScaffold](https://github.com/JRS1986/CodingScaffold)** — agentic-coding 脚手架，把 OMA 列为可选编排后端，附带 `runTeam` 工作流模板。

**Provider 社区优惠** — 限时，不代表付费背书。

- **[MiniMax](https://platform.minimaxi.com/subscribe/token-plan?code=98qruMqQhL&source=link)** — 在 OMA 的 TypeScript 多智能体工作流中使用 MiniMax M3。OMA 用户可在 2026-06-30 前享 MiniMax Token Plan 专属 88 折优惠。见 [MiniMax 接入指南](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/providers/minimax.md)。

在生产或 side project 中使用了 `open-multi-agent`？[请开个 Discussion](https://github.com/open-multi-agent/open-multi-agent/discussions)，我们会将其列在这里。深度集成的产品见 [Featured partner 计划](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/featured-partner.md)。

## 仓库结构

这是一个 monorepo。发布的包为 **`@open-multi-agent/core`**，位于 [`packages/core/`](packages/core/)，即库本体、测试、示例与 npm 包页的单一事实源。

```
open-multi-agent/
├── packages/
│   └── core/          # @open-multi-agent/core（发布的库）
│       ├── src/       # 框架源码
│       ├── tests/     # vitest 测试套件
│       └── examples/  # 可直接运行的示例（npx tsx packages/core/examples/<path>.ts）
└── docs/              # 子系统文档
```

build / lint / test 都从仓库根目录跨 workspace 编排：

```bash
npm install            # 安装所有 workspace
npm run build          # 编译 packages/core
npm run lint           # 类型检查
npm test               # 运行测试套件
```

## 文档

- [Provider](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/providers.md) — 环境变量、模型示例、本地模型工具调用、超时、常见问题。
- [工具配置](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/tool-configuration.md) — 工具预设、自定义工具、文件系统沙箱、MCP。
- [可观测性](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/observability.md) — `onProgress` 事件、`onTrace` span、运行后 dashboard。
- [共享记忆](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/shared-memory.md) — 默认存储与自定义 `MemoryStore` 后端。
- [Checkpoint & resume](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/checkpoint.md) — 可选的按运行快照/恢复，跑在任意 `MemoryStore` 上；崩溃、重启后可续跑。
- [上下文管理](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/context-management.md) — 滑动窗口、摘要、压缩、自定义压缩器。
- [CLI](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/cli.md) — 面向 shell 和 CI 的 JSON-first `oma` 命令行。
- [Consensus](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/consensus.md) — `runConsensus` proposer→judge 原语、按任务的 `verify` 钩子，以及预算不变量。
- [模型路由](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/model-routing.md) — 可选的 `modelRouting` 策略：按 phase / agent / role / priority / leaf 匹配，first match wins。
- [计划预览与回放](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/plan-replay.md) — 用 `planOnly` 预览协调者拆解的任务 DAG，`createPlanArtifact` 将其固化，之后 `runFromPlan` 不再调用协调者即可回放同一张图。

## 参与贡献

Issue、feature request、PR 都欢迎。特别欢迎以下方面的贡献：

- **生产级示例。** 端到端可运行的真实场景工作流。收录条件与提交格式见 [`packages/core/examples/production/README.md`](packages/core/examples/production/README.md)。
- **文档。** 指南、教程、API 文档。
- **翻译。** 将文档翻译为其他语言。[提交 PR](https://github.com/open-multi-agent/open-multi-agent/pulls)。

## 贡献者

<a href="https://github.com/open-multi-agent/open-multi-agent/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=open-multi-agent/open-multi-agent&max=100" />
</a>

按领域展开的完整致谢见[包页](packages/core/README_zh.md#贡献者)。

## 许可证

MIT
