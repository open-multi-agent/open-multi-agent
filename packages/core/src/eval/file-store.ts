/**
 * Node-only, single-process reference EvalStore backed by append-only NDJSON.
 * Import from `@open-multi-agent/core/eval/file`.
 *
 * Mutations use start/item/commit envelopes. Recovery accepts a batch only
 * when its item count and SHA-256 checksum match, so an interrupted final
 * append is replayed completely or discarded completely.
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  type FileHandle,
} from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { AppendResult, DeleteResult, Page } from '../observability/store.js'
import { EVAL_STORE_SCHEMA_MAJOR, type EvalRecord } from './record.js'
import {
  EVAL_STORE_INTERNALS,
  EvalStoreError,
  InMemoryEvalStore,
  type EvalDeleteQuery,
  type EvalQuery,
  type EvalRetentionPolicy,
  type EvalStore,
} from './store.js'

export const FILE_EVAL_STORE_FORMAT = 'oma.file_eval_store' as const
export const FILE_EVAL_STORE_FORMAT_VERSION = 1 as const

export type FileEvalStoreErrorCode =
  | 'INVALID_PATH'
  | 'OPEN_FAILED'
  | 'READ_FAILED'
  | 'WRITE_FAILED'
  | 'SYNC_FAILED'
  | 'CLOSE_FAILED'
  | 'CORRUPT_FILE'
  | 'UNSUPPORTED_FILE_FORMAT'
  | 'UNSUPPORTED_EVAL_SCHEMA'
  | 'RECOVERY_FAILED'
  | 'STALE_COMPACTION_FILE'
  | 'RENAME_FAILED'
  | 'COMPACTION_FAILED'
  | 'CLOSED'
  | 'RECOVERY_REQUIRED'

/** Payload-free, structured FileEvalStore lifecycle or filesystem failure. */
export class FileEvalStoreError extends Error {
  readonly name = 'FileEvalStoreError'

  constructor(
    readonly code: FileEvalStoreErrorCode,
    message: string,
    readonly operation?: string,
    readonly path?: string,
    readonly lineNumber?: number,
    readonly causeCode?: string,
  ) {
    super(message)
  }
}

export type FileEvalStoreDiagnosticCode =
  | 'trailing_partial_line'
  | 'incomplete_batch'
  | 'stale_compaction_file'
  | 'directory_sync_unsupported'
  | 'minimal_permissions_not_enforced'

export interface FileEvalStoreDiagnostic {
  readonly code: FileEvalStoreDiagnosticCode
  readonly severity: 'warning'
  readonly message: string
  readonly lineNumber?: number
}

export interface FileEvalStoreOptions {
  /** Injectable wall clock used only by retention. */
  readonly now?: () => number
  readonly onDiagnostic?: (diagnostic: FileEvalStoreDiagnostic) => void
}

export interface FileEvalStoreCompactionResult {
  readonly recordsWritten: number
  readonly fileSizeBytes: number
}

interface FileHeader {
  readonly type: 'file_header'
  readonly format: typeof FILE_EVAL_STORE_FORMAT
  readonly formatVersion: typeof FILE_EVAL_STORE_FORMAT_VERSION
  readonly evalSchemaMajor: typeof EVAL_STORE_SCHEMA_MAJOR
}

type MutationOperation = 'append' | 'delete'

interface BatchStart {
  readonly type: 'batch_start'
  readonly formatVersion: typeof FILE_EVAL_STORE_FORMAT_VERSION
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
  readonly memory: InMemoryEvalStore
  readonly header: FileHeader
  readonly repairOffset?: number
}

const HEADER: FileHeader = {
  type: 'file_header',
  format: FILE_EVAL_STORE_FORMAT,
  formatVersion: FILE_EVAL_STORE_FORMAT_VERSION,
  evalSchemaMajor: EVAL_STORE_SCHEMA_MAJOR,
}

const DIRECTORY_SYNC_UNSUPPORTED = new Set([
  'EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EISDIR', 'EPERM',
])

