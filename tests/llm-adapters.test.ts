import { describe, it, expect, vi } from 'vitest'
import { createAdapter } from '../src/llm/adapter.js'
import {
  toOpenAITool,
  toOpenAIMessages,
  fromOpenAICompletion,
  normalizeFinishReason,
  buildOpenAIMessageList,
} from '../src/llm/openai-common.js'
import type {
  ContentBlock,
  LLMMessage,
  LLMToolDef,
} from '../src/types.js'
import type { ChatCompletion } from 'openai/resources/chat/completions/index.js'

// ===========================================================================
// createAdapter factory
// ===========================================================================

describe('createAdapter', () => {
  it('creates an anthropic adapter', async () => {
    const adapter = await createAdapter('anthropic', 'test-key')
    expect(adapter.name).toBe('anthropic')
  })

  it('creates an openai adapter', async () => {
    const adapter = await createAdapter('openai', 'test-key')
    expect(adapter.name).toBe('openai')
  })

  it('creates a grok adapter', async () => {
    const adapter = await createAdapter('grok', 'test-key')
    expect(adapter.name).toBe('grok')
  })

  it('creates a gemini adapter', async () => {
    const adapter = await createAdapter('gemini', 'test-key')
    expect(adapter.name).toBe('gemini')
  })

  it('throws on unknown provider', async () => {
    await expect(
      createAdapter('unknown' as any, 'test-key'),
    ).rejects.toThrow('Unsupported')
  })
})

// ===========================================================================
// OpenAI common helpers
// ===========================================================================

describe('normalizeFinishReason', () => {
  it('maps stop → end_turn', () => {
    expect(normalizeFinishReason('stop')).toBe('end_turn')
  })

  it('maps tool_calls → tool_use', () => {
    expect(normalizeFinishReason('tool_calls')).toBe('tool_use')
  })

  it('maps length → max_tokens', () => {
    expect(normalizeFinishReason('length')).toBe('max_tokens')
  })

  it('maps content_filter → content_filter', () => {
    expect(normalizeFinishReason('content_filter')).toBe('content_filter')
  })

  it('passes through unknown reasons', () => {
    expect(normalizeFinishReason('custom_reason')).toBe('custom_reason')
  })
})

describe('toOpenAITool', () => {
  it('converts framework tool def to OpenAI format', () => {
    const tool: LLMToolDef = {
      name: 'search',
      description: 'Search the web',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
      },
    }

    const result = toOpenAITool(tool)

    expect(result.type).toBe('function')
    expect(result.function.name).toBe('search')
    expect(result.function.description).toBe('Search the web')
    expect(result.function.parameters).toEqual(tool.inputSchema)
  })
})

describe('toOpenAIMessages', () => {
  it('converts a simple user text message', () => {
    const msgs: LLMMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ]

    const result = toOpenAIMessages(msgs)

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ role: 'user', content: 'hello' })
  })

  it('converts assistant message with text', () => {
    const msgs: LLMMessage[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ]

    const result = toOpenAIMessages(msgs)

    expect(result[0]).toEqual({ role: 'assistant', content: 'hi', tool_calls: undefined })
  })

  it('converts assistant message with tool_use into tool_calls', () => {
    const msgs: LLMMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tc1', name: 'search', input: { query: 'AI' } },
        ],
      },
    ]

    const result = toOpenAIMessages(msgs)

    expect(result).toHaveLength(1)
    const msg = result[0]! as any
    expect(msg.role).toBe('assistant')
    expect(msg.tool_calls).toHaveLength(1)
    expect(msg.tool_calls[0].function.name).toBe('search')
  })

  it('splits tool_result blocks into separate tool-role messages', () => {
    const msgs: LLMMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tc1', content: 'result data' },
        ],
      },
    ]

    const result = toOpenAIMessages(msgs)

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      role: 'tool',
      tool_call_id: 'tc1',
      content: 'result data',
    })
  })

  it('handles mixed user message with text and tool_result', () => {
    const msgs: LLMMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'context' },
          { type: 'tool_result', tool_use_id: 'tc1', content: 'data' },
        ],
      },
    ]

    const result = toOpenAIMessages(msgs)

    // Should produce a user message for text, then a tool message for result
    expect(result.length).toBeGreaterThanOrEqual(2)
    expect(result[0]).toEqual({ role: 'user', content: 'context' })
    expect(result[1]).toEqual({
      role: 'tool',
      tool_call_id: 'tc1',
      content: 'data',
    })
  })

  it('handles image blocks in user messages', () => {
    const msgs: LLMMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe this' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'abc123' },
          },
        ],
      },
    ]

    const result = toOpenAIMessages(msgs)

    expect(result).toHaveLength(1)
    const content = (result[0] as any).content
    expect(content).toHaveLength(2)
    expect(content[1].type).toBe('image_url')
    expect(content[1].image_url.url).toContain('data:image/png;base64,abc123')
  })
})

