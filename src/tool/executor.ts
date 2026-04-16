/**
 * Parallel tool executor with concurrency control and error isolation.
 *
 * Validates input via Zod schemas, enforces a maximum concurrency limit using
 * a lightweight semaphore, tracks execution duration, and surfaces any
 * execution errors as ToolResult objects rather than thrown exceptions.
 *
 * Types are imported from `../types` to ensure consistency with the rest of
 * the framework.
 */

import type { ToolResult, ToolUseContext } from '../types.js'
import type { ToolDefinition } from '../types.js'
import { ToolRegistry } from './framework.js'
import { Semaphore } from '../utils/semaphore.js'

// ---------------------------------------------------------------------------
// ToolExecutor
// ---------------------------------------------------------------------------

export interface ToolExecutorOptions {
  /**
   * Maximum number of tool calls that may run in parallel.
   * Defaults to 4.
   */
  maxConcurrency?: number
  /**
   * Agent-level default for maximum tool output length in characters.
   * Per-tool `maxOutputChars` takes priority over this value.
   */
  maxToolOutputChars?: number
}

/** Describes one call in a batch. */
export interface BatchToolCall {
  /** Caller-assigned ID used as the key in the result map. */
  id: string
  /** Registered tool name. */
  name: string
  /** Raw (unparsed) input object from the LLM. */
  input: Record<string, unknown>
}

/**
 * Executes tools from a {@link ToolRegistry}, validating input against each
 * tool's Zod schema and enforcing a concurrency limit for batch execution.
 *
 * All errors — including unknown tool names, Zod validation failures, and
 * execution exceptions — are caught and returned as `ToolResult` objects with
 * `isError: true` so the agent runner can forward them to the LLM.
 */
export class ToolExecutor {
  private readonly registry: ToolRegistry
  private readonly semaphore: Semaphore
  private readonly maxToolOutputChars?: number

  constructor(registry: ToolRegistry, options: ToolExecutorOptions = {}) {
    this.registry = registry
    this.semaphore = new Semaphore(options.maxConcurrency ?? 4)
    this.maxToolOutputChars = options.maxToolOutputChars
  }

  // -------------------------------------------------------------------------
  // Single execution
  // -------------------------------------------------------------------------

  /**
   * Execute a single tool by name.
   *
   * Errors are caught and returned as a {@link ToolResult} with
   * `isError: true` — this method itself never rejects.
   *
   * @param toolName  The registered tool name.
   * @param input     Raw input object (before Zod validation).
   * @param context   Execution context forwarded to the tool.
   */
  async execute(
    toolName: string,
    input: Record<string, unknown>,
    context: ToolUseContext,
  ): Promise<ToolResult> {
    const tool = this.registry.get(toolName)
    if (tool === undefined) {
      return this.errorResult(
        `Tool "${toolName}" is not registered in the ToolRegistry.`,
      )
    }

    // Check abort before even starting
    if (context.abortSignal?.aborted === true) {
      return this.errorResult(
        `Tool "${toolName}" was aborted before execution began.`,
      )
    }

    return this.runTool(tool, input, context)
  }

  // -------------------------------------------------------------------------
  // Batch execution
  // -------------------------------------------------------------------------

  /**
   * Execute multiple tool calls in parallel, honouring the concurrency limit.
   *
   * Returns a `Map` from call ID to result.  Every call in `calls` is
   * guaranteed to produce an entry — errors are captured as results.
   *
   * @param calls    Array of tool calls to execute.
   * @param context  Shared execution context for all calls in this batch.
   */
  async executeBatch(
    calls: BatchToolCall[],
    context: ToolUseContext,
  ): Promise<Map<string, ToolResult>> {
    const results = new Map<string, ToolResult>()

    await Promise.all(
      calls.map(async (call) => {
        const result = await this.semaphore.run(() =>
          this.execute(call.name, call.input, context),
        )
        results.set(call.id, result)
      }),
    )

    return results
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Validate input with the tool's Zod schema, then call `execute`.
   * Any synchronous or asynchronous error is caught and turned into an error
   * ToolResult.
   */
  private async runTool(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tool: ToolDefinition<any>,
    rawInput: Record<string, unknown>,
    context: ToolUseContext,
  ): Promise<ToolResult> {
    // --- Zod validation ---
    const parseResult = tool.inputSchema.safeParse(rawInput)
    if (!parseResult.success) {
      const issues = parseResult.error.issues
        .map((issue) => `  • ${issue.path.join('.')}: ${issue.message}`)
        .join('\n')
      return this.errorResult(
        `Invalid input for tool "${tool.name}":\n${issues}`,
      )
    }

    // --- Abort check after parse (parse can be expensive for large inputs) ---
    if (context.abortSignal?.aborted === true) {
      return this.errorResult(
        `Tool "${tool.name}" was aborted before execution began.`,
      )
    }

    // --- Execute ---
    try {
      const result = await tool.execute(parseResult.data, context)
      return this.maybeTruncate(tool, result)
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : typeof err === 'string'
            ? err
            : JSON.stringify(err)
      return this.maybeTruncate(tool, this.errorResult(`Tool "${tool.name}" threw an error: ${message}`))
    }
  }

  /**
   * Apply truncation to a tool result if a character limit is configured.
   * Priority: per-tool `maxOutputChars` > agent-level `maxToolOutputChars`.
   */
  private maybeTruncate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tool: ToolDefinition<any>,
    result: ToolResult,
  ): ToolResult {
    const maxChars = tool.maxOutputChars ?? this.maxToolOutputChars
    if (maxChars === undefined || maxChars <= 0 || result.data.length <= maxChars) {
      return result
    }
    return { ...result, data: truncateToolOutput(result.data, maxChars) }
  }

  /** Construct an error ToolResult. */
  private errorResult(message: string): ToolResult {
    return {
      data: message,
      isError: true,
    }
  }
}

// ---------------------------------------------------------------------------
// Truncation helper
// ---------------------------------------------------------------------------

/**
 * Truncate tool output to fit within `maxChars`, preserving the head (~70%)
 * and tail (~30%) with a marker indicating how many characters were removed.
 *
 * The marker itself is counted against the budget so the returned string
 * never exceeds `maxChars`. When `maxChars` is too small to fit any
 * content alongside the marker, a marker-only string is returned.
 */
export function truncateToolOutput(data: string, maxChars: number): string {
  if (data.length <= maxChars) return data

  // Estimate marker length (digit count may shrink after subtracting content,
  // but using data.length gives a safe upper-bound for the digit count).
  const markerTemplate = '\n\n[...truncated  characters...]\n\n'
  const markerOverhead = markerTemplate.length + String(data.length).length

  // When maxChars is too small to fit any content alongside the marker,
  // fall back to a hard slice so the result never exceeds maxChars.
  if (maxChars <= markerOverhead) {
    return data.slice(0, maxChars)
  }

  const available = maxChars - markerOverhead
  const headChars = Math.floor(available * 0.7)
  const tailChars = available - headChars
  const truncatedCount = data.length - headChars - tailChars

  return `${data.slice(0, headChars)}\n\n[...truncated ${truncatedCount} characters...]\n\n${data.slice(-tailChars)}`
}
