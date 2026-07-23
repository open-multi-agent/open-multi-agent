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
- Length uses a cheap script-aware information estimate. CJK characters count as 2.25 units; ordinary Latin word runs approximate token density; long unbroken runs keep their raw length.

This policy is intentionally honest, cheap, and language-neutral rather than semantically ambitious. Semantically equivalent English and Chinese goals should select the same execution mode. Applications that need domain-specific semantics should inject an `ExecutionRouter` or declare an explicit mode/governance topology.

## Governance boundary

Execution Routing does not declare governance. The consequential-tool fallback still treats only `governanceIntent === undefined` as undeclared, regardless of which router selected Single or Team. Router decisions also cannot satisfy named-role or independent-review requirements; those facts continue to come from structured governance declarations and the executed topology.

## Behavior change

The built-in automatic route now recognizes short Chinese multi-stage goals and script-weighted length instead of relying on English-only word patterns plus raw character count. Equivalent goals translated between English and Chinese no longer change Single/Team topology in the routing stability gate. Existing English structural-pattern regressions retain their previous outcomes. Script weighting intentionally changes a detailed, long English single-action goal from `team` to `single` when its estimated information length remains bounded; this case is locked by a regression test. Multilingual applications may also observe corrected automatic routes for Chinese structured goals.
