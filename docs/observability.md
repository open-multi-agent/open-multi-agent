# Observability

`open-multi-agent` exposes three telemetry layers: live progress events, structured trace spans, and a static post-run dashboard.

## Progress Events

Use `onProgress` when you need lightweight lifecycle events for logs, terminal output, or a live UI.

```typescript
const orchestrator = new OpenMultiAgent({
  onProgress: (event) => {
    console.log(event.type, event.task ?? event.agent ?? '')
  },
})
```

Common event types include `task_start`, `task_complete`, `task_retry`, `task_skipped`, `agent_start`, `agent_complete`, `budget_exceeded`, and `error`. A `task_retry` event's `data.nextDelayMs` is the actual, post-jitter delay before the next attempt, not the nominal backoff schedule.

## Trace Spans

Use `onTrace` when you need structured spans for LLM calls, tool executions, and tasks. Each span carries a `runId`, its own `spanId`, an optional `parentId`, durations, token counts, and best-effort-redacted tool I/O.

```typescript
const orchestrator = new OpenMultiAgent({
  onTrace: async (span) => {
    await traceSink.write(span)
  },
})
```

Forward trace spans to OpenTelemetry, Datadog, Honeycomb, Langfuse, or your own run database only after deciding what data is safe for that sink. See [`integrations/trace-observability`](../packages/core/examples/integrations/trace-observability.ts) for a runnable example.

Span parentage is best-effort and uses the causal structure known to the runtime. In team runs, worker agent spans point to their task span, and LLM/tool/stream spans point to the agent span. Root spans such as top-level agent runs omit `parentId`.

## Post-Run Dashboard

`renderTeamRunDashboard(result)` returns a static HTML page that visualizes the executed task DAG with timing, token usage, per-task status, and task details.

```typescript
import { writeFileSync } from 'node:fs'
import { renderTeamRunDashboard } from '@open-multi-agent/core'

const result = await orchestrator.runTeam(team, goal)
writeFileSync('run.html', renderTeamRunDashboard(result))
```

The library does not write files by itself. The CLI can write dashboard HTML for you with `oma run --dashboard`; see [docs/cli.md](./cli.md).

The generated dashboard is self-contained and does not load remote scripts, stylesheets, or fonts. Sensitive-looking values in the embedded run payload are redacted before rendering.

## What to Persist

For production runs, persist enough data to reconstruct a failure without replaying the entire job:

- `TeamRunResult.tasks` for the executed DAG and task states.
- `TeamRunResult.totalTokenUsage` for cost attribution.
- `onTrace` spans for LLM calls and tool executions, keyed by `runId` + `spanId`.
- The rendered dashboard HTML when you need a shareable post-mortem artifact.
