/**
 * @fileoverview High-level Agent class for open-multi-agent.
 *
 * {@link Agent} is the primary interface most consumers interact with.
 * It wraps {@link AgentRunner} with:
 *  - Persistent conversation history (`prompt()`)
 *  - Fresh-conversation semantics (`run()`)
 *  - Streaming support (`stream()`)
 *  - Dynamic tool registration at runtime
 *  - Full lifecycle state tracking (`idle → running → completed | error`)
 *
 * @example
 * ```ts
 * const agent = new Agent({
 *   name: 'researcher',
 *   model: 'claude-opus-4-6',
 *   systemPrompt: 'You are a rigorous research assistant.',
 *   tools: ['web_search', 'read_file'],
 * })
 *
 * const result = await agent.run('Summarise the last 3 IPCC reports.')
 * console.log(result.output)
 * ```
 */

import type {
  AgentConfig,
  AgentState,
  AgentRunResult,
  BeforeRunHookContext,
  LLMMessage,
  StreamEvent,
  TokenUsage,
  ToolUseContext,
} from '../types.js'
import { emitTrace, generateRunId } from '../utils/trace.js'
import type { ToolDefinition as FrameworkToolDefinition, ToolRegistry } from '../tool/framework.js'
import type { ToolExecutor } from '../tool/executor.js'
import { createAdapter } from '../llm/adapter.js'
import { AgentRunner, type RunnerOptions, type RunOptions, type RunResult } from './runner.js'
import {
  buildStructuredOutputInstruction,
  extractJSON,
  validateOutput,
} from './structured-output.js'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const ZERO_USAGE: TokenUsage = { input_tokens: 0, output_tokens: 0 }

/**
 * Combine two {@link AbortSignal}s so that aborting either one cancels the
 * returned signal.  Works on Node 18+ (no `AbortSignal.any` required).
 */
function mergeAbortSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const controller = new AbortController()
  if (a.aborted || b.aborted) { controller.abort(); return controller.signal }
  const abort = () => controller.abort()
  a.addEventListener('abort', abort, { once: true })
  b.addEventListener('abort', abort, { once: true })
  return controller.signal
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
  }
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

/**
 * High-level wrapper around {@link AgentRunner} that manages conversation
 * history, state transitions, and tool lifecycle.
 */
export class Agent {
  readonly name: string
  readonly config: AgentConfig

  private runner: AgentRunner | null = null
  private state: AgentState
  private readonly _toolRegistry: ToolRegistry
  private readonly _toolExecutor: ToolExecutor
  private messageHistory: LLMMessage[] = []

  /**
   * @param config       - Static configuration for this agent.
   * @param toolRegistry - Registry used to resolve and manage tools.
   * @param toolExecutor - Executor that dispatches tool calls.
   *
   * `toolRegistry` and `toolExecutor` are injected rather than instantiated
   * internally so that teams of agents can share a single registry.
   */
  constructor(
    config: AgentConfig,
    toolRegistry: ToolRegistry,
    toolExecutor: ToolExecutor,
  ) {
    this.name = config.name
    this.config = config
    this._toolRegistry = toolRegistry
    this._toolExecutor = toolExecutor

    this.state = {
      status: 'idle',
      messages: [],
      tokenUsage: ZERO_USAGE,
    }
  }

  // -------------------------------------------------------------------------
  // Initialisation (async, called lazily)
  // -------------------------------------------------------------------------

