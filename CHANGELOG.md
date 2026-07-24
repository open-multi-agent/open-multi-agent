# Changelog

## Unreleased

## 1.13.0 - 2026-07-24

### Added

- Execution routing can now be selected explicitly with `mode`, customized
  through `ExecutionRouter`, or left to the built-in `DeterministicRouter`.
  Every `runTeam()` topology choice exposes a structured routing decision and
  trace linkage.
- Structured governance declarations support required or preferred roles,
  ordered review paths, budget-aware degradation, post-execution conclusions,
  and privacy-preserving execution receipts.
- Consequential tools can be declared through `ToolDefinition.consequential`.
  Undeclared runs expose a machine-readable disclosure flag and can opt into
  confirmation through the existing `onToolCall` gate.
- Model routes can declare ordered fallback routes for retryable worker
  provider failures.
- Agents and tasks can declare structured capabilities and hard requirements.
  The scheduler adds `capability-match` and weighted `composite` strategies,
  structured warnings, and optional strict assignee validation.
- `TeamRunResult.taskResults` preserves unmerged results by task ID. Explicit
  tasks can choose raw, structured, or combined dependency payloads and attach
  bounded role/provenance metadata.
- `OrchestratorConfig.onTaskDispatch(task)` provides a native per-task pipeline
  approval gate. It is mutually exclusive with `onApproval`.
- The offline Run Viewer surfaces execution-routing decisions, and Evaluation
  includes a language-neutral routing-stability gate.

### Changed

- Task DAG execution is event-driven by default. A downstream task now starts
  when its dependencies are satisfied instead of waiting for unrelated tasks
  from the same ready set.
- Progress events from independent DAG branches may interleave instead of
  arriving in round-sized groups. Consumers should correlate events by task ID
  and use task status plus `dependsOn` rather than adjacency to derive state.
- Unassigned tasks are scheduled one ready task at a time against the current
  DAG snapshot. Dependency-aware ready-set ordering and existing strategy
  eligibility/fallback contracts are preserved.
- Abort, budget exhaustion, and task-dispatch approval rejection now stop new
  dispatches, drain in-flight work, and then skip remaining tasks.
- Automatic execution routing recognizes structured Chinese, Japanese, and
  Korean goals and uses script-aware information length instead of relying on
  English-only word patterns and raw character count.

### Fixed

- CJK keyword extraction and zero-score fallback no longer select an
  ineligible agent or lose a valid keyword-based match.
- Governed `planOnly` runs validate and return the declared role DAG without
  executing agents.
- Explicit execution modes, governance floors, and per-run token/cost ceilings
  now resolve through a documented precedence order and disclose overrides or
  budget degradation instead of silently changing topology.

### Compatibility

- Configuring the existing `onApproval` callback automatically retains legacy
  round scheduling and callback semantics. A separate
  `legacyBatchScheduling` flag is not provided because `onApproval` already
  selects that compatibility path.
- Custom UIs that depend on round-grouped progress timing can temporarily
  configure `onApproval: async () => true`; event-driven consumers should
  migrate to task-ID correlation.
- Raw dependency output remains the default. Structured dependency handoff,
  governance declarations, consequential confirmation, and custom execution
  routing are opt-in.
- New result fields remain optional in public TypeScript interfaces so older
  serialized results and caller-authored fixtures continue to type-check.
- `@open-multi-agent/otel@0.1.0` is not republished; its
  `@open-multi-agent/core@^1.11.0` dependency remains compatible with core
  `1.13.0`.
