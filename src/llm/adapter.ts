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
 * const gemini    = createAdapter('gemini', process.env.GEMINI_API_KEY)
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
export type SupportedProvider = 'anthropic' | 'azure-openai' | 'bedrock' | 'copilot' | 'deepseek' | 'grok' | 'minimax' | 'openai' | 'gemini' | 'qiniu'

/**
 * Instantiate the appropriate {@link LLMAdapter} for the given provider.
 *
 * API keys fall back to the standard environment variables when not supplied
 * explicitly:
 * - `anthropic`    → `ANTHROPIC_API_KEY`
 * - `azure-openai` → `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_VERSION`, `AZURE_OPENAI_DEPLOYMENT`
 * - `openai`       → `OPENAI_API_KEY`
 * - `gemini`       → `GEMINI_API_KEY` / `GOOGLE_API_KEY`
 * - `grok`         → `XAI_API_KEY`
 * - `minimax`      → `MINIMAX_API_KEY`
 * - `deepseek`     → `DEEPSEEK_API_KEY`
 * - `qiniu`        → `QINIU_API_KEY`
 * - `bedrock`      → no API key; credentials via AWS SDK default provider chain
 *                     (env vars, shared config, IAM role). Pass `region` (4th arg)
 *                     or set `AWS_REGION`; falls back to `'us-east-1'`.
 * - `copilot`      → `GITHUB_COPILOT_TOKEN` / `GITHUB_TOKEN`, or interactive
 *                     OAuth2 device flow if neither is set
 *
 * Adapters are imported lazily so that projects using only one provider
 * are not forced to install the SDK for the other.
 *
 * @param provider - Which LLM provider to target.
 * @param apiKey   - Optional API key override; falls back to env var. Not used for `bedrock`.
 * @param baseURL  - Optional base URL for OpenAI-compatible APIs (Ollama, vLLM, etc.). Not used for `bedrock`.
 * @param region   - Optional AWS region for `bedrock`; falls back to `AWS_REGION` env var, then `'us-east-1'`. Ignored by all other providers.
 * @throws {Error} When the provider string is not recognised.
 */
export async function createAdapter(
  provider: SupportedProvider,
  apiKey?: string,
  baseURL?: string,
  region?: string,
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
    case 'gemini': {
      const { GeminiAdapter } = await import('./gemini.js')
      return new GeminiAdapter(apiKey)
    }
    case 'openai': {
      const { OpenAIAdapter } = await import('./openai.js')
      return new OpenAIAdapter(apiKey, baseURL)
    }
    case 'grok': {
      const { GrokAdapter } = await import('./grok.js')
      return new GrokAdapter(apiKey, baseURL)
    }
    case 'minimax': {
      const { MiniMaxAdapter } = await import('./minimax.js')
      return new MiniMaxAdapter(apiKey, baseURL)
    }
    case 'deepseek': {
      const { DeepSeekAdapter } = await import('./deepseek.js')
      return new DeepSeekAdapter(apiKey, baseURL)
    }
    case 'qiniu': {
      const { QiniuAdapter } = await import('./qiniu.js')
      return new QiniuAdapter(apiKey, baseURL)
    }
    case 'azure-openai': {
      // For azure-openai, the `baseURL` parameter serves as the Azure endpoint URL.
      // To override the API version, set AZURE_OPENAI_API_VERSION env var.
      const { AzureOpenAIAdapter } = await import('./azure-openai.js')
      return new AzureOpenAIAdapter(apiKey, baseURL)
    }
    case 'bedrock': {
      if (baseURL) console.warn('[open-multi-agent] baseURL is ignored for bedrock; pass region as the fourth arg or set AWS_REGION.')
      const { BedrockAdapter } = await import('./bedrock.js')
      return new BedrockAdapter(region)
    }
    default: {
      // The `never` cast here makes TypeScript enforce exhaustiveness.
      const _exhaustive: never = provider
      throw new Error(`Unsupported LLM provider: ${String(_exhaustive)}`)
    }
  }
}
