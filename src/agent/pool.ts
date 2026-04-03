/**
 * @fileoverview Agent pool for managing and scheduling multiple agents.
 *
 * {@link AgentPool} is a registry + scheduler that:
 *  - Holds any number of named {@link Agent} instances
 *  - Enforces a concurrency cap across parallel runs via {@link Semaphore}
 *  - Provides `runParallel` for fan-out and `runAny` for round-robin dispatch
 *  - Reports aggregate pool health via `getStatus()`
 *
 * @example
 * ```ts
 * const pool = new AgentPool(3)
 * pool.add(researchAgent)
 * pool.add(writerAgent)
 *
 * const results = await pool.runParallel([
 *   { agent: 'researcher', prompt: 'Find recent AI papers.' },
 *   { agent: 'writer',     prompt: 'Draft an intro section.' },
 * ])
 * ```
 */

import type { AgentRunResult } from '../types.js'
import type { RunOptions } from './runner.js'
import type { Agent } from './agent.js'
import { Semaphore } from '../utils/semaphore.js'

export { Semaphore } from '../utils/semaphore.js'

// ---------------------------------------------------------------------------
// Pool status snapshot
// ---------------------------------------------------------------------------

export interface PoolStatus {
  /** Total number of agents registered in the pool. */
  readonly total: number
  /** Agents currently in `idle` state. */
  readonly idle: number
  /** Agents currently in `running` state. */
  readonly running: number
  /** Agents currently in `completed` state. */
  readonly completed: number
  /** Agents currently in `error` state. */
  readonly error: number
}

// ---------------------------------------------------------------------------
// AgentPool
// ---------------------------------------------------------------------------

/**
 * Registry and scheduler for a collection of {@link Agent} instances.
 *
 * Thread-safety note: Node.js is single-threaded, so the semaphore approach
 * is safe — no atomics or mutex primitives are needed. The semaphore gates
 * concurrent async operations, not CPU threads.
 */
export class AgentPool {
  private readonly agents: Map<string, Agent> = new Map()
  private readonly semaphore: Semaphore
  /** Cursor used by `runAny` for round-robin dispatch. */
  private roundRobinIndex = 0

  /**
   * @param maxConcurrency - Maximum number of agent runs allowed at the same
   *                         time across the whole pool. Defaults to `5`.
   */
  constructor(private readonly maxConcurrency: number = 5) {
    this.semaphore = new Semaphore(maxConcurrency)
  }

  // -------------------------------------------------------------------------
  // Registry operations
  // -------------------------------------------------------------------------

  /**
   * Register an agent with the pool.
   *
   * @throws {Error} If an agent with the same name is already registered.
   */
  add(agent: Agent): void {
    if (this.agents.has(agent.name)) {
      throw new Error(
        `AgentPool: agent '${agent.name}' is already registered. ` +
        `Call remove('${agent.name}') before re-adding.`,
      )
    }
    this.agents.set(agent.name, agent)
  }

  /**
   * Unregister an agent by name.
   *
   * @throws {Error} If the agent is not found.
   */
  remove(name: string): void {
    if (!this.agents.has(name)) {
      throw new Error(`AgentPool: agent '${name}' is not registered.`)
    }
    this.agents.delete(name)
  }

  /**
   * Retrieve a registered agent by name, or `undefined` if not found.
   */
  get(name: string): Agent | undefined {
    return this.agents.get(name)
  }

  /**
   * Return all registered agents in insertion order.
   */
  list(): Agent[] {
    return Array.from(this.agents.values())
  }

  // -------------------------------------------------------------------------
  // Execution API
  // -------------------------------------------------------------------------

  /**
   * Run a single prompt on the named agent, respecting the pool concurrency
   * limit.
   *
   * @throws {Error} If the agent name is not found.
   */
  async run(
    agentName: string,
    prompt: string,
    runOptions?: Partial<RunOptions>,
  ): Promise<AgentRunResult> {
    const agent = this.requireAgent(agentName)

    await this.semaphore.acquire()
    try {
      return await agent.run(prompt, runOptions)
    } finally {
      this.semaphore.release()
    }
  }

