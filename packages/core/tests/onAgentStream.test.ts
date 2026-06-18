import { describe, it, expect, vi } from 'vitest'
import { Agent } from '../src/agent/agent.js'
import { AgentRunner } from '../src/agent/runner.js'
import { AgentPool } from '../src/agent/pool.js'
import { ToolRegistry } from '../src/tool/framework.js'
import { ToolExecutor } from '../src/tool/executor.js'
import type {
  AgentConfig,
  AgentRunResult,
  LLMAdapter,
  LLMMessage,
  LLMResponse,
  StreamEvent,
  TraceEvent,
} from '../src/types.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function mockAdapter(responseText: string) {
  const calls: { messages: LLMMessage[]; abortSignal?: AbortSignal }[] = []
  const adapter: LLMAdapter = {
    name: 'mock',
    async chat(messages, options) {
      calls.push({ messages: [...messages], abortSignal: options?.abortSignal })
      // Honor caller-supplied abort: reject like a real SDK would.
      if (options?.abortSignal?.aborted) {
        const err = new Error('aborted')
        err.name = 'AbortError'
        throw err
      }
      return {
        id: 'mock-1',
        content: [{ type: 'text' as const, text: responseText }],
        model: 'mock-model',
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 20 },
      } satisfies LLMResponse
    },
    async *stream() {
      /* unused — runner.stream synthesizes events from chat() */
    },
  }
  return { adapter, calls }
}

function buildMockAgent(config: AgentConfig, responseText: string) {
  const { adapter, calls } = mockAdapter(responseText)
  const registry = new ToolRegistry()
  const executor = new ToolExecutor(registry)
  const agent = new Agent(config, registry, executor)

  const runner = new AgentRunner(adapter, registry, executor, {
    model: config.model,
    systemPrompt: config.systemPrompt,
    maxTurns: config.maxTurns,
    agentName: config.name,
  })
  ;(agent as any).runner = runner

  return { agent, calls }
}

const baseConfig: AgentConfig = {
  name: 'streamer',
  model: 'mock-model',
  systemPrompt: 'You stream.',
}

// ---------------------------------------------------------------------------
// agent.stream() forwards full caller options through to the runner
// ---------------------------------------------------------------------------

describe('agent.stream() RunOptions forwarding', () => {
  it('forwards onTrace from caller options so traces fire during streaming', async () => {
    const { agent } = buildMockAgent(baseConfig, 'streamed text')
    const traces: TraceEvent[] = []

    const events: StreamEvent[] = []
    for await (const event of agent.stream('hi', {
      onTrace: (e) => { traces.push(e) },
      runId: 'run-1',
      traceAgent: 'streamer',
    })) {
      events.push(event)
    }

    const llmCallTraces = traces.filter(t => t.type === 'llm_call')
    expect(llmCallTraces.length).toBeGreaterThan(0)
    expect(llmCallTraces[0]!.runId).toBe('run-1')
    expect(events.some(e => e.type === 'done')).toBe(true)
  })

  it('pre-aborted caller signal short-circuits the stream before any LLM call', async () => {
    const { agent, calls } = buildMockAgent(baseConfig, 'unused')
    const controller = new AbortController()
    controller.abort()

    const events: StreamEvent[] = []
    for await (const event of agent.stream('hi', { abortSignal: controller.signal })) {
      events.push(event)
    }

    expect(calls).toHaveLength(0)
    expect(events.some(e => e.type === 'done')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// AgentPool.run() must isolate streamCallback failures
// ---------------------------------------------------------------------------

describe('AgentPool streamCallback error isolation', () => {
  it('does not propagate a throwing streamCallback', async () => {
    const { agent } = buildMockAgent(baseConfig, 'ok')
    const pool = new AgentPool(1)
    pool.add(agent)

    const events: StreamEvent[] = []
    const callback = vi.fn((event: StreamEvent) => {
      events.push(event)
      throw new Error('callback bug')
    })

    const result: AgentRunResult = await pool.run('streamer', 'hi', undefined, callback)

    expect(result.success).toBe(true)
    expect(callback).toHaveBeenCalled()
    expect(events.some(e => e.type === 'done')).toBe(true)
  })
})
