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
- **OpenTelemetry adapter, release bot, scaffolder or templates:** each package keeps its own validation steps in its `AGENTS.md`: [`packages/otel/AGENTS.md`](packages/otel/AGENTS.md), [`packages/release-bot/AGENTS.md`](packages/release-bot/AGENTS.md), and [`packages/create-oma-app/AGENTS.md`](packages/create-oma-app/AGENTS.md).
- **Examples or catalog metadata:** `npm run test:example-catalog` and `npm run lint -w @open-multi-agent/core`; add a runnable example smoke test when executable behavior changes. Which examples core lint excludes, and why, is in [`packages/core/AGENTS.md`](packages/core/AGENTS.md).
- **Cross-workspace or dependency changes:** `npm run lint`, `npm test`, and `npm run build`; add the package/import/template smoke checks relevant to the changed surface.
- **Provider E2E:** run only when the changed surface requires real-provider verification and the necessary credentials are safely available. Never expose credential values.

Before finishing, report every command run and its outcome. If a relevant check was skipped or could not run, state the reason and residual risk. CI remains the source of truth for the complete Node 20/22/24 pre-merge matrix.

## Non-obvious invariants

These constraints span multiple files and packages and can cause behavioral or compatibility bugs when missed. Each links to the `docs/` page that owns the full contract.

Invariants that concern a single package live in that package's `AGENTS.md`; the core runtime invariants (tools, delegation, sandbox, reasoning, external backends, run store, evaluation) are in [`packages/core/AGENTS.md`](packages/core/AGENTS.md#non-obvious-invariants).

- **Telemetry is not execution state:** losing telemetry must not roll back a durable run. Deleting traces must not delete checkpoints, shared memory, or remotely exported OpenTelemetry data. Observability delivery/export failures do not become agent, task, or run failures. See [observability](docs/observability.md).
- **Secrets and PII are redacted best-effort:** traces, shell output, and dashboard payloads pass through redaction, but callers must still avoid deliberately persisting or logging secrets.
