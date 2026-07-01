/**
 * @fileoverview AbortSignal composition helpers shared across the agent layer.
 */

/**
 * Combine two {@link AbortSignal}s so that aborting either one aborts the
 * returned signal. Works on Node 18+ (no `AbortSignal.any` required).
 */
export function mergeAbortSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const controller = new AbortController()
  if (a.aborted || b.aborted) {
    controller.abort()
    return controller.signal
  }
  const abort = () => controller.abort()
  a.addEventListener('abort', abort, { once: true })
  b.addEventListener('abort', abort, { once: true })
  return controller.signal
}
