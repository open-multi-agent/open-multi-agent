/**
 * @fileoverview DeepSeek adapter.
 *
 * Thin wrapper around OpenAIAdapter that hard-codes the official DeepSeek
 * OpenAI-compatible endpoint and DEEPSEEK_API_KEY environment variable fallback.
 */

import { OpenAIAdapter } from './openai.js'

/**
 * LLM adapter for DeepSeek models (deepseek-chat, deepseek-reasoner, and future models).
 *
 * Thread-safe. Can be shared across agents.
 *
 * Usage:
 *   provider: 'deepseek'
 *   model: 'deepseek-chat' (or 'deepseek-reasoner' for the thinking model)
 */
export class DeepSeekAdapter extends OpenAIAdapter {
  readonly name = 'deepseek'

  constructor(apiKey?: string, baseURL?: string) {
    // Allow override of baseURL (for proxies or future changes) but default to official DeepSeek endpoint.
    super(
      apiKey ?? process.env['DEEPSEEK_API_KEY'],
      baseURL ?? 'https://api.deepseek.com/v1'
    )
  }
}
