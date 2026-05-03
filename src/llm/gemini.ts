/**
 * @fileoverview Google Gemini adapter implementing {@link LLMAdapter}.
 *
 * Built for `@google/genai` (the unified Google Gen AI SDK, v1.x), NOT the
 * legacy `@google/generative-ai` package.
 *
 * Converts between the framework's internal {@link ContentBlock} types and the
 * `@google/genai` SDK's wire format, handling tool definitions, system prompts,
 * and both batch and streaming response paths.
 *
 * API key resolution order:
 *   1. `apiKey` constructor argument
 *   2. `GEMINI_API_KEY` environment variable
 *   3. `GOOGLE_API_KEY` environment variable
 *
 * @example
 * ```ts
 * import { GeminiAdapter } from './gemini.js'
 *
 * const adapter = new GeminiAdapter()
 * const response = await adapter.chat(messages, {
 *   model: 'gemini-2.5-flash',
 *   maxTokens: 1024,
 * })
 * ```
 */

import {
  GoogleGenAI,
  FunctionCallingConfigMode,
  type Content,
  type FunctionDeclaration,
  type GenerateContentConfig,
  type GenerateContentResponse,
  type Part,
  type ThinkingConfig as GeminiThinkingConfig,
  type Tool as GeminiTool,
} from '@google/genai'

import type {
  ContentBlock,
  LLMAdapter,
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  LLMStreamOptions,
  LLMToolDef,
  ReasoningBlock,
  StreamEvent,
  ThinkingConfig,
  ToolUseBlock,
} from '../types.js'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Map framework role names to Gemini role names.
 *
 * Gemini uses `"model"` instead of `"assistant"`.
 */
function toGeminiRole(role: 'user' | 'assistant'): string {
  return role === 'assistant' ? 'model' : 'user'
}

/**
 * Convert framework messages into Gemini's {@link Content}[] format.
 *
 * Key differences from Anthropic:
 * - Gemini uses `"model"` instead of `"assistant"`.
 * - `functionResponse` parts (tool results) must appear in `"user"` turns.
 * - `functionCall` parts appear in `"model"` turns.
 * - We build a name lookup map from tool_use blocks so tool_result blocks
 *   can resolve the function name required by Gemini's `functionResponse`.
 *
 * Reasoning handling: Gemini's `thoughtSignature` is a top-level field on
 * Part that accompanies a functionCall Part, identifying the signed thought
 * sequence that produced the call. We attach it to the outgoing Part
 * whenever the source {@link ToolUseBlock} carries a signature. Thought
 * summaries (incoming text Parts with `thought: true` surfaced as
 * {@link ReasoningBlock}) are echoed back only when they carry a signature
 * — Gemini 3 recommends round-tripping these signatures, but unsigned
 * reasoning (e.g. cross-provider blocks or Gemini 2.5 thought summaries
 * which never carry signatures) is dropped to keep context lean.
 */
function toGeminiContents(messages: LLMMessage[]): Content[] {
  // First pass: build id → name map for resolving tool results.
  const toolNameById = new Map<string, string>()
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        toolNameById.set(block.id, block.name)
      }
    }
  }

  return messages.map((msg): Content => {
    const parts: Part[] = []
    for (const block of msg.content) {
      switch (block.type) {
        case 'reasoning': {
          // Echo only when we have a signature to round-trip — see JSDoc
          // above. Drop unsigned reasoning silently rather than emitting an
          // empty/unsigned text part that would inflate context for no
          // protocol benefit.
          if (block.signature === undefined) break
          const part: Part = {
            text: block.text,
            thought: true,
            thoughtSignature: block.signature,
          }
          parts.push(part)
          break
        }

        case 'text':
          parts.push({ text: block.text })
          break

        case 'tool_use': {
          const part: Part = {
            functionCall: {
              id: block.id,
              name: block.name,
              args: block.input,
            },
          }
          if (block.signature !== undefined) {
            // thoughtSignature is a top-level field on Part (NOT nested under
            // functionCall) — see Part schema in @google/genai. Required by
            // Gemini 3+ to maintain extended-thinking context across tool-use
            // turns.
            part.thoughtSignature = block.signature
          }
          parts.push(part)
          break
        }

        case 'tool_result': {
          const name = toolNameById.get(block.tool_use_id) ?? block.tool_use_id
          parts.push({
            functionResponse: {
              id: block.tool_use_id,
              name,
              response: {
                content:
                  typeof block.content === 'string'
                    ? block.content
                    : JSON.stringify(block.content),
                isError: block.is_error ?? false,
              },
            },
          })
          break
        }

        case 'image':
          parts.push({
            inlineData: {
              mimeType: block.source.media_type,
              data: block.source.data,
            },
          })
          break

        default: {
          const _exhaustive: never = block
          throw new Error(`Unhandled content block type: ${JSON.stringify(_exhaustive)}`)
        }
      }
    }

    return { role: toGeminiRole(msg.role), parts }
  })
}

/**
 * Convert framework {@link LLMToolDef}s into a Gemini `tools` config array.
 *
 * In `@google/genai`, function declarations use `parametersJsonSchema` (not
 * `parameters` or `input_schema`). All declarations are grouped under a single
 * tool entry.
 */
