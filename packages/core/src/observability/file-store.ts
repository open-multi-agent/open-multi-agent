/**
 * Node-only, single-process reference TraceStore backed by append-only NDJSON.
 * Import from `@open-multi-agent/core/observability/file`.
 *
 * The file contains a versioned header followed by committed mutation batches.
 * A batch is visible only after its `batch_commit` marker, item count, and
 * SHA-256 payload checksum all validate. Recovery truncates an incomplete tail
 * back to the last committed byte boundary, so a crashed append is replayed in
 * full or not at all.
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  type FileHandle,
} from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { TraceRecord } from './records.js'
import { InMemoryTraceStore } from './in-memory-store.js'
import {
  TRACE_STORE_SCHEMA_MAJOR,
  TraceStoreError,
  type AppendResult,
  type DeleteResult,
  type GetRunOptions,
  type Page,
  type RetentionPolicy,
  type RunSummary,
  type StoredRun,
  type TraceDeleteQuery,
  type TraceQuery,
  type TraceStore,
  type TraceStoreDiagnostic,
} from './store.js'

export const FILE_TRACE_STORE_FORMAT = 'oma.file_trace_store' as const
export const FILE_TRACE_STORE_FORMAT_VERSION = 1 as const

export type FileTraceStoreErrorCode =
  | 'INVALID_PATH'
  | 'OPEN_FAILED'
  | 'READ_FAILED'
  | 'WRITE_FAILED'
  | 'SYNC_FAILED'
  | 'CLOSE_FAILED'
  | 'CORRUPT_FILE'
  | 'UNSUPPORTED_FILE_FORMAT'
  | 'UNSUPPORTED_TRACE_SCHEMA'
  | 'RECOVERY_FAILED'
  | 'STALE_COMPACTION_FILE'
  | 'RENAME_FAILED'
  | 'COMPACTION_FAILED'
  | 'CLOSED'
  | 'RECOVERY_REQUIRED'

/** Payload-free, structured FileTraceStore lifecycle or filesystem failure. */
export class FileTraceStoreError extends Error {
  readonly name = 'FileTraceStoreError'

  constructor(
    readonly code: FileTraceStoreErrorCode,
    message: string,
    readonly operation?: string,
    readonly path?: string,
    readonly lineNumber?: number,
    readonly causeCode?: string,
  ) {
    super(message)
  }
}

export type FileTraceStoreDiagnosticCode =
  | 'trailing_partial_line'
  | 'incomplete_batch'
  | 'stale_compaction_file'
  | 'directory_sync_unsupported'
  | 'minimal_permissions_not_enforced'

export interface FileTraceStoreDiagnostic {
  readonly code: FileTraceStoreDiagnosticCode
  readonly severity: 'warning'
  readonly message: string
  readonly lineNumber?: number
}

export interface FileTraceStoreOptions {
  /** Injectable wall clock used only by retention. */
  readonly now?: () => number
  readonly onDiagnostic?: (
    diagnostic: FileTraceStoreDiagnostic | TraceStoreDiagnostic,
  ) => void
}

export interface FileTraceStoreCompactionResult {
  readonly recordsWritten: number
  readonly fileSizeBytes: number
}

interface FileHeader {
  readonly type: 'file_header'
  readonly format: typeof FILE_TRACE_STORE_FORMAT
  readonly formatVersion: typeof FILE_TRACE_STORE_FORMAT_VERSION
  readonly traceSchemaMajor: typeof TRACE_STORE_SCHEMA_MAJOR
}

type MutationOperation = 'append' | 'delete'

interface BatchStart {
  readonly type: 'batch_start'
  readonly formatVersion: typeof FILE_TRACE_STORE_FORMAT_VERSION
  readonly batchId: string
  readonly operation: MutationOperation
  readonly itemCount: number
  readonly payloadSha256: string
}

interface BatchItem {
  readonly type: 'batch_item'
  readonly batchId: string
  readonly index: number
  readonly payload: unknown
}

interface BatchCommit {
  readonly type: 'batch_commit'
  readonly batchId: string
  readonly itemCount: number
  readonly payloadSha256: string
}

interface PendingBatch {
  readonly start: BatchStart
  readonly payloads: unknown[]
  readonly startLine: number
}

interface ParsedFile {
  readonly memory: InMemoryTraceStore
  readonly header: FileHeader
  readonly repairOffset?: number
}

