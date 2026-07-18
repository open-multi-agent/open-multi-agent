# Evaluation

The experimental `@open-multi-agent/core/eval` subpath defines quality scorers for offline regression checks and future online sampling. Evaluation runs outside the business execution path: it observes a result but never changes that result.

## Define a scorer

```ts
import { defineScorer, type ScorerContext } from '@open-multi-agent/core/eval'

const exact = defineScorer({
  name: 'exact-match',
  version: '1',
  score({ output, evalCase }) {
    const hit = output === evalCase.expected
    return { score: hit ? 1 : 0, pass: hit }
  },
})

const context: ScorerContext = {
  evalCase: { id: 'capital-france', input: 'Capital of France?', expected: 'Paris' },
  output: 'Paris',
  metadata: { promptVersion: 'v2' },
  signal: new AbortController().signal,
}

const result = await exact.score(context)
console.log(result.score) // 1
```

Scores must be finite numbers from `0` through `1`. `pass` is optional so a later gate can apply its own threshold. `defineScorer()` freezes the scorer definition and validates both synchronous and asynchronous results.

## Scorer failures are not zero scores

A scorer that throws, rejects, or exceeds its timeout has not measured quality. Callers must record that outcome as an `EvalRecord` with `status: 'scorer_error'`, normalize the error with `classifyRunFailure()`, and exclude it from score averages, percentiles, and pass rates. Do not replace scorer failures with `{ score: 0 }`.

The eval subpath defines the `EvalRecord` shape and schema major version. Eval runners and stores are separate, later capabilities.

## Use OMA agents as judges

```ts
import { z } from 'zod'
import { createJudgeScorer } from '@open-multi-agent/core/eval'

const relevancy = createJudgeScorer({
  name: 'relevancy',
  version: 'prompt-v1',
  judges: [
    { name: 'judge-a', model: 'claude-sonnet-4-6', provider: 'anthropic' },
    { name: 'judge-b', model: 'gpt-5', provider: 'openai' },
  ],
  quorum: 2,
  timeoutMs: 30_000,
  verdictSchema: z.object({
    score: z.number().min(0).max(1),
    pass: z.boolean(),
    reason: z.string(),
  }),
})

const result = await relevancy.score(context)
console.log(result.score, result.pass)
```

Judge scores are averaged. When the verdict schema returns a boolean `pass`, the scorer returns `pass: true` after the configured quorum is reached. The default verdict schema contains only `score` and `reason`, so the default result leaves `pass` undefined.

`result.details.judges`, `result.details.models`, and `result.details.scores` are parallel arrays: values at the same index describe one judge. This flat representation remains compatible with trace attribute values while preserving model-drift evidence. Bump the scorer `version` whenever judge models, configuration, or prompts change.

## Runtime verification versus evaluation

Use `runConsensus()` or per-task `verify` to accept, revise, or reject a result during a live business run. Use scorers to measure regressions and trends after or alongside a run. Runtime verification can affect the business result; evaluation never does. The two mechanisms can be used together.
