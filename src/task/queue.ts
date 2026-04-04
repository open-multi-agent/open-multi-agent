/**
 * @fileoverview Dependency-aware task queue.
 *
 * {@link TaskQueue} owns the mutable lifecycle of every task it holds.
 * Completing a task automatically unblocks dependents and fires events so
 * orchestrators can react without polling.
 */

import type { Task, TaskStatus } from '../types.js'
import { isTaskReady } from './task.js'

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

/** Named event types emitted by {@link TaskQueue}. */
export type TaskQueueEvent =
  | 'task:ready'
  | 'task:complete'
  | 'task:failed'
  | 'task:skipped'
  | 'all:complete'

/** Handler for `'task:ready' | 'task:complete' | 'task:failed'` events. */
type TaskHandler = (task: Task) => void
/** Handler for `'all:complete'` (no task argument). */
type AllCompleteHandler = () => void

type HandlerFor<E extends TaskQueueEvent> = E extends 'all:complete'
  ? AllCompleteHandler
  : TaskHandler

// ---------------------------------------------------------------------------
// TaskQueue
// ---------------------------------------------------------------------------

/**
 * Mutable, event-driven queue with topological dependency resolution.
 *
 * Tasks enter in `'pending'` state. The queue promotes them to `'blocked'`
 * when unresolved dependencies exist, and back to `'pending'` (firing
 * `'task:ready'`) when those dependencies complete. Callers drive execution by
 * calling {@link next} / {@link nextAvailable} and updating task state via
 * {@link complete} or {@link fail}.
 *
 * @example
 * ```ts
 * const queue = new TaskQueue()
 * queue.on('task:ready', (task) => scheduleExecution(task))
 * queue.on('all:complete', () => shutdown())
 *
 * queue.addBatch(tasks)
 * ```
 */
export class TaskQueue {
  private readonly tasks = new Map<string, Task>()

  /** Listeners keyed by event type, stored as symbol → handler pairs. */
  private readonly listeners = new Map<
    TaskQueueEvent,
    Map<symbol, TaskHandler | AllCompleteHandler>
  >()

  // ---------------------------------------------------------------------------
  // Mutation: add
  // ---------------------------------------------------------------------------

  /**
   * Adds a single task.
   *
   * If the task has unresolved dependencies it is immediately promoted to
   * `'blocked'`; otherwise it stays `'pending'` and `'task:ready'` fires.
   */
  add(task: Task): void {
    const resolved = this.resolveInitialStatus(task)
    this.tasks.set(resolved.id, resolved)
    if (resolved.status === 'pending') {
      this.emit('task:ready', resolved)
    }
  }

  /**
   * Adds multiple tasks at once.
   *
   * Processing each task re-evaluates the current map state, so inserting a
   * batch where some tasks satisfy others' dependencies produces correct initial
   * statuses when the dependencies appear first in the array. Use
   * {@link getTaskDependencyOrder} from `task.ts` to pre-sort if needed.
   */
  addBatch(tasks: Task[]): void {
    for (const task of tasks) {
      this.add(task)
    }
  }

  // ---------------------------------------------------------------------------
  // Mutation: update / complete / fail
  // ---------------------------------------------------------------------------

  /**
   * Applies a partial update to an existing task.
   *
   * Only `status`, `result`, and `assignee` are accepted to keep the update
   * surface narrow. Use {@link complete} and {@link fail} for terminal states.
   *
   * @throws {Error} when `taskId` is not found.
   */
  update(
    taskId: string,
    update: Partial<Pick<Task, 'status' | 'result' | 'assignee'>>,
  ): Task {
    const task = this.requireTask(taskId)
    const updated: Task = {
      ...task,
      ...update,
      updatedAt: new Date(),
    }
    this.tasks.set(taskId, updated)
    return updated
  }

  /**
   * Marks `taskId` as `'completed'`, records an optional `result` string, and
   * unblocks any dependents that are now ready to run.
   *
   * Fires `'task:complete'`, then `'task:ready'` for each newly-unblocked task,
   * then `'all:complete'` when the queue is fully resolved.
   *
   * @throws {Error} when `taskId` is not found.
   */
  complete(taskId: string, result?: string): Task {
    const completed = this.update(taskId, { status: 'completed', result })
    this.emit('task:complete', completed)
    this.unblockDependents(taskId)
    if (this.isComplete()) {
      this.emitAllComplete()
    }
    return completed
  }

