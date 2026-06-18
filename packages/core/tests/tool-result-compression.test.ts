import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { AgentRunner } from '../src/agent/runner.js'
import { ToolRegistry, defineTool } from '../src/tool/framework.js'
import { ToolExecutor } from '../src/tool/executor.js'
import type { LLMAdapter, LLMMessage, LLMResponse } from '../src/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResponse(text: string): LLMResponse {
  return {
    id: `resp-${Math.random().toString(36).slice(2)}`,
    content: [{ type: 'text', text }],
    model: 'mock-model',
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 20 },
  }
}

function toolUseResponse(toolName: string, input: Record<string, unknown>): LLMResponse {
  return {
    id: `resp-${Math.random().toString(36).slice(2)}`,
    content: [{
      type: 'tool_use',
      id: `tu-${Math.random().toString(36).slice(2)}`,
      name: toolName,
      input,
    }],
    model: 'mock-model',
    stop_reason: 'tool_use',
    usage: { input_tokens: 15, output_tokens: 25 },
  }
}

function buildRegistryAndExecutor(
  toolOutput: string = 'x'.repeat(600),
): { registry: ToolRegistry; executor: ToolExecutor } {
  const registry = new ToolRegistry()
  registry.register(
    defineTool({
      name: 'echo',
      description: 'Echo input',
      inputSchema: z.object({ message: z.string() }),
      async execute() {
        return { data: toolOutput }
      },
    }),
  )
  return { registry, executor: new ToolExecutor(registry) }
}

function buildErrorRegistryAndExecutor(): { registry: ToolRegistry; executor: ToolExecutor } {
  const registry = new ToolRegistry()
  registry.register(
    defineTool({
      name: 'fail',
      description: 'Always fails',
      inputSchema: z.object({ message: z.string() }),
      async execute() {
        return { data: 'E'.repeat(600), isError: true }
      },
    }),
  )
  return { registry, executor: new ToolExecutor(registry) }
}

