/**
 * @fileoverview Shared OpenAI wire-format conversion helpers.
 *
 * Both the OpenAI and Copilot adapters use the OpenAI Chat Completions API
 * format. This module contains the common conversion logic so it isn't
 * duplicated across adapters.
 */

import OpenAI from 'openai'
import type {
  ChatCompletion,
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
  ChatCompletionToolMessageParam,
  ChatCompletionUserMessageParam,
} from 'openai/resources/chat/completions/index.js'

import type {
  ContentBlock,
  LLMMessage,
  LLMResponse,
  LLMToolDef,
  TextBlock,
  ToolUseBlock,
} from '../types.js'
import { extractToolCallsFromText } from '../tool/text-tool-extractor.js'

// ---------------------------------------------------------------------------
// Framework → OpenAI
// ---------------------------------------------------------------------------

/**
 * Convert a framework {@link LLMToolDef} to an OpenAI {@link ChatCompletionTool}.
 */
export function toOpenAITool(tool: LLMToolDef): ChatCompletionTool {
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
 * Convert framework {@link LLMMessage}s into OpenAI
 * {@link ChatCompletionMessageParam} entries.
 *
 * `tool_result` blocks are expanded into top-level `tool`-role messages
 * because OpenAI uses a dedicated role for tool results rather than embedding
 * them inside user-content arrays.
 */
export function toOpenAIMessages(messages: LLMMessage[]): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = []

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      result.push(toOpenAIAssistantMessage(msg))
    } else {
      // user role
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

/**
 * Convert a `user`-role framework message into an OpenAI user message.
 * Image blocks are converted to the OpenAI image_url content part format.
 */
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
    // tool_result blocks are handled by the caller (toOpenAIMessages); skip here.
  }

  return { role: 'user', content: parts }
}

/**
 * Convert an `assistant`-role framework message into an OpenAI assistant message.
 * `tool_use` blocks become `tool_calls`; `text` blocks become message content.
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
// OpenAI → Framework
// ---------------------------------------------------------------------------

/**
 * Convert an OpenAI {@link ChatCompletion} into a framework {@link LLMResponse}.
 *
 * Takes only the first choice (index 0), consistent with how the framework
 * is designed for single-output agents.
 *
 * @param completion      - The raw OpenAI completion.
 * @param knownToolNames  - Optional whitelist of tool names. When the model
 *                          returns no `tool_calls` but the text contains JSON
 *                          that looks like a tool call, the fallback extractor
 *                          uses this list to validate matches. Pass the names
 *                          of tools sent in the request for best results.
 */
export function fromOpenAICompletion(
  completion: ChatCompletion,
  knownToolNames?: string[],
): LLMResponse {
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

  // ---------------------------------------------------------------------------
  // Fallback: extract tool calls from text when native tool_calls is empty.
  //
  // Some local models (Ollama thinking models, misconfigured vLLM) return tool
  // calls as plain text instead of using the tool_calls wire format.  When we
  // have text but no tool_calls, try to extract them from the text.
  // ---------------------------------------------------------------------------
  const hasNativeToolCalls = (message.tool_calls ?? []).length > 0
  if (
    !hasNativeToolCalls &&
    knownToolNames !== undefined &&
    knownToolNames.length > 0 &&
    message.content !== null &&
    message.content !== undefined &&
    message.content.length > 0
  ) {
    const extracted = extractToolCallsFromText(message.content, knownToolNames)
    if (extracted.length > 0) {
      content.push(...extracted)
    }
  }

  const hasToolUseBlocks = content.some(b => b.type === 'tool_use')
  const rawStopReason = choice.finish_reason ?? 'stop'
  // If we extracted tool calls from text but the finish_reason was 'stop',
  // correct it to 'tool_use' so the agent runner continues the loop.
  const stopReason = hasToolUseBlocks && rawStopReason === 'stop'
    ? 'tool_use'
    : normalizeFinishReason(rawStopReason)

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
 * stop-reason vocabulary.
 *
 * Mapping:
 * - `'stop'`           → `'end_turn'`
 * - `'tool_calls'`     → `'tool_use'`
 * - `'length'`         → `'max_tokens'`
 * - `'content_filter'` → `'content_filter'`
 * - anything else      → passed through unchanged
 */
export function normalizeFinishReason(reason: string): string {
  switch (reason) {
    case 'stop':           return 'end_turn'
    case 'tool_calls':     return 'tool_use'
    case 'length':         return 'max_tokens'
    case 'content_filter': return 'content_filter'
    default:               return reason
  }
}

/**
 * Prepend a system message when `systemPrompt` is provided, then append the
 * converted conversation messages.
 */
export function buildOpenAIMessageList(
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
