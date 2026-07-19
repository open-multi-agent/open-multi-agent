import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  costBudgetScorer,
  createAnswerRelevancyScorer,
  defineScorer,
  dependencyUtilizationScorer,
  duplicateWorkScorer,
  noProgressScorer,
  structuredOutputComplianceScorer,
  toolCallSuccessScorer,
  type ScorerContext,
} from '../src/eval/index.js'
import type { MaterializedSpan, StoredRun } from '../src/observability/store.js'
import type {
  AgentRunResult,
  LLMAdapter,
  LLMMessage,
  LLMResponse,
  TeamRunResult,
} from '../src/types.js'

function context(overrides: Partial<ScorerContext> = {}): ScorerContext {
  return {
    evalCase: { id: 'case-1', input: 'input', expected: 'expected' },
    output: 'output',
    metadata: {},
    signal: new AbortController().signal,
    ...overrides,
  }
}

function agentResult(
  output = 'output',
  overrides: Partial<AgentRunResult> = {},
): AgentRunResult {
  return {
    success: true,
    output,
    messages: [],
    tokenUsage: { input_tokens: 4, output_tokens: 2 },
    toolCalls: [],
    ...overrides,
  }
}

function teamResult(outputs: Readonly<Record<string, string>>): TeamRunResult {
  return {
    success: true,
    agentResults: new Map(Object.entries(outputs).map(([key, output]) => [key, agentResult(output)])),
    totalTokenUsage: { input_tokens: 12, output_tokens: 6 },
  }
}

function span(
  spanId: string,
  kind: MaterializedSpan['kind'],
  options: Partial<MaterializedSpan> = {},
): MaterializedSpan {
  return {
    traceId: '1'.repeat(32),
    spanId,
    kind,
    name: String(kind),
    startUnixMs: Number(spanId.replace(/\D/g, '')) || 0,
    endUnixMs: (Number(spanId.replace(/\D/g, '')) || 0) + 1,
    status: 'ok',
    attributes: {},
    links: [],
    events: [],
    incomplete: false,
    ...options,
  }
}

function storedRun(spans: readonly MaterializedSpan[], costs: StoredRun['costs'] = []): StoredRun {
  return {
    schemaVersion: 2,
    runId: 'run-1',
    attempts: [{
      attempt: 1,
      traceId: '1'.repeat(32),
      rootSpanId: '0'.repeat(16),
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:01.000Z',
      durationMs: 1_000,
      status: 'ok',
      incomplete: false,
    }],
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1_000,
    status: 'ok',
    agents: [],
    taskIds: [],
    models: [],
    providers: [],
    tokens: { input_tokens: 0, output_tokens: 0 },
    costs,
    incomplete: false,
    spans,
  }
}

