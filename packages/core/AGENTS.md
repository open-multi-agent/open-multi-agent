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
