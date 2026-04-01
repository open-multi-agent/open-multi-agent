/// <reference types="node" />

/**
 * @fileoverview Ollama adapter implementing {@link LLMAdapter}.
 *
 * Calls the Ollama HTTP API at `/api/chat` to run local models (Qwen, Llama,
 * Mistral, etc.) without any external SDK. Uses the Node.js built-in `fetch`
 * API (available since Node 18).
 *
 * Key mapping decisions:
 *
 * - Framework `tool_use` blocks in assistant messages → Ollama `tool_calls`
 * - Framework `tool_result` blocks in user messages  → Ollama `tool` role messages
 * - System prompt in {@link LLMChatOptions}           → prepended `system` message
 * - Ollama does not return IDs for tool calls;        → IDs are generated with
 *   `crypto.randomUUID()`
 *
 * Base URL resolution order:
 *   1. `baseUrl` constructor argument
 *   2. `OLLAMA_BASE_URL` environment variable
 *   3. `http://localhost:11434`
 *
 * @example
 * ```ts
 * import { OllamaAdapter } from './ollama.js'
 *
 * const adapter = new OllamaAdapter()
 * const response = await adapter.chat(messages, {
 *   model: 'qwen2.5',
 *   maxTokens: 1024,
 * })
 * ```
 */

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
// Ollama wire types
// ---------------------------------------------------------------------------

interface OllamaToolCallFunction {
  name: string
  arguments: Record<string, unknown>
}

interface OllamaToolCall {
  function: OllamaToolCallFunction
}

interface OllamaMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  tool_calls?: OllamaToolCall[]
}

interface OllamaTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

interface OllamaOptions {
  temperature?: number
  num_predict?: number
}

interface OllamaChatRequest {
  model: string
  messages: OllamaMessage[]
  tools?: OllamaTool[]
  options?: OllamaOptions
  stream: boolean
}

interface OllamaChatResponse {
  model: string
  created_at: string
  message: OllamaMessage
  done: boolean
  done_reason?: string
  prompt_eval_count?: number
  eval_count?: number
}

// ---------------------------------------------------------------------------
// Internal helpers — framework → Ollama
// ---------------------------------------------------------------------------

/**
 * Convert a framework {@link LLMToolDef} to an Ollama tool definition.
 */
function toOllamaTool(tool: LLMToolDef): OllamaTool {
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
 * Convert framework {@link LLMMessage} array (plus optional system prompt)
 * into an Ollama messages array.
 *
 * - `tool_result` blocks become separate `tool`-role messages (one per block)
 * - `tool_use` blocks in assistant messages become `tool_calls`
 * - A system prompt is prepended as a `system`-role message
 */
function toOllamaMessages(
  messages: LLMMessage[],
  systemPrompt: string | undefined,
): OllamaMessage[] {
  const result: OllamaMessage[] = []

  if (systemPrompt !== undefined && systemPrompt.length > 0) {
    result.push({ role: 'system', content: systemPrompt })
  }

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      result.push(toOllamaAssistantMessage(msg))
    } else {
      // user role — split tool_result blocks out as separate `tool` messages
      const toolResultBlocks = msg.content.filter((b) => b.type === 'tool_result')
      const otherBlocks = msg.content.filter((b) => b.type !== 'tool_result')

      if (otherBlocks.length > 0) {
        const textContent = otherBlocks
          .filter((b): b is TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
        result.push({ role: 'user', content: textContent })
      }

      for (const block of toolResultBlocks) {
        if (block.type === 'tool_result') {
          result.push({ role: 'tool', content: block.content })
        }
      }
    }
  }

  return result
}

/**
 * Convert an `assistant`-role framework message to an Ollama assistant message.
 *
 * Any `tool_use` blocks become `tool_calls`; `text` blocks become the message
 * content string.
 */
function toOllamaAssistantMessage(msg: LLMMessage): OllamaMessage {
  const toolCalls: OllamaToolCall[] = []
  const textParts: string[] = []

  for (const block of msg.content) {
    if (block.type === 'tool_use') {
      toolCalls.push({
        function: {
          name: block.name,
          arguments: block.input,
        },
      })
    } else if (block.type === 'text') {
      textParts.push(block.text)
    }
  }

  const message: OllamaMessage = {
    role: 'assistant',
    content: textParts.join(''),
  }

  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls
  }

  return message
}

