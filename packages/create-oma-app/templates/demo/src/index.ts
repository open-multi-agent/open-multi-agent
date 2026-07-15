import { writeFileSync } from 'node:fs'
import { OpenMultiAgent, renderTeamRunDashboard } from '@open-multi-agent/core'
import type { AgentConfig, OrchestratorEvent } from '@open-multi-agent/core'
import { resolveRuntime } from './runtime.js'

const runtime = await resolveRuntime()
const agent = (name: string, systemPrompt: string, temperature: number): AgentConfig => ({
  name,
  model: runtime.model,
  provider: 'openai',
  baseURL: runtime.baseURL,
  apiKey: runtime.apiKey,
  systemPrompt,
  maxTurns: 1,
  temperature,
})

const agents = [
  agent('strategist', 'Define sharp, outcome-focused goals. Use concrete bullets and no filler.', 0.3),
  agent('planner', 'Turn outcomes into a concrete four-week plan with checkable milestones.', 0.2),
  agent('risk-analyst', 'Name the highest-impact risks and one specific mitigation for each.', 0.4),
  agent('synthesizer', 'Merge team output into one concise manager-ready markdown document.', 0.2),
]

const onProgress = (event: OrchestratorEvent): void => {
  if (event.type === 'task_start' && event.agent) console.log(`  ▶ ${event.agent} working…`)
  if (event.type === 'task_complete' && event.agent) console.log(`  ✓ ${event.agent} done`)
}

const orchestrator = new OpenMultiAgent({
  defaultProvider: 'openai',
  defaultModel: runtime.model,
  defaultBaseURL: runtime.baseURL,
  defaultApiKey: runtime.apiKey,
  onProgress,
})
const team = orchestrator.createTeam('demo-team', { name: 'demo-team', agents, sharedMemory: true })
const goal = `Design a 30-day onboarding plan for a software engineer joining a fast-moving startup.
Step 1: identify the four outcomes the new hire should reach by day 30.
Step 2: turn those outcomes into weekly milestones for weeks one through four.
Step 3: list the three risks most likely to derail onboarding, each with a mitigation.
Step 4: synthesize everything into one concise plan a manager can hand over on day one.`

console.log(`\nRuntime: ${runtime.runtime} / ${runtime.model}`)
const result = await orchestrator.runTeam(team, goal)
const output = result.agentResults.get('synthesizer')?.output ?? 'No synthesis was produced.'
console.log(`\n${output}`)
writeFileSync('dashboard.html', renderTeamRunDashboard(result))
console.log('\nDAG dashboard → dashboard.html')