/** @internal Mutable indirection used only for deterministic filesystem failure tests. */
export const FILE_EVAL_STORE_IO = {
  mkdir,
  open,
  readFile,
  rename,
  stat,
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
  callback: FileEvalStoreOptions['onDiagnostic'],
  diagnostic: FileEvalStoreDiagnostic,
): void {
  try { callback?.(diagnostic) } catch { /* diagnostics never affect storage */ }
}

function fileError(
  code: FileEvalStoreErrorCode,
  message: string,
  operation: string,
  path: string,
  cause?: unknown,
  lineNumber?: number,
): FileEvalStoreError {
  return new FileEvalStoreError(code, message, operation, path, lineNumber, errno(cause))
}

function parseObject(line: string, path: string, lineNumber: number): Record<string, unknown> {
  try {
    const value = JSON.parse(line) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not-object')
    return value as Record<string, unknown>
  } catch {
    throw fileError(
      'CORRUPT_FILE',
      'FileEvalStore encountered an invalid complete NDJSON line.',
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
    formatVersion: FILE_EVAL_STORE_FORMAT_VERSION,
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
    const serialized = JSON.stringify(value)
    if (serialized === undefined) throw new Error('not serializable')
    return JSON.parse(serialized) as T
  } catch {
    throw new EvalStoreError('INVALID_ARGUMENT', `${field} must be JSON-serializable.`, field)
  }
}

/**
 * Persistent local EvalStore reference. One instance serializes every read and
 * write; multiple instances or processes must not write the same file.
 */
export class FileEvalStore implements EvalStore {
  readonly filePath: string
  readonly compactionTempPath: string

  private memory: InMemoryEvalStore
  private header: FileHeader
  private operationChain: Promise<void> = Promise.resolve()
  private state: 'open' | 'closing' | 'closed' | 'failed' = 'open'
  private closePromise: Promise<void> | null = null
  private readonly diagnostics: FileEvalStoreDiagnostic[] = []

  private constructor(
    filePath: string,
    memory: InMemoryEvalStore,
    header: FileHeader,
    private readonly options: FileEvalStoreOptions,
  ) {
    this.filePath = filePath
    this.compactionTempPath = `${filePath}.compact.tmp`
    this.memory = memory
    this.header = header
  }

  /** Open or create a store, repair only an incomplete tail, and rebuild indexes. */
  static async open(filePath: string, options: FileEvalStoreOptions = {}): Promise<FileEvalStore> {
    if (typeof filePath !== 'string' || filePath.length === 0 || filePath.includes('\0')) {
      throw new FileEvalStoreError(
        'INVALID_PATH',
        'FileEvalStore path must be a non-empty filesystem path.',
        'open',
      )
    }
    const absolute = resolve(filePath)
    const tempPath = `${absolute}.compact.tmp`
    const tempExists = await FileEvalStore.pathExists(tempPath, 'open')
    const targetExists = await FileEvalStore.pathExists(absolute, 'open')
    if (!targetExists && tempExists) {
      throw fileError(
        'STALE_COMPACTION_FILE',
        'A compaction temp file exists without the target file; refusing to create an empty store.',
        'open', absolute,
      )
    }
    if (!targetExists) await FileEvalStore.createFile(absolute, options)

    const provisional = new FileEvalStore(
      absolute,
      new InMemoryEvalStore({ now: options.now }),
      HEADER,
      options,
    )
    if (tempExists) provisional.emitFileDiagnostic({
      code: 'stale_compaction_file',
      severity: 'warning',
      message: 'A stale compaction temp file was found; the committed target file remains authoritative.',
    })
    const parsed = await provisional.parseFile(true)
    provisional.memory = parsed.memory
    provisional.header = parsed.header
    if (process.platform === 'win32') provisional.emitFileDiagnostic({
      code: 'minimal_permissions_not_enforced',
      severity: 'warning',
      message: 'This platform does not enforce POSIX mode 0600; protect the file with platform access controls.',
    })
    return provisional
  }

  get isClosed(): boolean {
    return this.state === 'closed'
  }

  getDiagnostics(): readonly FileEvalStoreDiagnostic[] {
    return cloneJson(this.diagnostics, 'diagnostics')
  }

  async append(records: readonly EvalRecord[]): Promise<AppendResult> {
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
      return result
    })
  }

  async query(query: EvalQuery = {}): Promise<Page<EvalRecord>> {
    const snapshot = cloneJson(query, 'query')
    return this.enqueue(() => this.memory.query(snapshot))
  }

  async delete(query: EvalDeleteQuery): Promise<DeleteResult> {
    const snapshot = cloneJson(query, 'query')
    return this.enqueue(async () => {
      const before = this.currentRecords()
      const result = await this.memory.delete(snapshot)
      return this.persistDeleteResult(result, this.deletedRecordIds(before))
    })
  }

  async applyRetention(policy: EvalRetentionPolicy): Promise<DeleteResult> {
    const snapshot = cloneJson(policy, 'policy')
    return this.enqueue(async () => {
      const before = this.currentRecords()
      const result = await this.memory.applyRetention(snapshot)
      return this.persistDeleteResult(result, this.deletedRecordIds(before))
    })
  }

  /** fsync all writes that completed before this call. The store remains open. */
  async flush(): Promise<void> {
    return this.enqueue(() => this.syncTarget('flush'))
  }

  /** Rewrite current records through same-directory temp, fsync, and atomic rename. */
  async compact(): Promise<FileEvalStoreCompactionResult> {
    return this.enqueue(async () => {
      const records = this.currentRecords()
      const checksum = payloadChecksum(records)
      const body = records.length > 0
        ? `${JSON.stringify(this.header)}\n${serializeBatch('append', records, `compact-${checksum.slice(0, 24)}`)}`
        : `${JSON.stringify(this.header)}\n`
      let handle: FileHandle | undefined
      let renamed = false
      try {
        handle = await FILE_EVAL_STORE_IO.open(this.compactionTempPath, 'w', 0o600)
        await FILE_EVAL_STORE_IO.chmod(handle, 0o600)
        await FILE_EVAL_STORE_IO.writeFile(handle, body)
        await FILE_EVAL_STORE_IO.sync(handle)
        await FILE_EVAL_STORE_IO.close(handle)
        handle = undefined
        try {
          await FILE_EVAL_STORE_IO.rename(this.compactionTempPath, this.filePath)
          renamed = true
        } catch (error) {
          throw fileError(
            'RENAME_FAILED',
            'FileEvalStore compaction could not atomically replace the target; the original remains authoritative.',
            'compact.rename', this.filePath, error,
          )
        }
        await this.syncDirectory('compact')
        const info = await FILE_EVAL_STORE_IO.stat(this.filePath)
        return { recordsWritten: records.length, fileSizeBytes: info.size }
      } catch (error) {
        if (handle) await FILE_EVAL_STORE_IO.close(handle).catch(() => undefined)
        if (error instanceof FileEvalStoreError) throw error
        throw fileError(
          'COMPACTION_FAILED',
          renamed
            ? 'FileEvalStore replaced the compacted file but could not confirm the final durability step.'
            : 'FileEvalStore compaction failed before replacing the committed target file.',
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
        'FileEvalStore cannot close cleanly after an unrecoverable write failure.',
        'close', this.filePath,
      ))
      return this.closePromise
    }
    this.state = 'closing'
    const closing = this.operationChain.then(async () => {
      if (this.state === 'failed') {
        throw fileError(
          'RECOVERY_REQUIRED',
          'FileEvalStore cannot close cleanly after an unrecoverable write failure.',
          'close', this.filePath,
        )
      }
      try {
        await this.syncTarget('close')
      } catch (error) {
        if (error instanceof FileEvalStoreError) throw error
        throw fileError('CLOSE_FAILED', 'FileEvalStore close failed.', 'close', this.filePath, error)
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
        'FileEvalStore requires reopen/recovery before further operations.',
        'operation', this.filePath,
      ))
    }
    if (this.state !== 'open') {
      return Promise.reject(fileError(
        'CLOSED',
        'FileEvalStore is closing or closed.',
        'operation', this.filePath,
      ))
    }
    const run = this.operationChain.then(operation)
    this.operationChain = run.then(() => undefined, () => undefined)
    return run
  }

  private currentRecords(): EvalRecord[] {
    return [...this.memory[EVAL_STORE_INTERNALS]().records()]
  }

  private deletedRecordIds(before: readonly EvalRecord[]): string[] {
    const remaining = new Set(this.currentRecords().map((record) => record.recordId))
    return before
      .filter((record) => !remaining.has(record.recordId))
      .map((record) => record.recordId)
  }

  private async persistDeleteResult(
    result: DeleteResult,
    recordIds: readonly string[],
  ): Promise<DeleteResult> {
    if (recordIds.length === 0) return result
    try {
      await this.appendMutation('delete', recordIds.map((recordId) => ({ recordId })))
      return result
    } catch (error) {
      await this.rollbackAfterMutationFailure(error)
      throw error
    }
  }

  private async appendMutation(
    operation: MutationOperation,
    payloads: readonly unknown[],
  ): Promise<void> {
    let startSize: number
    try {
      startSize = (await FILE_EVAL_STORE_IO.stat(this.filePath)).size
    } catch (error) {
      throw fileError(
        'WRITE_FAILED',
        'FileEvalStore could not inspect its data file before writing.',
        'append.stat', this.filePath, error,
      )
    }
    let handle: FileHandle | undefined
    try {
      handle = await FILE_EVAL_STORE_IO.open(this.filePath, 'a')
      await FILE_EVAL_STORE_IO.writeFile(handle, serializeBatch(operation, payloads))
      await FILE_EVAL_STORE_IO.close(handle)
    } catch (error) {
      if (handle) await FILE_EVAL_STORE_IO.close(handle).catch(() => undefined)
      const writeError = fileError(
        'WRITE_FAILED',
        'FileEvalStore append did not complete; the mutation was not acknowledged.',
        'append.write', this.filePath, error,
      )
      try {
        await this.truncateAndSync(startSize)
      } catch (rollbackError) {
        this.state = 'failed'
        throw fileError(
          'RECOVERY_REQUIRED',
          'FileEvalStore could not roll back a failed append; reopen is required.',
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
        'FileEvalStore could not rebuild state after a failed mutation.',
        'rollback', this.filePath, recoveryError,
      )
    }
    if (original instanceof Error) return
  }

  private async truncateAndSync(length: number): Promise<void> {
    let handle: FileHandle | undefined
    try {
      handle = await FILE_EVAL_STORE_IO.open(this.filePath, 'r+')
      await FILE_EVAL_STORE_IO.truncate(handle, length)
      await FILE_EVAL_STORE_IO.sync(handle)
      await FILE_EVAL_STORE_IO.close(handle)
      handle = undefined
    } finally {
      if (handle) await FILE_EVAL_STORE_IO.close(handle).catch(() => undefined)
    }
  }

  private async syncTarget(operation: string): Promise<void> {
    let handle: FileHandle | undefined
    try {
      handle = await FILE_EVAL_STORE_IO.open(this.filePath, 'r')
      await FILE_EVAL_STORE_IO.sync(handle)
      await FILE_EVAL_STORE_IO.close(handle)
      handle = undefined
    } catch (error) {
      if (handle) await FILE_EVAL_STORE_IO.close(handle).catch(() => undefined)
      throw fileError(
        'SYNC_FAILED',
        'FileEvalStore could not fsync its data file.',
        operation, this.filePath, error,
      )
    }
  }

  private async parseFile(repairTail: boolean): Promise<ParsedFile> {
    let raw: Buffer
    try {
      raw = await FILE_EVAL_STORE_IO.readFile(this.filePath)
    } catch (error) {
      throw fileError('READ_FAILED', 'FileEvalStore could not read its data file.', 'recover.read', this.filePath, error)
    }
    const memory = new InMemoryEvalStore({ now: this.options.now })
    let offset = 0
    let lineNumber = 0
    let lastCommittedOffset = 0
    let header: FileHeader | undefined
    let pending: PendingBatch | undefined
    while (offset < raw.length) {
      const newline = raw.indexOf(0x0a, offset)
      if (newline === -1) {
        this.emitFileDiagnostic({
          code: 'trailing_partial_line',
          severity: 'warning',
          lineNumber: lineNumber + 1,
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
          'FileEvalStore encountered an empty complete NDJSON line.',
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
        throw this.corruption('FileEvalStore encountered an unknown envelope line type.', lineNumber)
      }
      offset = nextOffset
    }
    if (!header) {
      throw fileError(
        'CORRUPT_FILE',
        'FileEvalStore has no complete version header.',
        'recover', this.filePath,
      )
    }
    const hasPartialLine = offset < raw.length
    if (pending) this.emitFileDiagnostic({
      code: 'incomplete_batch',
      severity: 'warning',
      lineNumber: pending.startLine,
      message: 'An uncommitted trailing batch was ignored and will be truncated.',
    })
    const needsRepair = hasPartialLine || pending !== undefined
    if (needsRepair && repairTail) {
      try {
        await this.truncateAndSync(lastCommittedOffset)
      } catch (error) {
        throw fileError(
          'RECOVERY_FAILED',
          'FileEvalStore could not truncate an incomplete tail during recovery.',
          'recover.truncate', this.filePath, error,
        )
      }
    }
    return { memory, header, ...(needsRepair ? { repairOffset: lastCommittedOffset } : {}) }
  }

  private parseHeader(value: Record<string, unknown>, lineNumber: number): FileHeader {
    if (value['type'] !== 'file_header' || value['format'] !== FILE_EVAL_STORE_FORMAT) {
      throw this.corruption('FileEvalStore header format is invalid.', lineNumber)
    }
    if (value['formatVersion'] !== FILE_EVAL_STORE_FORMAT_VERSION) {
      throw fileError(
        'UNSUPPORTED_FILE_FORMAT',
        'FileEvalStore file format version is unsupported.',
        'recover.header', this.filePath, undefined, lineNumber,
      )
    }
    if (value['evalSchemaMajor'] !== EVAL_STORE_SCHEMA_MAJOR) {
      throw fileError(
        'UNSUPPORTED_EVAL_SCHEMA',
        'FileEvalStore evaluation schema major is unsupported.',
        'recover.header', this.filePath, undefined, lineNumber,
      )
    }
    return HEADER
  }

  private parseBatchStart(value: Record<string, unknown>, lineNumber: number): BatchStart {
    if (value['formatVersion'] !== FILE_EVAL_STORE_FORMAT_VERSION
      || !nonEmpty(value['batchId'])
      || (value['operation'] !== 'append' && value['operation'] !== 'delete')
      || !Number.isInteger(value['itemCount']) || (value['itemCount'] as number) < 0
      || !nonEmpty(value['payloadSha256'])) {
      throw this.corruption('A batch_start envelope is malformed.', lineNumber)
    }
    return value as unknown as BatchStart
  }

  private parseBatchItem(value: Record<string, unknown>, lineNumber: number): BatchItem {
    if (!nonEmpty(value['batchId']) || !Number.isInteger(value['index'])
      || (value['index'] as number) < 0
      || !Object.prototype.hasOwnProperty.call(value, 'payload')) {
      throw this.corruption('A batch_item envelope is malformed.', lineNumber)
    }
    return value as unknown as BatchItem
  }

  private parseBatchCommit(value: Record<string, unknown>, lineNumber: number): BatchCommit {
    if (!nonEmpty(value['batchId']) || !Number.isInteger(value['itemCount'])
      || (value['itemCount'] as number) < 0
      || !nonEmpty(value['payloadSha256'])) {
      throw this.corruption('A batch_commit envelope is malformed.', lineNumber)
    }
    return value as unknown as BatchCommit
  }

  private async applyRecoveredBatch(
    memory: InMemoryEvalStore,
    pending: PendingBatch,
    lineNumber: number,
  ): Promise<void> {
    try {
      if (pending.start.operation === 'append') {
        await memory.append(pending.payloads as EvalRecord[])
      } else {
        const recordIds = pending.payloads.map((payload) => {
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)
            || !nonEmpty((payload as Record<string, unknown>)['recordId'])) {
            throw new Error('invalid-delete-payload')
          }
          return (payload as { recordId: string }).recordId
        })
        memory[EVAL_STORE_INTERNALS]().deleteRecordIds(recordIds)
      }
    } catch (error) {
      if (error instanceof EvalStoreError && error.code === 'UNSUPPORTED_SCHEMA_VERSION') {
        throw fileError(
          'UNSUPPORTED_EVAL_SCHEMA',
          'A committed batch contains an unsupported evaluation schema major.',
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

  private corruption(message: string, lineNumber: number): FileEvalStoreError {
    return fileError('CORRUPT_FILE', message, 'recover', this.filePath, undefined, lineNumber)
  }

  private emitFileDiagnostic(diagnostic: FileEvalStoreDiagnostic): void {
    this.diagnostics.push(diagnostic)
    emitSafely(this.options.onDiagnostic, diagnostic)
  }

  private async syncDirectory(operation: string): Promise<void> {
    let handle: FileHandle | undefined
    try {
      handle = await FILE_EVAL_STORE_IO.open(dirname(this.filePath), 'r')
      await FILE_EVAL_STORE_IO.sync(handle)
      await FILE_EVAL_STORE_IO.close(handle)
      handle = undefined
    } catch (error) {
      if (handle) await FILE_EVAL_STORE_IO.close(handle).catch(() => undefined)
      const code = errno(error)
      if (code && DIRECTORY_SYNC_UNSUPPORTED.has(code)) {
        this.emitFileDiagnostic({
          code: 'directory_sync_unsupported',
          severity: 'warning',
          message: 'The platform/filesystem does not support directory fsync; rename durability is best-effort.',
        })
        return
      }
      throw fileError(
        'SYNC_FAILED',
        'FileEvalStore could not fsync the parent directory after an atomic rename.',
        operation, this.filePath, error,
      )
    }
  }

  private static async pathExists(path: string, operation: string): Promise<boolean> {
    try {
      await FILE_EVAL_STORE_IO.stat(path)
      return true
    } catch (error) {
      if (errno(error) === 'ENOENT') return false
      throw fileError('OPEN_FAILED', 'FileEvalStore could not inspect its filesystem path.', operation, path, error)
    }
  }

  private static async createFile(path: string, options: FileEvalStoreOptions): Promise<void> {
    let handle: FileHandle | undefined
    try {
      await FILE_EVAL_STORE_IO.mkdir(dirname(path), { recursive: true })
      handle = await FILE_EVAL_STORE_IO.open(path, 'wx', 0o600)
      await FILE_EVAL_STORE_IO.chmod(handle, 0o600)
      await FILE_EVAL_STORE_IO.writeFile(handle, `${JSON.stringify(HEADER)}\n`)
      await FILE_EVAL_STORE_IO.sync(handle)
      await FILE_EVAL_STORE_IO.close(handle)
      handle = undefined
      const provisional = new FileEvalStore(
        path,
        new InMemoryEvalStore({ now: options.now }),
        HEADER,
        options,
      )
      await provisional.syncDirectory('open.create')
    } catch (error) {
      if (handle) await FILE_EVAL_STORE_IO.close(handle).catch(() => undefined)
      if (errno(error) === 'EEXIST') return
      throw fileError('OPEN_FAILED', 'FileEvalStore could not create its data file.', 'open.create', path, error)
    }
  }
}
