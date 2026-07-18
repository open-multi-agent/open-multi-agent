import { describe, expect, it, vi } from 'vitest'
import {
  defineEvalSet,
  defineScorer,
  runEvalSet,
} from '../src/eval/index.js'
import type {
  EvalProgressEvent,
  EvalTarget,
  ScorerContext,
} from '../src/eval/index.js'
import type { RunCostSummary, StoredRun, TraceStore } from '../src/observability/store.js'
import type { AgentRunResult, RunIdentity } from '../src/types.js'

function identity(runId = 'run-1'): RunIdentity {
  return {
    runId,
    attempt: 1,
    traceId: 'a'.repeat(32),
    rootSpanId: 'b'.repeat(16),
  }
}

function agentResult(
  overrides: Partial<AgentRunResult> = {},
): AgentRunResult {
  return {
    success: true,
    output: 'output',
    messages: [],
    tokenUsage: { input_tokens: 2, output_tokens: 3 },
    toolCalls: [],
    identity: identity(),
    ...overrides,
  }
}

const exact = defineScorer({
  name: 'exact',
  score: ({ output, evalCase }) => ({
    score: output === evalCase.expected ? 1 : 0,
    pass: output === evalCase.expected,
  }),
})

describe('runEvalSet', () => {
  it('satisfies the public two-case, two-repeat contract', async () => {
    const set = defineEvalSet({
      name: 'greetings',
      version: '1.0.0',
      cases: [
        { id: 'a', input: 'hi', expected: 'HI', tags: ['upper'] },
        { id: 'b', input: 'yo', expected: 'YO', tags: ['upper'] },
      ],
    })
    const target: EvalTarget = async (input) => ({ output: String(input).toUpperCase() })

    const report = await runEvalSet(set, target, { scorers: [exact], repeats: 2 })

    expect(report.records).toHaveLength(4)
    expect(report.aggregates[0]).toMatchObject({
      avg: 1,
      passRate: 1,
      scoredCount: 4,
      errorCount: 0,
    })
    expect(report).toMatchObject({
      schemaVersion: 1,
      evalSet: { name: 'greetings', version: '1.0.0' },
      caseCount: 2,
      repeats: 2,
      totals: { targetErrors: 0 },
    })
  })

  it('honors repeats, tag filtering, bounded concurrency, and serial scorers', async () => {
    const set = defineEvalSet({
      name: 'filtered', version: '1',
      cases: [
        { id: 'a', input: 'a', tags: ['keep'] },
        { id: 'b', input: 'b', tags: ['drop'] },
        { id: 'c', input: 'c', tags: ['keep', 'also'] },
      ],
      defaults: { repeats: 4, concurrency: 3 },
    })
    let active = 0
    let maxActive = 0
    const order: string[] = []
    const target: EvalTarget = async (input, context) => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
      return { output: `${input}-${context.repeat}` }
    }
    const first = defineScorer({ name: 'first', async score({ evalCase }) {
      order.push(`${evalCase.id}:first:start`)
      await new Promise((resolve) => setTimeout(resolve, 2))
      order.push(`${evalCase.id}:first:done`)
      return { score: 1 }
    } })
    const second = defineScorer({ name: 'second', score({ evalCase }) {
      order.push(`${evalCase.id}:second`)
      return { score: 1 }
    } })

    const report = await runEvalSet(set, target, {
      scorers: [first, second],
      repeats: 2,
      concurrency: 2,
      filterTags: ['keep'],
    })

    expect(report.caseCount).toBe(2)
    expect(report.repeats).toBe(2)
    expect(report.records).toHaveLength(8)
    expect(new Set(report.records.map((record) => record.caseId))).toEqual(new Set(['a', 'c']))
    expect(maxActive).toBe(2)
    for (const caseId of ['a', 'c']) {
      const starts = order.reduce<number[]>((indexes, value, index) =>
        value === `${caseId}:first:done` ? [...indexes, index] : indexes, [])
      const seconds = order.reduce<number[]>((indexes, value, index) =>
        value === `${caseId}:second` ? [...indexes, index] : indexes, [])
      expect(starts).toHaveLength(2)
      expect(seconds).toHaveLength(2)
      expect(seconds[0]).toBeGreaterThan(starts[0]!)
      expect(seconds[1]).toBeGreaterThan(starts[1]!)
    }
  })

  it('records one target_error per failed sample and isolates scorer_error records', async () => {
    const set = defineEvalSet({
      name: 'errors', version: '1',
      cases: [
        { id: 'ok', input: 'ok', expected: 'ok' },
        { id: 'score-fails', input: 'score-fails', expected: 'score-fails' },
        { id: 'target-fails', input: 'target-fails' },
      ],
    })
    const flaky = defineScorer({
      name: 'flaky',
      score({ evalCase }) {
        if (evalCase.id === 'score-fails') throw new Error('scorer secret')
        return { score: 0.5 }
      },
    })
    const progress: EvalProgressEvent[] = []

    const report = await runEvalSet(set, async (input) => {
      if (input === 'target-fails') throw new Error('target failed')
      return { output: input }
    }, { scorers: [exact, flaky], concurrency: 1, onProgress: (event) => progress.push(event) })

    const targetErrors = report.records.filter((record) => record.status === 'target_error')
    const scorerErrors = report.records.filter((record) => record.status === 'scorer_error')
    expect(report.records).toHaveLength(5)
    expect(targetErrors).toHaveLength(1)
    expect(targetErrors[0]).toMatchObject({
      caseId: 'target-fails', scorer: { name: '_target' }, status: 'target_error',
    })
    expect(targetErrors[0]?.score).toBeUndefined()
    expect(scorerErrors).toHaveLength(1)
    expect(scorerErrors[0]).toMatchObject({
      caseId: 'score-fails', scorer: { name: 'flaky' }, status: 'scorer_error',
    })
    expect(scorerErrors[0]?.score).toBeUndefined()
    expect(report.totals.targetErrors).toBe(1)
    expect(report.aggregates).toEqual(expect.arrayContaining([
      expect.objectContaining({ scorer: { name: 'exact' }, scoredCount: 2, errorCount: 0, avg: 1 }),
      expect.objectContaining({ scorer: { name: 'flaky' }, scoredCount: 1, errorCount: 1, avg: 0.5 }),
    ]))
    expect(progress).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'target_error', caseId: 'target-fails' }),
      expect.objectContaining({ type: 'scorer_error', caseId: 'score-fails', scorer: 'flaky' }),
    ]))
  })

  it('turns scorer timeouts into scorer_error and continues to later scorers', async () => {
    const slow = defineScorer({
      name: 'slow', timeoutMs: 5,
      async score() {
        await new Promise((resolve) => setTimeout(resolve, 30))
        return { score: 1 }
      },
    })
    const later = defineScorer({ name: 'later', score: () => ({ score: 0.75 }) })
    const set = defineEvalSet({ name: 'timeout', version: '1', cases: [{ id: 'a', input: 'a' }] })

    const report = await runEvalSet(set, async (input) => ({ output: input }), {
      scorers: [slow, later],
    })

    expect(report.records).toEqual([
      expect.objectContaining({
        scorer: { name: 'slow' }, status: 'scorer_error',
        error: expect.objectContaining({ kind: 'timeout', name: 'TimeoutError' }),
      }),
      expect.objectContaining({ scorer: { name: 'later' }, status: 'scored', score: 0.75 }),
    ])
  })

  it('stops scheduling after abort, waits for the in-flight sample, and returns a partial report', async () => {
    const controller = new AbortController()
    const set = defineEvalSet({
      name: 'abort', version: '1',
      cases: Array.from({ length: 5 }, (_, index) => ({ id: String(index), input: index })),
    })
    let calls = 0
    const report = await runEvalSet(set, async (input) => {
      calls++
      await new Promise((resolve) => setTimeout(resolve, 2))
      controller.abort()
      return { output: input }
    }, { scorers: [exact], concurrency: 1, signal: controller.signal })

    expect(calls).toBe(1)
    expect(report.aborted).toBe(true)
    expect(report.records).toHaveLength(1)
    expect(report.records[0]?.caseId).toBe('0')
  })

  it('uses nearest-rank percentiles, explicit pass denominators, and per-tag buckets', async () => {
    const set = defineEvalSet({
      name: 'math', version: '1',
      cases: [
        { id: 'a', input: 0.2, tags: ['pair', 'single'], metadata: { pass: true } },
        { id: 'b', input: 0.8, tags: ['pair'], metadata: { pass: false } },
        { id: 'c', input: 1, tags: ['other'] },
      ],
    })
    const numeric = defineScorer({ name: 'numeric', score({ output, evalCase }) {
      return {
        score: Number(output),
        ...(evalCase.metadata?.['pass'] !== undefined
          ? { pass: evalCase.metadata['pass'] as boolean }
          : {}),
      }
    } })

    const report = await runEvalSet(set, async (input) => ({ output: input }), { scorers: [numeric] })
    const aggregate = report.aggregates[0]!

    expect(aggregate).toMatchObject({
      scoredCount: 3,
      errorCount: 0,
      avg: 2 / 3,
      p50: 0.8,
      p95: 1,
      min: 0.2,
      max: 1,
      passRate: 0.5,
    })
    expect(aggregate.byTag?.['single']).toMatchObject({ p50: 0.2, p95: 0.2, scoredCount: 1 })
    expect(aggregate.byTag?.['pair']).toMatchObject({ p50: 0.2, p95: 0.8, scoredCount: 2 })
  })

  it('links StoredRun traces and run identity into scorer context and records', async () => {
    const runIdentity = identity('trace-run')
    const stored = { runId: 'trace-run', spans: [] } as unknown as StoredRun
    const getRun = vi.fn(async () => stored)
    const traceStore = { getRun } as unknown as TraceStore
    let received: StoredRun | undefined
    const scorer = defineScorer({ name: 'trace-aware', score(context: ScorerContext) {
      received = context.trace
      return { score: context.trace === stored ? 1 : 0 }
    } })
    const set = defineEvalSet({ name: 'trace', version: '1', cases: [{ id: 'a', input: 'a' }] })

    const report = await runEvalSet(set, async () => ({
      output: 'a', result: agentResult({ identity: runIdentity }),
    }), { scorers: [scorer], traceStore })

    expect(getRun).toHaveBeenCalledWith('trace-run')
    expect(received).toBe(stored)
    expect(report.records[0]?.runRef).toEqual(runIdentity)
  })

  it('leaves trace undefined without a TraceStore', async () => {
    let received: StoredRun | undefined
    const scorer = defineScorer({ name: 'no-trace', score(context) {
      received = context.trace
      return { score: 1 }
    } })
    const set = defineEvalSet({ name: 'trace', version: '1', cases: [{ id: 'a', input: 'a' }] })
    await runEvalSet(set, async () => ({ output: 'a', result: agentResult() }), { scorers: [scorer] })
    expect(received).toBeUndefined()
  })

  it('applies payload none/redacted/full policies and the 8 KiB cap', async () => {
    const secret = 'password="secret value"'
    const long = `${secret}-${'x'.repeat(70_000)}`
    const set = defineEvalSet({
      name: 'payload', version: '1', cases: [{ id: 'a', input: long, expected: secret }],
    })
    const target: EvalTarget = async () => ({ output: `sk-abcdefghijklmnop-${long}` })

    const none = await runEvalSet(set, target, { scorers: [exact] })
    const redacted = await runEvalSet(set, target, { scorers: [exact], storePayloads: 'redacted' })
    const full = await runEvalSet(set, target, { scorers: [exact], storePayloads: 'full' })

    expect(Object.hasOwn(none.records[0]!, 'payload')).toBe(false)
    expect(JSON.stringify(redacted.records[0]?.payload)).toContain('[redacted]')
    expect(JSON.stringify(redacted.records[0]?.payload)).not.toContain('secret value')
    expect(full.records[0]?.payload?.input).toContain('secret value')
    expect(full.records[0]?.payload?.input.length).toBeLessThanOrEqual(8 * 1024)
    expect(full.records[0]?.payload?.input).toContain('[truncated at 8192 characters]')
  })

  it('sums target usage once per sample and keeps currencies separate', async () => {
    const costs: readonly RunCostSummary[] = [
      { amount: 0.25, currency: 'USD' },
      { amount: 0.1, currency: 'EUR' },
    ]
    const set = defineEvalSet({ name: 'usage', version: '1', cases: [{ id: 'a', input: 'a' }] })
    const result = { ...agentResult(), costs } as AgentRunResult & { costs: readonly RunCostSummary[] }

    const report = await runEvalSet(set, async () => ({ output: 'a', result }), {
      scorers: [exact, defineScorer({ name: 'second', score: () => ({ score: 1 }) })],
      repeats: 2,
    })

    expect(report.records).toHaveLength(4)
    expect(report.totals.tokens).toEqual({ input_tokens: 4, output_tokens: 6 })
    expect(report.totals.costs).toEqual([
      { amount: 0.2, currency: 'EUR' },
      { amount: 0.5, currency: 'USD' },
    ])
  })

  it('merges metadata as case then runner options then target result fingerprint', async () => {
    const set = defineEvalSet({
      name: 'metadata', version: '1',
      cases: [{ id: 'a', input: 'a', metadata: { shared: 'case', case_only: true } }],
    })
    let contextMetadata: ScorerContext['metadata'] | undefined
    const scorer = defineScorer({ name: 'capture', score(context) {
      contextMetadata = context.metadata
      return { score: 1 }
    } })

    const report = await runEvalSet(set, async () => ({
      output: 'a',
      result: agentResult({ metadata: { shared: 'target', model: 'actual-model' } }),
    }), { scorers: [scorer], metadata: { shared: 'runner', runner_only: true } })

    const expected = {
      shared: 'target',
      case_only: true,
      runner_only: true,
      model: 'actual-model',
    }
    expect(contextMetadata).toEqual(expected)
    expect(report.records[0]?.metadata).toEqual(expected)
    expect(report.metadata).toEqual({ shared: 'runner', runner_only: true })
  })
})
