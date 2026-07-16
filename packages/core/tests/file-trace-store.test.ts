import {
  appendFile,
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FILE_TRACE_STORE_FORMAT,
  FILE_TRACE_STORE_IO,
  FileTraceStore,
  FileTraceStoreError,
  type FileTraceStoreDiagnostic,
} from '../src/observability/file-store.js'
import type { TraceRecord } from '../src/observability/records.js'
import type {
  AppendResult,
  DeleteResult,
  GetRunOptions,
  Page,
  RetentionPolicy,
  RunSummary,
  StoredRun,
  TraceDeleteQuery,
  TraceQuery,
  TraceStore,
} from '../src/observability/store.js'
import { TraceStoreError } from '../src/observability/store.js'
import {
  attemptRecords,
  runTraceStoreContractSuite,
  type TraceStoreContractFactoryOptions,
} from './helpers/trace-store-contract.js'

const temporaryRoots: string[] = []

async function temporaryPath(name = 'traces.ndjson'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'oma-file-trace-store-'))
  temporaryRoots.push(root)
  return join(root, name)
}

class DeferredTraceStore implements TraceStore {
  constructor(private readonly pending: Promise<FileTraceStore>) {}
  append(records: readonly TraceRecord[]): Promise<AppendResult> {
    return this.pending.then((store) => store.append(records))
  }
  getRun(runId: string, options?: GetRunOptions): Promise<StoredRun | null> {
    return this.pending.then((store) => store.getRun(runId, options))
  }
  queryRuns(query?: TraceQuery): Promise<Page<RunSummary>> {
    return this.pending.then((store) => store.queryRuns(query))
  }
  deleteRun(runId: string): Promise<DeleteResult> {
    return this.pending.then((store) => store.deleteRun(runId))
  }
  delete(query: TraceDeleteQuery): Promise<DeleteResult> {
    return this.pending.then((store) => store.delete(query))
  }
  applyRetention(policy: RetentionPolicy): Promise<DeleteResult> {
    return this.pending.then((store) => store.applyRetention(policy))
  }
}

function contractStore(options: TraceStoreContractFactoryOptions = {}): TraceStore {
  const path = join(tmpdir(), `oma-file-trace-contract-${randomUUID()}.ndjson`)
  temporaryRoots.push(path)
  const pending = FileTraceStore.open(path, {
    now: options.now,
    onDiagnostic: (diagnostic) => {
      if ('runId' in diagnostic) options.onDiagnostic?.(diagnostic)
    },
  })
  return new DeferredTraceStore(pending)
}

