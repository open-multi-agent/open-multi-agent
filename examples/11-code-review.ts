/**
 * Example 11 — Multi-Perspective Code Review
 *
 * Demonstrates:
 * - Dependency chain: reviewer agents depend on generator output
 * - Fan-out: three review agents run in parallel, each with a focused lens
 * - Aggregation: a synthesizer merges feedback into prioritized action items
 *
 * Flow:
 *   generator -> [security-reviewer, performance-reviewer, style-reviewer] -> synthesizer
 *
 * Run:
 *   npx tsx examples/11-code-review.ts
 *
 * Prerequisites:
 *   ANTHROPIC_API_KEY env var must be set.
 */

import { Agent, AgentPool, ToolRegistry, ToolExecutor, registerBuiltInTools } from '../src/index.js'
import type { AgentConfig, AgentRunResult } from '../src/types.js'

// ---------------------------------------------------------------------------
// Spec for the code generator
// ---------------------------------------------------------------------------

const SPEC = `Write a Node.js HTTP handler (using the built-in http module, no frameworks)
that accepts POST /users, reads a JSON body with { name, email }, stores it in
a global in-memory array, and returns 201 with the created user object including
a generated id. Include basic error handling.`

// ---------------------------------------------------------------------------
// Agent configs
// ---------------------------------------------------------------------------

const generatorConfig: AgentConfig = {
  name: 'generator',
  model: 'claude-sonnet-4-6',
  systemPrompt: `You are a backend developer. Given a spec, produce working
Node.js code. Output ONLY the code — no explanations, no markdown fences.`,
  maxTurns: 1,
  temperature: 0.2,
}

const securityReviewerConfig: AgentConfig = {
  name: 'security-reviewer',
  model: 'claude-sonnet-4-6',
  systemPrompt: `You are a security engineer reviewing code for OWASP top 10
vulnerabilities: injection, broken auth, sensitive data exposure, XXE, broken
access control, misconfig, XSS, insecure deserialization, known-vuln components,
and insufficient logging. For each finding, state the category, severity
(critical/high/medium/low), the offending line or pattern, and a fix.
Keep your review to 200-300 words.`,
  maxTurns: 1,
  temperature: 0.3,
}

const performanceReviewerConfig: AgentConfig = {
  name: 'performance-reviewer',
  model: 'claude-sonnet-4-6',
  systemPrompt: `You are a performance engineer reviewing code for N+1 queries,
memory leaks, blocking calls on the event loop, unbounded data structures,
missing timeouts, and inefficient algorithms. For each finding, state the
issue, impact (high/medium/low), the offending pattern, and a fix.
Keep your review to 200-300 words.`,
  maxTurns: 1,
  temperature: 0.3,
}

const styleReviewerConfig: AgentConfig = {
  name: 'style-reviewer',
  model: 'claude-sonnet-4-6',
  systemPrompt: `You are a senior developer reviewing code for naming clarity,
function length, single-responsibility violations, error message quality,
missing JSDoc, inconsistent formatting, and readability. For each finding,
state the issue, severity (nit/suggestion/important), and a fix.
Keep your review to 200-300 words.`,
  maxTurns: 1,
  temperature: 0.3,
}

const synthesizerConfig: AgentConfig = {
  name: 'synthesizer',
  model: 'claude-sonnet-4-6',
  systemPrompt: `You are a tech lead merging code review feedback from three
reviewers (security, performance, style) into one actionable report. Structure:

1. Critical issues (must fix before merge)
2. Important issues (fix soon)
3. Suggestions (nice to have)

For each item, include the reviewer source, a one-line summary, and the fix.
Deduplicate overlapping findings. Keep the report to 300-400 words.`,
  maxTurns: 1,
  temperature: 0.3,
}

// ---------------------------------------------------------------------------
// Build agents
// ---------------------------------------------------------------------------

function buildAgent(config: AgentConfig): Agent {
  const registry = new ToolRegistry()
  registerBuiltInTools(registry)
  const executor = new ToolExecutor(registry)
  return new Agent(config, registry, executor)
}

const generator = buildAgent(generatorConfig)
const securityReviewer = buildAgent(securityReviewerConfig)
const performanceReviewer = buildAgent(performanceReviewerConfig)
const styleReviewer = buildAgent(styleReviewerConfig)
const synthesizer = buildAgent(synthesizerConfig)

