import { describe, it, expect, vi } from 'vitest'
import { TaskQueue } from '../src/task/queue.js'
import { createTask } from '../src/task/task.js'
import { OpenMultiAgent } from '../src/orchestrator/orchestrator.js'
import { Agent } from '../src/agent/agent.js'
import { AgentRunner } from '../src/agent/runner.js'
import { ToolRegistry } from '../src/tool/framework.js'
import { ToolExecutor } from '../src/tool/executor.js'
import { AgentPool } from '../src/agent/pool.js'
import type { AgentConfig, LLMAdapter, LLMResponse, Task } from '../src/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function task(id: string, opts: { dependsOn?: string[]; assignee?: string } = {}) {
  const t = createTask({ title: id, description: `task ${id}`, assignee: opts.assignee })
  return { ...t, id, dependsOn: opts.dependsOn } as ReturnType<typeof createTask>
}

function mockAdapter(responseText: string): LLMAdapter {
  return {
    name: 'mock',
    async chat() {
      return {
        id: 'mock-1',
        content: [{ type: 'text' as const, text: responseText }],
        model: 'mock-model',
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 20 },
      } satisfies LLMResponse
    },
    async *stream() {
      /* unused */
    },
  }
}

function buildMockAgent(config: AgentConfig, responseText: string): Agent {
  const registry = new ToolRegistry()
  const executor = new ToolExecutor(registry)
  const agent = new Agent(config, registry, executor)
  const runner = new AgentRunner(mockAdapter(responseText), registry, executor, {
    model: config.model,
    systemPrompt: config.systemPrompt,
    maxTurns: config.maxTurns,
    maxTokens: config.maxTokens,
    temperature: config.temperature,
    agentName: config.name,
  })
  ;(agent as any).runner = runner
  return agent
}

// ---------------------------------------------------------------------------
// TaskQueue: skip / skipRemaining
// ---------------------------------------------------------------------------

describe('TaskQueue — skip', () => {
  it('marks a task as skipped', () => {
    const q = new TaskQueue()
    q.add(task('a'))
    q.skip('a', 'user rejected')
    expect(q.list()[0].status).toBe('skipped')
    expect(q.list()[0].result).toBe('user rejected')
  })

  it('fires task:skipped event with updated task object', () => {
    const q = new TaskQueue()
    const handler = vi.fn()
    q.on('task:skipped', handler)

    q.add(task('a'))
    q.skip('a', 'rejected')

    expect(handler).toHaveBeenCalledTimes(1)
    const emitted = handler.mock.calls[0][0]
    expect(emitted.id).toBe('a')
    expect(emitted.status).toBe('skipped')
    expect(emitted.result).toBe('rejected')
  })

  it('cascades skip to dependent tasks', () => {
    const q = new TaskQueue()
    q.add(task('a'))
    q.add(task('b', { dependsOn: ['a'] }))
    q.add(task('c', { dependsOn: ['b'] }))

    q.skip('a', 'rejected')

    expect(q.list().find((t) => t.id === 'a')!.status).toBe('skipped')
    expect(q.list().find((t) => t.id === 'b')!.status).toBe('skipped')
    expect(q.list().find((t) => t.id === 'c')!.status).toBe('skipped')
  })

  it('does not cascade to independent tasks', () => {
    const q = new TaskQueue()
    q.add(task('a'))
    q.add(task('b'))
    q.add(task('c', { dependsOn: ['a'] }))

    q.skip('a', 'rejected')

    expect(q.list().find((t) => t.id === 'b')!.status).toBe('pending')
    expect(q.list().find((t) => t.id === 'c')!.status).toBe('skipped')
  })

  it('throws when skipping a non-existent task', () => {
    const q = new TaskQueue()
    expect(() => q.skip('nope', 'reason')).toThrow('not found')
  })

  it('isComplete() treats skipped as terminal', () => {
    const q = new TaskQueue()
    q.add(task('a'))
    q.add(task('b'))

    q.complete('a', 'done')
    expect(q.isComplete()).toBe(false)

    q.skip('b', 'rejected')
    expect(q.isComplete()).toBe(true)
  })

  it('getProgress() counts skipped tasks', () => {
    const q = new TaskQueue()
    q.add(task('a'))
    q.add(task('b'))
    q.add(task('c'))

    q.complete('a', 'done')
    q.skip('b', 'rejected')

    const progress = q.getProgress()
    expect(progress.completed).toBe(1)
    expect(progress.skipped).toBe(1)
    expect(progress.pending).toBe(1)
  })
})

