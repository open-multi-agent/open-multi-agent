/**
 * @fileoverview `runImage`: one image generation or edit across an ordered
 * model chain, with per-model retries, output validation, and a record for
 * every provider call.
 */

import { ImageModelError } from '../errors.js'
import { abortableDelay, mergeAbortSignals } from '../utils/abort.js'
import { sniffImage } from './sniff.js'
import type {
  ImageAttemptRecord,
  ImageModelAdapter,
  ImageOutput,
  RunImageOptions,
  RunImageResult,
} from './types.js'

const DEFAULT_MAX_RETRIES_PER_MODEL = 2
const DEFAULT_BACKOFF_BASE_MS = 2_000
const DEFAULT_MAX_RETRY_AFTER_MS = 60_000
const DEFAULT_ATTEMPT_TIMEOUT_MS = 180_000

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`runImage: ${name} must be a non-negative integer`)
  }
}

function assertNonNegativeNumber(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`runImage: ${name} must be a non-negative number`)
  }
}

function callerAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
}

/**
 * Run one attempt with its own deadline. Resolves the adapter's output or
 * rejects with an {@link ImageModelError}; a caller cancellation rejects with
 * the caller's abort reason instead so the chain stops.
 */
async function callWithDeadline(
  adapter: ImageModelAdapter,
  options: RunImageOptions,
  timeoutMs: number,
) {
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), timeoutMs)
  const signal = options.signal === undefined
    ? deadline.signal
    : mergeAbortSignals(options.signal, deadline.signal)
  try {
    return await adapter.generate(options.request, { signal })
  } catch (error) {
    if (options.signal?.aborted) throw callerAbortReason(options.signal)
    if (deadline.signal.aborted) {
      throw new ImageModelError(
        'timeout',
        `${adapter.provider} call exceeded ${timeoutMs}ms`,
        true,
        { provider: adapter.provider },
      )
    }
    if (error instanceof ImageModelError) throw error
    throw new ImageModelError(
      'api_error',
      `${adapter.provider} adapter threw: ${error instanceof Error ? error.message : String(error)}`,
      false,
      { provider: adapter.provider },
    )
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Generate or edit one image, trying each model in `chain` until one returns
 * an image that passes `validate`.
 *
 * Within a model, retryable failures are retried up to `maxRetriesPerModel`
 * times with jittered exponential backoff, waiting at least as long as a
 * Retry-After the provider sent. A non-retryable failure, or a Retry-After
 * above `maxRetryAfterMs`, moves on to the next model.
 *
 * Returns a result rather than throwing when every model fails, so the attempt
 * records are always available. Rejects only for invalid options or when
 * `signal` aborts.
 */
export async function runImage(options: RunImageOptions): Promise<RunImageResult> {
  const maxRetries = options.maxRetriesPerModel ?? DEFAULT_MAX_RETRIES_PER_MODEL
  const backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS
  const maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS
  const attemptTimeoutMs = options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS
  if (options.chain.length === 0) throw new TypeError('runImage: chain must not be empty')
  assertNonNegativeInteger(maxRetries, 'maxRetriesPerModel')
  assertNonNegativeNumber(backoffBaseMs, 'backoffBaseMs')
  assertNonNegativeNumber(maxRetryAfterMs, 'maxRetryAfterMs')
  if (!Number.isFinite(attemptTimeoutMs) || attemptTimeoutMs <= 0) {
    throw new TypeError('runImage: attemptTimeoutMs must be a positive number')
  }

  const startedAt = Date.now()
  const attempts: ImageAttemptRecord[] = []
  let lastError: ImageModelError | undefined

  const record = async (entry: ImageAttemptRecord): Promise<void> => {
    attempts.push(entry)
    if (options.onAttempt === undefined) return
    try {
      await options.onAttempt(entry)
    } catch {
      // Attempt sinks are observability; a failing one must not change the result.
    }
  }

  for (const adapter of options.chain) {
    for (let modelAttempt = 1; modelAttempt <= maxRetries + 1; modelAttempt++) {
      if (options.signal?.aborted) throw callerAbortReason(options.signal)
      const base = {
        attempt: attempts.length + 1,
        modelAttempt,
        provider: adapter.provider,
        model: adapter.model,
      }
      const attemptStart = Date.now()
      let failure: ImageModelError

      try {
        const raw = await callWithDeadline(adapter, options, attemptTimeoutMs)
        const sniffed = sniffImage(raw.data)
        if (sniffed === undefined) {
          throw new ImageModelError(
            'invalid_output',
            `${adapter.provider} returned bytes that are not a PNG, JPEG, or WebP image`,
            true,
            { provider: adapter.provider },
          )
        }
        const output: ImageOutput = { data: raw.data, ...sniffed }
        const outputSummary = { ...sniffed, byteLength: raw.data.byteLength }
        const verdict = options.validate === undefined
          ? { ok: true as const }
          : await options.validate(output, options.request)

        if (verdict.ok) {
          await record({
            ...base,
            startMs: attemptStart,
            durationMs: Date.now() - attemptStart,
            status: 'succeeded',
            params: raw.params,
            output: outputSummary,
          })
          return {
            status: 'succeeded',
            output,
            provider: adapter.provider,
            model: adapter.model,
            attempts,
            durationMs: Date.now() - startedAt,
          }
        }

        failure = new ImageModelError(
          'invalid_output',
          `Output rejected by validate: ${verdict.reason}`,
          verdict.retryable ?? true,
          { provider: adapter.provider },
        )
        await record({
          ...base,
          startMs: attemptStart,
          durationMs: Date.now() - attemptStart,
          status: 'rejected',
          errorType: failure.type,
          errorMessage: failure.message,
          retryable: failure.retryable,
          params: raw.params,
          output: outputSummary,
          rejectedOutput: output,
        })
      } catch (error) {
        if (!(error instanceof ImageModelError)) throw error
        failure = error
        await record({
          ...base,
          startMs: attemptStart,
          durationMs: Date.now() - attemptStart,
          status: 'failed',
          errorType: failure.type,
          errorMessage: failure.message,
          retryable: failure.retryable,
        })
      }

      lastError = failure
      if (!failure.retryable || modelAttempt > maxRetries) break
      const retryAfterMs = failure.retryAfterMs ?? 0
      if (retryAfterMs > maxRetryAfterMs) break
      const backoffMs = backoffBaseMs * 2 ** (modelAttempt - 1) * (0.5 + 0.5 * Math.random())
      await abortableDelay(Math.max(backoffMs, retryAfterMs), options.signal)
    }
  }

  return {
    status: 'failed',
    error: {
      type: lastError?.type ?? 'api_error',
      message: lastError?.message ?? 'No model produced an image',
    },
    attempts,
    durationMs: Date.now() - startedAt,
  }
}
