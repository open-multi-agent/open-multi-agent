import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const benchmark = join(root, 'packages/core/benchmarks/observability-sinks.mjs')
const core = join(root, 'packages/core/dist/index.js')
const otel = join(root, 'packages/otel/dist/index.js')
const { stdout } = await exec(process.execPath, ['--expose-gc', benchmark, core, otel], {
  cwd: root,
  env: {
    ...process.env,
    OMA_BENCH_ITERATIONS: process.env.OMA_BENCH_ITERATIONS ?? '500',
    OMA_BENCH_ROUNDS: process.env.OMA_BENCH_ROUNDS ?? '5',
  },
  maxBuffer: 20 * 1024 * 1024,
})
const result = JSON.parse(stdout)
const failures = []

// CI deliberately uses 10x the dedicated RFC microsecond budgets. This catches
// order-of-magnitude regressions without turning shared-runner jitter into a
// release blocker. Dedicated benchmark snapshots use the strict budgets.
if (result.legacyDispatchP95Micros >= 100) failures.push('legacy dispatch p95 >= 100 us')
if (result.batchEmitP95Micros >= 200) failures.push('batch emit p95 >= 200 us')
if (result.otelConvertAndProcessP95Micros >= 500) failures.push('OTel conversion p95 >= 500 us')
for (const [name, value] of Object.entries(result.overheadVsNoSinkPercent)) {
  if (value >= 1_000) failures.push(`${name} whole-run overhead >= 1000% vs no sink`)
}
if (failures.length > 0) throw new Error(`Observability benchmark CI gate failed:\n- ${failures.join('\n- ')}`)
console.log(JSON.stringify({
  gate: 'pass',
  policy: '10x microsecond budgets and <1000% same-host overhead vs no sink',
  legacyDispatchP95Micros: result.legacyDispatchP95Micros,
  batchEmitP95Micros: result.batchEmitP95Micros,
  otelConvertAndProcessP95Micros: result.otelConvertAndProcessP95Micros,
  overheadVsNoSinkPercent: result.overheadVsNoSinkPercent,
}, null, 2))
