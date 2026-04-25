/**
 * @fileoverview Core type definitions for the open-multi-agent orchestration framework.
 *
 * All public types are exported from this single module. Downstream modules
 * import only what they need, keeping the dependency graph acyclic.
 */

import type { ZodSchema } from 'zod'
import type { SupportedProvider } from './llm/adapter.js'

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

/** Context management strategy for long-running agent conversations. */
export type ContextStrategy =
  | { type: 'sliding-window'; maxTurns: number }
  | { type: 'summarize'; maxTokens: number; summaryModel?: string }
  | {
      type: 'compact'
      /** Estimated token threshold that triggers compaction. Compaction is skipped when below this. */
      maxTokens: number
      /** Number of recent turn pairs (assistant+user) to keep intact. Default: 4. */
      preserveRecentTurns?: number
      /** Minimum chars in a tool_result content to qualify for compaction. Default: 200. */
      minToolResultChars?: number
      /** Minimum chars in an assistant text block to qualify for truncation. Default: 2000. */
      minTextBlockChars?: number
      /** Maximum chars to keep from a truncated text block (head excerpt). Default: 200. */
      textBlockExcerptChars?: number
    }
  | {
    type: 'custom'
    /**
     * Compaction callback. Invoked before every LLM turn including the first,
     * so implementations that should only fire past a token threshold must
     * self-gate inside this function.
     */
    compress: (
      messages: LLMMessage[],
      estimatedTokens: number,
    ) => Promise<LLMMessage[]> | LLMMessage[]
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
 * - `budget_exceeded` — token budget threshold reached for this run
 * - `done`        — the stream has ended; `data` is the final {@link LLMResponse}
 * - `error`       — an unrecoverable error occurred; `data` is an `Error`
 */
export interface StreamEvent {
  readonly type: 'text' | 'tool_use' | 'tool_result' | 'loop_detected' | 'budget_exceeded' | 'done' | 'error'
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

/**
 * Minimal pool surface used by `delegate_to_agent` to detect nested-run capacity.
 * {@link AgentPool} satisfies this structurally via {@link AgentPool.availableRunSlots}.
 */
export interface DelegationPoolView {
  readonly availableRunSlots: number
}

/** Descriptor for a team of agents (orchestrator-injected into tool context). */
export interface TeamInfo {
  readonly name: string
  readonly agents: readonly string[]
  /** When the team has shared memory enabled; used for delegation audit writes. */
  readonly sharedMemory?: MemoryStore
  /** Zero-based depth of nested delegation from the root task run. */
  readonly delegationDepth?: number
  readonly maxDelegationDepth?: number
  readonly delegationPool?: DelegationPoolView
  /**
   * Ordered chain of agent names from the root task to the current agent.
   * Used to block `A -> B -> A` cycles before they burn turns against `maxDelegationDepth`.
   */
  readonly delegationChain?: readonly string[]
  /**
   * Run another roster agent to completion and return its result.
   * Only set during orchestrated pool execution (`runTeam` / `runTasks`).
   */
  readonly runDelegatedAgent?: (targetAgent: string, prompt: string) => Promise<AgentRunResult>
}

/**
 * Optional side-channel metadata a tool may attach to its result.
 * Not shown to the LLM — the runner reads it for accounting purposes.
 */
export interface ToolResultMetadata {
  /**
   * Token usage consumed inside the tool execution itself (e.g. nested LLM
   * calls from `delegate_to_agent`). Accumulated into the parent runner's
   * total so budgets/cost tracking stay accurate across delegation.
   */
  readonly tokenUsage?: TokenUsage
}

/** Value returned by a tool's `execute` function. */
export interface ToolResult {
  readonly data: string
  readonly isError?: boolean
  readonly metadata?: ToolResultMetadata
}

/**
 * A tool registered with the framework.
 *
 * `inputSchema` is a Zod schema used for validation before `execute` is called.
 * At API call time it is converted to JSON Schema for {@link LLMToolDef}, unless
 * `llmInputSchema` is set (e.g. MCP tools ship JSON Schema from the server).
 *
 * `outputSchema` is optional runtime validation for `ToolResult.data`.  When
 * set and validation fails, execution returns an error ToolResult instead of
 * propagating invalid output.
 */
export interface ToolDefinition<TInput = Record<string, unknown>> {
  readonly name: string
  readonly description: string
  readonly inputSchema: ZodSchema<TInput>
  /**
   * Optional runtime validator for `ToolResult.data` (always a string).
   *
   * **Not to be confused with {@link AgentConfig.outputSchema}**, which
   * validates an agent's final JSON answer. This one only guards a single
   * tool's serialised output.
   */
  readonly outputSchema?: ZodSchema<string>
  /**
   * When present, used as {@link LLMToolDef.inputSchema} as-is instead of
   * deriving JSON Schema from `inputSchema` (Zod).
   */
  readonly llmInputSchema?: Record<string, unknown>
  /**
   * Per-tool maximum output length in characters. When set, tool output
   * exceeding this limit is truncated (head + tail with a marker in between).
   * Takes priority over {@link AgentConfig.maxToolOutputChars}.
   */
  readonly maxOutputChars?: number
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
  readonly provider?: SupportedProvider
  /**
   * Custom base URL for OpenAI-compatible APIs (Ollama, vLLM, LM Studio, etc.).
   * Note: local servers that don't require auth still need `apiKey` set to a
   * non-empty placeholder (e.g. `'ollama'`) because the OpenAI SDK validates it.
   */
  readonly baseURL?: string
  /** API key override; falls back to the provider's standard env var. */
  readonly apiKey?: string
  readonly systemPrompt?: string
  /**
   * Custom tool definitions to register alongside built-in tools.
   * Created via `defineTool()`. Custom tools bypass `tools` (allowlist)
   * and `toolPreset` filtering, but can still be blocked by `disallowedTools`.
   *
   * Tool names must not collide with built-in tool names; a duplicate name
   * will throw at registration time.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly customTools?: readonly ToolDefinition<any>[]
  /** Names of tools (from the tool registry) available to this agent. */
  readonly tools?: readonly string[]
  /** Names of tools explicitly disallowed for this agent. */
  readonly disallowedTools?: readonly string[]
  /** Predefined tool preset for common use cases. */
  readonly toolPreset?: 'readonly' | 'readwrite' | 'full'
  readonly maxTurns?: number
  readonly maxTokens?: number
  /** Maximum cumulative tokens (input + output) allowed for this run. */
  readonly maxTokenBudget?: number
  /** Optional context compression policy to control input growth across turns. */
  readonly contextStrategy?: ContextStrategy
  readonly temperature?: number
  /**
   * OpenAI-track sampling penalty for token frequency. Forwarded to OpenAI
   * cloud and OpenAI-compatible local servers (vLLM, llama-server). The
   * Anthropic adapter ignores this field.
   */
  readonly frequencyPenalty?: number
  /**
   * OpenAI-track sampling penalty for token presence. Forwarded to OpenAI
   * cloud and OpenAI-compatible local servers. The Anthropic adapter
   * ignores this field.
   */
  readonly presencePenalty?: number
  /**
   * Nucleus sampling cutoff. Forwarded to all adapters (OpenAI cloud,
   * OpenAI-compatible local, Anthropic).
   */
  readonly topP?: number
  /**
   * Top-k sampling cutoff. Forwarded to Anthropic and OpenAI-compatible
   * local servers. Cloud OpenAI rejects this parameter.
   */
  readonly topK?: number
  /**
   * Min-p sampling cutoff. Only supported by OpenAI-compatible local
   * servers (vLLM, llama-server, etc.). Cloud OpenAI rejects this parameter
   * and the Anthropic adapter ignores it.
   */
  readonly minP?: number
  /**
   * Whether the model may emit multiple tool calls in a single assistant
   * turn. Forwarded to OpenAI cloud and OpenAI-compatible local servers as
   * `parallel_tool_calls`. The Anthropic adapter ignores this field.
   *
   * - `undefined` (default): omit the field, server default applies. Cloud
   *   OpenAI defaults to `true`.
   * - `false`: force serial tool calling. Required by some local servers
   *   (vLLM, llama-server, certain quantized setups) that truncate
   *   concurrent `tool_call` deltas during streaming or return malformed
   *   `tool_calls` when more than one is emitted.
   * - `true`: explicit opt-in (matches the cloud default; no behavior
   *   change for cloud OpenAI users).
   */
  readonly parallelToolCalls?: boolean
  /**
   * Adapter-specific escape hatch merged into the outgoing request payload.
   * Spread between the sampling params and the structural fields, so values
   * here can override the standard sampling defaults (`temperature`, `topP`,
   * etc.) but cannot override transport-level fields (`model`, `messages`,
   * `tools`, `stream`, and Anthropic's `system`).
   */
  readonly extraBody?: Record<string, unknown>
  /**
   * Maximum wall-clock time (in milliseconds) for the entire agent run.
   * When exceeded, the run is aborted via `AbortSignal.timeout()`.
   * Useful for local models where inference can be unpredictably slow.
   */
  readonly timeoutMs?: number
  /**
   * Loop detection configuration. When set, the agent tracks repeated tool
   * calls and text outputs to detect stuck loops before `maxTurns` is reached.
   */
  readonly loopDetection?: LoopDetectionConfig
  /**
   * Maximum tool output length in characters for all tools used by this agent.
   * When set, tool outputs exceeding this limit are truncated (head + tail
   * with a marker in between). Per-tool {@link ToolDefinition.maxOutputChars}
   * takes priority over this value.
   */
  readonly maxToolOutputChars?: number
  /**
   * Compress tool results that the agent has already processed.
   *
   * In multi-turn runs, tool results persist in the conversation even after the
   * agent has acted on them. When enabled, consumed tool results (those followed
   * by an assistant response) are replaced with a short marker before the next
   * LLM call, freeing context budget for new reasoning.
   *
   * - `true` — enable with default threshold (500 chars)
   * - `{ minChars: N }` — only compress results longer than N characters
   * - `false` / `undefined` — disabled (default)
   *
   * Error tool results are never compressed.
   */
  readonly compressToolResults?: boolean | { readonly minChars?: number }
  /**
   * Optional Zod schema for structured output.  When set, the agent's final
   * output is parsed as JSON and validated against this schema.  A single
   * retry with error feedback is attempted on validation failure.
   *
   * **Distinct from {@link ToolDefinition.outputSchema}**, which validates an
   * individual tool's `ToolResult.data` string. This one operates on the
   * agent's final answer as parsed JSON.
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

// ---------------------------------------------------------------------------
// Loop detection
// ---------------------------------------------------------------------------

/** Configuration for agent loop detection. */
export interface LoopDetectionConfig {
  /**
   * Maximum consecutive times the same tool call (name + args) or text
   * output can repeat before detection triggers. Default: `3`.
   */
  readonly maxRepetitions?: number
  /**
   * Number of recent turns to track for repetition analysis. Default: `4`.
   */
  readonly loopDetectionWindow?: number
  /**
   * Action to take when a loop is detected.
   * - `'warn'`      — inject a "you appear stuck" message, give the LLM one
   *                    more chance; terminate if the loop persists (default)
   * - `'terminate'` — stop the run immediately
   * - `function`    — custom callback (sync or async); return `'continue'`,
   *                    `'inject'`, or `'terminate'` to control the outcome
   */
  readonly onLoopDetected?: 'warn' | 'terminate' | ((info: LoopDetectionInfo) => 'continue' | 'inject' | 'terminate' | Promise<'continue' | 'inject' | 'terminate'>)
}

/** Diagnostic payload emitted when a loop is detected. */
export interface LoopDetectionInfo {
  readonly kind: 'tool_repetition' | 'text_repetition'
  /** Number of consecutive identical occurrences observed. */
  readonly repetitions: number
  /** Human-readable description of the detected loop. */
  readonly detail: string
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
  /** True when the run was terminated or warned due to loop detection. */
  readonly loopDetected?: boolean
  /** True when the run stopped because token budget was exceeded. */
  readonly budgetExceeded?: boolean
}

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

/** Static configuration for a team of cooperating agents. */
export interface TeamConfig {
  readonly name: string
  readonly agents: readonly AgentConfig[]
  readonly sharedMemory?: boolean
  /**
   * Custom {@link MemoryStore} backing the team's shared memory (e.g. Redis,
   * Postgres, or a remote service). When provided, shared memory is enabled
   * regardless of `sharedMemory`. When both are set, `sharedMemoryStore` wins.
   * When omitted and `sharedMemory` is `true`, the default in-memory store is used.
   *
   * SDK-only: the CLI (`oma`) cannot pass runtime objects through its JSON config.
   */
  readonly sharedMemoryStore?: MemoryStore
  readonly maxConcurrency?: number
}

/** Aggregated result for a full team run. */
export interface TeamRunResult {
  readonly success: boolean
  readonly goal?: string
  readonly tasks?: readonly TaskExecutionRecord[]
  /** Keyed by agent name. */
  readonly agentResults: Map<string, AgentRunResult>
  readonly totalTokenUsage: TokenUsage
}

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

/** Valid states for a {@link Task}. */
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'blocked' | 'skipped'

/**
 * Metrics shown in the team-run dashboard detail panel for a single task.
 * Mirrors execution data collected during orchestration.
 */
export interface TaskExecutionMetrics {
  readonly startMs: number
  readonly endMs: number
  readonly durationMs: number
  readonly tokenUsage: TokenUsage
  readonly toolCalls: AgentRunResult['toolCalls']
}

/** Serializable task snapshot embedded in the static HTML dashboard. */
export interface TaskExecutionRecord {
  readonly id: string
  readonly title: string
  readonly assignee?: string
  readonly status: TaskStatus
  readonly dependsOn: readonly string[]
  readonly metrics?: TaskExecutionMetrics
}

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
  /**
   * Controls what prior team context is injected into this task's prompt.
   * - `dependencies` (default): only direct dependency task results
   * - `all`: full shared-memory summary
   */
  readonly memoryScope?: 'dependencies' | 'all'
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
    | 'budget_exceeded'
    | 'message'
    | 'error'
  readonly agent?: string
  readonly task?: string
  readonly data?: unknown
}

/** Top-level configuration for the orchestrator. */
export interface OrchestratorConfig {
  readonly maxConcurrency?: number
  /**
   * Maximum depth of `delegate_to_agent` chains from a task run (default `3`).
   * Depth is per nested delegated run, not per team.
   */
  readonly maxDelegationDepth?: number
  /** Maximum cumulative tokens (input + output) allowed per orchestrator run. */
  readonly maxTokenBudget?: number
  readonly defaultModel?: string
  readonly defaultProvider?: SupportedProvider
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

/**
 * Optional overrides for the temporary coordinator agent created by `runTeam`.
 *
 * All fields are optional. Unset fields fall back to orchestrator defaults
 * (or coordinator built-in defaults where applicable).
 */
export interface CoordinatorConfig {
  /** Coordinator model. Defaults to `OrchestratorConfig.defaultModel`. */
  readonly model?: string
  readonly provider?: SupportedProvider
  readonly baseURL?: string
  readonly apiKey?: string
  /**
   * Full system prompt override. When set, this replaces the default
   * coordinator preamble and decomposition guidance.
   *
   * Team roster, output format, and synthesis sections are still appended.
   */
  readonly systemPrompt?: string
  /**
   * Additional instructions appended to the default coordinator prompt.
   * Ignored when `systemPrompt` is provided.
   */
  readonly instructions?: string
  readonly maxTurns?: number
  readonly maxTokens?: number
  readonly temperature?: number
  /** See {@link AgentConfig.frequencyPenalty}. */
  readonly frequencyPenalty?: number
  /** See {@link AgentConfig.presencePenalty}. */
  readonly presencePenalty?: number
  /** See {@link AgentConfig.topP}. */
  readonly topP?: number
  /** See {@link AgentConfig.topK}. */
  readonly topK?: number
  /** See {@link AgentConfig.minP}. */
  readonly minP?: number
  /** See {@link AgentConfig.parallelToolCalls}. */
  readonly parallelToolCalls?: boolean
  /**
   * Adapter-specific escape hatch merged into the outgoing request payload.
   * Spread between the sampling params and the structural fields, so values
   * here can override the standard sampling defaults (`temperature`, `topP`,
   * etc.) but cannot override transport-level fields (`model`, `messages`,
   * `tools`, `stream`, and Anthropic's `system`).
   */
  readonly extraBody?: Record<string, unknown>
  /** Predefined tool preset for common coordinator use cases. */
  readonly toolPreset?: 'readonly' | 'readwrite' | 'full'
  /** Tool names available to the coordinator. */
  readonly tools?: readonly string[]
  /** Tool names explicitly denied to the coordinator. */
  readonly disallowedTools?: readonly string[]
  readonly loopDetection?: LoopDetectionConfig
  readonly timeoutMs?: number
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
  /** Distinguishes normal turn calls from context-summary calls. */
  readonly phase?: 'turn' | 'summary'
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
  /** See {@link AgentConfig.frequencyPenalty}. */
  readonly frequencyPenalty?: number
  /** See {@link AgentConfig.presencePenalty}. */
  readonly presencePenalty?: number
  /** See {@link AgentConfig.topP}. */
  readonly topP?: number
  /** See {@link AgentConfig.topK}. */
  readonly topK?: number
  /** See {@link AgentConfig.minP}. */
  readonly minP?: number
  /** See {@link AgentConfig.parallelToolCalls}. */
  readonly parallelToolCalls?: boolean
  /**
   * Adapter-specific escape hatch merged into the outgoing request payload.
   * Spread between the sampling params and the structural fields, so values
   * here can override the standard sampling defaults (`temperature`, `topP`,
   * etc.) but cannot override transport-level fields (`model`, `messages`,
   * `tools`, `stream`, and Anthropic's `system`).
   */
  readonly extraBody?: Record<string, unknown>
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
