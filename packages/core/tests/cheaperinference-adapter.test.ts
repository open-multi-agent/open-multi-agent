import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock OpenAI constructor (must be hoisted for Vitest)
// ---------------------------------------------------------------------------
const OpenAIMock = vi.hoisted(() => vi.fn())

vi.mock('openai', () => ({
  default: OpenAIMock,
}))

import { CheaperInferenceAdapter } from '../src/llm/cheaperinference.js'
import { createAdapter } from '../src/llm/adapter.js'

// ---------------------------------------------------------------------------
// CheaperInferenceAdapter tests
// ---------------------------------------------------------------------------

describe('CheaperInferenceAdapter', () => {
  beforeEach(() => {
    OpenAIMock.mockClear()
  })

  it('has name "cheaperinference"', () => {
    const adapter = new CheaperInferenceAdapter()
    expect(adapter.name).toBe('cheaperinference')
  })

  it('uses CHEAPER_INFERENCE_API_KEY by default', () => {
    const original = process.env['CHEAPER_INFERENCE_API_KEY']
    process.env['CHEAPER_INFERENCE_API_KEY'] = 'ci-test-key-123'

    try {
      new CheaperInferenceAdapter()
      expect(OpenAIMock).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'ci-test-key-123',
          baseURL: 'https://api.cheaperinference.com/v1',
        })
      )
    } finally {
      if (original === undefined) {
        delete process.env['CHEAPER_INFERENCE_API_KEY']
      } else {
        process.env['CHEAPER_INFERENCE_API_KEY'] = original
      }
    }
  })

  it('uses official Cheaper Inference baseURL by default', () => {
    new CheaperInferenceAdapter('some-key')
    expect(OpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'some-key',
        baseURL: 'https://api.cheaperinference.com/v1',
      })
    )
  })

  it('allows overriding apiKey and baseURL', () => {
    new CheaperInferenceAdapter('custom-key', 'https://custom.endpoint/v1')
    expect(OpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'custom-key',
        baseURL: 'https://custom.endpoint/v1',
      })
    )
  })

  it('createAdapter("cheaperinference") returns CheaperInferenceAdapter instance', async () => {
    const adapter = await createAdapter('cheaperinference')
    expect(adapter).toBeInstanceOf(CheaperInferenceAdapter)
  })
})
