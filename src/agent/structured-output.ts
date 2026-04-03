/**
 * @fileoverview Structured output utilities for agent responses.
 *
 * Provides JSON extraction, Zod validation, and system-prompt injection so
 * that agents can return typed, schema-validated output.
 */

import { type ZodSchema } from 'zod'
import { zodToJsonSchema } from '../tool/framework.js'

// ---------------------------------------------------------------------------
// System-prompt instruction builder
// ---------------------------------------------------------------------------

/**
 * Build a JSON-mode instruction block to append to the agent's system prompt.
 *
 * Converts the Zod schema to JSON Schema and formats it as a clear directive
 * for the LLM to respond with valid JSON matching the schema.
 */
export function buildStructuredOutputInstruction(schema: ZodSchema): string {
  const jsonSchema = zodToJsonSchema(schema)
  return [
    '',
    '## Output Format (REQUIRED)',
    'You MUST respond with ONLY valid JSON that conforms to the following JSON Schema.',
    'Do NOT include any text, markdown fences, or explanation outside the JSON object.',
    'Do NOT wrap the JSON in ```json code fences.',
    '',
    '```',
    JSON.stringify(jsonSchema, null, 2),
    '```',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// JSON extraction
// ---------------------------------------------------------------------------

/**
 * Attempt to extract and parse JSON from the agent's raw text output.
 *
 * Handles three cases in order:
 * 1. The output is already valid JSON (ideal case)
 * 2. The output contains a ` ```json ` fenced block
 * 3. The output contains a bare JSON object/array (first `{`/`[` to last `}`/`]`)
 *
 * @throws {Error} when no valid JSON can be extracted
 */
export function extractJSON(raw: string): unknown {
  const trimmed = raw.trim()

  // Case 1: Direct parse
  try {
    return JSON.parse(trimmed)
  } catch {
    // Continue to fallback strategies
  }

  // Case 2a: Prefer ```json tagged fence
  const jsonFenceMatch = trimmed.match(/```json\s*([\s\S]*?)```/)
  if (jsonFenceMatch?.[1]) {
    try {
      return JSON.parse(jsonFenceMatch[1].trim())
    } catch {
      // Continue
    }
  }

  // Case 2b: Fall back to bare ``` fence
  const bareFenceMatch = trimmed.match(/```\s*([\s\S]*?)```/)
  if (bareFenceMatch?.[1]) {
    try {
      return JSON.parse(bareFenceMatch[1].trim())
    } catch {
      // Continue
    }
  }

  // Case 3: Find first { to last } (object)
  const objStart = trimmed.indexOf('{')
  const objEnd = trimmed.lastIndexOf('}')
  if (objStart !== -1 && objEnd > objStart) {
    try {
      return JSON.parse(trimmed.slice(objStart, objEnd + 1))
    } catch {
      // Fall through
    }
  }

  // Case 3b: Find first [ to last ] (array)
  const arrStart = trimmed.indexOf('[')
  const arrEnd = trimmed.lastIndexOf(']')
  if (arrStart !== -1 && arrEnd > arrStart) {
    try {
      return JSON.parse(trimmed.slice(arrStart, arrEnd + 1))
    } catch {
      // Fall through
    }
  }

  throw new Error(
    `Failed to extract JSON from output. Raw output begins with: "${trimmed.slice(0, 100)}"`,
  )
}

// ---------------------------------------------------------------------------
// Zod validation
// ---------------------------------------------------------------------------

/**
 * Validate a parsed JSON value against a Zod schema.
 *
 * @returns The validated (and potentially transformed) value on success.
 * @throws {Error} with a human-readable Zod error message on failure.
 */
export function validateOutput(schema: ZodSchema, data: unknown): unknown {
  const result = schema.safeParse(data)
  if (result.success) {
    return result.data
  }
  const issues = result.error.issues
    .map(issue => `  - ${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('\n')
  throw new Error(`Output validation failed:\n${issues}`)
}