function toGeminiTools(tools: readonly LLMToolDef[]): GeminiTool[] {
  const functionDeclarations: FunctionDeclaration[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parametersJsonSchema: t.inputSchema as Record<string, unknown>,
  }))
  return [{ functionDeclarations }]
}

/**
 * Convert the framework's {@link ThinkingConfig} into Gemini's
 * `thinkingConfig`. Returns `undefined` when the caller hasn't opted in,
 * leaving the field absent so server defaults apply.
 *
 * `includeThoughts` defaults on when extended thinking is enabled — the
 * thought-summary stream is the only way for callers to surface model
 * reasoning, and the cost of the metadata is negligible. `thinkingBudget`
 * is forwarded only when the caller specifies one (Gemini accepts -1 to
 * mean "dynamic").
 */
function toGeminiThinkingConfig(
  thinking: ThinkingConfig | undefined,
): GeminiThinkingConfig | undefined {
  if (thinking === undefined || !thinking.enabled) return undefined
  const config: GeminiThinkingConfig = { includeThoughts: true }
  if (thinking.budgetTokens !== undefined) {
    config.thinkingBudget = thinking.budgetTokens
  }
  return config
}

/**
 * Build the {@link GenerateContentConfig} shared by chat() and stream().
 */
function buildConfig(
  options: LLMChatOptions | LLMStreamOptions,
): GenerateContentConfig {
  return {
    maxOutputTokens: options.maxTokens ?? 4096,
    temperature: options.temperature,
    systemInstruction: options.systemPrompt,
    tools: options.tools ? toGeminiTools(options.tools) : undefined,
    toolConfig: options.tools
      ? { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } }
      : undefined,
    thinkingConfig: toGeminiThinkingConfig(options.thinking),
    abortSignal: options.abortSignal,
  }
}

/**
 * Generate a stable pseudo-random ID string for tool use blocks.
 *
 * Gemini may not always return call IDs (especially in streaming), so we
 * fabricate them when absent to satisfy the framework's {@link ToolUseBlock}
 * contract.
 */
