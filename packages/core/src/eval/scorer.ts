import type {
  AgentRunResult,
  ConsensusResult,
  CostEstimateContext,
  TeamRunResult,
  TokenUsage,
  TraceAttributeValue,
} from '../types.js'
import type { StoredRun } from '../observability/store.js'
import type { EvalCase } from './evalcase.js'

/** Inputs available to every rule-based or model-based scorer. */
export interface ScorerContext {
  readonly evalCase: EvalCase
  readonly output: unknown
  readonly result?: AgentRunResult | TeamRunResult | ConsensusResult
  readonly trace?: StoredRun
  readonly metadata: Readonly<Record<string, TraceAttributeValue>>
  readonly signal: AbortSignal
}

/** A normalized quality score. Scoring failures are thrown, never represented as score zero. */
export interface ScoreResult {
  /** A finite score in the inclusive range [0, 1]. */
  readonly score: number
  readonly pass?: boolean
  readonly reason?: string
  readonly details?: Readonly<Record<string, TraceAttributeValue>>
}

/** A named, optionally versioned quality scorer. */
export interface Scorer {
  readonly name: string
  readonly version?: string
  readonly timeoutMs?: number
  score(context: ScorerContext): Promise<ScoreResult> | ScoreResult
}

const SCORE_COST_INPUTS = Symbol('oma.eval.score_cost_inputs')

/** Internal usage detail attached non-enumerably by framework-backed scorers. */
export interface ScoreCostInput {
  readonly usage: TokenUsage
  readonly context: CostEstimateContext
}

type ValueWithCost = {
  readonly [SCORE_COST_INPUTS]?: readonly ScoreCostInput[]
}

/** Attach scorer-side model usage without expanding the serialized ScoreResult contract. */
export function attachScoreCostInputs<T extends object>(
  result: T,
  inputs: readonly ScoreCostInput[],
): T {
  if (inputs.length === 0) return result
  Object.defineProperty(result, SCORE_COST_INPUTS, {
    value: Object.freeze(inputs.map((input) => Object.freeze({
      usage: Object.freeze({ ...input.usage }),
      context: Object.freeze({ ...input.context }),
    }))),
    enumerable: false,
    configurable: true,
  })
  return result
}

/** Read framework-owned scorer usage for online cost budgeting. */
export function scoreCostInputs(value: unknown): readonly ScoreCostInput[] {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return []
  return (value as ValueWithCost)[SCORE_COST_INPUTS] ?? []
}

function isTraceAttributeValue(value: unknown): value is TraceAttributeValue {
  if (typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (!Array.isArray(value)) return false
  if (value.length === 0) return true

  const itemType = typeof value[0]
  if (itemType !== 'string' && itemType !== 'number' && itemType !== 'boolean') return false
  return value.every((item) => typeof item === itemType && (
    typeof item !== 'number' || Number.isFinite(item)
  ))
}

function validateScoreResult(value: unknown): ScoreResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Scorer must return a ScoreResult object.')
  }

  const result = value as Record<string, unknown>
  if (
    typeof result['score'] !== 'number'
    || !Number.isFinite(result['score'])
    || result['score'] < 0
    || result['score'] > 1
  ) {
    throw new RangeError('ScoreResult.score must be a finite number in the range [0, 1].')
  }
  if (result['pass'] !== undefined && typeof result['pass'] !== 'boolean') {
    throw new TypeError('ScoreResult.pass must be a boolean when provided.')
  }
  if (result['reason'] !== undefined && typeof result['reason'] !== 'string') {
    throw new TypeError('ScoreResult.reason must be a string when provided.')
  }
  if (result['details'] !== undefined) {
    if (
      typeof result['details'] !== 'object'
      || result['details'] === null
      || Array.isArray(result['details'])
    ) {
      throw new TypeError('ScoreResult.details must be a trace-attribute record when provided.')
    }
    for (const detail of Object.values(result['details'])) {
      if (!isTraceAttributeValue(detail)) {
        throw new TypeError('ScoreResult.details values must be valid TraceAttributeValue values.')
      }
    }
  }

  return value as ScoreResult
}

/**
 * Validate and freeze a scorer definition.
 *
 * The returned wrapper also validates every synchronous or asynchronous result.
 * Rejections and thrown errors propagate unchanged so callers can record them as
 * `scorer_error`; they are never converted to a score of zero.
 */
export function defineScorer(scorer: Scorer): Scorer {
  if (typeof scorer !== 'object' || scorer === null) {
    throw new TypeError('Scorer must be an object.')
  }
  if (typeof scorer.name !== 'string' || scorer.name.trim().length === 0) {
    throw new TypeError('Scorer.name must be a non-empty string.')
  }
  if (typeof scorer.score !== 'function') {
    throw new TypeError('Scorer.score must be a function.')
  }

  const score = scorer.score
  const frozen: Scorer = {
    ...scorer,
    score(context) {
      const result = score.call(scorer, context)
      if (
        typeof result === 'object'
        && result !== null
        && typeof (result as PromiseLike<ScoreResult>).then === 'function'
      ) {
        return Promise.resolve(result).then(validateScoreResult)
      }
      return validateScoreResult(result)
    },
  }
  return Object.freeze(frozen)
}
