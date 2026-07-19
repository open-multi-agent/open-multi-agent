import type { MaterializedSpan } from '../../observability/store.js'
import { defineScorer, type Scorer } from '../scorer.js'

export interface NoProgressScorerOptions {
  /** Consecutive stalled agent attempts allowed before the score is reduced. Default: 2. */
  readonly maxStallTurns?: number
}

function numberAttribute(span: MaterializedSpan, name: string): number | undefined {
  const value = span.attributes[name]
  return typeof value === 'number' ? value : undefined
}

function stringAttribute(span: MaterializedSpan, name: string): string | undefined {
  const value = span.attributes[name]
  return typeof value === 'string' ? value : undefined
}

/** Score consecutive failed task-agent attempts that called an LLM but made no tool call. */
export function noProgressScorer(options: NoProgressScorerOptions = {}): Scorer {
  const maxStallTurns = options.maxStallTurns ?? 2
  if (!Number.isInteger(maxStallTurns) || maxStallTurns < 0) {
    throw new RangeError('NoProgressScorerOptions.maxStallTurns must be a non-negative integer.')
  }

  return defineScorer({
    name: 'no_progress',
    version: '1',
    score(context) {
      if (context.trace === undefined) {
        return {
          score: 1,
          reason: 'No trace was supplied; no-progress attempts were not evaluated.',
          details: {
            applicable: false,
            observed_attempts: 0,
            stalled_attempts: 0,
            max_consecutive_stalls: 0,
            max_stall_turns: maxStallTurns,
          },
        }
      }

      const spans = context.trace.spans
      const tasksById = new Map(spans
        .filter((span) => span.kind === 'task')
        .flatMap((span) => {
          const taskId = stringAttribute(span, 'oma.task.id')
          return taskId === undefined ? [] : [[taskId, span] as const]
        }))
      const agents = spans
        .filter((span) => span.kind === 'agent' && stringAttribute(span, 'oma.task.id') !== undefined)
        .sort((left, right) => (left.startUnixMs ?? 0) - (right.startUnixMs ?? 0))
      let observed = 0
      let stalled = 0
      let consecutive = 0
      let maxConsecutive = 0

      for (const agent of agents) {
        const llmCalls = spans.filter((span) => span.kind === 'llm' && span.parentSpanId === agent.spanId).length
        const turns = numberAttribute(agent, 'oma.agent.turns') ?? llmCalls
        if (turns === 0) continue
        observed++
        const childTools = spans.filter((span) => span.kind === 'tool' && span.parentSpanId === agent.spanId).length
        const toolCalls = numberAttribute(agent, 'oma.agent.tool_calls') ?? childTools
        const taskId = stringAttribute(agent, 'oma.task.id')!
        const task = tasksById.get(taskId)
        const taskCompletedByAttempt = task?.status === 'ok'
          && task.endUnixMs !== undefined
          && agent.endUnixMs !== undefined
          && task.endUnixMs <= agent.endUnixMs
        const isStalled = toolCalls === 0 && agent.status !== 'ok' && !taskCompletedByAttempt
        if (isStalled) {
          stalled++
          consecutive++
          maxConsecutive = Math.max(maxConsecutive, consecutive)
        } else {
          consecutive = 0
        }
      }

      if (observed === 0) {
        return {
          score: 1,
          reason: 'No task-agent attempts with LLM calls were present; the scorer is not applicable.',
          details: {
            applicable: false,
            observed_attempts: 0,
            stalled_attempts: 0,
            max_consecutive_stalls: 0,
            max_stall_turns: maxStallTurns,
          },
        }
      }

      const score = maxConsecutive <= maxStallTurns
        ? 1
        : maxStallTurns === 0 ? 0 : maxStallTurns / maxConsecutive
      return {
        score,
        reason: `Maximum consecutive stalled task-agent attempts: ${maxConsecutive} (allowed: ${maxStallTurns}).`,
        details: {
          applicable: true,
          observed_attempts: observed,
          stalled_attempts: stalled,
          max_consecutive_stalls: maxConsecutive,
          max_stall_turns: maxStallTurns,
        },
      }
    },
  })
}
