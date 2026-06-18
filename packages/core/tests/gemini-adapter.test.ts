import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock GoogleGenAI constructor (must be hoisted for Vitest)
// ---------------------------------------------------------------------------
const GoogleGenAIMock = vi.hoisted(() => vi.fn())

vi.mock('@google/genai', () => ({
  GoogleGenAI: GoogleGenAIMock,
  FunctionCallingConfigMode: { AUTO: 'AUTO' },
}))

import { GeminiAdapter } from '../src/llm/gemini.js'
import { createAdapter } from '../src/llm/adapter.js'

// ---------------------------------------------------------------------------
// GeminiAdapter tests
// ---------------------------------------------------------------------------

describe('GeminiAdapter', () => {
  beforeEach(() => {
    GoogleGenAIMock.mockClear()
  })

  it('has name "gemini"', () => {
    const adapter = new GeminiAdapter()
    expect(adapter.name).toBe('gemini')
  })

  it('uses GEMINI_API_KEY by default', () => {
    const originalGemini = process.env['GEMINI_API_KEY']
    const originalGoogle = process.env['GOOGLE_API_KEY']
    process.env['GEMINI_API_KEY'] = 'gemini-env-key'
    delete process.env['GOOGLE_API_KEY']

    try {
      new GeminiAdapter()
      expect(GoogleGenAIMock).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'gemini-env-key',
        }),
      )
    } finally {
      if (originalGemini === undefined) {
        delete process.env['GEMINI_API_KEY']
      } else {
        process.env['GEMINI_API_KEY'] = originalGemini
      }
      if (originalGoogle === undefined) {
        delete process.env['GOOGLE_API_KEY']
      } else {
        process.env['GOOGLE_API_KEY'] = originalGoogle
      }
    }
  })

  it('falls back to GOOGLE_API_KEY when GEMINI_API_KEY is unset', () => {
    const originalGemini = process.env['GEMINI_API_KEY']
    const originalGoogle = process.env['GOOGLE_API_KEY']
    delete process.env['GEMINI_API_KEY']
    process.env['GOOGLE_API_KEY'] = 'google-env-key'

    try {
      new GeminiAdapter()
      expect(GoogleGenAIMock).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'google-env-key',
        }),
      )
    } finally {
      if (originalGemini === undefined) {
        delete process.env['GEMINI_API_KEY']
      } else {
        process.env['GEMINI_API_KEY'] = originalGemini
      }
      if (originalGoogle === undefined) {
        delete process.env['GOOGLE_API_KEY']
      } else {
        process.env['GOOGLE_API_KEY'] = originalGoogle
      }
    }
  })

  it('allows overriding apiKey explicitly', () => {
    new GeminiAdapter('explicit-key')
    expect(GoogleGenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'explicit-key',
      }),
    )
  })

  it('createAdapter("gemini") returns GeminiAdapter instance', async () => {
    const adapter = await createAdapter('gemini')
    expect(adapter).toBeInstanceOf(GeminiAdapter)
  })
})
