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
  OrchestratorConfig,
  OrchestratorEvent,
  Task,
  TaskStatus,
  TeamConfig,
  TeamRunResult,
  TokenUsage,
} from '../types.js'
import type { RunOptions } from '../agent/runner.js'
import { Agent } from '../agent/agent.js'
import { AgentPool } from '../agent/pool.js'
import { emitTrace, generateRunId } from '../utils/trace.js'
import { ToolRegistry } from '../tool/framework.js'
import { ToolExecutor } from '../tool/executor.js'
import { registerBuiltInTools } from '../tool/built-in/index.js'
import { Team } from '../team/team.js'
import { TaskQueue } from '../task/queue.js'
import { createTask } from '../task/task.js'
import { Scheduler } from './scheduler.js'

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const ZERO_USAGE: TokenUsage = { input_tokens: 0, output_tokens: 0 }
const DEFAULT_MAX_CONCURRENCY = 5
const DEFAULT_MODEL = 'claude-opus-4-6'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
  }
}

/**
 * Build a minimal {@link Agent} with its own fresh registry/executor.
 * Registers all built-in tools so coordinator/worker agents can use them.
 */
function buildAgent(config: AgentConfig): Agent {
  const registry = new ToolRegistry()
  registerBuiltInTools(registry)
  const executor = new ToolExecutor(registry)
  return new Agent(config, registry, executor)
}

/** Promise-based delay. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
 * @param run      - The function that executes the task (typically `pool.run`).
 * @param task     - The task to execute (retry config read from its fields).
 * @param onRetry  - Called before each retry sleep with event data.
 * @param delayFn  - Injectable delay function (defaults to real `sleep`).
 * @returns The final {@link AgentRunResult} from the last attempt.
 */
export async function executeWithRetry(
  run: () => Promise<AgentRunResult>,
  task: Task,
  onRetry?: (data: { attempt: number; maxAttempts: number; error: string; nextDelayMs: number }) => void,
  delayFn: (ms: number) => Promise<void> = sleep,
): Promise<AgentRunResult> {
  const rawRetries = Number.isFinite(task.maxRetries) ? task.maxRetries! : 0
  const maxAttempts = Math.max(0, rawRetries) + 1
  const baseDelay = Math.max(0, Number.isFinite(task.retryDelayMs) ? task.retryDelayMs! : 1000)
  const backoff = Math.max(1, Number.isFinite(task.retryBackoff) ? task.retryBackoff! : 2)

  let lastError: string = ''
  // Accumulate token usage across all attempts so billing/observability
  // reflects the true cost of retries.
  let totalUsage: TokenUsage = { input_tokens: 0, output_tokens: 0 }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await run()
      totalUsage = {
        input_tokens: totalUsage.input_tokens + result.tokenUsage.input_tokens,
        output_tokens: totalUsage.output_tokens + result.tokenUsage.output_tokens,
      }

      if (result.success) {
        return { ...result, tokenUsage: totalUsage }
      }
      lastError = result.output

      // Failure — retry or give up
      if (attempt < maxAttempts) {
        const delay = computeRetryDelay(baseDelay, backoff, attempt)
        onRetry?.({ attempt, maxAttempts, error: lastError, nextDelayMs: delay })
        await delayFn(delay)
        continue
      }

      return { ...result, tokenUsage: totalUsage }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)

      if (attempt < maxAttempts) {
        const delay = computeRetryDelay(baseDelay, backoff, attempt)
        onRetry?.({ attempt, maxAttempts, error: lastError, nextDelayMs: delay })
        await delayFn(delay)
        continue
      }

      // All retries exhausted — return a failure result
      return {
        success: false,
        output: lastError,
        messages: [],
        tokenUsage: totalUsage,
        toolCalls: [],
      }
    }
  }

  // Should not be reached, but TypeScript needs a return
  return {
    success: false,
    output: lastError,
    messages: [],
    tokenUsage: totalUsage,
    toolCalls: [],
  }
}

// ---------------------------------------------------------------------------
// Parsed task spec (result of coordinator decomposition)
// ---------------------------------------------------------------------------

interface ParsedTaskSpec {
  title: string
  description: string
  assignee?: string
  dependsOn?: string[]
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
      })
    }

    return specs.length > 0 ? specs : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Orchestration loop
// ---------------------------------------------------------------------------

/**
 * Internal execution context assembled once per `runTeam` / `runTasks` call.
 */
interface RunContext {
  readonly team: Team
  readonly pool: AgentPool
  readonly scheduler: Scheduler
  readonly agentResults: Map<string, AgentRunResult>
  readonly config: OrchestratorConfig
  /** Trace run ID, present when `onTrace` is configured. */
  readonly runId?: string
  /** AbortSignal for run-level cancellation. Checked between task dispatch rounds. */
  readonly abortSignal?: AbortSignal
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
      // Mark all remaining pending tasks as skipped.
      for (const t of queue.getByStatus('pending')) {
        queue.update(t.id, { status: 'skipped' as TaskStatus })
      }
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

