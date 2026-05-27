import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock OpenAI constructor (must be hoisted for Vitest)
// ---------------------------------------------------------------------------
const OpenAIMock = vi.hoisted(() => vi.fn())

vi.mock('openai', () => ({
  default: OpenAIMock,
}))

import { DoubaoAdapter } from '../src/llm/doubao.js'
import { createAdapter } from '../src/llm/adapter.js'

// ---------------------------------------------------------------------------
// DoubaoAdapter tests
// ---------------------------------------------------------------------------

describe('DoubaoAdapter', () => {
  beforeEach(() => {
    OpenAIMock.mockClear()
  })

  it('has name "doubao"', () => {
    const adapter = new DoubaoAdapter()
    expect(adapter.name).toBe('doubao')
  })

  it('uses ARK_API_KEY by default', () => {
    const original = process.env['ARK_API_KEY']
    process.env['ARK_API_KEY'] = 'ark-test-key-123'

    try {
      new DoubaoAdapter()
      expect(OpenAIMock).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'ark-test-key-123',
          baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
        })
      )
    } finally {
      if (original === undefined) {
        delete process.env['ARK_API_KEY']
      } else {
        process.env['ARK_API_KEY'] = original
      }
    }
  })

  it('uses official Volcengine Ark baseURL by default', () => {
    new DoubaoAdapter('some-key')
    expect(OpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'some-key',
        baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
      })
    )
  })

  it('allows overriding apiKey and baseURL', () => {
    new DoubaoAdapter('custom-key', 'https://custom.endpoint/v1')
    expect(OpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'custom-key',
        baseURL: 'https://custom.endpoint/v1',
      })
    )
  })

  it('createAdapter("doubao") returns DoubaoAdapter instance', async () => {
    const adapter = await createAdapter('doubao')
    expect(adapter).toBeInstanceOf(DoubaoAdapter)
  })
})
