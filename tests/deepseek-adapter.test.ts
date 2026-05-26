import { describe, it, expect, vi, beforeEach } from 'vitest'
import { chatOpts, textMsg } from './helpers/llm-fixtures.js'

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
})
