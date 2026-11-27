import { describe, it, expect, vi } from 'vitest'
import { getEventListeners } from 'node:events'
import { OpenMultiAgent } from '../src/orchestrator/orchestrator.js'
import { Team } from '../src/team/team.js'
import { Agent } from '../src/agent/agent.js'
import { AgentRunner } from '../src/agent/runner.js'
import { ToolRegistry } from '../src/tool/framework.js'
import { ToolExecutor } from '../src/tool/executor.js'
import { mergeAbortSignals } from '../src/utils/abort.js'
import type { LLMAdapter, LLMMessage, LLMResponse } from '../src/types.js'

describe('mergeAbortSignals', () => {
  it.each([
    ['first', 0],
    ['second', 1],
  ] as const)('cleans up both source listeners when the %s signal aborts', (_, index) => {
    const controllers = [new AbortController(), new AbortController()] as const
    const [first, second] = controllers
    const merged = mergeAbortSignals(first.signal, second.signal)

    expect(getEventListeners(first.signal, 'abort')).toHaveLength(1)
    expect(getEventListeners(second.signal, 'abort')).toHaveLength(1)

    controllers[index].abort()

    expect(merged.signal.aborted).toBe(true)
    expect(getEventListeners(first.signal, 'abort')).toHaveLength(0)
    expect(getEventListeners(second.signal, 'abort')).toHaveLength(0)
    merged.dispose()
  })

  it('does not add a listener when a source is already aborted', () => {
    const aborted = new AbortController()
    const active = new AbortController()
    aborted.abort()

    const merged = mergeAbortSignals(aborted.signal, active.signal)

    expect(merged.signal.aborted).toBe(true)
    expect(getEventListeners(aborted.signal, 'abort')).toHaveLength(0)
    expect(getEventListeners(active.signal, 'abort')).toHaveLength(0)
  })

  it('dispose releases both source listeners without aborting the merged signal', () => {
    const first = new AbortController()
    const second = new AbortController()
    const merged = mergeAbortSignals(first.signal, second.signal)

    expect(getEventListeners(first.signal, 'abort')).toHaveLength(1)
    expect(getEventListeners(second.signal, 'abort')).toHaveLength(1)

    merged.dispose()

    expect(merged.signal.aborted).toBe(false)
    expect(getEventListeners(first.signal, 'abort')).toHaveLength(0)
    expect(getEventListeners(second.signal, 'abort')).toHaveLength(0)

    // Idempotent, and detached: a later source abort no longer propagates.
    merged.dispose()
    first.abort()
    expect(merged.signal.aborted).toBe(false)
  })
})

describe('AbortSignal support for runTeam and runTasks', () => {
  it('runTeam should accept an abortSignal option', async () => {
    const orchestrator = new OpenMultiAgent({
      defaultModel: 'test-model',
      defaultProvider: 'openai',
    })

    // Verify the API accepts the option without throwing
    const controller = new AbortController()
    const team = new Team({
      name: 'test',
      agents: [
        { name: 'agent1', model: 'test-model', systemPrompt: 'test' },
      ],
    })

    // Abort immediately so the run won't actually execute LLM calls
    controller.abort()

    // runTeam should return gracefully (no unhandled rejection)
    const result = await orchestrator.runTeam(team, 'test goal', {
      abortSignal: controller.signal,
    })

    // With immediate abort, coordinator may or may not have run,
    // but the function should not throw.
    expect(result).toBeDefined()
    expect(result.agentResults).toBeInstanceOf(Map)
  })

  it('runTasks should accept an abortSignal option', async () => {
    const orchestrator = new OpenMultiAgent({
      defaultModel: 'test-model',
      defaultProvider: 'openai',
    })

    const controller = new AbortController()
    const team = new Team({
      name: 'test',
      agents: [
        { name: 'agent1', model: 'test-model', systemPrompt: 'test' },
      ],
    })

    controller.abort()

    const result = await orchestrator.runTasks(team, [
      { title: 'task1', description: 'do something', assignee: 'agent1' },
    ], { abortSignal: controller.signal })

    expect(result).toBeDefined()
    expect(result.agentResults).toBeInstanceOf(Map)
  })

  it('pre-aborted signal should skip pending tasks', async () => {
    const orchestrator = new OpenMultiAgent({
      defaultModel: 'test-model',
      defaultProvider: 'openai',
    })

    const controller = new AbortController()
    controller.abort()

    const team = new Team({
      name: 'test',
      agents: [
        { name: 'agent1', model: 'test-model', systemPrompt: 'test' },
      ],
    })

    const result = await orchestrator.runTasks(team, [
      { title: 'task1', description: 'first', assignee: 'agent1' },
      { title: 'task2', description: 'second', assignee: 'agent1' },
    ], { abortSignal: controller.signal })

    // No agent runs should complete since signal was already aborted
    expect(result).toBeDefined()
  })

  it('runTeam and runTasks work without abortSignal (backward compat)', async () => {
    const orchestrator = new OpenMultiAgent({
      defaultModel: 'test-model',
      defaultProvider: 'openai',
    })

    const team = new Team({
      name: 'test',
      agents: [
        { name: 'agent1', model: 'test-model', systemPrompt: 'test' },
      ],
    })

    // These should not throw even without abortSignal
    const promise1 = orchestrator.runTeam(team, 'goal')
    const promise2 = orchestrator.runTasks(team, [
      { title: 'task1', description: 'do something', assignee: 'agent1' },
    ])

    // Both return promises (won't resolve without real LLM, but API is correct)
    expect(promise1).toBeInstanceOf(Promise)
    expect(promise2).toBeInstanceOf(Promise)
  })
})

/**
 * A merged signal that never aborts must still release the listeners it added
 * to its sources. A caller-owned signal can outlive any number of runs, and
 * with `callTimeoutMs` the runner mints one merge per LLM call, so a leaked
 * pair per call accumulates on the run signal until Node warns.
 */
function textAdapter(): LLMAdapter {
  const response: LLMResponse = {
    id: '1',
    content: [{ type: 'text', text: 'done' }],
    model: 'mock',
    stop_reason: 'end_turn',
    usage: { input_tokens: 0, output_tokens: 0 },
  }
  return { name: 'mock', chat: async () => response, async *stream() {} }
}

const USER_HI: LLMMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]

describe('mergeAbortSignals listener hygiene', () => {
  it('releases the caller listener after a per-call timeout run', async () => {
    const caller = new AbortController()
    const registry = new ToolRegistry()
    const runner = new AgentRunner(textAdapter(), registry, new ToolExecutor(registry), {
      model: 'mock',
      callTimeoutMs: 10_000,
    })

    const result = await runner.run(USER_HI, { abortSignal: caller.signal })

    expect(result.output).toBe('done')
    expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0)
  })

  it('releases the caller listener after a whole-run timeout', async () => {
    const caller = new AbortController()
    const registry = new ToolRegistry()
    const agent = new Agent(
      { name: 'a', model: 'mock', adapter: textAdapter(), timeoutMs: 10_000 },
      registry,
      new ToolExecutor(registry),
    )

    const result = await agent.run('hi', { abortSignal: caller.signal })

    expect(result.success).toBe(true)
    expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0)
  })
})
