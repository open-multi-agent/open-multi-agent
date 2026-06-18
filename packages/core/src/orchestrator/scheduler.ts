/**
 * @fileoverview Task scheduling strategies for the open-multi-agent orchestrator.
 *
 * The {@link Scheduler} class encapsulates four distinct strategies for
 * mapping a set of pending {@link Task}s onto a pool of available agents:
 *
 * - `round-robin`        — Distribute tasks evenly across agents by index.
 * - `least-busy`         — Assign to whichever agent has the fewest active tasks.
 * - `capability-match`   — Score agents by keyword overlap with the task description.
 * - `dependency-first`   — Prioritise tasks on the critical path (most blocked dependents).
 *
 * The scheduler is stateless between calls. All mutable task state lives in the
 * {@link TaskQueue} that is passed to {@link Scheduler.autoAssign}.
 */

import type { AgentConfig, Task } from '../types.js'
import type { TaskQueue } from '../task/queue.js'
import { extractKeywords, keywordScore } from '../utils/keywords.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The four scheduling strategies available to the {@link Scheduler}.
 *
 * - `round-robin`       — Equal distribution by agent index.
 * - `least-busy`        — Prefers the agent with the fewest `in_progress` tasks.
 * - `capability-match`  — Keyword-based affinity between task text and agent role.
 * - `dependency-first`  — Prioritise tasks that unblock the most other tasks.
 */
export type SchedulingStrategy =
  | 'round-robin'
  | 'least-busy'
  | 'capability-match'
  | 'dependency-first'

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
 * Maps pending tasks to available agents using one of four configurable strategies.
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
  /** Rolling cursor used by `round-robin` to distribute tasks sequentially. */
  private roundRobinCursor = 0

  /**
   * @param strategy - The scheduling algorithm to apply. Defaults to
   *                   `'dependency-first'` which is the safest default for
   *                   complex multi-step pipelines.
   */
  constructor(private readonly strategy: SchedulingStrategy = 'dependency-first') {}

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
   * The method is deterministic for all strategies except `round-robin`, which
   * advances an internal cursor and therefore produces different results across
   * successive calls with the same inputs.
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
   * Capability-match: score each agent against each task by keyword overlap
   * between the task's title/description and the agent's `systemPrompt` and
   * `name`. The highest-scoring agent wins.
   *
   * Falls back to round-robin when no agent has any positive score.
   */
  private scheduleCapabilityMatch(
    unassigned: Task[],
    agents: AgentConfig[],
  ): Map<string, string> {
    const result = new Map<string, string>()

    // Pre-compute keyword lists for each agent to avoid re-extracting per task.
    const agentKeywords = new Map<string, string[]>(
      agents.map((a) => [
        a.name,
        extractKeywords(`${a.name} ${a.systemPrompt ?? ''} ${a.model}`),
      ]),
    )

    for (const task of unassigned) {
      const taskText = `${task.title} ${task.description}`
      const taskKeywords = extractKeywords(taskText)

      let bestAgent = agents[0]!
      let bestScore = -1

      for (const agent of agents) {
        // Score in both directions: task keywords vs agent text, and agent
        // keywords vs task text, then take the max.
        const agentText = `${agent.name} ${agent.systemPrompt ?? ''}`
        const scoreA = keywordScore(agentText, taskKeywords)
        const scoreB = keywordScore(taskText, agentKeywords.get(agent.name) ?? [])
        const score = scoreA + scoreB

        if (score > bestScore) {
          bestScore = score
          bestAgent = agent
        }
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
}
