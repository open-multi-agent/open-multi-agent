/**
 * @fileoverview Ollama adapter implementing {@link LLMAdapter}.
 *
 * Supports local Ollama servers via `/api/chat` and handles function calling
 * with Ollama's OpenAI-compatible tool definition format.
 *
 * The adapter is intentionally lightweight: it uses the native Fetch API and
 * parses both regular JSON responses and SSE streams from Ollama.
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
  ToolResultBlock,
} from '../types.js'

const DEFAULT_BASE_URL = 'http://localhost:11434'

function hasToolResults(msg: LLMMessage): boolean {
  return msg.content.some((block) => block.type === 'tool_result')
}

function toOllamaTextContent(msg: LLMMessage): string {
  return msg.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

function toOllamaUserMessage(msg: LLMMessage): Record<string, unknown> {
  const text = toOllamaTextContent(msg)
  return {
    role: 'user',
    content: text || undefined,
  }
}

function toOllamaToolMessages(msg: LLMMessage): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = []

  for (const block of msg.content) {
    if (block.type !== 'tool_result') continue
    messages.push({
      role: 'tool',
      tool_call_id: block.tool_use_id,
      content: block.content,
    })
  }

  return messages
}

function toOllamaAssistantMessage(msg: LLMMessage): Record<string, unknown> {
  const text = toOllamaTextContent(msg)
  const assistantMessage: Record<string, unknown> = {
    role: 'assistant',
    content: text || undefined,
  }

  const toolCalls = msg.content
    .filter((block) => block.type === 'tool_use')
    .map((block) => ({
      id: block.id,
      type: 'function',
      function: {
        name: block.name,
        arguments: JSON.stringify(block.input),
      },
    }))

  if (toolCalls.length > 0) {
    assistantMessage.tool_calls = toolCalls
  }

  return assistantMessage
}

function toOllamaMessages(messages: LLMMessage[], systemPrompt?: string): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = []

  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt })
  }

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      result.push(toOllamaAssistantMessage(msg))
      continue
    }

    if (!hasToolResults(msg)) {
      result.push(toOllamaUserMessage(msg))
      continue
    }

    const text = toOllamaTextContent(msg)
    if (text.length > 0) {
      result.push({ role: 'user', content: text })
    }

    result.push(...toOllamaToolMessages(msg))
  }

  return result
}

function toOllamaFunction(tool: LLMToolDef): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }
}

function normalizeFinishReason(reason: unknown): string {
  if (typeof reason !== 'string') {
    return 'end_turn'
  }

  switch (reason) {
    case 'stop':
    case 'end_turn':
      return 'end_turn'
    case 'length':
      return 'max_tokens'
    case 'tool_call':
    case 'function_call':
      return 'tool_use'
    default:
      return reason
  }
}

function isMeaningfulOllamaMessage(message: any): boolean {
  if (!message || typeof message !== 'object') {
    return false
  }

  const content = message.content
  if (typeof content === 'string') {
    return content.trim().length > 0
  }

  if (Array.isArray(content)) {
    return content.length > 0
  }

  return false
}

function chooseBestResponseObject(objects: any[]): any {
  let best: any = null

  for (const obj of objects) {
    const message = obj.message ?? obj.choices?.[0]?.message
    if (isMeaningfulOllamaMessage(message)) {
      best = obj
    }
  }

  return best ?? objects[objects.length - 1]
}

function parseTextAsJson(text: string): any {
  const trimmed = text.trim()
  if (!trimmed) {
    return null
  }

  try {
    return JSON.parse(trimmed)
  } catch {
    // Fall through to SSE / NDJSON parsing.
  }

  const objects: any[] = []

  // Try server-sent events blocks.
  for (const chunk of trimmed.split(/\r?\n\r?\n/)) {
    let payload = ''
    for (const line of chunk.split(/\r?\n/)) {
      if (line.startsWith('data:')) {
        const value = line.slice(5).trim()
        if (value === '[DONE]') {
          continue
        }
        payload += value
      }
    }

    if (payload.length === 0) {
      continue
    }

    try {
      objects.push(JSON.parse(payload))
    } catch {
      // ignore non-JSON payloads
    }
  }

  if (objects.length > 0) {
    return chooseBestResponseObject(objects)
  }

  // Try line-delimited JSON fallback.
  for (const line of trimmed.split(/\r?\n/)) {
    const candidate = line.trim()
    if (!candidate) continue
    try {
      objects.push(JSON.parse(candidate))
    } catch {
      // ignore
    }
  }

  if (objects.length > 0) {
    return chooseBestResponseObject(objects)
  }

  return null
}

function parseToolCall(message: any): ToolUseBlock | null {
  const toolCall = message?.tool_call ?? message?.tool_call?.arguments ? message?.tool_call : undefined
  if (!toolCall || typeof toolCall.name !== 'string') {
    return null
  }

  let input: Record<string, unknown> = {}
  if (typeof toolCall.arguments === 'string') {
    try {
      const parsed = JSON.parse(toolCall.arguments)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        input = parsed as Record<string, unknown>
      }
    } catch {
      // ignore malformed JSON
    }
  } else if (toolCall.arguments && typeof toolCall.arguments === 'object') {
    input = toolCall.arguments as Record<string, unknown>
  }

  return {
    type: 'tool_use',
    id: toolCall.id ?? `${toolCall.name}:${Math.random().toString(16).slice(2)}`,
    name: toolCall.name,
    input,
  }
}

function parseOllamaContent(message: any): ContentBlock[] {
  if (typeof message === 'string') {
    return [{ type: 'text', text: message }]
  }

  const content: ContentBlock[] = []
  const items = Array.isArray(message.content) ? message.content : []

  for (const item of items) {
    if (item?.type === 'text' && typeof item.text === 'string') {
      content.push({ type: 'text', text: item.text })
    } else if (item?.type === 'tool_use' && typeof item.id === 'string' && typeof item.name === 'string') {
      content.push({
        type: 'tool_use',
        id: item.id,
        name: item.name,
        input: item.input ?? {},
      })
    } else if (item?.type === 'tool_result' && typeof item.tool_use_id === 'string') {
      content.push({
        type: 'tool_result',
        tool_use_id: item.tool_use_id,
        content: typeof item.content === 'string' ? item.content : String(item.content ?? ''),
        is_error: Boolean(item.is_error),
      })
    } else if (item?.type === 'image' && item.source) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: item.source.media_type ?? 'image/png',
          data: item.source.data ?? '',
        },
      })
    } else if (typeof item === 'string') {
      content.push({ type: 'text', text: item })
    }
  }

  return content.length > 0
    ? content
    : [{ type: 'text', text: String(message.content ?? '') }]
}

function buildOllamaResponse(body: any): LLMResponse {
  const choice = Array.isArray(body.choices) && body.choices.length > 0
    ? body.choices[0]
    : null

  const message = choice?.message ?? body.message ?? body
  const content = parseOllamaContent(message)

  const toolUse = parseToolCall(message)
  if (toolUse) {
    content.push(toolUse)
  }

  return {
    id: body.id ?? choice?.id ?? '',
    content,
    model: body.model ?? choice?.model ?? 'ollama',
    stop_reason: normalizeFinishReason(choice?.finish_reason ?? body.finish_reason),
    usage: {
      input_tokens: body.usage?.prompt_tokens ?? body.usage?.input_tokens ?? 0,
      output_tokens: body.usage?.completion_tokens ?? body.usage?.output_tokens ?? 0,
    },
  }
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$|$/, '')
}

/**
 * Lightweight adapter for Ollama's local `/api/chat` endpoint.
 */
