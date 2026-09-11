import { buildStructuredOutputInstruction } from '@open-multi-agent/core'
import type { ZodSchema } from 'zod'
import { describe, expect, it } from 'vitest'
import {
  buildReleaseDecision,
  changeAnalysisSchema,
  compatibilityAnalysisSchema,
  normalizeReleaseProposal,
  releaseProposalSchema,
  releaseReviewSchema,
  type ReleaseEvidence,
} from '../src/schema.js'

const evidence: ReleaseEvidence = {
  schemaVersion: 1,
  generatedAt: '2026-08-10T00:00:00.000Z',
  baseTag: 'v1.14.0',
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  versions: { core: '1.14.0', otel: '0.1.1', createOmaApp: '0.7.0' },
  commits: [{ sha: 'b'.repeat(40), subject: 'feat: add recovery', body: '' }],
  changedFiles: [{ path: 'packages/core/src/index.ts', additions: 2, deletions: 0 }],
  changelogUnreleased: '',
  workspaceChanges: { core: true, otel: false, createOmaApp: false, docs: false, workflows: false },
}

const proposal = {
  decision: 'release' as const,
  coreBump: 'minor' as const,
  createOmaAppBump: 'minor' as const,
  otelBump: 'none' as const,
  summary: 'Release durable recovery support.',
  changelog: {
    breakingChanges: [],
    added: ['Durable recovery resumes interrupted agent turns.'],
    changed: [],
    fixed: [],
    security: [],
    compatibility: ['Existing checkpoint readers remain supported.'],
  },
  risks: [],
  rationale: ['The merged feature is user-visible and additive.'],
}

const review = {
  verdict: 'approve' as const,
  issues: [],
  rationale: ['The proposal matches the evidence and package rules.'],
}

