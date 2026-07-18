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

## Load EvalSets and write reports

File I/O is isolated in the Node-only `@open-multi-agent/core/eval/file`
subpath. The root package and `@open-multi-agent/core/eval` do not import this
entry point.

```ts
import {
  loadEvalReport,
  loadEvalSet,
  loadGatePolicy,
  writeEvalReport,
} from '@open-multi-agent/core/eval/file'

const setFromJson = await loadEvalSet('./evals/greetings.json')
const fileReport = await runEvalSet(setFromJson, target, { scorers: [exact] })

await writeEvalReport(fileReport, { format: 'json', path: './report.json' })
await writeEvalReport(fileReport, { format: 'markdown', path: './report.md' })
await writeEvalReport(fileReport, { format: 'junit', path: './report.junit.xml' })

const policy = await loadGatePolicy('./evals/gate.json')
const baseline = await loadEvalReport('./evals/baseline.json')
```

`loadEvalSet()` parses JSON, applies the same validation and deep freezing as
`defineEvalSet()`, and includes the resolved file path plus the first schema
issue in validation errors. `writeEvalReport()` creates parent directories as
needed and supports:

- `json`: the authoritative, pretty-printed `EvalRunReport` representation.
- `markdown`: metadata, scorer and tag aggregates, failed samples, and totals
  for human review. Long failure reasons are truncated.
- `junit`: one testcase per record. `pass: false` becomes `<failure>`;
  `scorer_error` and `target_error` become `<error>`; records without `pass`
  and without an error are successful testcases. XML names and messages are
  fully escaped.

`loadGatePolicy()` and `loadEvalReport()` validate their schema-versioned JSON
contracts and report the resolved file path plus the first invalid field. Loaded
objects are defensively copied and deeply frozen.

## Run evaluations from the CLI

After building or installing the package, a no-network target can be evaluated
from a shell or CI job:

```bash
oma eval run --set ./evals/greetings.json --target ./evals/target.mjs \
  --report json --report junit --out ./eval-results \
  --gate ./evals/gate.json --baseline ./evals/baseline.json \
  --meta prompt_version=v2
```

The target module must default-export an `EvalTarget` function or
`{ target, scorers? }`. An optional `--scorers` module default-exports a
`Scorer[]`; scorer names must be unique across both sources. The CLI dynamically
imports and executes these user modules with the current process permissions,
so they must be trusted.

Reports are written below `<out>/<evalRunId>/`; `--out` defaults to
`./eval-results`. `--report` is repeatable and defaults to JSON. `--meta
key=value` is also repeatable and all values are strings. See
[the CLI reference](cli.md#oma-eval-run) for the complete argument and exit-code
contract.

Without `--gate`, low scores and `pass: false` records do not change the exit
code. With `--gate`, the stdout summary includes the verdict and its path, and
the exact `{ pass, failures, warnings }` object is written to
`<out>/<evalRunId>/verdict.json`. A failed gate or every selected target failing
exits 1. Usage/file/module errors exit 2. `--baseline` requires `--gate`.

## Gate quality in CI

`evaluateGate()` is pure logic exported from `@open-multi-agent/core/eval`:

```ts
import { evaluateGate } from '@open-multi-agent/core/eval'

const verdict = evaluateGate(report, {
  schemaVersion: 1,
  thresholds: [
    // A rule scorer plus passRate=1 is a deterministic quality gate.
    { scorer: 'exact', metric: 'passRate', min: 1 },
    { scorer: 'relevancy', metric: 'avg', min: 0.8 },
    { scorer: 'relevancy', metric: 'p50', min: 0.85, tag: 'critical' },
  ],
  maxScorerErrorRate: 0.1,
  maxTargetErrorRate: 0,
  baseline: {
    maxRegression: 0.05,
    perScorer: { exact: 0 },
  },
}, baseline)

if (!verdict.pass) process.exitCode = 1
```

The equivalent JSON policy is:

```json
{
  "schemaVersion": 1,
  "thresholds": [
    { "scorer": "exact", "metric": "passRate", "min": 1 },
    { "scorer": "relevancy", "metric": "avg", "min": 0.8 },
    { "scorer": "relevancy", "metric": "p50", "min": 0.85, "tag": "critical" }
  ],
  "maxScorerErrorRate": 0.1,
  "maxTargetErrorRate": 0,
  "baseline": {
    "maxRegression": 0.05,
    "perScorer": { "exact": 0 }
  }
}
```

Thresholds support `avg`, `p50`, `p95`, `min`, and `passRate`, with optional
tag scoping and inclusive `min`/`max` boundaries. A missing scorer, tag, or
`passRate` source is a configuration failure rather than a silent pass. The
health defaults fail when scorer errors exceed 10% of scored plus scorer-error
records, or when any selected target fails.

Every verdict contains only `pass`, `failures`, and `warnings`. A failure has a
stable `kind`, optional scorer/metric/tag coordinates, the observed `actual`,
the configured `limit`, and a human-readable `message`. For failures about
availability rather than a measured score, `missing_scorer` uses `actual: 0`
and `limit: 1`, while `baseline_mismatch` uses `actual: 1` and `limit: 0`.

A baseline is an ordinary JSON `EvalRunReport`, not a second file format. The
recommended workflow is:

1. Run the accepted target with `--report json` and copy its `report.json` to a
   reviewed location such as `evals/baseline.json`.
2. Commit that report together with its versioned EvalSet and gate policy.
3. In CI, compare the candidate report with `--baseline`.
4. Update the baseline only after intentionally reviewing and accepting the
   behavior change; the CLI never updates it automatically.

Set name or version mismatches fail by default. Set
`baseline.allowSetMismatch` to `true` only when a warning plus skipped
regression checks is intended. When a scorer version differs, OMA warns and
skips that scorer's regression checks because a changed judge prompt or model
does not produce a comparable score. Threshold and health checks still run.
If baseline rules are configured but no baseline report is supplied, OMA warns
and skips regression checks.

Use `oma eval gate` when report generation and quality enforcement are separate
CI stages. It prints the exact verdict JSON to stdout:

```bash
oma eval gate --report ./candidate/report.json --gate ./evals/gate.json \
  --baseline ./evals/baseline.json
```

A GitHub Actions job can preserve both machine-readable reports while letting
the gate control the step status:

```yaml
- name: Run deterministic evaluation gate
  run: |
    oma eval run --set ./evals/set.json --target ./evals/target.mjs \
      --gate ./evals/gate.json --baseline ./evals/baseline.json \
      --report json --report junit --out ./eval-results || exit 1

- name: Upload evaluation JUnit report
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: evaluation-junit
    path: eval-results/**/report.junit.xml
```

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
