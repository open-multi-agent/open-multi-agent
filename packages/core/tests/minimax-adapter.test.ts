import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock OpenAI constructor (must be hoisted for Vitest)
// ---------------------------------------------------------------------------
const OpenAIMock = vi.hoisted(() => vi.fn())

vi.mock('openai', () => ({
  default: OpenAIMock,
}))

import { MiniMaxAdapter } from '../src/llm/minimax.js'
import { createAdapter } from '../src/llm/adapter.js'

// ---------------------------------------------------------------------------
// MiniMaxAdapter tests
// ---------------------------------------------------------------------------

describe('MiniMaxAdapter', () => {
  beforeEach(() => {
    OpenAIMock.mockClear()
  })

  it('has name "minimax"', () => {
    const adapter = new MiniMaxAdapter()
    expect(adapter.name).toBe('minimax')
  })

  it('uses MINIMAX_API_KEY by default', () => {
    const original = process.env['MINIMAX_API_KEY']
    process.env['MINIMAX_API_KEY'] = 'minimax-test-key-123'

    try {
      new MiniMaxAdapter()
      expect(OpenAIMock).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'minimax-test-key-123',
          baseURL: 'https://api.minimax.io/v1',
        })
      )
    } finally {
      if (original === undefined) {
        delete process.env['MINIMAX_API_KEY']
      } else {
        process.env['MINIMAX_API_KEY'] = original
      }
    }
  })

  it('uses official MiniMax global baseURL by default', () => {
    new MiniMaxAdapter('some-key')
    expect(OpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'some-key',
        baseURL: 'https://api.minimax.io/v1',
      })
    )
  })

  it('uses MINIMAX_BASE_URL env var when set', () => {
    const original = process.env['MINIMAX_BASE_URL']
    process.env['MINIMAX_BASE_URL'] = 'https://api.minimaxi.com/v1'

    try {
      new MiniMaxAdapter('some-key')
      expect(OpenAIMock).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'some-key',
          baseURL: 'https://api.minimaxi.com/v1',
        })
      )
    } finally {
      if (original === undefined) {
        delete process.env['MINIMAX_BASE_URL']
      } else {
        process.env['MINIMAX_BASE_URL'] = original
      }
    }
  })

  it('allows overriding apiKey and baseURL', () => {
    new MiniMaxAdapter('custom-key', 'https://custom.endpoint/v1')
    expect(OpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'custom-key',
        baseURL: 'https://custom.endpoint/v1',
      })
    )
  })

  it('createAdapter("minimax") returns MiniMaxAdapter instance', async () => {
    const adapter = await createAdapter('minimax')
    expect(adapter).toBeInstanceOf(MiniMaxAdapter)
  })
})