const HEADER: FileHeader = {
  type: 'file_header',
  format: FILE_TRACE_STORE_FORMAT,
  formatVersion: FILE_TRACE_STORE_FORMAT_VERSION,
  traceSchemaMajor: TRACE_STORE_SCHEMA_MAJOR,
}

const DIRECTORY_SYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EISDIR', 'EPERM'])

/** @internal Mutable indirection used only for deterministic filesystem failure tests. */
export const FILE_TRACE_STORE_IO = {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile: (handle: FileHandle, data: string) => handle.writeFile(data, 'utf8'),
  sync: (handle: FileHandle) => handle.sync(),
  close: (handle: FileHandle) => handle.close(),
  truncate: (handle: FileHandle, length: number) => handle.truncate(length),
  chmod: (handle: FileHandle, mode: number) => handle.chmod(mode),
}

function errno(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' ? code : undefined
}

function emitSafely(
  callback: FileTraceStoreOptions['onDiagnostic'],
  diagnostic: FileTraceStoreDiagnostic | TraceStoreDiagnostic,
): void {
  try { callback?.(diagnostic) } catch { /* diagnostics never affect storage */ }
}

function fileError(
  code: FileTraceStoreErrorCode,
  message: string,
  operation: string,
  path: string,
  cause?: unknown,
  lineNumber?: number,
): FileTraceStoreError {
  return new FileTraceStoreError(code, message, operation, path, lineNumber, errno(cause))
}

function parseObject(line: string, path: string, lineNumber: number): Record<string, unknown> {
  try {
    const value = JSON.parse(line) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not-object')
    return value as Record<string, unknown>
  } catch {
    throw fileError(
      'CORRUPT_FILE',
      'FileTraceStore encountered an invalid complete NDJSON line.',
      'recover', path, undefined, lineNumber,
    )
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function payloadChecksum(payloads: readonly unknown[]): string {
  const hash = createHash('sha256')
  for (const payload of payloads) {
    hash.update(JSON.stringify(payload))
    hash.update('\n')
  }
  return hash.digest('hex')
}

function serializeBatch(
  operation: MutationOperation,
  payloads: readonly unknown[],
  batchId: string = randomUUID(),
): string {
  const checksum = payloadChecksum(payloads)
  const start: BatchStart = {
    type: 'batch_start',
    formatVersion: FILE_TRACE_STORE_FORMAT_VERSION,
    batchId,
    operation,
    itemCount: payloads.length,
    payloadSha256: checksum,
  }
  const lines = [JSON.stringify(start)]
  for (let index = 0; index < payloads.length; index++) {
    lines.push(JSON.stringify({
      type: 'batch_item', batchId, index, payload: payloads[index],
    } satisfies BatchItem))
  }
  lines.push(JSON.stringify({
    type: 'batch_commit', batchId, itemCount: payloads.length, payloadSha256: checksum,
  } satisfies BatchCommit))
  return `${lines.join('\n')}\n`
}

function cloneJson<T>(value: T, field: string): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T
  } catch {
    throw new TraceStoreError('INVALID_ARGUMENT', `${field} must be JSON-serializable.`, field)
  }
}

/**
 * Persistent local TraceStore reference. One instance serializes all reads and
 * writes; two instances/processes must not write the same file concurrently.
 */
export class FileTraceStore implements TraceStore {
  readonly filePath: string
  readonly compactionTempPath: string

  private memory: InMemoryTraceStore
  private header: FileHeader
  private operationChain: Promise<void> = Promise.resolve()
  private state: 'open' | 'closing' | 'closed' | 'failed' = 'open'
  private closePromise: Promise<void> | null = null
  private readonly diagnostics: FileTraceStoreDiagnostic[] = []

  private constructor(
    filePath: string,
    memory: InMemoryTraceStore,
    header: FileHeader,
    private readonly options: FileTraceStoreOptions,
  ) {
    this.filePath = filePath
    this.compactionTempPath = `${filePath}.compact.tmp`
    this.memory = memory
    this.header = header
  }

