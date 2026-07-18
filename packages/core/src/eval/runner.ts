import { classifyRunFailure } from '../observability/status.js'
import type { RunCostSummary, StoredRun, TraceStore } from '../observability/store.js'
import type {
  AgentRunResult,
  ConsensusResult,
  RunIdentity,
  TeamRunResult,
  TokenUsage,
  TraceAttributeValue,
} from '../types.js'
import { redactSensitiveText } from '../utils/redaction.js'
import type { EvalCase } from './evalcase.js'
import type { EvalSet } from './evalset.js'
import { aggregateEvalRecords } from './report.js'
import type { EvalRunReport } from './report.js'
import type { EvalRecord } from './record.js'
import type { ScoreResult, Scorer, ScorerContext } from './scorer.js'
import type { EvalStore } from './store.js'
import type { EvalTarget, TargetOutput } from './target.js'

const DEFAULT_REPEATS = 1
const DEFAULT_CONCURRENCY = 2
const TARGET_SCORER_NAME = '_target'
const PAYLOAD_MAX_CHARS = 8 * 1024

export interface EvalProgressEvent {
  readonly type: 'case_start' | 'case_done' | 'scorer_error' | 'target_error'
  readonly caseId: string
  readonly repeat: number
  readonly scorer?: string
}

export interface RunEvalOptions {
  readonly scorers: readonly Scorer[]
  readonly repeats?: number
  readonly concurrency?: number
  readonly filterTags?: readonly string[]
  readonly metadata?: Readonly<Record<string, TraceAttributeValue>>
  readonly traceStore?: TraceStore
  /** Optional persistence. Failures are reported as warnings and never fail the run. */
  readonly store?: EvalStore
  readonly evalRunId?: string
  readonly storePayloads?: 'none' | 'redacted' | 'full'
  readonly signal?: AbortSignal
  readonly onProgress?: (event: EvalProgressEvent) => void
}

interface SampleResult {
  readonly records: readonly EvalRecord[]
  readonly tokens?: TokenUsage
  readonly costs: readonly RunCostSummary[]
  readonly targetError: boolean
}

class ScorerTimeoutError extends Error {
  constructor(scorer: string, timeoutMs: number) {
    super(`Scorer "${scorer}" timed out after ${timeoutMs}ms.`)
    this.name = 'TimeoutError'
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer.`)
  }
  return value
}

function createId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid === undefined
    ? `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
    : `${prefix}_${uuid}`
}

function emitProgress(options: RunEvalOptions, event: EvalProgressEvent): void {
  try {
    options.onProgress?.(event)
  } catch {
    // Progress observation is best-effort and must not change evaluation results.
  }
}

function identityRunRef(identity: RunIdentity | undefined): EvalRecord['runRef'] {
  if (identity === undefined) return undefined
  return {
    runId: identity.runId,
    attempt: identity.attempt,
    traceId: identity.traceId,
    rootSpanId: identity.rootSpanId,
  }
}

function resultTokens(
  result: AgentRunResult | TeamRunResult | ConsensusResult | undefined,
): TokenUsage | undefined {
  if (result === undefined) return undefined
  if ('totalTokenUsage' in result) return result.totalTokenUsage
  return result.tokenUsage
}

function resultCosts(
  result: AgentRunResult | TeamRunResult | ConsensusResult | undefined,
): readonly RunCostSummary[] {
  if (result === undefined) return []
  const structural = result as unknown as {
    readonly cost?: RunCostSummary
    readonly costs?: readonly RunCostSummary[]
  }
  if (Array.isArray(structural.costs)) return structural.costs
  return structural.cost === undefined ? [] : [structural.cost]
}

function targetMetadata(
  evalCase: EvalCase,
  options: RunEvalOptions,
  output: TargetOutput | undefined,
): Readonly<Record<string, TraceAttributeValue>> {
  return Object.freeze({
    ...evalCase.metadata,
    ...options.metadata,
    ...output?.result?.metadata,
  })
}

function stringifyPayload(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    const json = JSON.stringify(value)
    return json === undefined ? String(value) : json
  } catch {
    return String(value)
  }
}

function truncatePayload(value: string): string {
  if (value.length <= PAYLOAD_MAX_CHARS) return value
  const marker = `\n[truncated at ${PAYLOAD_MAX_CHARS} characters]`
  return `${value.slice(0, PAYLOAD_MAX_CHARS - marker.length)}${marker}`
}

function payloadFor(
  mode: NonNullable<RunEvalOptions['storePayloads']>,
  input: unknown,
  output: unknown,
  expected: unknown,
): EvalRecord['payload'] {
  if (mode === 'none') return undefined
  const serialize = (value: unknown): string => {
    const bounded = truncatePayload(stringifyPayload(value))
    return mode === 'redacted'
      ? truncatePayload(redactSensitiveText(bounded))
      : bounded
  }
  return {
    ...(input !== undefined ? { input: serialize(input) } : {}),
    ...(output !== undefined ? { output: serialize(output) } : {}),
    ...(expected !== undefined ? { expected: serialize(expected) } : {}),
  }
}

