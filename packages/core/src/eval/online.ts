import { classifyRunFailure } from '../observability/status.js'
import type { FlushOptions, FlushResult } from '../observability/sink.js'
import type {
  AgentRunResult,
  ConsensusResult,
  CostEstimateContext,
  RunIdentity,
  RunStatus,
  TeamRunResult,
  TokenUsage,
  TraceAttributeValue,
} from '../types.js'
import { redactSensitiveText } from '../utils/redaction.js'
import type { EvalCase } from './evalcase.js'
import type { EvalRecord } from './record.js'
import {
  scoreCostInputs,
  type ScoreResult,
  type Scorer,
  type ScorerContext,
} from './scorer.js'
import type { EvalStore } from './store.js'

const DEFAULT_MAX_CONCURRENT = 1
const DEFAULT_MAX_QUEUE_LENGTH = 100
const DEFAULT_FLUSH_TIMEOUT_MS = 30_000
const DIAGNOSTIC_INTERVAL_MS = 60_000
const PAYLOAD_MAX_CHARS = 8 * 1024
const REASON_MAX_CHARS = 1_024

type OnlineRunResult = AgentRunResult | TeamRunResult | ConsensusResult

export interface OnlineSampleContext {
  readonly identity: RunIdentity
  readonly status: RunStatus
  readonly metadata: Readonly<Record<string, TraceAttributeValue>>
  readonly durationMs: number
}

export interface EvalDiagnostic {
  readonly code:
    | 'queue_full'
    | 'budget_exhausted'
    | 'scorer_failed'
    | 'store_append_failed'
    | 'flush_timeout'
    | 'enqueue_after_shutdown'
  readonly severity: 'warning' | 'error'
  /** Number of occurrences aggregated since the previous emitted diagnostic. */
  readonly count: number
  readonly scorerName?: string
  /** Fixed, payload-free message. Never contains run content or credentials. */
  readonly message: string
}

export interface OnlineEvaluationConfig {
  readonly scorers: readonly Scorer[]
  /** Number in [0,1], or a rule evaluated after a top-level run settles. */
  readonly sample: number | ((context: OnlineSampleContext) => boolean)
  readonly maxConcurrent?: number
  readonly maxQueueLength?: number
  readonly budget?: {
    readonly maxEvaluationsPerMinute?: number
    readonly maxCostPerHour?: number
  }
  readonly store?: EvalStore
  readonly storePayloads?: 'none' | 'redacted' | 'full'
  readonly onResult?: (record: EvalRecord) => void
  readonly onDiagnostic?: (diagnostic: EvalDiagnostic) => void
  readonly diagnostics?: 'warn' | 'silent'
}

export interface OnlineEvaluationStats {
  readonly sampled: number
  readonly enqueued: number
  readonly completed: number
  readonly dropped: number
  readonly failed: number
  readonly storeFailed: number
}

export interface OnlineEvaluationLifecycle {
  forceFlush(options?: FlushOptions): Promise<FlushResult>
  shutdown(options?: FlushOptions): Promise<FlushResult>
  getStats(): OnlineEvaluationStats
}

/** Internal hand-off from a top-level OMA entry point to the async evaluator. */
export interface OnlineEvaluationInput {
  readonly input: unknown
  readonly result: OnlineRunResult
  readonly durationMs: number
}

interface MutableStats {
  sampled: number
  enqueued: number
  completed: number
  dropped: number
  failed: number
  storeFailed: number
}

interface QueueEntry {
  readonly id: number
  readonly sample: OnlineEvaluationInput
  readonly context: OnlineSampleContext
}

interface EvaluationReservation {
  readonly entryId: number
  readonly at: number
  readonly count: number
}

interface CostEntry {
  readonly at: number
  readonly amount: number
}

interface OnlineEvaluatorRuntime {
  readonly now?: () => number
  readonly random?: () => number
  readonly estimateCost?: (usage: TokenUsage, context: CostEstimateContext) => number
}

class ScorerTimeoutError extends Error {
  constructor(scorerName: string, timeoutMs: number) {
    super(`Scorer "${scorerName}" timed out after ${timeoutMs}ms.`)
    this.name = 'TimeoutError'
  }
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer.`)
  }
  return value
}

function optionalPositiveInteger(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  return positiveInteger(value, value, name)
}

function positiveFinite(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number.`)
  }
  return value
}

