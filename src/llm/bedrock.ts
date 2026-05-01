/**
 * @fileoverview AWS Bedrock LLM adapter implementing {@link LLMAdapter}.
 *
 * Uses the Converse / ConverseStream APIs from `@aws-sdk/client-bedrock-runtime`
 * (the unified Anthropic-shaped schema) so the same adapter works across Claude,
 * Llama, Mistral, Cohere, and Titan model families without per-model shims.
 *
 * Region resolution order:
 *   1. `region` constructor argument
 *   2. `AWS_REGION` environment variable
 *   3. `'us-east-1'` (hard fallback)
 *
 * AWS credentials are resolved via the SDK default provider chain:
 * env vars → shared config file → EC2/ECS/Lambda IAM role.
 *
 * @example
 * ```ts
 * import { BedrockAdapter } from './bedrock.js'
 *
 * const adapter = new BedrockAdapter('us-east-1')
 * const response = await adapter.chat(messages, {
 *   model: 'anthropic.claude-3-5-haiku-20241022-v1:0',
 *   maxTokens: 1024,
 * })
 * ```
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime'
import type {
  ContentBlock as BedrockContentBlock,
  ConversationRole,
  Message as BedrockMessage,
  ToolConfiguration,
  InferenceConfiguration,
} from '@aws-sdk/client-bedrock-runtime'

import type {
  ContentBlock,
  ImageBlock,
  LLMAdapter,
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  LLMStreamOptions,
  LLMToolDef,
  ReasoningBlock,
  StreamEvent,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from '../types.js'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const MEDIA_TYPE_TO_FORMAT: Record<string, 'jpeg' | 'png' | 'gif' | 'webp'> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

function base64ToUint8Array(b64: string): Uint8Array {
  return Buffer.from(b64, 'base64')
}

/**
 * Convert a single framework {@link ContentBlock} into a Bedrock
 * {@link BedrockContentBlock} for the messages array.
 *
 * Reasoning blocks are dropped on input — see the `case 'reasoning'` arm below
 * for the round-trip limitation that forces this.
 */
function toBedrockContentBlock(block: ContentBlock): BedrockContentBlock | null {
  switch (block.type) {
    case 'text':
      return { text: block.text }

    case 'tool_use':
      // DocumentType is not publicly exported from the SDK; cast the whole block.
      return {
        toolUse: { toolUseId: block.id, name: block.name, input: block.input },
      } as BedrockContentBlock

    case 'tool_result': {
      const rawContent = block.content
      const textContent = typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent)
      return {
        toolResult: {
          toolUseId: block.tool_use_id,
          content: [{ text: textContent }],
          status: block.is_error ? 'error' : 'success',
        },
      }
    }

    case 'image': {
      const format = MEDIA_TYPE_TO_FORMAT[block.source.media_type] ?? 'png'
      return {
        image: {
          format,
          source: { bytes: base64ToUint8Array(block.source.data) },
        },
      }
    }

    case 'reasoning':
      // Limitation comment for future: Bedrock *does* accept reasoning back from clients, and in fact requires
      // the original reasoning text + its `signature` field unchanged when
      // continuing a multi-turn tool-use conversation with extended thinking.
      // The framework's ReasoningBlock currently has no place to carry that
      // signature, so a round-trip would silently strip it and Bedrock would
      // reject the next turn. Until the shared type grows a signature field
      // (tracked as a follow-up framework change), we drop reasoning on input.
      return null

    default: {
      const _exhaustive: never = block
      throw new Error(`Unhandled content block type: ${JSON.stringify(_exhaustive)}`)
    }
  }
}

/**
 * Convert framework messages into Bedrock `Message[]`.
 *
 * System prompt is passed separately via `options.systemPrompt` and handled
 * in `chat()`/`stream()` — it never appears as a message role in the framework.
 * Reasoning blocks are silently dropped on input — see {@link toBedrockContentBlock}
 * for why; multi-turn tool-use flows with extended thinking are not yet fully
 * supported until the framework's ReasoningBlock can carry a Bedrock signature.
 */
function toBedrockMessages(messages: LLMMessage[]): BedrockMessage[] {
  const bedrockMessages: BedrockMessage[] = []

  for (const msg of messages) {
    const content: BedrockContentBlock[] = []
    for (const block of msg.content) {
      const converted = toBedrockContentBlock(block)
      if (converted !== null) content.push(converted)
    }
    if (content.length > 0) {
      bedrockMessages.push({ role: msg.role as ConversationRole, content })
    }
  }

  return bedrockMessages
}

