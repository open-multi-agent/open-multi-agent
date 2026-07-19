/**
 * README hero-run capture
 *
 * Runs a real DeepSeek team (5 agents with tools) through `runTeam()` while a
 * `DashboardTraceCaptureSink` records the full trace, then writes the combined
 * Run Viewer HTML plus the raw materials needed to re-render it later without
 * spending API credits again.
 *
 * Run (one invocation = one candidate run):
 *   DEEPSEEK_API_KEY=... npx tsx .github/brand/capture-hero-run.mts
 *
 * Outputs, per run, under the gitignored .github/brand/frames/hero-runs/<ts>/:
 *   traces.ndjson  — full trace records (FileTraceStore format)
 *   result.json    — serialized TeamRunResult (no message payloads)
 *   viewer.html    — renderRunViewer({ result, run }) combined snapshot
 *   report.json    — selection metrics (see SELECTION REPORT below)
 *
 * The selected run's viewer.html is copied to .github/brand/run-viewer-hero.html
 * and recorded into the README GIF by record-readme-hero-gif.mjs.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { OpenMultiAgent } from '../../packages/core/src/index.js'
import {
  DashboardTraceCaptureSink,
  renderCapturedRunDashboard,
  serializeTeamRunResult,
} from '../../packages/core/src/cli/oma.js'
import { FileTraceStore } from '../../packages/core/src/observability/file-store.js'
import type { TraceRecord } from '../../packages/core/src/observability/records.js'
import type { AgentConfig, OrchestratorEvent } from '../../packages/core/src/types.js'

const MAX_TITLE_CHARS = 28

// DeepSeek published list prices in USD per token (api-docs.deepseek.com/quick_start/pricing),
// using the standard cache-miss input rate. OMA ships no price table by design — callers own
// provider pricing — so this hero capture (the caller) prices its own usage and injects it onto
// each LLM span below, lighting up the viewer's Cost metric, per-span cost, and per-task cost
// roll-up with honest numbers instead of "Not recorded".
const DEEPSEEK_PRICE_PER_TOKEN: Readonly<Record<string, { input: number; output: number }>> = {
  'deepseek-v4-flash': { input: 0.14 / 1e6, output: 0.28 / 1e6 },
  'deepseek-v4-pro': { input: 0.435 / 1e6, output: 0.87 / 1e6 },
}
const MODEL_ATTR_KEYS = ['oma.llm.model', 'oma.model', 'gen_ai.request.model', 'gen_ai.response.model']
const INPUT_TOKEN_ATTR_KEYS = ['oma.usage.input_tokens', 'gen_ai.usage.input_tokens']
const OUTPUT_TOKEN_ATTR_KEYS = ['oma.usage.output_tokens', 'gen_ai.usage.output_tokens']

function firstStringAttr(attributes: Readonly<Record<string, unknown>>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = attributes[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}
function firstNumberAttr(attributes: Readonly<Record<string, unknown>>, keys: readonly string[]): number {
  for (const key of keys) {
    const value = attributes[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return 0
}

/** Attach real USD cost to each LLM span from published DeepSeek rates. */
function withInjectedCost(records: readonly TraceRecord[]): TraceRecord[] {
  return records.map((record) => {
    if (record.recordType !== 'span_end' || record.kind !== 'llm') return record
    const model = firstStringAttr(record.attributes, MODEL_ATTR_KEYS)
    const price = model ? DEEPSEEK_PRICE_PER_TOKEN[model] : undefined
    if (!price) return record
    const amount = firstNumberAttr(record.attributes, INPUT_TOKEN_ATTR_KEYS) * price.input
      + firstNumberAttr(record.attributes, OUTPUT_TOKEN_ATTR_KEYS) * price.output
    if (!(amount > 0)) return record
    return {
      ...record,
      attributes: { ...record.attributes, 'oma.cost.amount': amount, 'oma.cost.currency': 'USD' },
    }
  })
}

if (!process.env['DEEPSEEK_API_KEY']) {
  console.error('DEEPSEEK_API_KEY environment variable must be set.')
  process.exit(2)
}

