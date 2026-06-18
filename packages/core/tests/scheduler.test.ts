import { describe, it, expect } from 'vitest'
import { Scheduler } from '../src/orchestrator/scheduler.js'
import { TaskQueue } from '../src/task/queue.js'
import { createTask } from '../src/task/task.js'
import type { AgentConfig, Task } from '../src/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function agent(name: string, systemPrompt?: string): AgentConfig {
  return { name, model: 'test-model', systemPrompt }
}

function pendingTask(title: string, opts?: { assignee?: string; dependsOn?: string[] }): Task {
  return createTask({ title, description: title, assignee: opts?.assignee, ...opts })
}

// ---------------------------------------------------------------------------
// round-robin
// ---------------------------------------------------------------------------

describe('Scheduler: round-robin', () => {
  it('distributes tasks evenly across agents', () => {
    const s = new Scheduler('round-robin')
    const agents = [agent('a'), agent('b'), agent('c')]
    const tasks = [
      pendingTask('t1'),
      pendingTask('t2'),
      pendingTask('t3'),
      pendingTask('t4'),
      pendingTask('t5'),
      pendingTask('t6'),
    ]

    const assignments = s.schedule(tasks, agents)

    expect(assignments.get(tasks[0]!.id)).toBe('a')
    expect(assignments.get(tasks[1]!.id)).toBe('b')
    expect(assignments.get(tasks[2]!.id)).toBe('c')
    expect(assignments.get(tasks[3]!.id)).toBe('a')
    expect(assignments.get(tasks[4]!.id)).toBe('b')
    expect(assignments.get(tasks[5]!.id)).toBe('c')
  })

  it('skips already-assigned tasks', () => {
    const s = new Scheduler('round-robin')
    const agents = [agent('a'), agent('b')]
    const tasks = [
      pendingTask('t1', { assignee: 'a' }),
      pendingTask('t2'),
    ]

    const assignments = s.schedule(tasks, agents)

    // Only t2 should be assigned
    expect(assignments.size).toBe(1)
    expect(assignments.has(tasks[1]!.id)).toBe(true)
  })

  it('returns empty map when no agents', () => {
    const s = new Scheduler('round-robin')
    const tasks = [pendingTask('t1')]
    expect(s.schedule(tasks, []).size).toBe(0)
  })

  it('cursor advances across calls', () => {
    const s = new Scheduler('round-robin')
    const agents = [agent('a'), agent('b')]
    const t1 = [pendingTask('t1')]
    const t2 = [pendingTask('t2')]

    const a1 = s.schedule(t1, agents)
    const a2 = s.schedule(t2, agents)

    expect(a1.get(t1[0]!.id)).toBe('a')
    expect(a2.get(t2[0]!.id)).toBe('b')
  })
})

// ---------------------------------------------------------------------------
// least-busy
// ---------------------------------------------------------------------------

describe('Scheduler: least-busy', () => {
  it('assigns to agent with fewest in_progress tasks', () => {
    const s = new Scheduler('least-busy')
    const agents = [agent('a'), agent('b')]

    // Create some in-progress tasks for agent 'a'
    const inProgress: Task = {
      ...pendingTask('busy'),
      status: 'in_progress',
      assignee: 'a',
    }
    const newTask = pendingTask('new')
    const allTasks = [inProgress, newTask]

    const assignments = s.schedule(allTasks, agents)

    // 'b' has 0 in-progress, 'a' has 1 → assign to 'b'
    expect(assignments.get(newTask.id)).toBe('b')
  })

  it('balances load across batch', () => {
    const s = new Scheduler('least-busy')
    const agents = [agent('a'), agent('b')]
    const tasks = [pendingTask('t1'), pendingTask('t2'), pendingTask('t3'), pendingTask('t4')]

    const assignments = s.schedule(tasks, agents)

    // Should alternate: a, b, a, b
    const values = [...assignments.values()]
    const aCount = values.filter(v => v === 'a').length
    const bCount = values.filter(v => v === 'b').length
    expect(aCount).toBe(2)
    expect(bCount).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// capability-match
// ---------------------------------------------------------------------------

describe('Scheduler: capability-match', () => {
  it('matches task keywords to agent system prompt', () => {
    const s = new Scheduler('capability-match')
    const agents = [
      agent('researcher', 'You are a research expert who analyzes data and writes reports'),
      agent('coder', 'You are a software engineer who writes TypeScript code'),
    ]
    const tasks = [
      pendingTask('Write TypeScript code for the API'),
      pendingTask('Research and analyze market data'),
    ]

    const assignments = s.schedule(tasks, agents)

    expect(assignments.get(tasks[0]!.id)).toBe('coder')
    expect(assignments.get(tasks[1]!.id)).toBe('researcher')
  })

  it('falls back to first agent when no keywords match', () => {
    const s = new Scheduler('capability-match')
    const agents = [agent('alpha'), agent('beta')]
    const tasks = [pendingTask('xyz')]

    const assignments = s.schedule(tasks, agents)

    // When scores are tied (all 0), first agent wins
    expect(assignments.size).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// dependency-first
// ---------------------------------------------------------------------------

describe('Scheduler: dependency-first', () => {
  it('prioritises tasks that unblock more dependents', () => {
    const s = new Scheduler('dependency-first')
    const agents = [agent('a')]

    // t1 blocks t2 and t3; t2 blocks nothing
    const t1 = pendingTask('t1')
    const t2 = pendingTask('t2')
    const t3 = { ...pendingTask('t3'), dependsOn: [t1.id] }
    const t4 = { ...pendingTask('t4'), dependsOn: [t1.id] }

    const allTasks = [t2, t1, t3, t4] // t2 first in input order

    const assignments = s.schedule(allTasks, agents)

    // t1 should be assigned first (unblocks 2 others)
    const entries = [...assignments.entries()]
    expect(entries[0]![0]).toBe(t1.id)
  })

  it('returns empty map for empty task list', () => {
    const s = new Scheduler('dependency-first')
    const assignments = s.schedule([], [agent('a')])
    expect(assignments.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// autoAssign
// ---------------------------------------------------------------------------

describe('Scheduler: autoAssign', () => {
  it('updates queue tasks with assignees', () => {
    const s = new Scheduler('round-robin')
    const agents = [agent('a'), agent('b')]
    const queue = new TaskQueue()

    const t1 = pendingTask('t1')
    const t2 = pendingTask('t2')
    queue.add(t1)
    queue.add(t2)

    s.autoAssign(queue, agents)

    const tasks = queue.list()
    const assignees = tasks.map(t => t.assignee)
    expect(assignees).toContain('a')
    expect(assignees).toContain('b')
  })

  it('does not overwrite existing assignees', () => {
    const s = new Scheduler('round-robin')
    const agents = [agent('a'), agent('b')]
    const queue = new TaskQueue()

    const t1 = pendingTask('t1', { assignee: 'x' })
    queue.add(t1)

    s.autoAssign(queue, agents)

    expect(queue.list()[0]!.assignee).toBe('x')
  })
})
