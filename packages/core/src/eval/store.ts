import type {
  AppendResult,
  DeleteResult,
  Page,
} from '../observability/store.js'
import type { TraceAttributeValue } from '../types.js'
import { EVAL_STORE_SCHEMA_MAJOR, type EvalRecord } from './record.js'

export type EvalStoreErrorCode =
  | 'INVALID_ARGUMENT'
  | 'INVALID_CURSOR'
  | 'UNSUPPORTED_SCHEMA_VERSION'

/** Structured validation failure shared by every EvalStore implementation. */
export class EvalStoreError extends Error {
  readonly name = 'EvalStoreError'

  constructor(
    readonly code: EvalStoreErrorCode,
    message: string,
    readonly field?: string,
  ) {
    super(message)
  }
}

export interface EvalQuery {
  readonly evalRunId?: string | readonly string[]
  /** Match `record.runRef.runId`. */
  readonly runId?: string | readonly string[]
  readonly evalSetName?: string
  readonly scorer?: readonly string[]
  readonly source?: 'offline' | 'online'
  readonly status?: readonly EvalRecord['status'][]
  /** Inclusive ISO-8601 lower bound on `timestampUnixMs`. */
  readonly after?: string
  /** Exclusive ISO-8601 upper bound on `timestampUnixMs`. */
  readonly before?: string
  readonly limit?: number
  readonly cursor?: string
  readonly order?: 'time_desc' | 'time_asc'
}

export interface EvalDeleteQuery {
  readonly evalRunId?: string | readonly string[]
  readonly evalSetName?: string
  /** Exclusive ISO-8601 upper bound on `timestampUnixMs`. */
  readonly before?: string
}

export interface EvalRetentionPolicy {
  readonly maxAgeMs?: number
  readonly maxRecords?: number
  readonly sources?: readonly EvalRecord['source'][]
}

/** Storage-medium-independent append/query contract for evaluation records. */
export interface EvalStore {
  /** Atomic per batch from the caller's view; idempotent by recordId. */
  append(records: readonly EvalRecord[]): Promise<AppendResult>
  query(query?: EvalQuery): Promise<Page<EvalRecord>>
  delete(query: EvalDeleteQuery): Promise<DeleteResult>
  applyRetention(policy: EvalRetentionPolicy): Promise<DeleteResult>
}

export interface InMemoryEvalStoreOptions {
  /** Hard capacity. A batch that would exceed it is rejected atomically. */
  readonly maxRecords?: number
  /** Injectable wall clock used only by retention. */
  readonly now?: () => number
}

interface StoredRecordEntry {
  readonly record: EvalRecord
  readonly revision: number
  readonly arrival: number
}

interface CursorState {
  readonly snapshotRevision: number
  readonly deleteEpoch: number
  readonly queryFingerprint: string
  readonly timestampUnixMs: number
  readonly recordId: string
}

interface NormalizedQuery {
  readonly evalRunIds?: readonly string[]
  readonly runIds?: readonly string[]
  readonly evalSetName?: string
  readonly scorers?: readonly string[]
  readonly source?: EvalRecord['source']
  readonly statuses?: readonly EvalRecord['status'][]
  readonly afterMs?: number
  readonly beforeMs?: number
  readonly limit: number
  readonly order: 'time_desc' | 'time_asc'
}

const EVAL_STATUSES = new Set<EvalRecord['status']>([
  'scored', 'scorer_error', 'target_error', 'skipped',
])
const EVAL_SOURCES = new Set<EvalRecord['source']>(['offline', 'online'])
const TRACE_ERROR_KINDS = new Set([
  'provider', 'tool', 'framework', 'callback', 'validation', 'timeout',
  'cancellation', 'budget', 'store', 'exporter', 'unknown',
])

function cloneJson<T>(value: T, field: string): T {
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) throw new Error('not serializable')
    return JSON.parse(serialized) as T
  } catch {
    throw new EvalStoreError('INVALID_ARGUMENT', `${field} must be JSON-serializable.`, field)
  }
}

function fingerprint(value: unknown): string {
  return JSON.stringify(value)
}

function hash(value: string): string {
  let current = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    current ^= value.charCodeAt(index)
    current = Math.imul(current, 0x01000193)
  }
  return (current >>> 0).toString(36)
}

function objectValue(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new EvalStoreError('INVALID_ARGUMENT', `${field} must be an object.`, field)
  }
}

function nonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new EvalStoreError('INVALID_ARGUMENT', `${field} must be a non-empty string.`, field)
  }
}

function optionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== 'string') {
    throw new EvalStoreError('INVALID_ARGUMENT', `${field} must be a string.`, field)
  }
}

function finiteNumber(value: unknown, field: string, min = 0): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    throw new EvalStoreError('INVALID_ARGUMENT', `${field} must be a finite number >= ${min}.`, field)
  }
}

function nonNegativeInteger(value: unknown, field: string): asserts value is number {
  finiteNumber(value, field)
  if (!Number.isInteger(value)) {
    throw new EvalStoreError('INVALID_ARGUMENT', `${field} must be an integer.`, field)
  }
}

function positiveInteger(value: unknown, field: string): asserts value is number {
  finiteNumber(value, field, 1)
  if (!Number.isInteger(value)) {
    throw new EvalStoreError('INVALID_ARGUMENT', `${field} must be an integer.`, field)
  }
}

function traceAttribute(value: unknown): value is TraceAttributeValue {
  const scalar = typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  if (scalar) return true
  if (!Array.isArray(value)) return false
  const kinds = new Set(value.map((item) => typeof item))
  return kinds.size <= 1 && value.every((item) =>
    typeof item === 'string' || typeof item === 'boolean'
    || (typeof item === 'number' && Number.isFinite(item)))
}

function traceAttributes(value: unknown, field: string): void {
  objectValue(value, field)
  for (const [key, child] of Object.entries(value)) {
    if (!traceAttribute(child)) {
      throw new EvalStoreError(
        'INVALID_ARGUMENT',
        `${field}.${key} is not a supported trace attribute.`,
        `${field}.${key}`,
      )
    }
  }
}

