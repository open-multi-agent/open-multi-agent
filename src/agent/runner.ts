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
  TeamInfo,
  LLMAdapter,
  LLMChatOptions,
  TraceEvent,
  LoopDetectionConfig,
  LoopDetectionInfo,
  LLMToolDef,
  ContextStrategy,
} from '../types.js'
import { TokenBudgetExceededError } from '../errors.js'
import { LoopDetector } from './loop-detector.js'
import { emitTrace } from '../utils/trace.js'
import { estimateTokens } from '../utils/tokens.js'
import type { ToolRegistry } from '../tool/framework.js'
import type { ToolExecutor } from '../tool/executor.js'

// ---------------------------------------------------------------------------
// Tool presets
// ---------------------------------------------------------------------------

/** Predefined tool sets for common agent use cases. */
export const TOOL_PRESETS = {
  readonly: ['file_read', 'grep', 'glob'],
  readwrite: ['file_read', 'file_write', 'file_edit', 'grep', 'glob'],
  full: ['file_read', 'file_write', 'file_edit', 'grep', 'glob', 'bash'],
} as const satisfies Record<string, readonly string[]>

/** Framework-level disallowed tools for safety rails. */
export const AGENT_FRAMEWORK_DISALLOWED: readonly string[] = [
  // Empty for now, infrastructure for future built-in tools
]

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
   * Tool access control configuration.
   * - `toolPreset`: Predefined tool sets for common use cases
   * - `allowedTools`: Whitelist of tool names (allowlist)
   * - `disallowedTools`: Blacklist of tool names (denylist)
   * Tools are resolved in order: preset → allowlist → denylist
   */
  readonly toolPreset?: 'readonly' | 'readwrite' | 'full'
  readonly allowedTools?: readonly string[]
  readonly disallowedTools?: readonly string[]
  /** Display name of the agent driving this runner (used in tool context). */
  readonly agentName?: string
  /** Short role description of the agent (used in tool context). */
  readonly agentRole?: string
  /** Loop detection configuration. When set, detects stuck agent loops. */
  readonly loopDetection?: LoopDetectionConfig
  /** Maximum cumulative tokens (input + output) allowed for this run. */
  readonly maxTokenBudget?: number
  /** Optional context compression strategy for long multi-turn runs. */
  readonly contextStrategy?: ContextStrategy
  /**
   * Compress tool results that the agent has already processed.
   * See {@link AgentConfig.compressToolResults} for details.
   */
  readonly compressToolResults?: boolean | { readonly minChars?: number }
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
  /**
   * Fired when the runner detects a potential configuration issue.
   * For example, when a model appears to ignore tool definitions.
   */
  readonly onWarning?: (message: string) => void
  /** Trace callback for observability spans. Async callbacks are safe. */
  readonly onTrace?: (event: TraceEvent) => void | Promise<void>
  /** Run ID for trace correlation. */
  readonly runId?: string
  /** Task ID for trace correlation. */
  readonly taskId?: string
  /** Agent name for trace correlation (overrides RunnerOptions.agentName). */
  readonly traceAgent?: string
  /**
   * Per-call abort signal. When set, takes precedence over the static
   * {@link RunnerOptions.abortSignal}. Useful for per-run timeouts.
   */
  readonly abortSignal?: AbortSignal
  /**
   * Team context for built-in tools such as `delegate_to_agent`.
   * Injected by the orchestrator during `runTeam` / `runTasks` pool runs.
   */
  readonly team?: TeamInfo
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
  /** True when the run was terminated or warned due to loop detection. */
  readonly loopDetected?: boolean
  /** True when the run was terminated due to token budget limits. */
  readonly budgetExceeded?: boolean
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

/** Default minimum content length before tool result compression kicks in. */
const DEFAULT_MIN_COMPRESS_CHARS = 500

