/**
 * @fileoverview The orchestration loop: dispatch dependency-ready tasks in
 * parallel, run each assignee (with retry, model routing, streaming, tracing),
 * fold usage into the budget, run the optional per-task verify, persist results
 * to shared memory, and save checkpoints.
 *
 * Also owns delegation team-info assembly ({@link buildTaskAgentTeamInfo}) and
 * per-task prompt construction ({@link buildTaskPrompt}).
 */

import type { RunOptions } from '../agent/runner.js'
import type {
  AgentConfig,
  AgentRunResult,
  CheckpointSnapshot,
  OrchestratorEvent,
  StreamEvent,
  Task,
  TaskExecutionMetrics,
  TaskStatus,
  TeamInfo,
  TokenUsage,
} from '../types.js'
import type { AgentPool } from '../agent/pool.js'
import type { Team } from '../team/team.js'
import type { TaskQueue } from '../task/queue.js'
import type { Checkpoint } from '../memory/checkpoint.js'
import { emitTrace, generateSpanId } from '../utils/trace.js'
import { classifyRunFailure, statusOnly } from '../observability/status.js'
import type { TraceRuntime, TraceSpan } from '../observability/runtime.js'
import {
  ZERO_USAGE,
  DEFAULT_MODEL,
  errorMessage,
  prependRevealCoordinatorContext,
  buildRevealCoordinatorLines,
  type RunContext,
  type RevealCoordinatorContext,
} from './run-context.js'
import { recordRunUsage, buildCostEstimateContext } from './budget.js'
import {
  routeMatches,
  withModelRoute,
  applyAgentDefaults,
  applyDefaultToolPreset,
  buildAgent,
} from './agent-config.js'
import { executeWithRetry } from './retry.js'
import { runTaskVerify } from './consensus.js'

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
export function buildTaskAgentTeamInfo(
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
    const effective: AgentConfig = withModelRoute(applyDefaultToolPreset(
      applyAgentDefaults(targetConfig, ctx.config),
      ctx.config.defaultToolPreset,
    ), route)
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

export async function saveRunCheckpoint(queue: TaskQueue, ctx: RunContext): Promise<void> {
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
export async function executeQueue(
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
        const workerEffectiveConfig = withModelRoute(applyDefaultToolPreset(
          applyAgentDefaults(agentConfig, config),
          config.defaultToolPreset,
        ), workerRoute)
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
export async function buildTaskPrompt(
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
