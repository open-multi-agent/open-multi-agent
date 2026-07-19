import type { MaterializedSpan } from '../../observability/store.js'
import { defineScorer, type Scorer } from '../scorer.js'

function taskSpans(spans: readonly MaterializedSpan[]): readonly MaterializedSpan[] {
  return spans.filter((span) => span.kind === 'task')
}

/**
 * Score dependency-chain completion using task span links and terminal status.
 * This deliberately does not claim semantic use of a dependency's contents.
 */
export function dependencyUtilizationScorer(): Scorer {
  return defineScorer({
    name: 'dependency_utilization',
    version: '1',
    score(context) {
      if (context.trace === undefined) {
        return {
          score: 1,
          reason: 'No trace was supplied; dependency utilization was not evaluated.',
          details: {
            applicable: false,
            dependency_tasks: 0,
            complete_dependency_tasks: 0,
            missing_dependency_links: 0,
          },
        }
      }

      const tasks = taskSpans(context.trace.spans)
      const bySpanId = new Map(tasks.map((span) => [span.spanId, span]))
      const dependentTasks = tasks
        .map((span) => ({
          span,
          links: span.links.filter((link) => link.relation === 'depends_on'),
        }))
        .filter((entry) => entry.links.length > 0)

      if (dependentTasks.length === 0) {
        return {
          score: 1,
          reason: 'The trace contained no task dependency links; the scorer is not applicable.',
          details: {
            applicable: false,
            dependency_tasks: 0,
            complete_dependency_tasks: 0,
            missing_dependency_links: 0,
          },
        }
      }

      let missingLinks = 0
      const complete = dependentTasks.filter(({ span, links }) => {
        const dependenciesComplete = links.every((link) => {
          const dependency = bySpanId.get(link.spanId)
          if (dependency === undefined) {
            missingLinks++
            return false
          }
          return dependency.status === 'ok'
        })
        return span.status === 'ok' && dependenciesComplete
      }).length
      const score = complete / dependentTasks.length

      return {
        score,
        reason: `${complete} of ${dependentTasks.length} dependency-bearing tasks completed with all linked dependencies successful.`,
        details: {
          applicable: true,
          dependency_tasks: dependentTasks.length,
          complete_dependency_tasks: complete,
          missing_dependency_links: missingLinks,
        },
      }
    },
  })
}
