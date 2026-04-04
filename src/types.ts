/**
 * @fileoverview Core type definitions for the open-multi-agent orchestration framework.
 *
 * All public types are exported from this single module. Downstream modules
 * import only what they need, keeping the dependency graph acyclic.
 */

import type { ZodSchema } from 'zod'

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

/** Plain-text content produced by a model or supplied by the user. */
export interface TextBlock {
  readonly type: 'text'
  readonly text: string
}

/**
 * A request by the model to invoke a named tool with a structured input.
 * The `id` is unique per turn and is referenced by {@link ToolResultBlock}.
 */
export interface ToolUseBlock {
  readonly type: 'tool_use'
  readonly id: string
  readonly name: string
  readonly input: Record<string, unknown>
}

/**
 * The result of executing a tool, keyed back to the originating
 * {@link ToolUseBlock} via `tool_use_id`.
 */
export interface ToolResultBlock {
  readonly type: 'tool_result'
  readonly tool_use_id: string
  readonly content: string
  readonly is_error?: boolean
}

/** A base64-encoded image passed to or returned from a model. */
export interface ImageBlock {
  readonly type: 'image'
  readonly source: {
    readonly type: 'base64'
    readonly media_type: string
    readonly data: string
  }
}

/** Union of all content block variants that may appear in a message. */
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ImageBlock

// ---------------------------------------------------------------------------
// LLM messages & responses
// ---------------------------------------------------------------------------

/**
 * A single message in a conversation thread.
 * System messages are passed separately via {@link LLMChatOptions.systemPrompt}.
 */
export interface LLMMessage {
  readonly role: 'user' | 'assistant'
  readonly content: ContentBlock[]
}

/** Token accounting for a single API call. */
export interface TokenUsage {
  readonly input_tokens: number
  readonly output_tokens: number
}

