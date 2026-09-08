/**
 * Residential Building Permit Review Gate (Per-Task Verify Loop)
 *
 * Demonstrates a provisional permit decision that must survive two
 * source-specific judges before it can stand:
 *
 *   site plan ──> site-plan-analyst ──┐
 *                                      ├─> permit-decision-proposer
 *   structural summary -> structural-analyst ┘              │
 *                                                           v
 *                                       per-task verify, quorum: 2
 *                                   ┌─────────────────────────────┐
 *                                   │ flood-overlay-judge         │
 *                                   │ fire-access-judge           │
 *                                   └─────────────────────────────┘
 *
 * The first decision is intentionally provisional: setbacks, coverage, height,
 * and structural loads are locally compliant, so the proposer emits APPROVE.
 * Each judge receives a different withheld MOCK source through
 * `judgePrompt: (judge) => string`. They expose an unverified floodplain
 * elevation and a substandard fire-access route, forcing a revision to an
 * actionable CONDITIONAL decision. `quorum: 2` ensures one accepting judge
 * can never short-circuit the other. No `mode` is set because `judgePrompt`
 * replaces the built-in mode instruction.
 *
 * Run:
 *   npx tsx packages/core/examples/cookbook/building-permit-review-gate.ts
 *
 * Prerequisites:
 *   ANTHROPIC_API_KEY env var must be set.
 *   Requires Node.js >= 20.
 *
 * Fixtures:
 *   Every file under examples/fixtures/building-permit-review-gate/ is
 *   MOCK and synthetic. The example makes no municipal or network request.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { OpenMultiAgent } from '../../src/index.js'
import type {
  AgentConfig,
  AgentRunResult,
  ConsensusTrace,
  RunTaskSpec,
  TraceEvent,
} from '../../src/types.js'

// ---------------------------------------------------------------------------
// MOCK fixture loading
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixtureRoot = path.join(__dirname, '../fixtures/building-permit-review-gate')

function readFixture(name: string): string {
  return readFileSync(path.join(fixtureRoot, name), 'utf8')
}

const sitePlan = readFixture('site-plan.json')
const structuralSummary = readFixture('structural-summary.json')
const floodOverlay = readFixture('flood-overlay.json')
const fireAccessReport = readFixture('fire-access-report.txt')
const fireCodeExcerpt = readFixture('fire-code-excerpt.md')

const MODEL = process.env['MODEL'] ?? 'claude-sonnet-4-6'
const providerConfig = {
  provider: 'anthropic' as const,
  model: MODEL,
  apiKey: process.env['ANTHROPIC_API_KEY'],
  baseURL: process.env['ANTHROPIC_BASE_URL'],
  tools: [] as const,
}

// ---------------------------------------------------------------------------
// Structured evidence and decision contracts
// ---------------------------------------------------------------------------

const SitePlanAudit = z.object({
  source_is_mock: z.literal(true),
  address: z.string(),
  parcel: z.string(),
  setbacks_compliant: z.boolean(),
  lot_coverage_compliant: z.boolean(),
  height_compliant: z.boolean(),
  parking_compliant: z.boolean(),
  flood_elevation_checked: z.literal(false),
  fire_access_checked: z.literal(false),
  evidence_limit: z.string(),
})

const StructuralAudit = z.object({
  source_is_mock: z.literal(true),
  occupancy: z.string(),
  loads_adequate: z.boolean(),
  lateral_system_adequate: z.boolean(),
  foundation_note: z.string(),
  below_floor_elevation_checked: z.literal(false),
  evidence_limit: z.string(),
})

const PermitDecision = z.object({
  source_is_mock: z.literal(true),
  address: z.string(),
  parcel: z.string(),
  decision: z.enum(['APPROVE', 'CONDITIONAL', 'DENY']),
  summary: z.string(),
  failed_requirements: z.array(z.object({
    requirement: z.string(),
    source: z.string(),
    evidence: z.string(),
  })),
  conditions: z.array(z.string()),
  supporting_evidence: z.array(z.object({
    source: z.string(),
    finding: z.string(),
  })),
  evidence_limitations: z.array(z.string()),
  required_resubmittals: z.array(z.string()),
  revision_notes: z.array(z.string()),
})
type PermitDecision = z.infer<typeof PermitDecision>

const JudgeVerdict = z.object({
  accept: z.boolean(),
  critique: z.string(),
})

// Capture both proposer calls to prove that the verify loop changed the
// structured decision rather than merely appending a warning after the fact.
const proposalAttempts: PermitDecision[] = []

function captureProposal(result: AgentRunResult): AgentRunResult {
  const parsed = PermitDecision.safeParse(result.structured)
  if (parsed.success) proposalAttempts.push(parsed.data)
  return result
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

const sitePlanAnalyst: AgentConfig = {
  name: 'site-plan-analyst',
  ...providerConfig,
  systemPrompt: `You audit only the provided MOCK applicant site plan.
Check setbacks, lot coverage, height, and parking against the stated limits.
You have no floodplain overlay, so flood_elevation_checked must be false, and
you have no fire-access evidence, so fire_access_checked must be false. State
both limitations. Return only schema-valid JSON.`,
  outputSchema: SitePlanAudit,
  maxTurns: 1,
  maxTokens: 1200,
  temperature: 0,
}

const structuralAnalyst: AgentConfig = {
  name: 'structural-analyst',
  ...providerConfig,
  systemPrompt: `You audit only the provided MOCK structural summary. Report
whether the stated loads and lateral system are adequate for the occupancy.
You cannot verify anything below the finished floor, so
below_floor_elevation_checked must be false and you must state that
limitation. Return only schema-valid JSON.`,
  outputSchema: StructuralAudit,
  maxTurns: 1,
  maxTokens: 1000,
  temperature: 0,
}

const decisionProposer: AgentConfig = {
  name: 'permit-decision-proposer',
  ...providerConfig,
  systemPrompt: `You produce an auditable residential building-permit decision.

On the initial call, use only the dependency evidence supplied to the task. If
the site plan and structural audits show local compliance, issue a provisional
APPROVE while explicitly listing every unverified overlay or access
assumption. Do not invent floodplain or fire-access facts.

On a revision call, reviewer critiques are new evidence from source-specific
judges. Address every critique, cite exact source values and measurements,
and change the decision when the code requires it. Preserve each literal
source filename from the critiques in the matching
failed_requirements[].source; in this recipe those filenames are
flood-overlay.json and fire-access-report.txt. An elevation below
BFE-plus-freeboard or an access route below code minimums must never remain
APPROVE. Return only schema-valid JSON.`,
  outputSchema: PermitDecision,
  afterRun: captureProposal,
  maxTurns: 1,
  maxTokens: 2400,
  temperature: 0,
}

const floodJudge: AgentConfig = {
  name: 'flood-overlay-judge',
  ...providerConfig,
  systemPrompt: 'You are an independent floodplain compliance reviewer.',
  outputSchema: JudgeVerdict,
  maxTurns: 1,
  maxTokens: 900,
  temperature: 0,
}

const fireAccessJudge: AgentConfig = {
  name: 'fire-access-judge',
  ...providerConfig,
  systemPrompt: 'You are an independent fire-access and life-safety reviewer.',
  outputSchema: JudgeVerdict,
  maxTurns: 1,
  maxTokens: 900,
  temperature: 0,
}

const judgeInstructions: Record<string, string> = {
  'flood-overlay-judge': `Review only floodplain continuity using the MOCK
source below. Apply its stated bridge invariant exactly. Reject any APPROVE
decision when the proposed lowest floor does not reach BFE plus freeboard. A
revised decision passes only if it is CONDITIONAL or DENY, records the 10.8 ft
vs 13.0 ft shortfall, conditions the permit on a registered elevation
certificate plus plan revision, and cites the literal filename
flood-overlay.json in the matching failed requirement. When dissenting,
include flood-overlay.json verbatim in the critique so the proposer can
preserve it in the revised decision.

## Judge-only MOCK source: flood-overlay.json
${floodOverlay}`,
  'fire-access-judge': `Review only fire-access compliance using the two MOCK
sources below. Reject any APPROVE decision when the access width, turnaround,
or hydrant distance is below code or unverified. A revised decision passes
only if it is CONDITIONAL or DENY, records the 18 ft vs 20 ft width shortfall,
the missing turnaround on a 210 ft dead-end, and the 420 ft vs 300 ft hydrant
distance, and conditions the permit on corrected access plus re-review. The
matching failed requirement must cite the literal filename
fire-access-report.txt. When dissenting, include fire-access-report.txt
verbatim in the critique so the proposer can preserve it in the revised
decision.

## Judge-only MOCK source: fire-access-report.txt
${fireAccessReport}

## Judge-only MOCK source: fire-code-excerpt.md
${fireCodeExcerpt}`,
}

// ---------------------------------------------------------------------------
// Task DAG and verify configuration
// ---------------------------------------------------------------------------

const tasks: RunTaskSpec[] = [
  {
    title: 'audit-site-plan',
    description: `Audit this isolated MOCK site plan.\n\n${sitePlan}`,
    assignee: 'site-plan-analyst',
  },
  {
    title: 'audit-structural',
    description: `Audit this isolated MOCK structural summary.\n\n${structuralSummary}`,
    assignee: 'structural-analyst',
  },
  {
    title: 'propose-permit-decision',
    description: `Using only the two structured dependency results, decide
whether the residential permit for 418 Alder Street can issue. Produce the
complete Permit Decision Report. This is a provisional thesis: do not assume
that floodplain or fire-access evidence was checked unless it appears in the
dependencies.`,
    assignee: 'permit-decision-proposer',
    dependsOn: ['audit-site-plan', 'audit-structural'],
    dependencyPayload: 'structured',
    verify: {
      judges: [floodJudge, fireAccessJudge],
      quorum: 2,
      maxRounds: 2,
      onDissent: 'revise',
      verdictSchema: JudgeVerdict,
      judgePrompt: (judgeName: string) =>
        judgeInstructions[judgeName] ??
        'Reject because this judge has no source-specific review instruction.',
    },
  },
]

const consensusEvents: ConsensusTrace[] = []

function collectTrace(event: TraceEvent): void {
  if (event.type === 'consensus') consensusEvents.push(event)
}

const orchestrator = new OpenMultiAgent({
  defaultProvider: 'anthropic',
  defaultModel: MODEL,
  onTrace: collectTrace,
})

const team = orchestrator.createTeam('building-permit-review-team', {
  name: 'building-permit-review-team',
  agents: [sitePlanAnalyst, structuralAnalyst, decisionProposer],
  sharedMemory: true,
})

// ---------------------------------------------------------------------------
// Execute and prove the intended conflict/revision path
// ---------------------------------------------------------------------------

function expectedPathAssertions(
  decision: PermitDecision,
): Array<{ name: string; pass: boolean }> {
  const roundOneJudges = new Set(
    consensusEvents.filter((event) => event.round === 1).map((event) => event.agent),
  )
  const roundTwoAccepted = new Set(
    consensusEvents
      .filter((event) => event.round === 2 && event.accepted)
      .map((event) => event.agent),
  )
  const elevationRecorded = decision.failed_requirements.some(
    (item) => item.evidence.includes('10.8') && item.evidence.includes('13.0'),
  )
  const accessWidthRecorded = decision.failed_requirements.some(
    (item) => item.evidence.includes('18 ft') && item.evidence.includes('20 ft'),
  )
  const evidenceSources = new Set(decision.failed_requirements.map((item) => item.source))
  const hasRemediation = decision.required_resubmittals.some((item) =>
    /elevation certificate|turnaround|hydrant|widen/i.test(item),
  )

  return [
    {
      name: 'the seeded first proposal is APPROVE',
      pass: proposalAttempts[0]?.decision === 'APPROVE',
    },
    {
      name: 'judge dissent revises the proposal to CONDITIONAL',
      pass: proposalAttempts.at(-1)?.decision === 'CONDITIONAL',
    },
    {
      name: 'both source-specific judges run in round one',
      pass: ['flood-overlay-judge', 'fire-access-judge'].every((judge) =>
        roundOneJudges.has(judge),
      ),
    },
    {
      name: 'both source-specific judges accept the revised decision',
      pass: roundTwoAccepted.size === 2,
    },
    {
      name: 'the revised decision records the 10.8 ft vs 13.0 ft elevation shortfall',
      pass: elevationRecorded,
    },
    {
      name: 'the revised decision records the 18 ft vs 20 ft access-width shortfall',
      pass: accessWidthRecorded,
    },
    {
      name: 'the revised decision cites flood-overlay.json',
      pass: [...evidenceSources].some((source) => source.includes('flood-overlay.json')),
    },
    {
      name: 'the revised decision cites fire-access-report.txt',
      pass: [...evidenceSources].some((source) => source.includes('fire-access-report.txt')),
    },
    {
      name: 'the revised decision requires a concrete resubmittal',
      pass: hasRemediation,
    },
  ]
}

async function main(): Promise<void> {
  console.log('Residential Building Permit Review Gate')
  console.log('='.repeat(64))
  console.log('All inputs are MOCK. No municipal system will be contacted.\n')

  const result = await orchestrator.runTasks(team, tasks)
  if (!result.success) throw new Error('The building-permit review workflow failed.')

  const decisionTask = result.tasks?.find((task) => task.title === 'propose-permit-decision')
  const decisionResult = decisionTask ? result.taskResults?.get(decisionTask.id) : undefined
  const decision = PermitDecision.parse(decisionResult?.structured)

  console.log(`Decision path: ${proposalAttempts.map((item) => item.decision).join(' -> ')}`)
  console.log('\nJudge audit trail:')
  for (const event of consensusEvents) {
    const verdict = event.accepted ? 'ACCEPT' : 'DISSENT'
    console.log(`  round ${event.round} | ${event.agent} | ${verdict}`)
    if (event.dissent) console.log(`    ${event.dissent}`)
  }

  console.log('\nVerified Permit Decision Report:')
  console.log(JSON.stringify(decision, null, 2))

  console.log('\n## Runtime Assertions\n')
  let hasFailure = false
  for (const assertion of expectedPathAssertions(decision)) {
    console.log(`- ${assertion.pass ? 'PASS' : 'FAIL'}: ${assertion.name}`)
    if (!assertion.pass) hasFailure = true
  }

  if (hasFailure) {
    console.error('Runtime assertion failed.')
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exitCode = 1
})
