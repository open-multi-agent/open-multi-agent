import type { TokenUsage } from '../../types.js'
import { defineScorer, type Scorer } from '../scorer.js'

export interface CostBudgetScorerOptions {
  readonly maxTokens?: number
  readonly maxCostAmount?: number
}

function positiveLimit(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number.`)
  }
  return value
}

function resultTokens(result: Parameters<Scorer['score']>[0]['result']): TokenUsage | undefined {
  if (result === undefined) return undefined
  return 'totalTokenUsage' in result ? result.totalTokenUsage : result.tokenUsage
}

/** Apply hard token and/or observed-cost ceilings to a run. */
export function costBudgetScorer(options: CostBudgetScorerOptions): Scorer {
  const maxTokens = positiveLimit(options.maxTokens, 'maxTokens')
  const maxCostAmount = positiveLimit(options.maxCostAmount, 'maxCostAmount')
  if (maxTokens === undefined && maxCostAmount === undefined) {
    throw new TypeError('costBudgetScorer requires maxTokens and/or maxCostAmount.')
  }

  return defineScorer({
    name: 'cost_budget',
    version: '1',
    score(context) {
      const usage = resultTokens(context.result)
      const totalTokens = usage === undefined
        ? undefined
        : usage.input_tokens + usage.output_tokens
      const currencies = new Set(context.trace?.costs.map((cost) => cost.currency) ?? [])
      if (maxCostAmount !== undefined && currencies.size > 1) {
        throw new TypeError('costBudgetScorer cannot compare cost amounts across multiple currencies.')
      }
      const costAmount = context.trace?.costs.length
        ? context.trace.costs.reduce((total, cost) => total + cost.amount, 0)
        : undefined
      const tokenPass = maxTokens === undefined || totalTokens === undefined
        ? undefined
        : totalTokens <= maxTokens
      const costPass = maxCostAmount === undefined || costAmount === undefined
        ? undefined
        : costAmount <= maxCostAmount
      const checks = [tokenPass, costPass].filter((value): value is boolean => value !== undefined)
      const pass = checks.every(Boolean)
      const missing: string[] = []
      if (maxTokens !== undefined && totalTokens === undefined) missing.push('token usage')
      if (maxCostAmount !== undefined && costAmount === undefined) missing.push('cost data')

      return {
        score: pass ? 1 : 0,
        ...(checks.length > 0 ? { pass } : {}),
        reason: missing.length > 0
          ? `${pass ? 'Configured observed budgets passed' : 'A configured observed budget was exceeded'}; ${missing.join(' and ')} unavailable.`
          : pass
            ? 'All configured budgets passed.'
            : 'At least one configured budget was exceeded.',
        details: {
          applicable: checks.length > 0,
          data_complete: missing.length === 0,
          ...(totalTokens !== undefined ? { total_tokens: totalTokens } : {}),
          ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
          ...(costAmount !== undefined ? { cost_amount: costAmount } : {}),
          ...(maxCostAmount !== undefined ? { max_cost_amount: maxCostAmount } : {}),
          ...(currencies.size === 1 ? { currency: [...currencies][0]! } : {}),
        },
      }
    },
  })
}
