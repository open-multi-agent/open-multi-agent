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
 * import { OpenAIAdapter } from '@vcg/agent-sdk'
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
  ChatCompletion,
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
  ChatCompletionToolMessageParam,
  ChatCompletionUserMessageParam,
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

// ---------------------------------------------------------------------------
// Internal helpers — framework → OpenAI
// ---------------------------------------------------------------------------

/**
 * Convert a framework {@link LLMToolDef} to an OpenAI {@link ChatCompletionTool}.
 *
 * OpenAI wraps the function definition inside a `function` key and a `type`
 * discriminant. The `inputSchema` is already a JSON Schema object.
 */
function toOpenAITool(tool: LLMToolDef): ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as Record<string, unknown>,
    },
  }
}

/**
 * Determine whether a framework message contains any `tool_result` content
 * blocks, which must be serialised as separate OpenAI `tool`-role messages.
 */
function hasToolResults(msg: LLMMessage): boolean {
  return msg.content.some((b) => b.type === 'tool_result')
}

/**
 * Convert a single framework {@link LLMMessage} into one or more OpenAI
 * {@link ChatCompletionMessageParam} entries.
 *
 * The expansion is necessary because OpenAI represents tool results as
 * top-level messages with role `tool`, whereas in our model they are content
 * blocks inside a `user` message.
 *
 * Expansion rules:
 * - A `user` message containing only text/image blocks → single user message
 * - A `user` message containing `tool_result` blocks → one `tool` message per
 *   tool_result block; any remaining text/image blocks are folded into an
 *   additional user message prepended to the group
 * - An `assistant` message → single assistant message with optional tool_calls
 */
function toOpenAIMessages(messages: LLMMessage[]): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = []

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      result.push(toOpenAIAssistantMessage(msg))
    } else {
      // user role
      if (!hasToolResults(msg)) {
        result.push(toOpenAIUserMessage(msg))
      } else {
        // Split: text/image blocks become a user message (if any exist), then
        // each tool_result block becomes an independent tool message.
        const nonToolBlocks = msg.content.filter((b) => b.type !== 'tool_result')
        if (nonToolBlocks.length > 0) {
          result.push(toOpenAIUserMessage({ role: 'user', content: nonToolBlocks }))
        }

        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            const toolMsg: ChatCompletionToolMessageParam = {
              role: 'tool',
              tool_call_id: block.tool_use_id,
              content: block.content,
            }
            result.push(toolMsg)
          }
        }
      }
    }
  }

  return result
}

/**
 * Convert a `user`-role framework message into an OpenAI user message.
 * Image blocks are converted to the OpenAI image_url content part format.
 */
function toOpenAIUserMessage(msg: LLMMessage): ChatCompletionUserMessageParam {
  // If the entire content is a single text block, use the compact string form
  // to keep the request payload smaller.
  if (msg.content.length === 1 && msg.content[0]?.type === 'text') {
    return { role: 'user', content: msg.content[0].text }
  }

  type ContentPart = OpenAI.Chat.ChatCompletionContentPartText | OpenAI.Chat.ChatCompletionContentPartImage
  const parts: ContentPart[] = []

  for (const block of msg.content) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      parts.push({
        type: 'image_url',
        image_url: {
          url: `data:${block.source.media_type};base64,${block.source.data}`,
        },
      })
    }
    // tool_result blocks are handled by the caller (toOpenAIMessages); skip here.
  }

  return { role: 'user', content: parts }
}

/**
 * Convert an `assistant`-role framework message into an OpenAI assistant message.
 *
 * Any `tool_use` blocks become `tool_calls`; `text` blocks become the message content.
 */
function toOpenAIAssistantMessage(msg: LLMMessage): ChatCompletionAssistantMessageParam {
  const toolCalls: ChatCompletionMessageToolCall[] = []
  const textParts: string[] = []

  for (const block of msg.content) {
    if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      })
    } else if (block.type === 'text') {
      textParts.push(block.text)
    }
  }

  const assistantMsg: ChatCompletionAssistantMessageParam = {
    role: 'assistant',
    content: textParts.length > 0 ? textParts.join('') : null,
  }

  if (toolCalls.length > 0) {
    assistantMsg.tool_calls = toolCalls
  }

  return assistantMsg
}

// ---------------------------------------------------------------------------
// Internal helpers — OpenAI → framework
// ---------------------------------------------------------------------------

/**
 * Convert an OpenAI {@link ChatCompletion} into a framework {@link LLMResponse}.
 *
 * We take only the first choice (index 0), consistent with how the framework
 * is designed for single-output agents.
 */
function fromOpenAICompletion(completion: ChatCompletion): LLMResponse {
  const choice = completion.choices[0]
  if (choice === undefined) {
    throw new Error('OpenAI returned a completion with no choices')
  }

  const content: ContentBlock[] = []
  const message = choice.message

  if (message.content !== null && message.content !== undefined) {
    const textBlock: TextBlock = { type: 'text', text: message.content }
    content.push(textBlock)
  }

  for (const toolCall of message.tool_calls ?? []) {
    let parsedInput: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(toolCall.function.arguments)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        parsedInput = parsed as Record<string, unknown>
      }
    } catch {
      // Malformed arguments from the model — surface as empty object.
    }

    const toolUseBlock: ToolUseBlock = {
      type: 'tool_use',
      id: toolCall.id,
      name: toolCall.function.name,
      input: parsedInput,
    }
    content.push(toolUseBlock)
  }

  const stopReason = normalizeFinishReason(choice.finish_reason ?? 'stop')

  return {
    id: completion.id,
    content,
    model: completion.model,
    stop_reason: stopReason,
    usage: {
      input_tokens: completion.usage?.prompt_tokens ?? 0,
      output_tokens: completion.usage?.completion_tokens ?? 0,
    },
  }
}

/**
 * Normalize an OpenAI `finish_reason` string to the framework's canonical
 * stop-reason vocabulary so consumers never need to branch on provider-specific
 * strings.
 *
 * Mapping:
 * - `'stop'`           → `'end_turn'`
 * - `'tool_calls'`     → `'tool_use'`
 * - `'length'`         → `'max_tokens'`
 * - `'content_filter'` → `'content_filter'`
 * - anything else      → passed through unchanged
 */
function normalizeFinishReason(reason: string): string {
  switch (reason) {
    case 'stop':           return 'end_turn'
    case 'tool_calls':     return 'tool_use'
    case 'length':         return 'max_tokens'
    case 'content_filter': return 'content_filter'
    default:               return reason
  }
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

/**
 * LLM adapter backed by the OpenAI Chat Completions API.
 *
 * Thread-safe — a single instance may be shared across concurrent agent runs.
 */
export class OpenAIAdapter implements LLMAdapter {
  readonly name = 'openai'

  readonly #client: OpenAI

  constructor(apiKey?: string) {
    this.#client = new OpenAI({
      apiKey: apiKey ?? process.env['OPENAI_API_KEY'],
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

    return fromOpenAICompletion(completion)
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

// ---------------------------------------------------------------------------
// Private utility
// ---------------------------------------------------------------------------

/**
 * Prepend a system message when `systemPrompt` is provided, then append the
 * converted conversation messages.
 *
 * OpenAI represents system instructions as a message with `role: 'system'`
 * at the top of the array, not as a separate API parameter.
 */
function buildOpenAIMessageList(
  messages: LLMMessage[],
  systemPrompt: string | undefined,
): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = []

  if (systemPrompt !== undefined && systemPrompt.length > 0) {
    result.push({ role: 'system', content: systemPrompt })
  }

  result.push(...toOpenAIMessages(messages))
  return result
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