// ---------------------------------------------------------------------------
// Internal helpers — Ollama → framework
// ---------------------------------------------------------------------------

/**
 * Parse tool call arguments from an Ollama response.
 *
 * Ollama returns `arguments` as a JSON object directly, but we defensively
 * handle the case where it arrives as a serialised string (e.g. some older
 * model releases).
 */
function parseToolArguments(args: unknown): Record<string, unknown> {
  if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>
  }
  if (typeof args === 'string') {
    try {
      const parsed: unknown = JSON.parse(args)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Malformed JSON — surface as empty object.
    }
  }
  return {}
}

/**
 * Normalise an Ollama `done_reason` string to the framework's canonical
 * stop-reason vocabulary.
 *
 * Mapping:
 * - `'stop'`       → `'end_turn'`
 * - `'tool_calls'` → `'tool_use'`
 * - `'length'`     → `'max_tokens'`
 * - anything else  → passed through unchanged
 */
function normalizeDoneReason(reason: string | undefined): string {
  switch (reason) {
    case 'stop':       return 'end_turn'
    case 'tool_calls': return 'tool_use'
    case 'length':     return 'max_tokens'
    default:           return reason ?? 'end_turn'
  }
}

/**
 * Convert an {@link OllamaChatResponse} into a framework {@link LLMResponse}.
 */
