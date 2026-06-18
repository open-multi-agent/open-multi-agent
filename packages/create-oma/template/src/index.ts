/**
 * Multi-agent demo — one goal, automatically decomposed into a task DAG.
 *
 * The OpenMultiAgent coordinator reads the goal below, breaks it into tasks,
 * assigns them to the right agents, and runs them in parallel and in dependency
 * order. When the run finishes, a dashboard of the DAG opens in your browser.
 *
 * These agents use NO tools — pure reasoning — so the first run is fast and
 * works on any OpenAI-compatible model. To watch agents use tools (read/write
 * files, run commands, call MCP servers), give an agent a `tools` array; see
 * the examples linked in the README.
 *
 * Run:  npm run dev
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { OpenMultiAgent, renderTeamRunDashboard } from '@open-multi-agent/core'
import type { AgentConfig, OrchestratorEvent } from '@open-multi-agent/core'

// --- Minimal .env loader ----------------------------------------------------
// Reads .env into process.env so `npm run dev` works right after
// `cp .env.example .env`. Inlined to keep the project at ONE runtime
// dependency (no dotenv). Existing env vars win.
function loadEnv(path = '.env'): void {
  if (!existsSync(path)) return
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    if (key && !(key in process.env)) process.env[key] = val
  }
}
loadEnv()

// --- Provider (OpenAI-compatible, env-driven) -------------------------------
// OPENAI_API_KEY is read automatically by the OpenAI client. For another
// provider, set OPENAI_BASE_URL + OMA_MODEL in .env (DeepSeek, Groq, Ollama…).
const model = process.env.OMA_MODEL ?? 'gpt-5.4'

if (!process.env.OPENAI_API_KEY) {
  console.error(
    '\n  Missing OPENAI_API_KEY.\n\n' +
      '  1. cp .env.example .env\n' +
      '  2. add a key — OpenAI, or any OpenAI-compatible provider\n' +
      '     (DeepSeek, Groq, Ollama, …; see .env.example)\n',
  )
  process.exit(1)
}

// --- The team: four specialists, no tools, pure reasoning -------------------
const strategist: AgentConfig = {
  name: 'strategist',
  model,
  systemPrompt: `You define sharp, outcome-focused goals.
Given a brief, name the few outcomes that matter most. Concrete bullet points, no filler.`,
  maxTurns: 1,
  temperature: 0.3,
}

const planner: AgentConfig = {
  name: 'planner',
  model,
  systemPrompt: `You turn outcomes into a concrete, time-boxed plan.
Produce clear weekly milestones — each a short, checkable line. No filler.`,
  maxTurns: 1,
  temperature: 0.2,
}

const riskAnalyst: AgentConfig = {
  name: 'risk-analyst',
  model,
  systemPrompt: `You stress-test plans.
Name the few highest-impact risks and give one concrete, specific mitigation for each.`,
  maxTurns: 1,
  temperature: 0.4,
}

const synthesizer: AgentConfig = {
  name: 'synthesizer',
  model,
  systemPrompt: `You assemble the team's work into one clean deliverable.
Merge the outcomes, weekly plan, and risk mitigations into a single concise document
a manager could hand over directly. Use short markdown headings.`,
  maxTurns: 1,
  temperature: 0.2,
}

// --- Live progress: watch the DAG run ---------------------------------------
function onProgress(event: OrchestratorEvent): void {
  switch (event.type) {
    case 'task_start':
      if (event.agent) console.log(`  ▶ ${event.agent} working…`)
      break
    case 'task_complete':
      if (event.agent) console.log(`  ✓ ${event.agent} done`)
      break
    case 'error':
      console.error(`  ✗ ${event.agent ?? 'run'} failed`)
      break
  }
}

/** Best-effort open in the default browser; prints the path if it can't. */
function openInBrowser(file: string): void {
  // pathToFileURL handles drive letters, slashes, and spaces on every OS —
  // a hand-built `file://` string breaks on Windows paths.
  const url = pathToFileURL(resolve(file)).href
  const fallback = (): void => console.log(`  Open it manually: ${url}`)
  try {
    // On Windows the opener is cmd's `start`, whose first quoted arg is the
    // window title — pass an empty title ("") so the URL isn't swallowed.
    const child =
      process.platform === 'win32'
        ? spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true })
        : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true })
    child.on('error', fallback)
    child.unref()
  } catch {
    fallback()
  }
}

const orchestrator = new OpenMultiAgent({
  defaultProvider: 'openai',
  defaultModel: model,
  defaultBaseURL: process.env.OPENAI_BASE_URL, // unset = OpenAI
  onProgress,
})

const team = orchestrator.createTeam('demo-team', {
  name: 'demo-team',
  agents: [strategist, planner, riskAnalyst, synthesizer],
  sharedMemory: true,
})

// --- The goal: multi-step, so the coordinator MUST decompose it -------------
// Kept well over 200 characters so it never hits the single-agent
// short-circuit — that is what guarantees you see a multi-agent DAG, not one
// agent. (create-oma's tests assert this length.)
const goal = `Design a 30-day onboarding plan for a software engineer joining a fast-moving startup.
Step 1: identify the 4 outcomes the new hire should reach by day 30.
Step 2: turn those outcomes into concrete weekly milestones for weeks 1 through 4.
Step 3: list the 3 risks most likely to derail onboarding, each with a specific mitigation.
Step 4: synthesize everything into one concise plan a manager could hand over on day one.`

console.log(`\n  Goal: ${goal.split('\n')[0]}\n`)
console.log('  The coordinator is decomposing the goal into a task DAG:\n')

const result = await orchestrator.runTeam(team, goal)

// --- Summary: the DAG the coordinator built from one goal -------------------
const line = '─'.repeat(52)
console.log(`\n  ${line}`)
console.log(`  Run complete — success: ${result.success}`)
console.log(`  Tokens: ${result.totalTokenUsage.input_tokens} in / ${result.totalTokenUsage.output_tokens} out`)
console.log('\n  Task DAG (auto-decomposed — you wrote none of this wiring):')
for (const task of result.tasks ?? []) {
  console.log(`    • ${task.title}  [${task.assignee ?? '—'}] ${task.status}`)
}

// --- Final plan: the synthesizer merged the team's work into one document ---
const plan = result.agentResults.get('synthesizer')
if (plan?.success && plan.output.trim()) {
  console.log(`\n  Final plan (by synthesizer):\n  ${line}`)
  console.log(plan.output)
}

// --- Dashboard: render the DAG and open it ----------------------------------
const dashboardPath = 'dashboard.html'
writeFileSync(dashboardPath, renderTeamRunDashboard(result))
console.log(`\n  ${line}`)
console.log(`  DAG dashboard → ${dashboardPath} (opening in your browser…)`)
openInBrowser(dashboardPath)
