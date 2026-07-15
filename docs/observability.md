# Observability

`open-multi-agent` exposes three telemetry layers: live progress events, structured trace spans, and a static post-run dashboard.

## Run identity and outcome

Every top-level execution (`runAgent`, `runTeam`, `runTasks`, `runFromPlan`,
`runConsensus`, and `restore`) returns an identity even when `onTrace` is not
configured:

```typescript
const result = await orchestrator.runTasks(team, tasks, { runId: 'order-42' })

result.identity // { runId, attempt, traceId, rootSpanId, links? } at runtime
result.status   // { code, message? } at runtime
result.errorInfo // redacted, JSON-safe details on failures
```

`runId` identifies a logical run and can be supplied by the caller (1-128
characters). `attempt` starts at 1. Each execution attempt gets a new 32-hex
`traceId` and 16-hex `rootSpanId`. Restore preserves `runId`, increments
`attempt`, generates new trace/root IDs, and links to the previous attempt when
restoring a v2 checkpoint.

Status codes are `ok`, `error`, `cancelled`, `timeout`, `budget_exhausted`,
`rejected`, and `skipped`. Existing `success` fields remain available and are
derived from `status.code === 'ok'`; cancellations and whole-run timeouts are
therefore no longer reported as successful runs. A rejected consensus verdict
is still an `ok` execution outcome—the verdict is a domain result, not a runtime
failure.

For source compatibility in the first 1.x release, the new result fields are
optional in TypeScript declarations, but every runtime result from these APIs
includes `identity` and `status`.

## TraceRecord schema v2

The core package exports the `TraceRecord` schema used by the internal
OBS-1B runtime. A span produces `span_start`, zero or more `span_event`
records, and exactly one self-contained `span_end`. Records carry
`schemaVersion: 2`, a unique `recordId`, a per-trace strictly increasing
`sequence`, the run identity, W3C-compatible trace/span IDs, timestamps,
status, safe attributes, and optional links.

The hierarchy uses parent relationships for lifecycle containment and links
for non-tree relationships:

- the run root contains coordinator, task, consensus, checkpoint, and callback operations;
- task attempts are agent children, with LLM and tool calls below the agent;
- DAG prerequisites use `depends_on` links;
- delegated agents are children of the `delegate_to_agent` tool and link back to the task;
- coordinator synthesis uses `consumed` links to task spans;
- checkpoint restore starts a new trace whose root links `continued_from` the prior root.

`span_end` repeats the span kind, name, start time, final attributes, links,
status, and structured error so it remains useful if a start/event record is
lost later in the delivery pipeline. Close is idempotent and the first end
wins.

OBS-1B does not add a public sink/exporter lifecycle. The runtime is activated
by the existing `onTrace` path and converts completed v2 operations back to
the unchanged seven-member `TraceEvent` union. Without `onTrace`, no child
TraceRecord objects are constructed; top-level identity/status still exist.

Streaming notifications are span events rather than zero-duration child
spans in v2. TTFT is recorded only by a genuinely streaming provider path;
the current aggregated `chat()` path never substitutes total latency for
TTFT. Legacy `agent_stream` callback events remain unchanged.

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
- `result.identity` and `result.status` as the stable run lookup and outcome.
- `onTrace` spans for LLM calls and tool executions, keyed by legacy `runId` + `spanId`.
- The rendered dashboard HTML when you need a shareable post-mortem artifact.

> **Redaction scope.** The redaction noted above applies to *telemetry* — trace spans and the dashboard payload. It does **not** cover persisted run state: shared-memory writes and checkpoint saves store agent output verbatim. To scrub secrets there, wrap the durable store with [`RedactingStore`](shared-memory.md#redacting-persisted-secrets).
