import type { TraceEvent } from '../types.js'
import type { TraceRecord } from './records.js'
import {
  DiagnosticReporter,
  statsFlushResult,
  type DiagnosticOptions,
  type FlushOptions,
  type FlushResult,
  type TraceSink,
  type TraceSinkStats,
} from './sink.js'

const LEGACY_EVENT = Symbol('oma.legacyTraceEvent')

type RecordWithLegacy = TraceRecord & { readonly [LEGACY_EVENT]?: TraceEvent }

/** Internal non-enumerable metadata used only by the compatibility bridge. */
export function attachLegacyTraceEvent(record: TraceRecord, event: TraceEvent): void {
  Object.defineProperty(record, LEGACY_EVENT, { value: event, enumerable: false })
}

/**
 * Completion/event bridge for the unchanged seven-member TraceEvent union.
 * Promise callbacks are tracked so direct users can forceFlush the bridge.
 */
export class LegacyCallbackTraceSink implements TraceSink {
  private readonly diagnostics: DiagnosticReporter
  private readonly pending = new Map<number, Promise<void>>()
  private nextId = 0
  private closing = false
  private shutdownPromise?: Promise<FlushResult>
  private mutable = { accepted: 0, exported: 0, failed: 0, dropped: 0 }

  constructor(
    private readonly callback: (event: TraceEvent) => void | Promise<void>,
    options: DiagnosticOptions = {},
  ) {
    this.diagnostics = new DiagnosticReporter({ ...options, sinkName: options.sinkName ?? 'LegacyCallbackTraceSink' })
  }

  emit(record: TraceRecord): void {
    const event = (record as RecordWithLegacy)[LEGACY_EVENT]
    if (!event) return
    if (this.closing) {
      this.mutable.dropped++
      this.diagnostics.report('emit_after_shutdown', 'Legacy trace event rejected after sink shutdown began.')
      return
    }

    const id = ++this.nextId
    this.mutable.accepted++
    try {
      const result = this.callback(event)
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        const tracked = Promise.resolve(result).then(
          () => { this.mutable.exported++ },
          () => {
            this.mutable.failed++
            this.diagnostics.report('export_failed', 'Legacy trace callback rejected.', 'error')
          },
        ).finally(() => { this.pending.delete(id) })
        this.pending.set(id, tracked)
      } else {
        this.mutable.exported++
      }
    } catch {
      this.mutable.failed++
      this.diagnostics.report('sink_emit_failed', 'Legacy trace callback threw synchronously.', 'error')
    }
  }

  async forceFlush(options: FlushOptions = {}): Promise<FlushResult> {
    const watermark = this.nextId
    const work = [...this.pending.entries()]
      .filter(([id]) => id <= watermark)
      .map(([, promise]) => promise)
    if (work.length === 0) return statsFlushResult(this.getStats(), this.resultStatus())

    const completed = await this.wait(Promise.all(work), options.timeoutMs ?? 30_000)
    if (!completed) {
      this.diagnostics.report('flush_timeout', 'Legacy trace callback flush timed out.')
      return statsFlushResult(this.getStats(), 'timeout')
    }
    return statsFlushResult(this.getStats(), this.resultStatus())
  }

  shutdown(options: FlushOptions = {}): Promise<FlushResult> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.closing = true
    this.shutdownPromise = this.forceFlush(options)
    return this.shutdownPromise
  }

  getStats(): TraceSinkStats {
    return {
      ...this.mutable,
      retried: 0,
      queuedRecords: this.pending.size,
      queuedBytes: 0,
      queued: this.pending.size,
      ...(this.mutable.failed > 0 ? { lastError: 'LEGACY_CALLBACK_FAILED', lastFailureCode: 'LEGACY_CALLBACK_FAILED' } : {}),
    }
  }

  private resultStatus(): FlushResult['status'] {
    if (this.mutable.failed === 0 && this.mutable.dropped === 0) return 'ok'
    return this.mutable.exported > 0 ? 'partial' : 'error'
  }

  private wait(work: Promise<unknown>, timeoutMs?: number): Promise<boolean> {
    if (timeoutMs === undefined) return work.then(() => true)
    return new Promise((resolve) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        resolve(false)
      }, Math.max(0, timeoutMs))
      timer.unref?.()
      work.then(() => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(true)
      })
    })
  }
}