  /**
   * Lazily create the {@link AgentRunner}.
   *
   * The adapter is created asynchronously (it may lazy-import provider SDKs),
   * so we defer construction until the first `run` / `prompt` / `stream` call.
   */
  private async getRunner(): Promise<AgentRunner> {
    if (this.runner !== null) {
      return this.runner
    }

    const provider = this.config.provider ?? 'anthropic'
    const adapter = await createAdapter(provider, this.config.apiKey, this.config.baseURL)

    // Append structured-output instructions when an outputSchema is configured.
    let effectiveSystemPrompt = this.config.systemPrompt
    if (this.config.outputSchema) {
      const instruction = buildStructuredOutputInstruction(this.config.outputSchema)
      effectiveSystemPrompt = effectiveSystemPrompt
        ? effectiveSystemPrompt + '\n' + instruction
        : instruction
    }

    const runnerOptions: RunnerOptions = {
      model: this.config.model,
      systemPrompt: effectiveSystemPrompt,
      maxTurns: this.config.maxTurns,
      maxTokens: this.config.maxTokens,
      temperature: this.config.temperature,
      toolPreset: this.config.toolPreset,
      allowedTools: this.config.tools,
      disallowedTools: this.config.disallowedTools,
      agentName: this.name,
      agentRole: this.config.systemPrompt?.slice(0, 50) ?? 'assistant',
      loopDetection: this.config.loopDetection,
      maxTokenBudget: this.config.maxTokenBudget,
      contextStrategy: this.config.contextStrategy,
      compressToolResults: this.config.compressToolResults,
    }

    this.runner = new AgentRunner(
      adapter,
      this._toolRegistry,
      this._toolExecutor,
      runnerOptions,
    )

    return this.runner
  }

  // -------------------------------------------------------------------------
  // Primary execution methods
  // -------------------------------------------------------------------------

  /**
   * Run `prompt` in a fresh conversation (history is NOT used).
   *
   * Equivalent to constructing a brand-new messages array `[{ role:'user', … }]`
   * and calling the runner once. The agent's persistent history is not modified.
   *
   * Use this for one-shot queries where past context is irrelevant.
   */
  async run(prompt: string, runOptions?: Partial<RunOptions>): Promise<AgentRunResult> {
    const messages: LLMMessage[] = [
      { role: 'user', content: [{ type: 'text', text: prompt }] },
    ]

    return this.executeRun(messages, runOptions)
  }

  /**
   * Run `prompt` as part of the ongoing conversation.
   *
   * Appends the user message to the persistent history, runs the agent, then
   * appends the resulting messages to the history for the next call.
   *
   * Use this for multi-turn interactions.
   */
  // TODO(#18): accept optional RunOptions to forward trace context
  async prompt(message: string): Promise<AgentRunResult> {
    const userMessage: LLMMessage = {
      role: 'user',
      content: [{ type: 'text', text: message }],
    }

    this.messageHistory.push(userMessage)

    const result = await this.executeRun([...this.messageHistory])

    // Persist the new messages into history so the next prompt sees them.
    for (const msg of result.messages) {
      this.messageHistory.push(msg)
    }

    return result
  }

  /**
   * Stream a fresh-conversation response, yielding {@link StreamEvent}s.
   *
   * Like {@link run}, this does not use or update the persistent history.
   */
  // TODO(#18): accept optional RunOptions to forward trace context
  async *stream(prompt: string): AsyncGenerator<StreamEvent> {
    const messages: LLMMessage[] = [
      { role: 'user', content: [{ type: 'text', text: prompt }] },
    ]

    yield* this.executeStream(messages)
  }

  // -------------------------------------------------------------------------
  // State management
  // -------------------------------------------------------------------------

  /** Return a snapshot of the current agent state (does not clone nested objects). */
  getState(): AgentState {
    return { ...this.state, messages: [...this.state.messages] }
  }

  /** Return a copy of the persistent message history. */
  getHistory(): LLMMessage[] {
    return [...this.messageHistory]
  }

  /**
   * Clear the persistent conversation history and reset state to `idle`.
   * Does NOT discard the runner instance — the adapter connection is reused.
   */
  reset(): void {
    this.messageHistory = []
    this.state = {
      status: 'idle',
      messages: [],
      tokenUsage: ZERO_USAGE,
    }
  }

  // -------------------------------------------------------------------------
  // Dynamic tool management
  // -------------------------------------------------------------------------

  /**
   * Register a new tool with this agent's tool registry at runtime.
   *
   * The tool becomes available to the next LLM call — no restart required.
   */
  addTool(tool: FrameworkToolDefinition): void {
    this._toolRegistry.register(tool, { runtimeAdded: true })
  }

