/**
 * Targeted tests for abort signal propagation fixes (#99, #100, #101).
 *
 * - #99:  Per-call abortSignal must reach tool execution context
 * - #100: Abort path in executeQueue must skip blocked tasks and emit events
 * - #101: Gemini adapter must forward abortSignal to the SDK
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AgentRunner } from '../src/agent/runner.js'
import { ToolRegistry, defineTool } from '../src/tool/framework.js'
import { ToolExecutor } from '../src/tool/executor.js'
import { TaskQueue } from '../src/task/queue.js'
import { createTask } from '../src/task/task.js'
import { z } from 'zod'
import type { LLMAdapter, LLMMessage, ToolUseContext } from '../src/types.js'

// ---------------------------------------------------------------------------
// #99 — Per-call abortSignal propagated to tool context
// ---------------------------------------------------------------------------

describe('Per-call abortSignal reaches tool context (#99)', () => {
  it('tool receives per-call abortSignal, not static runner signal', async () => {
    // Track the abortSignal passed to the tool
    let receivedSignal: AbortSignal | undefined

    const spy = defineTool({
      name: 'spy',
      description: 'Captures the abort signal from context.',
      inputSchema: z.object({}),
      execute: async (_input, context) => {
        receivedSignal = context.abortSignal
        return { data: 'ok', isError: false }
      },
    })

    const registry = new ToolRegistry()
    registry.register(spy)
    const executor = new ToolExecutor(registry)

    // Adapter returns one tool_use then end_turn
    const adapter: LLMAdapter = {
      name: 'mock',
      chat: vi.fn()
        .mockResolvedValueOnce({
          id: '1',
          content: [{ type: 'tool_use', id: 'call-1', name: 'spy', input: {} }],
          model: 'mock',
          stop_reason: 'tool_use',
          usage: { input_tokens: 0, output_tokens: 0 },
        })
        .mockResolvedValueOnce({
          id: '2',
          content: [{ type: 'text', text: 'done' }],
          model: 'mock',
          stop_reason: 'end_turn',
          usage: { input_tokens: 0, output_tokens: 0 },
        }),
      async *stream() { /* unused */ },
    }

    const perCallController = new AbortController()

    // Runner created WITHOUT a static abortSignal
    const runner = new AgentRunner(adapter, registry, executor, {
      model: 'mock',
      agentName: 'test',
      allowedTools: ['spy'],
    })

    const messages: LLMMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
    ]

    await runner.run(messages, { abortSignal: perCallController.signal })

    // The tool must have received the per-call signal, not undefined
    expect(receivedSignal).toBe(perCallController.signal)
  })

  it('tool receives static signal when no per-call signal is provided', async () => {
    let receivedSignal: AbortSignal | undefined

    const spy = defineTool({
      name: 'spy',
      description: 'Captures the abort signal from context.',
      inputSchema: z.object({}),
      execute: async (_input, context) => {
        receivedSignal = context.abortSignal
        return { data: 'ok', isError: false }
      },
    })

    const registry = new ToolRegistry()
    registry.register(spy)
    const executor = new ToolExecutor(registry)

    const staticController = new AbortController()

    const adapter: LLMAdapter = {
      name: 'mock',
      chat: vi.fn()
        .mockResolvedValueOnce({
          id: '1',
          content: [{ type: 'tool_use', id: 'call-1', name: 'spy', input: {} }],
          model: 'mock',
          stop_reason: 'tool_use',
          usage: { input_tokens: 0, output_tokens: 0 },
        })
        .mockResolvedValueOnce({
          id: '2',
          content: [{ type: 'text', text: 'done' }],
          model: 'mock',
          stop_reason: 'end_turn',
          usage: { input_tokens: 0, output_tokens: 0 },
        }),
      async *stream() { /* unused */ },
    }

    // Runner created WITH a static abortSignal, no per-call signal
    const runner = new AgentRunner(adapter, registry, executor, {
      model: 'mock',
      agentName: 'test',
      abortSignal: staticController.signal,
      allowedTools: ['spy'],
    })

    const messages: LLMMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
    ]

    await runner.run(messages)

    expect(receivedSignal).toBe(staticController.signal)
  })
})

// ---------------------------------------------------------------------------
// #100 — Abort path skips blocked tasks and emits events
// ---------------------------------------------------------------------------

