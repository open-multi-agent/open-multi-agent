import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock OpenAI constructor (must be hoisted for Vitest)
// ---------------------------------------------------------------------------
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
})
