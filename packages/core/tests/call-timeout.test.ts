/**
 * Per-LLM-call timeout (#336).
 *
 * `callTimeoutMs` bounds a *single* `adapter.chat()` request with an OMA-owned
 * `AbortSignal.timeout()`, re-armed fresh per call and merged with any existing
 * signal — so the bound is uniform across adapters and composes with the
 * whole-run `abortSignal` / `timeoutMs`. When our deadline fires (and the
 * caller's own signal did not) the stalled call surfaces as an
 * `LLMCallTimeoutError`, distinct from a deliberate cancellation.
 */

import { describe, it, expect, vi } from 'vitest'
import { AgentRunner } from '../src/agent/runner.js'
import { Agent } from '../src/agent/agent.js'
import { ToolRegistry, defineTool } from '../src/tool/framework.js'
import { ToolExecutor } from '../src/tool/executor.js'
import { LLMCallTimeoutError } from '../src/errors.js'
import { z } from 'zod'
import type { LLMAdapter, LLMChatOptions, LLMResponse } from '../src/types.js'

const USER_HI = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }]

function textResponse(text: string): LLMResponse {
  return {
    id: '1',
    content: [{ type: 'text', text }],
    model: 'mock',
    stop_reason: 'end_turn',
    usage: { input_tokens: 0, output_tokens: 0 },
  }
}

/**
 * An adapter whose `chat()` never resolves on its own but rejects as soon as
 * the passed `abortSignal` fires — models a stalled provider that still honors
 * cancellation. Rejects immediately if no signal is present so a misconfigured
 * test fails fast instead of hanging.
 */
function hangingAdapter(onCall?: (opts: LLMChatOptions) => void): LLMAdapter {
  return {
    name: 'hanging',
    chat: (_messages, options) => {
      onCall?.(options)
      return new Promise<LLMResponse>((_resolve, reject) => {
        const signal = options.abortSignal
        if (signal === undefined) {
          reject(new Error('test bug: hangingAdapter reached with no abortSignal'))
          return
        }
        if (signal.aborted) {
          reject(new Error('aborted by signal'))
          return
        }
        signal.addEventListener('abort', () => reject(new Error('aborted by signal')), { once: true })
      })
    },
    async *stream() { /* unused */ },
  }
}

function makeRunner(adapter: LLMAdapter, options: Partial<ConstructorParameters<typeof AgentRunner>[3]> = {}) {
  const registry = new ToolRegistry()
  const executor = new ToolExecutor(registry)
  return {
    registry,
    runner: new AgentRunner(adapter, registry, executor, { model: 'mock', ...options }),
  }
}

describe('callTimeoutMs — per-call LLM timeout (#336)', () => {
  it('does not inject a timeout signal when callTimeoutMs is unset', async () => {
    let seen: AbortSignal | undefined
    const chat = vi.fn(async (_m, opts: LLMChatOptions) => {
      seen = opts.abortSignal
      return textResponse('done')
    })
    const { runner } = makeRunner({ name: 'mock', chat, async *stream() {} })

    const result = await runner.run(USER_HI)

    expect(chat).toHaveBeenCalledOnce()
    expect(result.output).toBe('done')
    // With callTimeoutMs unset and no caller signal, nothing is injected.
    expect(seen).toBeUndefined()
  })

  it('passes the caller signal through unchanged (identity) when callTimeoutMs is unset', async () => {
    const controller = new AbortController()
    let seen: AbortSignal | undefined
    const { runner } = makeRunner({
      name: 'mock',
      chat: async (_m, opts) => { seen = opts.abortSignal; return textResponse('ok') },
      async *stream() {},
    })

    await runner.run(USER_HI, { abortSignal: controller.signal })

    // Exact identity — the signal is neither merged nor wrapped.
    expect(seen).toBe(controller.signal)
  })

  it('aborts a stalled call and throws LLMCallTimeoutError after callTimeoutMs', async () => {
    const { runner } = makeRunner(hangingAdapter(), { agentName: 'slowpoke', callTimeoutMs: 20 })

    const err = await runner.run(USER_HI).catch((e) => e)

    expect(err).toBeInstanceOf(LLMCallTimeoutError)
    expect(err.code).toBe('LLM_CALL_TIMEOUT')
    expect(err.timeoutMs).toBe(20)
    expect(err.agent).toBe('slowpoke')
  })

  it('mints a fresh timeout signal for every call (per-call, not whole-run)', async () => {
    const signals: (AbortSignal | undefined)[] = []
    const chat = vi.fn()
      .mockImplementationOnce(async (_m: unknown, opts: LLMChatOptions) => {
        signals.push(opts.abortSignal)
        return {
          id: '1',
          content: [{ type: 'tool_use', id: 'c1', name: 'noop', input: {} }],
          model: 'mock',
          stop_reason: 'tool_use',
          usage: { input_tokens: 0, output_tokens: 0 },
        }
      })
      .mockImplementationOnce(async (_m: unknown, opts: LLMChatOptions) => {
        signals.push(opts.abortSignal)
        return textResponse('done')
      })
    const { runner, registry } = makeRunner(
      { name: 'mock', chat, async *stream() {} },
      // Large budget so the fast mock calls never actually time out.
      { agentName: 'a', allowedTools: ['noop'], callTimeoutMs: 10_000 },
    )
    registry.register(defineTool({
      name: 'noop',
      description: 'noop',
      inputSchema: z.object({}),
      execute: async () => ({ data: 'ok', isError: false }),
    }))

    const result = await runner.run(USER_HI)

    expect(result.output).toBe('done')
    expect(signals).toHaveLength(2)
    expect(signals[0]).toBeDefined()
    expect(signals[1]).toBeDefined()
    // A fresh AbortSignal.timeout() is created for each call, so a fast first
    // turn never eats into a later turn's budget.
    expect(signals[0]).not.toBe(signals[1])
  })

  it('rethrows a caller abort as-is (not mislabeled as a timeout) when the caller signal fires first', async () => {
    const controller = new AbortController()
    // Large per-call budget so the timeout cannot be what fires.
    const { runner } = makeRunner(hangingAdapter(), { agentName: 'a', callTimeoutMs: 10_000 })

    const promise = runner.run(USER_HI, { abortSignal: controller.signal })
    // Abort once the call is in flight (the pre-call abort check has passed).
    setTimeout(() => controller.abort(), 5)
    const err = await promise.catch((e) => e)

    expect(err).not.toBeInstanceOf(LLMCallTimeoutError)
    expect((err as Error).message).toContain('aborted by signal')
  })

  it('threads AgentConfig.callTimeoutMs through to the runner', async () => {
    const registry = new ToolRegistry()
    const agent = new Agent(
      { name: 'a', model: 'mock', adapter: hangingAdapter(), callTimeoutMs: 20 },
      registry,
      new ToolExecutor(registry),
    )

    const result = await agent.run('hi')

    // Agent catches run failures and surfaces them as a non-success result.
    expect(result.success).toBe(false)
    expect(result.output).toContain('per-call timeout')
  })
})
