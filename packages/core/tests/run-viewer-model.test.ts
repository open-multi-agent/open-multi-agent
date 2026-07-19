import { describe, expect, it } from 'vitest'
import { buildRunViewerModel, RunViewerInputError } from '../src/dashboard/run-viewer-model.js'
import type { MaterializedSpan, StoredRun } from '../src/observability/store.js'
import type { SpanEndRecord } from '../src/observability/records.js'
import type { TeamRunResult } from '../src/types.js'

function result(runId = 'run-1'): TeamRunResult {
  return {
    success: true,
    identity: {
      runId,
      attempt: 1,
      traceId: '1'.repeat(32),
      rootSpanId: '1'.repeat(16),
    },
    status: { code: 'ok' },
    tasks: [
      { id: 'a', title: 'Collect evidence', assignee: 'researcher', status: 'completed', dependsOn: [] },
      { id: 'b', title: 'Write answer', assignee: 'writer', status: 'completed', dependsOn: ['a'] },
    ],
    agentResults: new Map(),
    totalTokenUsage: { input_tokens: 13, output_tokens: 8 },
    metrics: {
      totalTokens: { input_tokens: 13, output_tokens: 8 },
      totalRetries: 0,
      errorCount: 0,
      failureCount: 0,
      completedCount: 2,
      totalDurationMs: 100,
    },
  }
}

function storedRun(runId = 'run-1'): StoredRun {
  const traceId = '1'.repeat(32)
  const rootId = '1'.repeat(16)
  const taskAId = '2'.repeat(16)
  const taskBId = '3'.repeat(16)
  const endRecord: SpanEndRecord = {
    schemaVersion: 2,
    recordType: 'span_end',
    recordId: 'record-task-b',
    sequence: 6,
    timestampUnixMs: 1_100,
    runId,
    attempt: 1,
    traceId,
    spanId: taskBId,
    parentSpanId: rootId,
    kind: 'task',
    name: 'execute_task',
    startUnixMs: 1_050,
    endUnixMs: 1_100,
    durationMs: 50,
    status: { code: 'error' },
    error: { kind: 'provider', name: 'ProviderError', code: 'E_PROVIDER', message: 'safe failure' },
    attributes: {
      'oma.task.id': 'b',
      'oma.task.title': 'Write answer',
      'oma.agent.name': 'writer',
      'private.payload': 'must-not-appear',
    },
    links: [{ traceId, spanId: taskAId, relation: 'depends_on' }],
  }
  return {
    schemaVersion: 2,
    runId,
    attempts: [{
      attempt: 1,
      traceId,
      rootSpanId: rootId,
      startedAt: new Date(1_000).toISOString(),
      endedAt: new Date(1_100).toISOString(),
      durationMs: 100,
      status: 'error',
      incomplete: false,
    }],
    startedAt: new Date(1_000).toISOString(),
    endedAt: new Date(1_100).toISOString(),
    durationMs: 100,
    status: 'error',
    agents: ['researcher', 'writer'],
    taskIds: ['a', 'b'],
    models: ['model-a'],
    providers: ['provider-a'],
    tokens: { input_tokens: 13, output_tokens: 8 },
    costs: [{ amount: 0.01, currency: 'USD' }],
    incomplete: false,
    spans: [
      {
        traceId,
        spanId: rootId,
        kind: 'run',
        name: 'oma.run',
        startUnixMs: 1_000,
        endUnixMs: 1_100,
        durationMs: 100,
        status: 'error',
        attributes: {},
        links: [],
        events: [],
        incomplete: false,
      },
      {
        traceId,
        spanId: taskAId,
        parentSpanId: rootId,
        kind: 'task',
        name: 'execute_task',
        startUnixMs: 1_010,
        endUnixMs: 1_040,
        durationMs: 30,
        status: 'ok',
        attributes: {
          'oma.task.id': 'a',
          'oma.task.title': 'Collect evidence',
          'oma.agent.name': 'researcher',
        },
        links: [],
        events: [],
        incomplete: false,
      },
      {
        traceId,
        spanId: taskBId,
        parentSpanId: rootId,
        kind: 'task',
        name: 'execute_task',
        startUnixMs: 1_050,
        endUnixMs: 1_100,
        durationMs: 50,
        status: 'error',
        attributes: endRecord.attributes,
        links: endRecord.links ?? [],
        events: [{
          schemaVersion: 2,
          recordType: 'span_event',
          recordId: 'event-1',
          sequence: 5,
          timestampUnixMs: 1_075,
          runId,
          attempt: 1,
          traceId,
          spanId: taskBId,
          parentSpanId: rootId,
          name: 'retry_scheduled',
          attributes: { 'oma.retry.attempt': 2, 'unsafe.content': 'hidden' },
        }],
        incomplete: false,
      },
    ],
    records: [endRecord],
  }
}

