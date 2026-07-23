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
  <strong>Describe the goal, not the graph.</strong><br/>
  Multi-agent orchestration that runs in your own environment.
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
  <img src="https://raw.githubusercontent.com/open-multi-agent/open-multi-agent/main/.github/brand/demo-dashboard-hero.gif" alt="OMA Run Viewer replaying a real multi-agent run: task DAG and span waterfall views with per-task status, assignee, tokens, and tool calls" width="960" height="540" loading="eager">
</p>

<br />

<p align="center">
  <a href="https://open-multi-agent.com">Website</a> ·
  <a href="https://open-multi-agent.com/getting-started/introduction/">Docs</a> ·
  <a href="https://www.npmjs.com/package/@open-multi-agent/core">npm</a> ·
  <a href="https://github.com/open-multi-agent/open-multi-agent/discussions">Discussions</a>
</p>

<p align="center">
  <strong>English</strong> · <a href="./README_zh.md">中文</a>
</p>

<br />

`open-multi-agent` is an AI agent orchestration framework for TypeScript backends that drops into any Node.js app. It runs **dynamic workflows**: a coordinator turns one goal into a task DAG at runtime, a deterministic scheduler executes it across the team, and the whole run stays data you can inspect, approve, and replay. The dashboard above is the built-in offline Run Viewer replaying a real run.

## Why OMA

- **Plan from the goal.** A coordinator decomposes the request into a task DAG at runtime, assigns the work, and synthesizes the results. There is no hand-wired graph to maintain.
- **Deterministic control, human in the loop.** Preview and approve plans before anything runs, approve individual dispatches, freeze a plan and replay it, and verify answers with multi-agent consensus. When the topology must not drift, declare required roles and order instead of relying on prompt wording.
- **Recover rather than rerun.** Checkpoints resume interrupted runs without repeating completed tasks. Retries, timeouts, loop detection, and token and cost budgets keep every run bounded.
- **Observe every run.** Traces, stable run identity, and the offline Run Viewer ship in core: replay any run as a task DAG and span waterfall from your own disk, without a hosted service.
- **Evaluate in the same package.** Version EvalSets, score with reference scorers, gate CI on offline reports, and sample production runs, all built on the run records the orchestrator already emits.
- **Coding CLIs as first-class agents.** Process and ACP backends let Claude Code, Gemini CLI, and Codex join a team alongside LLM agents: same task DAG, same shared memory, same budgets.
- **Mix any model.** Cloud (Claude, GPT), local open models, and natively integrated Chinese providers on one team. Any OpenAI-compatible endpoint or AI SDK provider plugs in the same way, and a fallback parser covers local models that emit tool calls as text.
- **Run in your own environment.** Local, offline, air-gapped, or your own servers, on your own credentials. Built-in tools are default-deny, secrets are auto-redacted, and a minimal runtime footprint fits locked-down infrastructure.

## Get started

Scaffold a PR review agent, security analysis agent, or teaching DAG:

```bash
npm create oma-app@latest my-oma
```

In an interactive terminal, that one command selects a starter and runtime, installs dependencies, and runs a deterministic local demo. The demo needs no API key and makes no model request: scripted model responses drive the real OMA scheduler, result aggregation, and offline dashboard. Use `--no-install` to generate files only, or `--no-run` to install without starting the demo.

Or add OMA to an existing backend:

