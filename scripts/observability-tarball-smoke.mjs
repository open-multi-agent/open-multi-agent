import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const temporaryRoot = await mkdtemp(join(tmpdir(), 'oma-observability-pack-'))
const cache = join(temporaryRoot, 'npm-cache')

async function command(file, args, cwd = root) {
  const { stdout, stderr } = await exec(file, args, {
    cwd,
    env: { ...process.env, npm_config_cache: cache },
    maxBuffer: 20 * 1024 * 1024,
  })
  if (stderr.trim()) process.stderr.write(stderr)
  return stdout
}

async function pack(workspaceDirectory) {
  const stdout = await command('npm', [
    'pack', '--json', '--pack-destination', temporaryRoot,
  ], join(root, workspaceDirectory))
  const result = JSON.parse(stdout)[0]
  if (!result?.filename || !Array.isArray(result.files)) throw new Error(`Invalid npm pack result for ${workspaceDirectory}`)
  const paths = result.files.map((entry) => entry.path)
  const unexpected = paths.filter((path) =>
    !path.startsWith('dist/') && !['README.md', 'LICENSE', 'package.json'].includes(path))
  if (unexpected.length > 0) throw new Error(`Unexpected tarball files: ${unexpected.join(', ')}`)
  return { tarball: join(temporaryRoot, result.filename), paths }
}

function assertExportsInstalled(packageRoot, manifest) {
  const targets = []
  for (const value of Object.values(manifest.exports ?? {})) {
    if (typeof value === 'string') targets.push(value)
    else if (value && typeof value === 'object') targets.push(...Object.values(value))
  }
  return Promise.all(targets
    .filter((target) => typeof target === 'string' && target.startsWith('./'))
    .map(async (target) => {
      await readFile(resolve(packageRoot, target), 'utf8')
    }))
}

async function installConsumer(name, tarballs, extra = []) {
  const directory = join(temporaryRoot, name)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name, private: true, type: 'module' }))
  await command('npm', [
    'install', '--ignore-scripts', '--no-audit', '--no-fund',
    ...tarballs, ...extra,
  ], directory)
  return directory
}

async function runFixture(directory, source) {
  const fixture = join(directory, 'smoke.mjs')
  await writeFile(fixture, source)
  await command(process.execPath, [fixture], directory)
}

async function staticImportGraph(entry) {
  const visited = new Set()
  const specifiers = new Set()
  async function visit(file) {
    if (visited.has(file)) return
    visited.add(file)
    const source = (await readFile(file, 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    const pattern = /\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1]
      specifiers.add(specifier)
      if (specifier.startsWith('.')) await visit(resolve(dirname(file), specifier))
    }
  }
  await visit(entry)
  return { specifiers, visited }
}

