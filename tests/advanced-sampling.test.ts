import { describe, it, expect, vi, beforeEach } from 'vitest'
import { OpenMultiAgent } from '../src/index.js'
import type {
  AgentConfig,
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  TeamConfig,
} from '../src/types.js'

const capturedCalls: LLMChatOptions[] = []
const responseQueue: LLMResponse[] = []

vi.mock('../src/llm/adapter.js', () => ({
  createAdapter: async () => {
    return {
      name: 'mock',
      async chat(_msgs: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
        capturedCalls.push(options)
        const queued = responseQueue.shift()
        return queued ?? {
          id: 'test',
          content: [{ type: 'text', text: 'test response' }],
          model: options.model ?? 'mock',
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 10 },
        }
      },
      async *stream() {
        yield { type: 'done', data: {} }
      },
    }
  },
}))

beforeEach(() => {
  capturedCalls.length = 0
  responseQueue.length = 0
})

describe('Advanced Sampling Parameters', () => {
  it('maps sampling parameters from AgentConfig to LLMChatOptions', async () => {
    const oma = new OpenMultiAgent()

    const config: AgentConfig = {
      name: 'sampler',
      model: 'mock',
      topP: 0.9,
      topK: 40,
      minP: 0.05,
      frequencyPenalty: 1.2,
      presencePenalty: 0.5,
      parallelToolCalls: false,
      extraBody: { custom: 'value' },
    }

    await oma.runAgent(config, 'hello')

    expect(capturedCalls).toHaveLength(1)
    const call = capturedCalls[0]
    expect(call?.topP).toBe(0.9)
    expect(call?.topK).toBe(40)
    expect(call?.minP).toBe(0.05)
    expect(call?.frequencyPenalty).toBe(1.2)
    expect(call?.presencePenalty).toBe(0.5)
    expect(call?.parallelToolCalls).toBe(false)
    expect(call?.extraBody).toEqual({ custom: 'value' })
  })

  it('passes coordinatorOverrides sampling params through to the coordinator chat call', async () => {
    // Queue a valid task-spec JSON so the coordinator decomposition parses cleanly.
    responseQueue.push({
      id: 'coord',
      content: [
        {
          type: 'text',
          text: JSON.stringify([
            {
              title: 'do the thing',
              description: 'do the thing',
              assignee: 'worker',
            },
          ]),
        },
      ],
      model: 'mock',
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 10 },
    })

    const oma = new OpenMultiAgent()
    const teamConfig: TeamConfig = {
      name: 'team',
      agents: [{ name: 'worker', model: 'mock' }],
    }
    const team = oma.createTeam('team', teamConfig)

    // Use a goal that defeats the simple-goal short-circuit so the coordinator runs.
    await oma.runTeam(
      team,
      'step 1: research the topic. step 2: synthesize the findings.',
      {
        coordinator: {
          topP: 0.7,
          topK: 30,
          minP: 0.03,
          frequencyPenalty: 0.8,
          presencePenalty: 0.2,
          parallelToolCalls: false,
          extraBody: { coordinator_only: true },
        },
      },
    )

    // The coordinator is the first chat call.
    expect(capturedCalls.length).toBeGreaterThan(0)
    const coord = capturedCalls[0]
    expect(coord?.topP).toBe(0.7)
    expect(coord?.topK).toBe(30)
    expect(coord?.minP).toBe(0.03)
    expect(coord?.frequencyPenalty).toBe(0.8)
    expect(coord?.presencePenalty).toBe(0.2)
    expect(coord?.parallelToolCalls).toBe(false)
    expect(coord?.extraBody).toEqual({ coordinator_only: true })
  })
})
