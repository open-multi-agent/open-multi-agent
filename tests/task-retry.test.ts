import { describe, it, expect, vi } from 'vitest'
import { createTask } from '../src/task/task.js'
import { executeWithRetry, computeRetryDelay } from '../src/orchestrator/orchestrator.js'
import type { AgentRunResult } from '../src/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SUCCESS_RESULT: AgentRunResult = {
  success: true,
  output: 'done',
  messages: [],
  tokenUsage: { input_tokens: 10, output_tokens: 20 },
  toolCalls: [],
}

const FAILURE_RESULT: AgentRunResult = {
  success: false,
  output: 'agent failed',
  messages: [],
  tokenUsage: { input_tokens: 10, output_tokens: 20 },
  toolCalls: [],
}

/** No-op delay for tests. */
const noDelay = () => Promise.resolve()

// ---------------------------------------------------------------------------
// computeRetryDelay
// ---------------------------------------------------------------------------

describe('computeRetryDelay', () => {
  it('computes exponential backoff', () => {
    expect(computeRetryDelay(1000, 2, 1)).toBe(1000)  // 1000 * 2^0
    expect(computeRetryDelay(1000, 2, 2)).toBe(2000)  // 1000 * 2^1
    expect(computeRetryDelay(1000, 2, 3)).toBe(4000)  // 1000 * 2^2
  })

  it('caps at 30 seconds', () => {
    // 1000 * 2^20 = 1,048,576,000 — way over cap
    expect(computeRetryDelay(1000, 2, 21)).toBe(30_000)
  })

  it('handles backoff of 1 (constant delay)', () => {
    expect(computeRetryDelay(500, 1, 1)).toBe(500)
    expect(computeRetryDelay(500, 1, 5)).toBe(500)
  })
})

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
// executeWithRetry — tests the real exported function
// ---------------------------------------------------------------------------