async function scoreWithTimeout(
  scorer: Scorer,
  context: ScorerContext,
): Promise<ScoreResult> {
  if (scorer.timeoutMs === undefined) return scorer.score(context)

  const timeoutMs = Math.max(0, scorer.timeoutMs)
  const controller = new AbortController()
  const abort = (): void => controller.abort(context.signal.reason)
  if (context.signal.aborted) abort()
  else context.signal.addEventListener('abort', abort, { once: true })

  return new Promise<ScoreResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new ScorerTimeoutError(scorer.name, timeoutMs)
      controller.abort(error)
      context.signal.removeEventListener('abort', abort)
      reject(error)
    }, timeoutMs)

    Promise.resolve().then(() => scorer.score({ ...context, signal: controller.signal })).then(
      (value) => {
        clearTimeout(timer)
        context.signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        context.signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}

function baseRecord(
  evalRunId: string,
  set: EvalSet,
  evalCase: EvalCase,
  repeat: number,
  metadata: Readonly<Record<string, TraceAttributeValue>>,
): Pick<EvalRecord,
  'schemaVersion' | 'recordId' | 'evalRunId' | 'source' | 'timestampUnixMs'
  | 'evalSet' | 'caseId' | 'repeat' | 'metadata'> {
  return {
    schemaVersion: 1,
    recordId: createId('eval_record'),
    evalRunId,
    source: 'offline',
    timestampUnixMs: Date.now(),
    evalSet: { name: set.name, version: set.version },
    caseId: evalCase.id,
    repeat,
    metadata,
  }
}

async function runSample(
  set: EvalSet,
  evalCase: EvalCase,
  repeat: number,
  target: EvalTarget,
  options: RunEvalOptions,
  evalRunId: string,
  signal: AbortSignal,
): Promise<SampleResult> {
  emitProgress(options, { type: 'case_start', caseId: evalCase.id, repeat })
  const contextMetadata = Object.freeze({ ...evalCase.metadata, ...options.metadata })
  const targetStartedAt = Date.now()
  let targetOutput: TargetOutput

  try {
    targetOutput = await target(evalCase.input, {
      caseId: evalCase.id,
      repeat,
      signal,
      metadata: contextMetadata,
    })
    if (targetOutput === null || typeof targetOutput !== 'object' || !('output' in targetOutput)) {
      throw new TypeError('EvalTarget must return a TargetOutput object with an output field.')
    }
  } catch (error) {
    const metadata = targetMetadata(evalCase, options, undefined)
    const payload = payloadFor(
      options.storePayloads ?? 'none',
      evalCase.input,
      undefined,
      evalCase.expected,
    )
    const record: EvalRecord = {
      ...baseRecord(evalRunId, set, evalCase, repeat, metadata),
      scorer: { name: TARGET_SCORER_NAME },
      status: 'target_error',
      usage: { durationMs: Date.now() - targetStartedAt },
      error: classifyRunFailure(error).errorInfo,
      ...(payload !== undefined ? { payload } : {}),
    }
    emitProgress(options, { type: 'target_error', caseId: evalCase.id, repeat })
    emitProgress(options, { type: 'case_done', caseId: evalCase.id, repeat })
    return { records: [record], costs: [], targetError: true }
  }

  const durationMs = Date.now() - targetStartedAt
  const result = targetOutput.result
  const tokens = resultTokens(result)
  const costs = resultCosts(result)
  const metadata = targetMetadata(evalCase, options, targetOutput)
  const runRef = identityRunRef(result?.identity)
  const payload = payloadFor(
    options.storePayloads ?? 'none',
    evalCase.input,
    targetOutput.output,
    evalCase.expected,
  )
  const trace: StoredRun | undefined = options.traceStore !== undefined && result?.identity !== undefined
    ? (await options.traceStore.getRun(result.identity.runId)) ?? undefined
    : undefined
  const records: EvalRecord[] = []

  for (const scorer of options.scorers) {
    try {
      const scored = await scoreWithTimeout(scorer, {
        evalCase,
        output: targetOutput.output,
        ...(result !== undefined ? { result } : {}),
        ...(trace !== undefined ? { trace } : {}),
        metadata,
        signal,
      })
      records.push({
        ...baseRecord(evalRunId, set, evalCase, repeat, metadata),
        scorer: {
          name: scorer.name,
          ...(scorer.version !== undefined ? { version: scorer.version } : {}),
        },
        status: 'scored',
        score: scored.score,
        ...(scored.pass !== undefined ? { pass: scored.pass } : {}),
        ...(scored.reason !== undefined ? { reason: scored.reason } : {}),
        ...(scored.details !== undefined ? { details: scored.details } : {}),
        ...(runRef !== undefined ? { runRef } : {}),
        ...(tokens !== undefined || costs.length === 1
          ? { usage: {
              ...(tokens !== undefined ? { tokens } : {}),
              ...(costs.length === 1 ? { cost: costs[0] } : {}),
              durationMs,
            } }
          : { usage: { durationMs } }),
        ...(payload !== undefined ? { payload } : {}),
      })
    } catch (error) {
      const timeout = error instanceof ScorerTimeoutError
      records.push({
        ...baseRecord(evalRunId, set, evalCase, repeat, metadata),
        scorer: {
          name: scorer.name,
          ...(scorer.version !== undefined ? { version: scorer.version } : {}),
        },
        status: 'scorer_error',
        ...(runRef !== undefined ? { runRef } : {}),
        ...(tokens !== undefined || costs.length === 1
          ? { usage: {
              ...(tokens !== undefined ? { tokens } : {}),
              ...(costs.length === 1 ? { cost: costs[0] } : {}),
              durationMs,
            } }
          : { usage: { durationMs } }),
        error: classifyRunFailure(error, timeout
          ? { kind: 'timeout', statusCode: 'timeout' }
          : {}).errorInfo,
        ...(payload !== undefined ? { payload } : {}),
      })
      emitProgress(options, {
        type: 'scorer_error',
        caseId: evalCase.id,
        repeat,
        scorer: scorer.name,
      })
    }
  }

  emitProgress(options, { type: 'case_done', caseId: evalCase.id, repeat })
  return { records, ...(tokens !== undefined ? { tokens } : {}), costs, targetError: false }
}

function sumTokens(samples: readonly SampleResult[]): TokenUsage | undefined {
  const usages = samples.flatMap((sample) => sample.tokens === undefined ? [] : [sample.tokens])
  if (usages.length === 0) return undefined
  return usages.reduce<TokenUsage>((sum, usage) => ({
    input_tokens: sum.input_tokens + usage.input_tokens,
    output_tokens: sum.output_tokens + usage.output_tokens,
  }), { input_tokens: 0, output_tokens: 0 })
}

function sumCosts(samples: readonly SampleResult[]): readonly RunCostSummary[] | undefined {
  const totals = new Map<string, number>()
  for (const cost of samples.flatMap((sample) => sample.costs)) {
    totals.set(cost.currency, (totals.get(cost.currency) ?? 0) + cost.amount)
  }
  if (totals.size === 0) return undefined
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, amount]) => ({ currency, amount }))
}

