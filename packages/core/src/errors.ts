/**
 * @fileoverview Framework-specific error classes.
 */

/**
 * Raised when an agent or orchestrator run exceeds its configured token budget.
 */
export class TokenBudgetExceededError extends Error {
  readonly code = 'TOKEN_BUDGET_EXCEEDED'

  constructor(
    readonly agent: string,
    readonly tokensUsed: number,
    readonly budget: number,
  ) {
    super(`Agent "${agent}" exceeded token budget: ${tokensUsed} tokens used (budget: ${budget})`)
    this.name = 'TokenBudgetExceededError'
  }
}

/**
 * Raised when a message list passed to an adapter violates the
 * {@link LLMMessage}[] contract (e.g. a `content` that isn't a `ContentBlock[]`).
 * Surfaced at the adapter entry so the violation fails loudly instead of
 * crashing deep in provider-specific message conversion.
 */
export class InvalidMessageError extends Error {
  readonly code = 'INVALID_MESSAGE'

  constructor(message: string) {
    super(message)
    this.name = 'InvalidMessageError'
  }
}
