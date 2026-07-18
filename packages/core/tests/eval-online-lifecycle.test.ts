import { describe, expect, it } from 'vitest'
import { InMemoryEvalStore, type EvalStore } from '../src/eval/store.js'
import type { Scorer } from '../src/eval/scorer.js'
import { InMemoryStore } from '../src/memory/store.js'
import { OpenMultiAgent } from '../src/orchestrator/orchestrator.js'
import { Team } from '../src/team/team.js'
import type {
  AgentConfig,
  LLMAdapter,
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  RunOutcomeFields,
} from '../src/types.js'

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
  return { name: 'online-eval-test', chat, async *stream() { /* unused */ } }
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

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

const passScorer: Scorer = {
  name: 'length',
  version: '1',
  score({ output }) {
    return { score: String(output).length > 0 ? 1 : 0, pass: String(output).length > 0 }
  },
}

describe('OpenMultiAgent online evaluation lifecycle', () => {
  it('uses one shared no-op lifecycle when evaluation is absent or sample is zero', () => {
    const absent = new OpenMultiAgent()
    const zero = new OpenMultiAgent({
      evaluation: { scorers: [], sample: 0 },
    })

    expect(absent.evaluation).toBe(zero.evaluation)
    expect(absent.evaluation.getStats()).toEqual({
      sampled: 0,
      enqueued: 0,
      completed: 0,
      dropped: 0,
      failed: 0,
      storeFailed: 0,
    })
  })

  it('returns the business result without waiting for a slow scorer', async () => {
    const started = deferred()
    const release = deferred()
    const store = new InMemoryEvalStore()
    const slowScorer: Scorer = {
      name: 'slow',
      async score() {
        started.resolve()
        await release.promise
        return { score: 1 }
      },
    }
    const oma = new OpenMultiAgent({
      defaultModel: 'test-model',
      evaluation: { scorers: [slowScorer], sample: 1, store },
    })

    const run = await oma.runAgent(agentConfig(), 'hello')
    expect(run.success).toBe(true)
    expect(oma.evaluation.getStats().completed).toBe(0)

    await started.promise
    expect(oma.evaluation.getStats().completed).toBe(0)
    release.resolve()
    await oma.evaluation.forceFlush({ timeoutMs: 1_000 })
    expect((await store.query({ runId: [run.identity!.runId] })).items).toHaveLength(1)
  })

  it('samples all six top-level entries and preserves restore attempt identity', async () => {
    const store = new InMemoryEvalStore()
    const oma = new OpenMultiAgent({
      defaultModel: 'test-model',
      evaluation: { scorers: [passScorer], sample: 1, store },
    })
    const metadata = { deployment: 'canary' } as const

    const runAgent = await oma.runAgent(agentConfig(), 'hello', { metadata })
    const runTeam = await oma.runTeam(teamWith(), 'Say hello', { metadata })
    const runTasks = await oma.runTasks(teamWith(), [
      { title: 'task', description: 'work', assignee: 'worker' },
    ], { metadata })
    const runFromPlan = await oma.runFromPlan(teamWith(), {
      version: 1,
      tasks: [{ id: 'planned', title: 'planned', description: 'work', assignee: 'worker' }],
    }, { metadata })

    let consensusCall = 0
    const consensusAdapter = adapter(async () => response(
      consensusCall++ === 0 ? 'answer' : '{"accept":true,"critique":""}',
    ))
    const runConsensus = await oma.runConsensus(teamWith(), 'question', {
      proposer: agentConfig('proposer', consensusAdapter),
      judges: [agentConfig('judge', consensusAdapter)],
      maxRounds: 1,
      metadata,
    })

    const checkpointStore = new InMemoryStore()
    const checkpointRunId = 'online-restore'
    await new OpenMultiAgent({ defaultModel: 'test-model' }).runTasks(teamWith(), [
      { title: 'checkpointed', description: 'work', assignee: 'worker' },
    ], { checkpoint: { store: checkpointStore, runId: checkpointRunId }, metadata })
    const restore = await oma.restore(teamWith(), {
      checkpoint: { store: checkpointStore, runId: checkpointRunId },
    })

    const results: RunOutcomeFields[] = [
      runAgent,
      runTeam,
      runTasks,
      runFromPlan,
      runConsensus,
      restore,
    ]
    await oma.evaluation.forceFlush({ timeoutMs: 2_000 })
    const records = (await store.query({ source: 'online', order: 'time_asc' })).items

    expect(records).toHaveLength(6)
    expect(new Set(records.map((record) => record.evalRunId)).size).toBe(1)
    for (const outcome of results) {
      const record = records.find((candidate) => candidate.runRef?.runId === outcome.identity?.runId)
      expect(record).toMatchObject({
        source: 'online',
        scorer: { name: 'length', version: '1' },
        status: 'scored',
      })
    }
    const restoredRecord = records.find((record) => record.runRef?.runId === checkpointRunId)
    expect(restoredRecord?.runRef?.attempt).toBe(2)
    expect(restoredRecord?.metadata).toEqual(metadata)
  })

  it('never changes the business result when scoring or storage fails', async () => {
    const rejectingStore: EvalStore = {
      async append() { throw new Error('store rejected') },
      async query() { return { items: [] } },
      async delete() { return { runsDeleted: 0, recordsDeleted: 0, runIds: [] } },
      async applyRetention() { return { runsDeleted: 0, recordsDeleted: 0, runIds: [] } },
    }
    const throwingScorer: Scorer = {
      name: 'throws',
      score() { throw new Error('scorer rejected') },
    }
    const oma = new OpenMultiAgent({
      defaultModel: 'test-model',
      evaluation: {
        scorers: [throwingScorer],
        sample: 1,
        store: rejectingStore,
        diagnostics: 'silent',
      },
    })

    const business = await oma.runAgent(agentConfig(), 'business prompt')
    expect(business).toMatchObject({ success: true, output: 'ok', status: { code: 'ok' } })
    await oma.evaluation.forceFlush({ timeoutMs: 1_000 })
    expect(business).toMatchObject({ success: true, output: 'ok', status: { code: 'ok' } })
    expect(oma.evaluation.getStats()).toMatchObject({ failed: 1, storeFailed: 1 })
  })
})
