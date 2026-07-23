/**
 * @fileoverview Task scheduling strategies for the open-multi-agent orchestrator.
 *
 * The {@link Scheduler} class encapsulates five distinct strategies for
 * mapping a set of pending {@link Task}s onto a pool of available agents:
 *
 * - `round-robin`        — Distribute tasks evenly across agents by index.
 * - `least-busy`         — Assign to whichever agent has the fewest active tasks.
 * - `capability-match`   — Filter explicit requirements, then score capability/keyword affinity.
 * - `dependency-first`   — Prioritise tasks on the critical path (most blocked dependents).
 * - `composite`          — Combine criticality, capability fit, and current load.
 *
 * The scheduler retains only a round-robin cursor between calls. All mutable
 * task state lives in the {@link TaskQueue} passed to
 * {@link Scheduler.autoAssign}.
 */

import type { AgentConfig, Task } from '../types.js'
import type { TaskQueue } from '../task/queue.js'
import {
  AgentSelector,
  type AgentSelectorContext,
} from './agent-selector.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The five scheduling strategies available to the {@link Scheduler}.
 *
 * - `round-robin`       — Equal distribution by agent index.
 * - `least-busy`        — Prefers the agent with the fewest `in_progress` tasks.
 * - `capability-match`  — Explicit requirements plus capability/keyword affinity.
 * - `dependency-first`  — Prioritise tasks that unblock the most other tasks.
 * - `composite`         — Criticality ordering plus weighted fit and current load.
 *
 * `dependency-first` is the orchestrator default and suits dependency-heavy
 * DAGs. Use `round-robin` for interchangeable agents, `least-busy` for uneven
 * task durations, `capability-match` for clearly differentiated roles, and
 * `composite` when criticality, eligibility, fit, and load should work together.
 */
export type SchedulingStrategy =
  | 'round-robin'
  | 'least-busy'
  | 'capability-match'
  | 'dependency-first'
  | 'composite'

/** Relative weights used by the composite scheduling strategy. */
export interface SchedulingWeights {
  /** AgentSelector fit weight. Defaults to `0.7`. */
  readonly fit: number
  /** Available-capacity (`1 - normalizedLoad`) weight. Defaults to `0.3`. */
  readonly load: number
}

/** Default composite weights: fit is primary, current load is secondary. */
export const DEFAULT_SCHEDULING_WEIGHTS: SchedulingWeights = {
  fit: 0.7,
  load: 0.3,
}

export interface SchedulerWarning {
  /** Stable machine-readable warning code inherited from AgentSelector. */
  readonly code: 'NO_ELIGIBLE_AGENT'
  readonly message: string
  readonly taskId: string
  readonly taskTitle: string
  readonly reasons: readonly string[]
  /** Explicit compatibility fallback selected after hard filtering failed. */
  readonly fallback: 'zero-fit-current-load'
}

export interface SchedulerOptions {
  /** Per-field composite overrides; omitted fields use the documented defaults. */
  readonly weights?: Partial<SchedulingWeights>
  /** Receives structured scheduler degradations without changing assignments. */
  readonly onWarning?: (warning: SchedulerWarning) => void
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Count how many tasks in `allTasks` are (transitively) blocked waiting for
 * `taskId` to complete. Used by the `dependency-first` strategy to compute
 * the "criticality" of each pending task.
 *
 * The algorithm is a forward BFS over the dependency graph: for each task
 * whose `dependsOn` includes `taskId`, we add it to the result set and
 * recurse — without revisiting nodes.
 */
function countBlockedDependents(taskId: string, allTasks: Task[]): number {
  const idToTask = new Map<string, Task>(allTasks.map((t) => [t.id, t]))
  // Build reverse adjacency: dependencyId -> tasks that depend on it
  const dependents = new Map<string, string[]>()
  for (const t of allTasks) {
    for (const depId of t.dependsOn ?? []) {
      const list = dependents.get(depId) ?? []
      list.push(t.id)
      dependents.set(depId, list)
    }
  }

  const visited = new Set<string>()
  const queue: string[] = [taskId]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const depId of dependents.get(current) ?? []) {
      if (!visited.has(depId) && idToTask.has(depId)) {
        visited.add(depId)
        queue.push(depId)
      }
    }
  }
  // Exclude the seed task itself from the count
  return visited.size
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/**
 * Maps pending tasks to available agents using one of five configurable strategies.
 *
 * @example
 * ```ts
 * const scheduler = new Scheduler('capability-match')
 *
 * // Get a full assignment map from tasks to agent names
 * const assignments = scheduler.schedule(pendingTasks, teamAgents)
 *
 * // Or let the scheduler directly update a TaskQueue
 * scheduler.autoAssign(queue, teamAgents)
 * ```
 */
