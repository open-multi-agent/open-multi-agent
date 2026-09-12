<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/open-multi-agent/open-multi-agent/main/.github/brand/logo-mark-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/open-multi-agent/open-multi-agent/main/.github/brand/logo-mark-light.svg">
    <img alt="" src="https://raw.githubusercontent.com/open-multi-agent/open-multi-agent/main/.github/brand/logo-mark-light.svg" width="72">
  </picture>
  <br>Open Multi-Agent
</h1>

<p align="center">
  <strong>Agents your organization can own, approve, and audit.</strong><br/>
  A self-hosted TypeScript agent runtime: consequential actions wait for durable, tamper-evident approvals, and every run leaves a record you can verify offline, byte for byte.
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
  <a href="https://open-multi-agent.com/?utm_source=github&utm_medium=readme">Website</a> ·
  <a href="https://open-multi-agent.com/getting-started/introduction/?utm_source=github&utm_medium=readme">Docs</a> ·
  <a href="./packages/core/examples/">Examples</a> ·
  <a href="https://www.npmjs.com/package/@open-multi-agent/core">npm</a>
</p>

<p align="center">
  <strong>English</strong> · <a href="./README_zh.md">中文</a>
</p>

<br />

No telemetry. No hosted control plane. Your keys, your models — cloud, local (Ollama, vLLM, llama-server), or Chinese providers — your environment. Nothing stops working when the people who built it leave.

## Get started

Requires Node.js 20 or newer. For production, use a currently maintained
Node.js LTS release. Node.js 20 is upstream-EOL and retained only as a
migration compatibility window; OMA will remove it in the next major release,
no earlier than 2026-10-31.

Scaffold a PR review agent, security analysis agent, or teaching DAG:

```bash
npm create oma-app@latest my-oma
```

In an interactive terminal, that one command selects a starter and runtime, installs dependencies, and runs a deterministic local demo. The demo needs no API key and makes no model request: scripted model responses drive the real OMA scheduler, result aggregation, and offline dashboard.

Or add OMA to an existing backend:

```bash
npm install @open-multi-agent/core
```

```typescript
import { FileStore, OpenMultiAgent } from '@open-multi-agent/core'

// Your keys and your endpoint: a hosted provider, or a local server through baseURL.
const oma = new OpenMultiAgent({
  defaultProvider: 'openai',
  defaultModel: 'gpt-5.4',
  // Consequential tool calls (file writes, shell) pause for a human decision.
  onToolCall: ({ consequential }) => (consequential ? { action: 'suspend' } : { action: 'allow' }),
})

const team = oma.createTeam('ops', {
  name: 'ops',
  agents: [{ name: 'operator', systemPrompt: 'Reconcile overdue invoices.', toolPreset: 'readwrite' }],
})

// The checkpoint store keeps the run and its pending approvals durable.
const result = await oma.runTeam(team, 'Find overdue invoices and draft the reminders.', {
  checkpoint: { store: new FileStore('./.oma/run.json') },
})

// result.status?.code === 'suspended' until a reviewer decides result.pendingApprovals,
// each bound to a hash of exactly what the reviewer was shown.
```

Set `OPENAI_API_KEY` to run this example. [Providers](docs/providers.md) covers other hosted models, local servers, OpenAI-compatible endpoints, and AI SDK providers.

`runAgent()` runs a single agent, `runTasks()` executes an explicit pipeline, and `runTeam()` plans from a goal. The [Core package guide](packages/core/README.md) walks through all three modes, provider and credential setup, and the production checklist. The [example index](packages/core/examples/README.md) lists every runnable example across basics, cookbook workflows, patterns, providers, and integrations.

## Durable approvals

A plan, task dispatch, or tool-call gate can return `suspend`. The request is stored beside the checkpoint, bound to a SHA-256 hash of exactly what the reviewer saw, and the run resumes from that content after a restart. A decision is atomic and first-wins; a tampered request or a store without compare-and-set fails closed.

[`approval/durable.ts`](packages/core/src/approval/durable.ts) · [`durable-approval.test.ts`](packages/core/tests/durable-approval.test.ts) (16 cases) · [`durable-approval-validation.test.ts`](packages/core/tests/durable-approval-validation.test.ts) (7 cases) · [Guide](docs/durable-approvals.md)

## Verifiable journal

Attach a journal backend and the run records every block the model saw, every tool call and result, and every context rewrite. `verifyRun()` reads it back cold, offline, and checks that each block's named source event still reproduces it byte for byte; an evicted window is reported as inconclusive, not as a failure. It proves lineage and content, not that the file was never edited.

