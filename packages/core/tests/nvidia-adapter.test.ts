import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock OpenAI constructor (must be hoisted for Vitest)
// ---------------------------------------------------------------------------
const OpenAIMock = vi.hoisted(() => vi.fn())

vi.mock('openai', () => ({
  default: OpenAIMock,
}))

import { NvidiaAdapter } from '../src/llm/nvidia.js'
import { createAdapter } from '../src/llm/adapter.js'

// ---------------------------------------------------------------------------
// NvidiaAdapter tests
// ---------------------------------------------------------------------------

describe('NvidiaAdapter', () => {
  beforeEach(() => {
    OpenAIMock.mockClear()
  })

  it('has name "nvidia"', () => {
    const adapter = new NvidiaAdapter()
    expect(adapter.name).toBe('nvidia')
  })

  it('uses NVIDIA_API_KEY by default', () => {
    const original = process.env['NVIDIA_API_KEY']
    process.env['NVIDIA_API_KEY'] = 'nvapi-test-key-123'

    try {
      new NvidiaAdapter()
      expect(OpenAIMock).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'nvapi-test-key-123',
          baseURL: 'https://integrate.api.nvidia.com/v1',
        })
      )
    } finally {
      if (original === undefined) {
        delete process.env['NVIDIA_API_KEY']
      } else {
        process.env['NVIDIA_API_KEY'] = original
      }
    }
  })

  it('uses official NVIDIA baseURL by default', () => {
    new NvidiaAdapter('some-key')
    expect(OpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'some-key',
        baseURL: 'https://integrate.api.nvidia.com/v1',
      })
    )
  })

  it('allows overriding apiKey and baseURL', () => {
    new NvidiaAdapter('custom-key', 'https://custom.endpoint/v1')
    expect(OpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'custom-key',
        baseURL: 'https://custom.endpoint/v1',
      })
    )
  })

  it('createAdapter("nvidia") returns NvidiaAdapter instance', async () => {
    const adapter = await createAdapter('nvidia')
    expect(adapter).toBeInstanceOf(NvidiaAdapter)
  })
})
