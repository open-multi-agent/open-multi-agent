import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock OpenAI constructor (must be hoisted for Vitest)
// ---------------------------------------------------------------------------
const OpenAIMock = vi.hoisted(() => vi.fn())

vi.mock('openai', () => ({
  default: OpenAIMock,
}))

import { VeniceAdapter } from '../src/llm/venice.js'
import { createAdapter } from '../src/llm/adapter.js'

// ---------------------------------------------------------------------------
// VeniceAdapter tests
// ---------------------------------------------------------------------------

describe('VeniceAdapter', () => {
  beforeEach(() => {
    OpenAIMock.mockClear()
  })

  it('has name "venice"', () => {
    const adapter = new VeniceAdapter()
    expect(adapter.name).toBe('venice')
  })

  it('uses VENICE_API_KEY by default', () => {
    const original = process.env['VENICE_API_KEY']
    process.env['VENICE_API_KEY'] = 'venice-test-key-123'

    try {
      new VeniceAdapter()
      expect(OpenAIMock).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'venice-test-key-123',
          baseURL: 'https://api.venice.ai/api/v1',
        })
      )
    } finally {
      if (original === undefined) {
        delete process.env['VENICE_API_KEY']
      } else {
        process.env['VENICE_API_KEY'] = original
      }
    }
  })

  it('uses official Venice baseURL by default', () => {
    new VeniceAdapter('some-key')
    expect(OpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'some-key',
        baseURL: 'https://api.venice.ai/api/v1',
      })
    )
  })

  it('allows overriding apiKey and baseURL', () => {
    new VeniceAdapter('custom-key', 'https://custom.endpoint/v1')
    expect(OpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'custom-key',
        baseURL: 'https://custom.endpoint/v1',
      })
    )
  })

  it('createAdapter("venice") returns VeniceAdapter instance', async () => {
    const adapter = await createAdapter('venice')
    expect(adapter).toBeInstanceOf(VeniceAdapter)
  })
})