      const assignee = task.assignee
      if (!assignee) {
        // No assignee — mark failed and continue
        const msg = `Task "${task.title}" has no assignee.`
        queue.fail(task.id, msg)
        config.onProgress?.({
          type: 'error',
          task: task.id,
          data: msg,
        } satisfies OrchestratorEvent)
        return
      }

      const agent = pool.get(assignee)
      if (!agent) {
        const msg = `Agent "${assignee}" not found in pool for task "${task.title}".`
        queue.fail(task.id, msg)
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

      // Build the prompt: inject shared memory context + task description
      const prompt = await buildTaskPrompt(task, team)

      // Build trace context for this task's agent run
      const traceOptions: Partial<RunOptions> | undefined = config.onTrace
        ? { onTrace: config.onTrace, runId: ctx.runId ?? '', taskId: task.id, traceAgent: assignee, abortSignal: ctx.abortSignal }
        : ctx.abortSignal ? { abortSignal: ctx.abortSignal } : undefined

      const taskStartMs = config.onTrace ? Date.now() : 0
      let retryCount = 0

      const result = await executeWithRetry(
        () => pool.run(assignee, prompt, traceOptions),
        task,
        (retryData) => {
          retryCount++
          config.onProgress?.({
            type: 'task_retry',
            task: task.id,
            agent: assignee,
            data: retryData,
          } satisfies OrchestratorEvent)
        },
      )

      // Emit task trace
      if (config.onTrace) {
        const taskEndMs = Date.now()
        emitTrace(config.onTrace, {
          type: 'task',
          runId: ctx.runId ?? '',
          taskId: task.id,
          taskTitle: task.title,
          agent: assignee,
          success: result.success,
          retries: retryCount,
          startMs: taskStartMs,
          endMs: taskEndMs,
          durationMs: taskEndMs - taskStartMs,
        })
      }

      ctx.agentResults.set(`${assignee}:${task.id}`, result)

      if (result.success) {
        // Persist result into shared memory so other agents can read it
        const sharedMem = team.getSharedMemoryInstance()
        if (sharedMem) {
          await sharedMem.write(assignee, `task:${task.id}:result`, result.output)
        }

        const completedTask = queue.complete(task.id, result.output)
        completedThisRound.push(completedTask)

        config.onProgress?.({
          type: 'task_complete',
          task: task.id,
          agent: assignee,
          data: result,
        } satisfies OrchestratorEvent)

        config.onProgress?.({
          type: 'agent_complete',
          agent: assignee,
          task: task.id,
          data: result,
        } satisfies OrchestratorEvent)
      } else {
        queue.fail(task.id, result.output)
        config.onProgress?.({
          type: 'error',
          task: task.id,
          agent: assignee,
          data: result,
        } satisfies OrchestratorEvent)
      }
    })

    // Wait for the entire parallel batch before checking for newly-unblocked tasks.
    await Promise.all(dispatchPromises)

    // --- Approval gate ---
    // After the batch completes, check if the caller wants to approve
    // the next round before it starts.
    if (config.onApproval && completedThisRound.length > 0) {
      scheduler.autoAssign(queue, team.getAgents())
      const nextPending = queue.getByStatus('pending')

      if (nextPending.length > 0) {
        let approved: boolean
        try {
          approved = await config.onApproval(completedThisRound, nextPending)
        } catch (err) {
          const reason = `Skipped: approval callback error — ${err instanceof Error ? err.message : String(err)}`
          queue.skipRemaining(reason)
          break
        }
        if (!approved) {
          queue.skipRemaining('Skipped: approval rejected.')
          break
        }
      }
    }
  }

  unsubSkipped?.()
}

/**
 * Build the agent prompt for a specific task.
 *
 * Injects:
 *  - Task title and description
 *  - Dependency results from shared memory (if available)
 *  - Any messages addressed to this agent from the team bus
 */
