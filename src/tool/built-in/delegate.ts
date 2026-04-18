/**
 * @fileoverview Built-in `delegate_to_agent` tool for synchronous handoff to a roster agent.
 */

import { z } from 'zod'
import type { ToolDefinition, ToolResult, ToolUseContext } from '../../types.js'

const inputSchema = z.object({
  target_agent: z.string().min(1).describe('Name of the team agent to run the sub-task.'),
  prompt: z.string().min(1).describe('Instructions / question for the target agent.'),
})

/**
 * Delegates a sub-task to another agent on the team and returns that agent's final text output.
 *
 * Only available when the orchestrator injects {@link ToolUseContext.team} with
 * `runDelegatedAgent` (pool-backed `runTeam` / `runTasks`). Standalone `runAgent`
 * does not register this tool by default.
 *
 * Nested {@link AgentRunResult.tokenUsage} from the delegated run is surfaced via
 * {@link ToolResult.metadata} so the parent runner can aggregate it into its total
 * (keeps `maxTokenBudget` accurate across delegation chains).
 */
export const delegateToAgentTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name: 'delegate_to_agent',
  description:
    'Run a sub-task on another agent from this team and return that agent\'s final answer as the tool result. ' +
    'Use when you need a specialist teammate to produce output you will incorporate. ' +
    'The target agent runs in a fresh conversation for this prompt only.',
  inputSchema,
  async execute(
    { target_agent: targetAgent, prompt },
    context: ToolUseContext,
  ): Promise<ToolResult> {
    const team = context.team
    if (!team?.runDelegatedAgent) {
      return {
        data:
          'delegate_to_agent is only available during orchestrated team runs with the delegation tool enabled. ' +
          'Use SharedMemory or explicit tasks instead.',
        isError: true,
      }
    }

    if (targetAgent === context.agent.name) {
      return {
        data: 'Cannot delegate to yourself; use another team member.',
        isError: true,
      }
    }

    if (!team.agents.includes(targetAgent)) {
      return {
        data: `Unknown agent "${targetAgent}". Roster: ${team.agents.join(', ')}`,
        isError: true,
      }
    }

    const chain = team.delegationChain ?? []
    if (chain.includes(targetAgent)) {
      return {
        data:
          `Delegation cycle detected: ${[...chain, targetAgent].join(' -> ')}. ` +
          'Pick a different target or restructure the plan.',
        isError: true,
      }
    }

    const depth = team.delegationDepth ?? 0
    const maxDepth = team.maxDelegationDepth ?? 3
    if (depth >= maxDepth) {
      return {
        data: `Maximum delegation depth (${maxDepth}) reached; cannot delegate further.`,
        isError: true,
      }
    }

    if (team.delegationPool !== undefined && team.delegationPool.availableRunSlots < 1) {
      return {
        data:
          'Agent pool has no free concurrency slot for a delegated run (nested run would block indefinitely). ' +
          'Increase orchestrator maxConcurrency, wait for parallel work to finish, or avoid delegating while the pool is saturated.',
        isError: true,
      }
    }

    const result = await team.runDelegatedAgent(targetAgent, prompt)

    if (team.sharedMemory) {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      const key = `delegation:${targetAgent}:${suffix}`
      try {
        await team.sharedMemory.set(`${context.agent.name}/${key}`, result.output, {
          agent: context.agent.name,
          delegatedTo: targetAgent,
          success: String(result.success),
        })
      } catch {
        // Audit is best-effort; do not fail the tool on store errors.
      }
    }

    return {
      data: result.output,
      isError: !result.success,
      metadata: { tokenUsage: result.tokenUsage },
    }
  },
}
