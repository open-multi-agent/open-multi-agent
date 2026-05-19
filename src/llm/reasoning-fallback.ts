/**
 * @fileoverview Shared `<thinking>` text fallback for {@link ReasoningBlock}
 * round-tripping across adapter boundaries.
 *
 * When an outbound IR-to-native conversion encounters a {@link ReasoningBlock}
 * that the target adapter cannot natively echo — either because the wire
 * protocol does not accept reasoning input at all
 * ({@link LLMAdapter.capabilities.echoesReasoning} `=== 'never'`) or because
 * the block's {@link ReasoningBlock.provenance} does not match the target
 * adapter for an `'own-issued'` adapter — this helper converts the block to
 * an inline `<thinking>...</thinking>` text snippet that callers prepend to
 * the next outgoing text part.
 *
 * SAFETY CONTRACT (one-way invariant):
 *   The reverse direction — parsing `<thinking>` text back into a
 *   {@link ReasoningBlock} — must never happen. A reconstructed block would
 *   carry no verifiable signature and would be rejected if re-sent to
 *   Anthropic / Bedrock / Gemini 3. `ReasoningBlock` instances are only ever
 *   produced from native API extraction (and always stamped with
 *   `provenance`), never from text parsing.
 *
 * PHASE 1 STATUS:
 *   This helper is exported but not yet wired into any adapter outbound
 *   path. It is introduced ahead of behaviour wiring so the IR additions
 *   (`ReasoningBlock.provenance`, `LLMAdapter.capabilities`) can land
 *   independently and be reviewed in isolation. Phase 2 (#223) will:
 *     - Add `AgentConfig.preserveReasoningAcrossProviders` opt-in.
 *     - Wire each `echoesReasoning: 'never'` and `'own-issued'` adapter's
 *       outbound path to call this helper when appropriate.
 *     - Fold the OpenAI-family private helper added in #234 into this one
 *       so there is a single source of truth.
 */

import type { ReasoningBlock } from '../types.js'

/**
 * Default maximum character budget per `<thinking>` block after truncation.
 * Aligned with the value used by the OpenAI-family private replay helper
 * shipped in #234 (`openai-common.ts:31`) so Phase 2 consolidation is
 * behaviour-preserving.
 */
export const DEFAULT_REASONING_FALLBACK_MAX_CHARS = 1200

/** Marker inserted between head and tail when reasoning text is truncated. */
const TRUNCATION_MARKER = '...[truncated]...'

/** Placeholder emitted in place of opaque encrypted (redacted) reasoning. */
const REDACTED_PLACEHOLDER = '<thinking>[redacted]</thinking>'

export interface ReasoningFallbackOptions {
  /**
   * Hard upper bound on the inner text length (the `<thinking>` wrapper
   * itself is not counted). Values below 1 are clamped to 1; non-finite
   * values are treated as 1. When omitted, defaults to
   * {@link DEFAULT_REASONING_FALLBACK_MAX_CHARS}.
   */
  readonly maxChars?: number
}

function resolveMaxChars(value: number | undefined): number {
  if (value === undefined) return DEFAULT_REASONING_FALLBACK_MAX_CHARS
  if (!Number.isFinite(value)) return 1
  const floored = Math.floor(value)
  if (floored < 1) return 1
  return floored
}

/**
 * Truncate `text` to at most `maxChars` characters via a head+tail excerpt
 * with a `...[truncated]...` marker. The head receives ~70% of the budget
 * so the model sees more of the leading reasoning steps. When `maxChars` is
 * smaller than the marker itself, falls back to a simple head slice.
 */
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  if (TRUNCATION_MARKER.length >= maxChars) return text.slice(0, maxChars)
  const budget = maxChars - TRUNCATION_MARKER.length
  const head = Math.ceil(budget * 0.7)
  const tail = budget - head
  return `${text.slice(0, head)}${TRUNCATION_MARKER}${text.slice(text.length - tail)}`
}

/**
 * Convert a {@link ReasoningBlock} into its `<thinking>...</thinking>` text
 * representation for outbound replay through adapters that cannot natively
 * echo reasoning.
 *
 * Behaviour:
 *   - `redactedData` non-empty → returns {@link REDACTED_PLACEHOLDER} exactly.
 *     Plaintext is unavailable so emitting the original `text` (which is
 *     conventionally empty for redacted blocks) would yield an empty
 *     `<thinking></thinking>` and confuse the next model; the placeholder
 *     signals that reasoning occurred without leaking any content.
 *   - Empty non-redacted text → returns the empty string. Callers should
 *     skip emitting an assistant-message slot rather than pushing an empty
 *     payload.
 *   - Otherwise → returns `<thinking>${truncate(text)}</thinking>`.
 */
export function reasoningBlockToInlineText(
  block: ReasoningBlock,
  options?: ReasoningFallbackOptions,
): string {
  if (typeof block.redactedData === 'string' && block.redactedData.length > 0) {
    return REDACTED_PLACEHOLDER
  }
  if (block.text.length === 0) return ''
  const max = resolveMaxChars(options?.maxChars)
  return `<thinking>${truncate(block.text, max)}</thinking>`
}
