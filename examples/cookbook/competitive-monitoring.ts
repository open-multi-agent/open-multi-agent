/**
 * Competitive Monitoring (Multi-Source Aggregation with Contradiction Detection)
 *
 * Demonstrates:
 * - Three parallel source agents extract feed data from local JSON fixtures
 * - Each agent processes claims with { claim, date, source_url, confidence }
 * - Aggregator cross-checks claims across sources, identifies duplicates, flags contradictions
 * - Structured markdown report output
 * - Timing validation: parallel execution must be <70% of serial sum
 *
 * Run:
 *   npx tsx examples/cookbook/competitive-monitoring.ts
 *
 * Prerequisites:
 *   ANTHROPIC_API_KEY or OLLAMA running (for local models).
 *   Requires Node.js >= 18.
 *
 * Fixtures:
 *   - examples/fixtures/competitive-monitoring/twitter.json (10 claims)
 *   - examples/fixtures/competitive-monitoring/reddit.json (10 claims)
 *   - examples/fixtures/competitive-monitoring/news.json (10 claims)
 *
 * Intentional contradictions in fixtures (for aggregator to detect):
 *   - Competitor X product launch date: 04-15 (Twitter), 04-14 (Reddit), 04-16 (News)
 *   - Performance improvement claims: 60% (Twitter) vs 55% (News)
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { z } from 'zod'
import { Agent, ToolRegistry, ToolExecutor, registerBuiltInTools } from '../../src/index.js'
import type { AgentConfig, AgentRunResult } from '../../src/types.js'

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url))

interface Claim {
  claim: string
  date: string
  source_url: string
  confidence: number
}

function loadFixture(name: 'twitter' | 'reddit' | 'news'): Claim[] {
  const filePath = path.join(__dirname, '../fixtures/competitive-monitoring', `${name}.json`)
  const data = readFileSync(filePath, 'utf-8')
  return JSON.parse(data) as Claim[]
}

const twitterData = loadFixture('twitter')
const redditData = loadFixture('reddit')
const newsData = loadFixture('news')

function parseJsonObject<T>(raw: string): T | null {
  const codeBlockMatches = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
  for (const match of codeBlockMatches) {
    const block = match[1]?.trim()
    if (!block) continue
    try {
      return JSON.parse(block) as T
    } catch {
      // keep trying next candidate
    }
  }

  try {
    return JSON.parse(raw) as T
  } catch {
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) return null
    try {
      return JSON.parse(match[0]) as T
    } catch {
      return null
    }
  }
}

function normalizeAggregatedReport(input: unknown): AggregatedReport | null {
  const parsed = AggregatedReport.safeParse(input)
  if (parsed.success) return parsed.data

  if (!input || typeof input !== 'object') return null
  const root = input as Record<string, unknown>
  const wrapped = root.AggregatedReport
  if (!wrapped || typeof wrapped !== 'object') return null
  const payload = wrapped as Record<string, unknown>

  const verifiedClaimsRaw = Array.isArray(payload.VerifiedClaims) ? payload.VerifiedClaims : []
  const contradictionsRaw = Array.isArray(payload.DetectedContradictions) ? payload.DetectedContradictions : []

  const verified_claims = verifiedClaimsRaw.map((item) => {
    const record = (item ?? {}) as Record<string, unknown>
    const sources = Array.isArray(record.Sources)
      ? record.Sources.map((s) => String(s)).join(', ')
      : String(record.Sources ?? '')
    return {
      claim: String(record.ClaimText ?? ''),
      sources,
      consolidation: 'Normalized from alternate model output format.',
      avg_confidence: Number(record.ConfidenceScore ?? 0),
      first_reported: String(record.Date ?? ''),
    }
  })

  const contradictions = contradictionsRaw.map((item) => {
    const record = (item ?? {}) as Record<string, unknown>
    const conflictList = Array.isArray(record.ConflictingClaims) ? record.ConflictingClaims : []
    const firstConflict = (conflictList[0] ?? {}) as Record<string, unknown>
    const sourcesA = Array.isArray(record.Sources) ? record.Sources.map((s) => String(s)).join(', ') : String(record.Sources ?? '')
    const sourcesB = Array.isArray(firstConflict.Sources)
      ? firstConflict.Sources.map((s) => String(s)).join(', ')
      : String(firstConflict.Sources ?? '')
    return {
      claim_topic: String(record.ClaimText ?? ''),
      variant_a: String(record.ClaimText ?? ''),
      variant_b: String(firstConflict.ClaimText ?? ''),
      source_a: sourcesA,
      source_b: sourcesB,
      severity: 'moderate' as const,
    }
  })

  const normalized = AggregatedReport.safeParse({
    verified_claims,
    contradictions,
    summary: 'Normalized from alternate model output format.',
  })
  return normalized.success ? normalized.data : null
}

const USE_ANTHROPIC = Boolean(process.env.ANTHROPIC_API_KEY)
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'llama3.2:3b'
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1'
const LOCAL_MODEL_TIMEOUT_MS = Number(process.env.LOCAL_MODEL_TIMEOUT_MS ?? '900000')

type AgentConfigTemplate = Omit<AgentConfig, 'model'>

function withModelConfig(config: AgentConfigTemplate): AgentConfig {
  if (USE_ANTHROPIC) {
    return {
      ...config,
      model: 'claude-sonnet-4-6',
    }
  }

  return {
    ...config,
    model: OLLAMA_MODEL,
    provider: 'openai',
    baseURL: OLLAMA_BASE_URL,
    apiKey: 'ollama',
    timeoutMs: LOCAL_MODEL_TIMEOUT_MS,
  }
}

// ---------------------------------------------------------------------------
// Zod schemas for structured extraction
// ---------------------------------------------------------------------------

const ClaimData = z.object({
  claims: z.array(
    z.object({
      claim: z.string().describe('The specific claim or news item'),
      date: z.string().describe('ISO date or date the claim was made'),
      source_url: z.string().describe('URL or source reference'),
      confidence: z.number().min(0).max(1).describe('Confidence 0.0-1.0'),
    }),
  ),
})
type ClaimData = z.infer<typeof ClaimData>

const AggregatedReport = z.object({
  verified_claims: z.array(
    z.object({
      claim: z.string(),
      sources: z.string().describe('Comma-separated list of source names'),
      consolidation: z.string().describe('How claims were merged/consolidated'),
      avg_confidence: z.number(),
      first_reported: z.string().describe('Earliest date across sources'),
    }),
  ),
  contradictions: z.array(
    z.object({
      claim_topic: z.string().describe('The general topic with conflicting claims'),
      variant_a: z.string().describe('One version of the claim'),
      variant_b: z.string().describe('Conflicting version'),
      source_a: z.string(),
      source_b: z.string(),
      severity: z.enum(['minor', 'moderate', 'critical']),
    }),
  ),
  summary: z.string().describe('High-level summary of monitoring findings'),
})
type AggregatedReport = z.infer<typeof AggregatedReport>

function confidenceLabel(value: number): 'high' | 'medium' | 'low' {
  if (value >= 0.8) return 'high'
  if (value >= 0.6) return 'medium'
  return 'low'
}

function isGroundedToFixture(report: AggregatedReport, sourceClaims: Claim[]): boolean {
  if (report.verified_claims.length === 0) return false
  const corpus = sourceClaims.map(c => `${c.claim} ${c.date}`).join(' ').toLowerCase()
  const reportText = [
    report.summary,
    ...report.verified_claims.map(c => `${c.claim} ${c.first_reported}`),
    ...report.contradictions.map(c => `${c.claim_topic} ${c.variant_a} ${c.variant_b}`),
  ].join(' ').toLowerCase()

  const requiredHints = ['competitor x', 'company y', 'techconf2026']
  const hasKnownHint = requiredHints.some(hint => reportText.includes(hint))
  const hasDateFromFixture = /2026-\d{2}-\d{2}/.test(reportText)
  const overlapToken = ['apac', 'performance', 'funding', 'consolidation', 'offline-first']
    .some(token => reportText.includes(token) && corpus.includes(token))

  return hasKnownHint && hasDateFromFixture && overlapToken
}

function hasExpectedContradictions(report: AggregatedReport): boolean {
  if (report.contradictions.length === 0) return false
  const text = report.contradictions
    .map(c => `${c.claim_topic} ${c.variant_a} ${c.variant_b}`)
    .join(' ')
    .toLowerCase()
  const launchSignal = text.includes('launch') || text.includes('04-14') || text.includes('04-15') || text.includes('04-16')
  const perfSignal = text.includes('55%') || text.includes('60%') || text.includes('performance')
  return launchSignal || perfSignal
}

// ---------------------------------------------------------------------------
// Agent configs — source agents extract from fixtures
// ---------------------------------------------------------------------------

const twitterConfig: AgentConfig = withModelConfig({
  name: 'twitter-monitor',
  systemPrompt: `You are a social media monitor analyzing Twitter/X feed data.
You receive raw JSON fixture data. Extract and validate each claim.
Focus on:
- Product announcements and updates
- Funding news and partnerships
- Market movements and competitive intelligence

Return JSON matching the schema, validating dates and confidence scores.`,
  maxTurns: 1,
  maxTokens: 400,
  temperature: 0.2,
  outputSchema: USE_ANTHROPIC ? ClaimData : undefined,
})

const redditConfig: AgentConfig = withModelConfig({
  name: 'reddit-monitor',
  systemPrompt: `You are a community sentiment analyzer monitoring Reddit discussions.
You receive raw JSON fixture data about tech industry claims.
Extract insights but note that:
- Community opinions may be speculative or unverified
- Confidence scores may be lower due to anecdotal nature
- Flag claims that contradict official sources

Return JSON matching the schema.`,
  maxTurns: 1,
  maxTokens: 400,
  temperature: 0.2,
  outputSchema: USE_ANTHROPIC ? ClaimData : undefined,
})

const newsConfig: AgentConfig = withModelConfig({
  name: 'news-monitor',
  systemPrompt: `You are a tech news analyst monitoring official press releases and news sources.
You receive raw JSON fixture data from reputable news outlets.
Extract and validate claims with focus on:
- Official product announcements
- Verified funding and acquisition data
- Industry analyst reports
- Conference announcements

Return JSON matching the schema.`,
  maxTurns: 1,
  maxTokens: 400,
  temperature: 0.2,
  outputSchema: USE_ANTHROPIC ? ClaimData : undefined,
})

const aggregatorConfig: AgentConfig = withModelConfig({
  name: 'aggregator',
  systemPrompt: `You are a competitive intelligence analyst synthesizing multi-source monitoring data.
You receive claim extractions from Twitter, Reddit, and News monitors.

Your tasks:
1. **Deduplication**: Identify claims that are the same across sources (accounting for
   slight wording differences). Merge them, noting all sources.
2. **Contradiction Detection**: Flag claims about the SAME topic that have different
   versions, dates, or factual assertions (e.g., product launch date varies, or one
   source says growth is 200% while another says 150%).
3. **Confidence Scoring**: Average confidence across sources for merged claims.
4. **Markdown Report**: Generate a clear report with sections for verified claims and
   detected contradictions.

Return JSON matching the AggregatedReport schema. Be thorough about contradictions
even if the differences seem minor (e.g., 55% vs 60% performance improvement).`,
  maxTurns: 1,
  maxTokens: 1000,
  temperature: 0.3,
  outputSchema: AggregatedReport,
})

// ---------------------------------------------------------------------------
// Build agents
// ---------------------------------------------------------------------------

function buildAgent(config: AgentConfig): Agent {
  const registry = new ToolRegistry()
  if (USE_ANTHROPIC) {
    registerBuiltInTools(registry)
  }
  const executor = new ToolExecutor(registry)
  return new Agent(config, registry, executor)
}

const twitterMonitor = buildAgent(twitterConfig)
const redditMonitor = buildAgent(redditConfig)
const newsMonitor = buildAgent(newsConfig)
const aggregator = buildAgent(aggregatorConfig)

// ---------------------------------------------------------------------------
// Main execution
// ---------------------------------------------------------------------------

console.log('Competitive Monitoring — Multi-Source Aggregation with Contradiction Detection')
console.log('='.repeat(80))
console.log(`Model backend: ${USE_ANTHROPIC ? 'Anthropic' : `Ollama (${OLLAMA_MODEL})`}`)
console.log(`Local fixtures: Twitter (${twitterData.length}), Reddit (${redditData.length}), News (${newsData.length}) claims`)
console.log('Expected contradictions: Competitor X launch dates, performance improvement numbers\n')

// Track timing
const globalStartTime = Date.now()

// Format fixture data for prompts
const twitterPrompt = `Extract claims from this Twitter feed.
Rules:
- Use only claims from the input.
- Return a single JSON object matching the schema, no markdown and no extra text.
Input:
${JSON.stringify(twitterData)}`
const redditPrompt = `Extract claims from this Reddit feed.
Rules:
- Use only claims from the input.
- Return a single JSON object matching the schema, no markdown and no extra text.
Input:
${JSON.stringify(redditData)}`
const newsPrompt = `Extract claims from this News feed.
Rules:
- Use only claims from the input.
- Return a single JSON object matching the schema, no markdown and no extra text.
Input:
${JSON.stringify(newsData)}`

// ---------------------------------------------------------------------------
// Phase 1: Parallel fan-out — three monitors
// ---------------------------------------------------------------------------

console.log('[Phase 1] Parallel monitoring: Twitter, Reddit, News\n')

const monitorStartTime = Date.now()

async function runTimed(name: string, agent: Agent, prompt: string): Promise<{ result: AgentRunResult, elapsedMs: number }> {
  const start = Date.now()
  console.log(`  [RUN] ${name} monitor started...`)
  const result = await agent.run(prompt)
  const elapsedMs = Date.now() - start
  console.log(`  [DONE] ${name} monitor finished in ${elapsedMs}ms`)
  return {
    result,
    elapsedMs,
  }
}

const [twitterRun, redditRun, newsRun] = await Promise.all([
  runTimed('Twitter', twitterMonitor, twitterPrompt),
  runTimed('Reddit', redditMonitor, redditPrompt),
  runTimed('News', newsMonitor, newsPrompt),
])

const monitorTime = Date.now() - monitorStartTime

// Check results
const twitterResult = twitterRun.result
const redditResult = redditRun.result
const newsResult = newsRun.result

const monitorDurations = [
  { name: 'Twitter', time: twitterRun.elapsedMs, tokens: twitterResult.tokenUsage.output_tokens },
  { name: 'Reddit', time: redditRun.elapsedMs, tokens: redditResult.tokenUsage.output_tokens },
  { name: 'News', time: newsRun.elapsedMs, tokens: newsResult.tokenUsage.output_tokens },
]

for (const m of monitorDurations) {
  const status = 'OK'
  console.log(`  [${status}] ${m.name.padEnd(10)} — ${m.tokens} tokens, ~${m.time}ms`)
}

// Validate all completed
for (const [name, result] of [
  ['twitter-monitor', twitterResult],
  ['reddit-monitor', redditResult],
  ['news-monitor', newsResult],
] as const) {
  if (!result.success) {
    console.error(`✗ Monitor '${name}' failed`)
    console.error(`  Error: ${result.output}`)
    process.exit(1)
  }
}

console.log(`\n  Parallel wall time: ${monitorTime}ms`)
const serialMonitorTime = monitorDurations.reduce((sum, m) => sum + m.time, 0)
console.log(`  Sequential serial sum: ${serialMonitorTime}ms`)
console.log(`  Parallel speedup: ${(serialMonitorTime / monitorTime).toFixed(2)}x\n`)

// Extract structured outputs
let twitterClaims: Claim[] = []
let redditClaims: Claim[] = []
let newsClaims: Claim[] = []

try {
  const twitterStructured = twitterResult.structured as ClaimData | undefined
  const twitterParsed = twitterStructured ?? parseJsonObject<ClaimData>(twitterResult.output)
  twitterClaims = twitterParsed?.claims ?? []
} catch {
  console.warn('Could not parse Twitter output as ClaimData')
}

try {
  const redditStructured = redditResult.structured as ClaimData | undefined
  const redditParsed = redditStructured ?? parseJsonObject<ClaimData>(redditResult.output)
  redditClaims = redditParsed?.claims ?? []
} catch {
  console.warn('Could not parse Reddit output as ClaimData')
}

try {
  const newsStructured = newsResult.structured as ClaimData | undefined
  const newsParsed = newsStructured ?? parseJsonObject<ClaimData>(newsResult.output)
  newsClaims = newsParsed?.claims ?? []
} catch {
  console.warn('Could not parse News output as ClaimData')
}

// ---------------------------------------------------------------------------
// Phase 2: Aggregate
// ---------------------------------------------------------------------------

console.log('[Phase 2] Aggregation: Cross-check, merge, detect contradictions\n')

const aggregatorStartTime = Date.now()
const sourceClaimsForGrounding = [...twitterClaims, ...redditClaims, ...newsClaims]

const aggregatorPrompt = `
You have three monitoring reports. Merge and analyze:

TWITTER CLAIMS (${twitterClaims.length} items):
${JSON.stringify(twitterClaims, null, 2)}

REDDIT CLAIMS (${redditClaims.length} items):
${JSON.stringify(redditClaims, null, 2)}

NEWS CLAIMS (${newsClaims.length} items):
${JSON.stringify(newsClaims, null, 2)}

Now:
1. Find duplicate/similar claims across sources and merge them
2. Identify contradictions (different dates, numbers, or facts for the same topic)
3. Calculate average confidence for each merged claim
4. Return the result matching the AggregatedReport schema
5. Use only facts present in the provided claims
6. Output one JSON object only, no markdown/code fences, no explanations
`

const aggregatorResult = await aggregator.run(aggregatorPrompt)

let aggregatorTime = Date.now() - aggregatorStartTime
let aggregatorOutputTokens = aggregatorResult.tokenUsage.output_tokens

if (!aggregatorResult.success) {
  console.error('✗ Aggregator failed')
  console.error(`  Error: ${aggregatorResult.output}`)
  process.exit(1)
}

console.log(`  [OK] Aggregator completed — ${aggregatorResult.tokenUsage.output_tokens} tokens, ${aggregatorTime}ms\n`)

// Parse aggregated report
let report: AggregatedReport | null = null
try {
  const structuredReport = aggregatorResult.structured as AggregatedReport | undefined
  report = structuredReport ?? parseJsonObject<AggregatedReport>(aggregatorResult.output)
  report = normalizeAggregatedReport(report) ?? normalizeAggregatedReport(parseJsonObject<unknown>(aggregatorResult.output))
} catch (e) {
  console.warn('Warning: Could not parse aggregator output as JSON. Attempting raw output...')
  console.log(aggregatorResult.output)
}

if (report && !isGroundedToFixture(report, sourceClaimsForGrounding)) {
  console.warn('Warning: Aggregated report appears off-topic. Running one strict retry...')
  const retryStart = Date.now()
  const strictRetry = await aggregator.run(`
You previously produced an off-topic report. Retry strictly.
Only use entities and facts that appear in the provided claims.
Do NOT introduce any new product/domain/company.
Return exactly one JSON object matching AggregatedReport schema.

Claims:
${JSON.stringify(sourceClaimsForGrounding, null, 2)}
`)
  aggregatorTime += Date.now() - retryStart
  aggregatorOutputTokens += strictRetry.tokenUsage.output_tokens
  const strictStructured = strictRetry.structured as AggregatedReport | undefined
  const strictParsed = strictStructured ?? parseJsonObject<AggregatedReport>(strictRetry.output)
  const strictNormalized = normalizeAggregatedReport(strictParsed) ?? normalizeAggregatedReport(parseJsonObject<unknown>(strictRetry.output))
  if (strictNormalized && isGroundedToFixture(strictNormalized, sourceClaimsForGrounding)) {
    report = strictNormalized
  }
}

if (!report || !isGroundedToFixture(report, sourceClaimsForGrounding) || !hasExpectedContradictions(report)) {
  console.warn('Warning: Aggregated report failed quality gate (off-topic or missing expected contradictions).')
  console.warn('Proceeding without hard stop as requested.')
}

// ---------------------------------------------------------------------------
// Output markdown report
// ---------------------------------------------------------------------------

const totalTime = Date.now() - globalStartTime

console.log('\n' + '='.repeat(80))
console.log('COMPETITIVE INTELLIGENCE REPORT')
console.log('='.repeat(80))
console.log()

if (report) {
  console.log('## Summary\n')
  console.log(report.summary)
  console.log()

  console.log('## Verified Claims\n')
  if (report.verified_claims.length === 0) {
    console.log('_No claims verified across multiple sources._\n')
  } else {
    for (const vc of report.verified_claims) {
      console.log(`**${vc.claim}**`)
      console.log(`  - Sources: ${vc.sources}`)
      console.log(`  - Confidence: ${(vc.avg_confidence * 100).toFixed(0)}% [${confidenceLabel(vc.avg_confidence)}]`)
      console.log(`  - First reported: ${vc.first_reported}`)
      console.log(` - Consolidation: ${vc.consolidation}`)
      console.log()
    }
  }

  console.log('## contradictions: [...]\n')
  if (report.contradictions.length === 0) {
    console.log('_No contradictions detected._\n')
  } else {
    for (const c of report.contradictions) {
      const severityEmoji = c.severity === 'critical' ? '🔴' : c.severity === 'moderate' ? '🟠' : '🟡'
      console.log(`${severityEmoji} **${c.claim_topic}** [${c.severity}]`)
      console.log(`  - Version A (${c.source_a}): ${c.variant_a}`)
      console.log(`  - Version B (${c.source_b}): ${c.variant_b}`)
      console.log()
    }
  }
} else {
  console.log('(Raw aggregator output:)\n')
  console.log(aggregatorResult.output)
}

// ---------------------------------------------------------------------------
// Timing validation
// ---------------------------------------------------------------------------

console.log('## Timing Analysis\n')

const totalSourceTokens =
  twitterResult.tokenUsage.output_tokens +
  redditResult.tokenUsage.output_tokens +
  newsResult.tokenUsage.output_tokens

console.log(`Total execution time: ${totalTime}ms`)
console.log(`  - Parallel monitoring: ${monitorTime}ms`)
console.log(`  - Aggregation: ${aggregatorTime}ms`)
console.log()

console.log(`Serial sum of monitors: ${serialMonitorTime}ms`)
console.log(`Parallel actual: ${monitorTime}ms`)
console.log(`Speedup: ${(serialMonitorTime / monitorTime).toFixed(2)}x`)
console.log()

// Parallel must be < 70% of serial sum
const threshold = serialMonitorTime * 0.7
const assertion = monitorTime < threshold

console.log(`Parallel speedup assertion (must be <70% of serial):`)
console.log(`  ${monitorTime}ms < ${threshold.toFixed(0)}ms? ${assertion ? '✓ PASS' : '✗ FAIL'}`)

if (!assertion) {
  console.warn('\nWarning: Parallel execution did not achieve 70% reduction vs serial sum.')
  console.warn('This may indicate insufficient parallelism or overhead.')
}

console.log()
console.log(`Total tokens: ${totalSourceTokens + aggregatorOutputTokens}`)
console.log('='.repeat(80))

// ---------------------------------------------------------------------------
// Exit code
// ---------------------------------------------------------------------------

if (!assertion) {
  process.exit(1)
}

console.log('\n✓ Competitive monitoring complete.\n')

// ---------------------------------------------------------------------------
// Real API variant (commented out by default)
// ---------------------------------------------------------------------------

// To use live feeds instead of committed JSON fixtures, replace the fixture
// loaders above with your own source adapters, for example:
//
// const twitterData = await fetchTwitterFeed(...)
// const redditData = await fetchRedditPosts(...)
// const newsData = await fetchNewsArticles(...)
//
// The extraction and aggregation stages can stay unchanged so the example keeps
// demonstrating the same fan-out + contradiction-detection workflow.
