import { describe, it, expect, vi } from 'vitest'
import { OpenMultiAgent } from '../src/orchestrator/orchestrator.js'
import type { AgentConfig, LLMChatOptions, LLMMessage, LLMResponse } from '../src/types.js'

// Single shared mock adapter, routed by systemPrompt + first-turn user text.
vi.mock('../src/llm/adapter.js', () => ({
  createAdapter: async () => ({
    name: 'mock',
    async chat(messages: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
      const sys = options.systemPrompt ?? ''
      const firstUserText = extractText(messages[0]?.content ?? [])
      const onlyOneMessage = messages.length === 1

      // Root parent task (turn 1) emits a delegation tool_use.
      // Task description strings are set to 'ROOT-A' / 'ROOT-B' so we can
      // distinguish the parent's first turn from the ephemeral delegate's
      // first turn (which sees 'ping-A' / 'ping-B' as its user prompt).
      if (onlyOneMessage && firstUserText.includes('ROOT-A')) {
        return toolUseResponse('delegate_to_agent', { target_agent: 'B', prompt: 'ping-B' })
      }
      if (onlyOneMessage && firstUserText.includes('ROOT-B')) {
        return toolUseResponse('delegate_to_agent', { target_agent: 'A', prompt: 'ping-A' })
      }

      // Ephemeral delegate's first (and only) turn — return plain text so it
      // terminates cleanly without another delegation.
      if (onlyOneMessage) {
        const who = sys.startsWith('A-') ? 'A' : 'B'
        return textResponse(`${who} nested done`)
      }

      // Root parent turn 2 — after tool_result. Return text to end the loop.
      const who = sys.startsWith('A-') ? 'A' : 'B'
      return textResponse(`${who} parent done`)
    },
    async *stream() { yield { type: 'done' as const, data: {} } },
  }),
}))

function textResponse(text: string): LLMResponse {
  return {
    id: `r-${Math.random().toString(36).slice(2)}`,
    content: [{ type: 'text', text }],
    model: 'mock-model',
    stop_reason: 'end_turn',
    usage: { input_tokens: 5, output_tokens: 5 },
  }
}

function toolUseResponse(toolName: string, input: Record<string, unknown>): LLMResponse {
  return {
    id: `r-${Math.random().toString(36).slice(2)}`,
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

function extractText(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join(' ')
}

function agentA(): AgentConfig {
  return {
    name: 'A',
    model: 'mock-model',
    provider: 'openai',
    // sysPrompt prefix used by the mock to disambiguate A vs B.
    systemPrompt: 'A-agent. You are agent A. Delegate to B when asked.',
    tools: ['delegate_to_agent'],
    maxTurns: 4,
  }
}

function agentB(): AgentConfig {
  return {
    name: 'B',
    model: 'mock-model',
    provider: 'openai',
    systemPrompt: 'B-agent. You are agent B. Delegate to A when asked.',
    tools: ['delegate_to_agent'],
    maxTurns: 4,
  }
}

describe('mutual delegation (A↔B) completes without agent-lock deadlock', () => {
  it('two parallel root tasks both finish when each delegates to the other', async () => {
    // Previously: pool.run('B') inside A's tool call waited on B's agent lock
    // (held by the parent B task), while pool.run('A') inside B's tool call
    // waited on A's agent lock — classic mutual deadlock.
    // After the fix: delegation uses runEphemeral on a fresh Agent instance,
    // so neither call touches the per-agent lock.
    const oma = new OpenMultiAgent({
      defaultModel: 'mock-model',
      defaultProvider: 'openai',
      // Need room for 2 parent runs + 2 ephemeral delegates.
      maxConcurrency: 4,
    })
    const team = oma.createTeam('mutual', {
      name: 'mutual',
      agents: [agentA(), agentB()],
      sharedMemory: false,
    })

    // Race against a 10s timeout so a regression surfaces as a test failure
    // rather than a hanging CI job.
    const runPromise = oma.runTasks(team, [
      { title: 'Task A', description: 'ROOT-A', assignee: 'A' },
      { title: 'Task B', description: 'ROOT-B', assignee: 'B' },
    ])
    const timeout = new Promise((_resolve, reject) =>
      setTimeout(() => reject(new Error('mutual delegation deadlock (timeout)')), 10_000),
    )

    const result = (await Promise.race([runPromise, timeout])) as Awaited<typeof runPromise>

    expect(result.success).toBe(true)
    const agentOutputs = [...result.agentResults.values()].map((r) => r.output)
    expect(agentOutputs.some((o) => o.includes('A parent done'))).toBe(true)
    expect(agentOutputs.some((o) => o.includes('B parent done'))).toBe(true)
  })
})
