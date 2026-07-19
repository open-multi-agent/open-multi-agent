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
  <strong>From a goal to a task DAG, automatically.</strong><br/>
  TypeScript-native multi-agent orchestration.
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

`open-multi-agent` turns one goal into an inspectable task DAG, runs it across a team of agents, and synthesizes the result. It is a TypeScript library that embeds directly in your Node.js backend.

Use OMA when the plan should adapt at runtime, but execution still needs deterministic scheduling, explicit controls, and a trace you can inspect or replay.

## Why OMA

- **Plan from the goal.** A coordinator decomposes the request at runtime instead of requiring a hand-wired graph.
- **Execute predictably.** Dependencies control task order; independent work runs in parallel and failures stay scoped.
- **Operate in production.** Budgets, retries, approvals, checkpoints, redaction, and the offline Run Viewer are built into the workflow.
- **Keep your stack.** Mix providers, use local models, or connect external coding agents while OMA remains inside your TypeScript service.

## Get started

Scaffold a PR review agent, security analysis agent, or teaching DAG:

```bash
npm create oma-app@latest
```

Or add the orchestration library to an existing backend:

```bash
npm install @open-multi-agent/core
```

The [Core package guide](packages/core/README.md) contains the minimal example, three execution modes, provider setup, and production checklist. Browse the [example index](packages/core/examples/README.md) for runnable workflows.

## Built with OMA

| Project | How it uses OMA |
|---|---|
| [temodar-agent](https://github.com/xeloxa/temodar-agent) | WordPress security analysis with OMA tools inside Docker; confirmed production use. |
| [PR-Copilot](https://github.com/kidoom/PR-Copilot) | Scoped review agents, repository tools, and token-aware diff compression. |
| [StuFlow](https://github.com/znc15/StuFlow) | Terminal coding assistant using OMA as its orchestration core. |
| [Mark Galyan](https://github.com/apollo-mg) | Fully local agent loops on quantized models under tight VRAM limits. |

Integrations include [Engram](https://github.com/Agentscreator/engram-memory), [AgentSonar](https://github.com/agentsonar/agentsonar-oma), and [CodingScaffold](https://github.com/JRS1986/CodingScaffold). Using OMA in a project? [Tell us in Discussions](https://github.com/open-multi-agent/open-multi-agent/discussions) or join the [Featured partner program](docs/featured-partner.md).

## When OMA fits

OMA is designed for TypeScript teams that want the task graph to emerge from the goal at runtime. The coordinator creates the plan; the scheduler executes it as inspectable data.

Choose a graph-first framework when the workflow must be authored node by node. Use an LLM toolkit alone when one agent call is enough. OMA sits at the orchestration layer when several agents, dependencies, approvals, or recovery steps must work together.

## Packages

| Package | Purpose |
|---|---|
| [`@open-multi-agent/core`](packages/core/README.md) | Orchestration runtime, tools, memory, checkpoints, traces, CLI, and offline Run Viewer. |
| [`@open-multi-agent/otel`](packages/otel/README.md) | Optional enterprise integration for production teams with a centralized OpenTelemetry stack. |

Core users can store traces locally and inspect them with the offline Run Viewer. Install the OTel package only when OMA traces should appear in the same monitoring system as the rest of your application.

## Commercial support

Need to embed agent capabilities in an existing product or business system? Commercial discovery and delivery support is available at [yuanasi.com](https://yuanasi.com).

## Documentation

| Goal | Start here |
|---|---|
| Install and run | [Core package guide](packages/core/README.md) · [Examples](packages/core/examples/README.md) · [CLI](docs/cli.md) |
| Configure models and tools | [Providers](docs/providers.md) · [Tools and sandbox](docs/tool-configuration.md) · [External agents](docs/external-agents.md) |
| Operate reliably | [Observability](docs/observability.md) · [Evaluation](docs/evaluation.md) · [Checkpoint and resume](docs/checkpoint.md) · [Context management](docs/context-management.md) |
| Control orchestration | [Consensus](docs/consensus.md) · [Model routing](docs/model-routing.md) · [Plan replay](docs/plan-replay.md) |

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for workspace boundaries, validation, and submission guidance.

<a href="https://github.com/open-multi-agent/open-multi-agent/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=open-multi-agent/open-multi-agent&max=100" />
</a>

Contributor credits by area are on the [Core package page](packages/core/README.md#contributors).

## License

MIT
