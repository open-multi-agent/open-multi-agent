import { describe, it, expect } from 'vitest'
import { Checkpoint, CHECKPOINT_KEY_PREFIX, isCheckpointKey } from '../src/memory/checkpoint.js'
import { InMemoryStore } from '../src/memory/store.js'
import { SharedMemory } from '../src/memory/shared.js'
import { OpenMultiAgent } from '../src/orchestrator/orchestrator.js'
import { TaskQueue } from '../src/task/queue.js'
import { createTask } from '../src/task/task.js'
import { Team } from '../src/team/team.js'
import type {
  AgentConfig,
  LLMAdapter,
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  MemoryEntry,
  MemoryStore,
  RunTaskSpec,
} from '../src/types.js'

function textResponse(text: string, model: string): LLMResponse {
  return {
    id: `resp-${text}`,
    content: [{ type: 'text', text }],
    model,
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

function scriptedAdapter(outputs: string[]) {
  const prompts: string[] = []
  let callCount = 0
  const adapter: LLMAdapter = {
    name: 'checkpoint-test',
    async chat(messages: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
      const prompt = [...messages].reverse()
        .find((message) => message.role === 'user')
        ?.content
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text)
        .join('\n') ?? ''
      prompts.push(prompt)
      const output = outputs[callCount] ?? `output-${callCount}`
      callCount++
      return textResponse(output, options.model)
    },
    async *stream() {
      yield { type: 'done' as const, data: textResponse('stream-unused', 'mock-model') }
    },
  }

  return {
    adapter,
    prompts,
    calls: () => callCount,
  }
}

function worker(name: string, adapter: LLMAdapter): AgentConfig {
  return { name, model: 'mock-model', adapter, systemPrompt: `You are ${name}.` }
}

function task(id: string, opts: { dependsOn?: string[]; assignee?: string } = {}) {
  const created = createTask({ title: id, description: `task ${id}`, assignee: opts.assignee })
  return { ...created, id, dependsOn: opts.dependsOn } as ReturnType<typeof createTask>
}

class AsyncMapStore implements MemoryStore {
  readonly data = new Map<string, MemoryEntry>()

  async get(key: string): Promise<MemoryEntry | null> {
    return this.data.get(key) ?? null
  }

  async set(key: string, value: string, metadata?: Record<string, unknown>): Promise<void> {
    const existing = this.data.get(key)
    this.data.set(key, {
      key,
      value,
      metadata,
      createdAt: existing?.createdAt ?? new Date(),
    })
  }

  async setWithExpiry(
    key: string,
    value: string,
    expiresAtTurn: number,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const existing = this.data.get(key)
    this.data.set(key, {
      key,
      value,
      metadata,
      createdAt: existing?.createdAt ?? new Date(),
      expiresAtTurn,
    })
  }

  async list(): Promise<MemoryEntry[]> {
    return Array.from(this.data.values())
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key)
  }

  async clear(): Promise<void> {
    this.data.clear()
  }
}

async function deleteNonCheckpointEntries(store: MemoryStore): Promise<void> {
  for (const entry of await store.list()) {
    if (!isCheckpointKey(entry.key)) {
      await store.delete(entry.key)
    }
  }
}

describe('checkpoint snapshots', () => {
  it('TaskQueue snapshot round-trips pending, in-progress, and completed partitions', () => {
    const queue = new TaskQueue()
    queue.add(task('a'))
    queue.add(task('b'))
    queue.add(task('c', { dependsOn: ['a'] }))
    queue.update('b', { status: 'in_progress' })
    queue.complete('a', 'done a')

    const snapshot = queue.snapshot()
    const restored = TaskQueue.fromSnapshot(snapshot)

    expect(restored.snapshot().pending).toEqual(snapshot.pending)
    expect(restored.snapshot().inProgress).toEqual(snapshot.inProgress)
    expect(restored.snapshot().completed).toEqual(snapshot.completed)
    expect(restored.get('a')?.result).toBe('done a')
  })

  it('TaskQueue restore can make in-progress work runnable again', () => {
    const queue = new TaskQueue()
    queue.add(task('a'))
    queue.update('a', { status: 'in_progress' })

    const restored = TaskQueue.fromSnapshot(queue.snapshot(), { resetInProgress: true })
    expect(restored.get('a')?.status).toBe('pending')
  })

  it('SharedMemory snapshot/restore preserves entries and turn count', async () => {
    const memory = new SharedMemory()
    await memory.write('agent', 'plain', 'value', { source: 'test' })
    await memory.write('agent', 'structured', { ok: true, count: 2 })
    await memory.writeExpiring('agent', 'ttl', 'short', 3)
    memory.advanceTurn()

    const snapshot = await memory.snapshot()
    const restored = await SharedMemory.fromSnapshot(snapshot)

    expect(restored.getTurnCount()).toBe(1)
    expect((await restored.read('agent/plain'))?.value).toBe('value')
    expect((await restored.read('agent/plain'))?.metadata).toMatchObject({ source: 'test' })
    expect((await restored.read('agent/structured'))?.value).toEqual({ ok: true, count: 2 })
    expect((await restored.read('agent/ttl'))?.value).toBe('short')
  })

  it('Checkpoint persists and loads snapshots through MemoryStore only', async () => {
    const store = new AsyncMapStore()
    const checkpoint = new Checkpoint(store, { runId: 'custom' })
    const queue = new TaskQueue()
    queue.add(task('a'))
    queue.complete('a', 'done')

    await checkpoint.save({
      version: 1,
      mode: 'runTasks',
      createdAt: new Date().toISOString(),
      runId: 'custom',
      queue: queue.snapshot(),
      completedTaskResults: [{ taskId: 'a', result: 'done' }],
    })

    expect((await store.list()).map((entry) => entry.key)).toEqual([
      `${CHECKPOINT_KEY_PREFIX}custom/latest`,
    ])
    expect((await checkpoint.loadLatest())?.queue.completed).toEqual(['a'])
  })
})

