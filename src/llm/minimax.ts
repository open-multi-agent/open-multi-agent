/**
 * @fileoverview MiniMax adapter implementing {@link LLMAdapter}.
 *
 * MiniMax provides an OpenAI-compatible Chat Completions API at
 * `https://api.minimax.io/v1`, so this adapter delegates to the `openai` SDK
 * with a custom `baseURL` and handles MiniMax-specific constraints:
 *
 * - **Temperature** must be in the open interval (0, 1].  A caller-supplied
 *   value of `0` is clamped to `0.01` (deterministic-ish) and values above
 *   `1` are clamped to `1`.  When temperature is omitted the API default
 *   applies (the SDK omits the field rather than sending `undefined`).
 *
 * API key resolution order:
 *   1. `apiKey` constructor argument
 *   2. `MINIMAX_API_KEY` environment variable
 *
 * Supported models (204 K context window):
 *   - `MiniMax-M2.7`             — latest, highest capability
 *   - `MiniMax-M2.7-highspeed`   — faster, lower latency
 *   - `MiniMax-M2.5`             — previous generation
 *   - `MiniMax-M2.5-highspeed`   — previous generation, faster
 *
 * @example
 * ```ts
 * import { MiniMaxAdapter } from './minimax.js'
 *
 * const adapter = new MiniMaxAdapter()
 * const response = await adapter.chat(messages, {
 *   model: 'MiniMax-M2.7',
 *   maxTokens: 2048,
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
// Constants
// ---------------------------------------------------------------------------

/** Base URL for the MiniMax OpenAI-compatible Chat Completions API. */
const MINIMAX_BASE_URL = 'https://api.minimax.io/v1'

/**
 * MiniMax requires temperature in the open interval (0, 1].
 * Clamp zero → this floor and values above 1 → 1.
 */
const TEMP_FLOOR = 0.01
const TEMP_CEIL = 1.0

// ---------------------------------------------------------------------------
// Temperature helper
// ---------------------------------------------------------------------------

/**
 * Clamp a temperature value to MiniMax's accepted range (0, 1].
 *
 * - `undefined`  → `undefined` (let the API use its default)
 * - `<= 0`       → {@link TEMP_FLOOR} (0.01)
 * - `> 1`        → {@link TEMP_CEIL}  (1.0)
 * - otherwise    → unchanged
 */
function clampTemperature(temperature: number | undefined): number | undefined {
  if (temperature === undefined) return undefined
  if (temperature <= 0) return TEMP_FLOOR
  if (temperature > TEMP_CEIL) return TEMP_CEIL
  return temperature
}

// ---------------------------------------------------------------------------
// Internal helpers — framework → OpenAI wire format
// ---------------------------------------------------------------------------

function toMiniMaxTool(tool: LLMToolDef): ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as Record<string, unknown>,
    },
  }
}

function hasToolResults(msg: LLMMessage): boolean {
  return msg.content.some((b) => b.type === 'tool_result')
}

