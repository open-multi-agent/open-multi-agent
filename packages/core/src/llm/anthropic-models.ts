/**
 * @fileoverview Claude model-generation checks shared by the Anthropic adapter
 * and framework-internal calls. Kept free of the SDK import so callers outside
 * the adapter do not load it.
 *
 * Both lists are closed: they name model generations that will not grow, so a
 * model ID they do not recognise is treated as current.
 */

/** Models from before adaptive thinking (Sonnet 3.7 through the 4.5 generation). */
const BUDGET_ONLY_THINKING_MODEL =
  /^claude-(?:3-7-sonnet|sonnet-4(?:-0|-5)?|opus-4(?:-0|-1|-5)?|haiku-4-5)(?:-\d{8}|-latest)?$/

/** Models up to the 4.6 generation, which still accept non-default sampling parameters. */
const SAMPLING_MODEL =
  /^claude-(?:3-|(?:sonnet|opus|haiku)-4(?:-[0-6])?(?:-\d{8}|-latest)?$)/

/** True when the model only accepts `thinking: {type: 'enabled', budget_tokens}`. */
export function requiresBudgetThinking(model: string): boolean {
  return BUDGET_ONLY_THINKING_MODEL.test(model)
}

/**
 * True when the model accepts a non-default `temperature`, `top_p`, or
 * `top_k`. Claude Opus 4.7, Sonnet 5, and later reject them with HTTP 400.
 */
export function acceptsSamplingParams(model: string): boolean {
  return SAMPLING_MODEL.test(model)
}
