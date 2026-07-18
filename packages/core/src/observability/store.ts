import type { RunStatusCode, TokenUsage, TraceAttributeValue, TraceLink } from '../types.js'
import type { SpanEventRecord, SpanKind, TraceRecord } from './records.js'

export const TRACE_STORE_SCHEMA_MAJOR = 2 as const

export type TraceStoreErrorCode =
  | 'INVALID_ARGUMENT'
  | 'INVALID_CURSOR'
  | 'UNSUPPORTED_SCHEMA_VERSION'

/** Structured validation failure shared by every TraceStore implementation. */
export class TraceStoreError extends Error {
  readonly name = 'TraceStoreError'

  constructor(
    readonly code: TraceStoreErrorCode,
    message: string,
    readonly field?: string,
  ) {
    super(message)
  }
}

export type TraceStoreDiagnosticCode =
  | 'duplicate_span_end'
  | 'record_id_collision'

export interface TraceStoreDiagnostic {
  readonly code: TraceStoreDiagnosticCode
  readonly runId: string
  readonly traceId: string
  readonly spanId: string
  /** Payload-free message suitable for logs. */
  readonly message: string
}

export interface AppendResult {
  readonly written: number
  readonly deduplicated: number
  readonly diagnostics: readonly TraceStoreDiagnostic[]
}

export interface DeleteResult {
  readonly runsDeleted: number
  readonly recordsDeleted: number
  /** Deterministic deletion order. */
  readonly runIds: readonly string[]
}

export interface Page<T> {
  readonly items: readonly T[]
  readonly nextCursor?: string
}

export interface GetRunOptions {
  /** Include the immutable, sequence-sorted source record stream. */
  readonly includeRecords?: boolean
}

export interface TraceQuery {
  readonly runId?: string | readonly string[]
  /** Inclusive ISO-8601 lower bound on materialized run start time. */
  readonly startedAfter?: string
  /** Exclusive ISO-8601 upper bound on materialized run start time. */
  readonly startedBefore?: string
  readonly status?: readonly RunStatusCode[]
  readonly agent?: readonly string[]
  readonly taskId?: readonly string[]
  readonly model?: readonly string[]
  readonly provider?: readonly string[]
  readonly limit?: number
  readonly cursor?: string
  readonly order?: 'started_desc' | 'started_asc'
}

export type TraceDeleteQuery = Omit<TraceQuery, 'cursor' | 'limit' | 'order'>

export interface RetentionPolicy {
  readonly maxAgeMs?: number
  readonly maxRuns?: number
  /** When present, age and maxRuns only apply to runs with these terminal statuses. */
  readonly statuses?: readonly RunStatusCode[]
}

export interface RunAttemptSummary {
  readonly attempt: number
  readonly traceId: string
  readonly rootSpanId?: string
  readonly startedAt: string
  readonly endedAt?: string
  readonly durationMs?: number
  readonly status?: RunStatusCode
  readonly incomplete: boolean
}

export interface RunCostSummary {
  readonly amount: number
  readonly currency: string
}

export interface RunTokenSummary extends TokenUsage {
  readonly cache_read_input_tokens?: number
  readonly cache_creation_input_tokens?: number
  readonly reasoning_output_tokens?: number
}

export interface RunSummary {
  readonly schemaVersion: typeof TRACE_STORE_SCHEMA_MAJOR
  readonly runId: string
  readonly attempts: readonly RunAttemptSummary[]
  readonly startedAt: string
  readonly endedAt?: string
  readonly durationMs?: number
  /** Absent when no terminal run record exists. Never inferred as ok. */
  readonly status?: RunStatusCode
  /** Validated per-run metadata materialized from the latest attempt's root span. */
  readonly metadata?: Readonly<Record<string, TraceAttributeValue>>
  readonly agents: readonly string[]
  readonly taskIds: readonly string[]
  readonly models: readonly string[]
  readonly providers: readonly string[]
  readonly tokens: RunTokenSummary
  readonly costs: readonly RunCostSummary[]
  readonly incomplete: boolean
}

export interface MaterializedSpan {
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId?: string
  readonly kind?: SpanKind
  readonly name?: string
  readonly startUnixMs?: number
  readonly endUnixMs?: number
  readonly durationMs?: number
  readonly status?: RunStatusCode
  readonly attributes: Readonly<Record<string, TraceAttributeValue>>
  readonly links: readonly TraceLink[]
  readonly events: readonly SpanEventRecord[]
  readonly incomplete: boolean
}

export interface StoredRun extends RunSummary {
  readonly spans: readonly MaterializedSpan[]
  readonly records?: readonly TraceRecord[]
}

/** Storage-medium-independent append/query contract for observability records. */
export interface TraceStore {
  /** Atomic per batch from the caller's view; idempotent by recordId. */
  append(records: readonly TraceRecord[]): Promise<AppendResult>
  getRun(runId: string, options?: GetRunOptions): Promise<StoredRun | null>
  queryRuns(query?: TraceQuery): Promise<Page<RunSummary>>
  deleteRun(runId: string): Promise<DeleteResult>
  delete(query: TraceDeleteQuery): Promise<DeleteResult>
  applyRetention(policy: RetentionPolicy): Promise<DeleteResult>
}
