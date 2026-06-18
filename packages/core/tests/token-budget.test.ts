import { describe, it, expect, vi, beforeEach } from 'vitest'
import { OpenMultiAgent } from '../src/orchestrator/orchestrator.js'
import { Agent } from '../src/agent/agent.js'
import { ToolRegistry } from '../src/tool/framework.js'
import { ToolExecutor } from '../src/tool/executor.js'
import type { AgentConfig, LLMChatOptions, LLMMessage, LLMResponse, OrchestratorEvent } from '../src/types.js'

let mockAdapterResponses: string[] = []
let mockAdapterUsage: Array<{ input_tokens: number; output_tokens: number }> = []

vi.mock('../src/llm/adapter.js', () => ({
  createAdapter: async () => {
    let callIndex = 0
    return {
      name: 'mock',
      async chat(_msgs: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
        const text = mockAdapterResponses[callIndex] ?? 'default mock response'
        const usage = mockAdapterUsage[callIndex] ?? { input_tokens: 10, output_tokens: 20 }
        callIndex++
        return {
          id: `resp-${callIndex}`,
          content: [{ type: 'text', text }],
          model: options.model ?? 'mock-model',
          stop_reason: 'end_turn',
          usage,
        }
      },
      async *stream() {
        yield { type: 'done' as const, data: {} }
      },
    }
  },
}))

function agentConfig(name: string, maxTokenBudget?: number): AgentConfig {
  return {
    name,
    model: 'mock-model',
    provider: 'openai',
    systemPrompt: `You are ${name}.`,
    maxTokenBudget,
  }
}

