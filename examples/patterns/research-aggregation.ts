/**
 * Multi-Source Research Aggregation
 *
 * Demonstrates runTasks() with explicit dependency chains:
 * - Parallel execution: three analyst agents research the same topic independently
 * - Dependency chain via dependsOn: synthesizer waits for all analysts to finish
 * - Automatic shared memory: agent output flows to downstream agents via the framework
 *
 * Compare with example 07 (fan-out-aggregate) which uses AgentPool.runParallel()
 * for the same 3-analysts + synthesizer pattern. This example shows the runTasks()
 * API with explicit dependsOn declarations instead.
 *
 * Flow:
 *   [technical-analyst, market-analyst, community-analyst] (parallel) → synthesizer
 *
 * Run:
 *   npx tsx examples/patterns/research-aggregation.ts
 *
 * Prerequisites:
 *   ANTHROPIC_API_KEY env var must be set.
 */

import { OpenMultiAgent } from '../../src/index.js'
import type { AgentConfig, OrchestratorEvent } from '../../src/types.js'

// ---------------------------------------------------------------------------
// Topic
// ---------------------------------------------------------------------------

const TOPIC = 'WebAssembly adoption in 2026'

// ---------------------------------------------------------------------------
// Agents — three analysts + one synthesizer
// ---------------------------------------------------------------------------

const technicalAnalyst: AgentConfig = {
  name: 'technical-analyst',
  model: 'claude-sonnet-4-6',
  systemPrompt: `You are a technical analyst. Given a topic, research its technical
capabilities, limitations, performance characteristics, and architectural patterns.
Write your findings as structured markdown. Keep it to 200-300 words.`,
  maxTurns: 2,
}

const marketAnalyst: AgentConfig = {
  name: 'market-analyst',
  model: 'claude-sonnet-4-6',
  systemPrompt: `You are a market analyst. Given a topic, research industry adoption
rates, key companies using the technology, market size estimates, and competitive
landscape. Write your findings as structured markdown. Keep it to 200-300 words.`,
  maxTurns: 2,
}

const communityAnalyst: AgentConfig = {
  name: 'community-analyst',
  model: 'claude-sonnet-4-6',
  systemPrompt: `You are a developer community analyst. Given a topic, research
developer sentiment, ecosystem maturity, learning resources, community size,
and conference/meetup activity. Write your findings as structured markdown.
Keep it to 200-300 words.`,
  maxTurns: 2,
}

const synthesizer: AgentConfig = {
  name: 'synthesizer',
  model: 'claude-sonnet-4-6',
  systemPrompt: `You are a research director who synthesizes multiple analyst reports
into a single cohesive document. You will receive all prior analyst outputs
automatically. Then:

1. Cross-reference claims across reports - flag agreements and contradictions
2. Identify the 3 most important insights
3. Produce a structured report with: Executive Summary, Key Findings,
   Areas of Agreement, Open Questions, and Recommendation

Keep the final report to 300-400 words.`,
  maxTurns: 2,
}

// ---------------------------------------------------------------------------
// Orchestrator + team
// ---------------------------------------------------------------------------

function handleProgress(event: OrchestratorEvent): void {
  if (event.type === 'task_start') {
    console.log(`  [START] ${event.task ?? ''} → ${event.agent ?? ''}`)
  }
  if (event.type === 'task_complete') {
    console.log(`  [DONE]  ${event.task ?? ''}`)
  }
}

const orchestrator = new OpenMultiAgent({
  defaultModel: 'claude-sonnet-4-6',
  onProgress: handleProgress,
})

const team = orchestrator.createTeam('research-team', {
  name: 'research-team',
  agents: [technicalAnalyst, marketAnalyst, communityAnalyst, synthesizer],
  sharedMemory: true,
})

// ---------------------------------------------------------------------------
// Tasks — three analysts run in parallel, synthesizer depends on all three
// ---------------------------------------------------------------------------

const tasks = [
  {
    title: 'Technical analysis',
    description: `Research the technical aspects of ${TOPIC}. Focus on capabilities, limitations, performance, and architecture.`,
    assignee: 'technical-analyst',
  },
  {
    title: 'Market analysis',
    description: `Research the market landscape for ${TOPIC}. Focus on adoption rates, key players, market size, and competition.`,
    assignee: 'market-analyst',
  },
  {
    title: 'Community analysis',
    description: `Research the developer community around ${TOPIC}. Focus on sentiment, ecosystem maturity, learning resources, and community activity.`,
    assignee: 'community-analyst',
  },
  {
    title: 'Synthesize report',
    description: `Cross-reference all analyst findings, identify key insights, flag contradictions, and produce a unified research report.`,
    assignee: 'synthesizer',
    dependsOn: ['Technical analysis', 'Market analysis', 'Community analysis'],
  },
]

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log('Multi-Source Research Aggregation')
console.log('='.repeat(60))
console.log(`Topic: ${TOPIC}`)
console.log('Pipeline: 3 analysts (parallel) → synthesizer')
console.log('='.repeat(60))
console.log()

const result = await orchestrator.runTasks(team, tasks)

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

console.log('\n' + '='.repeat(60))
console.log(`Overall success: ${result.success}`)
console.log(`Tokens — input: ${result.totalTokenUsage.input_tokens}, output: ${result.totalTokenUsage.output_tokens}`)
console.log()

for (const [name, r] of result.agentResults) {
  const icon = r.success ? 'OK  ' : 'FAIL'
  const tokens = `in:${r.tokenUsage.input_tokens} out:${r.tokenUsage.output_tokens}`
  console.log(`  [${icon}] ${name.padEnd(20)} ${tokens}`)
}

const synthResult = result.agentResults.get('synthesizer')
if (synthResult?.success) {
  console.log('\n' + '='.repeat(60))
  console.log('SYNTHESIZED REPORT')
  console.log('='.repeat(60))
  console.log()
  console.log(synthResult.output)
}

console.log('\nDone.')
