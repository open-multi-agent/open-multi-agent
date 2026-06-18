import { describe, it, expect, vi, beforeEach } from 'vitest'
import { chatOpts, textMsg, toolDef } from './helpers/llm-fixtures.js'
import type { LLMMessage } from '../src/types.js'

// ---------------------------------------------------------------------------
// Mock OpenAI constructor (must be hoisted for Vitest)
// ---------------------------------------------------------------------------
const createCompletionMock = vi.hoisted(() => vi.fn())
const OpenAIMock = vi.hoisted(() => vi.fn())

vi.mock('openai', () => ({
  default: OpenAIMock,
}))

import { MiMoAdapter } from '../src/llm/mimo.js'
import { createAdapter } from '../src/llm/adapter.js'

// ---------------------------------------------------------------------------
// MiMoAdapter tests
// ---------------------------------------------------------------------------

describe('MiMoAdapter', () => {
  beforeEach(() => {
    OpenAIMock.mockClear()
    createCompletionMock.mockClear()
    OpenAIMock.mockImplementation(() => ({
      chat: { completions: { create: createCompletionMock } },
    }))
  })

  it('has name "mimo"', () => {
    const adapter = new MiMoAdapter()
    expect(adapter.name).toBe('mimo')
  })

  it('uses MIMO_API_KEY by default', () => {
    const original = process.env['MIMO_API_KEY']
    process.env['MIMO_API_KEY'] = 'mimo-test-key-123'

    try {
      new MiMoAdapter()
      expect(OpenAIMock).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'mimo-test-key-123',
          baseURL: 'https://api.xiaomimimo.com/v1',
        })
      )
    } finally {
      if (original === undefined) {
        delete process.env['MIMO_API_KEY']
      } else {
        process.env['MIMO_API_KEY'] = original
      }
    }
  })

  it('uses official MiMo pay-as-you-go baseURL by default', () => {
    new MiMoAdapter('some-key')
    expect(OpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'some-key',
        baseURL: 'https://api.xiaomimimo.com/v1',
      })
    )
  })

  it('allows MIMO_BASE_URL to select a Token Plan cluster', () => {
    const original = process.env['MIMO_BASE_URL']
    process.env['MIMO_BASE_URL'] = 'https://token-plan-cn.xiaomimimo.com/v1'

    try {
      new MiMoAdapter('some-key')
      expect(OpenAIMock).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'some-key',
          baseURL: 'https://token-plan-cn.xiaomimimo.com/v1',
        })
      )
    } finally {
      if (original === undefined) {
        delete process.env['MIMO_BASE_URL']
      } else {
        process.env['MIMO_BASE_URL'] = original
      }
    }
  })

  it('allows overriding apiKey and baseURL', () => {
    new MiMoAdapter('custom-key', 'https://custom.endpoint/v1')
    expect(OpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'custom-key',
        baseURL: 'https://custom.endpoint/v1',
      })
    )
  })

  it('createAdapter("mimo") returns MiMoAdapter instance', async () => {
    const adapter = await createAdapter('mimo')
    expect(adapter).toBeInstanceOf(MiMoAdapter)
  })

  it('parses OpenAI-format tool_calls in chat responses', async () => {
    createCompletionMock.mockResolvedValue({
      id: 'chatcmpl-mimo-tool',
      model: 'mimo-v2.5-pro',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'search', arguments: '{"query":"test"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    })

    const adapter = new MiMoAdapter('mimo-key')
    const result = await adapter.chat(
      [textMsg('user', 'Search for test')],
      chatOpts({ tools: [toolDef('search')] }),
    )

    expect(result.content[0]).toEqual({
      type: 'tool_use',
      id: 'call_1',
      name: 'search',
      input: { query: 'test' },
    })
    expect(result.stop_reason).toBe('tool_use')
  })

  it('stamps provenance "mimo" on extracted ReasoningBlocks', async () => {
    createCompletionMock.mockResolvedValue({
      id: 'chatcmpl-mimo-reasoning',
      model: 'mimo-v2.5-pro',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'Answer.',
          reasoning_content: 'plan first',
          tool_calls: undefined,
        },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    })

    const adapter = new MiMoAdapter('mimo-key')
    const result = await adapter.chat([textMsg('user', 'Hi')], chatOpts())

    expect(result.content[0]).toEqual({
      type: 'reasoning',
      text: 'plan first',
      provenance: 'mimo',
    })
  })

  it('echoes reasoning_content on MiMo tool-calling conversations', async () => {
    createCompletionMock.mockResolvedValueOnce({
      id: 'chatcmpl-mimo-echo',
      model: 'mimo-v2.5-pro',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'Answer.', tool_calls: undefined },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    })

    const messages: LLMMessage[] = [
      textMsg('user', 'Search for foo'),
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'I will use the search tool.', provenance: 'mimo' },
          { type: 'tool_use', id: 'call_1', name: 'search', input: { query: 'foo' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '[results]' }],
      },
    ]

    const adapter = new MiMoAdapter('mimo-key')
    await adapter.chat(messages, chatOpts({ tools: [toolDef('search')] }))

    const sentMessages = createCompletionMock.mock.calls[0][0].messages as Array<Record<string, unknown>>
    const assistant = sentMessages.find((m) => m['role'] === 'assistant')
    expect(assistant?.['tool_calls']).toBeDefined()
    expect(assistant?.['reasoning_content']).toBe('I will use the search tool.')
  })

  it('does not echo reasoning_content in pure text conversations', async () => {
    createCompletionMock.mockResolvedValueOnce({
      id: 'chatcmpl-mimo-text',
      model: 'mimo-v2.5-pro',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'Sure.', tool_calls: undefined },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    })

    const messages: LLMMessage[] = [
      textMsg('user', 'Hi'),
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Just acknowledge.', provenance: 'mimo' },
          { type: 'text', text: 'Hello!' },
        ],
      },
      textMsg('user', 'Now respond again.'),
    ]

    const adapter = new MiMoAdapter('mimo-key')
    await adapter.chat(messages, chatOpts())

    const sentMessages = createCompletionMock.mock.calls[0][0].messages as Array<Record<string, unknown>>
    const assistant = sentMessages.find((m) => m['role'] === 'assistant')
    expect(assistant?.['tool_calls']).toBeUndefined()
    expect(assistant?.['reasoning_content']).toBeUndefined()
    expect(assistant?.['content']).toBe('Hello!')
  })
})