export class Scheduler {
  /** Rolling cursor used by round-robin strategies and fallbacks. */
  private roundRobinCursor = 0

  /**
   * @param strategy - The scheduling algorithm to apply. Defaults to
   *                   `'dependency-first'` which is the safest default for
   *                   complex multi-step pipelines.
   */
  constructor(
    private readonly strategy: SchedulingStrategy = 'dependency-first',
    private readonly selectorContext: AgentSelectorContext = {},
    private readonly options: SchedulerOptions = {},
  ) {
    if (strategy === 'composite') {
      const weights = this.resolvedWeights()
      if (
        !Number.isFinite(weights.fit)
        || !Number.isFinite(weights.load)
        || weights.fit < 0
        || weights.load < 0
        || (weights.fit === 0 && weights.load === 0)
      ) {
        throw new RangeError(
          'Scheduling weights must be finite, non-negative, and not both zero.',
        )
      }
    }
  }

  // -------------------------------------------------------------------------
  // Primary API
  // -------------------------------------------------------------------------

  /**
   * Given a list of pending `tasks` and `agents`, return a mapping from
   * `taskId` to `agentName` representing the recommended assignment.
   *
   * Only tasks without an existing `assignee` are considered. Tasks that are
   * already assigned are preserved unchanged.
   *
   * The method is deterministic except where a strategy uses the shared
   * round-robin cursor: the `round-robin` strategy and zero-score fallback in
   * `capability-match` advance it across successive calls.
   *
   * @param tasks  - Snapshot of all tasks in the current run (any status).
   * @param agents - Available agent configurations.
   * @returns A `Map<taskId, agentName>` for every unassigned pending task.
   */
  schedule(tasks: Task[], agents: AgentConfig[]): Map<string, string> {
    if (agents.length === 0) return new Map()

    const unassigned = tasks.filter(
      (t) => t.status === 'pending' && !t.assignee,
    )

    switch (this.strategy) {
      case 'round-robin':
        return this.scheduleRoundRobin(unassigned, agents)
      case 'least-busy':
        return this.scheduleLeastBusy(unassigned, agents, tasks)
      case 'capability-match':
        return this.scheduleCapabilityMatch(unassigned, agents)
      case 'dependency-first':
        return this.scheduleDependencyFirst(unassigned, agents, tasks)
      case 'composite':
        return this.scheduleComposite(unassigned, agents, tasks)
    }
  }

  /**
   * Convenience method that applies assignments returned by {@link schedule}
   * directly to a live `TaskQueue`.
   *
   * Iterates all pending, unassigned tasks in the queue and sets `assignee` for
   * each according to the current strategy. Skips tasks that are already
   * assigned, non-pending, or whose IDs are not found in the queue snapshot.
   *
   * @param queue  - The live task queue to mutate.
   * @param agents - Available agent configurations.
   */
  autoAssign(queue: TaskQueue, agents: AgentConfig[]): void {
    const allTasks = queue.list()
    const assignments = this.schedule(allTasks, agents)

    for (const [taskId, agentName] of assignments) {
      try {
        queue.update(taskId, { assignee: agentName })
      } catch {
        // Task may have been completed/failed between snapshot and now — skip.
      }
    }
  }

