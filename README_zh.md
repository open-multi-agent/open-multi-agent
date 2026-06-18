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

## 快速开始

最快看到它跑起来 —— 一条命令脚手架出一个项目并启动多 agent DAG：

```bash
npm create oma-app@latest
```

回答一个提示；第一次运行就能看到 coordinator 把一个 goal 拆成多 agent DAG，并打开本次运行的 dashboard（OpenAI 或任意 OpenAI 兼容 provider）。若只想把库装进自己的项目：

```bash
npm install @open-multi-agent/core
```

完整的 quickstart、三种运行模式、provider 接入、生产级检查清单和完整 API 参考都在包页：

**→ [`packages/core/README_zh.md`](packages/core/README_zh.md)**

想跑仓库里的示例？克隆下来跑一个：

```bash
git clone https://github.com/open-multi-agent/open-multi-agent && cd open-multi-agent
npm install
export OPENAI_API_KEY=sk-...
npx tsx packages/core/examples/basics/team-collaboration.ts
```

三个 agent 协作产出 REST API，`onProgress` 实时输出协调者的任务 DAG——无依赖的任务并行执行，依赖项在输入就绪后自动解锁，协调者最终合成结果。通过 Ollama 运行本地模型不需要 API key，见 [provider 指南](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/providers.md)。

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

**生产环境在用**

- **[temodar-agent](https://github.com/xeloxa/temodar-agent)**（约 60 stars）。WordPress 安全分析平台，作者 [Ali Sünbül](https://github.com/xeloxa)。在 Docker runtime 里直接用我们的内置工具（`bash`、`file_*`、`grep`）。已确认生产环境使用。

**集成**

- **[Engram](https://www.engram-memory.com)** — "AI 记忆的 Git"。在 agent 之间即时同步知识并标记冲突。([repo](https://github.com/Agentscreator/engram-memory))
- **[@agentsonar/oma](https://github.com/agentsonar/agentsonar-oma)** — Sidecar，检测跨运行的委派环、重复和速率突增。

**Provider 社区优惠** — 限时，不代表付费背书。

- **[MiniMax](https://platform.minimaxi.com/subscribe/token-plan?code=98qruMqQhL&source=link)** — 在 OMA 的 TypeScript 多智能体工作流中使用 MiniMax M3。OMA 用户可在 2026-06-30 前享 MiniMax Token Plan 专属 88 折优惠。见 [MiniMax 接入指南](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/providers/minimax.md)。

在生产或 side project 中使用了 `open-multi-agent`？[请开个 Discussion](https://github.com/open-multi-agent/open-multi-agent/discussions)，我们会将其列在这里。深度集成的产品见 [Featured partner 计划](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/featured-partner.md)。

## 仓库结构

这是一个 monorepo。发布出去的包是 **`@open-multi-agent/core`**，位于 [`packages/core/`](packages/core/)——库本体、测试、示例和 npm 包页的单一事实源。

```
open-multi-agent/
├── packages/
│   └── core/          # @open-multi-agent/core —— 发布的库
│       ├── src/       # 框架源码
│       ├── tests/     # vitest 测试套件
│       └── examples/  # 可直接跑的示例（npx tsx packages/core/examples/<path>.ts）
└── docs/              # 子系统文档
```

build / lint / test 都从仓库根目录跨 workspace 编排：

```bash
npm install            # 安装所有 workspace
npm run build          # 编译 packages/core
npm run lint           # 类型检查
npm test               # 跑测试套件
```

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

- **生产级示例。** 端到端跑通的真实场景工作流。收录条件和提交格式见 [`packages/core/examples/production/README.md`](packages/core/examples/production/README.md)。
- **文档。** 指南、教程、API 文档。
- **翻译。** 把文档翻译成其他语言。[提个 PR](https://github.com/open-multi-agent/open-multi-agent/pulls)。

## 贡献者

<a href="https://github.com/open-multi-agent/open-multi-agent/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=open-multi-agent/open-multi-agent&max=100&v=20260529" />
</a>

按领域展开的完整致谢见[包页](packages/core/README_zh.md#贡献者)。

## 许可证

MIT