describe('token budget enforcement', () => {
  beforeEach(() => {
    mockAdapterResponses = []
    mockAdapterUsage = []
  })

  it('enforces agent-level maxTokenBudget in runAgent', async () => {
    mockAdapterResponses = ['over budget']
    mockAdapterUsage = [{ input_tokens: 20, output_tokens: 15 }]

    const events: OrchestratorEvent[] = []
    const oma = new OpenMultiAgent({
      defaultModel: 'mock-model',
      onProgress: e => events.push(e),
    })

    const result = await oma.runAgent(agentConfig('solo', 30), 'test')

    expect(result.success).toBe(false)
    expect(result.budgetExceeded).toBe(true)
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]?.role).toBe('assistant')
    expect(result.messages[0]?.content[0]).toMatchObject({ type: 'text', text: 'over budget' })
    expect(events.some(e => e.type === 'budget_exceeded')).toBe(true)
  })

  it('emits budget_exceeded stream event without error transition', async () => {
    mockAdapterResponses = ['over budget']
    mockAdapterUsage = [{ input_tokens: 20, output_tokens: 15 }]

    const agent = new Agent(
      agentConfig('streamer', 30),
      new ToolRegistry(),
      new ToolExecutor(new ToolRegistry()),
    )

    const eventTypes: string[] = []
    for await (const event of agent.stream('test')) {
      eventTypes.push(event.type)
    }

    expect(eventTypes).toContain('budget_exceeded')
    expect(eventTypes).toContain('done')
    expect(eventTypes).not.toContain('error')
    expect(agent.getState().status).toBe('completed')
  })

  it('does not skip in-progress sibling tasks when team budget is exceeded mid-batch', async () => {
    mockAdapterResponses = ['done-a', 'done-b', 'done-c']
    mockAdapterUsage = [
      { input_tokens: 15, output_tokens: 10 }, // A => 25
      { input_tokens: 15, output_tokens: 10 }, // B => 50 total (exceeds 40)
      { input_tokens: 15, output_tokens: 10 }, // C should never run
    ]

    const events: OrchestratorEvent[] = []
    const oma = new OpenMultiAgent({
      defaultModel: 'mock-model',
      maxTokenBudget: 40,
      onProgress: e => events.push(e),
    })
    const team = oma.createTeam('team-siblings', {
      name: 'team-siblings',
      agents: [agentConfig('worker-a'), agentConfig('worker-b')],
      sharedMemory: false,
    })

    await oma.runTasks(team, [
      { title: 'Task A', description: 'A', assignee: 'worker-a' },
      { title: 'Task B', description: 'B', assignee: 'worker-b' },
      { title: 'Task C', description: 'C', assignee: 'worker-a', dependsOn: ['Task A'] },
    ])

    const completedTaskIds = new Set(
      events.filter(e => e.type === 'task_complete').map(e => e.task).filter(Boolean) as string[],
    )
    const skippedTaskIds = new Set(
      events.filter(e => e.type === 'task_skipped').map(e => e.task).filter(Boolean) as string[],
    )

    const overlap = [...completedTaskIds].filter(id => skippedTaskIds.has(id))
    expect(overlap).toHaveLength(0)
  })

  it('does not trigger budget events when budget is not exceeded', async () => {
    mockAdapterResponses = ['done-a', 'done-b']
    mockAdapterUsage = [
      { input_tokens: 10, output_tokens: 10 },
      { input_tokens: 10, output_tokens: 10 },
    ]
    const events: OrchestratorEvent[] = []
    const oma = new OpenMultiAgent({
      defaultModel: 'mock-model',
      maxTokenBudget: 100,
      onProgress: e => events.push(e),
    })
    const team = oma.createTeam('team-a', {
      name: 'team-a',
      agents: [agentConfig('worker-a'), agentConfig('worker-b')],
      sharedMemory: false,
    })

    const result = await oma.runTasks(team, [
      { title: 'A', description: 'Do A', assignee: 'worker-a' },
      { title: 'B', description: 'Do B', assignee: 'worker-b', dependsOn: ['A'] },
    ])

    expect(result.success).toBe(true)
    expect(events.some(e => e.type === 'budget_exceeded')).toBe(false)
  })

  it('enforces team budget in runTasks and skips remaining tasks', async () => {
    mockAdapterResponses = ['done-a', 'done-b', 'done-c']
    mockAdapterUsage = [
      { input_tokens: 20, output_tokens: 15 }, // A => 35
      { input_tokens: 20, output_tokens: 15 }, // B => 70 total (exceeds 60)
      { input_tokens: 20, output_tokens: 15 }, // C should not run
    ]

    const events: OrchestratorEvent[] = []
    const oma = new OpenMultiAgent({
      defaultModel: 'mock-model',
      maxTokenBudget: 60,
      onProgress: e => events.push(e),
    })
    const team = oma.createTeam('team-b', {
      name: 'team-b',
      agents: [agentConfig('worker')],
      sharedMemory: false,
    })

    const result = await oma.runTasks(team, [
      { title: 'A', description: 'A', assignee: 'worker' },
      { title: 'B', description: 'B', assignee: 'worker', dependsOn: ['A'] },
      { title: 'C', description: 'C', assignee: 'worker', dependsOn: ['B'] },
    ])

    expect(result.totalTokenUsage.input_tokens + result.totalTokenUsage.output_tokens).toBe(70)
    expect(events.some(e => e.type === 'budget_exceeded')).toBe(true)
    expect(events.some(e => e.type === 'task_skipped')).toBe(true)
  })

  it('counts retry token usage before enforcing team budget', async () => {
    mockAdapterResponses = ['attempt-1', 'attempt-2', 'should-skip']
    mockAdapterUsage = [
      { input_tokens: 20, output_tokens: 15 }, // attempt 1
      { input_tokens: 20, output_tokens: 15 }, // attempt 2
      { input_tokens: 20, output_tokens: 15 }, // next task (should skip)
    ]

    const events: OrchestratorEvent[] = []
    const oma = new OpenMultiAgent({
      defaultModel: 'mock-model',
      maxTokenBudget: 50,
      onProgress: e => events.push(e),
    })
    const team = oma.createTeam('team-c', {
      name: 'team-c',
      agents: [agentConfig('retry-worker', 1)],
      sharedMemory: false,
    })

    const result = await oma.runTasks(team, [
      { title: 'Retrying task', description: 'Will exceed internal budget', assignee: 'retry-worker', maxRetries: 1 },
      { title: 'Later task', description: 'Should be skipped', assignee: 'retry-worker', dependsOn: ['Retrying task'] },
    ])

    expect(result.totalTokenUsage.input_tokens + result.totalTokenUsage.output_tokens).toBe(70)
    expect(events.some(e => e.type === 'budget_exceeded')).toBe(true)
    expect(events.some(e => e.type === 'error')).toBe(true)
  })

  it('enforces orchestrator budget in runTeam', async () => {
    mockAdapterResponses = [
      '```json\n[{"title":"Task A","description":"Do A","assignee":"worker"}]\n```',
      'worker result',
      'synthesis should not run when budget exceeded',
    ]
    mockAdapterUsage = [
      { input_tokens: 20, output_tokens: 15 }, // decomposition => 35
      { input_tokens: 20, output_tokens: 15 }, // task => 70 total (exceeds 60)
      { input_tokens: 20, output_tokens: 15 }, // synthesis should not execute
    ]

    const events: OrchestratorEvent[] = []
    const oma = new OpenMultiAgent({
      defaultModel: 'mock-model',
      maxTokenBudget: 60,
      onProgress: e => events.push(e),
    })
    const team = oma.createTeam('team-d', {
      name: 'team-d',
      agents: [agentConfig('worker')],
      sharedMemory: false,
    })

    // Use a goal that explicitly mentions sequencing so the short-circuit
    // path is skipped and the coordinator decomposition + execution flow
    // (which this test is exercising) actually runs.
    const result = await oma.runTeam(team, 'First plan the work, then execute it')
    expect(result.totalTokenUsage.input_tokens + result.totalTokenUsage.output_tokens).toBe(70)
    expect(events.some(e => e.type === 'budget_exceeded')).toBe(true)
  })
})
