import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock OpenAI constructor (must be hoisted for Vitest)
// ---------------------------------------------------------------------------
const OpenAIMock = vi.hoisted(() => vi.fn())

vi.mock('openai', () => ({
  default: OpenAIMock,
}))

import { GrokAdapter } from '../src/llm/grok.js'
import { createAdapter } from '../src/llm/adapter.js'

// ---------------------------------------------------------------------------
// GrokAdapter tests
// ---------------------------------------------------------------------------

describe('GrokAdapter', () => {
  beforeEach(() => {
    OpenAIMock.mockClear()
  })

  it('has name "grok"', () => {
    const adapter = new GrokAdapter()
    expect(adapter.name).toBe('grok')
  })

  it('uses XAI_API_KEY by default', () => {
    const original = process.env['XAI_API_KEY']
    process.env['XAI_API_KEY'] = 'xai-test-key-123'

    try {
      new GrokAdapter()
      expect(OpenAIMock).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'xai-test-key-123',
          baseURL: 'https://api.x.ai/v1',
        })
      )
    } finally {
      if (original === undefined) {
        delete process.env['XAI_API_KEY']
      } else {
        process.env['XAI_API_KEY'] = original
      }
    }
  })

  it('uses official xAI baseURL by default', () => {
    new GrokAdapter('some-key')
    expect(OpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'some-key',
        baseURL: 'https://api.x.ai/v1',
      })
    )
  })

  it('allows overriding apiKey and baseURL', () => {
    new GrokAdapter('custom-key', 'https://custom.endpoint/v1')
    expect(OpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'custom-key',
        baseURL: 'https://custom.endpoint/v1',
      })
    )
  })

  it('createAdapter("grok") returns GrokAdapter instance', async () => {
    const adapter = await createAdapter('grok')
    expect(adapter).toBeInstanceOf(GrokAdapter)
  })
})