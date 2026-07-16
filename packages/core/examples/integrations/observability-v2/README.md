# Observability v2 examples

These examples exercise the real public package/subpath APIs with a
deterministic local adapter. They need no model API key, network request,
global OpenTelemetry provider, or external collector. Build the workspaces
first, then run any file with `npx tsx`.

| Example | Ownership and lifecycle |
|---|---|
| [`batching-exporter.ts`](./batching-exporter.ts) | application-owned custom exporter and batching sink |
| [`in-memory-store.ts`](./in-memory-store.ts) | non-durable in-memory store; application shuts down the sink |
| [`file-trace-store.ts`](./file-trace-store.ts) | drain sink, fsync store, shut down sink, close store |
| [`otel-provider.ts`](./otel-provider.ts) | official in-memory exporter; OMA sink drains before application provider shutdown |
| [`cli-lifecycle.ts`](./cli-lifecycle.ts) | short-lived natural exit with explicit flush/shutdown/close |
| [`server-lifecycle.ts`](./server-lifecycle.ts) | application registers SIGTERM, stops intake, drains telemetry |
| [`serverless-lifecycle.ts`](./serverless-lifecycle.ts) | short per-invocation flush; warm singleton is not shut down |

[`public-snippets.ts`](./public-snippets.ts) is compile-only. It mirrors the
copyable migration guide API combinations and is included in the automated
TypeScript check.

The separate [`trace-observability.ts`](../trace-observability.ts) intentionally
remains the legacy `onTrace` example.
