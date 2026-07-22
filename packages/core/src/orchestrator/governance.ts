import type { AgentConfig, RunTaskSpec, RunTeamOptions } from '../types.js'

/**
 * Build the explicit role topology requested by a structured governance
 * declaration. `undefined` means the caller selected the legacy automatic
 * `runTeam()` route.
 */
export function buildGovernanceTaskSpecs(
  goal: string,
  agentConfigs: readonly AgentConfig[],
  options?: RunTeamOptions,
): readonly RunTaskSpec[] | undefined {
  const intent = options?.governanceIntent
  if (intent !== 'required' && intent !== 'preferred') return undefined

  const requiredRoles = options?.requiredRoles ?? []
  if (requiredRoles.length === 0) {
    throw new Error(
      `runTeam governanceIntent '${intent}' requires at least one role in requiredRoles.`,
    )
  }

  const duplicateRoles = findDuplicates(requiredRoles)
  if (duplicateRoles.length > 0) {
    throw new Error(
      `runTeam requiredRoles must contain unique team agent names; duplicate role(s): ${duplicateRoles.join(', ')}.`,
    )
  }

  const rosterNames = new Set(agentConfigs.map((agent) => agent.name))
  const unknownRoles = requiredRoles.filter((role) => !rosterNames.has(role))
  if (unknownRoles.length > 0) {
    throw new Error(
      `runTeam requiredRoles must exist in the team roster; unknown role(s): ${unknownRoles.join(', ')}.`,
    )
  }

  const requiredOrder = options?.requiredOrder
  if (requiredOrder !== undefined) {
    const declaredRoles = new Set(requiredRoles)
    const unknownOrderRoles = requiredOrder.filter((role) => !declaredRoles.has(role))
    if (unknownOrderRoles.length > 0) {
      throw new Error(
        `runTeam requiredOrder may reference only requiredRoles; invalid role(s): ${unknownOrderRoles.join(', ')}.`,
      )
    }

    const duplicateOrderRoles = findDuplicates(requiredOrder)
    if (duplicateOrderRoles.length > 0) {
      throw new Error(
        `runTeam requiredOrder must contain each required role once; duplicate role(s): ${duplicateOrderRoles.join(', ')}.`,
      )
    }

    if (requiredOrder.length !== requiredRoles.length) {
      const orderedRoles = new Set(requiredOrder)
      const missingRoles = requiredRoles.filter((role) => !orderedRoles.has(role))
      throw new Error(
        `runTeam requiredOrder must be a permutation of requiredRoles; missing role(s): ${missingRoles.join(', ')}.`,
      )
    }
  }

  const executionOrder = requiredOrder ?? requiredRoles
  // Keep task text role-neutral: assignment selects the roster agent, whose
  // systemPrompt owns the role semantics. Titles exist only for dependency IDs.
  const titleByRole = new Map(
    executionOrder.map((role, index) => [role, `Governance task ${index + 1}`]),
  )

  return executionOrder.map((role, index) => ({
    title: titleByRole.get(role)!,
    description: goal,
    assignee: role,
    ...(index > 0 && requiredOrder !== undefined
      ? { dependsOn: [titleByRole.get(executionOrder[index - 1]!)!] }
      : {}),
    memoryScope: 'dependencies',
  }))
}

function findDuplicates(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value)
    seen.add(value)
  }
  return [...duplicates]
}