  // -------------------------------------------------------------------------
  // Strategy implementations
  // -------------------------------------------------------------------------

  /**
   * Round-robin: assign tasks to agents in order, cycling back to the start.
   *
   * The cursor advances with every call so that repeated calls with the same
   * task set continue distributing work — rather than always starting from
   * agent[0].
   */
  private scheduleRoundRobin(
    unassigned: Task[],
    agents: AgentConfig[],
  ): Map<string, string> {
    const result = new Map<string, string>()
    for (const task of unassigned) {
      const agent = agents[this.roundRobinCursor % agents.length]!
      result.set(task.id, agent.name)
      this.roundRobinCursor = (this.roundRobinCursor + 1) % agents.length
    }
    return result
  }

  /**
   * Least-busy: assign each task to the agent with the fewest `in_progress`
   * tasks at the time the schedule is computed.
   *
   * Agent load is derived from the `in_progress` count in `allTasks`. Ties are
   * broken by the agent's position in the `agents` array (earlier = preferred).
   */
  private scheduleLeastBusy(
    unassigned: Task[],
    agents: AgentConfig[],
    allTasks: Task[],
  ): Map<string, string> {
    // Build initial in-progress count per agent.
    const load = new Map<string, number>(agents.map((a) => [a.name, 0]))
    for (const task of allTasks) {
      if (task.status === 'in_progress' && task.assignee) {
        const current = load.get(task.assignee) ?? 0
        load.set(task.assignee, current + 1)
      }
    }

    const result = new Map<string, string>()
    for (const task of unassigned) {
      // Pick the agent with the lowest current load.
      let bestAgent = agents[0]!
      let bestLoad = load.get(bestAgent.name) ?? 0

      for (let i = 1; i < agents.length; i++) {
        const agent = agents[i]!
        const agentLoad = load.get(agent.name) ?? 0
        if (agentLoad < bestLoad) {
          bestLoad = agentLoad
          bestAgent = agent
        }
      }

      result.set(task.id, bestAgent.name)
      // Increment the simulated load so subsequent tasks in this batch avoid
      // piling onto the same agent.
      load.set(bestAgent.name, (load.get(bestAgent.name) ?? 0) + 1)
    }

    return result
  }

  /**
   * Capability-match: use {@link AgentSelector} to hard-filter explicit task
   * requirements, then score declared capabilities before legacy keyword
   * overlap. The highest-scoring eligible agent wins.
   *
   * The highest positive score wins; positive-score ties preserve agent roster
   * order. When every agent scores zero for a task, that task consumes the
   * shared round-robin cursor instead.
   */
  private scheduleCapabilityMatch(
    unassigned: Task[],
    agents: AgentConfig[],
  ): Map<string, string> {
    const result = new Map<string, string>()
    const selector = new AgentSelector()

    for (const task of unassigned) {
      const selection = selector.select({
        title: task.title,
        description: task.description,
        requires: task.requires,
      }, agents, this.selectorContext)
      if (selection.error) {
        throw new Error(
          `Scheduler capability-match: ${selection.error.code}: ${selection.error.reasons.join(' ')}`,
        )
      }

      // Preserve the legacy scheduler's roster-order tie-break while reusing
      // the selector's eligibility and scoring kernel. The public selector and
      // stateless short-circuit use ascending-name ties.
      let bestAgent = agents[0]!
      let bestScore = -1
      for (const agent of agents) {
        const scored = selection.eligible.find((entry) => entry.agent === agent)
        if (scored && scored.score > bestScore) {
          bestAgent = agent
          bestScore = scored.score
        }
      }

      if (bestScore === 0) {
        bestAgent = agents[this.roundRobinCursor % agents.length]!
        this.roundRobinCursor = (this.roundRobinCursor + 1) % agents.length
      }

      result.set(task.id, bestAgent.name)
    }

    return result
  }

