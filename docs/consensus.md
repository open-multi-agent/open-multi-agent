# Consensus

`runConsensus` adds a proposer→judge verification loop on top of a single prompt: a **proposer** agent emits an answer, then a roster of **judge** agents try to refute it over up to `maxRounds`. The loop exits early once a `quorum` of judges accept.

```ts
const result = await orchestrator.runConsensus(team, 'Is this proof correct?', {
  proposer: { name: 'solver', model: 'claude-opus-4-6' },
  judges: [
    { name: 'judge-a', model: 'claude-opus-4-6' },
    { name: 'judge-b', model: 'claude-sonnet-4-6' },
  ],
  mode: 'refute',       // identical skeptic framing for every judge
  quorum: 2,            // default: ceil(judges.length / 2)
  maxRounds: 2,         // default: 2
  onDissent: 'revise',  // default: feed dissent back to the proposer
})

result.answer      // the (possibly revised) answer
result.verdict     // 'accepted' | 'rejected'
result.dissent     // critiques recorded across all rounds
result.rounds      // judging rounds executed
result.tokenUsage  // proposer + judges + revisions
```

## Options

| Option | Default | Meaning |
|--------|---------|---------|
| `proposer` | — | One agent, or an array (N-best — all candidates are shown to the judges). |
| `judges` | — | Verifier roster. Judges run **sequentially** so quorum and budget can stop the rest. |
| `mode` | `'refute'` | `'refute'`: every judge gets the same skeptic framing. `'lens'`: each judge gets a distinct angle (correctness, completeness, edge cases, …). |
| `quorum` | `ceil(judges.length / 2)` | Accepting judges required to reach consensus. |
| `maxRounds` | `2` | Upper bound on proposer↔judge rounds. |
| `verdictSchema` | — | Optional Zod schema validated against each judge's parsed verdict; a failure counts as dissent. |
| `onDissent` | `'revise'` | `'revise'`: feed dissent back to the proposer for another round. `'reject'`: stop, verdict `rejected`. `'keep'`: stop but keep the answer, verdict `accepted`. |
| `judgePrompt` | built-in | Override the verifier prompt — a `string` for all judges, or a `(judge) => string` function for per-judge framing. |

Every judge prompt includes the **original question** alongside the proposed answer, so judges (including lens-mode ones) score the answer against what was actually asked. A judge replies with `{"accept": boolean, "critique": string}`.

## Per-task `verify` hook

Any task in a `runTasks` pipeline can opt into consensus verification of its own result — the task's assignee is the proposer, so you supply everything *except* `proposer`:

```ts
await orchestrator.runTasks(team, [
  {
    title: 'derive-bound',
    description: 'Prove the O(n log n) bound.',
    assignee: 'mathematician',
    verify: { judges: [judgeA, judgeB], mode: 'refute', maxRounds: 2 },
  },
])
```

After the task completes, its result is fed into the same consensus loop. If consensus revises the answer, the revised result replaces the task output for downstream consumers. Tasks **without** `verify` run unchanged and pay nothing — the hook is fully opt-in.

## Budget invariant

Consensus token usage counts against the parent budget exactly like delegation does. Proposer, judge, and revision usage all accumulate into the running total and are checked against `OrchestratorConfig.maxTokenBudget`. Once the cumulative total crosses the budget, consensus **stops issuing further judge calls** — no separate budget knob, no escape hatch. For the per-task `verify` hook, judge usage rolls into the same run-level budget as the rest of the pipeline and trips the same gate.

## Observability

Every judge verdict is emitted as a `consensus` trace event via `onTrace` (with `accepted` set to the judge's decision and `dissent` carrying the critique when it objected), so you can audit each round. Dissenting critiques are additionally written to shared memory (under the judge's namespace, key `consensus:round:N:dissent`).