describe('fromOpenAICompletion', () => {
  function makeCompletion(overrides?: Partial<ChatCompletion>): ChatCompletion {
    return {
      id: 'comp-1',
      object: 'chat.completion',
      created: Date.now(),
      model: 'gpt-4',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Hello!', refusal: null },
          finish_reason: 'stop',
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      ...overrides,
    }
  }

  it('converts a simple text completion', () => {
    const result = fromOpenAICompletion(makeCompletion())

    expect(result.id).toBe('comp-1')
    expect(result.model).toBe('gpt-4')
    expect(result.stop_reason).toBe('end_turn') // 'stop' → 'end_turn'
    expect(result.content).toHaveLength(1)
    expect(result.content[0]).toEqual({ type: 'text', text: 'Hello!' })
    expect(result.usage.input_tokens).toBe(10)
    expect(result.usage.output_tokens).toBe(20)
  })

  it('converts tool_calls into tool_use blocks', () => {
    const completion = makeCompletion({
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            refusal: null,
            tool_calls: [
              {
                id: 'tc1',
                type: 'function',
                function: {
                  name: 'search',
                  arguments: '{"query":"test"}',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
          logprobs: null,
        },
      ],
    })

    const result = fromOpenAICompletion(completion)

    expect(result.stop_reason).toBe('tool_use')
    expect(result.content).toHaveLength(1)
    expect(result.content[0]).toEqual({
      type: 'tool_use',
      id: 'tc1',
      name: 'search',
      input: { query: 'test' },
    })
  })

  it('throws when completion has no choices', () => {
    const completion = makeCompletion({ choices: [] })
    expect(() => fromOpenAICompletion(completion)).toThrow('no choices')
  })

  it('handles malformed tool arguments gracefully', () => {
    const completion = makeCompletion({
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            refusal: null,
            tool_calls: [
              {
                id: 'tc1',
                type: 'function',
                function: {
                  name: 'search',
                  arguments: 'not-valid-json',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
          logprobs: null,
        },
      ],
    })

    const result = fromOpenAICompletion(completion)

    // Should not throw; input defaults to {}
    expect(result.content[0]).toEqual({
      type: 'tool_use',
      id: 'tc1',
      name: 'search',
      input: {},
    })
  })

  it('handles missing usage gracefully', () => {
    const completion = makeCompletion({ usage: undefined })

    const result = fromOpenAICompletion(completion)

    expect(result.usage.input_tokens).toBe(0)
    expect(result.usage.output_tokens).toBe(0)
  })
})

describe('buildOpenAIMessageList', () => {
  it('prepends system prompt when provided', () => {
    const msgs: LLMMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ]

    const result = buildOpenAIMessageList(msgs, 'You are helpful.')

    expect(result[0]).toEqual({ role: 'system', content: 'You are helpful.' })
    expect(result).toHaveLength(2)
  })

  it('omits system message when systemPrompt is undefined', () => {
    const msgs: LLMMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ]

    const result = buildOpenAIMessageList(msgs, undefined)

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ role: 'user', content: 'hi' })
  })

  it('omits system message when systemPrompt is empty string', () => {
    const msgs: LLMMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ]

    const result = buildOpenAIMessageList(msgs, '')

    expect(result).toHaveLength(1)
  })
})
