import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { Agent } from '../src/agent/agent.js'
import { AgentRunner } from '../src/agent/runner.js'
import { SharedMemory } from '../src/memory/shared.js'
import { ToolExecutor } from '../src/tool/executor.js'
import { ToolRegistry } from '../src/tool/framework.js'
import type { AgentConfig, LLMAdapter, LLMResponse } from '../src/types.js'

const DebriefSchema = z.object({
  questions_asked: z.array(
    z.object({
      question: z.string(),
      why_it_mattered: z.string(),
    }),
  ),
  weak_spots: z.array(z.string()),
  strong_spots: z.array(z.string()),
  overall_assessment: z.object({
    recommendation: z.enum(['strong-hire', 'hire', 'lean-hire', 'lean-no-hire', 'no-hire']),
    summary: z.string(),
  }),
})

function mockAdapter(responses: string[]): LLMAdapter {
  let callIndex = 0
  return {
    name: 'mock',
    async chat() {
      const text = responses[callIndex++] ?? ''
      return {
        id: `mock-${callIndex}`,
        content: [{ type: 'text' as const, text }],
        model: 'mock-model',
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 20 },
      } satisfies LLMResponse
    },
    async *stream() {
      /* unused */
    },
  }
}

function buildMockAgent(config: AgentConfig, responses: string[]): Agent {
  const adapter = mockAdapter(responses)
  const registry = new ToolRegistry()
  const executor = new ToolExecutor(registry)
  const agent = new Agent(config, registry, executor)
  const runner = new AgentRunner(adapter, registry, executor, {
    model: config.model,
    systemPrompt: config.systemPrompt,
    maxTurns: config.maxTurns,
    maxTokens: config.maxTokens,
    temperature: config.temperature,
    agentName: config.name,
  })
  ;(agent as any).runner = runner
  return agent
}

describe('personalized interview simulator architecture', () => {
  it('uses shared memory between interviewer turns and ends with structured debrief', async () => {
    const mem = new SharedMemory()

    await mem.write('candidate', 'resume', 'Built idempotent payment retry logic.')
    await mem.write('candidate', 'project-notes', 'Uses Redis keys to deduplicate webhook events.')
    await mem.write('candidate', 'code', 'POST /webhooks/stripe retries failed events.')
    await mem.write('role', 'target-job-spec', 'Test idempotency, transactions, and failure handling.')

    const interviewer = buildMockAgent(
      {
        name: 'interviewer',
        model: 'mock-model',
        systemPrompt: 'Ask one probing question at a time.',
        maxTurns: 2,
      },
      [
        'You mentioned idempotent retry logic. How did you prevent duplicate payment state transitions?',
        'Walk me through the transaction boundary you chose when a webhook retry arrives mid-update.',
      ],
    )

    const observer = buildMockAgent(
      {
        name: 'observer',
        model: 'mock-model',
        systemPrompt: 'Write compact observer flags.',
        maxTurns: 1,
      },
      [
        '- Candidate named idempotency keys but did not explain expiry choice.\n- Concurrency handling not yet tested.',
        '- Transaction boundary explanation was good.\n- Still probe race conditions around audit logging.',
      ],
    )

    const debriefPayload = {
      questions_asked: [
        {
          question: 'How did you prevent duplicate payment state transitions?',
          why_it_mattered: 'The role requires strong reasoning about idempotency under retries.',
        },
        {
          question: 'What transaction boundary did you choose during webhook retries?',
          why_it_mattered: 'The role expects correctness under concurrent updates.',
        },
      ],
      weak_spots: [
        'Did not justify idempotency key expiry tradeoff.',
      ],
      strong_spots: [
        'Explained transaction boundaries clearly.',
      ],
      overall_assessment: {
        recommendation: 'lean-hire',
        summary: 'Good backend fundamentals with one notable gap around retry-window tradeoffs.',
      },
    }

    const reporter = buildMockAgent(
      {
        name: 'reporter',
        model: 'mock-model',
        systemPrompt: 'Return a structured debrief.',
        maxTurns: 2,
        outputSchema: DebriefSchema,
      },
      [JSON.stringify(debriefPayload)],
    )

    let answer = ''
    for (let turn = 0; turn < 2; turn++) {
      const ctx = await mem.getSummary()
      const prompt = turn === 0
        ? `Context:\n${ctx}\n\nAsk the most probing opening question you can justify from the materials and role.`
        : `Context:\n${ctx}\n\nCandidate answer:\n${answer}\n\nAsk the next question.`

      const questionResult = await interviewer.prompt(prompt)
      expect(questionResult.success).toBe(true)

      answer = turn === 0
        ? 'We used a Redis idempotency key keyed by provider event id before mutating payment state.'
        : 'We wrapped the expense update and audit write in one database transaction.'

      await mem.write('interviewer', `turn-${turn}`, `Q: ${questionResult.output}\nA: ${answer}`)

      const observerResult = await observer.run(
        `Review transcript and candidate materials; write flags for the next turn:\n${await mem.getSummary()}`,
      )

      expect(observerResult.success).toBe(true)
      await mem.write('observer', 'flags', observerResult.output)
    }

    const summary = await mem.getSummary()
    expect(summary).toContain('candidate')
    expect(summary).toContain('role')
    expect(summary).toContain('interviewer')
    expect(summary).toContain('observer')
    expect(summary).toContain('Still probe race conditions around audit logging')

    const debrief = await reporter.run(`Summarize the full interview:\n${summary}`)
    expect(debrief.success).toBe(true)
    expect(debrief.structured).toBeDefined()
    expect(DebriefSchema.parse(debrief.structured)).toEqual(debriefPayload)

    const history = interviewer.getHistory()
    expect(history.length).toBe(4)
  })
})
