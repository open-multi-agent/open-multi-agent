import { fileURLToPath, pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { cpus } from 'node:os'
import { dirname, resolve } from 'node:path'

const [candidatePath, otelCandidatePath] = process.argv.slice(2)
if (!candidatePath) {
  throw new Error('Usage: node observability-sinks.mjs <candidate-index.js> [otel-index.js]')
}

const iterations = Number(process.env.OMA_BENCH_ITERATIONS ?? 2_000)
const rounds = Number(process.env.OMA_BENCH_ROUNDS ?? 9)
const core = await import(`${pathToFileURL(candidatePath).href}?obs2-benchmark`)
const traceUtils = await import(`${pathToFileURL(resolve(dirname(candidatePath), 'utils/trace.js')).href}?legacy-benchmark`)

const adapter = {
  name: 'obs2-benchmark',
  async chat() {
    return {
      id: 'benchmark-response',
      content: [{ type: 'text', text: 'ok' }],
      model: 'benchmark-model',
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }
  },
  async *stream() {},
}
const agent = { name: 'benchmark', model: 'benchmark-model', adapter }

function makeBatchSink(options = {}) {
  return new core.BatchingTraceSink({
    async export(records) { return { status: 'success', exported: records.length } },
  }, { diagnostics: 'silent', ...options })
}

const batchSink = makeBatchSink()
const runners = {
  noSink: new core.OpenMultiAgent({ defaultModel: 'benchmark-model' }),
  syncCallback: new core.OpenMultiAgent({ defaultModel: 'benchmark-model', onTrace() {} }),
  batchSink: new core.OpenMultiAgent({
    defaultModel: 'benchmark-model',
    observability: { sinks: [batchSink] },
  }),
}

async function measure(oma, count) {
  const start = performance.now()
  for (let index = 0; index < count; index++) await oma.runAgent(agent, 'ping')
  return performance.now() - start
}

for (const oma of Object.values(runners)) await measure(oma, 200)
await batchSink.forceFlush({ timeoutMs: 5_000 })

const samples = { noSink: [], syncCallback: [], batchSink: [] }
const names = Object.keys(runners)
for (let round = 0; round < rounds; round++) {
  const order = round % 2 === 0 ? names : [...names].reverse()
  for (const name of order) samples[name].push(await measure(runners[name], iterations))
  await batchSink.forceFlush({ timeoutMs: 5_000 })
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.floor(values.length * fraction)]
const medians = Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, median(values)]))

const sampleRecord = {
  schemaVersion: 2,
  recordId: '00000000-0000-4000-8000-000000000000',
  sequence: 1,
  timestampUnixMs: Date.now(),
  runId: 'benchmark-run',
  attempt: 1,
  traceId: '1'.repeat(32),
  spanId: '2'.repeat(16),
  recordType: 'span_end',
  kind: 'agent',
  name: 'invoke_agent',
  startUnixMs: Date.now(),
  endUnixMs: Date.now(),
  durationMs: 1,
  status: { code: 'ok' },
  attributes: {
    'oma.agent.name': 'benchmark-agent',
    'oma.usage.input_tokens': 100,
    'oma.usage.output_tokens': 20,
    'oma.status': 'ok',
  },
}
const representativeRecords = Array.from({ length: 402 }, (_, index) => ({
  ...sampleRecord,
  recordId: `${index}`.padStart(36, '0'),
  sequence: index + 1,
}))
const representativeBytes = representativeRecords.reduce(
  (sum, record) => sum + Buffer.byteLength(JSON.stringify(record), 'utf8'),
  0,
)

const emitIterations = 10_000
const emitSink = makeBatchSink({
  maxQueueRecords: emitIterations + 1,
  maxQueueBytes: 64 * 1024 * 1024,
  maxBatchRecords: emitIterations + 1,
  scheduledDelayMs: 60_000,
})
const emitMicros = []
for (let index = 0; index < emitIterations; index++) {
  const started = performance.now()
  emitSink.emit({ ...sampleRecord, sequence: index + 1 })
  emitMicros.push((performance.now() - started) * 1_000)
}
const emitP95Micros = percentile(emitMicros, 0.95)
await emitSink.shutdown({ timeoutMs: 5_000 })

const legacyEvent = {
  type: 'agent', runId: 'legacy-benchmark', spanId: '00000000-0000-4000-8000-000000000001',
  agent: 'benchmark', turns: 1, tokens: { input_tokens: 1, output_tokens: 1 }, toolCalls: 0,
  startMs: 1, endMs: 2, durationMs: 1,
}
const legacyDispatchMicros = []
for (let index = 0; index < emitIterations; index++) {
  const started = performance.now()
  traceUtils.emitTrace(() => {}, legacyEvent)
  legacyDispatchMicros.push((performance.now() - started) * 1_000)
}

