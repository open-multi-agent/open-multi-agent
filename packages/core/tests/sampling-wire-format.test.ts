import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { LLMMessage } from '../src/types.js'

const { mockOpenAICreate } = vi.hoisted(() => ({
  mockOpenAICreate: vi.fn(),
}))

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: mockOpenAICreate } },
  })),
}))

const { mockAnthropicCreate } = vi.hoisted(() => ({
  mockAnthropicCreate: vi.fn(),
}))

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockAnthropicCreate },
  })),
}))

// Imports happen after vi.mock so the mocked modules are picked up.
const { OpenAIAdapter } = await import('../src/llm/openai.js')
const { AnthropicAdapter } = await import('../src/llm/anthropic.js')

const userMessage: LLMMessage = {
  role: 'user',
  content: [{ type: 'text', text: 'hi' }],
}

const okOpenAIResponse = {
  id: 'r1',
  choices: [
    {
      index: 0,
      message: { role: 'assistant' as const, content: 'ok' },
      finish_reason: 'stop' as const,
    },
  ],
  model: 'gpt-test',
  usage: { prompt_tokens: 1, completion_tokens: 1 },
  created: 0,
  object: 'chat.completion' as const,
}

const okAnthropicResponse = {
  id: 'r1',
  content: [{ type: 'text' as const, text: 'ok' }],
  model: 'claude-test',
  role: 'assistant' as const,
  stop_reason: 'end_turn' as const,
  type: 'message' as const,
  usage: { input_tokens: 1, output_tokens: 1 },
}

beforeEach(() => {
  mockOpenAICreate.mockReset()
  mockAnthropicCreate.mockReset()
})

describe('OpenAI adapter wire format', () => {
  it('writes top_k, min_p, frequency_penalty, presence_penalty, top_p into the chat completions payload', async () => {
    mockOpenAICreate.mockResolvedValueOnce(okOpenAIResponse)

    const adapter = new OpenAIAdapter('test-key')
    await adapter.chat([userMessage], {
      model: 'gpt-test',
      maxTokens: 100,
      temperature: 0.7,
      topP: 0.9,
      topK: 40,
      minP: 0.05,
      frequencyPenalty: 1.2,
      presencePenalty: 0.5,
      extraBody: { repetition_penalty: 1.1 },
    })

    expect(mockOpenAICreate).toHaveBeenCalledTimes(1)
    const body = mockOpenAICreate.mock.calls[0]?.[0] as Record<string, unknown>
    expect(body['top_p']).toBe(0.9)
    expect(body['top_k']).toBe(40)
    expect(body['min_p']).toBe(0.05)
    expect(body['frequency_penalty']).toBe(1.2)
    expect(body['presence_penalty']).toBe(0.5)
    expect(body['repetition_penalty']).toBe(1.1)
    expect(body['temperature']).toBe(0.7)
    expect(body['max_tokens']).toBe(100)
    expect(body['model']).toBe('gpt-test')
    expect(body['stream']).toBe(false)
  })

  it('forwards parallelToolCalls=false as parallel_tool_calls in the chat payload', async () => {
    mockOpenAICreate.mockResolvedValueOnce(okOpenAIResponse)

    const adapter = new OpenAIAdapter('test-key')
    await adapter.chat([userMessage], {
      model: 'gpt-test',
      parallelToolCalls: false,
    })

    const body = mockOpenAICreate.mock.calls[0]?.[0] as Record<string, unknown>
    expect(body['parallel_tool_calls']).toBe(false)
  })

  it('forwards parallelToolCalls=true as parallel_tool_calls in the chat payload', async () => {
    mockOpenAICreate.mockResolvedValueOnce(okOpenAIResponse)

    const adapter = new OpenAIAdapter('test-key')
    await adapter.chat([userMessage], {
      model: 'gpt-test',
      parallelToolCalls: true,
    })

    const body = mockOpenAICreate.mock.calls[0]?.[0] as Record<string, unknown>
    expect(body['parallel_tool_calls']).toBe(true)
  })

  it('omits parallel_tool_calls when parallelToolCalls is undefined', async () => {
    mockOpenAICreate.mockResolvedValueOnce(okOpenAIResponse)

    const adapter = new OpenAIAdapter('test-key')
    await adapter.chat([userMessage], { model: 'gpt-test' })

    const body = mockOpenAICreate.mock.calls[0]?.[0] as Record<string, unknown>
    expect(body['parallel_tool_calls']).toBeUndefined()
  })

  it('refuses to let extraBody override transport-level fields (model, stream)', async () => {
    mockOpenAICreate.mockResolvedValueOnce(okOpenAIResponse)

    const adapter = new OpenAIAdapter('test-key')
    await adapter.chat([userMessage], {
      model: 'real-model',
      extraBody: { model: 'evil-override', stream: true },
    })

    const body = mockOpenAICreate.mock.calls[0]?.[0] as Record<string, unknown>
    expect(body['model']).toBe('real-model')
    expect(body['stream']).toBe(false)
  })

  it('lets extraBody override sampling defaults like temperature', async () => {
    mockOpenAICreate.mockResolvedValueOnce(okOpenAIResponse)

    const adapter = new OpenAIAdapter('test-key')
    await adapter.chat([userMessage], {
      model: 'm',
      temperature: 0.5,
      extraBody: { temperature: 0.99 },
    })

    const body = mockOpenAICreate.mock.calls[0]?.[0] as Record<string, unknown>
    expect(body['temperature']).toBe(0.99)
  })
})

describe('Anthropic adapter wire format', () => {
  it('writes top_p, top_k, temperature, max_tokens into the messages payload', async () => {
    mockAnthropicCreate.mockResolvedValueOnce(okAnthropicResponse)

    const adapter = new AnthropicAdapter('test-key')
    await adapter.chat([userMessage], {
      model: 'claude-test',
      maxTokens: 200,
      temperature: 0.6,
      topP: 0.85,
      topK: 25,
      extraBody: { metadata: { user_id: 'u1' } },
    })

    expect(mockAnthropicCreate).toHaveBeenCalledTimes(1)
    const body = mockAnthropicCreate.mock.calls[0]?.[0] as Record<string, unknown>
    expect(body['top_p']).toBe(0.85)
    expect(body['top_k']).toBe(25)
    expect(body['temperature']).toBe(0.6)
    expect(body['max_tokens']).toBe(200)
    expect(body['metadata']).toEqual({ user_id: 'u1' })
    expect(body['model']).toBe('claude-test')
  })

  it('refuses to let extraBody override transport-level fields (model)', async () => {
    mockAnthropicCreate.mockResolvedValueOnce(okAnthropicResponse)

    const adapter = new AnthropicAdapter('test-key')
    await adapter.chat([userMessage], {
      model: 'claude-real',
      extraBody: { model: 'evil-override' },
    })

    const body = mockAnthropicCreate.mock.calls[0]?.[0] as Record<string, unknown>
    expect(body['model']).toBe('claude-real')
  })
})
