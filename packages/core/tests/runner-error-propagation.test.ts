import { describe, it, expect } from 'vitest'
import { Agent } from '../src/agent/agent.js'
import { AgentRunner } from '../src/agent/runner.js'
import { ToolRegistry } from '../src/tool/framework.js'
import { ToolExecutor } from '../src/tool/executor.js'
import type { AgentConfig, LLMAdapter, LLMMessage } from '../src/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Adapter whose chat() always throws. */
function errorAdapter(error: Error): LLMAdapter {
  return {
    name: 'error-mock',
    async chat(_messages: LLMMessage[]) {
      throw error
    },
    async *stream() {
      /* unused */
    },
  }
}

function buildAgentWithAdapter(config: AgentConfig, adapter: LLMAdapter) {
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

  return agent
}

const baseConfig: AgentConfig = {
  name: 'test-agent',
  model: 'mock-model',
  systemPrompt: 'You are a test agent.',
}

// ---------------------------------------------------------------------------
// Tests — #98: AgentRunner.run() must propagate errors from stream()
// ---------------------------------------------------------------------------

describe('AgentRunner.run() error propagation (#98)', () => {
  it('LLM adapter error surfaces as success:false in AgentRunResult', async () => {
    const apiError = new Error('API 500: internal server error')
    const agent = buildAgentWithAdapter(baseConfig, errorAdapter(apiError))

    const result = await agent.run('hello')

    expect(result.success).toBe(false)
    expect(result.output).toContain('API 500')
  })

  it('AgentRunner.run() throws when adapter errors', async () => {
    const apiError = new Error('network timeout')
    const adapter = errorAdapter(apiError)
    const registry = new ToolRegistry()
    const executor = new ToolExecutor(registry)
    const runner = new AgentRunner(adapter, registry, executor, {
      model: 'mock-model',
      systemPrompt: 'test',
      agentName: 'test',
    })

    await expect(
      runner.run([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]),
    ).rejects.toThrow('network timeout')
  })

  it('agent transitions to error state on LLM failure', async () => {
    const agent = buildAgentWithAdapter(baseConfig, errorAdapter(new Error('boom')))

    await agent.run('hello')

    expect(agent.getState().status).toBe('error')
  })
})
