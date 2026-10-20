/**
 * @fileoverview MiniMax adapter.
 *
 * Thin wrapper around OpenAIAdapter that hard-codes the official MiniMax
 * OpenAI-compatible endpoint and MINIMAX_API_KEY environment variable fallback.
 */

import type { EgressPolicy, LLMChatOptions, ThinkingConfig } from '../types.js'
import { OpenAIAdapter } from './openai.js'
import type { ReasoningOutboundOptions } from './reasoning-fallback.js'

/**
 * LLM adapter for MiniMax-M3.1-Flash and MiniMax-M3.
 * Explicit legacy and custom model names are passed through unchanged.
 *
 * Thread-safe. Can be shared across agents.
 *
 * Usage:
 *   provider: 'minimax'
 *   model: 'MiniMax-M3.1-Flash' (or 'MiniMax-M3')
 */
export class MiniMaxAdapter extends OpenAIAdapter {
  readonly name = 'minimax'

  override readonly capabilities = { echoesReasoning: 'tool-use-only' as const }

  protected override buildMessageOptions(options: LLMChatOptions): ReasoningOutboundOptions {
    return {
      preserveReasoningAsText: options.preserveReasoningAsText,
      compressReasoningText: options.compressReasoningText,
      // Flash returns separate reasoning that must survive tool-call follow-ups.
      nativeReasoningEchoProvider: options.model === 'MiniMax-M3.1-Flash' ? this.name : undefined,
    }
  }

  protected override buildExtraBody(options: LLMChatOptions): Record<string, unknown> | undefined {
    const extraBody = super.buildExtraBody(options)
    if (options.model !== 'MiniMax-M3.1-Flash' && options.model !== 'MiniMax-M3') return extraBody
    if (options.thinking === undefined) return extraBody
    // Keep extraBody as the explicit provider-native override, as in the base adapter.
    if (options.model === 'MiniMax-M3.1-Flash' && !options.thinking.enabled
      && extraBody?.['thinking'] === undefined) {
      // The existing retry classifier treats 400 as terminal, just like the API.
      throw Object.assign(
        new Error('MiniMax-M3.1-Flash requires adaptive thinking; it cannot be disabled.'),
        { status: 400 },
      )
    }
    return {
      thinking: { type: options.thinking.enabled ? 'adaptive' : 'disabled' },
      ...extraBody,
    }
  }

  protected override buildReasoningEffort(options: LLMChatOptions): ThinkingConfig['effort'] {
    if (options.model === 'MiniMax-M3.1-Flash') return options.thinking?.effort
    // M3 ignores effort. Preserve the inherited behavior for explicit legacy/custom models.
    if (options.model === 'MiniMax-M3') return undefined
    return super.buildReasoningEffort(options)
  }

  constructor(apiKey?: string, baseURL?: string, egressPolicy?: EgressPolicy) {
    // Allow override of baseURL (for proxies or future changes) but default to official MiniMax endpoint.
    super(
      apiKey ?? process.env['MINIMAX_API_KEY'],
      baseURL ?? process.env['MINIMAX_BASE_URL'] ?? 'https://api.minimax.io/v1',
      egressPolicy,
      'minimax',
    )
  }
}
