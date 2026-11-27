/**
 * @fileoverview AbortSignal composition helpers shared across the agent layer.
 */

/**
 * A merged signal together with the cleanup its sources need once the work
 * bounded by it has finished.
 */
export interface MergedAbortSignal {
  readonly signal: AbortSignal
  /** Remove the listeners this merge added to its sources. Idempotent. */
  dispose(): void
}

/**
 * Combine two {@link AbortSignal}s so that aborting either one aborts the
 * returned signal. Works on supported Node 20+ releases without
 * `AbortSignal.any`.
 *
 * Listeners are only removed when one of the sources aborts, so a merge that
 * completes normally still holds two listeners on its sources. Call `dispose()`
 * once the work it bounds is done: a caller-owned signal can outlive any number
 * of runs, and per-call merges accumulate on the run signal.
 */
export function mergeAbortSignals(a: AbortSignal, b: AbortSignal): MergedAbortSignal {
  const controller = new AbortController()
  if (a.aborted || b.aborted) {
    controller.abort()
    return { signal: controller.signal, dispose() {} }
  }
  const abort = () => {
    a.removeEventListener('abort', abort)
    b.removeEventListener('abort', abort)
    controller.abort()
  }
  a.addEventListener('abort', abort, { once: true })
  b.addEventListener('abort', abort, { once: true })
  return {
    signal: controller.signal,
    dispose() {
      a.removeEventListener('abort', abort)
      b.removeEventListener('abort', abort)
    },
  }
}

/**
 * Promise-based delay that resolves early if `signal` aborts, so a long backoff
 * sleep does not outlive a cancelled run. Cleans up its timer and listener on
 * whichever path resolves first to avoid leaks across many retrying tasks.
 */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
