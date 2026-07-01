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
 * Raised when a single LLM call (one `adapter.chat()` request) exceeds the
 * per-call deadline configured via {@link AgentConfig.callTimeoutMs}.
 *
 * Distinct from a whole-run timeout ({@link AgentConfig.timeoutMs}) and from a
 * caller-supplied `abortSignal` cancellation: the runner only raises this when
 * its own per-call deadline fired and the caller's signal did not, so a stalled
 * provider is observable and tellable apart from a deliberate abort.
 */
export class LLMCallTimeoutError extends Error {
  readonly code = 'LLM_CALL_TIMEOUT'

  constructor(
    /** The per-call deadline, in milliseconds, that was exceeded. */
    readonly timeoutMs: number,
    /** Name of the agent whose call timed out, when known. */
    readonly agent?: string,
  ) {
    super(
      agent !== undefined
        ? `Agent "${agent}" LLM call exceeded per-call timeout of ${timeoutMs}ms`
        : `LLM call exceeded per-call timeout of ${timeoutMs}ms`,
    )
    this.name = 'LLMCallTimeoutError'
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
