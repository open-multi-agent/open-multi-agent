import { describe, it, expect } from 'vitest'
import { STOP_WORDS, extractKeywords, keywordScore } from '../src/utils/keywords.js'

// Regression coverage for the shared keyword helpers extracted from
// orchestrator.ts and scheduler.ts (PR #70 review point 1).
//
// These tests pin behaviour so future drift between Scheduler and the
// short-circuit selector is impossible — any edit must update the shared
// module and these tests at once.

describe('utils/keywords', () => {
  describe('STOP_WORDS', () => {
    it('contains all 26 stop words', () => {
      // Sanity-check the canonical list — if anyone adds/removes a stop word
      // they should also update this assertion.
      expect(STOP_WORDS.size).toBe(26)
    })

    it('includes "then" and "and" so they cannot dominate scoring', () => {
      expect(STOP_WORDS.has('then')).toBe(true)
      expect(STOP_WORDS.has('and')).toBe(true)
    })
  })

  describe('extractKeywords', () => {
    it('lowercases and dedupes', () => {
      const out = extractKeywords('TypeScript typescript TYPESCRIPT')
      expect(out).toEqual(['typescript'])
    })

    it('drops words shorter than 4 characters', () => {
      const out = extractKeywords('a bb ccc dddd eeeee')
      expect(out).toEqual(['dddd', 'eeeee'])
    })

    it('drops stop words', () => {
      const out = extractKeywords('the cat and the dog have meals')
      // 'cat', 'dog', 'have' filtered: 'cat'/'dog' too short, 'have' is a stop word
      expect(out).toEqual(['meals'])
    })

    it('splits on non-word characters', () => {
      const out = extractKeywords('hello,world!writer-mode')
      expect(out.sort()).toEqual(['hello', 'mode', 'world', 'writer'])
    })

    it('returns empty array for empty input', () => {
      expect(extractKeywords('')).toEqual([])
    })
  })

  describe('keywordScore', () => {
    it('counts each keyword at most once', () => {
      // 'code' appears twice in the text but contributes 1
      expect(keywordScore('code review code style', ['code'])).toBe(1)
    })

    it('is case-insensitive', () => {
      expect(keywordScore('TYPESCRIPT', ['typescript'])).toBe(1)
      expect(keywordScore('typescript', ['TYPESCRIPT'])).toBe(1)
    })

    it('returns 0 when no keywords match', () => {
      expect(keywordScore('hello world', ['rust', 'go'])).toBe(0)
    })

    it('sums distinct keyword hits', () => {
      expect(keywordScore('write typescript code for the api', ['typescript', 'code', 'rust'])).toBe(2)
    })

    it('returns 0 for empty keywords array', () => {
      expect(keywordScore('any text', [])).toBe(0)
    })
  })
})
