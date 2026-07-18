import { describe, expect, it } from 'vitest'
import { defineEvalSet } from '../src/eval/index.js'
import type { EvalSet } from '../src/eval/index.js'

describe('defineEvalSet', () => {
  it('validates, defensively copies, and deeply freezes a versioned set', () => {
    const source = {
      name: 'greetings',
      version: '1.0.0',
      description: 'Uppercase checks',
      cases: [{
        id: 'hello',
        input: 'hello',
        expected: 'HELLO',
        tags: ['upper'],
        metadata: { split: 'holdout' },
      }],
      defaults: { repeats: 2, concurrency: 3 },
    }

    const set = defineEvalSet(source)
    source.cases[0]!.tags.push('mutated')

    expect(set).toEqual({
      name: 'greetings',
      version: '1.0.0',
      description: 'Uppercase checks',
      cases: [{
        id: 'hello',
        input: 'hello',
        expected: 'HELLO',
        tags: ['upper'],
        metadata: { split: 'holdout' },
      }],
      defaults: { repeats: 2, concurrency: 3 },
    })
    expect(Object.isFrozen(set)).toBe(true)
    expect(Object.isFrozen(set.cases)).toBe(true)
    expect(Object.isFrozen(set.cases[0])).toBe(true)
    expect(Object.isFrozen(set.cases[0]!.tags)).toBe(true)
    expect(Object.isFrozen(set.defaults)).toBe(true)
  })

  it.each([
    ['duplicate case ids', {
      name: 'set', version: '1', cases: [{ id: 'same', input: 1 }, { id: 'same', input: 2 }],
    }],
    ['empty version', { name: 'set', version: ' ', cases: [{ id: 'a', input: 1 }] }],
    ['empty name', { name: '', version: '1', cases: [{ id: 'a', input: 1 }] }],
    ['empty cases', { name: 'set', version: '1', cases: [] }],
    ['non-string tag', {
      name: 'set', version: '1', cases: [{ id: 'a', input: 1, tags: [1] }],
    }],
    ['invalid defaults', {
      name: 'set', version: '1', cases: [{ id: 'a', input: 1 }], defaults: { repeats: 0 },
    }],
  ])('rejects %s', (_label, value) => {
    expect(() => defineEvalSet(value as unknown as EvalSet)).toThrow()
  })
})