/** Normalised response returned by every {@link LLMAdapter} implementation. */
export interface LLMResponse {
  readonly id: string
  readonly content: ContentBlock[]
  readonly model: string
  readonly stop_reason: string
  readonly usage: TokenUsage
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/**
 * A discrete event emitted during streaming generation.
 *
 * - `text`        — incremental text delta
 * - `tool_use`    — the model has begun or completed a tool-use block
 * - `tool_result` — a tool result has been appended to the stream
 * - `done`        — the stream has ended; `data` is the final {@link LLMResponse}
 * - `error`       — an unrecoverable error occurred; `data` is an `Error`
 */
export interface StreamEvent {
  readonly type: 'text' | 'tool_use' | 'tool_result' | 'done' | 'error'
  readonly data: unknown
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

/** The serialisable tool schema sent to the LLM provider. */
export interface LLMToolDef {
  readonly name: string
  readonly description: string
  /** JSON Schema object describing the tool's `input` parameter. */
  readonly inputSchema: Record<string, unknown>
}

/**
 * Context injected into every tool execution.
 *
 * Both `abortSignal` and `abortController` are provided so that tools and the
 * executor can choose the most ergonomic API for their use-case:
 *
 * - Long-running shell commands that need to kill a child process can use
 *   `abortController.signal` directly.
 * - Simple cancellation checks can read `abortSignal?.aborted`.
 *
 * When constructing a context, set `abortController` and derive `abortSignal`
 * from it, or provide both independently.
 */
export interface ToolUseContext {
  /** High-level description of the agent invoking this tool. */
  readonly agent: AgentInfo
  /** Team context, present when the tool runs inside a multi-agent team. */
  readonly team?: TeamInfo
  /**
   * Convenience reference to the abort signal.
   * Equivalent to `abortController?.signal` when an `abortController` is set.
   */
  readonly abortSignal?: AbortSignal
  /**
   * Full abort controller, available when the caller needs to inspect or
   * programmatically abort the signal.
   * Tools should prefer `abortSignal` for simple cancellation checks.
   */
  readonly abortController?: AbortController
  /** Working directory hint for file-system tools. */
  readonly cwd?: string
  /** Arbitrary caller-supplied metadata (session ID, request ID, etc.). */
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** Minimal descriptor for the agent that is invoking a tool. */
export interface AgentInfo {
  readonly name: string
  readonly role: string
  readonly model: string
}

/** Descriptor for a team of agents with shared memory. */
export interface TeamInfo {
  readonly name: string
  readonly agents: readonly string[]
  readonly sharedMemory: MemoryStore
}

/** Value returned by a tool's `execute` function. */
export interface ToolResult {
  readonly data: string
  readonly isError?: boolean
}

/**
 * A tool registered with the framework.
 *
 * `inputSchema` is a Zod schema used for validation before `execute` is called.
 * At API call time it is converted to JSON Schema via {@link LLMToolDef}.
 */
export interface ToolDefinition<TInput = Record<string, unknown>> {
  readonly name: string
  readonly description: string
  readonly inputSchema: ZodSchema<TInput>
  execute(input: TInput, context: ToolUseContext): Promise<ToolResult>
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

/** Context passed to the {@link AgentConfig.beforeRun} hook. */
export interface BeforeRunHookContext {
  /** The user prompt text. */
  readonly prompt: string
  /** The agent's static configuration. */
  readonly agent: AgentConfig
}

/** Static configuration for a single agent. */
export interface AgentConfig {
  readonly name: string
  readonly model: string
  readonly provider?: 'anthropic' | 'copilot' | 'grok' | 'openai'
  /**
   * Custom base URL for OpenAI-compatible APIs (Ollama, vLLM, LM Studio, etc.).
   * Note: local servers that don't require auth still need `apiKey` set to a
   * non-empty placeholder (e.g. `'ollama'`) because the OpenAI SDK validates it.
   */
  readonly baseURL?: string
  /** API key override; falls back to the provider's standard env var. */
  readonly apiKey?: string
  readonly systemPrompt?: string
  /** Names of tools (from the tool registry) available to this agent. */
  readonly tools?: readonly string[]
  readonly maxTurns?: number
  readonly maxTokens?: number
  readonly temperature?: number
  /**
   * Optional Zod schema for structured output.  When set, the agent's final
   * output is parsed as JSON and validated against this schema.  A single
   * retry with error feedback is attempted on validation failure.
   */
  readonly outputSchema?: ZodSchema
  /**
   * Called before each agent run. Receives the prompt and agent config.
   * Return a (possibly modified) context to continue, or throw to abort the run.
   * Only `prompt` from the returned context is applied; `agent` is read-only informational.
   */
  readonly beforeRun?: (context: BeforeRunHookContext) => Promise<BeforeRunHookContext> | BeforeRunHookContext
  /**
   * Called after each agent run completes successfully. Receives the run result.
   * Return a (possibly modified) result, or throw to mark the run as failed.
   * Not called when the run throws. For error observation, handle errors at the call site.
   */
  readonly afterRun?: (result: AgentRunResult) => Promise<AgentRunResult> | AgentRunResult
}

/** Lifecycle state tracked during an agent run. */
export interface AgentState {
  status: 'idle' | 'running' | 'completed' | 'error'
  messages: LLMMessage[]
  tokenUsage: TokenUsage
  error?: Error
}

/** A single recorded tool invocation within a run. */
export interface ToolCallRecord {
  readonly toolName: string
  readonly input: Record<string, unknown>
  readonly output: string
  /** Wall-clock duration in milliseconds. */
  readonly duration: number
}

/** The final result produced when an agent run completes (or fails). */
export interface AgentRunResult {
  readonly success: boolean
  readonly output: string
  readonly messages: LLMMessage[]
  readonly tokenUsage: TokenUsage
  readonly toolCalls: ToolCallRecord[]
  /**
   * Parsed and validated structured output when `outputSchema` is set on the
   * agent config.  `undefined` when no schema is configured or validation
   * failed after retry.
   */
  readonly structured?: unknown
}

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

/** Static configuration for a team of cooperating agents. */
export interface TeamConfig {
  readonly name: string
  readonly agents: readonly AgentConfig[]
  readonly sharedMemory?: boolean
  readonly maxConcurrency?: number
}

/** Aggregated result for a full team run. */
export interface TeamRunResult {
  readonly success: boolean
  /** Keyed by agent name. */
  readonly agentResults: Map<string, AgentRunResult>
  readonly totalTokenUsage: TokenUsage
}

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

/** Valid states for a {@link Task}. */
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'blocked' | 'skipped'

/** A discrete unit of work tracked by the orchestrator. */
export interface Task {
  readonly id: string
  readonly title: string
  readonly description: string
  status: TaskStatus
  /** Agent name responsible for executing this task. */
  assignee?: string
  /** IDs of tasks that must complete before this one can start. */
  dependsOn?: readonly string[]
  result?: string
  readonly createdAt: Date
  updatedAt: Date
  /** Maximum number of retry attempts on failure (default: 0 — no retry). */
  readonly maxRetries?: number
  /** Base delay in ms before the first retry (default: 1000). */
  readonly retryDelayMs?: number
  /** Exponential backoff multiplier (default: 2). */
  readonly retryBackoff?: number
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Progress event emitted by the orchestrator during a run.
 *
 * **v0.3 addition:** `'task_skipped'` — consumers with exhaustive switches
 * on `type` will need to add a case for this variant.
 */
export interface OrchestratorEvent {
  readonly type:
    | 'agent_start'
    | 'agent_complete'
    | 'task_start'
    | 'task_complete'
    | 'task_skipped'
    | 'task_retry'
    | 'message'
    | 'error'
  readonly agent?: string
  readonly task?: string
  readonly data?: unknown
}

/** Top-level configuration for the orchestrator. */
export interface OrchestratorConfig {
  readonly maxConcurrency?: number
  readonly defaultModel?: string
  readonly defaultProvider?: 'anthropic' | 'copilot' | 'grok' | 'openai'
  readonly defaultBaseURL?: string
  readonly defaultApiKey?: string
  readonly onProgress?: (event: OrchestratorEvent) => void
  readonly onTrace?: (event: TraceEvent) => void | Promise<void>
  /**
   * Optional approval gate called between task execution rounds.
   *
   * After a batch of tasks completes, this callback receives all
   * completed {@link Task}s from that round and the list of tasks about
   * to start next. Return `true` to continue or `false` to abort —
   * remaining tasks will be marked `'skipped'`.
   *
   * Not called when:
   * - No tasks succeeded in the round (all failed).
   * - No pending tasks remain after the round (final batch).
   *
   * **Note:** Do not mutate the {@link Task} objects passed to this
   * callback — they are live references to queue state. Mutation is
   * undefined behavior.
   */
  readonly onApproval?: (completedTasks: readonly Task[], nextTasks: readonly Task[]) => Promise<boolean>
}

// ---------------------------------------------------------------------------
// Trace events — lightweight observability spans
// ---------------------------------------------------------------------------

/** Trace event type discriminants. */
export type TraceEventType = 'llm_call' | 'tool_call' | 'task' | 'agent'

/** Shared fields present on every trace event. */
export interface TraceEventBase {
  /** Unique identifier for the entire run (runTeam / runTasks / runAgent call). */
  readonly runId: string
  readonly type: TraceEventType
  /** Unix epoch ms when the span started. */
  readonly startMs: number
  /** Unix epoch ms when the span ended. */
  readonly endMs: number
  /** Wall-clock duration in milliseconds (`endMs - startMs`). */
  readonly durationMs: number
  /** Agent name associated with this span. */
  readonly agent: string
  /** Task ID associated with this span. */
  readonly taskId?: string
}

/** Emitted for each LLM API call (one per agent turn). */
export interface LLMCallTrace extends TraceEventBase {
  readonly type: 'llm_call'
  readonly model: string
  readonly turn: number
  readonly tokens: TokenUsage
}

/** Emitted for each tool execution. */
export interface ToolCallTrace extends TraceEventBase {
  readonly type: 'tool_call'
  readonly tool: string
  readonly isError: boolean
}

/** Emitted when a task completes (wraps the full retry sequence). */
export interface TaskTrace extends TraceEventBase {
  readonly type: 'task'
  readonly taskId: string
  readonly taskTitle: string
  readonly success: boolean
  readonly retries: number
}

/** Emitted when an agent run completes (wraps the full conversation loop). */
export interface AgentTrace extends TraceEventBase {
  readonly type: 'agent'
  readonly turns: number
  readonly tokens: TokenUsage
  readonly toolCalls: number
}

/** Discriminated union of all trace event types. */
export type TraceEvent = LLMCallTrace | ToolCallTrace | TaskTrace | AgentTrace

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/** A single key-value record stored in a {@link MemoryStore}. */
export interface MemoryEntry {
  readonly key: string
  readonly value: string
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly createdAt: Date
}

/**
 * Persistent (or in-memory) key-value store shared across agents.
 * Implementations may be backed by Redis, SQLite, or plain objects.
 */
export interface MemoryStore {
  get(key: string): Promise<MemoryEntry | null>
  set(key: string, value: string, metadata?: Record<string, unknown>): Promise<void>
  list(): Promise<MemoryEntry[]>
  delete(key: string): Promise<void>
  clear(): Promise<void>
}

// ---------------------------------------------------------------------------
// LLM adapter
// ---------------------------------------------------------------------------

/** Options shared by both chat and streaming calls. */
export interface LLMChatOptions {
  readonly model: string
  readonly tools?: readonly LLMToolDef[]
  readonly maxTokens?: number
  readonly temperature?: number
  readonly systemPrompt?: string
  readonly abortSignal?: AbortSignal
}

/**
 * Options for streaming calls.
 * Extends {@link LLMChatOptions} without additional fields — the separation
 * exists so callers can type-narrow and implementations can diverge later.
 */
export interface LLMStreamOptions extends LLMChatOptions {}

/**
 * Provider-agnostic interface that every LLM backend must implement.
 *
 * @example
 * ```ts
 * const adapter: LLMAdapter = createAdapter('anthropic')
 * const response = await adapter.chat(messages, { model: 'claude-opus-4-6' })
 * ```
 */
export interface LLMAdapter {
  /** Human-readable provider name, e.g. `'anthropic'` or `'openai'`. */
  readonly name: string

  /**
   * Send a chat request and return the complete response.
   * Throws on non-retryable API errors.
   */
  chat(messages: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse>

  /**
   * Send a chat request and yield {@link StreamEvent}s incrementally.
   * The final event in the sequence always has `type === 'done'` on success,
   * or `type === 'error'` on failure.
   */
  stream(messages: LLMMessage[], options: LLMStreamOptions): AsyncIterable<StreamEvent>
}
