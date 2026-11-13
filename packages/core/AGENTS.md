# @open-multi-agent/core agent rules

Repository-wide rules, the validation matrix, and the cross-package invariants are in the root [AGENTS.md](../../AGENTS.md). This file holds only what matters while editing this package. Paths below are relative to `packages/core/` unless they start with `../`.

## Architecture entry points

`src/` is organized one directory per subsystem; run `ls src/` to locate code rather than relying on any list of those directories, and use [`docs/`](../../docs/README.md) for behavior and contracts. Inside `src/orchestrator/`, `orchestrator.ts` is the entry point that the peer modules in that directory hang off.

The published surface is `src/index.ts` plus the subpath entry points declared under `exports` in [`package.json`](package.json); list them with `jq '.exports | keys' packages/core/package.json` from the repository root rather than relying on any copy of that list. When adding or renaming one, keep that declaration, the backing source file, and the required entry-point list in the `package` job of [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) in sync.

`OpenMultiAgent` exposes three primary modes: `runAgent()` for a one-shot agent, `runTeam()` for coordinator-generated task DAGs, and `runTasks()` for explicit dependency pipelines. See the [README](README.md#architecture) for the conceptual architecture.

## Lint type-checks the examples

`npm run lint -w @open-multi-agent/core` type-checks `examples/` alongside `src/` via [`tsconfig.lint.json`](tsconfig.lint.json). That config excludes `examples/fixtures/` and the self-contained example projects that carry their own `package.json`/`tsconfig.json`. Add a new example of that shape to its `exclude` list, since lint cannot resolve a package-name import of `@open-multi-agent/core` before `dist` exists.

## Adding an LLM adapter

1. Implement `LLMAdapter.chat()` and `LLMAdapter.stream()`, add the provider to `SupportedProvider`, and register it in [`src/llm/adapter.ts`](src/llm/adapter.ts) through dynamic `import()` so unused SDKs never resolve. OpenAI-compatible providers should accept `baseURL` and reuse `openai-common.ts`.
2. Decide how the provider behaves under `egressPolicy` in `prepareProviderBaseURL`. An OpenAI-compatible provider needs an entry in `PROVIDER_DEFAULT_BASE_URLS` or a provider endpoint environment variable so its origin can be resolved and checked. A provider whose SDK opens connections OMA cannot guard must be declared unsupported so it fails closed.
3. Add the outcome to the enforcement matrix in [docs/egress-policy.md](../../docs/egress-policy.md).
4. Add focused adapter tests and update [docs/providers.md](../../docs/providers.md) without introducing a hard-coded provider count.

## Non-obvious invariants

These constraints span multiple files in this package and can cause behavioral or compatibility bugs when missed. Each links to the `docs/` page that owns the full contract.

- **Tool errors are values:** tool failures are returned as `ToolResult` with `isError: true`; they do not throw through the runner. LLM API failures propagate. Task failures cascade to dependents while independent tasks may continue.
- **Built-in tools are default-deny:** a built-in is granted only through `AgentConfig.tools`, `toolPreset`, or `OrchestratorConfig.defaultToolPreset`. Registered custom/runtime tools are granted by registration but still honor `disallowedTools`. Ungranted calls return an error rather than executing. See [tool configuration](../../docs/tool-configuration.md).
- **Per-call gates run below grants:** `onToolCall` runs after Zod validation and before execution. Denial returns an error `ToolResult`; throwing or invalid gates fail closed. Ungranted tools never reach the gate. `AgentConfig.onToolCall` overrides the orchestrator default. The optional shell classifier is exported from `/classifiers`.
- **Delegation is orchestration-only and separately granted:** `delegate_to_agent` exists only in `runTeam()` and `runTasks()` workers and must be explicitly granted. Standalone `runAgent()` and the simple-goal short circuit do not register it. Self-delegation, cycles, unknown targets, excess depth, and unavailable pool capacity are rejected; delegated usage counts against the parent budget.
- **Filesystem tools are sandboxed; `bash` is not:** filesystem built-ins resolve paths and symlinks within `AgentConfig.cwd` or `OrchestratorConfig.defaultCwd`, defaulting to `<cwd>/.agent-workspace`. `null` disables that sandbox and `process.cwd()` widens it. Shell execution has no equivalent filesystem boundary. See [sandbox and shell](../../docs/sandbox-and-shell.md).
- **Reasoning is dropped unless opted in:** provider-native reasoning blocks that the target adapter cannot echo are discarded unless `preserveReasoningAsText` is enabled. Inline `<thinking>` text is never reconstructed into a signed reasoning block. See [context management](../../docs/context-management.md).
- **Native tool calls win:** the local-model text extractor runs only when a server emits no native tool calls.
- **External backends replace the LLM runner:** process and ACP backends perform their own work in `cwd`; the runner tool loop, sandbox, and context strategy do not apply, while queue, scheduler, memory, and budget behavior remain backend-agnostic. ACP permissions default to auto-approve and its cumulative context usage is recorded as per-turn deltas when updates exist. See [external agents](../../docs/external-agents.md).
- **Ownership is opt-in, and its writes fail closed:** without a `runStore` a checkpoint is recovery state with no owner, so two processes can restore the same snapshot and both advance it. With one, a run acquires a lease before it dispatches, checkpoint writes fence against its token, and lifecycle writes reject rather than degrade to best-effort. A worker that lost its lease writes no terminal status and never reports success. See [run store](../../docs/run-store.md).
- **Evaluation observes results:** offline evaluation is separate; online sampling, scoring, and persistence are best-effort and isolated from the business response. Scorer failures become `scorer_error` and are excluded from score aggregates rather than converted to zero. See [evaluation](../../docs/evaluation.md).
