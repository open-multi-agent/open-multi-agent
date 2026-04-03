/**
 * @fileoverview Trace emission utilities for the observability layer.
 */

import { randomUUID } from 'node:crypto'
import type { TraceEvent } from '../types.js'

/**
 * Safely emit a trace event. Swallows callback errors so a broken
 * subscriber never crashes agent execution.
 */
export function emitTrace(
  fn: ((event: TraceEvent) => void | Promise<void>) | undefined,
  event: TraceEvent,
): void {
  if (!fn) return
  try {
    // Guard async callbacks: if fn returns a Promise, swallow its rejection
    // so an async onTrace never produces an unhandled promise rejection.
    const result = fn(event) as unknown
    if (result && typeof (result as Promise<unknown>).catch === 'function') {
      ;(result as Promise<unknown>).catch(noop)
    }
  } catch {
    // Intentionally swallowed — observability must never break execution.
  }
}

function noop() {}

/** Generate a unique run ID for trace correlation. */
export function generateRunId(): string {
  return randomUUID()
}
