# Shared Memory

Teams can share a namespaced key-value store so later agents see earlier agents' findings. Enable it with a boolean for the default in-process store:

```typescript
const team = orchestrator.createTeam('research-team', {
  name: 'research-team',
  agents: [researcher, writer],
  sharedMemory: true,
})
```

For durable or cross-process backends (Redis, Postgres, Engram, etc.), implement the `MemoryStore` interface and pass it via `sharedMemoryStore`. Keys are still namespaced as `<agentName>/<key>` before reaching the store:

```typescript
import type { MemoryStore } from '@jackchen_me/open-multi-agent'

class RedisStore implements MemoryStore { /* get/set/list/delete/clear */ }

const team = orchestrator.createTeam('durable-team', {
  name: 'durable-team',
  agents: [researcher, writer],
  sharedMemoryStore: new RedisStore(),
})
```

When both are provided, `sharedMemoryStore` wins. SDK-only: the CLI cannot pass runtime objects.
