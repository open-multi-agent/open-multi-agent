import { describe, expect, it, vi } from 'vitest'
import {
  OnlineEvaluator,
  type EvalDiagnostic,
  type OnlineEvaluationInput,
} from '../src/eval/online.js'
import { attachScoreCostInputs, type Scorer } from '../src/eval/scorer.js'
import { InMemoryEvalStore, type EvalStore } from '../src/eval/store.js'
import { createRunIdentity } from '../src/observability/identity.js'
import type { AgentRunResult, CostEstimateContext } from '../src/types.js'

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function result(
  runId: string,
  options: {
    readonly attempt?: number
    readonly success?: boolean
    readonly metadata?: Readonly<Record<string, string | number | boolean>>
  } = {},
): AgentRunResult {
  const success = options.success ?? true
  return {
    success,
    output: `output-${runId}`,
    messages: [],
    tokenUsage: { input_tokens: 2, output_tokens: 3 },
    toolCalls: [],
    identity: createRunIdentity({ runId, attempt: options.attempt }),
    status: { code: success ? 'ok' : 'error' },
    ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
  }
}

function sample(runId: string, options: Parameters<typeof result>[1] = {}): OnlineEvaluationInput {
  return { input: `prompt-${runId}`, result: result(runId, options), durationMs: 12 }
}

const passScorer: Scorer = {
  name: 'pass',
  score() { return { score: 1, pass: true, reason: 'ok' } },
}

