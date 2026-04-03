import { describe, it, expect } from 'vitest'
import { SharedMemory } from '../src/memory/shared.js'

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
})
