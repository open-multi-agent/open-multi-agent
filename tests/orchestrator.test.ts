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

vi.mock('../src/llm/adapter.js', () => ({
  createAdapter: async () => {
    let callIndex = 0
    return {
      name: 'mock',
      async chat(_msgs: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
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

      const result = await oma.runTeam(team, 'Research AI safety')

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

      const result = await oma.runTeam(team, 'Do something')

      expect(result.success).toBe(true)
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
})