describe('buildRunViewerModel', () => {
  it('rejects missing, mismatched, and unsupported sources with stable codes', () => {
    expect(() => buildRunViewerModel({})).toThrowError(expect.objectContaining({ code: 'MISSING_SOURCE' }))
    expect(() => buildRunViewerModel({ result: result('one'), run: storedRun('two') }))
      .toThrowError(expect.objectContaining({ code: 'RUN_ID_MISMATCH' }))
    const unsupported = { ...storedRun(), schemaVersion: 3 } as unknown as StoredRun
    expect(() => buildRunViewerModel({ run: unsupported }))
      .toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_SCHEMA_VERSION' }))
    expect(new RunViewerInputError('MISSING_SOURCE', 'x').name).toBe('RunViewerInputError')
  })

  it('builds a useful result-only model without fabricating trace detail', () => {
    const model = buildRunViewerModel({ result: result() })
    expect(model.sourceMode).toBe('result')
    expect(model.summary).toMatchObject({ runId: 'run-1', status: 'ok', inputTokens: 13, outputTokens: 8 })
    expect(model.tasks.map((task) => [task.id, task.dependsOn])).toEqual([['a', []], ['b', ['a']]])
    expect(model.spans).toEqual([])
    expect(model.warnings).toContainEqual(expect.objectContaining({ code: 'TRACE_DETAILS_UNAVAILABLE' }))
  })

  it('derives a trace-only task DAG, safe span facts, links, events, and structured errors', () => {
    const model = buildRunViewerModel({ run: storedRun() })
    expect(model.sourceMode).toBe('trace')
    expect(model.tasks.map((task) => [task.id, task.dependsOn])).toEqual([['a', []], ['b', ['a']]])
    const failed = model.spans.find((span) => span.taskId === 'b')!
    expect(failed.error).toMatchObject({ code: 'E_PROVIDER', message: 'safe failure' })
    expect(failed.events).toEqual([expect.objectContaining({
      name: 'retry_scheduled',
      facts: [{ label: 'Retry attempt', value: 2 }],
    })])
    expect(JSON.stringify(failed)).not.toContain('must-not-appear')
    expect(JSON.stringify(failed)).not.toContain('unsafe.content')
    expect(model.spans.find((span) => span.kind === 'run')?.costs).toBeUndefined()
  })

  it('uses the exact result graph while linking tasks to trace spans in combined mode', () => {
    const model = buildRunViewerModel({ result: result(), run: storedRun() }, { title: 'Trace review' })
    expect(model.sourceMode).toBe('combined')
    expect(model.title).toBe('Trace review')
    expect(model.tasks.find((task) => task.id === 'b')).toMatchObject({
      dependsOn: ['a'],
      spanKey: `${'1'.repeat(32)}:${'3'.repeat(16)}`,
    })
    expect(model.summary).toMatchObject({
      costs: [{ amount: 0.01, currency: 'USD' }],
      models: ['model-a'],
      providers: ['provider-a'],
    })
    expect(model.warnings).toEqual([])
  })

  it('degrades cyclic result tasks to a stable list with a visible warning', () => {
    const cyclic: TeamRunResult = {
      ...result(),
      tasks: [
        { id: 'a', title: 'A', status: 'pending', dependsOn: ['b'] },
        { id: 'b', title: 'B', status: 'pending', dependsOn: ['a'] },
      ],
    }
    const model = buildRunViewerModel({ result: cyclic })
    expect(model.dag.degraded).toBe(true)
    expect(model.warnings).toContainEqual(expect.objectContaining({ code: 'DAG_LAYOUT_FAILED' }))
  })

  it('preserves every span kind, attempt, event, link relation, cost, and incomplete state', () => {
    const firstTrace = 'a'.repeat(32)
    const secondTrace = 'b'.repeat(32)
    const kinds = ['run', 'agent', 'task', 'llm', 'tool', 'plan', 'consensus', 'checkpoint', 'callback'] as const
    const spans: MaterializedSpan[] = kinds.map((kind, index) => ({
      traceId: firstTrace,
      spanId: String(index + 1).padStart(16, '0'),
      ...(index ? { parentSpanId: '0000000000000001' } : {}),
      kind,
      name: `${kind}.operation`,
      startUnixMs: 2_000 + index * 10,
      endUnixMs: 2_005 + index * 10,
      durationMs: 5,
      status: 'ok',
      attributes: kind === 'llm' ? {
        'oma.llm.model': 'demo-model',
        'oma.llm.provider': 'demo-provider',
        'oma.usage.input_tokens': 7,
        'oma.usage.output_tokens': 3,
        'oma.cost.amount': 0.004,
        'oma.cost.currency': 'EUR',
      } : {},
      links: kind === 'callback' ? [
        { traceId: firstTrace, spanId: '0000000000000002', relation: 'continued_from' },
        { traceId: firstTrace, spanId: '0000000000000003', relation: 'depends_on' },
        { traceId: firstTrace, spanId: '0000000000000004', relation: 'consumed' },
        { traceId: firstTrace, spanId: '0000000000000005', relation: 'delegated_from' },
      ] : [],
      events: kind === 'tool' ? [{
        schemaVersion: 2,
        recordType: 'span_event',
        recordId: 'retry-event',
        sequence: 1,
        timestampUnixMs: 2_045,
        runId: 'run-all-kinds',
        attempt: 1,
        traceId: firstTrace,
        spanId: '0000000000000005',
        name: 'retry_scheduled',
        attributes: { 'oma.retry.attempt': 2 },
      }] : [],
      incomplete: false,
    }))
    spans.push({
      traceId: secondTrace,
      spanId: 'ffffffffffffffff',
      kind: 'agent',
      name: 'start-only',
      startUnixMs: 5_000,
      attributes: {},
      links: [],
      events: [],
      incomplete: true,
    }, {
      traceId: secondTrace,
      spanId: 'eeeeeeeeeeeeeeee',
      name: 'unknown-missing-timing',
      attributes: {},
      links: [],
      events: [],
      incomplete: false,
    })
    const run: StoredRun = {
      ...storedRun('run-all-kinds'),
      attempts: [
        { attempt: 1, traceId: firstTrace, startedAt: new Date(2_000).toISOString(), endedAt: new Date(2_100).toISOString(), durationMs: 100, status: 'ok', incomplete: false },
        { attempt: 2, traceId: secondTrace, startedAt: new Date(5_000).toISOString(), incomplete: true },
      ],
      spans,
      models: ['demo-model'],
      providers: ['demo-provider'],
      costs: [{ amount: 0.004, currency: 'EUR' }],
      incomplete: true,
      records: undefined,
    }
    const model = buildRunViewerModel({ run })
    expect(new Set(model.spans.map((span) => span.kind))).toEqual(new Set([...kinds, 'unknown']))
    expect(model.spans.map((span) => span.attempt)).toContain(2)
    expect(model.spans.find((span) => span.name === 'start-only')).toMatchObject({
      status: 'in_progress',
      incomplete: true,
    })
    expect(model.spans.find((span) => span.name === 'unknown-missing-timing')?.status).toBe('unknown')
    expect(model.spans.find((span) => span.kind === 'llm')).toMatchObject({
      tokens: { input_tokens: 7, output_tokens: 3 },
      costs: [{ amount: 0.004, currency: 'EUR' }],
    })
    expect(model.spans.find((span) => span.kind === 'tool')?.events[0]).toMatchObject({
      name: 'retry_scheduled',
      facts: [{ label: 'Retry attempt', value: 2 }],
    })
    expect(model.spans.find((span) => span.kind === 'callback')?.links.map((link) => link.relation))
      .toEqual(['continued_from', 'depends_on', 'consumed', 'delegated_from'])
  })

  it('rolls a task\'s descendant LLM spans up into task-level model, provider, and cost', () => {
    const runId = 'run-rollup'
    const traceId = '1'.repeat(32)
    const mkSpan = (
      spanId: string,
      kind: MaterializedSpan['kind'],
      parentSpanId: string | undefined,
      attributes: MaterializedSpan['attributes'] = {},
    ): MaterializedSpan => ({
      traceId,
      spanId,
      ...(parentSpanId ? { parentSpanId } : {}),
      kind,
      name: `${kind}.op`,
      startUnixMs: 3_000,
      endUnixMs: 3_050,
      durationMs: 50,
      status: 'ok',
      attributes,
      links: [],
      events: [],
      incomplete: false,
    })
    const combinedResult: TeamRunResult = {
      ...result(runId),
      tasks: [{ id: 't1', title: 'Build API', assignee: 'architect', status: 'completed', dependsOn: [] }],
    }
    const run: StoredRun = {
      ...storedRun(runId),
      taskIds: ['t1'],
      agents: ['architect'],
      records: undefined,
      // run → task → agent → { llm, llm, tool }. LLM spans carry no oma.task.id,
      // so the roll-up must reach them by walking down from the task span.
      spans: [
        mkSpan('0000000000000001', 'run', undefined),
        mkSpan('0000000000000002', 'task', '0000000000000001', {
          'oma.task.id': 't1',
          'oma.task.title': 'Build API',
          'oma.agent.name': 'architect',
        }),
        mkSpan('0000000000000003', 'agent', '0000000000000002', { 'oma.agent.name': 'architect' }),
        mkSpan('0000000000000004', 'llm', '0000000000000003', {
          'oma.llm.model': 'deepseek-v4-pro',
          'oma.llm.provider': 'deepseek',
          'oma.cost.amount': 0.01,
          'oma.cost.currency': 'USD',
        }),
        mkSpan('0000000000000005', 'llm', '0000000000000003', {
          'oma.llm.model': 'deepseek-v4-pro',
          'oma.llm.provider': 'deepseek',
          'oma.cost.amount': 0.02,
          'oma.cost.currency': 'USD',
        }),
        mkSpan('0000000000000006', 'tool', '0000000000000003', { 'oma.tool.name': 'file_write' }),
      ],
    }
    const task = buildRunViewerModel({ result: combinedResult, run }).tasks.find((t) => t.id === 't1')!
    expect(task).toMatchObject({ model: 'deepseek-v4-pro', provider: 'deepseek' })
    expect(task.costs).toEqual([{ amount: expect.closeTo(0.03, 10), currency: 'USD' }])
  })
})
