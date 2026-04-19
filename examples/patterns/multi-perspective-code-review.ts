/**
 * Multi-Perspective Code Review
 *
 * Demonstrates:
 * - Dependency chain: generator produces code, three reviewers depend on it
 * - Parallel execution: security, performance, and style reviewers run concurrently
 * - Shared memory: each agent's output is automatically stored and injected
 *   into downstream agents' prompts by the framework
 *
 * Flow:
 *   generator → [security-reviewer, performance-reviewer, style-reviewer] (parallel) → synthesizer
 *
 * Run:
 *   npx tsx examples/patterns/multi-perspective-code-review.ts
 *
 * Prerequisites:
 *   ANTHROPIC_API_KEY env var must be set.
 */

import { OpenMultiAgent } from '../../src/index.js'
import type { AgentConfig, OrchestratorEvent } from '../../src/types.js'

// ---------------------------------------------------------------------------
// API spec to implement
// ---------------------------------------------------------------------------

const API_SPEC = `POST /users endpoint that:
- Accepts JSON body with name (string, required), email (string, required), age (number, optional)
- Validates all fields
- Inserts into a PostgreSQL database
- Returns 201 with the created user or 400/500 on error`

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

const generator: AgentConfig = {
  name: 'generator',
  model: 'claude-sonnet-4-6',
  systemPrompt: `You are a Node.js backend developer. Given an API spec, write a complete
Express route handler. Include imports, validation, database query, and error handling.
Output only the code, no explanation. Keep it under 80 lines.`,
  maxTurns: 2,
}

const securityReviewer: AgentConfig = {
  name: 'security-reviewer',
  model: 'claude-sonnet-4-6',
  systemPrompt: `You are a security reviewer. Review the code provided in context and check
for OWASP top 10 vulnerabilities: SQL injection, XSS, broken authentication,
sensitive data exposure, etc. Write your findings as a markdown checklist.
Keep it to 150-200 words.`,
  maxTurns: 2,
}

const performanceReviewer: AgentConfig = {
  name: 'performance-reviewer',
  model: 'claude-sonnet-4-6',
  systemPrompt: `You are a performance reviewer. Review the code provided in context and check
for N+1 queries, memory leaks, blocking calls, missing connection pooling, and
inefficient patterns. Write your findings as a markdown checklist.
Keep it to 150-200 words.`,
  maxTurns: 2,
}

const styleReviewer: AgentConfig = {
  name: 'style-reviewer',
  model: 'claude-sonnet-4-6',
  systemPrompt: `You are a code style reviewer. Review the code provided in context and check
naming conventions, function structure, readability, error message clarity, and
consistency. Write your findings as a markdown checklist.
Keep it to 150-200 words.`,
  maxTurns: 2,
}

const synthesizer: AgentConfig = {
  name: 'synthesizer',
  model: 'claude-sonnet-4-6',
  systemPrompt: `You are a lead engineer synthesizing code review feedback. Review all
the feedback and original code provided in context. Produce a unified report with:

1. Critical issues (must fix before merge)
2. Recommended improvements (should fix)
3. Minor suggestions (nice to have)

Deduplicate overlapping feedback. Keep the report to 200-300 words.`,
  maxTurns: 2,
}

// ---------------------------------------------------------------------------
// Orchestrator + team
// ---------------------------------------------------------------------------

function handleProgress(event: OrchestratorEvent): void {
  if (event.type === 'task_start') {
    console.log(`  [START] ${event.task ?? '?'} → ${event.agent ?? '?'}`)
  }
  if (event.type === 'task_complete') {
    const success = (event.data as { success?: boolean })?.success ?? true
    console.log(`  [DONE]  ${event.task ?? '?'} (${success ? 'OK' : 'FAIL'})`)
  }
}

const orchestrator = new OpenMultiAgent({
  defaultModel: 'claude-sonnet-4-6',
  onProgress: handleProgress,
})

const team = orchestrator.createTeam('code-review-team', {
  name: 'code-review-team',
  agents: [generator, securityReviewer, performanceReviewer, styleReviewer, synthesizer],
  sharedMemory: true,
})

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

const tasks = [
  {
    title: 'Generate code',
    description: `Write a Node.js Express route handler for this API spec:\n\n${API_SPEC}`,
    assignee: 'generator',
  },
  {
    title: 'Security review',
    description: 'Review the generated code for security vulnerabilities.',
    assignee: 'security-reviewer',
    dependsOn: ['Generate code'],
  },
  {
    title: 'Performance review',
    description: 'Review the generated code for performance issues.',
    assignee: 'performance-reviewer',
    dependsOn: ['Generate code'],
  },
  {
    title: 'Style review',
    description: 'Review the generated code for style and readability.',
    assignee: 'style-reviewer',
    dependsOn: ['Generate code'],
  },
  {
    title: 'Synthesize feedback',
    description: 'Synthesize all review feedback and the original code into a unified, prioritized action item report.',
    assignee: 'synthesizer',
    dependsOn: ['Security review', 'Performance review', 'Style review'],
  },
]

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log('Multi-Perspective Code Review')
console.log('='.repeat(60))
console.log(`Spec: ${API_SPEC.split('\n')[0]}`)
console.log('Pipeline: generator → 3 reviewers (parallel) → synthesizer')
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
  console.log(`  [${icon}] ${name.padEnd(22)} ${tokens}`)
}

const synthResult = result.agentResults.get('synthesizer')
if (synthResult?.success) {
  console.log('\n' + '='.repeat(60))
  console.log('UNIFIED REVIEW REPORT')
  console.log('='.repeat(60))
  console.log()
  console.log(synthResult.output)
}

console.log('\nDone.')