describe('Abort path skips blocked tasks and emits events (#100)', () => {
  function task(id: string, opts: { dependsOn?: string[]; assignee?: string } = {}) {
    const t = createTask({ title: id, description: `task ${id}`, assignee: opts.assignee })
    return { ...t, id, dependsOn: opts.dependsOn } as ReturnType<typeof createTask>
  }

  it('skipRemaining transitions blocked tasks to skipped', () => {
    const q = new TaskQueue()
    q.add(task('a'))
    q.add(task('b', { dependsOn: ['a'] }))

    // 'b' should be blocked because it depends on 'a'
    expect(q.getByStatus('blocked').length).toBe(1)

    q.skipRemaining('Skipped: run aborted.')

    // Both tasks should be skipped — including the blocked one
    const all = q.list()
    expect(all.every(t => t.status === 'skipped')).toBe(true)
    expect(q.getByStatus('blocked').length).toBe(0)
  })

  it('skipRemaining emits task:skipped for every non-terminal task', () => {
    const q = new TaskQueue()
    q.add(task('a'))
    q.add(task('b', { dependsOn: ['a'] }))

    const handler = vi.fn()
    q.on('task:skipped', handler)

    q.skipRemaining('Skipped: run aborted.')

    // Both pending 'a' and blocked 'b' must trigger events
    expect(handler).toHaveBeenCalledTimes(2)
    const ids = handler.mock.calls.map((c: any[]) => c[0].id)
    expect(ids).toContain('a')
    expect(ids).toContain('b')
  })

  it('skipRemaining fires all:complete after skipping', () => {
    const q = new TaskQueue()
    q.add(task('a'))
    q.add(task('b', { dependsOn: ['a'] }))

    const completeHandler = vi.fn()
    q.on('all:complete', completeHandler)

    q.skipRemaining('Skipped: run aborted.')

    expect(completeHandler).toHaveBeenCalledTimes(1)
    expect(q.isComplete()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// #101 — Gemini adapter forwards abortSignal to SDK config
// ---------------------------------------------------------------------------

const mockGenerateContent = vi.hoisted(() => vi.fn())
const mockGenerateContentStream = vi.hoisted(() => vi.fn())
const GoogleGenAIMock = vi.hoisted(() =>
  vi.fn(() => ({
    models: {
      generateContent: mockGenerateContent,
      generateContentStream: mockGenerateContentStream,
    },
  })),
)

vi.mock('@google/genai', () => ({
  GoogleGenAI: GoogleGenAIMock,
  FunctionCallingConfigMode: { AUTO: 'AUTO' },
}))

import { GeminiAdapter } from '../src/llm/gemini.js'

describe('Gemini adapter forwards abortSignal (#101)', () => {
  let adapter: GeminiAdapter

  function makeGeminiResponse(parts: Array<Record<string, unknown>>) {
    return {
      candidates: [{
        content: { parts },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    }
  }

  async function* asyncGen<T>(items: T[]): AsyncGenerator<T> {
    for (const item of items) yield item
  }

  beforeEach(() => {
    vi.clearAllMocks()
    adapter = new GeminiAdapter('test-key')
  })

  it('chat() passes abortSignal in config', async () => {
    mockGenerateContent.mockResolvedValue(makeGeminiResponse([{ text: 'hi' }]))

    const controller = new AbortController()
    await adapter.chat(
      [{ role: 'user', content: [{ type: 'text' as const, text: 'hello' }] }],
      { model: 'gemini-2.5-flash', abortSignal: controller.signal },
    )

    const callArgs = mockGenerateContent.mock.calls[0][0]
    expect(callArgs.config.abortSignal).toBe(controller.signal)
  })

  it('chat() does not include abortSignal when not provided', async () => {
    mockGenerateContent.mockResolvedValue(makeGeminiResponse([{ text: 'hi' }]))

    await adapter.chat(
      [{ role: 'user', content: [{ type: 'text' as const, text: 'hello' }] }],
      { model: 'gemini-2.5-flash' },
    )

    const callArgs = mockGenerateContent.mock.calls[0][0]
    expect(callArgs.config.abortSignal).toBeUndefined()
  })

  it('stream() passes abortSignal in config', async () => {
    const chunk = makeGeminiResponse([{ text: 'hi' }])
    mockGenerateContentStream.mockResolvedValue(asyncGen([chunk]))

    const controller = new AbortController()
    const events: unknown[] = []
    for await (const e of adapter.stream(
      [{ role: 'user', content: [{ type: 'text' as const, text: 'hello' }] }],
      { model: 'gemini-2.5-flash', abortSignal: controller.signal },
    )) {
      events.push(e)
    }

    const callArgs = mockGenerateContentStream.mock.calls[0][0]
    expect(callArgs.config.abortSignal).toBe(controller.signal)
  })
})
