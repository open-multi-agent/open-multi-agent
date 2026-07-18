/**
 * @fileoverview OpenMultiAgent — the top-level multi-agent orchestration class.
 *
 * {@link OpenMultiAgent} is the primary public API of the open-multi-agent framework.
 * It ties together every subsystem:
 *
 *  - {@link Team}       — Agent roster, shared memory, inter-agent messaging
 *  - {@link TaskQueue}  — Dependency-aware work queue
 *  - {@link Scheduler}  — Task-to-agent assignment strategies
 *  - {@link AgentPool}  — Concurrency-controlled execution pool
 *  - {@link Agent}      — Conversation + tool-execution loop
 *
 * ## Quick start
 *
 * ```ts
 * const orchestrator = new OpenMultiAgent({ defaultModel: 'claude-opus-4-6' })
 *
 * const team = orchestrator.createTeam('research', {
 *   name: 'research',
 *   agents: [
 *     { name: 'researcher', model: 'claude-opus-4-6', systemPrompt: 'You are a researcher.' },
 *     { name: 'writer',     model: 'claude-opus-4-6', systemPrompt: 'You are a technical writer.' },
 *   ],
 *   sharedMemory: true,
 * })
 *
 * const result = await orchestrator.runTeam(team, 'Produce a report on TypeScript 5.5.')
 * console.log(result.agentResults.get('coordinator')?.output)
 * ```
 *
 * ## Key design decisions
 *
 * - **Coordinator pattern** — `runTeam()` spins up a temporary "coordinator" agent
 *   that breaks the high-level goal into tasks, assigns them, and synthesises the
 *   final answer. This is the framework's killer feature.
 * - **Parallel-by-default** — Independent tasks (no shared dependency) run in
 *   parallel up to `maxConcurrency`.
 * - **Graceful failure** — A failed task marks itself `'failed'` and its direct
 *   dependents remain `'blocked'` indefinitely; all non-dependent tasks continue.
 * - **Progress callbacks** — Callers can pass `onProgress` in the config to receive
 *   structured {@link OrchestratorEvent}s without polling.
 */

import type {
  AgentConfig,
  AgentRunResult,
  CheckpointOptions,
  CheckpointSnapshot,
  ConsensusOptions,
  ConsensusResult,
  ConsensusVerifyOptions,
  CoordinatorConfig,
  CostEstimateContext,
  ModelRouteConfig,
  ModelRoutingPolicy,
  PlanArtifact,
  PlanTaskArtifact,
  OrchestratorConfig,
  OrchestratorEvent,
  RestoreOptions,
  RunAgentOptions,
  RunIdentity,
  RunIdentityOptions,
  RunStatus,
  StructuredTraceError,
  RunMetrics,
  RunTaskSpec,
  RunTasksOptions,
  RunTeamOptions,
  StreamEvent,
  Task,
  TaskExecutionMetrics,
  TaskExecutionRecord,
  TaskStatus,
  TeamConfig,
  TeamInfo,
  TeamRunResult,
  TokenUsage,
  TraceAttributeValue,
} from '../types.js'
import type { ZodSchema } from 'zod'
import type { RunOptions } from '../agent/runner.js'
import { Agent } from '../agent/agent.js'
import { AgentPool } from '../agent/pool.js'
import { emitTrace, generateRunId, generateSpanId } from '../utils/trace.js'
import { ToolRegistry } from '../tool/framework.js'
import { ToolExecutor } from '../tool/executor.js'
import { registerBuiltInTools } from '../tool/built-in/index.js'
import { defaultWorkspaceDir } from '../tool/built-in/path-safety.js'
import { Team } from '../team/team.js'
import { TaskQueue } from '../task/queue.js'
import { Checkpoint } from '../memory/checkpoint.js'
import { InMemoryStore } from '../memory/store.js'
import { createTask, validateTaskDependencies } from '../task/task.js'
import { extractJSON, validateOutput } from '../agent/structured-output.js'
import { Scheduler } from './scheduler.js'
import { CostBudgetExceededError, TokenBudgetExceededError, isRetryableError } from '../errors.js'
import { abortableDelay } from '../utils/abort.js'
import {
  createRestoreIdentity,
  createRunIdentity,
  resolveRestoreMetadata,
  validateRunMetadata,
  type RestoreMetadataResolution,
} from '../observability/identity.js'
import { classifyRunFailure, statusOnly } from '../observability/status.js'
import {
  createTraceRuntime,
  LEGACY_TRACE_METADATA_ONLY,
  traceRecordObserverFrom,
  type TraceRecordObserver,
  type TraceRuntime,
  type TraceSpan,
} from '../observability/runtime.js'
import { CompositeSink } from '../observability/composite.js'
import type { TraceSink } from '../observability/sink.js'
import { SensitiveDataProcessor } from '../observability/processors.js'
import { LegacyCallbackTraceSink } from '../observability/legacy-callback.js'
import { extractKeywords, keywordScore } from '../utils/keywords.js'

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const ZERO_USAGE: TokenUsage = { input_tokens: 0, output_tokens: 0 }
const DEFAULT_MAX_CONCURRENCY = 5
const DEFAULT_MAX_DELEGATION_DEPTH = 3
const DEFAULT_MODEL = 'claude-opus-4-6'

type RunMetadata = Readonly<Record<string, TraceAttributeValue>>

interface RunFacts {
  readonly identity: RunIdentity
  readonly metadata?: RunMetadata
}

function identityOptionsForRun(options?: RunTasksOptions): RunIdentityOptions {
  const checkpointRunId = options?.checkpoint && typeof options.checkpoint === 'object'
    ? options.checkpoint.runId
    : undefined
  if (
    options?.runId !== undefined
    && checkpointRunId !== undefined
    && options.runId !== checkpointRunId
  ) {
    throw new Error(
      `runId conflict: run options requested "${options.runId}" but checkpoint options requested "${checkpointRunId}".`,
    )
  }
  const runId = options?.runId ?? checkpointRunId
  return {
    ...(runId !== undefined ? { runId } : {}),
    ...(options?.metadata !== undefined ? { metadata: options.metadata } : {}),
  }
}

function createRunFacts(options: RunIdentityOptions = {}): RunFacts {
  const metadata = validateRunMetadata(options.metadata)
  return {
    identity: createRunIdentity(options),
    ...(metadata !== undefined ? { metadata } : {}),
  }
}

function metadataAttributes(
  metadata: RunMetadata | undefined,
  overridden = false,
): Readonly<Record<string, TraceAttributeValue>> {
  const attributes: Record<string, TraceAttributeValue> = {}
  for (const [key, value] of Object.entries(metadata ?? {})) {
    attributes[`oma.meta.${key}`] = value
  }
  if (overridden) attributes['oma.meta._overridden'] = true
  return attributes
}

// ---------------------------------------------------------------------------
// Short-circuit helpers (exported for testability)
// ---------------------------------------------------------------------------

/**
 * Regex patterns that indicate a goal requires multi-agent coordination.
 *
 * Each pattern targets a distinct complexity signal:
 * - Sequencing:     "first … then", "step 1 / step 2", numbered lists
 * - Coordination:   "collaborate", "coordinate", "review each other"
 * - Parallel work:  "in parallel", "at the same time", "concurrently"
 * - Multi-phase:    "phase", "stage", multiple distinct action verbs joined by connectives
 */
const COMPLEXITY_PATTERNS: RegExp[] = [
  // Explicit sequencing
  /\bfirst\b.{3,60}\bthen\b/i,
  /\bstep\s*\d/i,
  /\bphase\s*\d/i,
  /\bstage\s*\d/i,
  /^\s*\d+[\.\)]/m,                       // numbered list items ("1. …", "2) …")

  // Coordination language — must be an imperative directive aimed at the agents
  // ("collaborate with X", "coordinate the team", "agents should coordinate"),
  // not a descriptive use ("how does X coordinate with Y" / "what does collaboration mean").
  // Match either an explicit preposition or a noun-phrase that names a group.
  /\bcollaborat(?:e|ing)\b\s+(?:with|on|to)\b/i,
  /\bcoordinat(?:e|ing)\b\s+(?:with|on|across|between|the\s+(?:team|agents?|workers?|effort|work))\b/i,
  /\breview\s+each\s+other/i,
  /\bwork\s+together\b/i,

  // Parallel execution
  /\bin\s+parallel\b/i,
  /\bconcurrently\b/i,
  /\bat\s+the\s+same\s+time\b/i,

  // Multiple deliverables joined by connectives
  // Matches patterns like "build X, then deploy Y and test Z"
  /\b(?:build|create|implement|design|write|develop)\b.{5,80}\b(?:and|then)\b.{5,80}\b(?:build|create|implement|design|write|develop|test|review|deploy)\b/i,
]


/**
 * Maximum goal length (in characters) below which a goal *may* be simple.
 *
 * Goals longer than this threshold almost always contain enough detail to
 * warrant multi-agent decomposition. The value is generous — short-circuit
 * is meant for genuinely simple, single-action goals.
 */
const SIMPLE_GOAL_MAX_LENGTH = 200

/**
 * Determine whether a goal is simple enough to skip coordinator decomposition.
 *
 * A goal is considered "simple" when ALL of the following hold:
 *   1. Its length is ≤ {@link SIMPLE_GOAL_MAX_LENGTH}.
 *   2. It does not match any {@link COMPLEXITY_PATTERNS}.
 *
 * The complexity patterns are deliberately conservative — they only fire on
 * imperative coordination directives (e.g. "collaborate with the team",
 * "coordinate the workers"), so descriptive uses ("how do pods coordinate
 * state", "explain microservice collaboration") remain classified as simple.
 *
 * Exported for unit testing.
 */
export function isSimpleGoal(goal: string): boolean {
  if (goal.length > SIMPLE_GOAL_MAX_LENGTH) return false
  return !COMPLEXITY_PATTERNS.some((re) => re.test(goal))
}

/**
 * Select the best-matching agent for a goal using keyword affinity scoring.
 *
 * The scoring logic mirrors {@link Scheduler}'s `capability-match` strategy
 * exactly, including its asymmetric use of the agent's `model` field:
 *
 *  - `agentKeywords` is computed from `name + systemPrompt + model` so that
 *    a goal which mentions a model name (e.g. "haiku") can boost an agent
 *    bound to that model.
 *  - `agentText` (used for the reverse direction) is computed from
 *    `name + systemPrompt` only — model names should not bias the
 *    text-vs-goal-keywords match.
 *
 * The two-direction sum (`scoreA + scoreB`) ensures both "agent describes
 * goal" and "goal mentions agent capability" contribute to the final score.
 *
 * Exported for unit testing.
 */
export function selectBestAgent(goal: string, agents: AgentConfig[]): AgentConfig {
  if (agents.length <= 1) return agents[0]!

  const goalKeywords = extractKeywords(goal)

  let bestAgent = agents[0]!
  let bestScore = -1

  for (const agent of agents) {
    const agentText = `${agent.name} ${agent.systemPrompt ?? ''}`
    // Mirror Scheduler.capability-match: include `model` here only.
    const agentKeywords = extractKeywords(`${agent.name} ${agent.systemPrompt ?? ''} ${agent.model}`)

    const scoreA = keywordScore(agentText, goalKeywords)
    const scoreB = keywordScore(goal, agentKeywords)
    const score = scoreA + scoreB

    if (score > bestScore) {
      bestScore = score
      bestAgent = agent
    }
  }

  return bestAgent
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
  }
}

function computeRunMetrics(
  tasks?: readonly TaskExecutionRecord[],
): RunMetrics | undefined {
  if (!tasks || tasks.length === 0) return undefined

  let inputTokens = 0
  let outputTokens = 0
  let totalRetries = 0
  let errorCount = 0
  let failureCount = 0
  let completedCount = 0
  let minTaskDurationMs: number | undefined
  let maxTaskDurationMs: number | undefined
  let totalDurationMs = 0

  for (const task of tasks) {
    if (task.status === 'failed') {
      failureCount++
    }
    if (task.status === 'failed' || task.status === 'skipped' || task.status === 'blocked') {
      errorCount++
    }
    if (task.status === 'completed') {
      completedCount++
    }

    const metrics = task.metrics
    if (metrics) {
      inputTokens += metrics.tokenUsage.input_tokens
      outputTokens += metrics.tokenUsage.output_tokens
      totalRetries += metrics.retries
    }

    if (task.status === 'completed' && metrics) {
      totalDurationMs += metrics.durationMs
      if (minTaskDurationMs === undefined || metrics.durationMs < minTaskDurationMs) {
        minTaskDurationMs = metrics.durationMs
      }
      if (maxTaskDurationMs === undefined || metrics.durationMs > maxTaskDurationMs) {
        maxTaskDurationMs = metrics.durationMs
      }
    }
  }

  return {
    totalTokens: { input_tokens: inputTokens, output_tokens: outputTokens },
    totalRetries,
    errorCount,
    failureCount,
    completedCount,
    minTaskDurationMs,
    maxTaskDurationMs,
    avgTaskDurationMs: completedCount > 0 ? Math.round(totalDurationMs / completedCount) : undefined,
    totalDurationMs,
  }
}

function resolveTokenBudget(primary?: number, fallback?: number): number | undefined {
  if (primary === undefined) return fallback
  if (fallback === undefined) return primary
  return Math.min(primary, fallback)
}

type BudgetExceededError = TokenBudgetExceededError | CostBudgetExceededError