```bash
npm install @open-multi-agent/core
```

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
console.log(result.agentResults.get('coordinator')?.output)
```

`runTeam()` plans from a goal, `runAgent()` runs a single agent, and `runTasks()` executes an explicit pipeline. The [Core package guide](packages/core/README.md) walks through all three modes, provider and credential setup, and the production checklist. The [example index](packages/core/examples/README.md) lists 50+ runnable examples across basics, cookbook workflows, patterns, providers, and integrations.

## Built with OMA

`open-multi-agent` launched 2026-04-01 under MIT. Known users and integrations to date:

- **[temodar-agent](https://github.com/xeloxa/temodar-agent)**. WordPress security analysis platform by [Ali Sünbül](https://github.com/xeloxa). Uses our built-in tools (`bash`, `file_*`, `grep`) directly inside a Docker runtime. Confirmed production use.
- **[Mark Galyan](https://github.com/apollo-mg)** runs OMA fully offline on local quantized models, using the Coordinator and context compaction to keep autonomous agent loops alive under tight VRAM limits. Contributor since the framework's first month, across compaction, sampling, and tool-call parsing.
- **[PR-Copilot](https://github.com/kidoom/PR-Copilot)**. AI pull-request review assistant by [kidoom](https://github.com/kidoom). Runs an OMA review team (coordinator + scoped reviewer agents), defines repo-context tools with `defineTool`, and adds a custom `ContextStrategy` for token-aware PR-diff compression. Public code on `@open-multi-agent/core`.
- **[StuFlow](https://github.com/znc15/StuFlow)** by [znc15](https://github.com/znc15). Terminal AI coding assistant on OMA's orchestration core: builds a team and drives it through `runAgent` / `runTasks` / `runTeam` with a custom `RunTeamOptions` coordinator, paired with DeepSeek. Public code on `@open-multi-agent/core`.
- **[Reports to Charts Studio](https://github.com/NARNIX0/Evident-Project)**. Turns documents and research tables into slide-ready charts. Uses OMA to run a five-role extraction council with structured outputs and deterministic validation. Public code on `@open-multi-agent/core`.

**Integrations**

- **[Engram](https://www.engram-memory.com)**: "Git for AI memory." Syncs knowledge across agents instantly and flags conflicts. ([repo](https://github.com/Agentscreator/engram-memory), ~80 stars)
- **[@agentsonar/oma](https://github.com/agentsonar/agentsonar-oma)**: Sidecar detecting cross-run delegation cycles, repetition, and rate bursts.
- **[CodingScaffold](https://github.com/JRS1986/CodingScaffold)**: Agentic-coding scaffold that lists OMA as an optional orchestration backend, with a `runTeam` workflow template.
- **[Bilig WorkPaper](https://github.com/proompteng/bilig)**: Formula-workbook MCP server with a reciprocal OMA integration for editing inputs, recalculating formulas, verifying readback, and persisting WorkPaper JSON.
- **[baize-oma](https://github.com/timywel/baize-oma)**: HTTP adapter exposing OMA `runAgent()` and `runTeam()` as Baize slot capabilities.

Using `open-multi-agent` in production or a side project? [Open a discussion](https://github.com/open-multi-agent/open-multi-agent/discussions) and we will list it here. Built an integration? The [integration guide](packages/core/examples/integrations/README.md) covers how to get listed. For a deep integration, see the [Featured partner program](docs/featured-partner.md).

## When OMA fits

OMA is designed for TypeScript teams that want the task graph to emerge from the goal at runtime.

Choose a graph-first framework when the workflow must be authored node by node. Use an LLM toolkit alone when one agent call is enough. OMA sits at the orchestration layer when several agents, dependencies, approvals, or recovery steps must work together.

For a named head-to-head against LangGraph, Mastra, CrewAI, the Vercel AI SDK, and others, see the [comparison page](https://open-multi-agent.com/compare/).

## Packages

- **[`@open-multi-agent/core`](packages/core/README.md)**: Orchestration runtime, tools, memory, checkpoints, traces, CLI, and offline Run Viewer.
- **[`@open-multi-agent/otel`](packages/otel/README.md)**: Optional enterprise integration for production teams with a centralized OpenTelemetry stack.
- **[`create-oma-app`](packages/create-oma-app/README.md)**: Scaffolder behind `npm create oma-app`; starter templates with a no-key local demo.

Core users can store traces locally and inspect them with the offline Run Viewer. Install the OTel package only when OMA traces should appear in the same monitoring system as the rest of your application.

## Commercial support

Need to embed agent capabilities in an existing product or business system? Email [jack@yuanasi.com](mailto:jack@yuanasi.com) for discovery and delivery support.

## Documentation

| Goal | Start here |
|---|---|
| Install and run | [Core package guide](packages/core/README.md) · [Examples](packages/core/examples/README.md) · [CLI](docs/cli.md) |
| Configure models and tools | [Providers](docs/providers.md) · [Tools and sandbox](docs/tool-configuration.md) · [External agents](docs/external-agents.md) |
| Operate reliably | [Observability](docs/observability.md) · [Evaluation](docs/evaluation.md) · [Checkpoint and resume](docs/checkpoint.md) · [Context management](docs/context-management.md) |
| Control orchestration | [Consensus](docs/consensus.md) · [Execution routing](docs/execution-routing.md) · [Model routing](docs/model-routing.md) · [Task scheduling](docs/task-scheduling.md) · [Plan replay](docs/plan-replay.md) · [Shared memory](docs/shared-memory.md) |

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for workspace boundaries, validation, and submission guidance.

<a href="https://github.com/open-multi-agent/open-multi-agent/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=open-multi-agent/open-multi-agent&max=100" />
</a>

Contributor credits by area are on the [Core package page](packages/core/README.md#contributors).

## License

MIT
