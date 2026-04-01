/**
 * @fileoverview vLLM adapter implementing {@link LLMAdapter}.
 *
 * vLLM exposes an OpenAI-compatible API, so this adapter reuses all shared
 * helpers from `openai-compat.ts` and simply points the `openai` client at
 * a custom `baseURL`.
 *
 * @module @vcg/agent-sdk
 */

import OpenAI from 'openai'
import type { ChatCompletionChunk } from 'openai/resources/chat/completions/index.js'

import type {
  ContentBlock,
  LLMAdapter,
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  LLMStreamOptions,
  StreamEvent,
  TextBlock,
  ToolUseBlock,
  VLLMConfig,
} from '../types.js'

import {
  toOpenAITool,
  fromOpenAICompletion,
  normalizeFinishReason,
  buildOpenAIMessageList,
} from './openai-compat.js'

// ---------------------------------------------------------------------------
// VLLMAdapter
// ---------------------------------------------------------------------------

/**
 * LLM adapter for vLLM inference servers.
 *
 * vLLM is OpenAI-compatible, so this adapter reuses the same message
 * conversion and response parsing logic as the OpenAI adapter. The key
 * difference is the configurable `baseURL` pointing at a self-hosted
 * vLLM instance.
 *
 * @example
 * ```ts
 * const adapter = new VLLMAdapter({
 *   baseURL: 'http://localhost:8000/v1',
 *   model: 'meta-llama/Llama-3-70b-chat-hf',
 * })
 * const response = await adapter.chat(messages, { model: 'meta-llama/Llama-3-70b-chat-hf' })
 * ```
 */
export class VLLMAdapter implements LLMAdapter {
  readonly name = 'vllm'

  readonly #client: OpenAI
  readonly #config: VLLMConfig

  constructor(config: VLLMConfig) {
    this.#config = config
    this.#client = new OpenAI({
      baseURL: config.baseURL,
      apiKey: config.apiKey ?? 'dummy',
      timeout: config.timeout,
      maxRetries: config.maxRetries,
    })
  }

  // -------------------------------------------------------------------------
  // healthCheck()
  // -------------------------------------------------------------------------

  /**
   * Check whether the vLLM server is reachable by hitting `GET {baseURL}/health`.
   *
   * Returns `true` if the server responds with a 2xx status, `false` otherwise.
   */
  async healthCheck(): Promise<boolean> {
    try {
      // Strip trailing /v1 if present to hit the root health endpoint
      const base = this.#config.baseURL.replace(/\/v1\/?$/, '')
      const response = await fetch(`${base}/health`, {
        signal: AbortSignal.timeout(this.#config.timeout ?? 5000),
      })
      return response.ok
    } catch {
      return false
    }
  }

  // -------------------------------------------------------------------------
  // chat()
  // -------------------------------------------------------------------------

  async chat(messages: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
    const openAIMessages = buildOpenAIMessageList(messages, options.systemPrompt)

    const completion = await this.#client.chat.completions.create(
      {
        model: options.model ?? this.#config.model,
        messages: openAIMessages,
        max_tokens: options.maxTokens,
        temperature: options.temperature,
        tools: options.tools ? options.tools.map(toOpenAITool) : undefined,
        stream: false,
      },
      {
        signal: options.abortSignal,
      },
    )

    return fromOpenAICompletion(completion)
  }

  // -------------------------------------------------------------------------
  // stream()
  // -------------------------------------------------------------------------

  async *stream(
    messages: LLMMessage[],
    options: LLMStreamOptions,
  ): AsyncIterable<StreamEvent> {
    const openAIMessages = buildOpenAIMessageList(messages, options.systemPrompt)

    const streamResponse = await this.#client.chat.completions.create(
      {
        model: options.model ?? this.#config.model,
        messages: openAIMessages,
        max_tokens: options.maxTokens,
        temperature: options.temperature,
        tools: options.tools ? options.tools.map(toOpenAITool) : undefined,
        stream: true,
        stream_options: { include_usage: true },
      },
      {
        signal: options.abortSignal,
      },
    )

    let completionId = ''
    let completionModel = ''
    let finalFinishReason: string = 'stop'
    let inputTokens = 0
    let outputTokens = 0

    const toolCallBuffers = new Map<
      number,
      { id: string; name: string; argsJson: string }
    >()

    let fullText = ''

    try {
      for await (const chunk of streamResponse) {
        completionId = chunk.id
        completionModel = chunk.model

        if (chunk.usage !== null && chunk.usage !== undefined) {
          inputTokens = chunk.usage.prompt_tokens
          outputTokens = chunk.usage.completion_tokens
        }

        const choice: ChatCompletionChunk.Choice | undefined = chunk.choices[0]
        if (choice === undefined) continue

        const delta = choice.delta

        if (delta.content !== null && delta.content !== undefined) {
          fullText += delta.content
          const textEvent: StreamEvent = { type: 'text', data: delta.content }
          yield textEvent
        }

        for (const toolCallDelta of delta.tool_calls ?? []) {
          const idx = toolCallDelta.index

          if (!toolCallBuffers.has(idx)) {
            toolCallBuffers.set(idx, {
              id: toolCallDelta.id ?? '',
              name: toolCallDelta.function?.name ?? '',
              argsJson: '',
            })
          }

          const buf = toolCallBuffers.get(idx)
          if (buf !== undefined) {
            if (toolCallDelta.id) buf.id = toolCallDelta.id
            if (toolCallDelta.function?.name) buf.name = toolCallDelta.function.name
            if (toolCallDelta.function?.arguments) {
              buf.argsJson += toolCallDelta.function.arguments
            }
          }
        }

        if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
          finalFinishReason = choice.finish_reason
        }
      }

      const finalToolUseBlocks: ToolUseBlock[] = []
      for (const buf of toolCallBuffers.values()) {
        let parsedInput: Record<string, unknown> = {}
        try {
          const parsed: unknown = JSON.parse(buf.argsJson)
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            parsedInput = parsed as Record<string, unknown>
          }
        } catch {
          // Malformed JSON — surface as empty object.
        }

        const toolUseBlock: ToolUseBlock = {
          type: 'tool_use',
          id: buf.id,
          name: buf.name,
          input: parsedInput,
        }
        finalToolUseBlocks.push(toolUseBlock)
        const toolUseEvent: StreamEvent = { type: 'tool_use', data: toolUseBlock }
        yield toolUseEvent
      }

      const doneContent: ContentBlock[] = []
      if (fullText.length > 0) {
        const textBlock: TextBlock = { type: 'text', text: fullText }
        doneContent.push(textBlock)
      }
      doneContent.push(...finalToolUseBlocks)

      const finalResponse: LLMResponse = {
        id: completionId,
        content: doneContent,
        model: completionModel,
        stop_reason: normalizeFinishReason(finalFinishReason),
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      }

      const doneEvent: StreamEvent = { type: 'done', data: finalResponse }
      yield doneEvent
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      const errorEvent: StreamEvent = { type: 'error', data: error }
      yield errorEvent
    }
  }
}
