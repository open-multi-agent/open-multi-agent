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
import type { MemoryStore } from '@open-multi-agent/core'

class RedisStore implements MemoryStore { /* get/set/list/delete/clear */ }

const team = orchestrator.createTeam('durable-team', {
  name: 'durable-team',
  agents: [researcher, writer],
  sharedMemoryStore: new RedisStore(),
})
```

When both are provided, `sharedMemoryStore` wins. SDK-only: the CLI cannot pass runtime objects.

---

## Structured handoff (typed values)

`SharedMemory.write()` and `writeExpiring()` accept any JSON-serializable value, not just strings:

```typescript
const mem = new SharedMemory()

// String (backward-compatible)
await mem.write('researcher', 'findings', 'TypeScript 5.5 ships const type params')

// Object (auto-serialized via JSON.stringify)
await mem.write('analyst', 'summary', {
  total: 42,
  passed: 40,
  failed: 2,
  tags: ['regression', 'critical'],
})

// Array
await mem.write('tester', 'reports', [
  { id: 1, status: 'pass' },
  { id: 2, status: 'fail', reason: 'timeout' },
])

// Number / boolean
await mem.write('counter', 'remaining', 7)
await mem.write('checker', 'valid', true)
```

`SharedMemory` serialises values to JSON strings before writing to the underlying `MemoryStore` and deserialises them back to their original type on read, so downstream callers receive well-typed data without manual parsing.

### Schema validation (Zod)

Pass a Zod schema to validate structured values at write time. Reuses the same Zod pattern from the tool framework (`defineTool`):

```typescript
import { z } from 'zod'

const AnalysisSchema = z.object({
  total: z.number(),
  passed: z.number(),
  failed: z.number(),
  tags: z.array(z.string()),
})

await mem.write('analyst', 'summary', data, undefined, AnalysisSchema)
// → passes: validates `data` against AnalysisSchema before storing

await mem.write('analyst', 'summary', { total: 42, passed: 40 }, undefined, AnalysisSchema)
// → throws ZodError: "failed" is required
```

Schema validation also works with `writeExpiring()`:

```typescript
await mem.writeExpiring('analyst', 'summary', data, 3, undefined, AnalysisSchema)
```

### Summary output

`getSummary()` detects the stored value type and formats it accordingly:

- **string** — truncated to 200 characters (unchanged behavior)
- **object / array** — pretty-printed with `JSON.stringify(value, null, 2)`
- **number, boolean, null, undefined** — rendered via `String()`

```typescript
await mem.write('analyst', 'stats', { pass: 40, fail: 2 })

const summary = await mem.getSummary()
// ## Shared Team Memory
//
// ### analyst
// - stats: {
//   "pass": 40,
//   "fail": 2
// }
```
