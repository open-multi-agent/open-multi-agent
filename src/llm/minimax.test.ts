/**
 * @fileoverview Tests for the MiniMax LLM adapter.
 *
 * Unit tests exercise temperature clamping, message conversion, and response
 * normalisation without making real API calls (the OpenAI client is mocked).
 *
 * Integration tests hit the live MiniMax API and are skipped automatically
 * when MINIMAX_API_KEY is not set.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { MockInstance } from 'vitest'

// ---------------------------------------------------------------------------
// Helpers — re-implement the clamping logic so tests don't import internals
// ---------------------------------------------------------------------------

function clampTemperature(temperature: number | undefined): number | undefined {
  if (temperature === undefined) return undefined
  if (temperature <= 0) return 0.01
  if (temperature > 1.0) return 1.0
  return temperature
}

// ---------------------------------------------------------------------------
// Unit tests — temperature clamping
// ---------------------------------------------------------------------------

describe('clampTemperature', () => {
  it('returns undefined when temperature is undefined', () => {
    expect(clampTemperature(undefined)).toBeUndefined()
  })

  it('clamps 0 to 0.01', () => {
    expect(clampTemperature(0)).toBe(0.01)
  })

  it('clamps negative values to 0.01', () => {
    expect(clampTemperature(-1)).toBe(0.01)
    expect(clampTemperature(-0.5)).toBe(0.01)
  })

  it('clamps values above 1 to 1.0', () => {
    expect(clampTemperature(1.5)).toBe(1.0)
    expect(clampTemperature(2)).toBe(1.0)
  })

  it('passes valid values through unchanged', () => {
    expect(clampTemperature(0.5)).toBe(0.5)
    expect(clampTemperature(0.01)).toBe(0.01)
    expect(clampTemperature(1.0)).toBe(1.0)
    expect(clampTemperature(0.7)).toBe(0.7)
  })
})

// ---------------------------------------------------------------------------
// Unit tests — MiniMaxAdapter (mocked OpenAI client)
// ---------------------------------------------------------------------------

// We mock the openai module before importing MiniMaxAdapter so the adapter
// never creates a real HTTP client.
const mockCreate = vi.fn()

vi.mock('openai', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: mockCreate,
        },
      },
    })),
  }
})

// Import after mocking.
const { MiniMaxAdapter } = await import('./minimax.js')

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** A minimal chat completion response from the MiniMax API. */
function makeCompletion(text: string, model = 'MiniMax-M2.7') {
  return {
    id: 'cmpl-test',
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text, tool_calls: undefined },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }
}

/** A minimal user message. */
function userMsg(text: string) {
  return { role: 'user' as const, content: [{ type: 'text' as const, text }] }
}

// ---------------------------------------------------------------------------
// chat() unit tests
// ---------------------------------------------------------------------------

describe('MiniMaxAdapter.chat()', () => {
  let adapter: InstanceType<typeof MiniMaxAdapter>

  beforeEach(() => {
    mockCreate.mockReset()
    adapter = new MiniMaxAdapter('test-key')
  })

  it('calls the API with the correct model and messages', async () => {
    mockCreate.mockResolvedValue(makeCompletion('hello'))

    const messages = [userMsg('hi')]
    const response = await adapter.chat(messages, { model: 'MiniMax-M2.7' })

    expect(mockCreate).toHaveBeenCalledOnce()
    const call = mockCreate.mock.calls[0]?.[0]
    expect(call.model).toBe('MiniMax-M2.7')
    expect(call.stream).toBe(false)
    expect(response.content[0]).toMatchObject({ type: 'text', text: 'hello' })
  })

  it('clamps temperature=0 to 0.01 before sending', async () => {
    mockCreate.mockResolvedValue(makeCompletion('ok'))
    await adapter.chat([userMsg('hi')], { model: 'MiniMax-M2.7', temperature: 0 })

    const call = mockCreate.mock.calls[0]?.[0]
    expect(call.temperature).toBe(0.01)
  })

  it('clamps temperature=2 to 1.0 before sending', async () => {
    mockCreate.mockResolvedValue(makeCompletion('ok'))
    await adapter.chat([userMsg('hi')], { model: 'MiniMax-M2.7', temperature: 2 })

    const call = mockCreate.mock.calls[0]?.[0]
    expect(call.temperature).toBe(1.0)
  })

  it('omits temperature when not provided', async () => {
    mockCreate.mockResolvedValue(makeCompletion('ok'))
    await adapter.chat([userMsg('hi')], { model: 'MiniMax-M2.7' })

    const call = mockCreate.mock.calls[0]?.[0]
    expect(call.temperature).toBeUndefined()
  })

  it('prepends a system message when systemPrompt is provided', async () => {
    mockCreate.mockResolvedValue(makeCompletion('ok'))
    await adapter.chat([userMsg('hi')], {
      model: 'MiniMax-M2.7',
      systemPrompt: 'Be concise.',
    })

    const call = mockCreate.mock.calls[0]?.[0]
    expect(call.messages[0]).toMatchObject({ role: 'system', content: 'Be concise.' })
    expect(call.messages[1]).toMatchObject({ role: 'user', content: 'hi' })
  })

  it('normalises finish_reason "stop" to "end_turn"', async () => {
    mockCreate.mockResolvedValue(makeCompletion('ok'))
    const response = await adapter.chat([userMsg('hi')], { model: 'MiniMax-M2.7' })
    expect(response.stop_reason).toBe('end_turn')
  })

  it('normalises finish_reason "tool_calls" to "tool_use"', async () => {
    const completion = makeCompletion('')
    completion.choices[0]!.finish_reason = 'tool_calls'
    completion.choices[0]!.message.tool_calls = [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'my_tool', arguments: '{"x":1}' },
      },
    ] as any
    mockCreate.mockResolvedValue(completion)

    const response = await adapter.chat([userMsg('hi')], { model: 'MiniMax-M2.7' })
    expect(response.stop_reason).toBe('tool_use')
    const toolUseBlock = response.content.find((b) => b.type === 'tool_use')
    expect(toolUseBlock).toMatchObject({
      type: 'tool_use',
      name: 'my_tool',
      input: { x: 1 },
    })
  })

  it('returns usage token counts', async () => {
    mockCreate.mockResolvedValue(makeCompletion('ok'))
    const response = await adapter.chat([userMsg('hi')], { model: 'MiniMax-M2.7' })
    expect(response.usage.input_tokens).toBe(10)
    expect(response.usage.output_tokens).toBe(5)
  })

  it('includes tools in the API call when provided', async () => {
    mockCreate.mockResolvedValue(makeCompletion('ok'))
    const tools = [
      {
        name: 'echo',
        description: 'Echo input',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      },
    ]

    await adapter.chat([userMsg('hi')], { model: 'MiniMax-M2.7', tools })
    const call = mockCreate.mock.calls[0]?.[0]
    expect(call.tools).toHaveLength(1)
    expect(call.tools[0].function.name).toBe('echo')
  })

  it('exposes adapter name as "minimax"', () => {
    expect(adapter.name).toBe('minimax')
  })

  it('throws when the API returns no choices', async () => {
    mockCreate.mockResolvedValue({ id: 'x', model: 'MiniMax-M2.7', choices: [], usage: null })
    await expect(
      adapter.chat([userMsg('hi')], { model: 'MiniMax-M2.7' }),
    ).rejects.toThrow('no choices')
  })
})