  /**
   * Deregister a tool by name.
   * If the tool is not registered this is a no-op (no error is thrown).
   */
  removeTool(name: string): void {
    this._toolRegistry.deregister(name)
  }

  /** Return the names of all currently registered tools. */
  getTools(): string[] {
    return this._toolRegistry.list().map((t) => t.name)
  }

  // -------------------------------------------------------------------------
  // Private execution core
  // -------------------------------------------------------------------------

  /**
   * Shared execution path used by both `run` and `prompt`.
   * Handles state transitions and error wrapping.
   */
  private async executeRun(
    messages: LLMMessage[],
    callerOptions?: Partial<RunOptions>,
  ): Promise<AgentRunResult> {
    this.transitionTo('running')

    const agentStartMs = Date.now()

    try {
      // --- beforeRun hook ---
      if (this.config.beforeRun) {
        const hookCtx = this.buildBeforeRunHookContext(messages)
        const modified = await this.config.beforeRun(hookCtx)
        this.applyHookContext(messages, modified, hookCtx.prompt)
      }

      const runner = await this.getRunner()
      const internalOnMessage = (msg: LLMMessage) => {
        this.state.messages.push(msg)
        callerOptions?.onMessage?.(msg)
      }
      // Auto-generate runId when onTrace is provided but runId is missing
      const needsRunId = callerOptions?.onTrace && !callerOptions.runId
      // Create a fresh timeout signal per run (not per runner) so that
      // each run() / prompt() call gets its own timeout window.
      const timeoutSignal = this.config.timeoutMs !== undefined && this.config.timeoutMs > 0
        ? AbortSignal.timeout(this.config.timeoutMs)
        : undefined
      // Merge caller-provided abortSignal with the timeout signal so that
      // either cancellation source is respected.
      const callerAbort = callerOptions?.abortSignal
      const effectiveAbort = timeoutSignal && callerAbort
        ? mergeAbortSignals(timeoutSignal, callerAbort)
        : timeoutSignal ?? callerAbort
      const runOptions: RunOptions = {
        ...callerOptions,
        onMessage: internalOnMessage,
        ...(needsRunId ? { runId: generateRunId() } : undefined),
        ...(effectiveAbort ? { abortSignal: effectiveAbort } : undefined),
      }

      const result = await runner.run(messages, runOptions)
      this.state.tokenUsage = addUsage(this.state.tokenUsage, result.tokenUsage)

      if (result.budgetExceeded) {
        let budgetResult = this.toAgentRunResult(result, false)
        if (this.config.afterRun) {
          budgetResult = await this.config.afterRun(budgetResult)
        }
        this.transitionTo('completed')
        this.emitAgentTrace(callerOptions, agentStartMs, budgetResult)
        return budgetResult
      }

      // --- Structured output validation ---
      if (this.config.outputSchema) {
        let validated = await this.validateStructuredOutput(
          messages,
          result,
          runner,
          runOptions,
        )
        // --- afterRun hook ---
        if (this.config.afterRun) {
          validated = await this.config.afterRun(validated)
        }
        this.emitAgentTrace(callerOptions, agentStartMs, validated)
        return validated
      }

      let agentResult = this.toAgentRunResult(result, true)

      // --- afterRun hook ---
      if (this.config.afterRun) {
        agentResult = await this.config.afterRun(agentResult)
      }

      this.transitionTo('completed')
      this.emitAgentTrace(callerOptions, agentStartMs, agentResult)
      return agentResult
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      this.transitionToError(error)

      const errorResult: AgentRunResult = {
        success: false,
        output: error.message,
        messages: [],
        tokenUsage: ZERO_USAGE,
        toolCalls: [],
        structured: undefined,
      }
      this.emitAgentTrace(callerOptions, agentStartMs, errorResult)
      return errorResult
    }
  }

