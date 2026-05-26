/**
 * @fileoverview DeepSeek adapter.
 *
 * Thin wrapper around OpenAIAdapter that hard-codes the official DeepSeek
 * OpenAI-compatible endpoint and DEEPSEEK_API_KEY environment variable fallback.
 */

import { OpenAIAdapter } from './openai.js'

/**
 * LLM adapter for DeepSeek V4 models. Both models support a 1M context window.
 *
 * Thread-safe. Can be shared across agents.
 *
 * Usage:
 *   provider: 'deepseek'
 *   model: 'deepseek-v4-flash' (economical) or 'deepseek-v4-pro' (flagship)
 *
 * Legacy `deepseek-chat` and `deepseek-reasoner` map to the non-thinking and
 * thinking modes of `deepseek-v4-flash` respectively, and will be fully retired
 * by DeepSeek on 2026-07-24.
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
