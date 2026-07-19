import type { MaterializedSpan } from '../../observability/store.js'
import type { TeamRunResult } from '../../types.js'
import { defineScorer, type Scorer } from '../scorer.js'

export interface DuplicateWorkScorerOptions {
  /** Similarity at or above this value counts as duplicate work. Default: 0.8. */
  readonly threshold?: number
}

function stringAttribute(span: MaterializedSpan, name: string): string | undefined {
  const value = span.attributes[name]
  return typeof value === 'string' ? value : undefined
}

function teamResult(result: Parameters<Scorer['score']>[0]['result']): TeamRunResult | undefined {
  return result !== undefined && 'agentResults' in result ? result : undefined
}

function taskOutput(result: TeamRunResult, span: MaterializedSpan): string | undefined {
  const taskId = stringAttribute(span, 'oma.task.id')
  if (taskId === undefined) return undefined
  const agent = stringAttribute(span, 'oma.agent.name')
  const exact = agent === undefined ? undefined : result.agentResults.get(`${agent}:${taskId}`)
  const matched = exact ?? [...result.agentResults.entries()]
    .find(([key]) => key.endsWith(`:${taskId}`))?.[1]
  const output = matched?.output.trim()
  return output ? output : undefined
}

function shingles(value: string): Set<string> {
  const normalized = Array.from(value.toLowerCase().replace(/\s+/g, ' ').trim())
  if (normalized.length === 0) return new Set()
  const width = Math.min(3, normalized.length)
  const values = new Set<string>()
  for (let index = 0; index <= normalized.length - width; index++) {
    values.add(normalized.slice(index, index + width).join(''))
  }
  return values
}

function similarity(left: string, right: string): number {
  const a = shingles(left)
  const b = shingles(right)
  if (a.size === 0 && b.size === 0) return 1
  let intersection = 0
  for (const value of a) if (b.has(value)) intersection++
  return intersection / (a.size + b.size - intersection)
}

/** Score pairwise task-output uniqueness with zero-dependency character shingles. */
export function duplicateWorkScorer(options: DuplicateWorkScorerOptions = {}): Scorer {
  const threshold = options.threshold ?? 0.8
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new RangeError('DuplicateWorkScorerOptions.threshold must be in the range [0, 1].')
  }

  return defineScorer({
    name: 'duplicate_work',
    version: '1',
    score(context) {
      const result = teamResult(context.result)
      if (context.trace === undefined || result === undefined) {
        return {
          score: 1,
          reason: 'A StoredRun trace and TeamRunResult are required; duplicate work was not evaluated.',
          details: {
            applicable: false,
            compared_pairs: 0,
            duplicate_pairs: 0,
            threshold,
            max_similarity: 0,
          },
        }
      }

      const outputs = context.trace.spans
        .filter((span) => span.kind === 'task')
        .flatMap((span) => {
          const output = taskOutput(result, span)
          return output === undefined ? [] : [output]
        })
      let pairs = 0
      let duplicates = 0
      let maxSimilarity = 0
      for (let left = 0; left < outputs.length; left++) {
        for (let right = left + 1; right < outputs.length; right++) {
          const value = similarity(outputs[left]!, outputs[right]!)
          pairs++
          maxSimilarity = Math.max(maxSimilarity, value)
          if (value >= threshold) duplicates++
        }
      }

      if (pairs === 0) {
        return {
          score: 1,
          reason: 'Fewer than two non-empty task outputs were available; duplicate work was not evaluated.',
          details: {
            applicable: false,
            compared_pairs: 0,
            duplicate_pairs: 0,
            threshold,
            max_similarity: 0,
          },
        }
      }

      return {
        score: 1 - duplicates / pairs,
        reason: `${duplicates} of ${pairs} task-output pairs met the duplicate-work threshold.`,
        details: {
          applicable: true,
          compared_pairs: pairs,
          duplicate_pairs: duplicates,
          threshold,
          max_similarity: maxSimilarity,
        },
      }
    },
  })
}
