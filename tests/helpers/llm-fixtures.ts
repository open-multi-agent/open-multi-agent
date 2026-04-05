/**
 * Shared fixture builders for LLM adapter contract tests.
 */

import type {
  ContentBlock,
  LLMChatOptions,
  LLMMessage,
  LLMToolDef,
  ImageBlock,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from '../../src/types.js'

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

export function textMsg(role: 'user' | 'assistant', text: string): LLMMessage {
  return { role, content: [{ type: 'text', text }] }
}

export function toolUseMsg(id: string, name: string, input: Record<string, unknown>): LLMMessage {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input }],
  }
}

export function toolResultMsg(toolUseId: string, content: string, isError = false): LLMMessage {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }],
  }
}

export function imageMsg(mediaType: string, data: string): LLMMessage {
  return {
    role: 'user',
    content: [{ type: 'image', source: { type: 'base64', media_type: mediaType, data } }],
  }
}

// ---------------------------------------------------------------------------
// Options & tool def builders
// ---------------------------------------------------------------------------

export function chatOpts(overrides: Partial<LLMChatOptions> = {}): LLMChatOptions {
  return {
    model: 'test-model',
    maxTokens: 1024,
    ...overrides,
  }
}

export function toolDef(name: string, description = 'A test tool'): LLMToolDef {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect all events from an async iterable. */
export async function collectEvents<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = []
  for await (const event of iterable) {
    events.push(event)
  }
  return events
}
