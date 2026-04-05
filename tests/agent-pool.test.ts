import { describe, it, expect, vi } from 'vitest'
import { AgentPool } from '../src/agent/pool.js'
import type { Agent } from '../src/agent/agent.js'
import type { AgentRunResult, AgentState } from '../src/types.js'

// ---------------------------------------------------------------------------
// Mock Agent factory
// ---------------------------------------------------------------------------

const SUCCESS_RESULT: AgentRunResult = {
  success: true,
  output: 'done',
  messages: [],
  tokenUsage: { input_tokens: 10, output_tokens: 20 },
  toolCalls: [],
}

function createMockAgent(
  name: string,
  opts?: { runResult?: AgentRunResult; state?: AgentState['status'] },
): Agent {
  const state: AgentState = {
    status: opts?.state ?? 'idle',
    messages: [],
    tokenUsage: { input_tokens: 0, output_tokens: 0 },
  }

  return {
    name,
    config: { name, model: 'test' },
    run: vi.fn().mockResolvedValue(opts?.runResult ?? SUCCESS_RESULT),
    getState: vi.fn().mockReturnValue(state),
    reset: vi.fn(),
  } as unknown as Agent
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentPool', () => {
  describe('registry: add / remove / get / list', () => {
    it('adds and retrieves an agent', () => {
      const pool = new AgentPool()
      const agent = createMockAgent('alice')
      pool.add(agent)

      expect(pool.get('alice')).toBe(agent)
      expect(pool.list()).toHaveLength(1)
    })

    it('throws on duplicate add', () => {
      const pool = new AgentPool()
      pool.add(createMockAgent('alice'))
      expect(() => pool.add(createMockAgent('alice'))).toThrow('already registered')
    })

    it('removes an agent', () => {
      const pool = new AgentPool()
      pool.add(createMockAgent('alice'))
      pool.remove('alice')
      expect(pool.get('alice')).toBeUndefined()
      expect(pool.list()).toHaveLength(0)
    })

    it('throws on remove of unknown agent', () => {
      const pool = new AgentPool()
      expect(() => pool.remove('unknown')).toThrow('not registered')
    })

    it('get returns undefined for unknown agent', () => {
      const pool = new AgentPool()
      expect(pool.get('unknown')).toBeUndefined()
    })
  })

  describe('run', () => {
    it('runs a prompt on a named agent', async () => {
      const pool = new AgentPool()
      const agent = createMockAgent('alice')
      pool.add(agent)

      const result = await pool.run('alice', 'hello')

      expect(result.success).toBe(true)
      expect(agent.run).toHaveBeenCalledWith('hello', undefined)
    })

    it('throws on unknown agent name', async () => {
      const pool = new AgentPool()
      await expect(pool.run('unknown', 'hello')).rejects.toThrow('not registered')
    })
  })

  describe('runParallel', () => {
    it('runs multiple agents in parallel', async () => {
      const pool = new AgentPool(5)
      pool.add(createMockAgent('a'))
      pool.add(createMockAgent('b'))

      const results = await pool.runParallel([
        { agent: 'a', prompt: 'task a' },
        { agent: 'b', prompt: 'task b' },
      ])

      expect(results.size).toBe(2)
      expect(results.get('a')!.success).toBe(true)
      expect(results.get('b')!.success).toBe(true)
    })

    it('handles agent failures gracefully', async () => {
      const pool = new AgentPool()
      const failAgent = createMockAgent('fail')
      ;(failAgent.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))
      pool.add(failAgent)

      const results = await pool.runParallel([
        { agent: 'fail', prompt: 'will fail' },
      ])

      expect(results.get('fail')!.success).toBe(false)
      expect(results.get('fail')!.output).toContain('boom')
    })
  })

  describe('runAny', () => {
    it('round-robins across agents', async () => {
      const pool = new AgentPool()
      const a = createMockAgent('a')
      const b = createMockAgent('b')
      pool.add(a)
      pool.add(b)

      await pool.runAny('first')
      await pool.runAny('second')

      expect(a.run).toHaveBeenCalledTimes(1)
      expect(b.run).toHaveBeenCalledTimes(1)
    })

    it('throws on empty pool', async () => {
      const pool = new AgentPool()
      await expect(pool.runAny('hello')).rejects.toThrow('empty pool')
    })
  })

  describe('getStatus', () => {
    it('reports agent states', () => {
      const pool = new AgentPool()
      pool.add(createMockAgent('idle1', { state: 'idle' }))
      pool.add(createMockAgent('idle2', { state: 'idle' }))
      pool.add(createMockAgent('running', { state: 'running' }))
      pool.add(createMockAgent('done', { state: 'completed' }))
      pool.add(createMockAgent('err', { state: 'error' }))

      const status = pool.getStatus()

      expect(status.total).toBe(5)
      expect(status.idle).toBe(2)
      expect(status.running).toBe(1)
      expect(status.completed).toBe(1)
      expect(status.error).toBe(1)
    })
  })

  describe('shutdown', () => {
    it('resets all agents', async () => {
      const pool = new AgentPool()
      const a = createMockAgent('a')
      const b = createMockAgent('b')
      pool.add(a)
      pool.add(b)

      await pool.shutdown()

      expect(a.reset).toHaveBeenCalled()
      expect(b.reset).toHaveBeenCalled()
    })
  })

  describe('concurrency', () => {
    it('respects maxConcurrency limit', async () => {
      let concurrent = 0
      let maxConcurrent = 0

      const makeAgent = (name: string): Agent => {
        const agent = createMockAgent(name)
        ;(agent.run as ReturnType<typeof vi.fn>).mockImplementation(async () => {
          concurrent++
          maxConcurrent = Math.max(maxConcurrent, concurrent)
          await new Promise(r => setTimeout(r, 50))
          concurrent--
          return SUCCESS_RESULT
        })
        return agent
      }

      const pool = new AgentPool(2) // max 2 concurrent
      pool.add(makeAgent('a'))
      pool.add(makeAgent('b'))
      pool.add(makeAgent('c'))

      await pool.runParallel([
        { agent: 'a', prompt: 'x' },
        { agent: 'b', prompt: 'y' },
        { agent: 'c', prompt: 'z' },
      ])

      expect(maxConcurrent).toBeLessThanOrEqual(2)
    })
  })
})
