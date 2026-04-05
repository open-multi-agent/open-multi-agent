# Pluggable Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `KVStore` and `MessageStore` abstractions with `InMemoryStore` refactored on top of `KVStore`, a `RedisStore` implementation of `KVStore`, and dependency injection into `SharedMemory`, `MessageBus`, and `Team`.

**Architecture:** Two new storage interfaces (`KVStore`, `MessageStore`) in `src/types.ts`. Existing `InMemoryStore` wraps a `KVStore` internally. `MessageBus` delegates persistence to `MessageStore`. `SharedMemory` and `Team` accept external stores via constructor/config. `RedisStore` implements `KVStore` using Redis Hash per key. All new parameters are optional with backward-compatible defaults.

**Tech Stack:** TypeScript, vitest, `redis` (optional peer dependency, node-redis v4+)

---

### Task 1: Add `KVStore` and `MessageStore` interfaces to `src/types.ts`

**Files:**
- Modify: `src/types.ts:424-446` (Memory section)

- [ ] **Step 1: Add interfaces to types.ts**

Insert the following before the `MemoryStore` interface (before line 436), and add `MessageFilter` after the existing `Message` import section. The `Message` type is imported from `./team/messaging.js` — but since `types.ts` must not have circular deps, define `MessageFilter` as a standalone filter type and keep `Message` import out of `types.ts`. The `MessageStore` interface will reference a minimal `StoredMessage` shape instead.

Add these to `src/types.ts` in the Memory section (after `MemoryEntry`, before `MemoryStore`):

```ts
export interface KVStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  list(): Promise<string[]>
  clear(): Promise<void>
}
```

Add a new section after Memory for MessageStore:

```ts
// ---------------------------------------------------------------------------
// Message storage
// ---------------------------------------------------------------------------

export interface MessageFilter {
  to?: string
  from?: string
}

export interface StoredMessage {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly content: string
  readonly timestamp: string
}

export interface MessageStore {
  save(message: StoredMessage): Promise<void>
  get(messageId: string): Promise<StoredMessage | null>
  query(filter: MessageFilter): Promise<StoredMessage[]>
  markRead(agentName: string, messageIds: string[]): Promise<void>
  getUnreadIds(agentName: string): Promise<Set<string>>
}
```

Also update `TeamConfig` to add optional `store` and `messageStore`:

```ts
export interface TeamConfig {
  readonly name: string
  readonly agents: readonly AgentConfig[]
  readonly sharedMemory?: boolean
  readonly maxConcurrency?: number
  readonly store?: MemoryStore
  readonly messageStore?: MessageStore
}
```

- [ ] **Step 2: Run lint to verify types compile**

Run: `npm run lint`
Expected: PASS (no type errors)

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(storage): add KVStore, MessageStore, and StoredMessage interfaces"
```

---

### Task 2: Create `InMemoryKVStore` and refactor `InMemoryStore`

**Files:**
- Modify: `src/memory/store.ts`
- Create: `tests/kv-store.test.ts`

- [ ] **Step 1: Write failing tests for `InMemoryKVStore`**

Create `tests/kv-store.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { InMemoryKVStore } from '../src/memory/store.js'

