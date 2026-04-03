/**
 * @fileoverview Core conversation loop engine for open-multi-agent.
 *
 * {@link AgentRunner} is the heart of the framework. It handles:
 *  - Sending messages to the LLM adapter
 *  - Extracting tool-use blocks from the response
 *  - Executing tool calls in parallel via {@link ToolExecutor}
 *  - Appending tool results and looping back until `end_turn`
 *  - Accumulating token usage and timing data across all turns
 *
 * The loop follows a standard agentic conversation pattern:
 * one outer `while (true)` that breaks on `end_turn` or maxTurns exhaustion.
 */

import type {
  LLMMessage,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ToolCallRecord,
  TokenUsage,
  StreamEvent,
  ToolResult,
  ToolUseContext,
  LLMAdapter,
  LLMChatOptions,
  TraceEvent,
} from '../types.js'
import { emitTrace } from '../utils/trace.js'
import type { ToolRegistry } from '../tool/framework.js'
import type { ToolExecutor } from '../tool/executor.js'

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/**
 * Static configuration for an {@link AgentRunner} instance.
 * These values are constant across every `run` / `stream` call.
 */
export interface RunnerOptions {
  /** LLM model identifier, e.g. `'claude-opus-4-6'`. */
  readonly model: string
  /** Optional system prompt prepended to every conversation. */
  readonly systemPrompt?: string
  /**
   * Maximum number of tool-call round-trips before the runner stops.
   * Prevents unbounded loops. Defaults to `10`.
   */
  readonly maxTurns?: number
  /** Maximum output tokens per LLM response. */
  readonly maxTokens?: number
  /** Sampling temperature passed to the adapter. */
  readonly temperature?: number
  /** AbortSignal that cancels any in-flight adapter call and stops the loop. */
  readonly abortSignal?: AbortSignal
  /**
   * Whitelist of tool names this runner is allowed to use.
   * When provided, only tools whose name appears in this list are sent to the
   * LLM. When omitted, all registered tools are available.
   */
  readonly allowedTools?: readonly string[]
  /** Display name of the agent driving this runner (used in tool context). */
  readonly agentName?: string
  /** Short role description of the agent (used in tool context). */
  readonly agentRole?: string
}

/**
 * Per-call callbacks for observing tool execution in real time.
 * All callbacks are optional; unused ones are simply skipped.
 */
export interface RunOptions {
  /** Fired just before each tool is dispatched. */
  readonly onToolCall?: (name: string, input: Record<string, unknown>) => void
  /** Fired after each tool result is received. */
  readonly onToolResult?: (name: string, result: ToolResult) => void
  /** Fired after each complete {@link LLMMessage} is appended. */
  readonly onMessage?: (message: LLMMessage) => void
  /** Trace callback for observability spans. Async callbacks are safe. */
  readonly onTrace?: (event: TraceEvent) => void | Promise<void>
  /** Run ID for trace correlation. */
  readonly runId?: string
  /** Task ID for trace correlation. */
  readonly taskId?: string
  /** Agent name for trace correlation (overrides RunnerOptions.agentName). */
  readonly traceAgent?: string
}

/** The aggregated result returned when a full run completes. */
export interface RunResult {
  /** All messages accumulated during this run (assistant + tool results). */
  readonly messages: LLMMessage[]
  /** The final text output from the last assistant turn. */
  readonly output: string
  /** All tool calls made during this run, in execution order. */
  readonly toolCalls: ToolCallRecord[]
  /** Aggregated token counts across every LLM call in this run. */
  readonly tokenUsage: TokenUsage
  /** Total number of LLM turns (including tool-call follow-ups). */
  readonly turns: number
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Extract every TextBlock from a content array and join them. */
function extractText(content: readonly ContentBlock[]): string {
  return content
    .filter((b): b is TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('')
}

/** Extract every ToolUseBlock from a content array. */
function extractToolUseBlocks(content: readonly ContentBlock[]): ToolUseBlock[] {
  return content.filter((b): b is ToolUseBlock => b.type === 'tool_use')
}

/** Add two {@link TokenUsage} values together, returning a new object. */
function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
  }
}

const ZERO_USAGE: TokenUsage = { input_tokens: 0, output_tokens: 0 }

// ---------------------------------------------------------------------------
// AgentRunner
// ---------------------------------------------------------------------------

/**
 * Drives a full agentic conversation: LLM calls, tool execution, and looping.
 *
 * @example
 * ```ts
 * const runner = new AgentRunner(adapter, registry, executor, {
 *   model: 'claude-opus-4-6',
 *   maxTurns: 10,
 * })
 * const result = await runner.run(messages)
 * console.log(result.output)
 * ```
 */
