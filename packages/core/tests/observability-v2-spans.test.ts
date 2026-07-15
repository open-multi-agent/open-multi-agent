import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createRunIdentity } from '../src/observability/identity.js'
import { TRACE_RECORD_OBSERVER, TraceRuntime } from '../src/observability/runtime.js'
import type { SpanEndRecord, TraceRecord } from '../src/observability/records.js'
import { OpenMultiAgent } from '../src/orchestrator/orchestrator.js'
import { Team } from '../src/team/team.js'
import { InMemoryStore } from '../src/memory/store.js'
import type {
  AgentConfig,
  LLMAdapter,
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  OrchestratorConfig,
  TraceEvent,
} from '../src/types.js'

function ended(records: readonly TraceRecord[]): SpanEndRecord[] {
  return records.filter((record): record is SpanEndRecord => record.recordType === 'span_end')
}

function response(text: string, usage = { input_tokens: 1, output_tokens: 1 }): LLMResponse {
  return {
    id: `response-${text}`,
    content: [{ type: 'text', text }],
    model: 'test-model',
    stop_reason: 'end_turn',
    usage,
  }
}

function toolResponse(name: string, input: Record<string, unknown>): LLMResponse {
  return {
    id: `tool-${name}`,
    content: [{ type: 'tool_use', id: `call-${name}`, name, input }],
    model: 'test-model',
    stop_reason: 'tool_use',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

function adapter(
  chat: (messages: LLMMessage[], options: LLMChatOptions) => Promise<LLMResponse>,
): LLMAdapter {
  return { name: 'obs-1b-test', chat, async *stream() { /* unused */ } }
}

function config(name: string, llm: LLMAdapter, extra: Partial<AgentConfig> = {}): AgentConfig {
  return { name, model: 'test-model', adapter: llm, ...extra }
}

function tracedOrchestrator(records: TraceRecord[], extra: OrchestratorConfig = {}): OpenMultiAgent {
  return new OpenMultiAgent({
    defaultModel: 'test-model',
    ...extra,
    [TRACE_RECORD_OBSERVER]: (record: TraceRecord) => records.push(record),
  } as OrchestratorConfig & { [TRACE_RECORD_OBSERVER]: (record: TraceRecord) => void })
}

function expectClosed(records: readonly TraceRecord[]): void {
  const starts = records.filter((record) => record.recordType === 'span_start')
  const ends = ended(records)
  expect(ends).toHaveLength(starts.length)
  for (const start of starts) {
    expect(ends.filter((end) => end.spanId === start.spanId)).toHaveLength(1)
  }
}

describe('OBS-1B TraceRuntime contract', () => {
  it('emits schema-v2 start/event/self-contained end records in strict sequence', () => {
    const records: TraceRecord[] = []
    const identity = createRunIdentity({ runId: 'contract-run' })
    const runtime = new TraceRuntime(identity, (record) => records.push(record))
    const child = runtime.startSpan({
      kind: 'llm',
      name: 'chat',
      parent: runtime.root,
      attributes: { 'oma.phase': 'turn', 'oma.agent.name': 'worker' },
    })
    child.event('first_chunk', { 'oma.stream.ttft_ms': 4 })
    child.end({ status: { code: 'ok' }, attributes: { 'oma.usage.input_tokens': 2 } })
    runtime.close({ status: { code: 'ok' } })

    expect(records.map((record) => record.sequence)).toEqual([1, 2, 3, 4, 5])
    expect(new Set(records.map((record) => record.recordId)).size).toBe(records.length)
    expect(records.every((record) => record.schemaVersion === 2)).toBe(true)
    expect(records.every((record) => record.runId === identity.runId)).toBe(true)
    expect(records.every((record) => record.attempt === identity.attempt)).toBe(true)
    expect(records.every((record) => record.traceId === identity.traceId)).toBe(true)
    expect(child.spanId).toMatch(/^[0-9a-f]{16}$/)

    const childEnd = ended(records).find((record) => record.spanId === child.spanId)!
    expect(childEnd).toMatchObject({
      kind: 'llm',
      name: 'chat',
      parentSpanId: identity.rootSpanId,
      status: { code: 'ok' },
    })
    expect(childEnd.attributes).toMatchObject({
      'oma.phase': 'turn',
      'oma.agent.name': 'worker',
      'oma.usage.input_tokens': 2,
      'oma.status': 'ok',
    })
  })

  it('closes exactly once and makes close/ensureEnded idempotent', () => {
    const records: TraceRecord[] = []
    const runtime = new TraceRuntime(createRunIdentity(), (record) => records.push(record))
    const span = runtime.startSpan({ kind: 'tool', name: 'execute_tool', parent: runtime.root })

    expect(span.end({ status: { code: 'error' } })).toBe(true)
    expect(span.end({ status: { code: 'ok' } })).toBe(false)
    expect(span.ensureEnded()).toBe(false)
    expect(ended(records).filter((record) => record.spanId === span.spanId)).toHaveLength(1)
  })

  it('keeps sequence unique and strictly increasing under parallel completions', async () => {
    const records: TraceRecord[] = []
    const runtime = new TraceRuntime(createRunIdentity(), (record) => records.push(record))
    const spans = Array.from({ length: 100 }, (_, index) => runtime.startSpan({
      kind: 'task',
      name: 'execute_task',
      parent: runtime.root,
      attributes: { 'oma.task.index': index },
    }))

    await Promise.all(spans.map(async (span, index) => {
      await Promise.resolve(index)
      span.end({ status: { code: 'ok' } })
    }))
    runtime.close({ status: { code: 'ok' } })

    const sequences = records.map((record) => record.sequence)
    expect(new Set(sequences).size).toBe(sequences.length)
    expect(sequences).toEqual(Array.from({ length: sequences.length }, (_, index) => index + 1))
    expect(ended(records)).toHaveLength(101)
  })

  it('converts only completed v2 records back to the unchanged legacy callback shape', () => {
    const legacy = vi.fn<(event: TraceEvent) => void>()
    const runtime = new TraceRuntime(createRunIdentity({ runId: 'legacy-run' }), undefined, legacy)
    const span = runtime.startSpan({ kind: 'agent', name: 'invoke_agent', parent: runtime.root })
    const event: TraceEvent = {
      type: 'agent',
      runId: 'legacy-run',
      spanId: '86012c59-320f-42af-b891-a870ad4ab4dc',
      agent: 'worker',
      turns: 1,
      tokens: { input_tokens: 1, output_tokens: 2 },
      toolCalls: 0,
      startMs: 1,
      endMs: 2,
      durationMs: 1,
    }

    expect(legacy).not.toHaveBeenCalled()
    span.end({ status: { code: 'ok' }, legacyEvent: event })
    expect(legacy).toHaveBeenCalledOnce()
    expect(legacy).toHaveBeenCalledWith(event)
  })
})

describe('OBS-1B runtime integration', () => {
  it('closes LLM/agent/root spans for success, provider error, timeout, cancellation, and budget', async () => {
    const cases: Array<{
      expected: string
      agent: AgentConfig
      abort?: AbortSignal
    }> = [
      { expected: 'ok', agent: config('ok', adapter(async () => response('ok'))) },
      {
        expected: 'error',
        agent: config('error', adapter(async () => {
          throw Object.assign(new Error('provider failed'), { status: 503 })
        })),
      },
      {
        expected: 'timeout',
        agent: config('timeout', adapter(async (_messages, options) => {
          await new Promise<void>((resolve) => {
            if (options.abortSignal?.aborted) resolve()
            else options.abortSignal?.addEventListener('abort', () => resolve(), { once: true })
          })
          return response('late')
        }), { timeoutMs: 5 }),
      },
      {
        expected: 'budget_exhausted',
        agent: config('budget', adapter(async () => response('large', {
          input_tokens: 10,
          output_tokens: 10,
        })), { maxTokenBudget: 5 }),
      },
    ]

    for (const testCase of cases) {
      const records: TraceRecord[] = []
      const result = await tracedOrchestrator(records).runAgent(testCase.agent, 'hello')
      expect(result.status?.code).toBe(testCase.expected)
      expectClosed(records)
      expect(ended(records).find((record) => record.kind === 'run')?.status.code)
        .toBe(testCase.expected)
      if (testCase.expected !== 'budget_exhausted') {
        expect(ended(records).find((record) => record.kind === 'llm')?.status.code)
          .toBe(testCase.expected)
      }
    }

    const controller = new AbortController()
    controller.abort()
    const cancelledRecords: TraceRecord[] = []
    const cancelled = await tracedOrchestrator(cancelledRecords).runAgent(
      config('cancelled', adapter(async () => response('unused'))),
      'hello',
      { abortSignal: controller.signal },
    )
    expect(cancelled.status?.code).toBe('cancelled')
    expectClosed(cancelledRecords)
    expect(ended(cancelledRecords).some((record) => record.kind === 'llm')).toBe(false)

    const inFlightController = new AbortController()
    const inFlightRecords: TraceRecord[] = []
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const inFlight = tracedOrchestrator(inFlightRecords).runAgent(
      config('in-flight', adapter(async (_messages, options) => {
        markStarted()
        await new Promise<void>((resolve) => {
          if (options.abortSignal?.aborted) resolve()
          else options.abortSignal?.addEventListener('abort', () => resolve(), { once: true })
        })
        const error = new Error('aborted in flight')
        error.name = 'AbortError'
        throw error
      })),
      'hello',
      { abortSignal: inFlightController.signal },
    )
    await started
    inFlightController.abort()
    const inFlightResult = await inFlight
    expect(inFlightResult.status?.code).toBe('cancelled')
    expect(ended(inFlightRecords).find((record) => record.kind === 'llm')?.status.code)
      .toBe('cancelled')
    expectClosed(inFlightRecords)
  })

  it('closes the structured-output retry when its second LLM call fails', async () => {
    const records: TraceRecord[] = []
    let calls = 0
    const llm = adapter(async () => {
      if (calls++ === 0) return response('not-json')
      throw Object.assign(new Error('retry failed'), { status: 500 })
    })
    const result = await tracedOrchestrator(records).runAgent(config('structured', llm, {
      outputSchema: z.object({ value: z.string() }),
    }), 'return json')

    expect(result.success).toBe(false)
    expect(ended(records).filter((record) => record.kind === 'llm').map((record) => record.status.code))
      .toEqual(['ok', 'error'])
    expectClosed(records)
  })

  it('closes a failing context-summary LLM call', async () => {
    const records: TraceRecord[] = []
    let mainCalls = 0
    const llm = adapter(async (_messages, options) => {
      if (options.model === 'summary-model') {
        throw Object.assign(new Error('summary provider failed'), { status: 500 })
      }
      return mainCalls++ < 2 ? toolResponse('echo', { value: 'x'.repeat(200) }) : response('done')
    })
    const result = await tracedOrchestrator(records).runAgent(config('summary', llm, {
      customTools: [{
        name: 'echo',
        description: 'echo',
        inputSchema: z.object({ value: z.string() }),
        execute: async ({ value }) => ({ data: value }),
      }],
      tools: ['echo'],
      contextStrategy: { type: 'summarize', maxTokens: 1, summaryModel: 'summary-model' },
    }), 'start')

    expect(result.success).toBe(false)
    const llmEnds = ended(records).filter((record) => record.kind === 'llm')
    expect(llmEnds.map((record) => record.attributes['oma.phase'])).toEqual(['turn', 'turn', 'summary'])
    expect(llmEnds.map((record) => record.status.code)).toEqual(['ok', 'ok', 'error'])
    expectClosed(records)
  })

  it('models retry attempts and DAG dependencies without turning the DAG into a parent chain', async () => {
    const records: TraceRecord[] = []
    let calls = 0
    const llm = adapter(async () => {
      if (calls++ === 0) throw Object.assign(new Error('transient'), { status: 500 })
      return response('ok')
    })
    const team = new Team({ name: 'team', agents: [config('worker', llm)] })
    const result = await tracedOrchestrator(records).runTasks(team, [
      { title: 'first', description: 'first', assignee: 'worker', maxRetries: 1, retryDelayMs: 0 },
      { title: 'second', description: 'second', assignee: 'worker', dependsOn: ['first'] },
    ])

    expect(result.success).toBe(true)
    expectClosed(records)
    const taskEnds = ended(records).filter((record) => record.kind === 'task')
    expect(taskEnds).toHaveLength(2)
    expect(taskEnds.every((record) => record.parentSpanId === result.identity?.rootSpanId)).toBe(true)
    expect(taskEnds[1]!.links).toContainEqual(expect.objectContaining({
      relation: 'depends_on',
      spanId: taskEnds[0]!.spanId,
    }))
    const attempts = ended(records).filter((record) => record.kind === 'agent')
    expect(attempts.map((record) => record.status.code)).toEqual(['error', 'ok', 'ok'])
    expect(records.some((record) => record.recordType === 'span_event' && record.name === 'retry_scheduled'))
      .toBe(true)
  })

  it('keeps an agent/task/run ok when a tool error is handled by the next LLM turn', async () => {
    const records: TraceRecord[] = []
    let calls = 0
    const llm = adapter(async () => calls++ === 0
      ? toolResponse('boom', {})
      : response('handled'))
    const team = new Team({ name: 'team', agents: [config('worker', llm, {
      customTools: [{
        name: 'boom',
        description: 'fails',
        inputSchema: z.object({}),
        execute: async () => { throw new Error('tool failed') },
      }],
      tools: ['boom'],
    })] })
    const result = await tracedOrchestrator(records).runTasks(team, [
      { title: 'tool task', description: 'use tool', assignee: 'worker' },
    ])

    expect(result.success).toBe(true)
    expect(ended(records).find((record) => record.kind === 'tool')?.status.code).toBe('error')
    expect(ended(records).find((record) => record.kind === 'agent')?.status.code).toBe('ok')
    expect(ended(records).find((record) => record.kind === 'task')?.status.code).toBe('ok')
    expect(ended(records).find((record) => record.kind === 'run')?.status.code).toBe('ok')
    expectClosed(records)
  })

  it('parents a delegated agent under the delegate tool and links it back to the task', async () => {
    const records: TraceRecord[] = []
    let callerTurns = 0
    const caller = adapter(async () => callerTurns++ === 0
      ? toolResponse('delegate_to_agent', { target_agent: 'helper', prompt: 'help' })
      : response('done'))
    const helper = adapter(async () => response('helped'))
    const team = new Team({ name: 'team', agents: [
      config('caller', caller, { tools: ['delegate_to_agent'] }),
      config('helper', helper),
    ] })
    const result = await tracedOrchestrator(records, { maxConcurrency: 2 }).runTasks(team, [
      { title: 'delegate', description: 'delegate work', assignee: 'caller' },
    ])

    expect(result.success).toBe(true)
    expectClosed(records)
    const tool = ended(records).find((record) =>
      record.kind === 'tool' && record.attributes['oma.tool.name'] === 'delegate_to_agent')!
    const task = ended(records).find((record) => record.kind === 'task')!
    const delegated = ended(records).find((record) =>
      record.kind === 'agent' && record.attributes['oma.phase'] === 'delegated')!
    expect(delegated.parentSpanId).toBe(tool.spanId)
    expect(delegated.links).toContainEqual(expect.objectContaining({
      relation: 'delegated_from',
      spanId: task.spanId,
    }))
  })

  it('links coordinator synthesis to every consumed task span', async () => {
    const records: TraceRecord[] = []
    let coordinatorCalls = 0
    const coordinator = adapter(async () => response(coordinatorCalls++ === 0
      ? '```json\n[{"title":"work","description":"do work","assignee":"worker"}]\n```'
      : 'synthesized'))
    const team = new Team({
      name: 'team',
      agents: [config('worker', adapter(async () => response('task output')))],
    })
    const result = await tracedOrchestrator(records).runTeam(
      team,
      'First do the work, then synthesize the result',
      { coordinator: { adapter: coordinator } },
    )

    expect(result.success).toBe(true)
    expectClosed(records)
    const task = ended(records).find((record) => record.kind === 'task')!
    const synthesis = ended(records).find((record) =>
      record.kind === 'agent' && record.attributes['oma.phase'] === 'synthesis')!
    expect(synthesis.parentSpanId).toBe(result.identity?.rootSpanId)
    expect(synthesis.links).toContainEqual(expect.objectContaining({
      relation: 'consumed',
      spanId: task.spanId,
    }))
  })

  it('closes approval rejection and callback-throw paths distinctly', async () => {
    for (const throws of [false, true]) {
      const records: TraceRecord[] = []
      const oma = tracedOrchestrator(records, {
        onApproval: async () => {
          if (throws) throw new Error('approval failed')
          return false
        },
      })
      const team = new Team({
        name: 'team',
        agents: [config('worker', adapter(async () => response('ok')))],
      })
      const result = await oma.runTasks(team, [
        { title: 'first', description: 'first', assignee: 'worker' },
        { title: 'second', description: 'second', assignee: 'worker', dependsOn: ['first'] },
      ])

      expect(result.status?.code).toBe(throws ? 'error' : 'rejected')
      const callback = ended(records).find((record) => record.kind === 'callback')!
      expect(callback.status.code).toBe(throws ? 'error' : 'rejected')
      expect(callback.error?.kind).toBe(throws ? 'callback' : undefined)
      expectClosed(records)
    }
  })

  it('builds top-level consensus proposer/judge/revision hierarchy', async () => {
    const records: TraceRecord[] = []
    let proposerCalls = 0
    const proposer = adapter(async () => response(proposerCalls++ === 0 ? 'answer' : 'revised answer'))
    let judgeCalls = 0
    const judge = adapter(async () => response(judgeCalls++ === 0
      ? '{"accept":false,"critique":"revise"}'
      : '{"accept":true,"critique":""}'))
    const result = await tracedOrchestrator(records).runConsensus(
      new Team({ name: 'team', agents: [] }),
      'question',
      {
        proposer: config('proposer', proposer),
        judges: [config('judge', judge)],
        maxRounds: 2,
      },
    )

    expect(result.verdict).toBe('accepted')
    expectClosed(records)
    const consensus = ended(records).find((record) => record.kind === 'consensus')!
    const agents = ended(records).filter((record) => record.kind === 'agent')
    expect(agents).toHaveLength(4)
    expect(agents.every((record) => record.parentSpanId === consensus.spanId)).toBe(true)
    expect(agents.map((record) => record.attributes['oma.phase']))
      .toEqual(['proposer', 'judge', 'revision', 'judge'])
  })

  it('puts checkpoint restore on a new trace linked to the previous root', async () => {
    const records: TraceRecord[] = []
    const store = new InMemoryStore()
    const oma = tracedOrchestrator(records)
    const makeTeam = () => new Team({
      name: 'team',
      agents: [config('worker', adapter(async () => response('ok')))],
    })
    const initial = await oma.runTasks(makeTeam(), [
      { title: 'task', description: 'work', assignee: 'worker' },
    ], { checkpoint: { store, runId: 'continued-run' } })
    const restored = await oma.restore(makeTeam(), {
      checkpoint: { store, runId: 'continued-run' },
    })

    expect(restored.identity?.attempt).toBe(2)
    const restoredRoot = records.find((record) =>
      record.recordType === 'span_start'
      && record.spanId === restored.identity?.rootSpanId)
    expect(restoredRoot?.links).toContainEqual({
      traceId: initial.identity?.traceId,
      spanId: initial.identity?.rootSpanId,
      relation: 'continued_from',
    })
    expectClosed(records)
  })
})
