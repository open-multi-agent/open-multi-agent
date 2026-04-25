/**
 * Learning Assistant (Education Planning with Multi-Agent Teamwork)
 *
 * Demonstrates:
 * - A practical education-domain use case built with `runTeam()`
 * - Three specialized agents collaborating on the same learning goal
 * - Shared memory between agents so later steps can build on earlier outputs
 * - A readable terminal trace of team progress and final recommendations
 *
 * Run:
 *   npx tsx examples/cookbook/learning-assistant.ts
 *
 * Prerequisites:
 *   ANTHROPIC_API_KEY env var must be set.
 */

import { OpenMultiAgent } from '../../src/index.js'
import type { AgentConfig, OrchestratorEvent } from '../../src/types.js'

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
  maxTurns: 4,
  temperature: 0.2,
}

const resourceCurator: AgentConfig = {
  name: 'resource-curator',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: `You are an education curator for software learners.
Recommend a small, high-quality set of resources for beginners: official docs, tutorials, exercises, and project ideas.
Prefer focused recommendations over long lists. Write concise markdown.`,
  maxTurns: 4,
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
  maxTurns: 4,
  temperature: 0.3,
}

// ---------------------------------------------------------------------------
// Progress tracking
// ---------------------------------------------------------------------------

const startTimes = new Map<string, number>()

function handleProgress(event: OrchestratorEvent): void {
  const ts = new Date().toISOString().slice(11, 23)

  switch (event.type) {
    case 'agent_start':
      startTimes.set(event.agent ?? '', Date.now())
      console.log(`[${ts}] AGENT START  -> ${event.agent}`)
      break

    case 'agent_complete': {
      const elapsed = Date.now() - (startTimes.get(event.agent ?? '') ?? Date.now())
      console.log(`[${ts}] AGENT DONE   <- ${event.agent} (${elapsed}ms)`)
      break
    }

    case 'task_start':
      console.log(`[${ts}] TASK START   :: ${event.task}`)
      break

    case 'task_complete':
      console.log(`[${ts}] TASK DONE    :: ${event.task}`)
      break

    case 'message':
      console.log(`[${ts}] MESSAGE      :: ${event.agent} shared an update`)
      break

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
  sharedMemory: true,
  maxConcurrency: 1,
})

console.log(`Team "${team.name}" created with agents: ${team.getAgents().map(a => a.name).join(', ')}`)
console.log('\nStarting learning assistant run...\n')
console.log('='.repeat(60))

const goal = `Create a beginner-friendly learning plan for this learner:
"I want to learn React."

The final answer should help a beginner understand:
- A staged learning roadmap
- The best starter resources
- A step-by-step practice plan for the first few weeks

Assume the learner knows basic JavaScript but has not built with React before.
Keep the advice practical, realistic, and easy to follow.`

const result = await orchestrator.runTeam(team, goal)

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
  console.log(`  ${agentName.padEnd(18)} [${status}]  tool_calls=${agentResult.toolCalls.length}`)
  if (!agentResult.success) {
    console.log(`    Error: ${agentResult.output.slice(0, 120)}`)
  }
}

console.log('\nFinal learning plan:')
console.log('-'.repeat(60))
console.log(result.output)
console.log('-'.repeat(60))
