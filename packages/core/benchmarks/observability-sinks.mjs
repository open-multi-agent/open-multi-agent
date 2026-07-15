import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

const [candidatePath] = process.argv.slice(2)
if (!candidatePath) {
  throw new Error('Usage: node observability-sinks.mjs <candidate-index.js>')
}

const iterations = Number(process.env.OMA_BENCH_ITERATIONS ?? 2_000)
const rounds = Number(process.env.OMA_BENCH_ROUNDS ?? 9)
const core = await import(`${pathToFileURL(candidatePath).href}?obs2-benchmark`)

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
emitMicros.sort((a, b) => a - b)
const emitP95Micros = emitMicros[Math.floor(emitMicros.length * 0.95)]
await emitSink.shutdown({ timeoutMs: 5_000 })

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
  samplesMs: samples,
  representative100AgentEnvelope: {
    records: representativeRecords.length,
    bytes: representativeBytes,
    fractionOfDefaultQueueBytes: representativeBytes / core.DEFAULT_BATCHING_OPTIONS.maxQueueBytes,
  },
  defaults: core.DEFAULT_BATCHING_OPTIONS,
}, null, 2))

await batchSink.shutdown({ timeoutMs: 5_000 })
