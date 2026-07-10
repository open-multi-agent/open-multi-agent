# Shared Memory

Teams can share a namespaced key-value store so later agents see earlier agents' findings. Enable it with a boolean for the default in-process store:

```typescript
const team = orchestrator.createTeam('research-team', {
  name: 'research-team',
  agents: [researcher, writer],
  sharedMemory: true,
})
```

For durable persistence without writing any storage code, pass the bundled **`FileStore`** — a zero-dependency, filesystem-backed `MemoryStore` with atomic writes (see [Checkpoint & resume](checkpoint.md#durable-persistence-filestore)). For cross-process or infrastructure backends (Redis, Postgres, Engram, etc.), implement the `MemoryStore` interface yourself and pass it via `sharedMemoryStore`. Keys are still namespaced as `<agentName>/<key>` before reaching the store:

```typescript
import type { MemoryStore } from '@open-multi-agent/core'

class RedisStore implements MemoryStore { /* get/set/list/delete/clear */ }

const team = orchestrator.createTeam('durable-team', {
  name: 'durable-team',
  agents: [researcher, writer],
  sharedMemoryStore: new RedisStore(),
})
```

When both are provided, `sharedMemoryStore` wins. SDK-only: the CLI cannot pass runtime objects.

## Redacting persisted secrets

Shared-memory writes persist agent output **verbatim**. Redaction elsewhere (trace spans, the dashboard) stops at the telemetry layer and does not reach the store — so if an agent can emit a secret into its answer and your store is durable, that secret lands on disk. Wrap the store with **`RedactingStore`**, a `MemoryStore` decorator that scrubs credentials (plus any custom patterns you add) from values on write, at the one choke point every write passes through:

```typescript
import { RedactingStore, FileStore } from '@open-multi-agent/core'

const team = orchestrator.createTeam('durable-team', {
  name: 'durable-team',
  agents: [researcher, writer],
  sharedMemoryStore: new RedactingStore(new FileStore('./.oma/memory.json'), {
    // Optional: extra value patterns (e.g. PII) on top of built-in credential redaction.
    patterns: [/\b\d{3}-\d{2}-\d{4}\b/],
  }),
})
```

Because checkpoints default to the team's shared-memory store, this one wrap also redacts the checkpoint written to it (see [Checkpoint & resume](checkpoint.md#redacting-persisted-secrets)). Redaction is **write-time**, so it is opt-in by construction and lossy on purpose: a downstream agent — or a resumed run — reads `[redacted]` where the secret was. The caller-facing run result is untouched; it never passes through the store.
