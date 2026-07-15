import type { TraceRecord } from './records.js'
import {
  DiagnosticReporter,
  emptyTraceSinkStats,
  type DiagnosticOptions,
  type FlushOptions,
  type FlushResult,
  type TraceSink,
  type TraceSinkStats,
} from './sink.js'

function combineStatus(results: readonly FlushResult[]): FlushResult['status'] {
  if (results.length === 0 || results.every((result) => result.status === 'ok')) return 'ok'
  if (results.every((result) => result.status === 'timeout')) return 'timeout'
  if (results.every((result) => result.status === 'error')) return 'error'
  return 'partial'
}

function combine(results: readonly FlushResult[]): FlushResult {
  return {
    status: combineStatus(results),
    accepted: results.reduce((sum, result) => sum + result.accepted, 0),
    exported: results.reduce((sum, result) => sum + result.exported, 0),
    dropped: results.reduce((sum, result) => sum + result.dropped, 0),
    failed: results.reduce((sum, result) => sum + result.failed, 0),
  }
}

function unrefTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(callback, delayMs)
  timer.unref?.()
  return timer
}

function safeStats(sink: TraceSink): TraceSinkStats {
  try {
    return sink.getStats?.() ?? emptyTraceSinkStats()
  } catch {
    return emptyTraceSinkStats()
  }
}

/** Fan-out sink. One child failure never prevents delivery to later children. */
export class CompositeSink implements TraceSink {
  private readonly diagnostics: DiagnosticReporter
  private shutdownPromise?: Promise<FlushResult>
  private closing = false
  private emitFailures = 0

  constructor(
    private readonly sinks: readonly TraceSink[],
    options: DiagnosticOptions = {},
  ) {
    this.diagnostics = new DiagnosticReporter({ ...options, sinkName: options.sinkName ?? 'CompositeSink' })
  }

  emit(record: TraceRecord): void {
    if (this.closing) {
      this.diagnostics.report('emit_after_shutdown', 'Trace record rejected after composite shutdown began.')
      return
    }
    for (const sink of this.sinks) {
      try {
        sink.emit(record)
      } catch {
        this.emitFailures++
        this.diagnostics.report('sink_emit_failed', 'A child trace sink threw while accepting a record.', 'error')
      }
    }
  }

  async forceFlush(options: FlushOptions = {}): Promise<FlushResult> {
    const results = await Promise.all(this.sinks.map((sink) =>
      this.callChild(sink, 'flush', options)))
    return combine(results)
  }

  shutdown(options: FlushOptions = {}): Promise<FlushResult> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.closing = true
    this.shutdownPromise = this.performShutdown(options)
    return this.shutdownPromise
  }

  getStats(): TraceSinkStats {
    const stats = this.sinks.map(safeStats)
    const last = [...stats].reverse().find((value) => value.lastError !== undefined)
    return {
      accepted: stats.reduce((sum, value) => sum + value.accepted, 0),
      exported: stats.reduce((sum, value) => sum + value.exported, 0),
      retried: stats.reduce((sum, value) => sum + value.retried, 0),
      failed: stats.reduce((sum, value) => sum + value.failed, this.emitFailures),
      dropped: stats.reduce((sum, value) => sum + value.dropped, 0),
      queuedRecords: stats.reduce((sum, value) => sum + value.queuedRecords, 0),
      queuedBytes: stats.reduce((sum, value) => sum + value.queuedBytes, 0),
      queued: stats.reduce((sum, value) => sum + value.queuedRecords, 0),
      ...(last?.lastError ? { lastError: last.lastError, lastFailureCode: last.lastError } : {}),
    }
  }

  private async performShutdown(options: FlushOptions): Promise<FlushResult> {
    const results = await Promise.all(this.sinks.map((sink) =>
      this.callChild(sink, 'shutdown', options)))
    return combine(results)
  }

  private callChild(
    sink: TraceSink,
    operation: 'flush' | 'shutdown',
    options: FlushOptions,
  ): Promise<FlushResult> {
    const timeoutMs = options.timeoutMs ?? 30_000
    return new Promise((resolve) => {
      let settled = false
      const finish = (result: FlushResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
      const timer = unrefTimer(() => {
        const stats = safeStats(sink)
        this.diagnostics.report(
          operation === 'flush' ? 'flush_timeout' : 'shutdown_failed',
          `A child trace sink ${operation} operation timed out.`,
          'error',
        )
        finish({
          status: 'timeout',
          accepted: stats.accepted,
          exported: stats.exported,
          dropped: stats.dropped,
          failed: stats.failed,
        })
      }, Math.max(0, timeoutMs))

      Promise.resolve()
        .then(() => operation === 'flush' ? sink.forceFlush(options) : sink.shutdown(options))
        .then(finish, () => {
          const stats = safeStats(sink)
          this.diagnostics.report(
            operation === 'flush' ? 'export_failed' : 'shutdown_failed',
            `A child trace sink rejected ${operation}.`,
            'error',
          )
          finish({
            status: 'error',
            accepted: stats.accepted,
            exported: stats.exported,
            dropped: stats.dropped,
            failed: stats.failed + 1,
          })
        })
    })
  }
}
