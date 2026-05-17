import { describe, expect, it } from 'vitest'
import { toOpenAIMessages } from '../src/llm/openai-common.js'
import type { LLMMessage } from '../src/types.js'

function getAssistantContent(messages: LLMMessage[]): string | null {
  const output = toOpenAIMessages(messages)
  const first = output[0]
  if (first === undefined || first.role !== 'assistant') {
    throw new Error('expected first message to be assistant')
  }
  return first.content
}

describe('toOpenAIMessages reasoning fallback', () => {
  it('prepends reasoning fallback to the next text block', () => {
    const messages: LLMMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'plan first' },
          { type: 'text', text: 'Now execute.' },
        ],
      },
    ]

    expect(getAssistantContent(messages)).toBe('<thinking>plan first</thinking>Now execute.')
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

    expect(getAssistantContent(messages)).toBe('<thinking>[redacted]</thinking>Proceeding.')
  })

  it('retains fallback text when no regular text block exists', () => {
    const messages: LLMMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'reasoning', text: 'intermediate chain' }],
      },
    ]

    expect(getAssistantContent(messages)).toBe('<thinking>intermediate chain</thinking>')
  })
})