function userPrompt(messages: LLMMessage[]): string {
  const message = [...messages].reverse().find((candidate) => candidate.role === 'user')
  return (message?.content ?? [])
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

describe('reference rule scorers', () => {
  it('scores trace tool outcomes and treats no tool calls as explicitly not applicable', async () => {
    const scorer = toolCallSuccessScorer()
    await expect(Promise.resolve(scorer.score(context({ result: agentResult() })))).resolves.toMatchObject({
      score: 1,
      pass: true,
      details: { tool_calls: 0, source: 'none' },
    })

    const trace = storedRun([
      span('tool-1', 'tool', { attributes: { 'oma.tool.is_error': false } }),
      span('tool-2', 'tool', { status: 'error', attributes: { 'oma.tool.is_error': true } }),
    ])
    await expect(Promise.resolve(scorer.score(context({ trace })))).resolves.toMatchObject({
      score: 0.5,
      pass: false,
      details: { tool_calls: 2, successful_tool_calls: 1, source: 'trace' },
    })
  })

  it('uses completed result tool calls when a trace is unavailable', async () => {
    const result = agentResult('done', {
      toolCalls: [
        { toolName: 'read', input: {}, output: 'ok', duration: 1 },
        { toolName: 'write', input: {}, output: 'ok', duration: 1 },
      ],
    })
    await expect(Promise.resolve(toolCallSuccessScorer().score(context({ result })))).resolves.toMatchObject({
      score: 1,
      details: { tool_calls: 2, source: 'result' },
    })
  })

  it('requires structured output and optionally validates it with Zod', async () => {
    const schema = z.object({ answer: z.number() })
    const scorer = structuredOutputComplianceScorer(schema)
    await expect(Promise.resolve(scorer.score(context({ result: agentResult() })))).resolves.toMatchObject({
      score: 0,
      pass: false,
      details: { structured_present: false },
    })
    await expect(Promise.resolve(scorer.score(context({
      result: agentResult('ok', { structured: { answer: 'wrong' } }),
    })))).resolves.toMatchObject({ score: 0, pass: false })
    await expect(Promise.resolve(scorer.score(context({
      result: agentResult('ok', { structured: { answer: 42 } }),
    })))).resolves.toMatchObject({ score: 1, pass: true })
  })

  it('applies hard token and cost ceilings and exposes unavailable data', async () => {
    const scorer = costBudgetScorer({ maxTokens: 7, maxCostAmount: 0.5 })
    await expect(Promise.resolve(scorer.score(context({
      result: agentResult(),
      trace: storedRun([], [{ amount: 0.25, currency: 'USD' }]),
    })))).resolves.toMatchObject({
      score: 1,
      pass: true,
      details: { total_tokens: 6, cost_amount: 0.25, data_complete: true },
    })
    await expect(Promise.resolve(scorer.score(context({
      result: agentResult('over', { tokenUsage: { input_tokens: 8, output_tokens: 2 } }),
      trace: storedRun([], [{ amount: 0.75, currency: 'USD' }]),
    })))).resolves.toMatchObject({ score: 0, pass: false })
    await expect(Promise.resolve(costBudgetScorer({ maxCostAmount: 1 }).score(context())))
      .resolves.toMatchObject({
      score: 1,
      details: { applicable: false, data_complete: false },
    })
  })

  it('rejects invalid budget options and incomparable cost currencies', async () => {
    expect(() => costBudgetScorer({})).toThrow(/requires/i)
    const scorer = costBudgetScorer({ maxCostAmount: 10 })
    expect(() => scorer.score(context({
      trace: storedRun([], [
        { amount: 1, currency: 'USD' },
        { amount: 1, currency: 'EUR' },
      ]),
    }))).toThrow(/multiple currencies/i)
  })
})

describe('reference structure scorers', () => {
  it('scores complete dependency chains and makes missing traces explicit', async () => {
    const scorer = dependencyUtilizationScorer()
    await expect(Promise.resolve(scorer.score(context()))).resolves.toMatchObject({
      score: 1,
      details: { applicable: false },
    })
    await expect(Promise.resolve(scorer.score(context({
      trace: storedRun([span('task-standalone', 'task', {
        attributes: { 'oma.task.id': 'standalone' },
      })]),
    })))).resolves.toMatchObject({ score: 1, details: { applicable: false } })
    const trace = storedRun([
      span('task-1', 'task', { attributes: { 'oma.task.id': 't1' } }),
      span('task-2', 'task', {
        attributes: { 'oma.task.id': 't2' },
        links: [{ traceId: '1'.repeat(32), spanId: 'task-1', relation: 'depends_on' }],
      }),
      span('task-3', 'task', {
        attributes: { 'oma.task.id': 't3' },
        links: [{ traceId: '1'.repeat(32), spanId: 'missing', relation: 'depends_on' }],
      }),
    ])
    await expect(Promise.resolve(scorer.score(context({ trace })))).resolves.toMatchObject({
      score: 0.5,
      details: {
        dependency_tasks: 2,
        complete_dependency_tasks: 1,
        missing_dependency_links: 1,
      },
    })
  })

  it('penalizes duplicate task outputs from a traced Team run', async () => {
    const trace = storedRun([
      span('task-1', 'task', { attributes: { 'oma.task.id': 't1', 'oma.agent.name': 'a' } }),
      span('task-2', 'task', { attributes: { 'oma.task.id': 't2', 'oma.agent.name': 'b' } }),
      span('task-3', 'task', { attributes: { 'oma.task.id': 't3', 'oma.agent.name': 'c' } }),
    ])
    const result = teamResult({
      'a:t1': 'same task output',
      'b:t2': 'same task output',
      'c:t3': 'completely unrelated material',
    })
    const scored = await duplicateWorkScorer().score(context({ trace, result }))
    expect(scored.score).toBeCloseTo(2 / 3)
    expect(scored.details).toMatchObject({
      applicable: true,
      compared_pairs: 3,
      duplicate_pairs: 1,
      max_similarity: 1,
    })
    await expect(Promise.resolve(duplicateWorkScorer().score(context({ result }))))
      .resolves.toMatchObject({
      score: 1,
      details: { applicable: false },
    })
  })

  it('scores consecutive failed no-tool task attempts as a conservative stall proxy', async () => {
    const trace = storedRun([
      span('task-1', 'task', { status: 'error', attributes: { 'oma.task.id': 't1' } }),
      span('agent-1', 'agent', {
        parentSpanId: 'task-1',
        status: 'error',
        attributes: { 'oma.task.id': 't1', 'oma.agent.turns': 1, 'oma.agent.tool_calls': 0 },
      }),
      span('task-2', 'task', { status: 'error', attributes: { 'oma.task.id': 't2' } }),
      span('agent-2', 'agent', {
        parentSpanId: 'task-2',
        status: 'error',
        attributes: { 'oma.task.id': 't2', 'oma.agent.turns': 1, 'oma.agent.tool_calls': 0 },
      }),
      span('task-3', 'task', { attributes: { 'oma.task.id': 't3' } }),
      span('agent-3', 'agent', {
        parentSpanId: 'task-3',
        attributes: { 'oma.task.id': 't3', 'oma.agent.turns': 1, 'oma.agent.tool_calls': 0 },
      }),
    ])
    await expect(Promise.resolve(noProgressScorer({ maxStallTurns: 1 }).score(context({ trace }))))
      .resolves.toMatchObject({
        score: 0.5,
        details: { observed_attempts: 3, stalled_attempts: 2, max_consecutive_stalls: 2 },
      })
    await expect(Promise.resolve(noProgressScorer().score(context()))).resolves.toMatchObject({
      score: 1,
      details: { applicable: false },
    })
  })
})

describe('reference judge scorer and version discipline', () => {
  it('runs the answer-relevancy template end to end with a mock adapter', async () => {
    const prompts: string[] = []
    const adapter: LLMAdapter = {
      name: 'mock',
      async chat(messages): Promise<LLMResponse> {
        const prompt = userPrompt(messages)
        prompts.push(prompt)
        const irrelevant = prompt.includes('unrelated answer')
        return {
          id: 'judge-response',
          content: [{
            type: 'text',
            text: irrelevant
              ? '{"score":0.1,"reason":"unrelated"}'
              : '{"score":0.75,"reason":"mostly relevant"}',
          }],
          model: 'mock-model',
          stop_reason: 'end_turn',
          usage: { input_tokens: 2, output_tokens: 1 },
        }
      },
      async *stream() {
        yield { type: 'done' as const, data: {} }
      },
    }
    const scorer = createAnswerRelevancyScorer({
      version: 'prompt-v1',
      judges: [{ name: 'judge', model: 'mock-model', adapter }],
    })
    await expect(scorer.score(context({
      evalCase: { id: 'case-1', input: 'Name the capital of France', expected: 'Paris' },
      output: 'Paris is the capital.',
    }))).resolves.toMatchObject({ score: 0.75, reason: 'judge: mostly relevant' })
    expect(prompts[0]).toContain('Evaluate only answer relevancy.')
    expect(prompts[0]).toContain('Name the capital of France')
    expect(prompts[0]).toContain('Paris is the capital.')
    await expect(scorer.score(context({ output: 'unrelated answer' })))
      .resolves.toMatchObject({ score: 0.1, reason: 'judge: unrelated' })
    await expect(scorer.score(context({
      evalCase: { id: 'no-expected', input: 'Summarize this.' },
      output: 'A concise summary.',
    }))).resolves.toMatchObject({ score: 0.75 })
    expect(prompts[2]).toContain('(not provided)')
  })

  it('warns once per scorer name when version is omitted', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    defineScorer({ name: 'unversioned-reference-test', score: () => ({ score: 1 }) })
    defineScorer({ name: 'unversioned-reference-test', score: () => ({ score: 1 }) })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('has no version'))
    warn.mockRestore()
  })
})