// ---------------------------------------------------------------------------
// Pool setup
// ---------------------------------------------------------------------------

const pool = new AgentPool(4)
pool.add(generator)
pool.add(securityReviewer)
pool.add(performanceReviewer)
pool.add(styleReviewer)
pool.add(synthesizer)

console.log('Multi-Perspective Code Review')
console.log('='.repeat(60))
console.log(`\nSpec: ${SPEC.replace(/\n/g, ' ').trim()}\n`)

// ---------------------------------------------------------------------------
// Step 1: Generate code
// ---------------------------------------------------------------------------

console.log('[Step 1] Generating code...\n')

const genResult = await pool.run('generator', SPEC)

if (!genResult.success) {
  console.error('Generator failed:', genResult.output)
  process.exit(1)
}

console.log('Generated code:')
console.log(genResult.output.slice(0, 300) + '...\n')

// ---------------------------------------------------------------------------
// Step 2: Fan-out — three reviewers in parallel
// ---------------------------------------------------------------------------

console.log('[Step 2] Fan-out: 3 reviewers running in parallel...\n')

const reviewPrompt = `Review the following Node.js code:\n\n${genResult.output}`

const reviewResults: Map<string, AgentRunResult> = await pool.runParallel([
  { agent: 'security-reviewer',    prompt: reviewPrompt },
  { agent: 'performance-reviewer', prompt: reviewPrompt },
  { agent: 'style-reviewer',       prompt: reviewPrompt },
])

const reviewers = ['security-reviewer', 'performance-reviewer', 'style-reviewer'] as const
for (const name of reviewers) {
  const result = reviewResults.get(name)!
  const status = result.success ? 'OK' : 'FAILED'
  console.log(`  ${name} [${status}] — ${result.tokenUsage.output_tokens} output tokens`)
  console.log(`  ${result.output.slice(0, 120).replace(/\n/g, ' ')}...`)
  console.log()
}

for (const name of reviewers) {
  if (!reviewResults.get(name)!.success) {
    console.error(`Reviewer '${name}' failed: ${reviewResults.get(name)!.output}`)
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Step 3: Synthesize reviews
// ---------------------------------------------------------------------------

console.log('[Step 3] Synthesizer merging feedback...\n')

const synthPrompt = `Three reviewers have independently reviewed the same code.
Merge their feedback into a single prioritized report.

--- SECURITY REVIEW ---
${reviewResults.get('security-reviewer')!.output}

--- PERFORMANCE REVIEW ---
${reviewResults.get('performance-reviewer')!.output}

--- STYLE REVIEW ---
${reviewResults.get('style-reviewer')!.output}

Now produce the unified review report.`

const synthResult = await pool.run('synthesizer', synthPrompt)

if (!synthResult.success) {
  console.error('Synthesizer failed:', synthResult.output)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Final output
// ---------------------------------------------------------------------------

console.log('='.repeat(60))
console.log('UNIFIED CODE REVIEW REPORT')
console.log('='.repeat(60))
console.log()
console.log(synthResult.output)
console.log()

// ---------------------------------------------------------------------------
// Token usage
// ---------------------------------------------------------------------------

console.log('-'.repeat(60))
console.log('Token Usage Summary:')
console.log('-'.repeat(60))

let totalInput = genResult.tokenUsage.input_tokens
let totalOutput = genResult.tokenUsage.output_tokens
console.log(`  ${'generator'.padEnd(22)} — input: ${genResult.tokenUsage.input_tokens}, output: ${genResult.tokenUsage.output_tokens}`)

for (const name of reviewers) {
  const r = reviewResults.get(name)!
  totalInput += r.tokenUsage.input_tokens
  totalOutput += r.tokenUsage.output_tokens
  console.log(`  ${name.padEnd(22)} — input: ${r.tokenUsage.input_tokens}, output: ${r.tokenUsage.output_tokens}`)
}

totalInput += synthResult.tokenUsage.input_tokens
totalOutput += synthResult.tokenUsage.output_tokens
console.log(`  ${'synthesizer'.padEnd(22)} — input: ${synthResult.tokenUsage.input_tokens}, output: ${synthResult.tokenUsage.output_tokens}`)
console.log('-'.repeat(60))
console.log(`  ${'TOTAL'.padEnd(22)} — input: ${totalInput}, output: ${totalOutput}`)

console.log('\nDone.')