function totalTokens(usage: TokenUsage): number {
  return usage.input_tokens + usage.output_tokens
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function buildCostEstimateContext(params: {
  readonly agentName: string
  readonly model: string
  readonly provider?: AgentConfig['provider']
  readonly phase: CostEstimateContext['phase']
  readonly taskId?: string
}): CostEstimateContext {
  return {
    agentName: params.agentName,
    model: params.model,
    phase: params.phase,
    ...(params.provider !== undefined ? { provider: params.provider } : {}),
    ...(params.taskId !== undefined ? { taskId: params.taskId } : {}),
  }
}

function estimateIncrementalCost(
  usage: TokenUsage,
  context: CostEstimateContext,
  estimateCost: NonNullable<OrchestratorConfig['estimateCost']>,
): number {
  const cost = estimateCost(usage, context)
  if (!Number.isFinite(cost) || cost < 0) {
    throw new Error(
      `Cost estimator returned invalid cost for agent "${context.agentName}": ${String(cost)}`,
    )
  }
  return cost
}

function applyBudgetAccounting(params: {
  readonly currentUsage: TokenUsage
  readonly currentCost: number
  readonly usage: TokenUsage
  readonly maxTokenBudget?: number
  readonly maxCostBudget?: number
  readonly estimateCost?: OrchestratorConfig['estimateCost']
  readonly costContext: CostEstimateContext
}): {
  readonly cumulativeUsage: TokenUsage
  readonly cumulativeCost: number
  readonly exceeded?: BudgetExceededError
} {
  const cumulativeUsage = addUsage(params.currentUsage, params.usage)
  const cumulativeCost = params.estimateCost
    ? params.currentCost + estimateIncrementalCost(params.usage, params.costContext, params.estimateCost)
    : params.currentCost

  if (
    params.maxTokenBudget !== undefined
    && totalTokens(cumulativeUsage) > params.maxTokenBudget
  ) {
    return {
      cumulativeUsage,
      cumulativeCost,
      exceeded: new TokenBudgetExceededError(
        params.costContext.agentName,
        totalTokens(cumulativeUsage),
        params.maxTokenBudget,
      ),
    }
  }

  if (
    params.maxCostBudget !== undefined
    && params.estimateCost !== undefined
    && cumulativeCost > params.maxCostBudget
  ) {
    return {
      cumulativeUsage,
      cumulativeCost,
      exceeded: new CostBudgetExceededError(
        params.costContext.agentName,
        cumulativeCost,
        params.maxCostBudget,
      ),
    }
  }

  return { cumulativeUsage, cumulativeCost }
}

function emitBudgetExceeded(
  config: OrchestratorConfig,
  error: BudgetExceededError,
  agent: string,
  task?: string,
): void {
  config.onProgress?.({
    type: 'budget_exceeded',
    agent,
    ...(task !== undefined ? { task } : {}),
    data: error,
  } satisfies OrchestratorEvent)
}

function recordRunUsage(
  ctx: RunContext,
  usage: TokenUsage,
  costContext: CostEstimateContext,
  agent: string = costContext.agentName,
  task?: string,
): BudgetExceededError | undefined {
  const accounting = applyBudgetAccounting({
    currentUsage: ctx.cumulativeUsage,
    currentCost: ctx.cumulativeCost,
    usage,
    maxTokenBudget: ctx.maxTokenBudget,
    maxCostBudget: ctx.maxCostBudget,
    estimateCost: ctx.estimateCost,
    costContext,
  })
  ctx.cumulativeUsage = accounting.cumulativeUsage
  ctx.cumulativeCost = accounting.cumulativeCost

  if (!ctx.budgetExceededTriggered && accounting.exceeded) {
    ctx.budgetExceededTriggered = true
    ctx.budgetExceededReason = accounting.exceeded.message
    const classified = classifyRunFailure(accounting.exceeded)
    ctx.outcomeStatus = classified.status
    ctx.outcomeErrorInfo = classified.errorInfo
    emitBudgetExceeded(ctx.config, accounting.exceeded, agent, task)
    return accounting.exceeded
  }

  return undefined
}

/**
 * Build a minimal {@link Agent} with its own fresh registry/executor.
 * Pool workers pass `includeDelegateTool` so `delegate_to_agent` is available during `runTeam` / `runTasks`.
 */
function buildAgent(
  config: AgentConfig,
  toolRegistration?: { readonly includeDelegateTool?: boolean },
): Agent {
  const registry = new ToolRegistry()
  registerBuiltInTools(registry, toolRegistration)
  if (config.customTools) {
    for (const tool of config.customTools) {
      registry.register(tool, { runtimeAdded: true })
    }
  }
  const executor = new ToolExecutor(registry, {
    ...(config.maxToolOutputChars !== undefined
      ? { maxToolOutputChars: config.maxToolOutputChars }
      : {}),
  })
  return new Agent(config, registry, executor)
}

/**
 * Apply the orchestrator's {@link OrchestratorConfig.defaultToolPreset} as a
 * fallback grant for an agent that declares neither `tools` nor `toolPreset`.
 *
 * Built-in tools are opt-in (default-deny): an agent with no grant resolves to
 * zero built-in tools. This fills that gap when the orchestrator opts in to a
 * default. Per-agent grants always win — the default never widens an agent that
 * already declares `tools` or `toolPreset`.
 */
function applyDefaultToolPreset(
  config: AgentConfig,
  defaultToolPreset: OrchestratorConfig['defaultToolPreset'],
): AgentConfig {
  if (
    defaultToolPreset === undefined
    || config.tools !== undefined
    || config.toolPreset !== undefined
  ) {
    return config
  }
  return { ...config, toolPreset: defaultToolPreset }
}

/** Maximum delay cap to prevent runaway exponential backoff (30 seconds). */
const MAX_RETRY_DELAY_MS = 30_000

/**
 * Compute the retry delay for a given attempt, capped at {@link MAX_RETRY_DELAY_MS}.
 */
export function computeRetryDelay(
  baseDelay: number,
  backoff: number,
  attempt: number,
): number {
  return Math.min(baseDelay * backoff ** (attempt - 1), MAX_RETRY_DELAY_MS)
}

/**
 * Execute an agent task with optional retry and exponential backoff.
 *
 * Exported for testability — called internally by {@link executeQueue}.
 *
 * Retry is off by default (`maxRetries: 0`). When enabled it is error-aware:
 * provably-terminal failures (auth/validation errors, aborted calls, 4xx client
 * errors other than 408/409/429) skip retries instead of wasting attempts;
 * backoff is jittered to avoid lockstep re-collision against a rate-limited
 * provider; and `abortSignal` is honored between attempts so a cancelled run
 * neither sleeps a full backoff nor fires one more attempt.
 *
 * @param run      - The function that executes the task (typically `pool.run`).
 * @param task     - The task to execute (retry config read from its fields).
 * @param onRetry  - Called before each retry sleep with the (post-jitter) delay.
 * @param delayFn  - Injectable delay function (defaults to `abortableDelay`).
 * @param opts     - Optional `abortSignal` (checked between attempts) and `rng`
 *                   (injectable `Math.random` for deterministic jitter in tests).
 * @returns The final {@link AgentRunResult} from the last attempt.
 */
export async function executeWithRetry(
  run: (attempt: number) => Promise<AgentRunResult>,
  task: Task,
  onRetry?: (data: { attempt: number; maxAttempts: number; error: string; nextDelayMs: number }) => void,
  delayFn: (ms: number, signal?: AbortSignal) => Promise<void> = abortableDelay,
  opts?: { abortSignal?: AbortSignal; rng?: () => number },
): Promise<AgentRunResult> {
  const abortSignal = opts?.abortSignal
  const rng = opts?.rng ?? Math.random
  const rawRetries = Number.isFinite(task.maxRetries) ? task.maxRetries! : 0
  const maxAttempts = Math.max(0, rawRetries) + 1
  const baseDelay = Math.max(0, Number.isFinite(task.retryDelayMs) ? task.retryDelayMs! : 1000)
  const backoff = Math.max(1, Number.isFinite(task.retryBackoff) ? task.retryBackoff! : 2)

  let lastError: string = ''
  // Accumulate token usage across all attempts so billing/observability
  // reflects the true cost of retries.
  let totalUsage: TokenUsage = { input_tokens: 0, output_tokens: 0 }

  const failure = (output: string): AgentRunResult => ({
    success: false,
    output,
    messages: [],
    tokenUsage: totalUsage,
    toolCalls: [],
  })

  // Compute the jittered backoff, report it, and sleep. Equal jitter over
  // [nominal/2, nominal] decorrelates tasks retrying in lockstep while keeping a
  // floor so a rate-limited provider isn't hammered instantly. Applied to the
  // already-capped nominal, so the sleep never exceeds MAX_RETRY_DELAY_MS.
  const backoffSleep = async (attempt: number): Promise<void> => {
    const nominal = computeRetryDelay(baseDelay, backoff, attempt)
    const jittered = Math.round(nominal / 2 + rng() * (nominal / 2))
    onRetry?.({ attempt, maxAttempts, error: lastError, nextDelayMs: jittered })
    await delayFn(jittered, abortSignal)
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Honor abort before every attempt — this turns an abort that landed during
    // a prior backoff sleep into an early return instead of one more attempt.
    if (abortSignal?.aborted) {
      return failure(lastError || 'Run aborted')
    }

    try {
      const result = await run(attempt)
      totalUsage = {
        input_tokens: totalUsage.input_tokens + result.tokenUsage.input_tokens,
        output_tokens: totalUsage.output_tokens + result.tokenUsage.output_tokens,
      }

      if (result.success) {
        return { ...result, tokenUsage: totalUsage }
      }
      lastError = result.output

      // Non-streaming path carries the structured error on the result; a
      // provably-terminal one (e.g. a 401) is not worth retrying.
      const terminal = result.error !== undefined && !isRetryableError(result.error)
      if (!terminal && attempt < maxAttempts && !abortSignal?.aborted) {
        await backoffSleep(attempt)
        continue
      }

      return { ...result, tokenUsage: totalUsage }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)

      // Streaming path: the structured error is in scope here. Skip retries on
      // terminal errors (auth/validation/abort) so they don't waste attempts.
      const terminal = !isRetryableError(err)
      if (!terminal && attempt < maxAttempts && !abortSignal?.aborted) {
        await backoffSleep(attempt)
        continue
      }

      // Terminal, aborted, or retries exhausted — return a failure result.
      return failure(lastError)
    }
  }

  // Should not be reached, but TypeScript needs a return.
  return failure(lastError)
}

// ---------------------------------------------------------------------------
// Parsed task spec (result of coordinator decomposition)
// ---------------------------------------------------------------------------

/**
 * Partial verify config that the coordinator can emit in task JSON.
 * Contains only fields that are safe to include in LLM output — `judges`
 * (full AgentConfig objects) are always supplied by the caller via
 * {@link RunTeamOptions.verifyJudges} and are never in coordinator JSON.
 */
interface CoordinatorVerifySpec {
  readonly mode?: 'refute' | 'lens'
  readonly quorum?: number
  readonly maxRounds?: number
  readonly onDissent?: 'revise' | 'reject' | 'keep'
}

interface ParsedTaskSpec {
  title: string
  description: string
  assignee?: string
  dependsOn?: string[]
  memoryScope?: 'dependencies' | 'all'
  maxRetries?: number
  retryDelayMs?: number
  retryBackoff?: number
  role?: string
  priority?: 'low' | 'normal' | 'high' | 'critical'
  /**
   * Full verify options (used by explicit `runTasks` specs that already
   * include judges) OR a coordinator-emitted partial spec / boolean `true`
   * (resolved into full options by `loadSpecsIntoQueue` when
   * `verifyJudges` is available).
   */
  verify?: ConsensusVerifyOptions | CoordinatorVerifySpec | true
}

/**
 * Resolve a parsed task spec's `verify` field into a full
 * {@link ConsensusVerifyOptions} (or `undefined` when no verify should run).
 *
 * - Full `ConsensusVerifyOptions` (already has `judges`): used as-is.
 * - `true` or `CoordinatorVerifySpec` (no `judges`): merged with
 *   `verifyJudges` when provided; ignored when `verifyJudges` is absent.
 * - `undefined`: no verify.
 */
function resolveVerify(
  spec: ConsensusVerifyOptions | CoordinatorVerifySpec | true | undefined,
  verifyJudges?: readonly AgentConfig[],
): ConsensusVerifyOptions | undefined {
  if (spec === undefined) return undefined
  if (spec !== true && 'judges' in spec) return spec as ConsensusVerifyOptions
  if (!verifyJudges || verifyJudges.length === 0) return undefined
  const partial: CoordinatorVerifySpec = spec === true ? {} : spec
  return {
    judges: verifyJudges,
    ...(partial.mode !== undefined ? { mode: partial.mode } : {}),
    ...(partial.quorum !== undefined ? { quorum: partial.quorum } : {}),
    ...(partial.maxRounds !== undefined ? { maxRounds: partial.maxRounds } : {}),
    ...(partial.onDissent !== undefined ? { onDissent: partial.onDissent } : {}),
  }
}

/**
 * Parse the coordinator-emitted `verify` field on a task JSON object.
 * Accepts `true` (use all defaults) or a partial object with `mode`,
 * `quorum`, `maxRounds`, and/or `onDissent`. Returns `undefined` for any
 * other value so missing / null / unrecognised values are ignored safely.
 */
function parseCoordinatorVerify(raw: unknown): CoordinatorVerifySpec | true | undefined {
  if (raw === true) return true
  if (typeof raw !== 'object' || raw === null) return undefined
  const obj = raw as Record<string, unknown>
  const mode = obj['mode'] === 'refute' || obj['mode'] === 'lens' ? obj['mode'] : undefined
  const quorum = typeof obj['quorum'] === 'number' && obj['quorum'] >= 1 ? Math.floor(obj['quorum']) : undefined
  const maxRounds = typeof obj['maxRounds'] === 'number' && obj['maxRounds'] >= 1 ? Math.floor(obj['maxRounds']) : undefined
  const onDissent = obj['onDissent'] === 'revise' || obj['onDissent'] === 'reject' || obj['onDissent'] === 'keep'
    ? obj['onDissent']
    : undefined
  if (mode === undefined && quorum === undefined && maxRounds === undefined && onDissent === undefined) return true
  return { mode, quorum, maxRounds, onDissent }
}

/**
 * Attempt to extract a JSON array of task specs from the coordinator's raw
 * output. The coordinator is prompted to emit JSON inside a ```json … ``` fence
 * or as a bare array. Returns `null` when no valid array can be extracted.
 */
function parseTaskSpecs(raw: string): ParsedTaskSpec[] | null {
  // Strategy 1: look for a fenced JSON block
  const fenceMatch = raw.match(/```json\s*([\s\S]*?)```/)
  const candidate = fenceMatch ? fenceMatch[1]! : raw

  // Strategy 2: find the first '[' and last ']'
  const arrayStart = candidate.indexOf('[')
  const arrayEnd = candidate.lastIndexOf(']')
  if (arrayStart === -1 || arrayEnd === -1 || arrayEnd <= arrayStart) {
    return null
  }

  const jsonSlice = candidate.slice(arrayStart, arrayEnd + 1)
  try {
    const parsed: unknown = JSON.parse(jsonSlice)
    if (!Array.isArray(parsed)) return null

    const specs: ParsedTaskSpec[] = []
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue
      const obj = item as Record<string, unknown>
      if (typeof obj['title'] !== 'string') continue
      if (typeof obj['description'] !== 'string') continue

      specs.push({
        title: obj['title'],
        description: obj['description'],
        assignee: typeof obj['assignee'] === 'string' ? obj['assignee'] : undefined,
        dependsOn: Array.isArray(obj['dependsOn'])
          ? (obj['dependsOn'] as unknown[]).filter((x): x is string => typeof x === 'string')
          : undefined,
        memoryScope: obj['memoryScope'] === 'all' ? 'all' : undefined,
        maxRetries: typeof obj['maxRetries'] === 'number' ? obj['maxRetries'] : undefined,
        retryDelayMs: typeof obj['retryDelayMs'] === 'number' ? obj['retryDelayMs'] : undefined,
        retryBackoff: typeof obj['retryBackoff'] === 'number' ? obj['retryBackoff'] : undefined,
        role: typeof obj['role'] === 'string' ? obj['role'] : undefined,
        priority: obj['priority'] === 'low' || obj['priority'] === 'normal' || obj['priority'] === 'high' || obj['priority'] === 'critical'
          ? obj['priority']
          : undefined,
        verify: parseCoordinatorVerify(obj['verify']),
      })
    }

    return specs.length > 0 ? specs : null
  } catch {
    return null
  }
}

interface ModelRoutingSelection {
  readonly phase: 'coordinator' | 'synthesis' | 'short-circuit' | 'worker' | 'delegated'
  readonly agent: string
  readonly task?: Task
  readonly leaf?: boolean
}

function routeMatches(
  policy: ModelRoutingPolicy | undefined,
  selection: ModelRoutingSelection,
): ModelRouteConfig | undefined {
  if (!policy) return undefined
  const task = selection.task
  for (const rule of policy.rules) {
    const match = rule.match
    if (match.phase !== undefined && match.phase !== selection.phase) continue
    if (match.agent !== undefined && match.agent !== selection.agent) continue
    if (match.taskRole !== undefined && match.taskRole !== task?.role) continue
    if (match.taskPriority !== undefined && match.taskPriority !== task?.priority) continue
    if (match.leaf !== undefined && match.leaf !== selection.leaf) continue
    if (match.hasDependencies !== undefined && match.hasDependencies !== ((task?.dependsOn?.length ?? 0) > 0)) continue
    return rule.route
  }
  return undefined
}

function withModelRoute(config: AgentConfig, route: ModelRouteConfig | undefined): AgentConfig {
  if (!route) return config
  return {
    ...config,
    model: route.model,
    provider: route.provider ?? config.provider,
    baseURL: route.baseURL ?? config.baseURL,
    apiKey: route.apiKey ?? config.apiKey,
    region: route.region ?? config.region,
  }
}

