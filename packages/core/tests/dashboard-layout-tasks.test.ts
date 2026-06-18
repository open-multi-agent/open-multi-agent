import { describe, expect, it } from 'vitest'
import { layoutTasks } from '../src/dashboard/layout-tasks.js'

describe('layoutTasks', () => {
  it('assigns increasing columns along a dependency chain (topological levels)', () => {
    const tasks = [
      { id: 'a', dependsOn: [] as const },
      { id: 'b', dependsOn: ['a'] as const },
      { id: 'c', dependsOn: ['b'] as const },
    ]
    const { positions } = layoutTasks(tasks)
    expect(positions.get('a')!.x).toBeLessThan(positions.get('b')!.x)
    expect(positions.get('b')!.x).toBeLessThan(positions.get('c')!.x)
  })

  it('places a merge node after all of its dependencies (diamond)', () => {
    const tasks = [
      { id: 'root', dependsOn: [] as const },
      { id: 'left', dependsOn: ['root'] as const },
      { id: 'right', dependsOn: ['root'] as const },
      { id: 'merge', dependsOn: ['left', 'right'] as const },
    ]
    const { positions } = layoutTasks(tasks)
    const mx = positions.get('merge')!.x
    expect(mx).toBeGreaterThan(positions.get('left')!.x)
    expect(mx).toBeGreaterThan(positions.get('right')!.x)
  })

  it('orders independent roots in the same column with distinct rows', () => {
    const tasks = [
      { id: 'a', dependsOn: [] as const },
      { id: 'b', dependsOn: [] as const },
    ]
    const { positions } = layoutTasks(tasks)
    expect(positions.get('a')!.x).toBe(positions.get('b')!.x)
    expect(positions.get('a')!.y).not.toBe(positions.get('b')!.y)
  })

  it('throws when task dependencies contain a cycle', () => {
    const tasks = [
      { id: 'a', dependsOn: ['b'] as const },
      { id: 'b', dependsOn: ['a'] as const },
    ]
    expect(() => layoutTasks(tasks)).toThrow('Task dependency graph contains a cycle')
  })
})
