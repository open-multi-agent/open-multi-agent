import { describe, it, expect, vi } from 'vitest'
import { TaskQueue } from '../src/task/queue.js'
import { createTask } from '../src/task/task.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a simple task with a predictable id. */
function task(id: string, opts: { dependsOn?: string[]; assignee?: string } = {}) {
  const t = createTask({ title: id, description: `task ${id}`, assignee: opts.assignee })
  // Override the random UUID so tests can reference tasks by name.
  return { ...t, id, dependsOn: opts.dependsOn } as ReturnType<typeof createTask>
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TaskQueue', () => {
  // -------------------------------------------------------------------------
  // Basic add & query
  // -------------------------------------------------------------------------

  it('adds a task and lists it', () => {
    const q = new TaskQueue()
    q.add(task('a'))
    expect(q.list()).toHaveLength(1)
    expect(q.list()[0].id).toBe('a')
    expect(q.get('a')?.title).toBe('a')
  })

  it('fires task:ready for a task with no dependencies', () => {
    const q = new TaskQueue()
    const handler = vi.fn()
    q.on('task:ready', handler)

    q.add(task('a'))
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0].id).toBe('a')
  })

  it('blocks a task whose dependency is not yet completed', () => {
    const q = new TaskQueue()
    q.add(task('a'))
    q.add(task('b', { dependsOn: ['a'] }))

    const b = q.list().find((t) => t.id === 'b')!
    expect(b.status).toBe('blocked')
  })

  // -------------------------------------------------------------------------
  // Dependency resolution
  // -------------------------------------------------------------------------

  it('unblocks a dependent task when its dependency completes', () => {
    const q = new TaskQueue()
    const readyHandler = vi.fn()
    q.on('task:ready', readyHandler)

    q.add(task('a'))
    q.add(task('b', { dependsOn: ['a'] }))

    // 'a' fires task:ready, 'b' is blocked
    expect(readyHandler).toHaveBeenCalledTimes(1)

    q.complete('a', 'done')

    // 'b' should now be unblocked → fires task:ready
    expect(readyHandler).toHaveBeenCalledTimes(2)
    expect(readyHandler.mock.calls[1][0].id).toBe('b')
    expect(q.list().find((t) => t.id === 'b')!.status).toBe('pending')
  })

  it('keeps a task blocked until ALL dependencies complete', () => {
    const q = new TaskQueue()
    q.add(task('a'))
    q.add(task('b'))
    q.add(task('c', { dependsOn: ['a', 'b'] }))

    q.complete('a')

    const cAfterA = q.list().find((t) => t.id === 'c')!
    expect(cAfterA.status).toBe('blocked')

    q.complete('b')

    const cAfterB = q.list().find((t) => t.id === 'c')!
    expect(cAfterB.status).toBe('pending')
  })

  // -------------------------------------------------------------------------
  // Cascade failure
  // -------------------------------------------------------------------------

  it('cascades failure to direct dependents', () => {
    const q = new TaskQueue()
    const failHandler = vi.fn()
    q.on('task:failed', failHandler)

    q.add(task('a'))
    q.add(task('b', { dependsOn: ['a'] }))

    q.fail('a', 'boom')

    expect(failHandler).toHaveBeenCalledTimes(2) // a + b
    expect(q.list().find((t) => t.id === 'b')!.status).toBe('failed')
    expect(q.list().find((t) => t.id === 'b')!.result).toContain('dependency')
  })

  it('cascades failure transitively (a → b → c)', () => {
    const q = new TaskQueue()
    q.add(task('a'))
    q.add(task('b', { dependsOn: ['a'] }))
    q.add(task('c', { dependsOn: ['b'] }))

    q.fail('a', 'boom')

    expect(q.list().every((t) => t.status === 'failed')).toBe(true)
  })

  it('does not cascade failure to independent tasks', () => {
    const q = new TaskQueue()
    q.add(task('a'))
    q.add(task('b'))
    q.add(task('c', { dependsOn: ['a'] }))

    q.fail('a', 'boom')

    expect(q.list().find((t) => t.id === 'b')!.status).toBe('pending')
    expect(q.list().find((t) => t.id === 'c')!.status).toBe('failed')
  })

  // -------------------------------------------------------------------------
  // Completion
  // -------------------------------------------------------------------------

  it('fires all:complete when every task reaches a terminal state', () => {
    const q = new TaskQueue()
    const allComplete = vi.fn()
    q.on('all:complete', allComplete)

    q.add(task('a'))
    q.add(task('b'))

    q.complete('a')
    expect(allComplete).not.toHaveBeenCalled()

    q.complete('b')
    expect(allComplete).toHaveBeenCalledTimes(1)
  })

  it('fires all:complete when mix of completed and failed', () => {
    const q = new TaskQueue()
    const allComplete = vi.fn()
    q.on('all:complete', allComplete)

    q.add(task('a'))
    q.add(task('b', { dependsOn: ['a'] }))

    q.fail('a', 'err') // cascades to b
    expect(allComplete).toHaveBeenCalledTimes(1)
  })

  it('isComplete returns true for an empty queue', () => {
    const q = new TaskQueue()
    expect(q.isComplete()).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Query: next / nextAvailable
  // -------------------------------------------------------------------------

  it('next() returns a pending task for the given assignee', () => {
    const q = new TaskQueue()
    q.add(task('a', { assignee: 'alice' }))
    q.add(task('b', { assignee: 'bob' }))

    expect(q.next('bob')?.id).toBe('b')
  })

  it('next() returns undefined when no pending task matches', () => {
    const q = new TaskQueue()
    q.add(task('a', { assignee: 'alice' }))
    expect(q.next('bob')).toBeUndefined()
  })

  it('nextAvailable() prefers unassigned tasks', () => {
    const q = new TaskQueue()
    q.add(task('assigned', { assignee: 'alice' }))
    q.add(task('unassigned'))

    expect(q.nextAvailable()?.id).toBe('unassigned')
  })

  // -------------------------------------------------------------------------
  // Progress
  // -------------------------------------------------------------------------

  it('getProgress() returns correct counts', () => {
    const q = new TaskQueue()
    q.add(task('a'))
    q.add(task('b'))
    q.add(task('c', { dependsOn: ['a'] }))

    q.complete('a')

    const p = q.getProgress()
    expect(p.total).toBe(3)
    expect(p.completed).toBe(1)
    expect(p.pending).toBe(2) // b + c (unblocked)
    expect(p.blocked).toBe(0)
  })

  // -------------------------------------------------------------------------
  // Event unsubscribe
  // -------------------------------------------------------------------------

  it('unsubscribe stops receiving events', () => {
    const q = new TaskQueue()
    const handler = vi.fn()
    const off = q.on('task:ready', handler)

    q.add(task('a'))
    expect(handler).toHaveBeenCalledTimes(1)

    off()
    q.add(task('b'))
    expect(handler).toHaveBeenCalledTimes(1) // no new call
  })

  // -------------------------------------------------------------------------
  // Error cases
  // -------------------------------------------------------------------------

  it('throws when completing a non-existent task', () => {
    const q = new TaskQueue()
    expect(() => q.complete('ghost')).toThrow('not found')
  })

  it('throws when failing a non-existent task', () => {
    const q = new TaskQueue()
    expect(() => q.fail('ghost', 'err')).toThrow('not found')
  })
})
