import { describe, expect, it } from 'vitest'
import { toOpenAIMessages } from '../src/llm/openai-common.js'
import type { LLMMessage } from '../src/types.js'

type OutboundOpts = {
  preserveReasoningAsText?: boolean
  compressReasoningText?: boolean | { minChars?: number }
}

function getAssistantContent(
  messages: LLMMessage[],
  outboundOptions?: OutboundOpts,
): string | null {
  const output = toOpenAIMessages(messages, outboundOptions)
  const first = output[0]
  if (first === undefined || first.role !== 'assistant') {
    throw new Error('expected first message to be assistant')
  }
  return first.content
}

function extractThinkingContent(content: string | null): string {
  if (content === null) {
    throw new Error('expected assistant content')
  }
  const match = content.match(/<thinking>([\s\S]*?)<\/thinking>/)
  if (match?.[1] === undefined) {
    throw new Error('expected thinking tag in assistant content')
  }
  return match[1]
}

describe('toOpenAIMessages reasoning fallback', () => {
  it('keeps historical default behavior when fallback is disabled', () => {
    const messages: LLMMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'plan first' },
          { type: 'text', text: 'Now execute.' },
        ],
      },
    ]

    expect(getAssistantContent(messages)).toBe('Now execute.')
  })

  it('prepends reasoning fallback only when explicitly enabled', () => {
    const messages: LLMMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'plan first' },
          { type: 'text', text: 'Now execute.' },
        ],
      },
    ]

    expect(getAssistantContent(messages, { preserveReasoningAsText: true })).toBe('<thinking>plan first</thinking>Now execute.')
  })

  it('keeps redacted reasoning with placeholder text', () => {
    const messages: LLMMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '', redactedData: 'opaque' },
          { type: 'text', text: 'Proceeding.' },
        ],
      },
    ]

    expect(getAssistantContent(messages, { preserveReasoningAsText: true })).toBe('<thinking>[redacted]</thinking>Proceeding.')
  })

  it('retains fallback text when no regular text block exists', () => {
    const messages: LLMMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'reasoning', text: 'intermediate chain' }],
      },
    ]

    expect(getAssistantContent(messages, { preserveReasoningAsText: true })).toBe('<thinking>intermediate chain</thinking>')
  })

  it('bounds replay size when compress.minChars is set', () => {
    const messages: LLMMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'abcdefghijklmnopqrstuvwxyz0123456789' },
          { type: 'text', text: 'Done.' },
        ],
      },
    ]

    const content = getAssistantContent(messages, {
      preserveReasoningAsText: true,
      compressReasoningText: { minChars: 32 },
    })
    expect(content).not.toBeNull()
    expect(content!).toContain('<thinking>')
    expect(content!).toContain('[truncated')
    expect(extractThinkingContent(content).length).toBeLessThanOrEqual(32)
    expect(content!.endsWith('Done.')).toBe(true)
  })

  it('skips truncation when compressReasoningText is explicitly false', () => {
    // Footgun mode: caller opts into preserve + opts out of compression.
    // The full reasoning text should pass through unchanged.
    const longText = 'x'.repeat(5000)
    const messages: LLMMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: longText },
          { type: 'text', text: 'Done.' },
        ],
      },
    ]

    const content = getAssistantContent(messages, {
      preserveReasoningAsText: true,
      compressReasoningText: false,
    })
    expect(content).toBe(`<thinking>${longText}</thinking>Done.`)
  })

  it('defaults compress to on when preserve is true and compress is undefined', () => {
    // Maintainer guidance from #223: "tie compress default-on to the preserve
    // flag". A very long text should be truncated even without an explicit
    // compress setting.
    const longText = 'y'.repeat(5000)
    const messages: LLMMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: longText },
          { type: 'text', text: 'Done.' },
        ],
      },
    ]

    const content = getAssistantContent(messages, {
      preserveReasoningAsText: true,
    })
    expect(extractThinkingContent(content).length).toBeLessThan(longText.length)
    expect(content!).toContain('[truncated')
  })

  it('omits reasoning-only assistant messages when fallback is disabled', () => {
    const messages: LLMMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'reasoning', text: 'intermediate chain' }],
      },
    ]

    expect(toOpenAIMessages(messages)).toEqual([])
  })

  it('clamps explicit invalid compress.minChars to minimum bound', () => {
    // Note: positive Infinity is intentionally NOT in this list — it now
    // means "no truncation" rather than "clamp to 1". See reasoning-fallback.ts.
    const invalidValues = [0, -3, 0.5, Number.NaN]
    const baseMessages: LLMMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'abcdef' },
          { type: 'text', text: 'Done.' },
        ],
      },
    ]

    for (const value of invalidValues) {
      const content = getAssistantContent(baseMessages, {
        preserveReasoningAsText: true,
        compressReasoningText: { minChars: value },
      })
      expect(extractThinkingContent(content).length).toBe(1)
      expect(content!.endsWith('Done.')).toBe(true)
    }
  })
})
