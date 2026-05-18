import { describe, expect, it } from 'vitest'
import { toOpenAIMessages } from '../src/llm/openai-common.js'
import type { LLMMessage } from '../src/types.js'

function getAssistantContent(
  messages: LLMMessage[],
  replayOptions?: { enableReasoningTextReplay?: boolean; maxReasoningReplayChars?: number },
): string | null {
  const output = toOpenAIMessages(messages, replayOptions)
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

    expect(getAssistantContent(messages, { enableReasoningTextReplay: true })).toBe('<thinking>plan first</thinking>Now execute.')
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

    expect(getAssistantContent(messages, { enableReasoningTextReplay: true })).toBe('<thinking>[redacted]</thinking>Proceeding.')
  })

  it('retains fallback text when no regular text block exists', () => {
    const messages: LLMMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'reasoning', text: 'intermediate chain' }],
      },
    ]

    expect(getAssistantContent(messages, { enableReasoningTextReplay: true })).toBe('<thinking>intermediate chain</thinking>')
  })

  it('bounds replay size with truncation when enabled', () => {
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
      enableReasoningTextReplay: true,
      maxReasoningReplayChars: 32,
    })
    expect(content).not.toBeNull()
    expect(content!).toContain('<thinking>')
    expect(content!).toContain('[truncated')
    expect(extractThinkingContent(content).length).toBeLessThanOrEqual(32)
    expect(content!.endsWith('Done.')).toBe(true)
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

  it('clamps explicit invalid max chars to minimum bound', () => {
    const invalidValues = [0, -3, 0.5, Number.NaN, Number.POSITIVE_INFINITY]
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
        enableReasoningTextReplay: true,
        maxReasoningReplayChars: value,
      })
      expect(extractThinkingContent(content).length).toBe(1)
      expect(content!.endsWith('Done.')).toBe(true)
    }
  })
})