describe('TaskQueue — skipRemaining', () => {
  it('marks all non-terminal tasks as skipped', () => {
    const q = new TaskQueue()
    q.add(task('a'))
    q.add(task('b'))
    q.add(task('c', { dependsOn: ['a'] }))

    q.complete('a', 'done')
    q.skipRemaining('approval rejected')

    expect(q.list().find((t) => t.id === 'a')!.status).toBe('completed')
    expect(q.list().find((t) => t.id === 'b')!.status).toBe('skipped')
    expect(q.list().find((t) => t.id === 'c')!.status).toBe('skipped')
  })

  it('leaves failed tasks untouched', () => {
    const q = new TaskQueue()
    q.add(task('a'))
    q.add(task('b'))

    q.fail('a', 'error')
    q.skipRemaining()

    expect(q.list().find((t) => t.id === 'a')!.status).toBe('failed')
    expect(q.list().find((t) => t.id === 'b')!.status).toBe('skipped')
  })

  it('emits task:skipped with the updated task object (not stale)', () => {
    const q = new TaskQueue()
    const handler = vi.fn()
    q.on('task:skipped', handler)

    q.add(task('a'))
    q.add(task('b'))

    q.skipRemaining('reason')

    expect(handler).toHaveBeenCalledTimes(2)
    // Every emitted task must have status 'skipped'
    for (const call of handler.mock.calls) {
      expect(call[0].status).toBe('skipped')
      expect(call[0].result).toBe('reason')
    }
  })

  it('fires all:complete after skipRemaining', () => {
    const q = new TaskQueue()
    const handler = vi.fn()
    q.on('all:complete', handler)

    q.add(task('a'))
    q.add(task('b'))

    q.complete('a', 'done')
    expect(handler).not.toHaveBeenCalled()

    q.skipRemaining()
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Orchestrator: onApproval integration
// ---------------------------------------------------------------------------

describe('onApproval integration', () => {
  function patchPool(orchestrator: OpenMultiAgent, agents: Map<string, Agent>) {
    ;(orchestrator as any).buildPool = () => {
      const pool = new AgentPool(5)
      for (const [, agent] of agents) {
        pool.add(agent)
      }
      return pool
    }
  }

  function setup(onApproval?: (tasks: readonly Task[], next: readonly Task[]) => Promise<boolean>) {
    const agentA: AgentConfig = { name: 'agent-a', model: 'mock', systemPrompt: 'You are agent A.' }
    const agentB: AgentConfig = { name: 'agent-b', model: 'mock', systemPrompt: 'You are agent B.' }

    const orchestrator = new OpenMultiAgent({
      defaultModel: 'mock',
      ...(onApproval ? { onApproval } : {}),
    })

    const team = orchestrator.createTeam('test', {
      name: 'test',
      agents: [agentA, agentB],
    })

    const mockAgents = new Map<string, Agent>()
    mockAgents.set('agent-a', buildMockAgent(agentA, 'result from A'))
    mockAgents.set('agent-b', buildMockAgent(agentB, 'result from B'))
    patchPool(orchestrator, mockAgents)

    return { orchestrator, team }
  }

  it('approve all — all tasks complete normally', async () => {
    const approvalSpy = vi.fn().mockResolvedValue(true)
    const { orchestrator, team } = setup(approvalSpy)

    const result = await orchestrator.runTasks(team, [
      { title: 'task-1', description: 'first', assignee: 'agent-a' },
      { title: 'task-2', description: 'second', assignee: 'agent-b', dependsOn: ['task-1'] },
    ])

    expect(result.success).toBe(true)
    expect(result.agentResults.has('agent-a')).toBe(true)
    expect(result.agentResults.has('agent-b')).toBe(true)
    // onApproval called once (between round 1 and round 2)
    expect(approvalSpy).toHaveBeenCalledTimes(1)
  })

  it('reject mid-pipeline — remaining tasks skipped', async () => {
    const approvalSpy = vi.fn().mockResolvedValue(false)
    const { orchestrator, team } = setup(approvalSpy)

    const result = await orchestrator.runTasks(team, [
      { title: 'task-1', description: 'first', assignee: 'agent-a' },
      { title: 'task-2', description: 'second', assignee: 'agent-b', dependsOn: ['task-1'] },
    ])

    expect(approvalSpy).toHaveBeenCalledTimes(1)
    // Only agent-a's output present (task-2 was skipped, never ran)
    expect(result.agentResults.has('agent-a')).toBe(true)
    expect(result.agentResults.has('agent-b')).toBe(false)
  })

  it('no callback — tasks flow without interruption', async () => {
    const { orchestrator, team } = setup(/* no onApproval */)

    const result = await orchestrator.runTasks(team, [
      { title: 'task-1', description: 'first', assignee: 'agent-a' },
      { title: 'task-2', description: 'second', assignee: 'agent-b', dependsOn: ['task-1'] },
    ])

    expect(result.success).toBe(true)
    expect(result.agentResults.has('agent-a')).toBe(true)
    expect(result.agentResults.has('agent-b')).toBe(true)
  })

  it('callback receives correct arguments — completedTasks array and nextTasks', async () => {
    const approvalSpy = vi.fn().mockResolvedValue(true)
    const { orchestrator, team } = setup(approvalSpy)

    await orchestrator.runTasks(team, [
      { title: 'task-1', description: 'first', assignee: 'agent-a' },
      { title: 'task-2', description: 'second', assignee: 'agent-b', dependsOn: ['task-1'] },
    ])

    // First arg: array of completed tasks from this round
    const completedTasks = approvalSpy.mock.calls[0][0]
    expect(completedTasks).toHaveLength(1)
    expect(completedTasks[0].title).toBe('task-1')
    expect(completedTasks[0].status).toBe('completed')

    // Second arg: the next tasks about to run
    const nextTasks = approvalSpy.mock.calls[0][1]
    expect(nextTasks).toHaveLength(1)
    expect(nextTasks[0].title).toBe('task-2')
  })

  it('callback throwing an error skips remaining tasks gracefully', async () => {
    const approvalSpy = vi.fn().mockRejectedValue(new Error('network timeout'))
    const { orchestrator, team } = setup(approvalSpy)

    // Should not throw — error is caught and remaining tasks are skipped
    const result = await orchestrator.runTasks(team, [
      { title: 'task-1', description: 'first', assignee: 'agent-a' },
      { title: 'task-2', description: 'second', assignee: 'agent-b', dependsOn: ['task-1'] },
    ])

    expect(approvalSpy).toHaveBeenCalledTimes(1)
    expect(result.agentResults.has('agent-a')).toBe(true)
    expect(result.agentResults.has('agent-b')).toBe(false)
  })

  it('parallel batch — completedTasks contains all tasks from the round', async () => {
    const approvalSpy = vi.fn().mockResolvedValue(true)
    const agentA: AgentConfig = { name: 'agent-a', model: 'mock', systemPrompt: 'A' }
    const agentB: AgentConfig = { name: 'agent-b', model: 'mock', systemPrompt: 'B' }
    const agentC: AgentConfig = { name: 'agent-c', model: 'mock', systemPrompt: 'C' }

    const orchestrator = new OpenMultiAgent({
      defaultModel: 'mock',
      onApproval: approvalSpy,
    })

    const team = orchestrator.createTeam('test', {
      name: 'test',
      agents: [agentA, agentB, agentC],
    })

    const mockAgents = new Map<string, Agent>()
    mockAgents.set('agent-a', buildMockAgent(agentA, 'A done'))
    mockAgents.set('agent-b', buildMockAgent(agentB, 'B done'))
    mockAgents.set('agent-c', buildMockAgent(agentC, 'C done'))
    patchPool(orchestrator, mockAgents)

    // task-1 and task-2 are independent (run in parallel), task-3 depends on both
    await orchestrator.runTasks(team, [
      { title: 'task-1', description: 'first', assignee: 'agent-a' },
      { title: 'task-2', description: 'second', assignee: 'agent-b' },
      { title: 'task-3', description: 'third', assignee: 'agent-c', dependsOn: ['task-1', 'task-2'] },
    ])

    // Approval called once between the parallel batch and task-3
    expect(approvalSpy).toHaveBeenCalledTimes(1)
    const completedTasks = approvalSpy.mock.calls[0][0] as Task[]
    // Both task-1 and task-2 completed in the same round
    expect(completedTasks).toHaveLength(2)
    const titles = completedTasks.map((t: Task) => t.title).sort()
    expect(titles).toEqual(['task-1', 'task-2'])
  })

  it('single batch with no second round — callback never fires', async () => {
    const approvalSpy = vi.fn().mockResolvedValue(true)
    const { orchestrator, team } = setup(approvalSpy)

    const result = await orchestrator.runTasks(team, [
      { title: 'task-1', description: 'first', assignee: 'agent-a' },
      { title: 'task-2', description: 'second', assignee: 'agent-b' },
    ])

    expect(result.success).toBe(true)
    // No second round → callback never called
    expect(approvalSpy).not.toHaveBeenCalled()
  })

  it('mixed success/failure in batch — completedTasks only contains succeeded tasks', async () => {
    const approvalSpy = vi.fn().mockResolvedValue(true)
    const agentA: AgentConfig = { name: 'agent-a', model: 'mock', systemPrompt: 'A' }
    const agentB: AgentConfig = { name: 'agent-b', model: 'mock', systemPrompt: 'B' }
    const agentC: AgentConfig = { name: 'agent-c', model: 'mock', systemPrompt: 'C' }

    const orchestrator = new OpenMultiAgent({
      defaultModel: 'mock',
      onApproval: approvalSpy,
    })

    const team = orchestrator.createTeam('test', {
      name: 'test',
      agents: [agentA, agentB, agentC],
    })

    const mockAgents = new Map<string, Agent>()
    mockAgents.set('agent-a', buildMockAgent(agentA, 'A done'))
    mockAgents.set('agent-b', buildMockAgent(agentB, 'B done'))
    mockAgents.set('agent-c', buildMockAgent(agentC, 'C done'))

    // Patch buildPool so that pool.run for agent-b returns a failure result
    ;(orchestrator as any).buildPool = () => {
      const pool = new AgentPool(5)
      for (const [, agent] of mockAgents) pool.add(agent)
      const originalRun = pool.run.bind(pool)
      pool.run = async (agentName: string, prompt: string, opts?: any) => {
        if (agentName === 'agent-b') {
          return {
            success: false,
            output: 'simulated failure',
            messages: [],
            tokenUsage: { input_tokens: 0, output_tokens: 0 },
            toolCalls: [],
          }
        }
        return originalRun(agentName, prompt, opts)
      }
      return pool
    }

    // task-1 (success) and task-2 (fail) run in parallel, task-3 depends on task-1
    await orchestrator.runTasks(team, [
      { title: 'task-1', description: 'first', assignee: 'agent-a' },
      { title: 'task-2', description: 'second', assignee: 'agent-b' },
      { title: 'task-3', description: 'third', assignee: 'agent-c', dependsOn: ['task-1'] },
    ])

    expect(approvalSpy).toHaveBeenCalledTimes(1)
    const completedTasks = approvalSpy.mock.calls[0][0] as Task[]
    // Only task-1 succeeded — task-2 failed, so it should not appear
    expect(completedTasks).toHaveLength(1)
    expect(completedTasks[0].title).toBe('task-1')
    expect(completedTasks[0].status).toBe('completed')
  })

  it('onProgress receives task_skipped events when approval is rejected', async () => {
    const progressSpy = vi.fn()
    const agentA: AgentConfig = { name: 'agent-a', model: 'mock', systemPrompt: 'A' }
    const agentB: AgentConfig = { name: 'agent-b', model: 'mock', systemPrompt: 'B' }

    const orchestrator = new OpenMultiAgent({
      defaultModel: 'mock',
      onApproval: vi.fn().mockResolvedValue(false),
      onProgress: progressSpy,
    })

    const team = orchestrator.createTeam('test', {
      name: 'test',
      agents: [agentA, agentB],
    })

    const mockAgents = new Map<string, Agent>()
    mockAgents.set('agent-a', buildMockAgent(agentA, 'A done'))
    mockAgents.set('agent-b', buildMockAgent(agentB, 'B done'))
    ;(orchestrator as any).buildPool = () => {
      const pool = new AgentPool(5)
      for (const [, agent] of mockAgents) pool.add(agent)
      return pool
    }

    await orchestrator.runTasks(team, [
      { title: 'task-1', description: 'first', assignee: 'agent-a' },
      { title: 'task-2', description: 'second', assignee: 'agent-b', dependsOn: ['task-1'] },
    ])

    const skippedEvents = progressSpy.mock.calls
      .map((c: any) => c[0])
      .filter((e: any) => e.type === 'task_skipped')

    expect(skippedEvents).toHaveLength(1)
    expect(skippedEvents[0].data.status).toBe('skipped')
  })
})
