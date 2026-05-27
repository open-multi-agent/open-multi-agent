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

  // DeepSeek V4 in thinking mode requires `reasoning_content` to be echoed
  // back on EVERY intermediate assistant message of a tool-calling
  // conversation, including the final synthesis message that has no
  // `tool_calls` of its own. Omitting any of them 400s on the next user
  // turn. See:
  //   https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
  // The `'tool-use-only'` capability tells the OpenAIAdapter base class to
  // pass `nativeReasoningEchoProvider: 'deepseek'` to the message builder,
  // which attaches `reasoning_content` on every assistant message in a
  // tool-calling conversation that carries a deepseek-provenance reasoning
  // block. Non-tool conversations drop reasoning entirely (the spec says
  // it is ignored there but would still bloat context).
  override readonly capabilities = {
    echoesReasoning: 'tool-use-only' as const,
  }

  constructor(apiKey?: string, baseURL?: string) {
    // Allow override of baseURL (for proxies or future changes) but default to official DeepSeek endpoint.
    super(
      apiKey ?? process.env['DEEPSEEK_API_KEY'],
      baseURL ?? 'https://api.deepseek.com/v1'
    )
  }
}