/**
 * Prepends synthetic framing text to the first user message so we never emit
 * consecutive `user` turns (Bedrock) and summaries do not concatenate onto
 * the original user prompt (direct API). If there is no user message yet,
 * inserts a single assistant text preamble.
 */
function prependSyntheticPrefixToFirstUser(
  messages: LLMMessage[],
  prefix: string,
): LLMMessage[] {
  const userIdx = messages.findIndex(m => m.role === 'user')
  if (userIdx < 0) {
    return [{
      role: 'assistant',
      content: [{ type: 'text', text: prefix.trimEnd() }],
    }, ...messages]
  }
  const target = messages[userIdx]!
  const merged: LLMMessage = {
    role: 'user',
    content: [{ type: 'text', text: prefix }, ...target.content],
  }
  return [...messages.slice(0, userIdx), merged, ...messages.slice(userIdx + 1)]
}

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
  private summarizeCache: {
    oldSignature: string
    summaryPrefix: string
  } | null = null

  constructor(
    private readonly adapter: LLMAdapter,
    private readonly toolRegistry: ToolRegistry,
    private readonly toolExecutor: ToolExecutor,
    private readonly options: RunnerOptions,
  ) {
    this.maxTurns = options.maxTurns ?? 10
  }

  private serializeMessage(message: LLMMessage): string {
    return JSON.stringify(message)
  }

  private truncateToSlidingWindow(messages: LLMMessage[], maxTurns: number): LLMMessage[] {
    if (maxTurns <= 0) {
      return messages
    }

    const firstUserIndex = messages.findIndex(m => m.role === 'user')
    const firstUser = firstUserIndex >= 0 ? messages[firstUserIndex]! : null
    const afterFirst = firstUserIndex >= 0
      ? messages.slice(firstUserIndex + 1)
      : messages.slice()

    if (afterFirst.length <= maxTurns * 2) {
      return messages
    }

    const kept = afterFirst.slice(-maxTurns * 2)
    const result: LLMMessage[] = []

    if (firstUser !== null) {
      result.push(firstUser)
    }

    const droppedPairs = Math.floor((afterFirst.length - kept.length) / 2)
    if (droppedPairs > 0) {
      const notice =
        `[Earlier conversation history truncated — ${droppedPairs} turn(s) removed]\n\n`
      result.push(...prependSyntheticPrefixToFirstUser(kept, notice))
      return result
    }

    result.push(...kept)
    return result
  }

  private async summarizeMessages(
    messages: LLMMessage[],
    maxTokens: number,
    summaryModel: string | undefined,
    baseChatOptions: LLMChatOptions,
    turns: number,
    options: RunOptions,
  ): Promise<{ messages: LLMMessage[]; usage: TokenUsage }> {
    const estimated = estimateTokens(messages)
    if (estimated <= maxTokens || messages.length < 4) {
      return { messages, usage: ZERO_USAGE }
    }

    const firstUserIndex = messages.findIndex(m => m.role === 'user')
    if (firstUserIndex < 0 || firstUserIndex === messages.length - 1) {
      return { messages, usage: ZERO_USAGE }
    }

    const firstUser = messages[firstUserIndex]!
    const rest = messages.slice(firstUserIndex + 1)
    if (rest.length < 2) {
      return { messages, usage: ZERO_USAGE }
    }

    // Split on an even boundary so we never separate a tool_use assistant turn
    // from its tool_result user message (rest is user/assistant pairs).
    const splitAt = Math.max(2, Math.floor(rest.length / 4) * 2)
    const oldPortion = rest.slice(0, splitAt)
    const recentPortion = rest.slice(splitAt)

    const oldSignature = oldPortion.map(m => this.serializeMessage(m)).join('\n')
    if (this.summarizeCache !== null && this.summarizeCache.oldSignature === oldSignature) {
      const mergedRecent = prependSyntheticPrefixToFirstUser(
        recentPortion,
        `${this.summarizeCache.summaryPrefix}\n\n`,
      )
      return { messages: [firstUser, ...mergedRecent], usage: ZERO_USAGE }
    }

    const summaryPrompt = [
      'Summarize the following conversation history for an LLM.',
      '- Preserve user goals, constraints, and decisions.',
      '- Keep key tool outputs and unresolved questions.',
      '- Use concise bullets.',
      '- Do not fabricate details.',
    ].join('\n')

    const summaryInput: LLMMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: summaryPrompt },
          { type: 'text', text: `\n\nConversation:\n${oldSignature}` },
        ],
      },
    ]

    const summaryOptions: LLMChatOptions = {
      ...baseChatOptions,
      model: summaryModel ?? this.options.model,
      tools: undefined,
    }

    const summaryStartMs = Date.now()
    const summaryResponse = await this.adapter.chat(summaryInput, summaryOptions)
    if (options.onTrace) {
      const summaryEndMs = Date.now()
      emitTrace(options.onTrace, {
        type: 'llm_call',
        runId: options.runId ?? '',
        taskId: options.taskId,
        agent: options.traceAgent ?? this.options.agentName ?? 'unknown',
        model: summaryOptions.model,
        phase: 'summary',
        turn: turns,
        tokens: summaryResponse.usage,
        startMs: summaryStartMs,
        endMs: summaryEndMs,
        durationMs: summaryEndMs - summaryStartMs,
      })
    }

    const summaryText = extractText(summaryResponse.content).trim()
    const summaryPrefix = summaryText.length > 0
      ? `[Conversation summary]\n${summaryText}`
      : '[Conversation summary unavailable]'

    this.summarizeCache = { oldSignature, summaryPrefix }
    
    const mergedRecent = prependSyntheticPrefixToFirstUser(
      recentPortion,
      `${summaryPrefix}\n\n`,
    )
    
    return {
      messages: [firstUser, ...mergedRecent],
      usage: summaryResponse.usage,
    }
  }

  private async applyContextStrategy(
    messages: LLMMessage[],
    strategy: ContextStrategy,
    baseChatOptions: LLMChatOptions,
    turns: number,
    options: RunOptions,
  ): Promise<{ messages: LLMMessage[]; usage: TokenUsage }> {
    if (strategy.type === 'sliding-window') {
      return { messages: this.truncateToSlidingWindow(messages, strategy.maxTurns), usage: ZERO_USAGE }
    }

    if (strategy.type === 'summarize') {
      return this.summarizeMessages(
        messages,
        strategy.maxTokens,
        strategy.summaryModel,
        baseChatOptions,
        turns,
        options,
      )
    }

    if (strategy.type === 'compact') {
      return { messages: this.compactMessages(messages, strategy), usage: ZERO_USAGE }
    }

    const estimated = estimateTokens(messages)
    const compressed = await strategy.compress(messages, estimated)
    if (!Array.isArray(compressed) || compressed.length === 0) {
      throw new Error('contextStrategy.custom.compress must return a non-empty LLMMessage[]')
    }
    return { messages: compressed, usage: ZERO_USAGE }
  }

  // -------------------------------------------------------------------------
  // Tool resolution
  // -------------------------------------------------------------------------

  /**
   * Resolve the final set of tools available to this agent based on the
   * three-layer configuration: preset → allowlist → denylist → framework safety.
   *
   * Returns LLMToolDef[] for direct use with LLM adapters.
   */
  private resolveTools(): LLMToolDef[] {
    // Validate configuration for contradictions
    if (this.options.toolPreset && this.options.allowedTools) {
      console.warn(
        'AgentRunner: both toolPreset and allowedTools are set. ' +
        'Final tool access will be the intersection of both.'
      )
    }

    if (this.options.allowedTools && this.options.disallowedTools) {
      const overlap = this.options.allowedTools.filter(tool =>
        this.options.disallowedTools!.includes(tool)
      )
      if (overlap.length > 0) {
        console.warn(
          `AgentRunner: tools [${overlap.map(name => `"${name}"`).join(', ')}] appear in both allowedTools and disallowedTools. ` +
          'This is contradictory and may lead to unexpected behavior.'
        )
      }
    }

    const allTools = this.toolRegistry.toToolDefs()
    const runtimeCustomTools = this.toolRegistry.toRuntimeToolDefs()
    const runtimeCustomToolNames = new Set(runtimeCustomTools.map(t => t.name))
    let filteredTools = allTools.filter(t => !runtimeCustomToolNames.has(t.name))

    // 1. Apply preset filter if set
    if (this.options.toolPreset) {
      const presetTools = new Set(TOOL_PRESETS[this.options.toolPreset] as readonly string[])
      filteredTools = filteredTools.filter(t => presetTools.has(t.name))
    }

    // 2. Apply allowlist filter if set
    if (this.options.allowedTools) {
      filteredTools = filteredTools.filter(t => this.options.allowedTools!.includes(t.name))
    }

    // 3. Apply denylist filter if set
    const denied = this.options.disallowedTools
      ? new Set(this.options.disallowedTools)
      : undefined
    if (denied) {
      filteredTools = filteredTools.filter(t => !denied.has(t.name))
    }

    // 4. Apply framework-level safety rails
    const frameworkDenied = new Set(AGENT_FRAMEWORK_DISALLOWED)
    filteredTools = filteredTools.filter(t => !frameworkDenied.has(t.name))

    // Runtime-added custom tools bypass preset / allowlist but respect denylist.
    const finalRuntime = denied
      ? runtimeCustomTools.filter(t => !denied.has(t.name))
      : runtimeCustomTools
    return [...filteredTools, ...finalRuntime]
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
    const accumulated: RunResult = {
      messages: [],
      output: '',
      toolCalls: [],
      tokenUsage: ZERO_USAGE,
      turns: 0,
    }

    for await (const event of this.stream(messages, options)) {
      if (event.type === 'done') {
        Object.assign(accumulated, event.data)
      } else if (event.type === 'error') {
        throw event.data
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
 *  - `{ type: 'budget_exceeded', data: TokenBudgetExceededError }` on budget trip
   *  - `{ type: 'done', data: RunResult }` at the very end
   *  - `{ type: 'error', data: Error }` on unrecoverable failure
   */
  async *stream(
    initialMessages: LLMMessage[],
    options: RunOptions = {},
  ): AsyncGenerator<StreamEvent> {
    // Working copy of the conversation — mutated as turns progress.
    let conversationMessages: LLMMessage[] = [...initialMessages]
    const newMessages: LLMMessage[] = []

    // Accumulated state across all turns.
    let totalUsage: TokenUsage = ZERO_USAGE
    const allToolCalls: ToolCallRecord[] = []
    let finalOutput = ''
    let turns = 0
    let budgetExceeded = false

    // Build the stable LLM options once; model / tokens / temp don't change.
    // resolveTools() returns LLMToolDef[] with three-layer filtering applied.
    const toolDefs = this.resolveTools()

    // Per-call abortSignal takes precedence over the static one.
    const effectiveAbortSignal = options.abortSignal ?? this.options.abortSignal

    const baseChatOptions: LLMChatOptions = {
      model: this.options.model,
      tools: toolDefs.length > 0 ? toolDefs : undefined,
      maxTokens: this.options.maxTokens,
      temperature: this.options.temperature,
      systemPrompt: this.options.systemPrompt,
      abortSignal: effectiveAbortSignal,
    }

    // Loop detection state — only allocated when configured.
    const detector = this.options.loopDetection
      ? new LoopDetector(this.options.loopDetection)
      : null
    let loopDetected = false
    let loopWarned = false
    const loopAction = this.options.loopDetection?.onLoopDetected ?? 'warn'

    try {
      // -----------------------------------------------------------------
      // Main agentic loop — `while (true)` until end_turn or maxTurns
      // -----------------------------------------------------------------
      while (true) {
        // Respect abort before each LLM call.
        if (effectiveAbortSignal?.aborted) {
          break
        }

        // Guard against unbounded loops.
        if (turns >= this.maxTurns) {
          break
        }

        turns++

        // Compress consumed tool results before context strategy (lightweight,
        // no LLM calls) so the strategy operates on already-reduced messages.
        if (this.options.compressToolResults && turns > 1) {
          conversationMessages = this.compressConsumedToolResults(conversationMessages)
        }

        // Optionally compact context before each LLM call.
        if (this.options.contextStrategy) {
          const compacted = await this.applyContextStrategy(
            conversationMessages,
            this.options.contextStrategy,
            baseChatOptions,
            turns,
            options,
          )
          conversationMessages = compacted.messages
          totalUsage = addTokenUsage(totalUsage, compacted.usage)
        }

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
            phase: 'turn',
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
        newMessages.push(assistantMessage)
        options.onMessage?.(assistantMessage)

        // Yield text deltas so streaming callers can display them promptly.
        const turnText = extractText(response.content)
        if (turnText.length > 0) {
          yield { type: 'text', data: turnText } satisfies StreamEvent
        }

        const totalTokens = totalUsage.input_tokens + totalUsage.output_tokens
        if (this.options.maxTokenBudget !== undefined && totalTokens > this.options.maxTokenBudget) {
          budgetExceeded = true
          finalOutput = turnText
          yield {
            type: 'budget_exceeded',
            data: new TokenBudgetExceededError(
              this.options.agentName ?? 'unknown',
              totalTokens,
              this.options.maxTokenBudget,
            ),
          } satisfies StreamEvent
          break
        }

        // Extract tool-use blocks for detection and execution.
        const toolUseBlocks = extractToolUseBlocks(response.content)

        // ------------------------------------------------------------------
        // Step 2.5: Loop detection — check before yielding tool_use events
        // so that terminate mode doesn't emit orphaned tool_use without
        // matching tool_result.
        // ------------------------------------------------------------------
        let injectWarning = false
        let injectWarningKind: 'tool_repetition' | 'text_repetition' = 'tool_repetition'
        if (detector && toolUseBlocks.length > 0) {
          const toolInfo = detector.recordToolCalls(toolUseBlocks)
          const textInfo = turnText.length > 0 ? detector.recordText(turnText) : null
          const info = toolInfo ?? textInfo

          if (info) {
            yield { type: 'loop_detected', data: info } satisfies StreamEvent
            options.onWarning?.(info.detail)

            const action = typeof loopAction === 'function'
              ? await loopAction(info)
              : loopAction

            if (action === 'terminate') {
              loopDetected = true
              finalOutput = turnText
              break
            } else if (action === 'warn' || action === 'inject') {
              if (loopWarned) {
                // Second detection after a warning — force terminate.
                loopDetected = true
                finalOutput = turnText
                break
              }
              loopWarned = true
              injectWarning = true
              injectWarningKind = info.kind
              // Fall through to execute tools, then inject warning.
            }
            // 'continue' — do nothing, let the loop proceed normally.
          } else {
            // No loop detected this turn — agent has recovered, so reset
            // the warning state. A future loop gets a fresh warning cycle.
            loopWarned = false
          }
        }

        // ------------------------------------------------------------------
        // Step 3: Decide whether to continue looping.
        // ------------------------------------------------------------------
        if (toolUseBlocks.length === 0) {
          // Warn on first turn if tools were provided but model didn't use them.
          if (turns === 1 && toolDefs.length > 0 && options.onWarning) {
            const agentName = this.options.agentName ?? 'unknown'
            options.onWarning(
              `Agent "${agentName}" has ${toolDefs.length} tool(s) available but the model ` +
              `returned no tool calls. If using a local model, verify it supports tool calling ` +
              `(see https://ollama.com/search?c=tools).`,
            )
          }
          // No tools requested — this is the terminal assistant turn.
          finalOutput = turnText
          break
        }

        // Announce each tool-use block the model requested (after loop
        // detection, so terminate mode never emits unpaired events).
        for (const block of toolUseBlocks) {
          yield { type: 'tool_use', data: block } satisfies StreamEvent
        }

        // ------------------------------------------------------------------
        // Step 4: Execute all tool calls in PARALLEL.
        //
        // Parallel execution is critical for multi-tool responses where the
        // tools are independent (e.g. reading several files at once).
        // ------------------------------------------------------------------
        const toolContext: ToolUseContext = this.buildToolContext(options)

        const executionPromises = toolUseBlocks.map(async (block): Promise<{
          resultBlock: ToolResultBlock
          record: ToolCallRecord
          delegationUsage?: TokenUsage
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

          return {
            resultBlock,
            record,
            ...(result.metadata?.tokenUsage !== undefined
              ? { delegationUsage: result.metadata.tokenUsage }
              : {}),
          }
        })

        // Wait for every tool in this turn to finish.
        const executions = await Promise.all(executionPromises)

        // Roll up any nested-run token usage surfaced via ToolResult.metadata
        // (e.g. from delegate_to_agent) so it counts against this agent's budget.
        let delegationTurnUsage: TokenUsage | undefined
        for (const ex of executions) {
          if (ex.delegationUsage !== undefined) {
            totalUsage = addTokenUsage(totalUsage, ex.delegationUsage)
            delegationTurnUsage = delegationTurnUsage === undefined
              ? ex.delegationUsage
              : addTokenUsage(delegationTurnUsage, ex.delegationUsage)
          }
        }

        // ------------------------------------------------------------------
        // Step 5: Accumulate results and build the user message that carries
        //         them back to the LLM in the next turn.
        // ------------------------------------------------------------------
        const toolResultBlocks: ContentBlock[] = executions.map(e => e.resultBlock)

        for (const { record, resultBlock } of executions) {
          allToolCalls.push(record)
          yield { type: 'tool_result', data: resultBlock } satisfies StreamEvent
        }

        // Inject a loop-detection warning into the tool-result message so
        // the LLM sees it alongside the results (avoids two consecutive user
        // messages which violates the alternating-role constraint).
        if (injectWarning) {
          const warningText = injectWarningKind === 'text_repetition'
            ? 'WARNING: You appear to be generating the same response repeatedly. ' +
              'This suggests you are stuck in a loop. Please try a different approach ' +
              'or provide new information.'
            : 'WARNING: You appear to be repeating the same tool calls with identical arguments. ' +
              'This suggests you are stuck in a loop. Please try a different approach, use different ' +
              'parameters, or explain what you are trying to accomplish.'
          toolResultBlocks.push({ type: 'text' as const, text: warningText })
        }

        const toolResultMessage: LLMMessage = {
          role: 'user',
          content: toolResultBlocks,
        }

        conversationMessages.push(toolResultMessage)
        newMessages.push(toolResultMessage)
        options.onMessage?.(toolResultMessage)

        // Budget check is deferred until tool_result events have been yielded
        // and the tool_result user message has been appended, so stream
        // consumers see matched tool_use/tool_result pairs and the returned
        // `messages` remain resumable against the Anthropic/OpenAI APIs.
        if (delegationTurnUsage !== undefined && this.options.maxTokenBudget !== undefined) {
          const totalAfterDelegation = totalUsage.input_tokens + totalUsage.output_tokens
          if (totalAfterDelegation > this.options.maxTokenBudget) {
            budgetExceeded = true
            finalOutput = turnText
            yield {
              type: 'budget_exceeded',
              data: new TokenBudgetExceededError(
                this.options.agentName ?? 'unknown',
                totalAfterDelegation,
                this.options.maxTokenBudget,
              ),
            } satisfies StreamEvent
            break
          }
        }

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
      messages: newMessages,
      output: finalOutput,
      toolCalls: allToolCalls,
      tokenUsage: totalUsage,
      turns,
      ...(loopDetected ? { loopDetected: true } : {}),
      ...(budgetExceeded ? { budgetExceeded: true } : {}),
    }

    yield { type: 'done', data: runResult } satisfies StreamEvent
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Rule-based selective context compaction (no LLM calls).
   *
   * Compresses old turns while preserving the conversation skeleton:
   * - tool_use blocks (decisions) are always kept
   * - Long tool_result content is replaced with a compact marker
   * - Long assistant text blocks are truncated with an excerpt
   * - Error tool_results are never compressed
   * - Recent turns (within `preserveRecentTurns`) are kept intact
   */
  private compactMessages(
    messages: LLMMessage[],
    strategy: Extract<ContextStrategy, { type: 'compact' }>,
  ): LLMMessage[] {
    const estimated = estimateTokens(messages)
    if (estimated <= strategy.maxTokens) {
      return messages
    }

    const preserveRecent = strategy.preserveRecentTurns ?? 4
    const minToolResultChars = strategy.minToolResultChars ?? 200
    const minTextBlockChars = strategy.minTextBlockChars ?? 2000
    const textBlockExcerptChars = strategy.textBlockExcerptChars ?? 200

    // Find the first user message — it is always preserved as-is.
    const firstUserIndex = messages.findIndex(m => m.role === 'user')
    if (firstUserIndex < 0 || firstUserIndex === messages.length - 1) {
      return messages
    }

    // Walk backward to find the boundary between old and recent turns.
    // A "turn pair" is an assistant message followed by a user message.
    let boundary = messages.length
    let pairsFound = 0
    for (let i = messages.length - 1; i > firstUserIndex && pairsFound < preserveRecent; i--) {
      if (messages[i]!.role === 'user' && i > 0 && messages[i - 1]!.role === 'assistant') {
        pairsFound++
        boundary = i - 1
      }
    }

    // If all turns fit within the recent window, nothing to compact.
    if (boundary <= firstUserIndex + 1) {
      return messages
    }

    // Build a tool_use_id → tool name lookup from old assistant messages.
    const toolNameMap = new Map<string, string>()
    for (let i = firstUserIndex + 1; i < boundary; i++) {
      const msg = messages[i]!
      if (msg.role !== 'assistant') continue
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          toolNameMap.set(block.id, block.name)
        }
      }
    }

    // Process old messages (between first user and boundary).
    let anyChanged = false
    const result: LLMMessage[] = []

    for (let i = 0; i < messages.length; i++) {
      // First user message and recent messages: keep intact.
      if (i <= firstUserIndex || i >= boundary) {
        result.push(messages[i]!)
        continue
      }

      const msg = messages[i]!
      let msgChanged = false
      const newContent = msg.content.map((block): ContentBlock => {
        if (msg.role === 'assistant') {
          // tool_use blocks: always preserve (decisions).
          if (block.type === 'tool_use') return block
          // Long text blocks: truncate with excerpt.
          if (block.type === 'text' && block.text.length >= minTextBlockChars) {
            msgChanged = true
            return {
              type: 'text',
              text: `${block.text.slice(0, textBlockExcerptChars)}... [truncated — ${block.text.length} chars total]`,
            } satisfies TextBlock
          }
          // Image blocks in old turns: replace with marker.
          if (block.type === 'image') {
            msgChanged = true
            return { type: 'text', text: '[Image compacted]' } satisfies TextBlock
          }
          return block
        }

        // User messages in old zone.
        if (block.type === 'tool_result') {
          // Error results: always preserve.
          if (block.is_error) return block
          // Already compressed by compressToolResults or a prior compact pass.
          if (
            block.content.startsWith('[Tool output compressed') ||
            block.content.startsWith('[Tool result:')
          ) {
            return block
          }
          // Short results: preserve.
          if (block.content.length < minToolResultChars) return block
          const toolName = toolNameMap.get(block.tool_use_id) ?? 'unknown'
          // Delegation results: preserve — parent agent may still reason over them.
          if (toolName === 'delegate_to_agent') return block
          // Compress.
          msgChanged = true
          return {
            type: 'tool_result',
            tool_use_id: block.tool_use_id,
            content: `[Tool result: ${toolName} — ${block.content.length} chars, compacted]`,
          } satisfies ToolResultBlock
        }
        return block
      })

      if (msgChanged) {
        anyChanged = true
        result.push({ role: msg.role, content: newContent } as LLMMessage)
      } else {
        result.push(msg)
      }
    }

    return anyChanged ? result : messages
  }

  /**
   * Replace consumed tool results with compact markers.
   *
   * A tool_result is "consumed" when the assistant has produced a response
   * after seeing it (i.e. there is an assistant message following the user
   * message that contains the tool_result).  The most recent user message
   * with tool results is always kept intact — the LLM is about to see it.
   *
   * Error results and results shorter than `minChars` are never compressed.
   */
  private compressConsumedToolResults(messages: LLMMessage[]): LLMMessage[] {
    const config = this.options.compressToolResults
    if (!config) return messages

    const minChars = typeof config === 'object'
      ? (config.minChars ?? DEFAULT_MIN_COMPRESS_CHARS)
      : DEFAULT_MIN_COMPRESS_CHARS

    // Find the last user message that carries tool_result blocks.
    let lastToolResultUserIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (
        messages[i]!.role === 'user' &&
        messages[i]!.content.some(b => b.type === 'tool_result')
      ) {
        lastToolResultUserIdx = i
        break
      }
    }

    // Nothing to compress if there's at most one tool-result user message.
    if (lastToolResultUserIdx <= 0) return messages

    // Build a tool_use_id → tool name map so we can exempt delegation results,
    // whose full output the parent agent may need to re-read in later turns.
    const toolNameMap = new Map<string, string>()
    for (const msg of messages) {
      if (msg.role !== 'assistant') continue
      for (const block of msg.content) {
        if (block.type === 'tool_use') toolNameMap.set(block.id, block.name)
      }
    }

    let anyChanged = false
    const result = messages.map((msg, idx) => {
      // Only compress user messages that appear before the last one.
      if (msg.role !== 'user' || idx >= lastToolResultUserIdx) return msg

      const hasToolResult = msg.content.some(b => b.type === 'tool_result')
      if (!hasToolResult) return msg

      let msgChanged = false
      const newContent = msg.content.map((block): ContentBlock => {
        if (block.type !== 'tool_result') return block

        // Never compress error results — they carry diagnostic value.
        if (block.is_error) return block

        // Never compress delegation results — the parent agent relies on the full sub-agent output.
        if (toolNameMap.get(block.tool_use_id) === 'delegate_to_agent') return block

        // Skip already-compressed results — avoid re-compression with wrong char count.
        if (block.content.startsWith('[Tool output compressed')) return block

        // Skip short results — the marker itself has overhead.
        if (block.content.length < minChars) return block

        msgChanged = true
        return {
          type: 'tool_result',
          tool_use_id: block.tool_use_id,
          content: `[Tool output compressed — ${block.content.length} chars, already processed]`,
        } satisfies ToolResultBlock
      })

      if (msgChanged) {
        anyChanged = true
        return { role: msg.role, content: newContent } as LLMMessage
      }
      return msg
    })

    return anyChanged ? result : messages
  }

  /**
   * Build the {@link ToolUseContext} passed to every tool execution.
   * Identifies this runner as the invoking agent.
   */
  private buildToolContext(options: RunOptions = {}): ToolUseContext {
    return {
      agent: {
        name: this.options.agentName ?? 'runner',
        role: this.options.agentRole ?? 'assistant',
        model: this.options.model,
      },
      abortSignal: options.abortSignal ?? this.options.abortSignal,
      ...(options.team !== undefined ? { team: options.team } : {}),
    }
  }
}
