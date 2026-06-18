import { describe, it, expect } from 'vitest'
import {
  createTask,
  isTaskReady,
  getTaskDependencyOrder,
  validateTaskDependencies,
} from '../src/task/task.js'
import type { Task } from '../src/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function task(id: string, opts: { dependsOn?: string[]; status?: Task['status'] } = {}): Task {
  const t = createTask({ title: id, description: `task ${id}` })
  return { ...t, id, dependsOn: opts.dependsOn, status: opts.status ?? 'pending' }
}

// ---------------------------------------------------------------------------
// createTask
// ---------------------------------------------------------------------------

describe('createTask', () => {
  it('creates a task with pending status and timestamps', () => {
    const t = createTask({ title: 'Test', description: 'A test task' })
    expect(t.id).toBeDefined()
    expect(t.status).toBe('pending')
    expect(t.createdAt).toBeInstanceOf(Date)
    expect(t.updatedAt).toBeInstanceOf(Date)
  })

  it('copies dependsOn array (no shared reference)', () => {
    const deps = ['a']
    const t = createTask({ title: 'T', description: 'D', dependsOn: deps })
    deps.push('b')
    expect(t.dependsOn).toEqual(['a'])
  })
})

// ---------------------------------------------------------------------------
// isTaskReady
// ---------------------------------------------------------------------------

describe('isTaskReady', () => {
  it('returns true for a pending task with no dependencies', () => {
    const t = task('a')
    expect(isTaskReady(t, [t])).toBe(true)
  })

  it('returns false for a non-pending task', () => {
    const t = task('a', { status: 'blocked' })
    expect(isTaskReady(t, [t])).toBe(false)
  })

  it('returns true when all dependencies are completed', () => {
    const dep = task('dep', { status: 'completed' })
    const t = task('a', { dependsOn: ['dep'] })
    expect(isTaskReady(t, [dep, t])).toBe(true)
  })

  it('returns false when a dependency is not yet completed', () => {
    const dep = task('dep', { status: 'in_progress' })
    const t = task('a', { dependsOn: ['dep'] })
    expect(isTaskReady(t, [dep, t])).toBe(false)
  })

  it('returns false when a dependency is missing from the task set', () => {
    const t = task('a', { dependsOn: ['ghost'] })
    expect(isTaskReady(t, [t])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// getTaskDependencyOrder
// ---------------------------------------------------------------------------

describe('getTaskDependencyOrder', () => {
  it('returns empty array for empty input', () => {
    expect(getTaskDependencyOrder([])).toEqual([])
  })

  it('returns tasks with no deps first', () => {
    const a = task('a')
    const b = task('b', { dependsOn: ['a'] })
    const ordered = getTaskDependencyOrder([b, a])
    expect(ordered[0].id).toBe('a')
    expect(ordered[1].id).toBe('b')
  })

  it('handles a diamond dependency (a → b,c → d)', () => {
    const a = task('a')
    const b = task('b', { dependsOn: ['a'] })
    const c = task('c', { dependsOn: ['a'] })
    const d = task('d', { dependsOn: ['b', 'c'] })

    const ordered = getTaskDependencyOrder([d, c, b, a])
    const ids = ordered.map((t) => t.id)

    // a must come before b and c; b and c must come before d
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('b'))
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('c'))
    expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('d'))
    expect(ids.indexOf('c')).toBeLessThan(ids.indexOf('d'))
  })

  it('returns partial result when a cycle exists', () => {
    const a = task('a', { dependsOn: ['b'] })
    const b = task('b', { dependsOn: ['a'] })
    const ordered = getTaskDependencyOrder([a, b])
    // Neither can be ordered — result should be empty (or partial)
    expect(ordered.length).toBeLessThan(2)
  })
})

// ---------------------------------------------------------------------------
// validateTaskDependencies
// ---------------------------------------------------------------------------

describe('validateTaskDependencies', () => {
  it('returns valid for tasks with no deps', () => {
    const result = validateTaskDependencies([task('a'), task('b')])
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('detects self-dependency', () => {
    const t = task('a', { dependsOn: ['a'] })
    const result = validateTaskDependencies([t])
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('depends on itself')
  })

  it('detects unknown dependency', () => {
    const t = task('a', { dependsOn: ['ghost'] })
    const result = validateTaskDependencies([t])
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('unknown dependency')
  })

  it('detects a cycle (a → b → a)', () => {
    const a = task('a', { dependsOn: ['b'] })
    const b = task('b', { dependsOn: ['a'] })
    const result = validateTaskDependencies([a, b])
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.toLowerCase().includes('cyclic'))).toBe(true)
  })

  it('detects a longer cycle (a → b → c → a)', () => {
    const a = task('a', { dependsOn: ['c'] })
    const b = task('b', { dependsOn: ['a'] })
    const c = task('c', { dependsOn: ['b'] })
    const result = validateTaskDependencies([a, b, c])
    expect(result.valid).toBe(false)
  })
})
