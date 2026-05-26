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
  // back on every follow-up request that includes a prior tool-use assistant
  // turn; omitting it returns 400. See:
  //   https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
  // The `'tool-use-only'` capability tells the OpenAIAdapter base class to
  // pass `nativeReasoningEchoProvider: 'deepseek'` to the message builder,
  // which attaches `reasoning_content` on outbound assistant messages that
  // contain `tool_calls` and carry a deepseek-provenance reasoning block.
  // Non-tool turns drop the reasoning (it would pollute context without
  // benefit; the spec says it is ignored there anyway).
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
