import { describe, expect, it } from 'vitest'
import { classifyRunFailure } from '../src/observability/status.js'
import {
  EVAL_STORE_SCHEMA_MAJOR,
  defineScorer,
  type EvalRecord,
  type Scorer,
  type ScorerContext,
} from '../src/eval/index.js'

function context(overrides: Partial<ScorerContext> = {}): ScorerContext {
  return {
    evalCase: { id: 'case-1', input: 'question', expected: 'answer' },
    output: 'answer',
    metadata: {},
    signal: new AbortController().signal,
    ...overrides,
  }
}

describe('defineScorer', () => {
  it('rejects an empty name and a non-function score', () => {
    expect(() => defineScorer({ name: '  ', score: () => ({ score: 1 }) })).toThrow(/name/i)
    expect(() => defineScorer({
      name: 'broken',
      score: 1,
    } as unknown as Scorer)).toThrow(/score/i)
  })

  it('returns a frozen scorer without freezing the caller definition', () => {
    const definition: Scorer = { name: 'exact-match', score: () => ({ score: 1 }) }
    const scorer = defineScorer(definition)

    expect(Object.isFrozen(scorer)).toBe(true)
    expect(Object.isFrozen(definition)).toBe(false)
  })

  it('supports synchronous and asynchronous score functions', async () => {
    const sync = defineScorer({ name: 'sync', score: () => ({ score: 0.25 }) })
    const asyncScorer = defineScorer({
      name: 'async',
      async score() {
        return { score: 0.75, pass: true }
      },
    })

    expect(sync.score(context())).toEqual({ score: 0.25 })
    await expect(asyncScorer.score(context())).resolves.toEqual({ score: 0.75, pass: true })
  })

  it('passes the caller AbortSignal through unchanged', () => {
    const controller = new AbortController()
    const scorer = defineScorer({
      name: 'signal-aware',
      score(ctx) {
        return { score: ctx.signal === controller.signal ? 1 : 0 }
      },
    })

    expect(scorer.score(context({ signal: controller.signal }))).toEqual({ score: 1 })
  })

  it('validates result shape and normalized score range', async () => {
    const tooHigh = defineScorer({ name: 'too-high', score: () => ({ score: 1.01 }) })
    const invalidDetails = defineScorer({
      name: 'nested-details',
      score: () => ({ score: 1, details: { nested: { value: 1 } } }),
    } as unknown as Scorer)
    const asyncNaN = defineScorer({
      name: 'nan',
      async score() {
        return { score: Number.NaN }
      },
    })

    expect(() => tooHigh.score(context())).toThrow(/\[0, 1\]/)
    expect(() => invalidDetails.score(context())).toThrow(/TraceAttributeValue/)
    await expect(asyncNaN.score(context())).rejects.toThrow(/\[0, 1\]/)
  })

  it('propagates scorer failures instead of converting them to score zero', async () => {
    const failure = new Error('scorer unavailable')
    const sync = defineScorer({
      name: 'throws',
      score() {
        throw failure
      },
    })
    const asyncScorer = defineScorer({
      name: 'rejects',
      async score() {
        throw failure
      },
    })

    expect(() => sync.score(context())).toThrow(failure)
    await expect(asyncScorer.score(context())).rejects.toBe(failure)
  })
})

describe('evaluation public contract', () => {
  it('supports the documented exact-match scorer through the eval barrel', async () => {
    const exact = defineScorer({
      name: 'exact-match',
      version: '1',
      score({ output, evalCase }) {
        const hit = output === evalCase.expected
        return { score: hit ? 1 : 0, pass: hit }
      },
    })

    expect(exact.score(context())).toEqual({ score: 1, pass: true })
  })

  it('exports the EvalRecord schema contract and keeps scorer errors scoreless', () => {
    const error = classifyRunFailure(new Error('judge failed')).errorInfo
    const record: EvalRecord = {
      schemaVersion: EVAL_STORE_SCHEMA_MAJOR,
      recordId: 'record-1',
      evalRunId: 'eval-run-1',
      source: 'offline',
      timestampUnixMs: 1,
      scorer: { name: 'relevancy', version: '1' },
      status: 'scorer_error',
      metadata: { promptVersion: 'v2' },
      error,
    }

    expect(EVAL_STORE_SCHEMA_MAJOR).toBe(1)
    expect(record.status).toBe('scorer_error')
    expect(record.score).toBeUndefined()
    expect(record.error?.kind).toBe('unknown')
  })

  it('does not re-export eval symbols from the root entry', async () => {
    const root = await import('../src/index.js')
    expect('defineScorer' in root).toBe(false)
    expect('createJudgeScorer' in root).toBe(false)
  })
})