runTraceStoreContractSuite('FileTraceStore', contractStore)

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('FileTraceStore file format and recovery', () => {
  it('creates a versioned 0600 file and reopens with identical query results', async () => {
    const path = await temporaryPath()
    const store = await FileTraceStore.open(path)
    await store.append(attemptRecords({ runId: 'reopen', status: 'error' }))
    const before = await store.queryRuns({ status: ['error'] })
    await store.flush()
    await store.close()

    const firstLine = (await readFile(path, 'utf8')).split('\n')[0]
    expect(JSON.parse(firstLine!)).toEqual({
      type: 'file_header', format: FILE_TRACE_STORE_FORMAT,
      formatVersion: 1, traceSchemaMajor: 2,
    })
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)

    const reopened = await FileTraceStore.open(path)
    expect(await reopened.queryRuns({ status: ['error'] })).toEqual(before)
    await reopened.close()
  })

  it('serializes concurrent same-instance appends in invocation order', async () => {
    const path = await temporaryPath()
    const store = await FileTraceStore.open(path)
    await Promise.all(['a', 'b', 'c', 'd'].map((runId, index) =>
      store.append(attemptRecords({ runId, start: 1_000 + index }))))
    expect((await store.queryRuns({ order: 'started_asc' })).items.map((run) => run.runId))
      .toEqual(['a', 'b', 'c', 'd'])
    const loggedRunIds = (await readFile(path, 'utf8')).split('\n')
      .filter((line) => line.includes('"type":"batch_item"'))
      .map((line) => (JSON.parse(line) as { payload: { runId: string } }).payload.runId)
      .filter((runId, index, all) => index === 0 || runId !== all[index - 1])
    expect(loggedRunIds).toEqual(['a', 'b', 'c', 'd'])
    await store.close()
  })

  it('hides an entire batch when the file ends midway through that batch', async () => {
    const path = await temporaryPath()
    const store = await FileTraceStore.open(path)
    await store.append(attemptRecords({ runId: 'half-batch' }))
    await store.close()
    const lines = (await readFile(path, 'utf8')).split('\n')
    await writeFile(path, `${lines.slice(0, 3).join('\n')}\n`, 'utf8')

    const diagnostics: FileTraceStoreDiagnostic[] = []
    const reopened = await FileTraceStore.open(path, {
      onDiagnostic: (diagnostic) => { if (!('runId' in diagnostic)) diagnostics.push(diagnostic) },
    })
    expect(await reopened.getRun('half-batch')).toBeNull()
    expect(diagnostics).toEqual([expect.objectContaining({ code: 'incomplete_batch' })])
    expect((await readFile(path, 'utf8')).split('\n')).toHaveLength(2)
    await reopened.close()
  })

  it('recovers a trailing partial line, diagnoses it, and preserves prior commits', async () => {
    const path = await temporaryPath()
    const store = await FileTraceStore.open(path)
    await store.append(attemptRecords({ runId: 'committed' }))
    await store.close()
    const committedRaw = await readFile(path, 'utf8')
    await appendFile(path, '{"type":"batch_start"', 'utf8')

    const diagnostics: FileTraceStoreDiagnostic[] = []
    const reopened = await FileTraceStore.open(path, {
      onDiagnostic: (diagnostic) => { if (!('runId' in diagnostic)) diagnostics.push(diagnostic) },
    })
    expect((await reopened.getRun('committed'))?.status).toBe('ok')
    expect(diagnostics).toEqual([expect.objectContaining({ code: 'trailing_partial_line' })])
    expect(await readFile(path, 'utf8')).toBe(committedRaw)
    await reopened.close()
  })

  it('fails loudly on a complete corrupt line even when valid data follows it', async () => {
    const firstPath = await temporaryPath('first.ndjson')
    const secondPath = await temporaryPath('second.ndjson')
    const first = await FileTraceStore.open(firstPath)
    const second = await FileTraceStore.open(secondPath)
    await first.append(attemptRecords({ runId: 'first' }))
    await second.append(attemptRecords({ runId: 'second' }))
    await Promise.all([first.close(), second.close()])
    const firstRaw = await readFile(firstPath, 'utf8')
    const secondLines = (await readFile(secondPath, 'utf8')).split('\n')
    await writeFile(firstPath, `${firstRaw}{invalid-json}\n${secondLines.slice(1).join('\n')}`, 'utf8')

    await expect(FileTraceStore.open(firstPath)).rejects.toMatchObject({
      code: 'CORRUPT_FILE', operation: 'recover',
    })
  })

  it('rejects unsupported on-disk format and trace schema versions', async () => {
    const formatPath = await temporaryPath('format.ndjson')
    await writeFile(formatPath, `${JSON.stringify({
      type: 'file_header', format: FILE_TRACE_STORE_FORMAT,
      formatVersion: 99, traceSchemaMajor: 2,
    })}\n`)
    await expect(FileTraceStore.open(formatPath)).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE_FORMAT' })

    const schemaPath = await temporaryPath('schema.ndjson')
    await writeFile(schemaPath, `${JSON.stringify({
      type: 'file_header', format: FILE_TRACE_STORE_FORMAT,
      formatVersion: 1, traceSchemaMajor: 99,
    })}\n`)
    await expect(FileTraceStore.open(schemaPath)).rejects.toMatchObject({ code: 'UNSUPPORTED_TRACE_SCHEMA' })
  })

  it('preserves recordId and first span_end idempotency across reopen', async () => {
    const path = await temporaryPath()
    const records = attemptRecords({ runId: 'dedupe-reopen', status: 'ok' })
    const store = await FileTraceStore.open(path)
    await store.append(records)
    await store.close()

    const reopened = await FileTraceStore.open(path)
    await expect(reopened.append(records)).resolves.toMatchObject({ written: 0, deduplicated: 2 })
    const duplicateEnd = {
      ...records[1]!, recordId: 'different-end-record', sequence: 4,
      status: { code: 'error' as const },
    } as TraceRecord
    await expect(reopened.append([duplicateEnd])).resolves.toMatchObject({
      written: 0, deduplicated: 1,
      diagnostics: [expect.objectContaining({ code: 'duplicate_span_end' })],
    })
    expect((await reopened.getRun('dedupe-reopen'))?.status).toBe('ok')
    await reopened.close()
  })

  it('does not resurrect delete or retention results after reopen', async () => {
    const path = await temporaryPath()
    const store = await FileTraceStore.open(path, { now: () => 10_000 })
    await store.append(attemptRecords({ runId: 'delete', start: 1_000 }))
    await store.append(attemptRecords({ runId: 'retained-away', start: 2_000, status: 'error' }))
    await store.append(attemptRecords({ runId: 'keep', start: 9_000 }))
    await store.deleteRun('delete')
    await store.applyRetention({ maxAgeMs: 5_000, statuses: ['error'] })
    await store.close()

    const reopened = await FileTraceStore.open(path, { now: () => 10_000 })
    expect((await reopened.queryRuns({ order: 'started_asc' })).items.map((run) => run.runId)).toEqual(['keep'])
    await reopened.close()
  })

  it('declares cursors instance-bound by rejecting them after reopen', async () => {
    const path = await temporaryPath()
    const store = await FileTraceStore.open(path)
    await store.append(attemptRecords({ runId: 'cursor-a' }))
    await store.append(attemptRecords({ runId: 'cursor-b', start: 2_000 }))
    const cursor = (await store.queryRuns({ limit: 1 })).nextCursor!
    await store.close()
    const reopened = await FileTraceStore.open(path)
    await expect(reopened.queryRuns({ limit: 1, cursor })).rejects.toMatchObject({ code: 'INVALID_CURSOR' })
    await reopened.close()
  })
})

