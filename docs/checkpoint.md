# Checkpoint & Resume

Long-running task workflows can persist their progress and resume after a crash, an abort, or a process restart. Checkpointing is **opt-in** and runs entirely over the existing [`MemoryStore`](shared-memory.md) interface, so the same in-memory, Redis, Postgres, or custom backend that holds shared memory also holds checkpoints — no extra storage layer.

It covers the orchestration paths (`runTeam`, `runTasks`, `runFromPlan`, and `restore`). A single `runAgent` call has nothing to resume and is not checkpointed.

## Enable it

Pass `checkpoint` per call, or set a default for every run via `OrchestratorConfig.checkpoint`. Per-call options override the config default.

```typescript
import { OpenMultiAgent, Team, InMemoryStore } from '@open-multi-agent/core'

const store = new InMemoryStore() // for durability across restarts, use FileStore (below) or a custom MemoryStore

const team = new Team({
  name: 'research',
  agents: [researcher, writer],
  sharedMemoryStore: store,
})

const orchestrator = new OpenMultiAgent()

// Snapshots are written after each completed task.
await orchestrator.runTasks(team, tasks, { checkpoint: { store } })
```

`checkpoint: true` is shorthand: it reuses the team's shared-memory store when the team has one, otherwise a private in-memory store scoped to the orchestrator instance.

```typescript
const orchestrator = new OpenMultiAgent({ checkpoint: true }) // default for all runs
```

### `CheckpointOptions`

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `enabled` | `boolean` | `true` | Set `false` to disable for a single run when a config default is on. |
| `store` | `MemoryStore` | team's shared-memory store | Durable backend for checkpoint records. |
| `runId` | `string` | — | Logical run id; derives a per-run checkpoint key. |
| `key` | `string` | — | Exact store key. Takes precedence over `runId`. |

> **A `runId`, `key`, or explicit `store` is required when the team has no shared-memory store.** The instance-level fallback store is shared across every run on the orchestrator, so without a distinct key two concurrent runs would overwrite each other at the default checkpoint key. The call throws rather than risk a silent stomp.

## Durable persistence: `FileStore`

`InMemoryStore` is a plain `Map` — it dies with the process, so a checkpoint held there does not survive a restart. For durability out of the box, use the bundled **`FileStore`**: a zero-dependency, filesystem-backed `MemoryStore` (Node built-ins only, so the three-dependency promise holds). Each write lands atomically — temp file → `fsync` → `rename` — so a reader never sees a half-written file, even across a power loss, not just a process crash.

```typescript
import { OpenMultiAgent, Team, InMemoryStore, FileStore } from '@open-multi-agent/core'

const team = new Team({
  name: 'research',
  agents: [researcher, writer],
  sharedMemoryStore: new InMemoryStore(), // hot-path memory stays in RAM
})

const orchestrator = new OpenMultiAgent()

// Checkpoints are durable; a fresh process can resume from the same path.
await orchestrator.runTasks(team, tasks, {
  checkpoint: { store: new FileStore('./.oma/checkpoint.json') },
})
```

