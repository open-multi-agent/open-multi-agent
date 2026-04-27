import { describe, expect, it } from 'vitest'
import { estimateTokens } from '../src/utils/tokens.js'
import type { LLMMessage } from '../src/types.js'

describe('estimateTokens', () => {
  it('counts retained reasoning text', () => {
    const messages: LLMMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'reasoning', text: 'x'.repeat(400) }],
      },
    ]

    expect(estimateTokens(messages)).toBe(100)
  })
})
