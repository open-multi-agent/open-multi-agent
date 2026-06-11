import { describe, it, expect, vi, beforeEach } from 'vitest'
import { textMsg, chatOpts, collectEvents } from './helpers/llm-fixtures.js'
import type { LLMMessage } from '../src/types.js'
import { assertValidMessages } from '../src/llm/validate.js'
import { InvalidMessageError } from '../src/errors.js'

// ---------------------------------------------------------------------------
// Mock the SDKs. The adapters instantiate a client in their constructor, but
// the guard fires on the first line of chat()/stream() — before any SDK call —
// so the mocked methods are never reached in these tests.
// ---------------------------------------------------------------------------

vi.mock('openai', () => {
  const OpenAIMock = vi.fn(() => ({ chat: { completions: { create: vi.fn() } } }))
  return { default: OpenAIMock, OpenAI: OpenAIMock }
})

vi.mock('@anthropic-ai/sdk', () => {
  const AnthropicMock = vi.fn(() => ({ messages: { create: vi.fn(), stream: vi.fn() } }))
  return { default: AnthropicMock, Anthropic: AnthropicMock }
})

import { OpenAIAdapter } from '../src/llm/openai.js'
import { AnthropicAdapter } from '../src/llm/anthropic.js'

// The reported crash: content is a raw string instead of a ContentBlock[].
const stringContent = [{ role: 'user', content: 'oops' }] as unknown as LLMMessage[]

// ---------------------------------------------------------------------------
// Unit: the shared guard
// ---------------------------------------------------------------------------

describe('assertValidMessages', () => {
  it('accepts valid message shapes', () => {
    expect(() => assertValidMessages([textMsg('user', 'hi')])).not.toThrow()
    expect(() => assertValidMessages([
      { role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'tool_use', id: '1', name: 'x', input: {} }] },
    ] as LLMMessage[])).not.toThrow()
    // An empty content array is a valid ContentBlock[] — the guard must not over-reject.
    expect(() => assertValidMessages([{ role: 'user', content: [] }] as LLMMessage[])).not.toThrow()
  })

  it('rejects a non-array messages list', () => {
    expect(() => assertValidMessages('nope' as unknown as LLMMessage[])).toThrow(InvalidMessageError)
    expect(() => assertValidMessages(null as unknown as LLMMessage[])).toThrow(/messages must be an array, got null/)
  })

  it('rejects a non-object message', () => {
    expect(() => assertValidMessages(['x'] as unknown as LLMMessage[])).toThrow(/messages\[0\] must be an object, got string/)
  })

  it('rejects string content and names the offending index', () => {
    expect(() => assertValidMessages(stringContent)).toThrow(InvalidMessageError)
    expect(() => assertValidMessages(
      [textMsg('user', 'ok'), { role: 'user', content: 'oops' }] as unknown as LLMMessage[],
    )).toThrow(/messages\[1\]\.content must be a ContentBlock\[\], got string/)
  })

  it('rejects null or object content', () => {
    expect(() => assertValidMessages([{ role: 'user', content: null }] as unknown as LLMMessage[])).toThrow(/content must be a ContentBlock\[\], got null/)
    expect(() => assertValidMessages([{ role: 'user', content: {} }] as unknown as LLMMessage[])).toThrow(/content must be a ContentBlock\[\], got object/)
  })

  it('rejects a content block without a string type', () => {
    expect(() => assertValidMessages([{ role: 'user', content: [null] }] as unknown as LLMMessage[]))
      .toThrow(/messages\[0\]\.content\[0\] must be a content block with a string "type"/)
    expect(() => assertValidMessages([{ role: 'user', content: [{ text: 'no type' }] }] as unknown as LLMMessage[]))
      .toThrow(InvalidMessageError)
  })
})

// ---------------------------------------------------------------------------
// Wiring: the guard is invoked at each adapter entry (openai-common family +
// independent family), for both chat() and stream().
// ---------------------------------------------------------------------------

describe('adapter entry validation', () => {
  let openai: OpenAIAdapter
  let anthropic: AnthropicAdapter

  beforeEach(() => {
    vi.clearAllMocks()
    openai = new OpenAIAdapter('test-key')
    anthropic = new AnthropicAdapter('test-key')
  })

  it('OpenAI chat() rejects string content', async () => {
    await expect(openai.chat(stringContent, chatOpts())).rejects.toThrow(InvalidMessageError)
  })

  it('OpenAI stream() rejects string content on iteration', async () => {
    await expect(collectEvents(openai.stream(stringContent, chatOpts()))).rejects.toThrow(InvalidMessageError)
  })

  it('Anthropic chat() rejects string content', async () => {
    await expect(anthropic.chat(stringContent, chatOpts())).rejects.toThrow(InvalidMessageError)
  })

  it('Anthropic stream() rejects string content on iteration', async () => {
    await expect(collectEvents(anthropic.stream(stringContent, chatOpts()))).rejects.toThrow(InvalidMessageError)
  })
})
