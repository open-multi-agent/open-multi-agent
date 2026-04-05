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