/** Extract all tool_result content strings from messages sent to the LLM. */
function extractToolResultContents(messages: LLMMessage[]): string[] {
  return messages.flatMap(m =>
    m.content
      .filter((b): b is { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean } =>
        b.type === 'tool_result')
      .map(b => b.content),
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentRunner compressToolResults', () => {
  it('does NOT compress when compressToolResults is not set (default)', async () => {
    const calls: LLMMessage[][] = []
    const longOutput = 'x'.repeat(600)
    const responses = [
      toolUseResponse('echo', { message: 't1' }),
      toolUseResponse('echo', { message: 't2' }),
      textResponse('done'),
    ]
    let idx = 0
    const adapter: LLMAdapter = {
      name: 'mock',
      async chat(messages) {
        calls.push(messages.map(m => ({ role: m.role, content: [...m.content] })))
        return responses[idx++]!
      },
      async *stream() { /* unused */ },
    }
    const { registry, executor } = buildRegistryAndExecutor(longOutput)
    const runner = new AgentRunner(adapter, registry, executor, {
      model: 'mock-model',
      allowedTools: ['echo'],
      maxTurns: 5,
      // compressToolResults not set
    })

    await runner.run([{ role: 'user', content: [{ type: 'text', text: 'start' }] }])

    // Turn 3 should still see full tool results from turn 1
    const turn3Messages = calls[2]!
    const allToolResults = extractToolResultContents(turn3Messages)
    expect(allToolResults.every(c => c === longOutput)).toBe(true)
  })

  it('compresses consumed tool results on turn 3+', async () => {
    const calls: LLMMessage[][] = []
    const longOutput = 'x'.repeat(600)
    const responses = [
      toolUseResponse('echo', { message: 't1' }),
      toolUseResponse('echo', { message: 't2' }),
      textResponse('done'),
    ]
    let idx = 0
    const adapter: LLMAdapter = {
      name: 'mock',
      async chat(messages) {
        calls.push(messages.map(m => ({ role: m.role, content: [...m.content] })))
        return responses[idx++]!
      },
      async *stream() { /* unused */ },
    }
    const { registry, executor } = buildRegistryAndExecutor(longOutput)
    const runner = new AgentRunner(adapter, registry, executor, {
      model: 'mock-model',
      allowedTools: ['echo'],
      maxTurns: 5,
      compressToolResults: true,
    })

    await runner.run([{ role: 'user', content: [{ type: 'text', text: 'start' }] }])

    // Turn 3: the LLM should see a compressed marker for turn 1 results
    // but the full output for turn 2 results (most recent, not yet consumed).
    const turn3Messages = calls[2]!
    const allToolResults = extractToolResultContents(turn3Messages)
    expect(allToolResults).toHaveLength(2)

    // First result (turn 1) should be compressed
    expect(allToolResults[0]).toContain('compressed')
    expect(allToolResults[0]).toContain('600 chars')

    // Second result (turn 2, most recent) should be preserved in full
    expect(allToolResults[1]).toBe(longOutput)
  })

  it('preserves tool_use_id on compressed results', async () => {
    const calls: LLMMessage[][] = []
    const longOutput = 'x'.repeat(600)
    const responses = [
      toolUseResponse('echo', { message: 't1' }),
      toolUseResponse('echo', { message: 't2' }),
      textResponse('done'),
    ]
    let idx = 0
    const adapter: LLMAdapter = {
      name: 'mock',
      async chat(messages) {
        calls.push(messages.map(m => ({ role: m.role, content: [...m.content] })))
        return responses[idx++]!
      },
      async *stream() { /* unused */ },
    }
    const { registry, executor } = buildRegistryAndExecutor(longOutput)
    const runner = new AgentRunner(adapter, registry, executor, {
      model: 'mock-model',
      allowedTools: ['echo'],
      maxTurns: 5,
      compressToolResults: true,
    })

    await runner.run([{ role: 'user', content: [{ type: 'text', text: 'start' }] }])

    // Turn 3: verify compressed result still has tool_use_id
    const turn3Messages = calls[2]!
    const toolResultBlocks = turn3Messages.flatMap(m =>
      m.content.filter(b => b.type === 'tool_result'),
    )
    for (const block of toolResultBlocks) {
      expect(block).toHaveProperty('tool_use_id')
      expect((block as { tool_use_id: string }).tool_use_id).toBeTruthy()
    }
  })

  it('skips short tool results below minChars threshold', async () => {
    const calls: LLMMessage[][] = []
    const shortOutput = 'short' // 5 chars, well below 500 default
    const responses = [
      toolUseResponse('echo', { message: 't1' }),
      toolUseResponse('echo', { message: 't2' }),
      textResponse('done'),
    ]
    let idx = 0
    const adapter: LLMAdapter = {
      name: 'mock',
      async chat(messages) {
        calls.push(messages.map(m => ({ role: m.role, content: [...m.content] })))
        return responses[idx++]!
      },
      async *stream() { /* unused */ },
    }
    const { registry, executor } = buildRegistryAndExecutor(shortOutput)
    const runner = new AgentRunner(adapter, registry, executor, {
      model: 'mock-model',
      allowedTools: ['echo'],
      maxTurns: 5,
      compressToolResults: true,
    })

    await runner.run([{ role: 'user', content: [{ type: 'text', text: 'start' }] }])

    // Turn 3: short results should NOT be compressed
    const turn3Messages = calls[2]!
    const allToolResults = extractToolResultContents(turn3Messages)
    expect(allToolResults.every(c => c === shortOutput)).toBe(true)
  })

  it('respects custom minChars threshold', async () => {
    const calls: LLMMessage[][] = []
    const output = 'x'.repeat(200)
    const responses = [
      toolUseResponse('echo', { message: 't1' }),
      toolUseResponse('echo', { message: 't2' }),
      textResponse('done'),
    ]
    let idx = 0
    const adapter: LLMAdapter = {
      name: 'mock',
      async chat(messages) {
        calls.push(messages.map(m => ({ role: m.role, content: [...m.content] })))
        return responses[idx++]!
      },
      async *stream() { /* unused */ },
    }
    const { registry, executor } = buildRegistryAndExecutor(output)
    const runner = new AgentRunner(adapter, registry, executor, {
      model: 'mock-model',
      allowedTools: ['echo'],
      maxTurns: 5,
      compressToolResults: { minChars: 100 },
    })

    await runner.run([{ role: 'user', content: [{ type: 'text', text: 'start' }] }])

    // With minChars=100, the 200-char output should be compressed
    const turn3Messages = calls[2]!
    const allToolResults = extractToolResultContents(turn3Messages)
    expect(allToolResults[0]).toContain('compressed')
    expect(allToolResults[0]).toContain('200 chars')
  })

  it('never compresses error tool results', async () => {
    const calls: LLMMessage[][] = []
    const responses = [
      toolUseResponse('fail', { message: 't1' }),
      toolUseResponse('fail', { message: 't2' }),
      textResponse('done'),
    ]
    let idx = 0
    const adapter: LLMAdapter = {
      name: 'mock',
      async chat(messages) {
        calls.push(messages.map(m => ({ role: m.role, content: [...m.content] })))
        return responses[idx++]!
      },
      async *stream() { /* unused */ },
    }
    const { registry, executor } = buildErrorRegistryAndExecutor()
    const runner = new AgentRunner(adapter, registry, executor, {
      model: 'mock-model',
      allowedTools: ['fail'],
      maxTurns: 5,
      compressToolResults: true,
    })

    await runner.run([{ role: 'user', content: [{ type: 'text', text: 'start' }] }])

    // Error results should never be compressed even if long
    const turn3Messages = calls[2]!
    const allToolResults = extractToolResultContents(turn3Messages)
    expect(allToolResults.every(c => c === 'E'.repeat(600))).toBe(true)
  })

  it('compresses selectively in multi-block tool_result messages (parallel tool calls)', async () => {
    const calls: LLMMessage[][] = []
    // Two tools: one returns long output, one returns short output
    const registry = new ToolRegistry()
    registry.register(
      defineTool({
        name: 'long_tool',
        description: 'Returns long output',
        inputSchema: z.object({ msg: z.string() }),
        async execute() { return { data: 'L'.repeat(600) } },
      }),
    )
    registry.register(
      defineTool({
        name: 'short_tool',
        description: 'Returns short output',
        inputSchema: z.object({ msg: z.string() }),
        async execute() { return { data: 'S'.repeat(50) } },
      }),
    )
    const executor = new ToolExecutor(registry)

    // Turn 1: model calls both tools in parallel
    const parallelResponse: LLMResponse = {
      id: 'resp-parallel',
      content: [
        { type: 'tool_use', id: 'tu-long', name: 'long_tool', input: { msg: 'a' } },
        { type: 'tool_use', id: 'tu-short', name: 'short_tool', input: { msg: 'b' } },
      ],
      model: 'mock-model',
      stop_reason: 'tool_use',
      usage: { input_tokens: 15, output_tokens: 25 },
    }
    const responses = [
      parallelResponse,
      toolUseResponse('long_tool', { msg: 't2' }),
      textResponse('done'),
    ]
    let idx = 0
    const adapter: LLMAdapter = {
      name: 'mock',
      async chat(messages) {
        calls.push(messages.map(m => ({ role: m.role, content: [...m.content] })))
        return responses[idx++]!
      },
      async *stream() { /* unused */ },
    }

    const runner = new AgentRunner(adapter, registry, executor, {
      model: 'mock-model',
      allowedTools: ['long_tool', 'short_tool'],
      maxTurns: 5,
      compressToolResults: true,
    })

    await runner.run([{ role: 'user', content: [{ type: 'text', text: 'start' }] }])

    // Turn 3: the parallel results from turn 1 should be selectively compressed.
    // The long_tool result (600 chars) → compressed. The short_tool result (50 chars) → kept.
    const turn3Messages = calls[2]!
    const turn1ToolResults = turn3Messages.flatMap(m =>
      m.content.filter((b): b is { type: 'tool_result'; tool_use_id: string; content: string } =>
        b.type === 'tool_result'),
    )
    // Find the results from turn 1 (first user message with tool_results)
    const firstToolResultMsg = turn3Messages.find(
      m => m.role === 'user' && m.content.some(b => b.type === 'tool_result'),
    )!
    const blocks = firstToolResultMsg.content.filter(
      (b): b is { type: 'tool_result'; tool_use_id: string; content: string } =>
        b.type === 'tool_result',
    )

    // One should be compressed (long), one should be intact (short)
    const compressedBlocks = blocks.filter(b => b.content.includes('compressed'))
    const intactBlocks = blocks.filter(b => !b.content.includes('compressed'))
    expect(compressedBlocks).toHaveLength(1)
    expect(compressedBlocks[0]!.content).toContain('600 chars')
    expect(intactBlocks).toHaveLength(1)
    expect(intactBlocks[0]!.content).toBe('S'.repeat(50))
  })

  it('compounds compression across 4+ turns', async () => {
    const calls: LLMMessage[][] = []
    const longOutput = 'x'.repeat(600)
    const responses = [
      toolUseResponse('echo', { message: 't1' }),
      toolUseResponse('echo', { message: 't2' }),
      toolUseResponse('echo', { message: 't3' }),
      textResponse('done'),
    ]
    let idx = 0
    const adapter: LLMAdapter = {
      name: 'mock',
      async chat(messages) {
        calls.push(messages.map(m => ({ role: m.role, content: [...m.content] })))
        return responses[idx++]!
      },
      async *stream() { /* unused */ },
    }
    const { registry, executor } = buildRegistryAndExecutor(longOutput)
    const runner = new AgentRunner(adapter, registry, executor, {
      model: 'mock-model',
      allowedTools: ['echo'],
      maxTurns: 6,
      compressToolResults: true,
    })

    await runner.run([{ role: 'user', content: [{ type: 'text', text: 'start' }] }])

    // Turn 4: turns 1 and 2 should both be compressed, turn 3 should be intact
    const turn4Messages = calls[3]!
    const allToolResults = extractToolResultContents(turn4Messages)
    expect(allToolResults).toHaveLength(3)

    // First two are compressed (turns 1 & 2)
    expect(allToolResults[0]).toContain('compressed')
    expect(allToolResults[1]).toContain('compressed')

    // Last one (turn 3, most recent) preserved
    expect(allToolResults[2]).toBe(longOutput)
  })

  it('does not re-compress already compressed markers with low minChars', async () => {
    const calls: LLMMessage[][] = []
    const longOutput = 'x'.repeat(600)
    const responses = [
      toolUseResponse('echo', { message: 't1' }),
      toolUseResponse('echo', { message: 't2' }),
      toolUseResponse('echo', { message: 't3' }),
      textResponse('done'),
    ]
    let idx = 0
    const adapter: LLMAdapter = {
      name: 'mock',
      async chat(messages) {
        calls.push(messages.map(m => ({ role: m.role, content: [...m.content] })))
        return responses[idx++]!
      },
      async *stream() { /* unused */ },
    }
    const { registry, executor } = buildRegistryAndExecutor(longOutput)
    const runner = new AgentRunner(adapter, registry, executor, {
      model: 'mock-model',
      allowedTools: ['echo'],
      maxTurns: 6,
      compressToolResults: { minChars: 10 }, // very low threshold
    })

    await runner.run([{ role: 'user', content: [{ type: 'text', text: 'start' }] }])

    // Turn 4: turn 1 was compressed in turn 3. With minChars=10 the marker
    // itself (55 chars) exceeds the threshold. Without the guard it would be
    // re-compressed with a wrong char count (55 instead of 600).
    const turn4Messages = calls[3]!
    const allToolResults = extractToolResultContents(turn4Messages)

    // Turn 1 result: should still show original 600 chars, not re-compressed
    expect(allToolResults[0]).toContain('600 chars')
    // Turn 2 result: compressed for the first time this turn
    expect(allToolResults[1]).toContain('600 chars')
    // Turn 3 result: most recent, preserved in full
    expect(allToolResults[2]).toBe(longOutput)
  })

  it('works together with contextStrategy', async () => {
    const calls: LLMMessage[][] = []
    const longOutput = 'x'.repeat(600)
    const responses = [
      toolUseResponse('echo', { message: 't1' }),
      toolUseResponse('echo', { message: 't2' }),
      textResponse('done'),
    ]
    let idx = 0
    const adapter: LLMAdapter = {
      name: 'mock',
      async chat(messages) {
        calls.push(messages.map(m => ({ role: m.role, content: [...m.content] })))
        return responses[idx++]!
      },
      async *stream() { /* unused */ },
    }
    const { registry, executor } = buildRegistryAndExecutor(longOutput)
    const runner = new AgentRunner(adapter, registry, executor, {
      model: 'mock-model',
      allowedTools: ['echo'],
      maxTurns: 5,
      compressToolResults: true,
      contextStrategy: { type: 'sliding-window', maxTurns: 10 },
    })

    const result = await runner.run([
      { role: 'user', content: [{ type: 'text', text: 'start' }] },
    ])

    // Should complete without error; both features coexist
    expect(result.output).toBe('done')

    // Turn 3 should have compressed turn 1 results
    const turn3Messages = calls[2]!
    const allToolResults = extractToolResultContents(turn3Messages)
    expect(allToolResults[0]).toContain('compressed')
  })

  it('does NOT compress delegate_to_agent results on turn 3+', async () => {
    const calls: LLMMessage[][] = []
    const longOutput = 'y'.repeat(600)
    const responses = [
      toolUseResponse('delegate_to_agent', { target_agent: 'bob', prompt: 'do work' }),
      toolUseResponse('delegate_to_agent', { target_agent: 'bob', prompt: 'do more' }),
      textResponse('done'),
    ]
    let idx = 0
    const adapter: LLMAdapter = {
      name: 'mock',
      async chat(messages) {
        calls.push(messages.map(m => ({ role: m.role, content: [...m.content] })))
        return responses[idx++]!
      },
      async *stream() { /* unused */ },
    }
    const registry = new ToolRegistry()
    registry.register(
      defineTool({
        name: 'delegate_to_agent',
        description: 'Fake delegation tool for test',
        inputSchema: z.object({ target_agent: z.string(), prompt: z.string() }),
        async execute() {
          return { data: longOutput }
        },
      }),
    )
    const runner = new AgentRunner(adapter, registry, new ToolExecutor(registry), {
      model: 'mock-model',
      allowedTools: ['delegate_to_agent'],
      maxTurns: 5,
      compressToolResults: true,
    })

    await runner.run([{ role: 'user', content: [{ type: 'text', text: 'start' }] }])

    // Turn 3: both delegation results should survive unchanged.
    const turn3Messages = calls[2]!
    const allToolResults = extractToolResultContents(turn3Messages)
    expect(allToolResults).toHaveLength(2)
    expect(allToolResults[0]).toBe(longOutput)
    expect(allToolResults[1]).toBe(longOutput)
  })
})
