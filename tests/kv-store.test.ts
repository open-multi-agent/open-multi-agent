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