export class AgentRunner {
  private readonly maxTurns: number

  constructor(
    private readonly adapter: LLMAdapter,
    private readonly toolRegistry: ToolRegistry,
    private readonly toolExecutor: ToolExecutor,
    private readonly options: RunnerOptions,
  ) {
    this.maxTurns = options.maxTurns ?? 10
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Run a complete conversation starting from `messages`.
   *
   * The call may internally make multiple LLM requests (one per tool-call
   * round-trip). It returns only when:
   *  - The LLM emits `end_turn` with no tool-use blocks, or
   *  - `maxTurns` is exceeded, or
   *  - The abort signal is triggered.
   */
  async run(
    messages: LLMMessage[],
    options: RunOptions = {},
  ): Promise<RunResult> {
    // Collect everything yielded by the internal streaming loop.
    const accumulated: {
      messages: LLMMessage[]
      output: string
      toolCalls: ToolCallRecord[]
      tokenUsage: TokenUsage
      turns: number
    } = {
      messages: [],
      output: '',
      toolCalls: [],
      tokenUsage: ZERO_USAGE,
      turns: 0,
    }

    for await (const event of this.stream(messages, options)) {
      if (event.type === 'done') {
        const result = event.data as RunResult
        accumulated.messages = result.messages
        accumulated.output = result.output
        accumulated.toolCalls = result.toolCalls
        accumulated.tokenUsage = result.tokenUsage
        accumulated.turns = result.turns
      }
    }

    return accumulated
  }

  /**
   * Run the conversation and yield {@link StreamEvent}s incrementally.
   *
   * Callers receive:
   *  - `{ type: 'text', data: string }` for each text delta
   *  - `{ type: 'tool_use', data: ToolUseBlock }` when the model requests a tool
   *  - `{ type: 'tool_result', data: ToolResultBlock }` after each execution
   *  - `{ type: 'done', data: RunResult }` at the very end
   *  - `{ type: 'error', data: Error }` on unrecoverable failure
   */
  async *stream(
    initialMessages: LLMMessage[],
    options: RunOptions = {},
  ): AsyncGenerator<StreamEvent> {
    // Working copy of the conversation — mutated as turns progress.
    const conversationMessages: LLMMessage[] = [...initialMessages]

    // Accumulated state across all turns.
    let totalUsage: TokenUsage = ZERO_USAGE
    const allToolCalls: ToolCallRecord[] = []
    let finalOutput = ''
    let turns = 0

    // Build the stable LLM options once; model / tokens / temp don't change.
    // toToolDefs() returns LLMToolDef[] (inputSchema, camelCase) — matches
    // LLMChatOptions.tools from types.ts directly.
    const allDefs = this.toolRegistry.toToolDefs()
    const toolDefs = this.options.allowedTools
      ? allDefs.filter(d => this.options.allowedTools!.includes(d.name))
      : allDefs

    const baseChatOptions: LLMChatOptions = {
      model: this.options.model,
      tools: toolDefs.length > 0 ? toolDefs : undefined,
      maxTokens: this.options.maxTokens,
      temperature: this.options.temperature,
      systemPrompt: this.options.systemPrompt,
      abortSignal: this.options.abortSignal,
    }

    try {
      // -----------------------------------------------------------------
      // Main agentic loop — `while (true)` until end_turn or maxTurns
      // -----------------------------------------------------------------
      while (true) {
        // Respect abort before each LLM call.
        if (this.options.abortSignal?.aborted) {
          break
        }

        // Guard against unbounded loops.
        if (turns >= this.maxTurns) {
          break
        }

        turns++

        // ------------------------------------------------------------------
        // Step 1: Call the LLM and collect the full response for this turn.
        // ------------------------------------------------------------------
        const llmStartMs = Date.now()
        const response = await this.adapter.chat(conversationMessages, baseChatOptions)
        if (options.onTrace) {
          const llmEndMs = Date.now()
          emitTrace(options.onTrace, {
            type: 'llm_call',
            runId: options.runId ?? '',
            taskId: options.taskId,
            agent: options.traceAgent ?? this.options.agentName ?? 'unknown',
            model: this.options.model,
            turn: turns,
            tokens: response.usage,
            startMs: llmStartMs,
            endMs: llmEndMs,
            durationMs: llmEndMs - llmStartMs,
          })
        }

        totalUsage = addTokenUsage(totalUsage, response.usage)

        // ------------------------------------------------------------------
        // Step 2: Build the assistant message from the response content.
        // ------------------------------------------------------------------
        const assistantMessage: LLMMessage = {
          role: 'assistant',
          content: response.content,
        }

        conversationMessages.push(assistantMessage)
        options.onMessage?.(assistantMessage)

        // Yield text deltas so streaming callers can display them promptly.
        const turnText = extractText(response.content)
        if (turnText.length > 0) {
          yield { type: 'text', data: turnText } satisfies StreamEvent
        }

        // Announce each tool-use block the model requested.
        const toolUseBlocks = extractToolUseBlocks(response.content)
        for (const block of toolUseBlocks) {
          yield { type: 'tool_use', data: block } satisfies StreamEvent
        }

        // ------------------------------------------------------------------
        // Step 3: Decide whether to continue looping.
        // ------------------------------------------------------------------
        if (toolUseBlocks.length === 0) {
          // No tools requested — this is the terminal assistant turn.
          finalOutput = turnText
          break
        }

        // ------------------------------------------------------------------
        // Step 4: Execute all tool calls in PARALLEL.
        //
        // Parallel execution is critical for multi-tool responses where the
        // tools are independent (e.g. reading several files at once).
        // ------------------------------------------------------------------
        const toolContext: ToolUseContext = this.buildToolContext()

        const executionPromises = toolUseBlocks.map(async (block): Promise<{
          resultBlock: ToolResultBlock
          record: ToolCallRecord
        }> => {
          options.onToolCall?.(block.name, block.input)

          const startTime = Date.now()
          let result: ToolResult

          try {
            result = await this.toolExecutor.execute(
              block.name,
              block.input,
              toolContext,
            )
          } catch (err) {
            // Tool executor errors become error results — the loop continues.
            const message = err instanceof Error ? err.message : String(err)
            result = { data: message, isError: true }
          }

          const endTime = Date.now()
          const duration = endTime - startTime

          options.onToolResult?.(block.name, result)

          if (options.onTrace) {
            emitTrace(options.onTrace, {
              type: 'tool_call',
              runId: options.runId ?? '',
              taskId: options.taskId,
              agent: options.traceAgent ?? this.options.agentName ?? 'unknown',
              tool: block.name,
              isError: result.isError ?? false,
              startMs: startTime,
              endMs: endTime,
              durationMs: duration,
            })
          }

          const record: ToolCallRecord = {
            toolName: block.name,
            input: block.input,
            output: result.data,
            duration,
          }

          const resultBlock: ToolResultBlock = {
            type: 'tool_result',
            tool_use_id: block.id,
            content: result.data,
            is_error: result.isError,
          }

          return { resultBlock, record }
        })

        // Wait for every tool in this turn to finish.
        const executions = await Promise.all(executionPromises)

        // ------------------------------------------------------------------
        // Step 5: Accumulate results and build the user message that carries
        //         them back to the LLM in the next turn.
        // ------------------------------------------------------------------
        const toolResultBlocks: ContentBlock[] = executions.map(e => e.resultBlock)

        for (const { record, resultBlock } of executions) {
          allToolCalls.push(record)
          yield { type: 'tool_result', data: resultBlock } satisfies StreamEvent
        }

        const toolResultMessage: LLMMessage = {
          role: 'user',
          content: toolResultBlocks,
        }

        conversationMessages.push(toolResultMessage)
        options.onMessage?.(toolResultMessage)

        // Loop back to Step 1 — send updated conversation to the LLM.
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      yield { type: 'error', data: error } satisfies StreamEvent
      return
    }

    // If the loop exited due to maxTurns, use whatever text was last emitted.
    if (finalOutput === '' && conversationMessages.length > 0) {
      const lastAssistant = [...conversationMessages]
        .reverse()
        .find(m => m.role === 'assistant')
      if (lastAssistant !== undefined) {
        finalOutput = extractText(lastAssistant.content)
      }
    }

    const runResult: RunResult = {
      // Return only the messages added during this run (not the initial seed).
      messages: conversationMessages.slice(initialMessages.length),
      output: finalOutput,
      toolCalls: allToolCalls,
      tokenUsage: totalUsage,
      turns,
    }

    yield { type: 'done', data: runResult } satisfies StreamEvent
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Build the {@link ToolUseContext} passed to every tool execution.
   * Identifies this runner as the invoking agent.
   */
  private buildToolContext(): ToolUseContext {
    return {
      agent: {
        name: this.options.agentName ?? 'runner',
        role: this.options.agentRole ?? 'assistant',
        model: this.options.model,
      },
      abortSignal: this.options.abortSignal,
    }
  }
}
