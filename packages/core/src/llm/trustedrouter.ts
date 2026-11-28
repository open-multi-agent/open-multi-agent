/**
 * @fileoverview TrustedRouter adapter.
 *
 * Thin wrapper around OpenAIAdapter that defaults to the TrustedRouter API
 * endpoint and TRUSTEDROUTER_API_KEY environment variable fallback.
 */

import type { EgressPolicy } from '../types.js'
import { OpenAIAdapter } from './openai.js'

/**
 * LLM adapter for models routed through TrustedRouter
 * (verifiable Confidential Space TEE inference with ZDR/E2E egress).
 *
 * Thread-safe. Can be shared across agents.
 *
 * Usage:
 *   provider: 'trustedrouter'
 *   model: 'trustedrouter/zdr' (or any of 600+ `vendor/model` IDs listed by
 *          GET /v1/models, plus routing presets such as `trustedrouter/auto`,
 *          `trustedrouter/zdr`, `trustedrouter/e2e`, and `nyte/auto`)
 */
export class TrustedRouterAdapter extends OpenAIAdapter {
  readonly name = 'trustedrouter'

  constructor(apiKey?: string, baseURL?: string, egressPolicy?: EgressPolicy) {
    // Allow override of baseURL (for proxies) but default to the official TrustedRouter endpoint.
    super(
      apiKey ?? process.env['TRUSTEDROUTER_API_KEY'],
      baseURL ?? 'https://api.trustedrouter.com/v1',
      egressPolicy,
      'trustedrouter',
    )
  }
}
