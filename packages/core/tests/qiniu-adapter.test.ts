import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock OpenAI constructor (must be hoisted for Vitest)
// ---------------------------------------------------------------------------
const OpenAIMock = vi.hoisted(() => vi.fn())

vi.mock('openai', () => ({
  default: OpenAIMock,
}))

import { QiniuAdapter } from '../src/llm/qiniu.js'
import { createAdapter } from '../src/llm/adapter.js'

// ---------------------------------------------------------------------------
// QiniuAdapter tests
// ---------------------------------------------------------------------------

describe('QiniuAdapter', () => {
  beforeEach(() => {
    OpenAIMock.mockClear()
  })

  it('has name "qiniu"', () => {
    const adapter = new QiniuAdapter()
    expect(adapter.name).toBe('qiniu')
  })

  it('uses QINIU_API_KEY by default', () => {
    const original = process.env['QINIU_API_KEY']
    process.env['QINIU_API_KEY'] = 'qiniu-test-key-123'

    try {
      new QiniuAdapter()
      expect(OpenAIMock).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'qiniu-test-key-123',
          baseURL: 'https://api.qnaigc.com/v1',
        })
      )
    } finally {
      if (original === undefined) {
        delete process.env['QINIU_API_KEY']
      } else {
        process.env['QINIU_API_KEY'] = original
      }
    }
  })

  it('uses official Qiniu baseURL by default', () => {
    new QiniuAdapter('some-key')
    expect(OpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'some-key',
        baseURL: 'https://api.qnaigc.com/v1',
      })
    )
  })

  it('allows overriding apiKey and baseURL', () => {
    new QiniuAdapter('custom-key', 'https://custom.endpoint/v1')
    expect(OpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'custom-key',
        baseURL: 'https://custom.endpoint/v1',
      })
    )
  })

  it('createAdapter("qiniu") returns QiniuAdapter instance', async () => {
    const adapter = await createAdapter('qiniu')
    expect(adapter).toBeInstanceOf(QiniuAdapter)
  })
})