function validateRecord(record: unknown, index: number): asserts record is EvalRecord {
  const prefix = `records[${index}]`
  objectValue(record, prefix)
  if (record['schemaVersion'] !== EVAL_STORE_SCHEMA_MAJOR) {
    if (typeof record['schemaVersion'] === 'number') {
      throw new EvalStoreError(
        'UNSUPPORTED_SCHEMA_VERSION',
        `Unsupported EvalRecord schema major ${record['schemaVersion']}; supported major is ${EVAL_STORE_SCHEMA_MAJOR}.`,
        `${prefix}.schemaVersion`,
      )
    }
    throw new EvalStoreError(
      'INVALID_ARGUMENT',
      `${prefix}.schemaVersion must be ${EVAL_STORE_SCHEMA_MAJOR}.`,
      `${prefix}.schemaVersion`,
    )
  }
  nonEmptyString(record['recordId'], `${prefix}.recordId`)
  nonEmptyString(record['evalRunId'], `${prefix}.evalRunId`)
  if (!EVAL_SOURCES.has(record['source'] as EvalRecord['source'])) {
    throw new EvalStoreError('INVALID_ARGUMENT', `${prefix}.source is invalid.`, `${prefix}.source`)
  }
  nonNegativeInteger(record['timestampUnixMs'], `${prefix}.timestampUnixMs`)
  if (record['evalSet'] !== undefined) {
    objectValue(record['evalSet'], `${prefix}.evalSet`)
    nonEmptyString(record['evalSet']['name'], `${prefix}.evalSet.name`)
    nonEmptyString(record['evalSet']['version'], `${prefix}.evalSet.version`)
  }
  optionalString(record['caseId'], `${prefix}.caseId`)
  if (record['repeat'] !== undefined) positiveInteger(record['repeat'], `${prefix}.repeat`)
  objectValue(record['scorer'], `${prefix}.scorer`)
  nonEmptyString(record['scorer']['name'], `${prefix}.scorer.name`)
  optionalString(record['scorer']['version'], `${prefix}.scorer.version`)
  if (!EVAL_STATUSES.has(record['status'] as EvalRecord['status'])) {
    throw new EvalStoreError('INVALID_ARGUMENT', `${prefix}.status is invalid.`, `${prefix}.status`)
  }
  if (record['score'] !== undefined) {
    finiteNumber(record['score'], `${prefix}.score`)
    if (record['score'] > 1) {
      throw new EvalStoreError('INVALID_ARGUMENT', `${prefix}.score must be <= 1.`, `${prefix}.score`)
    }
  }
  if (record['pass'] !== undefined && typeof record['pass'] !== 'boolean') {
    throw new EvalStoreError('INVALID_ARGUMENT', `${prefix}.pass must be a boolean.`, `${prefix}.pass`)
  }
  optionalString(record['reason'], `${prefix}.reason`)
  if (record['details'] !== undefined) traceAttributes(record['details'], `${prefix}.details`)
  if (record['runRef'] !== undefined) {
    objectValue(record['runRef'], `${prefix}.runRef`)
    nonEmptyString(record['runRef']['runId'], `${prefix}.runRef.runId`)
    positiveInteger(record['runRef']['attempt'], `${prefix}.runRef.attempt`)
    nonEmptyString(record['runRef']['traceId'], `${prefix}.runRef.traceId`)
    nonEmptyString(record['runRef']['rootSpanId'], `${prefix}.runRef.rootSpanId`)
  }
  traceAttributes(record['metadata'], `${prefix}.metadata`)
  if (record['usage'] !== undefined) {
    objectValue(record['usage'], `${prefix}.usage`)
    if (record['usage']['tokens'] !== undefined) {
      objectValue(record['usage']['tokens'], `${prefix}.usage.tokens`)
      nonNegativeInteger(record['usage']['tokens']['input_tokens'], `${prefix}.usage.tokens.input_tokens`)
      nonNegativeInteger(record['usage']['tokens']['output_tokens'], `${prefix}.usage.tokens.output_tokens`)
    }
    if (record['usage']['cost'] !== undefined) {
      objectValue(record['usage']['cost'], `${prefix}.usage.cost`)
      finiteNumber(record['usage']['cost']['amount'], `${prefix}.usage.cost.amount`)
      nonEmptyString(record['usage']['cost']['currency'], `${prefix}.usage.cost.currency`)
    }
    if (record['usage']['durationMs'] !== undefined) {
      finiteNumber(record['usage']['durationMs'], `${prefix}.usage.durationMs`)
    }
  }
  if (record['error'] !== undefined) {
    objectValue(record['error'], `${prefix}.error`)
    if (!TRACE_ERROR_KINDS.has(record['error']['kind'] as string)) {
      throw new EvalStoreError('INVALID_ARGUMENT', `${prefix}.error.kind is invalid.`, `${prefix}.error.kind`)
    }
    for (const key of ['code', 'name', 'message', 'provider'] as const) {
      optionalString(record['error'][key], `${prefix}.error.${key}`)
    }
    if (record['error']['retryable'] !== undefined && typeof record['error']['retryable'] !== 'boolean') {
      throw new EvalStoreError('INVALID_ARGUMENT', `${prefix}.error.retryable must be a boolean.`, `${prefix}.error.retryable`)
    }
    if (record['error']['httpStatus'] !== undefined) {
      nonNegativeInteger(record['error']['httpStatus'], `${prefix}.error.httpStatus`)
    }
    if (record['error']['attempt'] !== undefined) positiveInteger(record['error']['attempt'], `${prefix}.error.attempt`)
  }
  if (record['payload'] !== undefined) {
    objectValue(record['payload'], `${prefix}.payload`)
    optionalString(record['payload']['input'], `${prefix}.payload.input`)
    optionalString(record['payload']['output'], `${prefix}.payload.output`)
    optionalString(record['payload']['expected'], `${prefix}.payload.expected`)
  }
}

function stringList(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined) return undefined
  const values = typeof value === 'string' ? [value] : value
  if (!Array.isArray(values) || values.length === 0
    || values.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new EvalStoreError('INVALID_ARGUMENT', `${field} must contain non-empty strings.`, field)
  }
  return [...new Set(values)].sort()
}

function stringArray(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new EvalStoreError('INVALID_ARGUMENT', `${field} must be an array of non-empty strings.`, field)
  }
  return stringList(value, field)
}

function statusList(value: unknown, field: string): readonly EvalRecord['status'][] | undefined {
  const values = stringArray(value, field)
  if (!values) return undefined
  if (values.some((status) => !EVAL_STATUSES.has(status as EvalRecord['status']))) {
    throw new EvalStoreError('INVALID_ARGUMENT', `${field} contains an unsupported status.`, field)
  }
  return values as EvalRecord['status'][]
}

function sourceList(value: unknown, field: string): readonly EvalRecord['source'][] | undefined {
  const values = stringArray(value, field)
  if (!values) return undefined
  if (values.some((source) => !EVAL_SOURCES.has(source as EvalRecord['source']))) {
    throw new EvalStoreError('INVALID_ARGUMENT', `${field} contains an unsupported source.`, field)
  }
  return values as EvalRecord['source'][]
}

