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

  it('lists keys', async () => {
    const client = createMockClient()
    const { RedisStore } = await import('../src/memory/redis-store.js')
    const store = new RedisStore(client)

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
