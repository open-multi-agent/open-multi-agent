/**
 * Learning Assistant (Education Planning with Multi-Agent Teamwork)
 *
 * Demonstrates:
 * - A practical education-domain use case built with `runTasks()`
 * - Three specialized agents collaborating through an explicit task pipeline
 * - Dependency-scoped context so the final plan can build on earlier outputs
 * - A readable terminal trace of task progress and final recommendations
 *
 * Run:
 *   npx tsx examples/cookbook/learning-assistant.ts
 *
 * Prerequisites:
 *   ANTHROPIC_API_KEY env var must be set.
 */

import { OpenMultiAgent } from '../../src/index.js'
import type { AgentConfig, OrchestratorEvent, Task } from '../../src/types.js'

const AGENT_TIMEOUT_MS = 60_000
const TASK_LABELS = new Map<string, string>([
  ['Design React learning roadmap', 'Step 1/3 - Learning Roadmap'],
  ['Curate React starter resources', 'Step 2/3 - Recommended Resources'],
  ['Build step-by-step React study plan', 'Step 3/3 - 4-Week Study Plan'],
])

// ---------------------------------------------------------------------------
// Agent definitions
// ---------------------------------------------------------------------------

const roadmapPlanner: AgentConfig = {
  name: 'roadmap-planner',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: `You are a learning strategist who designs beginner-friendly technical learning roadmaps.
Break goals into clear stages, call out prerequisites, and define what "done" looks like for each stage.
Write concise markdown that is practical and encouraging.`,
  tools: [],
  maxTurns: 4,
  timeoutMs: AGENT_TIMEOUT_MS,
  temperature: 0.2,
}

const resourceCurator: AgentConfig = {
  name: 'resource-curator',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: `You are an education curator for software learners.
Recommend a small, high-quality set of resources for beginners: official docs, tutorials, exercises, and project ideas.
Prefer focused recommendations over long lists. Write concise markdown.`,
  tools: [],
  maxTurns: 4,
  timeoutMs: AGENT_TIMEOUT_MS,
  temperature: 0.2,
}

const practiceCoach: AgentConfig = {
  name: 'practice-coach',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: `You are a technical learning coach.
Turn a learning goal into a step-by-step practice plan with a realistic weekly cadence.
Include milestones, suggested mini-projects, and advice on how to know when the learner is ready to move on.
Write concise markdown.`,
  tools: [],
  maxTurns: 4,
  timeoutMs: AGENT_TIMEOUT_MS,
  temperature: 0.3,
}

// ---------------------------------------------------------------------------
// Progress tracking
// ---------------------------------------------------------------------------

const taskTimes = new Map<string, number>()
const taskLabelsById = new Map<string, string>()

function handleProgress(event: OrchestratorEvent): void {
  const ts = new Date().toISOString().slice(11, 23)

  switch (event.type) {
    case 'task_start': {
      taskTimes.set(event.task ?? '', Date.now())
      const task = event.data as Task | undefined
      const title = task?.title ?? event.task ?? 'Unknown task'
      const label = TASK_LABELS.get(title) ?? title
      if (event.task) {
        taskLabelsById.set(event.task, label)
      }
      console.log(`[${ts}] START        :: ${label}`)
      break
    }
    case 'task_complete': {
      const elapsed = Date.now() - (taskTimes.get(event.task ?? '') ?? Date.now())
      const label = (event.task ? taskLabelsById.get(event.task) : undefined) ?? event.task ?? 'Unknown task'
      console.log(`[${ts}] DONE         :: ${label} (${elapsed}ms)`)
      break
    }
    case 'error':
      console.error(`[${ts}] ERROR        :: agent=${event.agent} task=${event.task}`)
      if (event.data instanceof Error) {
        console.error(`               ${event.data.message}`)
      }
      break
  }
}

// ---------------------------------------------------------------------------
// Team execution
// ---------------------------------------------------------------------------

const orchestrator = new OpenMultiAgent({
  defaultModel: 'claude-sonnet-4-6',
  maxConcurrency: 1,
  onProgress: handleProgress,
})

const team = orchestrator.createTeam('learning-team', {
  name: 'learning-team',
  agents: [roadmapPlanner, resourceCurator, practiceCoach],
  maxConcurrency: 1,
})

console.log(`Team "${team.name}" created with agents: ${team.getAgents().map(a => a.name).join(', ')}`)
console.log('\nStarting learning assistant run...\n')
console.log('='.repeat(60))

const learnerGoal = `I want to learn React.`

const tasks: Array<{
  title: string
  description: string
  assignee?: string
  dependsOn?: string[]
}> = [
  {
    title: 'Design React learning roadmap',
    description: `The learner's goal is: "${learnerGoal}"

Create a beginner-friendly React learning roadmap in markdown.
Requirements:
- Assume the learner knows basic JavaScript but is new to React
- Break the roadmap into 3-4 stages
- For each stage, include the goal, key topics, and a simple milestone
- Keep the roadmap practical and easy to follow`,
    assignee: 'roadmap-planner',
  },
  {
    title: 'Curate React starter resources',
    description: `The learner's goal is: "${learnerGoal}"

Recommend a focused set of starter resources in markdown.
Requirements:
- Include official documentation, one beginner tutorial, one practice source, and 2 mini-project ideas
- Prefer a short, high-quality list over a long directory
- Explain in one sentence why each resource is worth the learner's time`,
    assignee: 'resource-curator',
  },
  {
    title: 'Build step-by-step React study plan',
    description: `Create the final learner-facing study plan in markdown.
Use the prerequisite task outputs to produce one cohesive answer.

Required sections:
- ## Learning Roadmap
- ## Recommended Resources
- ## 4-Week Practice Plan
- ## Progress Checks

The 4-week plan should be realistic for a beginner studying a few times per week.
Make the final answer practical, encouraging, and easy to act on.`,
    assignee: 'practice-coach',
    dependsOn: ['Design React learning roadmap', 'Curate React starter resources'],
  },
]

const result = await orchestrator.runTasks(team, tasks)

console.log('\n' + '='.repeat(60))

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

console.log('\nLearning assistant run complete.')
console.log(`Success: ${result.success}`)
console.log(
  `Total tokens - input: ${result.totalTokenUsage.input_tokens}, output: ${result.totalTokenUsage.output_tokens}`,
)

console.log('\nPer-agent results:')
for (const [agentName, agentResult] of result.agentResults) {
  const status = agentResult.success ? 'OK' : 'FAILED'
  console.log(
    `  ${agentName.padEnd(18)} [${status}]  tokens=${agentResult.tokenUsage.input_tokens}/${agentResult.tokenUsage.output_tokens}  tool_calls=${agentResult.toolCalls.length}`,
  )
  if (!agentResult.success) {
    console.log(`    Error: ${agentResult.output.slice(0, 120)}`)
  }
}

const finalPlan = result.agentResults.get('practice-coach')
if (finalPlan?.success) {
  console.log('\nFinal learning plan:')
  console.log('-'.repeat(60))
  console.log(finalPlan.output)
  console.log('-'.repeat(60))
}
