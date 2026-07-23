# Execution routing

Execution Routing decides the execution topology for an automatic `runTeam()` call: use one Agent directly (`single`) or ask the Coordinator to build and execute a Team plan (`team`). It is orthogonal to [Model Routing](model-routing.md), which chooses the model for calls inside the selected topology.

## Precedence

`runTeam()` resolves topology in this order:

1. Explicit `mode: 'single' | 'team'`.
2. Declared governance topology or `preferredUnderBudget` degradation policy.
3. The per-run `executionRouter`.
4. The orchestrator-level `executionRouter`.
5. The built-in `DeterministicRouter`.

Routers run only for automatic, non-`planOnly` topology selection. They never override an explicit mode, declared role topology, or governance budget policy. `governanceIntent: 'none'` retains automatic topology selection, while still counting as an explicit governance declaration for consequential-tool confirmation.

## Contract

```ts
import type {
  ExecutionRouter,
  RoutingContext,
  RoutingDecision,
} from '@open-multi-agent/core'

class ApplicationRouter implements ExecutionRouter {
  readonly version = 'application-router-v1'

  decide(context: RoutingContext): RoutingDecision {
    const mode = context.goal.startsWith('[team]') ? 'team' : 'single'
    return {
      mode,
      reasons: [`Application policy selected ${mode}.`],
      routerVersion: this.version,
    }
  }
}
```

`RoutingContext` contains the goal, a structured roster summary, and optional remaining token/cost ceilings at the point routing begins. Roster entries contain `name`, effective `model`, and an optional directly declared tool count. Full `systemPrompt` values, credentials, API keys, tool implementations, and model output are never supplied to the router. The summary is intentionally small so a later structured capability model can extend it without exposing prompts.

Set a default on the orchestrator or override it for one call:

```ts
const orchestrator = new OpenMultiAgent({
  executionRouter: new ApplicationRouter(),
})

const result = await orchestrator.runTeam(team, goal, {
  executionRouter: requestScopedRouter,
})
```

The per-run router wins over the orchestrator router. A decision is valid only when `mode` is `single` or `team`, `reasons` is a string array, `routerVersion` matches the router's non-empty `version`, optional `confidence` is between 0 and 1, and `single` has at least one roster member.

## Failure behavior

Routing is advisory infrastructure and must not turn into a run failure. If a custom router throws, rejects, or returns an invalid decision, OMA falls back to `DeterministicRouter`. The returned decision uses the built-in router version and appends a fallback reason to `reasons`.

```ts
result.routingDecision
// {
//   mode: 'single',
//   reasons: [
//     'The goal has one concise action and no multi-stage structure.',
//     'Execution router fallback: custom decision failed (Error).'
//   ],
//   routerVersion: 'deterministic-v1'
// }
```

Every `runTeam()` topology choice exposes `TeamRunResult.routingDecision`.
Its `source` distinguishes caller `override`, governance `declared`, framework
`policy`, and automatic `router` decisions; only `router` records carry the
actual `routerVersion`. See the
[five routing trace source classifications](./observability.md#trace-spans),
including the compatibility-only `legacy-deterministic` label.

## Built-in deterministic policy

`DeterministicRouter` wraps the single `isSimpleGoal()` heuristic; OMA does not maintain a second competing heuristic.

- An empty roster cannot select the Single path; otherwise the goal heuristic decides.
- English sequence, coordination, parallelism, and multi-deliverable signals remain supported.
- Chinese sequence markers (`先…然后`, `第一步/第二步`), circled steps, action enumerations, semicolon-separated clauses, and connected action verbs are recognized.
- Japanese (`まず…次に`, `第一に…第二に`, `ステップ1/手順1`) and Korean (`먼저…그다음`, `첫째…둘째`, `1단계/2단계`) sequence markers are recognized, and dense `、` enumeration counts for kana- and Hangul-initial lists as well as Han. Each marker pair must appear, so a lone marker does not force Team.
- Length uses a cheap script-aware information estimate. CJK characters — Han, Japanese kana, and Korean Hangul — count as 2.25 units; ordinary Latin word runs approximate token density; long unbroken runs keep their raw length.

Language coverage is tiered honestly rather than claimed uniform:

- **Chinese, Japanese, and Korean** are one tier: the structural markers above plus 2.25-unit length weighting.
- **Latin-script languages** share English's length treatment (word runs approximate token density). The structural word patterns are English-specific, so other Latin languages are routed by length and punctuation, not by their own sequence words.
- **Other scripts** fall back conservatively: each non-space character counts as one unit and no structural markers apply, so routing relies on the length threshold alone.

CJK verb-connective sequencing is a deliberate non-goal. Chinese keeps a verb-connective pattern because its verbs are invariant tokens, but Japanese and Korean verbs inflect (Japanese て-form, Korean agglutinative endings), so matching them would require morphological analysis this heuristic intentionally avoids; explicit markers and enumeration cover the structural signal instead.

This policy is intentionally honest, cheap, and language-neutral rather than semantically ambitious. Semantically equivalent English, Chinese, Japanese, and Korean goals should select the same execution mode. Applications that need domain-specific semantics should inject an `ExecutionRouter` or declare an explicit mode/governance topology.

## Governance boundary

Execution Routing does not declare governance. The consequential-tool fallback still treats only `governanceIntent === undefined` as undeclared, regardless of which router selected Single or Team. Router decisions also cannot satisfy named-role or independent-review requirements; those facts continue to come from structured governance declarations and the executed topology.

## Behavior change

The built-in automatic route recognizes short CJK (Chinese, Japanese, Korean) multi-stage goals and script-weighted length instead of relying on English-only word patterns plus raw character count. Equivalent goals translated between English, Chinese, Japanese, and Korean no longer change Single/Team topology in the routing stability gate. Existing English and Chinese outcomes, including structural-pattern regressions, retain their previous behavior. Script weighting intentionally changes a detailed, long English single-action goal from `team` to `single` when its estimated information length remains bounded; this case is locked by a regression test. Multilingual applications may also observe corrected automatic routes for CJK structured goals.