function toBedrockTools(tools: readonly LLMToolDef[]): ToolConfiguration {
  // Tool is a discriminated union with a required $unknown variant; cast to satisfy it.
  const bedrockTools = tools.map((t) => ({
    toolSpec: {
      name: t.name,
      description: t.description,
      inputSchema: { json: t.inputSchema as Record<string, unknown> },
    },
  })) as unknown as ToolConfiguration['tools']
  return { tools: bedrockTools }
}

/**
 * Convert a Bedrock response {@link BedrockContentBlock} into a framework
 * {@link ContentBlock}.
 *
 * `toolUse.input` arrives as a parsed object in chat() responses.
 */
function fromBedrockContentBlock(block: BedrockContentBlock): ContentBlock | null {
  if (block.text !== undefined) {
    const text: TextBlock = { type: 'text', text: block.text }
    return text
  }
  if (block.toolUse !== undefined) {
    const toolUse: ToolUseBlock = {
      type: 'tool_use',
      id: block.toolUse.toolUseId ?? '',
      name: block.toolUse.name ?? '',
      input: (block.toolUse.input as Record<string, unknown>) ?? {},
    }
    return toolUse
  }
  if (block.reasoningContent !== undefined) {
    const r = block.reasoningContent as { reasoningText?: { text?: string } }
    const reasoning: ReasoningBlock = {
      type: 'reasoning',
      text: r.reasoningText?.text ?? '',
    }
    return reasoning
  }
  return null
}