function storeRecords(count, prefix) {
  return Array.from({ length: count }, (_, index) => {
    const runIndex = Math.floor(index / 2)
    const isEnd = index % 2 === 1
    const traceId = (runIndex + 1).toString(16).padStart(32, '0')
    const spanId = (runIndex + 1).toString(16).padStart(16, '0')
    const startUnixMs = 1_700_000_000_000 + runIndex
    return {
      schemaVersion: 2,
      recordId: `${prefix}-${index}`,
      sequence: isEnd ? 2 : 1,
      timestampUnixMs: startUnixMs + (isEnd ? 1 : 0),
      runId: `${prefix}-run-${runIndex}`,
      attempt: 1,
      traceId,
      spanId,
      recordType: isEnd ? 'span_end' : 'span_start',
      kind: 'run',
      name: 'oma.run',
      startUnixMs,
      ...(isEnd ? {
        endUnixMs: startUnixMs + 1,
        durationMs: 1,
        status: { code: 'ok' },
      } : {}),
      attributes: {},
    }
  })
}

const inMemoryStore = []
for (const count of [1_000, 10_000]) {
  global.gc?.()
  const store = new core.InMemoryTraceStore()
  const records = storeRecords(count, `memory-${count}`)
  const heapBefore = process.memoryUsage().heapUsed
  const appendStarted = performance.now()
  await store.append(records)
  const appendMs = performance.now() - appendStarted
  global.gc?.()
  const heapAfter = process.memoryUsage().heapUsed
  const queryStarted = performance.now()
  const page = await store.queryRuns({ limit: 500 })
  inMemoryStore.push({
    records: count,
    appendMs,
    firstPageQueryMs: performance.now() - queryStarted,
    firstPageRuns: page.items.length,
    estimatedHeapBytes: Math.max(0, heapAfter - heapBefore),
  })
}

function workloadRecords(agentCount) {
  const traceId = 'a'.repeat(32)
  const records = []
  let localSequence = 0
  const rootId = '1'.repeat(16)
  records.push({ ...sampleRecord, recordId: `workload-root-start-${agentCount}`,
    sequence: ++localSequence, traceId, spanId: rootId, recordType: 'span_start', kind: 'run' })
  for (let index = 0; index < agentCount; index++) {
    const spanId = (index + 2).toString(16).padStart(16, '0')
    records.push({ ...sampleRecord, recordId: `workload-agent-start-${agentCount}-${index}`,
      sequence: ++localSequence, traceId, spanId, parentSpanId: rootId, recordType: 'span_start' })
    records.push({ ...sampleRecord, recordId: `workload-agent-end-${agentCount}-${index}`,
      sequence: ++localSequence, traceId, spanId, parentSpanId: rootId })
  }
  records.push({ ...sampleRecord, recordId: `workload-root-end-${agentCount}`,
    sequence: ++localSequence, traceId, spanId: rootId, kind: 'run' })
  return records
}

async function measureEnqueue(records) {
  const repeats = Math.max(1, Math.ceil(1_000 / records.length))
  const measurementRecords = Array.from({ length: repeats }, (_, repeat) =>
    records.map((record, index) => ({ ...record, recordId: `${record.recordId}-sample-${repeat}-${index}` }))).flat()
  const sink = makeBatchSink({
    maxQueueRecords: measurementRecords.length + 1,
    maxQueueBytes: 64 * 1024 * 1024,
    maxBatchRecords: measurementRecords.length + 1,
    scheduledDelayMs: 60_000,
  })
  const micros = []
  for (const record of measurementRecords) {
    const started = performance.now()
    sink.emit(record)
    micros.push((performance.now() - started) * 1_000)
  }
  const stats = sink.getStats()
  await sink.shutdown({ timeoutMs: 5_000 })
  return {
    records: records.length,
    measurementSamples: measurementRecords.length,
    bytes: records.reduce((sum, record) => sum + Buffer.byteLength(JSON.stringify(record)), 0),
    enqueueP95Micros: percentile(micros, 0.95),
    queuedBytes: stats.queuedBytes,
  }
}

const equivalentAgentWorkloads = []
for (const agents of [1, 10, 100]) {
  equivalentAgentWorkloads.push({ agents, ...(await measureEnqueue(workloadRecords(agents))) })
}

const streamingMetadata = Array.from({ length: 10_000 }, (_, index) => ({
  ...sampleRecord,
  recordId: `stream-${index}`,
  sequence: index + 1,
  recordType: 'span_event',
  name: 'stream_chunk',
  attributes: { 'oma.stream.type': 'text', 'oma.stream.index': index },
}))
const streamingMetadataResult = await measureEnqueue(streamingMetadata)

