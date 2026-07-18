import type { TraceAttributeValue } from '../types.js'

/** One input/output expectation evaluated by one or more scorers. */
export interface EvalCase {
  readonly id: string
  readonly input: unknown
  readonly expected?: unknown
  readonly tags?: readonly string[]
  readonly metadata?: Readonly<Record<string, TraceAttributeValue>>
}