[`journal/verify.ts`](packages/core/src/journal/verify.ts) · [`journal/hash.ts`](packages/core/src/journal/hash.ts) · [`verify-run.test.ts`](packages/core/tests/verify-run.test.ts) (11 cases) · [Guide](docs/run-journal.md)

## Governance floor

Declare `governanceIntent: 'required'` with `requiredRoles`, and the run is judged on an execution receipt: which roles ran, in what order, with which dependency edges, and whether an independent review happened. The evaluator never sees agent output text, and a run can succeed and still report `unsatisfied`.

[`orchestrator/governance.ts`](packages/core/src/orchestrator/governance.ts) · [`observability/execution-receipt.ts`](packages/core/src/observability/execution-receipt.ts) · [`governance-floor.test.ts`](packages/core/tests/governance-floor.test.ts) (16 cases) · [Guide](docs/tool-configuration.md#declared-governance-roles-in-runteam) · [Receipts](docs/observability.md#execution-receipts)

## Runs where you run

- **No telemetry, no hosted control plane.** A library with no OMA backend or account, and none planned. It makes no analytics, license, update, or phone-home request. [Self-hosting](docs/self-hosting.md)
- **Your keys, your models.** Built-in adapters for Anthropic, OpenAI, Azure OpenAI, Bedrock, Gemini, Grok, and Copilot, and for DeepSeek, Doubao, Hunyuan, MiniMax, MiMo, and Qiniu; Ollama, vLLM, and llama-server through `baseURL`; any OpenAI-compatible endpoint and Vercel AI SDK providers. [Providers](docs/providers.md)
- **Egress policy.** `offline` or `allowlist`, checked before a built-in adapter connects. A child policy can only tighten its parent, an unenforceable transport fails closed, and process and ACP backends sit outside it. [LLM egress policy](docs/egress-policy.md)

## Built with OMA

`open-multi-agent` launched 2026-04-01 under MIT. Known users and integrations to date:

- **[temodar-agent](https://github.com/xeloxa/temodar-agent)** by [Ali Sünbül](https://github.com/xeloxa). WordPress security analysis platform running OMA's built-in tools (`bash`, `file_*`, `grep`) inside a Docker runtime. Confirmed production use. (~60 stars)
- **[Mark Galyan](https://github.com/apollo-mg)** runs OMA fully offline on local quantized models, using the coordinator and context compaction to keep autonomous agent loops alive under tight VRAM limits. Contributor since the framework's first month.
- **[Engram](https://www.engram-memory.com)**: "Git for AI memory." Syncs knowledge across agents instantly and flags conflicts. ([repo](https://github.com/Agentscreator/engram-memory), ~80 stars)

<details>
<summary>More users and integrations</summary>

**Users**

- **[PR-Copilot](https://github.com/kidoom/PR-Copilot)** by [kidoom](https://github.com/kidoom). AI pull-request review assistant running an OMA review team, with `defineTool` repo-context tools and a custom `ContextStrategy` for token-aware diff compression.
- **[StuFlow](https://github.com/znc15/StuFlow)** by [znc15](https://github.com/znc15). Terminal AI coding assistant on OMA's orchestration core, driving `runAgent` / `runTasks` / `runTeam` with a custom coordinator, paired with DeepSeek.
- **[Reports to Charts Studio](https://github.com/NARNIX0/Evident-Project)**. Turns documents and research tables into slide-ready charts, using a five-role extraction council with structured outputs and deterministic validation.

**Integrations**

- **[@agentsonar/oma](https://github.com/agentsonar/agentsonar-oma)**: Sidecar detecting cross-run delegation cycles, repetition, and rate bursts.
- **[CodingScaffold](https://github.com/JRS1986/CodingScaffold)**: Agentic-coding scaffold that lists OMA as an optional orchestration backend, with a `runTeam` workflow template.
- **[baize-oma](https://github.com/timywel/baize-oma)**: HTTP adapter exposing OMA `runAgent()` and `runTeam()` as Baize slot capabilities.

</details>

We build customer-owned systems on OMA for organizations that need one. Email [jack@yuanasi.com](mailto:jack@yuanasi.com).

## Sponsors

Paid sponsors supporting `open-multi-agent`. Sponsorship does not affect technical decisions or model recommendations.

**Providers**

- **[Atlas Cloud](https://www.atlascloud.ai/console/coding-plan)**: Full-modal AI inference platform giving one API for video, image, and LLM across 300+ curated models. $5 credit vouchers for OMA users, first come first served. See the [Atlas Cloud setup guide](docs/providers-atlascloud.md).

## Optional coordinator

`runTeam()` decomposes a goal into a task graph across agents. One model call turns the goal into task specs with assignees and dependencies, a deterministic scheduler executes them, and a second call writes the final answer from the completed task outputs. The coordinator is never consulted mid-run, and the finished run is data you can read back. Use `runAgent()` or `runTasks()` when you already know the work.

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

// Nothing above declares a task graph. The coordinator planned one at runtime,
// and the finished run is data you can read back.
for (const task of result.tasks ?? []) {
  console.log(`[${task.status}] ${task.title} → ${task.assignee ?? 'unassigned'}`, task.dependsOn)
}

console.log(result.agentResults.get('coordinator')?.output)
console.log(result.totalTokenUsage)
```

<p align="center">
  <img src="https://raw.githubusercontent.com/open-multi-agent/open-multi-agent/main/.github/brand/demo-dashboard-hero.gif" alt="OMA Run Viewer replaying a real run: task DAG and span waterfall views with per-task status, assignee, tokens, and tool calls" width="960" height="540" loading="lazy">
</p>
<p align="center"><em>The offline Run Viewer replaying a real run from the trace store: task DAG, span waterfall, and per-task evidence, with no hosted service involved.</em></p>

[Coordinator](docs/coordinator.md) covers what it decides and what it is allowed to see. [Plan replay](docs/plan-replay.md) freezes an approved plan, [Consensus](docs/consensus.md) verifies outputs with independent judges, and [External agents](docs/external-agents.md) puts Claude Code, Gemini CLI, and Codex on the same task graph through process and ACP backends.

## Packages

- **[`@open-multi-agent/core`](packages/core/README.md)**: Runtime, tools, memory, checkpoints, approvals, journal, traces, CLI, and offline Run Viewer.
- **[`@open-multi-agent/otel`](packages/otel/README.md)**: Optional OpenTelemetry adapter for teams with a centralized OpenTelemetry stack.
- **[`create-oma-app`](packages/create-oma-app/README.md)**: Scaffolder behind `npm create oma-app`; starter templates with a no-key local demo.

Core users can store traces locally and inspect them with the offline Run Viewer. Install the OTel package only when OMA traces should appear in the same monitoring system as the rest of your application.

## Documentation

| Goal | Start here |
|---|---|
| Install and run | [All docs](docs/README.md) · [Core package guide](packages/core/README.md) · [Examples](packages/core/examples/README.md) · [CLI](docs/cli.md) · [Glossary](docs/glossary.md) · [Production checklist](docs/production-checklist.md) |
| Configure models and tools | [Providers](docs/providers.md) · [LLM egress policy](docs/egress-policy.md) · [Tools](docs/tool-configuration.md) · [Sandbox and shell](docs/sandbox-and-shell.md) · [MCP](docs/mcp.md) · [Structured input](docs/structured-input.md) · [External agents](docs/external-agents.md) |
| Operate reliably | [Observability](docs/observability.md) · [Run Viewer](docs/run-viewer.md) · [Run journal](docs/run-journal.md) · [Evaluation](docs/evaluation.md) · [Checkpoint and resume](docs/checkpoint.md) · [Run store and leases](docs/run-store.md) · [Durable approvals](docs/durable-approvals.md) · [Adaptive recovery](docs/adaptive-recovery.md) · [Context management](docs/context-management.md) · [Errors](docs/errors.md) |
| Control orchestration | [Coordinator](docs/coordinator.md) · [Consensus](docs/consensus.md) · [Execution routing](docs/execution-routing.md) · [Model routing](docs/model-routing.md) · [Task scheduling](docs/task-scheduling.md) · [Plan replay](docs/plan-replay.md) · [Shared memory](docs/shared-memory.md) · [Streaming](docs/streaming.md) · [Budgets and limits](docs/budgets-and-limits.md) |

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for workspace boundaries, validation, and submission guidance.

<a href="https://github.com/open-multi-agent/open-multi-agent/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=open-multi-agent/open-multi-agent&max=100" />
</a>

Contributor credits by area are in [CONTRIBUTORS.md](CONTRIBUTORS.md).

## License

MIT

Maintained by [YuanASI (Shenzhen YuanASI Technology Co., Ltd.)](https://yuanasi.com/en?utm_source=github&utm_medium=readme_footer&utm_campaign=open_multi_agent).