describe('OpenMultiAgent checkpoint/restore', () => {
  const tasks: RunTaskSpec[] = [
    { title: 'first', description: 'do first', assignee: 'worker' },
    { title: 'second', description: 'do second', assignee: 'worker', dependsOn: ['first'] },
  ]

  it('does not write checkpoint keys when checkpointing is not enabled', async () => {
    const store = new InMemoryStore()
    const scripted = scriptedAdapter(['done'])
    const team = new Team({
      name: 'team',
      agents: [worker('worker', scripted.adapter)],
      sharedMemoryStore: store,
    })
    const orchestrator = new OpenMultiAgent()

    await orchestrator.runTasks(team, [
      { title: 'only', description: 'do it', assignee: 'worker' },
    ])

    expect((await store.list()).some((entry) => isCheckpointKey(entry.key))).toBe(false)
  })

  it('restores after an aborted run, skips completed tasks, and rehydrates shared memory', async () => {
    const store = new InMemoryStore()
    const scripted = scriptedAdapter(['first output', 'second output'])
    const abort = new AbortController()
    const orchestrator = new OpenMultiAgent({
      onProgress(event) {
        if (event.type === 'task_complete') {
          abort.abort()
        }
      },
    })
    const team = new Team({
      name: 'team',
      agents: [worker('worker', scripted.adapter)],
      sharedMemoryStore: store,
    })
    await team.getSharedMemoryInstance()!.write('seed', 'note', { keep: true })

    await orchestrator.runTasks(team, tasks, {
      abortSignal: abort.signal,
      checkpoint: { store },
    })
    expect(scripted.calls()).toBe(1)

    await deleteNonCheckpointEntries(store)

    const resumedTeam = new Team({
      name: 'team',
      agents: [worker('worker', scripted.adapter)],
      sharedMemoryStore: store,
    })
    const restored = await orchestrator.restore(resumedTeam, { checkpoint: { store } })

    expect(scripted.calls()).toBe(2)
    expect(scripted.prompts[1]).toContain('first output')
    expect(restored.tasks?.map((record) => [record.title, record.status])).toEqual([
      ['first', 'completed'],
      ['second', 'completed'],
    ])
    expect((await resumedTeam.getSharedMemoryInstance()!.read('seed/note'))?.value).toEqual({ keep: true })
  })

  it('restore against an empty store starts a fresh task run', async () => {
    const store = new InMemoryStore()
    const scripted = scriptedAdapter(['fresh output'])
    const team = new Team({
      name: 'team',
      agents: [worker('worker', scripted.adapter)],
      sharedMemoryStore: store,
    })
    const orchestrator = new OpenMultiAgent()

    const result = await orchestrator.restore(team, [
      { title: 'fresh', description: 'start fresh', assignee: 'worker' },
    ], { checkpoint: { store } })

    expect(scripted.calls()).toBe(1)
    expect(result.tasks?.[0]?.status).toBe('completed')
    expect((await store.list()).some((entry) => isCheckpointKey(entry.key))).toBe(true)
  })

  it('checkpoint/restore works with a custom async MemoryStore', async () => {
    const store = new AsyncMapStore()
    const scripted = scriptedAdapter(['first output', 'second output'])
    const abort = new AbortController()
    const orchestrator = new OpenMultiAgent({
      onProgress(event) {
        if (event.type === 'task_complete') abort.abort()
      },
    })
    const team = new Team({
      name: 'team',
      agents: [worker('worker', scripted.adapter)],
      sharedMemoryStore: store,
    })

    await orchestrator.runTasks(team, tasks, {
      abortSignal: abort.signal,
      checkpoint: { store },
    })

    const resumedTeam = new Team({
      name: 'team',
      agents: [worker('worker', scripted.adapter)],
      sharedMemoryStore: store,
    })
    const result = await orchestrator.restore(resumedTeam, { checkpoint: { store } })

    expect(result.tasks?.every((record) => record.status === 'completed')).toBe(true)
    expect(scripted.calls()).toBe(2)
  })

  it('restore after the final checkpoint is a no-op', async () => {
    const store = new InMemoryStore()
    const scripted = scriptedAdapter(['first output', 'second output'])
    const orchestrator = new OpenMultiAgent()
    const team = new Team({
      name: 'team',
      agents: [worker('worker', scripted.adapter)],
      sharedMemoryStore: store,
    })

    await orchestrator.runTasks(team, tasks, { checkpoint: { store } })
    expect(scripted.calls()).toBe(2)

    const resumedTeam = new Team({
      name: 'team',
      agents: [worker('worker', scripted.adapter)],
      sharedMemoryStore: store,
    })
    const result = await orchestrator.restore(resumedTeam, { checkpoint: { store } })

    expect(scripted.calls()).toBe(2)
    expect(result.tasks?.map((record) => record.status)).toEqual(['completed', 'completed'])
  })
})
