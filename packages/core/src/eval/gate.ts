import { z } from 'zod'

import type { EvalRunReport, ScorerAggregate } from './report.js'

export type GateMetric = 'avg' | 'p50' | 'p95' | 'min' | 'passRate'

export interface GateThreshold {
  readonly scorer: string
  readonly metric: GateMetric
  readonly min?: number
  readonly max?: number
  readonly tag?: string
}

export interface GatePolicy {
  readonly schemaVersion: 1
  readonly thresholds: readonly GateThreshold[]
  /** Fail when scorer errors exceed this share of scored plus scorer-error records. Default 0.1. */
  readonly maxScorerErrorRate?: number
  /** Fail when target errors exceed this share of selected samples. Default 0. */
  readonly maxTargetErrorRate?: number
  readonly baseline?: {
    /** Maximum allowed absolute score drop from the baseline. */
    readonly maxRegression?: number
    readonly perScorer?: Readonly<Record<string, number>>
    /** Warn and skip regression checks when the EvalSet identity differs. Default false. */
    readonly allowSetMismatch?: boolean
  }
}

export interface GateFailure {
  readonly kind:
    | 'threshold'
    | 'regression'
    | 'scorer_health'
    | 'target_health'
    | 'baseline_mismatch'
    | 'missing_scorer'
  readonly scorer?: string
  readonly metric?: string
  readonly tag?: string
  readonly actual: number
  readonly limit: number
  readonly message: string
}

export interface GateVerdict {
  readonly pass: boolean
  readonly failures: readonly GateFailure[]
  readonly warnings: readonly string[]
}

const unitInterval = z.number().finite().min(0).max(1)

const gateThresholdSchema = z.object({
  scorer: z.string().trim().min(1),
  metric: z.enum(['avg', 'p50', 'p95', 'min', 'passRate']),
  min: unitInterval.optional(),
  max: unitInterval.optional(),
  tag: z.string().trim().min(1).optional(),
}).superRefine((threshold, context) => {
  if (threshold.min === undefined && threshold.max === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'at least one of min or max is required',
    })
  }
  if (
    threshold.min !== undefined
    && threshold.max !== undefined
    && threshold.min > threshold.max
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'min must be less than or equal to max',
    })
  }
})

/** @internal Shared by the Node-only GatePolicy loader. */
export const gatePolicySchema = z.object({
  schemaVersion: z.literal(1),
  thresholds: z.array(gateThresholdSchema),
  maxScorerErrorRate: unitInterval.optional(),
  maxTargetErrorRate: unitInterval.optional(),
  baseline: z.object({
    maxRegression: unitInterval.optional(),
    perScorer: z.record(unitInterval).optional(),
    allowSetMismatch: z.boolean().optional(),
  }).optional(),
})

function aggregateFor(
  report: EvalRunReport,
  threshold: GateThreshold,
): ScorerAggregate | undefined {
  const aggregate = report.aggregates.find((candidate) =>
    candidate.scorer.name === threshold.scorer)
  if (aggregate === undefined || threshold.tag === undefined) return aggregate
  return aggregate.byTag?.[threshold.tag]
}

function aggregateMetric(
  aggregate: ScorerAggregate | undefined,
  metric: GateMetric,
): number | undefined {
  if (aggregate === undefined) return undefined
  return aggregate[metric]
}

function thresholdTarget(threshold: GateThreshold): string {
  return threshold.tag === undefined
    ? `scorer "${threshold.scorer}"`
    : `scorer "${threshold.scorer}" for tag "${threshold.tag}"`
}

function missingThresholdFailure(threshold: GateThreshold): GateFailure {
  const aggregateTarget = thresholdTarget(threshold)
  const suffix = threshold.metric === 'passRate'
    ? ' or has no scored records with a pass value'
    : ''
  return {
    kind: 'missing_scorer',
    scorer: threshold.scorer,
    metric: threshold.metric,
    ...(threshold.tag !== undefined ? { tag: threshold.tag } : {}),
    actual: 0,
    limit: 1,
    message: `Gate threshold references ${aggregateTarget}, but the metric "${threshold.metric}" is unavailable${suffix}.`,
  }
}

function thresholdFailures(
  report: EvalRunReport,
  threshold: GateThreshold,
): readonly GateFailure[] {
  const actual = aggregateMetric(aggregateFor(report, threshold), threshold.metric)
  if (actual === undefined) return [missingThresholdFailure(threshold)]

  const target = thresholdTarget(threshold)
  const failures: GateFailure[] = []
  if (threshold.min !== undefined && actual < threshold.min) {
    failures.push({
      kind: 'threshold',
      scorer: threshold.scorer,
      metric: threshold.metric,
      ...(threshold.tag !== undefined ? { tag: threshold.tag } : {}),
      actual,
      limit: threshold.min,
      message: `Gate metric "${threshold.metric}" for ${target} is ${actual}, below minimum ${threshold.min}.`,
    })
  }
  if (threshold.max !== undefined && actual > threshold.max) {
    failures.push({
      kind: 'threshold',
      scorer: threshold.scorer,
      metric: threshold.metric,
      ...(threshold.tag !== undefined ? { tag: threshold.tag } : {}),
      actual,
      limit: threshold.max,
      message: `Gate metric "${threshold.metric}" for ${target} is ${actual}, above maximum ${threshold.max}.`,
    })
  }
  return failures
}

