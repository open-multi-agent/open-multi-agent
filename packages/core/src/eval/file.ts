import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { z, ZodError } from 'zod'

import { defineEvalSet, type EvalSet } from './evalset.js'
import { gatePolicySchema, type GatePolicy } from './gate.js'
import type { EvalRunReport, ScorerAggregate } from './report.js'
import type { EvalRecord } from './record.js'

export {
  FILE_EVAL_STORE_FORMAT,
  FILE_EVAL_STORE_FORMAT_VERSION,
  FileEvalStore,
  FileEvalStoreError,
} from './file-store.js'
export type {
  FileEvalStoreCompactionResult,
  FileEvalStoreDiagnostic,
  FileEvalStoreDiagnosticCode,
  FileEvalStoreErrorCode,
  FileEvalStoreOptions,
} from './file-store.js'

export type EvalReportFormat = 'json' | 'markdown' | 'junit'

const REASON_MAX_CHARS = 200

const traceAttributeValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.array(z.string()),
  z.array(z.number().finite()),
  z.array(z.boolean()),
])

const scorerIdentitySchema = z.object({
  name: z.string().trim().min(1),
  version: z.string().optional(),
})

const tokenUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
})

const costSchema = z.object({
  amount: z.number().finite().nonnegative(),
  currency: z.string().trim().min(1),
})

const structuredTraceErrorSchema = z.object({
  kind: z.enum([
    'auth',
    'rate_limit',
    'provider',
    'validation',
    'timeout',
    'cancellation',
    'budget',
    'store',
    'exporter',
    'unknown',
  ]),
  code: z.string().optional(),
  name: z.string().optional(),
  message: z.string().optional(),
  retryable: z.boolean().optional(),
  httpStatus: z.number().int().optional(),
  provider: z.string().optional(),
  attempt: z.number().int().positive().optional(),
})

const evalRecordSchema = z.object({
  schemaVersion: z.literal(1),
  recordId: z.string().trim().min(1),
  evalRunId: z.string().trim().min(1),
  source: z.enum(['offline', 'online']),
  timestampUnixMs: z.number().int().nonnegative(),
  evalSet: z.object({
    name: z.string().trim().min(1),
    version: z.string().trim().min(1),
  }).optional(),
  caseId: z.string().optional(),
  repeat: z.number().int().positive().optional(),
  scorer: scorerIdentitySchema,
  status: z.enum(['scored', 'scorer_error', 'target_error', 'skipped']),
  score: z.number().finite().min(0).max(1).optional(),
  pass: z.boolean().optional(),
  reason: z.string().optional(),
  details: z.record(traceAttributeValueSchema).optional(),
  runRef: z.object({
    runId: z.string().trim().min(1),
    attempt: z.number().int().positive(),
    traceId: z.string().trim().min(1),
    rootSpanId: z.string().trim().min(1),
  }).optional(),
  metadata: z.record(traceAttributeValueSchema),
  usage: z.object({
    tokens: tokenUsageSchema.optional(),
    cost: costSchema.optional(),
    durationMs: z.number().finite().nonnegative().optional(),
  }).optional(),
  error: structuredTraceErrorSchema.optional(),
  payload: z.object({
    input: z.string().optional(),
    output: z.string().optional(),
    expected: z.string().optional(),
  }).optional(),
})

const scorerAggregateSchema: z.ZodTypeAny = z.lazy(() => z.object({
  scorer: scorerIdentitySchema,
  scoredCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  avg: z.number().finite().min(0).max(1),
  p50: z.number().finite().min(0).max(1),
  p95: z.number().finite().min(0).max(1),
  min: z.number().finite().min(0).max(1),
  max: z.number().finite().min(0).max(1),
  passRate: z.number().finite().min(0).max(1).optional(),
  byTag: z.record(scorerAggregateSchema).optional(),
}))

const evalRunReportSchema = z.object({
  schemaVersion: z.literal(1),
  evalRunId: z.string().trim().min(1),
  startedAtUnixMs: z.number().int().nonnegative(),
  durationMs: z.number().finite().nonnegative(),
  evalSet: z.object({
    name: z.string().trim().min(1),
    version: z.string().trim().min(1),
  }),
  metadata: z.record(traceAttributeValueSchema),
  caseCount: z.number().int().nonnegative(),
  repeats: z.number().int().positive(),
  aborted: z.boolean().optional(),
  warnings: z.array(z.string()).optional(),
  records: z.array(evalRecordSchema),
  aggregates: z.array(scorerAggregateSchema),
  totals: z.object({
    tokens: tokenUsageSchema.optional(),
    costs: z.array(costSchema).optional(),
    targetErrors: z.number().int().nonnegative(),
  }),
})