async function buildTaskPrompt(task: Task, team: Team): Promise<string> {
  const lines: string[] = [
    `# Task: ${task.title}`,
    '',
    task.description,
  ]

  // Inject shared memory summary so the agent sees its teammates' work
  const sharedMem = team.getSharedMemoryInstance()
  if (sharedMem) {
    const summary = await sharedMem.getSummary()
    if (summary) {
      lines.push('', summary)
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
    Omit<OrchestratorConfig, 'onApproval' | 'onProgress' | 'onTrace' | 'defaultBaseURL' | 'defaultApiKey'>
  > & Pick<OrchestratorConfig, 'onApproval' | 'onProgress' | 'onTrace' | 'defaultBaseURL' | 'defaultApiKey'>

  private readonly teams: Map<string, Team> = new Map()
  private completedTaskCount = 0

  /**
   * @param config - Optional top-level configuration.
   *
   * Sensible defaults:
   *   - `maxConcurrency`: 5
   *   - `defaultModel`:   `'claude-opus-4-6'`
   *   - `defaultProvider`: `'anthropic'`
   */
  constructor(config: OrchestratorConfig = {}) {
    this.config = {
      maxConcurrency: config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
      defaultModel: config.defaultModel ?? DEFAULT_MODEL,
      defaultProvider: config.defaultProvider ?? 'anthropic',
      defaultBaseURL: config.defaultBaseURL,
      defaultApiKey: config.defaultApiKey,
      onApproval: config.onApproval,
      onProgress: config.onProgress,
      onTrace: config.onTrace,
    }
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
  async runAgent(config: AgentConfig, prompt: string): Promise<AgentRunResult> {
    const effective: AgentConfig = {
      ...config,
      provider: config.provider ?? this.config.defaultProvider,
      baseURL: config.baseURL ?? this.config.defaultBaseURL,
      apiKey: config.apiKey ?? this.config.defaultApiKey,
    }
    const agent = buildAgent(effective)
    this.config.onProgress?.({
      type: 'agent_start',
      agent: config.name,
      data: { prompt },
    })

    const traceOptions: Partial<RunOptions> | undefined = this.config.onTrace
      ? { onTrace: this.config.onTrace, runId: generateRunId(), traceAgent: config.name }
      : undefined

    const result = await agent.run(prompt, traceOptions)

    this.config.onProgress?.({
      type: 'agent_complete',
      agent: config.name,
      data: result,
    })

    if (result.success) {
      this.completedTaskCount++
    }

    return result
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
  async runTeam(team: Team, goal: string, options?: { abortSignal?: AbortSignal }): Promise<TeamRunResult> {
    const agentConfigs = team.getAgents()

    // ------------------------------------------------------------------
    // Step 1: Coordinator decomposes goal into tasks
    // ------------------------------------------------------------------
    const coordinatorConfig: AgentConfig = {
      name: 'coordinator',
      model: this.config.defaultModel,
      provider: this.config.defaultProvider,
      baseURL: this.config.defaultBaseURL,
      apiKey: this.config.defaultApiKey,
      systemPrompt: this.buildCoordinatorSystemPrompt(agentConfigs),
      maxTurns: 3,
    }

    const decompositionPrompt = this.buildDecompositionPrompt(goal, agentConfigs)
    const coordinatorAgent = buildAgent(coordinatorConfig)
    const runId = this.config.onTrace ? generateRunId() : undefined

    this.config.onProgress?.({
      type: 'agent_start',
      agent: 'coordinator',
      data: { phase: 'decomposition', goal },
    })

    const decompTraceOptions: Partial<RunOptions> | undefined = this.config.onTrace
      ? { onTrace: this.config.onTrace, runId: runId ?? '', traceAgent: 'coordinator', abortSignal: options?.abortSignal }
      : options?.abortSignal ? { abortSignal: options.abortSignal } : undefined
    const decompositionResult = await coordinatorAgent.run(decompositionPrompt, decompTraceOptions)
    const agentResults = new Map<string, AgentRunResult>()
    agentResults.set('coordinator:decompose', decompositionResult)

    // ------------------------------------------------------------------
    // Step 2: Parse tasks from coordinator output
    // ------------------------------------------------------------------
    const taskSpecs = parseTaskSpecs(decompositionResult.output)

    const queue = new TaskQueue()
    const scheduler = new Scheduler('dependency-first')

    if (taskSpecs && taskSpecs.length > 0) {
      // Map title-based dependsOn references to real task IDs so we can
      // build the dependency graph before adding tasks to the queue.
      this.loadSpecsIntoQueue(taskSpecs, agentConfigs, queue)
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
    const ctx: RunContext = {
      team,
      pool,
      scheduler,
      agentResults,
      config: this.config,
      runId,
      abortSignal: options?.abortSignal,
    }

    await executeQueue(queue, ctx)

    // ------------------------------------------------------------------
    // Step 5: Coordinator synthesises final result
    // ------------------------------------------------------------------
    const synthesisPrompt = await this.buildSynthesisPrompt(goal, queue.list(), team)
    const synthTraceOptions: Partial<RunOptions> | undefined = this.config.onTrace
      ? { onTrace: this.config.onTrace, runId: runId ?? '', traceAgent: 'coordinator' }
      : undefined
    const synthesisResult = await coordinatorAgent.run(synthesisPrompt, synthTraceOptions)
    agentResults.set('coordinator', synthesisResult)

    this.config.onProgress?.({
      type: 'agent_complete',
      agent: 'coordinator',
      data: synthesisResult,
    })

    // Note: coordinator decompose and synthesis are internal meta-steps.
    // Only actual user tasks (non-coordinator keys) are counted in
    // buildTeamRunResult, so we do not increment completedTaskCount here.

    return this.buildTeamRunResult(agentResults)
  }

  // -------------------------------------------------------------------------
  // Explicit-task team run
  // -------------------------------------------------------------------------

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
    tasks: ReadonlyArray<{
      title: string
      description: string
      assignee?: string
      dependsOn?: string[]
      maxRetries?: number
      retryDelayMs?: number
      retryBackoff?: number
    }>,
    options?: { abortSignal?: AbortSignal },
  ): Promise<TeamRunResult> {
    const agentConfigs = team.getAgents()
    const queue = new TaskQueue()
    const scheduler = new Scheduler('dependency-first')

    this.loadSpecsIntoQueue(
      tasks.map((t) => ({
        title: t.title,
        description: t.description,
        assignee: t.assignee,
        dependsOn: t.dependsOn,
        maxRetries: t.maxRetries,
        retryDelayMs: t.retryDelayMs,
        retryBackoff: t.retryBackoff,
      })),
      agentConfigs,
      queue,
    )

    scheduler.autoAssign(queue, agentConfigs)

    const pool = this.buildPool(agentConfigs)
    const agentResults = new Map<string, AgentRunResult>()
    const ctx: RunContext = {
      team,
      pool,
      scheduler,
      agentResults,
      config: this.config,
      runId: this.config.onTrace ? generateRunId() : undefined,
      abortSignal: options?.abortSignal,
    }

    await executeQueue(queue, ctx)

    return this.buildTeamRunResult(agentResults)
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
  private buildCoordinatorSystemPrompt(agents: AgentConfig[]): string {
    const roster = agents
      .map(
        (a) =>
          `- **${a.name}** (${a.model}): ${a.systemPrompt?.slice(0, 120) ?? 'general purpose agent'}`,
      )
      .join('\n')

    return [
      'You are a task coordinator responsible for decomposing high-level goals',
      'into concrete, actionable tasks and assigning them to the right team members.',
      '',
      '## Team Roster',
      roster,
      '',
      '## Output Format',
      'When asked to decompose a goal, respond ONLY with a JSON array of task objects.',
      'Each task must have:',
      '  - "title":       Short descriptive title (string)',
      '  - "description": Full task description with context and expected output (string)',
      '  - "assignee":    One of the agent names listed in the roster (string)',
      '  - "dependsOn":   Array of titles of tasks this task depends on (string[], may be empty)',
      '',
      'Wrap the JSON in a ```json code fence.',
      'Do not include any text outside the code fence.',
      '',
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

  /**
   * Load a list of task specs into a queue.
   *
   * Handles title-based `dependsOn` references by building a title→id map first,
   * then resolving them to real IDs before adding tasks to the queue.
   */
  private loadSpecsIntoQueue(
    specs: ReadonlyArray<ParsedTaskSpec & {
      maxRetries?: number
      retryDelayMs?: number
      retryBackoff?: number
    }>,
    agentConfigs: AgentConfig[],
    queue: TaskQueue,
  ): void {
    const agentNames = new Set(agentConfigs.map((a) => a.name))

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
        maxRetries: spec.maxRetries,
        retryDelayMs: spec.retryDelayMs,
        retryBackoff: spec.retryBackoff,
      })
      titleToId.set(spec.title.toLowerCase().trim(), task.id)
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
      for (const depRef of spec.dependsOn) {
        // Accept both raw IDs and title strings
        const byId = createdTasks.find((t) => t.id === depRef)
        const byTitle = titleToId.get(depRef.toLowerCase().trim())
        const resolvedId = byId?.id ?? byTitle
        if (resolvedId) {
          resolvedDeps.push(resolvedId)
        }
      }

      const taskWithDeps: Task = {
        ...task,
        dependsOn: resolvedDeps.length > 0 ? resolvedDeps : undefined,
      }
      queue.add(taskWithDeps)
    }
  }

  /** Build an {@link AgentPool} from a list of agent configurations. */
  private buildPool(agentConfigs: AgentConfig[]): AgentPool {
    const pool = new AgentPool(this.config.maxConcurrency)
    for (const config of agentConfigs) {
      const effective: AgentConfig = {
        ...config,
        model: config.model,
        provider: config.provider ?? this.config.defaultProvider,
        baseURL: config.baseURL ?? this.config.defaultBaseURL,
        apiKey: config.apiKey ?? this.config.defaultApiKey,
      }
      pool.add(buildAgent(effective))
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

    return {
      success: overallSuccess,
      agentResults: collapsed,
      totalTokenUsage: totalUsage,
    }
  }
}