**Which store gets the `FileStore`.** Prefer it as the *checkpoint* store, leaving shared memory on a fast `InMemoryStore` (above). A separate checkpoint store self-embeds the shared-memory snapshot (see [What gets saved](#what-gets-saved)), so resume rebuilds everything from the one file — while durability I/O stays at checkpoint cadence (once per completed task) instead of firing on every agent memory write. Using `FileStore` as `sharedMemoryStore` also works and is durable, but then *every* shared-memory write rewrites the whole file; reach for that only when shared memory itself must survive a restart independently of checkpoints.

**Scope.** One process at a time — there is no cross-process file lock, so this is not a shared database. Concurrent writes *within* a process are serialized and safe. That matches the resume story, which is inherently sequential (process A crashes, process B resumes). A corrupt or unreadable state file makes the store throw rather than silently start empty, so durable data is never quietly discarded.

## Resume

`restore()` loads the latest checkpoint, rebuilds the task queue and shared memory, skips completed tasks, and runs the remainder.

```typescript
// After a crash/restart: same team wiring, same store.
const resumedTeam = new Team({
  name: 'research',
  agents: [researcher, writer],
  sharedMemoryStore: store,
})

const result = await orchestrator.restore(resumedTeam, { checkpoint: { store } })
```

A restored `runTeam` run re-runs the coordinator synthesis, so you get the same synthesized final answer (under `result.agentResults.get('coordinator')`) as a fresh `runTeam`, not just the raw per-task outputs. Re-supply the coordinator config you used originally — the checkpoint can't persist a live adapter:

```typescript
const result = await orchestrator.restore(resumedTeam, {
  checkpoint: { store },
  coordinator: { provider: 'anthropic', model: 'claude-sonnet-4-6' }, // same as the original runTeam
})
```

If synthesis can't run (no usable coordinator config or credentials) or the synthesis call fails, restore is best-effort: it returns the raw per-task outputs without a `'coordinator'` entry and emits an `onProgress` `synthesis_failed` event. `runTasks` / `runFromPlan` runs never synthesize.

If no checkpoint is found, `restore()` falls back to a normal run of the tasks or plan you pass — so the same call works for both first run and resume:

```typescript
// Fresh store → runs all tasks. Existing checkpoint → resumes, skipping done tasks.
await orchestrator.restore(team, tasks, { checkpoint: { store } })
await orchestrator.restore(team, plan,  { checkpoint: { store } })  // PlanArtifact
await orchestrator.restore(team,        { checkpoint: { store } })  // resume-only, no-op on empty store
```

## What gets saved

On each successfully completed task, the orchestrator writes a `CheckpointSnapshot`:

- **Task queue state** — every task and its status partition (pending / in-progress / completed / failed / blocked / skipped).
- **Shared memory** — the turn counter is always recorded. The full entry snapshot is embedded **only when the checkpoint store differs from the team's shared-memory store**. When they are the same store (the default for `checkpoint: true`), the entries are already durable there, so re-embedding them every task would be wasted ~O(N²) write volume across a long run; resume reads them straight from the store instead. Either way, resume rehydrates shared memory correctly.
- **Completed task results** — `taskId`, `assignee`, and `result` for each finished task, so resumed agents see prior outputs.

Snapshots are stored as JSON under a reserved namespace: `__oma_checkpoint__/<runId>/latest` (or `__oma_checkpoint__/latest` when no `runId` is set). Keys under `__oma_checkpoint__/` are reserved — shared-memory snapshot/restore deliberately skips them so one store can hold both agent memory and checkpoints.

### Saves are best-effort

A checkpoint write must never take down the run it protects. If the store rejects (a transient Redis/SQLite error), the failure is surfaced via `onProgress` and the run continues; the next completed task retries the write.

```typescript
const orchestrator = new OpenMultiAgent({
  onProgress(event) {
    if (event.type === 'error' && event.data?.kind === 'checkpoint_save_failed') {
      console.warn('checkpoint write failed, run continues:', event.data.error)
    }
  },
})
```

## Redacting persisted secrets

A checkpoint stores completed task results — and, for a separate checkpoint store, the shared-memory snapshot — **verbatim**. Redaction elsewhere (traces, dashboard) does **not** reach this path, so a secret an agent emits into its answer lands on disk. To scrub it, wrap the durable store with **`RedactingStore`**:

```typescript
import { RedactingStore, FileStore } from '@open-multi-agent/core'

await orchestrator.runTasks(team, tasks, {
  checkpoint: { store: new RedactingStore(new FileStore('./.oma/checkpoint.json')) },
})
```

`RedactingStore` redacts values on write at the store boundary, so it covers **both** persistence paths through the same primitive:

- Wrap the **checkpoint store** (above) to scrub the checkpoint's own results and any embedded shared-memory snapshot.
- Wrap the **shared-memory store** (`sharedMemoryStore: new RedactingStore(...)`) to scrub the `<agent>/<key>` entries. In the default `checkpoint: true` reuse case the checkpoint store *is* that store, so one wrap scrubs both.

Wrap **every durable store you persist to**: in a split setup — wrapped shared store, separate *unwrapped* checkpoint store — the checkpoint's `completedTaskResults` (sourced from the queue, not the store) would still be raw. Add custom value patterns (e.g. PII) via `new RedactingStore(store, { patterns: [/…/] })`.

Redaction is opt-in by construction and lossy on purpose: a **resumed** run sees `[redacted]` in place of the masked values. Don't enable it if a downstream agent legitimately needs a persisted secret on resume.

## Advanced: the `Checkpoint` class

For inspecting or managing checkpoints directly, the manager and key helpers are exported:

```typescript
import {
  Checkpoint,
  checkpointKey,
  isCheckpointKey,
  CHECKPOINT_KEY_PREFIX,
  DEFAULT_CHECKPOINT_KEY,
} from '@open-multi-agent/core'

const cp = new Checkpoint(store, { runId: 'nightly-2026-06-18' })
const snapshot = await cp.loadLatest() // CheckpointSnapshot | null
await cp.delete()                      // drop the persisted checkpoint
```

## Limitations

Per-run snapshot/restore over `MemoryStore`. What it does *not* yet do:

- **Resume is task-grained, not mid-task.** A task interrupted while running re-runs from the start on resume — the in-flight agent's conversation history inside a running task is not persisted. Recovery happens at task boundaries.
- **Snapshot-based, not event-sourced.** Each checkpoint overwrites the previous one; there is no transition log to replay.

Two notes on the shared-memory optimization described above:

- A *separate* durable checkpoint store (shared memory in store X, `checkpoint: { store: Y }`) still embeds the full memory snapshot on each save — necessary, since Y holds no other copy of the entries.
- The reused-store path does not point-in-time roll back shared memory. The default framework writes results only on task completion (so a crashed in-progress task has written nothing), but a custom tool that writes to shared memory mid-task would not have those partial writes rolled back on resume.

These are tracked as follow-ups: [#312](https://github.com/open-multi-agent/open-multi-agent/issues/312) (mid-task recovery) and [#313](https://github.com/open-multi-agent/open-multi-agent/issues/313) (event-sourced replay).
