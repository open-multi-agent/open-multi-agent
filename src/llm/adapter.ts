/**
 * @fileoverview LLM adapter factory.
 *
 * Re-exports the {@link LLMAdapter} interface and provides a
 * {@link createAdapter} factory that returns the correct concrete
 * implementation based on the requested provider.
 *
 * @example
 * ```ts
 * import { createAdapter } from '@vcg/agent-sdk'
 *
 * const anthropic = createAdapter('anthropic')
 * const openai    = createAdapter('openai', process.env.OPENAI_API_KEY)
 * const vllm      = createAdapter('vllm', { baseURL: 'http://localhost:8000/v1', model: 'llama3' })
 * ```
 */

export type {
  LLMAdapter,
  LLMChatOptions,
  LLMStreamOptions,
  LLMToolDef,
  LLMMessage,
  LLMResponse,
  StreamEvent,
  TokenUsage,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ImageBlock,
  VLLMConfig,
} from '../types.js'

import type { LLMAdapter, VLLMConfig } from '../types.js'

/**
 * The set of LLM providers supported out of the box.
 * Additional providers can be integrated by implementing {@link LLMAdapter}
 * directly and bypassing this factory.
 */
export type SupportedProvider = 'anthropic' | 'openai' | 'vllm'

/**
 * Instantiate the appropriate {@link LLMAdapter} for the given provider.
 *
 * For `'anthropic'` and `'openai'`, the second argument is an optional API key
 * string (falls back to `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` env vars).
 *
 * For `'vllm'`, the second argument must be a {@link VLLMConfig} object.
 *
 * Adapters are imported lazily so that projects using only one provider
 * are not forced to install the SDK for the other.
 *
 * @param provider - Which LLM provider to target.
 * @param config   - API key string (for anthropic/openai) or VLLMConfig (for vllm).
 * @throws {Error} When the provider string is not recognised.
 */
export async function createAdapter(
  provider: SupportedProvider,
  config?: string | VLLMConfig,
): Promise<LLMAdapter> {
  switch (provider) {
    case 'anthropic': {
      const { AnthropicAdapter } = await import('./anthropic.js')
      const apiKey = typeof config === 'string' ? config : undefined
      return new AnthropicAdapter(apiKey)
    }
    case 'openai': {
      const { OpenAIAdapter } = await import('./openai.js')
      const apiKey = typeof config === 'string' ? config : undefined
      return new OpenAIAdapter(apiKey)
    }
    case 'vllm': {
      const { VLLMAdapter } = await import('./vllm.js')
      if (typeof config === 'object' && config !== null && 'baseURL' in config) {
        return new VLLMAdapter(config as VLLMConfig)
      }
      throw new Error(
        'createAdapter("vllm") requires a VLLMConfig object as the second argument ' +
        '(e.g. { baseURL: "http://localhost:8000/v1", model: "llama3" }).',
      )
    }
    default: {
      const _exhaustive: never = provider
      throw new Error(`Unsupported LLM provider: ${String(_exhaustive)}`)
    }
  }
}