function truncateReason(value: string): string {
  if (value.length <= REASON_MAX_CHARS) return value
  return `${value.slice(0, REASON_MAX_CHARS - 1)}…`
}

function firstZodIssue(error: ZodError): string {
  const issue = error.issues[0]
  if (issue === undefined) return error.message
  const path = issue.path.length === 0 ? '' : `${issue.path.join('.')}: `
  return `${path}${issue.message}`
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return value
}

/** Load, validate, defensively copy, and freeze an EvalSet JSON file. */
export async function loadEvalSet(filePath: string): Promise<EvalSet> {
  const absolutePath = resolve(filePath)
  const raw = await readFile(absolutePath, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid EvalSet JSON in ${absolutePath}: ${message}`)
  }

  try {
    return defineEvalSet(parsed as EvalSet)
  } catch (error) {
    const message = error instanceof ZodError
      ? firstZodIssue(error)
      : error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid EvalSet in ${absolutePath}: ${message}`)
  }
}

/** Load and validate a GatePolicy JSON file. */
export async function loadGatePolicy(filePath: string): Promise<GatePolicy> {
  const absolutePath = resolve(filePath)
  const raw = await readFile(absolutePath, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid GatePolicy JSON in ${absolutePath}: ${message}`)
  }

  try {
    return deepFreeze(gatePolicySchema.parse(parsed) as GatePolicy)
  } catch (error) {
    const message = error instanceof ZodError
      ? firstZodIssue(error)
      : error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid GatePolicy in ${absolutePath}: ${message}`)
  }
}

/** Load and validate an authoritative EvalRunReport JSON file. */
export async function loadEvalReport(filePath: string): Promise<EvalRunReport> {
  const absolutePath = resolve(filePath)
  const raw = await readFile(absolutePath, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid EvalRunReport JSON in ${absolutePath}: ${message}`)
  }

  try {
    return deepFreeze(evalRunReportSchema.parse(parsed) as EvalRunReport)
  } catch (error) {
    const message = error instanceof ZodError
      ? firstZodIssue(error)
      : error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid EvalRunReport in ${absolutePath}: ${message}`)
  }
}

function markdownCell(value: unknown): string {
  if (value === undefined) return '—'
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll('\n', '<br>')
}

function metric(value: number | undefined): string {
  if (value === undefined) return '—'
  return Number(value.toFixed(6)).toString()
}

function passRate(value: number | undefined): string {
  return value === undefined ? '—' : `${metric(value * 100)}%`
}

function aggregateRow(aggregate: ScorerAggregate, tag?: string): string {
  return [
    tag,
    aggregate.scorer.name,
    aggregate.scorer.version,
    aggregate.scoredCount,
    metric(aggregate.avg),
    metric(aggregate.p50),
    metric(aggregate.p95),
    metric(aggregate.min),
    metric(aggregate.max),
    passRate(aggregate.passRate),
    aggregate.errorCount,
  ].map(markdownCell).join(' | ')
}

function recordFailureReason(record: EvalRecord): string {
  if (record.status === 'scored') return truncateReason(record.reason ?? 'Score did not pass.')
  return truncateReason(record.error?.message ?? record.reason ?? record.status)
}