export class OllamaAdapter implements LLMAdapter {
  readonly name = 'ollama'
  readonly #baseUrl: string
  readonly #apiKey?: string

  constructor(apiKey?: string, baseUrl = DEFAULT_BASE_URL) {
    const envApiKey = (globalThis as any).process?.env?.OLLAMA_API_KEY
    this.#apiKey = apiKey ?? (typeof envApiKey === 'string' ? envApiKey : undefined)
    this.#baseUrl = stripTrailingSlash(baseUrl)
  }

  private buildRequestBody(messages: LLMMessage[], options: LLMChatOptions): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: options.model,
      messages: toOllamaMessages(messages, options.systemPrompt),
      temperature: options.temperature ?? 1,
      max_tokens: options.maxTokens,
    }

    if (options.tools) {
      body.functions = options.tools.map(toOllamaFunction)
      body.function_call = 'auto'
    }

    return body
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    if (this.#apiKey) {
      headers.Authorization = `Bearer ${this.#apiKey}`
    }

    return headers
  }

  // -------------------------------------------------------------------------
  // chat()
  // -------------------------------------------------------------------------

  async chat(messages: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
    const url = `${this.#baseUrl}/api/chat`
    const requestBody = this.buildRequestBody(messages, options)
    requestBody.stream = false

    const response = await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(requestBody),
      signal: options.abortSignal,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Ollama API request failed (${response.status}): ${text}`)
    }

    const text = await response.text()
    const body = parseTextAsJson(text)
    if (body === null) {
      throw new Error(
        `Ollama API returned invalid JSON response: ${text.slice(0, 200)}`,
      )
    }

    return buildOllamaResponse(body)
  }

  // -------------------------------------------------------------------------
  // stream()
  // -------------------------------------------------------------------------

  async *stream(messages: LLMMessage[], options: LLMStreamOptions): AsyncIterable<StreamEvent> {
    const url = `${this.#baseUrl}/api/chat`
    const requestBody = this.buildRequestBody(messages, options)
    requestBody.stream = true

    const response = await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(requestBody),
      signal: options.abortSignal,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Ollama API request failed (${response.status}): ${text}`)
    }

    const reader = response.body?.getReader()
    if (!reader) {
      throw new Error('Ollama stream response has no body')
    }

    const decoder = new TextDecoder()
    let buffer = ''
    let lastMessage: any = null
    let accumulatedText = ''

    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) {
          break
        }

        buffer += decoder.decode(value, { stream: true })

        while (true) {
          const boundary = buffer.indexOf('\n\n')
          if (boundary === -1) {
            break
          }

          const packet = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const lines = packet.split(/\r?\n/)
          let data = ''

          for (const line of lines) {
            if (line.startsWith('data:')) {
              data += line.slice(5).trim()
            }
          }

          if (data === '[DONE]') {
            buffer = ''
            break
          }

          if (!data) {
            continue
          }

          try {
            const payload = JSON.parse(data)
            const choice = Array.isArray(payload.choices) && payload.choices.length > 0
              ? payload.choices[0]
              : null
            const delta = choice?.delta ?? payload.delta

            if (delta?.content) {
              const text = String(delta.content)
              accumulatedText += text
              yield { type: 'text', data: text }
            }

            const toolDelta = delta?.tool_call ?? payload.tool_call
            if (toolDelta || choice?.message?.tool_call || payload.message?.tool_call) {
              const toolCallMessage = toolDelta ?? choice?.message?.tool_call ?? payload.message?.tool_call
              const toolUse = parseToolCall({ tool_call: toolCallMessage })
              if (toolUse) {
                yield { type: 'tool_use', data: toolUse }
              }
            }

            if (payload.message) {
              lastMessage = payload.message
            }
            if (choice?.message) {
              lastMessage = choice.message
            }
          } catch {
            // Ignore malformed SSE payloads.
          }
        }
      }

      let finalMessage: any = lastMessage ?? {
        id: '',
        model: options.model,
        message: { content: [{ type: 'text', text: accumulatedText }] },
        usage: { prompt_tokens: 0, completion_tokens: 0 },
        finish_reason: 'stop',
      }

      const isEmptyMessage = finalMessage?.message &&
        ((typeof finalMessage.message.content === 'string' && finalMessage.message.content.trim() === '') ||
          (Array.isArray(finalMessage.message.content) && finalMessage.message.content.length === 0))

      if (isEmptyMessage && accumulatedText.length > 0) {
        finalMessage = {
          ...finalMessage,
          message: { content: [{ type: 'text', text: accumulatedText }] },
        }
      }

      const finalResponse: LLMResponse = buildOllamaResponse(finalMessage)

      yield { type: 'done', data: finalResponse }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      yield { type: 'error', data: error }
    }
  }
}