describe('FileTraceStore lifecycle and filesystem failures', () => {
  it('defines append as write-complete and flush as the fsync boundary', async () => {
    const path = await temporaryPath()
    const store = await FileTraceStore.open(path)
    const sync = vi.spyOn(FILE_TRACE_STORE_IO, 'sync')
    await store.append(attemptRecords({ runId: 'durability-boundary' }))
    expect(sync).not.toHaveBeenCalled()
    await store.flush()
    expect(sync).toHaveBeenCalledTimes(1)
    await store.close()
  })

  it('makes flush repeatable, close idempotent, and post-close operations structured errors', async () => {
    const path = await temporaryPath()
    const store = await FileTraceStore.open(path)
    await store.append(attemptRecords({ runId: 'lifecycle' }))
    await expect(store.flush()).resolves.toBeUndefined()
    await expect(store.flush()).resolves.toBeUndefined()
    const first = store.close()
    const second = store.close()
    expect(second).toBe(first)
    await expect(first).resolves.toBeUndefined()
    await expect(store.close()).resolves.toBeUndefined()
    await expect(store.getRun('lifecycle')).rejects.toMatchObject({ code: 'CLOSED' })
    await expect(store.flush()).rejects.toMatchObject({ code: 'CLOSED' })
  })

  it('rolls back memory and disk state when a write fails', async () => {
    const path = await temporaryPath()
    const store = await FileTraceStore.open(path)
    vi.spyOn(FILE_TRACE_STORE_IO, 'writeFile').mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }))
    await expect(store.append(attemptRecords({ runId: 'write-failed' }))).rejects.toMatchObject({
      code: 'WRITE_FAILED', causeCode: 'ENOSPC',
    })
    expect(await store.getRun('write-failed')).toBeNull()
    vi.restoreAllMocks()
    await store.append(attemptRecords({ runId: 'after-failure' }))
    await store.close()
    const reopened = await FileTraceStore.open(path)
    expect(await reopened.getRun('write-failed')).toBeNull()
    expect((await reopened.getRun('after-failure'))?.status).toBe('ok')
    await reopened.close()
  })

  it('reports fsync failure instead of claiming flush success', async () => {
    const path = await temporaryPath()
    const store = await FileTraceStore.open(path)
    await store.append(attemptRecords({ runId: 'sync-failed' }))
    vi.spyOn(FILE_TRACE_STORE_IO, 'sync').mockRejectedValueOnce(Object.assign(new Error('sync failed'), { code: 'EIO' }))
    await expect(store.flush()).rejects.toMatchObject({ code: 'SYNC_FAILED', causeCode: 'EIO' })
    vi.restoreAllMocks()
    await store.close()
  })

  it.skipIf(process.platform === 'win32')('returns a structured permission failure when the parent is not writable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oma-file-trace-permission-'))
    temporaryRoots.push(root)
    await chmod(root, 0o500)
    try {
      await expect(FileTraceStore.open(join(root, 'denied.ndjson'))).rejects.toMatchObject({
        code: 'OPEN_FAILED', causeCode: expect.stringMatching(/EACCES|EPERM/),
      })
    } finally {
      await chmod(root, 0o700)
    }
  })

  it('keeps the original usable when compaction rename fails', async () => {
    const path = await temporaryPath()
    const store = await FileTraceStore.open(path)
    await store.append(attemptRecords({ runId: 'rename-safe' }))
    const before = await readFile(path, 'utf8')
    vi.spyOn(FILE_TRACE_STORE_IO, 'rename').mockRejectedValueOnce(Object.assign(new Error('rename denied'), { code: 'EACCES' }))
    await expect(store.compact()).rejects.toMatchObject({ code: 'RENAME_FAILED', causeCode: 'EACCES' })
    expect(await readFile(path, 'utf8')).toBe(before)
    expect((await store.getRun('rename-safe'))?.status).toBe('ok')
    vi.restoreAllMocks()
    await store.close()
  })

  it('keeps the original usable when compaction temp fsync fails before rename', async () => {
    const path = await temporaryPath()
    const store = await FileTraceStore.open(path)
    await store.append(attemptRecords({ runId: 'compact-sync-safe' }))
    const before = await readFile(path, 'utf8')
    vi.spyOn(FILE_TRACE_STORE_IO, 'sync').mockRejectedValueOnce(Object.assign(new Error('sync denied'), { code: 'EIO' }))
    await expect(store.compact()).rejects.toMatchObject({ code: 'COMPACTION_FAILED', causeCode: 'EIO' })
    expect(await readFile(path, 'utf8')).toBe(before)
    expect((await store.getRun('compact-sync-safe'))?.status).toBe('ok')
    vi.restoreAllMocks()
    await store.close()
  })
})