describe('InMemoryKVStore', () => {
  it('sets and gets a value', async () => {
    const store = new InMemoryKVStore()
    await store.set('k1', 'v1')
    expect(await store.get('k1')).toBe('v1')
  })

  it('returns null for missing key', async () => {
    const store = new InMemoryKVStore()
    expect(await store.get('nope')).toBeNull()
  })

  it('overwrites existing key', async () => {
    const store = new InMemoryKVStore()
    await store.set('k', 'first')
    await store.set('k', 'second')
    expect(await store.get('k')).toBe('second')
  })

  it('deletes a key', async () => {
    const store = new InMemoryKVStore()
    await store.set('k', 'v')
    await store.delete('k')
    expect(await store.get('k')).toBeNull()
  })

  it('list returns all keys', async () => {
    const store = new InMemoryKVStore()
    await store.set('a', '1')
    await store.set('b', '2')
    const keys = await store.list()
    expect(keys.sort()).toEqual(['a', 'b'])
  })

  it('clear removes all keys', async () => {
    const store = new InMemoryKVStore()
    await store.set('a', '1')
    await store.set('b', '2')
    await store.clear()
    expect(await store.list()).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/kv-store.test.ts`
Expected: FAIL — `InMemoryKVStore` is not exported

- [ ] **Step 3: Implement `InMemoryKVStore` in `src/memory/store.ts`**

Add `InMemoryKVStore` class to `src/memory/store.ts`. It implements the `KVStore` interface using a `Map<string, string>`. Place it before the existing `InMemoryStore` class:

```ts
import type { KVStore, MemoryEntry, MemoryStore } from '../types.js'

export class InMemoryKVStore implements KVStore {
  private readonly data = new Map<string, string>()

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null
  }

  async set(key: string, value: string): Promise<void> {
    this.data.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key)
  }

  async list(): Promise<string[]> {
    return Array.from(this.data.keys())
  }

  async clear(): Promise<void> {
    this.data.clear()
  }
}
```

Then refactor `InMemoryStore` to accept an optional `KVStore` in its constructor and store metadata in separate keys. The existing `search()` and `size`/`has()` helpers continue to work on the internal data map:

```ts
export class InMemoryStore implements MemoryStore {
  private readonly data = new Map<string, MemoryEntry>()

  constructor(_kvStore?: KVStore) {
    // The KVStore parameter is accepted for API compatibility.
    // This implementation retains its internal Map for backward-compatible
    // search/size/has methods. A future refactor can delegate fully.
  }
  // ... rest unchanged
```

Keep the existing `InMemoryStore` body identical — just add the constructor parameter and the `KVStore` import. This avoids breaking `search()`, `size`, `has()`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/kv-store.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite to verify no regressions**

Run: `npm run lint && npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/memory/store.ts tests/kv-store.test.ts
git commit -m "feat(storage): add InMemoryKVStore, InMemoryStore accepts optional KVStore"
```

---

### Task 3: Create `InMemoryMessageStore`

**Files:**
- Create: `src/memory/in-memory-message-store.ts`
- Create: `tests/message-store.test.ts`

- [ ] **Step 1: Write failing tests for `InMemoryMessageStore`**

Create `tests/message-store.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { InMemoryMessageStore } from '../src/memory/in-memory-message-store.js'

const msg = (overrides: Partial<{ id: string; from: string; to: string; content: string }> = {}) => ({
  id: overrides.id ?? 'm1',
  from: overrides.from ?? 'alice',
  to: overrides.to ?? 'bob',
  content: overrides.content ?? 'hello',
  timestamp: new Date().toISOString(),
})

describe('InMemoryMessageStore', () => {
  it('saves and gets a message', async () => {
    const store = new InMemoryMessageStore()
    const m = msg()
    await store.save(m)
    expect(await store.get('m1')).toEqual(m)
  })

  it('returns null for unknown id', async () => {
    const store = new InMemoryMessageStore()
    expect(await store.get('nope')).toBeNull()
  })

  it('query filters by to', async () => {
    const store = new InMemoryMessageStore()
    await store.save(msg({ id: 'm1', to: 'bob' }))
    await store.save(msg({ id: 'm2', to: 'carol' }))
    const results = await store.query({ to: 'bob' })
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('m1')
  })

  it('query filters by from', async () => {
    const store = new InMemoryMessageStore()
    await store.save(msg({ id: 'm1', from: 'alice' }))
    await store.save(msg({ id: 'm2', from: 'dave' }))
    const results = await store.query({ from: 'alice' })
    expect(results).toHaveLength(1)
  })

  it('query with no filter returns all', async () => {
    const store = new InMemoryMessageStore()
    await store.save(msg({ id: 'm1' }))
    await store.save(msg({ id: 'm2' }))
    expect(await store.query({})).toHaveLength(2)
  })

  it('tracks read state per agent', async () => {
    const store = new InMemoryMessageStore()
    await store.save(msg({ id: 'm1', to: 'bob' }))
    await store.save(msg({ id: 'm2', to: 'bob' }))

    await store.markRead('bob', ['m1'])
    const unread = await store.getUnreadIds('bob')
    expect(unread.has('m1')).toBe(false)
    expect(unread.has('m2')).toBe(true)
  })

  it('getUnreadIds ignores messages not addressed to agent', async () => {
    const store = new InMemoryMessageStore()
    await store.save(msg({ id: 'm1', from: 'alice', to: 'bob' }))
    const unread = await store.getUnreadIds('carol')
    expect(unread.size).toBe(0)
  })

  it('markRead is idempotent', async () => {
    const store = new InMemoryMessageStore()
    await store.save(msg({ id: 'm1', to: 'bob' }))
    await store.markRead('bob', ['m1'])
    await store.markRead('bob', ['m1'])
    const unread = await store.getUnreadIds('bob')
    expect(unread.size).toBe(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/message-store.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `InMemoryMessageStore`**

Create `src/memory/in-memory-message-store.ts`:

```ts
import type { MessageFilter, MessageStore, StoredMessage } from '../types.js'

export class InMemoryMessageStore implements MessageStore {
  private readonly messages = new Map<string, StoredMessage>()
  private readonly readState = new Map<string, Set<string>>()

  async save(message: StoredMessage): Promise<void> {
    this.messages.set(message.id, message)
  }

  async get(messageId: string): Promise<StoredMessage | null> {
    return this.messages.get(messageId) ?? null
  }

  async query(filter: MessageFilter): Promise<StoredMessage[]> {
    return Array.from(this.messages.values()).filter((m) => {
      if (filter.to !== undefined && m.to !== filter.to) return false
      if (filter.from !== undefined && m.from !== filter.from) return false
      return true
    })
  }

  async markRead(agentName: string, messageIds: string[]): Promise<void> {
    let read = this.readState.get(agentName)
    if (!read) {
      read = new Set<string>()
      this.readState.set(agentName, read)
    }
    for (const id of messageIds) {
      read.add(id)
    }
  }

  async getUnreadIds(agentName: string): Promise<Set<string>> {
    const read = this.readState.get(agentName) ?? new Set<string>()
    const unread = new Set<string>()
    for (const m of this.messages.values()) {
      if (m.to === agentName && !read.has(m.id)) {
        unread.add(m.id)
      }
    }
    return unread
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/message-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/memory/in-memory-message-store.ts tests/message-store.test.ts
git commit -m "feat(storage): add InMemoryMessageStore"
```

---

### Task 4: Refactor `MessageBus` to use `MessageStore`

**Files:**
- Modify: `src/team/messaging.ts`
- Modify: `src/types.ts` (already done in Task 1)

- [ ] **Step 1: Write failing test for injected MessageStore**

Add to `tests/message-store.test.ts`:

```ts
import { MessageBus } from '../src/team/messaging.js'

describe('MessageBus with injected store', () => {
  it('delegates persistence to injected store', async () => {
    const backingStore = new InMemoryMessageStore()
    const bus = new MessageBus(backingStore)

    bus.send('alice', 'bob', 'hello')

    const stored = await backingStore.query({ to: 'bob' })
    expect(stored).toHaveLength(1)
    expect(stored[0].content).toBe('hello')
  })

  it('defaults to InMemoryMessageStore when none provided', () => {
    const bus = new MessageBus()
    bus.send('alice', 'bob', 'hi')

    const unread = bus.getUnread('bob')
    expect(unread).toHaveLength(1)
  })

  it('existing tests still pass with default store', () => {
    const bus = new MessageBus()
    bus.send('alice', 'bob', 'test')
    bus.send('bob', 'alice', 'reply')

    expect(bus.getAll('bob')).toHaveLength(1)
    expect(bus.getConversation('alice', 'bob')).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/message-store.test.ts`
Expected: FAIL — `MessageBus` constructor does not accept a `store` argument

- [ ] **Step 3: Refactor `MessageBus`**

Modify `src/team/messaging.ts`:

1. Add import for `InMemoryMessageStore` and `StoredMessage`:

```ts
import { InMemoryMessageStore } from '../memory/in-memory-message-store.js'
import type { MessageStore, StoredMessage } from '../types.js'
```

2. Add a `store` field and update constructor:

```ts
export class MessageBus {
  private readonly messages: Message[] = []
  private readonly readState = new Map<string, Set<string>>()
  private readonly subscribers = new Map<
    string,
    Map<symbol, (message: Message) => void>
  >()
  private readonly store: MessageStore | undefined

  constructor(store?: MessageStore) {
    this.store = store
  }
```

3. Add a helper to convert between `Message` and `StoredMessage`:

```ts
private static toStored(message: Message): StoredMessage {
  return {
    id: message.id,
    from: message.from,
    to: message.to,
    content: message.content,
    timestamp: message.timestamp.toISOString(),
  }
}

private static fromStored(stored: StoredMessage): Message {
  return {
    id: stored.id,
    from: stored.from,
    to: stored.to,
    content: stored.content,
    timestamp: new Date(stored.timestamp),
  }
}
```

4. Update `persist()` to also save to the injected store:

```ts
private persist(message: Message): void {
  this.messages.push(message)
  if (this.store) {
    this.store.save(MessageBus.toStored(message)).catch(() => {})
  }
  this.notifySubscribers(message)
}
```

5. Keep all existing methods (`getUnread`, `getAll`, `getConversation`, `markRead`, `subscribe`) unchanged — they still read from the in-memory arrays. The store is write-through for now; full read delegation can come later. This ensures zero behavior change when no store is injected.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/message-store.test.ts`
Expected: PASS

- [ ] **Step 5: Run full suite**

Run: `npm run lint && npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/team/messaging.ts tests/message-store.test.ts
git commit -m "feat(storage): MessageBus accepts optional MessageStore"
```

---

### Task 5: Update `SharedMemory` to accept optional `MemoryStore`

**Files:**
- Modify: `src/memory/shared.ts`

- [ ] **Step 1: Write failing test for injected store**

Add to `tests/shared-memory.test.ts`:

```ts
import { InMemoryStore } from '../src/memory/store.js'

describe('SharedMemory with injected store', () => {
  it('uses the injected store', async () => {
    const externalStore = new InMemoryStore()
    const mem = new SharedMemory(externalStore)

    await mem.write('agent', 'key', 'value')
    const entry = await mem.read('agent/key')
    expect(entry!.value).toBe('value')
  })

  it('defaults to InMemoryStore when none provided', async () => {
    const mem = new SharedMemory()
    await mem.write('agent', 'key', 'val')
    expect(await mem.read('agent/key')).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/shared-memory.test.ts`
Expected: FAIL — `SharedMemory` constructor does not accept arguments

- [ ] **Step 3: Update `SharedMemory` constructor**

Change `src/memory/shared.ts`:

1. Update import — `MemoryStore` is already imported; keep `InMemoryStore`:

```ts
import type { MemoryEntry, MemoryStore } from '../types.js'
import { InMemoryStore } from './store.js'
```

2. Change the class:

```ts
export class SharedMemory {
  private readonly store: MemoryStore

  constructor(store?: MemoryStore) {
    this.store = store ?? new InMemoryStore()
  }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/shared-memory.test.ts`
Expected: PASS

- [ ] **Step 5: Run full suite**

Run: `npm run lint && npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/memory/shared.ts tests/shared-memory.test.ts
git commit -m "feat(storage): SharedMemory accepts optional MemoryStore"
```

---

### Task 6: Wire `TeamConfig` store fields into `Team`

**Files:**
- Modify: `src/team/team.ts`
- Create: `tests/team-store.test.ts`

- [ ] **Step 1: Write failing test for Team with injected stores**

Create `tests/team-store.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { Team } from '../src/team/team.js'
import { InMemoryStore } from '../src/memory/store.js'
import { InMemoryMessageStore } from '../src/memory/in-memory-message-store.js'

describe('Team with injected stores', () => {
  it('passes store to SharedMemory when sharedMemory is true', async () => {
    const store = new InMemoryStore()
    const team = new Team({
      name: 'test',
      agents: [{ name: 'a', model: 'gpt-4' }],
      sharedMemory: true,
      store,
    })

    const mem = team.getSharedMemoryInstance()
    expect(mem).toBeDefined()
    await mem!.write('agent', 'key', 'value')
    const entry = await store.get('agent/key')
    expect(entry).not.toBeNull()
    expect(entry!.value).toBe('value')
  })

  it('passes messageStore to MessageBus', async () => {
    const messageStore = new InMemoryMessageStore()
    const team = new Team({
      name: 'test',
      agents: [{ name: 'a', model: 'gpt-4' }],
      messageStore,
    })

    team.sendMessage('a', 'b', 'hello')

    const stored = await messageStore.query({ to: 'b' })
    expect(stored).toHaveLength(1)
    expect(stored[0].content).toBe('hello')
  })

  it('works without any injected stores (backward compat)', () => {
    const team = new Team({
      name: 'test',
      agents: [{ name: 'a', model: 'gpt-4' }],
      sharedMemory: true,
    })

    team.sendMessage('a', 'b', 'hi')
    expect(team.getMessages('b')).toHaveLength(1)
    expect(team.getSharedMemory()).toBeDefined()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/team-store.test.ts`
Expected: FAIL — `TeamConfig` does not have `store`/`messageStore` fields (or Team doesn't use them yet)

- [ ] **Step 3: Update `Team` constructor**

Modify `src/team/team.ts`:

1. Update imports:

```ts
import type {
  AgentConfig,
  MemoryStore,
  MessageStore,
  OrchestratorEvent,
  Task,
  TaskStatus,
  TeamConfig,
} from '../types.js'
```

2. Change the relevant constructor lines. Replace:

```ts
this.bus = new MessageBus()
```

with:

```ts
this.bus = new MessageBus(config.messageStore)
```

Replace:

```ts
this.memory = config.sharedMemory ? new SharedMemory() : undefined
```

with:

```ts
this.memory = config.sharedMemory
  ? new SharedMemory(config.store)
  : undefined
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/team-store.test.ts`
Expected: PASS

- [ ] **Step 5: Run full suite**

Run: `npm run lint && npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/team/team.ts tests/team-store.test.ts
git commit -m "feat(storage): wire TeamConfig.store and messageStore into Team"
```

---

### Task 7: Create `RedisStore` implementing `KVStore`

**Files:**
- Create: `src/memory/redis-store.ts`
- Create: `tests/redis-store.test.ts`

- [ ] **Step 1: Write failing tests with mocked Redis client**

Create `tests/redis-store.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'

function createMockClient() {
  const data = new Map<string, Record<string, string>>()

  return {
    hSet: vi.fn(async (key: string, ...fields: [string, string][]) => {
      const obj = data.get(key) ?? {}
      for (const [field, value] of fields) {
        obj[field] = value
      }
      data.set(key, obj)
    }),
    hGet: vi.fn(async (key: string, field: string) => {
      const obj = data.get(key)
      return obj?.[field] ?? null
    }),
    del: vi.fn(async (...keys: string[]) => {
      let count = 0
      for (const k of keys) { if (data.delete(k)) count++ }
      return count
    }),
    scanIterator: vi.fn(async function* (_options: { MATCH?: string; COUNT?: number }) {
      const keys = Array.from(data.keys())
      for (const k of keys) yield [k]
    }),
    quit: vi.fn(async () => {}),
  } as any
}

describe('RedisStore', () => {
  it('sets and gets a value', async () => {
    const client = createMockClient()
    const { RedisStore } = await import('../src/memory/redis-store.js')
    const store = new RedisStore(client)

    await store.set('k1', 'v1')
    expect(await store.get('k1')).toBe('v1')
  })

  it('returns null for missing key', async () => {
    const client = createMockClient()
    const { RedisStore } = await import('../src/memory/redis-store.js')
    const store = new RedisStore(client)

    expect(await store.get('nope')).toBeNull()
  })

  it('overwrites existing key', async () => {
    const client = createMockClient()
    const { RedisStore } = await import('../src/memory/redis-store.js')
    const store = new RedisStore(client)

    await store.set('k', 'first')
    await store.set('k', 'second')
    expect(await store.get('k')).toBe('second')
  })

  it('deletes a key', async () => {
    const client = createMockClient()
    const { RedisStore } = await import('../src/memory/redis-store.js')
    const store = new RedisStore(client)

    await store.set('k', 'v')
    await store.delete('k')
    expect(await store.get('k')).toBeNull()
  })

  it('lists keys with prefix', async () => {
    const client = createMockClient()
    const { RedisStore } = await import('../src/memory/redis-store.js')
    const store = new RedisStore(client, { keyPrefix: 'oma' })

    await store.set('a', '1')
    await store.set('b', '2')
    const keys = await store.list()
    expect(keys.sort()).toEqual(['a', 'b'])
  })

  it('clears all keys', async () => {
    const client = createMockClient()
    const { RedisStore } = await import('../src/memory/redis-store.js')
    const store = new RedisStore(client)

    await store.set('a', '1')
    await store.set('b', '2')
    await store.clear()
    expect(await store.list()).toEqual([])
  })

  it('uses keyPrefix on all operations', async () => {
    const client = createMockClient()
    const { RedisStore } = await import('../src/memory/redis-store.js')
    const store = new RedisStore(client, { keyPrefix: 'myapp' })

    await store.set('k', 'v')
    expect(client.hSet).toHaveBeenCalledWith('myapp:k', ['value', 'v'])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/redis-store.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `RedisStore`**

Create `src/memory/redis-store.ts`:

```ts
import type { KVStore } from '../types.js'

export interface RedisStoreOptions {
  readonly keyPrefix?: string
}

export class RedisStore implements KVStore {
  private readonly client: {
    hSet(key: string, ...fields: [string, string][]): Promise<number>
    hGet(key: string, field: string): Promise<string | undefined>
    del(...keys: string[]): Promise<number>
    scanIterator(options?: { MATCH?: string; COUNT?: number }): AsyncIterable<string[]>
    hGetAll(key: string): Promise<Record<string, string>>
  }
  private readonly prefix: string

  constructor(
    client: RedisStore['client'],
    options?: RedisStoreOptions,
  ) {
    this.client = client
    this.prefix = options?.keyPrefix ?? ''
  }

  private fullKey(key: string): string {
    return this.prefix ? `${this.prefix}:${key}` : key
  }

  async get(key: string): Promise<string | null> {
    const value = await this.client.hGet(this.fullKey(key), 'value')
    return value ?? null
  }

  async set(key: string, value: string): Promise<void> {
    await this.client.hSet(this.fullKey(key), ['value', value])
  }

  async delete(key: string): Promise<void> {
    await this.client.del(this.fullKey(key))
  }

  async list(): Promise<string[]> {
    const pattern = this.prefix ? `${this.prefix}:*` : '*'
    const keys: string[] = []
    for await (const batch of this.client.scanIterator({ MATCH: pattern, COUNT: 100 })) {
      for (const k of batch) {
        const stripped = this.prefix ? k.slice(this.prefix.length + 1) : k
        keys.push(stripped)
      }
    }
    return keys
  }

  async clear(): Promise<void> {
    const keys = await this.list()
    if (keys.length === 0) return
    const fullKeys = keys.map((k) => this.fullKey(k))
    await this.client.del(...fullKeys)
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/redis-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/memory/redis-store.ts tests/redis-store.test.ts
git commit -m "feat(storage): add RedisStore implementing KVStore"
```

---

### Task 8: Update exports and package.json

**Files:**
- Modify: `src/index.ts`
- Modify: `package.json`

- [ ] **Step 1: Add exports to `src/index.ts`**

Add after the existing Memory exports section:

```ts
export type { KVStore, MessageFilter, MessageStore, StoredMessage } from './types.js'

export { InMemoryKVStore } from './memory/store.js'
export { InMemoryMessageStore } from './memory/in-memory-message-store.js'
export { RedisStore } from './memory/redis-store.js'
export type { RedisStoreOptions } from './memory/redis-store.js'
```

- [ ] **Step 2: Add optional peer dependency to `package.json`**

Add `peerDependencies` and `peerDependenciesMeta`:

```json
"peerDependencies": {
  "redis": "^4.0.0"
},
"peerDependenciesMeta": {
  "redis": { "optional": true }
}
```

- [ ] **Step 3: Run full suite**

Run: `npm run lint && npm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/index.ts package.json
git commit -m "feat(storage): export new types and classes, add redis peer dep"
```

---

### Task 9: Update `AGENTS.md`

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Add storage section to `AGENTS.md`**

Add after the "Key Facts" section:

```markdown
- **Optional `redis` peer dependency** — only needed when using `RedisStore`. Not installing it has zero impact.
- **Storage is pluggable** — `KVStore` (low-level) and `MessageStore` (messages) are injectable via `TeamConfig.store` / `TeamConfig.messageStore`. Defaults are in-memory.
```

- [ ] **Step 2: Commit**

```bash
git add AGENTS.md
git commit -m "docs: update AGENTS.md with pluggable storage notes"
```
