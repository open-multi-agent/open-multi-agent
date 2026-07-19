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
  <strong>只描述目标，不画任务图。</strong><br/>
  运行在你自己环境中的多智能体编排。
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
  <img src="https://raw.githubusercontent.com/open-multi-agent/open-multi-agent/main/.github/brand/demo-dashboard-hero.gif" alt="OMA Run Viewer 回放真实多智能体运行：任务 DAG 与 span 瀑布双视图，展示每个任务的状态、负责人、token 与工具调用" width="960" height="540" loading="eager">
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

`open-multi-agent` 是面向 TypeScript 后端的多智能体编排框架，可直接嵌入任意 Node.js 应用。它把一个目标拆成可审查的任务 DAG，交给多个 Agent 执行，再合成最终结果，全程在你自己的环境中运行。可本地、断网或气隙部署，云端与本地模型同队混用。

当任务计划需要在运行时动态生成，但执行仍需确定性调度、明确管控和可回放轨迹时，选择 OMA。

## 为什么选择 OMA

- **从目标生成计划。** Coordinator 在运行时把请求拆成任务 DAG，自动完成分工，无需预先画好工作流图。
- **给 Agent 套上确定性。** 计划先审后跑、固化重放、多 Agent 共识验证：用确定性控制包住非确定性的 Agent。
- **在你自己的环境中运行。** 本地、断网、气隙或自有服务器，用你自己的凭证；工具默认拒绝、密钥自动脱敏。仅 3 个运行时依赖，轻到能塞进受限内网，完全不必上云。
- **任意模型混编。** 云端（Claude、GPT）、本地开源模型与原生接入的国产模型同队协作，并为以文本形式返回工具调用的本地模型提供容错解析。

## 快速开始

初始化 PR 审查 Agent、安全分析 Agent 或教学用 DAG：

```bash
npm create oma-app@latest
```

也可以把 OMA 直接加入现有后端：

```bash
npm install @open-multi-agent/core
```

[核心包使用指南](packages/core/README_zh.md)提供最小示例、三种执行模式、Provider 配置和生产检查清单。更多可运行流程见[示例索引](packages/core/examples/README.md)。

## 基于 OMA 构建

`open-multi-agent` 2026-04-01 发布，MIT 协议。当前公开在用与集成的项目：

- **[temodar-agent](https://github.com/xeloxa/temodar-agent)**（约 60 stars）。WordPress 安全分析平台，作者 [Ali Sünbül](https://github.com/xeloxa)。在 Docker runtime 里直接用我们的内置工具（`bash`、`file_*`、`grep`）。已确认生产环境使用。
- **[Mark Galyan](https://github.com/apollo-mg)** 在本地量化模型上完全离线运行 OMA，借助 coordinator 与上下文压缩，在显存受限的条件下维持自治 agent 循环持续运行。自框架发布首月起持续贡献，涵盖上下文压缩、采样与工具调用解析。
- **[PR-Copilot](https://github.com/kidoom/PR-Copilot)**。AI pull request 审查助手，作者 [kidoom](https://github.com/kidoom)。运行一个 OMA 审查 team（coordinator + 限定范围的 reviewer agent），用 `defineTool` 定义仓库上下文工具，并加入自定义 `ContextStrategy` 做 token-aware 的 PR diff 压缩。公开代码，基于 `@open-multi-agent/core`。
- **[StuFlow](https://github.com/znc15/StuFlow)**。终端 AI 编码助手，作者 [znc15](https://github.com/znc15)。以 OMA 为编排内核：构建 team 并通过 `runAgent` / `runTasks` / `runTeam` 驱动，配自定义 `RunTeamOptions` coordinator，搭配 DeepSeek。公开代码，基于 `@open-multi-agent/core`。

**集成**

- **[Engram](https://www.engram-memory.com)**："AI 记忆的 Git"。在 agent 之间即时同步知识并标记冲突。([repo](https://github.com/Agentscreator/engram-memory))
- **[@agentsonar/oma](https://github.com/agentsonar/agentsonar-oma)**：Sidecar，检测跨运行的委派环、重复和速率突增。
- **[CodingScaffold](https://github.com/JRS1986/CodingScaffold)**：agentic-coding 脚手架，把 OMA 列为可选编排后端，附带 `runTeam` 工作流模板。

在生产或 side project 中使用了 `open-multi-agent`？[请开个 Discussion](https://github.com/open-multi-agent/open-multi-agent/discussions)，我们会将其列在这里。做了集成？收录方式见[集成指南](packages/core/examples/integrations/README.md)。深度集成的产品见 [Featured partner 计划](docs/featured-partner.md)。

## OMA 适合什么场景

OMA 面向希望任务图随目标动态生成的 TypeScript 团队。Coordinator 产生计划，Scheduler 把它当作可审查数据执行。

如果工作流必须逐节点手工设计，图优先框架更合适；如果只需要单个 Agent 调用，一个 LLM 工具库就够了。当多个 Agent、任务依赖、审批或恢复机制需要协同时，OMA 负责这一编排层。

与 LangGraph、Mastra、CrewAI、Vercel AI SDK 等的逐项对比见[对比页](https://open-multi-agent.com/zh/compare/)。

## 包

| 包 | 作用 |
|---|---|
| [`@open-multi-agent/core`](packages/core/README_zh.md) | 编排运行时、工具、记忆、checkpoint、trace、CLI 和离线 Run Viewer。 |
| [`@open-multi-agent/otel`](packages/otel/README.md) | 面向已建立 OpenTelemetry 统一监控体系的生产团队的可选企业集成。 |

Core 用户可以在本地保存 trace，并用离线 Run Viewer 查看。只有当 OMA trace 需要进入应用现有的统一监控平台时，才需要安装 OTel 包。

## 企业服务

面向已有产品或业务系统的团队，提供 AI 场景梳理、Agent 能力嵌入与交付支持。微信扫码联系，或邮件 [jack@yuanasi.com](mailto:jack@yuanasi.com)。

<p align="center">
  <img src="https://raw.githubusercontent.com/open-multi-agent/open-multi-agent/main/.github/brand/wechat-qr.jpg" alt="微信扫码添加 JackChen 咨询" width="180">
</p>

## 文档

| 目标 | 从这里开始 |
|---|---|
| 安装与运行 | [核心包使用指南](packages/core/README_zh.md) · [示例](packages/core/examples/README.md) · [CLI](docs/cli.md) |
| 配置模型与工具 | [Provider](docs/providers.md) · [工具与沙箱](docs/tool-configuration.md) · [外部 Agent](docs/external-agents.md) |
| 稳定运行 | [可观测性](docs/observability.md) · [评测](docs/evaluation.md) · [Checkpoint 与恢复](docs/checkpoint.md) · [上下文管理](docs/context-management.md) |
| 控制编排 | [Consensus](docs/consensus.md) · [模型路由](docs/model-routing.md) · [计划回放](docs/plan-replay.md) |

## 参与贡献

欢迎提交 Issue 和 Pull Request。Workspace 边界、验证要求和提交流程见 [CONTRIBUTING.md](.github/CONTRIBUTING.md)。

<a href="https://github.com/open-multi-agent/open-multi-agent/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=open-multi-agent/open-multi-agent&max=100" />
</a>

按领域展开的贡献者致谢见[核心包页](packages/core/README_zh.md#贡献者)。

## 许可证

MIT
