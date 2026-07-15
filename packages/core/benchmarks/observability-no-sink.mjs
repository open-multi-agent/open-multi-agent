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
  return async (count) => {
    const start = performance.now()
    for (let index = 0; index < count; index++) {
      await oma.runAgent(agent, 'ping')
    }
    return performance.now() - start
  }
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

console.log(JSON.stringify({
  iterations,
  rounds,
  baselineMedianMs,
  candidateMedianMs,
  regressionPercent,
  baselineSamplesMs: baselineMs,
  candidateSamplesMs: candidateMs,
}, null, 2))

