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
  fn: ((event: TraceEvent) => void) | undefined,
  event: TraceEvent,
): void {
  if (!fn) return
  try {
    fn(event)
  } catch {
    // Intentionally swallowed — observability must never break execution.
  }
}

/** Generate a unique run ID for trace correlation. */
export function generateRunId(): string {
  return randomUUID()
}
