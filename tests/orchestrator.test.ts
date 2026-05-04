import { describe, it, expect, vi, beforeEach } from 'vitest'
import { OpenMultiAgent } from '../src/orchestrator/orchestrator.js'
import type {
  AgentConfig,
  AgentRunResult,
  LLMAdapter,
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  OrchestratorEvent,
  TeamConfig,
  TraceEvent,
} from '../src/types.js'

// ---------------------------------------------------------------------------
// Mock LLM adapter
// ---------------------------------------------------------------------------

/** A controllable fake LLM adapter for orchestrator tests. */
function createMockAdapter(responses: string[]): LLMAdapter {
  let callIndex = 0
  return {
    name: 'mock',
    async chat(_msgs: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
      const text = responses[callIndex] ?? 'no response configured'
      callIndex++
      return {
        id: `resp-${callIndex}`,
        content: [{ type: 'text', text }],
        model: options.model,
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 20 },
      }
    },
    async *stream() {
      yield { type: 'done' as const, data: {} }
    },
  }
}

/**
 * Mock the createAdapter factory to return our mock adapter.
 * We need to do this at the module level because Agent calls createAdapter internally.
 */
let mockAdapterResponses: string[] = []
let capturedChatOptions: LLMChatOptions[] = []
let capturedPrompts: string[] = []

