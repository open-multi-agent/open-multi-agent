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

OBS-2 adds a public sink/exporter lifecycle. The runtime is activated by either
`observability.sinks` or the existing `onTrace` path. Without either option, no
child `TraceRecord` objects or attributes are constructed; top-level
identity/status still exist.

Streaming notifications are span events rather than zero-duration child
spans in v2. TTFT is recorded only by a genuinely streaming provider path;
the current aggregated `chat()` path never substitutes total latency for
TTFT. Legacy `agent_stream` callback events remain unchanged.

## Sinks, exporters, and ownership

`TraceSink` is the synchronous hot-path contract. Its `emit(record): void`
method accepts a record quickly and is never awaited by Agent, Task, or Run
execution. `TraceExporter` is the asynchronous batch-delivery contract used by
`BatchingTraceSink`; network or storage I/O belongs there. A sink or exporter
failure changes observability statistics and diagnostics, never the business
result.

```typescript
import {
  BatchingTraceSink,
  OpenMultiAgent,
  type TraceExporter,
} from '@open-multi-agent/core'

const exporter: TraceExporter = {
  async export(records, signal) {
    // Send the batch using `signal`; return a delivered prefix count.
    return { status: 'success', exported: records.length }
  },
}

const sink = new BatchingTraceSink(exporter)
const orchestrator = new OpenMultiAgent({
  observability: { sinks: [sink] },
})
```

An exporter result has `success`, `retryable`, or permanent `failure` status.
`exported` is the successfully delivered prefix of the supplied batch. A short
`success` is a permanent partial result; a short `retryable` result retries only
the unexported suffix. Rejected or timed-out exporter promises are contained by
the batching sink.

Core also exports `CompositeSink`, `FilteringSink`,
`SensitiveDataProcessor`, and `LegacyCallbackTraceSink`, both from the package
root and the explicit `@open-multi-agent/core/observability` subpath.

## TraceStore query and reference storage

`TraceStore` is the storage-medium-independent persistence and query contract
for v2 `TraceRecord` batches. Core includes `InMemoryTraceStore` as the reference
implementation and `TraceStoreExporter` as the bridge into
`BatchingTraceSink`:

```typescript
import {
  BatchingTraceSink,
  InMemoryTraceStore,
  TraceStoreExporter,
} from '@open-multi-agent/core/observability'

const store = new InMemoryTraceStore()
const sink = new BatchingTraceSink(new TraceStoreExporter(store))

// Configure sink under observability.sinks, run work, then flush its watermark.
await sink.forceFlush({ timeoutMs: 1_000 })
const page = await store.queryRuns({
  status: ['error', 'timeout'],
  agent: ['researcher'],
  limit: 50,
})
```

`InMemoryTraceStore` is not durable and is not a production database. It is
intended for unit tests, local inspection, and short-lived processes. It has no
filesystem or database dependency, and it returns copies rather than mutable
references to its internal records.

### Append, schema, and materialization

`append(records)` accepts a batch atomically: validation failure leaves the
whole batch invisible. Schema major `2` is supported; another major is rejected
with `TraceStoreError(code = 'UNSUPPORTED_SCHEMA_VERSION')`. Unknown fields on
schema-v2 records are retained so additive minor evolution can round-trip.

`recordId` is the idempotency key. Re-exporting a previously accepted batch is
a successful no-op for those records. If the same span receives more than one
distinct `span_end`, the first accepted end wins and append returns a
`duplicate_span_end` diagnostic; the later end cannot change the materialized
Agent or Run outcome.

Materialization sorts records within each trace by `sequence`, independent of
arrival order. An end record is self-contained, so an end-only span is complete.
A start with no accepted end remains incomplete. A logical `runId` groups all
attempts and trace identities, including restore continuations. Parentage and
`continued_from`, `depends_on`, `delegated_from`, and `consumed` links are
preserved on materialized spans. The run terminal status is the latest attempt's
actual root end status; it is absent when that record is missing and is never
invented as `ok`.

Run summaries include start/end/duration, attempts and trace/root identity,
terminal status when present, agent/task/model/provider values actually found
in attributes, LLM token and cost facts, incomplete state, and schema version.
Only LLM end records contribute token/cost totals, avoiding double-counting
agent or run rollups.

### Filters, ordering, and opaque cursors

`queryRuns` supports combined `runId`, ISO time range, status, agent, task ID,
model, and provider filters. `startedAfter` is inclusive; `startedBefore` is
exclusive. The default page size is 50 (maximum 500). Stable ordering is
`(startedAt, runId)`, descending by default; `started_asc` reverses both parts
of that key, so equal timestamps always have a deterministic tie-breaker.