try {
  const core = await pack('packages/core')
  const otel = await pack('packages/otel')

  const coreOnly = await installConsumer('core-only', [core.tarball])
  await runFixture(coreOnly, `
    import { mkdtemp, rm } from 'node:fs/promises'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    import * as coreRoot from '@open-multi-agent/core'
    import { OpenMultiAgent } from '@open-multi-agent/core'
    import { defineEvalSet, toolCallSuccessScorer } from '@open-multi-agent/core/eval'
    import { FileEvalStore } from '@open-multi-agent/core/eval/file'
    import { InMemoryTraceStore } from '@open-multi-agent/core/observability'
    import { FileTraceStore } from '@open-multi-agent/core/observability/file'
    if (typeof OpenMultiAgent !== 'function') throw new Error('core root import failed')
    if (typeof defineEvalSet !== 'function' || typeof toolCallSuccessScorer !== 'function') {
      throw new Error('eval import failed')
    }
    if ('defineEvalSet' in coreRoot) throw new Error('core root unexpectedly re-exported eval')
    defineEvalSet({ name: 'pack', version: '1', cases: [{ id: 'case', input: 'x' }] })
    const score = await toolCallSuccessScorer().score({
      evalCase: { id: 'case', input: 'x' }, output: 'x', metadata: {},
      signal: new AbortController().signal,
    })
    if (score.score !== 1) throw new Error('reference scorer failed')
    const records = [{
      schemaVersion: 2, recordId: 'start', sequence: 1, timestampUnixMs: 1,
      runId: 'pack-core-only', attempt: 1, traceId: '1'.repeat(32), spanId: '2'.repeat(16),
      recordType: 'span_start', kind: 'run', name: 'oma.run', startUnixMs: 1, attributes: {},
    }, {
      schemaVersion: 2, recordId: 'end', sequence: 2, timestampUnixMs: 2,
      runId: 'pack-core-only', attempt: 1, traceId: '1'.repeat(32), spanId: '2'.repeat(16),
      recordType: 'span_end', kind: 'run', name: 'oma.run', startUnixMs: 1,
      endUnixMs: 2, durationMs: 1, status: { code: 'ok' }, attributes: {},
    }]
    const memory = new InMemoryTraceStore()
    await memory.append(records)
    if ((await memory.getRun('pack-core-only'))?.status !== 'ok') throw new Error('memory store failed')
    const directory = await mkdtemp(join(tmpdir(), 'oma-core-only-'))
    const file = await FileTraceStore.open(join(directory, 'traces.ndjson'))
    await file.append(records); await file.flush(); await file.close()
    const evalFile = await FileEvalStore.open(join(directory, 'evals.ndjson'))
    await evalFile.flush(); await evalFile.close()
    await rm(directory, { recursive: true, force: true })
  `)
  const coreManifest = JSON.parse(await readFile(join(coreOnly, 'node_modules/@open-multi-agent/core/package.json'), 'utf8'))
  const installedCore = join(coreOnly, 'node_modules/@open-multi-agent/core')
  await assertExportsInstalled(installedCore, coreManifest)
  for (const entry of ['dist/index.js', 'dist/observability/index.js', 'dist/eval/index.js']) {
    const graph = await staticImportGraph(join(installedCore, entry))
    if ([...graph.specifiers].some((specifier) => specifier.startsWith('@opentelemetry/'))) {
      throw new Error(`${entry} eagerly reaches OpenTelemetry`)
    }
    if ([...graph.visited].some((file) => file.endsWith('/dist/observability/file-store.js'))) {
      throw new Error(`${entry} eagerly reaches FileTraceStore`)
    }
    if ([...graph.visited].some((file) => file.endsWith('/dist/eval/file-store.js'))) {
      throw new Error(`${entry} eagerly reaches FileEvalStore`)
    }
    if ((entry === 'dist/observability/index.js' || entry === 'dist/eval/index.js')
      && [...graph.specifiers].some((specifier) => specifier === 'node:fs' || specifier.startsWith('node:fs/'))) {
      throw new Error(`${entry} eagerly reaches node:fs`)
    }
  }
  const fileGraph = await staticImportGraph(join(installedCore, 'dist/observability/file.js'))
  if (![...fileGraph.specifiers].some((specifier) => specifier === 'node:fs' || specifier.startsWith('node:fs/'))) {
    throw new Error('observability/file did not reach its Node-only implementation')
  }
  const evalFileGraph = await staticImportGraph(join(installedCore, 'dist/eval/file.js'))
  if (![...evalFileGraph.specifiers].some((specifier) => specifier === 'node:fs' || specifier.startsWith('node:fs/'))) {
    throw new Error('eval/file did not reach its Node-only implementation')
  }
  await readdir(join(coreOnly, 'node_modules/@open-multi-agent')).then((names) => {
    if (names.includes('otel')) throw new Error('core-only consumer unexpectedly installed OTel')
  })

  const combined = await installConsumer('core-otel', [core.tarball, otel.tarball], [
    '@opentelemetry/api@1.9.0',
    '@opentelemetry/sdk-trace-base@2.9.0',
  ])
  await runFixture(combined, `
    import { SpanStatusCode } from '@opentelemetry/api'
    import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
    import { createOtelTraceSink } from '@open-multi-agent/otel'
    const exporter = new InMemorySpanExporter()
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
    const sink = createOtelTraceSink({ tracerProvider: provider })
    const traceId = 'a'.repeat(32), rootId = '1'.repeat(16), firstId = '2'.repeat(16), secondId = '3'.repeat(16)
    let sequence = 0
    const base = (recordId, spanId) => ({ schemaVersion: 2, recordId, sequence: ++sequence,
      timestampUnixMs: sequence, runId: 'pack-otel', attempt: 1, traceId, spanId })
    const start = (id, name, parentSpanId, links) => ({ ...base('start-' + id, id), recordType: 'span_start',
      kind: id === rootId ? 'run' : 'task', name, startUnixMs: sequence,
      ...(parentSpanId ? { parentSpanId } : {}), ...(links ? { links } : {}), attributes: {} })
    const end = (id, name, parentSpanId, status, links) => ({ ...base('end-' + id, id), recordType: 'span_end',
      kind: id === rootId ? 'run' : 'task', name, startUnixMs: 1, endUnixMs: sequence,
      durationMs: sequence - 1, status, ...(parentSpanId ? { parentSpanId } : {}),
      ...(links ? { links } : {}), attributes: {} })
    const link = { traceId, spanId: firstId, relation: 'depends_on' }
    for (const record of [
      start(rootId, 'oma.run'), start(firstId, 'first', rootId), end(firstId, 'first', rootId, { code: 'ok' }),
      start(secondId, 'second', rootId, [link]), end(secondId, 'second', rootId, { code: 'error' }, [link]),
      end(rootId, 'oma.run', undefined, { code: 'error' }),
    ]) sink.emit(record)
    const flushed = await sink.forceFlush({ timeoutMs: 2000 })
    if (flushed.status !== 'ok') throw new Error('OTel flush failed: ' + flushed.status)
    const spans = exporter.getFinishedSpans(), first = spans.find((span) => span.name === 'first')
    const second = spans.find((span) => span.name === 'second')
    if (!first || !second || second.links[0]?.context.spanId !== first.spanContext().spanId) throw new Error('link mapping failed')
    if (second.status.code !== SpanStatusCode.ERROR || second.attributes['oma.status'] !== 'error') throw new Error('status mapping failed')
    await sink.shutdown({ timeoutMs: 2000 }); await provider.shutdown()
  `)
  const otelManifest = JSON.parse(await readFile(join(combined, 'node_modules/@open-multi-agent/otel/package.json'), 'utf8'))
  await assertExportsInstalled(join(combined, 'node_modules/@open-multi-agent/otel'), otelManifest)

  const minimumTarball = process.env.OMA_OBSERVABILITY_MIN_CORE_TARBALL ?? core.tarball
  const minimum = await installConsumer('minimum-core', [minimumTarball, otel.tarball], [
    '@opentelemetry/api@1.9.0',
  ])
  await runFixture(minimum, `
    import * as core from '@open-multi-agent/core/observability'
    import { createOtelTraceSink } from '@open-multi-agent/otel'
    for (const name of ['BatchingTraceSink', 'InMemoryTraceStore', 'TraceStoreExporter']) {
      if (typeof core[name] !== 'function') throw new Error('minimum core misses ' + name)
    }
    if (typeof createOtelTraceSink !== 'function') throw new Error('OTel entry missing')
    const coreManifest = JSON.parse(await (await import('node:fs/promises')).readFile(
      new URL('./node_modules/@open-multi-agent/core/package.json', import.meta.url), 'utf8'))
    const otelManifest = JSON.parse(await (await import('node:fs/promises')).readFile(
      new URL('./node_modules/@open-multi-agent/otel/package.json', import.meta.url), 'utf8'))
    if (coreManifest.version !== '1.11.0') throw new Error('minimum core must be 1.11.0')
    if (otelManifest.dependencies['@open-multi-agent/core'] !== '^1.11.0') throw new Error('incorrect OTel core range')
  `)

  console.log(JSON.stringify({
    coreTarball: core.tarball,
    otelTarball: otel.tarball,
    scenarios: ['core-only', 'core+otel', 'minimum-core'],
  }, null, 2))
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
