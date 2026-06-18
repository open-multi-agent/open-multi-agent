import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock OpenAI constructor (must be hoisted for Vitest)
// ---------------------------------------------------------------------------
const OpenAIMock = vi.hoisted(() => vi.fn())

vi.mock('openai', () => ({
  default: OpenAIMock,
}))

import { HunyuanAdapter } from '../src/llm/hunyuan.js'
import { createAdapter } from '../src/llm/adapter.js'

// ---------------------------------------------------------------------------
// HunyuanAdapter tests
// ---------------------------------------------------------------------------

describe('HunyuanAdapter', () => {
  let savedBaseUrl: string | undefined

  beforeEach(() => {
    OpenAIMock.mockClear()
    // Keep default-endpoint assertions hermetic regardless of the ambient env.
    savedBaseUrl = process.env['HUNYUAN_BASE_URL']
    delete process.env['HUNYUAN_BASE_URL']
  })

  afterEach(() => {
    if (savedBaseUrl === undefined) {
      delete process.env['HUNYUAN_BASE_URL']
    } else {
      process.env['HUNYUAN_BASE_URL'] = savedBaseUrl
    }
  })

  it('has name "hunyuan"', () => {
    const adapter = new HunyuanAdapter()
    expect(adapter.name).toBe('hunyuan')
  })

  it('overrides capabilities to echoesReasoning: "tool-use-only"', () => {
    // hy3-preview's interleaved-thinking mode requires `reasoning_content` to
    // be backfilled on every tool-using turn (Tencent TokenHub spec). The
    // override propagates `nativeReasoningEchoProvider: 'hunyuan'` to the
    // message builder; non-thinking Hunyuan models emit no reasoning, so the
    // echo is a no-op for them. Must NOT inherit OpenAI's default `'never'`.
    const adapter = new HunyuanAdapter('dummy-key')
    expect(adapter.capabilities).toEqual({ echoesReasoning: 'tool-use-only' })
  })

  it('uses HUNYUAN_API_KEY by default', () => {
    const original = process.env['HUNYUAN_API_KEY']
    process.env['HUNYUAN_API_KEY'] = 'hunyuan-test-key-123'

    try {
      new HunyuanAdapter()
      expect(OpenAIMock).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'hunyuan-test-key-123',
          baseURL: 'https://tokenhub.tencentmaas.com/v1',
        })
      )
    } finally {
      if (original === undefined) {
        delete process.env['HUNYUAN_API_KEY']
      } else {
        process.env['HUNYUAN_API_KEY'] = original
      }
    }
  })

  it('uses the Tencent MaaS / TokenHub baseURL by default', () => {
    new HunyuanAdapter('some-key')
    expect(OpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'some-key',
        baseURL: 'https://tokenhub.tencentmaas.com/v1',
      })
    )
  })

  it('allows overriding apiKey and baseURL', () => {
    new HunyuanAdapter('custom-key', 'https://custom.endpoint/v1')
    expect(OpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'custom-key',
        baseURL: 'https://custom.endpoint/v1',
      })
    )
  })

  it('honors HUNYUAN_BASE_URL for the legacy / alternate clusters', () => {
    process.env['HUNYUAN_BASE_URL'] = 'https://api.hunyuan.cloud.tencent.com/v1'

    new HunyuanAdapter('some-key')
    expect(OpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'some-key',
        baseURL: 'https://api.hunyuan.cloud.tencent.com/v1',
      })
    )
  })

  it('prefers explicit baseURL arg over HUNYUAN_BASE_URL', () => {
    process.env['HUNYUAN_BASE_URL'] = 'https://api.hunyuan.cloud.tencent.com/v1'

    new HunyuanAdapter('some-key', 'https://explicit.endpoint/v1')
    expect(OpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'some-key',
        baseURL: 'https://explicit.endpoint/v1',
      })
    )
  })

  it('createAdapter("hunyuan") returns HunyuanAdapter instance', async () => {
    const adapter = await createAdapter('hunyuan')
    expect(adapter).toBeInstanceOf(HunyuanAdapter)
  })
})
