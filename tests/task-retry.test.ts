import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { createTask } from '../src/task/task.js'
import { TaskQueue } from '../src/task/queue.js'
import type { Task, OrchestratorEvent, AgentRunResult, LLMResponse, LLMAdapter } from '../src/types.js'
import { Agent } from '../src/agent/agent.js'
import { AgentRunner } from '../src/agent/runner.js'
import { AgentPool } from '../src/agent/pool.js'
import { ToolRegistry } from '../src/tool/framework.js'
import { ToolExecutor } from '../src/tool/executor.js'

// ---------------------------------------------------------------------------
// createTask: retry fields
// ---------------------------------------------------------------------------

describe('createTask with retry fields', () => {
  it('passes through retry config', () => {
    const t = createTask({
      title: 'Retry task',
      description: 'test',
      maxRetries: 3,
      retryDelayMs: 500,
      retryBackoff: 1.5,
    })
    expect(t.maxRetries).toBe(3)
    expect(t.retryDelayMs).toBe(500)
    expect(t.retryBackoff).toBe(1.5)
  })

  it('defaults retry fields to undefined', () => {
    const t = createTask({ title: 'No retry', description: 'test' })
    expect(t.maxRetries).toBeUndefined()
    expect(t.retryDelayMs).toBeUndefined()
    expect(t.retryBackoff).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// executeQueue retry integration (mock agent pool)
// ---------------------------------------------------------------------------

/**
 * Build a mock adapter that returns responses in sequence.
 * Each response can be configured as success or failure.
 */
function mockAdapter(responses: Array<{ text: string; success?: boolean }>): LLMAdapter {
  let callIndex = 0
  return {
    name: 'mock',
    async chat() {
      const resp = responses[callIndex++] ?? { text: 'fallback' }
      return {
        id: `mock-${callIndex}`,
        content: [{ type: 'text' as const, text: resp.text }],
        model: 'mock-model',
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 20 },
      } satisfies LLMResponse
    },
    async *stream() { /* unused */ },
  }
}

function buildMockPool(
  agentName: string,
  responses: Array<{ text: string; success?: boolean }>,
): AgentPool {
  const adapter = mockAdapter(responses)
  const registry = new ToolRegistry()
  const executor = new ToolExecutor(registry)
  const config = { name: agentName, model: 'mock-model', systemPrompt: 'test' }
  const agent = new Agent(config, registry, executor)

  // Inject a pre-built runner to bypass createAdapter
  const runner = new AgentRunner(adapter, registry, executor, {
    model: config.model,
    systemPrompt: config.systemPrompt,
    agentName: config.name,
  })
  ;(agent as any).runner = runner

  const pool = new AgentPool(5)
  pool.add(agent)
  return pool
}

/**
 * Minimal re-implementation of the retry logic from executeQueue for isolated testing.
 * This tests the retry pattern directly without needing the full orchestrator.
 */
async function executeTaskWithRetry(
  task: Task,
  pool: AgentPool,
  onProgress?: (event: OrchestratorEvent) => void,
): Promise<AgentRunResult> {
  const maxAttempts = (task.maxRetries ?? 0) + 1
  const baseDelay = task.retryDelayMs ?? 1000
  const backoff = task.retryBackoff ?? 2
  const assignee = task.assignee!

  let lastResult: AgentRunResult | undefined

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await pool.run(assignee, task.description)
      lastResult = result

      if (result.success) {
        return result
      }

      if (attempt < maxAttempts) {
        const delay = baseDelay * backoff ** (attempt - 1)
        onProgress?.({
          type: 'task_retry',
          task: task.id,
          agent: assignee,
          data: { attempt, maxAttempts, error: result.output, nextDelayMs: delay },
        })
        // Skip actual sleep in tests — just verify the event was emitted
        continue
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)

      if (attempt < maxAttempts) {
        const delay = baseDelay * backoff ** (attempt - 1)
        onProgress?.({
          type: 'task_retry',
          task: task.id,
          agent: assignee,
          data: { attempt, maxAttempts, error: message, nextDelayMs: delay },
        })
        continue
      }

      return {
        success: false,
        output: message,
        messages: [],
        tokenUsage: { input_tokens: 0, output_tokens: 0 },
        toolCalls: [],
      }
    }
  }

  return lastResult!
}

describe('Task retry logic', () => {
  it('succeeds on first attempt with no retry config', async () => {
    const pool = buildMockPool('worker', [{ text: 'done' }])
    const task = createTask({
      title: 'Simple',
      description: 'do something',
      assignee: 'worker',
    })

    const result = await executeTaskWithRetry(task, pool)
    expect(result.success).toBe(true)
    expect(result.output).toBe('done')
  })

  it('retries and succeeds on second attempt', async () => {
    // First call returns empty text (success:true but the agent just returned text)
    // We need to simulate failure. Since AgentRunner always returns success:true
    // for normal text responses, let's test with multiple responses where
    // the first throws and the second succeeds.
    const pool = buildMockPool('worker', [
      { text: 'result1' },
      { text: 'result2' },
    ])

    const task = createTask({
      title: 'Retry task',
      description: 'do something',
      assignee: 'worker',
      maxRetries: 2,
      retryDelayMs: 10,
      retryBackoff: 1,
    })

    // Simulate first attempt failure by making pool.run throw on first call
    let callCount = 0
    const originalRun = pool.run.bind(pool)
    vi.spyOn(pool, 'run').mockImplementation(async (name, prompt) => {
      callCount++
      if (callCount === 1) {
        throw new Error('transient LLM error')
      }
      return originalRun(name, prompt)
    })

    const events: OrchestratorEvent[] = []
    const result = await executeTaskWithRetry(task, pool, (e) => events.push(e))

    expect(result.success).toBe(true)
    expect(result.output).toBe('result1') // second adapter response (first call threw)
    expect(callCount).toBe(2)

    // Verify task_retry event was emitted
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('task_retry')
    expect((events[0]!.data as any).attempt).toBe(1)
  })

  it('exhausts all retries and fails', async () => {
    const pool = buildMockPool('worker', [])

    const task = createTask({
      title: 'Always fails',
      description: 'do something',
      assignee: 'worker',
      maxRetries: 2,
      retryDelayMs: 10,
      retryBackoff: 1,
    })

    vi.spyOn(pool, 'run').mockRejectedValue(new Error('persistent error'))

    const events: OrchestratorEvent[] = []
    const result = await executeTaskWithRetry(task, pool, (e) => events.push(e))

    expect(result.success).toBe(false)
    expect(result.output).toBe('persistent error')

    // Should have emitted 2 retry events (attempt 1 and 2), then failed on attempt 3
    expect(events).toHaveLength(2)
    expect(events.every(e => e.type === 'task_retry')).toBe(true)
  })

  it('emits correct backoff delays', async () => {
    const pool = buildMockPool('worker', [])

    const task = createTask({
      title: 'Backoff test',
      description: 'do something',
      assignee: 'worker',
      maxRetries: 3,
      retryDelayMs: 100,
      retryBackoff: 2,
    })

    vi.spyOn(pool, 'run').mockRejectedValue(new Error('error'))

    const events: OrchestratorEvent[] = []
    await executeTaskWithRetry(task, pool, (e) => events.push(e))

    // 3 retry events: attempts 1, 2, 3 (attempt 4 is the final failure)
    expect(events).toHaveLength(3)
    expect((events[0]!.data as any).nextDelayMs).toBe(100)  // 100 * 2^0
    expect((events[1]!.data as any).nextDelayMs).toBe(200)  // 100 * 2^1
    expect((events[2]!.data as any).nextDelayMs).toBe(400)  // 100 * 2^2
  })

  it('no retry events when maxRetries is 0', async () => {
    const pool = buildMockPool('worker', [])

    const task = createTask({
      title: 'No retry',
      description: 'do something',
      assignee: 'worker',
      maxRetries: 0,
    })

    vi.spyOn(pool, 'run').mockRejectedValue(new Error('fail'))

    const events: OrchestratorEvent[] = []
    const result = await executeTaskWithRetry(task, pool, (e) => events.push(e))

    expect(result.success).toBe(false)
    expect(events).toHaveLength(0)
  })
})