function createId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid === undefined
    ? `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
    : `${prefix}_${uuid}`
}

function unrefTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(callback, delayMs)
  timer.unref?.()
  return timer
}

function stringifyPayload(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    const serialized = JSON.stringify(value)
    return serialized === undefined ? String(value) : serialized
  } catch {
    return String(value)
  }
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  const marker = `\n[truncated at ${maxChars} characters]`
  return `${value.slice(0, Math.max(0, maxChars - marker.length))}${marker}`
}

function sanitizeText(value: string, maxChars: number): string {
  return truncate(redactSensitiveText(value), maxChars)
}

function inputDescription(value: unknown): string {
  if (typeof value === 'string') return `[string input omitted; ${value.length} characters]`
  if (Array.isArray(value)) return `[array input omitted; ${value.length} items]`
  if (value === null) return '[null input]'
  if (value === undefined) return '[undefined input]'
  return `[${typeof value} input omitted]`
}

function storedPayload(
  mode: NonNullable<OnlineEvaluationConfig['storePayloads']>,
  input: unknown,
  output: unknown,
): EvalRecord['payload'] {
  if (mode === 'none') return undefined
  const serialize = (value: unknown): string => {
    const bounded = truncate(stringifyPayload(value), PAYLOAD_MAX_CHARS)
    return mode === 'redacted' ? sanitizeText(bounded, PAYLOAD_MAX_CHARS) : bounded
  }
  return {
    ...(input !== undefined ? { input: serialize(input) } : {}),
    ...(output !== undefined ? { output: serialize(output) } : {}),
  }
}

function scorerInput(
  mode: NonNullable<OnlineEvaluationConfig['storePayloads']>,
  input: unknown,
): unknown {
  if (mode === 'none') return inputDescription(input)
  const bounded = truncate(stringifyPayload(input), PAYLOAD_MAX_CHARS)
  return mode === 'redacted' ? sanitizeText(bounded, PAYLOAD_MAX_CHARS) : bounded
}

function resultOutput(result: OnlineRunResult): unknown {
  if ('output' in result) return result.output
  if ('answer' in result) return result.answer
  const coordinator = result.agentResults.get('coordinator')?.output
  if (coordinator !== undefined) return coordinator
  return [...result.agentResults.values()]
    .map((agentResult) => agentResult.output)
    .filter(Boolean)
    .join('\n\n---\n\n')
}

function resultTokens(result: OnlineRunResult): TokenUsage {
  return 'totalTokenUsage' in result ? result.totalTokenUsage : result.tokenUsage
}

function runRef(identity: RunIdentity): NonNullable<EvalRecord['runRef']> {
  return {
    runId: identity.runId,
    attempt: identity.attempt,
    traceId: identity.traceId,
    rootSpanId: identity.rootSpanId,
  }
}

function sanitizeDetails(
  details: Readonly<Record<string, TraceAttributeValue>> | undefined,
): Readonly<Record<string, TraceAttributeValue>> | undefined {
  if (details === undefined) return undefined
  const sanitized: Record<string, TraceAttributeValue> = {}
  for (const [key, value] of Object.entries(details)) {
    if (typeof value === 'string') sanitized[key] = sanitizeText(value, REASON_MAX_CHARS)
    else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      sanitized[key] = value.map((item) => sanitizeText(item, REASON_MAX_CHARS))
    } else sanitized[key] = value
  }
  return Object.freeze(sanitized)
}

async function scoreWithTimeout(
  scorer: Scorer,
  context: ScorerContext,
): Promise<ScoreResult> {
  if (scorer.timeoutMs === undefined) {
    return Promise.resolve().then(() => scorer.score(context))
  }

  const timeoutMs = Math.max(0, scorer.timeoutMs)
  const controller = new AbortController()
  const onAbort = (): void => controller.abort(context.signal.reason)
  if (context.signal.aborted) onAbort()
  else context.signal.addEventListener('abort', onAbort, { once: true })

  return new Promise<ScoreResult>((resolve, reject) => {
    const timer = unrefTimer(() => {
      const error = new ScorerTimeoutError(scorer.name, timeoutMs)
      controller.abort(error)
      context.signal.removeEventListener('abort', onAbort)
      reject(error)
    }, timeoutMs)

    Promise.resolve().then(() => scorer.score({ ...context, signal: controller.signal })).then(
      (value) => {
        clearTimeout(timer)
        context.signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        context.signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

const EMPTY_STATS: OnlineEvaluationStats = Object.freeze({
  sampled: 0,
  enqueued: 0,
  completed: 0,
  dropped: 0,
  failed: 0,
  storeFailed: 0,
})

const EMPTY_FLUSH: FlushResult = Object.freeze({
  status: 'ok',
  accepted: 0,
  exported: 0,
  dropped: 0,
  failed: 0,
})

/** Shared lifecycle facade used when online evaluation is disabled. */
export const NOOP_ONLINE_EVALUATION: OnlineEvaluationLifecycle = Object.freeze({
  async forceFlush() { return EMPTY_FLUSH },
  async shutdown() { return EMPTY_FLUSH },
  getStats() { return EMPTY_STATS },
})

/** Bounded, best-effort online evaluator used by one OpenMultiAgent instance. */
export class OnlineEvaluator implements OnlineEvaluationLifecycle {
  private readonly scorers: readonly Scorer[]
  private readonly sample: OnlineEvaluationConfig['sample']
  private readonly maxConcurrent: number
  private readonly maxQueueLength: number
  private readonly maxEvaluationsPerMinute?: number
  private readonly maxCostPerHour?: number
  private readonly store?: EvalStore
  private readonly storePayloads: NonNullable<OnlineEvaluationConfig['storePayloads']>
  private readonly onResult?: OnlineEvaluationConfig['onResult']
  private readonly onDiagnostic?: OnlineEvaluationConfig['onDiagnostic']
  private readonly diagnosticMode: NonNullable<OnlineEvaluationConfig['diagnostics']>
  private readonly now: () => number
  private readonly random: () => number
  private readonly estimateCost?: OnlineEvaluatorRuntime['estimateCost']
  private readonly queue: QueueEntry[] = []
  private readonly reservations: EvaluationReservation[] = []
  private readonly costs: CostEntry[] = []
  private readonly diagnosticCounts = new Map<EvalDiagnostic['code'], number>()
  private readonly diagnosticLastEmitted = new Map<EvalDiagnostic['code'], number>()
  private readonly settledOutOfOrder = new Set<number>()
  private readonly waiters = new Set<() => void>()
  private readonly mutable: MutableStats = {
    sampled: 0,
    enqueued: 0,
    completed: 0,
    dropped: 0,
    failed: 0,
    storeFailed: 0,
  }
  private readonly evalRunId = createId('online_eval')
  private nextId = 0
  private settledThrough = 0
  private active = 0
  private scheduled?: ReturnType<typeof setTimeout>
  private closing = false
  private shutdownPromise?: Promise<FlushResult>

  constructor(config: OnlineEvaluationConfig, runtime: OnlineEvaluatorRuntime = {}) {
    if (!Array.isArray(config.scorers) || config.scorers.length === 0) {
      throw new TypeError('OnlineEvaluationConfig.scorers must contain at least one scorer.')
    }
    if (
      typeof config.sample !== 'function'
      && (typeof config.sample !== 'number'
        || !Number.isFinite(config.sample)
        || config.sample < 0
        || config.sample > 1)
    ) {
      throw new RangeError('OnlineEvaluationConfig.sample must be a number in [0, 1] or a function.')
    }
    if (
      config.storePayloads !== undefined
      && config.storePayloads !== 'none'
      && config.storePayloads !== 'redacted'
      && config.storePayloads !== 'full'
    ) {
      throw new TypeError('OnlineEvaluationConfig.storePayloads must be none, redacted, or full.')
    }

    this.scorers = Object.freeze([...config.scorers])
    this.sample = config.sample
    this.maxConcurrent = positiveInteger(config.maxConcurrent, DEFAULT_MAX_CONCURRENT, 'maxConcurrent')
    this.maxQueueLength = positiveInteger(config.maxQueueLength, DEFAULT_MAX_QUEUE_LENGTH, 'maxQueueLength')
    this.maxEvaluationsPerMinute = optionalPositiveInteger(
      config.budget?.maxEvaluationsPerMinute,
      'budget.maxEvaluationsPerMinute',
    )
    this.maxCostPerHour = positiveFinite(config.budget?.maxCostPerHour, 'budget.maxCostPerHour')
    this.store = config.store
    this.storePayloads = config.storePayloads ?? 'none'
    this.onResult = config.onResult
    this.onDiagnostic = config.onDiagnostic
    this.diagnosticMode = config.diagnostics ?? 'warn'
    this.now = runtime.now ?? Date.now
    this.random = runtime.random ?? Math.random
    this.estimateCost = runtime.estimateCost

    if (this.maxCostPerHour !== undefined && this.estimateCost === undefined) {
      this.report(
        'budget_exhausted',
        'Cost budget is inactive because no estimateCost function was configured.',
      )
    }
  }

  /** Synchronously decide, budget, and enqueue one settled top-level run. */
  enqueue(sample: OnlineEvaluationInput): boolean {
    if (this.closing) {
      this.mutable.dropped++
      this.report('enqueue_after_shutdown', 'Online evaluation rejected after shutdown began.')
      return false
    }

    const identity = sample.result.identity
    if (identity === undefined) {
      this.mutable.failed++
      this.report('scorer_failed', 'Online evaluation skipped a run without runtime identity.', 'error')
      return false
    }
    const status: RunStatus = sample.result.status ?? {
      code: 'error',
      message: 'Run settled without a normalized status.',
    }
    const context: OnlineSampleContext = Object.freeze({
      identity,
      status,
      metadata: Object.freeze({ ...sample.result.metadata }),
      durationMs: Math.max(0, sample.durationMs),
    })

    if (!this.shouldSample(context)) return false
    this.mutable.sampled++

    if (this.queue.length >= this.maxQueueLength) {
      this.mutable.dropped++
      this.report('queue_full', 'Online evaluation sample dropped because the bounded queue is full.')
      return false
    }

    const now = this.now()
    this.pruneBudgets(now)
    if (this.costBudgetExhausted()) {
      this.mutable.dropped++
      this.report('budget_exhausted', 'Online evaluation cost budget is exhausted.')
      return false
    }
    const evaluationCount = this.scorers.length
    if (!this.reserveEvaluations(this.nextId + 1, evaluationCount, now)) {
      this.mutable.dropped++
      this.report('budget_exhausted', 'Online evaluation rate budget is exhausted.')
      return false
    }

    const entry: QueueEntry = {
      id: ++this.nextId,
      sample,
      context,
    }
    this.mutable.enqueued++
    this.queue.push(entry)
    this.schedule()
    return true
  }

  async forceFlush(options: FlushOptions = {}): Promise<FlushResult> {
    const target = this.nextId
    if (target <= this.settledThrough) return this.flushResult(this.resultStatus())
    this.clearSchedule()
    this.startWorkers()
    const completed = await this.waitForWatermark(
      target,
      options.timeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS,
    )
    if (!completed) {
      this.report('flush_timeout', 'Online evaluation flush timed out before queued samples settled.')
      return this.flushResult('timeout')
    }
    return this.flushResult(this.resultStatus())
  }

  shutdown(options: FlushOptions = {}): Promise<FlushResult> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.closing = true
    this.clearSchedule()
    this.shutdownPromise = this.forceFlush(options)
    return this.shutdownPromise
  }

  getStats(): OnlineEvaluationStats {
    return { ...this.mutable }
  }

  private shouldSample(context: OnlineSampleContext): boolean {
    if (typeof this.sample === 'number') return this.random() < this.sample
    try {
      return this.sample(context) === true
    } catch {
      this.report('scorer_failed', 'Online sampling rule failed; the run was not sampled.', 'error')
      return false
    }
  }

  private schedule(): void {
    if (this.scheduled !== undefined || this.active > 0) return
    this.scheduled = unrefTimer(() => {
      this.scheduled = undefined
      this.startWorkers()
    }, 0)
  }

  private clearSchedule(): void {
    if (this.scheduled !== undefined) clearTimeout(this.scheduled)
    this.scheduled = undefined
  }

  private startWorkers(): void {
    while (this.active < this.maxConcurrent) {
      const entry = this.queue.shift()
      if (entry === undefined) break
      this.active++
      void this.process(entry).catch(() => {
        this.mutable.failed++
        this.report('scorer_failed', 'Online evaluation worker failed unexpectedly.', 'error')
      }).finally(() => {
        this.active--
        this.settle(entry.id)
        this.startWorkers()
      })
    }
  }

  private async process(entry: QueueEntry): Promise<void> {
    const now = this.now()
    this.pruneBudgets(now)
    if (this.costBudgetExhausted()) {
      this.releaseReservation(entry.id)
      this.mutable.dropped++
      this.report('budget_exhausted', 'Online evaluation cost budget is exhausted.')
      return
    }

    const output = resultOutput(entry.sample.result)
    const evalCase: EvalCase = Object.freeze({
      id: entry.context.identity.runId,
      input: scorerInput(this.storePayloads, entry.sample.input),
      metadata: entry.context.metadata,
    })
    const payload = storedPayload(this.storePayloads, entry.sample.input, output)
    const signal = new AbortController().signal
    const records: EvalRecord[] = []

    for (const scorer of this.scorers) {
      try {
        const scored = await scoreWithTimeout(scorer, {
          evalCase,
          output,
          result: entry.sample.result,
          metadata: entry.context.metadata,
          signal,
        })
        this.mutable.completed++
        this.recordCost(scored)
        const details = sanitizeDetails(scored.details)
        records.push({
          ...this.baseRecord(entry.context, scorer),
          status: 'scored',
          score: scored.score,
          ...(scored.pass !== undefined ? { pass: scored.pass } : {}),
          ...(scored.reason !== undefined
            ? { reason: sanitizeText(scored.reason, REASON_MAX_CHARS) }
            : {}),
          ...(details !== undefined ? { details } : {}),
          usage: {
            tokens: resultTokens(entry.sample.result),
            durationMs: entry.context.durationMs,
          },
          ...(payload !== undefined ? { payload } : {}),
        })
      } catch (error) {
        this.mutable.failed++
        this.recordCost(error)
        const timeout = error instanceof ScorerTimeoutError
        records.push({
          ...this.baseRecord(entry.context, scorer),
          status: 'scorer_error',
          usage: {
            tokens: resultTokens(entry.sample.result),
            durationMs: entry.context.durationMs,
          },
          error: classifyRunFailure(error, timeout
            ? { kind: 'timeout', statusCode: 'timeout' }
            : {}).errorInfo,
          ...(payload !== undefined ? { payload } : {}),
        })
        this.report(
          'scorer_failed',
          'Online evaluation scorer failed; a scorer_error record was produced.',
          'error',
          scorer.name,
        )
      }
    }

    if (this.store !== undefined) {
      try {
        await this.store.append(records)
      } catch {
        this.mutable.storeFailed += records.length
        this.report(
          'store_append_failed',
          'Online evaluation records were discarded because EvalStore append failed.',
          'error',
        )
        return
      }
    }

    for (const record of records) {
      try {
        this.onResult?.(record)
      } catch {
        this.mutable.failed++
      }
    }
  }

  private baseRecord(
    context: OnlineSampleContext,
    scorer: Scorer,
  ): Pick<EvalRecord,
    'schemaVersion' | 'recordId' | 'evalRunId' | 'source' | 'timestampUnixMs'
    | 'scorer' | 'runRef' | 'metadata'> {
    return {
      schemaVersion: 1,
      recordId: createId('eval_record'),
      evalRunId: this.evalRunId,
      source: 'online',
      timestampUnixMs: this.now(),
      scorer: {
        name: scorer.name,
        ...(scorer.version !== undefined ? { version: scorer.version } : {}),
      },
      runRef: runRef(context.identity),
      metadata: context.metadata,
    }
  }

  private recordCost(scored: unknown): void {
    if (this.maxCostPerHour === undefined || this.estimateCost === undefined) return
    let amount = 0
    try {
      for (const input of scoreCostInputs(scored)) {
        const estimated = this.estimateCost(input.usage, input.context)
        if (!Number.isFinite(estimated) || estimated < 0) {
          throw new Error('estimateCost returned an invalid amount.')
        }
        amount += estimated
      }
    } catch {
      this.mutable.failed++
      this.report(
        'budget_exhausted',
        'Online evaluation cost could not be estimated; the cost budget remains best-effort.',
      )
      return
    }
    if (amount > 0) this.costs.push({ at: this.now(), amount })
  }

  private pruneBudgets(now: number): void {
    while (this.reservations[0] && this.reservations[0].at <= now - 60_000) {
      this.reservations.shift()
    }
    while (this.costs[0] && this.costs[0].at <= now - 3_600_000) {
      this.costs.shift()
    }
  }

  private reserveEvaluations(entryId: number, count: number, now: number): boolean {
    if (this.maxEvaluationsPerMinute === undefined) return true
    const used = this.reservations.reduce((sum, reservation) => sum + reservation.count, 0)
    if (used + count > this.maxEvaluationsPerMinute) return false
    this.reservations.push({ entryId, at: now, count })
    return true
  }

  private releaseReservation(entryId: number): void {
    const index = this.reservations.findIndex((reservation) => reservation.entryId === entryId)
    if (index >= 0) this.reservations.splice(index, 1)
  }

  private costBudgetExhausted(): boolean {
    if (this.maxCostPerHour === undefined || this.estimateCost === undefined) return false
    return this.costs.reduce((sum, entry) => sum + entry.amount, 0) >= this.maxCostPerHour
  }

  private report(
    code: EvalDiagnostic['code'],
    message: string,
    severity: EvalDiagnostic['severity'] = 'warning',
    scorerName?: string,
  ): void {
    const count = (this.diagnosticCounts.get(code) ?? 0) + 1
    this.diagnosticCounts.set(code, count)
    const now = this.now()
    if (now - (this.diagnosticLastEmitted.get(code) ?? -Infinity) < DIAGNOSTIC_INTERVAL_MS) return
    this.diagnosticCounts.set(code, 0)
    this.diagnosticLastEmitted.set(code, now)
    const diagnostic: EvalDiagnostic = {
      code,
      severity,
      count,
      ...(scorerName !== undefined ? { scorerName } : {}),
      message,
    }
    try {
      if (this.onDiagnostic !== undefined) this.onDiagnostic(diagnostic)
      else if (this.diagnosticMode !== 'silent') {
        console.warn(`[open-multi-agent evaluation] ${code}: ${message}`)
      }
    } catch {
      this.mutable.failed++
    }
  }

  private settle(id: number): void {
    if (id === this.settledThrough + 1) {
      this.settledThrough = id
      while (this.settledOutOfOrder.delete(this.settledThrough + 1)) this.settledThrough++
    } else if (id > this.settledThrough) {
      this.settledOutOfOrder.add(id)
    }
    for (const wake of this.waiters) wake()
  }

  private waitForWatermark(target: number, timeoutMs: number): Promise<boolean> {
    if (target <= this.settledThrough) return Promise.resolve(true)
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const check = () => {
        if (target > this.settledThrough) return
        cleanup()
        resolve(true)
      }
      const cleanup = () => {
        this.waiters.delete(check)
        if (timer !== undefined) clearTimeout(timer)
      }
      this.waiters.add(check)
      timer = unrefTimer(() => {
        cleanup()
        resolve(false)
      }, Math.max(0, timeoutMs))
      check()
    })
  }

  private resultStatus(): FlushResult['status'] {
    if (this.mutable.failed === 0 && this.mutable.storeFailed === 0 && this.mutable.dropped === 0) {
      return 'ok'
    }
    return this.mutable.completed > 0 ? 'partial' : 'error'
  }

  private flushResult(status: FlushResult['status']): FlushResult {
    return {
      status,
      accepted: this.mutable.enqueued,
      exported: this.mutable.completed,
      dropped: this.mutable.dropped,
      failed: this.mutable.failed + this.mutable.storeFailed,
    }
  }
}

/** Avoid constructing an evaluator for omitted or numeric-zero sampling. */
export function createOnlineEvaluator(
  config: OnlineEvaluationConfig | undefined,
  estimateCost?: OnlineEvaluatorRuntime['estimateCost'],
): OnlineEvaluator | undefined {
  if (config === undefined) return undefined
  if (typeof config.sample === 'number') {
    if (!Number.isFinite(config.sample) || config.sample < 0 || config.sample > 1) {
      throw new RangeError('OnlineEvaluationConfig.sample must be a number in [0, 1] or a function.')
    }
    if (config.sample === 0) return undefined
  }
  return new OnlineEvaluator(config, { estimateCost })
}
