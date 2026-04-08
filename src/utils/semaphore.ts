/**
 * @fileoverview Shared counting semaphore for concurrency control.
 *
 * Used by both {@link ToolExecutor} and {@link AgentPool} to cap the number of
 * concurrent async operations without requiring any third-party dependencies.
 *
 * This is intentionally self-contained and tuned for Promise/async use —
 * not a general OS-semaphore replacement.
 */

// ---------------------------------------------------------------------------
// Semaphore
// ---------------------------------------------------------------------------

/**
 * Classic counting semaphore for concurrency control.
 *
 * `acquire()` resolves immediately if a slot is free, otherwise queues the
 * caller. `release()` unblocks the next waiter in FIFO order.
 *
 * Node.js is single-threaded, so this is safe without atomics or mutex
 * primitives — the semaphore gates concurrent async operations, not CPU threads.
 */
export class Semaphore {
  private current = 0
  private readonly queue: Array<() => void> = []

  /**
   * @param max - Maximum number of concurrent holders. Must be >= 1.
   */
  constructor(private readonly max: number) {
    if (max < 1) {
      throw new RangeError(`Semaphore max must be at least 1, got ${max}`)
    }
  }

  /** Maximum concurrent holders configured for this semaphore. */
  get limit(): number {
    return this.max
  }

  /**
   * Acquire a slot. Resolves immediately when one is free, or waits until a
   * holder calls `release()`.
   */
  acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++
      return Promise.resolve()
    }

    return new Promise<void>(resolve => {
      this.queue.push(resolve)
    })
  }

  /**
   * Release a previously acquired slot.
   * If callers are queued, the next one is unblocked synchronously.
   */
  release(): void {
    const next = this.queue.shift()
    if (next !== undefined) {
      // A queued caller is waiting — hand the slot directly to it.
      // `current` stays the same: we consumed the slot immediately.
      next()
    } else {
      this.current--
    }
  }

  /**
   * Run `fn` while holding one slot, automatically releasing it afterward
   * even if `fn` throws.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }

  /** Number of slots currently in use. */
  get active(): number {
    return this.current
  }

  /** Number of callers waiting for a slot. */
  get pending(): number {
    return this.queue.length
  }
}
