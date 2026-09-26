# OpenAI SDK compatibility

This page records the compatibility decision for the OpenAI Node SDK used by
`@open-multi-agent/core`. It covers the built-in OpenAI, Azure OpenAI, Copilot,
and OpenAI-compatible adapters; it does not make claims about a provider's
service-side API availability.

## Decision

As of 2026-09-26:

- The current OMA major stays on `openai@^6.49.0` and Node.js `>=20`.
- `openai@7` is a target for the next OMA major, after the migration work below.
- OMA will not load SDK v6 and v7 concurrently in the current major. That would
  add two dependency paths and two boundary matrices without preserving a
  supported Node.js 20 path once v7 is selected.

The direct upgrade is therefore **no-go for the current major** and **go for a
planned next-major migration**.

## Compatibility matrix

| OMA line | OpenAI SDK | Node.js | Decision |
|---|---|---|---|
| Current major | `^6.49.0` | 20, 22, 24 | Supported and tested by the existing CI matrix |
| Current major with SDK v7 | `7.23.0` evaluation | 22+ | Not a drop-in update; do not publish as a v1 patch/minor |
| Next major target | `^7.x` | 22+ | Re-evaluate after the migration checklist is complete |

`openai@7.23.0` declares `engines.node: ">=22.0.0"`. Raising the published
runtime floor now would break the compatibility window that OMA intentionally
retains for Node.js 20. The next major is the correct release boundary for
that change.

## Evaluation findings

### Request and response boundary

The v7 runtime still provides the symbols OMA uses at the package root:

- `OpenAI`
- `AzureOpenAI`
- `APIUserAbortError`
- `chat.completions.create()` for non-streaming and streaming requests

The existing local HTTP boundary suite also passed with SDK v7: function tools,
the final usage-only SSE chunk, API error status preservation, unsupported
custom-tool rejection, caller cancellation, OpenAI-compatible chat, and the
Azure adapter all remained green. This is a runtime compatibility result only;
it is not a live-provider or Node 20 result.

### Type-resolution boundary

OMA currently imports Chat Completions types from
`openai/resources/chat/completions/index.js` in four internal files:

- `packages/core/src/llm/openai.ts`
- `packages/core/src/llm/openai-common.ts`
- `packages/core/src/llm/azure-openai.ts`
- `packages/core/src/llm/copilot.ts`

With `openai@7.23.0`, the unmodified repository fails
`npm run lint -w @open-multi-agent/core` with `TS2307` for those four imports.
For OMA's module resolution, the v7-compatible declaration path is
`openai/resources/chat/completions/completions.js`. A probe that changed only
these four type-only specifiers passed the core lint and build checks, so this
is a small, isolated migration prerequisite rather than a reason to add a
compatibility shim or a second SDK dependency.

### Public API and adapter blast radius

The OpenAI SDK types are used inside the LLM adapter implementation and are not
part of OMA's root public type surface. The direct and Azure adapters use the
SDK; Copilot uses the same OpenAI boundary; DeepSeek, Doubao, Grok, Hunyuan,
MiniMax, MiMo, and Qiniu reuse `OpenAIAdapter`. The image adapters use `fetch`
directly and are outside this SDK decision.

The migration must therefore compile every OpenAI-compatible subclass and both
direct adapters, not only the `openai` provider name.

### Retry, timeout, and cancellation

The v6 and v7 clients both document a default SDK timeout of ten minutes and a
default of two SDK retries. OMA already adds its own adapter/run retry policy
and passes the caller's `AbortSignal` through the SDK boundary. The upgrade
must keep this layering explicit: either preserve the current SDK defaults and
test the combined behavior, or make an intentional `maxRetries` decision in a
separate behavior change. This evaluation does not silently change retry
counts.

SDK v7 also documents independent Node.js fetch response-header and
body-inactivity timeouts. A live-provider check on Node 22/24 is required
before claiming long-running streaming compatibility; the local boundary
tests do not prove that transport behavior.

## Migration checklist for the next major

1. Change the four internal type imports to the v7-compatible public path and
   compile against both the current v6 lockfile and the selected v7 release.
2. Raise the next major's runtime contract and generated-app templates to Node
   22, and keep CI on Node 22 and 24.
3. Run the boundary matrix for non-streaming Chat Completions, streaming usage
   chunks, JSON-schema function tools, unsupported tool variants, API errors,
   aborts, Azure, Copilot, and every OpenAI-compatible subclass.
4. Verify the public declarations, package tarball, egress policy wrapper, and
   OpenAI-compatible `baseURL` path; confirm that no OpenAI SDK type becomes a
   root export.
5. Decide and document whether the SDK's two automatic retries remain enabled
   alongside OMA retry behavior. Add a deterministic test for the chosen
   request-count contract.
6. Run the complete Node 22/24 CI matrix and an opt-in live OpenAI/Azure check
   when credentials are available. Do not claim live-provider coverage from
   mocked or local-server tests.

No dependency, public API, or Node.js engine change is part of this evaluation
page. The eventual SDK bump should be a separate next-major implementation PR
with its own release and migration notes.
