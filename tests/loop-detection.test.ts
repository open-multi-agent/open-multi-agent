import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { LoopDetector } from '../src/agent/loop-detector.js'
import { AgentRunner } from '../src/agent/runner.js'
import { ToolRegistry, defineTool } from '../src/tool/framework.js'
import { ToolExecutor } from '../src/tool/executor.js'
import type { LLMAdapter, LLMResponse, StreamEvent } from '../src/types.js'

// ---------------------------------------------------------------------------
// Mock helpers
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

const echoTool = defineTool({
  name: 'echo',
  description: 'Echoes input',
  inputSchema: z.object({ message: z.string() }),
  async execute({ message }) {
    return { data: message }
  },
})

// ---------------------------------------------------------------------------
// Unit tests — LoopDetector class
// ---------------------------------------------------------------------------

describe('LoopDetector', () => {
  describe('tool call repetition', () => {
    it('returns null for non-repeating tool calls', () => {
      const detector = new LoopDetector()
      expect(detector.recordToolCalls([{ name: 'a', input: { x: 1 } }])).toBeNull()
      expect(detector.recordToolCalls([{ name: 'b', input: { x: 2 } }])).toBeNull()
      expect(detector.recordToolCalls([{ name: 'c', input: { x: 3 } }])).toBeNull()
    })

    it('detects 3 identical tool calls (default threshold)', () => {
      const detector = new LoopDetector()
      expect(detector.recordToolCalls([{ name: 'a', input: { x: 1 } }])).toBeNull()
      expect(detector.recordToolCalls([{ name: 'a', input: { x: 1 } }])).toBeNull()
      const info = detector.recordToolCalls([{ name: 'a', input: { x: 1 } }])
      expect(info).not.toBeNull()
      expect(info!.kind).toBe('tool_repetition')
      expect(info!.repetitions).toBe(3)
    })

    it('does not trigger when args differ', () => {
      const detector = new LoopDetector()
      expect(detector.recordToolCalls([{ name: 'a', input: { x: 1 } }])).toBeNull()
      expect(detector.recordToolCalls([{ name: 'a', input: { x: 2 } }])).toBeNull()
      expect(detector.recordToolCalls([{ name: 'a', input: { x: 3 } }])).toBeNull()
    })

    it('resets count when a different call intervenes', () => {
      const detector = new LoopDetector()
      detector.recordToolCalls([{ name: 'a', input: { x: 1 } }])
      detector.recordToolCalls([{ name: 'a', input: { x: 1 } }])
      // Different call breaks the streak
      detector.recordToolCalls([{ name: 'b', input: { x: 1 } }])
      expect(detector.recordToolCalls([{ name: 'a', input: { x: 1 } }])).toBeNull()
    })

    it('handles multi-tool turns with order-independent signatures', () => {
      const detector = new LoopDetector()
      const toolsA = [
        { name: 'read', input: { file: 'a.ts' } },
        { name: 'read', input: { file: 'b.ts' } },
      ]
      // Same tools in different order
      const toolsB = [
        { name: 'read', input: { file: 'b.ts' } },
        { name: 'read', input: { file: 'a.ts' } },
      ]
      expect(detector.recordToolCalls(toolsA)).toBeNull()
      expect(detector.recordToolCalls(toolsB)).toBeNull()
      const info = detector.recordToolCalls(toolsA)
      expect(info).not.toBeNull()
      expect(info!.kind).toBe('tool_repetition')
    })

    it('respects custom threshold', () => {
      const detector = new LoopDetector({ maxRepetitions: 2 })
      expect(detector.recordToolCalls([{ name: 'a', input: {} }])).toBeNull()
      const info = detector.recordToolCalls([{ name: 'a', input: {} }])
      expect(info).not.toBeNull()
      expect(info!.repetitions).toBe(2)
    })

    it('returns null for empty blocks', () => {
      const detector = new LoopDetector()
      expect(detector.recordToolCalls([])).toBeNull()
    })

    it('produces deterministic signatures regardless of key order', () => {
      const detector = new LoopDetector()
      detector.recordToolCalls([{ name: 'a', input: { b: 2, a: 1 } }])
      detector.recordToolCalls([{ name: 'a', input: { a: 1, b: 2 } }])
      const info = detector.recordToolCalls([{ name: 'a', input: { b: 2, a: 1 } }])
      expect(info).not.toBeNull()
    })
  })

  describe('text repetition', () => {
    it('returns null for non-repeating text', () => {
      const detector = new LoopDetector()
      expect(detector.recordText('hello')).toBeNull()
      expect(detector.recordText('world')).toBeNull()
      expect(detector.recordText('foo')).toBeNull()
    })

    it('detects 3 identical texts (default threshold)', () => {
      const detector = new LoopDetector()
      expect(detector.recordText('stuck')).toBeNull()
      expect(detector.recordText('stuck')).toBeNull()
      const info = detector.recordText('stuck')
      expect(info).not.toBeNull()
      expect(info!.kind).toBe('text_repetition')
      expect(info!.repetitions).toBe(3)
    })

    it('ignores empty or whitespace-only text', () => {
      const detector = new LoopDetector()
      expect(detector.recordText('')).toBeNull()
      expect(detector.recordText('   ')).toBeNull()
      expect(detector.recordText('\n\t')).toBeNull()
    })

    it('normalises whitespace before comparison', () => {
      const detector = new LoopDetector()
      detector.recordText('hello  world')
      detector.recordText('hello world')
      const info = detector.recordText('hello   world')
      expect(info).not.toBeNull()
    })
  })

  describe('window size', () => {
    it('clamps windowSize to at least maxRepeats', () => {
      // Window of 2 with threshold 3 is auto-clamped to 3.
      const detector = new LoopDetector({ loopDetectionWindow: 2, maxRepetitions: 3 })
      detector.recordToolCalls([{ name: 'a', input: {} }])
      detector.recordToolCalls([{ name: 'a', input: {} }])
      // Third call triggers because window was clamped to 3
      const info = detector.recordToolCalls([{ name: 'a', input: {} }])
      expect(info).not.toBeNull()
      expect(info!.repetitions).toBe(3)
    })

    it('works correctly when window >= threshold', () => {
      const detector = new LoopDetector({ loopDetectionWindow: 4, maxRepetitions: 3 })
      detector.recordToolCalls([{ name: 'a', input: {} }])
      detector.recordToolCalls([{ name: 'a', input: {} }])
      const info = detector.recordToolCalls([{ name: 'a', input: {} }])
      expect(info).not.toBeNull()
    })
  })
})

