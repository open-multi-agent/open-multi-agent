# Changelog

## Unreleased

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

### Added

- `OrchestratorConfig.onTaskDispatch(task)` provides a native per-task pipeline
  approval gate. It is mutually exclusive with `onApproval`.

### Compatibility

- Configuring the existing `onApproval` callback automatically retains legacy
  round scheduling and callback semantics. A separate
  `legacyBatchScheduling` flag is not provided because `onApproval` already
  selects that compatibility path.
- Custom UIs that depend on round-grouped progress timing can temporarily
  configure `onApproval: async () => true`; event-driven consumers should
  migrate to task-ID correlation.
