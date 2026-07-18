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

A scorer that throws, rejects, or exceeds its timeout has not measured quality. `runEvalSet()` records that outcome as an `EvalRecord` with `status: 'scorer_error'`, normalizes the error, continues to later scorers, and excludes the failure from score averages, percentiles, and pass rates. Do not replace scorer failures with `{ score: 0 }`.

If the target itself throws, the sample produces one `target_error` record under the reserved scorer name `_target`; its scorers do not run. The eval subpath also defines the `EvalRecord` shape and schema major version.

## Run an EvalSet offline

```ts
import {
  defineEvalSet,
  defineScorer,
  runEvalSet,
  type EvalTarget,
} from '@open-multi-agent/core/eval'

const set = defineEvalSet({
  name: 'greetings',
  version: '1.0.0',
  cases: [
    { id: 'a', input: 'hi', expected: 'HI', tags: ['upper'] },
    { id: 'b', input: 'yo', expected: 'YO', tags: ['upper'] },
  ],
  defaults: { concurrency: 2 },
})

const target: EvalTarget = async (input) => ({
  output: String(input).toUpperCase(),
})

const exact = defineScorer({
  name: 'exact',
  score({ output, evalCase }) {
    const pass = output === evalCase.expected
    return { score: pass ? 1 : 0, pass }
  },
})

const report = await runEvalSet(set, target, {
  scorers: [exact],
  repeats: 2,
  metadata: { prompt_version: 'v2' },
})

console.log(report.records.length)          // 4
console.log(report.aggregates[0]?.avg)      // 1
console.log(report.aggregates[0]?.passRate) // 1
```

`defineEvalSet()` validates non-empty names, versions, and cases; requires case IDs to be unique; and returns a deeply frozen copy. Treat `version` as the content version and bump it whenever cases change. `filterTags` selects cases matching any requested tag. `repeats` and `concurrency` override the set defaults.

Each case/repeat target runs once, then that sample's scorers run serially. Different samples run in parallel up to `concurrency` (default `2`). Aborting stops new samples from being scheduled, waits for already-started samples, and returns a partial report with `aborted: true`.

Report percentiles use the nearest-rank method. For two sorted scores, p50 is the lower score and p95 is the higher score. `passRate` only includes scored records that explicitly contain `pass`; scorer errors are excluded from every score denominator. `byTag` repeats the same aggregation for each case tag. Target token usage is counted once per sample, even when multiple scorers run, and costs are summed only within the same currency.

## Evaluate OMA runs

Use the convenience targets when the system under evaluation is an OMA agent, team, or fixed plan:

```ts
import { Team, type AgentConfig, type PlanArtifact } from '@open-multi-agent/core'
import {
  targetFromAgent,
  targetFromPlan,
  targetFromTeam,
} from '@open-multi-agent/core/eval'

declare const agent: AgentConfig
declare const team: Team
declare const plan: PlanArtifact

const agentTarget = targetFromAgent(agent, {
  metadata: { prompt_version: 'v2' },
})
const teamTarget = targetFromTeam(team)
const planTarget = targetFromPlan(team, plan)

void agentTarget
void teamTarget
void planTarget
```

Agent and team targets convert non-string input with `String(input)` and use it as the prompt or goal. Plan targets replay the supplied `PlanArtifact`; the plan fixes the tasks and goal. These wrappers return the OMA result alongside the primary output, inject `eval_case` and one-based `eval_repeat` run metadata, and add available model/provider fingerprints. The runner uses the result identity for `runRef` and the result usage for report totals. When `traceStore` is provided, it also loads the matching `StoredRun` into `ScorerContext.trace`.

Record metadata merges in this order, with later values winning: case metadata, `runEvalSet()` metadata, then metadata echoed by a convenience target (including its configuration fingerprint).

## Payload privacy

EvalSet cases may contain private user data. `storePayloads` therefore defaults to `'none'`, so records contain scores, reasons, metadata, and run references but no input/output snapshots. `'redacted'` serializes each payload field, caps it at 8 KiB, and applies OMA's existing secret redaction. `'full'` keeps the serialized text without redaction but still applies the 8 KiB cap; opt into it only for data you are prepared to retain. A model-based judge necessarily sends the evaluated output to the configured judge model regardless of record payload storage.

## Why there is no seed

OMA's current provider contract has no cross-provider seed parameter or LLM response recording. Adding a seed to `EvalSet` would therefore promise determinism the framework cannot provide. Use `repeats` to sample nondeterministic behavior and compare the aggregate statistics. `targetFromPlan()` fixes the orchestration plan, but model responses can still vary.

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
