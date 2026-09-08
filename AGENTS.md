# AGENTS.md

This file is the canonical working agreement for AI agents editing this repository. It holds the execution rules, high-risk invariants, and verification expectations that apply across workspaces. Conceptual architecture lives in [`packages/core/README.md`](packages/core/README.md), subsystem behavior in [`docs/`](docs/), and package-specific traps in each package's own `AGENTS.md`, so this file stays concise and accurate.

## Repository layout

This is a private npm-workspaces root. Run the commands below from the repository root unless a workspace-specific `-w` form is shown. Discover the workspaces with `ls packages/` and read each `package.json` for its scripts; the facts below are the ones that listing cannot tell you.

- `@open-multi-agent/release-bot` is private and never published. It drives [`.github/workflows/release-bot.yml`](.github/workflows/release-bot.yml) and [`publish.yml`](.github/workflows/publish.yml).
- `@open-multi-agent/otel` is versioned independently from core.
- [`bench/`](bench/README.md) is the A/B benchmark harness: not a workspace, never published, runs through `npx tsx`, and everything it produces is gitignored.
- Paths in this file are repository-relative. An unprefixed `src/` or `tests/` is ambiguous across workspaces, so name the package.
- Package-specific rules live in nested `AGENTS.md` files (`ls packages/*/AGENTS.md`), each beside a `CLAUDE.md` that only imports it. They load when you work inside that package; read them before editing there.

## Commands

```bash
npm run build          # Compile every workspace
npm run lint           # Type-check every workspace; core lint also covers packages/core/examples/
npm test               # Unit tests in every workspace; mocks provider SDKs, needs no network or API keys
npm run test:scaffold  # End-to-end create-oma-app scaffold smoke test
npm run test:example-catalog  # Validate example catalog metadata and coverage
npm run test:e2e       # Core provider E2E; needs real API keys, as do most examples

node packages/core/dist/cli/oma.js help  # After build; `oma` when installed from npm
```

## Working rules

- Use strict TypeScript and ESM imports with `.js` extensions: `import { X } from './foo.js'` even when the source file is TypeScript. There is no eslint/prettier configuration; match nearby style.
- Change source files, tests, templates, or docs rather than generated `dist/` output.
- Add or update tests for behavior changes. Update user-facing docs and examples when public behavior changes, or state why they are not applicable.
- Keep dependency ownership explicit. Core must remain importable and runnable without optional integrations.
- **Pin what stays in the repository; keep ranges on what a consumer installs.** `devDependencies` everywhere and the release bot's dependencies are exact; the root [`.npmrc`](.npmrc) sets `save-exact=true` so a new one arrives pinned. The published blocks stay semver ranges: core's `dependencies`, every `peerDependencies`, and otel's `@open-multi-agent/core`.
- `save-exact` also pins a new entry in a published block, so widen it by hand. An exact version there overrides the consumer's own resolution and blocks their `npm audit fix` until we cut a release; the `package` job in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) fails when one is left exact.
- Add optional provider SDKs as peer dependencies and load them lazily with dynamic `import()`. Do not maintain a fixed dependency or adapter count in documentation.
- OpenTelemetry APIs, SDKs, semantic-convention packages, and exporters belong in `@open-multi-agent/otel`, never in the core root import. The application owns its tracer/provider lifecycle unless an API explicitly says otherwise.
- **`docs/` is the source of truth for subsystem behavior.** [docs/README.md](docs/README.md) indexes every page with the question it answers; run `ls docs/` before concluding a topic is undocumented. Keep this file to rules and concise invariants, and link to docs instead of copying explanations.
- **The package READMEs are landing pages, not guides.** A new feature earns at most one short paragraph plus a link to its `docs/` page in [`packages/core/README.md`](packages/core/README.md); anything longer belongs in `docs/`. Update [`packages/core/README_zh.md`](packages/core/README_zh.md) in the same change or the translation drifts. Per-contributor credits live in [`CONTRIBUTORS.md`](CONTRIBUTORS.md), not in a README.
- Follow conventional commits when a commit is requested. Reference a PR or issue when one exists. The full contribution flow is in [`.github/CONTRIBUTING.md`](.github/CONTRIBUTING.md).
- Publishing spans three packages with independent version tracks, a fixed publish order, and template pins that must move with the core version. Do not infer any of that from this file: [`.github/RELEASING.md`](.github/RELEASING.md) is the source of truth.
- **Managed Git worktrees share repository metadata.** Never repair access by changing `.git` ownership or permissions. Use the current tool's normal Git and approval flow.
- **Keep worktree dependencies isolated.** Run `npm ci` in each worktree and never symlink `node_modules` from another checkout.

## Validation by change type

Always inspect the focused diff and run `git diff --check`. Run the smallest relevant checks first, then broaden in proportion to the change.

