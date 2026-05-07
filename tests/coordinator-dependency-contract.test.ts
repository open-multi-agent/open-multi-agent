/**
 * Regression guard: the framework must faithfully forward whatever `dependsOn`
 * the coordinator returned — no framework-level widening or silent drops.
 *
 * Uses a stubbed LLM adapter so no API key is needed and the coordinator's
 * output is fully deterministic. This is NOT a test of LLM behaviour;
 * see tests/e2e/coordinator-dependency-widening.test.ts for that.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { OpenMultiAgent } from '../src/orchestrator/orchestrator.js'
import type { AgentConfig, LLMChatOptions, LLMMessage, LLMResponse, TeamConfig } from '../src/types.js'

// ---------------------------------------------------------------------------
// Mock LLM adapter — same pattern as orchestrator.test.ts
// ---------------------------------------------------------------------------

let mockAdapterResponses: string[] = []

vi.mock('../src/llm/adapter.js', () => ({
  createAdapter: async () => {
    let callIndex = 0
    return {
      name: 'mock',
      async chat(_msgs: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
        const text = mockAdapterResponses[callIndex] ?? 'default mock response'
        callIndex++
        return {
          id: `resp-${callIndex}`,
          content: [{ type: 'text', text }],
          model: options.model ?? 'mock-model',
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 20 },
        }
      },
      async *stream() {
        yield { type: 'done' as const, data: {} }
      },
    }
  },
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function agent(name: string, systemPrompt: string): AgentConfig {
  return { name, model: 'mock-model', provider: 'openai', systemPrompt }
}

function teamCfg(agents: AgentConfig[]): TeamConfig {
  return { name: 'test-team', agents }
}

function coordinatorPlan(tasks: object[]): string {
  return '```json\n' + JSON.stringify(tasks) + '\n```'
}

// A goal complex enough to bypass the simple-goal short-circuit, but
// planOnly: true ensures no workers actually execute regardless.
const GOAL = 'Design and plan a secure software system using our engineering team'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('coordinator dependency contract — framework plumbing', () => {
  beforeEach(() => {
    mockAdapterResponses = []
  })

  it('preserves minimal dependsOn — unrelated sibling is not wired in by the framework', async () => {
    // The coordinator returns a plan where:
    //   architect  → depends only on requirements (NOT security)
    //   frontend   → depends only on architect   (NOT security)
    // The framework must preserve this exactly.
    mockAdapterResponses = [
      coordinatorPlan([
        { title: 'Requirements', description: 'Gather requirements', assignee: 'requirements-analyst', dependsOn: [] },
        { title: 'Security Audit', description: 'Audit for security', assignee: 'security-auditor', dependsOn: ['Requirements'] },
        { title: 'Architecture', description: 'Design architecture', assignee: 'architect', dependsOn: ['Requirements'] },
        { title: 'Frontend Plan', description: 'Plan the frontend', assignee: 'frontend-planner', dependsOn: ['Architecture'] },
      ]),
    ]

    const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
    const team = oma.createTeam('t', teamCfg([
      agent('requirements-analyst', 'You gather requirements.'),
      agent('security-auditor', 'You audit the requirements for security vulnerabilities.'),
      agent('architect', 'You consume the requirements analysis to design the system.'),
      agent('frontend-planner', 'You consume the architectural blueprint to plan the frontend.'),
    ]))

    const result = await oma.runTeam(team, GOAL, { planOnly: true })

    expect(result.planOnly).toBe(true)
    expect(result.tasks).toBeDefined()
    expect(result.tasks).toHaveLength(4)

    const byAssignee = (name: string) => result.tasks!.find(t => t.assignee === name)!
    const requirementsTask = byAssignee('requirements-analyst')
    const securityTask     = byAssignee('security-auditor')
    const architectTask    = byAssignee('architect')
    const frontendTask     = byAssignee('frontend-planner')

    // architect → only requirements; security must not appear
    expect(architectTask.dependsOn).toEqual([requirementsTask.id])
    expect(architectTask.dependsOn).not.toContain(securityTask.id)

    // frontend → only architect; security must not appear
    expect(frontendTask.dependsOn).toEqual([architectTask.id])
    expect(frontendTask.dependsOn).not.toContain(securityTask.id)
  })

  it('propagates all declared dependsOn — no silent drops by the framework', async () => {
    // The coordinator returns exhaustive deps (all declared).
    // The framework must wire every one of them — no silent drops.
    mockAdapterResponses = [
      coordinatorPlan([
        { title: 'Requirements', description: 'Gather requirements', assignee: 'requirements-analyst', dependsOn: [] },
        { title: 'Security Audit', description: 'Audit for security', assignee: 'security-auditor', dependsOn: ['Requirements'] },
        { title: 'Architecture', description: 'Design architecture', assignee: 'architect', dependsOn: ['Requirements', 'Security Audit'] },
        { title: 'Threat Model', description: 'Model threats', assignee: 'threat-modeler', dependsOn: ['Architecture', 'Security Audit'] },
      ]),
    ]

    const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
    const team = oma.createTeam('t', teamCfg([
      agent('requirements-analyst', 'You gather requirements.'),
      agent('security-auditor', 'You audit the requirements for security vulnerabilities.'),
      agent('architect', 'You consume the requirements analysis and the security audit. Both inputs are required.'),
      agent('threat-modeler', 'You consume the architectural blueprint and the security audit. Both inputs are required.'),
    ]))

    const result = await oma.runTeam(team, GOAL, { planOnly: true })

    expect(result.planOnly).toBe(true)
    expect(result.tasks).toBeDefined()
    expect(result.tasks).toHaveLength(4)

    const byAssignee = (name: string) => result.tasks!.find(t => t.assignee === name)!
    const requirementsTask = byAssignee('requirements-analyst')
    const securityTask     = byAssignee('security-auditor')
    const architectTask    = byAssignee('architect')
    const threatTask       = byAssignee('threat-modeler')

    // architect declared 2 deps — both must be present
    expect(architectTask.dependsOn).toHaveLength(2)
    expect(architectTask.dependsOn).toContain(requirementsTask.id)
    expect(architectTask.dependsOn).toContain(securityTask.id)

    // threat-modeler declared 2 deps — both must be present
    expect(threatTask.dependsOn).toHaveLength(2)
    expect(threatTask.dependsOn).toContain(architectTask.id)
    expect(threatTask.dependsOn).toContain(securityTask.id)
  })
})
