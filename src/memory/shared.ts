/**
 * @fileoverview Shared memory layer for teams of cooperating agents.
 *
 * Each agent writes under its own namespace (`<agentName>/<key>`) so entries
 * remain attributable, while any agent may read any entry. The
 * {@link SharedMemory.getSummary} method produces a human-readable digest
 * suitable for injecting into an agent's context window.
 */

import type { MemoryEntry, MemoryStore } from '../types.js'
import { InMemoryStore } from './store.js'

// ---------------------------------------------------------------------------
// Runtime shape check
// ---------------------------------------------------------------------------

const STORE_METHODS = ['get', 'set', 'list', 'delete', 'clear'] as const

/**
 * Returns true when `v` structurally implements {@link MemoryStore}.
 *
 * Used to defend against malformed `sharedMemoryStore` values reaching
 * {@link SharedMemory} (e.g. a plain object deserialized from JSON that
 * cannot actually satisfy the interface at runtime).
 */
function isMemoryStore(v: unknown): v is MemoryStore {
  if (v === null || typeof v !== 'object') return false
  const obj = v as Record<string, unknown>
  return STORE_METHODS.every((m) => typeof obj[m] === 'function')
}

// ---------------------------------------------------------------------------
// SharedMemory
// ---------------------------------------------------------------------------

/**
 * Namespaced shared memory for a team of agents.
 *
 * Writes are namespaced as `<agentName>/<key>` so that entries from different
 * agents never collide and are always attributable. Reads are namespace-aware
 * but also accept fully-qualified keys, making cross-agent reads straightforward.
 *
 * @example
 * ```ts
 * const mem = new SharedMemory()
 *
 * await mem.write('researcher', 'findings', 'TypeScript 5.5 ships const type params')
 * await mem.write('coder', 'plan', 'Implement feature X using const type params')
 *
 * const entry = await mem.read('researcher/findings')
 * const all = await mem.listByAgent('researcher')
 * const summary = await mem.getSummary()
 * ```
 */
export class SharedMemory {
  private readonly store: MemoryStore
  /**
   * Monotonic turn counter used to evaluate per-entry `expiresAtTurn`.
   * Advanced explicitly via {@link advanceTurn}; not bound to any specific
   * unit (the orchestrator drives it once per completed task in `runTeam` /
   * `runTasks`).
   */
  private turnCount = 0

  /**
   * @param store - Optional custom {@link MemoryStore} backing this shared memory.
   *                Defaults to an in-process {@link InMemoryStore}. Custom stores
   *                receive namespaced keys (`<agentName>/<key>`) opaque to them.
   *                Stores that don't implement {@link MemoryStore.setWithExpiry}
   *                still work — `writeExpiring` falls back to plain `set` on
   *                them and the entry never expires.
   *
   * @throws {TypeError} when `store` is provided but does not structurally
   *                     implement {@link MemoryStore} (fails fast on malformed
   *                     values, e.g. plain objects from untrusted JSON config).
   */
  constructor(store?: MemoryStore) {
    if (store !== undefined && !isMemoryStore(store)) {
      throw new TypeError(
        'SharedMemory: `store` must implement the MemoryStore interface ' +
          `(methods: ${STORE_METHODS.join(', ')}).`,
      )
    }
    this.store = store ?? new InMemoryStore()
  }

  // ---------------------------------------------------------------------------
  // Turn counter
  // ---------------------------------------------------------------------------

  /**
   * Advance the turn counter by one. Entries previously written via
   * {@link writeExpiring} with `ttlTurns: N` expire once the counter reaches
   * `(write-time count) + N`.
   *
   * Called by the orchestrator after each completed task in `runTeam` and
   * `runTasks`. Standalone `runAgent` does not advance the counter — there
   * is no team turn boundary in single-agent runs.
   */
  advanceTurn(): void {
    this.turnCount++
  }

  /** Current turn count. Useful for tests and observability. */
  getTurnCount(): number {
    return this.turnCount
  }

  // ---------------------------------------------------------------------------
  // Write
  // ---------------------------------------------------------------------------

  /**
   * Write `value` under the namespaced key `<agentName>/<key>`.
   *
   * Metadata is merged with a `{ agent: agentName }` marker so consumers can
   * identify provenance when iterating all entries.
   *
   * @param agentName - The writing agent's name (used as a namespace prefix).
   * @param key       - Logical key within the agent's namespace.
   * @param value     - String value to store (serialise objects before writing).
   * @param metadata  - Optional extra metadata stored alongside the entry.
   */
  async write(
    agentName: string,
    key: string,
    value: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const namespacedKey = SharedMemory.namespaceKey(agentName, key)
    await this.store.set(namespacedKey, value, {
      ...metadata,
      agent: agentName,
    })
  }

