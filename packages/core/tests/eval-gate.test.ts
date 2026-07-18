import { describe, expect, it } from 'vitest'

import { evaluateGate, type GatePolicy } from '../src/eval/gate.js'
import type { EvalRunReport, ScorerAggregate } from '../src/eval/report.js'
import type { EvalRecord } from '../src/eval/record.js'

function record(status: 'scored' | 'scorer_error', index: number): EvalRecord {
  return {
    schemaVersion: 1,
    recordId: `record-${index}`,
    evalRunId: 'run-1',
    source: 'offline',
    timestampUnixMs: index,
    evalSet: { name: 'fixture', version: '1' },
    caseId: `case-${index}`,
    repeat: 1,
    scorer: { name: 'exact', version: '1' },
    status,
    ...(status === 'scored' ? { score: 0.8, pass: true } : {}),
    metadata: {},
  }
}

function aggregate(options: {
  readonly name?: string
  readonly version?: string
  readonly avg?: number
  readonly passRate?: number | null
  readonly byTag?: Readonly<Record<string, ScorerAggregate>>
} = {}): ScorerAggregate {
  const avg = options.avg ?? 0.8
  const passRate = options.passRate === undefined ? 0.8 : options.passRate
  return {
    scorer: { name: options.name ?? 'exact', version: options.version ?? '1' },
    scoredCount: 10,
    errorCount: 0,
    avg,
    p50: avg,
    p95: avg,
    min: avg,
    max: avg,
    ...(passRate !== null ? { passRate } : {}),
    ...(options.byTag !== undefined ? { byTag: options.byTag } : {}),
  }
}

function report(options: {
  readonly name?: string
  readonly version?: string
  readonly aggregate?: ScorerAggregate
  readonly records?: readonly EvalRecord[]
  readonly caseCount?: number
  readonly repeats?: number
  readonly targetErrors?: number
} = {}): EvalRunReport {
  return {
    schemaVersion: 1,
    evalRunId: 'run-1',
    startedAtUnixMs: 1,
    durationMs: 1,
    evalSet: { name: options.name ?? 'fixture', version: options.version ?? '1' },
    metadata: {},
    caseCount: options.caseCount ?? 10,
    repeats: options.repeats ?? 1,
    records: options.records ?? [],
    aggregates: [options.aggregate ?? aggregate()],
    totals: { targetErrors: options.targetErrors ?? 0 },
  }
}

function policy(
  thresholds: GatePolicy['thresholds'],
  options: Omit<GatePolicy, 'schemaVersion' | 'thresholds'> = {},
): GatePolicy {
  return { schemaVersion: 1, thresholds, ...options }
}

describe('evaluateGate thresholds', () => {
  it('rejects a threshold without min or max', () => {
    expect(() => evaluateGate(report(), {
      schemaVersion: 1,
      thresholds: [{ scorer: 'exact', metric: 'avg' }],
    })).toThrow('at least one of min or max is required')
  })

  it('fails min, max, and tag-scoped thresholds while equality passes', () => {
    const tagged = aggregate({ avg: 0.4, passRate: 0.4 })
    const current = report({
      aggregate: aggregate({ byTag: { critical: tagged } }),
    })

    const verdict = evaluateGate(current, policy([
      { scorer: 'exact', metric: 'avg', min: 0.8 },
      { scorer: 'exact', metric: 'avg', max: 0.8 },
      { scorer: 'exact', metric: 'p50', min: 0.9 },
      { scorer: 'exact', metric: 'p95', max: 0.7 },
      { scorer: 'exact', metric: 'avg', min: 0.5, tag: 'critical' },
    ]))

    expect(verdict.pass).toBe(false)
    expect(verdict.failures).toHaveLength(3)
    expect(verdict.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'threshold', metric: 'p50', actual: 0.8, limit: 0.9 }),
      expect.objectContaining({ kind: 'threshold', metric: 'p95', actual: 0.8, limit: 0.7 }),
      expect.objectContaining({ kind: 'threshold', metric: 'avg', tag: 'critical', actual: 0.4 }),
    ]))
  })

  it('fails visibly for a missing scorer, tag, or passRate source', () => {
    const noPassRate = report({ aggregate: aggregate({ passRate: null }) })
    const verdict = evaluateGate(noPassRate, policy([
      { scorer: 'missing', metric: 'avg', min: 0.5 },
      { scorer: 'exact', metric: 'avg', min: 0.5, tag: 'missing' },
      { scorer: 'exact', metric: 'passRate', min: 1 },
    ]))

    expect(verdict.failures.map((failure) => failure.kind)).toEqual([
      'missing_scorer',
      'missing_scorer',
      'missing_scorer',
    ])
    expect(verdict.failures[0]?.message).toContain('missing')
    expect(verdict.failures[1]?.message).toContain('tag "missing"')
    expect(verdict.failures[2]?.message).toContain('no scored records with a pass value')
  })
})