// One directory per invocation; everything inside is gitignored via frames/.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const runDir = join(SCRIPT_DIR, 'frames', 'hero-runs', new Date().toISOString().replace(/[:.]/g, '-'))
mkdirSync(runDir, { recursive: true })
// Keep the agents' bash cwd and the filesystem-tool sandbox (<cwd>/.agent-workspace)
// inside the gitignored run directory.
process.chdir(runDir)

// ---------------------------------------------------------------------------
// Agent definitions — parallel branch needs distinct assignees (per-agent mutex)
// ---------------------------------------------------------------------------
// Built-in filesystem tools require absolute paths resolved inside the
// <cwd>/.agent-workspace sandbox (same reason examples/providers/deepseek.ts
// embeds an absolute OUTPUT_DIR in its goal). Any tool rejection embeds the
// local sandbox path in the error, which would leak into the committed viewer
// snapshot and paint red error spans in the hero waterfall — so the prompts
// spell the exact directory out and keep bash down to `node --check`.
const OUTPUT_DIR = join(runDir, '.agent-workspace', 'hero-api')
const PATH_RULE = `Filesystem tools require absolute paths: every file you read or write lives
under ${OUTPUT_DIR}/ (e.g. ${OUTPUT_DIR}/auth.js). Do not install packages, start servers, or make
network calls. Never execute code and never run a test — the ONLY bash command permitted is
\`node --check <absolute file path>\` to confirm a file you just wrote parses (never \`node <file>\`
without --check, never run the test script, never any other command).`

const architect: AgentConfig = {
  name: 'architect',
  model: 'deepseek-v4-pro',
  provider: 'deepseek',
  systemPrompt: `You are a security-minded software architect. Design a small JWT (HS256)
authentication module built only on Node's built-in \`crypto\` (no external packages). Write the
contract — the sign/verify signatures, error types, and token/claim format — to
${OUTPUT_DIR}/CONTRACT.md with file_write so the implementer, tester, and security reviewer can
all work from it. Be concise. Do not write code or run any command.
${PATH_RULE}`,
  tools: ['file_write'],
  maxTurns: 5,
  temperature: 0.2,
}

const backendDev: AgentConfig = {
  name: 'backend-dev',
  model: 'deepseek-v4-flash',
  provider: 'deepseek',
  systemPrompt: `You are a Node.js developer. Read the contract at ${OUTPUT_DIR}/CONTRACT.md, then
implement the JWT sign/verify module using only Node's built-in \`crypto\` (no external packages).
Write it to ${OUTPUT_DIR}/auth.js with clear input validation and typed errors, and confirm it
parses with \`node --check ${OUTPUT_DIR}/auth.js\`. Do not run the module or any test.
${PATH_RULE}`,
  tools: ['bash', 'file_read', 'file_write', 'file_edit'],
  maxTurns: 10,
  temperature: 0.1,
}

const qaEngineer: AgentConfig = {
  name: 'qa-engineer',
  model: 'deepseek-v4-flash',
  provider: 'deepseek',
  systemPrompt: `You are a QA engineer. Read ONLY the contract at ${OUTPUT_DIR}/CONTRACT.md (the
implementation runs in parallel and is not available to you). Write a plain-Node test script
(node:assert, no framework) to ${OUTPUT_DIR}/auth.test.js that exercises sign/verify against the
contract — including a tampered-token case and an expired-token case — then confirm it parses with
\`node --check ${OUTPUT_DIR}/auth.test.js\`. Do not run the tests.
${PATH_RULE}`,
  tools: ['bash', 'file_read', 'file_write'],
  maxTurns: 8,
  temperature: 0.1,
}

const securityAnalyst: AgentConfig = {
  name: 'security-analyst',
  model: 'deepseek-v4-pro',
  provider: 'deepseek',
  systemPrompt: `You are an application security engineer. Read ONLY the contract at
${OUTPUT_DIR}/CONTRACT.md, then write a concise threat model to ${OUTPUT_DIR}/THREAT-MODEL.md:
concrete risks (signature bypass, algorithm confusion, timing attacks, weak secrets, token
replay/expiry) each paired with a specific mitigation. Do not read other files, write code, or run
any command.
${PATH_RULE}`,
  tools: ['file_read', 'file_write'],
  maxTurns: 6,
  temperature: 0.3,
}