function scorerVersion(report: EvalRunReport, scorer: string): string | undefined {
  return report.aggregates.find((aggregate) => aggregate.scorer.name === scorer)?.scorer.version
}

function displayVersion(version: string | undefined): string {
  return version === undefined ? '(unversioned)' : `"${version}"`
}

function sameEvalSet(current: EvalRunReport, baseline: EvalRunReport): boolean {
  return current.evalSet.name === baseline.evalSet.name
    && current.evalSet.version === baseline.evalSet.version
}

function evalSetIdentity(report: EvalRunReport): string {
  return `${report.evalSet.name}@${report.evalSet.version}`
}

function exceedsComputedLimit(actual: number, limit: number): boolean {
  const tolerance = Number.EPSILON * 4 * Math.max(1, Math.abs(actual), Math.abs(limit))
  return actual - limit > tolerance
}

/** Evaluate thresholds, scorer/target health, and an optional one-report baseline. */
export function evaluateGate(
  report: EvalRunReport,
  policy: GatePolicy,
  baseline?: EvalRunReport,
): GateVerdict {
  const validatedPolicy = gatePolicySchema.parse(policy) as GatePolicy
  const failures = validatedPolicy.thresholds.flatMap((threshold) =>
    thresholdFailures(report, threshold)) as GateFailure[]
  const warnings = new Set<string>()

  const scorerRecords = report.records.filter((record) =>
    record.status === 'scored' || record.status === 'scorer_error')
  const scorerErrors = scorerRecords.filter((record) => record.status === 'scorer_error').length
  const scorerErrorRate = scorerRecords.length === 0 ? 0 : scorerErrors / scorerRecords.length
  const maxScorerErrorRate = validatedPolicy.maxScorerErrorRate ?? 0.1
  if (scorerErrorRate > maxScorerErrorRate) {
    failures.push({
      kind: 'scorer_health',
      actual: scorerErrorRate,
      limit: maxScorerErrorRate,
      message: `Scorer error rate ${scorerErrorRate} exceeds maximum ${maxScorerErrorRate}.`,
    })
  }

  const sampleCount = report.caseCount * report.repeats
  const targetErrorRate = sampleCount === 0 ? 0 : report.totals.targetErrors / sampleCount
  const maxTargetErrorRate = validatedPolicy.maxTargetErrorRate ?? 0
  if (targetErrorRate > maxTargetErrorRate) {
    failures.push({
      kind: 'target_health',
      actual: targetErrorRate,
      limit: maxTargetErrorRate,
      message: `Target error rate ${targetErrorRate} exceeds maximum ${maxTargetErrorRate}.`,
    })
  }

  if (baseline === undefined) {
    if (validatedPolicy.baseline !== undefined) {
      warnings.add(
        'Baseline policy is configured but no baseline report was provided; regression checks were skipped.',
      )
    }
  } else if (!sameEvalSet(report, baseline)) {
    const message = `Baseline EvalSet mismatch: current is ${evalSetIdentity(report)}, baseline is ${evalSetIdentity(baseline)}; regression checks were skipped.`
    if (validatedPolicy.baseline?.allowSetMismatch === true) {
      warnings.add(message)
    } else {
      failures.push({
        kind: 'baseline_mismatch',
        actual: 1,
        limit: 0,
        message,
      })
    }
  } else {
    for (const threshold of validatedPolicy.thresholds) {
      const maxRegression = validatedPolicy.baseline?.perScorer?.[threshold.scorer]
        ?? validatedPolicy.baseline?.maxRegression
      if (maxRegression === undefined) continue

      const currentVersion = scorerVersion(report, threshold.scorer)
      const baselineVersion = scorerVersion(baseline, threshold.scorer)
      if (currentVersion !== baselineVersion) {
        warnings.add(
          `Scorer version drift for "${threshold.scorer}": current ${displayVersion(currentVersion)}, baseline ${displayVersion(baselineVersion)}; regression checks were skipped for this scorer.`,
        )
        continue
      }

      const currentValue = aggregateMetric(aggregateFor(report, threshold), threshold.metric)
      const baselineValue = aggregateMetric(aggregateFor(baseline, threshold), threshold.metric)
      if (currentValue === undefined || baselineValue === undefined) {
        warnings.add(
          `Baseline metric "${threshold.metric}" for ${thresholdTarget(threshold)} is unavailable; regression check was skipped.`,
        )
        continue
      }

      const regression = baselineValue - currentValue
      if (exceedsComputedLimit(regression, maxRegression)) {
        failures.push({
          kind: 'regression',
          scorer: threshold.scorer,
          metric: threshold.metric,
          ...(threshold.tag !== undefined ? { tag: threshold.tag } : {}),
          actual: regression,
          limit: maxRegression,
          message: `Gate metric "${threshold.metric}" for ${thresholdTarget(threshold)} regressed by ${regression} (baseline ${baselineValue}, current ${currentValue}), exceeding ${maxRegression}.`,
        })
      }
    }
  }

  return {
    pass: failures.length === 0,
    failures,
    warnings: [...warnings],
  }
}