  /**
   * Like {@link write}, but tags the entry with a turn-count expiry so it is
   * automatically dropped from reads once the {@link advanceTurn} counter has
   * advanced `ttlTurns` steps.
   *
   * Backends that don't implement {@link MemoryStore.setWithExpiry} fall back
   * to a plain write — the entry persists indefinitely and `ttlTurns` is
   * effectively ignored. Custom store authors who need TTL must implement
   * the optional method.
   *
   * @param ttlTurns - Number of turns the entry should remain readable for.
   *                   Must be a positive integer; `0` means the entry is
   *                   already expired and won't be returned by reads.
   */
  async writeExpiring(
    agentName: string,
    key: string,
    value: string,
    ttlTurns: number,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const namespacedKey = SharedMemory.namespaceKey(agentName, key)
    const fullMetadata = { ...metadata, agent: agentName }
    if (typeof this.store.setWithExpiry === 'function') {
      const expiresAtTurn = this.turnCount + ttlTurns
      await this.store.setWithExpiry(namespacedKey, value, expiresAtTurn, fullMetadata)
    } else {
      // Custom store doesn't support TTL — degrade to plain set.
      await this.store.set(namespacedKey, value, fullMetadata)
    }
  }

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  /**
   * Read an entry by its fully-qualified key (`<agentName>/<key>`).
   *
   * Returns `null` when the key is absent **or** when the entry has expired
   * (per its `expiresAtTurn` against the current turn counter). Expired
   * entries are deleted from the underlying store as a side effect.
   */
  async read(key: string): Promise<MemoryEntry | null> {
    const entry = await this.store.get(key)
    if (entry === null) return null
    if (this.isExpired(entry)) {
      await this.store.delete(key)
      return null
    }
    return entry
  }

  // ---------------------------------------------------------------------------
  // List
  // ---------------------------------------------------------------------------

  /** Returns every non-expired entry in the shared store, regardless of agent. */
  async listAll(): Promise<MemoryEntry[]> {
    return this.filterExpired(await this.store.list())
  }

  /**
   * Returns all non-expired entries written by `agentName` (i.e. those whose
   * key starts with `<agentName>/`).
   */
  async listByAgent(agentName: string): Promise<MemoryEntry[]> {
    const prefix = SharedMemory.namespaceKey(agentName, '')
    const all = await this.store.list()
    const live = await this.filterExpired(all)
    return live.filter((entry) => entry.key.startsWith(prefix))
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------

  /**
   * Produces a human-readable summary of all entries in the store.
   *
   * The output is structured as a markdown-style block, grouped by agent, and
   * is designed to be prepended to an agent's system prompt or injected as a
   * user turn so the agent has context about what its teammates know.
   *
   * Returns an empty string when the store is empty.
   *
   * @example
   * ```
   * ## Shared Team Memory
   *
   * ### researcher
   * - findings: TypeScript 5.5 ships const type params
   *
   * ### coder
   * - plan: Implement feature X using const type params
   * ```
   */
  async getSummary(filter?: { taskIds?: string[] }): Promise<string> {
    let all = await this.store.list()
    all = await this.filterExpired(all)
    if (filter?.taskIds && filter.taskIds.length > 0) {
      const taskIds = new Set(filter.taskIds)
      all = all.filter((entry) => {
        const slashIdx = entry.key.indexOf('/')
        const localKey = slashIdx === -1 ? entry.key : entry.key.slice(slashIdx + 1)
        if (!localKey.startsWith('task:') || !localKey.endsWith(':result')) return false
        const taskId = localKey.slice('task:'.length, localKey.length - ':result'.length)
        return taskIds.has(taskId)
      })
    }
    if (all.length === 0) return ''

    // Group entries by agent name.
    const byAgent = new Map<string, Array<{ localKey: string; value: string }>>()
    for (const entry of all) {
      const slashIdx = entry.key.indexOf('/')
      const agent = slashIdx === -1 ? '_unknown' : entry.key.slice(0, slashIdx)
      const localKey = slashIdx === -1 ? entry.key : entry.key.slice(slashIdx + 1)

      let group = byAgent.get(agent)
      if (!group) {
        group = []
        byAgent.set(agent, group)
      }
      group.push({ localKey, value: entry.value })
    }

    const lines: string[] = ['## Shared Team Memory', '']
    for (const [agent, entries] of byAgent) {
      lines.push(`### ${agent}`)
      for (const { localKey, value } of entries) {
        // Truncate long values so the summary stays readable in a context window.
        const displayValue =
          value.length > 200 ? `${value.slice(0, 197)}…` : value
        lines.push(`- ${localKey}: ${displayValue}`)
      }
      lines.push('')
    }

    return lines.join('\n').trimEnd()
  }

  // ---------------------------------------------------------------------------
  // Store access
  // ---------------------------------------------------------------------------

  /**
   * Returns the underlying {@link MemoryStore} so callers that only need the
   * raw key-value interface can receive a properly typed reference without
   * accessing private fields via bracket notation.
   */
  getStore(): MemoryStore {
    return this.store
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private static namespaceKey(agentName: string, key: string): string {
    return `${agentName}/${key}`
  }

  /** True when `entry.expiresAtTurn` is set and has been reached. */
  private isExpired(entry: MemoryEntry): boolean {
    return entry.expiresAtTurn !== undefined && this.turnCount >= entry.expiresAtTurn
  }

  /**
   * Drops expired entries from `entries` and deletes them from the store as
   * a side effect. Entries without `expiresAtTurn` are always kept.
   */
  private async filterExpired(entries: MemoryEntry[]): Promise<MemoryEntry[]> {
    const live: MemoryEntry[] = []
    for (const entry of entries) {
      if (this.isExpired(entry)) {
        await this.store.delete(entry.key)
      } else {
        live.push(entry)
      }
    }
    return live
  }
}