describe('OnlineEvaluator sampling and records', () => {
  it('supports zero, full, ratio, and rule sampling with stable evaluator IDs', async () => {
    const decisions = [0.1, 0.9, 0.1]
    const store = new InMemoryEvalStore()
    const evaluator = new OnlineEvaluator({ scorers: [passScorer], sample: 0.5, store }, {
      random: () => decisions.shift() ?? 1,
    })

    expect(evaluator.enqueue(sample('ratio-hit'))).toBe(true)
    expect(evaluator.enqueue(sample('ratio-miss'))).toBe(false)
    await evaluator.forceFlush()

    const page = await store.query({ source: 'online' })
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({
      source: 'online',
      scorer: { name: 'pass' },
      status: 'scored',
      runRef: { runId: 'ratio-hit', attempt: 1 },
      usage: { tokens: { input_tokens: 2, output_tokens: 3 }, durationMs: 12 },
    })
    expect(page.items[0]?.caseId).toBeUndefined()
    expect(page.items[0]?.evalSet).toBeUndefined()

    evaluator.enqueue(sample('same-evaluator'))
    await evaluator.forceFlush()
    const all = await store.query({ order: 'time_asc' })
    expect(new Set(all.items.map((record) => record.evalRunId)).size).toBe(1)

    const disabled = new OnlineEvaluator({ scorers: [passScorer], sample: 0, diagnostics: 'silent' })
    expect(disabled.enqueue(sample('disabled'))).toBe(false)
    expect(disabled.getStats()).toEqual({
      sampled: 0,
      enqueued: 0,
      completed: 0,
      dropped: 0,
      failed: 0,
      storeFailed: 0,
    })
  })

  it('passes status and metadata to rules, and isolates a throwing rule', () => {
    const diagnostics: EvalDiagnostic[] = []
    const seen: unknown[] = []
    const evaluator = new OnlineEvaluator({
      scorers: [passScorer],
      sample(context) {
        seen.push(context)
        if (context.metadata['throw']) throw new Error('private payload')
        return context.status.code !== 'ok' && context.metadata['tier'] === 'canary'
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })

    expect(evaluator.enqueue(sample('ok', { metadata: { tier: 'canary' } }))).toBe(false)
    expect(evaluator.enqueue(sample('failed', {
      success: false,
      metadata: { tier: 'canary' },
    }))).toBe(true)
    expect(evaluator.enqueue(sample('throws', { metadata: { throw: true } }))).toBe(false)

    expect(seen).toHaveLength(3)
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({ code: 'scorer_failed', severity: 'error' })
    expect(diagnostics[0]?.message).not.toContain('private payload')
  })

  it('keeps payloads out by default and redacts explicit redacted payload storage', async () => {
    const contexts: unknown[] = []
    const scorer: Scorer = {
      name: 'inspect',
      score(context) {
        contexts.push(context.evalCase.input)
        return { score: 1 }
      },
    }
    const noneStore = new InMemoryEvalStore()
    const none = new OnlineEvaluator({ scorers: [scorer], sample: 1, store: noneStore })
    none.enqueue({
      input: 'token sk-abcdefghijklmnop',
      result: result('private-none'),
      durationMs: 1,
    })
    await none.forceFlush()
    expect(contexts[0]).toBe('[string input omitted; 25 characters]')
    expect((await noneStore.query()).items[0]?.payload).toBeUndefined()

    const redactedStore = new InMemoryEvalStore()
    const redacted = new OnlineEvaluator({
      scorers: [scorer],
      sample: 1,
      store: redactedStore,
      storePayloads: 'redacted',
    })
    redacted.enqueue({
      input: 'token sk-abcdefghijklmnop',
      result: { ...result('private-redacted'), output: 'password="hunter2"' },
      durationMs: 1,
    })
    await redacted.forceFlush()
    const record = (await redactedStore.query()).items[0]
    expect(record?.payload?.input).not.toContain('sk-abcdefghijklmnop')
    expect(record?.payload?.output).not.toContain('hunter2')
  })
})

describe('OnlineEvaluator bounds and budgets', () => {
  it('drops when the bounded queue is full and reports the drop', () => {
    const diagnostics: EvalDiagnostic[] = []
    const evaluator = new OnlineEvaluator({
      scorers: [passScorer],
      sample: 1,
      maxQueueLength: 1,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })

    expect(evaluator.enqueue(sample('queued'))).toBe(true)
    expect(evaluator.enqueue(sample('dropped'))).toBe(false)
    expect(evaluator.getStats()).toMatchObject({ sampled: 2, enqueued: 1, dropped: 1 })
    expect(diagnostics).toEqual([expect.objectContaining({ code: 'queue_full', count: 1 })])
  })

  it('never exceeds maxConcurrent workers', async () => {
    const release = deferred()
    const twoStarted = deferred()
    let active = 0
    let maxActive = 0
    let started = 0
    const scorer: Scorer = {
      name: 'slow',
      async score() {
        active++
        started++
        maxActive = Math.max(maxActive, active)
        if (started === 2) twoStarted.resolve()
        await release.promise
        active--
        return { score: 1 }
      },
    }
    const evaluator = new OnlineEvaluator({
      scorers: [scorer],
      sample: 1,
      maxConcurrent: 2,
      maxQueueLength: 3,
    })
    evaluator.enqueue(sample('concurrent-1'))
    evaluator.enqueue(sample('concurrent-2'))
    evaluator.enqueue(sample('concurrent-3'))

    const flush = evaluator.forceFlush()
    await twoStarted.promise
    expect(maxActive).toBe(2)
    release.resolve()
    await flush
    expect(evaluator.getStats().completed).toBe(3)
  })

  it('enforces and recovers the per-minute evaluation budget', async () => {
    let now = 1_000
    const diagnostics: EvalDiagnostic[] = []
    const evaluator = new OnlineEvaluator({
      scorers: [passScorer],
      sample: 1,
      budget: { maxEvaluationsPerMinute: 1 },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    }, { now: () => now })

    expect(evaluator.enqueue(sample('minute-1'))).toBe(true)
    expect(evaluator.enqueue(sample('minute-blocked'))).toBe(false)
    await evaluator.forceFlush()
    now += 60_001
    expect(evaluator.enqueue(sample('minute-recovered'))).toBe(true)
    await evaluator.forceFlush()

    expect(evaluator.getStats()).toMatchObject({ enqueued: 2, completed: 2, dropped: 1 })
    expect(diagnostics[0]).toMatchObject({ code: 'budget_exhausted' })
  })

  it('warns once and stays uncapped when a cost budget has no estimator', async () => {
    const diagnostics: EvalDiagnostic[] = []
    const evaluator = new OnlineEvaluator({
      scorers: [passScorer],
      sample: 1,
      budget: { maxCostPerHour: 1 },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })
    evaluator.enqueue(sample('cost-unavailable-1'))
    evaluator.enqueue(sample('cost-unavailable-2'))
    await evaluator.forceFlush()

    expect(evaluator.getStats()).toMatchObject({ enqueued: 2, completed: 2, dropped: 0 })
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({ code: 'budget_exhausted', count: 1 })
  })

  it('caps framework-reported scorer cost and recovers after the hourly window', async () => {
    let now = 10_000
    const costContext: CostEstimateContext = {
      agentName: 'judge',
      model: 'judge-model',
      phase: 'agent',
    }
    const scorer: Scorer = {
      name: 'costed',
      score() {
        return attachScoreCostInputs({ score: 1 }, [{
          usage: { input_tokens: 4, output_tokens: 1 },
          context: costContext,
        }])
      },
    }
    const evaluator = new OnlineEvaluator({
      scorers: [scorer],
      sample: 1,
      budget: { maxCostPerHour: 5 },
      diagnostics: 'silent',
    }, {
      now: () => now,
      estimateCost: (usage) => usage.input_tokens + usage.output_tokens,
    })

    evaluator.enqueue(sample('costed-1'))
    await evaluator.forceFlush()
    expect(evaluator.enqueue(sample('costed-blocked'))).toBe(false)
    now += 3_600_001
    expect(evaluator.enqueue(sample('costed-recovered'))).toBe(true)
    await evaluator.forceFlush()
  })

  it('accounts for framework-reported model cost even when the scorer fails', async () => {
    const costContext: CostEstimateContext = {
      agentName: 'judge',
      model: 'judge-model',
      phase: 'agent',
    }
    const scorer: Scorer = {
      name: 'failing-costed',
      score() {
        throw attachScoreCostInputs(new Error('invalid judge verdict'), [{
          usage: { input_tokens: 4, output_tokens: 1 },
          context: costContext,
        }])
      },
    }
    const evaluator = new OnlineEvaluator({
      scorers: [scorer],
      sample: 1,
      budget: { maxCostPerHour: 5 },
      diagnostics: 'silent',
    }, {
      estimateCost: (usage) => usage.input_tokens + usage.output_tokens,
    })

    evaluator.enqueue(sample('failing-costed-1'))
    await evaluator.forceFlush()
    expect(evaluator.enqueue(sample('failing-costed-blocked'))).toBe(false)
  })
})

describe('OnlineEvaluator failure isolation and lifecycle', () => {
  it('records sync throws, async rejects, and timeouts as scorer_error', async () => {
    const scorers: Scorer[] = [
      { name: 'sync', score() { throw new Error('sync secret') } },
      { name: 'async', async score() { throw new Error('async secret') } },
      { name: 'timeout', timeoutMs: 5, async score() { await new Promise(() => {}) } },
    ]
    const diagnostics: EvalDiagnostic[] = []
    const store = new InMemoryEvalStore()
    const evaluator = new OnlineEvaluator({
      scorers,
      sample: 1,
      store,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })
    evaluator.enqueue(sample('scorer-failures'))
    const flushed = await evaluator.forceFlush({ timeoutMs: 1_000 })

    expect(flushed.status).toBe('error')
    const records = (await store.query({ status: ['scorer_error'] })).items
    expect(records).toHaveLength(3)
    expect(records.map((record) => record.scorer.name).sort()).toEqual(['async', 'sync', 'timeout'])
    expect(records.find((record) => record.scorer.name === 'timeout')?.error?.kind).toBe('timeout')
    expect(evaluator.getStats()).toMatchObject({ failed: 3, storeFailed: 0 })
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({ code: 'scorer_failed', count: 1 })
  })

  it('isolates store, result, and diagnostic callback failures', async () => {
    const rejectingStore: EvalStore = {
      async append() { throw new Error('store down') },
      async query() { return { items: [] } },
      async delete() { return { runsDeleted: 0, recordsDeleted: 0, runIds: [] } },
      async applyRetention() { return { runsDeleted: 0, recordsDeleted: 0, runIds: [] } },
    }
    const storeEvaluator = new OnlineEvaluator({
      scorers: [passScorer],
      sample: 1,
      store: rejectingStore,
      onDiagnostic() { throw new Error('diagnostic callback') },
    })
    storeEvaluator.enqueue(sample('store-failure'))
    await storeEvaluator.forceFlush()
    expect(storeEvaluator.getStats()).toMatchObject({
      completed: 1,
      failed: 1,
      storeFailed: 1,
    })

    const resultEvaluator = new OnlineEvaluator({
      scorers: [passScorer],
      sample: 1,
      onResult() { throw new Error('result callback') },
      diagnostics: 'silent',
    })
    resultEvaluator.enqueue(sample('result-callback'))
    await resultEvaluator.forceFlush()
    expect(resultEvaluator.getStats()).toMatchObject({ completed: 1, failed: 1 })
  })

  it('times out flush, makes shutdown idempotent, and rejects post-shutdown enqueue', async () => {
    const diagnostics: EvalDiagnostic[] = []
    const never: Scorer = { name: 'never', async score() { await new Promise(() => {}) } }
    const timed = new OnlineEvaluator({
      scorers: [never],
      sample: 1,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })
    timed.enqueue(sample('never'))
    expect((await timed.forceFlush({ timeoutMs: 5 })).status).toBe('timeout')
    expect(diagnostics[0]).toMatchObject({ code: 'flush_timeout' })

    const evaluator = new OnlineEvaluator({
      scorers: [passScorer],
      sample: 1,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })
    evaluator.enqueue(sample('shutdown'))
    const first = evaluator.shutdown({ timeoutMs: 1_000 })
    const second = evaluator.shutdown({ timeoutMs: 1 })
    expect(second).toBe(first)
    await Promise.all([first, evaluator.forceFlush({ timeoutMs: 1_000 })])
    expect(evaluator.enqueue(sample('after-shutdown'))).toBe(false)
    expect(diagnostics.some((diagnostic) => diagnostic.code === 'enqueue_after_shutdown')).toBe(true)
  })

  it('rate-limits console warnings, honors silent mode, and unrefs scheduling timers', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const timers = vi.spyOn(globalThis, 'setTimeout')
    const evaluator = new OnlineEvaluator({
      scorers: [passScorer],
      sample: 1,
      maxQueueLength: 1,
    })
    evaluator.enqueue(sample('warn-queued'))
    evaluator.enqueue(sample('warn-1'))
    evaluator.enqueue(sample('warn-2'))
    expect(warn).toHaveBeenCalledTimes(1)
    const scheduled = timers.mock.results
      .map((entry) => entry.value as { hasRef?: () => boolean } | undefined)
      .find((timer) => typeof timer?.hasRef === 'function')
    expect(scheduled?.hasRef?.()).toBe(false)

    const silent = new OnlineEvaluator({
      scorers: [passScorer],
      sample: 1,
      maxQueueLength: 1,
      diagnostics: 'silent',
    })
    silent.enqueue(sample('silent-queued'))
    silent.enqueue(sample('silent-drop'))
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
    timers.mockRestore()
  })

  it('aggregates suppressed diagnostic counts into the next rate-limit window', () => {
    let now = 1_000
    const diagnostics: EvalDiagnostic[] = []
    const evaluator = new OnlineEvaluator({
      scorers: [passScorer],
      sample: 1,
      maxQueueLength: 1,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    }, { now: () => now })

    evaluator.enqueue(sample('diagnostic-queued'))
    evaluator.enqueue(sample('diagnostic-drop-1'))
    evaluator.enqueue(sample('diagnostic-drop-2'))
    evaluator.enqueue(sample('diagnostic-drop-3'))
    expect(diagnostics).toEqual([expect.objectContaining({ code: 'queue_full', count: 1 })])

    now += 60_001
    evaluator.enqueue(sample('diagnostic-drop-4'))
    expect(diagnostics[1]).toMatchObject({ code: 'queue_full', count: 3 })
  })
})