vi.mock('../src/llm/adapter.js', () => ({
  createAdapter: async () => {
    let callIndex = 0
    return {
      name: 'mock',
      async chat(_msgs: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
        capturedChatOptions.push(options)
        const lastUser = [..._msgs].reverse().find((m) => m.role === 'user')
        const prompt = (lastUser?.content ?? [])
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
        capturedPrompts.push(prompt)
        const text = mockAdapterResponses[callIndex] ?? 'default mock response'
        callIndex++
        return {
          id: `resp-${callIndex}`,
          content: [{ type: 'text', text }],
          model: options.model ?? 'mock-model',
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 20 },
        }
      },
      async *stream() {
        yield { type: 'done' as const, data: {} }
      },
    }
  },
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function agentConfig(name: string): AgentConfig {
  return {
    name,
    model: 'mock-model',
    provider: 'openai',
    systemPrompt: `You are ${name}.`,
  }
}

function teamCfg(agents?: AgentConfig[]): TeamConfig {
  return {
    name: 'test-team',
    agents: agents ?? [agentConfig('worker-a'), agentConfig('worker-b')],
    sharedMemory: true,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OpenMultiAgent', () => {
  beforeEach(() => {
    mockAdapterResponses = []
    capturedChatOptions = []
    capturedPrompts = []
  })

  describe('createTeam', () => {
    it('creates and registers a team', () => {
      const oma = new OpenMultiAgent()
      const team = oma.createTeam('my-team', teamCfg())
      expect(team.name).toBe('test-team')
      expect(oma.getStatus().teams).toBe(1)
    })

    it('throws on duplicate team name', () => {
      const oma = new OpenMultiAgent()
      oma.createTeam('my-team', teamCfg())
      expect(() => oma.createTeam('my-team', teamCfg())).toThrow('already exists')
    })
  })

  describe('shutdown', () => {
    it('clears teams and counters', async () => {
      const oma = new OpenMultiAgent()
      oma.createTeam('t1', teamCfg())
      await oma.shutdown()
      expect(oma.getStatus().teams).toBe(0)
      expect(oma.getStatus().completedTasks).toBe(0)
    })
  })

  describe('getStatus', () => {
    it('reports initial state', () => {
      const oma = new OpenMultiAgent()
      const status = oma.getStatus()
      expect(status).toEqual({ teams: 0, activeAgents: 0, completedTasks: 0 })
    })
  })

  describe('runAgent', () => {
    it('runs a single agent and returns result', async () => {
      mockAdapterResponses = ['Hello from agent!']

      const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
      const result = await oma.runAgent(
        agentConfig('solo'),
        'Say hello',
      )

      expect(result.success).toBe(true)
      expect(result.output).toBe('Hello from agent!')
      expect(oma.getStatus().completedTasks).toBe(1)
    })

    it('registers customTools so they are available to the LLM', async () => {
      mockAdapterResponses = ['used custom tool']

      const { z } = await import('zod')
      const { defineTool } = await import('../src/tool/framework.js')

      const myTool = defineTool({
        name: 'my_custom_tool',
        description: 'A custom tool for testing',
        inputSchema: z.object({ query: z.string() }),
        execute: async ({ query }) => ({ data: query }),
      })

      const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
      await oma.runAgent(
        { ...agentConfig('solo'), customTools: [myTool] },
        'Use the custom tool',
      )

      const toolNames = capturedChatOptions[0]?.tools?.map(t => t.name) ?? []
      expect(toolNames).toContain('my_custom_tool')
    })

    it('customTools bypass tools allowlist and toolPreset filtering', async () => {
      mockAdapterResponses = ['done']

      const { z } = await import('zod')
      const { defineTool } = await import('../src/tool/framework.js')

      const myTool = defineTool({
        name: 'my_custom_tool',
        description: 'A custom tool for testing',
        inputSchema: z.object({ query: z.string() }),
        execute: async ({ query }) => ({ data: query }),
      })

      const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })

      // toolPreset 'readonly' only allows file_read, grep, glob — custom tool should still appear
      await oma.runAgent(
        { ...agentConfig('solo'), customTools: [myTool], toolPreset: 'readonly' },
        'test',
      )

      const toolNames = capturedChatOptions[0]?.tools?.map(t => t.name) ?? []
      expect(toolNames).toContain('my_custom_tool')
      // built-in tools outside the preset should be filtered
      expect(toolNames).not.toContain('bash')
    })

    it('customTools can be blocked by disallowedTools', async () => {
      mockAdapterResponses = ['done']

      const { z } = await import('zod')
      const { defineTool } = await import('../src/tool/framework.js')

      const myTool = defineTool({
        name: 'my_custom_tool',
        description: 'A custom tool for testing',
        inputSchema: z.object({ query: z.string() }),
        execute: async ({ query }) => ({ data: query }),
      })

      const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })

      await oma.runAgent(
        { ...agentConfig('solo'), customTools: [myTool], disallowedTools: ['my_custom_tool'] },
        'test',
      )

      const toolNames = capturedChatOptions[0]?.tools?.map(t => t.name) ?? []
      expect(toolNames).not.toContain('my_custom_tool')
    })

    it('fires onProgress events', async () => {
      mockAdapterResponses = ['done']

      const events: OrchestratorEvent[] = []
      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        onProgress: (e) => events.push(e),
      })

      await oma.runAgent(agentConfig('solo'), 'test')

      const types = events.map(e => e.type)
      expect(types).toContain('agent_start')
      expect(types).toContain('agent_complete')
    })
  })

  describe('runTasks', () => {
    it('executes explicit tasks assigned to agents', async () => {
      // Each agent run produces one LLM call
      mockAdapterResponses = ['result-a', 'result-b']

      const events: OrchestratorEvent[] = []
      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        onProgress: (e) => events.push(e),
      })
      const team = oma.createTeam('t', teamCfg())

      const result = await oma.runTasks(team, [
        { title: 'Task A', description: 'Do A', assignee: 'worker-a' },
        { title: 'Task B', description: 'Do B', assignee: 'worker-b' },
      ])

      expect(result.success).toBe(true)
      expect(result.agentResults.size).toBeGreaterThanOrEqual(1)
    })

    it('handles task dependencies sequentially', async () => {
      mockAdapterResponses = ['first done', 'second done']

      const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
      const team = oma.createTeam('t', teamCfg())

      const result = await oma.runTasks(team, [
        { title: 'First', description: 'Do first', assignee: 'worker-a' },
        { title: 'Second', description: 'Do second', assignee: 'worker-b', dependsOn: ['First'] },
      ])

      expect(result.success).toBe(true)
    })

    it('uses a clean slate for tasks without dependencies', async () => {
      mockAdapterResponses = ['alpha done', 'beta done']

      const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
      const team = oma.createTeam('t', teamCfg())

      await oma.runTasks(team, [
        { title: 'Independent A', description: 'Do independent A', assignee: 'worker-a' },
        { title: 'Independent B', description: 'Do independent B', assignee: 'worker-b' },
      ])

      const workerPrompts = capturedPrompts.slice(0, 2)
      expect(workerPrompts[0]).toContain('# Task: Independent A')
      expect(workerPrompts[1]).toContain('# Task: Independent B')
      expect(workerPrompts[0]).not.toContain('## Shared Team Memory')
      expect(workerPrompts[1]).not.toContain('## Shared Team Memory')
      expect(workerPrompts[0]).not.toContain('## Context from prerequisite tasks')
      expect(workerPrompts[1]).not.toContain('## Context from prerequisite tasks')
    })

    it('injects only dependency results into dependent task prompts', async () => {
      mockAdapterResponses = ['first output', 'second output']

      const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
      const team = oma.createTeam('t', teamCfg())

      await oma.runTasks(team, [
        { title: 'First', description: 'Produce first', assignee: 'worker-a' },
        { title: 'Second', description: 'Use first', assignee: 'worker-b', dependsOn: ['First'] },
      ])

      const secondPrompt = capturedPrompts[1] ?? ''
      expect(secondPrompt).toContain('## Context from prerequisite tasks')
      expect(secondPrompt).toContain('### First (by worker-a)')
      expect(secondPrompt).toContain('first output')
      expect(secondPrompt).not.toContain('## Shared Team Memory')
    })

    it('supports memoryScope all opt-in for full shared memory visibility', async () => {
      mockAdapterResponses = ['writer output', 'reader output']

      const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
      const team = oma.createTeam('t', teamCfg())

      await oma.runTasks(team, [
        { title: 'Write', description: 'Write something', assignee: 'worker-a' },
        {
          title: 'Read all',
          description: 'Read everything',
          assignee: 'worker-b',
          memoryScope: 'all',
          dependsOn: ['Write'],
        },
      ])

      const secondPrompt = capturedPrompts[1] ?? ''
      expect(secondPrompt).toContain('## Shared Team Memory')
      expect(secondPrompt).toContain('task:')
      expect(secondPrompt).not.toContain('## Context from prerequisite tasks')
    })
  })

  describe('runTeam', () => {
    it('runs coordinator decomposition + execution + synthesis', async () => {
      // Response 1: coordinator decomposition (returns JSON task array)
      // Response 2: worker-a executes task
      // Response 3: coordinator synthesis
      mockAdapterResponses = [
        '```json\n[{"title": "Research", "description": "Research the topic", "assignee": "worker-a"}]\n```',
        'Research results here',
        'Final synthesized answer based on research results',
      ]

      const events: OrchestratorEvent[] = []
      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        onProgress: (e) => events.push(e),
      })
      const team = oma.createTeam('t', teamCfg())

      const result = await oma.runTeam(team, 'First research AI safety best practices, then write a comprehensive implementation guide')

      expect(result.success).toBe(true)
      // Should have coordinator result
      expect(result.agentResults.has('coordinator')).toBe(true)
    })

    it('falls back to one-task-per-agent when coordinator output is unparseable', async () => {
      mockAdapterResponses = [
        'I cannot produce JSON output', // invalid coordinator output
        'worker-a result',
        'worker-b result',
        'synthesis',
      ]

      const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
      const team = oma.createTeam('t', teamCfg())

      const result = await oma.runTeam(team, 'First design the database schema, then implement the REST API endpoints')

      expect(result.success).toBe(true)
    })

    it('supports coordinator model override without affecting workers', async () => {
      mockAdapterResponses = [
        '```json\n[{"title": "Research", "description": "Research", "assignee": "worker-a"}]\n```',
        'worker output',
        'final synthesis',
      ]

      const oma = new OpenMultiAgent({
        defaultModel: 'expensive-model',
        defaultProvider: 'openai',
      })
      const team = oma.createTeam('t', teamCfg([
        { ...agentConfig('worker-a'), model: 'worker-model' },
      ]))

      const result = await oma.runTeam(team, 'First research the topic, then synthesize findings', {
        coordinator: { model: 'cheap-model' },
      })

      expect(result.success).toBe(true)
      expect(capturedChatOptions.length).toBe(3)
      expect(capturedChatOptions[0]?.model).toBe('cheap-model')
      expect(capturedChatOptions[1]?.model).toBe('worker-model')
      expect(capturedChatOptions[2]?.model).toBe('cheap-model')
    })

    it('appends coordinator.instructions to the default system prompt', async () => {
      mockAdapterResponses = [
        '```json\n[{"title": "Plan", "description": "Plan", "assignee": "worker-a"}]\n```',
        'done',
        'final',
      ]

      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        defaultProvider: 'openai',
      })
      const team = oma.createTeam('t', teamCfg([
        { ...agentConfig('worker-a'), model: 'worker-model' },
      ]))

      await oma.runTeam(team, 'First implement, then verify', {
        coordinator: {
          instructions: 'Always create a testing task after implementation tasks.',
        },
      })

      const coordinatorPrompt = capturedChatOptions[0]?.systemPrompt ?? ''
      expect(coordinatorPrompt).toContain('You are a task coordinator responsible')
      expect(coordinatorPrompt).toContain('## Additional Instructions')
      expect(coordinatorPrompt).toContain('Always create a testing task after implementation tasks.')
    })

    it('uses coordinator.systemPrompt override while still appending required sections', async () => {
      mockAdapterResponses = [
        '```json\n[{"title": "Plan", "description": "Plan", "assignee": "worker-a"}]\n```',
        'done',
        'final',
      ]

      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        defaultProvider: 'openai',
      })
      const team = oma.createTeam('t', teamCfg([
        { ...agentConfig('worker-a'), model: 'worker-model' },
      ]))

      await oma.runTeam(team, 'First implement, then verify', {
        coordinator: {
          systemPrompt: 'You are a custom coordinator for monorepo planning.',
        },
      })

      const coordinatorPrompt = capturedChatOptions[0]?.systemPrompt ?? ''
      expect(coordinatorPrompt).toContain('You are a custom coordinator for monorepo planning.')
      expect(coordinatorPrompt).toContain('## Team Roster')
      expect(coordinatorPrompt).toContain('## Output Format')
      expect(coordinatorPrompt).toContain('## When synthesising results')
      expect(coordinatorPrompt).not.toContain('You are a task coordinator responsible')
    })

    it('applies advanced coordinator options (maxTokens, temperature, tools, disallowedTools)', async () => {
      mockAdapterResponses = [
        '```json\n[{"title": "Inspect", "description": "Inspect", "assignee": "worker-a"}]\n```',
        'worker output',
        'final synthesis',
      ]

      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        defaultProvider: 'openai',
      })
      const team = oma.createTeam('t', teamCfg([
        { ...agentConfig('worker-a'), model: 'worker-model' },
      ]))

      await oma.runTeam(team, 'First inspect project, then produce output', {
        coordinator: {
          maxTurns: 5,
          maxTokens: 1234,
          temperature: 0,
          tools: ['file_read', 'grep'],
          disallowedTools: ['grep'],
          timeoutMs: 1500,
          loopDetection: { maxRepetitions: 2, loopDetectionWindow: 3 },
        },
      })

      expect(capturedChatOptions[0]?.maxTokens).toBe(1234)
      expect(capturedChatOptions[0]?.temperature).toBe(0)
      expect(capturedChatOptions[0]?.tools).toBeDefined()
      expect(capturedChatOptions[0]?.tools?.map((t) => t.name)).toContain('file_read')
      expect(capturedChatOptions[0]?.tools?.map((t) => t.name)).not.toContain('grep')
    })

    it('supports coordinator.toolPreset and intersects with tools allowlist', async () => {
      mockAdapterResponses = [
        '```json\n[{"title": "Inspect", "description": "Inspect", "assignee": "worker-a"}]\n```',
        'worker output',
        'final synthesis',
      ]

      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        defaultProvider: 'openai',
      })
      const team = oma.createTeam('t', teamCfg([
        { ...agentConfig('worker-a'), model: 'worker-model' },
      ]))

      await oma.runTeam(team, 'First inspect project, then produce output', {
        coordinator: {
          toolPreset: 'readonly',
          tools: ['file_read', 'bash'],
        },
      })

      const coordinatorToolNames = capturedChatOptions[0]?.tools?.map((t) => t.name) ?? []
      expect(coordinatorToolNames).toContain('file_read')
      expect(coordinatorToolNames).not.toContain('bash')
    })
  })

  describe('config defaults', () => {
    it('uses default model and provider', () => {
      const oma = new OpenMultiAgent()
      const status = oma.getStatus()
      expect(status).toBeDefined()
    })

    it('accepts custom config', () => {
      const oma = new OpenMultiAgent({
        maxConcurrency: 3,
        defaultModel: 'custom-model',
        defaultProvider: 'openai',
      })
      expect(oma.getStatus().teams).toBe(0)
    })
  })

  describe('onApproval gate', () => {
    it('skips remaining tasks when approval rejects', async () => {
      mockAdapterResponses = ['first done', 'should not run']

      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        onApproval: async () => false, // reject all
      })
      const team = oma.createTeam('t', teamCfg([agentConfig('worker')]))

      const result = await oma.runTasks(team, [
        { title: 'First', description: 'Do first', assignee: 'worker' },
        { title: 'Second', description: 'Do second', assignee: 'worker', dependsOn: ['First'] },
      ])

      // The first task succeeded; the second was skipped (no agentResult entry).
      // Overall success is based on agentResults only, so it's true.
      expect(result.success).toBe(true)
      // But we should have fewer agent results than tasks
      expect(result.agentResults.size).toBeLessThanOrEqual(1)
    })
  })

  describe('onPlanReady gate', () => {
    const complexGoal = 'First research the topic, then write a comprehensive guide based on the findings'

    it('emits plan_ready trace even when onPlanReady callback is not configured', async () => {
      mockAdapterResponses = [
        '```json\n[{"title": "Research", "description": "Research", "assignee": "worker"}]\n```',
        'worker output',
        'final synthesis',
      ]
      const traces: TraceEvent[] = []
      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        onTrace: (event) => { traces.push(event) },
      })
      const team = oma.createTeam('t', teamCfg([agentConfig('worker')]))

      const result = await oma.runTeam(team, complexGoal)

      expect(result.success).toBe(true)
      const planReadyTraces = traces.filter((t) => t.type === 'plan_ready')
      expect(planReadyTraces).toHaveLength(1)
      const planReady = planReadyTraces[0]!
      expect(planReady.type).toBe('plan_ready')
      expect(planReady.taskCount).toBe(1)
      expect(planReady.approved).toBe(true)
      expect(planReady.runId).toMatch(/.+/)
    })

    it('aborts when callback returns false, preserving coordinator token usage', async () => {
      mockAdapterResponses = [
        '```json\n[{"title": "Research", "description": "Research", "assignee": "worker"}]\n```',
      ]
      const onPlanReadySpy = vi.fn().mockResolvedValue(false)
      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        onPlanReady: onPlanReadySpy,
      })
      const team = oma.createTeam('t', teamCfg([agentConfig('worker')]))

      const result = await oma.runTeam(team, complexGoal)

      expect(result.success).toBe(false)
      expect(result.agentResults.has('coordinator')).toBe(true)
      expect(result.totalTokenUsage.input_tokens).toBe(10)
      expect(result.totalTokenUsage.output_tokens).toBe(20)
      expect(onPlanReadySpy).toHaveBeenCalledTimes(1)
    })

    it('aborts when callback throws, treating it as a controlled abort', async () => {
      mockAdapterResponses = [
        '```json\n[{"title": "Research", "description": "Research", "assignee": "worker"}]\n```',
      ]
      const onPlanReadySpy = vi.fn().mockRejectedValue(new Error('boom'))
      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        onPlanReady: onPlanReadySpy,
      })
      const team = oma.createTeam('t', teamCfg([agentConfig('worker')]))

      const result = await oma.runTeam(team, complexGoal)

      expect(result.success).toBe(false)
      expect(result.agentResults.has('coordinator')).toBe(true)
      expect(result.totalTokenUsage.input_tokens).toBe(10)
      expect(result.totalTokenUsage.output_tokens).toBe(20)
      expect(onPlanReadySpy).toHaveBeenCalledTimes(1)
    })

    it('proceeds when callback returns true, receiving the decomposed plan', async () => {
      mockAdapterResponses = [
        '```json\n[{"title": "Research", "description": "Research", "assignee": "worker"}]\n```',
        'worker output',
        'final synthesis',
      ]
      const onPlanReadySpy = vi.fn().mockResolvedValue(true)
      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        onPlanReady: onPlanReadySpy,
      })
      const team = oma.createTeam('t', teamCfg([agentConfig('worker')]))

      const result = await oma.runTeam(team, complexGoal)

      expect(result.success).toBe(true)
      expect(result.agentResults.has('worker')).toBe(true)
      expect(result.agentResults.has('coordinator')).toBe(true)
      expect(onPlanReadySpy).toHaveBeenCalledTimes(1)
      const tasksArg = onPlanReadySpy.mock.calls[0]?.[0] as { title: string }[] | undefined
      expect(Array.isArray(tasksArg)).toBe(true)
      expect(tasksArg).toHaveLength(1)
      expect(tasksArg?.[0]?.title).toBe('Research')
    })

    it('emits plan_ready trace with approval decision', async () => {
      mockAdapterResponses = [
        '```json\n[{"title": "Research", "description": "Research", "assignee": "worker"}]\n```',
      ]
      const traces: TraceEvent[] = []
      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        onTrace: (event) => { traces.push(event) },
        onPlanReady: async () => false,
      })
      const team = oma.createTeam('t', teamCfg([agentConfig('worker')]))

      const result = await oma.runTeam(team, complexGoal)

      expect(result.success).toBe(false)
      const planReadyTraces = traces.filter((t) => t.type === 'plan_ready')
      expect(planReadyTraces).toHaveLength(1)
      const planReady = planReadyTraces[0]!
      expect(planReady.type).toBe('plan_ready')
      expect(planReady.agent).toBe('coordinator')
      expect(planReady.taskCount).toBe(1)
      expect(planReady.approved).toBe(false)
      expect(planReady.runId).toMatch(/.+/)
      expect(planReady.durationMs).toBeGreaterThanOrEqual(0)
      expect(planReady.startMs).toBeLessThanOrEqual(planReady.endMs)
    })
  })

  describe('planOnly mode', () => {
    const complexGoal = 'First research the topic, then write a comprehensive guide based on the findings'

    it('returns the decomposed plan without executing tasks', async () => {
      mockAdapterResponses = [
        '```json\n[' +
          '{"title": "Research", "description": "Research the topic", "assignee": "worker"},' +
          '{"title": "Write", "description": "Write the guide", "assignee": "worker", "dependsOn": ["Research"]}' +
          ']\n```',
        'should-not-be-called-1',
        'should-not-be-called-2',
      ]
      const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
      const team = oma.createTeam('t', teamCfg([agentConfig('worker')]))

      const result = await oma.runTeam(team, complexGoal, { planOnly: true })

      expect(result.success).toBe(true)
      expect(result.planOnly).toBe(true)
      expect(result.tasks).toBeDefined()
      expect(result.tasks!.length).toBe(2)

      // Tasks should be in pre-execution states only. Independent tasks remain
      // 'pending'; tasks with unmet dependencies are 'blocked' (set by the
      // queue at insert time). Neither has executed.
      for (const task of result.tasks!) {
        expect(['pending', 'blocked']).toContain(task.status)
        expect(task.metrics).toBeUndefined()
      }

      const taskIds = new Set(result.tasks!.map((t) => t.id))
      for (const task of result.tasks!) {
        for (const dep of task.dependsOn) {
          expect(taskIds.has(dep)).toBe(true)
        }
      }

      expect(result.agentResults.size).toBe(1)
      expect(result.agentResults.has('coordinator')).toBe(true)
      expect(result.totalTokenUsage.input_tokens).toBe(10)
      expect(result.totalTokenUsage.output_tokens).toBe(20)

      // Only the coordinator should have been called.
      expect(capturedChatOptions.length).toBe(1)
    })

    it('still fires onPlanReady when planOnly is true', async () => {
      mockAdapterResponses = [
        '```json\n[{"title": "Research", "description": "Research", "assignee": "worker"}]\n```',
      ]
      const onPlanReadySpy = vi.fn().mockResolvedValue(true)
      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        onPlanReady: onPlanReadySpy,
      })
      const team = oma.createTeam('t', teamCfg([agentConfig('worker')]))

      const result = await oma.runTeam(team, complexGoal, { planOnly: true })

      expect(onPlanReadySpy).toHaveBeenCalledTimes(1)
      const tasksArg = onPlanReadySpy.mock.calls[0]?.[0] as { title: string }[] | undefined
      expect(Array.isArray(tasksArg)).toBe(true)
      expect(tasksArg).toHaveLength(1)
      expect(tasksArg?.[0]?.title).toBe('Research')
      expect(result.success).toBe(true)
      expect(result.planOnly).toBe(true)
    })

    it('honors onPlanReady rejection over planOnly', async () => {
      mockAdapterResponses = [
        '```json\n[{"title": "Research", "description": "Research", "assignee": "worker"}]\n```',
      ]
      const onPlanReadySpy = vi.fn().mockResolvedValue(false)
      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        onPlanReady: onPlanReadySpy,
      })
      const team = oma.createTeam('t', teamCfg([agentConfig('worker')]))

      const result = await oma.runTeam(team, complexGoal, { planOnly: true })

      expect(result.success).toBe(false)
      expect(result.planOnly).toBeUndefined()
      expect(onPlanReadySpy).toHaveBeenCalledTimes(1)
    })

    it('bypasses simple-goal short-circuit when planOnly is true', async () => {
      const simpleGoal = 'summarize this document'
      mockAdapterResponses = [
        '```json\n[{"title": "Summarize", "description": "Summarize", "assignee": "worker"}]\n```',
      ]
      const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
      const team = oma.createTeam('t', teamCfg([agentConfig('worker')]))

      const result = await oma.runTeam(team, simpleGoal, { planOnly: true })

      expect(result.planOnly).toBe(true)
      expect(result.success).toBe(true)
      expect(result.tasks).toBeDefined()
      expect(result.tasks!.length).toBeGreaterThan(0)
      expect(result.agentResults.has('coordinator')).toBe(true)
      // Exactly one chat call — the coordinator. The simple-goal short-circuit
      // would have called the worker directly instead.
      expect(capturedChatOptions.length).toBe(1)
    })

    it('emits balanced agent_start / agent_complete for the coordinator when planOnly is true', async () => {
      mockAdapterResponses = [
        '```json\n[{"title": "Research", "description": "Research", "assignee": "worker"}]\n```',
      ]
      const events: OrchestratorEvent[] = []
      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        onProgress: (e) => events.push(e),
      })
      const team = oma.createTeam('t', teamCfg([agentConfig('worker')]))

      await oma.runTeam(team, complexGoal, { planOnly: true })

      const coordinatorEvents = events.filter((e) => e.agent === 'coordinator')
      const types = coordinatorEvents.map((e) => e.type)
      expect(types).toContain('agent_start')
      expect(types).toContain('agent_complete')
      expect(types.filter((t) => t === 'agent_start').length).toBe(
        types.filter((t) => t === 'agent_complete').length,
      )
    })
  })

  describe('stream trace events', () => {
    it('emits agent_stream trace events when onAgentStream is configured', async () => {
      const complexGoal = 'First research the topic, then write a comprehensive guide based on the findings'
      mockAdapterResponses = [
        '```json\n[{"title": "Research", "description": "Research", "assignee": "worker"}]\n```',
        'worker output',
        'final synthesis',
      ]
      const traces: TraceEvent[] = []
      const streamedTypes: string[] = []
      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        onTrace: (event) => { traces.push(event) },
        onAgentStream: (_agentName, event) => { streamedTypes.push(event.type) },
      })
      const team = oma.createTeam('t', teamCfg([agentConfig('worker')]))

      const result = await oma.runTeam(team, complexGoal)

      expect(result.success).toBe(true)
      expect(streamedTypes.length).toBeGreaterThan(0)

      const streamTraces = traces.filter((t) => t.type === 'agent_stream')
      expect(streamTraces.length).toBeGreaterThan(0)
      expect(streamTraces.some((t) => t.streamType === 'text')).toBe(true)
      expect(streamTraces.some((t) => t.streamType === 'done')).toBe(true)
      for (const trace of streamTraces) {
        expect(trace.agent).toBe('worker')
        expect(trace.taskId).toMatch(/.+/)
        expect(trace.runId).toMatch(/.+/)
        expect(trace.durationMs).toBe(0)
      }
    })
  })
})
