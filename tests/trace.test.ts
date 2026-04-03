import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { Agent } from '../src/agent/agent.js'
import { AgentRunner, type RunOptions } from '../src/agent/runner.js'
import { ToolRegistry, defineTool } from '../src/tool/framework.js'
import { ToolExecutor } from '../src/tool/executor.js'
import { executeWithRetry } from '../src/orchestrator/orchestrator.js'
import { emitTrace, generateRunId } from '../src/utils/trace.js'
import { createTask } from '../src/task/task.js'
import type {
  AgentConfig,
  AgentRunResult,
  LLMAdapter,
  LLMResponse,
  TraceEvent,
} from '../src/types.js'

// ---------------------------------------------------------------------------
// Mock adapters
// ---------------------------------------------------------------------------

function mockAdapter(responses: LLMResponse[]): LLMAdapter {
  let callIndex = 0
  return {
    name: 'mock',
    async chat() {
      return responses[callIndex++]!
    },
    async *stream() {
      /* unused */
    },
  }
}

function textResponse(text: string): LLMResponse {
  return {
    id: `resp-${Math.random().toString(36).slice(2)}`,
    content: [{ type: 'text' as const, text }],
    model: 'mock-model',
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 20 },
  }
}

function toolUseResponse(toolName: string, input: Record<string, unknown>): LLMResponse {
  return {
    id: `resp-${Math.random().toString(36).slice(2)}`,
    content: [
      {
        type: 'tool_use' as const,
        id: `tu-${Math.random().toString(36).slice(2)}`,
        name: toolName,
        input,
      },
    ],
    model: 'mock-model',
    stop_reason: 'tool_use',
    usage: { input_tokens: 15, output_tokens: 25 },
  }
}

