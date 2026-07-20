import { OpenMultiAgent } from '@open-multi-agent/core'
import type { AgentConfig, OrchestratorEvent } from '@open-multi-agent/core'
import { createDemoAdapter, DEMO_MODEL, DEMO_NOTICE, messageText } from './demo-adapter.js'
import { openDashboard, writeDashboard } from './report.js'
import { resolveRuntime } from './runtime.js'

const demoMode = process.argv.includes('--demo')
const runtime = demoMode ? undefined : await resolveRuntime()

const demoOutputs: Readonly<Record<string, string>> = {
  strategist: '- Ship one meaningful change independently\n- Explain the product architecture\n- Build working relationships with the team\n- Agree on the next 60-day growth goal',
  planner: 'Week 1: environment and architecture walkthrough.\nWeek 2: pair on a small fix.\nWeek 3: own and ship a scoped change.\nWeek 4: review outcomes and write the next plan.',
  'risk-analyst': '- Setup access delay → preflight accounts before day one.\n- Unclear ownership → assign one onboarding owner.\n- Too much passive reading → require a small shipped change by week three.',
  synthesizer: '# 30-day onboarding plan\n\n## Outcomes\nShip independently, understand the architecture, build team context, and define the next growth goal.\n\n## Milestones\nMove from setup to pairing to an owned production change across four weeks.\n\n## Risks\nPreflight access, assign one owner, and bias toward hands-on delivery.',
}

const agent = (name: string, systemPrompt: string, temperature: number): AgentConfig => {
  const common = { name, systemPrompt, maxTurns: 1, temperature }
  if (demoMode) {
    return {
      ...common,
      model: DEMO_MODEL,
      adapter: createDemoAdapter(name, demoOutputs[name] ?? 'Demo task completed.'),
    }
  }
  return {
    ...common,
    model: runtime!.model,
    provider: 'openai',
    baseURL: runtime!.baseURL,
    apiKey: runtime!.apiKey,
  }
}

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
  defaultModel: demoMode ? DEMO_MODEL : runtime!.model,
  ...(runtime ? { defaultBaseURL: runtime.baseURL, defaultApiKey: runtime.apiKey } : {}),
  onProgress,
})
const team = orchestrator.createTeam('demo-team', { name: 'demo-team', agents, sharedMemory: true })
const goal = `Design a 30-day onboarding plan for a software engineer joining a fast-moving startup.
Step 1: identify the four outcomes the new hire should reach by day 30.
Step 2: turn those outcomes into weekly milestones for weeks one through four.
Step 3: list the three risks most likely to derail onboarding, each with a mitigation.
Step 4: synthesize everything into one concise plan a manager can hand over on day one.`

console.log(`\nRuntime: ${demoMode ? `demo / ${DEMO_MODEL}` : `${runtime!.runtime} / ${runtime!.model}`}`)
if (demoMode) console.log(`${DEMO_NOTICE}\n`)

const coordinatorAdapter = createDemoAdapter('coordinator', (messages) => {
  const prompt = messageText(messages)
  if (prompt.includes('Decompose the following goal')) {
    return JSON.stringify([
      { title: 'Define day-30 outcomes', description: 'Define four concrete onboarding outcomes.', assignee: 'strategist', dependsOn: [] },
      { title: 'Plan weekly milestones', description: 'Turn the outcomes into four weekly milestones.', assignee: 'planner', dependsOn: ['Define day-30 outcomes'] },
      { title: 'Assess onboarding risks', description: 'Identify the three highest-impact risks and mitigations.', assignee: 'risk-analyst', dependsOn: ['Define day-30 outcomes'] },
      { title: 'Synthesize the plan', description: 'Merge outcomes, milestones, and risks into one manager-ready plan.', assignee: 'synthesizer', dependsOn: ['Plan weekly milestones', 'Assess onboarding risks'] },
    ])
  }
  return demoOutputs.synthesizer!
})

const result = await orchestrator.runTeam(
  team,
  goal,
  demoMode ? { coordinator: { model: DEMO_MODEL, adapter: coordinatorAdapter } } : undefined,
)
const output = result.agentResults.get('synthesizer')?.output ?? 'No synthesis was produced.'
console.log(`\n${output}`)
const dashboard = writeDashboard('dashboard.html', result, demoMode ? 'demo' : 'live')
console.log(`\nDAG dashboard → ${dashboard}`)
if (demoMode) openDashboard(dashboard)