function parseDate(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || !Number.isFinite(Date.parse(value))) {
    throw new EvalStoreError('INVALID_ARGUMENT', `${field} must be a valid ISO-8601 timestamp.`, field)
  }
  return Date.parse(value)
}

function normalizeQuery(query: EvalQuery = {}): NormalizedQuery {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw new EvalStoreError('INVALID_ARGUMENT', 'query must be an object.', 'query')
  }
  const limit = query.limit ?? 100
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new EvalStoreError('INVALID_ARGUMENT', 'limit must be an integer from 1 through 1000.', 'limit')
  }
  if (query.order !== undefined && query.order !== 'time_asc' && query.order !== 'time_desc') {
    throw new EvalStoreError('INVALID_ARGUMENT', 'order must be time_asc or time_desc.', 'order')
  }
  const afterMs = parseDate(query.after, 'after')
  const beforeMs = parseDate(query.before, 'before')
  if (afterMs !== undefined && beforeMs !== undefined && afterMs >= beforeMs) {
    throw new EvalStoreError('INVALID_ARGUMENT', 'after must be before before.', 'after')
  }
  if (query.evalSetName !== undefined) nonEmptyString(query.evalSetName, 'evalSetName')
  if (query.source !== undefined && !EVAL_SOURCES.has(query.source)) {
    throw new EvalStoreError('INVALID_ARGUMENT', 'source must be offline or online.', 'source')
  }
  const evalRunIds = stringList(query.evalRunId, 'evalRunId')
  const runIds = stringList(query.runId, 'runId')
  const scorers = stringArray(query.scorer, 'scorer')
  const statuses = statusList(query.status, 'status')
  return {
    ...(evalRunIds ? { evalRunIds } : {}),
    ...(runIds ? { runIds } : {}),
    ...(query.evalSetName !== undefined ? { evalSetName: query.evalSetName } : {}),
    ...(scorers ? { scorers } : {}),
    ...(query.source !== undefined ? { source: query.source } : {}),
    ...(statuses ? { statuses } : {}),
    ...(afterMs !== undefined ? { afterMs } : {}),
    ...(beforeMs !== undefined ? { beforeMs } : {}),
    limit,
    order: query.order ?? 'time_desc',
  }
}

function queryIdentity(query: NormalizedQuery): string {
  const { limit: _limit, ...identity } = query
  return JSON.stringify(identity)
}

function matches(record: EvalRecord, query: NormalizedQuery): boolean {
  return (!query.evalRunIds || query.evalRunIds.includes(record.evalRunId))
    && (!query.runIds || (record.runRef !== undefined && query.runIds.includes(record.runRef.runId)))
    && (query.evalSetName === undefined || record.evalSet?.name === query.evalSetName)
    && (!query.scorers || query.scorers.includes(record.scorer.name))
    && (query.source === undefined || record.source === query.source)
    && (!query.statuses || query.statuses.includes(record.status))
    && (query.afterMs === undefined || record.timestampUnixMs >= query.afterMs)
    && (query.beforeMs === undefined || record.timestampUnixMs < query.beforeMs)
}

function compareRecords(
  left: EvalRecord,
  right: EvalRecord,
  order: NormalizedQuery['order'],
): number {
  const time = left.timestampUnixMs - right.timestampUnixMs
  const stable = time || left.recordId.localeCompare(right.recordId)
  return order === 'time_asc' ? stable : -stable
}

/** @internal FileEvalStore recovery bridge; intentionally not re-exported. */
export const EVAL_STORE_INTERNALS: unique symbol = Symbol('oma.eval-store-internals')

/** @internal */
export interface EvalStoreInternals {
  records(): readonly EvalRecord[]
  deleteRecordIds(recordIds: readonly string[]): DeleteResult
}

/** Non-durable reference EvalStore for tests and short-lived local runs. */
export class InMemoryEvalStore implements EvalStore {
  private readonly entries: StoredRecordEntry[] = []
  private readonly seen = new Map<string, string>()
  private revision = 0
  private arrival = 0
  private deleteEpoch = 0
  private readonly cursorSecret = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  private readonly now: () => number
  private readonly maxRecords?: number

