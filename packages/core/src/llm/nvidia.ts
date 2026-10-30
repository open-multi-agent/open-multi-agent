/**
 * @fileoverview NVIDIA NIM adapter.
 *
 * Thin wrapper around OpenAIAdapter that hard-codes the official NVIDIA NIM endpoint
 * and NVIDIA_API_KEY environment variable fallback.
 */

import type { EgressPolicy } from '../types.js'
import { OpenAIAdapter } from './openai.js'

/**
 * LLM adapter for NVIDIA NIM models (hosted at build.nvidia.com or self-hosted NIM).
 *
 * Thread-safe. Can be shared across agents.
 *
 * Usage:
 *   provider: 'nvidia'
 *   model: 'nvidia/nemotron-3.5-super-vl-120b-a12b' (or any current NIM model name)
 */
export class NvidiaAdapter extends OpenAIAdapter {
  readonly name = 'nvidia'

  constructor(apiKey?: string, baseURL?: string, egressPolicy?: EgressPolicy) {
    // Allow override of baseURL (for self-hosted NIM or proxies) but default to the official NVIDIA endpoint.
    super(
      apiKey ?? process.env['NVIDIA_API_KEY'],
      baseURL ?? 'https://integrate.api.nvidia.com/v1',
      egressPolicy,
      'nvidia',
    )
  }
}
