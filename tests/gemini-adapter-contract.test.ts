import { describe, it, expect, vi, beforeEach } from 'vitest'
import { textMsg, toolUseMsg, toolResultMsg, imageMsg, chatOpts, toolDef, collectEvents } from './helpers/llm-fixtures.js'
import type { LLMResponse, StreamEvent, ToolUseBlock } from '../src/types.js'

// ---------------------------------------------------------------------------
// Mock GoogleGenAI
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGeminiResponse(parts: Array<Record<string, unknown>>, overrides: Record<string, unknown> = {}) {
  return {
    candidates: [{
      content: { parts },
      finishReason: 'STOP',
      ...overrides,
    }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
  }
}

async function* asyncGen<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GeminiAdapter (contract)', () => {
  let adapter: GeminiAdapter

  beforeEach(() => {
    vi.clearAllMocks()
    adapter = new GeminiAdapter('test-key')
  })

  // =========================================================================
  // chat() — message conversion
  // =========================================================================

  describe('chat() message conversion', () => {
    it('converts text messages with correct role mapping', async () => {
      mockGenerateContent.mockResolvedValue(makeGeminiResponse([{ text: 'Hi' }]))

      await adapter.chat(
        [textMsg('user', 'Hello'), textMsg('assistant', 'Hi')],
        chatOpts(),
      )

      const callArgs = mockGenerateContent.mock.calls[0][0]
      expect(callArgs.contents[0]).toMatchObject({ role: 'user', parts: [{ text: 'Hello' }] })
      expect(callArgs.contents[1]).toMatchObject({ role: 'model', parts: [{ text: 'Hi' }] })
    })

    it('converts tool_use blocks to functionCall parts', async () => {
      mockGenerateContent.mockResolvedValue(makeGeminiResponse([{ text: 'ok' }]))

      await adapter.chat(
        [toolUseMsg('call_1', 'search', { query: 'test' })],
        chatOpts(),
      )

      const parts = mockGenerateContent.mock.calls[0][0].contents[0].parts
      expect(parts[0].functionCall).toEqual({
        id: 'call_1',
        name: 'search',
        args: { query: 'test' },
      })
    })

    it('converts tool_result blocks to functionResponse parts with name lookup', async () => {
      mockGenerateContent.mockResolvedValue(makeGeminiResponse([{ text: 'ok' }]))

      await adapter.chat(
        [
          toolUseMsg('call_1', 'search', { query: 'test' }),
          toolResultMsg('call_1', 'found it'),
        ],
        chatOpts(),
      )

      const resultParts = mockGenerateContent.mock.calls[0][0].contents[1].parts
      expect(resultParts[0].functionResponse).toMatchObject({
        id: 'call_1',
        name: 'search',
        response: { content: 'found it', isError: false },
      })
    })

    it('falls back to tool_use_id as name when no matching tool_use found', async () => {
      mockGenerateContent.mockResolvedValue(makeGeminiResponse([{ text: 'ok' }]))

      await adapter.chat(
        [toolResultMsg('unknown_id', 'data')],
        chatOpts(),
      )

      const parts = mockGenerateContent.mock.calls[0][0].contents[0].parts
      expect(parts[0].functionResponse.name).toBe('unknown_id')
    })

    it('converts image blocks to inlineData parts', async () => {
      mockGenerateContent.mockResolvedValue(makeGeminiResponse([{ text: 'ok' }]))

      await adapter.chat([imageMsg('image/png', 'base64data')], chatOpts())

      const parts = mockGenerateContent.mock.calls[0][0].contents[0].parts
      expect(parts[0].inlineData).toEqual({
        mimeType: 'image/png',
        data: 'base64data',
      })
    })
  })

  // =========================================================================
  // chat() — tools & config
  // =========================================================================

  describe('chat() tools & config', () => {
    it('converts tools to Gemini format with parametersJsonSchema', async () => {
      mockGenerateContent.mockResolvedValue(makeGeminiResponse([{ text: 'ok' }]))
      const tool = toolDef('search', 'Search')

      await adapter.chat([textMsg('user', 'Hi')], chatOpts({ tools: [tool] }))

      const config = mockGenerateContent.mock.calls[0][0].config
      expect(config.tools[0].functionDeclarations[0]).toEqual({
        name: 'search',
        description: 'Search',
        parametersJsonSchema: tool.inputSchema,
      })
      expect(config.toolConfig).toEqual({
        functionCallingConfig: { mode: 'AUTO' },
      })
    })

    it('passes systemInstruction, maxOutputTokens, temperature', async () => {
      mockGenerateContent.mockResolvedValue(makeGeminiResponse([{ text: 'ok' }]))

      await adapter.chat(
        [textMsg('user', 'Hi')],
        chatOpts({ systemPrompt: 'Be helpful', temperature: 0.7, maxTokens: 2048 }),
      )

      const config = mockGenerateContent.mock.calls[0][0].config
      expect(config.systemInstruction).toBe('Be helpful')
      expect(config.temperature).toBe(0.7)
      expect(config.maxOutputTokens).toBe(2048)
    })

    it('omits tools/toolConfig when no tools provided', async () => {
      mockGenerateContent.mockResolvedValue(makeGeminiResponse([{ text: 'ok' }]))

      await adapter.chat([textMsg('user', 'Hi')], chatOpts())

      const config = mockGenerateContent.mock.calls[0][0].config
      expect(config.tools).toBeUndefined()
      expect(config.toolConfig).toBeUndefined()
    })
  })

  // =========================================================================
  // chat() — response conversion
  // =========================================================================

  describe('chat() response conversion', () => {
    it('converts text parts to TextBlock', async () => {
      mockGenerateContent.mockResolvedValue(makeGeminiResponse([{ text: 'Hello' }]))

      const result = await adapter.chat([textMsg('user', 'Hi')], chatOpts())

      expect(result.content[0]).toEqual({ type: 'text', text: 'Hello' })
    })

    it('converts functionCall parts to ToolUseBlock with existing id', async () => {
      mockGenerateContent.mockResolvedValue(makeGeminiResponse([
        { functionCall: { id: 'call_1', name: 'search', args: { q: 'test' } } },
      ]))

      const result = await adapter.chat([textMsg('user', 'Hi')], chatOpts())

      expect(result.content[0]).toEqual({
        type: 'tool_use',
        id: 'call_1',
        name: 'search',
        input: { q: 'test' },
      })
    })

    it('fabricates ID when functionCall has no id field', async () => {
      mockGenerateContent.mockResolvedValue(makeGeminiResponse([
        { functionCall: { name: 'search', args: { q: 'test' } } },
      ]))

      const result = await adapter.chat([textMsg('user', 'Hi')], chatOpts())

      const block = result.content[0] as ToolUseBlock
      expect(block.type).toBe('tool_use')
      expect(block.id).toMatch(/^gemini-\d+-[a-z0-9]+$/)
      expect(block.name).toBe('search')
    })

    it('maps STOP finishReason to end_turn', async () => {
      mockGenerateContent.mockResolvedValue(makeGeminiResponse([{ text: 'ok' }], { finishReason: 'STOP' }))

      const result = await adapter.chat([textMsg('user', 'Hi')], chatOpts())

      expect(result.stop_reason).toBe('end_turn')
    })

    it('maps MAX_TOKENS finishReason to max_tokens', async () => {
      mockGenerateContent.mockResolvedValue(makeGeminiResponse([{ text: 'trunc' }], { finishReason: 'MAX_TOKENS' }))

      const result = await adapter.chat([textMsg('user', 'Hi')], chatOpts())

      expect(result.stop_reason).toBe('max_tokens')
    })

    it('maps to tool_use when response contains functionCall (even with STOP)', async () => {
      mockGenerateContent.mockResolvedValue(makeGeminiResponse(
        [{ functionCall: { id: 'c1', name: 'search', args: {} } }],
        { finishReason: 'STOP' },
      ))

      const result = await adapter.chat([textMsg('user', 'Hi')], chatOpts())

      expect(result.stop_reason).toBe('tool_use')
    })

    it('handles missing usageMetadata (defaults to 0)', async () => {
      mockGenerateContent.mockResolvedValue({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      })

      const result = await adapter.chat([textMsg('user', 'Hi')], chatOpts())

      expect(result.usage).toEqual({ input_tokens: 0, output_tokens: 0 })
    })

    it('handles empty candidates gracefully', async () => {
      mockGenerateContent.mockResolvedValue({ candidates: [{ content: {} }] })

      const result = await adapter.chat([textMsg('user', 'Hi')], chatOpts())

      expect(result.content).toEqual([])
    })
  })

  // =========================================================================
  // stream()
  // =========================================================================

  describe('stream()', () => {
    it('yields text events for text parts', async () => {
      mockGenerateContentStream.mockResolvedValue(
        asyncGen([
          makeGeminiResponse([{ text: 'Hello' }]),
          makeGeminiResponse([{ text: ' world' }]),
        ]),
      )

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      const textEvents = events.filter(e => e.type === 'text')
      expect(textEvents).toEqual([
        { type: 'text', data: 'Hello' },
        { type: 'text', data: ' world' },
      ])
    })

    it('yields tool_use events for functionCall parts', async () => {
      mockGenerateContentStream.mockResolvedValue(
        asyncGen([
          makeGeminiResponse([{ functionCall: { id: 'c1', name: 'search', args: { q: 'test' } } }]),
        ]),
      )

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      const toolEvents = events.filter(e => e.type === 'tool_use')
      expect(toolEvents).toHaveLength(1)
      expect((toolEvents[0].data as ToolUseBlock).name).toBe('search')
    })

    it('accumulates token counts from usageMetadata', async () => {
      mockGenerateContentStream.mockResolvedValue(
        asyncGen([
          { candidates: [{ content: { parts: [{ text: 'Hi' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } },
          { candidates: [{ content: { parts: [{ text: '!' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } },
        ]),
      )

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      const done = events.find(e => e.type === 'done')
      const response = done!.data as LLMResponse
      expect(response.usage).toEqual({ input_tokens: 10, output_tokens: 5 })
    })

    it('yields done event with correct stop_reason', async () => {
      mockGenerateContentStream.mockResolvedValue(
        asyncGen([makeGeminiResponse([{ text: 'ok' }], { finishReason: 'MAX_TOKENS' })]),
      )

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      const done = events.find(e => e.type === 'done')
      expect((done!.data as LLMResponse).stop_reason).toBe('max_tokens')
    })

    it('yields error event when stream throws', async () => {
      mockGenerateContentStream.mockResolvedValue(
        (async function* () { throw new Error('Gemini error') })(),
      )

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      const errorEvents = events.filter(e => e.type === 'error')
      expect(errorEvents).toHaveLength(1)
      expect((errorEvents[0].data as Error).message).toBe('Gemini error')
    })

    it('handles chunks with no candidates', async () => {
      mockGenerateContentStream.mockResolvedValue(
        asyncGen([
          { candidates: undefined, usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0 } },
          makeGeminiResponse([{ text: 'ok' }]),
        ]),
      )

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      const textEvents = events.filter(e => e.type === 'text')
      expect(textEvents).toHaveLength(1)
      expect(textEvents[0].data).toBe('ok')
    })
  })
})