/** Execute an EvalSet offline with bounded sample concurrency and serial per-sample scoring. */
export async function runEvalSet(
  set: EvalSet,
  target: EvalTarget,
  options: RunEvalOptions,
): Promise<EvalRunReport> {
  const startedAtUnixMs = Date.now()
  const repeats = positiveInteger(options.repeats ?? set.defaults?.repeats ?? DEFAULT_REPEATS, 'repeats')
  const concurrency = positiveInteger(
    options.concurrency ?? set.defaults?.concurrency ?? DEFAULT_CONCURRENCY,
    'concurrency',
  )
  if (options.evalRunId !== undefined && options.evalRunId.trim().length === 0) {
    throw new TypeError('evalRunId must be a non-empty string when provided.')
  }
  const evalRunId = options.evalRunId ?? createId('eval_run')
  const filter = options.filterTags === undefined || options.filterTags.length === 0
    ? undefined
    : new Set(options.filterTags)
  const cases = set.cases.filter((evalCase) =>
    filter === undefined || evalCase.tags?.some((tag) => filter.has(tag)) === true)
  const jobs = cases.flatMap((evalCase) =>
    Array.from({ length: repeats }, (_, index) => ({ evalCase, repeat: index + 1 })))
  const signal = options.signal ?? new AbortController().signal
  const samples = new Array<SampleResult | undefined>(jobs.length)
  const storeWarnings = new Array<string | undefined>(jobs.length)
  let cursor = 0

  const worker = async (): Promise<void> => {
    while (!signal.aborted) {
      const index = cursor++
      const job = jobs[index]
      if (job === undefined) return
      const sample = await runSample(
        set,
        job.evalCase,
        job.repeat,
        target,
        options,
        evalRunId,
        signal,
      )
      samples[index] = sample
      if (options.store !== undefined) {
        try {
          await options.store.append(sample.records)
        } catch {
          storeWarnings[index] = `Evaluation records for case "${job.evalCase.id}" repeat ${job.repeat} were not persisted.`
        }
      }
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(concurrency, jobs.length) },
    () => worker(),
  ))

  const completed = samples.filter((sample): sample is SampleResult => sample !== undefined)
  const records = completed.flatMap((sample) => sample.records)
  const tagsByCase = new Map(cases.map((evalCase) => [evalCase.id, evalCase.tags ?? []]))
  const tokens = sumTokens(completed)
  const costs = sumCosts(completed)
  const warnings = storeWarnings.filter((warning): warning is string => warning !== undefined)

  return {
    schemaVersion: 1,
    evalRunId,
    startedAtUnixMs,
    durationMs: Date.now() - startedAtUnixMs,
    evalSet: { name: set.name, version: set.version },
    metadata: Object.freeze({ ...options.metadata }),
    caseCount: cases.length,
    repeats,
    ...(signal.aborted ? { aborted: true } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    records,
    aggregates: aggregateEvalRecords(records, options.scorers, tagsByCase),
    totals: {
      ...(tokens !== undefined ? { tokens } : {}),
      ...(costs !== undefined ? { costs } : {}),
      targetErrors: completed.filter((sample) => sample.targetError).length,
    },
  }
}
