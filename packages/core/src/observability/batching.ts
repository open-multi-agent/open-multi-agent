import type { TraceRecord } from './records.js'
import {
  DiagnosticReporter,
  statsFlushResult,
  type DiagnosticOptions,
  type ExportResult,
  type FlushOptions,
  type FlushResult,
  type TraceExporter,
  type TraceSink,
  type TraceSinkStats,
} from './sink.js'

export const DEFAULT_BATCHING_OPTIONS = Object.freeze({
  maxQueueRecords: 2_048,
  maxQueueBytes: 16 * 1024 * 1024,
  maxRecordBytes: 256 * 1024,
  maxBatchRecords: 512,
  scheduledDelayMs: 5_000,
  exportTimeoutMs: 30_000,
  maxRetries: 3,
  retryDelayMs: 1_000,
  retryBackoff: 2,
  maxRetryDelayMs: 30_000,
})

export interface BatchingTraceSinkOptions extends DiagnosticOptions {
  readonly maxQueueRecords?: number
  readonly maxQueueBytes?: number
  readonly maxRecordBytes?: number
  readonly maxBatchRecords?: number
  readonly scheduledDelayMs?: number
  readonly exportTimeoutMs?: number
  /** Number of retries after the initial export attempt. */
  readonly maxRetries?: number
  readonly retryDelayMs?: number
  readonly retryBackoff?: number
  readonly maxRetryDelayMs?: number
  /** Disable equal jitter only for deterministic tests/benchmarks. */
  readonly retryJitter?: boolean
}

interface QueueEntry {
  readonly id: number
  readonly record: TraceRecord
  readonly bytes: number
  readonly priority: number
}

interface MutableStats {
  accepted: number
  exported: number
  retried: number
  failed: number
  dropped: number
  queuedRecords: number
  queuedBytes: number
  lastError?: string
}

type TimeoutResult<T> = { readonly kind: 'value'; readonly value: T } | { readonly kind: 'timeout' }

function positiveInt(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback
}

function nonNegativeInt(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback
}

function recordPriority(record: TraceRecord): number {
  if (record.recordType === 'span_end') return 3
  if (record.recordType === 'span_start') return 2
  if (record.name === 'stream_chunk') return 0
  return 1
}

function normalizeExportResult(value: unknown): ExportResult {
  try {
    if (typeof value !== 'object' || value === null) {
      return { status: 'failure', exported: 0, code: 'INVALID_EXPORT_RESULT' }
    }
    const candidate = value as Partial<ExportResult>
    if (
      candidate.status !== 'success'
      && candidate.status !== 'retryable'
      && candidate.status !== 'failure'
    ) {
      return { status: 'failure', exported: 0, code: 'INVALID_EXPORT_RESULT' }
    }
    if (typeof candidate.exported !== 'number' || !Number.isFinite(candidate.exported)) {
      return { status: 'failure', exported: 0, code: 'INVALID_EXPORT_RESULT' }
    }
    return {
      status: candidate.status,
      exported: candidate.exported,
      ...(typeof candidate.retryAfterMs === 'number' && Number.isFinite(candidate.retryAfterMs)
        ? { retryAfterMs: Math.max(0, candidate.retryAfterMs) }
        : {}),
      ...(typeof candidate.code === 'string' ? { code: candidate.code.slice(0, 128) } : {}),
    }
  } catch {
    return { status: 'failure', exported: 0, code: 'INVALID_EXPORT_RESULT' }
  }
}

function byteSize(record: TraceRecord): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(record), 'utf8')
  } catch {
    return undefined
  }
}

function unrefTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(callback, delayMs)
  timer.unref?.()
  return timer
}