// ---------------------------------------------------------------------------
// Integration tests — AgentRunner with loop detection
// ---------------------------------------------------------------------------

describe('AgentRunner loop detection', () => {
  function buildRunner(
    responses: LLMResponse[],
    loopDetection: import('../src/types.js').LoopDetectionConfig,
  ) {
    const adapter = mockAdapter(responses)
    const registry = new ToolRegistry()
    registry.register(echoTool)
    const executor = new ToolExecutor(registry)
    const runner = new AgentRunner(adapter, registry, executor, {
      model: 'mock-model',
      maxTurns: 10,
      allowedTools: ['echo'],
      agentName: 'test-agent',
      loopDetection,
    })
    return runner
  }

  it('terminates early in terminate mode', async () => {
    // 5 identical tool calls, then a text response (should never reach it)
    const responses = [
      ...Array.from({ length: 5 }, () => toolUseResponse('echo', { message: 'hi' })),
      textResponse('done'),
    ]
    const runner = buildRunner(responses, {
      maxRepetitions: 3,
      onLoopDetected: 'terminate',
    })

    const result = await runner.run([{ role: 'user', content: [{ type: 'text', text: 'go' }] }])

    expect(result.loopDetected).toBe(true)
    expect(result.turns).toBe(3)
  })

  it('emits loop_detected stream event in terminate mode', async () => {
    const responses = [
      ...Array.from({ length: 5 }, () => toolUseResponse('echo', { message: 'hi' })),
      textResponse('done'),
    ]
    const runner = buildRunner(responses, {
      maxRepetitions: 3,
      onLoopDetected: 'terminate',
    })

    const events: StreamEvent[] = []
    for await (const event of runner.stream([{ role: 'user', content: [{ type: 'text', text: 'go' }] }])) {
      events.push(event)
    }

    const loopEvents = events.filter(e => e.type === 'loop_detected')
    expect(loopEvents).toHaveLength(1)
    const info = loopEvents[0]!.data as import('../src/types.js').LoopDetectionInfo
    expect(info.kind).toBe('tool_repetition')
    expect(info.repetitions).toBe(3)
  })

  it('calls onWarning in terminate mode', async () => {
    const responses = [
      ...Array.from({ length: 5 }, () => toolUseResponse('echo', { message: 'hi' })),
      textResponse('done'),
    ]
    const runner = buildRunner(responses, {
      maxRepetitions: 3,
      onLoopDetected: 'terminate',
    })

    const warnings: string[] = []
    await runner.run(
      [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      { onWarning: (msg) => warnings.push(msg) },
    )

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('loop')
  })

  it('injects warning message in warn mode and terminates on second detection', async () => {
    // 6 identical tool calls — warn fires at turn 3, then terminate at turn 4+
    const responses = [
      ...Array.from({ length: 6 }, () => toolUseResponse('echo', { message: 'hi' })),
      textResponse('done'),
    ]
    const runner = buildRunner(responses, {
      maxRepetitions: 3,
      onLoopDetected: 'warn',
    })

    const result = await runner.run([{ role: 'user', content: [{ type: 'text', text: 'go' }] }])

    // Should have terminated after the second detection (turn 4), not run all 6
    expect(result.loopDetected).toBe(true)
    expect(result.turns).toBeLessThanOrEqual(5)
  })

  it('supports custom callback returning terminate', async () => {
    const responses = [
      ...Array.from({ length: 5 }, () => toolUseResponse('echo', { message: 'hi' })),
      textResponse('done'),
    ]
    const callback = vi.fn().mockReturnValue('terminate')
    const runner = buildRunner(responses, {
      maxRepetitions: 3,
      onLoopDetected: callback,
    })

    const result = await runner.run([{ role: 'user', content: [{ type: 'text', text: 'go' }] }])

    expect(callback).toHaveBeenCalledOnce()
    expect(result.loopDetected).toBe(true)
    expect(result.turns).toBe(3)
  })

  it('supports custom callback returning inject', async () => {
    // 'inject' behaves like 'warn': injects warning, terminates on second detection
    const responses = [
      ...Array.from({ length: 6 }, () => toolUseResponse('echo', { message: 'hi' })),
      textResponse('done'),
    ]
    const callback = vi.fn().mockReturnValue('inject')
    const runner = buildRunner(responses, {
      maxRepetitions: 3,
      onLoopDetected: callback,
    })

    const result = await runner.run([{ role: 'user', content: [{ type: 'text', text: 'go' }] }])

    expect(callback).toHaveBeenCalledTimes(2) // first triggers inject, second forces terminate
    expect(result.loopDetected).toBe(true)
    expect(result.turns).toBeLessThanOrEqual(5)
  })

  it('supports custom callback returning continue', async () => {
    const responses = [
      ...Array.from({ length: 5 }, () => toolUseResponse('echo', { message: 'hi' })),
      textResponse('done'),
    ]
    const callback = vi.fn().mockReturnValue('continue')
    const runner = buildRunner(responses, {
      maxRepetitions: 3,
      onLoopDetected: callback,
    })

    const result = await runner.run([{ role: 'user', content: [{ type: 'text', text: 'go' }] }])

    // continue means no termination — runs until maxTurns or text response
    // callback fires at turn 3, 4, 5 (all repeating)
    expect(callback).toHaveBeenCalledTimes(3)
    expect(result.loopDetected).toBeUndefined()
  })

  it('supports async onLoopDetected callback', async () => {
    const responses = [
      ...Array.from({ length: 5 }, () => toolUseResponse('echo', { message: 'hi' })),
      textResponse('done'),
    ]
    const callback = vi.fn().mockResolvedValue('terminate')
    const runner = buildRunner(responses, {
      maxRepetitions: 3,
      onLoopDetected: callback,
    })

    const result = await runner.run([{ role: 'user', content: [{ type: 'text', text: 'go' }] }])

    expect(callback).toHaveBeenCalledOnce()
    expect(result.loopDetected).toBe(true)
    expect(result.turns).toBe(3)
  })

  it('gives a fresh warning cycle after agent recovers from a loop', async () => {
    // Sequence: 3x same tool (loop #1 warned) → 1x different tool (recovery)
    //           → 3x same tool again (loop #2 should warn, NOT immediate terminate)
    //           → 1x more same tool (now terminates after 2nd warning)
    const responses = [
      // Loop #1: 3 identical calls → triggers warn
      toolUseResponse('echo', { message: 'hi' }),
      toolUseResponse('echo', { message: 'hi' }),
      toolUseResponse('echo', { message: 'hi' }),
      // Recovery: different call
      toolUseResponse('echo', { message: 'different' }),
      // Loop #2: 3 identical calls → should trigger warn again (not terminate)
      toolUseResponse('echo', { message: 'stuck again' }),
      toolUseResponse('echo', { message: 'stuck again' }),
      toolUseResponse('echo', { message: 'stuck again' }),
      // 4th identical → second warning, force terminate
      toolUseResponse('echo', { message: 'stuck again' }),
      textResponse('done'),
    ]
    const warnings: string[] = []
    const runner = buildRunner(responses, {
      maxRepetitions: 3,
      onLoopDetected: 'warn',
    })

    const result = await runner.run(
      [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      { onWarning: (msg) => warnings.push(msg) },
    )

    // Three warnings: loop #1 warn, loop #2 warn, loop #2 force-terminate
    expect(warnings).toHaveLength(3)
    expect(result.loopDetected).toBe(true)
    // Should have run past loop #1 (3 turns) + recovery (1) + loop #2 warn (3) + terminate (1) = 8
    expect(result.turns).toBe(8)
  })

  it('injects warning TextBlock into tool-result user message in warn mode', async () => {
    // 4 identical tool calls: warn fires at turn 3, terminate at turn 4
    const responses = [
      ...Array.from({ length: 4 }, () => toolUseResponse('echo', { message: 'hi' })),
      textResponse('done'),
    ]
    const runner = buildRunner(responses, {
      maxRepetitions: 3,
      onLoopDetected: 'warn',
    })

    const result = await runner.run([{ role: 'user', content: [{ type: 'text', text: 'go' }] }])

    // Find user messages that contain a text block with the WARNING string
    const userMessages = result.messages.filter(m => m.role === 'user')
    const warningBlocks = userMessages.flatMap(m =>
      m.content.filter(
        (b): b is import('../src/types.js').TextBlock =>
          b.type === 'text' && 'text' in b && (b as import('../src/types.js').TextBlock).text.startsWith('WARNING:'),
      ),
    )

    expect(warningBlocks).toHaveLength(1)
    expect(warningBlocks[0]!.text).toContain('repeating the same tool calls')
  })

  it('does not interfere when loopDetection is not configured', async () => {
    const adapter = mockAdapter([
      ...Array.from({ length: 5 }, () => toolUseResponse('echo', { message: 'hi' })),
      textResponse('done'),
    ])
    const registry = new ToolRegistry()
    registry.register(echoTool)
    const executor = new ToolExecutor(registry)
    const runner = new AgentRunner(adapter, registry, executor, {
      model: 'mock-model',
      maxTurns: 10,
      allowedTools: ['echo'],
      agentName: 'test-agent',
      // no loopDetection
    })

    const result = await runner.run([{ role: 'user', content: [{ type: 'text', text: 'go' }] }])

    // All 5 tool turns + 1 text turn = 6
    expect(result.turns).toBe(6)
    expect(result.loopDetected).toBeUndefined()
  })
})