function generateId(): string {
  return `gemini-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

/**
 * Extract the function call ID from a Gemini part, or generate one.
 *
 * The `id` field exists in newer API versions but may be absent in older
 * responses, so we cast conservatively and fall back to a generated ID.
 */
function getFunctionCallId(part: Part): string {
  return (part.functionCall as { id?: string } | undefined)?.id ?? generateId()
}

/**
 * Extract `thoughtSignature` from a Gemini Part.
 *
 * Gemini puts thoughtSignature as a top-level field on Part (NOT nested
 * under functionCall, despite some early docs implying otherwise — see
 * the Part schema in @google/genai). Gemini 3+ rejects subsequent turns
 * when the signature isn't echoed back unchanged on the corresponding
 * functionCall part.
 */
function getThoughtSignature(part: Part): string | undefined {
  return part.thoughtSignature
}

/**
 * Convert a single Gemini {@link Part} into zero or one framework
 * {@link ContentBlock}s. Returns `null` for parts we don't model so the
 * caller can skip them without inflating the content array.
 *
 * Recognised inputs:
 * - text part with `thought: true` → {@link ReasoningBlock} (thought summary,
 *   carries `thoughtSignature` on Gemini 3 if present)
 * - regular text part            → {@link TextBlock}
 * - functionCall part            → {@link ToolUseBlock} (with optional signature)
 */
function fromGeminiPart(part: Part): ContentBlock | null {
  if (part.functionCall !== undefined) {
    const block: ToolUseBlock = {
      type: 'tool_use',
      id: getFunctionCallId(part),
      name: part.functionCall.name ?? '',
      input: (part.functionCall.args ?? {}) as Record<string, unknown>,
    }
    const signature = getThoughtSignature(part)
    if (signature !== undefined) {
      return { ...block, signature }
    }
    return block
  }
  if (part.text !== undefined && part.text !== '') {
    if ((part as { thought?: boolean }).thought === true) {
      const reasoning: ReasoningBlock = { type: 'reasoning', text: part.text }
      // Gemini 3 may attach thoughtSignature to thought-summary parts too.
      // Preserve it on the framework block so the next turn can echo it
      // back — see toGeminiContents reasoning case for the round-trip.
      const signature = getThoughtSignature(part)
      if (signature !== undefined) {
        return { ...reasoning, signature }
      }
      return reasoning
    }
    return { type: 'text', text: part.text }
  }
  // inlineData echoes and other part types are silently ignored.
  return null
}

/**
 * Convert a Gemini {@link GenerateContentResponse} into a framework
 * {@link LLMResponse}.
 */
function fromGeminiResponse(
  response: GenerateContentResponse,
  id: string,
  model: string,
): LLMResponse {
  const candidate = response.candidates?.[0]
  const content: ContentBlock[] = []

  for (const part of candidate?.content?.parts ?? []) {
    const block = fromGeminiPart(part)
    if (block !== null) content.push(block)
  }

  // Map Gemini finish reasons to framework stop_reason vocabulary.
  const finishReason = candidate?.finishReason as string | undefined
  let stop_reason: LLMResponse['stop_reason'] = 'end_turn'
  if (finishReason === 'MAX_TOKENS') {
    stop_reason = 'max_tokens'
  } else if (content.some((b) => b.type === 'tool_use')) {
    // Gemini may report STOP even when it returned function calls.
    stop_reason = 'tool_use'
  }

  const usage = response.usageMetadata
  return {
    id,
    content,
    model,
    stop_reason,
    usage: {
      input_tokens: usage?.promptTokenCount ?? 0,
      output_tokens: usage?.candidatesTokenCount ?? 0,
    },
  }
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

/**
 * LLM adapter backed by the Google Gemini API via `@google/genai`.
 *
 * Thread-safe — a single instance may be shared across concurrent agent runs.
 * The underlying SDK client is stateless across requests.
 */
export class GeminiAdapter implements LLMAdapter {
  readonly name = 'gemini'

  readonly #client: GoogleGenAI

  constructor(apiKey?: string) {
    this.#client = new GoogleGenAI({
      apiKey: apiKey ?? process.env['GEMINI_API_KEY'] ?? process.env['GOOGLE_API_KEY'],
    })
  }

  // -------------------------------------------------------------------------
  // chat()
  // -------------------------------------------------------------------------

  /**
   * Send a synchronous (non-streaming) chat request and return the complete
   * {@link LLMResponse}.
   *
   * Uses `ai.models.generateContent()` with the full conversation as `contents`,
   * which is the idiomatic pattern for `@google/genai`.
   */
  async chat(messages: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
    const id = generateId()
    const contents = toGeminiContents(messages)

    const response = await this.#client.models.generateContent({
      model: options.model,
      contents,
      config: buildConfig(options),
    })

    return fromGeminiResponse(response, id, options.model)
  }

  // -------------------------------------------------------------------------
  // stream()
  // -------------------------------------------------------------------------

  /**
   * Send a streaming chat request and yield {@link StreamEvent}s as they
   * arrive from the API.
   *
   * Uses `ai.models.generateContentStream()` which returns an
   * `AsyncGenerator<GenerateContentResponse>`. Each yielded chunk has the same
   * shape as a full response but contains only the delta for that chunk.
   *
   * Because `@google/genai` doesn't expose a `finalMessage()` helper like the
   * Anthropic SDK, we accumulate content and token counts as we stream so that
   * the terminal `done` event carries a complete and accurate {@link LLMResponse}.
   *
   * Sequence guarantees (matching the Anthropic adapter):
   * - Zero or more `text` events with incremental deltas
   * - Zero or more `tool_use` events (one per call; Gemini doesn't stream args)
   * - Exactly one terminal event: `done` or `error`
   */
  async *stream(
    messages: LLMMessage[],
    options: LLMStreamOptions,
  ): AsyncIterable<StreamEvent> {
    const id = generateId()
    const contents = toGeminiContents(messages)

    try {
      const streamResponse = await this.#client.models.generateContentStream({
        model: options.model,
        contents,
        config: buildConfig(options),
      })

      // Accumulators for building the done payload.
      const accumulatedContent: ContentBlock[] = []
      let inputTokens = 0
      let outputTokens = 0
      let lastFinishReason: string | undefined

      for await (const chunk of streamResponse) {
        const candidate = chunk.candidates?.[0]

        // Accumulate token counts — the API emits these on the final chunk.
        if (chunk.usageMetadata) {
          inputTokens = chunk.usageMetadata.promptTokenCount ?? inputTokens
          outputTokens = chunk.usageMetadata.candidatesTokenCount ?? outputTokens
        }
        if (candidate?.finishReason) {
          lastFinishReason = candidate.finishReason as string
        }

        for (const part of candidate?.content?.parts ?? []) {
          const block = fromGeminiPart(part)
          if (block === null) continue
          accumulatedContent.push(block)
          switch (block.type) {
            case 'text':
              yield { type: 'text', data: block.text } satisfies StreamEvent
              break
            case 'reasoning':
              // Thought summary delta — surface as a reasoning event so
              // observers can stream model thinking the same way they do
              // for Anthropic's `thinking_delta`.
              yield { type: 'reasoning', data: block.text } satisfies StreamEvent
              break
            case 'tool_use':
              yield { type: 'tool_use', data: block } satisfies StreamEvent
              break
            // No other block types come back from Gemini parts.
          }
        }
      }

      // Determine stop_reason from the accumulated response.
      const hasToolUse = accumulatedContent.some((b) => b.type === 'tool_use')
      let stop_reason: LLMResponse['stop_reason'] = 'end_turn'
      if (lastFinishReason === 'MAX_TOKENS') {
        stop_reason = 'max_tokens'
      } else if (hasToolUse) {
        stop_reason = 'tool_use'
      }

      const finalResponse: LLMResponse = {
        id,
        content: accumulatedContent,
        model: options.model,
        stop_reason,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      }

      yield { type: 'done', data: finalResponse } satisfies StreamEvent
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      yield { type: 'error', data: error } satisfies StreamEvent
    }
  }
}