const reviewer: AgentConfig = {
  name: 'reviewer',
  model: 'deepseek-v4-flash',
  provider: 'deepseek',
  systemPrompt: `You are a senior reviewer. Read exactly these three files with file_read:
${OUTPUT_DIR}/auth.js, ${OUTPUT_DIR}/auth.test.js, and ${OUTPUT_DIR}/THREAT-MODEL.md. Then RETURN
your integration review as your final message — LGTM items, suggestions, blocking issues, and
whether the code addresses the threat model. Do NOT write any file and do NOT run any command.
${PATH_RULE}`,
  tools: ['file_read'],
  maxTurns: 5,
  temperature: 0.3,
}

// ---------------------------------------------------------------------------
// Progress log (mirrors examples/providers/deepseek.ts)
// ---------------------------------------------------------------------------
function handleProgress(event: OrchestratorEvent): void {
  const ts = new Date().toISOString().slice(11, 23)
  switch (event.type) {
    case 'agent_start':
      console.log(`[${ts}] AGENT START → ${event.agent}`)
      break
    case 'agent_complete':
      console.log(`[${ts}] AGENT DONE ← ${event.agent}`)
      break
    case 'task_start':
      console.log(`[${ts}] TASK START ↓ ${event.task}`)
      break
    case 'task_complete':
      console.log(`[${ts}] TASK DONE ↑ ${event.task}`)
      break
    case 'task_retry':
      console.log(`[${ts}] TASK RETRY ⟳ ${event.task}`)
      break
    case 'error':
      console.error(`[${ts}] ERROR ✗ agent=${event.agent} task=${event.task}`)
      break
  }
}

// ---------------------------------------------------------------------------
// Orchestrate — trace capture wired the same way `oma run --dashboard` does it
// ---------------------------------------------------------------------------
const capture = new DashboardTraceCaptureSink()
const orchestrator = new OpenMultiAgent({
  defaultModel: 'deepseek-v4-flash',
  defaultProvider: 'deepseek',
  maxConcurrency: 3, // let the three parallel specialists genuinely overlap in the waterfall
  onProgress: handleProgress,
  observability: { sinks: [capture] },
})

const team = orchestrator.createTeam('hero-team', {
  name: 'hero-team',
  agents: [architect, backendDev, qaEngineer, securityAnalyst, reviewer],
  sharedMemory: true,
  maxConcurrency: 3,
})

// The goal itself is never embedded in the viewer payload (titles and safe
// attributes only), so the absolute workspace directory is safe to spell out
// here — and required, because the file tools reject relative paths.
const goal = `Build a small JWT (HS256) authentication module in ${OUTPUT_DIR}/ using only Node's
built-in \`crypto\` (no external packages). Produce exactly four files:
- ${OUTPUT_DIR}/CONTRACT.md — the design: sign(payload, secret) and verify(token, secret), error
  types, and token/claim format
- ${OUTPUT_DIR}/auth.js — the implementation, with input validation and typed errors
- ${OUTPUT_DIR}/auth.test.js — a node:assert test script covering tamper and expiry cases
- ${OUTPUT_DIR}/THREAT-MODEL.md — risks and mitigations for the design
Finish with an integration review of everything produced.
Do not install packages, start servers, execute code, or run tests; only \`node --check <file>\` is
allowed, to confirm a file parses. Filesystem tools need absolute paths under ${OUTPUT_DIR}/ .`

const coordinatorInstructions = `Decompose into exactly 5 tasks.
Task titles must be short imperative phrases of at most ${MAX_TITLE_CHARS} characters.
The first task designs the auth module and writes the contract. The implementation task, the
test-writing task, and the threat-model task must each depend only on the design task and NOT on
one another, so they run in parallel, and must be assigned to three different agents.
The final integration review depends on all three. Assign every task explicitly.`