function fromOllamaResponse(data: OllamaChatResponse): LLMResponse {
  const content: ContentBlock[] = []
  const message = data.message

  if (message.content.length > 0) {
    const textBlock: TextBlock = { type: 'text', text: message.content }
    content.push(textBlock)
  }

  for (const tc of message.tool_calls ?? []) {
    const toolUseBlock: ToolUseBlock = {
      type: 'tool_use',
      id: crypto.randomUUID(),
      name: tc.function.name,
      input: parseToolArguments(tc.function.arguments),
    }
    content.push(toolUseBlock)
  }

  return {
    id: crypto.randomUUID(),
    content,
    model: data.model,
    stop_reason: normalizeDoneReason(data.done_reason),
    usage: {
      input_tokens: data.prompt_eval_count ?? 0,
      output_tokens: data.eval_count ?? 0,
    },
  }
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

/**
 * LLM adapter backed by the Ollama HTTP API.
 *
 * Requires a locally-running Ollama instance. The default base URL is
 * `http://localhost:11434`; override via the constructor or the
 * `OLLAMA_BASE_URL` environment variable.
 *
 * No API key is required — Ollama runs entirely on your own hardware.
 *
 * Thread-safe — a single instance may be shared across concurrent agent runs.
 */
export class OllamaAdapter implements LLMAdapter {
  readonly name = 'ollama'

  readonly #baseUrl: string

  constructor(baseUrl?: string) {
    this.#baseUrl = (
      baseUrl ?? process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434'
    ).replace(/\/$/, '')
  }

  // -------------------------------------------------------------------------
  // chat()
  // -------------------------------------------------------------------------

  /**
   * Send a synchronous (non-streaming) chat request and return the complete
   * {@link LLMResponse}.
   *
   * Throws an `Error` on non-2xx responses or network failures. Callers should
   * catch and handle these (e.g. model not found, Ollama not running).
   */
  async chat(messages: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
    const ollamaMessages = toOllamaMessages(messages, options.systemPrompt)

    const body: OllamaChatRequest = {
      model: options.model,
      messages: ollamaMessages,
      stream: false,
    }

    if (options.tools !== undefined && options.tools.length > 0) {
      body.tools = options.tools.map(toOllamaTool)
    }

    const ollamaOptions: OllamaOptions = {}
    if (options.temperature !== undefined) ollamaOptions.temperature = options.temperature
    if (options.maxTokens !== undefined) ollamaOptions.num_predict = options.maxTokens
    if (Object.keys(ollamaOptions).length > 0) body.options = ollamaOptions

    const response = await fetch(`${this.#baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: options.abortSignal,
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText)
      throw new Error(`Ollama API error ${response.status}: ${errorText}`)
    }

    const data: OllamaChatResponse = (await response.json()) as OllamaChatResponse
    return fromOllamaResponse(data)
  }

  // -------------------------------------------------------------------------
  // stream()
  // -------------------------------------------------------------------------

  /**
   * Send a streaming chat request and yield {@link StreamEvent}s incrementally.
   *
   * Ollama streams responses as NDJSON (newline-delimited JSON). Text deltas
   * are emitted immediately; tool calls (when present) are accumulated and
   * emitted after the stream ends, matching the contract of other adapters.
   *
   * Sequence guarantees:
   * - Zero or more `text` events (incremental text deltas)
   * - Zero or more `tool_use` events (emitted once per tool call, after stream ends)
   * - Exactly one terminal event: `done` or `error`
   */
  async *stream(
    messages: LLMMessage[],
    options: LLMStreamOptions,
  ): AsyncIterable<StreamEvent> {
    const ollamaMessages = toOllamaMessages(messages, options.systemPrompt)

    const body: OllamaChatRequest = {
      model: options.model,
      messages: ollamaMessages,
      stream: true,
    }

    if (options.tools !== undefined && options.tools.length > 0) {
      body.tools = options.tools.map(toOllamaTool)
    }

    const ollamaOptions: OllamaOptions = {}
    if (options.temperature !== undefined) ollamaOptions.temperature = options.temperature
    if (options.maxTokens !== undefined) ollamaOptions.num_predict = options.maxTokens
    if (Object.keys(ollamaOptions).length > 0) body.options = ollamaOptions

    try {
      const response = await fetch(`${this.#baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: options.abortSignal,
      })

      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText)
        throw new Error(`Ollama API error ${response.status}: ${errorText}`)
      }

      if (response.body === null) {
        throw new Error('Ollama streaming response has no body')
      }

      // Accumulate state across chunks.
      let responseModel = options.model
      let doneReason: string | undefined
      let inputTokens = 0
      let outputTokens = 0
      let fullText = ''
      const toolCallBuffers: OllamaToolCall[] = []

      // Read the NDJSON stream line by line.
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let lineBuffer = ''

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          lineBuffer += decoder.decode(value, { stream: true })
          const lines = lineBuffer.split('\n')
          // Keep the last (possibly incomplete) line in the buffer.
          lineBuffer = lines.pop() ?? ''

          for (const line of lines) {
            const event = parseStreamChunk(line)
            if (event === null) continue

            responseModel = event.model

            if (event.message.content.length > 0) {
              fullText += event.message.content
              const textEvent: StreamEvent = { type: 'text', data: event.message.content }
              yield textEvent
            }

            if (event.message.tool_calls !== undefined) {
              for (const tc of event.message.tool_calls) {
                toolCallBuffers.push(tc)
              }
            }

            if (event.done) {
              doneReason = event.done_reason
              inputTokens = event.prompt_eval_count ?? 0
              outputTokens = event.eval_count ?? 0
            }
          }
        }

        // Handle any remaining data left in the line buffer after EOF.
        const finalEvent = parseStreamChunk(lineBuffer)
        if (finalEvent !== null) {
          responseModel = finalEvent.model
          if (finalEvent.message.content.length > 0) {
            fullText += finalEvent.message.content
            const textEvent: StreamEvent = { type: 'text', data: finalEvent.message.content }
            yield textEvent
          }
          if (finalEvent.message.tool_calls !== undefined) {
            for (const tc of finalEvent.message.tool_calls) {
              toolCallBuffers.push(tc)
            }
          }
          if (finalEvent.done) {
            doneReason = finalEvent.done_reason
            inputTokens = finalEvent.prompt_eval_count ?? 0
            outputTokens = finalEvent.eval_count ?? 0
          }
        }
      } finally {
        reader.releaseLock()
      }

      // Emit accumulated tool_use events after the stream ends.
      const finalToolUseBlocks: ToolUseBlock[] = []
      for (const tc of toolCallBuffers) {
        const toolUseBlock: ToolUseBlock = {
          type: 'tool_use',
          id: crypto.randomUUID(),
          name: tc.function.name,
          input: parseToolArguments(tc.function.arguments),
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
        id: crypto.randomUUID(),
        content: doneContent,
        model: responseModel,
        stop_reason: normalizeDoneReason(doneReason),
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
 * Parse a single NDJSON line from the Ollama streaming response.
 * Returns `null` for empty or unparseable lines.
 */
function parseStreamChunk(line: string): OllamaChatResponse | null {
  const trimmed = line.trim()
  if (trimmed.length === 0) return null
  try {
    return JSON.parse(trimmed) as OllamaChatResponse
  } catch {
    return null
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