  /**
   * Marks `taskId` as `'failed'` and records `error` in the `result` field.
   *
   * Fires `'task:failed'` for the failed task and for every downstream task
   * that transitively depended on it (cascade failure). This prevents blocked
   * tasks from remaining stuck indefinitely when an upstream dependency fails.
   *
   * @throws {Error} when `taskId` is not found.
   */
  fail(taskId: string, error: string): Task {
    const failed = this.update(taskId, { status: 'failed', result: error })
    this.emit('task:failed', failed)
    this.cascadeFailure(taskId)
    if (this.isComplete()) {
      this.emitAllComplete()
    }
    return failed
  }

  /**
   * Marks `taskId` as `'skipped'` and records `reason` in the `result` field.
   *
   * Fires `'task:skipped'` for the skipped task and cascades to every
   * downstream task that transitively depended on it — even if the dependent
   * has other dependencies that are still pending or completed. A skipped
   * upstream is treated as permanently unsatisfiable, mirroring `fail()`.
   *
   * @throws {Error} when `taskId` is not found.
   */
  skip(taskId: string, reason: string): Task {
    const skipped = this.update(taskId, { status: 'skipped', result: reason })
    this.emit('task:skipped', skipped)
    this.cascadeSkip(taskId)
    if (this.isComplete()) {
      this.emitAllComplete()
    }
    return skipped
  }

  /**
   * Marks all non-terminal tasks as `'skipped'`.
   *
   * Used when an approval gate rejects continuation — every pending, blocked,
   * or in-progress task is skipped with the given reason.
   *
   * **Important:** Call only when no tasks are actively executing. The
   * orchestrator invokes this after `await Promise.all()`, so no tasks are
   * in-flight. Calling while agents are running may mark an in-progress task
   * as skipped while its agent continues executing.
   */
  skipRemaining(reason = 'Skipped: approval rejected.'): void {
    // Snapshot first — update() mutates the live map, which is unsafe to
    // iterate over during modification.
    const snapshot = Array.from(this.tasks.values())
    for (const task of snapshot) {
      if (task.status === 'completed' || task.status === 'failed' || task.status === 'skipped') continue
      const skipped = this.update(task.id, { status: 'skipped', result: reason })
      this.emit('task:skipped', skipped)
    }
    if (this.isComplete()) {
      this.emitAllComplete()
    }
  }

  /**
   * Recursively marks all tasks that (transitively) depend on `failedTaskId`
   * as `'failed'` with an informative message, firing `'task:failed'` for each.
   *
   * Only tasks in `'blocked'` or `'pending'` state are affected; tasks already
   * in a terminal state are left untouched.
   */
  private cascadeFailure(failedTaskId: string): void {
    for (const task of this.tasks.values()) {
      if (task.status !== 'blocked' && task.status !== 'pending') continue
      if (!task.dependsOn?.includes(failedTaskId)) continue

      const cascaded = this.update(task.id, {
        status: 'failed',
        result: `Cancelled: dependency "${failedTaskId}" failed.`,
      })
      this.emit('task:failed', cascaded)
      // Recurse to handle transitive dependents.
      this.cascadeFailure(task.id)
    }
  }

