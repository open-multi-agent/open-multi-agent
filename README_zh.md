# Open Multi-Agent

面向 TypeScript 的轻量多智能体编排引擎。3 个运行时依赖，零配置，一次 `runTeam()` 调用从目标到结果。

CrewAI 是 Python。LangGraph 需要你自己画图。`open-multi-agent` 是你现有 Node.js 后端里 `npm install` 一下就能用的那一层。当你需要让一支 agent 团队围绕一个目标协作时，只提供这个，不多不少。

3 个运行时依赖 · 41 个源文件 · Node.js 能跑的地方都能部署

[![GitHub stars](https://img.shields.io/github/stars/JackChen-me/open-multi-agent)](https://github.com/JackChen-me/open-multi-agent/stargazers)
[![license](https://img.shields.io/github/license/JackChen-me/open-multi-agent)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue)](https://www.typescriptlang.org/)
[![coverage](https://img.shields.io/badge/coverage-88%25-brightgreen)](https://github.com/JackChen-me/open-multi-agent/actions)

[English](./README.md) | **中文**

## 你真正得到的三件事

- **一次调用从目标到结果。** `runTeam(team, "构建一个 REST API")` 启动一个协调者 agent，把目标拆成任务 DAG，解析依赖，独立任务并行执行，最终合成输出。不需要画图，不需要手动连任务。
- **TypeScript 原生，3 个运行时依赖。** `@anthropic-ai/sdk`、`openai`、`zod`。这就是全部运行时。可嵌入 Express、Next.js、Serverless 函数或 CI/CD 流水线。没有 Python 运行时，没有子进程桥接，没有云端 sidecar。
- **多模型团队。** Claude、GPT、Gemini、Grok、MiniMax、DeepSeek、Copilot，或任何 OpenAI 兼容的本地模型（Ollama、vLLM、LM Studio、llama.cpp）可以在同一个团队中使用。让架构师用 Opus 4.6，开发者用 GPT-5.4，评审用本地的 Gemma 4，一次 `runTeam()` 调用全部搞定。Gemini 作为 optional peer dependency 提供：使用前需 `npm install @google/genai`。

其他能力（MCP 集成、上下文策略、结构化输出、任务重试、人机协同、生命周期钩子、循环检测、可观测性）在下方章节和 [`examples/`](./examples/) 里。

## 哲学：我们做什么，不做什么

我们的目标是做 TypeScript 生态里最简单的多智能体框架。简单不等于封闭。框架的长期价值不在于功能清单的长度，而在于它连接的网络有多大。

**我们做：**
- 一个协调者，把目标拆成任务 DAG。
- 一个任务队列，独立任务并行执行，失败级联到下游。
- 共享内存和消息总线，让 agent 之间能看到彼此的输出。
- 多模型团队，每个 agent 可以用不同的 LLM provider。

**我们不做：**
- **Agent Handoffs。** 如果 agent A 需要把对话中途交接给 agent B，去用 [OpenAI Agents SDK](https://github.com/openai/openai-agents-python)。在我们的模型里，每个 agent 完整负责自己的任务，不会中途交接。
- **状态持久化 / 检查点。** 短期内不做。加存储后端会打破 3 个依赖的承诺，而且我们的工作流执行时间是秒到分钟级，不是小时级。如果真实使用场景转向长时间工作流，我们会重新评估。

**正在跟踪：**
- **A2A 协议。** 观望中，等生产级采纳到位再行动。

完整理由见 [`DECISIONS.md`](./DECISIONS.md)。

## 和 X 有什么不同？

**vs. [LangGraph JS](https://github.com/langchain-ai/langgraphjs)。** LangGraph 是声明式图编排：你定义节点、边、条件路由，然后 `compile()` + `invoke()`。`open-multi-agent` 是目标驱动：你声明团队和目标，协调者在运行时把目标拆成任务 DAG。LangGraph 给你完全的拓扑控制（适合固定的生产工作流）。这个框架代码更少、迭代更快（适合探索型多智能体协作）。LangGraph 还有成熟的检查点能力，我们没有。

**vs. [CrewAI](https://github.com/crewAIInc/crewAI)。** CrewAI 是成熟的 Python 选择。如果你的技术栈是 Python，用 CrewAI。`open-multi-agent` 是 TypeScript 原生：3 个运行时依赖，直接嵌入 Node.js，不需要子进程桥接。编排能力大致相当，按语言契合度选。

**vs. [Vercel AI SDK](https://github.com/vercel/ai)。** AI SDK 是 LLM 调用层：统一的 TypeScript 客户端，支持 60+ provider，带流式、tool calls、结构化输出。它不做多智能体编排。`open-multi-agent` 需要多 agent 时叠在它之上。两者互补：单 agent 用 AI SDK，需要团队用这个。

## 谁在用

`open-multi-agent` 是一个新项目（2026-04-01 发布，MIT 许可，5,500+ stars）。生态还在成形，下面这份列表很短，但都真实：

- **[temodar-agent](https://github.com/xeloxa/temodar-agent)**（约 50 stars）。WordPress 安全分析平台，作者 [Ali Sünbül](https://github.com/xeloxa)。在 Docker runtime 里直接使用我们的内置工具（`bash`、`file_*`、`grep`）。已确认生产环境使用。
- **[rentech-quant-platform](https://github.com/rookiecoderasz/rentech-quant-platform)。** 多智能体量化交易研究平台，5 条管线 + MCP 集成，基于 `open-multi-agent` 构建。早期信号，项目非常新。
- **家用服务器 Cybersecurity SOC。** 本地完全离线运行 Qwen 2.5 + DeepSeek Coder（通过 Ollama），在 Wazuh + Proxmox 上构建自主 SOC 流水线。早期用户，未公开。

你在生产环境或 side project 里用 `open-multi-agent` 吗？[开一个 Discussion](https://github.com/JackChen-me/open-multi-agent/discussions)，我们会把你列上来。

## 快速开始

需要 Node.js >= 18。

```bash
npm install @jackchen_me/open-multi-agent
```

根据使用的 Provider 设置对应的 API key。通过 Ollama 使用本地模型无需 API key — 参见 [example 06](examples/06-local-model.ts)。

- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `GEMINI_API_KEY`
- `XAI_API_KEY`（Grok）
- `MINIMAX_API_KEY`（MiniMax）
- `MINIMAX_BASE_URL`（MiniMax — 可选，用于选择接入端点）
- `DEEPSEEK_API_KEY`（DeepSeek）
- `GITHUB_TOKEN`（Copilot）

三个智能体，一个目标——框架处理剩下的一切：

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

// 描述一个目标——框架将其拆解为任务并编排执行
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
| 单智能体 | `runAgent()` | 一个智能体，一个提示词——最简入口 |
| 自动编排团队 | `runTeam()` | 给一个目标，框架自动规划和执行 |
| 显式任务管线 | `runTasks()` | 你自己定义任务图和分配 |

如果需要 MapReduce 风格的扇出而不涉及任务依赖，直接使用 `AgentPool.runParallel()`。参见[示例 07](examples/07-fan-out-aggregate.ts)。

## 示例

[`examples/`](./examples/) 里有 18 个可运行脚本和 1 个完整项目。推荐从这几个开始：

- [02 — 团队协作](examples/02-team-collaboration.ts)：`runTeam()` 协调者模式。
- [06 — 本地模型](examples/06-local-model.ts)：通过 `baseURL` 把 Ollama 和 Claude 放在同一条管线。
- [09 — 结构化输出](examples/09-structured-output.ts)：任意 agent 产出 Zod 校验过的 JSON。
- [11 — 可观测性](examples/11-trace-observability.ts)：`onTrace` 回调，为 LLM 调用、工具、任务发出结构化 span。
- [17 — MiniMax](examples/17-minimax.ts)：使用 MiniMax M2.7 的三智能体团队。
- [18 — DeepSeek](examples/18-deepseek.ts)：使用 DeepSeek Chat 的三智能体团队。
- [with-vercel-ai-sdk](examples/with-vercel-ai-sdk/)：Next.js 应用 — OMA `runTeam()` + AI SDK `useChat` 流式输出。

用 `npx tsx examples/02-team-collaboration.ts` 运行脚本示例。

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
| `bash` | 执行 Shell 命令。返回 stdout + stderr。支持超时和工作目录设置。 |
| `file_read` | 读取指定绝对路径的文件内容。支持偏移量和行数限制以处理大文件。 |
| `file_write` | 写入或创建文件。自动创建父目录。 |
| `file_edit` | 通过精确字符串匹配编辑文件。 |
| `grep` | 使用正则表达式搜索文件内容。优先使用 ripgrep，回退到 Node.js 实现。 |
| `glob` | 按 glob 模式查找文件。返回按修改时间排序的匹配路径。 |

## 工具配置

可以通过预设、白名单和黑名单对 agent 的工具访问进行精细控制。

### 工具预设

为常见场景预定义的工具组合：

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

将预设与白名单、黑名单组合，实现精确控制：

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

通过 `agent.addTool()` 添加的工具始终可用，不受过滤规则影响。

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
| Ollama / vLLM / LM Studio | `provider: 'openai'` + `baseURL` | — | 已验证 |
| llama.cpp server | `provider: 'openai'` + `baseURL` | — | 已验证 |

Gemini 需要 `npm install @google/genai`（optional peer dependency）。

已验证支持 tool-calling 的本地模型：**Gemma 4**（见[示例 08](examples/08-gemma4-local.ts)）。

任何 OpenAI 兼容 API 均可通过 `provider: 'openai'` + `baseURL` 接入（Groq、Mistral、Qwen 等）。**Grok、MiniMax 和 DeepSeek 现已原生支持**，分别使用 `provider: 'grok'`、`provider: 'minimax'` 和 `provider: 'deepseek'`。

### 本地模型 Tool-Calling

框架支持通过 Ollama、vLLM、LM Studio 或 llama.cpp 运行的本地模型进行 tool-calling。Tool-calling 由这些服务通过 OpenAI 兼容 API 原生处理。

**已验证模型：** Gemma 4、Llama 3.1、Qwen 3、Mistral、Phi-4。完整列表见 [ollama.com/search?c=tools](https://ollama.com/search?c=tools)。

**兜底提取：** 如果本地模型以文本形式返回工具调用，而非使用 `tool_calls` 协议格式（常见于 thinking 模型或配置不当的服务），框架会自动从文本输出中提取。

**超时设置：** 本地推理可能较慢。使用 `AgentConfig` 上的 `timeoutMs` 防止无限等待：

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
- 模型不调用工具？确保该模型出现在 Ollama 的 [Tools 分类](https://ollama.com/search?c=tools)中。并非所有模型都支持 tool-calling。
- 使用 Ollama？更新到最新版（`ollama update`）——旧版本有已知的 tool-calling bug。
- 代理干扰？本地服务使用 `no_proxy=localhost`。

### LLM 配置示例

```typescript
const grokAgent: AgentConfig = {
  name: 'grok-agent',
  provider: 'grok',
  model: 'grok-4',
  systemPrompt: 'You are a helpful assistant.',
}
```

（设置 `XAI_API_KEY` 环境变量即可，无需 `baseURL`。）

```typescript
const minimaxAgent: AgentConfig = {
  name: 'minimax-agent',
  provider: 'minimax',
  model: 'MiniMax-M2.7',
  systemPrompt: 'You are a helpful assistant.',
}
```

设置 `MINIMAX_API_KEY`。适配器通过 `MINIMAX_BASE_URL` 选择接入端点：

- `https://api.minimax.io/v1` 全球端点，默认
- `https://api.minimaxi.com/v1` 中国大陆端点

也可在 `AgentConfig` 中直接传入 `baseURL` 覆盖环境变量。

```typescript
const deepseekAgent: AgentConfig = {
  name: 'deepseek-agent',
  provider: 'deepseek',
  model: 'deepseek-chat',
  systemPrompt: '你是一个有用的助手。',
}
```

设置 `DEEPSEEK_API_KEY`。可用模型：`deepseek-chat`（DeepSeek-V3，推荐用于编码任务）和 `deepseek-reasoner`（思考模式）。

## 参与贡献

欢迎提 Issue、功能需求和 PR。以下方向的贡献尤其有价值：

- **示例** — 真实场景的工作流和用例。
- **文档** — 指南、教程和 API 文档。

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
