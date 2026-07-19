import { z } from 'zod'
import type { JudgeScorerOptions } from '../judge.js'
import { createJudgeScorer } from '../judge.js'
import type { Scorer } from '../scorer.js'

export interface AnswerRelevancyScorerOptions
  extends Omit<JudgeScorerOptions, 'name' | 'verdictSchema' | 'judgePrompt'> {
  readonly name?: string
}

const ANSWER_RELEVANCY_SCHEMA = z.object({
  score: z.number().min(0).max(1),
  reason: z.string(),
})

const ANSWER_RELEVANCY_PROMPT = [
  'Evaluate only answer relevancy.',
  'A fully relevant answer directly addresses the case input, stays on topic, and uses the expected output when one is supplied.',
  'Do not reward style, verbosity, or factual claims that are unrelated to the requested answer.',
  'Return a score from 0 to 1 and a concise reason.',
].join(' ')

/** Create a versionable answer-relevancy judge using OMA's generic judge scorer. */
export function createAnswerRelevancyScorer(options: AnswerRelevancyScorerOptions): Scorer {
  return createJudgeScorer({
    ...options,
    name: options.name ?? 'answer_relevancy',
    verdictSchema: ANSWER_RELEVANCY_SCHEMA,
    judgePrompt: ANSWER_RELEVANCY_PROMPT,
  })
}
