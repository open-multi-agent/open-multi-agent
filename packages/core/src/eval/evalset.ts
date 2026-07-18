import { z } from 'zod'
import type { TraceAttributeValue } from '../types.js'
import type { EvalCase } from './evalcase.js'

const traceAttributeValueSchema: z.ZodType<TraceAttributeValue> = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.array(z.string()),
  z.array(z.number().finite()),
  z.array(z.boolean()),
])

const evalCaseSchema = z.object({
  id: z.string().trim().min(1),
  input: z.unknown(),
  expected: z.unknown().optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(traceAttributeValueSchema).optional(),
})

const evalSetSchema = z.object({
  name: z.string().trim().min(1),
  version: z.string().trim().min(1),
  description: z.string().optional(),
  cases: z.array(evalCaseSchema).min(1),
  defaults: z.object({
    repeats: z.number().int().positive().optional(),
    concurrency: z.number().int().positive().optional(),
  }).optional(),
})

/** A versioned collection of evaluation cases. Bump `version` whenever cases change. */
export interface EvalSet {
  readonly name: string
  readonly version: string
  readonly description?: string
  readonly cases: readonly EvalCase[]
  readonly defaults?: {
    readonly repeats?: number
    readonly concurrency?: number
  }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return value
}

/** Validate, defensively copy, and freeze an EvalSet definition. */
export function defineEvalSet(set: EvalSet): EvalSet {
  const parsed = evalSetSchema.parse(set) as EvalSet
  const ids = new Set<string>()
  for (const evalCase of parsed.cases) {
    if (ids.has(evalCase.id)) {
      throw new Error(`EvalSet case id "${evalCase.id}" must be unique.`)
    }
    ids.add(evalCase.id)
  }
  return deepFreeze(parsed)
}