  /** Emit an `agent` trace event if `onTrace` is provided. */
  private emitAgentTrace(
    options: Partial<RunOptions> | undefined,
    startMs: number,
    result: AgentRunResult,
  ): void {
    if (!options?.onTrace) return
    const endMs = Date.now()
    emitTrace(options.onTrace, {
      type: 'agent',
      runId: options.runId ?? '',
      taskId: options.taskId,
      agent: options.traceAgent ?? this.name,
      turns: result.messages.filter(m => m.role === 'assistant').length,
      tokens: result.tokenUsage,
      toolCalls: result.toolCalls.length,
      startMs,
      endMs,
      durationMs: endMs - startMs,
    })
  }

  /**
   * Validate agent output against the configured `outputSchema`.
   * On first validation failure, retry once with error feedback.
   */
  private async validateStructuredOutput(
    originalMessages: LLMMessage[],
    result: RunResult,
    runner: AgentRunner,
    runOptions: RunOptions,
  ): Promise<AgentRunResult> {
    const schema = this.config.outputSchema!

    // First attempt
    let firstAttemptError: unknown
    try {
      const parsed = extractJSON(result.output)
      const validated = validateOutput(schema, parsed)
      this.transitionTo('completed')
      return this.toAgentRunResult(result, true, validated)
    } catch (e) {
      firstAttemptError = e
    }

    // Retry: send full context + error feedback
    const errorMsg = firstAttemptError instanceof Error
      ? firstAttemptError.message
      : String(firstAttemptError)

    const errorFeedbackMessage: LLMMessage = {
      role: 'user' as const,
      content: [{
        type: 'text' as const,
        text: [
          'Your previous response did not produce valid JSON matching the required schema.',
          '',
          `Error: ${errorMsg}`,
          '',
          'Please try again. Respond with ONLY valid JSON, no other text.',
        ].join('\n'),
      }],
    }

    const retryMessages: LLMMessage[] = [
      ...originalMessages,
      ...result.messages,
      errorFeedbackMessage,
    ]

    const retryResult = await runner.run(retryMessages, runOptions)
    this.state.tokenUsage = addUsage(this.state.tokenUsage, retryResult.tokenUsage)

    const mergedTokenUsage = addUsage(result.tokenUsage, retryResult.tokenUsage)
    // Include the error feedback turn to maintain alternating user/assistant roles,
    // which is required by Anthropic's API for subsequent prompt() calls.
    const mergedMessages = [...result.messages, errorFeedbackMessage, ...retryResult.messages]
    const mergedToolCalls = [...result.toolCalls, ...retryResult.toolCalls]

    try {
      const parsed = extractJSON(retryResult.output)
      const validated = validateOutput(schema, parsed)
      this.transitionTo('completed')
      return {
        success: true,
        output: retryResult.output,
        messages: mergedMessages,
        tokenUsage: mergedTokenUsage,
        toolCalls: mergedToolCalls,
        structured: validated,
        ...(retryResult.budgetExceeded ? { budgetExceeded: true } : {}),
      }
    } catch {
      // Retry also failed
      this.transitionTo('completed')
      return {
        success: false,
        output: retryResult.output,
        messages: mergedMessages,
        tokenUsage: mergedTokenUsage,
        toolCalls: mergedToolCalls,
        structured: undefined,
        ...(retryResult.budgetExceeded ? { budgetExceeded: true } : {}),
      }
    }
  }

