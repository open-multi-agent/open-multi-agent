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

Common event types include `task_start`, `task_complete`, `task_retry`, `task_skipped`, `agent_start`, `agent_complete`, `budget_exceeded`, and `error`.

## Trace Spans

Use `onTrace` when you need structured spans for LLM calls, tool executions, and tasks. Each span carries parent IDs, durations, token counts, and tool I/O.

```typescript
const orchestrator = new OpenMultiAgent({
  onTrace: async (span) => {
    await traceSink.write(span)
  },
})
```

Forward trace spans to OpenTelemetry, Datadog, Honeycomb, Langfuse, or your own run database. See [`integrations/trace-observability`](../examples/integrations/trace-observability.ts) for a runnable example.

## Post-Run Dashboard

`renderTeamRunDashboard(result)` returns a static HTML page that visualizes the executed task DAG with timing, token usage, per-task status, and task details.

```typescript
import { writeFileSync } from 'node:fs'
import { renderTeamRunDashboard } from '@jackchen_me/open-multi-agent'

const result = await orchestrator.runTeam(team, goal)
writeFileSync('run.html', renderTeamRunDashboard(result))
```

The library does not write files by itself. The CLI can write dashboard HTML for you with `oma run --dashboard`; see [docs/cli.md](./cli.md).

The dashboard HTML loads Tailwind CSS and Google Fonts from the network at view time. Opening the generated HTML requires an online environment unless you host or inline those assets yourself.

## What to Persist

For production runs, persist enough data to reconstruct a failure without replaying the entire job:

- `TeamRunResult.tasks` for the executed DAG and task states.
- `TeamRunResult.totalTokenUsage` for cost attribution.
- `onTrace` spans for LLM calls and tool executions.
- The rendered dashboard HTML when you need a shareable post-mortem artifact.
