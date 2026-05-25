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
 * Wiring (post #223 Phase 2): every adapter outbound path consults
 * {@link ReasoningOutboundOptions} resolved from
 * {@link AgentConfig.preserveReasoningAsText} +
 * {@link AgentConfig.compressReasoningText}. When opt-in is off, reasoning
 * blocks that can't be native-echoed are dropped silently (preserving
 * pre-Phase-2 behaviour). When opt-in is on, they pass through
 * {@link reasoningBlockToInlineText} and become inline `<thinking>` text.
 */

import type { ReasoningBlock } from '../types.js'

/**
 * Default maximum character budget per `<thinking>` block after truncation.
 * Aligned with the value used by the OpenAI-family private replay helper
 * shipped in #234 so the Phase 2 consolidation is behaviour-preserving.
 */
export const DEFAULT_REASONING_FALLBACK_MAX_CHARS = 1200

/**
 * Sentinel value the resolver returns when the caller explicitly disables
 * truncation (`compressReasoningText: false`). Exported so the special-case
 * branch in {@link resolveMaxChars} stays searchable — removing the branch
 * would silently re-introduce truncation for users who opted out.
 *
 * Equal to `Number.POSITIVE_INFINITY`; the resolver maps it to
 * `Number.MAX_SAFE_INTEGER` so `text.length <= maxChars` is always true.
 */
export const NO_TRUNCATION = Number.POSITIVE_INFINITY

/** Marker inserted between head and tail when reasoning text is truncated. */
const TRUNCATION_MARKER = '...[truncated]...'

/** Placeholder emitted in place of opaque encrypted (redacted) reasoning. */
const REDACTED_PLACEHOLDER = '<thinking>[redacted]</thinking>'

export interface ReasoningFallbackOptions {
  /**
   * Hard upper bound on the inner text length (the `<thinking>` wrapper
   * itself is not counted). Special values:
   *   - `undefined` → defaults to {@link DEFAULT_REASONING_FALLBACK_MAX_CHARS}.
   *   - {@link NO_TRUNCATION} (`Number.POSITIVE_INFINITY`) → no truncation;
   *     the entire reasoning text passes through unchanged. This is the
   *     sentinel returned by {@link resolveReasoningOutboundMaxChars} when
   *     the caller sets `compressReasoningText: false`.
   *   - Any other non-finite value (`NaN`, `-Infinity`) → clamped to 1
   *     (defensive — these values are invalid input).
   *   - Finite values below 1 → clamped to 1.
   *   - Finite values ≥ 1 → used as-is (floored).
   */
  readonly maxChars?: number
}

/**
 * Outbound-conversion options derived from {@link AgentConfig}'s reasoning
 * fields. Threaded through every adapter's outbound IR-to-native conversion
 * so each can opt the user into the cross-provider `<thinking>` text
 * fallback (see #223). Internal to the LLM layer — adapters pick the values
 * out of {@link LLMChatOptions} themselves.
 */
export interface ReasoningOutboundOptions {
  /** Mirrors {@link LLMChatOptions.preserveReasoningAsText}. */
  readonly preserveReasoningAsText?: boolean
  /** Mirrors {@link LLMChatOptions.compressReasoningText}. */
  readonly compressReasoningText?: boolean | { readonly minChars?: number }
}

/**
 * Resolve {@link ReasoningOutboundOptions} to the `maxChars` value accepted
 * by {@link reasoningBlockToInlineText}. Encodes the
 * default-on-when-preserve-on semantics documented in #223:
 *
 *   - `preserve=false`           → returns `undefined` (fallback never runs;
 *                                  callers must check `preserve` themselves)
 *   - `compress=undefined`/`true`→ returns `undefined` so the helper applies
 *                                  its own default head+tail budget
 *   - `compress=false`           → returns {@link NO_TRUNCATION}; the helper
 *                                  treats this as a no-op cap (full text)
 *   - `compress={minChars: N}`   → `N` (the threshold value also serves as
 *                                  the truncation cap)
 */
export function resolveReasoningOutboundMaxChars(
  options: ReasoningOutboundOptions | undefined,
): number | undefined {
  if (options?.preserveReasoningAsText !== true) return undefined
  const compress = options.compressReasoningText
  if (compress === false) return NO_TRUNCATION
  if (compress === undefined || compress === true) {
    return undefined  // helper applies its own default when maxChars omitted
  }
  return compress.minChars  // undefined → helper default, number → that cap
}

function resolveMaxChars(value: number | undefined): number {
  if (value === undefined) return DEFAULT_REASONING_FALLBACK_MAX_CHARS
  if (value === NO_TRUNCATION) return Number.MAX_SAFE_INTEGER
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
