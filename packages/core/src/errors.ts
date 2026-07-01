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

/**
 * Read an HTTP-style status code off an unknown error, if present. Provider
 * SDK errors (`Anthropic.APIError`, `OpenAI.APIError`) expose it as `.status`;
 * some libraries use `.statusCode`. Returns `undefined` for network/unknown
 * errors that carry no numeric status.
 */
function extractStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const record = error as { status?: unknown; statusCode?: unknown }
  const status = record.status ?? record.statusCode
  return typeof status === 'number' && Number.isFinite(status) ? status : undefined
}

/**
 * Classify an error as retryable (transient — another attempt might succeed)
 * or terminal (a retry cannot help).
 *
 * Conservative by design: returns `true` (retryable) unless the error is
 * *provably* terminal, so turning retry on never silently stops retrying an
 * error class that was retried before — it only skips attempts that are
 * pointless. Terminal cases are exhausted-budget, malformed input, an aborted
 * call, and 4xx client errors other than 408/409/429. Everything else —
 * network blips (no status), request timeouts (408), conflicts (409), rate
 * limits (429), and all 5xx server errors — is retryable.
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof TokenBudgetExceededError) return false
  if (error instanceof InvalidMessageError) return false
  if (error instanceof LLMCallTimeoutError) return true
  if (error instanceof Error && error.name === 'AbortError') return false
  const status = extractStatus(error)
  if (status === undefined) return true
  if (status === 408 || status === 409 || status === 429) return true
  if (status >= 400 && status < 500) return false
  return true
}
