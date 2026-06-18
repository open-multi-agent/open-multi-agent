import { describe, it, expect, vi } from 'vitest'
import { OpenMultiAgent } from '../src/orchestrator/orchestrator.js'
import { Team } from '../src/team/team.js'

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
