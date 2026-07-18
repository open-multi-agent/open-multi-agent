import type { RunCostSummary } from '../observability/store.js'
import type { TokenUsage, TraceAttributeValue } from '../types.js'
import type { EvalRecord } from './record.js'
import type { Scorer } from './scorer.js'

/** Score statistics for one scorer, excluding scorer failures from score denominators. */
export interface ScorerAggregate {
  readonly scorer: { readonly name: string; readonly version?: string }
  readonly scoredCount: number
  readonly errorCount: number
  readonly avg: number
  readonly p50: number
  readonly p95: number
  readonly min: number
  readonly max: number
  readonly passRate?: number
  readonly byTag?: Readonly<Record<string, ScorerAggregate>>
}

/** Complete result of one offline EvalSet execution. */
export interface EvalRunReport {
  readonly schemaVersion: 1
  readonly evalRunId: string
  readonly startedAtUnixMs: number
  readonly durationMs: number
  readonly evalSet: { readonly name: string; readonly version: string }
  readonly metadata: Readonly<Record<string, TraceAttributeValue>>
  readonly caseCount: number
  readonly repeats: number
  readonly aborted?: boolean
  /** Non-fatal evaluation infrastructure failures, such as persistence errors. */
  readonly warnings?: readonly string[]
  readonly records: readonly EvalRecord[]
  readonly aggregates: readonly ScorerAggregate[]
  readonly totals: {
    readonly tokens?: TokenUsage
    readonly costs?: readonly RunCostSummary[]
    readonly targetErrors: number
  }
}

function nearestRank(sorted: readonly number[], percentile: number): number {
  if (sorted.length === 0) return 0
  const rank = Math.max(1, Math.ceil(percentile * sorted.length))
  return sorted[Math.min(rank - 1, sorted.length - 1)]!
}

function aggregateOne(
  scorer: Pick<Scorer, 'name' | 'version'>,
  records: readonly EvalRecord[],
): ScorerAggregate {
  const matching = records.filter((record) =>
    record.scorer.name === scorer.name && record.scorer.version === scorer.version)
  const scored = matching.filter((record) => record.status === 'scored' && record.score !== undefined)
  const scores = scored.map((record) => record.score!).sort((a, b) => a - b)
  const passed = scored.filter((record) => record.pass !== undefined)
  const identity = {
    name: scorer.name,
    ...(scorer.version !== undefined ? { version: scorer.version } : {}),
  }

  return {
    scorer: identity,
    scoredCount: scores.length,
    errorCount: matching.filter((record) => record.status === 'scorer_error').length,
    avg: scores.length === 0 ? 0 : scores.reduce((sum, score) => sum + score, 0) / scores.length,
    p50: nearestRank(scores, 0.5),
    p95: nearestRank(scores, 0.95),
    min: scores[0] ?? 0,
    max: scores[scores.length - 1] ?? 0,
    ...(passed.length > 0
      ? { passRate: passed.filter((record) => record.pass === true).length / passed.length }
      : {}),
  }
}

/** @internal Build deterministic per-scorer and per-tag aggregates. */
export function aggregateEvalRecords(
  records: readonly EvalRecord[],
  scorers: readonly Scorer[],
  tagsByCase: ReadonlyMap<string, readonly string[]>,
): readonly ScorerAggregate[] {
  const tags = [...new Set([...tagsByCase.values()].flat())]
  return scorers.map((scorer) => {
    const aggregate = aggregateOne(scorer, records)
    if (tags.length === 0) return aggregate

    const byTag = Object.fromEntries(tags.map((tag) => [
      tag,
      aggregateOne(scorer, records.filter((record) =>
        record.caseId !== undefined && tagsByCase.get(record.caseId)?.includes(tag))),
    ]))
    return { ...aggregate, byTag }
  })
}