describe('FileTraceStore compaction', () => {
  it('preserves query results, removes deleted data, and is byte-deterministic when repeated', async () => {
    const path = await temporaryPath()
    const store = await FileTraceStore.open(path)
    await store.append(attemptRecords({ runId: 'deleted', start: 1_000 }))
    await store.append(attemptRecords({ runId: 'kept', start: 2_000, status: 'error' }))
    await store.deleteRun('deleted')
    const before = await store.queryRuns({ order: 'started_asc' })
    const first = await store.compact()
    const compactedOnce = await readFile(path, 'utf8')
    expect(compactedOnce).not.toContain('"runId":"deleted"')
    expect(await store.queryRuns({ order: 'started_asc' })).toEqual(before)
    const second = await store.compact()
    const compactedTwice = await readFile(path, 'utf8')
    expect(compactedTwice).toBe(compactedOnce)
    expect(second).toEqual(first)
    await store.close()

    const reopened = await FileTraceStore.open(path)
    expect(await reopened.queryRuns({ order: 'started_asc' })).toEqual(before)
    await reopened.close()
  })

  it('diagnoses a stale temp while keeping the target authoritative', async () => {
    const path = await temporaryPath()
    const store = await FileTraceStore.open(path)
    await store.append(attemptRecords({ runId: 'target-wins' }))
    await store.close()
    await writeFile(`${path}.compact.tmp`, 'interrupted compaction', 'utf8')

    const diagnostics: FileTraceStoreDiagnostic[] = []
    const reopened = await FileTraceStore.open(path, {
      onDiagnostic: (diagnostic) => { if (!('runId' in diagnostic)) diagnostics.push(diagnostic) },
    })
    expect((await reopened.getRun('target-wins'))?.status).toBe('ok')
    expect(diagnostics).toEqual([expect.objectContaining({ code: 'stale_compaction_file' })])
    await reopened.close()
  })

  it('fails loudly when only a stale compaction temp exists', async () => {
    const path = await temporaryPath()
    await writeFile(`${path}.compact.tmp`, 'possible committed data', 'utf8')
    await expect(FileTraceStore.open(path)).rejects.toMatchObject({ code: 'STALE_COMPACTION_FILE' })
  })
})

describe('FileTraceStore import boundary', () => {
  it('is exported only from the Node-only file subpath module', async () => {
    const root = await import('../src/index.js')
    const observability = await import('../src/observability/index.js')
    const file = await import('../src/observability/file.js')
    expect(root).not.toHaveProperty('FileTraceStore')
    expect(observability).not.toHaveProperty('FileTraceStore')
    expect(file.FileTraceStore).toBe(FileTraceStore)
  })

  it('uses payload-free structured corruption errors', async () => {
    const path = await temporaryPath()
    const secret = 'secret-telemetry-payload'
    await writeFile(path, `${JSON.stringify({
      type: 'file_header', format: FILE_TRACE_STORE_FORMAT,
      formatVersion: 1, traceSchemaMajor: 2,
    })}\n{${secret}}\n`)
    const error = await FileTraceStore.open(path).catch((caught) => caught as FileTraceStoreError)
    expect(error).toBeInstanceOf(FileTraceStoreError)
    expect(error.code).toBe('CORRUPT_FILE')
    expect(error.message).not.toContain(secret)
  })

  it('keeps TraceStore validation errors unchanged', async () => {
    const path = await temporaryPath()
    const store = await FileTraceStore.open(path)
    await expect(store.append([{ schemaVersion: 99 } as unknown as TraceRecord]))
      .rejects.toBeInstanceOf(TraceStoreError)
    await store.close()
  })
})
