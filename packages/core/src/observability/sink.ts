import type { TraceRecord } from './records.js'

export interface FlushOptions {
  readonly timeoutMs?: number
}

export interface FlushResult {
  readonly status: 'ok' | 'partial' | 'timeout' | 'error'
  readonly accepted: number
  readonly exported: number
  readonly dropped: number
  readonly failed: number
}

/**
 * Result for one exporter call. `exported` is the successfully delivered
 * prefix of the supplied batch. A short success is a permanent partial
 * result; a short retryable result retries only the unexported suffix.
 */
export interface ExportResult {
  readonly status: 'success' | 'retryable' | 'failure'
  readonly exported: number
  readonly retryAfterMs?: number
  readonly code?: string
}

export interface TraceExporter {
  export(records: readonly TraceRecord[], signal: AbortSignal): Promise<ExportResult>
  forceFlush?(signal: AbortSignal): Promise<ExportResult>
  shutdown?(signal: AbortSignal): Promise<ExportResult>
}

export interface TraceSinkStats {
  readonly accepted: number
  readonly exported: number
  readonly retried: number
  readonly failed: number
  readonly dropped: number
  readonly queuedRecords: number
  readonly queuedBytes: number
  readonly lastError?: string
  /** Backwards-friendly alias for queuedRecords. */
  readonly queued: number
  /** Backwards-friendly alias for lastError. */
  readonly lastFailureCode?: string
}

export type TelemetryDiagnosticCode =
  | 'sink_emit_failed'
  | 'queue_full'
  | 'record_too_large'
  | 'export_failed'
  | 'export_timeout'
  | 'flush_timeout'
  | 'shutdown_failed'
  | 'emit_after_shutdown'

export interface TelemetryDiagnostic {
  readonly code: TelemetryDiagnosticCode
  readonly severity: 'warning' | 'error'
  readonly count: number
  readonly sinkName?: string
  /** Fixed, payload-free message. Never contains a TraceRecord or raw error. */
  readonly message: string
}

export type DiagnosticMode = 'warn' | 'silent'

export interface DiagnosticOptions {
  readonly diagnostics?: DiagnosticMode
  readonly onDiagnostic?: (diagnostic: TelemetryDiagnostic) => void
  readonly diagnosticIntervalMs?: number
  readonly sinkName?: string
}

export interface TraceSink {
  /** Synchronous, non-blocking acceptance. Callers never await this method. */
  emit(record: TraceRecord): void
  forceFlush(options?: FlushOptions): Promise<FlushResult>
  /** Idempotent. Emit after the shutdown cutoff is rejected and diagnosed. */
  shutdown(options?: FlushOptions): Promise<FlushResult>
  getStats?(): TraceSinkStats
}

export interface ObservabilityResource {
  readonly serviceName?: string
  readonly serviceVersion?: string
  readonly deploymentEnvironment?: string
  readonly release?: string
}

export interface TraceCapturePolicy {
  readonly prompt?: 'none' | 'redacted'
  readonly completion?: 'none' | 'redacted'
  readonly toolInput?: 'none' | 'redacted'
  readonly toolOutput?: 'none' | 'redacted'
  readonly errorMessage?: 'code-only' | 'redacted'
  readonly stack?: boolean
  readonly streamEvents?: 'none' | 'first' | 'all'
  readonly maxContentChars?: number
}

export interface ObservabilityConfig {
  readonly sinks: readonly TraceSink[]
  readonly resource?: ObservabilityResource
  readonly capture?: TraceCapturePolicy
  readonly onDiagnostic?: (diagnostic: TelemetryDiagnostic) => void
}

const EMPTY_STATS: TraceSinkStats = {
  accepted: 0,
  exported: 0,
  retried: 0,
  failed: 0,
  dropped: 0,
  queuedRecords: 0,
  queuedBytes: 0,
  queued: 0,
}

export function emptyTraceSinkStats(): TraceSinkStats {
  return { ...EMPTY_STATS }
}

/** Payload-free, rate-limited diagnostics that cannot recurse through tracing. */
export class DiagnosticReporter {
  private readonly counts = new Map<TelemetryDiagnosticCode, number>()
  private readonly lastEmitted = new Map<TelemetryDiagnosticCode, number>()

  constructor(private readonly options: DiagnosticOptions = {}) {}

  report(
    code: TelemetryDiagnosticCode,
    message: string,
    severity: TelemetryDiagnostic['severity'] = 'warning',
  ): void {
    const count = (this.counts.get(code) ?? 0) + 1
    this.counts.set(code, count)
    const now = Date.now()
    const interval = this.options.diagnosticIntervalMs ?? 60_000
    if (now - (this.lastEmitted.get(code) ?? -Infinity) < interval) return
    this.lastEmitted.set(code, now)

    const diagnostic: TelemetryDiagnostic = {
      code,
      severity,
      count,
      ...(this.options.sinkName ? { sinkName: this.options.sinkName } : {}),
      message,
    }
    try {
      if (this.options.onDiagnostic) {
        this.options.onDiagnostic(diagnostic)
      } else if (this.options.diagnostics !== 'silent') {
        console.warn(`[open-multi-agent observability] ${code}: ${message}`)
      }
    } catch {
      // A diagnostic handler is itself telemetry. Never recurse or throw.
    }
  }
}

export function statsFlushResult(
  stats: TraceSinkStats,
  status: FlushResult['status'],
): FlushResult {
  return {
    status,
    accepted: stats.accepted,
    exported: stats.exported,
    dropped: stats.dropped,
    failed: stats.failed,
  }
}