  /**
   * Dependency-first: prioritise tasks by how many other tasks are blocked
   * waiting for them (the "critical path" heuristic).
   *
   * Tasks with more downstream dependents are assigned to agents first. Within
   * the same criticality tier the agents are selected round-robin so no single
   * agent is overloaded.
   */
  private scheduleDependencyFirst(
    unassigned: Task[],
    agents: AgentConfig[],
    allTasks: Task[],
  ): Map<string, string> {
    // Sort by descending blocked-dependent count so high-criticality tasks
    // get first choice of agents.
    const ranked = [...unassigned].sort((a, b) => {
      const critA = countBlockedDependents(a.id, allTasks)
      const critB = countBlockedDependents(b.id, allTasks)
      return critB - critA
    })

    const result = new Map<string, string>()
    let cursor = this.roundRobinCursor

    for (const task of ranked) {
      const agent = agents[cursor % agents.length]!
      result.set(task.id, agent.name)
      cursor = (cursor + 1) % agents.length
    }

    // Advance the shared cursor for consistency with round-robin.
    this.roundRobinCursor = cursor

    return result
  }

  /**
   * Composite: rank tasks by criticality, then choose an agent with
   * `fitWeight * selectorFit + loadWeight * (1 - normalizedCurrentLoad)`.
   *
   * Load is read only from the supplied DAG snapshot's `in_progress` tasks.
   * Assignments made earlier in this call are deliberately not folded into
   * load, keeping the decision compatible with future one-ready-task calls.
   *
   * When hard filtering leaves no eligible agent, the selector's structured
   * failure is emitted as a warning and the task follows an explicit zero-fit
   * fallback across the full roster, using current load and ascending agent
   * name as the deterministic tie-break.
   */
  private scheduleComposite(
    unassigned: Task[],
    agents: AgentConfig[],
    allTasks: Task[],
  ): Map<string, string> {
    const ranked = [...unassigned].sort((a, b) =>
      countBlockedDependents(b.id, allTasks)
      - countBlockedDependents(a.id, allTasks))
    const loads = new Map<string, number>(agents.map((agent) => [agent.name, 0]))
    for (const task of allTasks) {
      if (task.status === 'in_progress' && task.assignee && loads.has(task.assignee)) {
        loads.set(task.assignee, (loads.get(task.assignee) ?? 0) + 1)
      }
    }
    const maxLoad = Math.max(1, ...loads.values())
    const weights = this.resolvedWeights()
    const selector = new AgentSelector()
    const result = new Map<string, string>()

    for (const task of ranked) {
      const selection = selector.select({
        title: task.title,
        description: task.description,
        requires: task.requires,
      }, agents, this.selectorContext)
      const candidates = selection.error
        ? agents.map((agent) => ({ agent, score: 0 }))
        : selection.eligible

      if (selection.error) {
        this.options.onWarning?.({
          code: selection.error.code,
          message: selection.error.message,
          taskId: task.id,
          taskTitle: task.title,
          reasons: selection.error.reasons,
          fallback: 'zero-fit-current-load',
        })
      }

      const rankedCandidates = candidates.map((candidate) => {
        const normalizedLoad = (loads.get(candidate.agent.name) ?? 0) / maxLoad
        return {
          agent: candidate.agent,
          score:
            weights.fit * candidate.score
            + weights.load * (1 - normalizedLoad),
        }
      }).sort((left, right) => {
        const scoreOrder = right.score - left.score
        if (scoreOrder !== 0) return scoreOrder
        if (left.agent.name < right.agent.name) return -1
        if (left.agent.name > right.agent.name) return 1
        return 0
      })

      result.set(task.id, rankedCandidates[0]!.agent.name)
    }

    return result
  }

  private resolvedWeights(): SchedulingWeights {
    return {
      fit: this.options.weights?.fit ?? DEFAULT_SCHEDULING_WEIGHTS.fit,
      load: this.options.weights?.load ?? DEFAULT_SCHEDULING_WEIGHTS.load,
    }
  }
}