describe('evaluateGate baseline regression', () => {
  it('passes an equal-limit regression and improvements, but fails a larger drop', () => {
    const current = report({ aggregate: aggregate({ avg: 0.7 }) })
    const equal = evaluateGate(
      current,
      policy([{ scorer: 'exact', metric: 'avg', min: 0 }], {
        baseline: { maxRegression: 0.1 },
      }),
      report({ aggregate: aggregate({ avg: 0.8 }) }),
    )
    const regressed = evaluateGate(
      current,
      policy([{ scorer: 'exact', metric: 'avg', min: 0 }], {
        baseline: { maxRegression: 0.1 },
      }),
      report({ aggregate: aggregate({ avg: 0.81 }) }),
    )
    const improved = evaluateGate(
      report({ aggregate: aggregate({ avg: 0.8 }) }),
      policy([{ scorer: 'exact', metric: 'avg', min: 0 }], {
        baseline: { maxRegression: 0.1 },
      }),
      report({ aggregate: aggregate({ avg: 0.7 }) }),
    )

    expect(equal.pass).toBe(true)
    expect(regressed.failures).toEqual([
      expect.objectContaining({ kind: 'regression', scorer: 'exact', metric: 'avg', limit: 0.1 }),
    ])
    expect(improved.pass).toBe(true)
  })

  it('uses a per-scorer regression limit instead of the global limit', () => {
    const verdict = evaluateGate(
      report({ aggregate: aggregate({ avg: 0.8 }) }),
      policy([{ scorer: 'exact', metric: 'avg', min: 0 }], {
        baseline: { maxRegression: 0.1, perScorer: { exact: 0.02 } },
      }),
      report({ aggregate: aggregate({ avg: 0.83 }) }),
    )

    expect(verdict.failures).toEqual([
      expect.objectContaining({ kind: 'regression', limit: 0.02 }),
    ])
  })

  it('fails name or version mismatches unless allowSetMismatch downgrades them', () => {
    for (const baseline of [report({ name: 'other' }), report({ version: '2' })]) {
      const failed = evaluateGate(report(), policy([], { baseline: {} }), baseline)
      const allowed = evaluateGate(
        report(),
        policy([], { baseline: { allowSetMismatch: true } }),
        baseline,
      )

      expect(failed.failures).toEqual([
        expect.objectContaining({ kind: 'baseline_mismatch', actual: 1, limit: 0 }),
      ])
      expect(allowed.pass).toBe(true)
      expect(allowed.warnings[0]).toContain('Baseline EvalSet mismatch')
    }
  })

  it('warns once and skips regression when the scorer version drifts', () => {
    const verdict = evaluateGate(
      report({ aggregate: aggregate({ version: '2', avg: 0.5 }) }),
      policy([
        { scorer: 'exact', metric: 'avg', min: 0 },
        { scorer: 'exact', metric: 'p50', min: 0 },
      ], { baseline: { maxRegression: 0 } }),
      report({ aggregate: aggregate({ version: '1', avg: 1 }) }),
    )

    expect(verdict.pass).toBe(true)
    expect(verdict.failures).toEqual([])
    expect(verdict.warnings).toHaveLength(1)
    expect(verdict.warnings[0]).toContain('Scorer version drift')
  })
})

describe('evaluateGate health and warnings', () => {
  it('applies scorer health defaults, explicit limits, and equality boundaries', () => {
    const records = Array.from({ length: 10 }, (_, index) =>
      record(index === 0 ? 'scorer_error' : 'scored', index))
    const boundary = evaluateGate(report({ records }), policy([]))
    const failed = evaluateGate(
      report({ records: records.map((entry, index) =>
        index === 1 ? record('scorer_error', index) : entry) }),
      policy([]),
    )
    const explicitBoundary = evaluateGate(
      report({ records: records.map((entry, index) =>
        index === 1 ? record('scorer_error', index) : entry) }),
      policy([], { maxScorerErrorRate: 0.2 }),
    )

    expect(boundary.pass).toBe(true)
    expect(failed.failures).toEqual([
      expect.objectContaining({ kind: 'scorer_health', actual: 0.2, limit: 0.1 }),
    ])
    expect(explicitBoundary.pass).toBe(true)
  })

  it('applies target health defaults, explicit limits, and equality boundaries', () => {
    const failed = evaluateGate(report({ targetErrors: 1 }), policy([]))
    const explicitBoundary = evaluateGate(
      report({ targetErrors: 1 }),
      policy([], { maxTargetErrorRate: 0.1 }),
    )

    expect(failed.failures).toEqual([
      expect.objectContaining({ kind: 'target_health', actual: 0.1, limit: 0 }),
    ])
    expect(explicitBoundary.pass).toBe(true)
  })

  it('allows an empty threshold list and warns when baseline rules lack a report', () => {
    const verdict = evaluateGate(
      report(),
      policy([], { baseline: { maxRegression: 0.05 } }),
    )

    expect(verdict.pass).toBe(true)
    expect(verdict.failures).toEqual([])
    expect(verdict.warnings).toEqual([
      'Baseline policy is configured but no baseline report was provided; regression checks were skipped.',
    ])
  })
})
