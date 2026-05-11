import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { AgentRunner } from '../src/agent/runner.js'
import { ToolRegistry, defineTool } from '../src/tool/framework.js'
import { ToolExecutor } from '../src/tool/executor.js'
import type { LLMAdapter, LLMMessage, LLMResponse, StreamEvent, ToolUseBlock, ToolResultBlock, ContentBlock } from '../src/types.js'

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
    usage: { input_tokens: 5, output_tokens: 5 },
  }
}

function textResponse(text: string): LLMResponse {
  return {
    id: `resp-${Math.random().toString(36).slice(2)}`,
    content: [{ type: 'text', text }],
    model: 'mock-model',
    stop_reason: 'end_turn',
    usage: { input_tokens: 5, output_tokens: 5 },
  }
}

describe('delegation-triggered budget_exceeded', () => {
  it('yields tool_result events and appends tool_result message before break', async () => {
    // Parent turn 1: LLM asks for a delegation.
    // Tool returns metadata.tokenUsage that alone pushes totalUsage past the budget.
    // Expectation: stream yields tool_use AND tool_result, and the returned
    // `messages` contains the user tool_result message, so downstream consumers
    // can resume without API "tool_use without tool_result" errors.
    const responses = [
      toolUseResponse('delegate_to_agent', { target_agent: 'bob', prompt: 'work' }),
      textResponse('should not be reached'),
    ]
    let idx = 0
    const adapter: LLMAdapter = {
      name: 'mock',
      async chat() {
        return responses[idx++]!
      },
      async *stream() { /* unused */ },
    }

    const registry = new ToolRegistry()
    registry.register(
      defineTool({
        name: 'delegate_to_agent',
        description: 'Fake delegation for test',
        inputSchema: z.object({ target_agent: z.string(), prompt: z.string() }),
        async execute() {
          return {
            data: 'delegated output',
            metadata: { tokenUsage: { input_tokens: 500, output_tokens: 500 } },
          }
        },
      }),
    )

    const runner = new AgentRunner(adapter, registry, new ToolExecutor(registry), {
      model: 'mock-model',
      allowedTools: ['delegate_to_agent'],
      maxTurns: 5,
      maxTokenBudget: 100, // 10 (parent LLM) + 1000 (delegation) ≫ 100
      agentName: 'parent',
    })

    const events: StreamEvent[] = []
    for await (const ev of runner.stream([{ role: 'user', content: [{ type: 'text', text: 'start' }] }])) {
      events.push(ev)
    }

    const toolUseEvents = events.filter((e): e is StreamEvent & { type: 'tool_use'; data: ToolUseBlock } => e.type === 'tool_use')
    const toolResultEvents = events.filter((e): e is StreamEvent & { type: 'tool_result'; data: ToolResultBlock } => e.type === 'tool_result')
    const budgetEvents = events.filter(e => e.type === 'budget_exceeded')
    const doneEvents = events.filter((e): e is StreamEvent & { type: 'done'; data: { messages: LLMMessage[]; budgetExceeded?: boolean } } => e.type === 'done')

    // 1. Every tool_use event has a matching tool_result event.
    expect(toolUseEvents).toHaveLength(1)
    expect(toolResultEvents).toHaveLength(1)
    expect(toolResultEvents[0]!.data.tool_use_id).toBe(toolUseEvents[0]!.data.id)

    // 2. Budget event fires and the run terminates with budgetExceeded=true.
    expect(budgetEvents).toHaveLength(1)
    expect(doneEvents).toHaveLength(1)
    expect(doneEvents[0]!.data.budgetExceeded).toBe(true)

    // 3. Returned messages contain the tool_result user message so the
    //    conversation is API-resumable.
    const messages = doneEvents[0]!.data.messages
    const lastMsg = messages[messages.length - 1]!
    expect(lastMsg.role).toBe('user')
    const hasMatchingToolResult = lastMsg.content.some(
      b => b.type === 'tool_result' && b.tool_use_id === toolUseEvents[0]!.data.id,
    )
    expect(hasMatchingToolResult).toBe(true)

    // 4. Ordering: tool_result event is emitted before budget_exceeded.
    const toolResultIdx = events.findIndex(e => e.type === 'tool_result')
    const budgetIdx = events.findIndex(e => e.type === 'budget_exceeded')
    expect(toolResultIdx).toBeLessThan(budgetIdx)

    // 5. LLM was only called once — we broke before a second turn.
    expect(idx).toBe(1)
  })
})

