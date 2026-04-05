/**
 * @fileoverview Fallback tool-call extractor for local models.
 *
 * When a local model (Ollama, vLLM, LM Studio) returns tool calls as plain
 * text instead of using the OpenAI `tool_calls` wire format, this module
 * attempts to extract them from the text output.
 *
 * Common scenarios:
 * - Ollama thinking-model bug: tool call JSON ends up inside unclosed `<think>` tags
 * - Model outputs raw JSON tool calls without the server parsing them
 * - Model wraps tool calls in markdown code fences
 * - Hermes-format `<tool_call>` tags
 *
 * This is a **safety net**, not the primary path. Native `tool_calls` from
 * the server are always preferred.
 */

import type { ToolUseBlock } from '../types.js'

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

let callCounter = 0

/** Generate a unique tool-call ID for extracted calls. */
function generateToolCallId(): string {
  return `extracted_call_${Date.now()}_${++callCounter}`
}

// ---------------------------------------------------------------------------
// Internal parsers
// ---------------------------------------------------------------------------

/**
 * Try to parse a single JSON object as a tool call.
 *
 * Accepted shapes:
 * ```json
 * { "name": "bash", "arguments": { "command": "ls" } }
 * { "name": "bash", "parameters": { "command": "ls" } }
 * { "function": { "name": "bash", "arguments": { "command": "ls" } } }
 * ```
 */
function parseToolCallJSON(
  json: unknown,
  knownToolNames: ReadonlySet<string>,
): ToolUseBlock | null {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return null
  }

  const obj = json as Record<string, unknown>

  // Shape: { function: { name, arguments } }
  if (typeof obj['function'] === 'object' && obj['function'] !== null) {
    const fn = obj['function'] as Record<string, unknown>
    return parseFlat(fn, knownToolNames)
  }

  // Shape: { name, arguments|parameters }
  return parseFlat(obj, knownToolNames)
}

function parseFlat(
  obj: Record<string, unknown>,
  knownToolNames: ReadonlySet<string>,
): ToolUseBlock | null {
  const name = obj['name']
  if (typeof name !== 'string' || name.length === 0) return null

  // Whitelist check — don't treat arbitrary JSON as a tool call
  if (knownToolNames.size > 0 && !knownToolNames.has(name)) return null

  let input: Record<string, unknown> = {}
  const args = obj['arguments'] ?? obj['parameters'] ?? obj['input']
  if (args !== null && args !== undefined) {
    if (typeof args === 'string') {
      try {
        const parsed = JSON.parse(args)
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          input = parsed as Record<string, unknown>
        }
      } catch {
        // Malformed — use empty input
      }
    } else if (typeof args === 'object' && !Array.isArray(args)) {
      input = args as Record<string, unknown>
    }
  }

  return {
    type: 'tool_use',
    id: generateToolCallId(),
    name,
    input,
  }
}

// ---------------------------------------------------------------------------
// JSON extraction from text
// ---------------------------------------------------------------------------

/**
 * Find all top-level JSON objects in a string by tracking brace depth.
 * Returns the parsed objects (not sub-objects).
 */
function extractJSONObjects(text: string): unknown[] {
  const results: unknown[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escape = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!

    if (escape) {
      escape = false
      continue
    }

    if (ch === '\\' && inString) {
      escape = true
      continue
    }

    if (ch === '"') {
      inString = !inString
      continue
    }

    if (inString) continue

    if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && start !== -1) {
        const candidate = text.slice(start, i + 1)
        try {
          results.push(JSON.parse(candidate))
        } catch {
          // Not valid JSON — skip
        }
        start = -1
      }
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Hermes format: <tool_call>...</tool_call>
// ---------------------------------------------------------------------------

function extractHermesToolCalls(
  text: string,
  knownToolNames: ReadonlySet<string>,
): ToolUseBlock[] {
  const results: ToolUseBlock[] = []

  for (const match of text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) {
    const inner = match[1]!.trim()
    try {
      const parsed: unknown = JSON.parse(inner)
      const block = parseToolCallJSON(parsed, knownToolNames)
      if (block !== null) results.push(block)
    } catch {
      // Malformed hermes content — skip
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Attempt to extract tool calls from a model's text output.
 *
 * Tries multiple strategies in order:
 * 1. Hermes `<tool_call>` tags
 * 2. JSON objects in text (bare or inside code fences)
 *
 * @param text           - The model's text output.
 * @param knownToolNames - Whitelist of registered tool names. When non-empty,
 *                         only JSON objects whose `name` matches a known tool
 *                         are treated as tool calls.
 * @returns Extracted {@link ToolUseBlock}s, or an empty array if none found.
 */
export function extractToolCallsFromText(
  text: string,
  knownToolNames: string[],
): ToolUseBlock[] {
  if (text.length === 0) return []

  const nameSet = new Set(knownToolNames)

  // Strategy 1: Hermes format
  const hermesResults = extractHermesToolCalls(text, nameSet)
  if (hermesResults.length > 0) return hermesResults

  // Strategy 2: Strip code fences, then extract JSON objects
  const stripped = text.replace(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/g, '$1')
  const jsonObjects = extractJSONObjects(stripped)

  const results: ToolUseBlock[] = []
  for (const obj of jsonObjects) {
    const block = parseToolCallJSON(obj, nameSet)
    if (block !== null) results.push(block)
  }

  return results
}