  /**
   * Recursively marks all tasks that (transitively) depend on `skippedTaskId`
   * as `'skipped'`, firing `'task:skipped'` for each.
   */
  private cascadeSkip(skippedTaskId: string): void {
    for (const task of this.tasks.values()) {
      if (task.status !== 'blocked' && task.status !== 'pending') continue
      if (!task.dependsOn?.includes(skippedTaskId)) continue

      const cascaded = this.update(task.id, {
        status: 'skipped',
        result: `Skipped: dependency "${skippedTaskId}" was skipped.`,
      })
      this.emit('task:skipped', cascaded)
      this.cascadeSkip(task.id)
    }
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /**
   * Returns the next `'pending'` task for `assignee` (matched against
   * `task.assignee`), or `undefined` if none exists.
   *
   * If `assignee` is omitted, behaves like {@link nextAvailable}.
   */
  next(assignee?: string): Task | undefined {
    if (assignee === undefined) return this.nextAvailable()

    for (const task of this.tasks.values()) {
      if (task.status === 'pending' && task.assignee === assignee) {
        return task
      }
    }
    return undefined
  }

  /**
   * Returns the next `'pending'` task that has no `assignee` restriction, or
   * the first `'pending'` task overall when all pending tasks have an assignee.
   */
  nextAvailable(): Task | undefined {
    let fallback: Task | undefined

    for (const task of this.tasks.values()) {
      if (task.status !== 'pending') continue
      if (!task.assignee) return task
      if (!fallback) fallback = task
    }

    return fallback
  }

  /** Returns a snapshot array of all tasks (any status). */
  list(): Task[] {
    return Array.from(this.tasks.values())
  }

  /** Returns all tasks whose `status` matches `status`. */
  getByStatus(status: TaskStatus): Task[] {
    return this.list().filter((t) => t.status === status)
  }

  /**
   * Returns `true` when every task in the queue has reached a terminal state
   * (`'completed'`, `'failed'`, or `'skipped'`), **or** the queue is empty.
   */
  isComplete(): boolean {
    for (const task of this.tasks.values()) {
      if (task.status !== 'completed' && task.status !== 'failed' && task.status !== 'skipped') return false
    }
    return true
  }

  /**
   * Returns a progress snapshot.
   *
   * @example
   * ```ts
   * const { completed, total } = queue.getProgress()
   * console.log(`${completed}/${total} tasks done`)
   * ```
   */
  getProgress(): {
    total: number
    completed: number
    failed: number
    skipped: number
    inProgress: number
    pending: number
    blocked: number
  } {
    let completed = 0
    let failed = 0
    let skipped = 0
    let inProgress = 0
    let pending = 0
    let blocked = 0

    for (const task of this.tasks.values()) {
      switch (task.status) {
        case 'completed':
          completed++
          break
        case 'failed':
          failed++
          break
        case 'skipped':
          skipped++
          break
        case 'in_progress':
          inProgress++
          break
        case 'pending':
          pending++
          break
        case 'blocked':
          blocked++
          break
      }
    }

    return {
      total: this.tasks.size,
      completed,
      failed,
      skipped,
      inProgress,
      pending,
      blocked,
    }
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  /**
   * Subscribes to a queue event.
   *
   * @returns An unsubscribe function. Calling it is idempotent.
   *
   * @example
   * ```ts
   * const off = queue.on('task:ready', (task) => execute(task))
   * // later…
   * off()
   * ```
   */
  on<E extends TaskQueueEvent>(
    event: E,
    handler: HandlerFor<E>,
  ): () => void {
    let map = this.listeners.get(event)
    if (!map) {
      map = new Map()
      this.listeners.set(event, map)
    }
    const id = Symbol()
    map.set(id, handler as TaskHandler | AllCompleteHandler)
    return () => {
      map!.delete(id)
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Evaluates whether `task` should start as `'blocked'` based on the tasks
   * already registered in the queue.
   */
  private resolveInitialStatus(task: Task): Task {
    if (!task.dependsOn || task.dependsOn.length === 0) return task

    const allCurrent = Array.from(this.tasks.values())
    const ready = isTaskReady(task, allCurrent)
    if (ready) return task

    return { ...task, status: 'blocked', updatedAt: new Date() }
  }

  /**
   * After a task completes, scan all `'blocked'` tasks and promote any that are
   * now fully satisfied to `'pending'`, firing `'task:ready'` for each.
   *
   * The task array and lookup map are built once for the entire scan to keep
   * the operation O(n) rather than O(n²).
   */
  private unblockDependents(completedId: string): void {
    const allTasks = Array.from(this.tasks.values())
    const taskById = new Map<string, Task>(allTasks.map((t) => [t.id, t]))

    for (const task of allTasks) {
      if (task.status !== 'blocked') continue
      if (!task.dependsOn?.includes(completedId)) continue

      // Re-check against the current state of the whole task set.
      // Pass the pre-built map to avoid rebuilding it for every candidate task.
      if (isTaskReady({ ...task, status: 'pending' }, allTasks, taskById)) {
        const unblocked: Task = {
          ...task,
          status: 'pending',
          updatedAt: new Date(),
        }
        this.tasks.set(task.id, unblocked)
        // Update the map so subsequent iterations in the same call see the new status.
        taskById.set(task.id, unblocked)
        this.emit('task:ready', unblocked)
      }
    }
  }

  private emit(event: 'task:ready' | 'task:complete' | 'task:failed' | 'task:skipped', task: Task): void {
    const map = this.listeners.get(event)
    if (!map) return
    for (const handler of map.values()) {
      ;(handler as TaskHandler)(task)
    }
  }

  private emitAllComplete(): void {
    const map = this.listeners.get('all:complete')
    if (!map) return
    for (const handler of map.values()) {
      ;(handler as AllCompleteHandler)()
    }
  }

  private requireTask(taskId: string): Task {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error(`TaskQueue: task "${taskId}" not found.`)
    return task
  }
}
