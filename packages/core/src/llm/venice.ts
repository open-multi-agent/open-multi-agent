/**
 * @fileoverview Venice adapter.
 *
 * Thin wrapper around OpenAIAdapter that hard-codes the Venice API endpoint
 * and VENICE_API_KEY environment variable fallback.
 */

import type { EgressPolicy } from '../types.js'
import { OpenAIAdapter } from './openai.js'

/**
 * LLM adapter for models served by the Venice API.
 *
 * Thread-safe. Can be shared across agents.
 *
 * Usage:
 *   provider: 'venice'
 *   model: 'z-ai-glm-5-3-flash' (or any model ID listed by GET /models)
 */
export class VeniceAdapter extends OpenAIAdapter {
  readonly name = 'venice'

  constructor(apiKey?: string, baseURL?: string, egressPolicy?: EgressPolicy) {
    // Allow override of baseURL (for proxies) but default to the official Venice endpoint.
    super(
      apiKey ?? process.env['VENICE_API_KEY'],
      baseURL ?? 'https://api.venice.ai/api/v1',
      egressPolicy,
      'venice',
    )
  }
}