  /**
   * Shared streaming path used by `stream`.
   * Handles state transitions and error wrapping.
   */
  private async *executeStream(messages: LLMMessage[]): AsyncGenerator<StreamEvent> {
    this.transitionTo('running')

    try {
      // --- beforeRun hook ---
      if (this.config.beforeRun) {
        const hookCtx = this.buildBeforeRunHookContext(messages)
        const modified = await this.config.beforeRun(hookCtx)
        this.applyHookContext(messages, modified, hookCtx.prompt)
      }

      const runner = await this.getRunner()
      // Fresh timeout per stream call, same as executeRun.
      const timeoutSignal = this.config.timeoutMs !== undefined && this.config.timeoutMs > 0
        ? AbortSignal.timeout(this.config.timeoutMs)
        : undefined

      for await (const event of runner.stream(messages, timeoutSignal ? { abortSignal: timeoutSignal } : {})) {
        if (event.type === 'done') {
          const result = event.data as import('./runner.js').RunResult
          this.state.tokenUsage = addUsage(this.state.tokenUsage, result.tokenUsage)

          let agentResult = this.toAgentRunResult(result, !result.budgetExceeded)
          if (this.config.afterRun) {
            agentResult = await this.config.afterRun(agentResult)
          }
          this.transitionTo('completed')
          yield { type: 'done', data: agentResult } satisfies StreamEvent
          continue
        } else if (event.type === 'error') {
          const error = event.data instanceof Error
            ? event.data
            : new Error(String(event.data))
          this.transitionToError(error)
        }

        yield event
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      this.transitionToError(error)
      yield { type: 'error', data: error } satisfies StreamEvent
    }
  }

  // -------------------------------------------------------------------------
  // Hook helpers
  // -------------------------------------------------------------------------

  /** Extract the prompt text from the last user message to build hook context. */
  private buildBeforeRunHookContext(messages: LLMMessage[]): BeforeRunHookContext {
    let prompt = ''
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === 'user') {
        prompt = messages[i]!.content
          .filter((b): b is import('../types.js').TextBlock => b.type === 'text')
          .map(b => b.text)
          .join('')
        break
      }
    }
    // Strip hook functions to avoid circular self-references in the context
    const { beforeRun, afterRun, ...agentInfo } = this.config
    return { prompt, agent: agentInfo as AgentConfig }
  }

  /**
   * Apply a (possibly modified) hook context back to the messages array.
   *
   * Only text blocks in the last user message are replaced; non-text content
   * (images, tool results) is preserved. The array element is replaced (not
   * mutated in place) so that shallow copies of the original array (e.g. from
   * `prompt()`) are not affected.
   */
  private applyHookContext(messages: LLMMessage[], ctx: BeforeRunHookContext, originalPrompt: string): void {
    if (ctx.prompt === originalPrompt) return

    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === 'user') {
        const nonTextBlocks = messages[i]!.content.filter(b => b.type !== 'text')
        messages[i] = {
          role: 'user',
          content: [{ type: 'text', text: ctx.prompt }, ...nonTextBlocks],
        }
        break
      }
    }
  }

  // -------------------------------------------------------------------------
  // State transition helpers
  // -------------------------------------------------------------------------

  private transitionTo(status: 'idle' | 'running' | 'completed' | 'error'): void {
    this.state = { ...this.state, status }
  }

  private transitionToError(error: Error): void {
    this.state = { ...this.state, status: 'error', error }
  }

  // -------------------------------------------------------------------------
  // Result mapping
  // -------------------------------------------------------------------------

  private toAgentRunResult(
    result: RunResult,
    success: boolean,
    structured?: unknown,
  ): AgentRunResult {
    return {
      success,
      output: result.output,
      messages: result.messages,
      tokenUsage: result.tokenUsage,
      toolCalls: result.toolCalls,
      structured,
      ...(result.loopDetected ? { loopDetected: true } : {}),
      ...(result.budgetExceeded ? { budgetExceeded: true } : {}),
    }
  }

  // -------------------------------------------------------------------------
  // ToolUseContext builder (for direct use by subclasses or advanced callers)
  // -------------------------------------------------------------------------

  /**
   * Build a {@link ToolUseContext} that identifies this agent.
   * Exposed so team orchestrators can inject richer context (e.g. `TeamInfo`).
   */
  buildToolContext(abortSignal?: AbortSignal): ToolUseContext {
    return {
      agent: {
        name: this.name,
        role: this.config.systemPrompt?.slice(0, 60) ?? 'assistant',
        model: this.config.model,
      },
      abortSignal,
    }
  }
}
