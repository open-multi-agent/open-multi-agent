/**
 * @fileoverview LLM adapter factory.
 *
 * Re-exports the {@link LLMAdapter} interface and provides a
 * {@link createAdapter} factory that returns the correct concrete
 * implementation based on the requested provider.
 *
 * @example
 * ```ts
 * import { createAdapter } from './adapter.js'
 *
 * const anthropic = createAdapter('anthropic')
 * const openai    = createAdapter('openai', process.env.OPENAI_API_KEY)
 * const ollama    = createAdapter('ollama')
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
} from '../types.js'

import type { LLMAdapter } from '../types.js'

/**
 * The set of LLM providers supported out of the box.
 * Additional providers can be integrated by implementing {@link LLMAdapter}
 * directly and bypassing this factory.
 */
export type SupportedProvider = 'anthropic' | 'openai' | 'ollama'
export type SupportedProvider = 'anthropic' | 'copilot' | 'openai'

/**
 * Instantiate the appropriate {@link LLMAdapter} for the given provider.
 *
 * API keys fall back to the standard environment variables
 * (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`) when not supplied explicitly.
 * Ollama uses `OLLAMA_BASE_URL` (defaults to http://localhost:11434).
 * API keys fall back to the standard environment variables when not supplied
 * explicitly:
 * - `anthropic` → `ANTHROPIC_API_KEY`
 * - `openai`    → `OPENAI_API_KEY`
 * - `copilot`   → `GITHUB_COPILOT_TOKEN` / `GITHUB_TOKEN`, or interactive
 *                  OAuth2 device flow if neither is set
 *
 * Adapters are imported lazily so that projects using only one provider
 * are not forced to install the SDK for the other.
 *
 * @param provider - Which LLM provider to target.
 * @param apiKey   - Optional API key override; falls back to env var.
 * @param baseURL  - Optional base URL for OpenAI-compatible APIs (Ollama, vLLM, etc.).
 * @throws {Error} When the provider string is not recognised.
 */
export async function createAdapter(
  provider: SupportedProvider,
  apiKey?: string,
  baseURL?: string,
): Promise<LLMAdapter> {
  switch (provider) {
    case 'anthropic': {
      const { AnthropicAdapter } = await import('./anthropic.js')
      return new AnthropicAdapter(apiKey, baseURL)
    }
    case 'copilot': {
      if (baseURL) {
        console.warn('[open-multi-agent] baseURL is not supported for the copilot provider and will be ignored.')
      }
      const { CopilotAdapter } = await import('./copilot.js')
      return new CopilotAdapter(apiKey)
    }
    case 'openai': {
      const { OpenAIAdapter } = await import('./openai.js')
      return new OpenAIAdapter(apiKey, baseURL)
    }
    case 'ollama': {
      const { OllamaAdapter } = await import('./ollama.js')
      return new OllamaAdapter()
    }
    default: {
      // The `never` cast here makes TypeScript enforce exhaustiveness.
      const _exhaustive: never = provider
      throw new Error(`Unsupported LLM provider: ${String(_exhaustive)}`)
    }
  }
}