describe('regular budget_exceeded on a tool-call turn', () => {
  it('does not leave an orphaned tool_use block when LLM-token budget fires mid-turn', async () => {
    // The LLM returns a tool_use response whose token cost alone exceeds the
    // budget. Before the fix, AgentRunner broke immediately (before tool
    // execution) leaving an unmatched tool_use block in conversationMessages,
    // which caused a 400 on any subsequent API call. After the fix, the break
    // is deferred until after the matching tool_result has been appended.
    const toolUseId = 'tu-regular-budget'
    const responses: LLMResponse[] = [
      {
        id: 'resp-1',
        content: [{ type: 'tool_use', id: toolUseId, name: 'noop', input: {} }] as ContentBlock[],
        model: 'mock-model',
        stop_reason: 'tool_use',
        usage: { input_tokens: 90, output_tokens: 60 }, // 150 > budget of 100
      },
      {
        id: 'resp-2',
        content: [{ type: 'text', text: 'should not be reached' }],
        model: 'mock-model',
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 5 },
      },
    ]
    let idx = 0
    const adapter: LLMAdapter = {
      name: 'mock',
      async chat() { return responses[idx++]! },
      async *stream() { /* unused */ },
    }

    const registry = new ToolRegistry()
    registry.register(
      defineTool({
        name: 'noop',
        description: 'No-op tool for testing',
        inputSchema: z.object({}),
        async execute() { return { data: 'ok' } },
      }),
    )

    const runner = new AgentRunner(adapter, registry, new ToolExecutor(registry), {
      model: 'mock-model',
      allowedTools: ['noop'],
      maxTurns: 5,
      maxTokenBudget: 100,
      agentName: 'test-agent',
    })

    const events: StreamEvent[] = []
    for await (const ev of runner.stream([{ role: 'user', content: [{ type: 'text', text: 'go' }] }])) {
      events.push(ev)
    }

    const toolUseEvents = events.filter((e): e is StreamEvent & { type: 'tool_use'; data: ToolUseBlock } => e.type === 'tool_use')
    const toolResultEvents = events.filter((e): e is StreamEvent & { type: 'tool_result'; data: ToolResultBlock } => e.type === 'tool_result')
    const budgetEvents = events.filter(e => e.type === 'budget_exceeded')
    const doneEvents = events.filter((e): e is StreamEvent & { type: 'done'; data: { messages: LLMMessage[]; budgetExceeded?: boolean } } => e.type === 'done')

    // 1. tool_use and tool_result events are both emitted (paired).
    expect(toolUseEvents).toHaveLength(1)
    expect(toolResultEvents).toHaveLength(1)
    expect(toolResultEvents[0]!.data.tool_use_id).toBe(toolUseId)

    // 2. Budget event fires and run ends with budgetExceeded=true.
    expect(budgetEvents).toHaveLength(1)
    expect(doneEvents).toHaveLength(1)
    expect(doneEvents[0]!.data.budgetExceeded).toBe(true)

    // 3. Returned messages end with a tool_result user message — conversation
    //    is API-resumable (no orphaned tool_use block at the tail).
    const messages = doneEvents[0]!.data.messages
    const lastMsg = messages[messages.length - 1]!
    expect(lastMsg.role).toBe('user')
    expect(lastMsg.content.some(b => b.type === 'tool_result' && b.tool_use_id === toolUseId)).toBe(true)

    // 4. tool_result event appears before done (i.e. is emitted, not dropped).
    const toolResultIdx = events.findIndex(e => e.type === 'tool_result')
    const doneIdx = events.findIndex(e => e.type === 'done')
    expect(toolResultIdx).toBeGreaterThanOrEqual(0)
    expect(toolResultIdx).toBeLessThan(doneIdx)

    // 5. LLM should only be called once — we broke before a second turn.
    expect(idx).toBe(1)
  })
})