const pressureByCount = makeBatchSink({
  maxQueueRecords: 100,
  maxQueueBytes: 64 * 1024 * 1024,
  scheduledDelayMs: 60_000,
})
for (const record of streamingMetadata.slice(0, 1_000)) pressureByCount.emit(record)
const queuePressureRecords = pressureByCount.getStats()
await pressureByCount.shutdown({ timeoutMs: 5_000 })

const sampleBytes = Buffer.byteLength(JSON.stringify(sampleRecord))
const pressureByBytes = makeBatchSink({
  maxQueueRecords: 1_000,
  maxQueueBytes: sampleBytes * 4,
  maxRecordBytes: sampleBytes * 2,
  scheduledDelayMs: 60_000,
})
for (let index = 0; index < 100; index++) pressureByBytes.emit({ ...sampleRecord, recordId: `bytes-${index}` })
const queuePressureBytes = pressureByBytes.getStats()
await pressureByBytes.shutdown({ timeoutMs: 5_000 })

const resolvedOtelPath = otelCandidatePath
  ?? fileURLToPath(new URL('../../otel/dist/index.js', import.meta.url))
const otel = await import(`${pathToFileURL(resolvedOtelPath).href}?otel-benchmark`)
const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } =
  await import('@opentelemetry/sdk-trace-base')

function otelRecord(index, prefix) {
  return {
    ...sampleRecord,
    recordId: `${prefix}-${index}`,
    runId: `${prefix}-${index}`,
    traceId: (index + 1).toString(16).padStart(32, '0'),
    spanId: (index + 1).toString(16).padStart(16, '0'),
    sequence: 1,
    kind: 'run',
    name: 'oma.run',
  }
}

const otelExporter = new InMemorySpanExporter()
const otelProvider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(otelExporter)],
})
const otelAdapter = otel.createOtelTraceExporter({ tracerProvider: otelProvider })
const otelMicros = []
for (let index = 0; index < 200; index++) {
  await otelAdapter.export([otelRecord(index, 'otel-warmup')], new AbortController().signal)
}
otelExporter.reset()
for (let index = 0; index < 1_000; index++) {
  const started = performance.now()
  await otelAdapter.export([otelRecord(index + 10_000, 'otel-p95')], new AbortController().signal)
  otelMicros.push((performance.now() - started) * 1_000)
}
await otelAdapter.forceFlush(new AbortController().signal)
await otelAdapter.shutdown(new AbortController().signal)
await otelProvider.shutdown()

const otelScales = []
for (const count of [1_000, 10_000]) {
  const exporter = new InMemorySpanExporter()
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  const adapter = otel.createOtelTraceExporter({ tracerProvider: provider })
  const records = Array.from({ length: count }, (_, index) => otelRecord(index, `otel-${count}`))
  const started = performance.now()
  const result = await adapter.export(records, new AbortController().signal)
  await adapter.forceFlush(new AbortController().signal)
  otelScales.push({ records: count, totalMs: performance.now() - started, exported: result.exported })
  await adapter.shutdown(new AbortController().signal)
  await provider.shutdown()
}

console.log(JSON.stringify({
  iterations,
  rounds,
  mediansMs: medians,
  overheadVsNoSinkPercent: {
    syncCallback: ((medians.syncCallback / medians.noSink) - 1) * 100,
    batchSink: ((medians.batchSink / medians.noSink) - 1) * 100,
  },
  medianMicrosPerRun: Object.fromEntries(
    Object.entries(medians).map(([name, value]) => [name, value * 1_000 / iterations]),
  ),
  batchEmitP95Micros: emitP95Micros,
  legacyDispatchP95Micros: percentile(legacyDispatchMicros, 0.95),
  otelConvertAndProcessP95Micros: percentile(otelMicros, 0.95),
  inMemoryStore,
  equivalentAgentWorkloads,
  streamingMetadata: streamingMetadataResult,
  queuePressure: {
    records: queuePressureRecords,
    bytes: queuePressureBytes,
  },
  otelScales,
  contentCapture: {
    status: 'non-goal',
    reason: 'This release exposes no content-on mode; metadata-only is the only product baseline.',
  },
  environment: {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cpu: cpus()[0]?.model ?? 'unknown',
  },
  samplesMs: samples,
  representative100AgentEnvelope: {
    records: representativeRecords.length,
    bytes: representativeBytes,
    fractionOfDefaultQueueBytes: representativeBytes / core.DEFAULT_BATCHING_OPTIONS.maxQueueBytes,
  },
  defaults: core.DEFAULT_BATCHING_OPTIONS,
}, null, 2))

await batchSink.shutdown({ timeoutMs: 5_000 })