function isLeafTask(task: Task, tasks: readonly Task[]): boolean {
  for (const candidate of tasks) {
    if (candidate.dependsOn?.includes(task.id)) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Orchestration loop
// ---------------------------------------------------------------------------

/**
 * Team-level context optionally injected into every worker prompt when
 * `RunTeamOptions.revealCoordinator` is true.
 */
interface RevealCoordinatorContext {
  readonly goal: string
  readonly rosterNames: readonly string[]
}

function buildRevealCoordinatorLines(
  revealContext: RevealCoordinatorContext,
  assignee: string,
): string[] {
  return [
    '## Team context',
    `Goal: ${revealContext.goal}`,
    `Team: ${revealContext.rosterNames.join(', ')}`,
    `Your role in this team: ${assignee}`,
    'Assignment: You are responsible for the prompt below in this team run.',
    '',
  ]
}

function prependRevealCoordinatorContext(
  prompt: string,
  revealContext: RevealCoordinatorContext | undefined,
  assignee: string,
): string {
  return revealContext
    ? [...buildRevealCoordinatorLines(revealContext, assignee), prompt].join('\n')
    : prompt
}

/**
 * Internal execution context assembled once per `runTeam` / `runTasks` call.
 */
interface RunContext {
  readonly team: Team
  readonly pool: AgentPool
  readonly scheduler: Scheduler
  readonly agentResults: Map<string, AgentRunResult>
  readonly config: OrchestratorConfig
  readonly checkpoint?: ActiveCheckpoint
  /** Stable top-level execution identity, independent of trace callbacks. */
  readonly identity: RunIdentity
  /** Validated facts echoed on the result and persisted with checkpoints. */
  readonly metadata?: RunMetadata
  /** Legacy trace correlation alias. */
  readonly runId: string
  readonly traceRuntime?: TraceRuntime
  readonly taskSpans: Map<string, TraceSpan>
  /** AbortSignal for run-level cancellation. Checked between task dispatch rounds. */
  readonly abortSignal?: AbortSignal
  cumulativeUsage: TokenUsage
  cumulativeCost: number
  readonly maxTokenBudget?: number
  readonly maxCostBudget?: number
  readonly estimateCost?: OrchestratorConfig['estimateCost']
  budgetExceededTriggered: boolean
  budgetExceededReason?: string
  outcomeStatus?: RunStatus
  outcomeErrorInfo?: StructuredTraceError
  readonly taskMetrics: Map<string, TaskExecutionMetrics>
  /**
   * Present only when `runTeam` is called with `{ revealCoordinator: true }`.
   * `runTasks` omits this entirely (no goal concept).
   */
  readonly revealCoordinatorContext?: RevealCoordinatorContext
  readonly modelRouting?: ModelRoutingPolicy
  readonly taskById: ReadonlyMap<string, Task>
  readonly taskLeafById: ReadonlyMap<string, boolean>
}

interface ActiveCheckpoint {
  readonly manager: Checkpoint
  readonly mode: CheckpointSnapshot['mode']
  readonly goal?: string
  readonly runId?: string
  /**
   * True when the checkpoint store is the same object as the team's
   * shared-memory store. In that case the memory entries are already durable
   * in the store, so the checkpoint omits the full shared-memory snapshot
   * (avoids ~O(N^2) write volume) and persists only the turn counter.
   */
  readonly reusesSharedMemoryStore: boolean
  saveChain: Promise<void>
}

/**
 * Build {@link TeamInfo} for tool context, including nested `runDelegatedAgent`
 * that respects pool capacity to avoid semaphore deadlocks.
 *
 * Delegation always builds a **fresh** Agent instance for the target and runs
 * it via `pool.runEphemeral` — the pool semaphore still gates total concurrency,
 * but the per-agent lock is bypassed. This matches `delegate_to_agent`'s "runs
 * in a fresh conversation for this prompt only" contract and prevents mutual
 * delegation (A→B while B→A) from deadlocking on each other's agent locks.
 */
function buildTaskAgentTeamInfo(
  ctx: RunContext,
  taskId: string,
  traceBase: Partial<RunOptions>,
  delegationDepth: number,
  delegationChain: readonly string[],
): TeamInfo {
  const sharedMem = ctx.team.getSharedMemoryInstance()
  const maxDepth = ctx.config.maxDelegationDepth
  const agentConfigs = ctx.team.getAgents()
  const agentNames = agentConfigs.map((a) => a.name)

  const runDelegatedAgent = async (
    targetAgent: string,
    prompt: string,
    delegatedParent?: unknown,
  ): Promise<AgentRunResult> => {
    const pool = ctx.pool
    if (pool.availableRunSlots < 1) {
      return {
        success: false,
        output:
          'Agent pool has no free concurrency slot for a delegated run (would deadlock). ' +
          'Increase maxConcurrency or reduce parallel delegation.',
        messages: [],
        tokenUsage: ZERO_USAGE,
        toolCalls: [],
      }
    }

    const targetConfig = agentConfigs.find((a) => a.name === targetAgent)
    if (!targetConfig) {
      return {
        success: false,
        output: `Unknown agent "${targetAgent}" — not in team roster [${agentNames.join(', ')}].`,
        messages: [],
        tokenUsage: ZERO_USAGE,
        toolCalls: [],
      }
    }

    // Apply orchestrator-level defaults just like buildPool, then construct a
    // one-shot Agent for this delegation only.
    const route = routeMatches(ctx.modelRouting, {
      phase: 'delegated',
      agent: targetAgent,
      task: ctx.taskById.get(taskId),
      leaf: ctx.taskLeafById.get(taskId),
    })
    const effective: AgentConfig = withModelRoute(applyDefaultToolPreset({
      ...targetConfig,
      model: targetConfig.model ?? ctx.config.defaultModel,
      provider: targetConfig.provider ?? ctx.config.defaultProvider,
      baseURL: targetConfig.baseURL ?? ctx.config.defaultBaseURL,
      apiKey: targetConfig.apiKey ?? ctx.config.defaultApiKey,
      cwd: targetConfig.cwd === undefined ? ctx.config.defaultCwd : targetConfig.cwd,
      onToolCall: targetConfig.onToolCall ?? ctx.config.onToolCall,
    }, ctx.config.defaultToolPreset), route)
    const tempAgent = buildAgent(effective, { includeDelegateTool: true })

    const delegatedParentId = traceBase.traceSpanId ?? traceBase.traceParentId
    const delegatedSpanId = traceBase.onTrace ? generateSpanId() : undefined
    const childTraceBase: Partial<RunOptions> = {
      ...traceBase,
      traceAgent: targetAgent,
      taskId,
      ...(ctx.traceRuntime && delegatedParent ? {
        traceRuntime: ctx.traceRuntime,
        traceSpan: delegatedParent as TraceSpan,
        tracePhase: 'delegated',
        traceLinks: ctx.taskSpans.get(taskId) ? [{
          traceId: ctx.identity.traceId,
          spanId: ctx.taskSpans.get(taskId)!.spanId,
          relation: 'delegated_from' as const,
        }] : [],
      } : {}),
      ...(delegatedParentId ? { traceParentId: delegatedParentId } : {}),
      ...(delegatedSpanId ? { traceSpanId: delegatedSpanId } : {}),
    }
    const nestedTeam = buildTaskAgentTeamInfo(
      ctx,
      taskId,
      childTraceBase,
      delegationDepth + 1,
      [...delegationChain, targetAgent],
    )
    const childOpts: Partial<RunOptions> = {
      ...childTraceBase,
      team: nestedTeam,
    }
    return pool.runEphemeral(
      tempAgent,
      prependRevealCoordinatorContext(prompt, ctx.revealCoordinatorContext, targetAgent),
      childOpts,
    )
  }

  return {
    name: ctx.team.name,
    agents: agentNames,
    ...(sharedMem ? { sharedMemory: sharedMem.getStore() } : {}),
    delegationDepth,
    maxDelegationDepth: maxDepth,
    delegationPool: ctx.pool,
    delegationChain,
    runDelegatedAgent,
  }
}

async function saveRunCheckpoint(queue: TaskQueue, ctx: RunContext): Promise<void> {
  const active = ctx.checkpoint
  if (!active) return
  const checkpointSpan = ctx.traceRuntime?.startSpan({
    kind: 'checkpoint',
    name: 'save_checkpoint',
    parent: ctx.traceRuntime.root,
    attributes: { 'oma.checkpoint.mode': active.mode },
  })

  // Best-effort: a checkpoint write must never take down the run it protects.
  // Both snapshot construction and the store write are guarded, so a failing
  // store (e.g. a transient Redis/SQLite error) is surfaced via `onProgress`
  // and the run continues — the next completed task retries the write.
  const save = async (): Promise<void> => {
    const sharedMem = ctx.team.getSharedMemoryInstance()
    const completedTaskResults = queue.getByStatus('completed').map((task) => ({
      taskId: task.id,
      ...(task.assignee !== undefined ? { assignee: task.assignee } : {}),
      ...(task.result !== undefined ? { result: task.result } : {}),
    }))

    const snapshot: CheckpointSnapshot = {
      version: 2,
      mode: active.mode,
      createdAt: new Date().toISOString(),
      ...(ctx.metadata !== undefined ? { metadata: ctx.metadata } : {}),
      identity: {
        runId: ctx.identity.runId,
        attempt: ctx.identity.attempt,
        lastTraceId: ctx.identity.traceId,
        lastRootSpanId: ctx.identity.rootSpanId,
      },
      ...(active.goal !== undefined ? { goal: active.goal } : {}),
      queue: queue.snapshot(),
      // When the checkpoint store IS the shared-memory store, the entries are
      // already durable there — embedding a full snapshot on every task would
      // be ~O(N^2) write volume. Persist only the turn counter (cheap) so TTL
      // expiry stays correct; restore reads the entries straight from the store.
      ...(sharedMem && !active.reusesSharedMemoryStore
        ? { sharedMemory: await sharedMem.snapshot() }
        : {}),
      messageBus: ctx.team.snapshotMessageBus(),
      ...(sharedMem ? { turnCount: sharedMem.getTurnCount() } : {}),
      completedTaskResults,
    }

    await active.manager.save(snapshot)
  }

  const nextSave = active.saveChain.catch(() => undefined).then(save)
  // Keep the stored chain non-rejecting so a failed save never leaves an
  // unhandled rejection or blocks the next checkpoint in the chain.
  active.saveChain = nextSave.catch(() => undefined)
  try {
    await nextSave
    checkpointSpan?.end({ status: statusOnly('ok') })
  } catch (error) {
    const classified = classifyRunFailure(error, { kind: 'store' })
    checkpointSpan?.event('checkpoint_failed', {})
    checkpointSpan?.end({ status: classified.status, error: classified.errorInfo })
    ctx.config.onProgress?.({
      type: 'error',
      data: { kind: 'checkpoint_save_failed', error },
    } satisfies OrchestratorEvent)
  }
}

/**
 * Execute all tasks in `queue` using agents in `pool`, respecting dependencies
 * and running independent tasks in parallel.
 *
 * The orchestration loop works in rounds:
 *  1. Find all `'pending'` tasks (dependencies satisfied).
 *  2. Dispatch them in parallel via the pool.
 *  3. On completion, the queue automatically unblocks dependents.
 *  4. Repeat until no more pending tasks exist or all remaining tasks are
 *     `'failed'`/`'blocked'` (stuck).
 */
async function executeQueue(
  queue: TaskQueue,
  ctx: RunContext,
): Promise<void> {
  const { team, pool, scheduler, config } = ctx

  // Relay queue-level skip events to the orchestrator's onProgress callback.
  const unsubSkipped = config.onProgress
    ? queue.on('task:skipped', (task) => {
        config.onProgress!({
          type: 'task_skipped',
          task: task.id,
          data: task,
        } satisfies OrchestratorEvent)
      })
    : undefined

  while (true) {
    // Check for cancellation before each dispatch round.
    if (ctx.abortSignal?.aborted) {
      queue.skipRemaining('Skipped: run aborted.')
      const abortError = new Error('Run cancelled by caller.')
      abortError.name = 'AbortError'
      const classified = classifyRunFailure(abortError)
      ctx.outcomeStatus = classified.status
      ctx.outcomeErrorInfo = classified.errorInfo
      break
    }

    // Re-run auto-assignment each iteration so tasks that were unblocked since
    // the last round (and thus have no assignee yet) get assigned before dispatch.
    scheduler.autoAssign(queue, team.getAgents())

    const pending = queue.getByStatus('pending')
    if (pending.length === 0) {
      // Either all done, or everything remaining is blocked/failed.
      break
    }

    // Track tasks that complete successfully in this round for the approval gate.
    // Safe to push from concurrent promises: JS is single-threaded, so
    // Array.push calls from resolved microtasks never interleave.
    const completedThisRound: Task[] = []

    // Dispatch all currently-pending tasks as a parallel batch.
    const dispatchPromises = pending.map(async (task): Promise<void> => {
      // Mark in-progress
      queue.update(task.id, { status: 'in_progress' as TaskStatus })

      const dependencyLinks = (task.dependsOn ?? []).flatMap((dependencyId) => {
        const dependencySpan = ctx.taskSpans.get(dependencyId)
        return dependencySpan ? [{
          traceId: ctx.identity.traceId,
          spanId: dependencySpan.spanId,
          relation: 'depends_on' as const,
        }] : []
      })
      const taskSpan = ctx.traceRuntime?.startSpan({
        kind: 'task',
        name: 'execute_task',
        parent: ctx.traceRuntime.root,
        links: dependencyLinks,
        attributes: {
          'oma.task.id': task.id,
          'oma.task.title': task.title,
          ...(task.assignee ? { 'oma.agent.name': task.assignee } : {}),
        },
      })
      if (taskSpan) ctx.taskSpans.set(task.id, taskSpan)

      try {
        const assignee = task.assignee
        if (!assignee) {
          // No assignee — mark failed and continue
          const msg = `Task "${task.title}" has no assignee.`
          queue.fail(task.id, msg)
          const classified = classifyRunFailure(new Error(msg), { kind: 'framework' })
          taskSpan?.end({ status: classified.status, error: classified.errorInfo })
          config.onProgress?.({
            type: 'error',
            task: task.id,
            data: msg,
          } satisfies OrchestratorEvent)
          return
        }

        const agentConfig = team.getAgent(assignee)
        if (!agentConfig) {
          const msg = `Agent "${assignee}" not found in team for task "${task.title}".`
          queue.fail(task.id, msg)
          const classified = classifyRunFailure(new Error(msg), { kind: 'framework' })
          taskSpan?.end({ status: classified.status, error: classified.errorInfo })
          config.onProgress?.({
            type: 'error',
            task: task.id,
            agent: assignee,
            data: msg,
          } satisfies OrchestratorEvent)
          return
        }

        const agent = pool.get(assignee)
        if (!agent) {
          const msg = `Agent "${assignee}" not found in pool for task "${task.title}".`
          queue.fail(task.id, msg)
          const classified = classifyRunFailure(new Error(msg), { kind: 'framework' })
          taskSpan?.end({ status: classified.status, error: classified.errorInfo })
          config.onProgress?.({
            type: 'error',
            task: task.id,
            agent: assignee,
            data: msg,
          } satisfies OrchestratorEvent)
          return
        }

        config.onProgress?.({
          type: 'task_start',
          task: task.id,
          agent: assignee,
          data: task,
        } satisfies OrchestratorEvent)

        config.onProgress?.({
          type: 'agent_start',
          agent: assignee,
          task: task.id,
          data: task,
        } satisfies OrchestratorEvent)

        // Build the prompt: task description + dependency-only context by default.
        const prompt = await buildTaskPrompt(task, team, queue, ctx.revealCoordinatorContext)

        // Trace + abort + team tool context (delegate_to_agent)
        const taskSpanId = config.onTrace ? generateSpanId() : undefined
        const agentSpanId = config.onTrace ? generateSpanId() : undefined
        const traceBase: Partial<RunOptions> = {
          identity: ctx.identity,
          runId: ctx.runId,
          ...(ctx.traceRuntime ? {
            traceRuntime: ctx.traceRuntime,
            traceSpan: taskSpan ?? ctx.traceRuntime.root,
          } : {}),
          ...(config.onTrace
            ? {
                onTrace: config.onTrace,
                taskId: task.id,
                traceAgent: assignee,
                ...(taskSpanId ? { traceParentId: taskSpanId } : {}),
                ...(agentSpanId ? { traceSpanId: agentSpanId } : {}),
              }
            : {}),
          ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
        }
        const runOptions: Partial<RunOptions> = {
          ...traceBase,
          team: buildTaskAgentTeamInfo(ctx, task.id, traceBase, 0, [assignee]),
        }
        const workerRoute = routeMatches(ctx.modelRouting, {
          phase: 'worker',
          agent: assignee,
          task,
          leaf: ctx.taskLeafById.get(task.id),
        })
        const workerEffectiveConfig = withModelRoute(applyDefaultToolPreset({
          ...agentConfig,
          model: agentConfig.model ?? config.defaultModel,
          provider: agentConfig.provider ?? config.defaultProvider,
          baseURL: agentConfig.baseURL ?? config.defaultBaseURL,
          apiKey: agentConfig.apiKey ?? config.defaultApiKey,
          cwd: agentConfig.cwd === undefined ? config.defaultCwd : agentConfig.cwd,
          onToolCall: agentConfig.onToolCall ?? config.onToolCall,
        }, config.defaultToolPreset), workerRoute)
        const routedAgent = workerRoute
          ? buildAgent(workerEffectiveConfig, { includeDelegateTool: true })
          : undefined
        const streamCallback = config.onAgentStream
          ? (event: StreamEvent) => {
              const streamMs = Date.now()
              const legacyEvent = config.onTrace ? {
                  type: 'agent_stream',
                  runId: ctx.runId ?? '',
                  spanId: generateSpanId(),
                  ...(agentSpanId ? { parentId: agentSpanId } : {}),
                  taskId: task.id,
                  agent: assignee,
                  streamType: event.type,
                  startMs: streamMs,
                  endMs: streamMs,
                  durationMs: 0,
                } as const : undefined
              if (taskSpan) {
                taskSpan.event('stream_chunk', { 'oma.stream.type': event.type }, legacyEvent)
              } else if (legacyEvent) {
                emitTrace(config.onTrace, legacyEvent)
              }
              config.onAgentStream!(assignee, event)
            }
          : undefined

        const taskStartMs = taskSpan?.startUnixMs ?? Date.now()
        let retryCount = 0

        const result = await executeWithRetry(
          (attempt) => routedAgent
            ? pool.runEphemeral(
                routedAgent,
                prompt,
                { ...runOptions, traceAgentAttempt: attempt },
                streamCallback,
              )
            : pool.run(
                assignee,
                prompt,
                { ...runOptions, traceAgentAttempt: attempt },
                streamCallback,
              ),
          task,
          (retryData) => {
            retryCount++
            taskSpan?.event('retry_scheduled', {
              'oma.retry.attempt': retryData.attempt,
              'oma.retry.max_attempts': retryData.maxAttempts,
              'oma.retry.delay_ms': retryData.nextDelayMs,
            })
            config.onProgress?.({
              type: 'task_retry',
              task: task.id,
              agent: assignee,
              data: retryData,
            } satisfies OrchestratorEvent)
          },
          undefined,
          { abortSignal: ctx.abortSignal },
        )

        const taskEndMs = Date.now()

        const taskLegacyEvent = config.onTrace ? {
            type: 'task',
            runId: ctx.runId ?? '',
            spanId: taskSpanId ?? generateSpanId(),
            taskId: task.id,
            taskTitle: task.title,
            agent: assignee,
            success: result.success,
            retries: retryCount,
            startMs: taskStartMs,
            endMs: taskEndMs,
            durationMs: taskEndMs - taskStartMs,
          } as const : undefined

        ctx.agentResults.set(`${assignee}:${task.id}`, result)

        ctx.taskMetrics.set(task.id, {
          startMs: taskStartMs,
          endMs: taskEndMs,
          durationMs: Math.max(0, taskEndMs - taskStartMs),
          tokenUsage: result.tokenUsage,
          toolCalls: result.toolCalls,
          retries: retryCount,
        })
        try {
          const budgetError = recordRunUsage(ctx, result.tokenUsage, buildCostEstimateContext({
            agentName: assignee,
            model: workerEffectiveConfig.model ?? config.defaultModel ?? DEFAULT_MODEL,
            provider: workerEffectiveConfig.provider,
            phase: 'worker',
            taskId: task.id,
          }), assignee, task.id)
          if (budgetError) {
            taskSpan?.event('budget_exhausted', {})
          }
        } catch (error) {
          const message = errorMessage(error)
          ctx.agentResults.set(`${assignee}:${task.id}`, {
            ...result,
            success: false,
            output: message,
            error,
          })
          queue.fail(task.id, message)
          const classified = classifyRunFailure(error, { kind: 'budget' })
          taskSpan?.event('budget_exhausted', {})
          taskSpan?.end({
            status: classified.status,
            error: classified.errorInfo,
            ...(taskLegacyEvent ? { legacyEvent: taskLegacyEvent } : {}),
          })
          config.onProgress?.({
            type: 'error',
            task: task.id,
            agent: assignee,
            data: message,
          } satisfies OrchestratorEvent)
          return
        }

        if (result.success) {
          const sharedMem = team.getSharedMemoryInstance()

          // Opt-in consensus verification runs *before* the task is finalised so the
          // verified outcome (accepted → revised, rejected → original) flows into the
          // queue, shared memory, progress events, and agentResults as one consistent
          // result. Judge usage is charged to the same parent budget as the rest of the run.
          let effective = result
          if (task.verify && !ctx.budgetExceededTriggered) {
            effective = await runTaskVerify(task, assignee, result, sharedMem, ctx)
          }

          // Reflect the verified result in the per-task record the caller receives.
          ctx.agentResults.set(`${assignee}:${task.id}`, effective)

          // Persist result into shared memory so other agents can read it
          if (sharedMem) {
            await sharedMem.write(assignee, `task:${task.id}:result`, effective.output)
            // Advance the turn counter so any TTL-tagged entries written during
            // this task can be expired by subsequent reads.
            sharedMem.advanceTurn()
          }

          const completedTask = queue.complete(task.id, effective.output)
          completedThisRound.push(completedTask)
          await saveRunCheckpoint(queue, ctx)

          config.onProgress?.({
            type: 'task_complete',
            task: task.id,
            agent: assignee,
            data: effective,
          } satisfies OrchestratorEvent)

          config.onProgress?.({
            type: 'agent_complete',
            agent: assignee,
            task: task.id,
            data: effective,
          } satisfies OrchestratorEvent)
          taskSpan?.end({
            status: effective.status ?? statusOnly(effective.success ? 'ok' : 'error'),
            ...(effective.errorInfo ? { error: effective.errorInfo } : {}),
            attributes: { 'oma.task.retries': retryCount },
            ...(taskLegacyEvent ? { legacyEvent: { ...taskLegacyEvent, success: effective.success } } : {}),
          })
        } else {
          queue.fail(task.id, result.output)
          taskSpan?.end({
            status: result.status ?? statusOnly('error', result.output),
            ...(result.errorInfo ? { error: result.errorInfo } : {}),
            attributes: { 'oma.task.retries': retryCount },
            ...(taskLegacyEvent ? { legacyEvent: taskLegacyEvent } : {}),
          })
          config.onProgress?.({
            type: 'error',
            task: task.id,
            agent: assignee,
            data: result,
          } satisfies OrchestratorEvent)
        }
      } finally {
        taskSpan?.ensureEnded()
      }
    })

    // Wait for the entire parallel batch before checking for newly-unblocked tasks.
    await Promise.all(dispatchPromises)
    if (ctx.budgetExceededTriggered) {
      queue.skipRemaining(ctx.budgetExceededReason ?? 'Skipped: token budget exceeded.')
      break
    }

    // --- Approval gate ---
    // After the batch completes, check if the caller wants to approve
    // the next round before it starts.
    if (config.onApproval && completedThisRound.length > 0) {
      scheduler.autoAssign(queue, team.getAgents())
      const nextPending = queue.getByStatus('pending')

      if (nextPending.length > 0) {
        const approvalSpan = ctx.traceRuntime?.startSpan({
          kind: 'callback',
          name: 'approval_callback',
          parent: ctx.traceRuntime.root,
          attributes: { 'oma.callback.name': 'onApproval' },
        })
        let approved: boolean
        try {
          approved = await config.onApproval(completedThisRound, nextPending)
        } catch (err) {
          const reason = `Skipped: approval callback error — ${err instanceof Error ? err.message : String(err)}`
          queue.skipRemaining(reason)
          const classified = classifyRunFailure(err, { kind: 'callback' })
          approvalSpan?.end({ status: classified.status, error: classified.errorInfo })
          ctx.outcomeStatus = classified.status
          ctx.outcomeErrorInfo = classified.errorInfo
          break
        }
        if (!approved) {
          approvalSpan?.event('approval_decision', { 'oma.approval.approved': false })
          approvalSpan?.end({ status: statusOnly('rejected') })
          queue.skipRemaining('Skipped: approval rejected.')
          ctx.outcomeStatus = statusOnly('rejected', 'Approval rejected.')
          break
        }
        approvalSpan?.event('approval_decision', { 'oma.approval.approved': true })
        approvalSpan?.end({ status: statusOnly('ok') })
      }
    }
  }

  unsubSkipped?.()
}

/**
 * Build the agent prompt for a specific task.
 *
 * Injects:
 *  - Optional team-context block at the top when `revealContext` is provided
 *    (set via `RunTeamOptions.revealCoordinator`)
 *  - Task title and description
 *  - Direct dependency task results by default (clean slate when none)
 *  - Optional full shared-memory context when `task.memoryScope === 'all'`
 *  - Any messages addressed to this agent from the team bus
 */
async function buildTaskPrompt(
  task: Task,
  team: Team,
  queue: TaskQueue,
  revealContext?: RevealCoordinatorContext,
): Promise<string> {
  const lines: string[] = []

  // `task.assignee` is belt-and-suspenders: `executeQueue` already fails any
  // task without an assignee before reaching this function (see the assignee
  // check in the dispatch loop). The guard here documents the precondition and
  // protects against future refactors that move the call site.
  if (revealContext && task.assignee) {
    lines.push(...buildRevealCoordinatorLines(revealContext, task.assignee))
  }

  lines.push(
    `# Task: ${task.title}`,
    '',
    task.description,
  )

  if (task.memoryScope === 'all') {
    // Explicit opt-in for full visibility (legacy/shared-memory behavior).
    const sharedMem = team.getSharedMemoryInstance()
    if (sharedMem) {
      const summary = await sharedMem.getSummary()
      if (summary) {
        lines.push('', summary)
      }
    }
  } else if (task.dependsOn && task.dependsOn.length > 0) {
    // Default-deny: inject only explicit prerequisite outputs.
    const depResults: string[] = []
    for (const depId of task.dependsOn) {
      const depTask = queue.get(depId)
      if (depTask?.status === 'completed' && depTask.result) {
        depResults.push(`### ${depTask.title} (by ${depTask.assignee ?? 'unknown'})\n${depTask.result}`)
      }
    }
    if (depResults.length > 0) {
      lines.push('', '## Context from prerequisite tasks', '', ...depResults)
    }
  }

  // Inject messages from other agents addressed to this assignee
  if (task.assignee) {
    const messages = team.getMessages(task.assignee)
    if (messages.length > 0) {
      lines.push('', '## Messages from team members')
      for (const msg of messages) {
        lines.push(`- **${msg.from}**: ${msg.content}`)
      }
    }
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Consensus (proposer + judge verification)
// ---------------------------------------------------------------------------

/** Orchestrator-level defaults applied to ephemeral consensus agents. */
interface ConsensusAgentDefaults {
  readonly defaultModel: OrchestratorConfig['defaultModel']
  readonly defaultProvider: OrchestratorConfig['defaultProvider']
  readonly defaultBaseURL: OrchestratorConfig['defaultBaseURL']
  readonly defaultApiKey: OrchestratorConfig['defaultApiKey']
  readonly defaultCwd: OrchestratorConfig['defaultCwd']
  readonly onToolCall: OrchestratorConfig['onToolCall']
  readonly maxConcurrency: number
}

/** Skeptic framing applied to every judge (refute mode and lens-mode base). */
const DEFAULT_VERIFIER_INSTRUCTION =
  'You are a rigorous skeptic reviewing a proposed answer to the question shown below. ' +
  'Judge the answer against what that question actually asks: hunt for errors, unsupported ' +
  'claims, gaps, and faulty reasoning, then decide whether it withstands scrutiny.'

/** Per-judge review angles used in `lens` mode (assigned round-robin by index). */
const CONSENSUS_LENSES = [
  'factual correctness and logical soundness',
  'completeness and coverage of the question',
  'edge cases, failure modes, and counterexamples',
  'clarity, precision, and freedom from ambiguity',
  'hidden assumptions and unstated premises',
  'evidence, citations, and verifiability',
] as const

/** Verdict contract appended to every judge prompt. */
const VERDICT_INSTRUCTION =
  'Respond ONLY with a JSON object {"accept": <true|false>, "critique": "<concise reason>"}. ' +
  'Set "accept" to true only if the answer withstands scrutiny; otherwise set it false ' +
  'and explain the problem in "critique".'

/** Apply orchestrator defaults to a consensus agent config, mirroring buildPool. */
function applyConsensusDefaults(config: AgentConfig, defaults: ConsensusAgentDefaults): AgentConfig {
  return {
    ...config,
    model: config.model ?? defaults.defaultModel,
    provider: config.provider ?? defaults.defaultProvider,
    baseURL: config.baseURL ?? defaults.defaultBaseURL,
    apiKey: config.apiKey ?? defaults.defaultApiKey,
    cwd: config.cwd === undefined ? defaults.defaultCwd : config.cwd,
    onToolCall: config.onToolCall ?? defaults.onToolCall,
  }
}

/** Build the user prompt sent to a single judge, always including the original question. */
function buildJudgePrompt(p: {
  judge: string
  answer: string
  prompt: string
  mode: 'refute' | 'lens'
  judgeIndex: number
  judgePrompt?: string | ((judge: string) => string)
}): string {
  let instruction: string
  if (p.judgePrompt !== undefined) {
    instruction = typeof p.judgePrompt === 'function' ? p.judgePrompt(p.judge) : p.judgePrompt
  } else if (p.mode === 'lens') {
    const lens = CONSENSUS_LENSES[p.judgeIndex % CONSENSUS_LENSES.length]!
    instruction = `${DEFAULT_VERIFIER_INSTRUCTION}\nFocus specifically on: ${lens}. ` +
      'If that angle is irrelevant to this question, accept the answer rather than inventing objections.'
  } else {
    instruction = DEFAULT_VERIFIER_INSTRUCTION
  }
  return [
    instruction,
    '',
    '## Question',
    p.prompt,
    '',
    '## Proposed answer',
    p.answer,
    '',
    '## Your verdict',
    VERDICT_INSTRUCTION,
  ].join('\n')
}

/** Build the proposer prompt for a revision round, feeding back the prior answer and the dissent. */
function buildRevisePrompt(prompt: string, answer: string, dissent: readonly string[]): string {
  return [
    prompt,
    '',
    '## Your previous answer',
    answer,
    '',
    '## Reviewer critiques to address',
    ...dissent.map((d) => `- ${d}`),
    '',
    'Revise the previous answer to address every critique above. Respond with the improved answer only.',
  ].join('\n')
}

/** Parse a judge's raw output into an accept/critique decision. */
function parseJudgeVerdict(
  output: string,
  verdictSchema?: ZodSchema,
): { accept: boolean; critique: string } {
  let parsed: unknown
  try {
    parsed = extractJSON(output)
  } catch {
    return { accept: false, critique: 'Judge output was not valid JSON.' }
  }
  if (verdictSchema) {
    try {
      validateOutput(verdictSchema, parsed)
    } catch (err) {
      return { accept: false, critique: `Verdict failed schema validation: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
  const obj = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>
  const accept = typeof obj['accept'] === 'boolean' ? obj['accept'] : false
  const critique = typeof obj['critique'] === 'string' && obj['critique']
    ? obj['critique']
    : accept ? '' : 'No critique provided.'
  return { accept, critique }
}

/** Inputs to {@link runConsensusCore} — the judge loop shared by `runConsensus` and the `verify` hook. */
interface ConsensusCoreParams {
  readonly team: Team
  readonly prompt: string
  /** Proposed answer to scrutinise (proposer output, or the task result). */
  readonly initialAnswer: string
  /** Usage attributable so far that should be reported back (proposer usage, or zero for the verify hook). */
  readonly initialUsage: TokenUsage
  /** Tokens already spent that count toward the budget but are not re-reported (e.g. prior task usage). */
  readonly budgetBaseTokens: number
  readonly judges: readonly AgentConfig[]
  readonly mode: 'refute' | 'lens'
  readonly quorum: number
  readonly maxRounds: number
  readonly verdictSchema?: ZodSchema
  readonly onDissent: 'revise' | 'reject' | 'keep'
  readonly judgePrompt?: string | ((judge: string) => string)
  readonly budget?: number
  /** Re-run on a revision round (the proposer, or the task assignee). */
  readonly reviseProposer?: AgentConfig
  readonly defaults: ConsensusAgentDefaults
  readonly onTrace?: OrchestratorConfig['onTrace']
  readonly runId?: string
  readonly identity?: RunIdentity
  readonly abortSignal?: AbortSignal
  readonly onUsage?: (usage: TokenUsage, effectiveConfig: AgentConfig) => void
  readonly shouldStop?: () => boolean
  /** Existing pool to reuse; a fresh one is created when omitted. */
  readonly pool?: AgentPool
  readonly traceRuntime?: TraceRuntime
  readonly consensusSpan?: TraceSpan
}

/**
 * Run the judge/refutation loop over a proposed answer: judges run sequentially
 * (so quorum and budget can stop the rest), dissent is recorded to shared memory
 * and trace, and `onDissent` decides whether to revise, reject, or keep.
 */
async function runConsensusCore(params: ConsensusCoreParams): Promise<ConsensusResult> {
  const {
    team, prompt, judges, mode, quorum, maxRounds, verdictSchema, onDissent,
    judgePrompt, budget, budgetBaseTokens, reviseProposer, defaults, onTrace, runId,
  } = params

  const pool = params.pool ?? new AgentPool(Math.max(1, defaults.maxConcurrency))
  const sharedMem = team.getSharedMemoryInstance()

  let answer = params.initialAnswer
  let usage = params.initialUsage
  const dissent: string[] = []
  let rounds = 0
  let accepted = false
  let executionFailure: AgentRunResult | undefined

  const overBudget = (): boolean =>
    budget !== undefined && budgetBaseTokens + usage.input_tokens + usage.output_tokens > budget

  const runEphemeral = async (
    config: AgentConfig,
    text: string,
    phase: 'judge' | 'revision',
  ): Promise<AgentRunResult> => {
    const effective = applyConsensusDefaults(config, defaults)
    const result = await pool.runEphemeral(buildAgent(effective), text, {
      ...(params.identity ? { identity: params.identity, runId: params.identity.runId } : {}),
      ...(params.traceRuntime && params.consensusSpan ? {
        traceRuntime: params.traceRuntime,
        traceSpan: params.consensusSpan,
        tracePhase: phase,
      } : {}),
      ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    })
    params.onUsage?.(result.tokenUsage, effective)
    return result
  }

  // Proposer usage was already accumulated by the caller; bail before judging if it blew the budget.
  if (overBudget() || params.shouldStop?.()) {
    return { answer, verdict: 'rejected', dissent, rounds, tokenUsage: usage }
  }

  let budgetHit = false
  for (let round = 1; round <= maxRounds; round++) {
    rounds = round
    let acceptCount = 0
    const roundDissent: string[] = []

    for (let j = 0; j < judges.length; j++) {
      const judge = judges[j]!
      const judgeText = buildJudgePrompt({ judge: judge.name, answer, prompt, mode, judgeIndex: j, judgePrompt })
      const r = await runEphemeral(judge, judgeText, 'judge')
      usage = addUsage(usage, r.tokenUsage)
      if (!r.success && executionFailure === undefined) executionFailure = r
      if (overBudget() || params.shouldStop?.()) { budgetHit = true; break }

      const verdict = parseJudgeVerdict(r.output, verdictSchema)

      // Trace every verdict (accept or dissent); shared memory records dissent only.
      const now = Date.now()
      const legacyEvent = onTrace ? {
          type: 'consensus',
          runId: runId ?? '',
          spanId: generateSpanId(),
          agent: judge.name,
          round,
          accepted: verdict.accept,
          ...(verdict.accept ? {} : { dissent: verdict.critique }),
          startMs: now,
          endMs: now,
          durationMs: 0,
        } as const : undefined
      if (params.consensusSpan) {
        params.consensusSpan.event('consensus_verdict', {
          'oma.consensus.round': round,
          'oma.consensus.accepted': verdict.accept,
          'oma.agent.name': judge.name,
        }, legacyEvent)
      } else if (legacyEvent) {
        emitTrace(onTrace, legacyEvent)
      }

      if (verdict.accept) {
        acceptCount++
        if (acceptCount >= quorum) { accepted = true; break }
      } else {
        const labelled = `${judge.name}: ${verdict.critique}`
        roundDissent.push(labelled)
        dissent.push(labelled)
        if (sharedMem) {
          await sharedMem.write(judge.name, `consensus:round:${round}:dissent`, verdict.critique)
        }
      }
    }

    if (budgetHit || accepted) break

    // Round missed quorum. Revise (if rounds remain) or stop.
    if (onDissent === 'revise' && round < maxRounds && reviseProposer) {
      const r = await runEphemeral(
        reviseProposer,
        buildRevisePrompt(prompt, answer, roundDissent),
        'revision',
      )
      usage = addUsage(usage, r.tokenUsage)
      if (!r.success && executionFailure === undefined) executionFailure = r
      if (r.success && r.output) answer = r.output
      if (overBudget() || params.shouldStop?.()) { budgetHit = true; break }
      continue
    }
    break
  }

  const verdict: 'accepted' | 'rejected' =
    accepted || (!budgetHit && onDissent === 'keep') ? 'accepted' : 'rejected'
  return {
    answer,
    verdict,
    dissent,
    rounds,
    tokenUsage: usage,
    ...(executionFailure?.status ? { status: executionFailure.status } : {}),
    ...(executionFailure?.errorInfo ? { errorInfo: executionFailure.errorInfo } : {}),
  }
}

/**
 * Run the per-task `verify` hook before a task is finalised: feed the task
 * result into the consensus loop, fold judge usage into the run's cumulative
 * budget, surface the verdict, and return the effective result — the accepted
 * revision when judges revise it, otherwise the original. The caller uses this
 * to finalise the task so the queue, shared memory, events, and agentResults
 * all agree on the verified outcome.
 */
async function runTaskVerify(
  task: Task,
  assignee: string,
  result: AgentRunResult,
  sharedMem: ReturnType<Team['getSharedMemoryInstance']>,
  ctx: RunContext,
): Promise<AgentRunResult> {
  const verify = task.verify!
  const { team, config } = ctx
  const assigneeConfig = team.getAgents().find((a) => a.name === assignee)
  const consensusSpan = ctx.traceRuntime?.startSpan({
    kind: 'consensus',
    name: 'verify_consensus',
    parent: ctx.taskSpans.get(task.id) ?? ctx.traceRuntime.root,
    attributes: {
      'oma.consensus.scope': 'task',
      'oma.task.id': task.id,
    },
  })

  const consensus = await runConsensusCore({
    team,
    prompt: task.description,
    initialAnswer: result.output,
    initialUsage: ZERO_USAGE,
    budgetBaseTokens: ctx.cumulativeUsage.input_tokens + ctx.cumulativeUsage.output_tokens,
    judges: verify.judges,
    mode: verify.mode ?? 'refute',
    quorum: Math.min(
      verify.judges.length,
      Math.max(1, verify.quorum ?? Math.ceil(verify.judges.length / 2)),
    ),
    maxRounds: Math.max(1, verify.maxRounds ?? 2),
    verdictSchema: verify.verdictSchema,
    onDissent: verify.onDissent ?? 'revise',
    judgePrompt: verify.judgePrompt,
    budget: ctx.maxTokenBudget,
    reviseProposer: assigneeConfig,
    defaults: {
      defaultModel: config.defaultModel,
      defaultProvider: config.defaultProvider,
      defaultBaseURL: config.defaultBaseURL,
      defaultApiKey: config.defaultApiKey,
      defaultCwd: config.defaultCwd,
      onToolCall: config.onToolCall,
      maxConcurrency: config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
    },
    onTrace: config.onTrace,
    runId: ctx.runId,
    identity: ctx.identity,
    abortSignal: ctx.abortSignal,
    onUsage: (usage, effectiveConfig) => {
      recordRunUsage(ctx, usage, buildCostEstimateContext({
        agentName: effectiveConfig.name,
        model: effectiveConfig.model ?? config.defaultModel ?? DEFAULT_MODEL,
        provider: effectiveConfig.provider,
        phase: 'consensus',
        taskId: task.id,
      }), assignee, task.id)
    },
    shouldStop: () => ctx.budgetExceededTriggered,
    ...(ctx.traceRuntime && consensusSpan ? {
      traceRuntime: ctx.traceRuntime,
      consensusSpan,
    } : {}),
  })

  consensusSpan?.end({
    status: consensus.status ?? statusOnly('ok'),
    ...(consensus.errorInfo ? { error: consensus.errorInfo } : {}),
    attributes: {
      'oma.consensus.verdict': consensus.verdict,
      'oma.consensus.rounds': consensus.rounds,
    },
  })

  if (consensus.status && consensus.status.code !== 'ok') {
    ctx.outcomeStatus = consensus.status
    ctx.outcomeErrorInfo = consensus.errorInfo
  }

  // Surface the verdict as a task-level outcome so downstream agents and the
  // final synthesis can see whether the result survived scrutiny.
  if (sharedMem) {
    const summary = consensus.verdict === 'accepted'
      ? 'accepted'
      : `rejected${consensus.dissent.length ? `: ${consensus.dissent.join('; ')}` : ''}`
    await sharedMem.write(assignee, `task:${task.id}:verdict`, summary)
  }

  // Only an *accepted* revision supersedes the task result; a rejected revision is
  // recorded as dissent but the caller finalises with the original output. Judge
  // usage rolls into the per-task usage (mirrors how delegation usage rolls in).
  const useRevision =
    consensus.verdict === 'accepted' && consensus.answer && consensus.answer !== result.output
  return {
    ...result,
    output: useRevision ? consensus.answer : result.output,
    tokenUsage: addUsage(result.tokenUsage, consensus.tokenUsage),
  }
}

// ---------------------------------------------------------------------------
// OpenMultiAgent
// ---------------------------------------------------------------------------

/**
 * Top-level orchestrator for the open-multi-agent framework.
 *
 * Manages teams, coordinates task execution, and surfaces progress events.
 * Most users will interact with this class exclusively.
 */
export class OpenMultiAgent {
  private readonly config: Required<
    Omit<OrchestratorConfig, 'onApproval' | 'onAgentStream' | 'onPlanReady' | 'onProgress' | 'onTrace' | 'onToolCall' | 'observability' | 'defaultBaseURL' | 'defaultApiKey' | 'maxTokenBudget' | 'maxCostBudget' | 'estimateCost' | 'defaultToolPreset' | 'checkpoint'>
  > & Pick<OrchestratorConfig, 'onApproval' | 'onAgentStream' | 'onPlanReady' | 'onProgress' | 'onTrace' | 'onToolCall' | 'observability' | 'defaultBaseURL' | 'defaultApiKey' | 'maxTokenBudget' | 'maxCostBudget' | 'estimateCost' | 'defaultToolPreset' | 'checkpoint'>

  private readonly teams: Map<string, Team> = new Map()
  private readonly fallbackCheckpointStore = new InMemoryStore()
  private completedTaskCount = 0
  private readonly traceRecordObserver?: TraceRecordObserver
  private readonly traceSink?: TraceSink

  /**
   * @param config - Optional top-level configuration.
   *
   * Sensible defaults:
   *   - `maxConcurrency`: 5
   *   - `maxDelegationDepth`: 3
   *   - `defaultModel`:   `'claude-opus-4-6'`
   *   - `defaultProvider`: `'anthropic'`
   */
  constructor(config: OrchestratorConfig = {}) {
    if (config.maxCostBudget !== undefined && config.estimateCost === undefined) {
      throw new Error('maxCostBudget requires estimateCost so cost caps cannot be silently ignored.')
    }

    this.traceRecordObserver = traceRecordObserverFrom(config)
    const hasExplicitLegacyBridge = config.observability?.sinks.some(
      (sink) => sink instanceof LegacyCallbackTraceSink,
    ) ?? false
    this.traceSink = config.observability && config.observability.sinks.length > 0
      ? new CompositeSink(config.observability.sinks.map((sink) =>
          sink instanceof LegacyCallbackTraceSink
            ? sink
            : new SensitiveDataProcessor(sink, { capture: config.observability?.capture })), {
          onDiagnostic: config.observability.onDiagnostic,
          sinkName: 'OpenMultiAgent',
        })
      : undefined
    this.config = {
      maxConcurrency: config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
      maxDelegationDepth: config.maxDelegationDepth ?? DEFAULT_MAX_DELEGATION_DEPTH,
      defaultModel: config.defaultModel ?? DEFAULT_MODEL,
      defaultProvider: config.defaultProvider ?? 'anthropic',
      defaultBaseURL: config.defaultBaseURL,
      defaultApiKey: config.defaultApiKey,
      // `defaultCwd === undefined` means "use the default sandbox rooted at
      // <cwd>/.agent-workspace". An explicit `null` propagates through to
      // disable the filesystem sandbox; a string sets a custom sandbox root.
      defaultCwd: config.defaultCwd === undefined ? defaultWorkspaceDir() : config.defaultCwd,
      maxTokenBudget: config.maxTokenBudget,
      maxCostBudget: config.maxCostBudget,
      estimateCost: config.estimateCost,
      defaultToolPreset: config.defaultToolPreset,
      checkpoint: config.checkpoint,
      onApproval: config.onApproval,
      onPlanReady: config.onPlanReady,
      onAgentStream: config.onAgentStream,
      onProgress: config.onProgress,
      observability: config.observability,
      onTrace: config.onTrace ?? (hasExplicitLegacyBridge ? LEGACY_TRACE_METADATA_ONLY : undefined),
      onToolCall: config.onToolCall,
    }
  }

  private startTrace(
    identity: RunIdentity,
    metadata?: RunMetadata,
    metadataOverridden = false,
  ): TraceRuntime | undefined {
    return createTraceRuntime(
      identity,
      this.config.onTrace,
      this.traceRecordObserver,
      this.traceSink,
      metadataAttributes(metadata, metadataOverridden),
    )
  }

  // -------------------------------------------------------------------------
  // Team management
  // -------------------------------------------------------------------------

  /**
   * Create and register a {@link Team} with the orchestrator.
   *
   * The team is stored internally so {@link getStatus} can report aggregate
   * agent counts. Returns the new {@link Team} for further configuration.
   *
   * @param name   - Unique team identifier. Throws if already registered.
   * @param config - Team configuration (agents, shared memory, concurrency).
   */
  createTeam(name: string, config: TeamConfig): Team {
    if (this.teams.has(name)) {
      throw new Error(
        `OpenMultiAgent: a team named "${name}" already exists. ` +
        `Use a unique name or call shutdown() to clear all teams.`,
      )
    }
    const team = new Team(config)
    this.teams.set(name, team)
    return team
  }

  // -------------------------------------------------------------------------
  // Single-agent convenience
  // -------------------------------------------------------------------------

  /**
   * Run a single prompt with a one-off agent.
   *
   * Constructs a fresh agent from `config`, runs `prompt` in a single turn,
   * and returns the result. The agent is not registered with any pool or team.
   *
   * Useful for simple one-shot queries that do not need team orchestration.
   *
   * @param config - Agent configuration.
   * @param prompt - The user prompt to send.
   */
  async runAgent(
    config: AgentConfig,
    prompt: string,
    options?: RunAgentOptions,
  ): Promise<AgentRunResult> {
    const { identity, metadata } = createRunFacts(options)
    const traceRuntime = this.startTrace(identity, metadata)
    const effectiveBudget = resolveTokenBudget(config.maxTokenBudget, this.config.maxTokenBudget)
    const effective: AgentConfig = applyDefaultToolPreset({
      ...config,
      model: config.model ?? this.config.defaultModel,
      provider: config.provider ?? this.config.defaultProvider,
      baseURL: config.baseURL ?? this.config.defaultBaseURL,
      apiKey: config.apiKey ?? this.config.defaultApiKey,
      cwd: config.cwd === undefined ? this.config.defaultCwd : config.cwd,
      maxTokenBudget: effectiveBudget,
      onToolCall: config.onToolCall ?? this.config.onToolCall,
    }, this.config.defaultToolPreset)
    const agent = buildAgent(effective)
    this.config.onProgress?.({
      type: 'agent_start',
      agent: config.name,
      data: { prompt },
    })

    // Build run-time options: trace + optional abort signal. RunOptions has
    // readonly fields, so we assemble the literal in one shot.
    const traceFields = this.config.onTrace
      ? {
          onTrace: this.config.onTrace,
          traceAgent: config.name,
        }
      : null
    const abortFields = options?.abortSignal ? { abortSignal: options.abortSignal } : null
    const runOptions: Partial<RunOptions> | undefined =
      traceFields || abortFields
        ? {
            identity,
            runId: identity.runId,
            ...(traceRuntime ? { traceRuntime, traceSpan: traceRuntime.root } : {}),
            tracePhase: 'agent',
            ...(traceFields ?? {}),
            ...(abortFields ?? {}),
          }
        : {
            identity,
            runId: identity.runId,
            ...(traceRuntime ? { traceRuntime, traceSpan: traceRuntime.root } : {}),
            tracePhase: 'agent',
          }

    const result = await agent.run(prompt, runOptions)
    let finalResult = result

    if (result.budgetExceeded) {
      this.config.onProgress?.({
        type: 'budget_exceeded',
        agent: config.name,
        data: new TokenBudgetExceededError(
          config.name,
          result.tokenUsage.input_tokens + result.tokenUsage.output_tokens,
          effectiveBudget ?? 0,
        ),
      })
    }

    if (!result.budgetExceeded && this.config.estimateCost) {
      const accounting = applyBudgetAccounting({
        currentUsage: ZERO_USAGE,
        currentCost: 0,
        usage: result.tokenUsage,
        maxCostBudget: this.config.maxCostBudget,
        estimateCost: this.config.estimateCost,
        costContext: buildCostEstimateContext({
          agentName: config.name,
          model: effective.model ?? this.config.defaultModel,
          provider: effective.provider,
          phase: 'agent',
        }),
      })
      if (accounting.exceeded instanceof CostBudgetExceededError) {
        this.config.onProgress?.({
          type: 'budget_exceeded',
          agent: config.name,
          data: accounting.exceeded,
        })
        finalResult = {
          ...result,
          success: false,
          budgetExceeded: true,
          ...classifyRunFailure(accounting.exceeded),
        }
      }
    }

    this.config.onProgress?.({
      type: 'agent_complete',
      agent: config.name,
      data: finalResult,
    })

    if (finalResult.success) {
      this.completedTaskCount++
    }

    const completedResult: AgentRunResult = {
      ...finalResult,
      ...(metadata !== undefined ? { metadata } : {}),
    }
    traceRuntime?.close({
      status: completedResult.status ?? statusOnly(completedResult.success ? 'ok' : 'error'),
      ...(completedResult.errorInfo ? { error: completedResult.errorInfo } : {}),
    })
    return completedResult
  }

  // -------------------------------------------------------------------------
  // Auto-orchestrated team run (KILLER FEATURE)
  // -------------------------------------------------------------------------

  /**
   * Run a team on a high-level goal with full automatic orchestration.
   *
   * This is the flagship method of the framework. It works as follows:
   *
   * 1. A temporary "coordinator" agent receives the goal and the team's agent
   *    roster, and is asked to decompose it into an ordered list of tasks with
   *    JSON output.
   * 2. The tasks are loaded into a {@link TaskQueue}. Title-based dependency
   *    tokens in the coordinator's output are resolved to task IDs.
   * 3. The {@link Scheduler} assigns unassigned tasks to team agents.
   * 4. Tasks are executed in dependency order, with independent tasks running
   *    in parallel up to `maxConcurrency`.
   * 5. Results are persisted to shared memory after each task so subsequent
   *    agents can read them.
   * 6. The coordinator synthesises a final answer from all task outputs.
   * 7. A {@link TeamRunResult} is returned.
   *
   * @param team - A team created via {@link createTeam} (or `new Team(...)`).
   * @param goal - High-level natural-language goal for the team.
   */
  async runTeam(
    team: Team,
    goal: string,
    options?: RunTeamOptions,
  ): Promise<TeamRunResult> {
    const { identity, metadata } = createRunFacts(identityOptionsForRun(options))
    const traceRuntime = this.startTrace(identity, metadata)
    const finish = (result: TeamRunResult): TeamRunResult => {
      const completedResult: TeamRunResult = {
        ...result,
        ...(metadata !== undefined ? { metadata } : {}),
      }
      traceRuntime?.close({
        status: completedResult.status ?? statusOnly(completedResult.success ? 'ok' : 'error'),
        ...(completedResult.errorInfo ? { error: completedResult.errorInfo } : {}),
      })
      return completedResult
    }
    const agentConfigs = team.getAgents()
    const coordinatorOverrides = options?.coordinator

    // ------------------------------------------------------------------
    // Short-circuit: skip coordinator for simple, single-action goals.
    //
    // When the goal is short and contains no multi-step / coordination
    // signals, dispatching it to a single agent is faster and cheaper
    // than spinning up a coordinator for decomposition + synthesis.
    //
    // The best-matching agent is selected via keyword affinity scoring
    // (same algorithm as the `capability-match` scheduler strategy).
    // ------------------------------------------------------------------
    if (!options?.planOnly && agentConfigs.length > 0 && isSimpleGoal(goal)) {
      const bestAgent = selectBestAgent(goal, agentConfigs)

      // Use buildAgent() + agent.run() directly instead of this.runAgent()
      // to avoid duplicate progress events and double completedTaskCount.
      // Events are emitted here; counting is handled by buildTeamRunResult().
      const effectiveBudget = resolveTokenBudget(bestAgent.maxTokenBudget, this.config.maxTokenBudget)
      const effective: AgentConfig = withModelRoute(applyDefaultToolPreset({
        ...bestAgent,
        model: bestAgent.model ?? this.config.defaultModel,
        provider: bestAgent.provider ?? this.config.defaultProvider,
        baseURL: bestAgent.baseURL ?? this.config.defaultBaseURL,
        apiKey: bestAgent.apiKey ?? this.config.defaultApiKey,
        cwd: bestAgent.cwd === undefined ? this.config.defaultCwd : bestAgent.cwd,
        maxTokenBudget: effectiveBudget,
        onToolCall: bestAgent.onToolCall ?? this.config.onToolCall,
      }, this.config.defaultToolPreset), routeMatches(options?.modelRouting, { phase: 'short-circuit', agent: bestAgent.name }))
      const agent = buildAgent(effective)

      this.config.onProgress?.({
        type: 'agent_start',
        agent: bestAgent.name,
        data: { phase: 'short-circuit', goal },
      })

      const traceFields = this.config.onTrace
        ? { onTrace: this.config.onTrace, traceAgent: bestAgent.name }
        : null
      const abortFields = options?.abortSignal ? { abortSignal: options.abortSignal } : null
      const runOptions: Partial<RunOptions> | undefined =
        traceFields || abortFields
          ? {
              identity,
              runId: identity.runId,
              ...(traceRuntime ? { traceRuntime, traceSpan: traceRuntime.root } : {}),
              tracePhase: 'short-circuit',
              ...(traceFields ?? {}),
              ...(abortFields ?? {}),
            }
          : {
              identity,
              runId: identity.runId,
              ...(traceRuntime ? { traceRuntime, traceSpan: traceRuntime.root } : {}),
              tracePhase: 'short-circuit',
            }

      const scStartMs = Date.now()
      const result = await agent.run(goal, runOptions)
      const scEndMs = Date.now()
      let finalResult = result

      if (result.budgetExceeded) {
        this.config.onProgress?.({
          type: 'budget_exceeded',
          agent: bestAgent.name,
          data: new TokenBudgetExceededError(
            bestAgent.name,
            result.tokenUsage.input_tokens + result.tokenUsage.output_tokens,
            effectiveBudget ?? 0,
          ),
        })
      }

      if (!result.budgetExceeded && this.config.estimateCost) {
        const accounting = applyBudgetAccounting({
          currentUsage: ZERO_USAGE,
          currentCost: 0,
          usage: result.tokenUsage,
          maxCostBudget: this.config.maxCostBudget,
          estimateCost: this.config.estimateCost,
          costContext: buildCostEstimateContext({
            agentName: bestAgent.name,
            model: effective.model ?? this.config.defaultModel,
            provider: effective.provider,
            phase: 'short-circuit',
          }),
        })
        if (accounting.exceeded instanceof CostBudgetExceededError) {
          this.config.onProgress?.({
            type: 'budget_exceeded',
            agent: bestAgent.name,
            data: accounting.exceeded,
          })
          finalResult = {
            ...result,
            success: false,
            budgetExceeded: true,
            ...classifyRunFailure(accounting.exceeded),
          }
        }
      }

      this.config.onProgress?.({
        type: 'agent_complete',
        agent: bestAgent.name,
        data: { phase: 'short-circuit', result: finalResult },
      })

      const agentResults = new Map<string, AgentRunResult>()
      agentResults.set(bestAgent.name, finalResult)


      const tasks: readonly TaskExecutionRecord[] = [{
        id: 'short-circuit',
        title: `Short-circuit: ${bestAgent.name}`,
        assignee: bestAgent.name,
        status: finalResult.success ? 'completed' : 'failed',
        dependsOn: [],
        metrics: {
          startMs: scStartMs,
          endMs: scEndMs,
          durationMs: Math.max(0, scEndMs - scStartMs),
          tokenUsage: finalResult.tokenUsage,
          toolCalls: finalResult.toolCalls,
          retries: 0,
        },
      }]
      return finish(this.buildTeamRunResult(agentResults, identity, goal, tasks))
    }

    // ------------------------------------------------------------------
    // Step 1: Coordinator decomposes goal into tasks
    // ------------------------------------------------------------------
    const coordinatorBaseConfig = this.buildCoordinatorBaseConfig(
      coordinatorOverrides,
      agentConfigs,
      (options?.verifyJudges?.length ?? 0) > 0,
    )
    const coordinatorConfig = withModelRoute(
      coordinatorBaseConfig,
      routeMatches(options?.modelRouting, { phase: 'coordinator', agent: 'coordinator' }),
    )

    const decompositionPrompt = this.buildDecompositionPrompt(goal, agentConfigs)
    const coordinatorAgent = buildAgent(coordinatorConfig)
    const runId = identity.runId
    const coordinatorDecomposeSpanId = this.config.onTrace ? generateSpanId() : undefined

    this.config.onProgress?.({
      type: 'agent_start',
      agent: 'coordinator',
      data: { phase: 'decomposition', goal },
    })

    const decompTraceOptions: Partial<RunOptions> | undefined = this.config.onTrace
      ? {
          identity,
          ...(traceRuntime ? { traceRuntime, traceSpan: traceRuntime.root } : {}),
          tracePhase: 'decomposition',
          onTrace: this.config.onTrace,
          runId,
          traceAgent: 'coordinator',
          ...(coordinatorDecomposeSpanId ? { traceSpanId: coordinatorDecomposeSpanId } : {}),
          ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}),
        }
      : {
          identity,
          runId,
          ...(traceRuntime ? { traceRuntime, traceSpan: traceRuntime.root } : {}),
          tracePhase: 'decomposition',
          ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}),
        }
    const decompositionResult = await coordinatorAgent.run(decompositionPrompt, decompTraceOptions)
    const agentResults = new Map<string, AgentRunResult>()
    agentResults.set('coordinator:decompose', decompositionResult)
    const maxTokenBudget = this.config.maxTokenBudget
    const maxCostBudget = this.config.maxCostBudget
    const decompositionBudget = applyBudgetAccounting({
      currentUsage: ZERO_USAGE,
      currentCost: 0,
      usage: decompositionResult.tokenUsage,
      maxTokenBudget,
      maxCostBudget,
      estimateCost: this.config.estimateCost,
      costContext: buildCostEstimateContext({
        agentName: 'coordinator',
        model: coordinatorConfig.model ?? this.config.defaultModel,
        provider: coordinatorConfig.provider,
        phase: 'coordinator',
      }),
    })
    let cumulativeUsage = decompositionBudget.cumulativeUsage
    let cumulativeCost = decompositionBudget.cumulativeCost

    if (decompositionBudget.exceeded) {
      emitBudgetExceeded(this.config, decompositionBudget.exceeded, 'coordinator')
      const classified = classifyRunFailure(decompositionBudget.exceeded)
      return finish(this.buildTeamRunResult(
        agentResults, identity, goal, [], classified.status, classified.errorInfo,
      ))
    }

    // ------------------------------------------------------------------
    // Step 2: Parse tasks from coordinator output
    // ------------------------------------------------------------------
    const taskSpecs = parseTaskSpecs(decompositionResult.output)

    const queue = new TaskQueue()
    const scheduler = new Scheduler('dependency-first')
    const taskMetrics = new Map<string, TaskExecutionMetrics>()

    if (taskSpecs && taskSpecs.length > 0) {
      // Map title-based dependsOn references to real task IDs so we can
      // build the dependency graph before adding tasks to the queue.
      this.loadSpecsIntoQueue(taskSpecs, agentConfigs, queue, options?.verifyJudges)
    } else {
      // Coordinator failed to produce structured output — fall back to
      // one task per agent using the goal as the description.
      for (const agentConfig of agentConfigs) {
        const task = createTask({
          title: `${agentConfig.name}: ${goal.slice(0, 80)}`,
          description: goal,
          assignee: agentConfig.name,
        })
        queue.add(task)
      }
    }

    // ------------------------------------------------------------------
    // Step 3: Auto-assign any unassigned tasks
    // ------------------------------------------------------------------
    scheduler.autoAssign(queue, agentConfigs)

    // ------------------------------------------------------------------
    // Step 4: Build pool and execute
    // ------------------------------------------------------------------
    const pool = this.buildPool(agentConfigs)
    const activeCheckpoint = this.createActiveCheckpoint(
      team,
      options?.checkpoint ?? this.config.checkpoint,
      'runTeam',
      goal,
    )
    const ctx: RunContext = {
      team,
      pool,
      scheduler,
      agentResults,
      config: this.config,
      ...(activeCheckpoint ? { checkpoint: activeCheckpoint } : {}),
      runId,
      identity,
      ...(metadata !== undefined ? { metadata } : {}),
      ...(traceRuntime ? { traceRuntime } : {}),
      taskSpans: new Map(),
      abortSignal: options?.abortSignal,
      cumulativeUsage,
      cumulativeCost,
      maxTokenBudget,
      maxCostBudget,
      estimateCost: this.config.estimateCost,
      budgetExceededTriggered: false,
      budgetExceededReason: undefined,
      taskMetrics,
      ...(options?.revealCoordinator
        ? {
            revealCoordinatorContext: {
              goal,
              rosterNames: agentConfigs.map((a) => a.name),
            },
          }
        : {}),
      modelRouting: options?.modelRouting,
      taskById: new Map(queue.list().map((task) => [task.id, task])),
      taskLeafById: new Map(queue.list().map((task) => [task.id, isLeafTask(task, queue.list())])),
    }

    const planTasks = queue.list()
    const planSpan = traceRuntime?.startSpan({
      kind: 'plan',
      name: 'prepare_plan',
      parent: traceRuntime.root,
      attributes: { 'oma.plan.task_count': planTasks.length },
    })
    const planReadyStartMs = planSpan?.startUnixMs ?? Date.now()
    let approved = true
    let planApprovalError: unknown
    if (this.config.onPlanReady) {
      try {
        approved = await this.config.onPlanReady(planTasks)
      } catch (error) {
        approved = false
        planApprovalError = error
      }
    }
    const planReadyEndMs = Date.now()
    const planLegacyEvent = this.config.onTrace ? {
        type: 'plan_ready',
        runId: runId ?? '',
        spanId: generateSpanId(),
        ...(coordinatorDecomposeSpanId ? { parentId: coordinatorDecomposeSpanId } : {}),
        agent: 'coordinator',
        taskCount: planTasks.length,
        approved,
        startMs: planReadyStartMs,
        endMs: planReadyEndMs,
        durationMs: planReadyEndMs - planReadyStartMs,
      } as const : undefined
    if (planSpan) {
      const planStatus = planApprovalError !== undefined
        ? classifyRunFailure(planApprovalError, { kind: 'callback' })
        : undefined
      planSpan.end({
        status: planStatus?.status ?? statusOnly(approved ? 'ok' : 'rejected'),
        ...(planStatus ? { error: planStatus.errorInfo } : {}),
        attributes: { 'oma.plan.approved': approved },
        ...(planLegacyEvent ? { legacyEvent: planLegacyEvent } : {}),
      })
    } else if (planLegacyEvent) {
      emitTrace(this.config.onTrace, planLegacyEvent)
    }
    if (!approved) {
      if (planApprovalError !== undefined) {
        const classified = classifyRunFailure(planApprovalError, { kind: 'callback' })
        return finish(this.buildTeamRunResult(
          agentResults, identity, goal, [], classified.status, classified.errorInfo,
        ))
      }
      return finish(this.buildTeamRunResult(
        agentResults,
        identity,
        goal,
        [],
        statusOnly('rejected', 'Plan approval rejected.'),
      ))
    }

    if (options?.planOnly) {
      const planOnlyTasks: readonly TaskExecutionRecord[] = queue.list().map((task) => ({
        id: task.id,
        title: task.title,
        assignee: task.assignee,
        status: task.status,
        dependsOn: task.dependsOn ?? [],
        description: task.description,
        memoryScope: task.memoryScope,
        maxRetries: task.maxRetries,
        retryDelayMs: task.retryDelayMs,
        retryBackoff: task.retryBackoff,
        verify: task.verify,
        metrics: undefined,
      }))
      this.config.onProgress?.({
        type: 'agent_complete',
        agent: 'coordinator',
        data: decompositionResult,
      })
      return finish({
        ...this.buildTeamRunResult(agentResults, identity, goal, planOnlyTasks),
        planOnly: true,
      })
    }

    await executeQueue(queue, ctx)
    if (queue.list().every((task) => task.status === 'completed')) {
      await saveRunCheckpoint(queue, ctx)
    }
    cumulativeUsage = ctx.cumulativeUsage
    cumulativeCost = ctx.cumulativeCost
    const taskRecords: readonly TaskExecutionRecord[] = queue.list().map((task) => ({
      id: task.id,
      title: task.title,
      assignee: task.assignee,
      status: task.status,
      dependsOn: task.dependsOn ?? [],
      description: task.description,
      memoryScope: task.memoryScope,
      maxRetries: task.maxRetries,
      retryDelayMs: task.retryDelayMs,
      retryBackoff: task.retryBackoff,
      verify: task.verify,
      metrics: taskMetrics.get(task.id),
    }))

    // ------------------------------------------------------------------
    // Step 5: Coordinator synthesises final result
    // ------------------------------------------------------------------
    const synthesis = await this.runCoordinatorSynthesis(team, queue, goal, coordinatorBaseConfig, {
      identity,
      modelRouting: options?.modelRouting,
      runId,
      abortSignal: options?.abortSignal,
      cumulativeUsage,
      cumulativeCost,
      maxTokenBudget,
      maxCostBudget,
      estimateCost: this.config.estimateCost,
      ...(traceRuntime ? { traceRuntime, consumedTaskSpans: [...ctx.taskSpans.values()] } : {}),
    })
    if (synthesis === null) {
      // Aborted or already over budget — return raw task outputs, no synthesis.
      if (options?.abortSignal?.aborted && ctx.outcomeStatus === undefined) {
        const abortError = new Error('Run cancelled by caller.')
        abortError.name = 'AbortError'
        const classified = classifyRunFailure(abortError)
        ctx.outcomeStatus = classified.status
        ctx.outcomeErrorInfo = classified.errorInfo
      }
      return finish(this.buildTeamRunResult(
        agentResults, identity, goal, taskRecords, ctx.outcomeStatus, ctx.outcomeErrorInfo,
      ))
    }
    agentResults.set('coordinator', synthesis.result)
    cumulativeUsage = synthesis.cumulativeUsage
    cumulativeCost = synthesis.cumulativeCost

    // Note: coordinator decompose and synthesis are internal meta-steps.
    // Only actual user tasks (non-coordinator keys) are counted in
    // buildTeamRunResult, so we do not increment completedTaskCount here.

    return finish(this.buildTeamRunResult(
      agentResults, identity, goal, taskRecords, ctx.outcomeStatus, ctx.outcomeErrorInfo,
    ))
  }

  // -------------------------------------------------------------------------
  // Explicit-task and plan replay team runs
  // -------------------------------------------------------------------------

  /**
   * Convert a plan-only {@link TeamRunResult} into a serializable plan artifact.
   *
   * The input must come from `runTeam(team, goal, { planOnly: true })` on a
   * version that records task descriptions. Executed run results are rejected
   * because their task records are not a replay contract.
   */
  createPlanArtifact(result: TeamRunResult): PlanArtifact {
    if (result.planOnly !== true || !result.tasks) {
      throw new Error('createPlanArtifact requires a plan-only TeamRunResult.')
    }

    return {
      version: 1,
      ...(result.goal !== undefined ? { goal: result.goal } : {}),
      tasks: result.tasks.map((task): PlanTaskArtifact => {
        if (!task.description) {
          throw new Error(`Plan task "${task.id}" is missing a description and cannot be replayed.`)
        }
        return {
          id: task.id,
          title: task.title,
          description: task.description,
          ...(task.assignee !== undefined ? { assignee: task.assignee } : {}),
          ...(task.dependsOn.length > 0 ? { dependsOn: task.dependsOn } : {}),
          ...(task.memoryScope !== undefined ? { memoryScope: task.memoryScope } : {}),
          ...(task.maxRetries !== undefined ? { maxRetries: task.maxRetries } : {}),
          ...(task.retryDelayMs !== undefined ? { retryDelayMs: task.retryDelayMs } : {}),
          ...(task.retryBackoff !== undefined ? { retryBackoff: task.retryBackoff } : {}),
        }
      }),
    }
  }

  /**
   * Replay a persisted plan artifact without invoking the coordinator.
   *
   * Task IDs, dependencies, assignees, titles, and descriptions are used exactly
   * as stored in the artifact. This is intentionally execution-only; it does not
   * synthesize a coordinator final answer. Durable checkpoints are available
   * through the same opt-in `checkpoint` option used by `runTasks`.
   */
  async runFromPlan(
    team: Team,
    plan: PlanArtifact,
    options?: RunTasksOptions,
  ): Promise<TeamRunResult> {
    if (plan.version !== 1) {
      throw new Error(`Unsupported plan artifact version: ${String(plan.version)}`)
    }

    const queue = new TaskQueue()
    const tasks = this.tasksFromPlan(plan)
    const validation = validateTaskDependencies(tasks)
    if (!validation.valid) {
      throw new Error(`Invalid plan artifact: ${validation.errors.join(' ')}`)
    }
    queue.addBatch(tasks)

    return this.executeExplicitTaskQueue(team, queue, options, plan.goal)
  }

  /**
   * Resume a checkpointed run, or start a fresh one when no checkpoint exists.
   *
   * Loads the latest checkpoint from the configured {@link MemoryStore}, rebuilds
   * the task queue and shared memory, skips already-completed tasks, and runs the
   * remainder. When no checkpoint is found the call falls back to a normal run of
   * the provided tasks/plan (or a no-op when neither is given).
   *
   * A resumed `runTeam` run re-runs the coordinator synthesis so the result
   * matches a fresh `runTeam` (a synthesized final answer under the
   * `'coordinator'` key in `agentResults`, not just raw per-task outputs).
   * Re-supply the coordinator via `options.coordinator` — the checkpoint cannot
   * persist a live adapter. If no usable coordinator config is available or the
   * synthesis call fails, restore falls back to raw outputs and emits an
   * `onProgress` `synthesis_failed` event. A restored `runTasks`/`runFromPlan`
   * run never synthesizes; pass the original tasks/plan to resume it unchanged.
   */
  async restore(
    team: Team,
    tasks: ReadonlyArray<RunTaskSpec>,
    options?: RestoreOptions,
  ): Promise<TeamRunResult>
  async restore(
    team: Team,
    plan: PlanArtifact,
    options?: RestoreOptions,
  ): Promise<TeamRunResult>
  async restore(
    team: Team,
    options?: RestoreOptions,
  ): Promise<TeamRunResult>
  async restore(
    team: Team,
    tasksOrOptions?: ReadonlyArray<RunTaskSpec> | PlanArtifact | RestoreOptions,
    maybeOptions?: RestoreOptions,
  ): Promise<TeamRunResult> {
    const hasTaskSource = Array.isArray(tasksOrOptions) || this.isPlanArtifact(tasksOrOptions)
    const options = hasTaskSource ? maybeOptions : tasksOrOptions as RestoreOptions | undefined
    validateRunMetadata(options?.metadata)
    const activeCheckpoint = this.createActiveCheckpoint(
      team,
      options?.checkpoint ?? this.config.checkpoint ?? true,
      'runTasks',
      options?.goal,
    )

    const snapshot = activeCheckpoint ? await activeCheckpoint.manager.loadLatest() : null
    if (!snapshot) {
      if (Array.isArray(tasksOrOptions)) {
        const queue = new TaskQueue()
        this.loadSpecsIntoQueue(
          tasksOrOptions.map((t) => ({
            title: t.title,
            description: t.description,
            assignee: t.assignee,
            dependsOn: t.dependsOn,
            memoryScope: t.memoryScope,
            maxRetries: t.maxRetries,
            retryDelayMs: t.retryDelayMs,
            retryBackoff: t.retryBackoff,
            role: t.role,
            priority: t.priority,
            verify: t.verify,
          })),
          team.getAgents(),
          queue,
        )
        return this.executeExplicitTaskQueue(
          team,
          queue,
          options,
          options?.goal,
          undefined,
          activeCheckpoint,
        )
      }
      if (this.isPlanArtifact(tasksOrOptions)) {
        const queue = new TaskQueue()
        const tasks = this.tasksFromPlan(tasksOrOptions)
        const validation = validateTaskDependencies(tasks)
        if (!validation.valid) {
          throw new Error(`Invalid plan artifact: ${validation.errors.join(' ')}`)
        }
        queue.addBatch(tasks)
        return this.executeExplicitTaskQueue(
          team,
          queue,
          options,
          tasksOrOptions.goal ?? options?.goal,
          undefined,
          activeCheckpoint,
        )
      }

      const queue = new TaskQueue()
      return this.executeExplicitTaskQueue(
        team,
        queue,
        options,
        options?.goal,
        undefined,
        activeCheckpoint,
      )
    }

    const sharedMem = team.getSharedMemoryInstance()
    if (sharedMem && snapshot.sharedMemory) {
      await sharedMem.restore(snapshot.sharedMemory)
    } else if (sharedMem && snapshot.turnCount !== undefined) {
      // Reused-store checkpoint: entries are already in the store; only the
      // turn counter needs restoring so TTL expiry resumes correctly.
      sharedMem.setTurnCount(snapshot.turnCount)
    }
    if (snapshot.messageBus) {
      team.restoreMessageBus(snapshot.messageBus)
    }

    const restoreIdentityOptions = identityOptionsForRun(options)
    const restoreMetadata = resolveRestoreMetadata(snapshot, restoreIdentityOptions)
    const identity = createRestoreIdentity(snapshot, restoreIdentityOptions)

    const queue = TaskQueue.fromSnapshot(snapshot.queue, { resetInProgress: true })
    const agentResults = this.agentResultsFromCheckpoint(snapshot, queue)
    const checkpointForResume: ActiveCheckpoint | undefined = activeCheckpoint
      ? {
          ...activeCheckpoint,
          mode: snapshot.mode,
          ...(snapshot.goal !== undefined ? { goal: snapshot.goal } : {}),
          runId: identity.runId,
        }
      : undefined

    return this.executeExplicitTaskQueue(
      team,
      queue,
      options,
      snapshot.goal ?? options?.goal,
      agentResults,
      checkpointForResume,
      options?.coordinator,
      identity,
      restoreMetadata,
    )
  }

  /**
   * Run a team with an explicitly provided task list.
   *
   * Simpler than {@link runTeam}: no coordinator agent is involved. Tasks are
   * loaded directly into the queue, unassigned tasks are auto-assigned via the
   * {@link Scheduler}, and execution proceeds in dependency order.
   *
   * @param team  - A team created via {@link createTeam}.
   * @param tasks - Array of task descriptors.
   */
  async runTasks(
    team: Team,
    tasks: ReadonlyArray<RunTaskSpec>,
    options?: RunTasksOptions,
  ): Promise<TeamRunResult> {
    const agentConfigs = team.getAgents()
    const queue = new TaskQueue()

    this.loadSpecsIntoQueue(
      tasks.map((t) => ({
        title: t.title,
        description: t.description,
        assignee: t.assignee,
        dependsOn: t.dependsOn,
        memoryScope: t.memoryScope,
        maxRetries: t.maxRetries,
        retryDelayMs: t.retryDelayMs,
        retryBackoff: t.retryBackoff,
        role: t.role,
        priority: t.priority,
        verify: t.verify,
      })),
      agentConfigs,
      queue,
    )

    return this.executeExplicitTaskQueue(team, queue, options)
  }

  // -------------------------------------------------------------------------
  // Consensus
  // -------------------------------------------------------------------------

  /**
   * Run a proposer→judge consensus over a single prompt.
   *
   * The proposer emits an answer; judges try to refute it over up to
   * `maxRounds`, exiting early once `quorum` accept. Proposer and judge token
   * usage all count against the orchestrator's `maxTokenBudget` — crossing it
   * stops issuing further judge calls, exactly like delegation and `runTasks`.
   */
  async runConsensus(
    team: Team,
    prompt: string,
    options: ConsensusOptions,
  ): Promise<ConsensusResult> {
    const { identity, metadata } = createRunFacts(options)
    const proposers = Array.isArray(options.proposer) ? options.proposer : [options.proposer]
    if (proposers.length === 0) {
      throw new Error('runConsensus: at least one proposer is required.')
    }
    if (options.judges.length === 0) {
      throw new Error('runConsensus: at least one judge is required.')
    }

    const traceRuntime = this.startTrace(identity, metadata)
    const consensusSpan = traceRuntime?.startSpan({
      kind: 'consensus',
      name: 'verify_consensus',
      parent: traceRuntime.root,
      attributes: { 'oma.consensus.scope': 'top_level' },
    })
    const finish = (result: ConsensusResult): ConsensusResult => {
      const completedResult: ConsensusResult = {
        ...result,
        ...(metadata !== undefined ? { metadata } : {}),
      }
      const status = completedResult.status ?? statusOnly('ok')
      consensusSpan?.end({
        status,
        ...(completedResult.errorInfo ? { error: completedResult.errorInfo } : {}),
        attributes: {
          'oma.consensus.verdict': completedResult.verdict,
          'oma.consensus.rounds': completedResult.rounds,
        },
      })
      traceRuntime?.close({
        status,
        ...(completedResult.errorInfo ? { error: completedResult.errorInfo } : {}),
      })
      return completedResult
    }

    const mode = options.mode ?? 'refute'
    const maxRounds = Math.max(1, options.maxRounds ?? 2)
    const quorum = Math.min(
      options.judges.length,
      Math.max(1, options.quorum ?? Math.ceil(options.judges.length / 2)),
    )
    const onDissent = options.onDissent ?? 'revise'
    const budget = this.config.maxTokenBudget
    const defaults: ConsensusAgentDefaults = {
      defaultModel: this.config.defaultModel,
      defaultProvider: this.config.defaultProvider,
      defaultBaseURL: this.config.defaultBaseURL,
      defaultApiKey: this.config.defaultApiKey,
      defaultCwd: this.config.defaultCwd,
      onToolCall: this.config.onToolCall,
      maxConcurrency: this.config.maxConcurrency,
    }

    const pool = new AgentPool(Math.max(1, this.config.maxConcurrency))
    let usage: TokenUsage = ZERO_USAGE

    // Step 2: run proposer(s); accumulate usage and honour the budget before judging.
    const candidates: string[] = []
    let firstFailure: AgentRunResult | undefined
    for (const proposerConfig of proposers) {
      const r = await pool.runEphemeral(
        buildAgent(applyConsensusDefaults(proposerConfig, defaults)),
        prompt,
        {
          identity,
          runId: identity.runId,
          ...(traceRuntime && consensusSpan ? {
            traceRuntime,
            traceSpan: consensusSpan,
            tracePhase: 'proposer',
          } : {}),
          ...(this.config.onTrace ? { onTrace: this.config.onTrace, traceAgent: proposerConfig.name } : {}),
          ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
        },
      )
      usage = addUsage(usage, r.tokenUsage)
      if (r.success && r.output) candidates.push(r.output)
      if (!r.success && firstFailure === undefined) firstFailure = r
      if (options.abortSignal?.aborted) {
        const abortError = new Error('Run cancelled by caller.')
        abortError.name = 'AbortError'
        const classified = classifyRunFailure(abortError)
        return finish({
          identity,
          status: classified.status,
          errorInfo: classified.errorInfo,
          answer: candidates.join('\n\n---\n\n'),
          verdict: 'rejected',
          dissent: [],
          rounds: 0,
          tokenUsage: usage,
        })
      }
      if (budget !== undefined && usage.input_tokens + usage.output_tokens > budget) {
        const budgetError = new TokenBudgetExceededError(
          proposerConfig.name,
          usage.input_tokens + usage.output_tokens,
          budget,
        )
        this.config.onProgress?.({
          type: 'budget_exceeded',
          agent: proposerConfig.name,
          data: budgetError,
        })
        const classified = classifyRunFailure(budgetError)
        consensusSpan?.event('budget_exhausted', {})
        return finish({
          identity,
          status: classified.status,
          errorInfo: classified.errorInfo,
          answer: candidates.join('\n\n---\n\n'),
          verdict: 'rejected',
          dissent: [],
          rounds: 0,
          tokenUsage: usage,
        })
      }
    }

    // Every proposer failed or returned empty output: there is nothing to judge.
    // Bail with a rejected verdict so an empty answer can never come back accepted.
    if (candidates.length === 0) {
      const status = firstFailure?.status ?? statusOnly('error', 'All consensus proposers failed.')
      return finish({
        identity,
        status,
        ...(firstFailure?.errorInfo ? { errorInfo: firstFailure.errorInfo } : {}),
        answer: '', verdict: 'rejected', dissent: [], rounds: 0, tokenUsage: usage,
      })
    }

    const result = await runConsensusCore({
      team,
      prompt,
      initialAnswer: candidates.join('\n\n---\n\n'),
      initialUsage: usage,
      budgetBaseTokens: 0,
      judges: options.judges,
      mode,
      quorum,
      maxRounds,
      verdictSchema: options.verdictSchema,
      onDissent,
      judgePrompt: options.judgePrompt,
      budget,
      reviseProposer: proposers[0],
      defaults,
      onTrace: this.config.onTrace,
      runId: identity.runId,
      identity,
      abortSignal: options.abortSignal,
      pool,
      ...(traceRuntime && consensusSpan ? { traceRuntime, consensusSpan } : {}),
    })
    if (options.abortSignal?.aborted) {
      const abortError = new Error('Run cancelled by caller.')
      abortError.name = 'AbortError'
      const classified = classifyRunFailure(abortError)
      return finish({ ...result, identity, status: classified.status, errorInfo: classified.errorInfo })
    }
    if (budget !== undefined && result.tokenUsage.input_tokens + result.tokenUsage.output_tokens > budget) {
      const budgetError = new TokenBudgetExceededError(
        proposers[0]!.name,
        result.tokenUsage.input_tokens + result.tokenUsage.output_tokens,
        budget,
      )
      const classified = classifyRunFailure(budgetError)
      consensusSpan?.event('budget_exhausted', {})
      return finish({ ...result, identity, status: classified.status, errorInfo: classified.errorInfo })
    }
    return finish({ ...result, identity, status: result.status ?? statusOnly('ok') })
  }

  // -------------------------------------------------------------------------
  // Observability
  // -------------------------------------------------------------------------

  /**
   * Returns a lightweight status snapshot.
   *
   * - `teams`          — Number of teams registered with this orchestrator.
   * - `activeAgents`   — Total agents currently in `running` state.
   * - `completedTasks` — Cumulative count of successfully completed tasks
   *                      (coordinator meta-steps excluded).
   */
  getStatus(): { teams: number; activeAgents: number; completedTasks: number } {
    return {
      teams: this.teams.size,
      activeAgents: 0, // Pools are ephemeral per-run; no cross-run state to inspect.
      completedTasks: this.completedTaskCount,
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Deregister all teams and reset internal counters.
   *
   * Does not cancel in-flight runs. Call this when you want to reuse the
   * orchestrator instance for a fresh set of teams.
   *
   * Async for forward compatibility — shutdown may need to perform async
   * cleanup (e.g. graceful agent drain) in future versions.
   */
  async shutdown(): Promise<void> {
    this.teams.clear()
    this.completedTaskCount = 0
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Build the system prompt given to the coordinator agent. */
  private buildCoordinatorSystemPrompt(agents: AgentConfig[], hasVerifyJudges?: boolean): string {
    return [
      'You are a task coordinator responsible for decomposing high-level goals',
      'into concrete, actionable tasks and assigning them to the right team members.',
      '',
      this.buildCoordinatorRosterSection(agents),
      '',
      this.buildCoordinatorOutputFormatSection(hasVerifyJudges),
      '',
      this.buildCoordinatorSynthesisSection(),
    ].join('\n')
  }

  /** Build coordinator system prompt with optional caller overrides. */
  private buildCoordinatorPrompt(agents: AgentConfig[], config?: CoordinatorConfig, hasVerifyJudges?: boolean): string {
    if (config?.systemPrompt) {
      return [
        config.systemPrompt,
        '',
        this.buildCoordinatorRosterSection(agents),
        '',
        this.buildCoordinatorOutputFormatSection(hasVerifyJudges),
        '',
        this.buildCoordinatorSynthesisSection(),
      ].join('\n')
    }

    const base = this.buildCoordinatorSystemPrompt(agents, hasVerifyJudges)
    if (!config?.instructions) {
      return base
    }

    return [
      base,
      '',
      '## Additional Instructions',
      config.instructions,
    ].join('\n')
  }

  /** Build the coordinator team roster section. */
  private buildCoordinatorRosterSection(agents: AgentConfig[]): string {
    const roster = agents
      .map(
        (a) =>
          `- **${a.name}** (${a.model}): ${a.systemPrompt ?? 'general purpose agent'}`,
      )
      .join('\n')

    return [
      '## Team Roster',
      roster,
    ].join('\n')
  }

  /** Build the coordinator JSON output-format section. */
  private buildCoordinatorOutputFormatSection(hasVerifyJudges?: boolean): string {
    const lines = [
      '## Output Format',
      'When asked to decompose a goal, respond ONLY with a JSON array of task objects.',
      'Each task must have:',
      '  - "title":       Short descriptive title (string)',
      '  - "description": Full task description with context and expected output (string)',
      '  - "assignee":    One of the agent names listed in the roster (string)',
      '  - "dependsOn":   Array of titles of tasks this task depends on (string[], may be empty).',
    ]
    if (hasVerifyJudges) {
      lines.push(
        '  - "verify":      (optional) Set to true to apply consensus judge verification on this task\'s result.',
        '                   Or set to an object with any of: "mode" ("refute"|"lens"), "quorum" (number),',
        '                   "maxRounds" (number), "onDissent" ("revise"|"reject"|"keep").',
        '                   Omit for tasks where a single agent\'s answer is sufficient.',
      )
    }
    lines.push(
      '',
      '## Dependency Guidance',
      'Prefer the minimum set of upstream tasks each assignee needs. When deciding dependsOn for agent X:',
      '  1. Use X\'s system prompt as the primary signal for what inputs it consumes.',
      '  2. Lean toward including a task as a dependency only when X\'s system prompt names or describes needing that kind of input.',
      '  3. Avoid adding a dependency just because the information "would be useful" or matches general best practice; if X\'s system prompt gives no indication it consumes that input, prefer to leave it out.',
      '  4. When uncertain, prefer fewer dependencies over more — extra parents cost parallelism and tokens.',
      '',
      'Wrap the JSON in a ```json code fence.',
      'Do not include any text outside the code fence.',
    )
    return lines.join('\n')
  }

  /** Build the coordinator synthesis guidance section. */
  private buildCoordinatorSynthesisSection(): string {
    return [
      '## When synthesising results',
      'You will be given completed task outputs and asked to synthesise a final answer.',
      'Write a clear, comprehensive response that addresses the original goal.',
    ].join('\n')
  }

  /** Build the decomposition prompt for the coordinator. */
  private buildDecompositionPrompt(goal: string, agents: AgentConfig[]): string {
    const names = agents.map((a) => a.name).join(', ')
    return [
      `Decompose the following goal into tasks for your team (${names}).`,
      '',
      `## Goal`,
      goal,
      '',
      'Return ONLY the JSON task array in a ```json code fence.',
    ].join('\n')
  }

  /**
   * Build the base coordinator {@link AgentConfig} shared by the decomposition
   * and synthesis passes. Falls back to orchestrator defaults for any field the
   * caller's {@link CoordinatorConfig} leaves unset.
   */
  private buildCoordinatorBaseConfig(
    coordinatorOverrides: CoordinatorConfig | undefined,
    agentConfigs: AgentConfig[],
    hasVerifyJudges: boolean,
  ): AgentConfig {
    return {
      name: 'coordinator',
      model: coordinatorOverrides?.model ?? this.config.defaultModel,
      ...(coordinatorOverrides?.adapter !== undefined ? { adapter: coordinatorOverrides.adapter } : {}),
      provider: coordinatorOverrides?.provider ?? this.config.defaultProvider,
      baseURL: coordinatorOverrides?.baseURL ?? this.config.defaultBaseURL,
      apiKey: coordinatorOverrides?.apiKey ?? this.config.defaultApiKey,
      systemPrompt: this.buildCoordinatorPrompt(agentConfigs, coordinatorOverrides, hasVerifyJudges),
      maxTurns: coordinatorOverrides?.maxTurns ?? 3,
      maxTokens: coordinatorOverrides?.maxTokens,
      temperature: coordinatorOverrides?.temperature,
      topP: coordinatorOverrides?.topP,
      topK: coordinatorOverrides?.topK,
      minP: coordinatorOverrides?.minP,
      parallelToolCalls: coordinatorOverrides?.parallelToolCalls,
      frequencyPenalty: coordinatorOverrides?.frequencyPenalty,
      presencePenalty: coordinatorOverrides?.presencePenalty,
      extraBody: coordinatorOverrides?.extraBody,
      toolPreset: coordinatorOverrides?.toolPreset,
      tools: coordinatorOverrides?.tools,
      disallowedTools: coordinatorOverrides?.disallowedTools,
      onToolCall: coordinatorOverrides?.onToolCall ?? this.config.onToolCall,
      cwd: coordinatorOverrides?.cwd === undefined
        ? this.config.defaultCwd
        : coordinatorOverrides.cwd,
      loopDetection: coordinatorOverrides?.loopDetection,
      timeoutMs: coordinatorOverrides?.timeoutMs,
      callTimeoutMs: coordinatorOverrides?.callTimeoutMs,
    }
  }

  /**
   * Run the coordinator synthesis pass over completed task results. Returns the
   * synthesis result plus updated cumulative usage, or `null` when synthesis is
   * skipped (run aborted, or the token budget was already exhausted before the
   * pass). Emits `budget_exceeded` (when synthesis tips over budget) and
   * `agent_complete`, mirroring the inline `runTeam` path. Does not mutate
   * `agentResults` — the caller records the `'coordinator'` entry.
   */
  private async runCoordinatorSynthesis(
    team: Team,
    queue: TaskQueue,
    goal: string,
    coordinatorBaseConfig: AgentConfig,
    opts: {
      readonly identity: RunIdentity
      readonly modelRouting?: ModelRoutingPolicy
      readonly runId?: string
      readonly abortSignal?: AbortSignal
      readonly cumulativeUsage: TokenUsage
      readonly cumulativeCost: number
      readonly maxTokenBudget?: number
      readonly maxCostBudget?: number
      readonly estimateCost?: OrchestratorConfig['estimateCost']
      readonly traceRuntime?: TraceRuntime
      readonly consumedTaskSpans?: readonly TraceSpan[]
    },
  ): Promise<{ readonly result: AgentRunResult; readonly cumulativeUsage: TokenUsage; readonly cumulativeCost: number } | null> {
    if (opts.abortSignal?.aborted) return null
    if (
      opts.maxTokenBudget !== undefined
      && totalTokens(opts.cumulativeUsage) > opts.maxTokenBudget
    ) {
      return null
    }
    if (
      opts.maxCostBudget !== undefined
      && opts.estimateCost !== undefined
      && opts.cumulativeCost > opts.maxCostBudget
    ) {
      return null
    }

    const synthesisPrompt = await this.buildSynthesisPrompt(goal, queue.list(), team)
    const synthesisConfig = withModelRoute(
      coordinatorBaseConfig,
      routeMatches(opts.modelRouting, { phase: 'synthesis', agent: 'coordinator' }),
    )
    const synthesisAgent = buildAgent(synthesisConfig)
    const synthTraceOptions: Partial<RunOptions> = {
      identity: opts.identity,
      runId: opts.identity.runId,
      ...(opts.traceRuntime ? {
        traceRuntime: opts.traceRuntime,
        traceSpan: opts.traceRuntime.root,
        tracePhase: 'synthesis',
        traceLinks: (opts.consumedTaskSpans ?? []).map((span) => ({
          traceId: opts.identity.traceId,
          spanId: span.spanId,
          relation: 'consumed' as const,
        })),
      } : {}),
      ...(this.config.onTrace
        ? { onTrace: this.config.onTrace, traceAgent: 'coordinator' }
        : {}),
      ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    }
    let result = await synthesisAgent.run(synthesisPrompt, synthTraceOptions)
    const accounting = applyBudgetAccounting({
      currentUsage: opts.cumulativeUsage,
      currentCost: opts.cumulativeCost,
      usage: result.tokenUsage,
      maxTokenBudget: opts.maxTokenBudget,
      maxCostBudget: opts.maxCostBudget,
      estimateCost: opts.estimateCost,
      costContext: buildCostEstimateContext({
        agentName: 'coordinator',
        model: synthesisConfig.model ?? this.config.defaultModel,
        provider: synthesisConfig.provider,
        phase: 'synthesis',
      }),
    })

    if (accounting.exceeded) {
      emitBudgetExceeded(this.config, accounting.exceeded, 'coordinator')
      result = {
        ...result,
        success: false,
        budgetExceeded: true,
        ...classifyRunFailure(accounting.exceeded),
      }
    }

    this.config.onProgress?.({
      type: 'agent_complete',
      agent: 'coordinator',
      data: result,
    })

    return {
      result,
      cumulativeUsage: accounting.cumulativeUsage,
      cumulativeCost: accounting.cumulativeCost,
    }
  }

  /** Build the synthesis prompt shown to the coordinator after all tasks complete. */
  private async buildSynthesisPrompt(
    goal: string,
    tasks: Task[],
    team: Team,
  ): Promise<string> {
    const completedTasks = tasks.filter((t) => t.status === 'completed')
    const failedTasks = tasks.filter((t) => t.status === 'failed')
    const skippedTasks = tasks.filter((t) => t.status === 'skipped')

    const resultSections = completedTasks.map((t) => {
      const assignee = t.assignee ?? 'unknown'
      return `### ${t.title} (completed by ${assignee})\n${t.result ?? '(no output)'}`
    })

    const failureSections = failedTasks.map(
      (t) => `### ${t.title} (FAILED)\nError: ${t.result ?? 'unknown error'}`,
    )

    const skippedSections = skippedTasks.map(
      (t) => `### ${t.title} (SKIPPED)\nReason: ${t.result ?? 'approval rejected'}`,
    )

    // Also include shared memory summary for additional context
    let memorySummary = ''
    const sharedMem = team.getSharedMemoryInstance()
    if (sharedMem) {
      memorySummary = await sharedMem.getSummary()
    }

    return [
      `## Original Goal`,
      goal,
      '',
      `## Task Results`,
      ...resultSections,
      ...(failureSections.length > 0 ? ['', '## Failed Tasks', ...failureSections] : []),
      ...(skippedSections.length > 0 ? ['', '## Skipped Tasks', ...skippedSections] : []),
      ...(memorySummary ? ['', memorySummary] : []),
      '',
      '## Your Task',
      'Synthesise the above results into a comprehensive final answer that addresses the original goal.',
      'If some tasks failed or were skipped, note any gaps in the result.',
    ].join('\n')
  }

  private tasksFromPlan(plan: PlanArtifact): Task[] {
    const now = new Date()
    return plan.tasks.map((task): Task => ({
      id: task.id,
      title: task.title,
      description: task.description,
      status: 'pending' as TaskStatus,
      ...(task.assignee !== undefined ? { assignee: task.assignee } : {}),
      ...(task.dependsOn && task.dependsOn.length > 0 ? { dependsOn: [...task.dependsOn] } : {}),
      ...(task.memoryScope !== undefined ? { memoryScope: task.memoryScope } : {}),
      result: undefined,
      createdAt: now,
      updatedAt: now,
      ...(task.maxRetries !== undefined ? { maxRetries: task.maxRetries } : {}),
      ...(task.retryDelayMs !== undefined ? { retryDelayMs: task.retryDelayMs } : {}),
      ...(task.retryBackoff !== undefined ? { retryBackoff: task.retryBackoff } : {}),
    }))
  }

  private async executeExplicitTaskQueue(
    team: Team,
    queue: TaskQueue,
    options?: RunTasksOptions,
    goal?: string,
    initialAgentResults?: Map<string, AgentRunResult>,
    activeCheckpoint?: ActiveCheckpoint,
    coordinatorForSynthesis?: CoordinatorConfig,
    identity?: RunIdentity,
    restoreMetadata?: RestoreMetadataResolution,
  ): Promise<TeamRunResult> {
    const newRunFacts = identity === undefined
      ? createRunFacts(identityOptionsForRun(options))
      : undefined
    const runIdentity = identity ?? newRunFacts!.identity
    const metadata = restoreMetadata?.metadata ?? newRunFacts?.metadata
    const traceRuntime = this.startTrace(runIdentity, metadata, restoreMetadata?.overridden)
    const agentConfigs = team.getAgents()
    const scheduler = new Scheduler('dependency-first')
    scheduler.autoAssign(queue, agentConfigs)

    const pool = this.buildPool(agentConfigs)
    const agentResults = initialAgentResults ?? new Map<string, AgentRunResult>()
    const checkpoint = activeCheckpoint ?? this.createActiveCheckpoint(
      team,
      options?.checkpoint ?? this.config.checkpoint,
      'runTasks',
      goal,
    )
    const ctx: RunContext = {
      team,
      pool,
      scheduler,
      agentResults,
      config: this.config,
      ...(checkpoint ? { checkpoint } : {}),
      identity: runIdentity,
      ...(metadata !== undefined ? { metadata } : {}),
      runId: runIdentity.runId,
      ...(traceRuntime ? { traceRuntime } : {}),
      taskSpans: new Map(),
      abortSignal: options?.abortSignal,
      cumulativeUsage: ZERO_USAGE,
      cumulativeCost: 0,
      maxTokenBudget: this.config.maxTokenBudget,
      maxCostBudget: this.config.maxCostBudget,
      estimateCost: this.config.estimateCost,
      budgetExceededTriggered: false,
      budgetExceededReason: undefined,
      taskMetrics: new Map<string, TaskExecutionMetrics>(),
      modelRouting: options?.modelRouting,
      taskById: new Map(queue.list().map((task) => [task.id, task])),
      taskLeafById: new Map(queue.list().map((task) => [task.id, isLeafTask(task, queue.list())])),
    }

    await executeQueue(queue, ctx)
    if (queue.list().every((task) => task.status === 'completed')) {
      await saveRunCheckpoint(queue, ctx)
    }

    // A resumed `runTeam` re-runs the coordinator synthesis so the restored
    // result matches a fresh `runTeam` (a synthesized final answer, not raw
    // per-task outputs). Best-effort: a missing/unusable coordinator config or
    // a failing synthesis call must not discard the recovered work — on failure
    // we surface `synthesis_failed` and fall back to raw outputs.
    if (checkpoint?.mode === 'runTeam' && goal !== undefined) {
      try {
        const coordinatorBaseConfig = this.buildCoordinatorBaseConfig(coordinatorForSynthesis, agentConfigs, false)
        const synthesis = await this.runCoordinatorSynthesis(team, queue, goal, coordinatorBaseConfig, {
          identity: runIdentity,
          modelRouting: options?.modelRouting,
          runId: ctx.runId,
          abortSignal: options?.abortSignal,
          cumulativeUsage: ctx.cumulativeUsage,
          cumulativeCost: ctx.cumulativeCost,
          maxTokenBudget: ctx.maxTokenBudget,
          maxCostBudget: ctx.maxCostBudget,
          estimateCost: ctx.estimateCost,
          ...(traceRuntime ? { traceRuntime, consumedTaskSpans: [...ctx.taskSpans.values()] } : {}),
        })
        if (synthesis !== null && synthesis.result.success) {
          agentResults.set('coordinator', synthesis.result)
          ctx.cumulativeUsage = synthesis.cumulativeUsage
          ctx.cumulativeCost = synthesis.cumulativeCost
        } else if (synthesis !== null) {
          // Synthesis ran but the coordinator agent failed (e.g. the LLM call
          // errored). Keep the recovered task outputs and surface the failure
          // rather than attaching a failed answer under `'coordinator'`.
          this.config.onProgress?.({
            type: 'error',
            data: {
              kind: 'synthesis_failed',
              error: new Error(synthesis.result.output || 'coordinator synthesis failed'),
            },
          })
          ctx.outcomeStatus = synthesis.result.status ?? statusOnly('error', synthesis.result.output)
          ctx.outcomeErrorInfo = synthesis.result.errorInfo
        } else if (options?.abortSignal?.aborted && ctx.outcomeStatus === undefined) {
          const abortError = new Error('Run cancelled by caller.')
          abortError.name = 'AbortError'
          const classified = classifyRunFailure(abortError)
          ctx.outcomeStatus = classified.status
          ctx.outcomeErrorInfo = classified.errorInfo
        }
      } catch (error) {
        this.config.onProgress?.({
          type: 'error',
          data: { kind: 'synthesis_failed', error },
        })
        const classified = classifyRunFailure(error)
        ctx.outcomeStatus = classified.status
        ctx.outcomeErrorInfo = classified.errorInfo
      }
    }

    const taskRecords: readonly TaskExecutionRecord[] = queue.list().map((task) => ({
      id: task.id,
      title: task.title,
      assignee: task.assignee,
      status: task.status,
      dependsOn: task.dependsOn ?? [],
      description: task.description,
      memoryScope: task.memoryScope,
      maxRetries: task.maxRetries,
      retryDelayMs: task.retryDelayMs,
      retryBackoff: task.retryBackoff,
      verify: task.verify,
      metrics: ctx.taskMetrics.get(task.id),
    }))

    const result = this.buildTeamRunResult(
      agentResults,
      runIdentity,
      goal,
      taskRecords,
      ctx.outcomeStatus,
      ctx.outcomeErrorInfo,
    )
    const completedResult: TeamRunResult = {
      ...result,
      ...(metadata !== undefined ? { metadata } : {}),
    }
    traceRuntime?.close({
      status: completedResult.status ?? statusOnly(completedResult.success ? 'ok' : 'error'),
      ...(completedResult.errorInfo ? { error: completedResult.errorInfo } : {}),
    })
    return completedResult
  }

  private createActiveCheckpoint(
    team: Team,
    config: boolean | CheckpointOptions | undefined,
    mode: CheckpointSnapshot['mode'],
    goal?: string,
  ): ActiveCheckpoint | undefined {
    if (config === undefined || config === false) return undefined
    const options = config === true ? {} : config
    if (options.enabled === false) return undefined

    // The instance-level fallback store is shared across every run on this
    // orchestrator, so concurrent runs would overwrite each other at the
    // default checkpoint key. Require a `runId` (or an explicit `key`/`store`)
    // before falling back, so each run resolves to a distinct, resumable key.
    const sharedStore = team.getSharedMemory()
    const explicitStore = options.store ?? sharedStore
    if (!explicitStore && options.runId === undefined && options.key === undefined) {
      throw new Error(
        'Checkpoint requires a `runId` (or an explicit `store`/`key`) when the team has no ' +
          'shared-memory store. Without one, concurrent runs would share the fallback store and ' +
          "overwrite each other's checkpoint at the default key.",
      )
    }
    const store = explicitStore ?? this.fallbackCheckpointStore
    return {
      manager: new Checkpoint(store, options),
      mode,
      ...(goal !== undefined ? { goal } : {}),
      ...(options.runId !== undefined ? { runId: options.runId } : {}),
      reusesSharedMemoryStore: sharedStore !== undefined && store === sharedStore,
      saveChain: Promise.resolve(),
    }
  }

  private agentResultsFromCheckpoint(
    snapshot: CheckpointSnapshot,
    queue: TaskQueue,
  ): Map<string, AgentRunResult> {
    const taskById = new Map(queue.list().map((task) => [task.id, task]))
    const agentResults = new Map<string, AgentRunResult>()

    for (const completed of snapshot.completedTaskResults) {
      const task = taskById.get(completed.taskId)
      const assignee = completed.assignee ?? task?.assignee ?? 'unknown'
      const output = completed.result ?? task?.result ?? ''
      agentResults.set(`${assignee}:${completed.taskId}`, {
        success: true,
        output,
        messages: [],
        tokenUsage: ZERO_USAGE,
        toolCalls: [],
      })
    }

    return agentResults
  }

  private isPlanArtifact(value: unknown): value is PlanArtifact {
    if (value === null || typeof value !== 'object') return false
    const artifact = value as Record<string, unknown>
    return artifact['version'] === 1 && Array.isArray(artifact['tasks'])
  }

  /**
   * Load a list of task specs into a queue.
   *
   * Handles title-based `dependsOn` references by building a title→id map first,
   * then resolving them to real IDs before adding tasks to the queue.
   */
  private loadSpecsIntoQueue(
    specs: ReadonlyArray<ParsedTaskSpec & {
      memoryScope?: 'dependencies' | 'all'
      maxRetries?: number
      retryDelayMs?: number
      retryBackoff?: number
      role?: string
      priority?: 'low' | 'normal' | 'high' | 'critical'
    }>,
    agentConfigs: AgentConfig[],
    queue: TaskQueue,
    verifyJudges?: readonly AgentConfig[],
  ): void {
    const agentNames = new Set(agentConfigs.map((a) => a.name))
    const normalizeTitle = (title: string): string => title.toLowerCase().trim()
    const titleCounts = new Map<string, number>()
    for (const spec of specs) {
      const key = normalizeTitle(spec.title)
      titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1)
    }

    // First pass: create tasks (without dependencies) to get stable IDs.
    const titleToId = new Map<string, string>()
    const createdTasks: Task[] = []

    for (const spec of specs) {
      const task = createTask({
        title: spec.title,
        description: spec.description,
        assignee: spec.assignee && agentNames.has(spec.assignee)
          ? spec.assignee
          : undefined,
        memoryScope: spec.memoryScope,
        maxRetries: spec.maxRetries,
        retryDelayMs: spec.retryDelayMs,
        retryBackoff: spec.retryBackoff,
        role: spec.role,
        priority: spec.priority,
        verify: resolveVerify(spec.verify, verifyJudges),
      })
      const titleKey = normalizeTitle(spec.title)
      if ((titleCounts.get(titleKey) ?? 0) === 1) {
        titleToId.set(titleKey, task.id)
      }
      createdTasks.push(task)
    }

    // Second pass: resolve title-based dependsOn to IDs.
    for (let i = 0; i < createdTasks.length; i++) {
      const spec = specs[i]!
      const task = createdTasks[i]!

      if (!spec.dependsOn || spec.dependsOn.length === 0) {
        queue.add(task)
        continue
      }

      const resolvedDeps: string[] = []
      const unresolvedDeps: string[] = []
      for (const depRef of spec.dependsOn) {
        // Accept both raw IDs and title strings
        const byId = createdTasks.find((t) => t.id === depRef)
        const depTitleKey = normalizeTitle(depRef)
        const byTitle = titleToId.get(depTitleKey)
        const resolvedId = byId?.id ?? byTitle
        if (resolvedId) {
          resolvedDeps.push(resolvedId)
        } else {
          const count = titleCounts.get(depTitleKey) ?? 0
          unresolvedDeps.push(count > 1 ? `${depRef} (ambiguous duplicate title)` : depRef)
        }
      }

      const taskWithDeps: Task = {
        ...task,
        dependsOn: resolvedDeps.length > 0 ? resolvedDeps : undefined,
      }
      queue.add(taskWithDeps)
      if (unresolvedDeps.length > 0) {
        queue.fail(
          task.id,
          `Unresolved dependency reference(s): ${unresolvedDeps.join(', ')}`,
        )
      }
    }
  }

  /** Build an {@link AgentPool} from a list of agent configurations. */
  private buildPool(agentConfigs: AgentConfig[]): AgentPool {
    const pool = new AgentPool(this.config.maxConcurrency)
    for (const config of agentConfigs) {
      const effective: AgentConfig = applyDefaultToolPreset({
        ...config,
        model: config.model ?? this.config.defaultModel,
        provider: config.provider ?? this.config.defaultProvider,
        baseURL: config.baseURL ?? this.config.defaultBaseURL,
        apiKey: config.apiKey ?? this.config.defaultApiKey,
        cwd: config.cwd === undefined ? this.config.defaultCwd : config.cwd,
        onToolCall: config.onToolCall ?? this.config.onToolCall,
      }, this.config.defaultToolPreset)
      pool.add(buildAgent(effective, { includeDelegateTool: true }))
    }
    return pool
  }

  /**
   * Aggregate the per-run `agentResults` map into a {@link TeamRunResult}.
   *
   * Merges results keyed as `agentName:taskId` back into a per-agent map
   * by agent name for the public result surface.
   *
   * Only non-coordinator entries are counted toward `completedTaskCount` to
   * avoid double-counting the coordinator's internal decompose/synthesis steps.
   */
  private buildTeamRunResult(
    agentResults: Map<string, AgentRunResult>,
    identity: RunIdentity,
    goal?: string,
    tasks?: readonly TaskExecutionRecord[],
    forcedStatus?: RunStatus,
    forcedErrorInfo?: StructuredTraceError,
  ): TeamRunResult {
    let totalUsage: TokenUsage = ZERO_USAGE
    let overallSuccess = true
    const collapsed = new Map<string, AgentRunResult>()

    for (const [key, result] of agentResults) {
      // Strip the `:taskId` suffix to get the agent name
      const agentName = key.includes(':') ? key.split(':')[0]! : key

      totalUsage = addUsage(totalUsage, result.tokenUsage)
      if (!result.success) overallSuccess = false

      const existing = collapsed.get(agentName)
      if (!existing) {
        collapsed.set(agentName, result)
      } else {
        // Merge multiple results for the same agent (multi-task case).
        // Keep the latest `structured` value (last completed task wins).
        collapsed.set(agentName, {
          success: existing.success && result.success,
          identity,
          status: existing.success && result.success
            ? statusOnly('ok')
            : result.status ?? existing.status ?? statusOnly('error'),
          ...(result.errorInfo ?? existing.errorInfo
            ? { errorInfo: result.errorInfo ?? existing.errorInfo }
            : {}),
          output: [existing.output, result.output].filter(Boolean).join('\n\n---\n\n'),
          messages: [...existing.messages, ...result.messages],
          tokenUsage: addUsage(existing.tokenUsage, result.tokenUsage),
          toolCalls: [...existing.toolCalls, ...result.toolCalls],
          structured: result.structured !== undefined ? result.structured : existing.structured,
        })
      }

      // Only count actual user tasks — skip coordinator meta-entries
      // (keys that start with 'coordinator') to avoid double-counting.
      if (result.success && !key.startsWith('coordinator')) {
        this.completedTaskCount++
      }
    }

    const metrics = computeRunMetrics(tasks)

    const statuses = [...agentResults.values()]
      .map((result) => result.status)
      .filter((status): status is RunStatus => status !== undefined)
    const firstStatus = (code: RunStatus['code']) => statuses.find((status) => status.code === code)
    const taskFailed = tasks?.some((task) => task.status === 'failed') ?? false
    const status = forcedStatus
      ?? firstStatus('budget_exhausted')
      ?? firstStatus('timeout')
      ?? firstStatus('cancelled')
      ?? (overallSuccess && !taskFailed ? statusOnly('ok') : statusOnly('error'))
    const errorInfo = forcedErrorInfo ?? [...agentResults.values()]
      .find((result) => result.status?.code === status.code && result.errorInfo !== undefined)
      ?.errorInfo

    return {
      success: status.code === 'ok',
      identity,
      status,
      ...(errorInfo !== undefined ? { errorInfo } : {}),
      goal,
      tasks,
      agentResults: collapsed,
      totalTokenUsage: totalUsage,
      metrics,
    }
  }
}
