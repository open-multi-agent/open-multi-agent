import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

const [candidatePath] = process.argv.slice(2)
const moduleUrl = candidatePath
  ? pathToFileURL(candidatePath).href
  : new URL('../dist/observability/file.js', import.meta.url).href
const { FileTraceStore } = await import(`${moduleUrl}?file-trace-store-benchmark`)

function records(count, prefix) {
  return Array.from({ length: count }, (_, index) => {
    const runIndex = Math.floor(index / 2)
    const isEnd = index % 2 === 1
    const start = 1_700_000_000_000 + runIndex
    return {
      schemaVersion: 2,
      recordId: `${prefix}-record-${index}`,
      sequence: isEnd ? 2 : 1,
      timestampUnixMs: start + (isEnd ? 1 : 0),
      runId: `${prefix}-run-${String(runIndex).padStart(6, '0')}`,
      attempt: 1,
      traceId: `${prefix}-trace-${runIndex}`,
      spanId: `${prefix}-span-${runIndex}`,
      recordType: isEnd ? 'span_end' : 'span_start',
      kind: 'run',
      name: 'oma.run',
      startUnixMs: start,
      ...(isEnd ? {
        endUnixMs: start + 1,
        durationMs: 1,
        status: { code: 'ok' },
      } : {}),
      attributes: {},
    }
  })
}

async function queryAll(store) {
  let cursor
  let count = 0
  do {
    const page = await store.queryRuns({ limit: 500, order: 'started_asc', ...(cursor ? { cursor } : {}) })
    count += page.items.length
    cursor = page.nextCursor
  } while (cursor)
  return count
}

async function measureScale(root, count) {
  global.gc?.()
  const heapBefore = process.memoryUsage().heapUsed
  const path = join(root, `scale-${count}.ndjson`)
  const payload = records(count, `scale-${count}`)
  const store = await FileTraceStore.open(path)
  const appendStarted = performance.now()
  await store.append(payload)
  const appendMs = performance.now() - appendStarted
  const flushStarted = performance.now()
  await store.flush()
  const flushMs = performance.now() - flushStarted
  global.gc?.()
  const heapAfterIndex = process.memoryUsage().heapUsed
  await store.close()

  const reopenStarted = performance.now()
  const reopened = await FileTraceStore.open(path)
  const reopenMs = performance.now() - reopenStarted
  const queryStarted = performance.now()
  const runs = await queryAll(reopened)
  const queryMs = performance.now() - queryStarted
  const beforeCompactionBytes = (await stat(path)).size
  const compactionStarted = performance.now()
  const compaction = await reopened.compact()
  const compactionMs = performance.now() - compactionStarted
  await reopened.close()

  return {
    records: count,
    runs,
    appendMs,
    flushMs,
    reopenMs,
    queryMs,
    compactionMs,
    estimatedIndexHeapBytes: Math.max(0, heapAfterIndex - heapBefore),
    bytesBeforeCompaction: beforeCompactionBytes,
    bytesAfterCompaction: compaction.fileSizeBytes,
  }
}

async function measureBatchSize(root, batchSize, count = 1_000) {
  const path = join(root, `batch-${batchSize}.ndjson`)
  const payload = records(count, `batch-${batchSize}`)
  const store = await FileTraceStore.open(path)
  const started = performance.now()
  for (let index = 0; index < payload.length; index += batchSize) {
    await store.append(payload.slice(index, index + batchSize))
  }
  const appendMs = performance.now() - started
  await store.flush()
  await store.close()
  return { batchSize, appendMs, fileSizeBytes: (await stat(path)).size }
}

const root = await mkdtemp(join(tmpdir(), 'oma-file-trace-benchmark-'))
try {
  const scales = []
  for (const count of [1_000, 10_000]) scales.push(await measureScale(root, count))
  const batchSizes = []
  for (const size of [1, 10, 100, 1_000]) batchSizes.push(await measureBatchSize(root, size))
  console.log(JSON.stringify({
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    durability: 'append=write-complete; flush/close=fsync',
    scales,
    batchSizes,
  }, null, 2))
} finally {
  await rm(root, { recursive: true, force: true })
}