function toMiniMaxMessages(messages: LLMMessage[]): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = []

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      result.push(toMiniMaxAssistantMessage(msg))
    } else {
      if (!hasToolResults(msg)) {
        result.push(toMiniMaxUserMessage(msg))
      } else {
        const nonToolBlocks = msg.content.filter((b) => b.type !== 'tool_result')
        if (nonToolBlocks.length > 0) {
          result.push(toMiniMaxUserMessage({ role: 'user', content: nonToolBlocks }))
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

function toMiniMaxUserMessage(msg: LLMMessage): ChatCompletionUserMessageParam {
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
  }

  return { role: 'user', content: parts }
}

function toMiniMaxAssistantMessage(msg: LLMMessage): ChatCompletionAssistantMessageParam {
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
// Internal helpers — OpenAI wire format → framework
// ---------------------------------------------------------------------------

function fromMiniMaxCompletion(completion: ChatCompletion): LLMResponse {
  const choice = completion.choices[0]
  if (choice === undefined) {
    throw new Error('MiniMax returned a completion with no choices')
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
      // Malformed arguments — surface as empty object.
    }

    const toolUseBlock: ToolUseBlock = {
      type: 'tool_use',
      id: toolCall.id,
      name: toolCall.function.name,
      input: parsedInput,
    }
    content.push(toolUseBlock)
  }

  return {
    id: completion.id,
    content,
    model: completion.model,
    stop_reason: normalizeFinishReason(choice.finish_reason ?? 'stop'),
    usage: {
      input_tokens: completion.usage?.prompt_tokens ?? 0,
      output_tokens: completion.usage?.completion_tokens ?? 0,
    },
  }
}

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
 * LLM adapter backed by the MiniMax Chat Completions API.
 *
 * Uses the OpenAI SDK pointed at `https://api.minimax.io/v1`.
 * Thread-safe — a single instance may be shared across concurrent agent runs.
 */
export class MiniMaxAdapter implements LLMAdapter {
  readonly name = 'minimax'

  readonly #client: OpenAI

  constructor(apiKey?: string) {
    this.#client = new OpenAI({
      apiKey: apiKey ?? process.env['MINIMAX_API_KEY'],
      baseURL: MINIMAX_BASE_URL,
    })
  }

  // -------------------------------------------------------------------------
  // chat()
  // -------------------------------------------------------------------------

  /**
   * Send a synchronous (non-streaming) chat request and return the complete
   * {@link LLMResponse}.
   *
   * Temperature is clamped to MiniMax's accepted range (0, 1] before sending.
   */
  async chat(messages: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
    const miniMaxMessages = buildMiniMaxMessageList(messages, options.systemPrompt)

    const completion = await this.#client.chat.completions.create(
      {
        model: options.model,
        messages: miniMaxMessages,
        max_tokens: options.maxTokens,
        temperature: clampTemperature(options.temperature),
        tools: options.tools ? options.tools.map(toMiniMaxTool) : undefined,
        stream: false,
      },
      {
        signal: options.abortSignal,
      },
    )

    return fromMiniMaxCompletion(completion)
  }

  // -------------------------------------------------------------------------
  // stream()
  // -------------------------------------------------------------------------

  /**
   * Send a streaming chat request and yield {@link StreamEvent}s incrementally.
   *
   * Temperature is clamped to MiniMax's accepted range (0, 1] before sending.
   *
   * Sequence guarantees:
   * - Zero or more `text` events
   * - Zero or more `tool_use` events (emitted once per tool call, after
   *   arguments have been fully assembled)
   * - Exactly one terminal event: `done` or `error`
   */
  async *stream(
    messages: LLMMessage[],
    options: LLMStreamOptions,
  ): AsyncIterable<StreamEvent> {
    const miniMaxMessages = buildMiniMaxMessageList(messages, options.systemPrompt)

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
      const streamResponse = await this.#client.chat.completions.create(
        {
          model: options.model,
          messages: miniMaxMessages,
          max_tokens: options.maxTokens,
          temperature: clampTemperature(options.temperature),
          tools: options.tools ? options.tools.map(toMiniMaxTool) : undefined,
          stream: true,
          stream_options: { include_usage: true },
        },
        {
          signal: options.abortSignal,
        },
      )

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
          yield { type: 'text', data: delta.content } satisfies StreamEvent
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
        yield { type: 'tool_use', data: toolUseBlock } satisfies StreamEvent
      }

      const doneContent: ContentBlock[] = []
      if (fullText.length > 0) {
        doneContent.push({ type: 'text', text: fullText } satisfies TextBlock)
      }
      doneContent.push(...finalToolUseBlocks)

      const finalResponse: LLMResponse = {
        id: completionId,
        content: doneContent,
        model: completionModel,
        stop_reason: normalizeFinishReason(finalFinishReason),
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      }

      yield { type: 'done', data: finalResponse } satisfies StreamEvent
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      yield { type: 'error', data: error } satisfies StreamEvent
    }
  }
}

// ---------------------------------------------------------------------------
// Private utility
// ---------------------------------------------------------------------------

function buildMiniMaxMessageList(
  messages: LLMMessage[],
  systemPrompt: string | undefined,
): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = []

  if (systemPrompt !== undefined && systemPrompt.length > 0) {
    result.push({ role: 'system', content: systemPrompt })
  }

  result.push(...toMiniMaxMessages(messages))
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
