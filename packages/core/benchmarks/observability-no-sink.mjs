import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

const [baselinePath, candidatePath] = process.argv.slice(2)
if (!baselinePath || !candidatePath) {
  throw new Error('Usage: node observability-no-sink.mjs <baseline-index.js> <candidate-index.js>')
}

const iterations = Number(process.env.OMA_BENCH_ITERATIONS ?? 2_000)
const rounds = Number(process.env.OMA_BENCH_ROUNDS ?? 9)

async function load(indexPath, label) {
  const { OpenMultiAgent } = await import(`${pathToFileURL(indexPath).href}?label=${label}`)
  const adapter = {
    name: `benchmark-${label}`,
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
  const oma = new OpenMultiAgent({ defaultModel: 'benchmark-model' })
  const agent = { name: 'benchmark', model: 'benchmark-model', adapter }
  const run = async (count) => {
    const start = performance.now()
    for (let index = 0; index < count; index++) {
      await oma.runAgent(agent, 'ping')
    }
    return performance.now() - start
  }
  run.retainedBytesPerRun = async (count) => {
    if (!global.gc) return null
    global.gc()
    const before = process.memoryUsage().heapUsed
    const held = []
    for (let index = 0; index < count; index++) held.push(await oma.runAgent(agent, 'ping'))
    global.gc()
    const bytes = Math.max(0, process.memoryUsage().heapUsed - before) / count
    held.length = 0
    global.gc()
    return bytes
  }
  return run
}

const baseline = await load(baselinePath, 'baseline')
const candidate = await load(candidatePath, 'candidate')
await baseline(200)
await candidate(200)

const baselineMs = []
const candidateMs = []
for (let round = 0; round < rounds; round++) {
  if (round % 2 === 0) {
    baselineMs.push(await baseline(iterations))
    candidateMs.push(await candidate(iterations))
  } else {
    candidateMs.push(await candidate(iterations))
    baselineMs.push(await baseline(iterations))
  }
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const baselineMedianMs = median(baselineMs)
const candidateMedianMs = median(candidateMs)
const regressionPercent = ((candidateMedianMs / baselineMedianMs) - 1) * 100
const retainedIterations = Number(process.env.OMA_BENCH_MEMORY_ITERATIONS ?? 2_000)
const retainedRounds = Number(process.env.OMA_BENCH_MEMORY_ROUNDS ?? 3)
const baselineRetained = []
const candidateRetained = []
for (let round = 0; round < retainedRounds; round++) {
  if (round % 2 === 0) {
    baselineRetained.push(await baseline.retainedBytesPerRun(retainedIterations))
    candidateRetained.push(await candidate.retainedBytesPerRun(retainedIterations))
  } else {
    candidateRetained.push(await candidate.retainedBytesPerRun(retainedIterations))
    baselineRetained.push(await baseline.retainedBytesPerRun(retainedIterations))
  }
}
const validMedian = (values) => values.some((value) => value === null)
  ? null
  : median(values)
const baselineRetainedBytesPerRun = validMedian(baselineRetained)
const candidateRetainedBytesPerRun = validMedian(candidateRetained)

console.log(JSON.stringify({
  iterations,
  rounds,
  baselineMedianMs,
  candidateMedianMs,
  regressionPercent,
  retainedMemory: {
    iterations: retainedIterations,
    rounds: retainedRounds,
    baselineBytesPerRun: baselineRetainedBytesPerRun,
    candidateBytesPerRun: candidateRetainedBytesPerRun,
    additionalBytesPerRun: baselineRetainedBytesPerRun === null || candidateRetainedBytesPerRun === null
      ? null
      : candidateRetainedBytesPerRun - baselineRetainedBytesPerRun,
    note: global.gc ? 'Retained result arrays; median of alternating same-process rounds.' : 'Run with --expose-gc.',
  },
  baselineSamplesMs: baselineMs,
  candidateSamplesMs: candidateMs,
}, null, 2))
