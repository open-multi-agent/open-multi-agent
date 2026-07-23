import { describe, expect, it, vi } from 'vitest'
import { OpenMultiAgent } from '../src/orchestrator/orchestrator.js'
import type {
  AgentConfig,
  LLMAdapter,
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  OrchestratorEvent,
  Task,
  TeamRunResult,
  TokenUsage,
} from '../src/types.js'

type TaskTitle = 'A' | 'B' | 'C'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

interface TimelineEntry {
  readonly type: OrchestratorEvent['type'] | 'approval'
  readonly taskId?: string
  readonly title?: string
  readonly agent?: string
  readonly data?: unknown
}

interface HarnessOptions {
  readonly maxConcurrency?: number
  readonly maxTokenBudget?: number
  readonly abortSignal?: AbortSignal
  readonly cAssignee?: string | null
  readonly usageByTask?: Partial<Record<TaskTitle, TokenUsage>>
  readonly onApproval?: (
    completedTasks: readonly Task[],
    nextTasks: readonly Task[],
  ) => Promise<boolean>
}

const MAX_CONCURRENCY = 2
const TASK_TITLES: readonly TaskTitle[] = ['A', 'B', 'C']
const DEFAULT_USAGE: TokenUsage = { input_tokens: 1, output_tokens: 1 }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill
  })
  return { promise, resolve }
}

