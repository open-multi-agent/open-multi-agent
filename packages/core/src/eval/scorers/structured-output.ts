import type { ZodSchema } from 'zod'
import { defineScorer, type Scorer } from '../scorer.js'

/** Score whether an Agent result contains structured output and optionally matches a schema. */
export function structuredOutputComplianceScorer(schema?: ZodSchema): Scorer {
  return defineScorer({
    name: 'structured_output_compliance',
    version: '1',
    score(context) {
      const structured = context.result !== undefined && 'structured' in context.result
        ? context.result.structured
        : undefined
      if (structured === undefined) {
        return {
          score: 0,
          pass: false,
          reason: 'The target result did not contain structured output.',
          details: { structured_present: false, schema_checked: schema !== undefined },
        }
      }

      const valid = schema === undefined || schema.safeParse(structured).success
      return {
        score: valid ? 1 : 0,
        pass: valid,
        reason: valid
          ? schema === undefined
            ? 'Structured output was present.'
            : 'Structured output matched the supplied schema.'
          : 'Structured output did not match the supplied schema.',
        details: { structured_present: true, schema_checked: schema !== undefined },
      }
    },
  })
}