  constructor(options: InMemoryEvalStoreOptions = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new EvalStoreError('INVALID_ARGUMENT', 'options must be an object.', 'options')
    }
    if (options.maxRecords !== undefined) {
      nonNegativeInteger(options.maxRecords, 'maxRecords')
      this.maxRecords = options.maxRecords
    }
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw new EvalStoreError('INVALID_ARGUMENT', 'now must be a function.', 'now')
    }
    this.now = options.now ?? Date.now
  }

  async append(records: readonly EvalRecord[]): Promise<AppendResult> {
    if (!Array.isArray(records)) {
      throw new EvalStoreError('INVALID_ARGUMENT', 'records must be an array.', 'records')
    }
    records.forEach(validateRecord)
    const snapshots = records.map((record, index) => cloneJson(record, `records[${index}]`))
    const stagedSeen = new Map(this.seen)
    const writes: EvalRecord[] = []
    let deduplicated = 0
    for (const record of snapshots) {
      if (stagedSeen.has(record.recordId)) {
        deduplicated++
        continue
      }
      writes.push(record)
      stagedSeen.set(record.recordId, fingerprint(record))
    }
    if (this.maxRecords !== undefined && this.entries.length + writes.length > this.maxRecords) {
      throw new EvalStoreError(
        'INVALID_ARGUMENT',
        `append would exceed the InMemoryEvalStore maxRecords capacity of ${this.maxRecords}.`,
        'records',
      )
    }

    const revision = writes.length > 0 ? this.revision + 1 : this.revision
    for (const record of writes) this.entries.push({ record, revision, arrival: ++this.arrival })
    if (writes.length > 0) this.revision = revision
    this.seen.clear()
    for (const [key, value] of stagedSeen) this.seen.set(key, value)
    return { written: writes.length, deduplicated, diagnostics: [] }
  }

  async query(query: EvalQuery = {}): Promise<Page<EvalRecord>> {
    const normalized = normalizeQuery(query)
    const identity = queryIdentity(normalized)
    let snapshotRevision = this.revision
    let after: Pick<CursorState, 'timestampUnixMs' | 'recordId'> | undefined
    if (query.cursor !== undefined) {
      const state = this.decodeCursor(query.cursor)
      if (state.queryFingerprint !== identity || state.deleteEpoch !== this.deleteEpoch) {
        throw new EvalStoreError(
          'INVALID_CURSOR',
          'Cursor does not match this query or is no longer valid.',
          'cursor',
        )
      }
      snapshotRevision = state.snapshotRevision
      after = state
    }
    const records = this.entries
      .filter((entry) => entry.revision <= snapshotRevision)
      .map((entry) => entry.record)
      .filter((record) => matches(record, normalized))
      .sort((left, right) => compareRecords(left, right, normalized.order))
    const startIndex = after
      ? records.findIndex((record) =>
        record.timestampUnixMs === after!.timestampUnixMs && record.recordId === after!.recordId) + 1
      : 0
    if (after && startIndex === 0) {
      throw new EvalStoreError(
        'INVALID_CURSOR',
        'Cursor position is not present in the query snapshot.',
        'cursor',
      )
    }
    const items = records.slice(startIndex, startIndex + normalized.limit)
    const hasMore = startIndex + items.length < records.length
    const nextCursor = hasMore && items.length > 0
      ? this.encodeCursor({
        snapshotRevision,
        deleteEpoch: this.deleteEpoch,
        queryFingerprint: identity,
        timestampUnixMs: items.at(-1)!.timestampUnixMs,
        recordId: items.at(-1)!.recordId,
      })
      : undefined
    return cloneJson({ items, ...(nextCursor ? { nextCursor } : {}) }, 'page')
  }

  async delete(query: EvalDeleteQuery): Promise<DeleteResult> {
    if (!query || typeof query !== 'object' || Array.isArray(query)) {
      throw new EvalStoreError('INVALID_ARGUMENT', 'query must be an object.', 'query')
    }
    const evalRunIds = stringList(query.evalRunId, 'evalRunId')
    if (query.evalSetName !== undefined) nonEmptyString(query.evalSetName, 'evalSetName')
    const beforeMs = parseDate(query.before, 'before')
    const recordIds = this.entries
      .map((entry) => entry.record)
      .filter((record) =>
        (!evalRunIds || evalRunIds.includes(record.evalRunId))
        && (query.evalSetName === undefined || record.evalSet?.name === query.evalSetName)
        && (beforeMs === undefined || record.timestampUnixMs < beforeMs))
      .sort((left, right) => compareRecords(left, right, 'time_asc'))
      .map((record) => record.recordId)
    return this.deleteRecordIds(recordIds)
  }

  async applyRetention(policy: EvalRetentionPolicy): Promise<DeleteResult> {
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
      throw new EvalStoreError('INVALID_ARGUMENT', 'policy must be an object.', 'policy')
    }
    if (policy.maxAgeMs === undefined && policy.maxRecords === undefined && policy.sources === undefined) {
      throw new EvalStoreError(
        'INVALID_ARGUMENT',
        'Retention policy must set maxAgeMs, maxRecords, or sources.',
        'policy',
      )
    }
    if (policy.maxAgeMs !== undefined) finiteNumber(policy.maxAgeMs, 'maxAgeMs')
    if (policy.maxRecords !== undefined) nonNegativeInteger(policy.maxRecords, 'maxRecords')
    const sources = sourceList(policy.sources, 'sources')
    let scoped = this.entries
      .map((entry) => entry.record)
      .filter((record) => !sources || sources.includes(record.source))
    const deleteIds = new Set<string>()
    if (policy.maxAgeMs !== undefined) {
      const cutoff = this.now() - policy.maxAgeMs
      for (const record of scoped) {
        if (record.timestampUnixMs < cutoff) deleteIds.add(record.recordId)
      }
    }
    if (policy.maxRecords !== undefined) {
      scoped = scoped.sort((left, right) => compareRecords(left, right, 'time_desc'))
      for (const record of scoped.slice(policy.maxRecords)) deleteIds.add(record.recordId)
    } else if (policy.maxAgeMs === undefined && sources) {
      for (const record of scoped) deleteIds.add(record.recordId)
    }
    const ordered = this.entries
      .map((entry) => entry.record)
      .filter((record) => deleteIds.has(record.recordId))
      .sort((left, right) => compareRecords(left, right, 'time_asc'))
      .map((record) => record.recordId)
    return this.deleteRecordIds(ordered)
  }

  [EVAL_STORE_INTERNALS](): EvalStoreInternals {
    return {
      records: () => cloneJson(
        [...this.entries]
          .sort((left, right) => left.arrival - right.arrival)
          .map((entry) => entry.record),
        'records',
      ),
      deleteRecordIds: (recordIds) => this.deleteRecordIds(recordIds),
    }
  }

  private deleteRecordIds(recordIds: readonly string[]): DeleteResult {
    const requested = new Set(recordIds)
    if (requested.size === 0) return { runsDeleted: 0, recordsDeleted: 0, runIds: [] }
    const records = this.entries
      .map((entry) => entry.record)
      .filter((record) => requested.has(record.recordId))
      .sort((left, right) => compareRecords(left, right, 'time_asc'))
    if (records.length === 0) return { runsDeleted: 0, recordsDeleted: 0, runIds: [] }
    for (let index = this.entries.length - 1; index >= 0; index--) {
      if (requested.has(this.entries[index]!.record.recordId)) this.entries.splice(index, 1)
    }
    for (const record of records) this.seen.delete(record.recordId)
    this.deleteEpoch++
    const runIds = records
      .map((record) => record.evalRunId)
      .filter((runId, index, all) => all.indexOf(runId) === index)
    return cloneJson({
      runsDeleted: runIds.length,
      recordsDeleted: records.length,
      runIds,
    }, 'deleteResult')
  }

  private encodeCursor(state: CursorState): string {
    const body = encodeURIComponent(JSON.stringify(state))
    return `oma-es1.${body}.${hash(`${this.cursorSecret}:${body}`)}`
  }

  private decodeCursor(cursor: unknown): CursorState {
    if (typeof cursor !== 'string' || cursor.length === 0) {
      throw new EvalStoreError('INVALID_CURSOR', 'cursor must be an opaque non-empty string.', 'cursor')
    }
    const match = /^oma-es1\.(.+)\.([a-z0-9]+)$/.exec(cursor)
    if (!match || hash(`${this.cursorSecret}:${match[1]}`) !== match[2]) {
      throw new EvalStoreError('INVALID_CURSOR', 'Cursor is invalid or has been tampered with.', 'cursor')
    }
    try {
      const state = JSON.parse(decodeURIComponent(match[1]!)) as Partial<CursorState>
      if (!Number.isInteger(state.snapshotRevision) || !Number.isInteger(state.deleteEpoch)
        || typeof state.queryFingerprint !== 'string'
        || !Number.isInteger(state.timestampUnixMs)
        || typeof state.recordId !== 'string') throw new Error('invalid')
      return state as CursorState
    } catch {
      throw new EvalStoreError('INVALID_CURSOR', 'Cursor payload is invalid.', 'cursor')
    }
  }
}