console.log(`Run directory: ${runDir}`)
console.log(`Team "${team.name}": ${team.getAgents().map((a) => a.name).join(', ')}`)
console.log('\nStarting team run...')
console.log('='.repeat(60))

const result = await orchestrator.runTeam(team, goal, {
  coordinator: {
    model: 'deepseek-v4-pro',
    provider: 'deepseek',
    instructions: coordinatorInstructions,
  },
})

const records = withInjectedCost(capture.records())
const { html, captureWarning } = renderCapturedRunDashboard(result, records)

// ---------------------------------------------------------------------------
// Persist run artifacts
// ---------------------------------------------------------------------------
const tracePath = join(runDir, 'traces.ndjson')
const store = await FileTraceStore.open(tracePath)
await store.append(records)
await store.flush()
await store.close()

writeFileSync(join(runDir, 'result.json'), JSON.stringify(
  serializeTeamRunResult(result, { pretty: true, includeMessages: false }),
  null,
  2,
))
writeFileSync(join(runDir, 'viewer.html'), html)

await orchestrator.shutdown()

// ---------------------------------------------------------------------------
// SELECTION REPORT — hard criteria for picking the committed run
// ---------------------------------------------------------------------------
const tasks = result.tasks ?? []
const spanEnds = records.filter((r) => r.recordType === 'span_end')
const toolSpans = spanEnds.filter((r) => r.kind === 'tool')
const llmSpans = spanEnds.filter((r) => r.kind === 'llm')
// Error spans paint red bars in the hero waterfall, and sandbox/tool error
// messages can embed local absolute paths into the snapshot.
const errorSpans = spanEnds.filter((r) => r.status !== undefined && r.status.code !== 'ok')
const homeDir = process.env['HOME'] ?? ''
const leaks = ['/Users/', '/home/', ...(homeDir ? [homeDir] : [])].filter((needle) => html.includes(needle))

const titleReport = tasks.map((t) => ({
  id: t.id,
  title: t.title,
  chars: t.title.length,
  fits: t.title.length <= MAX_TITLE_CHARS,
  assignee: t.assignee ?? null,
  dependsOn: t.dependsOn ?? [],
  status: t.status,
}))

const checks = {
  success: result.success,
  taskCount: tasks.length,
  taskCountOk: tasks.length >= 4 && tasks.length <= 5,
  allTitlesFit: titleReport.every((t) => t.fits),
  toolSpanCount: toolSpans.length,
  toolSpansOk: toolSpans.length >= 2,
  llmSpanCount: llmSpans.length,
  errorSpanCount: errorSpans.length,
  pathLeaks: leaks,
  captureWarning: captureWarning ?? null,
}
const pass =
  checks.success && checks.taskCountOk && checks.allTitlesFit && checks.toolSpansOk &&
  checks.errorSpanCount === 0 && leaks.length === 0 && !captureWarning

writeFileSync(join(runDir, 'report.json'), JSON.stringify({ checks, tasks: titleReport }, null, 2))

console.log('='.repeat(60))
console.log('\nSELECTION REPORT')
for (const t of titleReport) {
  const dep = t.dependsOn.length ? ` deps=[${t.dependsOn.join(',')}]` : ''
  console.log(` ${t.fits ? 'ok ' : 'LONG'} [${t.status}] ${t.id} "${t.title}" (${t.chars}) → ${t.assignee}${dep}`)
}
console.log(` success=${checks.success} tasks=${checks.taskCount} toolSpans=${checks.toolSpanCount} llmSpans=${checks.llmSpanCount} errorSpans=${checks.errorSpanCount}`)
if (leaks.length) console.log(` PATH LEAK in viewer.html: ${leaks.join(', ')}`)
if (captureWarning) console.log(` captureWarning=${captureWarning}`)
console.log(`\nVERDICT: ${pass ? 'PASS' : 'FAIL'} — artifacts in ${runDir}`)
process.exit(pass ? 0 : 1)
