import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isSimpleGoal, selectBestAgent } from '../src/orchestrator/orchestrator.js'
import { OpenMultiAgent } from '../src/orchestrator/orchestrator.js'
import type {
  AgentConfig,
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  OrchestratorEvent,
  TeamConfig,
} from '../src/types.js'

// ---------------------------------------------------------------------------
// isSimpleGoal — pure function tests
// ---------------------------------------------------------------------------

describe('isSimpleGoal', () => {
  describe('returns true for simple goals', () => {
    const simpleGoals = [
      'Say hello',
      'What is 2 + 2?',
      'Explain monads in one paragraph',
      'Translate this to French: Good morning',
      'List 3 blockchain security vulnerabilities',
      'Write a haiku about TypeScript',
      'Summarize this article',
      '你好，回一个字：哈',
      'Fix the typo in the README',
    ]

    for (const goal of simpleGoals) {
      it(`"${goal}"`, () => {
        expect(isSimpleGoal(goal)).toBe(true)
      })
    }
  })

  describe('returns false for complex goals', () => {
    it('goal with explicit sequencing (first…then)', () => {
      expect(isSimpleGoal('First design the API schema, then implement the endpoints')).toBe(false)
    })

    it('goal with numbered steps', () => {
      expect(isSimpleGoal('1. Design the schema\n2. Implement the API\n3. Write tests')).toBe(false)
    })

    it('goal with step N pattern', () => {
      expect(isSimpleGoal('Step 1: set up the project. Step 2: write the code.')).toBe(false)
    })

    it('goal with collaboration language', () => {
      expect(isSimpleGoal('Collaborate on building a REST API with tests')).toBe(false)
    })

    it('goal with coordination language', () => {
      expect(isSimpleGoal('Coordinate the team to build and deploy the service')).toBe(false)
    })

    it('goal with parallel execution', () => {
      expect(isSimpleGoal('Run the linter and tests in parallel')).toBe(false)
    })

    it('goal with multiple deliverables (build…and…test)', () => {
      expect(isSimpleGoal('Build the REST API endpoints and then write comprehensive integration tests for each one')).toBe(false)
    })

    it('goal exceeding max length', () => {
      const longGoal = 'Explain the concept of ' + 'a'.repeat(200)
      expect(isSimpleGoal(longGoal)).toBe(false)
    })

    it('goal with phase markers', () => {
      expect(isSimpleGoal('Phase 1 is planning, phase 2 is execution')).toBe(false)
    })

    it('goal with "work together"', () => {
      expect(isSimpleGoal('Work together to build the frontend and backend')).toBe(false)
    })

    it('goal with "review each other"', () => {
      expect(isSimpleGoal('Write code and review each other\'s pull requests')).toBe(false)
    })
  })

  describe('edge cases', () => {
    it('empty string is simple', () => {
      expect(isSimpleGoal('')).toBe(true)
    })

    it('"and" alone does not trigger complexity', () => {
      // Unlike the original turbo implementation, common words like "and"
      // should NOT flag a goal as complex.
      expect(isSimpleGoal('Pros and cons of TypeScript')).toBe(true)
    })

    it('"then" alone does not trigger complexity', () => {
      expect(isSimpleGoal('What happened then?')).toBe(true)
    })

    it('"summarize" alone does not trigger complexity', () => {
      expect(isSimpleGoal('Summarize the article about AI safety')).toBe(true)
    })

    it('"analyze" alone does not trigger complexity', () => {
      expect(isSimpleGoal('Analyze this error log')).toBe(true)
    })

    it('goal exactly at length boundary (200) is simple if no patterns', () => {
      const goal = 'x'.repeat(200)
      expect(isSimpleGoal(goal)).toBe(true)
    })

    it('goal at 201 chars is complex', () => {
      const goal = 'x'.repeat(201)
      expect(isSimpleGoal(goal)).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Regression: tightened coordinate/collaborate regex (PR #70 review point 5)
  //
  // Descriptive uses of "coordinate" / "collaborate" / "collaboration" must
  // NOT be flagged as complex — only imperative directives aimed at agents.
  // -------------------------------------------------------------------------

  describe('tightened coordinate/collaborate patterns', () => {
    it('descriptive "how X coordinates" is simple', () => {
      expect(isSimpleGoal('Explain how Kubernetes pods coordinate state')).toBe(true)
    })

    it('descriptive "collaboration" noun is simple', () => {
      expect(isSimpleGoal('What is microservice collaboration?')).toBe(true)
    })

    it('descriptive "team that coordinates" is simple', () => {
      expect(isSimpleGoal('Describe a team that coordinates releases')).toBe(true)
    })

    it('descriptive "without collaborating" is simple', () => {
      expect(isSimpleGoal('Show how to deploy without collaborating')).toBe(true)
    })

    it('imperative "collaborate with X" is complex', () => {
      expect(isSimpleGoal('Collaborate with the writer to draft a post')).toBe(false)
    })

    it('imperative "coordinate the team" is complex', () => {
      expect(isSimpleGoal('Coordinate the team for release')).toBe(false)
    })

    it('imperative "coordinate across services" is complex', () => {
      expect(isSimpleGoal('Coordinate across services to roll out the change')).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// selectBestAgent — keyword affinity scoring
// ---------------------------------------------------------------------------

describe('selectBestAgent', () => {
  it('selects agent whose systemPrompt best matches the goal', () => {
    const agents: AgentConfig[] = [
      { name: 'researcher', model: 'test', systemPrompt: 'You are a research expert who analyzes data and writes reports' },
      { name: 'coder', model: 'test', systemPrompt: 'You are a software engineer who writes TypeScript code' },
    ]

    expect(selectBestAgent('Write TypeScript code for the API', agents)).toBe(agents[1])
    expect(selectBestAgent('Research the latest AI papers', agents)).toBe(agents[0])
  })

  it('falls back to first agent when no keywords match', () => {
    const agents: AgentConfig[] = [
      { name: 'alpha', model: 'test' },
      { name: 'beta', model: 'test' },
    ]

    expect(selectBestAgent('xyzzy', agents)).toBe(agents[0])
  })

  it('returns the only agent when team has one member', () => {
    const agents: AgentConfig[] = [
      { name: 'solo', model: 'test', systemPrompt: 'General purpose agent' },
    ]

    expect(selectBestAgent('anything', agents)).toBe(agents[0])
  })

  it('considers agent name in scoring', () => {
    const agents: AgentConfig[] = [
      { name: 'writer', model: 'test', systemPrompt: 'You help with tasks' },
      { name: 'reviewer', model: 'test', systemPrompt: 'You help with tasks' },
    ]

    // "review" should match "reviewer" agent name
    expect(selectBestAgent('Review this pull request', agents)).toBe(agents[1])
  })

  // -------------------------------------------------------------------------
  // Regression: model field asymmetry (PR #70 review point 2)
  //
  // selectBestAgent must mirror Scheduler.capability-match exactly:
  //   - agentKeywords includes `model`
  //   - agentText excludes `model`
  // This means a goal that mentions a model name should boost the agent
  // bound to that model (via scoreB), even if neither name nor system prompt
  // contains the keyword.
  // -------------------------------------------------------------------------
  it('matches scheduler asymmetry: model name in goal boosts the bound agent', () => {
    const agents: AgentConfig[] = [
      // Distinct, non-overlapping prompts so neither one wins on scoreA
      { name: 'a1', model: 'haiku-fast-model', systemPrompt: 'You handle quick lookups' },
      { name: 'a2', model: 'opus-deep-model', systemPrompt: 'You handle deep analysis' },
    ]

    // Mention "haiku" — this is only present in a1.model, so the bound
    // agent should win because agentKeywords (which includes model) matches.
    expect(selectBestAgent('Use the haiku model please', agents)).toBe(agents[0])
  })
})

// ---------------------------------------------------------------------------
// runTeam short-circuit integration test
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

function agentConfig(name: string, systemPrompt?: string): AgentConfig {
  return {
    name,
    model: 'mock-model',
    provider: 'openai',
    systemPrompt: systemPrompt ?? `You are ${name}.`,
  }
}

function teamCfg(agents?: AgentConfig[]): TeamConfig {
  return {
    name: 'test-team',
    agents: agents ?? [
      agentConfig('researcher', 'You research topics and analyze data'),
      agentConfig('coder', 'You write TypeScript code'),
    ],
    sharedMemory: true,
  }
}

describe('runTeam short-circuit', () => {
  beforeEach(() => {
    mockAdapterResponses = []
  })

  it('short-circuits simple goals to a single agent (no coordinator)', async () => {
    // Only ONE response needed — no coordinator decomposition or synthesis
    mockAdapterResponses = ['Direct answer without coordination']

    const events: OrchestratorEvent[] = []
    const oma = new OpenMultiAgent({
      defaultModel: 'mock-model',
      onProgress: (e) => events.push(e),
    })
    const team = oma.createTeam('t', teamCfg())

    const result = await oma.runTeam(team, 'Say hello')

    expect(result.success).toBe(true)
    expect(result.agentResults.size).toBe(1)
    // Should NOT have coordinator results — short-circuit bypasses it
    expect(result.agentResults.has('coordinator')).toBe(false)
  })

  it('emits progress events for short-circuit path', async () => {
    mockAdapterResponses = ['done']

    const events: OrchestratorEvent[] = []
    const oma = new OpenMultiAgent({
      defaultModel: 'mock-model',
      onProgress: (e) => events.push(e),
    })
    const team = oma.createTeam('t', teamCfg())

    await oma.runTeam(team, 'Say hello')

    const types = events.map(e => e.type)
    expect(types).toContain('agent_start')
    expect(types).toContain('agent_complete')
  })

  it('uses coordinator for complex goals', async () => {
    // Complex goal — needs coordinator decomposition + execution + synthesis
    mockAdapterResponses = [
      '```json\n[{"title": "Research", "description": "Research the topic", "assignee": "researcher"}]\n```',
      'Research results',
      'Final synthesis',
    ]

    const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
    const team = oma.createTeam('t', teamCfg())

    const result = await oma.runTeam(
      team,
      'First research AI safety best practices, then write a comprehensive guide with code examples',
    )

    expect(result.success).toBe(true)
    // Complex goal should go through coordinator
    expect(result.agentResults.has('coordinator')).toBe(true)
  })

  it('selects best-matching agent for simple goals', async () => {
    mockAdapterResponses = ['code result']

    const events: OrchestratorEvent[] = []
    const oma = new OpenMultiAgent({
      defaultModel: 'mock-model',
      onProgress: (e) => events.push(e),
    })
    const team = oma.createTeam('t', teamCfg())

    await oma.runTeam(team, 'Write TypeScript code')

    // Should pick 'coder' agent based on keyword match
    const startEvent = events.find(e => e.type === 'agent_start')
    expect(startEvent?.agent).toBe('coder')
  })

  // -------------------------------------------------------------------------
  // Regression: no duplicate progress events (#82)
  //
  // The short-circuit path must emit exactly one agent_start and one
  // agent_complete event. Before the fix, calling this.runAgent() added
  // a second pair of events on top of the ones emitted by the short-circuit
  // block itself, and buildTeamRunResult() double-counted completedTasks.
  // -------------------------------------------------------------------------
  it('emits exactly one agent_start and one agent_complete (no duplicates)', async () => {
    mockAdapterResponses = ['done']

    const events: OrchestratorEvent[] = []
    const oma = new OpenMultiAgent({
      defaultModel: 'mock-model',
      onProgress: (e) => events.push(e),
    })
    const team = oma.createTeam('t', teamCfg())

    await oma.runTeam(team, 'Say hello')

    const starts = events.filter(e => e.type === 'agent_start')
    const completes = events.filter(e => e.type === 'agent_complete')
    expect(starts).toHaveLength(1)
    expect(completes).toHaveLength(1)
  })

  it('completedTaskCount is exactly 1 after a successful short-circuit run', async () => {
    mockAdapterResponses = ['done']
    const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
    const team = oma.createTeam('t', teamCfg())

    await oma.runTeam(team, 'Say hello')

    expect(oma.getStatus().completedTasks).toBe(1)
  })

  it('aborted signal causes the underlying agent loop to skip the LLM call', async () => {
    // Pre-aborted controller — runner should break before any chat() call
    const controller = new AbortController()
    controller.abort()

    mockAdapterResponses = ['should never be returned']

    const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
    const team = oma.createTeam('t', teamCfg())

    const result = await oma.runTeam(team, 'Say hello', { abortSignal: controller.signal })

    // Short-circuit ran one agent, but its loop bailed before any LLM call,
    // so the agent's output is the empty string and token usage is zero.
    const agentResult = result.agentResults.values().next().value
    expect(agentResult?.output).toBe('')
    expect(agentResult?.tokenUsage.input_tokens).toBe(0)
    expect(agentResult?.tokenUsage.output_tokens).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Public API surface — internal helpers must stay out of the barrel export
// (PR #70 review point 3)
// ---------------------------------------------------------------------------

describe('public API barrel', () => {
  it('does not re-export isSimpleGoal or selectBestAgent', async () => {
    const indexExports = await import('../src/index.js')
    expect((indexExports as Record<string, unknown>).isSimpleGoal).toBeUndefined()
    expect((indexExports as Record<string, unknown>).selectBestAgent).toBeUndefined()
  })

  it('still re-exports the documented public symbols', async () => {
    const indexExports = await import('../src/index.js')
    expect(indexExports.OpenMultiAgent).toBeDefined()
    expect(indexExports.executeWithRetry).toBeDefined()
    expect(indexExports.computeRetryDelay).toBeDefined()
  })
})
