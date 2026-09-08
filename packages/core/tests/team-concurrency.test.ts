import { describe, it, expect, beforeEach, vi } from 'vitest'
import { OpenMultiAgent } from '../src/orchestrator/orchestrator.js'
import type {
  AgentConfig,
  LLMAdapter,
  LLMResponse,
  OrchestratorEvent,
  Task,
} from '../src/types.js'

// Tracks how many agent runs the pool has in flight at once. Every mocked
// chat() call holds a slot for a fixed delay, so `peak` is the concurrency the
// pool actually granted rather than the concurrency it was configured for.
const tracker = {
  inFlight: 0,
  peak: 0,
  reset(): void {
    this.inFlight = 0
    this.peak = 0
  },
}

const HOLD_MS = 25

vi.mock('../src/llm/adapter.js', () => ({
  createAdapter: async () => ({
    name: 'mock',
    async chat(): Promise<LLMResponse> {
      tracker.inFlight += 1
      tracker.peak = Math.max(tracker.peak, tracker.inFlight)
      try {
        await new Promise((resolve) => setTimeout(resolve, HOLD_MS))
        return {
          id: 'r-1',
          content: [{ type: 'text', text: 'done' }],
          model: 'mock-model',
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }
      } finally {
        tracker.inFlight -= 1
      }
    },
    async *stream() { yield { type: 'done' as const, data: {} } },
  }),
}))

const TASK_COUNT = 6

// One agent per task: AgentPool serializes runs on the same Agent instance via
// a per-agent mutex, so sharing an agent would cap concurrency below the pool
// limit and hide what is being measured.
function agents(): AgentConfig[] {
  return Array.from({ length: TASK_COUNT }, (_unused, i) => ({
    name: `worker-${i}`,
    model: 'mock-model',
    provider: 'openai' as const,
    systemPrompt: 'Answer briefly.',
    maxTurns: 1,
  }))
}

function tasks(): Array<Pick<Task, 'title' | 'description' | 'assignee'>> {
  return Array.from({ length: TASK_COUNT }, (_unused, i) => ({
    title: `task-${i}`,
    description: 'Independent unit of work with no dependencies.',
    assignee: `worker-${i}`,
  }))
}

/**
 * Coordinator that decomposes into exactly `plan`, with no dependencies so
 * every task is ready at once, then synthesizes.
 */
function coordinatorAdapter(plan: ReturnType<typeof tasks>): LLMAdapter {
  let calls = 0
  return {
    name: 'coordinator-mock',
    async chat(): Promise<LLMResponse> {
      calls += 1
      const text = calls === 1
        ? `\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``
        : 'synthesized'
      return {
        id: 'c-1',
        content: [{ type: 'text', text }],
        model: 'mock-model',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }
    },
    async *stream() { yield { type: 'done' as const, data: {} } },
  }
}

/**
 * Run `TASK_COUNT` independent tasks and report the peak concurrency the pool
 * granted. Both caps are optional so each case isolates one authority.
 */
async function peakConcurrency(caps: {
  readonly orchestrator?: number
  readonly team?: number
}): Promise<number> {
  const oma = new OpenMultiAgent({
    defaultModel: 'mock-model',
    defaultProvider: 'openai',
    ...(caps.orchestrator !== undefined ? { maxConcurrency: caps.orchestrator } : {}),
  })
  const team = oma.createTeam('probe', {
    name: 'probe',
    agents: agents(),
    sharedMemory: false,
    ...(caps.team !== undefined ? { maxConcurrency: caps.team } : {}),
  })

  const result = await oma.runTasks(team, tasks())
  expect(result.tasks?.every((task) => task.status === 'completed')).toBe(true)
  return tracker.peak
}

describe('TeamConfig.maxConcurrency', () => {
  beforeEach(() => {
    tracker.reset()
  })

  it('caps the pool below the orchestrator default', async () => {
    // Without the team cap this run reaches the default ceiling of 5.
    expect(await peakConcurrency({ team: 2 })).toBe(2)
  })

  it('serializes the run at 1', async () => {
    expect(await peakConcurrency({ team: 1 })).toBe(1)
  })

  it('cannot widen the pool past the orchestrator ceiling', async () => {
    expect(await peakConcurrency({ orchestrator: 2, team: TASK_COUNT })).toBe(2)
  })

  it('yields to the orchestrator when the orchestrator cap is smaller', async () => {
    expect(await peakConcurrency({ orchestrator: 1, team: 4 })).toBe(1)
  })

  it('leaves the orchestrator cap in force when omitted', async () => {
    expect(await peakConcurrency({ orchestrator: 3 })).toBe(3)
  })

  it('applies to runTeam as well as runTasks', async () => {
    const oma = new OpenMultiAgent({ defaultModel: 'mock-model', defaultProvider: 'openai' })
    const team = oma.createTeam('probe', {
      name: 'probe',
      agents: agents(),
      sharedMemory: false,
      maxConcurrency: 2,
    })

    // The coordinator runs on its own adapter so its decompose and synthesis
    // calls stay out of the tracker; only the workers use the mocked module
    // adapter that records concurrency.
    const result = await oma.runTeam(team, 'Handle the work.', {
      mode: 'team',
      coordinator: { adapter: coordinatorAdapter(tasks()) },
    })

    expect(result.tasks).toHaveLength(TASK_COUNT)
    expect(tracker.peak).toBe(2)
  })

  describe('an unusable cap warns and falls back instead of failing the run', () => {
    // Falling back to the orchestrator value is exactly what these configs did
    // before the field was read at all, so enforcement cannot break a run that
    // an earlier release accepted. Throwing would. The check still cannot be
    // left to Semaphore, which rejects only values below 1 — NaN slips past and
    // produces a pool that never grants a slot.
    it.each([
      ['zero', 0],
      ['negative', -1],
      ['fractional', 1.5],
      ['NaN', Number.NaN],
    ])('warns and applies the orchestrator cap for %s', async (_label, value) => {
      const events: OrchestratorEvent[] = []
      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        defaultProvider: 'openai',
        maxConcurrency: 3,
        onProgress: (event) => events.push(event),
      })
      const team = oma.createTeam('probe', {
        name: 'probe',
        agents: agents(),
        sharedMemory: false,
        maxConcurrency: value,
      })

      const result = await oma.runTasks(team, tasks())

      expect(result.tasks?.every((task) => task.status === 'completed')).toBe(true)
      expect(tracker.peak).toBe(3)

      const warning = events.find((event) =>
        event.type === 'warning'
        && (event.data as { code?: string } | undefined)?.code === 'INVALID_TEAM_MAX_CONCURRENCY')
      expect(warning).toBeDefined()
      expect(warning?.data).toMatchObject({
        teamMaxConcurrency: value,
        appliedMaxConcurrency: 3,
      })
    })

    it('does not warn for a usable cap', async () => {
      const events: OrchestratorEvent[] = []
      const oma = new OpenMultiAgent({
        defaultModel: 'mock-model',
        defaultProvider: 'openai',
        onProgress: (event) => events.push(event),
      })
      const team = oma.createTeam('probe', {
        name: 'probe',
        agents: agents(),
        sharedMemory: false,
        maxConcurrency: 2,
      })

      await oma.runTasks(team, tasks())

      expect(events.some((event) =>
        event.type === 'warning'
        && (event.data as { code?: string } | undefined)?.code === 'INVALID_TEAM_MAX_CONCURRENCY',
      )).toBe(false)
    })
  })
})
