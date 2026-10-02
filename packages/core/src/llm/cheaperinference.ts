/**
 * @fileoverview Cheaper Inference adapter.
 *
 * Thin wrapper around OpenAIAdapter that hard-codes the official Cheaper
 * Inference OpenAI-compatible endpoint and CHEAPER_INFERENCE_API_KEY
 * environment variable fallback.
 */

import type { EgressPolicy } from '../types.js'
import { OpenAIAdapter } from './openai.js'

/**
 * LLM adapter for models served through the Cheaper Inference gateway.
 *
 * Thread-safe. Can be shared across agents.
 *
 * Usage:
 *   provider: 'cheaperinference'
 *   model: 'gpt-5.4-mini' (or any model available to your Cheaper Inference API key)
 */
export class CheaperInferenceAdapter extends OpenAIAdapter {
  readonly name = 'cheaperinference'

  constructor(apiKey?: string, baseURL?: string, egressPolicy?: EgressPolicy) {
    // Allow override of baseURL (for proxies or future changes) but default to official Cheaper Inference endpoint.
    super(
      apiKey ?? process.env['CHEAPER_INFERENCE_API_KEY'],
      baseURL ?? 'https://api.cheaperinference.com/v1',
      egressPolicy,
      'cheaperinference',
    )
  }
}
