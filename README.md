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
  <img src="https://raw.githubusercontent.com/open-multi-agent/open-multi-agent/main/.github/brand/demo-dashboard-hero.gif" alt="Post-run dashboard replaying a completed team run: task DAG with per-node assignee, status, token breakdown, and agent output log" width="960" height="456" loading="eager">
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

`open-multi-agent` is an AI agent orchestration framework for TypeScript backends that drops into any Node.js app.

> **Your engineers describe the goal, not the graph.**

Graph-first frameworks make you wire every node and edge up front. OMA runs a **dynamic workflow**: a coordinator turns the goal into a task DAG at runtime, parallelizes independent tasks, and synthesizes the result. That plan is emitted as data for a deterministic scheduler to run, so it stays inspectable and replayable. It is the same bet Anthropic made with Claude Code's [dynamic workflows](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code); OMA offers it as an open library that runs on any provider, in your own backend.

Lightweight core: the engine plus Anthropic, OpenAI, and any OpenAI-compatible endpoint work out of the box; Gemini, Bedrock, MCP, and the Vercel AI SDK bridge are opt-in peer dependencies. OpenTelemetry is a separately installable integration (`@open-multi-agent/otel`): OTel APIs, SDKs, semantic-convention mappings, and exporter integrations stay outside the core import, and applications explicitly supply their own provider.

Dependencies are governed by demonstrated value and their security, size,
maintenance, and compatibility cost—not by a permanent dependency-count cap.
Optional or platform-specific SDKs remain isolated when that keeps unused code
out of the root import.

## Get started

One command scaffolds a production starter or the teaching DAG demo:

```bash
npm create oma-app@latest
```

When creating a project, choose a **PR Review Agent**, **Security Analysis Agent**, or **multi-agent DAG starter demo**, then select a cloud/OpenAI-compatible provider or fully local Ollama. Production starters emit Markdown, JSON, and an inspectable offline Run Viewer while keeping agents read-only. To add the library to your own project:

```bash
npm install @open-multi-agent/core
```

The full quickstart, the three ways to run, provider setup, the production checklist, and the complete API reference live on the package page:

**→ [`packages/core/README.md`](packages/core/README.md)**

