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
  <video autoplay loop muted playsinline width="960" height="540" poster="https://raw.githubusercontent.com/open-multi-agent/open-multi-agent/demo-dashboard-gif-review-3d9ae0/.github/brand/demo-dashboard-hero.gif" src="https://cdn.jsdelivr.net/gh/open-multi-agent/open-multi-agent@demo-dashboard-gif-review-3d9ae0/.github/brand/demo-dashboard-hero.mp4">
    <img src="https://raw.githubusercontent.com/open-multi-agent/open-multi-agent/demo-dashboard-gif-review-3d9ae0/.github/brand/demo-dashboard-hero.gif" alt="OMA Run Viewer replaying a real multi-agent run: task DAG and span waterfall views with per-task status, assignee, tokens, and tool calls" width="960" height="540" loading="eager">
  </video>
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

`open-multi-agent` is an AI agent orchestration framework for TypeScript backends that drops into any Node.js app. It turns one goal into an inspectable task DAG, runs it across a team of agents, and synthesizes the result, all inside your own environment. Run it local, offline, or air-gapped, mixing cloud and local models on one team.

Use OMA when the plan should adapt at runtime, but execution still needs deterministic scheduling, explicit controls, and a trace you can inspect or replay.

## Why OMA

- **Plan from the goal.** A coordinator decomposes the request into a task DAG at runtime (auto work-division) instead of a hand-wired graph.
- **Wrap agents in determinism.** Preview and approve the plan, freeze and replay it, and verify with multi-agent consensus: deterministic control around non-deterministic agents.
- **Run in your own environment.** Local, offline, air-gapped, or your own servers, on your own credentials. Tools are default-deny and secrets auto-redacted, and three runtime dependencies keep it light enough for locked-down infrastructure; no cloud required.
- **Mix any model.** Cloud (Claude, GPT), local open models, and natively integrated Chinese providers on one team, with a fallback parser for local models that emit tool calls as text.

## Get started

Scaffold a PR review agent, security analysis agent, or teaching DAG:

```bash
npm create oma-app@latest
```

Or add OMA to an existing backend:

```bash
npm install @open-multi-agent/core
```

The [Core package guide](packages/core/README.md) contains the minimal example, three execution modes, provider setup, and production checklist. Browse the [example index](packages/core/examples/README.md) for runnable workflows.

## Built with OMA

`open-multi-agent` launched 2026-04-01 under MIT. Known users and integrations to date:

- **[temodar-agent](https://github.com/xeloxa/temodar-agent)** (~60 stars). WordPress security analysis platform by [Ali Sünbül](https://github.com/xeloxa). Uses our built-in tools (`bash`, `file_*`, `grep`) directly inside a Docker runtime. Confirmed production use.
- **[Mark Galyan](https://github.com/apollo-mg)** runs OMA fully offline on local quantized models, using the Coordinator and context compaction to keep autonomous agent loops alive under tight VRAM limits. Contributor since the framework's first month, across compaction, sampling, and tool-call parsing.
- **[PR-Copilot](https://github.com/kidoom/PR-Copilot)**. AI pull-request review assistant by [kidoom](https://github.com/kidoom). Runs an OMA review team (coordinator + scoped reviewer agents), defines repo-context tools with `defineTool`, and adds a custom `ContextStrategy` for token-aware PR-diff compression. Public code on `@open-multi-agent/core`.
- **[StuFlow](https://github.com/znc15/StuFlow)** by [znc15](https://github.com/znc15). Terminal AI coding assistant on OMA's orchestration core: builds a team and drives it through `runAgent` / `runTasks` / `runTeam` with a custom `RunTeamOptions` coordinator, paired with DeepSeek. Public code on `@open-multi-agent/core`.

**Integrations**

- **[Engram](https://www.engram-memory.com)**: "Git for AI memory." Syncs knowledge across agents instantly and flags conflicts. ([repo](https://github.com/Agentscreator/engram-memory), ~80 stars)
- **[@agentsonar/oma](https://github.com/agentsonar/agentsonar-oma)**: Sidecar detecting cross-run delegation cycles, repetition, and rate bursts.
- **[CodingScaffold](https://github.com/JRS1986/CodingScaffold)**: Agentic-coding scaffold that lists OMA as an optional orchestration backend, with a `runTeam` workflow template.

Using `open-multi-agent` in production or a side project? [Open a discussion](https://github.com/open-multi-agent/open-multi-agent/discussions) and we will list it here. Built an integration? The [integration guide](packages/core/examples/integrations/README.md) covers how to get listed. For a deep integration, see the [Featured partner program](docs/featured-partner.md).

## When OMA fits

OMA is designed for TypeScript teams that want the task graph to emerge from the goal at runtime. The coordinator creates the plan; the scheduler executes it as inspectable data.

Choose a graph-first framework when the workflow must be authored node by node. Use an LLM toolkit alone when one agent call is enough. OMA sits at the orchestration layer when several agents, dependencies, approvals, or recovery steps must work together.

For a named head-to-head against LangGraph, Mastra, CrewAI, the Vercel AI SDK, and others, see the [comparison page](https://open-multi-agent.com/compare/).

## Packages

| Package | Purpose |
|---|---|
| [`@open-multi-agent/core`](packages/core/README.md) | Orchestration runtime, tools, memory, checkpoints, traces, CLI, and offline Run Viewer. |
| [`@open-multi-agent/otel`](packages/otel/README.md) | Optional enterprise integration for production teams with a centralized OpenTelemetry stack. |

Core users can store traces locally and inspect them with the offline Run Viewer. Install the OTel package only when OMA traces should appear in the same monitoring system as the rest of your application.

## Commercial support

Need to embed agent capabilities in an existing product or business system? Email [jack@yuanasi.com](mailto:jack@yuanasi.com) for discovery and delivery support.

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