  /** Open or create a store, scan the full log, repair only an incomplete tail, and rebuild indexes. */
  static async open(filePath: string, options: FileTraceStoreOptions = {}): Promise<FileTraceStore> {
    if (typeof filePath !== 'string' || filePath.length === 0 || filePath.includes('\0')) {
      throw new FileTraceStoreError('INVALID_PATH', 'FileTraceStore path must be a non-empty filesystem path.', 'open')
    }
    const absolute = resolve(filePath)
    const tempPath = `${absolute}.compact.tmp`
    const tempExists = await FileTraceStore.pathExists(tempPath, 'open')
    const targetExists = await FileTraceStore.pathExists(absolute, 'open')
    if (!targetExists && tempExists) {
      throw fileError(
        'STALE_COMPACTION_FILE',
        'A compaction temp file exists without the target file; refusing to create an empty store.',
        'open', absolute,
      )
    }
    if (!targetExists) await FileTraceStore.createFile(absolute, options)

    const provisional = new FileTraceStore(
      absolute,
      new InMemoryTraceStore({ now: options.now }),
      HEADER,
      options,
    )
    if (tempExists) provisional.emitFileDiagnostic({
      code: 'stale_compaction_file', severity: 'warning',
      message: 'A stale compaction temp file was found; the committed target file remains authoritative.',
    })
    const parsed = await provisional.parseFile(true)
    provisional.memory = parsed.memory
    provisional.header = parsed.header
    if (process.platform === 'win32') provisional.emitFileDiagnostic({
      code: 'minimal_permissions_not_enforced', severity: 'warning',
      message: 'This platform does not enforce POSIX mode 0600; protect the file with platform access controls.',
    })
    return provisional
  }

  get isClosed(): boolean {
    return this.state === 'closed'
  }

  getDiagnostics(): readonly FileTraceStoreDiagnostic[] {
    return cloneJson(this.diagnostics, 'diagnostics')
  }

  async append(records: readonly TraceRecord[]): Promise<AppendResult> {
    const snapshot = cloneJson(records, 'records')
    return this.enqueue(async () => {
      const result = await this.memory.append(snapshot)
      if (snapshot.length > 0) {
        try {
          await this.appendMutation('append', snapshot)
        } catch (error) {
          await this.rollbackAfterMutationFailure(error)
          throw error
        }
      }
      for (const diagnostic of result.diagnostics) emitSafely(this.options.onDiagnostic, diagnostic)
      return result
    })
  }

  async getRun(runId: string, options: GetRunOptions = {}): Promise<StoredRun | null> {
    const optionsSnapshot = cloneJson(options, 'options')
    return this.enqueue(() => this.memory.getRun(runId, optionsSnapshot))
  }

  async queryRuns(query: TraceQuery = {}): Promise<Page<RunSummary>> {
    const snapshot = cloneJson(query, 'query')
    return this.enqueue(() => this.memory.queryRuns(snapshot))
  }

  async deleteRun(runId: string): Promise<DeleteResult> {
    return this.enqueue(async () => {
      const result = await this.memory.deleteRun(runId)
      return this.persistDeleteResult(result)
    })
  }

  async delete(query: TraceDeleteQuery): Promise<DeleteResult> {
    const snapshot = cloneJson(query, 'query')
    return this.enqueue(async () => {
      const result = await this.memory.delete(snapshot)
      return this.persistDeleteResult(result)
    })
  }

  async applyRetention(policy: RetentionPolicy): Promise<DeleteResult> {
    const snapshot = cloneJson(policy, 'policy')
    return this.enqueue(async () => {
      const result = await this.memory.applyRetention(snapshot)
      return this.persistDeleteResult(result)
    })
  }

  /** fsync all writes that completed before this call. The store remains open. */
  async flush(): Promise<void> {
    return this.enqueue(() => this.syncTarget('flush'))
  }