- **Documentation-only:** `git diff --check`; tests are not required unless commands, generated artifacts, or executable examples changed.
- **Core code:** relevant core tests, then `npm run lint -w @open-multi-agent/core` and `npm run test -w @open-multi-agent/core`. Run `npm run build -w @open-multi-agent/core` when public entry points, declarations, package output, or CLI output may be affected.
- **OpenTelemetry adapter:** relevant tests, then `npm run lint -w @open-multi-agent/otel`, `npm run test -w @open-multi-agent/otel`, and build when package output or public types may be affected.
- **Release bot:** relevant tests, then `npm run lint -w @open-multi-agent/release-bot` and `npm run test -w @open-multi-agent/release-bot`; both build core first through their `pre` scripts, so they also catch a core API change that breaks the bot. Workflow changes follow [`.github/RELEASING.md`](.github/RELEASING.md).
- **Scaffolder or templates:** relevant tests, then `npm run lint -w create-oma-app`, `npm run test -w create-oma-app`, and `npm run typecheck:template -w create-oma-app`. Run `npm run test:scaffold -w create-oma-app` when generated-project behavior changes.
- **Examples or catalog metadata:** `npm run test:example-catalog` and `npm run lint -w @open-multi-agent/core`; add a runnable example smoke test when executable behavior changes. Which examples core lint excludes, and why, is in [`packages/core/AGENTS.md`](packages/core/AGENTS.md).
- **Cross-workspace or dependency changes:** `npm run lint`, `npm test`, and `npm run build`; add the package/import/template smoke checks relevant to the changed surface.
- **Provider E2E:** run only when the changed surface requires real-provider verification and the necessary credentials are safely available. Never expose credential values.

Before finishing, report every command run and its outcome. If a relevant check was skipped or could not run, state the reason and residual risk. CI remains the source of truth for the complete Node 20/22/24 pre-merge matrix.

## Non-obvious invariants

These constraints span multiple files and packages and can cause behavioral or compatibility bugs when missed. Each links to the `docs/` page that owns the full contract.

- **Tool errors are values:** tool failures are returned as `ToolResult` with `isError: true`; they do not throw through the runner. LLM API failures propagate. Task failures cascade to dependents while independent tasks may continue.
- **Built-in tools are default-deny:** a built-in is granted only through `AgentConfig.tools`, `toolPreset`, or `OrchestratorConfig.defaultToolPreset`. Registered custom/runtime tools are granted by registration but still honor `disallowedTools`. Ungranted calls return an error rather than executing. See [tool configuration](docs/tool-configuration.md).
- **Per-call gates run below grants:** `onToolCall` runs after Zod validation and before execution. Denial returns an error `ToolResult`; throwing or invalid gates fail closed. Ungranted tools never reach the gate. `AgentConfig.onToolCall` overrides the orchestrator default. The optional shell classifier is exported from `/classifiers`.
- **Delegation is orchestration-only and separately granted:** `delegate_to_agent` exists only in `runTeam()` and `runTasks()` workers and must be explicitly granted. Standalone `runAgent()` and the simple-goal short circuit do not register it. Self-delegation, cycles, unknown targets, excess depth, and unavailable pool capacity are rejected; delegated usage counts against the parent budget.
- **Filesystem tools are sandboxed; `bash` is not:** filesystem built-ins resolve paths and symlinks within `AgentConfig.cwd` or `OrchestratorConfig.defaultCwd`, defaulting to `<cwd>/.agent-workspace`. `null` disables that sandbox and `process.cwd()` widens it. Shell execution has no equivalent filesystem boundary. See [sandbox and shell](docs/sandbox-and-shell.md).
- **Reasoning is dropped unless opted in:** provider-native reasoning blocks that the target adapter cannot echo are discarded unless `preserveReasoningAsText` is enabled. Inline `<thinking>` text is never reconstructed into a signed reasoning block. See [context management](docs/context-management.md).
- **Native tool calls win:** the local-model text extractor runs only when a server emits no native tool calls.
- **External backends replace the LLM runner:** process and ACP backends perform their own work in `cwd`; the runner tool loop, sandbox, and context strategy do not apply, while queue, scheduler, memory, and budget behavior remain backend-agnostic. ACP permissions default to auto-approve and its cumulative context usage is recorded as per-turn deltas when updates exist. See [external agents](docs/external-agents.md).
- **Ownership is opt-in, and its writes fail closed:** without a `runStore` a checkpoint is recovery state with no owner, so two processes can restore the same snapshot and both advance it. With one, a run acquires a lease before it dispatches, checkpoint writes fence against its token, and lifecycle writes reject rather than degrade to best-effort. A worker that lost its lease writes no terminal status and never reports success. See [run store](docs/run-store.md).
- **Telemetry is not execution state:** losing telemetry must not roll back a durable run. Deleting traces must not delete checkpoints, shared memory, or remotely exported OpenTelemetry data. Observability delivery/export failures do not become agent, task, or run failures. See [observability](docs/observability.md).
- **Evaluation observes results:** offline evaluation is separate; online sampling, scoring, and persistence are best-effort and isolated from the business response. Scorer failures become `scorer_error` and are excluded from score aggregates rather than converted to zero. See [evaluation](docs/evaluation.md).
- **Secrets and PII are redacted best-effort:** traces, shell output, and dashboard payloads pass through redaction, but callers must still avoid deliberately persisting or logging secrets.
