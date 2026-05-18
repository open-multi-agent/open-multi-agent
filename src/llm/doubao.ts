/**
 * @fileoverview DouBao adapter.
 *
 * Thin wrapper around OpenAIAdapter that hard-codes the official ByteDance DouBao
 * OpenAI-compatible endpoint and DOUBAO_API_KEY environment variable fallback.
 */

import { OpenAIAdapter } from './openai.js'

/**
 * LLM adapter for ByteDance DouBao models.
 *
 * Thread-safe. Can be shared across agents.
 *
 * Usage:
 *   provider: 'doubao'
 *   model: 'doubao-seed-2-0-lite-260428' (or any current DouBao model name)
 */
export class DoubaoAdapter extends OpenAIAdapter {
  readonly name = 'doubao'

  constructor(apiKey?: string, baseURL?: string) {
    // Allow override of baseURL (for proxies or future changes) but default to official DouBao endpoint.
    super(
      apiKey ?? process.env['DOUBAO_API_KEY'],
      baseURL ?? process.env['DOUBAO_BASE_URL'] ?? 'https://ark.cn-beijing.volces.com/api/v3'
    )
  }
}