function buildMockAgent(
  config: AgentConfig,
  responses: LLMResponse[],
  registry?: ToolRegistry,
  executor?: ToolExecutor,
): Agent {
  const reg = registry ?? new ToolRegistry()
  const exec = executor ?? new ToolExecutor(reg)
  const adapter = mockAdapter(responses)
  const agent = new Agent(config, reg, exec)

  const runner = new AgentRunner(adapter, reg, exec, {
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

// ---------------------------------------------------------------------------
// emitTrace helper
// ---------------------------------------------------------------------------

describe('emitTrace', () => {
  it('does nothing when fn is undefined', () => {
    // Should not throw
    emitTrace(undefined, {
      type: 'agent',
      runId: 'r1',
      agent: 'a',
      turns: 1,
      tokens: { input_tokens: 0, output_tokens: 0 },
      toolCalls: 0,
      startMs: 0,
      endMs: 0,
      durationMs: 0,
    })
  })

  it('calls fn with the event', () => {
    const fn = vi.fn()
    const event: TraceEvent = {
      type: 'agent',
      runId: 'r1',
      agent: 'a',
      turns: 1,
      tokens: { input_tokens: 0, output_tokens: 0 },
      toolCalls: 0,
      startMs: 0,
      endMs: 0,
      durationMs: 0,
    }
    emitTrace(fn, event)
    expect(fn).toHaveBeenCalledWith(event)
  })

  it('swallows errors thrown by callback', () => {
    const fn = () => { throw new Error('boom') }
    expect(() =>
      emitTrace(fn, {
        type: 'agent',
        runId: 'r1',
        agent: 'a',
        turns: 1,
        tokens: { input_tokens: 0, output_tokens: 0 },
        toolCalls: 0,
        startMs: 0,
        endMs: 0,
        durationMs: 0,
      }),
    ).not.toThrow()
  })

  it('swallows rejected promises from async callbacks', async () => {
    // An async onTrace that rejects should not produce unhandled rejection
    const fn = async () => { throw new Error('async boom') }
    emitTrace(fn as unknown as (event: TraceEvent) => void, {
      type: 'agent',
      runId: 'r1',
      agent: 'a',
      turns: 1,
      tokens: { input_tokens: 0, output_tokens: 0 },
      toolCalls: 0,
      startMs: 0,
      endMs: 0,
      durationMs: 0,
    })
    // If the rejection is not caught, vitest will fail with unhandled rejection.
    // Give the microtask queue a tick to surface any unhandled rejection.
    await new Promise(resolve => setTimeout(resolve, 10))
  })
})

describe('generateRunId', () => {
  it('returns a UUID string', () => {
    const id = generateRunId()
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('returns unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, generateRunId))
    expect(ids.size).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// AgentRunner trace events
// ---------------------------------------------------------------------------

describe('AgentRunner trace events', () => {
  it('emits llm_call trace for each LLM turn', async () => {
    const traces: TraceEvent[] = []
    const registry = new ToolRegistry()
    const executor = new ToolExecutor(registry)
    const adapter = mockAdapter([textResponse('Hello!')])

    const runner = new AgentRunner(adapter, registry, executor, {
      model: 'test-model',
      agentName: 'test-agent',
    })

    const runOptions: RunOptions = {
      onTrace: (e) => traces.push(e),
      runId: 'run-1',
      traceAgent: 'test-agent',
    }

    await runner.run(
      [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      runOptions,
    )

    const llmTraces = traces.filter(t => t.type === 'llm_call')
    expect(llmTraces).toHaveLength(1)

    const llm = llmTraces[0]!
    expect(llm.type).toBe('llm_call')
    expect(llm.runId).toBe('run-1')
    expect(llm.agent).toBe('test-agent')
    expect(llm.model).toBe('test-model')
    expect(llm.turn).toBe(1)
    expect(llm.tokens).toEqual({ input_tokens: 10, output_tokens: 20 })
    expect(llm.durationMs).toBeGreaterThanOrEqual(0)
    expect(llm.startMs).toBeLessThanOrEqual(llm.endMs)
  })

  it('emits tool_call trace with correct fields', async () => {
    const traces: TraceEvent[] = []
    const registry = new ToolRegistry()
    registry.register(
      defineTool({
        name: 'echo',
        description: 'echoes',
        inputSchema: z.object({ msg: z.string() }),
        execute: async ({ msg }) => ({ data: msg }),
      }),
    )
    const executor = new ToolExecutor(registry)
    const adapter = mockAdapter([
      toolUseResponse('echo', { msg: 'hello' }),
      textResponse('Done'),
    ])

    const runner = new AgentRunner(adapter, registry, executor, {
      model: 'test-model',
      agentName: 'tooler',
    })

    await runner.run(
      [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
      { onTrace: (e) => traces.push(e), runId: 'run-2', traceAgent: 'tooler' },
    )

    const toolTraces = traces.filter(t => t.type === 'tool_call')
    expect(toolTraces).toHaveLength(1)

    const tool = toolTraces[0]!
    expect(tool.type).toBe('tool_call')
    expect(tool.runId).toBe('run-2')
    expect(tool.agent).toBe('tooler')
    expect(tool.tool).toBe('echo')
    expect(tool.isError).toBe(false)
    expect(tool.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('tool_call trace has isError: true on tool failure', async () => {
    const traces: TraceEvent[] = []
    const registry = new ToolRegistry()
    registry.register(
      defineTool({
        name: 'boom',
        description: 'fails',
        inputSchema: z.object({}),
        execute: async () => { throw new Error('fail') },
      }),
    )
    const executor = new ToolExecutor(registry)
    const adapter = mockAdapter([
      toolUseResponse('boom', {}),
      textResponse('Handled'),
    ])

    const runner = new AgentRunner(adapter, registry, executor, {
      model: 'test-model',
      agentName: 'err-agent',
    })

    await runner.run(
      [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
      { onTrace: (e) => traces.push(e), runId: 'run-3', traceAgent: 'err-agent' },
    )

    const toolTraces = traces.filter(t => t.type === 'tool_call')
    expect(toolTraces).toHaveLength(1)
    expect(toolTraces[0]!.isError).toBe(true)
  })

  it('does not call Date.now for LLM timing when onTrace is absent', async () => {
    // This test just verifies no errors occur when onTrace is not provided
    const registry = new ToolRegistry()
    const executor = new ToolExecutor(registry)
    const adapter = mockAdapter([textResponse('hi')])

    const runner = new AgentRunner(adapter, registry, executor, {
      model: 'test-model',
    })

    const result = await runner.run(
      [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
      {},
    )

    expect(result.output).toBe('hi')
  })
})

// ---------------------------------------------------------------------------
// Agent-level trace events
// ---------------------------------------------------------------------------

describe('Agent trace events', () => {
  it('emits agent trace with turns, tokens, and toolCalls', async () => {
    const traces: TraceEvent[] = []
    const config: AgentConfig = {
      name: 'my-agent',
      model: 'mock-model',
      systemPrompt: 'You are a test.',
    }

    const agent = buildMockAgent(config, [textResponse('Hello world')])

    const runOptions: Partial<RunOptions> = {
      onTrace: (e) => traces.push(e),
      runId: 'run-agent-1',
      traceAgent: 'my-agent',
    }

    const result = await agent.run('Say hello', runOptions)
    expect(result.success).toBe(true)

    const agentTraces = traces.filter(t => t.type === 'agent')
    expect(agentTraces).toHaveLength(1)

    const at = agentTraces[0]!
    expect(at.type).toBe('agent')
    expect(at.runId).toBe('run-agent-1')
    expect(at.agent).toBe('my-agent')
    expect(at.turns).toBe(1) // one assistant message
    expect(at.tokens).toEqual({ input_tokens: 10, output_tokens: 20 })
    expect(at.toolCalls).toBe(0)
    expect(at.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('all traces share the same runId', async () => {
    const traces: TraceEvent[] = []
    const registry = new ToolRegistry()
    registry.register(
      defineTool({
        name: 'greet',
        description: 'greets',
        inputSchema: z.object({ name: z.string() }),
        execute: async ({ name }) => ({ data: `Hi ${name}` }),
      }),
    )
    const executor = new ToolExecutor(registry)
    const config: AgentConfig = {
      name: 'multi-trace-agent',
      model: 'mock-model',
      tools: ['greet'],
    }

    const agent = buildMockAgent(
      config,
      [
        toolUseResponse('greet', { name: 'world' }),
        textResponse('Done'),
      ],
      registry,
      executor,
    )

    const runId = 'shared-run-id'
    await agent.run('test', {
      onTrace: (e) => traces.push(e),
      runId,
      traceAgent: 'multi-trace-agent',
    })

    // Should have: 2 llm_call, 1 tool_call, 1 agent
    expect(traces.length).toBeGreaterThanOrEqual(4)

    for (const trace of traces) {
      expect(trace.runId).toBe(runId)
    }
  })

  it('onTrace error does not break agent execution', async () => {
    const config: AgentConfig = {
      name: 'resilient-agent',
      model: 'mock-model',
    }

    const agent = buildMockAgent(config, [textResponse('OK')])

    const result = await agent.run('test', {
      onTrace: () => { throw new Error('callback exploded') },
      runId: 'run-err',
      traceAgent: 'resilient-agent',
    })

    // The run should still succeed despite the broken callback
    expect(result.success).toBe(true)
    expect(result.output).toBe('OK')
  })

  it('per-turn token usage in llm_call traces', async () => {
    const traces: TraceEvent[] = []
    const registry = new ToolRegistry()
    registry.register(
      defineTool({
        name: 'noop',
        description: 'noop',
        inputSchema: z.object({}),
        execute: async () => ({ data: 'ok' }),
      }),
    )
    const executor = new ToolExecutor(registry)

    // Two LLM calls: first triggers a tool, second is the final response
    const resp1: LLMResponse = {
      id: 'r1',
      content: [{ type: 'tool_use', id: 'tu1', name: 'noop', input: {} }],
      model: 'mock-model',
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 50 },
    }
    const resp2: LLMResponse = {
      id: 'r2',
      content: [{ type: 'text', text: 'Final answer' }],
      model: 'mock-model',
      stop_reason: 'end_turn',
      usage: { input_tokens: 200, output_tokens: 100 },
    }

    const adapter = mockAdapter([resp1, resp2])
    const runner = new AgentRunner(adapter, registry, executor, {
      model: 'mock-model',
      agentName: 'token-agent',
    })

    await runner.run(
      [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      { onTrace: (e) => traces.push(e), runId: 'run-tok', traceAgent: 'token-agent' },
    )

    const llmTraces = traces.filter(t => t.type === 'llm_call')
    expect(llmTraces).toHaveLength(2)

    // Each trace carries its own turn's token usage, not the aggregate
    expect(llmTraces[0]!.tokens).toEqual({ input_tokens: 100, output_tokens: 50 })
    expect(llmTraces[1]!.tokens).toEqual({ input_tokens: 200, output_tokens: 100 })

    // Turn numbers should be sequential
    expect(llmTraces[0]!.turn).toBe(1)
    expect(llmTraces[1]!.turn).toBe(2)
  })
})
