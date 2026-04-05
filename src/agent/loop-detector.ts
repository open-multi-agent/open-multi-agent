/**
 * @fileoverview Sliding-window loop detector for the agent conversation loop.
 *
 * Tracks tool-call signatures and text outputs across turns to detect when an
 * agent is stuck repeating the same actions. Used by {@link AgentRunner} when
 * {@link LoopDetectionConfig} is provided.
 */

import type { LoopDetectionConfig, LoopDetectionInfo } from '../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recursively sort object keys so that `{b:1, a:2}` and `{a:2, b:1}` produce
 * the same JSON string.
 */
function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(sortKeys)
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((value as Record<string, unknown>)[key])
  }
  return sorted
}

// ---------------------------------------------------------------------------
// LoopDetector
// ---------------------------------------------------------------------------

export class LoopDetector {
  private readonly maxRepeats: number
  private readonly windowSize: number

  private readonly toolSignatures: string[] = []
  private readonly textOutputs: string[] = []

  constructor(config: LoopDetectionConfig = {}) {
    this.maxRepeats = config.maxRepetitions ?? 3
    const requestedWindow = config.loopDetectionWindow ?? 4
    // Window must be >= threshold, otherwise detection can never trigger.
    this.windowSize = Math.max(requestedWindow, this.maxRepeats)
  }

  /**
   * Record a turn's tool calls. Returns detection info when a loop is found.
   */
  recordToolCalls(
    blocks: ReadonlyArray<{ name: string; input: Record<string, unknown> }>,
  ): LoopDetectionInfo | null {
    if (blocks.length === 0) return null

    const signature = this.computeToolSignature(blocks)
    this.push(this.toolSignatures, signature)

    const count = this.consecutiveRepeats(this.toolSignatures)
    if (count >= this.maxRepeats) {
      const names = blocks.map(b => b.name).join(', ')
      return {
        kind: 'tool_repetition',
        repetitions: count,
        detail:
          `Tool call "${names}" with identical arguments has repeated ` +
          `${count} times consecutively. The agent appears to be stuck in a loop.`,
      }
    }
    return null
  }

  /**
   * Record a turn's text output. Returns detection info when a loop is found.
   */
  recordText(text: string): LoopDetectionInfo | null {
    const normalised = text.trim().replace(/\s+/g, ' ')
    if (normalised.length === 0) return null

    this.push(this.textOutputs, normalised)

    const count = this.consecutiveRepeats(this.textOutputs)
    if (count >= this.maxRepeats) {
      return {
        kind: 'text_repetition',
        repetitions: count,
        detail:
          `The agent has produced the same text response ${count} times ` +
          `consecutively. It appears to be stuck in a loop.`,
      }
    }
    return null
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /**
   * Deterministic JSON signature for a set of tool calls.
   * Sorts calls by name (for multi-tool turns) and keys within each input.
   */
  private computeToolSignature(
    blocks: ReadonlyArray<{ name: string; input: Record<string, unknown> }>,
  ): string {
    const items = blocks
      .map(b => ({ name: b.name, input: sortKeys(b.input) }))
      .sort((a, b) => {
        const cmp = a.name.localeCompare(b.name)
        if (cmp !== 0) return cmp
        return JSON.stringify(a.input).localeCompare(JSON.stringify(b.input))
      })
    return JSON.stringify(items)
  }

  /** Push an entry and trim the buffer to `windowSize`. */
  private push(buffer: string[], entry: string): void {
    buffer.push(entry)
    while (buffer.length > this.windowSize) {
      buffer.shift()
    }
  }

  /**
   * Count how many consecutive identical entries exist at the tail of `buffer`.
   * Returns 1 when the last entry is unique.
   */
  private consecutiveRepeats(buffer: string[]): number {
    if (buffer.length === 0) return 0
    const last = buffer[buffer.length - 1]
    let count = 0
    for (let i = buffer.length - 1; i >= 0; i--) {
      if (buffer[i] === last) count++
      else break
    }
    return count
  }
}