// ---------------------------------------------------------------------------
// adapter factory unit test
// ---------------------------------------------------------------------------

describe('createAdapter("minimax")', () => {
  it('returns a MiniMaxAdapter instance', async () => {
    const { createAdapter } = await import('./adapter.js')
    const adapter = await createAdapter('minimax', 'test-key')
    expect(adapter.name).toBe('minimax')
  })

  it('throws for an unknown provider', async () => {
    const { createAdapter } = await import('./adapter.js')
    await expect(
      createAdapter('unknown' as any),
    ).rejects.toThrow('Unsupported LLM provider')
  })
})

// ---------------------------------------------------------------------------
// stream() unit tests
// ---------------------------------------------------------------------------

describe('MiniMaxAdapter.stream()', () => {
  let adapter: InstanceType<typeof MiniMaxAdapter>

  beforeEach(() => {
    mockCreate.mockReset()
    adapter = new MiniMaxAdapter('test-key')
  })

  /** Build an async iterable that yields the supplied chunks in order. */
  function makeStream(chunks: object[]) {
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const chunk of chunks) yield chunk
      },
    }
  }

  it('yields text events and a final done event', async () => {
    const chunks = [
      { id: 's1', model: 'MiniMax-M2.7', choices: [{ delta: { content: 'hel' }, finish_reason: null }], usage: null },
      { id: 's1', model: 'MiniMax-M2.7', choices: [{ delta: { content: 'lo' }, finish_reason: null }], usage: null },
      { id: 's1', model: 'MiniMax-M2.7', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 } },
    ]
    mockCreate.mockResolvedValue(makeStream(chunks))

    const events: any[] = []
    for await (const event of adapter.stream([userMsg('hi')], { model: 'MiniMax-M2.7' })) {
      events.push(event)
    }

    const textEvents = events.filter((e) => e.type === 'text')
    const doneEvent = events.find((e) => e.type === 'done')

    expect(textEvents.map((e) => e.data).join('')).toBe('hello')
    expect(doneEvent).toBeDefined()
    expect((doneEvent.data as any).stop_reason).toBe('end_turn')
    expect((doneEvent.data as any).usage.input_tokens).toBe(5)
  })

  it('yields an error event when the API throws', async () => {
    mockCreate.mockRejectedValue(new Error('network failure'))

    const events: any[] = []
    for await (const event of adapter.stream([userMsg('hi')], { model: 'MiniMax-M2.7' })) {
      events.push(event)
    }

    expect(events[0]).toMatchObject({ type: 'error' })
    expect((events[0].data as Error).message).toContain('network failure')
  })

  it('clamps temperature before streaming', async () => {
    const chunks = [
      { id: 's1', model: 'MiniMax-M2.7', choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    ]
    mockCreate.mockResolvedValue(makeStream(chunks))

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of adapter.stream([userMsg('hi')], { model: 'MiniMax-M2.7', temperature: 0 })) {
      // drain
    }

    const call = mockCreate.mock.calls[0]?.[0]
    expect(call.temperature).toBe(0.01)
    expect(call.stream).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Integration tests — run in a separate file (minimax.integration.test.ts)
// to avoid conflicts with the global vi.mock('openai') above.
// ---------------------------------------------------------------------------

describe.skip('MiniMaxAdapter (integration — see minimax.integration.test.ts)', () => {
  it('placeholder', () => { /* no-op */ })
})
