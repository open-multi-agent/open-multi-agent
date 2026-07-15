import { describe, expect, it, vi } from 'vitest'
import { createRunIdentity } from '../src/observability/identity.js'
import type { TraceRecord, SpanEndRecord, SpanEventRecord, SpanStartRecord } from '../src/observability/records.js'
import { TraceRuntime } from '../src/observability/runtime.js'
import { BatchingTraceSink, DEFAULT_BATCHING_OPTIONS } from '../src/observability/batching.js'
import { CompositeSink } from '../src/observability/composite.js'
import { LegacyCallbackTraceSink } from '../src/observability/legacy-callback.js'
import { FilteringSink, SensitiveDataProcessor } from '../src/observability/processors.js'
import type {
  ExportResult,
  FlushResult,
  TraceExporter,
  TraceSink,
  TraceSinkStats,
} from '../src/observability/sink.js'
import { OpenMultiAgent } from '../src/orchestrator/orchestrator.js'
import type { LLMAdapter, TraceEvent } from '../src/types.js'

let sequence = 0

function base(recordType: TraceRecord['recordType']) {
  return {
    schemaVersion: 2 as const,
    recordId: `record-${++sequence}`,
    sequence,
    timestampUnixMs: Date.now(),
    runId: 'sink-test',
    attempt: 1,
    traceId: '1'.repeat(32),
    spanId: sequence.toString(16).padStart(16, '0'),
    recordType,
  }
}

function start(attributes: Record<string, string | number | boolean> = {}): SpanStartRecord {
  return {
    ...base('span_start'),
    kind: 'agent',
    name: 'invoke_agent',
    startUnixMs: Date.now(),
    attributes,
  }
}

function event(name: SpanEventRecord['name'] = 'retry_scheduled'): SpanEventRecord {
  return { ...base('span_event'), name, attributes: {} }
}

function end(attributes: Record<string, string | number | boolean> = {}): SpanEndRecord {
  const now = Date.now()
  return {
    ...base('span_end'),
    kind: 'agent',
    name: 'invoke_agent',
    startUnixMs: now,
    endUnixMs: now,
    durationMs: 0,
    status: { code: 'ok' },
    attributes,
  }
}

function exporter(
  implementation: (records: readonly TraceRecord[], signal: AbortSignal) => Promise<ExportResult>,
): TraceExporter {
  return { export: implementation }
}

function sinkOptions(extra: Record<string, unknown> = {}) {
  return {
    scheduledDelayMs: 60_000,
    exportTimeoutMs: 50,
    retryDelayMs: 0,
    retryJitter: false,
    diagnostics: 'silent' as const,
    ...extra,
  }
}

function emptyStats(): TraceSinkStats {
  return {
    accepted: 0,
    exported: 0,
    retried: 0,
    failed: 0,
    dropped: 0,
    queuedRecords: 0,
    queuedBytes: 0,
    queued: 0,
  }
}

function okResult(): FlushResult {
  return { status: 'ok', accepted: 0, exported: 0, dropped: 0, failed: 0 }
}