function buildInferenceConfig(options: LLMChatOptions): InferenceConfiguration | undefined {
  const cfg: InferenceConfiguration = {}
  if (options.maxTokens !== undefined) cfg.maxTokens = options.maxTokens ?? 4096
  if (options.temperature !== undefined) cfg.temperature = options.temperature
  if (options.topP !== undefined) cfg.topP = options.topP
  return Object.keys(cfg).length > 0 ? cfg : undefined
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

/**
 * LLM adapter backed by AWS Bedrock Converse / ConverseStream APIs.
 *
 * Thread-safe — a single instance may be shared across concurrent agent runs.
 */
export class BedrockAdapter implements LLMAdapter {
  readonly name = 'bedrock'

  readonly #client: BedrockRuntimeClient

  constructor(region?: string) {
    const resolvedRegion = region ?? process.env['AWS_REGION'] ?? 'us-east-1'
    this.#client = new BedrockRuntimeClient({ region: resolvedRegion })
  }

  // -------------------------------------------------------------------------
  // chat()
  // -------------------------------------------------------------------------

  async chat(messages: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
    const bedrockMessages = toBedrockMessages(messages)
    const system = options.systemPrompt ? [{ text: options.systemPrompt }] : undefined

    const input: ConstructorParameters<typeof ConverseCommand>[0] = {
      modelId: options.model,
      messages: bedrockMessages,
      system,
      toolConfig: options.tools ? toBedrockTools(options.tools) : undefined,
      inferenceConfig: buildInferenceConfig(options) ?? { maxTokens: 4096 },
    }

    if (options.topK !== undefined || options.extraBody) {
      input.additionalModelRequestFields = {
        ...(options.topK !== undefined ? { top_k: options.topK } : {}),
        ...(options.extraBody as Record<string, unknown> | undefined),
      }
    }

    const response = await this.#client.send(new ConverseCommand(input), {
      abortSignal: options.abortSignal,
    })

    const rawContent = response.output?.message?.content ?? []
    const content = rawContent
      .map(fromBedrockContentBlock)
      .filter((b): b is ContentBlock => b !== null)

    return {
      id: response.$metadata.requestId ?? '',
      content,
      model: options.model,
      stop_reason: (response.stopReason as string) ?? 'end_turn',
      usage: {
        input_tokens: response.usage?.inputTokens ?? 0,
        output_tokens: response.usage?.outputTokens ?? 0,
      },
    }
  }

  // -------------------------------------------------------------------------
  // stream()
  // -------------------------------------------------------------------------

  async *stream(messages: LLMMessage[], options: LLMStreamOptions): AsyncIterable<StreamEvent> {
    const bedrockMessages = toBedrockMessages(messages)
    const system = options.systemPrompt ? [{ text: options.systemPrompt }] : undefined

    const input: ConstructorParameters<typeof ConverseStreamCommand>[0] = {
      modelId: options.model,
      messages: bedrockMessages,
      system,
      toolConfig: options.tools ? toBedrockTools(options.tools) : undefined,
      inferenceConfig: buildInferenceConfig(options) ?? { maxTokens: 4096 },
    }

    if (options.topK !== undefined || options.extraBody) {
      input.additionalModelRequestFields = {
        ...(options.topK !== undefined ? { top_k: options.topK } : {}),
        ...(options.extraBody as Record<string, unknown> | undefined),
      }
    }

    // Accumulate tool-use input JSON deltas; keyed by content block index.
    const toolBuffers = new Map<number, { toolUseId: string; name: string; json: string }>()
    // Accumulate reasoning text deltas; keyed by content block index. Each
    // index becomes one ReasoningBlock in the final `done` payload, matching
    // what `chat()` produces for the same response shape.
    const reasoningBuffers = new Map<number, { text: string }>()
    // Accumulated content blocks for the done event.
    const accumulatedContent: ContentBlock[] = []
    let stopReason = 'end_turn'
    let inputTokens = 0
    let outputTokens = 0
    const requestId = ''

    try {
      const response = await this.#client.send(new ConverseStreamCommand(input), {
        abortSignal: options.abortSignal,
      })

      for await (const event of response.stream ?? []) {
        if (event.contentBlockStart?.start?.toolUse) {
          const { toolUseId, name } = event.contentBlockStart.start.toolUse
          const index = event.contentBlockStart.contentBlockIndex ?? 0
          toolBuffers.set(index, { toolUseId: toolUseId ?? '', name: name ?? '', json: '' })
        }

        if (event.contentBlockDelta?.delta) {
          const delta = event.contentBlockDelta.delta
          const index = event.contentBlockDelta.contentBlockIndex ?? 0

          if (delta.text !== undefined) {
            const textEvent: StreamEvent = { type: 'text', data: delta.text }
            yield textEvent
            accumulatedContent.push({ type: 'text', text: delta.text })
          } else if (delta.toolUse?.input !== undefined) {
            const buf = toolBuffers.get(index)
            if (buf) buf.json += delta.toolUse.input
          } else if ((delta as { reasoningContent?: { text?: string } }).reasoningContent?.text !== undefined) {
            const text = (delta as { reasoningContent: { text: string } }).reasoningContent.text
            const reasoningEvent: StreamEvent = { type: 'reasoning', data: text }
            yield reasoningEvent
            const buf = reasoningBuffers.get(index) ?? { text: '' }
            buf.text += text
            reasoningBuffers.set(index, buf)
          }
        }

        if (event.contentBlockStop !== undefined) {
          const index = event.contentBlockStop.contentBlockIndex ?? 0
          const reasoningBuf = reasoningBuffers.get(index)
          if (reasoningBuf) {
            const reasoningBlock: ReasoningBlock = { type: 'reasoning', text: reasoningBuf.text }
            accumulatedContent.push(reasoningBlock)
            reasoningBuffers.delete(index)
          }
          const buf = toolBuffers.get(index)
          if (buf) {
            let parsedInput: Record<string, unknown> = {}
            try {
              const parsed: unknown = JSON.parse(buf.json || '{}')
              if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
                parsedInput = parsed as Record<string, unknown>
              }
            } catch {
              // malformed JSON → empty object
            }
            const toolUseBlock: ToolUseBlock = {
              type: 'tool_use',
              id: buf.toolUseId,
              name: buf.name,
              input: parsedInput,
            }
            accumulatedContent.push(toolUseBlock)
            const toolUseEvent: StreamEvent = { type: 'tool_use', data: toolUseBlock }
            yield toolUseEvent
            toolBuffers.delete(index)
          }
        }

        if (event.messageStop) {
          stopReason = (event.messageStop.stopReason as string) ?? 'end_turn'
        }

        if (event.metadata?.usage) {
          inputTokens = event.metadata.usage.inputTokens ?? 0
          outputTokens = event.metadata.usage.outputTokens ?? 0
        }
      }

      // Safety net: if Bedrock ever omits a contentBlockStop for a reasoning
      // block, flush whatever we buffered so the done payload still matches
      // what chat() would have returned for the same response.
      for (const [, buf] of reasoningBuffers) {
        accumulatedContent.push({ type: 'reasoning', text: buf.text })
      }
      reasoningBuffers.clear()

      const finalResponse: LLMResponse = {
        id: requestId,
        content: accumulatedContent,
        model: options.model,
        stop_reason: stopReason,
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

export type { ContentBlock, ImageBlock, LLMAdapter, LLMChatOptions, LLMMessage, LLMResponse, LLMStreamOptions, LLMToolDef, StreamEvent, TextBlock, ToolResultBlock, ToolUseBlock }
