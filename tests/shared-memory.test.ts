import { describe, it, expect } from 'vitest'
import { SharedMemory } from '../src/memory/shared.js'
import { Team } from '../src/team/team.js'
import type { MemoryEntry, MemoryStore } from '../src/types.js'

describe('SharedMemory', () => {
  // -------------------------------------------------------------------------
  // Write & read
  // -------------------------------------------------------------------------

  it('writes and reads a value under a namespaced key', async () => {
    const mem = new SharedMemory()
    await mem.write('researcher', 'findings', 'TS 5.5 ships const type params')

    const entry = await mem.read('researcher/findings')
    expect(entry).not.toBeNull()
    expect(entry!.value).toBe('TS 5.5 ships const type params')
  })

  it('returns null for a non-existent key', async () => {
    const mem = new SharedMemory()
    expect(await mem.read('nope/nothing')).toBeNull()
  })

  // -------------------------------------------------------------------------
  // Namespace isolation
  // -------------------------------------------------------------------------

  it('isolates writes between agents', async () => {
    const mem = new SharedMemory()
    await mem.write('alice', 'plan', 'plan A')
    await mem.write('bob', 'plan', 'plan B')

    const alice = await mem.read('alice/plan')
    const bob = await mem.read('bob/plan')
    expect(alice!.value).toBe('plan A')
    expect(bob!.value).toBe('plan B')
  })

  it('listByAgent returns only that agent\'s entries', async () => {
    const mem = new SharedMemory()
    await mem.write('alice', 'a1', 'v1')
    await mem.write('alice', 'a2', 'v2')
    await mem.write('bob', 'b1', 'v3')

    const aliceEntries = await mem.listByAgent('alice')
    expect(aliceEntries).toHaveLength(2)
    expect(aliceEntries.every((e) => e.key.startsWith('alice/'))).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Overwrite
  // -------------------------------------------------------------------------

  it('overwrites a value and preserves createdAt', async () => {
    const mem = new SharedMemory()
    await mem.write('agent', 'key', 'first')
    const first = await mem.read('agent/key')

    await mem.write('agent', 'key', 'second')
    const second = await mem.read('agent/key')

    expect(second!.value).toBe('second')
    expect(second!.createdAt.getTime()).toBe(first!.createdAt.getTime())
  })

  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------

  it('stores metadata alongside the value', async () => {
    const mem = new SharedMemory()
    await mem.write('agent', 'key', 'val', { priority: 'high' })

    const entry = await mem.read('agent/key')
    expect(entry!.metadata).toMatchObject({ priority: 'high', agent: 'agent' })
  })

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------

  it('returns empty string for an empty store', async () => {
    const mem = new SharedMemory()
    expect(await mem.getSummary()).toBe('')
  })

  it('produces a markdown summary grouped by agent', async () => {
    const mem = new SharedMemory()
    await mem.write('researcher', 'findings', 'result A')
    await mem.write('coder', 'plan', 'implement X')

    const summary = await mem.getSummary()
    expect(summary).toContain('## Shared Team Memory')
    expect(summary).toContain('### researcher')
    expect(summary).toContain('### coder')
    expect(summary).toContain('findings: result A')
    expect(summary).toContain('plan: implement X')
  })

  it('truncates long values in the summary', async () => {
    const mem = new SharedMemory()
    const longValue = 'x'.repeat(300)
    await mem.write('agent', 'big', longValue)

    const summary = await mem.getSummary()
    // Summary truncates at 200 chars → 197 + '…'
    expect(summary.length).toBeLessThan(longValue.length)
    expect(summary).toContain('…')
  })

  it('filters summary to only requested task IDs', async () => {
    const mem = new SharedMemory()
    await mem.write('alice', 'task:t1:result', 'output 1')
    await mem.write('bob', 'task:t2:result', 'output 2')
    await mem.write('alice', 'notes', 'not a task result')

    const summary = await mem.getSummary({ taskIds: ['t2'] })
    expect(summary).toContain('### bob')
    expect(summary).toContain('task:t2:result: output 2')
    expect(summary).not.toContain('task:t1:result: output 1')
    expect(summary).not.toContain('notes: not a task result')
  })

  // -------------------------------------------------------------------------
  // listAll
  // -------------------------------------------------------------------------

  it('listAll returns entries from all agents', async () => {
    const mem = new SharedMemory()
    await mem.write('a', 'k1', 'v1')
    await mem.write('b', 'k2', 'v2')

    const all = await mem.listAll()
    expect(all).toHaveLength(2)
  })

  // -------------------------------------------------------------------------
  // Custom MemoryStore injection (issue #156)
  // -------------------------------------------------------------------------

  describe('custom MemoryStore injection', () => {
    /** Recording store that forwards to an internal map and tracks every call. */
    class RecordingStore implements MemoryStore {
      readonly data = new Map<string, MemoryEntry>()
      readonly setCalls: Array<{ key: string; value: string }> = []

      async get(key: string): Promise<MemoryEntry | null> {
        return this.data.get(key) ?? null
      }
      async set(
        key: string,
        value: string,
        metadata?: Record<string, unknown>,
      ): Promise<void> {
        this.setCalls.push({ key, value })
        this.data.set(key, { key, value, metadata, createdAt: new Date() })
      }
      async list(): Promise<MemoryEntry[]> {
        return Array.from(this.data.values())
      }
      async delete(key: string): Promise<void> {
        this.data.delete(key)
      }
      async clear(): Promise<void> {
        this.data.clear()
      }
    }

    it('routes writes through an injected MemoryStore', async () => {
      const store = new RecordingStore()
      const mem = new SharedMemory(store)
      await mem.write('alice', 'plan', 'v1')

      expect(store.setCalls).toEqual([{ key: 'alice/plan', value: 'v1' }])
    })

    it('preserves `<agent>/<key>` namespace prefix on the underlying store', async () => {
      const store = new RecordingStore()
      const mem = new SharedMemory(store)
      await mem.write('bob', 'notes', 'hello')

      const entry = await store.get('bob/notes')
      expect(entry?.value).toBe('hello')
    })

    it('getSummary reads from the injected store', async () => {
      const store = new RecordingStore()
      const mem = new SharedMemory(store)
      await mem.write('alice', 'k', 'val')

      const summary = await mem.getSummary()
      expect(summary).toContain('### alice')
      expect(summary).toContain('k: val')
    })

    it('getStore returns the injected store', () => {
      const store = new RecordingStore()
      const mem = new SharedMemory(store)
      expect(mem.getStore()).toBe(store)
    })

    it('Team wires `sharedMemoryStore` into its SharedMemory', async () => {
      const store = new RecordingStore()
      const team = new Team({
        name: 'injection-team',
        agents: [{ name: 'alice', model: 'claude-sonnet-4-6' }],
        sharedMemoryStore: store,
      })

      const sharedMem = team.getSharedMemoryInstance()
      expect(sharedMem).toBeDefined()
      await sharedMem!.write('alice', 'fact', 'committed')

      expect(store.setCalls).toEqual([{ key: 'alice/fact', value: 'committed' }])
    })

    it('Team: `sharedMemoryStore` takes precedence over `sharedMemory: false`', () => {
      const store = new RecordingStore()
      const team = new Team({
        name: 'override-team',
        agents: [{ name: 'alice', model: 'claude-sonnet-4-6' }],
        sharedMemory: false,
        sharedMemoryStore: store,
      })

      // Custom store wins: memory is enabled even though the boolean is false.
      expect(team.getSharedMemoryInstance()).toBeDefined()
      expect(team.getSharedMemory()).toBe(store)
    })

    it('Team: neither flag → no shared memory (backward compat)', () => {
      const team = new Team({
        name: 'no-memory-team',
        agents: [{ name: 'alice', model: 'claude-sonnet-4-6' }],
      })
      expect(team.getSharedMemoryInstance()).toBeUndefined()
    })

    it('Team: `sharedMemory: true` only → default InMemoryStore (backward compat)', () => {
      const team = new Team({
        name: 'default-memory-team',
        agents: [{ name: 'alice', model: 'claude-sonnet-4-6' }],
        sharedMemory: true,
      })
      expect(team.getSharedMemoryInstance()).toBeDefined()
      expect(team.getSharedMemory()).toBeDefined()
    })

    // -----------------------------------------------------------------------
    // Shape validation — defends against malformed `sharedMemoryStore`
    // (e.g. plain objects from untrusted JSON) reaching SharedMemory.
    // -----------------------------------------------------------------------

    it('SharedMemory throws when store is a plain object missing methods', () => {
      const plain = { foo: 'bar' } as unknown as MemoryStore
      expect(() => new SharedMemory(plain)).toThrow(TypeError)
      expect(() => new SharedMemory(plain)).toThrow(/MemoryStore interface/)
    })

    it('SharedMemory throws when store is missing a single method', () => {
      const partial = {
        get: async () => null,
        set: async () => undefined,
        list: async () => [],
        delete: async () => undefined,
        // `clear` missing
      } as unknown as MemoryStore
      expect(() => new SharedMemory(partial)).toThrow(TypeError)
    })

    it('SharedMemory throws when store is null (cast)', () => {
      expect(() => new SharedMemory(null as unknown as MemoryStore)).toThrow(TypeError)
    })

    it('Team throws early on malformed `sharedMemoryStore`', () => {
      const bogus = { not: 'a store' } as unknown as MemoryStore
      expect(
        () =>
          new Team({
            name: 'bad-team',
            agents: [{ name: 'alice', model: 'claude-sonnet-4-6' }],
            sharedMemoryStore: bogus,
          }),
      ).toThrow(TypeError)
    })

    it('Team throws on falsy-but-present sharedMemoryStore (null)', () => {
      // `null` is falsy but present; a truthy gate would silently drop it.
      // The `!== undefined` gate routes it through SharedMemory's shape check
      // so config bugs fail fast instead of being silently downgraded.
      expect(
        () =>
          new Team({
            name: 'null-store-team',
            agents: [{ name: 'alice', model: 'claude-sonnet-4-6' }],
            sharedMemoryStore: null as unknown as MemoryStore,
          }),
      ).toThrow(TypeError)
    })

    it('Team: omitting sharedMemoryStore entirely still honors sharedMemory: true', () => {
      // Sanity check that the `!== undefined` gate does not accidentally
      // enable memory when the field is absent.
      const team = new Team({
        name: 'absent-store-team',
        agents: [{ name: 'alice', model: 'claude-sonnet-4-6' }],
        sharedMemory: true,
      })
      expect(team.getSharedMemoryInstance()).toBeDefined()
    })
  })
})