The cursor is opaque, store-instance-specific, and bound to the filter/order
that created it. Invalid, tampered, or mismatched cursors reject with
`TraceStoreError(code = 'INVALID_CURSOR')`. The first page captures an append
revision: records appended while later pages are read do not appear in that
pagination walk, preventing duplicates and omissions. A fresh query sees them.
Deletes are immediately consistent and invalidate outstanding cursors; the
append snapshot does not claim a transaction across concurrent delete or
retention operations.

### Delete and retention

`deleteRun(runId)` removes every attempt for one logical run. `delete(query)`
bulk-deletes logical runs using the same frozen filters as queries, without
cursor, order, or limit. Both are idempotent, and successful deletion is
immediately reflected by `getRun` and `queryRuns`.

Retention accepts `maxAgeMs`, `maxRuns`, and an optional terminal-status scope.
Age uses the injected store clock and run start time. `maxRuns` keeps the newest
matching runs by the same stable ordering; age and count deletion sets are
combined. A status-only policy deletes runs with those actual terminal statuses
and does not match incomplete runs with no status. Deletion order is oldest
first with `runId` as the tie-breaker, and repeated application is safe.

TraceStore retention only affects that store. It cannot delete copies already
exported to OTel or another vendor.

### TraceStore is not RunStore or CheckpointStore

TraceStore is append/query telemetry and can be best-effort. A future RunStore
is the authoritative durable state machine with CAS, lease, suspend, and resume
semantics; TraceStore deliberately provides none of those. CheckpointStore
persists execution state used to restore work. Losing telemetry must not roll
back a durable run, and deleting traces must not imply deleting checkpoints or
shared memory.
## Optional OpenTelemetry package

`@open-multi-agent/otel` is an independent workspace/package that adapts OBS-2
`TraceRecord` batches to OpenTelemetry spans. It is not imported by core, so a
core-only installation has no OpenTelemetry runtime dependency or import path.

```typescript
import { OpenMultiAgent } from '@open-multi-agent/core'
import { createOtelTraceSink } from '@open-multi-agent/otel'

// The application has already constructed and configured this OTel provider.
const sink = createOtelTraceSink({
  tracerProvider: provider,
  metadata: { environment: 'production', release: '2026.07.15' },
})
const orchestrator = new OpenMultiAgent({ observability: { sinks: [sink] } })
```

Pass exactly one application-owned `tracer` or `tracerProvider`; supplying
neither is a configuration error. The adapter never reads, initializes, or
replaces the global provider. `forceFlush()` delegates to a supplied provider
when it supports that operation. Provider shutdown is skipped by default, even
when available: set `shutdownOnShutdown: true` only when the adapter owns that
provider's lifecycle. Rejection/timeout maps to the OBS-2 exporter result and
diagnostics, never to an Agent/Task/Run failure.

OMA run/agent/task/LLM/tool/consensus/checkpoint records become spans;
retry, verdict, first-chunk, and stream records become `oma.*` events. DAG,
delegation, consumed-synthesis, and restore-continuation relations become OTel
links. The adapter keeps `schemaVersion: 2`, run/attempt, OMA trace/span IDs,
record ID, and sequence as stable `oma.*` attributes. It maps `error`,
`timeout`, and `budget_exhausted` to OTel `Error`; all remaining OMA statuses
remain OTel `Unset` and are preserved in `oma.status`.

Links whose targets were observed by the same adapter use the target span's
actual SDK-generated OTel context. Each link records `oma.link.resolved` plus
the stable OMA target trace/span IDs. A same-process restore resolves through a
bounded cache of the 256 most recent root contexts. After a process restart the
previous SDK context is unavailable, so `continued_from` falls back to a remote
unsampled context built from the OMA IDs and marks itself unresolved; the OMA
target attributes remain available for correlation.

Completed OTel `Span` objects are released immediately. Lightweight contexts
live only until their root span closes, at which point the trace-local registry
is cleared. Root close and adapter shutdown end any remaining open spans as
incomplete before clearing state, so telemetry loss cannot produce an unbounded
live-span registry.

For LLM/tool spans it also emits a bounded compatibility subset of the current
development-status GenAI conventions (provider/model, token/cache/reasoning
counts, tool name, and TTFT). Every span records
`oma.otel.mapping.version` and `oma.otel.gen_ai_semconv.version`; the stable
contract is `oma.*`, not the evolving GenAI field names. It emits no metrics,
so no high-cardinality run/task/tenant/request fields become metric labels.

The adapter exports no prompt, completion, tool arguments/results, raw payload,
credential, chain-of-thought, or reasoning content. Numeric token counts remain
eligible. It forwards only an explicit low-sensitivity `oma.*` allowlist rather
than arbitrary record attributes. `contentCapture` is a reserved disabled-only extension point; there
is no content-capture switch in this release.