describe('release decision', () => {
  it('normalizes a core-only scaffolder bump before independent review', () => {
    expect(normalizeReleaseProposal(evidence, proposal).createOmaAppBump).toBe('patch')
  })

  it('maps a core-only major (breaking) to a create-oma-app minor', () => {
    const majorProposal = {
      ...proposal,
      coreBump: 'major' as const,
      changelog: {
        ...proposal.changelog,
        breakingChanges: ['Existing callers must migrate to the new input shape.'],
      },
    }
    expect(normalizeReleaseProposal(evidence, majorProposal).createOmaAppBump).toBe('minor')
  })

  it('calculates concrete versions only after independent approval', () => {
    const decision = buildReleaseDecision(evidence, proposal, review, '2026-08-10')
    expect(decision.status).toBe('release')
    if (decision.status !== 'release') throw new Error('expected release')
    expect(decision.plan.nextVersions).toEqual({
      core: '1.15.0',
      otel: '0.1.1',
      createOmaApp: '0.7.1',
    })
    expect(decision.plan.bumps.otel).toBeNull()
    expect(decision.plan.bumps.createOmaApp).toBe('patch')
  })

  it('uses the proposed scaffolder bump only when its workspace changed', () => {
    const decision = buildReleaseDecision({
      ...evidence,
      workspaceChanges: { ...evidence.workspaceChanges, createOmaApp: true },
    }, proposal, review, '2026-08-10')
    expect(decision.status).toBe('release')
    if (decision.status !== 'release') throw new Error('expected release')
    expect(decision.plan.nextVersions.createOmaApp).toBe('0.8.0')
    expect(decision.plan.bumps.createOmaApp).toBe('minor')
  })

  it('bumps create-oma-app minor when a core-only release is major (breaking)', () => {
    const decision = buildReleaseDecision(evidence, {
      ...proposal,
      coreBump: 'major' as const,
      changelog: {
        ...proposal.changelog,
        breakingChanges: ['Existing callers must migrate to the new input shape.'],
      },
    }, review, '2026-08-10')
    expect(decision.status).toBe('release')
    if (decision.status !== 'release') throw new Error('expected release')
    expect(decision.plan.nextVersions).toEqual({
      core: '2.0.0',
      otel: '0.1.1',
      createOmaApp: '0.8.0',
    })
    expect(decision.plan.bumps.createOmaApp).toBe('minor')
  })

  it('keeps reviewer rejection fail-closed', () => {
    const decision = buildReleaseDecision(evidence, proposal, {
      ...review,
      verdict: 'reject',
      issues: ['Public compatibility evidence is incomplete.'],
    })
    expect(decision.status).toBe('rejected')
  })

  it('surfaces reviewer rejection even when the planner proposed no release', () => {
    const decision = buildReleaseDecision(evidence, {
      ...proposal,
      decision: 'none',
      coreBump: 'none',
      createOmaAppBump: 'none',
      otelBump: 'none',
    }, {
      ...review,
      verdict: 'reject',
      issues: ['Evidence is incomplete.'],
    })
    expect(decision.status).toBe('rejected')
  })

  it('requires an OTel bump exactly when that workspace changed', () => {
    const otelEvidence = {
      ...evidence,
      workspaceChanges: { ...evidence.workspaceChanges, otel: true },
    }
    expect(() => buildReleaseDecision(otelEvidence, proposal, review)).toThrow(/must increment/)
    expect(() => buildReleaseDecision(evidence, { ...proposal, otelBump: 'patch' }, review)).toThrow(/must not increment/)
  })

  it('rejects internally inconsistent no-release output at schema validation', () => {
    expect(() => releaseProposalSchema.parse({
      ...proposal,
      decision: 'none',
      coreBump: 'patch',
      createOmaAppBump: 'none',
    })).toThrow()
  })

  it('rejects multiline model-authored changelog entries', () => {
    expect(() => releaseProposalSchema.parse({
      ...proposal,
      changelog: { ...proposal.changelog, added: ['safe line\nmalicious heading'] },
    })).toThrow(/single line/)
  })

  it('never permits a breaking change to ship as a patch', () => {
    expect(() => releaseProposalSchema.parse({
      ...proposal,
      coreBump: 'patch',
      changelog: {
        ...proposal.changelog,
        breakingChanges: ['Existing callers must migrate to the new input shape.'],
      },
    })).toThrow(/breaking changes cannot ship as a patch/)
  })
})

describe('structured-output schema shape', () => {
  // The model receives each schema as the JSON Schema embedded in its system
  // prompt and emits the properties in that order. A nested object followed by
  // another root-level property makes it close the nested object mid-answer,
  // and twice it did not: change-analyst on 2026-09-04 and release-planner on
  // 2026-09-11 both put the trailing root properties inside `changelog` and
  // then ran out of matching brackets. Keeping every nested object last removes
  // the boundary rather than relying on the model to hold it.
  const schemas = {
    changeAnalysisSchema,
    compatibilityAnalysisSchema,
    releaseProposalSchema,
    releaseReviewSchema,
  }

  function propertyTypes(schema: ZodSchema): Array<[string, string]> {
    const instruction = buildStructuredOutputInstruction(schema)
    const fenced = instruction.match(/```\n([\s\S]*?)\n```/)
    expect(fenced?.[1], 'instruction embeds a fenced JSON Schema').toBeDefined()
    const jsonSchema = JSON.parse(fenced![1]!) as {
      properties?: Record<string, { type?: string }>
    }
    expect(jsonSchema.properties, 'JSON Schema exposes properties').toBeDefined()
    return Object.entries(jsonSchema.properties!).map(([name, value]) => [name, value.type ?? ''])
  }

  for (const [label, schema] of Object.entries(schemas)) {
    it(`keeps every nested object last in ${label}`, () => {
      const entries = propertyTypes(schema)
      const lastObjectIndex = entries.map(([, type]) => type).lastIndexOf('object')
      if (lastObjectIndex === -1) return
      expect(
        entries.slice(lastObjectIndex).map(([name]) => name),
        'no property may follow a nested object',
      ).toEqual([entries[lastObjectIndex]![0]])
    })
  }
})
