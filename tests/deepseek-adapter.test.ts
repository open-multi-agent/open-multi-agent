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

import { DeepSeekAdapter } from '../src/llm/deepseek.js'
import { createAdapter } from '../src/llm/adapter.js'

// ---------------------------------------------------------------------------
// DeepSeekAdapter tests
// ---------------------------------------------------------------------------

describe('DeepSeekAdapter', () => {
  beforeEach(() => {
    OpenAIMock.mockClear()
    createCompletionMock.mockClear()
    OpenAIMock.mockImplementation(() => ({
      chat: { completions: { create: createCompletionMock } },
    }))
  })

  it('has name "deepseek"', () => {
    const adapter = new DeepSeekAdapter()
    expect(adapter.name).toBe('deepseek')
  })

  it('uses DEEPSEEK_API_KEY by default', () => {
    const original = process.env['DEEPSEEK_API_KEY']
    process.env['DEEPSEEK_API_KEY'] = 'deepseek-test-key-123'

    try {
      new DeepSeekAdapter()
      expect(OpenAIMock).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'deepseek-test-key-123',
          baseURL: 'https://api.deepseek.com/v1',
        })
      )
    } finally {
      if (original === undefined) {
        delete process.env['DEEPSEEK_API_KEY']
      } else {
        process.env['DEEPSEEK_API_KEY'] = original
      }
    }
  })

  it('uses official DeepSeek baseURL by default', () => {
    new DeepSeekAdapter('some-key')
    expect(OpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'some-key',
        baseURL: 'https://api.deepseek.com/v1',
      })
    )
  })

  it('allows overriding apiKey and baseURL', () => {
    new DeepSeekAdapter('custom-key', 'https://custom.endpoint/v1')
    expect(OpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'custom-key',
        baseURL: 'https://custom.endpoint/v1',
      })
    )
  })

  it('createAdapter("deepseek") returns DeepSeekAdapter instance', async () => {
    const adapter = await createAdapter('deepseek')
    expect(adapter).toBeInstanceOf(DeepSeekAdapter)
  })

  // ---------------------------------------------------------------------------
  // Phase 1 of #223 — subclass-of-OpenAIAdapter provenance flow
  // ---------------------------------------------------------------------------
  //
  // OpenAIAdapter.chat() calls fromOpenAICompletion(..., this.name). Subclasses
  // inherit chat() and override `name`, so `this.name` must resolve to the
  // subclass value at runtime. This test acts as the canary for the inheritance
  // mechanism — if it stamps 'deepseek' rather than the parent's 'openai', the
  // same code path validates grok / qiniu / minimax (which all use the same
  // inherited chat()).
  it('stamps provenance: "deepseek" (not parent "openai") on extracted ReasoningBlocks', async () => {
    createCompletionMock.mockResolvedValue({
      id: 'chatcmpl-ds',
      model: 'deepseek-v4-pro',
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

    const adapter = new DeepSeekAdapter('deepseek-key')
    const result = await adapter.chat([textMsg('user', 'Hi')], chatOpts())

    expect(result.content[0]).toEqual({
      type: 'reasoning',
      text: 'plan first',
      provenance: 'deepseek',
    })
  })

  // ---------------------------------------------------------------------------
  // reasoning_content passback (DeepSeek V4 thinking mode)
  //
  // Per https://api-docs.deepseek.com/zh-cn/guides/thinking_mode, follow-up
  // requests that include a prior tool-use assistant turn MUST echo
  // `reasoning_content` back. Omitting it returns 400.
  // ---------------------------------------------------------------------------
  describe('reasoning_content echo on tool-use turns', () => {
    function getAssistantMessage(callIndex = 0): Record<string, unknown> {
      const call = createCompletionMock.mock.calls[callIndex]
      if (call === undefined) throw new Error(`no mock call at index ${callIndex}`)
      const messages = call[0].messages as Array<Record<string, unknown>>
      const assistant = messages.find((m) => m['role'] === 'assistant')
      if (assistant === undefined) throw new Error('no assistant message found in request')
      return assistant
    }

    it('echoes reasoning_content on assistant messages that contain tool_calls', async () => {
      // The agent runner's typical flow: turn 1 yields reasoning + tool_use;
      // tools execute; turn 2 sends back the assistant + tool_result and the
      // model returns its final answer.
      createCompletionMock.mockResolvedValueOnce({
        id: 'chatcmpl-ds-2',
        model: 'deepseek-v4-pro',
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
            { type: 'reasoning', text: 'I will use the search tool.', provenance: 'deepseek' },
            { type: 'tool_use', id: 'call_1', name: 'search', input: { q: 'foo' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '[results]' }],
        },
      ]

      const adapter = new DeepSeekAdapter('deepseek-key')
      await adapter.chat(messages, chatOpts({ tools: [toolDef('search')] }))

      const assistant = getAssistantMessage()
      expect(assistant['tool_calls']).toBeDefined()
      expect(assistant['reasoning_content']).toBe('I will use the search tool.')
    })

    it('does NOT echo reasoning_content on assistant messages without tool_calls', async () => {
      // Per spec, `reasoning_content` is ignored on non-tool turns and would
      // just pollute context. We drop it.
      createCompletionMock.mockResolvedValueOnce({
        id: 'chatcmpl-ds-3',
        model: 'deepseek-v4-pro',
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
            { type: 'reasoning', text: 'Just acknowledge.', provenance: 'deepseek' },
            { type: 'text', text: 'Hello!' },
          ],
        },
        textMsg('user', 'Now respond again.'),
      ]

      const adapter = new DeepSeekAdapter('deepseek-key')
      await adapter.chat(messages, chatOpts())

      const assistant = getAssistantMessage()
      expect(assistant['tool_calls']).toBeUndefined()
      expect(assistant['reasoning_content']).toBeUndefined()
      expect(assistant['content']).toBe('Hello!')
    })

    it('does NOT echo reasoning blocks from a foreign provenance', async () => {
      // Cross-provider reasoning (e.g. an upstream Anthropic block carried
      // through to a DeepSeek adapter) is not eligible for native echo —
      // DeepSeek did not produce it and would not recognise its signature.
      createCompletionMock.mockResolvedValueOnce({
        id: 'chatcmpl-ds-4',
        model: 'deepseek-v4-pro',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Done.', tool_calls: undefined },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      })

      const messages: LLMMessage[] = [
        textMsg('user', 'Search for bar'),
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'Foreign reasoning.', provenance: 'anthropic' },
            { type: 'tool_use', id: 'call_1', name: 'search', input: { q: 'bar' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '[results]' }],
        },
      ]

      const adapter = new DeepSeekAdapter('deepseek-key')
      await adapter.chat(messages, chatOpts({ tools: [toolDef('search')] }))

      const assistant = getAssistantMessage()
      expect(assistant['tool_calls']).toBeDefined()
      expect(assistant['reasoning_content']).toBeUndefined()
    })

    it('drops a reasoning block with no provenance (treated as foreign)', async () => {
      // Older clients or third-party IR constructors may produce reasoning
      // blocks without `provenance`. Treat the same as foreign — silent drop.
      createCompletionMock.mockResolvedValueOnce({
        id: 'chatcmpl-ds-5',
        model: 'deepseek-v4-pro',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'OK.', tool_calls: undefined },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      })

      const messages: LLMMessage[] = [
        textMsg('user', 'Search'),
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'No provenance.' },
            { type: 'tool_use', id: 'call_2', name: 'search', input: { q: 'x' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_2', content: '[]' }],
        },
      ]

      const adapter = new DeepSeekAdapter('deepseek-key')
      await adapter.chat(messages, chatOpts({ tools: [toolDef('search')] }))

      const assistant = getAssistantMessage()
      expect(assistant['reasoning_content']).toBeUndefined()
    })

    it('preserves reasoning_content across multiple historical tool-use turns', async () => {
      // Each prior tool-use turn carries its own reasoning. The spec requires
      // every such turn to keep its reasoning_content on subsequent requests,
      // not just the most recent one.
      createCompletionMock.mockResolvedValueOnce({
        id: 'chatcmpl-ds-6',
        model: 'deepseek-v4-pro',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Final.', tool_calls: undefined },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      })

      const messages: LLMMessage[] = [
        textMsg('user', 'Multi-step research.'),
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'Plan A.', provenance: 'deepseek' },
            { type: 'tool_use', id: 'call_1', name: 'search', input: { q: 'a' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '[a]' }],
        },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'Plan B.', provenance: 'deepseek' },
            { type: 'tool_use', id: 'call_2', name: 'search', input: { q: 'b' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_2', content: '[b]' }],
        },
      ]

      const adapter = new DeepSeekAdapter('deepseek-key')
      await adapter.chat(messages, chatOpts({ tools: [toolDef('search')] }))

      const sentMessages = createCompletionMock.mock.calls[0][0].messages as Array<Record<string, unknown>>
      const assistants = sentMessages.filter((m) => m['role'] === 'assistant')
      expect(assistants).toHaveLength(2)
      expect(assistants[0]['reasoning_content']).toBe('Plan A.')
      expect(assistants[1]['reasoning_content']).toBe('Plan B.')
    })

    it('does NOT echo reasoning_content from OpenAIAdapter (capability remains `never`)', async () => {
      // Verifies the capability gate, not just the DeepSeek subclass:
      // OpenAIAdapter itself must NOT attach reasoning_content even when
      // matching-provenance reasoning is present in the message history.
      const { OpenAIAdapter } = await import('../src/llm/openai.js')
      createCompletionMock.mockResolvedValueOnce({
        id: 'chatcmpl-oai',
        model: 'gpt-4o',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Final.', tool_calls: undefined },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      })

      const messages: LLMMessage[] = [
        textMsg('user', 'Search'),
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'thinking', provenance: 'openai' },
            { type: 'tool_use', id: 'call_1', name: 'search', input: { q: 'x' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '[]' }],
        },
      ]

      const openaiAdapter = new OpenAIAdapter('openai-key')
      await openaiAdapter.chat(messages, chatOpts({ tools: [toolDef('search')] }))

      const sentMessages = createCompletionMock.mock.calls[0][0].messages as Array<Record<string, unknown>>
      const assistant = sentMessages.find((m) => m['role'] === 'assistant')
      expect(assistant!['reasoning_content']).toBeUndefined()
    })
  })
})