Other ways to run: clone the repo and run any [example](packages/core/examples/) with `npx tsx packages/core/examples/basics/team-collaboration.ts`, or embed OMA in a real backend with the [Express](packages/core/examples/integrations/express-customer-support/) and [Next.js](packages/core/examples/integrations/with-vercel-ai-sdk/) apps. To skip local setup, the [Next.js starter](https://github.com/open-multi-agent/oma-nextjs-starter) deploys to Vercel in one click; local models via [Ollama](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/providers.md) need no API key.

## Ecosystem

`open-multi-agent` launched 2026-04-01 under MIT. Known users and integrations to date:

**Built with OMA**

- **[temodar-agent](https://github.com/xeloxa/temodar-agent)** (~60 stars). WordPress security analysis platform by [Ali Sünbül](https://github.com/xeloxa). Uses our built-in tools (`bash`, `file_*`, `grep`) directly inside a Docker runtime. Confirmed production use.
- **[Mark Galyan](https://github.com/apollo-mg)** runs OMA fully offline on local quantized models, using the Coordinator and context compaction to keep autonomous agent loops alive under tight VRAM limits. Contributor since the framework's first month, across compaction, sampling, and tool-call parsing.
- **[PR-Copilot](https://github.com/kidoom/PR-Copilot)**. AI pull-request review assistant by [kidoom](https://github.com/kidoom). Runs an OMA review team (coordinator + scoped reviewer agents), defines repo-context tools with `defineTool`, and adds a custom `ContextStrategy` for token-aware PR-diff compression. Public code on `@open-multi-agent/core`.
- **[StuFlow](https://github.com/znc15/StuFlow)** by [znc15](https://github.com/znc15). Terminal AI coding assistant on OMA's orchestration core: builds a team and drives it through `runAgent` / `runTasks` / `runTeam` with a custom `RunTeamOptions` coordinator, paired with DeepSeek. Public code on `@open-multi-agent/core`.

**Integrations**

- **[Engram](https://www.engram-memory.com)** — "Git for AI memory." Syncs knowledge across agents instantly and flags conflicts. ([repo](https://github.com/Agentscreator/engram-memory))
- **[@agentsonar/oma](https://github.com/agentsonar/agentsonar-oma)** — Sidecar detecting cross-run delegation cycles, repetition, and rate bursts.
- **[CodingScaffold](https://github.com/JRS1986/CodingScaffold)** — Agentic-coding scaffold that lists OMA as an optional orchestration backend, with a `runTeam` workflow template.

Using `open-multi-agent` in production or a side project? [Open a discussion](https://github.com/open-multi-agent/open-multi-agent/discussions) and we will list it here. For a deep integration, see the [Featured partner program](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/featured-partner.md).

## How is this different from X?

Most TypeScript teams choosing a multi-agent layer are weighing OMA against LangGraph JS, Mastra, CrewAI, and the Vercel AI SDK. The short version: OMA is goal-driven, dynamic planning instead of rigid hand-wired graphs. Hand its Coordinator a goal and it builds the task DAG at runtime.

That comparison includes Claude Code's own [dynamic workflows](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code), and OMA is composable with it rather than only competing: over [ACP](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/external-agents.md), an OMA team can run Claude Code itself as one of its agents.

Full head-to-head on each on the package page: [How is this different?](packages/core/README.md#how-is-this-different-from-x)

## Repository

This is a monorepo. The main package is **`@open-multi-agent/core`**; the optional OpenTelemetry adapter is published independently as **`@open-multi-agent/otel`**.

```
open-multi-agent/
├── packages/
│   ├── core/          # @open-multi-agent/core — framework, tests, examples
│   └── otel/          # @open-multi-agent/otel — optional adapter
└── docs/              # subsystem documentation
```

Build, lint, and test orchestrate across the workspace from the repo root:

```bash
npm install            # install all workspaces
npm run build          # compile packages/core
npm run lint           # type-check
npm test               # run the test suite
```

## Documentation

- [Providers](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/providers.md) — env vars, model examples, local tool-calling, timeouts, troubleshooting.
- [Tool configuration](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/tool-configuration.md) — tool presets, custom tools, the filesystem sandbox, and MCP.
- [Observability](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/observability.md) — stable identity/status, TraceRecord v2, bounded sink/exporter lifecycle, InMemory/File TraceStore, and the offline single-run DAG/Waterfall Viewer. Existing callbacks have a staged [`onTrace` migration guide](docs/observability-migration.md); [`@open-multi-agent/otel`](packages/otel/README.md) uses an application-owned provider.
- [Shared memory](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/shared-memory.md) — the default store and custom `MemoryStore` backends.
- [Checkpoint & resume](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/checkpoint.md) — opt-in snapshots over any `MemoryStore`; restore preserves `runId`, increments `attempt`, and starts a fresh trace.
- [Context management](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/context-management.md) — sliding window, summarization, compaction, and custom compressors.
- [CLI](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/cli.md) — the JSON-first `oma` binary for shell and CI.
- [Consensus](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/consensus.md) — the `runConsensus` proposer→judge primitive, the per-task `verify` hook, and the budget invariant.
- [Model routing](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/model-routing.md) — the opt-in `modelRouting` policy: match by phase / agent / role / priority / leaf, first match wins.
- [Plan preview & replay](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/plan-replay.md) — preview the coordinator's task DAG with `planOnly`, freeze it with `createPlanArtifact`, then `runFromPlan` replays the exact graph without re-invoking the coordinator.

## Contributing

Issues, feature requests, and PRs are welcome. Some areas where contributions would be especially valuable:

- **Production examples.** Real-world end-to-end workflows. See [`packages/core/examples/production/README.md`](packages/core/examples/production/README.md) for the acceptance criteria and submission format.
- **Documentation.** Guides, tutorials, and API docs.
- **Translations.** Help translate the docs into other languages. [Open a PR](https://github.com/open-multi-agent/open-multi-agent/pulls).

## Contributors

<a href="https://github.com/open-multi-agent/open-multi-agent/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=open-multi-agent/open-multi-agent&max=100" />
</a>

Full credits by area are on the [package page](packages/core/README.md#contributors).

## License

MIT
