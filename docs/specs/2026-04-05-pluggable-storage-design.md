# Pluggable Storage: KVStore, MessageStore, and Redis Implementation

## Motivation

All state (shared memory, messages) currently lives in-process with no persistence. Users running multi-agent workflows that span restarts or need audit trails have no way to recover state. This design adds a storage abstraction layer so any backend (Redis, SQLite, etc.) can be plugged in without framework code changes.

## Design Principles

- **Interface-first**: abstract interfaces in `src/types.ts`, concrete implementations in `src/memory/`
- **Zero breaking changes**: all new constructor parameters are optional with backward-compatible defaults
- **Dependency injection**: callers own backend client lifecycle; framework never creates connections
- **`redis` as optional peer dependency**: core package stays lightweight; `redis` is only needed when using `RedisStore`

## New Interfaces

### KVStore (`src/types.ts`)

Low-level key-value primitive. Every higher-level store is built on top of or alongside this.

```ts
export interface KVStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  list(): Promise<string[]>
  clear(): Promise<void>
}
```

### MessageStore (`src/types.ts`)

Abstracts message persistence and read-state tracking, extracted from the current `MessageBus` internals.

```ts
export interface MessageFilter {
  to?: string
  from?: string
  conversationWith?: string
}

export interface MessageStore {
  save(message: Message): Promise<void>
  get(messageId: string): Promise<Message | null>
  query(filter: MessageFilter): Promise<Message[]>
  markRead(agentName: string, messageIds: string[]): Promise<void>
  getUnreadIds(agentName: string): Promise<Set<string>>
}
```

## Refactored Components

### InMemoryKVStore (`src/memory/store.ts`)

New class implementing `KVStore` using a plain `Map<string, string>`. This is the simplest possible implementation — no metadata, no timestamps, just raw strings.

The existing `InMemoryStore` (which implements `MemoryStore`) is refactored to wrap a `KVStore` internally. For each entry it stores:
- `<key>` → the entry's value string
- `__meta:<key>` → JSON `{ metadata, createdAt }` (only when metadata exists; createdAt is always stored)

### InMemoryMessageStore (`src/memory/in-memory-message-store.ts`)

Extracts the `messages[]` array and `readState` Map from `MessageBus` into a standalone class implementing `MessageStore`. Logic is identical to current behavior — just relocated.

### MessageBus (`src/team/messaging.ts`)

- Constructor gains optional `store?: MessageStore` parameter
- Defaults to `new InMemoryMessageStore()` when not provided
- `send`/`broadcast` call `store.save()` then notify subscribers
- `getUnread`/`getAll`/`getConversation` delegate to store
- `subscribe`/`notifySubscribers` logic unchanged (pub/sub remains in-process)
- All existing public method signatures preserved

### SharedMemory (`src/memory/shared.ts`)

- Constructor gains optional `store?: MemoryStore` parameter
- Defaults to `new InMemoryStore()` when not provided
- Private field type changes from `InMemoryStore` to `MemoryStore`

### TeamConfig (`src/types.ts`)

Two new optional fields:

```ts
export interface TeamConfig {
  // ... existing fields ...
  store?: MemoryStore
  messageStore?: MessageStore
}
```

### Team (`src/team/team.ts`)

- Passes `config.store` to `SharedMemory` constructor (when `sharedMemory: true` and `config.store` is provided)
- Passes `config.messageStore` to `MessageBus` constructor

## New: RedisStore

### `src/memory/redis-store.ts`

Implements `KVStore` backed by Redis. Constructor signature:

```ts
export class RedisStore implements KVStore {
  constructor(client: RedisClientType, options?: { keyPrefix?: string })
}
```

**Storage mapping:**
- `set(key, value)` → Redis `HSET <prefix>:<key> value <value>`
- `get(key)` → Redis `HGET <prefix>:<key> value`
- `delete(key)` → Redis `DEL <prefix>:<key>`
- `list()` → Redis `SCAN` with `MATCH <prefix>:*`
- `clear()` → Redis `SCAN` + `DEL` batch

Uses Redis Hash per key so metadata fields can be added later without migration.

### Dependency

`redis` (node-redis v4+) added to `package.json` as an optional peer dependency:

```json
"peerDependencies": {
  "redis": "^4.0.0"
},
"peerDependenciesMeta": {
  "redis": { "optional": true }
}
```

Import is lazy (`await import('redis')`), same pattern as LLM adapters, so users who don't use `RedisStore` never load the package.

## Exports (`src/index.ts`)

New exports:

```ts
export type { KVStore, MessageStore, MessageFilter } from './types.js'
export { InMemoryMessageStore } from './memory/in-memory-message-store.js'
export { RedisStore } from './memory/redis-store.js'
```

## File Change Summary

| File | Change |
|------|--------|
| `src/types.ts` | Add `KVStore`, `MessageStore`, `MessageFilter`; add `store`/`messageStore` to `TeamConfig` |
| `src/memory/store.ts` | Add `InMemoryKVStore` class; refactor `InMemoryStore` to wrap `KVStore` |
| `src/memory/in-memory-message-store.ts` | New — extract message persistence from `MessageBus` |
| `src/memory/redis-store.ts` | New — `RedisStore implements KVStore` |
| `src/memory/shared.ts` | Accept optional `store` param, widen field type to `MemoryStore` |
| `src/team/messaging.ts` | Accept optional `store` param, delegate persistence |
| `src/team/team.ts` | Wire `config.store` → `SharedMemory`, `config.messageStore` → `MessageBus` |
| `src/index.ts` | Export new types and classes |
| `package.json` | Add `redis` as optional peer dependency |
| `tests/` | New tests for `InMemoryKVStore`, `InMemoryMessageStore`, `RedisStore` (mocked) |

## Usage Examples

### Default (no changes required)

```ts
const team = new Team({ name: 'team', agents: [...], sharedMemory: true })
// Uses InMemoryStore / InMemoryMessageStore — identical to current behavior
```

### Redis-backed shared memory

```ts
import { createClient } from 'redis'
import { RedisStore } from '@jackchen_me/open-multi-agent'

const client = createClient({ url: 'redis://localhost:6379' })
await client.connect()

const kvStore = new RedisStore(client, { keyPrefix: 'myapp' })
const memoryStore = new InMemoryStore(kvStore)  // wraps KVStore
const team = new Team({
  name: 'team',
  agents: [...],
  sharedMemory: true,
  store: memoryStore,
})
```

### Custom KVStore implementation

```ts
import type { KVStore } from '@jackchen_me/open-multi-agent'

class SQLiteStore implements KVStore {
  // ... implement get/set/delete/list/clear against SQLite
}
```

## Out of Scope

- Redis-backed `MessageStore` implementation (users can implement `MessageStore` themselves against Redis or any backend; a built-in one can be added later)
- Migration tooling between store backends
- TTL / expiry on entries
- Encryption at rest