function taskTitleFromMessages(messages: LLMMessage[]): TaskTitle {
  const prompt = [...messages]
    .reverse()
    .find((message) => message.role === 'user')
    ?.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n') ?? ''
  const title = prompt.match(/^# Task: (.+)$/m)?.[1]
  if (!TASK_TITLES.includes(title as TaskTitle)) {
    throw new Error(`Unexpected task prompt: ${prompt}`)
  }
  return title as TaskTitle
}

/**
 * Reusable adapter for DAG scheduling tests. Each task announces when its model
 * call starts and remains in flight until the test releases its deferred gate.
 */
class DeferredTaskAdapter implements LLMAdapter {
  readonly name = 'pipeline-scheduling-test'

  private readonly starts = new Map<TaskTitle, Deferred<void>>()
  private readonly releases = new Map<TaskTitle, Deferred<void>>()
  private readonly usageByTask: Partial<Record<TaskTitle, TokenUsage>>

  constructor(usageByTask: Partial<Record<TaskTitle, TokenUsage>> = {}) {
    this.usageByTask = usageByTask
    for (const title of TASK_TITLES) {
      this.starts.set(title, deferred<void>())
      this.releases.set(title, deferred<void>())
    }
  }

  async chat(messages: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
    const title = taskTitleFromMessages(messages)
    this.starts.get(title)!.resolve(undefined)
    await this.releases.get(title)!.promise

    return {
      id: `response-${title}`,
      content: [{ type: 'text', text: `completed ${title}` }],
      model: options.model,
      stop_reason: 'end_turn',
      usage: this.usageByTask[title] ?? DEFAULT_USAGE,
    }
  }

  async *stream() {
    yield { type: 'done' as const, data: {} }
  }

  waitForStart(title: TaskTitle): Promise<void> {
    return this.starts.get(title)!.promise
  }

  release(title: TaskTitle): void {
    this.releases.get(title)!.resolve(undefined)
  }
}

/**
 * Reusable progress collector that resolves event waiters without polling and
 * derives task-level in-flight concurrency from start/terminal event pairs.
 */
class SchedulingEventCollector {
  readonly timeline: TimelineEntry[] = []

  private readonly titlesByTaskId = new Map<string, string>()
  private readonly waiters = new Map<string, Array<Deferred<void>>>()

  readonly onProgress = (event: OrchestratorEvent): void => {
    const dataTitle = this.titleFromData(event.data)
    if (event.task && dataTitle) {
      this.titlesByTaskId.set(event.task, dataTitle)
    }
    const title = dataTitle ?? (event.task ? this.titlesByTaskId.get(event.task) : undefined)
    this.timeline.push({
      type: event.type,
      ...(event.task ? { taskId: event.task } : {}),
      ...(title ? { title } : {}),
      ...(event.agent ? { agent: event.agent } : {}),
      ...(event.data !== undefined ? { data: event.data } : {}),
    })
    if (title) this.resolveWaiters(event.type, title)
  }

  markApproval(): void {
    this.timeline.push({ type: 'approval' })
    this.resolveWaiters('approval')
  }

  waitFor(type: TimelineEntry['type'], title?: string): Promise<void> {
    if (this.indexOf(type, title) !== -1) return Promise.resolve()
    const key = this.waiterKey(type, title)
    const waiter = deferred<void>()
    const pending = this.waiters.get(key) ?? []
    pending.push(waiter)
    this.waiters.set(key, pending)
    return waiter.promise
  }

  has(type: TimelineEntry['type'], title?: string): boolean {
    return this.indexOf(type, title) !== -1
  }

  indexOf(type: TimelineEntry['type'], title?: string): number {
    return this.timeline.findIndex((entry) =>
      entry.type === type && (title === undefined || entry.title === title),
    )
  }

  get maxInFlight(): number {
    const inFlight = new Set<string>()
    let peak = 0

    for (const entry of this.timeline) {
      if (entry.type === 'task_start' && entry.taskId) {
        inFlight.add(entry.taskId)
        peak = Math.max(peak, inFlight.size)
      }
      if (
        entry.taskId
        && (
          entry.type === 'task_complete'
          || entry.type === 'task_skipped'
          || entry.type === 'error'
        )
      ) {
        inFlight.delete(entry.taskId)
      }
    }

    return peak
  }

  private titleFromData(data: unknown): string | undefined {
    if (data === null || typeof data !== 'object' || !('title' in data)) return undefined
    const title = (data as { title?: unknown }).title
    return typeof title === 'string' ? title : undefined
  }

  private resolveWaiters(type: TimelineEntry['type'], title?: string): void {
    const key = this.waiterKey(type, title)
    for (const waiter of this.waiters.get(key) ?? []) {
      waiter.resolve(undefined)
    }
    this.waiters.delete(key)
  }

  private waiterKey(type: TimelineEntry['type'], title?: string): string {
    return `${type}:${title ?? ''}`
  }
}

function createSchedulingHarness(options: HarnessOptions = {}) {
  const adapter = new DeferredTaskAdapter(options.usageByTask)
  const events = new SchedulingEventCollector()
  const orchestrator = new OpenMultiAgent({
    defaultModel: 'mock-model',
    maxConcurrency: options.maxConcurrency ?? MAX_CONCURRENCY,
    schedulingStrategy: 'round-robin',
    ...(options.maxTokenBudget !== undefined
      ? { maxTokenBudget: options.maxTokenBudget }
      : {}),
    ...(options.onApproval
      ? {
          onApproval: async (completedTasks: readonly Task[], nextTasks: readonly Task[]) => {
            events.markApproval()
            return options.onApproval!(completedTasks, nextTasks)
          },
        }
      : {}),
    onProgress: events.onProgress,
  })
  const agents: AgentConfig[] = ['worker-a', 'worker-b', 'worker-c'].map((name) => ({
    name,
    model: 'mock-model',
    systemPrompt: `You are ${name}.`,
    adapter,
  }))
  const team = orchestrator.createTeam('pipeline-scheduling', {
    name: 'pipeline-scheduling',
    agents,
    sharedMemory: false,
  })
  const cAssignee = options.cAssignee === undefined ? 'worker-c' : options.cAssignee
  const tasks = [
    { title: 'A', description: 'Fast root task A.', assignee: 'worker-a' },
    { title: 'B', description: 'Slow root task B.', assignee: 'worker-b' },
    {
      title: 'C',
      description: 'Task C depends only on A.',
      ...(cAssignee === null ? {} : { assignee: cAssignee }),
      dependsOn: ['A'],
    },
  ]

  return {
    adapter,
    events,
    run: () => orchestrator.runTasks(
      team,
      tasks,
      options.abortSignal ? { abortSignal: options.abortSignal } : undefined,
    ),
  }
}

async function drainMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 8; turn++) {
    await Promise.resolve()
  }
}

async function runFastABeforeSlowB(
  harness: ReturnType<typeof createSchedulingHarness>,
): Promise<TeamRunResult> {
  // C may be released before it starts; its eventual model call will complete immediately.
  harness.adapter.release('C')
  const resultPromise = harness.run()
  await Promise.all([
    harness.adapter.waitForStart('A'),
    harness.adapter.waitForStart('B'),
  ])

  harness.adapter.release('A')
  await harness.events.waitFor('task_complete', 'A')
  await drainMicrotasks()
  harness.adapter.release('B')

  return resultPromise
}

function taskStatus(result: TeamRunResult, title: TaskTitle) {
  return result.tasks?.find((task) => task.title === title)?.status
}

