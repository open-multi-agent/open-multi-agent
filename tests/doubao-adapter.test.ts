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

  it('uses DOUBAO_API_KEY by default', () => {
    const original = process.env['DOUBAO_API_KEY']
    process.env['DOUBAO_API_KEY'] = 'doubao-test-key-123'

    try {
      new DoubaoAdapter()
      expect(OpenAIMock).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'doubao-test-key-123',
          baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
        })
      )
    } finally {
      if (original === undefined) {
        delete process.env['DOUBAO_API_KEY']
      } else {
        process.env['DOUBAO_API_KEY'] = original
      }
    }
  })

  it('uses official DouBao baseURL by default', () => {
    new DoubaoAdapter('some-key')
    expect(OpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'some-key',
        baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
      })
    )
  })

  it('uses DOUBAO_BASE_URL env var when set', () => {
    const original = process.env['DOUBAO_BASE_URL']
    process.env['DOUBAO_BASE_URL'] = 'https://custom.doubao.endpoint/api/v3'

    try {
      new DoubaoAdapter('some-key')
      expect(OpenAIMock).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'some-key',
          baseURL: 'https://custom.doubao.endpoint/api/v3',
        })
      )
    } finally {
      if (original === undefined) {
        delete process.env['DOUBAO_BASE_URL']
      } else {
        process.env['DOUBAO_BASE_URL'] = original
      }
    }
  })

  it('allows overriding apiKey and baseURL', () => {
    new DoubaoAdapter('custom-key', 'https://custom.endpoint/api/v3')
    expect(OpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'custom-key',
        baseURL: 'https://custom.endpoint/api/v3',
      })
    )
  })

  it('createAdapter("doubao") returns DoubaoAdapter instance', async () => {
    const adapter = await createAdapter('doubao')
    expect(adapter).toBeInstanceOf(DoubaoAdapter)
  })
})
