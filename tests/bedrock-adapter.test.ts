import { describe, it, expect, vi, beforeEach } from 'vitest'
import { textMsg, toolUseMsg, toolResultMsg, chatOpts, toolDef, collectEvents } from './helpers/llm-fixtures.js'
import type { LLMResponse, StreamEvent, ToolUseBlock } from '../src/types.js'

// ---------------------------------------------------------------------------
// Mock @aws-sdk/client-bedrock-runtime
// ---------------------------------------------------------------------------

const mockSend = vi.hoisted(() => vi.fn())

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  const BedrockRuntimeClient = vi.fn(() => ({ send: mockSend }))
  const ConverseCommand = vi.fn((input: unknown) => ({ input }))
  const ConverseStreamCommand = vi.fn((input: unknown) => ({ input }))
  return { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand }
})

import { BedrockAdapter } from '../src/llm/bedrock.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConverseResponse(overrides: Record<string, unknown> = {}) {
  return {
    $metadata: { requestId: 'req-test-123' },
    output: {
      message: {
        role: 'assistant',
        content: [{ text: 'Hello' }],
      },
    },
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 5 },
    ...overrides,
  }
}

function makeStreamResponse(events: unknown[]) {
  return {
    $metadata: { requestId: 'req-stream-123' },
    stream: (async function* () {
      for (const e of events) yield e
    })(),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BedrockAdapter', () => {
  let adapter: BedrockAdapter

  beforeEach(() => {
    vi.clearAllMocks()
    adapter = new BedrockAdapter('us-east-1')
  })

  // =========================================================================
  // Constructor / region resolution
  // =========================================================================

  describe('region resolution', () => {
    it('uses explicit region argument', () => {
      const a = new BedrockAdapter('eu-west-1')
      expect(a).toBeDefined()
    })

    it('falls back to AWS_REGION env var', () => {
      const original = process.env['AWS_REGION']
      process.env['AWS_REGION'] = 'ap-southeast-1'
      const a = new BedrockAdapter()
      expect(a).toBeDefined()
      if (original === undefined) delete process.env['AWS_REGION']
      else process.env['AWS_REGION'] = original
    })

    it('falls back to us-east-1 when no region available', () => {
      const original = process.env['AWS_REGION']
      delete process.env['AWS_REGION']
      const a = new BedrockAdapter()
      expect(a).toBeDefined()
      if (original !== undefined) process.env['AWS_REGION'] = original
    })
  })

  // =========================================================================
  // chat()
  // =========================================================================

  describe('chat()', () => {
    it('returns text content from ConverseCommand response', async () => {
      mockSend.mockResolvedValue(makeConverseResponse())

      const result = await adapter.chat([textMsg('user', 'Hi')], chatOpts())

      expect(result).toMatchObject({
        id: 'req-test-123',
        content: [{ type: 'text', text: 'Hello' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      })
    })

    it('returns tool_use content with parsed input', async () => {
      mockSend.mockResolvedValue(makeConverseResponse({
        output: {
          message: {
            role: 'assistant',
            content: [{ toolUse: { toolUseId: 'call_1', name: 'search', input: { query: 'test' } } }],
          },
        },
        stopReason: 'tool_use',
      }))

      const result = await adapter.chat([textMsg('user', 'search for something')], chatOpts())

      expect(result.content[0]).toEqual({
        type: 'tool_use',
        id: 'call_1',
        name: 'search',
        input: { query: 'test' },
      })
      expect(result.stop_reason).toBe('tool_use')
    })

    it('wires system prompt into system array', async () => {
      mockSend.mockResolvedValue(makeConverseResponse())

      await adapter.chat(
        [textMsg('user', 'Hi')],
        chatOpts({ systemPrompt: 'Be concise.' }),
      )

      const cmd = mockSend.mock.calls[0][0]
      expect(cmd.input.system).toEqual([{ text: 'Be concise.' }])
    })

    it('wires tools into toolConfig', async () => {
      mockSend.mockResolvedValue(makeConverseResponse())
      const tool = toolDef('search', 'Search the web')

      await adapter.chat([textMsg('user', 'Hi')], chatOpts({ tools: [tool] }))

      const cmd = mockSend.mock.calls[0][0]
      expect(cmd.input.toolConfig.tools[0]).toMatchObject({
        toolSpec: {
          name: 'search',
          description: 'Search the web',
        },
      })
    })

    it('wires inferenceConfig from options', async () => {
      mockSend.mockResolvedValue(makeConverseResponse())

      await adapter.chat(
        [textMsg('user', 'Hi')],
        chatOpts({ maxTokens: 512, temperature: 0.7, topP: 0.9 }),
      )

      const cmd = mockSend.mock.calls[0][0]
      expect(cmd.input.inferenceConfig).toMatchObject({
        maxTokens: 512,
        temperature: 0.7,
        topP: 0.9,
      })
    })

    it('puts topK in additionalModelRequestFields', async () => {
      mockSend.mockResolvedValue(makeConverseResponse())

      await adapter.chat(
        [textMsg('user', 'Hi')],
        chatOpts({ topK: 40 }),
      )

      const cmd = mockSend.mock.calls[0][0]
      expect(cmd.input.additionalModelRequestFields).toMatchObject({ top_k: 40 })
    })

    it('passes stop_reason through', async () => {
      mockSend.mockResolvedValue(makeConverseResponse({ stopReason: 'max_tokens' }))

      const result = await adapter.chat([textMsg('user', 'Hi')], chatOpts())
      expect(result.stop_reason).toBe('max_tokens')
    })

    it('maps inputTokens/outputTokens to usage', async () => {
      mockSend.mockResolvedValue(makeConverseResponse({
        usage: { inputTokens: 42, outputTokens: 17 },
      }))

      const result = await adapter.chat([textMsg('user', 'Hi')], chatOpts())
      expect(result.usage).toEqual({ input_tokens: 42, output_tokens: 17 })
    })

    it('forwards abortSignal to client.send', async () => {
      mockSend.mockResolvedValue(makeConverseResponse())
      const controller = new AbortController()

      await adapter.chat([textMsg('user', 'Hi')], chatOpts({ abortSignal: controller.signal }))

      expect(mockSend.mock.calls[0][1]).toEqual({ abortSignal: controller.signal })
    })

    it('sends tool_use and tool_result messages correctly', async () => {
      mockSend.mockResolvedValue(makeConverseResponse())

      await adapter.chat(
        [
          toolUseMsg('c1', 'search', { q: 'hello' }),
          toolResultMsg('c1', 'the result', false),
        ],
        chatOpts(),
      )

      const msgs = mockSend.mock.calls[0][0].input.messages
      expect(msgs[0].content[0].toolUse).toMatchObject({ toolUseId: 'c1', name: 'search' })
      expect(msgs[1].content[0].toolResult).toMatchObject({ toolUseId: 'c1', status: 'success' })
    })

    it('marks error tool_result with status error', async () => {
      mockSend.mockResolvedValue(makeConverseResponse())

      await adapter.chat(
        [toolResultMsg('c1', 'oops', true)],
        chatOpts(),
      )

      const msgs = mockSend.mock.calls[0][0].input.messages
      expect(msgs[0].content[0].toolResult.status).toBe('error')
    })
  })

  // =========================================================================
  // stream()
  // =========================================================================

  describe('stream()', () => {
    it('emits text delta events in order', async () => {
      mockSend.mockResolvedValue(makeStreamResponse([
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Hello' } } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: ' world' } } },
        { messageStop: { stopReason: 'end_turn' } },
        { metadata: { usage: { inputTokens: 5, outputTokens: 3 } } },
      ]))

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))
      const textEvents = events.filter(e => e.type === 'text')
      expect(textEvents).toEqual([
        { type: 'text', data: 'Hello' },
        { type: 'text', data: ' world' },
      ])
    })

    it('accumulates split tool-input JSON across deltas and emits one tool_use event', async () => {
      mockSend.mockResolvedValue(makeStreamResponse([
        { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'c1', name: 'search' } } } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"qu' } } } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: 'ery":"test"}' } } } },
        { contentBlockStop: { contentBlockIndex: 0 } },
        { messageStop: { stopReason: 'tool_use' } },
        { metadata: { usage: { inputTokens: 8, outputTokens: 4 } } },
      ]))

      const events = await collectEvents(adapter.stream([textMsg('user', 'search')], chatOpts()))

      const toolEvents = events.filter(e => e.type === 'tool_use')
      expect(toolEvents).toHaveLength(1)
      const block = toolEvents[0].data as ToolUseBlock
      expect(block).toEqual({ type: 'tool_use', id: 'c1', name: 'search', input: { query: 'test' } })
    })

    it('emits reasoning events from reasoningContent deltas', async () => {
      mockSend.mockResolvedValue(makeStreamResponse([
        { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: 'thinking...' } } } },
        { messageStop: { stopReason: 'end_turn' } },
        { metadata: { usage: { inputTokens: 4, outputTokens: 2 } } },
      ]))

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))
      const reasoningEvents = events.filter(e => e.type === 'reasoning')
      expect(reasoningEvents).toEqual([{ type: 'reasoning', data: 'thinking...' }])
    })

    it('includes reasoning blocks in the done payload, coalescing deltas per index', async () => {
      mockSend.mockResolvedValue(makeStreamResponse([
        { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: 'first ' } } } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: 'thought' } } } },
        { contentBlockStop: { contentBlockIndex: 0 } },
        { contentBlockDelta: { contentBlockIndex: 1, delta: { text: 'answer' } } },
        { messageStop: { stopReason: 'end_turn' } },
        { metadata: { usage: { inputTokens: 4, outputTokens: 2 } } },
      ]))

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))
      const doneEvent = events.find(e => e.type === 'done')
      const response = doneEvent?.data as LLMResponse
      const reasoningBlocks = response.content.filter(b => b.type === 'reasoning')
      expect(reasoningBlocks).toEqual([{ type: 'reasoning', text: 'first thought' }])
    })

    it('flushes reasoning buffer into done payload even when contentBlockStop is missing', async () => {
      mockSend.mockResolvedValue(makeStreamResponse([
        { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: 'unterminated' } } } },
        { messageStop: { stopReason: 'end_turn' } },
        { metadata: { usage: { inputTokens: 1, outputTokens: 1 } } },
      ]))

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))
      const response = events.find(e => e.type === 'done')?.data as LLMResponse
      expect(response.content).toContainEqual({ type: 'reasoning', text: 'unterminated' })
    })

    it('emits done event with final LLMResponse', async () => {
      mockSend.mockResolvedValue(makeStreamResponse([
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Done' } } },
        { messageStop: { stopReason: 'end_turn' } },
        { metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
      ]))

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      const doneEvents = events.filter(e => e.type === 'done')
      expect(doneEvents).toHaveLength(1)
      const response = doneEvents[0].data as LLMResponse
      expect(response.stop_reason).toBe('end_turn')
      expect(response.usage).toEqual({ input_tokens: 10, output_tokens: 5 })
    })

    it('emits error event when stream throws', async () => {
      mockSend.mockRejectedValue(new Error('Stream failed'))

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      const errorEvents = events.filter(e => e.type === 'error')
      expect(errorEvents).toHaveLength(1)
      expect((errorEvents[0].data as Error).message).toBe('Stream failed')
    })

    it('forwards abortSignal to client.send in stream mode', async () => {
      mockSend.mockResolvedValue(makeStreamResponse([
        { messageStop: { stopReason: 'end_turn' } },
        { metadata: { usage: { inputTokens: 1, outputTokens: 1 } } },
      ]))
      const controller = new AbortController()

      await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts({ abortSignal: controller.signal })))

      expect(mockSend.mock.calls[0][1]).toEqual({ abortSignal: controller.signal })
    })

    it('handles malformed tool JSON gracefully (defaults to empty object)', async () => {
      mockSend.mockResolvedValue(makeStreamResponse([
        { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'c1', name: 'broken' } } } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{invalid' } } } },
        { contentBlockStop: { contentBlockIndex: 0 } },
        { messageStop: { stopReason: 'tool_use' } },
        { metadata: { usage: { inputTokens: 2, outputTokens: 1 } } },
      ]))

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      const toolEvents = events.filter(e => e.type === 'tool_use')
      expect((toolEvents[0].data as ToolUseBlock).input).toEqual({})
    })
  })
})
