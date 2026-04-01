/**
 * @fileoverview Unit tests for OllamaAdapter.
 *
 * All tests mock `globalThis.fetch` so no real Ollama server is required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OllamaAdapter } from '../src/llm/ollama.js'
import type { LLMMessage } from '../src/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const userMsg = (text: string): LLMMessage => ({
  role: 'user',
  content: [{ type: 'text', text }],
})

function makeNdJsonStream(...chunks: object[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(JSON.stringify(chunk) + '\n'))
      }
      controller.close()
    },
  })
}

function stubFetch(body: unknown, ok = true, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    body: null,
  })
}

function stubStreamingFetch(...chunks: object[]): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    body: makeNdJsonStream(...chunks),
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OllamaAdapter', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // Constructor / base URL
  // -------------------------------------------------------------------------

  describe('constructor', () => {
    it('has name "ollama"', () => {
      expect(new OllamaAdapter().name).toBe('ollama')
    })

    it('strips trailing slash from base URL', async () => {
      const fetcher = stubFetch({
        model: 'qwen2.5',
        created_at: '',
        message: { role: 'assistant', content: 'hi' },
        done: true,
        done_reason: 'stop',
      })
      globalThis.fetch = fetcher

      await new OllamaAdapter('http://localhost:11434/').chat([userMsg('hello')], { model: 'qwen2.5' })

      const url = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
      expect(url).toBe('http://localhost:11434/api/chat')
    })
  })

  // -------------------------------------------------------------------------
  // chat() — text response
  // -------------------------------------------------------------------------

  describe('chat()', () => {
    it('returns a text response', async () => {
      globalThis.fetch = stubFetch({
        model: 'qwen2.5',
        created_at: '',
        message: { role: 'assistant', content: 'Hello, world!' },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 10,
        eval_count: 5,
      })

      const result = await new OllamaAdapter().chat([userMsg('hi')], { model: 'qwen2.5' })

      expect(result.content).toHaveLength(1)
      expect(result.content[0]).toMatchObject({ type: 'text', text: 'Hello, world!' })
      expect(result.model).toBe('qwen2.5')
      expect(result.stop_reason).toBe('end_turn')
      expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 5 })
    })

    it('maps done_reason "tool_calls" to stop_reason "tool_use"', async () => {
      globalThis.fetch = stubFetch({
        model: 'qwen2.5',
        created_at: '',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'my_tool', arguments: { x: 1 } } }],
        },
        done: true,
        done_reason: 'tool_calls',
      })

      const result = await new OllamaAdapter().chat([userMsg('call a tool')], { model: 'qwen2.5' })
      const toolBlock = result.content.find((b) => b.type === 'tool_use')
      expect(toolBlock).toMatchObject({ type: 'tool_use', name: 'my_tool', input: { x: 1 } })
      expect(result.stop_reason).toBe('tool_use')
    })

    it('includes tools in the request body', async () => {
      const fetcher = stubFetch({
        model: 'qwen2.5',
        created_at: '',
        message: { role: 'assistant', content: 'ok' },
        done: true,
        done_reason: 'stop',
      })
      globalThis.fetch = fetcher

      await new OllamaAdapter().chat([userMsg('hi')], {
        model: 'qwen2.5',
        tools: [
          {
            name: 'search',
            description: 'Search the web',
            inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
          },
        ],
      })

      const sent = JSON.parse((fetcher as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string)
      expect(sent.tools).toHaveLength(1)
      expect(sent.tools[0].function.name).toBe('search')
    })

    it('prepends system prompt as a system message', async () => {
      const fetcher = stubFetch({
        model: 'qwen2.5',
        created_at: '',
        message: { role: 'assistant', content: 'reply' },
        done: true,
        done_reason: 'stop',
      })
      globalThis.fetch = fetcher

      await new OllamaAdapter().chat([userMsg('hello')], { model: 'qwen2.5', systemPrompt: 'Be terse.' })

      const sent = JSON.parse((fetcher as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string)
      expect(sent.messages[0]).toEqual({ role: 'system', content: 'Be terse.' })
    })

    it('converts tool_result blocks to tool-role messages', async () => {
      const fetcher = stubFetch({
        model: 'qwen2.5',
        created_at: '',
        message: { role: 'assistant', content: 'done' },
        done: true,
        done_reason: 'stop',
      })
      globalThis.fetch = fetcher

      const messages: LLMMessage[] = [
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'id1', content: 'result data', is_error: false }],
        },
      ]
      await new OllamaAdapter().chat(messages, { model: 'qwen2.5' })

      const sent = JSON.parse((fetcher as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string)
      expect(sent.messages[0]).toMatchObject({ role: 'tool', content: 'result data' })
    })

    it('throws on non-2xx responses', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: () => Promise.resolve('model not found'),
      })

      await expect(
        new OllamaAdapter().chat([userMsg('hi')], { model: 'unknown-model' }),
      ).rejects.toThrow('Ollama API error 404')
    })

    it('handles tool arguments that arrive as a JSON string', async () => {
      globalThis.fetch = stubFetch({
        model: 'qwen2.5',
        created_at: '',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'tool', arguments: '{"key":"value"}' } }],
        },
        done: true,
        done_reason: 'tool_calls',
      })

      const result = await new OllamaAdapter().chat([userMsg('use tool')], { model: 'qwen2.5' })
      const toolBlock = result.content.find((b) => b.type === 'tool_use')
      expect(toolBlock).toMatchObject({ input: { key: 'value' } })
    })
  })

  // -------------------------------------------------------------------------
  // stream()
  // -------------------------------------------------------------------------

  describe('stream()', () => {
    it('yields text events then a done event', async () => {
      globalThis.fetch = stubStreamingFetch(
        { model: 'qwen2.5', message: { role: 'assistant', content: 'Hello' }, done: false },
        { model: 'qwen2.5', message: { role: 'assistant', content: ' world' }, done: false },
        {
          model: 'qwen2.5',
          message: { role: 'assistant', content: '' },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 5,
          eval_count: 3,
        },
      )

      const events = []
      for await (const ev of new OllamaAdapter().stream([userMsg('hi')], { model: 'qwen2.5' })) {
        events.push(ev)
      }

      const textEvents = events.filter((e) => e.type === 'text')
      expect(textEvents).toEqual([
        { type: 'text', data: 'Hello' },
        { type: 'text', data: ' world' },
      ])

      const doneEvent = events.find((e) => e.type === 'done')
      expect(doneEvent).toBeDefined()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((doneEvent as any).data.stop_reason).toBe('end_turn')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((doneEvent as any).data.usage).toEqual({ input_tokens: 5, output_tokens: 3 })
    })

    it('accumulates tool calls and emits tool_use events before done', async () => {
      globalThis.fetch = stubStreamingFetch(
        {
          model: 'qwen2.5',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ function: { name: 'calc', arguments: { op: 'add' } } }],
          },
          done: true,
          done_reason: 'tool_calls',
        },
      )

      const events = []
      for await (const ev of new OllamaAdapter().stream([userMsg('calc')], { model: 'qwen2.5' })) {
        events.push(ev)
      }

      const toolEvents = events.filter((e) => e.type === 'tool_use')
      expect(toolEvents).toHaveLength(1)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((toolEvents[0] as any).data.name).toBe('calc')

      // tool_use event appears before done event
      const toolIdx = events.findIndex((e) => e.type === 'tool_use')
      const doneIdx = events.findIndex((e) => e.type === 'done')
      expect(toolIdx).toBeLessThan(doneIdx)
    })

    it('yields an error event on HTTP failure', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Server Error',
        text: () => Promise.resolve('internal error'),
      })

      const events = []
      for await (const ev of new OllamaAdapter().stream([userMsg('hi')], { model: 'qwen2.5' })) {
        events.push(ev)
      }

      expect(events[0]).toMatchObject({ type: 'error' })
      expect(events).toHaveLength(1)
    })
  })
})