describe('executeWithRetry', () => {
  it('succeeds on first attempt with no retry config', async () => {
    const run = vi.fn().mockResolvedValue(SUCCESS_RESULT)
    const task = createTask({ title: 'Simple', description: 'test' })

    const result = await executeWithRetry(run, task, undefined, noDelay)

    expect(result.success).toBe(true)
    expect(result.output).toBe('done')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('succeeds on first attempt even when maxRetries > 0', async () => {
    const run = vi.fn().mockResolvedValue(SUCCESS_RESULT)
    const task = createTask({
      title: 'Has retries',
      description: 'test',
      maxRetries: 3,
    })

    const result = await executeWithRetry(run, task, undefined, noDelay)

    expect(result.success).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('retries on exception and succeeds on second attempt', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('transient error'))
      .mockResolvedValueOnce(SUCCESS_RESULT)

    const task = createTask({
      title: 'Retry task',
      description: 'test',
      maxRetries: 2,
      retryDelayMs: 100,
      retryBackoff: 2,
    })

    const retryEvents: unknown[] = []
    const result = await executeWithRetry(
      run,
      task,
      (data) => retryEvents.push(data),
      noDelay,
    )

    expect(result.success).toBe(true)
    expect(run).toHaveBeenCalledTimes(2)
    expect(retryEvents).toHaveLength(1)
    expect(retryEvents[0]).toEqual({
      attempt: 1,
      maxAttempts: 3,
      error: 'transient error',
      nextDelayMs: 100,  // 100 * 2^0
    })
  })

  it('retries on success:false and succeeds on second attempt', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(FAILURE_RESULT)
      .mockResolvedValueOnce(SUCCESS_RESULT)

    const task = createTask({
      title: 'Retry task',
      description: 'test',
      maxRetries: 1,
      retryDelayMs: 50,
    })

    const result = await executeWithRetry(run, task, undefined, noDelay)

    expect(result.success).toBe(true)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('exhausts all retries on persistent exception', async () => {
    const run = vi.fn().mockRejectedValue(new Error('persistent error'))

    const task = createTask({
      title: 'Always fails',
      description: 'test',
      maxRetries: 2,
      retryDelayMs: 10,
      retryBackoff: 1,
    })

    const retryEvents: unknown[] = []
    const result = await executeWithRetry(
      run,
      task,
      (data) => retryEvents.push(data),
      noDelay,
    )

    expect(result.success).toBe(false)
    expect(result.output).toBe('persistent error')
    expect(run).toHaveBeenCalledTimes(3)  // 1 initial + 2 retries
    expect(retryEvents).toHaveLength(2)
  })

  it('exhausts all retries on persistent success:false', async () => {
    const run = vi.fn().mockResolvedValue(FAILURE_RESULT)

    const task = createTask({
      title: 'Always fails',
      description: 'test',
      maxRetries: 1,
    })

    const result = await executeWithRetry(run, task, undefined, noDelay)

    expect(result.success).toBe(false)
    expect(result.output).toBe('agent failed')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('emits correct exponential backoff delays', async () => {
    const run = vi.fn().mockRejectedValue(new Error('error'))

    const task = createTask({
      title: 'Backoff test',
      description: 'test',
      maxRetries: 3,
      retryDelayMs: 100,
      retryBackoff: 2,
    })

    const retryEvents: Array<{ nextDelayMs: number }> = []
    await executeWithRetry(
      run,
      task,
      (data) => retryEvents.push(data),
      noDelay,
    )

    expect(retryEvents).toHaveLength(3)
    expect(retryEvents[0]!.nextDelayMs).toBe(100)   // 100 * 2^0
    expect(retryEvents[1]!.nextDelayMs).toBe(200)   // 100 * 2^1
    expect(retryEvents[2]!.nextDelayMs).toBe(400)   // 100 * 2^2
  })

  it('no retry events when maxRetries is 0 (default)', async () => {
    const run = vi.fn().mockRejectedValue(new Error('fail'))
    const task = createTask({ title: 'No retry', description: 'test' })

    const retryEvents: unknown[] = []
    const result = await executeWithRetry(
      run,
      task,
      (data) => retryEvents.push(data),
      noDelay,
    )

    expect(result.success).toBe(false)
    expect(run).toHaveBeenCalledTimes(1)
    expect(retryEvents).toHaveLength(0)
  })

  it('calls the delay function with computed delay', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('error'))
      .mockResolvedValueOnce(SUCCESS_RESULT)

    const task = createTask({
      title: 'Delay test',
      description: 'test',
      maxRetries: 1,
      retryDelayMs: 250,
      retryBackoff: 3,
    })

    const mockDelay = vi.fn().mockResolvedValue(undefined)
    await executeWithRetry(run, task, undefined, mockDelay)

    expect(mockDelay).toHaveBeenCalledTimes(1)
    expect(mockDelay).toHaveBeenCalledWith(250)  // 250 * 3^0
  })

  it('caps delay at 30 seconds', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('error'))
      .mockResolvedValueOnce(SUCCESS_RESULT)

    const task = createTask({
      title: 'Cap test',
      description: 'test',
      maxRetries: 1,
      retryDelayMs: 50_000,
      retryBackoff: 2,
    })

    const mockDelay = vi.fn().mockResolvedValue(undefined)
    await executeWithRetry(run, task, undefined, mockDelay)

    expect(mockDelay).toHaveBeenCalledWith(30_000)  // capped
  })

  it('accumulates token usage across retry attempts', async () => {
    const failResult: AgentRunResult = {
      ...FAILURE_RESULT,
      tokenUsage: { input_tokens: 100, output_tokens: 50 },
    }
    const successResult: AgentRunResult = {
      ...SUCCESS_RESULT,
      tokenUsage: { input_tokens: 200, output_tokens: 80 },
    }

    const run = vi.fn()
      .mockResolvedValueOnce(failResult)
      .mockResolvedValueOnce(failResult)
      .mockResolvedValueOnce(successResult)

    const task = createTask({
      title: 'Token test',
      description: 'test',
      maxRetries: 2,
      retryDelayMs: 10,
    })

    const result = await executeWithRetry(run, task, undefined, noDelay)

    expect(result.success).toBe(true)
    // 100+100+200 input, 50+50+80 output
    expect(result.tokenUsage.input_tokens).toBe(400)
    expect(result.tokenUsage.output_tokens).toBe(180)
  })

  it('accumulates token usage even when all retries fail', async () => {
    const failResult: AgentRunResult = {
      ...FAILURE_RESULT,
      tokenUsage: { input_tokens: 50, output_tokens: 30 },
    }

    const run = vi.fn().mockResolvedValue(failResult)

    const task = createTask({
      title: 'Token fail test',
      description: 'test',
      maxRetries: 1,
    })

    const result = await executeWithRetry(run, task, undefined, noDelay)

    expect(result.success).toBe(false)
    // 50+50 input, 30+30 output (2 attempts)
    expect(result.tokenUsage.input_tokens).toBe(100)
    expect(result.tokenUsage.output_tokens).toBe(60)
  })

  it('clamps negative maxRetries to 0 (single attempt)', async () => {
    const run = vi.fn().mockRejectedValue(new Error('fail'))

    const task = createTask({
      title: 'Negative retry',
      description: 'test',
      maxRetries: -5,
    })
    // Manually set negative value since createTask doesn't validate
    ;(task as any).maxRetries = -5

    const result = await executeWithRetry(run, task, undefined, noDelay)

    expect(result.success).toBe(false)
    expect(run).toHaveBeenCalledTimes(1)  // exactly 1 attempt, no retries
  })

  it('clamps backoff below 1 to 1 (constant delay)', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('error'))
      .mockResolvedValueOnce(SUCCESS_RESULT)

    const task = createTask({
      title: 'Bad backoff',
      description: 'test',
      maxRetries: 1,
      retryDelayMs: 100,
      retryBackoff: -2,
    })
    ;(task as any).retryBackoff = -2

    const mockDelay = vi.fn().mockResolvedValue(undefined)
    await executeWithRetry(run, task, undefined, mockDelay)

    // backoff clamped to 1, so delay = 100 * 1^0 = 100
    expect(mockDelay).toHaveBeenCalledWith(100)
  })
})