  /**
   * Run prompts on multiple agents in parallel, subject to the concurrency
   * cap set at construction time.
   *
   * Results are returned as a `Map<agentName, AgentRunResult>`. If two tasks
   * target the same agent name, the map will only contain the last result.
   * Use unique agent names or run tasks sequentially in that case.
   *
   * @param tasks - Array of `{ agent, prompt }` descriptors.
   */
  // TODO(#18): accept RunOptions per task to forward trace context
  async runParallel(
    tasks: ReadonlyArray<{ readonly agent: string; readonly prompt: string }>,
  ): Promise<Map<string, AgentRunResult>> {
    const resultMap = new Map<string, AgentRunResult>()

    const settledResults = await Promise.allSettled(
      tasks.map(async task => {
        const result = await this.run(task.agent, task.prompt)
        return { name: task.agent, result }
      }),
    )

    for (const settled of settledResults) {
      if (settled.status === 'fulfilled') {
        resultMap.set(settled.value.name, settled.value.result)
      } else {
        // A rejected run is surfaced as an error AgentRunResult so the caller
        // sees it in the map rather than needing to catch Promise.allSettled.
        // We cannot know the agent name from the rejection alone — find it via
        // the original task list index.
        const idx = settledResults.indexOf(settled)
        const agentName = tasks[idx]?.agent ?? 'unknown'
        resultMap.set(agentName, this.errorResult(settled.reason))
      }
    }

    return resultMap
  }

  /**
   * Run a prompt on the "best available" agent using round-robin selection.
   *
   * Agents are selected in insertion order, cycling back to the start. The
   * concurrency limit is still enforced — if the selected agent is busy the
   * call will queue via the semaphore.
   *
   * @throws {Error} If the pool is empty.
   */
  // TODO(#18): accept RunOptions to forward trace context
  async runAny(prompt: string): Promise<AgentRunResult> {
    const allAgents = this.list()
    if (allAgents.length === 0) {
      throw new Error('AgentPool: cannot call runAny on an empty pool.')
    }

    // Wrap the index to keep it in bounds even if agents were removed.
    this.roundRobinIndex = this.roundRobinIndex % allAgents.length
    const agent = allAgents[this.roundRobinIndex]!
    this.roundRobinIndex = (this.roundRobinIndex + 1) % allAgents.length

    await this.semaphore.acquire()
    try {
      return await agent.run(prompt)
    } finally {
      this.semaphore.release()
    }
  }

  // -------------------------------------------------------------------------
  // Observability
  // -------------------------------------------------------------------------

  /**
   * Snapshot of how many agents are in each lifecycle state.
   */
  getStatus(): PoolStatus {
    let idle = 0
    let running = 0
    let completed = 0
    let error = 0

    for (const agent of this.agents.values()) {
      switch (agent.getState().status) {
        case 'idle':      idle++;      break
        case 'running':   running++;   break
        case 'completed': completed++; break
        case 'error':     error++;     break
      }
    }

    return { total: this.agents.size, idle, running, completed, error }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Reset all agents in the pool.
   *
   * Clears their conversation histories and returns them to `idle` state.
   * Does not remove agents from the pool.
   *
   * Async for forward compatibility — shutdown may need to perform async
   * cleanup (e.g. draining in-flight requests) in future versions.
   */
  async shutdown(): Promise<void> {
    for (const agent of this.agents.values()) {
      agent.reset()
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private requireAgent(name: string): Agent {
    const agent = this.agents.get(name)
    if (agent === undefined) {
      throw new Error(
        `AgentPool: agent '${name}' is not registered. ` +
        `Registered agents: [${Array.from(this.agents.keys()).join(', ')}]`,
      )
    }
    return agent
  }

  /**
   * Build a failure {@link AgentRunResult} from a caught rejection reason.
   * This keeps `runParallel` returning a complete map even when individual
   * agents fail.
   */
  private errorResult(reason: unknown): AgentRunResult {
    const message = reason instanceof Error ? reason.message : String(reason)
    return {
      success: false,
      output: message,
      messages: [],
      tokenUsage: { input_tokens: 0, output_tokens: 0 },
      toolCalls: [],
    }
  }
}
