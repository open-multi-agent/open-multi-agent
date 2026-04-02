/**
 * @fileoverview Ollama adapter implementing {@link LLMAdapter}.
 *
 * Converts between the framework's internal {@link ContentBlock} types and the
 * Ollama Chat Completions wire format (OpenAI-compatible).
 * Key mapping decisions mirror {@link OpenAIAdapter}:
 *
 * - Framework `tool_use` blocks in assistant messages → Ollama `tool_calls`
 * - Framework `tool_result` blocks in user messages  → Ollama `tool` role messages
 * - Framework `image` blocks in user messages        → Ollama image content parts
 * - System prompt in {@link LLMChatOptions}           → prepended `system` message
 *
 * Ollama runs locally (ollama serve). No API key needed.
 * Resolution order for base URL:
 *   1. `OLLAMA_BASE_URL` environment variable
 *   2. `http://localhost:11434`
 *
 * @example
 * ```ts
 * import { createAdapter } from './adapter.js'
 *
 * const adapter = await createAdapter('ollama')
 * const response = await adapter.chat(messages, {
 *   model: 'llama3.1',
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
// Internal helpers — framework → Ollama (same as OpenAI)
// ---------------------------------------------------------------------------

/**
 * Convert a framework {@link LLMToolDef} to an Ollama {@link ChatCompletionTool}.
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

function hasToolResults(msg: LLMMessage): boolean {
  return msg.content.some((b) => b.type === 'tool_result')
}

function toOpenAIMessages(messages: LLMMessage[]): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = []

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      result.push(toOpenAIAssistantMessage(msg))
    } else {
      if (!hasToolResults(msg)) {
        result.push(toOpenAIUserMessage(msg))
      } else {
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

function toOpenAIUserMessage(msg: LLMMessage): ChatCompletionUserMessageParam {
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
// Internal helpers — Ollama → framework (same as OpenAI)
// ---------------------------------------------------------------------------

function fromOpenAICompletion(completion: ChatCompletion): LLMResponse {
  const choice = completion.choices[0]
  if (choice === undefined) {
    throw new Error('Ollama returned a completion with no choices')
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
 * LLM adapter backed by Ollama (OpenAI-compatible Chat Completions API).
 *
 * Local-first — run `ollama serve` and `ollama pull <model>`.
 * Thread-safe — share across concurrent runs.
 */
export class OllamaAdapter implements LLMAdapter {
  readonly name = 'ollama'

  readonly #client: OpenAI

  constructor() {
    this.#client = new OpenAI({
      baseURL: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
    })
  }

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

  async *stream(
    messages: LLMMessage[],
    options: LLMStreamOptions,
  ): AsyncIterable<StreamEvent> {
    const openAIMessages = buildOpenAIMessageList(messages, options.systemPrompt)

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

    let completionId = ''
    let completionModel = ''
    let finalFinishReason: string = 'stop'
    let inputTokens = 0
    let outputTokens = 0

    const toolCallBuffers = new Map<number, { id: string; name: string; argsJson: string }>()

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

          const buf = toolCallBuffers.get(idx)!
          if (toolCallDelta.id) buf.id = toolCallDelta.id
          if (toolCallDelta.function?.name) buf.name = toolCallDelta.function.name
          if (toolCallDelta.function?.arguments) {
            buf.argsJson += toolCallDelta.function.arguments
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
