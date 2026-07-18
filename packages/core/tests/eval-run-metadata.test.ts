import { describe, expect, it, vi } from 'vitest'
import { Checkpoint } from '../src/memory/checkpoint.js'
import { InMemoryStore } from '../src/memory/store.js'
import { InMemoryTraceStore } from '../src/observability/in-memory-store.js'
import type { SpanEndRecord, TraceRecord } from '../src/observability/records.js'
import { TRACE_RECORD_OBSERVER } from '../src/observability/runtime.js'
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
  OrchestratorConfig,
  RunOutcomeFields,
  TraceAttributeValue,
} from '../src/types.js'

const METADATA = { prompt_version: 'v3', experiment: 'routing_ab' } as const

function response(text: string): LLMResponse {
  return {
    id: `response-${text}`,
    content: [{ type: 'text', text }],
    model: 'test-model',
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

function adapter(
  chat: (messages: LLMMessage[], options: LLMChatOptions) => Promise<LLMResponse>,
): LLMAdapter {
  return { name: 'run-metadata-test', chat, async *stream() { /* unused */ } }
}

function staticAdapter(text = 'ok'): LLMAdapter {
  return adapter(async () => response(text))
}

function agentConfig(name = 'worker', llm: LLMAdapter = staticAdapter()): AgentConfig {
  return { name, model: 'test-model', adapter: llm }
}

function teamWith(llm: LLMAdapter = staticAdapter()): Team {
  return new Team({ name: 'team', agents: [agentConfig('worker', llm)] })
}

function tracedOrchestrator(records: TraceRecord[]): OpenMultiAgent {
  return new OpenMultiAgent({
    defaultModel: 'test-model',
    [TRACE_RECORD_OBSERVER]: (record: TraceRecord) => records.push(record),
  } as OrchestratorConfig & { [TRACE_RECORD_OBSERVER]: (record: TraceRecord) => void })
}

function rootEnd(records: readonly TraceRecord[], traceId: string | undefined): SpanEndRecord {
  const record = records.find((candidate): candidate is SpanEndRecord =>
    candidate.traceId === traceId
    && candidate.recordType === 'span_end'
    && candidate.kind === 'run'
    && candidate.parentSpanId === undefined)
  expect(record).toBeDefined()
  return record!
}

function expectMetadata(
  result: RunOutcomeFields,
  records: readonly TraceRecord[],
  expected: Readonly<Record<string, TraceAttributeValue>>,
): void {
  expect(result.metadata).toEqual(expected)
  const attributes = rootEnd(records, result.identity?.traceId).attributes
  for (const [key, value] of Object.entries(expected)) {
    expect(attributes[`oma.meta.${key}`]).toEqual(value)
  }
}

function expectNoMetadata(result: RunOutcomeFields, records: readonly TraceRecord[]): void {
  expect(Object.hasOwn(result, 'metadata')).toBe(false)
  expect(Object.keys(rootEnd(records, result.identity?.traceId).attributes)
    .some((key) => key.startsWith('oma.meta.'))).toBe(false)
}

async function runTopLevelEntries(
  oma: OpenMultiAgent,
  metadata: Readonly<Record<string, TraceAttributeValue>> | undefined,
): Promise<RunOutcomeFields[]> {
  const options = metadata === undefined ? {} : { metadata }
  const runAgent = await oma.runAgent(agentConfig(), 'hello', options)
  const runTeam = await oma.runTeam(teamWith(), 'Say hello', options)
  const runTasks = await oma.runTasks(teamWith(), [
    { title: 'task', description: 'work', assignee: 'worker' },
  ], options)
  const runFromPlan = await oma.runFromPlan(teamWith(), {
    version: 1,
    tasks: [{ id: 'planned', title: 'planned', description: 'work', assignee: 'worker' }],
  }, options)

  let consensusCall = 0
  const consensusAdapter = adapter(async () => response(
    consensusCall++ === 0 ? 'answer' : '{"accept":true,"critique":""}',
  ))
  const runConsensus = await oma.runConsensus(teamWith(), 'question', {
    proposer: agentConfig('proposer', consensusAdapter),
    judges: [agentConfig('judge', consensusAdapter)],
    maxRounds: 1,
    ...options,
  })

  const store = new InMemoryStore()
  await oma.runTasks(teamWith(), [
    { title: 'checkpointed', description: 'work', assignee: 'worker' },
  ], { checkpoint: { store, runId: 'metadata-restore' }, ...options })
  const restore = await oma.restore(teamWith(), {
    checkpoint: { store, runId: 'metadata-restore' },
  })

  return [runAgent, runTeam, runTasks, runFromPlan, runConsensus, restore]
}

describe('per-run metadata', () => {
  it('echoes metadata and writes root attributes for all six top-level entries', async () => {
    const records: TraceRecord[] = []
    const results = await runTopLevelEntries(tracedOrchestrator(records), METADATA)

    expect(results).toHaveLength(6)
    for (const result of results) expectMetadata(result, records, METADATA)
  })

  it('omits metadata from results and root spans for all six entries when absent', async () => {
    const records: TraceRecord[] = []
    const results = await runTopLevelEntries(tracedOrchestrator(records), undefined)

    expect(results).toHaveLength(6)
    for (const result of results) expectNoMetadata(result, records)
  })

  it('rejects invalid keys, counts, reserved prefixes, and values before a run starts', async () => {
    const chat = vi.fn(async () => response('unused'))
    const oma = new OpenMultiAgent({ defaultModel: 'test-model' })
    const invalidMetadata: unknown[] = [
      { 'Prompt.Version': 'v1' },
      { 'invalid-key': 'v1' },
      { ['x'.repeat(65)]: 'v1' },
      { '': 'v1' },
      { 'oma.reserved': 'v1' },
      { _overridden: false },
      Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`key_${index}`, index])),
      { nested: { value: true } },
      { mixed: ['a', 1] },
      { invalid_number: Number.NaN },
      { invalid_array_number: [Number.POSITIVE_INFINITY] },
      null,
      [],
    ]

    for (const metadata of invalidMetadata) {
      await expect(oma.runAgent(agentConfig('worker', adapter(chat)), 'hello', {
        metadata: metadata as never,
      })).rejects.toThrow(/metadata|reserved|oma\./)
    }
    expect(chat).not.toHaveBeenCalled()
  })

  it('truncates string values to 1024 characters and echoes without observability configured', async () => {
    const long = 'x'.repeat(1_100)
    const result = await new OpenMultiAgent({ defaultModel: 'test-model' }).runAgent(
      agentConfig(),
      'hello',
      { metadata: { scalar: long, strings: [long, 'short'] } },
    )

    expect(result.metadata).toEqual({ scalar: 'x'.repeat(1_024), strings: ['x'.repeat(1_024), 'short'] })
  })

  it('persists metadata, inherits it on restore, and marks a different explicit override', async () => {
    const records: TraceRecord[] = []
    const store = new InMemoryStore()
    const oma = tracedOrchestrator(records)
    const initial = await oma.runTasks(teamWith(), [
      { title: 'task', description: 'work', assignee: 'worker' },
    ], {
      metadata: METADATA,
      checkpoint: { store, runId: 'logical-metadata-run' },
    })

    const stored = await new Checkpoint(store, { runId: 'logical-metadata-run' }).loadLatest()
    expect(stored?.metadata).toEqual(METADATA)

    const inherited = await oma.restore(teamWith(), {
      checkpoint: { store, runId: 'logical-metadata-run' },
    })
    expectMetadata(inherited, records, METADATA)
    expect(rootEnd(records, inherited.identity?.traceId).attributes['oma.meta._overridden']).toBeUndefined()

    const overriddenMetadata = { prompt_version: 'v4', dataset_tag: 'holdout' } as const
    const overridden = await oma.restore(teamWith(), {
      metadata: overriddenMetadata,
      checkpoint: { store, runId: 'logical-metadata-run' },
    })
    expectMetadata(overridden, records, overriddenMetadata)
    expect(rootEnd(records, overridden.identity?.traceId).attributes['oma.meta._overridden']).toBe(true)
    expect(overridden.identity?.attempt).toBe(3)
    expect(overridden.identity?.runId).toBe(initial.identity?.runId)

    const updated = await new Checkpoint(store, { runId: 'logical-metadata-run' }).loadLatest()
    expect(updated?.metadata).toEqual(overriddenMetadata)

    const traceStore = new InMemoryTraceStore()
    await traceStore.append(records)
    expect((await traceStore.getRun('logical-metadata-run'))?.metadata).toEqual(overriddenMetadata)
  })

  it('reads legacy checkpoints without metadata', async () => {
    const store = new InMemoryStore()
    const queue = new TaskQueue()
    const task = { ...createTask({ title: 'task', description: 'work', assignee: 'worker' }), id: 'task' }
    queue.add(task)
    queue.complete('task', 'done')
    await new Checkpoint(store, { runId: 'legacy-metadata-run' }).save({
      version: 1,
      mode: 'runTasks',
      createdAt: new Date().toISOString(),
      runId: 'legacy-metadata-run',
      queue: queue.snapshot(),
      completedTaskResults: [{ taskId: 'task', assignee: 'worker', result: 'done' }],
    })

    const result = await new OpenMultiAgent({ defaultModel: 'test-model' }).restore(teamWith(), {
      checkpoint: { store, runId: 'legacy-metadata-run' },
    })
    expect(Object.hasOwn(result, 'metadata')).toBe(false)
  })

  it('materializes latest root metadata into RunSummary without adding query filters', async () => {
    const records: TraceRecord[] = []
    const oma = tracedOrchestrator(records)
    const withMetadata = await oma.runTasks(teamWith(), [], {
      runId: 'summary-with-metadata',
      metadata: METADATA,
    })
    const withoutMetadata = await oma.runTasks(teamWith(), [], { runId: 'summary-without-metadata' })
    const store = new InMemoryTraceStore()
    await store.append(records)

    expect((await store.getRun(withMetadata.identity!.runId))?.metadata).toEqual(METADATA)
    expect((await store.getRun(withoutMetadata.identity!.runId))?.metadata).toBeUndefined()
    const page = await store.queryRuns({ order: 'started_asc' })
    expect(page.items).toHaveLength(2)
    expect(page.items.find((run) => run.runId === withMetadata.identity!.runId)?.metadata).toEqual(METADATA)
    expect(page.items.find((run) => run.runId === withoutMetadata.identity!.runId)?.metadata).toBeUndefined()
  })
})