async function withTimeout<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<TimeoutResult<T>> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<TimeoutResult<T>>((resolve) => {
    timer = unrefTimer(() => {
      controller.abort(new Error('Telemetry operation timed out.'))
      resolve({ kind: 'timeout' })
    }, timeoutMs)
  })
  const value = Promise.resolve()
    .then(() => operation(controller.signal))
    .then<TimeoutResult<T>>((result) => ({ kind: 'value', value: result }))
  try {
    return await Promise.race([value, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<boolean> {
  if (delayMs <= 0) return Promise.resolve(true)
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = unrefTimer(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    const onAbort = () => {
      clearTimeout(timer)
      resolve(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Zero-dependency, bounded asynchronous transport for TraceRecord batches. */
export class BatchingTraceSink implements TraceSink {
  private readonly options: Required<Omit<BatchingTraceSinkOptions, keyof DiagnosticOptions>>
  private readonly diagnostics: DiagnosticReporter
  private readonly queue: QueueEntry[] = []
  private readonly mutable: MutableStats = {
    accepted: 0,
    exported: 0,
    retried: 0,
    failed: 0,
    dropped: 0,
    queuedRecords: 0,
    queuedBytes: 0,
  }
  private nextId = 0
  private settledThrough = 0
  private readonly settledOutOfOrder = new Set<number>()
  private timer?: ReturnType<typeof setTimeout>
  private worker?: Promise<void>
  private wakeWorker = false
  private closing = false
  private shutdownPromise?: Promise<FlushResult>
  private exporterFlush?: Promise<'ok' | 'timeout' | 'error'>
  private readonly waiters = new Set<() => void>()

  constructor(
    private readonly exporter: TraceExporter,
    options: BatchingTraceSinkOptions = {},
  ) {
    this.options = {
      maxQueueRecords: positiveInt(options.maxQueueRecords, DEFAULT_BATCHING_OPTIONS.maxQueueRecords),
      maxQueueBytes: positiveInt(options.maxQueueBytes, DEFAULT_BATCHING_OPTIONS.maxQueueBytes),
      maxRecordBytes: positiveInt(options.maxRecordBytes, DEFAULT_BATCHING_OPTIONS.maxRecordBytes),
      maxBatchRecords: positiveInt(options.maxBatchRecords, DEFAULT_BATCHING_OPTIONS.maxBatchRecords),
      scheduledDelayMs: positiveInt(options.scheduledDelayMs, DEFAULT_BATCHING_OPTIONS.scheduledDelayMs),
      exportTimeoutMs: positiveInt(options.exportTimeoutMs, DEFAULT_BATCHING_OPTIONS.exportTimeoutMs),
      maxRetries: nonNegativeInt(options.maxRetries, DEFAULT_BATCHING_OPTIONS.maxRetries),
      retryDelayMs: nonNegativeInt(options.retryDelayMs, DEFAULT_BATCHING_OPTIONS.retryDelayMs),
      retryBackoff: options.retryBackoff !== undefined && options.retryBackoff >= 1
        ? options.retryBackoff
        : DEFAULT_BATCHING_OPTIONS.retryBackoff,
      maxRetryDelayMs: positiveInt(options.maxRetryDelayMs, DEFAULT_BATCHING_OPTIONS.maxRetryDelayMs),
      retryJitter: options.retryJitter ?? true,
    }
    this.diagnostics = new DiagnosticReporter({ ...options, sinkName: options.sinkName ?? 'BatchingTraceSink' })
  }

  emit(record: TraceRecord): void {
    if (this.closing) {
      this.mutable.dropped++
      this.diagnostics.report('emit_after_shutdown', 'Trace record rejected after sink shutdown began.')
      return
    }
    const bytes = byteSize(record)
    if (bytes === undefined || bytes > this.options.maxRecordBytes) {
      this.mutable.dropped++
      this.diagnostics.report('record_too_large', 'Trace record exceeded the configured size limit or was not serializable.')
      return
    }

    const incoming: QueueEntry = {
      id: this.nextId + 1,
      record,
      bytes,
      priority: recordPriority(record),
    }
    if (!this.makeRoom(incoming)) {
      this.mutable.dropped++
      this.diagnostics.report('queue_full', 'Trace record dropped because the bounded queue is full.')
      return
    }

    this.nextId = incoming.id
    this.mutable.accepted++
    this.queue.push(incoming)
    this.mutable.queuedRecords++
    this.mutable.queuedBytes += bytes
    if (this.queue.length >= this.options.maxBatchRecords) this.startWorker()
    else this.schedule()
  }

  async forceFlush(options: FlushOptions = {}): Promise<FlushResult> {
    const startedAt = Date.now()
    const timeoutMs = options.timeoutMs ?? this.options.exportTimeoutMs
    const target = this.nextId
    const before = this.getStats()
    let completed = target <= this.settledThrough
    if (!completed) {
      this.clearTimer()
      this.startWorker()
      completed = await this.waitForWatermark(target, timeoutMs)
    }
    const stats = this.getStats()
    if (!completed) {
      this.diagnostics.report('flush_timeout', 'Trace flush timed out before its acceptance watermark settled.')
      return statsFlushResult(stats, 'timeout')
    }
    const remainingMs = Math.max(0, timeoutMs - (Date.now() - startedAt))
    const exporterStatus = await this.flushExporter(remainingMs)
    if (exporterStatus === 'timeout') {
      this.diagnostics.report('flush_timeout', 'Trace exporter forceFlush timed out.')
      return statsFlushResult(this.getStats(), 'timeout')
    }
    if (exporterStatus === 'error') {
      this.mutable.lastError = 'EXPORTER_FLUSH_FAILED'
      this.diagnostics.report('export_failed', 'Trace exporter forceFlush failed.', 'error')
      return statsFlushResult(this.getStats(), stats.exported > 0 ? 'partial' : 'error')
    }
    return statsFlushResult(stats, this.resultStatus(stats))
  }

  shutdown(options: FlushOptions = {}): Promise<FlushResult> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.closing = true
    this.clearTimer()
    this.shutdownPromise = this.performShutdown(options)
    return this.shutdownPromise
  }

  getStats(): TraceSinkStats {
    return {
      ...this.mutable,
      queued: this.mutable.queuedRecords,
      ...(this.mutable.lastError ? { lastFailureCode: this.mutable.lastError } : {}),
    }
  }

  private makeRoom(incoming: QueueEntry): boolean {
    const wouldOverflow = () =>
      this.mutable.queuedRecords + 1 > this.options.maxQueueRecords
      || this.mutable.queuedBytes + incoming.bytes > this.options.maxQueueBytes

    while (wouldOverflow()) {
      let candidateIndex = -1
      let candidatePriority = Infinity
      for (let index = 0; index < this.queue.length; index++) {
        const priority = this.queue[index]!.priority
        if (priority < candidatePriority) {
          candidatePriority = priority
          candidateIndex = index
        }
      }
      if (candidateIndex < 0 || candidatePriority > incoming.priority) return false
      const [dropped] = this.queue.splice(candidateIndex, 1)
      if (!dropped) return false
      this.mutable.queuedRecords--
      this.mutable.queuedBytes -= dropped.bytes
      this.mutable.dropped++
      this.settle(dropped.id)
      this.diagnostics.report('queue_full', 'A lower-priority queued trace record was dropped to preserve bounded memory.')
    }
    return true
  }

  private schedule(): void {
    if (this.timer || this.worker || this.queue.length === 0) return
    this.timer = unrefTimer(() => {
      this.timer = undefined
      this.startWorker()
    }, this.options.scheduledDelayMs)
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  private startWorker(): void {
    this.wakeWorker = true
    if (this.worker) return
    this.worker = this.drain().finally(() => {
      this.worker = undefined
      if (this.queue.length > 0) {
        if (this.wakeWorker || this.closing) this.startWorker()
        else this.schedule()
      }
    })
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      this.wakeWorker = false
      const batch = this.queue.splice(0, this.options.maxBatchRecords)
      await this.exportBatch(batch)
      if (!this.wakeWorker && !this.closing && this.queue.length < this.options.maxBatchRecords) break
    }
  }

  private async exportBatch(batch: QueueEntry[]): Promise<void> {
    let remaining = batch
    let retry = 0
    while (remaining.length > 0) {
      let result: ExportResult
      try {
        const outcome = await withTimeout(this.options.exportTimeoutMs, (signal) =>
          this.exporter.export(remaining.map((entry) => entry.record), signal))
        if (outcome.kind === 'timeout') {
          result = { status: 'retryable', exported: 0, code: 'EXPORT_TIMEOUT' }
          this.diagnostics.report('export_timeout', 'Trace exporter exceeded its configured timeout.', 'error')
        } else {
          result = normalizeExportResult(outcome.value)
        }
      } catch {
        result = { status: 'retryable', exported: 0, code: 'EXPORT_REJECTED' }
      }

      const delivered = Math.min(remaining.length, Math.max(0, Math.floor(result.exported)))
      for (const entry of remaining.slice(0, delivered)) this.markExported(entry)
      remaining = remaining.slice(delivered)
      if (remaining.length === 0) return

      if (result.status !== 'success') {
        this.mutable.lastError = result.code ?? (result.status === 'retryable' ? 'EXPORT_RETRYABLE' : 'EXPORT_FAILED')
      }

      if (result.status === 'retryable' && retry < this.options.maxRetries) {
        retry++
        this.mutable.retried += remaining.length
        const nominal = result.retryAfterMs ?? Math.min(
          this.options.retryDelayMs * this.options.retryBackoff ** (retry - 1),
          this.options.maxRetryDelayMs,
        )
        const delay = this.options.retryJitter
          ? Math.floor(nominal / 2 + Math.random() * nominal / 2)
          : nominal
        this.diagnostics.report('export_failed', 'Trace exporter reported a retryable delivery failure.')
        await abortableDelay(delay)
        continue
      }

      const code = result.code ?? (result.status === 'success' ? 'PARTIAL_EXPORT' : 'EXPORT_FAILED')
      this.mutable.lastError = code
      for (const entry of remaining) this.markFailed(entry)
      this.diagnostics.report('export_failed', 'Trace exporter permanently failed to deliver one or more records.', 'error')
      return
    }
  }

  private markExported(entry: QueueEntry): void {
    this.mutable.exported++
    this.release(entry)
    this.settle(entry.id)
  }

  private markFailed(entry: QueueEntry): void {
    this.mutable.failed++
    this.release(entry)
    this.settle(entry.id)
  }

  private release(entry: QueueEntry): void {
    this.mutable.queuedRecords--
    this.mutable.queuedBytes -= entry.bytes
  }

  private settle(id: number): void {
    if (id === this.settledThrough + 1) {
      this.settledThrough = id
      while (this.settledOutOfOrder.delete(this.settledThrough + 1)) this.settledThrough++
    } else if (id > this.settledThrough) {
      this.settledOutOfOrder.add(id)
    }
    for (const wake of this.waiters) wake()
  }

  private waitForWatermark(target: number, timeoutMs?: number): Promise<boolean> {
    if (target <= this.settledThrough) return Promise.resolve(true)
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const check = () => {
        if (target > this.settledThrough) return
        cleanup()
        resolve(true)
      }
      const cleanup = () => {
        this.waiters.delete(check)
        if (timer) clearTimeout(timer)
      }
      this.waiters.add(check)
      if (timeoutMs !== undefined) {
        timer = unrefTimer(() => {
          cleanup()
          resolve(false)
        }, Math.max(0, timeoutMs))
      }
      check()
    })
  }

  private resultStatus(stats: TraceSinkStats): FlushResult['status'] {
    if (stats.failed > 0 || stats.dropped > 0) {
      return stats.exported > 0 ? 'partial' : 'error'
    }
    return 'ok'
  }

  private async performShutdown(options: FlushOptions): Promise<FlushResult> {
    const startedAt = Date.now()
    const totalTimeoutMs = options.timeoutMs ?? this.options.exportTimeoutMs
    const flushed = await this.forceFlush({ timeoutMs: totalTimeoutMs })
    if (flushed.status === 'timeout') return flushed
    if (!this.exporter.shutdown) return flushed
    try {
      const timeoutMs = Math.max(0, totalTimeoutMs - (Date.now() - startedAt))
      const outcome = await withTimeout(timeoutMs, (signal) => this.exporter.shutdown!(signal))
      if (outcome.kind === 'timeout') {
        this.mutable.lastError = 'SHUTDOWN_TIMEOUT'
        this.diagnostics.report('shutdown_failed', 'Trace exporter shutdown timed out.', 'error')
        return statsFlushResult(this.getStats(), 'timeout')
      }
      if (outcome.value.status !== 'success') {
        this.mutable.lastError = outcome.value.code ?? 'SHUTDOWN_FAILED'
        this.diagnostics.report('shutdown_failed', 'Trace exporter shutdown failed.', 'error')
        return statsFlushResult(this.getStats(), flushed.status === 'ok' ? 'error' : 'partial')
      }
      return flushed
    } catch {
      this.mutable.lastError = 'SHUTDOWN_REJECTED'
      this.diagnostics.report('shutdown_failed', 'Trace exporter shutdown rejected.', 'error')
      return statsFlushResult(this.getStats(), flushed.status === 'ok' ? 'error' : 'partial')
    }
  }

  private flushExporter(timeoutMs: number): Promise<'ok' | 'timeout' | 'error'> {
    if (!this.exporter.forceFlush) return Promise.resolve('ok')
    if (this.exporterFlush) return this.waitForExporterFlush(this.exporterFlush, timeoutMs)
    this.exporterFlush = (async () => {
      try {
        const outcome = await withTimeout(timeoutMs, (signal) => this.exporter.forceFlush!(signal))
        if (outcome.kind === 'timeout') return 'timeout'
        return outcome.value.status === 'success' ? 'ok' : 'error'
      } catch {
        return 'error'
      }
    })().finally(() => { this.exporterFlush = undefined })
    return this.exporterFlush
  }

  private waitForExporterFlush(
    work: Promise<'ok' | 'timeout' | 'error'>,
    timeoutMs: number,
  ): Promise<'ok' | 'timeout' | 'error'> {
    return new Promise((resolve) => {
      let settled = false
      const timer = unrefTimer(() => {
        if (settled) return
        settled = true
        resolve('timeout')
      }, timeoutMs)
      work.then((result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      })
    })
  }
}