  /**
   * Rewrite only current effective records through same-directory temp → fsync
   * → atomic rename → directory fsync. Query results and in-memory cursors are unchanged.
   */
  async compact(): Promise<FileTraceStoreCompactionResult> {
    return this.enqueue(async () => {
      const records = await this.currentRecords()
      const checksum = payloadChecksum(records)
      const body = records.length > 0
        ? `${JSON.stringify(this.header)}\n${serializeBatch('append', records, `compact-${checksum.slice(0, 24)}`)}`
        : `${JSON.stringify(this.header)}\n`
      let handle: FileHandle | undefined
      let renamed = false
      try {
        handle = await FILE_TRACE_STORE_IO.open(this.compactionTempPath, 'w', 0o600)
        await FILE_TRACE_STORE_IO.chmod(handle, 0o600)
        await FILE_TRACE_STORE_IO.writeFile(handle, body)
        await FILE_TRACE_STORE_IO.sync(handle)
        await FILE_TRACE_STORE_IO.close(handle)
        handle = undefined
        try {
          await FILE_TRACE_STORE_IO.rename(this.compactionTempPath, this.filePath)
          renamed = true
        } catch (error) {
          throw fileError(
            'RENAME_FAILED',
            'FileTraceStore compaction could not atomically replace the target; the original remains authoritative.',
            'compact.rename', this.filePath, error,
          )
        }
        await this.syncDirectory('compact')
        const info = await FILE_TRACE_STORE_IO.stat(this.filePath)
        return { recordsWritten: records.length, fileSizeBytes: info.size }
      } catch (error) {
        if (handle) await FILE_TRACE_STORE_IO.close(handle).catch(() => undefined)
        if (error instanceof FileTraceStoreError) throw error
        throw fileError(
          renamed ? 'COMPACTION_FAILED' : 'COMPACTION_FAILED',
          renamed
            ? 'FileTraceStore replaced the compacted file but could not confirm the final durability step.'
            : 'FileTraceStore compaction failed before replacing the committed target file.',
          'compact', this.filePath, error,
        )
      }
    })
  }

