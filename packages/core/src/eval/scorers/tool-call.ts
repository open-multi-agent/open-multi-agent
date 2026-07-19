import type { MaterializedSpan } from '../../observability/store.js'
import type { AgentRunResult, ConsensusResult, TeamRunResult } from '../../types.js'
import { defineScorer, type Scorer } from '../scorer.js'

type RunResult = AgentRunResult | TeamRunResult | ConsensusResult

function resultToolCallCount(result: RunResult | undefined): number | undefined {
  if (result === undefined) return undefined
  if ('toolCalls' in result) return result.toolCalls.length
  if ('agentResults' in result) {
    return [...result.agentResults.values()]
      .reduce((total, agentResult) => total + agentResult.toolCalls.length, 0)
  }
  return undefined
}

function toolSucceeded(span: MaterializedSpan): boolean {
  if (span.attributes['oma.tool.is_error'] === true) return false
  return span.status === 'ok'
}

/** Score the share of recorded tool calls that completed successfully. */
export function toolCallSuccessScorer(): Scorer {
  return defineScorer({
    name: 'tool_call_success',
    version: '1',
    score(context) {
      const toolSpans = context.trace?.spans.filter((span) => span.kind === 'tool') ?? []
      const fromTrace = toolSpans.length > 0
      const total = fromTrace ? toolSpans.length : (resultToolCallCount(context.result) ?? 0)
      const successful = fromTrace
        ? toolSpans.filter(toolSucceeded).length
        // ToolCallRecord exposes completed calls but no error flag. Without a trace,
        // recorded result calls are therefore treated as successful.
        : total

      if (total === 0) {
        return {
          score: 1,
          pass: true,
          reason: 'No tool calls were recorded; the scorer is not applicable.',
          details: { tool_calls: 0, successful_tool_calls: 0, source: 'none' },
        }
      }

      const score = successful / total
      return {
        score,
        pass: successful === total,
        reason: `${successful} of ${total} recorded tool calls succeeded.`,
        details: {
          tool_calls: total,
          successful_tool_calls: successful,
          source: fromTrace ? 'trace' : 'result',
        },
      }
    },
  })
}
