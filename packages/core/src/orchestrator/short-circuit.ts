/**
 * @fileoverview Short-circuit helpers: decide when a goal is simple enough to
 * skip coordinator decomposition, and pick the best-matching agent for it.
 *
 * Exported for unit testing and re-exported from the orchestrator barrel so the
 * public `isSimpleGoal` / `selectBestAgent` import paths stay stable.
 */

import type { AgentConfig } from '../types.js'
import { extractKeywords, keywordScore } from '../utils/keywords.js'

/**
 * Regex patterns that indicate a goal requires multi-agent coordination.
 *
 * Each pattern targets a distinct complexity signal:
 * - Sequencing:     "first … then", "step 1 / step 2", numbered lists
 * - Coordination:   "collaborate", "coordinate", "review each other"
 * - Parallel work:  "in parallel", "at the same time", "concurrently"
 * - Multi-phase:    "phase", "stage", multiple distinct action verbs joined by connectives
 */
export const COMPLEXITY_PATTERNS: RegExp[] = [
  // Explicit sequencing
  /\bfirst\b.{3,60}\bthen\b/i,
  /\bstep\s*\d/i,
  /\bphase\s*\d/i,
  /\bstage\s*\d/i,
  /^\s*\d+[\.\)]/m,                       // numbered list items ("1. …", "2) …")

  // Coordination language — must be an imperative directive aimed at the agents
  // ("collaborate with X", "coordinate the team", "agents should coordinate"),
  // not a descriptive use ("how does X coordinate with Y" / "what does collaboration mean").
  // Match either an explicit preposition or a noun-phrase that names a group.
  /\bcollaborat(?:e|ing)\b\s+(?:with|on|to)\b/i,
  /\bcoordinat(?:e|ing)\b\s+(?:with|on|across|between|the\s+(?:team|agents?|workers?|effort|work))\b/i,
  /\breview\s+each\s+other/i,
  /\bwork\s+together\b/i,

  // Parallel execution
  /\bin\s+parallel\b/i,
  /\bconcurrently\b/i,
  /\bat\s+the\s+same\s+time\b/i,

  // Multiple deliverables joined by connectives
  // Matches patterns like "build X, then deploy Y and test Z"
  /\b(?:build|create|implement|design|write|develop)\b.{5,80}\b(?:and|then)\b.{5,80}\b(?:build|create|implement|design|write|develop|test|review|deploy)\b/i,
]

/**
 * Maximum goal length (in characters) below which a goal *may* be simple.
 *
 * Goals longer than this threshold almost always contain enough detail to
 * warrant multi-agent decomposition. The value is generous — short-circuit
 * is meant for genuinely simple, single-action goals.
 */
export const SIMPLE_GOAL_MAX_LENGTH = 200

/**
 * Determine whether a goal is simple enough to skip coordinator decomposition.
 *
 * A goal is considered "simple" when ALL of the following hold:
 *   1. Its length is ≤ {@link SIMPLE_GOAL_MAX_LENGTH}.
 *   2. It does not match any {@link COMPLEXITY_PATTERNS}.
 *
 * The complexity patterns are deliberately conservative — they only fire on
 * imperative coordination directives (e.g. "collaborate with the team",
 * "coordinate the workers"), so descriptive uses ("how do pods coordinate
 * state", "explain microservice collaboration") remain classified as simple.
 *
 * Exported for unit testing.
 */
export function isSimpleGoal(goal: string): boolean {
  if (goal.length > SIMPLE_GOAL_MAX_LENGTH) return false
  return !COMPLEXITY_PATTERNS.some((re) => re.test(goal))
}

/**
 * Select the best-matching agent for a goal using keyword affinity scoring.
 *
 * The scoring logic mirrors {@link Scheduler}'s `capability-match` strategy
 * exactly, including its asymmetric use of the agent's `model` field:
 *
 *  - `agentKeywords` is computed from `name + systemPrompt + model` so that
 *    a goal which mentions a model name (e.g. "haiku") can boost an agent
 *    bound to that model.
 *  - `agentText` (used for the reverse direction) is computed from
 *    `name + systemPrompt` only — model names should not bias the
 *    text-vs-goal-keywords match.
 *
 * The two-direction sum (`scoreA + scoreB`) ensures both "agent describes
 * goal" and "goal mentions agent capability" contribute to the final score.
 *
 * Exported for unit testing.
 */
export function selectBestAgent(goal: string, agents: AgentConfig[]): AgentConfig {
  if (agents.length <= 1) return agents[0]!

  const goalKeywords = extractKeywords(goal)

  let bestAgent = agents[0]!
  let bestScore = -1

  for (const agent of agents) {
    const agentText = `${agent.name} ${agent.systemPrompt ?? ''}`
    // Mirror Scheduler.capability-match: include `model` here only.
    const agentKeywords = extractKeywords(`${agent.name} ${agent.systemPrompt ?? ''} ${agent.model}`)

    const scoreA = keywordScore(agentText, goalKeywords)
    const scoreB = keywordScore(goal, agentKeywords)
    const score = scoreA + scoreB

    if (score > bestScore) {
      bestScore = score
      bestAgent = agent
    }
  }

  return bestAgent
}