  /** Idempotently fsync prior writes and reject all later operations. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    if (this.state === 'closed') return Promise.resolve()
    if (this.state === 'failed') {
      this.state = 'closed'
      this.closePromise = Promise.reject(fileError(
        'RECOVERY_REQUIRED',
        'FileTraceStore cannot close cleanly after an unrecoverable write failure.',
        'close', this.filePath,
      ))
      return this.closePromise
    }
    this.state = 'closing'
    const closing = this.operationChain.then(async () => {
      if (this.state === 'failed') {
        throw fileError(
          'RECOVERY_REQUIRED',
          'FileTraceStore cannot close cleanly after an unrecoverable write failure.',
          'close', this.filePath,
        )
      }
      try {
        await this.syncTarget('close')
      } catch (error) {
        if (error instanceof FileTraceStoreError) throw error
        throw fileError('CLOSE_FAILED', 'FileTraceStore close failed.', 'close', this.filePath, error)
      }
    })
    this.closePromise = closing.then(
      () => { this.state = 'closed' },
      (error) => { this.state = 'closed'; throw error },
    )
    this.operationChain = this.closePromise.then(() => undefined, () => undefined)
    return this.closePromise
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === 'failed') {
      return Promise.reject(fileError(
        'RECOVERY_REQUIRED',
        'FileTraceStore requires reopen/recovery before further operations.',
        'operation', this.filePath,
      ))
    }
    if (this.state !== 'open') {
      return Promise.reject(fileError(
        'CLOSED',
        'FileTraceStore is closing or closed.',
        'operation', this.filePath,
      ))
    }
    const run = this.operationChain.then(operation)
    this.operationChain = run.then(() => undefined, () => undefined)
    return run
  }

  private async persistDeleteResult(result: DeleteResult): Promise<DeleteResult> {
    if (result.runIds.length === 0) return result
    try {
      await this.appendMutation('delete', result.runIds.map((runId) => ({ runId })))
      return result
    } catch (error) {
      await this.rollbackAfterMutationFailure(error)
      throw error
    }
  }

  private async appendMutation(operation: MutationOperation, payloads: readonly unknown[]): Promise<void> {
    let startSize: number
    try {
      startSize = (await FILE_TRACE_STORE_IO.stat(this.filePath)).size
    } catch (error) {
      throw fileError('WRITE_FAILED', 'FileTraceStore could not inspect its data file before writing.', 'append.stat', this.filePath, error)
    }
    let handle: FileHandle | undefined
    try {
      handle = await FILE_TRACE_STORE_IO.open(this.filePath, 'a')
      await FILE_TRACE_STORE_IO.writeFile(handle, serializeBatch(operation, payloads))
      await FILE_TRACE_STORE_IO.close(handle)
    } catch (error) {
      if (handle) await FILE_TRACE_STORE_IO.close(handle).catch(() => undefined)
      const writeError = fileError(
        'WRITE_FAILED',
        'FileTraceStore append did not complete; the mutation was not acknowledged.',
        'append.write', this.filePath, error,
      )
      try {
        await this.truncateAndSync(startSize)
      } catch (rollbackError) {
        this.state = 'failed'
        throw fileError(
          'RECOVERY_REQUIRED',
          'FileTraceStore could not roll back a failed append; reopen is required.',
          'append.rollback', this.filePath, rollbackError,
        )
      }
      throw writeError
    }
  }

  private async rollbackAfterMutationFailure(original: unknown): Promise<void> {
    if (this.state === 'failed') return
    try {
      const parsed = await this.parseFile(false)
      this.memory = parsed.memory
      this.header = parsed.header
    } catch (recoveryError) {
      this.state = 'failed'
      throw fileError(
        'RECOVERY_REQUIRED',
        'FileTraceStore could not rebuild state after a failed mutation.',
        'rollback', this.filePath, recoveryError,
      )
    }
    if (original instanceof Error) return
  }

  private async truncateAndSync(length: number): Promise<void> {
    let handle: FileHandle | undefined
    try {
      handle = await FILE_TRACE_STORE_IO.open(this.filePath, 'r+')
      await FILE_TRACE_STORE_IO.truncate(handle, length)
      await FILE_TRACE_STORE_IO.sync(handle)
      await FILE_TRACE_STORE_IO.close(handle)
    } finally {
      if (handle) await FILE_TRACE_STORE_IO.close(handle).catch(() => undefined)
    }
  }

  private async syncTarget(operation: string): Promise<void> {
    let handle: FileHandle | undefined
    try {
      handle = await FILE_TRACE_STORE_IO.open(this.filePath, 'r')
      await FILE_TRACE_STORE_IO.sync(handle)
      await FILE_TRACE_STORE_IO.close(handle)
    } catch (error) {
      if (handle) await FILE_TRACE_STORE_IO.close(handle).catch(() => undefined)
      throw fileError(
        'SYNC_FAILED',
        'FileTraceStore could not fsync its data file.',
        operation, this.filePath, error,
      )
    }
  }

  private async currentRecords(): Promise<TraceRecord[]> {
    const records: TraceRecord[] = []
    let cursor: string | undefined
    do {
      const page = await this.memory.queryRuns({ limit: 500, order: 'started_asc', ...(cursor ? { cursor } : {}) })
      for (const summary of page.items) {
        const run = await this.memory.getRun(summary.runId, { includeRecords: true })
        if (run?.records) records.push(...run.records)
      }
      cursor = page.nextCursor
    } while (cursor)
    return records
  }

  private async parseFile(repairTail: boolean): Promise<ParsedFile> {
    let raw: Buffer
    try {
      raw = await FILE_TRACE_STORE_IO.readFile(this.filePath)
    } catch (error) {
      throw fileError('READ_FAILED', 'FileTraceStore could not read its data file.', 'recover.read', this.filePath, error)
    }
    const memory = new InMemoryTraceStore({ now: this.options.now })
    let offset = 0
    let lineNumber = 0
    let lastCommittedOffset = 0
    let header: FileHeader | undefined
    let pending: PendingBatch | undefined
    while (offset < raw.length) {
      const newline = raw.indexOf(0x0a, offset)
      if (newline === -1) {
        this.emitFileDiagnostic({
          code: 'trailing_partial_line', severity: 'warning', lineNumber: lineNumber + 1,
          message: 'A trailing partial NDJSON line was ignored and will be truncated.',
        })
        break
      }
      lineNumber++
      const line = raw.subarray(offset, newline).toString('utf8')
      const nextOffset = newline + 1
      if (line.length === 0) {
        throw fileError(
          'CORRUPT_FILE',
          'FileTraceStore encountered an empty complete NDJSON line.',
          'recover', this.filePath, undefined, lineNumber,
        )
      }
      const value = parseObject(line, this.filePath, lineNumber)
      if (!header) {
        header = this.parseHeader(value, lineNumber)
        lastCommittedOffset = nextOffset
        offset = nextOffset
        continue
      }
      const type = value['type']
      if (type === 'batch_start') {
        if (pending) throw this.corruption('A new batch began before the prior batch committed.', lineNumber)
        pending = { start: this.parseBatchStart(value, lineNumber), payloads: [], startLine: lineNumber }
      } else if (type === 'batch_item') {
        if (!pending) throw this.corruption('A batch item appeared without a batch start.', lineNumber)
        const item = this.parseBatchItem(value, lineNumber)
        if (item.batchId !== pending.start.batchId || item.index !== pending.payloads.length) {
          throw this.corruption('A batch item has a mismatched id or non-contiguous index.', lineNumber)
        }
        if (pending.payloads.length >= pending.start.itemCount) {
          throw this.corruption('A batch contains more items than declared.', lineNumber)
        }
        pending.payloads.push(item.payload)
      } else if (type === 'batch_commit') {
        if (!pending) throw this.corruption('A batch commit appeared without a batch start.', lineNumber)
        const commit = this.parseBatchCommit(value, lineNumber)
        const checksum = payloadChecksum(pending.payloads)
        if (commit.batchId !== pending.start.batchId
          || commit.itemCount !== pending.start.itemCount
          || pending.payloads.length !== pending.start.itemCount
          || commit.payloadSha256 !== pending.start.payloadSha256
          || checksum !== pending.start.payloadSha256) {
          throw this.corruption('A committed batch failed its id, count, or checksum validation.', lineNumber)
        }
        await this.applyRecoveredBatch(memory, pending, lineNumber)
        pending = undefined
        lastCommittedOffset = nextOffset
      } else {
        throw this.corruption('FileTraceStore encountered an unknown envelope line type.', lineNumber)
      }
      offset = nextOffset
    }
    if (!header) {
      throw fileError(
        'CORRUPT_FILE',
        'FileTraceStore has no complete version header.',
        'recover', this.filePath,
      )
    }
    const hasPartialLine = offset < raw.length
    if (pending) this.emitFileDiagnostic({
      code: 'incomplete_batch', severity: 'warning', lineNumber: pending.startLine,
      message: 'An uncommitted trailing batch was ignored and will be truncated.',
    })
    const needsRepair = hasPartialLine || pending !== undefined
    if (needsRepair && repairTail) {
      try {
        await this.truncateAndSync(lastCommittedOffset)
      } catch (error) {
        throw fileError(
          'RECOVERY_FAILED',
          'FileTraceStore could not truncate an incomplete tail during recovery.',
          'recover.truncate', this.filePath, error,
        )
      }
    }
    return { memory, header, ...(needsRepair ? { repairOffset: lastCommittedOffset } : {}) }
  }

  private parseHeader(value: Record<string, unknown>, lineNumber: number): FileHeader {
    if (value['type'] !== 'file_header' || value['format'] !== FILE_TRACE_STORE_FORMAT) {
      throw this.corruption('FileTraceStore header format is invalid.', lineNumber)
    }
    if (value['formatVersion'] !== FILE_TRACE_STORE_FORMAT_VERSION) {
      throw fileError(
        'UNSUPPORTED_FILE_FORMAT',
        'FileTraceStore file format version is unsupported.',
        'recover.header', this.filePath, undefined, lineNumber,
      )
    }
    if (value['traceSchemaMajor'] !== TRACE_STORE_SCHEMA_MAJOR) {
      throw fileError(
        'UNSUPPORTED_TRACE_SCHEMA',
        'FileTraceStore trace schema major is unsupported.',
        'recover.header', this.filePath, undefined, lineNumber,
      )
    }
    return HEADER
  }

  private parseBatchStart(value: Record<string, unknown>, lineNumber: number): BatchStart {
    if (value['formatVersion'] !== FILE_TRACE_STORE_FORMAT_VERSION
      || !nonEmpty(value['batchId'])
      || (value['operation'] !== 'append' && value['operation'] !== 'delete')
      || !Number.isInteger(value['itemCount']) || (value['itemCount'] as number) < 0
      || !nonEmpty(value['payloadSha256'])) {
      throw this.corruption('A batch_start envelope is malformed.', lineNumber)
    }
    return value as unknown as BatchStart
  }

  private parseBatchItem(value: Record<string, unknown>, lineNumber: number): BatchItem {
    if (!nonEmpty(value['batchId']) || !Number.isInteger(value['index']) || (value['index'] as number) < 0
      || !Object.prototype.hasOwnProperty.call(value, 'payload')) {
      throw this.corruption('A batch_item envelope is malformed.', lineNumber)
    }
    return value as unknown as BatchItem
  }

  private parseBatchCommit(value: Record<string, unknown>, lineNumber: number): BatchCommit {
    if (!nonEmpty(value['batchId']) || !Number.isInteger(value['itemCount']) || (value['itemCount'] as number) < 0
      || !nonEmpty(value['payloadSha256'])) {
      throw this.corruption('A batch_commit envelope is malformed.', lineNumber)
    }
    return value as unknown as BatchCommit
  }

  private async applyRecoveredBatch(
    memory: InMemoryTraceStore,
    pending: PendingBatch,
    lineNumber: number,
  ): Promise<void> {
    try {
      if (pending.start.operation === 'append') {
        await memory.append(pending.payloads as TraceRecord[])
      } else {
        for (const payload of pending.payloads) {
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)
            || !nonEmpty((payload as Record<string, unknown>)['runId'])) {
            throw new Error('invalid-delete-payload')
          }
          await memory.deleteRun((payload as { runId: string }).runId)
        }
      }
    } catch (error) {
      if (error instanceof TraceStoreError && error.code === 'UNSUPPORTED_SCHEMA_VERSION') {
        throw fileError(
          'UNSUPPORTED_TRACE_SCHEMA',
          'A committed batch contains an unsupported trace schema major.',
          'recover.batch', this.filePath, error, lineNumber,
        )
      }
      throw fileError(
        'CORRUPT_FILE',
        'A committed batch contains invalid data.',
        'recover.batch', this.filePath, error, lineNumber,
      )
    }
  }

  private corruption(message: string, lineNumber: number): FileTraceStoreError {
    return fileError('CORRUPT_FILE', message, 'recover', this.filePath, undefined, lineNumber)
  }

  private emitFileDiagnostic(diagnostic: FileTraceStoreDiagnostic): void {
    this.diagnostics.push(diagnostic)
    emitSafely(this.options.onDiagnostic, diagnostic)
  }

  private async syncDirectory(operation: string): Promise<void> {
    let handle: FileHandle | undefined
    try {
      handle = await FILE_TRACE_STORE_IO.open(dirname(this.filePath), 'r')
      await FILE_TRACE_STORE_IO.sync(handle)
      await FILE_TRACE_STORE_IO.close(handle)
    } catch (error) {
      if (handle) await FILE_TRACE_STORE_IO.close(handle).catch(() => undefined)
      const code = errno(error)
      if (code && DIRECTORY_SYNC_UNSUPPORTED.has(code)) {
        this.emitFileDiagnostic({
          code: 'directory_sync_unsupported', severity: 'warning',
          message: 'The platform/filesystem does not support directory fsync; rename durability is best-effort.',
        })
        return
      }
      throw fileError(
        'SYNC_FAILED',
        'FileTraceStore could not fsync the parent directory after an atomic rename.',
        operation, this.filePath, error,
      )
    }
  }

  private static async pathExists(path: string, operation: string): Promise<boolean> {
    try {
      await FILE_TRACE_STORE_IO.stat(path)
      return true
    } catch (error) {
      if (errno(error) === 'ENOENT') return false
      throw fileError('OPEN_FAILED', 'FileTraceStore could not inspect its filesystem path.', operation, path, error)
    }
  }

  private static async createFile(path: string, options: FileTraceStoreOptions): Promise<void> {
    let handle: FileHandle | undefined
    try {
      await FILE_TRACE_STORE_IO.mkdir(dirname(path), { recursive: true })
      handle = await FILE_TRACE_STORE_IO.open(path, 'wx', 0o600)
      await FILE_TRACE_STORE_IO.chmod(handle, 0o600)
      await FILE_TRACE_STORE_IO.writeFile(handle, `${JSON.stringify(HEADER)}\n`)
      await FILE_TRACE_STORE_IO.sync(handle)
      await FILE_TRACE_STORE_IO.close(handle)
      handle = undefined
      const provisional = new FileTraceStore(
        path, new InMemoryTraceStore({ now: options.now }), HEADER, options,
      )
      await provisional.syncDirectory('open.create')
    } catch (error) {
      if (handle) await FILE_TRACE_STORE_IO.close(handle).catch(() => undefined)
      if (errno(error) === 'EEXIST') return
      throw fileError('OPEN_FAILED', 'FileTraceStore could not create its data file.', 'open.create', path, error)
    }
  }
}
