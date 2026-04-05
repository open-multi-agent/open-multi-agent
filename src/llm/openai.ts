/**
 * @fileoverview OpenAI adapter implementing {@link LLMAdapter}.
 *
 * Converts between the framework's internal {@link ContentBlock} types and the
 * OpenAI Chat Completions wire format. Key mapping decisions:
 *
 * - Framework `tool_use` blocks in assistant messages → OpenAI `tool_calls`
 * - Framework `tool_result` blocks in user messages  → OpenAI `tool` role messages
 * - Framework `image` blocks in user messages        → OpenAI image content parts
 * - System prompt in {@link LLMChatOptions}           → prepended `system` message
 *
 * Because OpenAI and Anthropic use fundamentally different role-based structures
 * for tool calling (Anthropic embeds tool results in user-role content arrays;
 * OpenAI uses a dedicated `tool` role), the conversion necessarily splits
 * `tool_result` blocks out into separate top-level messages.
 *
 * API key resolution order:
 *   1. `apiKey` constructor argument
 *   2. `OPENAI_API_KEY` environment variable
 *
 * @example
 * ```ts
 * import { OpenAIAdapter } from './openai.js'
 *
 * const adapter = new OpenAIAdapter()
 * const response = await adapter.chat(messages, {
 *   model: 'gpt-5.4',
 *   maxTokens: 1024,
 * })
 * ```
 */

import OpenAI from 'openai'
import type {
  ChatCompletionChunk,
} from 'openai/resources/chat/completions/index.js'

import type {
  ContentBlock,
  LLMAdapter,
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  LLMStreamOptions,
  LLMToolDef,
  StreamEvent,
  TextBlock,
  ToolUseBlock,
} from '../types.js'

import {
  toOpenAITool,
  fromOpenAICompletion,
  normalizeFinishReason,
  buildOpenAIMessageList,
} from './openai-common.js'
import { extractToolCallsFromText } from '../tool/text-tool-extractor.js'

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

/**
 * LLM adapter backed by the OpenAI Chat Completions API.
 *
 * Thread-safe — a single instance may be shared across concurrent agent runs.
 */
export class OpenAIAdapter implements LLMAdapter {
  readonly name: string = 'openai'

  readonly #client: OpenAI

  constructor(apiKey?: string, baseURL?: string) {
    this.#client = new OpenAI({
      apiKey: apiKey ?? process.env['OPENAI_API_KEY'],
      baseURL,
    })
  }

  // -------------------------------------------------------------------------
  // chat()
  // -------------------------------------------------------------------------

  /**
   * Send a synchronous (non-streaming) chat request and return the complete
   * {@link LLMResponse}.
   *
   * Throws an `OpenAI.APIError` on non-2xx responses. Callers should catch and
   * handle these (e.g. rate limits, context length exceeded).
   */
  async chat(messages: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
    const openAIMessages = buildOpenAIMessageList(messages, options.systemPrompt)

    const completion = await this.#client.chat.completions.create(
      {
        model: options.model,
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

    const toolNames = options.tools?.map(t => t.name)
    return fromOpenAICompletion(completion, toolNames)
  }

  // -------------------------------------------------------------------------
  // stream()
  // -------------------------------------------------------------------------

  /**
   * Send a streaming chat request and yield {@link StreamEvent}s incrementally.
   *
   * Sequence guarantees match {@link AnthropicAdapter.stream}:
   * - Zero or more `text` events
   * - Zero or more `tool_use` events (emitted once per tool call, after
   *   arguments have been fully assembled)
   * - Exactly one terminal event: `done` or `error`
   */
  async *stream(
    messages: LLMMessage[],
    options: LLMStreamOptions,
  ): AsyncIterable<StreamEvent> {
    const openAIMessages = buildOpenAIMessageList(messages, options.systemPrompt)

    // We request usage in the final chunk so we can include it in the `done` event.
    const streamResponse = await this.#client.chat.completions.create(
      {
        model: options.model,
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

    // Accumulate state across chunks.
    let completionId = ''
    let completionModel = ''
    let finalFinishReason: string = 'stop'
    let inputTokens = 0
    let outputTokens = 0

    // tool_calls are streamed piecemeal; key = tool call index
    const toolCallBuffers = new Map<
      number,
      { id: string; name: string; argsJson: string }
    >()

    // Full text accumulator for the `done` response.
    let fullText = ''

    try {
      for await (const chunk of streamResponse) {
        completionId = chunk.id
        completionModel = chunk.model

        // Usage is only populated in the final chunk when stream_options.include_usage is set.
        if (chunk.usage !== null && chunk.usage !== undefined) {
          inputTokens = chunk.usage.prompt_tokens
          outputTokens = chunk.usage.completion_tokens
        }

        const choice: ChatCompletionChunk.Choice | undefined = chunk.choices[0]
        if (choice === undefined) continue

        const delta = choice.delta

        // --- text delta ---
        if (delta.content !== null && delta.content !== undefined) {
          fullText += delta.content
          const textEvent: StreamEvent = { type: 'text', data: delta.content }
          yield textEvent
        }

        // --- tool call delta ---
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
          // buf is guaranteed to exist: we just set it above.
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

      // Emit accumulated tool_use events after the stream ends.
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

      // Build the complete content array for the done response.
      const doneContent: ContentBlock[] = []
      if (fullText.length > 0) {
        const textBlock: TextBlock = { type: 'text', text: fullText }
        doneContent.push(textBlock)
      }
      doneContent.push(...finalToolUseBlocks)

      // Fallback: extract tool calls from text when streaming produced no
      // native tool_calls (same logic as fromOpenAICompletion).
      if (finalToolUseBlocks.length === 0 && fullText.length > 0 && options.tools) {
        const toolNames = options.tools.map(t => t.name)
        const extracted = extractToolCallsFromText(fullText, toolNames)
        if (extracted.length > 0) {
          doneContent.push(...extracted)
          for (const block of extracted) {
            yield { type: 'tool_use', data: block } satisfies StreamEvent
          }
        }
      }

      const hasToolUseBlocks = doneContent.some(b => b.type === 'tool_use')
      const resolvedStopReason = hasToolUseBlocks && finalFinishReason === 'stop'
        ? 'tool_use'
        : normalizeFinishReason(finalFinishReason)

      const finalResponse: LLMResponse = {
        id: completionId,
        content: doneContent,
        model: completionModel,
        stop_reason: resolvedStopReason,
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

// Re-export types that consumers of this module commonly need alongside the adapter.
export type {
  ContentBlock,
  LLMAdapter,
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  LLMStreamOptions,
  LLMToolDef,
  StreamEvent,
}
