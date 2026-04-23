import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'
import { OpenMultiAgent } from '../src/orchestrator/orchestrator.js'
import type { AgentConfig, LLMChatOptions, LLMMessage, LLMResponse, TeamConfig } from '../src/types.js'

// ---------------------------------------------------------------------------
// Mock createAdapter so tests do not require network access or API keys.
// ---------------------------------------------------------------------------

const CLAIM_ACCELERATING = 'Wasm adoption is accelerating rapidly in 2026.'
const CLAIM_STAGNATING = 'Wasm adoption is stagnating in 2026.'

let capturedPrompts: string[] = []

function lastUserText(msgs: LLMMessage[]): string {
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
  return (lastUser?.content ?? [])
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
}

vi.mock('../src/llm/adapter.js', () => ({
  createAdapter: async () => {
    return {
      name: 'mock',
      async chat(msgs: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
        const prompt = lastUserText(msgs)
        capturedPrompts.push(prompt)

        const isTechnical = prompt.includes('# Task: Technical analysis')
        const isMarket = prompt.includes('# Task: Market analysis')
        const isCommunity = prompt.includes('# Task: Community analysis')
        const isSynth = prompt.includes('# Task: Synthesize report')

        let text = 'default mock response'

        if (isTechnical) {
          text = [
            '## Claims (max 6 bullets)',
            `- ${CLAIM_ACCELERATING}`,
            '- Runtime sandboxing reduces risk compared to native plugins.',
            '',
            '## Evidence (max 4 bullets)',
            '- Multiple runtimes optimized for near-native speed exist.',
          ].join('\n')
        } else if (isMarket) {
          text = [
            '## Claims (max 6 bullets)',
            `- ${CLAIM_STAGNATING}`,
            '- Enterprises are cautious due to tooling fragmentation.',
            '',
            '## Evidence (max 4 bullets)',
            '- Hiring signals lag behind hype cycles.',
          ].join('\n')
        } else if (isCommunity) {
          text = [
            '## Claims (max 6 bullets)',
            '- Developer interest is steady but polarized by use-case.',
            '',
            '## Evidence (max 4 bullets)',
            '- Tutorials focus on edge runtimes and plugin systems.',
          ].join('\n')
        } else if (isSynth) {
          // Minimal "extraction": if we see both contradictory claims in the prompt context,
          // surface them in the contradictions array.
          const hasA = prompt.includes(CLAIM_ACCELERATING)
          const hasB = prompt.includes(CLAIM_STAGNATING)
          const contradictions = (hasA && hasB)
            ? [{
                claim_a: CLAIM_ACCELERATING,
                claim_b: CLAIM_STAGNATING,
                analysts: ['technical-analyst', 'market-analyst'],
              }]
            : []

          const payload = {
            summary: 'Mock synthesis summary.',
            findings: [
              {
                title: 'Adoption signals are mixed.',
                detail: 'Technical capability is improving, but market pull is uncertain. This is consistent with contradictory near-term signals.',
                analysts: ['technical-analyst', 'market-analyst', 'community-analyst'],
                confidence: 0.6,
              },
            ],
            contradictions,
          }
          text = JSON.stringify(payload)
        }

        return {
          id: 'mock-1',
          content: [{ type: 'text', text }],
          model: options.model ?? 'mock-model',
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 20 },
        } satisfies LLMResponse
      },
      async *stream() {
        /* unused */
      },
    }
  },
}))

// ---------------------------------------------------------------------------
// Schema under test (matches the issue acceptance requirements)
// ---------------------------------------------------------------------------

const FindingSchema = z.object({
  title: z.string(),
  detail: z.string(),
  analysts: z.array(z.enum(['technical-analyst', 'market-analyst', 'community-analyst'])).min(1),
  confidence: z.number().min(0).max(1),
})

const ContradictionSchema = z.object({
  claim_a: z.string(),
  claim_b: z.string(),
  analysts: z.tuple([
    z.enum(['technical-analyst', 'market-analyst', 'community-analyst']),
    z.enum(['technical-analyst', 'market-analyst', 'community-analyst']),
  ]),
}).refine((x) => x.analysts[0] !== x.analysts[1], { path: ['analysts'], message: 'must be different' })

const ResearchAggregationSchema = z.object({
  summary: z.string(),
  findings: z.array(FindingSchema),
  contradictions: z.array(ContradictionSchema),
})

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

function teamCfg(agents: AgentConfig[]): TeamConfig {
  return { name: 'research-team', agents, sharedMemory: true }
}

describe('research aggregation (mocked) surfaces contradictions in structured output', () => {
  beforeEach(() => {
    capturedPrompts = []
  })

  it('returns synthesizer.structured with contradictions array containing known claims', async () => {
    const oma = new OpenMultiAgent({
      defaultProvider: 'openai',
      defaultModel: 'mock-model',
      maxConcurrency: 3,
    })

    const agents: AgentConfig[] = [
      { name: 'technical-analyst', model: 'mock-model', systemPrompt: 'technical', maxTurns: 1 },
      { name: 'market-analyst', model: 'mock-model', systemPrompt: 'market', maxTurns: 1 },
      { name: 'community-analyst', model: 'mock-model', systemPrompt: 'community', maxTurns: 1 },
      { name: 'synthesizer', model: 'mock-model', systemPrompt: 'synth', outputSchema: ResearchAggregationSchema, maxTurns: 2 },
    ]

    const team = oma.createTeam('research-team', teamCfg(agents))

    const tasks = [
      { title: 'Technical analysis', description: 'Analyze tech', assignee: 'technical-analyst' },
      { title: 'Market analysis', description: 'Analyze market', assignee: 'market-analyst' },
      { title: 'Community analysis', description: 'Analyze community', assignee: 'community-analyst' },
      {
        title: 'Synthesize report',
        description: 'Synthesize',
        assignee: 'synthesizer',
        dependsOn: ['Technical analysis', 'Market analysis', 'Community analysis'],
      },
    ] as const

    const result = await oma.runTasks(team, tasks)
    expect(result.success).toBe(true)

    const synth = result.agentResults.get('synthesizer')
    expect(synth?.success).toBe(true)
    expect(synth?.structured).toBeDefined()

    const structured = synth!.structured as z.infer<typeof ResearchAggregationSchema>
    expect(Array.isArray(structured.contradictions)).toBe(true)

    // Assert that the known contradiction is surfaced.
    expect(structured.contradictions).toEqual([
      {
        claim_a: CLAIM_ACCELERATING,
        claim_b: CLAIM_STAGNATING,
        analysts: ['technical-analyst', 'market-analyst'],
      },
    ])

    // Sanity check: the synthesizer prompt actually contained the analyst outputs.
    const synthPrompt = capturedPrompts.find((p) => p.includes('# Task: Synthesize report')) ?? ''
    expect(synthPrompt).toContain(CLAIM_ACCELERATING)
    expect(synthPrompt).toContain(CLAIM_STAGNATING)
  })
})