function markdownReport(report: EvalRunReport): string {
  const warningLines = report.warnings === undefined || report.warnings.length === 0
    ? []
    : ['## Warnings', '', ...report.warnings.map((warning) => `- ${warning}`), '']
  const lines = [
    `# Evaluation Report: ${report.evalSet.name}@${report.evalSet.version}`,
    '',
    `- Eval run: \`${report.evalRunId}\``,
    `- Started: ${new Date(report.startedAtUnixMs).toISOString()}`,
    `- Duration: ${report.durationMs} ms`,
    `- Cases: ${report.caseCount}`,
    `- Repeats: ${report.repeats}`,
    `- Aborted: ${report.aborted === true ? 'yes' : 'no'}`,
    '',
    '## Metadata',
    '',
    '```json',
    JSON.stringify(report.metadata, null, 2),
    '```',
    '',
    ...warningLines,
    '## Scorer aggregates',
    '',
    '| Scorer | Version | Scored | Avg | P50 | P95 | Min | Max | Pass rate | Errors |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...report.aggregates.map((aggregate) => `| ${aggregateRow(aggregate).split(' | ').slice(1).join(' | ')} |`),
  ]

  const byTag = report.aggregates.flatMap((aggregate) =>
    Object.entries(aggregate.byTag ?? {}).map(([tag, tagged]) => ({ tag, aggregate: tagged })))
  if (byTag.length > 0) {
    lines.push(
      '',
      '## Aggregates by tag',
      '',
      '| Tag | Scorer | Version | Scored | Avg | P50 | P95 | Min | Max | Pass rate | Errors |',
      '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
      ...byTag.map(({ tag, aggregate }) => `| ${aggregateRow(aggregate, tag)} |`),
    )
  }

  const failures = report.records.filter((record) =>
    record.pass === false || record.status === 'scorer_error' || record.status === 'target_error')
  lines.push('', '## Failed samples', '')
  if (failures.length === 0) {
    lines.push('None.')
  } else {
    lines.push(
      '| Case | Repeat | Scorer | Status | Reason |',
      '| --- | ---: | --- | --- | --- |',
      ...failures.map((record) => `| ${[
        record.caseId,
        record.repeat,
        record.scorer.name,
        record.status,
        recordFailureReason(record),
      ].map(markdownCell).join(' | ')} |`),
    )
  }

  lines.push(
    '',
    '## Totals',
    '',
    `- Target errors: ${report.totals.targetErrors}`,
    `- Tokens: ${report.totals.tokens === undefined
      ? '—'
      : `${report.totals.tokens.input_tokens} input, ${report.totals.tokens.output_tokens} output`}`,
    `- Costs: ${report.totals.costs === undefined || report.totals.costs.length === 0
      ? '—'
      : report.totals.costs.map((cost) => `${cost.amount} ${cost.currency}`).join(', ')}`,
    '',
  )
  return lines.join('\n')
}

function xmlEscape(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function seconds(milliseconds: number | undefined): string {
  return ((milliseconds ?? 0) / 1_000).toFixed(3)
}

function junitTestcase(report: EvalRunReport, record: EvalRecord): string {
  const name = `${record.caseId ?? '_unknown'}#r${record.repeat ?? 0} · ${record.scorer.name}`
  const start = `  <testcase name="${xmlEscape(name)}" classname="${xmlEscape(report.evalSet.name)}" time="${seconds(record.usage?.durationMs)}"`
  if (record.status === 'scorer_error' || record.status === 'target_error') {
    const reason = recordFailureReason(record)
    return `${start}>\n    <error message="${xmlEscape(reason)}">${xmlEscape(reason)}</error>\n  </testcase>`
  }
  if (record.pass === false) {
    const reason = recordFailureReason(record)
    return `${start}>\n    <failure message="${xmlEscape(reason)}">${xmlEscape(reason)}</failure>\n  </testcase>`
  }
  return `${start} />`
}

function junitReport(report: EvalRunReport): string {
  const failures = report.records.filter((record) =>
    record.status !== 'scorer_error' && record.status !== 'target_error' && record.pass === false).length
  const errors = report.records.filter((record) =>
    record.status === 'scorer_error' || record.status === 'target_error').length
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="${xmlEscape(`${report.evalSet.name}@${report.evalSet.version}`)}" tests="${report.records.length}" failures="${failures}" errors="${errors}" time="${seconds(report.durationMs)}">`,
    ...report.records.map((record) => junitTestcase(report, record)),
    '</testsuite>',
    '',
  ].join('\n')
}

function serializeReport(report: EvalRunReport, format: EvalReportFormat): string {
  if (format === 'json') return JSON.stringify(report, null, 2)
  if (format === 'markdown') return markdownReport(report)
  return junitReport(report)
}

/** Write an EvalRunReport in its authoritative JSON, Markdown, or JUnit form. */
export async function writeEvalReport(
  report: EvalRunReport,
  options: { readonly format: EvalReportFormat; readonly path: string },
): Promise<void> {
  const outputPath = resolve(options.path)
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, serializeReport(report, options.format), 'utf8')
}
