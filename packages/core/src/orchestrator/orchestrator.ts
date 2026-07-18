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
  ModelRoutingPolicy,
  PlanArtifact,
  PlanTaskArtifact,
  OrchestratorConfig,
  OrchestratorEvent,
  RestoreOptions,
  RunAgentOptions,
  RunIdentity,
  RunStatus,
  StructuredTraceError,
  RunTaskSpec,
  RunTasksOptions,
  RunTeamOptions,
  Task,
  TaskExecutionMetrics,
  TaskExecutionRecord,
  TaskStatus,
  TeamConfig,
  TeamRunResult,
  TokenUsage,
} from '../types.js'
import type { RunOptions } from '../agent/runner.js'
import { Agent } from '../agent/agent.js'
import { AgentPool } from '../agent/pool.js'
import { emitTrace, generateSpanId } from '../utils/trace.js'
import { defaultWorkspaceDir } from '../tool/built-in/path-safety.js'
import { Team } from '../team/team.js'
import { TaskQueue } from '../task/queue.js'
import { Checkpoint } from '../memory/checkpoint.js'
import { InMemoryStore } from '../memory/store.js'
import { createTask, validateTaskDependencies } from '../task/task.js'
import { Scheduler } from './scheduler.js'
import { CostBudgetExceededError, TokenBudgetExceededError } from '../errors.js'
import {
  createRestoreIdentity,
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
import {
  ZERO_USAGE,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MAX_DELEGATION_DEPTH,
  DEFAULT_MODEL,
  addUsage,
  totalTokens,
  createRunFacts,
  identityOptionsForRun,
  metadataAttributes,
  type RunMetadata,
  type RunContext,
  type ActiveCheckpoint,
} from './run-context.js'
import {
  computeRunMetrics,
  resolveTokenBudget,
  buildCostEstimateContext,
  applyBudgetAccounting,
  emitBudgetExceeded,
} from './budget.js'
import {
  buildAgent,
  applyDefaultToolPreset,
  routeMatches,
  withModelRoute,
  isLeafTask,
} from './agent-config.js'
import { isSimpleGoal, selectBestAgent } from './short-circuit.js'
import { executeQueue, saveRunCheckpoint } from './task-execution.js'
import { runConsensusCore, applyConsensusDefaults, type ConsensusAgentDefaults } from './consensus.js'

// ---------------------------------------------------------------------------
// Re-exports — keep the public import surface stable after the split so callers
// (index.ts barrel and tests) can continue importing these from this module.
// ---------------------------------------------------------------------------

export { isSimpleGoal, selectBestAgent } from './short-circuit.js'
export { computeRetryDelay, executeWithRetry } from './retry.js'

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
