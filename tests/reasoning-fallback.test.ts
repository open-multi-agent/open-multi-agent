import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REASONING_FALLBACK_MAX_CHARS,
  reasoningBlockToInlineText,
} from '../src/llm/reasoning-fallback.js'
import type { ReasoningBlock } from '../src/types.js'

describe('reasoningBlockToInlineText', () => {
  it('wraps non-empty text in <thinking> tags', () => {
    const block: ReasoningBlock = { type: 'reasoning', text: 'plan first' }
    expect(reasoningBlockToInlineText(block)).toBe('<thinking>plan first</thinking>')
  })

  it('returns empty string for non-redacted blocks with empty text', () => {
    const block: ReasoningBlock = { type: 'reasoning', text: '' }
    expect(reasoningBlockToInlineText(block)).toBe('')
  })

  it('emits the [redacted] placeholder when redactedData is non-empty', () => {
    const block: ReasoningBlock = {
      type: 'reasoning',
      text: '',
      redactedData: 'opaque-encrypted-blob',
    }
    expect(reasoningBlockToInlineText(block)).toBe('<thinking>[redacted]</thinking>')
  })

  it('prefers the redacted placeholder over text when both are present', () => {
    // Anthropic should never emit both, but the behaviour must be deterministic
    // if a future provider does — never leak text alongside a redacted marker.
    const block: ReasoningBlock = {
      type: 'reasoning',
      text: 'some plaintext',
      redactedData: 'opaque',
    }
    expect(reasoningBlockToInlineText(block)).toBe('<thinking>[redacted]</thinking>')
  })

  it('treats empty redactedData as absent (falls through to text path)', () => {
    const block: ReasoningBlock = {
      type: 'reasoning',
      text: 'visible',
      redactedData: '',
    }
    expect(reasoningBlockToInlineText(block)).toBe('<thinking>visible</thinking>')
  })

  describe('truncation', () => {
    it('leaves text under maxChars unchanged', () => {
      const block: ReasoningBlock = { type: 'reasoning', text: 'short' }
      const out = reasoningBlockToInlineText(block, { maxChars: 100 })
      expect(out).toBe('<thinking>short</thinking>')
    })

    it('produces a head+tail excerpt with marker when over maxChars', () => {
      const text = 'A'.repeat(60) + 'M'.repeat(60) + 'Z'.repeat(60)
      const block: ReasoningBlock = { type: 'reasoning', text }
      const out = reasoningBlockToInlineText(block, { maxChars: 60 })

      expect(out.startsWith('<thinking>')).toBe(true)
      expect(out.endsWith('</thinking>')).toBe(true)
      expect(out).toContain('...[truncated]...')
      // Head should preserve the leading 'A's; tail should preserve the
      // trailing 'Z's. Middle 'M's get dropped by definition of head+tail.
      expect(out).toContain('A')
      expect(out).toContain('Z')
      expect(out).not.toContain('M')

      // Inner text length (excluding wrapper) is bounded by maxChars.
      const inner = out.slice('<thinking>'.length, -'</thinking>'.length)
      expect(inner.length).toBeLessThanOrEqual(60)
    })

    it('falls back to a head slice when maxChars is smaller than the marker', () => {
      const text = 'abcdefghij'
      const block: ReasoningBlock = { type: 'reasoning', text }
      // Marker is "...[truncated]..." (17 chars); ask for budget below that.
      const out = reasoningBlockToInlineText(block, { maxChars: 3 })
      expect(out).toBe('<thinking>abc</thinking>')
    })

    it('clamps non-finite maxChars to 1', () => {
      const block: ReasoningBlock = { type: 'reasoning', text: 'abc' }
      expect(reasoningBlockToInlineText(block, { maxChars: NaN })).toBe('<thinking>a</thinking>')
      expect(reasoningBlockToInlineText(block, { maxChars: Infinity })).toBe('<thinking>a</thinking>')
    })

    it('clamps maxChars below 1 to 1', () => {
      const block: ReasoningBlock = { type: 'reasoning', text: 'abc' }
      expect(reasoningBlockToInlineText(block, { maxChars: 0 })).toBe('<thinking>a</thinking>')
      expect(reasoningBlockToInlineText(block, { maxChars: -10 })).toBe('<thinking>a</thinking>')
    })

    it('uses DEFAULT_REASONING_FALLBACK_MAX_CHARS when maxChars is omitted', () => {
      const text = 'X'.repeat(DEFAULT_REASONING_FALLBACK_MAX_CHARS + 100)
      const block: ReasoningBlock = { type: 'reasoning', text }
      const out = reasoningBlockToInlineText(block)
      const inner = out.slice('<thinking>'.length, -'</thinking>'.length)
      expect(inner.length).toBeLessThanOrEqual(DEFAULT_REASONING_FALLBACK_MAX_CHARS)
    })
  })

  describe('one-way invariant', () => {
    it('always emits a string output (no parsing back to ReasoningBlock)', () => {
      // This test is a documentation marker rather than a behaviour check:
      // the helper has no inverse, by design. If a future contributor adds
      // an `inlineTextToReasoningBlock` function, it would violate the
      // safety contract documented in src/llm/reasoning-fallback.ts.
      const block: ReasoningBlock = { type: 'reasoning', text: 'x' }
      const out = reasoningBlockToInlineText(block)
      expect(typeof out).toBe('string')
    })
  })
})