The first release intentionally provides no OTLP convenience subpath. The
application selects its own OTel SDK and OTLP/exporter implementation, avoiding
eager OTLP imports, implicit global-provider configuration, and a second
SDK/exporter compatibility matrix. See
[`packages/otel/README.md`](../packages/otel/README.md) for the full API and
mapping table.

## Flush and shutdown

`forceFlush({ timeoutMs })` captures an acceptance watermark. It promises that
records accepted before that call have been exported or explicitly counted as
failed/dropped; records accepted afterward do not delay that call. It then
delegates to the exporter's optional `forceFlush`. Results are `ok`, `partial`,
`timeout`, or `error` and include cumulative accepted/exported/dropped/failed
counts.

`shutdown({ timeoutMs })` atomically stops acceptance, flushes the cutoff, then
shuts down the exporter. It is idempotent: concurrent and repeated calls share
the first result. An `emit` after the cutoff is dropped and diagnosed. Timeout
is a total lifecycle deadline, not an exception thrown into Agent execution.

The creator of a sink owns its lifecycle. OMA does **not** automatically shut
down injected sinks, install process signal handlers, call `process.exit()`, or
assume that a sink is exclusive to one orchestrator.

```typescript
// Serverless/FaaS: flush this invocation, keep a shared singleton usable.
const result = await orchestrator.runAgent(agent, prompt)
const telemetry = await sink.forceFlush({ timeoutMs: 1_500 })
return { result, telemetry: telemetry.status }

// Short-lived CLI: finish delivery before natural process exit.
try {
  await main()
  await sink.forceFlush({ timeoutMs: 5_000 })
} finally {
  await sink.shutdown({ timeoutMs: 5_000 })
}

// Long-lived server: application-owned graceful shutdown.
async function stopServer() {
  await sink.shutdown({ timeoutMs: 10_000 })
  await server.close()
}
// Register stopServer with your server/process framework if desired.
```

## Queue, retry, drop, and diagnostics

`BatchingTraceSink` defaults are bounded:

| Setting | Default |
|---|---:|
| queued records | 2,048 |
| queued bytes | 16 MiB |
| one record | 256 KiB |
| batch records | 512 |
| scheduled delay | 5 seconds |
| export timeout | 30 seconds |
| retries after the first attempt | 3 |
| retry backoff | 1 second, exponential ×2, equal jitter, capped at 30 seconds |

Only `retryable` results, rejected exporter promises, and export timeouts are
retried. Retry/backoff happens in the transport worker and never blocks
business execution. Queue admission is non-blocking. When capacity is needed,
the sink drops oldest records in this priority order: `stream_chunk`, other
events, `span_start`, then self-contained `span_end`. Oversize records are
rejected before acceptance.

`getStats()` reports accepted, exported, retried, failed, dropped, queued record
count/bytes, and a payload-free last error code. Built-in diagnostics never
include a record, prompt, tool payload, or raw exception. They default to one
`console.warn` per sink+code per 60 seconds; pass `diagnostics: 'silent'`
explicitly to a built-in sink to disable warnings, or use `onDiagnostic`.
Diagnostic handler throws are swallowed without recursively producing another
diagnostic.

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

`onTrace` remains source- and runtime-compatible for existing users. Each event
still carries its UUID `spanId`, optional UUID `parentId`, duration, token
counts, and the same best-effort-redacted legacy tool I/O.

```typescript
const orchestrator = new OpenMultiAgent({
  onTrace: async (span) => {
    await traceSink.write(span)
  },
})
```

Forward trace spans to OpenTelemetry, Datadog, Honeycomb, Langfuse, or your own run database only after deciding what data is safe for that sink. See [`integrations/trace-observability`](../packages/core/examples/integrations/trace-observability.ts) for a runnable example.

The seven-member `TraceEvent` union and completion/event timing are unchanged.
Internally, `LegacyCallbackTraceSink` maps v2 records back to the exact legacy
event object. Synchronous callback throws and asynchronous rejections remain
isolated and cannot become unhandled rejections. `onTrace` is not marked
deprecated in this release; the 1.x compatibility window remains open while
users can migrate transport code to `observability.sinks` at their own pace.

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

## Default privacy boundary

The v2 instrumentation does not collect prompts, completions, tool arguments,
or tool results by default. `OpenMultiAgent` wraps configured v2 sinks in a
`SensitiveDataProcessor`; its optional `observability.capture` policy is the
only core-controlled content opt-in. Structured credential fields are removed
even when content capture is enabled. Chain-of-thought/reasoning content,
signed reasoning blocks, and `<thinking>` text are never captured by OMA
instrumentation; numeric reasoning-token counts may be recorded.

Legacy `onTrace` keeps its existing redacted tool input/output fields for
compatibility, so its privacy surface is intentionally broader than the v2
default. Trace processing does not redact checkpoints or shared memory.
