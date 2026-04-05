import { describe, it, expect, vi, beforeEach } from 'vitest'
import { textMsg, toolUseMsg, toolResultMsg, imageMsg, chatOpts, toolDef, collectEvents } from './helpers/llm-fixtures.js'
import type { LLMResponse, StreamEvent, ToolUseBlock } from '../src/types.js'

// ---------------------------------------------------------------------------
// Mock the Anthropic SDK
// ---------------------------------------------------------------------------

const mockCreate = vi.hoisted(() => vi.fn())
const mockStream = vi.hoisted(() => vi.fn())

vi.mock('@anthropic-ai/sdk', () => {
  const AnthropicMock = vi.fn(() => ({
    messages: {
      create: mockCreate,
      stream: mockStream,
    },
  }))
  return { default: AnthropicMock, Anthropic: AnthropicMock }
})

import { AnthropicAdapter } from '../src/llm/anthropic.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAnthropicResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg_test123',
    content: [{ type: 'text', text: 'Hello' }],
    model: 'claude-sonnet-4',
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
    ...overrides,
  }
}

function makeStreamMock(events: Array<Record<string, unknown>>, finalMsg: Record<string, unknown>) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const event of events) yield event
    },
    finalMessage: vi.fn().mockResolvedValue(finalMsg),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AnthropicAdapter', () => {
  let adapter: AnthropicAdapter

  beforeEach(() => {
    vi.clearAllMocks()
    adapter = new AnthropicAdapter('test-key')
  })

  // =========================================================================
  // chat()
  // =========================================================================

  describe('chat()', () => {
    it('converts a text message and returns LLMResponse', async () => {
      mockCreate.mockResolvedValue(makeAnthropicResponse())

      const result = await adapter.chat([textMsg('user', 'Hi')], chatOpts())

      // Verify the SDK was called with correct shape
      const callArgs = mockCreate.mock.calls[0]
      expect(callArgs[0]).toMatchObject({
        model: 'test-model',
        max_tokens: 1024,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      })

      // Verify response transformation
      expect(result).toEqual({
        id: 'msg_test123',
        content: [{ type: 'text', text: 'Hello' }],
        model: 'claude-sonnet-4',
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      })
    })

    it('converts tool_use blocks to Anthropic format', async () => {
      mockCreate.mockResolvedValue(makeAnthropicResponse())

      await adapter.chat(
        [toolUseMsg('call_1', 'search', { query: 'test' })],
        chatOpts(),
      )

      const sentMessages = mockCreate.mock.calls[0][0].messages
      expect(sentMessages[0].content[0]).toEqual({
        type: 'tool_use',
        id: 'call_1',
        name: 'search',
        input: { query: 'test' },
      })
    })

    it('converts tool_result blocks to Anthropic format', async () => {
      mockCreate.mockResolvedValue(makeAnthropicResponse())

      await adapter.chat(
        [toolResultMsg('call_1', 'result data', false)],
        chatOpts(),
      )

      const sentMessages = mockCreate.mock.calls[0][0].messages
      expect(sentMessages[0].content[0]).toEqual({
        type: 'tool_result',
        tool_use_id: 'call_1',
        content: 'result data',
        is_error: false,
      })
    })

    it('converts image blocks to Anthropic format', async () => {
      mockCreate.mockResolvedValue(makeAnthropicResponse())

      await adapter.chat([imageMsg('image/png', 'base64data')], chatOpts())

      const sentMessages = mockCreate.mock.calls[0][0].messages
      expect(sentMessages[0].content[0]).toEqual({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'base64data',
        },
      })
    })

    it('passes system prompt as top-level parameter', async () => {
      mockCreate.mockResolvedValue(makeAnthropicResponse())

      await adapter.chat(
        [textMsg('user', 'Hi')],
        chatOpts({ systemPrompt: 'You are helpful.' }),
      )

      expect(mockCreate.mock.calls[0][0].system).toBe('You are helpful.')
    })

    it('converts tools to Anthropic format', async () => {
      mockCreate.mockResolvedValue(makeAnthropicResponse())
      const tool = toolDef('search', 'Search the web')

      await adapter.chat(
        [textMsg('user', 'Hi')],
        chatOpts({ tools: [tool] }),
      )

      const sentTools = mockCreate.mock.calls[0][0].tools
      expect(sentTools[0]).toEqual({
        name: 'search',
        description: 'Search the web',
        input_schema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      })
    })

    it('passes temperature through', async () => {
      mockCreate.mockResolvedValue(makeAnthropicResponse())

      await adapter.chat(
        [textMsg('user', 'Hi')],
        chatOpts({ temperature: 0.5 }),
      )

      expect(mockCreate.mock.calls[0][0].temperature).toBe(0.5)
    })

    it('passes abortSignal to SDK request options', async () => {
      mockCreate.mockResolvedValue(makeAnthropicResponse())
      const controller = new AbortController()

      await adapter.chat(
        [textMsg('user', 'Hi')],
        chatOpts({ abortSignal: controller.signal }),
      )

      expect(mockCreate.mock.calls[0][1]).toEqual({ signal: controller.signal })
    })

    it('defaults max_tokens to 4096 when unset', async () => {
      mockCreate.mockResolvedValue(makeAnthropicResponse())

      await adapter.chat(
        [textMsg('user', 'Hi')],
        { model: 'test-model' },
      )

      expect(mockCreate.mock.calls[0][0].max_tokens).toBe(4096)
    })

    it('converts tool_use response blocks from Anthropic', async () => {
      mockCreate.mockResolvedValue(makeAnthropicResponse({
        content: [
          { type: 'tool_use', id: 'call_1', name: 'search', input: { q: 'test' } },
        ],
        stop_reason: 'tool_use',
      }))

      const result = await adapter.chat([textMsg('user', 'search')], chatOpts())

      expect(result.content[0]).toEqual({
        type: 'tool_use',
        id: 'call_1',
        name: 'search',
        input: { q: 'test' },
      })
      expect(result.stop_reason).toBe('tool_use')
    })

    it('gracefully degrades unknown block types to text', async () => {
      mockCreate.mockResolvedValue(makeAnthropicResponse({
        content: [{ type: 'thinking', thinking: 'hmm...' }],
      }))

      const result = await adapter.chat([textMsg('user', 'Hi')], chatOpts())

      expect(result.content[0]).toEqual({
        type: 'text',
        text: '[unsupported block type: thinking]',
      })
    })

    it('defaults stop_reason to end_turn when null', async () => {
      mockCreate.mockResolvedValue(makeAnthropicResponse({ stop_reason: null }))

      const result = await adapter.chat([textMsg('user', 'Hi')], chatOpts())

      expect(result.stop_reason).toBe('end_turn')
    })

    it('propagates SDK errors', async () => {
      mockCreate.mockRejectedValue(new Error('Rate limited'))

      await expect(
        adapter.chat([textMsg('user', 'Hi')], chatOpts()),
      ).rejects.toThrow('Rate limited')
    })
  })

  // =========================================================================
  // stream()
  // =========================================================================

  describe('stream()', () => {
    it('yields text events from text_delta', async () => {
      const streamObj = makeStreamMock(
        [
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
        ],
        makeAnthropicResponse({ content: [{ type: 'text', text: 'Hello world' }] }),
      )
      mockStream.mockReturnValue(streamObj)

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      const textEvents = events.filter(e => e.type === 'text')
      expect(textEvents).toEqual([
        { type: 'text', data: 'Hello' },
        { type: 'text', data: ' world' },
      ])
    })

    it('accumulates tool input JSON and emits tool_use on content_block_stop', async () => {
      const streamObj = makeStreamMock(
        [
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'call_1', name: 'search' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"qu' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: 'ery":"test"}' },
          },
          { type: 'content_block_stop', index: 0 },
        ],
        makeAnthropicResponse({
          content: [{ type: 'tool_use', id: 'call_1', name: 'search', input: { query: 'test' } }],
          stop_reason: 'tool_use',
        }),
      )
      mockStream.mockReturnValue(streamObj)

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      const toolEvents = events.filter(e => e.type === 'tool_use')
      expect(toolEvents).toHaveLength(1)
      const block = toolEvents[0].data as ToolUseBlock
      expect(block).toEqual({
        type: 'tool_use',
        id: 'call_1',
        name: 'search',
        input: { query: 'test' },
      })
    })

    it('handles malformed tool JSON gracefully (defaults to empty object)', async () => {
      const streamObj = makeStreamMock(
        [
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'call_1', name: 'broken' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{invalid' },
          },
          { type: 'content_block_stop', index: 0 },
        ],
        makeAnthropicResponse({
          content: [{ type: 'tool_use', id: 'call_1', name: 'broken', input: {} }],
        }),
      )
      mockStream.mockReturnValue(streamObj)

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      const toolEvents = events.filter(e => e.type === 'tool_use')
      expect((toolEvents[0].data as ToolUseBlock).input).toEqual({})
    })

    it('yields done event with complete LLMResponse', async () => {
      const final = makeAnthropicResponse({
        content: [{ type: 'text', text: 'Done' }],
      })
      const streamObj = makeStreamMock([], final)
      mockStream.mockReturnValue(streamObj)

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      const doneEvents = events.filter(e => e.type === 'done')
      expect(doneEvents).toHaveLength(1)
      const response = doneEvents[0].data as LLMResponse
      expect(response.id).toBe('msg_test123')
      expect(response.content).toEqual([{ type: 'text', text: 'Done' }])
      expect(response.usage).toEqual({ input_tokens: 10, output_tokens: 5 })
    })

    it('yields error event when stream throws', async () => {
      const streamObj = {
        [Symbol.asyncIterator]: async function* () {
          throw new Error('Stream failed')
        },
        finalMessage: vi.fn(),
      }
      mockStream.mockReturnValue(streamObj)

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      const errorEvents = events.filter(e => e.type === 'error')
      expect(errorEvents).toHaveLength(1)
      expect((errorEvents[0].data as Error).message).toBe('Stream failed')
    })

    it('passes system prompt and tools to stream call', async () => {
      const streamObj = makeStreamMock([], makeAnthropicResponse())
      mockStream.mockReturnValue(streamObj)
      const tool = toolDef('search')

      await collectEvents(
        adapter.stream(
          [textMsg('user', 'Hi')],
          chatOpts({ systemPrompt: 'Be helpful', tools: [tool] }),
        ),
      )

      const callArgs = mockStream.mock.calls[0][0]
      expect(callArgs.system).toBe('Be helpful')
      expect(callArgs.tools[0].name).toBe('search')
    })

    it('passes abortSignal to stream request options', async () => {
      const streamObj = makeStreamMock([], makeAnthropicResponse())
      mockStream.mockReturnValue(streamObj)
      const controller = new AbortController()

      await collectEvents(
        adapter.stream(
          [textMsg('user', 'Hi')],
          chatOpts({ abortSignal: controller.signal }),
        ),
      )

      expect(mockStream.mock.calls[0][1]).toEqual({ signal: controller.signal })
    })

    it('handles multiple tool calls in one stream', async () => {
      const streamObj = makeStreamMock(
        [
          { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'c1', name: 'search' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":"a"}' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'c2', name: 'read' } },
          { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"b"}' } },
          { type: 'content_block_stop', index: 1 },
        ],
        makeAnthropicResponse({
          content: [
            { type: 'tool_use', id: 'c1', name: 'search', input: { q: 'a' } },
            { type: 'tool_use', id: 'c2', name: 'read', input: { path: 'b' } },
          ],
        }),
      )
      mockStream.mockReturnValue(streamObj)

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      const toolEvents = events.filter(e => e.type === 'tool_use')
      expect(toolEvents).toHaveLength(2)
      expect((toolEvents[0].data as ToolUseBlock).name).toBe('search')
      expect((toolEvents[1].data as ToolUseBlock).name).toBe('read')
    })
  })
})
