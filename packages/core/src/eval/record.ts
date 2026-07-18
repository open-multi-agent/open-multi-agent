import type { RunCostSummary } from '../observability/store.js'
import type {
  StructuredTraceError,
  TokenUsage,
  TraceAttributeValue,
} from '../types.js'

export const EVAL_STORE_SCHEMA_MAJOR = 1 as const

/** Serializable result of one target/scorer evaluation. */
export interface EvalRecord {
  readonly schemaVersion: 1
  readonly recordId: string
  readonly evalRunId: string
  readonly source: 'offline' | 'online'
  readonly timestampUnixMs: number
  readonly evalSet?: { readonly name: string; readonly version: string }
  readonly caseId?: string
  readonly repeat?: number
  readonly scorer: { readonly name: string; readonly version?: string }
  /**
   * `scorer_error` means the scorer threw, rejected, or timed out. It is not a
   * score of zero and must be excluded from score aggregates.
   */
  readonly status: 'scored' | 'scorer_error' | 'target_error' | 'skipped'
  /** Present only when scoring completed successfully. */
  readonly score?: number
  readonly pass?: boolean
  readonly reason?: string
  readonly details?: Readonly<Record<string, TraceAttributeValue>>
  readonly runRef?: {
    readonly runId: string
    readonly attempt: number
    readonly traceId: string
    readonly rootSpanId: string
  }
  readonly metadata: Readonly<Record<string, TraceAttributeValue>>
  readonly usage?: {
    readonly tokens?: TokenUsage
    readonly cost?: RunCostSummary
    readonly durationMs?: number
  }
  readonly error?: StructuredTraceError
  readonly payload?: {
    readonly input?: string
    readonly output?: string
    readonly expected?: string
  }
}