// These tests document the current batch barrier; the pipeline PR will update
// these assertions deliberately.
describe('current executeQueue batch semantics', () => {
  it('starts C only after the entire A/B batch completes', async () => {
    const harness = createSchedulingHarness()

    const result = await runFastABeforeSlowB(harness)

    expect(taskStatus(result, 'A')).toBe('completed')
    expect(taskStatus(result, 'B')).toBe('completed')
    expect(taskStatus(result, 'C')).toBe('completed')
    expect(harness.events.indexOf('task_start', 'C')).toBeGreaterThan(
      harness.events.indexOf('task_complete', 'B'),
    )
  })

  it('calls onApproval between rounds with the completed batch and next tasks', async () => {
    const onApproval = vi.fn(async (
      _completedTasks: readonly Task[],
      _nextTasks: readonly Task[],
    ) => true)
    const harness = createSchedulingHarness({ onApproval })

    await runFastABeforeSlowB(harness)

    expect(onApproval).toHaveBeenCalledTimes(1)
    const [completedTasks, nextTasks] = onApproval.mock.calls[0]!
    expect(completedTasks.map((task) => task.title).sort()).toEqual(['A', 'B'])
    expect(nextTasks.map((task) => task.title)).toEqual(['C'])
    expect(harness.events.indexOf('approval')).toBeGreaterThan(
      harness.events.indexOf('task_complete', 'B'),
    )
    expect(harness.events.indexOf('approval')).toBeLessThan(
      harness.events.indexOf('task_start', 'C'),
    )
  })

  it('auto-assigns a newly-unblocked task before the next round is approved', async () => {
    const onApproval = vi.fn(async (
      _completedTasks: readonly Task[],
      _nextTasks: readonly Task[],
    ) => true)
    const harness = createSchedulingHarness({
      cAssignee: null,
      onApproval,
    })

    const result = await runFastABeforeSlowB(harness)

    const nextTask = onApproval.mock.calls[0]![1][0]
    const cStart = harness.events.timeline.find((entry) =>
      entry.type === 'task_start' && entry.title === 'C',
    )
    expect(nextTask?.title).toBe('C')
    expect(nextTask?.assignee).toBeDefined()
    expect(cStart?.agent).toBe(nextTask?.assignee)
    expect(result.tasks?.find((task) => task.title === 'C')?.assignee).toBe(nextTask?.assignee)
  })

  it('applies a run budget overage after every task in the active batch settles', async () => {
    const harness = createSchedulingHarness({
      maxTokenBudget: 10,
      usageByTask: {
        A: { input_tokens: 6, output_tokens: 5 },
        B: { input_tokens: 1, output_tokens: 1 },
      },
    })

    const result = await runFastABeforeSlowB(harness)

    expect(taskStatus(result, 'A')).toBe('completed')
    expect(taskStatus(result, 'B')).toBe('completed')
    expect(taskStatus(result, 'C')).toBe('skipped')
    expect(harness.events.has('task_start', 'C')).toBe(false)
    expect(harness.events.has('budget_exceeded')).toBe(true)
    expect(harness.events.indexOf('budget_exceeded')).toBeLessThan(
      harness.events.indexOf('task_complete', 'B'),
    )
    expect(harness.events.indexOf('task_complete', 'B')).toBeLessThan(
      harness.events.indexOf('task_skipped', 'C'),
    )
  })

  it('skips remaining tasks after abort without leaving in_progress state', async () => {
    const controller = new AbortController()
    const harness = createSchedulingHarness({ abortSignal: controller.signal })
    harness.adapter.release('C')
    const resultPromise = harness.run()
    await Promise.all([
      harness.adapter.waitForStart('A'),
      harness.adapter.waitForStart('B'),
    ])

    harness.adapter.release('A')
    await harness.events.waitFor('task_complete', 'A')
    controller.abort()
    harness.adapter.release('B')
    const result = await resultPromise

    expect(taskStatus(result, 'A')).toBe('completed')
    expect(taskStatus(result, 'B')).toBe('completed')
    expect(taskStatus(result, 'C')).toBe('skipped')
    expect(result.tasks?.some((task) => task.status === 'in_progress')).toBe(false)
    expect(result.tasks?.some((task) =>
      task.status === 'pending' || task.status === 'blocked',
    )).toBe(false)
    expect(harness.events.indexOf('task_complete', 'B')).toBeLessThan(
      harness.events.indexOf('task_skipped', 'C'),
    )
  })
})

describe('target event-driven pipeline semantics', () => {
  it.fails('starts C before slow B completes while respecting maxConcurrency', async () => {
    const harness = createSchedulingHarness({ maxConcurrency: MAX_CONCURRENCY })

    await runFastABeforeSlowB(harness)

    expect(harness.events.maxInFlight).toBeLessThanOrEqual(MAX_CONCURRENCY)
    expect(harness.events.indexOf('task_start', 'C')).toBeLessThan(
      harness.events.indexOf('task_complete', 'B'),
    )
  })
})
