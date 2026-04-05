import { describe, it, expect } from 'vitest'
import { InMemoryMessageStore } from '../src/memory/in-memory-message-store.js'
import { MessageBus } from '../src/team/messaging.js'

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

describe('MessageBus with injected store', () => {
  it('delegates persistence to injected store', async () => {
    const backingStore = new InMemoryMessageStore()
    const bus = new MessageBus(backingStore)

    bus.send('alice', 'bob', 'hello')

    const stored = await backingStore.query({ to: 'bob' })
    expect(stored).toHaveLength(1)
    expect(stored[0].content).toBe('hello')
  })

  it('defaults to working without store', () => {
    const bus = new MessageBus()
    bus.send('alice', 'bob', 'hi')

    const unread = bus.getUnread('bob')
    expect(unread).toHaveLength(1)
  })

  it('existing getAll/getConversation still work with store', () => {
    const backingStore = new InMemoryMessageStore()
    const bus = new MessageBus(backingStore)
    bus.send('alice', 'bob', 'test')
    bus.send('bob', 'alice', 'reply')

    expect(bus.getAll('bob')).toHaveLength(1)
    expect(bus.getConversation('alice', 'bob')).toHaveLength(2)
  })
})