describe('BatchingTraceSink delivery lifecycle', () => {
  it('locks the RFC-backed queue, record, batch, interval, timeout, and retry defaults', () => {
    expect(DEFAULT_BATCHING_OPTIONS).toEqual({
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
  })

  it('accepts synchronously and exports a batch asynchronously', async () => {
    const batches: TraceRecord[][] = []
    const sink = new BatchingTraceSink(exporter(async (records) => {
      batches.push([...records])
      return { status: 'success', exported: records.length }
    }), sinkOptions())

    sink.emit(start())
    expect(batches).toHaveLength(0)
    const flushed = await sink.forceFlush({ timeoutMs: 200 })

    expect(batches).toHaveLength(1)
    expect(flushed).toMatchObject({ status: 'ok', accepted: 1, exported: 1, failed: 0 })
    expect(sink.getStats()).toMatchObject({ queuedRecords: 0, queuedBytes: 0 })
  })

  it('converts exporter rejection and permanent failure into stats, never a throw', async () => {
    const rejecting = new BatchingTraceSink(exporter(async () => { throw new Error('secret payload') }), sinkOptions({ maxRetries: 0 }))
    rejecting.emit(end())
    await expect(rejecting.forceFlush({ timeoutMs: 200 })).resolves.toMatchObject({ status: 'error', failed: 1 })
    expect(rejecting.getStats().lastError).toBe('EXPORT_REJECTED')

    const permanent = new BatchingTraceSink(exporter(async () => ({ status: 'failure', exported: 0, code: 'BAD_REQUEST' })), sinkOptions())
    permanent.emit(end())
    await expect(permanent.forceFlush({ timeoutMs: 200 })).resolves.toMatchObject({ status: 'error', failed: 1 })
    expect(permanent.getStats().lastError).toBe('BAD_REQUEST')

    const malformed = new BatchingTraceSink(
      exporter(async () => undefined as unknown as ExportResult),
      sinkOptions({ maxRetries: 0 }),
    )
    malformed.emit(end())
    await expect(malformed.forceFlush({ timeoutMs: 200 })).resolves.toMatchObject({ status: 'error', failed: 1 })
    expect(malformed.getStats().lastError).toBe('INVALID_EXPORT_RESULT')
  })

  it('bounds a hung exporter with export timeout and aborts its signal', async () => {
    let signal: AbortSignal | undefined
    const sink = new BatchingTraceSink(exporter(async (_records, current) => {
      signal = current
      return await new Promise<ExportResult>(() => {})
    }), sinkOptions({ exportTimeoutMs: 10, maxRetries: 0 }))
    sink.emit(end())

    const result = await sink.forceFlush({ timeoutMs: 100 })
    expect(result).toMatchObject({ status: 'error', failed: 1 })
    expect(signal?.aborted).toBe(true)
  })

  it('handles permanent partial success and retries only retryable remainders', async () => {
    const partial = new BatchingTraceSink(exporter(async () => ({ status: 'success', exported: 1 })), sinkOptions())
    partial.emit(start())
    partial.emit(end())
    await expect(partial.forceFlush({ timeoutMs: 200 })).resolves.toMatchObject({ status: 'partial', exported: 1, failed: 1 })

    let calls = 0
    const retried = new BatchingTraceSink(exporter(async (records) => {
      calls++
      return calls === 1
        ? { status: 'retryable', exported: 1, code: 'RATE_LIMIT' }
        : { status: 'success', exported: records.length }
    }), sinkOptions({ maxRetries: 1 }))
    retried.emit(start())
    retried.emit(end())
    const result = await retried.forceFlush({ timeoutMs: 200 })
    expect(result).toMatchObject({ status: 'ok', exported: 2, failed: 0 })
    expect(retried.getStats().retried).toBe(1)
  })

  it('enforces record-count and byte bounds with consistent stats', async () => {
    const delivered: TraceRecord[] = []
    const byCount = new BatchingTraceSink(exporter(async (records) => {
      delivered.push(...records)
      return { status: 'success', exported: records.length }
    }), sinkOptions({ maxQueueRecords: 1 }))
    byCount.emit(start())
    byCount.emit(end())
    expect(byCount.getStats()).toMatchObject({ accepted: 2, dropped: 1, queuedRecords: 1 })
    await byCount.forceFlush({ timeoutMs: 200 })
    expect(delivered[0]?.recordType).toBe('span_end')

    const first = start({ payload: 'a'.repeat(100) })
    const bytes = Buffer.byteLength(JSON.stringify(first), 'utf8')
    const byBytes = new BatchingTraceSink(exporter(async (records) => ({ status: 'success', exported: records.length })), sinkOptions({
      maxQueueBytes: bytes + 8,
      maxRecordBytes: bytes * 2,
    }))
    byBytes.emit(first)
    byBytes.emit(start({ payload: 'b'.repeat(100) }))
    expect(byBytes.getStats()).toMatchObject({ accepted: 2, dropped: 1, queuedRecords: 1 })
    expect(byBytes.getStats().queuedBytes).toBeLessThanOrEqual(bytes + 8)
    await byBytes.shutdown({ timeoutMs: 200 })
  })

  it('drops oversize records before acceptance', () => {
    const diagnostics = vi.fn()
    const sink = new BatchingTraceSink(exporter(async (records) => ({ status: 'success', exported: records.length })), sinkOptions({
      maxRecordBytes: 32,
      onDiagnostic: diagnostics,
    }))
    sink.emit(start({ payload: 'x'.repeat(100) }))
    sink.emit(start({ payload: 'y'.repeat(100) }))
    expect(sink.getStats()).toMatchObject({ accepted: 0, dropped: 2, queuedRecords: 0 })
    expect(diagnostics).toHaveBeenCalledOnce()
    expect(diagnostics.mock.calls[0]?.[0]).toMatchObject({ code: 'record_too_large', count: 1 })
  })

  it('rate-limits default warnings and requires explicit silent mode to suppress them', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const noisy = new BatchingTraceSink(
      exporter(async (records) => ({ status: 'success', exported: records.length })),
      { ...sinkOptions(), diagnostics: 'warn', maxRecordBytes: 32 },
    )
    noisy.emit(start({ payload: 'x'.repeat(100) }))
    noisy.emit(start({ payload: 'y'.repeat(100) }))
    expect(warn).toHaveBeenCalledOnce()

    const silent = new BatchingTraceSink(
      exporter(async (records) => ({ status: 'success', exported: records.length })),
      sinkOptions({ maxRecordBytes: 32 }),
    )
    silent.emit(start({ payload: 'z'.repeat(100) }))
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('uses stream event, event, start, end as the priority drop order', async () => {
    const delivered: TraceRecord[] = []
    const sink = new BatchingTraceSink(exporter(async (records) => {
      delivered.push(...records)
      return { status: 'success', exported: records.length }
    }), sinkOptions({ maxQueueRecords: 1 }))
    sink.emit(event('stream_chunk'))
    sink.emit(event('retry_scheduled'))
    sink.emit(start())
    sink.emit(end())
    expect(sink.getStats()).toMatchObject({ accepted: 4, dropped: 3, queuedRecords: 1 })
    await sink.forceFlush({ timeoutMs: 200 })
    expect(delivered.map((record) => record.recordType)).toEqual(['span_end'])
  })

  it('forceFlush observes an acceptance watermark and supports concurrent callers', async () => {
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    let call = 0
    const sink = new BatchingTraceSink(exporter(async (records) => {
      call++
      if (call === 1) await firstGate
      return { status: 'success', exported: records.length }
    }), sinkOptions({ maxBatchRecords: 1 }))

    sink.emit(start())
    const flushOne = sink.forceFlush({ timeoutMs: 200 })
    const flushTwo = sink.forceFlush({ timeoutMs: 200 })
    sink.emit(end())
    releaseFirst()

    await expect(Promise.all([flushOne, flushTwo])).resolves.toEqual([
      expect.objectContaining({ status: 'ok' }),
      expect.objectContaining({ status: 'ok' }),
    ])
    expect(call).toBeGreaterThanOrEqual(1)
    await sink.shutdown({ timeoutMs: 200 })
  })

  it('returns flush timeout promptly without changing later delivery', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const sink = new BatchingTraceSink(exporter(async (records) => {
      await gate
      return { status: 'success', exported: records.length }
    }), sinkOptions({ exportTimeoutMs: 500 }))
    sink.emit(end())
    await expect(sink.forceFlush({ timeoutMs: 5 })).resolves.toMatchObject({ status: 'timeout' })
    release()
    await expect(sink.forceFlush({ timeoutMs: 200 })).resolves.toMatchObject({ status: 'ok', exported: 1 })
  })

  it('makes concurrent/repeated shutdown deterministic and rejects later emits', async () => {
    const exporterFlush = vi.fn(async () => ({ status: 'success' as const, exported: 0 }))
    const shutdown = vi.fn(async () => ({ status: 'success' as const, exported: 0 }))
    const sink = new BatchingTraceSink({
      export: async (records) => ({ status: 'success', exported: records.length }),
      forceFlush: exporterFlush,
      shutdown,
    }, sinkOptions())
    sink.emit(end())
    const first = sink.shutdown({ timeoutMs: 200 })
    const second = sink.shutdown({ timeoutMs: 1 })
    expect(first).toBe(second)
    await expect(first).resolves.toMatchObject({ status: 'ok', exported: 1 })
    expect(exporterFlush).toHaveBeenCalledOnce()
    expect(shutdown).toHaveBeenCalledOnce()
    sink.emit(end())
    expect(sink.getStats()).toMatchObject({ accepted: 1, dropped: 1 })
  })

  it('bounds a hung exporter shutdown with the lifecycle deadline', async () => {
    const sink = new BatchingTraceSink({
      export: async (records) => ({ status: 'success', exported: records.length }),
      shutdown: async () => await new Promise<ExportResult>(() => {}),
    }, sinkOptions())
    await expect(sink.shutdown({ timeoutMs: 5 })).resolves.toMatchObject({ status: 'timeout' })
    await expect(sink.shutdown({ timeoutMs: 100 })).resolves.toMatchObject({ status: 'timeout' })
  })

  it('unrefs its scheduled timer', () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const sink = new BatchingTraceSink(exporter(async (records) => ({ status: 'success', exported: records.length })), sinkOptions())
    sink.emit(start())
    const handle = setTimeoutSpy.mock.results.at(-1)?.value as ReturnType<typeof setTimeout>
    expect(handle.hasRef?.()).toBe(false)
    setTimeoutSpy.mockRestore()
    void sink.shutdown({ timeoutMs: 200 })
  })
})

describe('OBS-2 composition, privacy, diagnostics, and compatibility', () => {
  it('isolates a throwing Composite child and diagnostic handler', async () => {
    const received: TraceRecord[] = []
    const broken: TraceSink = {
      emit: () => { throw new Error('secret') },
      forceFlush: async () => { throw new Error('broken') },
      shutdown: async () => { throw new Error('broken') },
    }
    const healthy: TraceSink = {
      emit: (record) => { received.push(record) },
      forceFlush: async () => okResult(),
      shutdown: async () => okResult(),
      getStats: emptyStats,
    }
    const composite = new CompositeSink([broken, healthy], {
      onDiagnostic: () => { throw new Error('diagnostic failed') },
      diagnosticIntervalMs: 0,
    })
    expect(() => composite.emit(end())).not.toThrow()
    expect(received).toHaveLength(1)
    await expect(composite.forceFlush()).resolves.toMatchObject({ status: 'partial' })
  })

  it('bounds a Composite child that ignores lifecycle timeouts', async () => {
    const hanging: TraceSink = {
      emit() {},
      forceFlush: async () => await new Promise<FlushResult>(() => {}),
      shutdown: async () => await new Promise<FlushResult>(() => {}),
    }
    const composite = new CompositeSink([hanging], { diagnostics: 'silent' })
    await expect(composite.forceFlush({ timeoutMs: 5 })).resolves.toMatchObject({ status: 'timeout' })
    await expect(composite.shutdown({ timeoutMs: 5 })).resolves.toMatchObject({ status: 'timeout' })
  })

  it('filters records and structurally removes sensitive/content/reasoning fields', async () => {
    const received: TraceRecord[] = []
    const target: TraceSink = {
      emit: (record) => { received.push(record) },
      forceFlush: async () => okResult(),
      shutdown: async () => okResult(),
    }
    const processor = new FilteringSink(
      new SensitiveDataProcessor(target),
      (record) => record.recordType === 'span_start',
    )
    processor.emit(start({
      'oma.agent.name': 'safe',
      'request.authorization': 'Bearer secret',
      'oma.prompt': 'private prompt',
      'oma.reasoning.content': 'hidden thought',
      'oma.reasoning.output_tokens': 7,
    }))
    processor.emit(end())
    expect(received).toHaveLength(1)
    expect(received[0]?.attributes).toEqual({
      'oma.agent.name': 'safe',
      'oma.reasoning.output_tokens': 7,
    })
  })

  it('contains legacy callback sync throws and async rejections without unhandled rejection', async () => {
    const sync = new LegacyCallbackTraceSink(() => { throw new Error('sync') }, { diagnostics: 'silent' })
    const runtime = new TraceRuntime(createRunIdentity(), undefined, undefined, sync)
    const span = runtime.startSpan({ kind: 'agent', name: 'invoke_agent', parent: runtime.root })
    const legacy: TraceEvent = {
      type: 'agent', runId: 'legacy', spanId: crypto.randomUUID(), agent: 'worker', turns: 1,
      tokens: { input_tokens: 1, output_tokens: 1 }, toolCalls: 0,
      startMs: 1, endMs: 2, durationMs: 1,
    }
    expect(() => span.end({ status: { code: 'ok' }, legacyEvent: legacy })).not.toThrow()
    await expect(sync.forceFlush()).resolves.toMatchObject({ status: 'error', failed: 1 })

    const rejected = new LegacyCallbackTraceSink(async () => { throw new Error('async') }, { diagnostics: 'silent' })
    const asyncRuntime = new TraceRuntime(createRunIdentity(), undefined, undefined, rejected)
    const asyncSpan = asyncRuntime.startSpan({ kind: 'agent', name: 'invoke_agent', parent: asyncRuntime.root })
    asyncSpan.end({ status: { code: 'ok' }, legacyEvent: legacy })
    await expect(rejected.forceFlush({ timeoutMs: 100 })).resolves.toMatchObject({ status: 'error', failed: 1 })
  })

  it('delivers all seven legacy event shapes unchanged through the bridge', async () => {
    const received: TraceEvent[] = []
    const bridge = new LegacyCallbackTraceSink((legacy) => { received.push(legacy) }, { diagnostics: 'silent' })
    const runtime = new TraceRuntime(createRunIdentity(), undefined, undefined, bridge)
    const baseEvent = {
      runId: 'legacy-run', spanId: crypto.randomUUID(), agent: 'worker', startMs: 1, endMs: 2, durationMs: 1,
    }
    const events: TraceEvent[] = [
      { ...baseEvent, type: 'llm_call', model: 'm', turn: 1, tokens: { input_tokens: 1, output_tokens: 1 } },
      { ...baseEvent, type: 'tool_call', tool: 't', isError: false, input: {}, output: 'ok' },
      { ...baseEvent, type: 'task', taskId: 't', taskTitle: 'T', success: true, retries: 0 },
      { ...baseEvent, type: 'agent', turns: 1, tokens: { input_tokens: 1, output_tokens: 1 }, toolCalls: 0 },
      { ...baseEvent, type: 'plan_ready', taskCount: 1, approved: true },
      { ...baseEvent, type: 'agent_stream', streamType: 'text' },
      { ...baseEvent, type: 'consensus', round: 1, accepted: true },
    ]
    for (const legacy of events) {
      if (legacy.type === 'agent_stream') runtime.root.event('stream_chunk', {}, legacy)
      else {
        const span = runtime.startSpan({ kind: 'agent', name: 'invoke_agent', parent: runtime.root })
        span.end({ status: { code: 'ok' }, legacyEvent: legacy })
      }
    }
    await bridge.forceFlush()
    expect(received).toEqual(events)
  })

  it('keeps sink failures isolated from Agent results through Orchestrator observability', async () => {
    const broken: TraceSink = {
      emit: () => { throw new Error('telemetry failed') },
      forceFlush: async () => { throw new Error('telemetry failed') },
      shutdown: async () => { throw new Error('telemetry failed') },
    }
    const adapter: LLMAdapter = {
      name: 'sink-failure-test',
      async chat() {
        return {
          id: 'ok', content: [{ type: 'text', text: 'business result' }], model: 'test',
          stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
        }
      },
      async *stream() {},
    }
    const oma = new OpenMultiAgent({
      defaultModel: 'test',
      observability: { sinks: [broken], onDiagnostic: () => {} },
    })
    const result = await oma.runAgent({ name: 'worker', model: 'test', adapter }, 'private prompt')
    expect(result).toMatchObject({ success: true, output: 'business result', status: { code: 'ok' } })
  })
})
