import { afterEach, describe, expect, it, vi } from 'vitest'
import { OllamaAdapter } from './ollama.js'
import { createAdapter } from './adapter.js'

const encoder = new TextEncoder()

function createFetchMock(response: unknown): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => response,
    text: async () => JSON.stringify(response),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close()
      },
    }),
  }))
}

describe('OllamaAdapter', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('creates an Ollama adapter through createAdapter()', async () => {
    const adapter = await createAdapter('ollama')
    expect(adapter.name).toBe('ollama')
  })

  it('sends chat requests to the local Ollama endpoint', async () => {
    const adapter = new OllamaAdapter(undefined, 'http://localhost:11434')
    const mockResponse = {
      id: 'abc123',
      model: 'qwen',
      choices: [
        {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'hello' }],
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 2,
      },
    }

    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => mockResponse,
      text: async () => JSON.stringify(mockResponse),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close()
        },
      }),
    }))

    vi.stubGlobal('fetch', fetchMock)

    const result = await adapter.chat(
      [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
      { model: 'qwen' },
    )

    expect(fetchMock).toHaveBeenCalledOnce()
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('POST')
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(typeof init?.body).toBe('string')
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'qwen',
    })
    expect(result.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(result.model).toBe('qwen')
  })

  it('parses streaming-style chat responses and ignores final empty chunks', async () => {
    const adapter = new OllamaAdapter(undefined, 'http://localhost:11434')
    const chunk = '{"model":"llama2","message":{"role":"assistant","content":"Hello"}}\n'
      + '{"model":"llama2","message":{"role":"assistant","content":""}}\n'

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => chunk,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close()
        },
      }),
    }))

    vi.stubGlobal('fetch', fetchMock)

    const result = await adapter.chat(
      [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
      { model: 'llama2' },
    )

    expect(result.content).toEqual([{ type: 'text', text: 'Hello' }])
    expect(result.model).toBe('llama2')
  })

  it('streams SSE events from Ollama and emits done', async () => {
    const adapter = new OllamaAdapter(undefined, 'http://localhost:11434')
    const chunk = `data: {"choices":[{"delta":{"content":"hi"}}]}\n\n` +
      `data: [DONE]\n\n`

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => chunk,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(chunk))
          controller.close()
        },
      }),
    }))

    vi.stubGlobal('fetch', fetchMock)

    const events = [] as Array<unknown>
    for await (const event of adapter.stream(
      [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
      { model: 'qwen' },
    )) {
      events.push(event)
    }

    expect(events.length).toBeGreaterThanOrEqual(2)
    expect(events[0]).toEqual({ type: 'text', data: 'hi' })
    expect((events[events.length - 1] as any).type).toBe('done')
  })
})
