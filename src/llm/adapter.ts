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
 * const ollama    = createAdapter('ollama')           // uses http://localhost:11434
 * const ollamaRemote = createAdapter('ollama', 'http://my-server:11434')
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

/**
 * Instantiate the appropriate {@link LLMAdapter} for the given provider.
 *
 * For `'anthropic'` and `'openai'`, the second argument is an API key that
 * falls back to the standard environment variables (`ANTHROPIC_API_KEY` /
 * `OPENAI_API_KEY`) when not supplied explicitly.
 *
 * For `'ollama'`, the second argument is the base URL of the Ollama server
 * (e.g. `'http://localhost:11434'`). It falls back to the `OLLAMA_BASE_URL`
 * environment variable, then `http://localhost:11434`.
 *
 * Adapters are imported lazily so that projects using only one provider
 * are not forced to install the SDK for the other.
 *
 * @param provider   - Which LLM provider to target.
 * @param credential - API key (anthropic/openai) or base URL (ollama).
 * @throws {Error} When the provider string is not recognised.
 */
export async function createAdapter(
  provider: SupportedProvider,
  credential?: string,
): Promise<LLMAdapter> {
  switch (provider) {
    case 'anthropic': {
      const { AnthropicAdapter } = await import('./anthropic.js')
      return new AnthropicAdapter(credential)
    }
    case 'openai': {
      const { OpenAIAdapter } = await import('./openai.js')
      return new OpenAIAdapter(credential)
    }
    case 'ollama': {
      const { OllamaAdapter } = await import('./ollama.js')
      return new OllamaAdapter(credential)
    }
    default: {
      // The `never` cast here makes TypeScript enforce exhaustiveness.
      const _exhaustive: never = provider
      throw new Error(`Unsupported LLM provider: ${String(_exhaustive)}`)
    }
  }
}
