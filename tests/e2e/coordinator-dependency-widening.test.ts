/**
 * E2E regression test: coordinator must not widen `dependsOn` beyond what an
 * agent's system prompt declares as its input.
 *
 * Uses `planOnly: true` so the coordinator decomposition call hits the real
 * LLM but no worker tasks execute — cheap to run.
 *
 * BEFORE the fixes (truncation + weak guidance):
 *   FAILS — the coordinator adds extra parents to agents with brief input
 *   declarations (e.g. frontend-planner and backend-planner pick up
 *   security-auditor and threat-modeler even though their prompts only name
 *   the architectural blueprint).
 *
 * AFTER the fixes:
 *   PASSES — coordinator sees full prompts and is guided to prefer the
 *   minimum upstream set declared by each agent's system prompt.
 *
 * Skipped by default. Run with: RUN_E2E=1 npm run test:e2e
 * Requires: ANTHROPIC_API_KEY environment variable
 *
 * Reproducer: https://github.com/CodingBangboo/open-multi-agent/blob/planOnly_with_examples/examples/basics/plan-only-dag_stress_test.ts
 * Issue: https://github.com/open-multi-agent/open-multi-agent/issues/208
 */
import { describe, it, expect } from 'vitest'
import { OpenMultiAgent } from '../../src/orchestrator/orchestrator.js'
import type { AgentConfig, TeamConfig } from '../../src/types.js'

const describeE2E = process.env['RUN_E2E'] ? describe : describe.skip

// Match the model used in the original reproducer.
const MODEL = 'claude-sonnet-4-6'

// System prompts copied verbatim from the reproducer so this test exercises
// the same coordinator inputs that produced the bug.
const roster: AgentConfig[] = [
  {
    name: 'requirements-analyst',
    model: MODEL,
    provider: 'anthropic',
    systemPrompt:
      'You gather and document functional and non-functional requirements for software systems. ' +
      'Output user stories, acceptance criteria, and constraints.',
  },
  {
    name: 'architect',
    model: MODEL,
    provider: 'anthropic',
    // Brief: "consume requirements" only — security-auditor must NOT be wired in.
    systemPrompt:
      'You design system architecture: services, data models, API contracts, deployment topology. ' +
      'You consume requirements and produce an architectural blueprint.',
  },
  {
    name: 'security-auditor',
    model: MODEL,
    provider: 'anthropic',
    systemPrompt:
      'You audit requirements for security and compliance concerns (auth flows, PII, OWASP, regulatory). ' +
      'Output a security requirements addendum.',
  },
  {
    name: 'frontend-planner',
    model: MODEL,
    provider: 'anthropic',
    // Brief: "consume the architectural blueprint" only — security + threat must NOT be wired in.
    systemPrompt:
      'You plan the frontend implementation: pages, components, state management, API integration. ' +
      'You consume the architectural blueprint.',
  },
  {
    name: 'backend-planner',
    model: MODEL,
    provider: 'anthropic',
    // Brief: "consume the architectural blueprint" only — security + threat must NOT be wired in.
    systemPrompt:
      'You plan the backend implementation: services, endpoints, persistence, integrations. ' +
      'You consume the architectural blueprint.',
  },
  {
    name: 'threat-modeler',
    model: MODEL,
    provider: 'anthropic',
    // Exhaustive: "Both inputs are required" — architect + security MUST both be wired.
    systemPrompt:
      'You produce a threat model (STRIDE, attack trees) by combining the architectural blueprint ' +
      'with the security requirements addendum. Both inputs are required.',
  },
  {
    name: 'project-manager',
    model: MODEL,
    provider: 'anthropic',
    // Exhaustive: all six artefacts listed — all 6 deps must be wired.
    systemPrompt:
      'You aggregate all upstream planning artefacts (requirements, architecture, security, ' +
      'frontend plan, backend plan, threat model) into a final delivery plan with milestones, ' +
      'risks, and ownership.',
  },
]

const teamCfg: TeamConfig = {
  name: 'auth-planning',
  agents: roster,
  sharedMemory: true,
}

// Detailed goal from the reproducer — generic goals produce simpler DAGs that
// may not trigger the dependency-widening behaviour.
const GOAL = `Produce a complete delivery plan for a new User Authentication Service.
Scope:
- Email/password sign-up + sign-in
- OAuth (Google, GitHub) sign-in
- Session management with refresh tokens
- Password reset via email
- Audit logging
- Admin dashboard for user management
The final output must be a project plan with milestones, owner per milestone, identified risks \
(including security threats), and dependency ordering across frontend and backend work.`

describeE2E('coordinator dependency widening — E2E (planOnly)', () => {
  it('respects brief input declarations — does not add unrelated upstream deps', async () => {
    const oma = new OpenMultiAgent({
      defaultModel: MODEL,
      defaultProvider: 'anthropic',
    })
    const team = oma.createTeam('auth-planning', teamCfg)

    const result = await oma.runTeam(team, GOAL, { planOnly: true })

    // A failed coordinator (e.g. missing API key) returns success: false and
    // triggers the one-task-per-agent fallback with empty deps. Catch that
    // early so the error is obvious rather than collapsing into a confusing
    // empty-dependsOn assertion below.
    expect(result.success, 'coordinator decomposition failed — check ANTHROPIC_API_KEY').toBe(true)
    expect(result.planOnly).toBe(true)
    expect(result.tasks).toBeDefined()
    expect(result.tasks!.length).toBeGreaterThanOrEqual(6)

    const byAssignee = (name: string) => {
      const task = result.tasks!.find(t => t.assignee === name)
      if (!task) throw new Error(`No task found for assignee "${name}"`)
      return task
    }

    const requirementsTask = byAssignee('requirements-analyst')
    const securityTask     = byAssignee('security-auditor')
    const architectTask    = byAssignee('architect')
    const threatTask       = byAssignee('threat-modeler')
    const frontendTask     = byAssignee('frontend-planner')
    const backendTask      = byAssignee('backend-planner')

    // ── Bug cases: brief declarations must not be widened ──────────────────

    // architect only says "consume requirements" → security must NOT appear
    expect(architectTask.dependsOn).toContain(requirementsTask.id)
    expect(architectTask.dependsOn).not.toContain(securityTask.id)

    // frontend only says "consume the architectural blueprint" → security + threat must NOT appear
    expect(frontendTask.dependsOn).toContain(architectTask.id)
    expect(frontendTask.dependsOn).not.toContain(securityTask.id)
    expect(frontendTask.dependsOn).not.toContain(threatTask.id)

    // backend only says "consume the architectural blueprint" → security + threat must NOT appear
    expect(backendTask.dependsOn).toContain(architectTask.id)
    expect(backendTask.dependsOn).not.toContain(securityTask.id)
    expect(backendTask.dependsOn).not.toContain(threatTask.id)

    // ── Known-good: exhaustive declarations must still be fully wired ──────

    // threat-modeler says "Both inputs are required" → architect + security must both appear
    expect(threatTask.dependsOn).toContain(architectTask.id)
    expect(threatTask.dependsOn).toContain(securityTask.id)
  }, 90_000)
})
