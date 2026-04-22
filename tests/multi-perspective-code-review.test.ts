import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { Agent } from '../src/agent/agent.js'
import { AgentRunner } from '../src/agent/runner.js'
import { ToolRegistry } from '../src/tool/framework.js'
import { ToolExecutor } from '../src/tool/executor.js'
import type { AgentConfig, LLMAdapter, LLMResponse } from '../src/types.js'

const ReviewFindings = z.array(
  z.object({
    priority: z.enum(['critical', 'high', 'medium', 'low']),
    category: z.enum(['security', 'performance', 'style']),
    issue: z.string(),
    fix_hint: z.string(),
  }),
)

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
      /* unused in this test */
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

describe('multi-perspective code review example', () => {
  it('returns structured findings that match the issue schema', async () => {
    const config: AgentConfig = {
      name: 'synthesizer',
      model: 'mock-model',
      systemPrompt: 'Return structured review findings.',
      outputSchema: ReviewFindings,
    }

    const findings = [
      {
        priority: 'critical',
        category: 'security',
        issue: 'User input is interpolated directly into the SQL query.',
        fix_hint: 'Use parameterized queries for all database writes.',
      },
      {
        priority: 'medium',
        category: 'style',
        issue: 'Error responses use inconsistent wording across branches.',
        fix_hint: 'Standardize error messages and response payload structure.',
      },
    ]

    const agent = buildMockAgent(config, [JSON.stringify(findings)])
    const result = await agent.run('Synthesize the reviewers into structured findings.')

    expect(result.success).toBe(true)
    expect(Array.isArray(result.structured)).toBe(true)
    expect(ReviewFindings.parse(result.structured)).toEqual(findings)
  })
})
