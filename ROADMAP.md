# VCG Agent SDK — Roadmap

Transform `open-multi-agent` into `@vcg/agent-sdk`: a turnkey agent framework for VCG's international applications. Devs get a simple agent they can pull into any app — chat agents, worker agents, scheduled jobs — all backed by our vLLM infrastructure.

---

## Phase 1: Foundation — vLLM Adapter + Package Rebranding

**Goal:** Agents can target our vLLM servers out of the box.

### 1A. Package Rename

- Rename from `open-multi-agent` to `@vcg/agent-sdk`
- Rename `OpenMultiAgent` class to `VCGAgent` (or `AgentSDK`)
- Update all exports, doc comments, and README

### 1B. vLLM Adapter

vLLM exposes an OpenAI-compatible API, so the adapter extends the existing OpenAI adapter pattern with custom base URL and model config.

- **New** `src/llm/vllm.ts` — `VLLMAdapter` class
- **New** `src/llm/openai-compat.ts` — extract shared OpenAI-format helpers (message conversion, tool formatting, streaming) so both `OpenAIAdapter` and `VLLMAdapter` reuse them
- **Modify** `src/llm/adapter.ts` — add `'vllm'` to `createAdapter()` factory
- **Modify** `src/types.ts` — add `VLLMConfig` type, `'vllm'` to provider unions

```typescript
interface VLLMConfig {
  baseURL: string          // e.g. "http://vllm-server:8000/v1"
  model: string            // e.g. "meta-llama/Llama-3-70b"
  apiKey?: string
  timeout?: number
  maxRetries?: number
}
```

### 1C. Centralized Configuration

- **New** `src/config/defaults.ts` — default vLLM server URL, model, common settings
- **New** `src/config/index.ts` — `loadConfig()` with priority: constructor args > env vars > config file
- Env vars: `VCG_VLLM_URL`, `VCG_VLLM_MODEL`, `VCG_VLLM_API_KEY`, `VCG_DEFAULT_PROVIDER`, `VCG_LOG_LEVEL`, `VCG_LOCALE`

---

## Phase 2: Developer Experience — Presets + Simple API

**Goal:** Working agent in ~5 lines of code.

### 2A. Agent Presets

- **New** `src/presets/chat.ts` — `createChatAgent(config?)`
  - Multi-turn history, streaming, temperature 0.7
  - Defaults to vLLM from env config
- **New** `src/presets/worker.ts` — `createWorkerAgent(config?)`
  - Single-turn (stateless), built-in tools loaded, temperature 0, maxTurns 20
- **New** `src/presets/index.ts` — re-exports

```typescript
import { createChatAgent, createWorkerAgent } from '@vcg/agent-sdk'

const chat = createChatAgent({ name: 'support-bot' })
const reply = await chat.prompt('How do I reset my password?')

const worker = createWorkerAgent({ tools: [myCustomTool] })
const result = await worker.run('Process this data file')
```

### 2B. Configuration Presets

- **New** `src/config/presets.ts` — named profiles: `'production'`, `'development'`, `'lightweight'`
- Auto-detect environment and apply appropriate defaults

### 2C. Structured Logger

- **New** `src/logger.ts` — simple console-based logger with level filtering (`debug` | `info` | `warn` | `error` | `silent`)
- No external dependency, used by middleware/presets/scheduler

---

## Phase 3: Custom Tool Ecosystem

**Goal:** Pre-built tool packs, middleware, and easy custom tool authoring.

### 3A. Tool Packs

Pre-built tool collections, each a function returning `Tool[]` for configurability.

- **New** `src/tool/packs/http.ts` — `httpToolPack(config?)`: GET, POST, PUT, DELETE with auth headers, timeout, response size limits (native `fetch`)
- **New** `src/tool/packs/database.ts` — `databaseToolPack(config?)`: generic SQL query/execute via pluggable `DatabaseConnection` interface (DB drivers are peer deps)
- **New** `src/tool/packs/json.ts` — `jsonToolPack()`: parse, validate, transform JSON/YAML
- **New** `src/tool/packs/index.ts` — re-exports + `registerAllPacks(registry)`

```typescript
const httpTools = httpToolPack({ defaultHeaders: { Authorization: 'Bearer ...' } })
registry.registerPack(httpTools)
```

### 3B. Tool Middleware

Composable wrappers for cross-cutting concerns on tool execution.

- **New** `src/tool/middleware.ts`
  - `withLogging(tool, logger?)` — log inputs, outputs, duration
  - `withRateLimit(tool, { maxPerMinute })` — token bucket throttle
  - `withAuth(tool, validator)` — permission check before execution
  - `withTimeout(tool, ms)` — hard timeout via AbortController
  - `withRetry(tool, { maxRetries })` — exponential backoff on transient errors
- Composable: `withLogging(withRateLimit(myTool, { maxPerMinute: 10 }))`

### 3C. Tool Sharing Across Agents/Teams

- Add optional `sharedToolRegistry` to `OrchestratorConfig` and `TeamConfig`
- When present, all agents in the team share the same registry instead of creating fresh ones
- Add `ToolRegistry.registerPack()` / `deregisterPack()` for bulk registration

---

## Phase 4: Built-In Request Queuing

**Goal:** Production-grade request management for LLM calls — rate limiting, prioritization, backpressure, and retry built into the framework so devs don't have to manage it themselves.

### 4A. LLM Request Queue

When multiple agents or scheduled jobs fire concurrently, raw LLM calls can overwhelm a vLLM server or hit API rate limits. A built-in queue sits between agents and adapters.

- **New** `src/llm/queue.ts` — `LLMRequestQueue` class

```typescript
interface QueueConfig {
  maxConcurrent: number       // max parallel LLM calls (default: 5)
  maxQueueSize: number        // max pending requests before rejecting (default: 100)
  defaultPriority: number     // 0 = highest (default: 5)
  rateLimit?: {
    requestsPerMinute: number // token bucket rate limit
    burstSize?: number        // allow short bursts above steady rate
  }
  retry?: {
    maxRetries: number        // retry on transient failures (default: 3)
    backoffMs: number         // initial backoff (default: 1000)
    backoffMultiplier: number // exponential factor (default: 2)
    retryableErrors: string[] // error codes/messages to retry on
  }
  timeout?: number            // per-request timeout in ms
}
```

Core behavior:
- Wraps any `LLMAdapter` transparently — agents don't know the queue exists
- Priority queue (lower number = higher priority): chat agents get priority 1, cron workers get priority 10
- Semaphore-gated concurrency (reuses existing `src/utils/semaphore.ts`)
- Token bucket rate limiting to stay within vLLM server capacity
- Automatic retry with exponential backoff for 429s, 503s, and connection errors
- Backpressure: rejects with a clear error when queue is full rather than growing unbounded
- Request deduplication (optional): identical prompts within a time window return the same pending result

### 4B. Queued Adapter Wrapper

- **New** `src/llm/queued-adapter.ts` — `QueuedLLMAdapter` implementing `LLMAdapter`

```typescript
class QueuedLLMAdapter implements LLMAdapter {
  constructor(inner: LLMAdapter, config?: QueueConfig)
  chat(messages, options): Promise<LLMResponse>   // enqueues, awaits turn
  stream(messages, options): AsyncIterable<StreamEvent>  // enqueues, streams when ready
  getQueueStatus(): QueueStatus
  drain(): Promise<void>   // wait for all pending requests to complete
  pause(): void            // stop dequeuing (in-flight requests finish)
  resume(): void           // resume dequeuing
}

interface QueueStatus {
  pending: number
  active: number
  completed: number
  failed: number
  avgLatencyMs: number
  queueDepth: number
}
```

### 4C. Integration Points

- **Modify** `src/llm/adapter.ts` — `createAdapter()` accepts optional `queue?: QueueConfig`; when provided, wraps the adapter in `QueuedLLMAdapter` automatically
- **Modify** `src/orchestrator/orchestrator.ts` — orchestrator-level queue config flows to all agents in a team, so one queue manages all LLM traffic for the team
- **Modify** `src/presets/` — presets wire up default queue config (e.g., worker preset uses queue with retry enabled, chat preset uses low-latency queue with higher priority)
- **Modify** `src/config/defaults.ts` — default queue settings in centralized config

### 4D. Per-Provider Queue Policies

Different backends have different constraints:
- **vLLM** — limited by GPU memory/batch size; queue focuses on `maxConcurrent`
- **Anthropic API** — has rate limits (RPM/TPM); queue focuses on `rateLimit`
- **OpenAI API** — similar rate limits; queue focuses on `rateLimit`

Default policies per provider baked into config so devs don't have to tune:

```typescript
const defaultQueuePolicies: Record<SupportedProvider, Partial<QueueConfig>> = {
  vllm:      { maxConcurrent: 8, rateLimit: undefined },        // GPU-bound
  anthropic: { maxConcurrent: 5, rateLimit: { requestsPerMinute: 50 } },
  openai:    { maxConcurrent: 5, rateLimit: { requestsPerMinute: 60 } },
}
```

### 4E. Observability

- Queue emits events: `request:enqueued`, `request:started`, `request:completed`, `request:failed`, `request:retried`, `queue:full`
- Ties into the structured logger from Phase 2C
- `getQueueStatus()` available at adapter, orchestrator, and preset level for health dashboards

---

## Phase 5: Cron / Scheduled Agent Support

**Goal:** Agents that run on schedules with monitoring.

### 5A. Cron Scheduler

- **New** `src/scheduler/cron-agent.ts` — `CronAgent` wrapping an agent with schedule

```typescript
const scheduled = new CronAgent({
  agent: createWorkerAgent(),
  schedule: '0 */6 * * *',
  task: 'Check service health and report',
  onComplete: (result) => webhook(result),
  onError: (err) => alerting(err),
})
scheduled.start()
```

- **New** `src/scheduler/cron-manager.ts` — registry of all scheduled agents (start/stop/list/status)
- **New** `src/scheduler/cron-parser.ts` — lightweight cron expression parser (or add `cron-parser` dep)

### 5B. Persistence Layer

- **New** `src/scheduler/persistence.ts` — pluggable store for schedule state (last run, next run, results)
- Default: file-based JSON store
- Interface for Redis/DB backends

### 5C. Health and Monitoring

- `CronAgent.getStatus()` — last run, next run, success/failure count
- `CronManager.getHealthReport()` — all agents' status
- Optional webhook/callback on completion or failure
- **New** `src/scheduler/webhook.ts` — POST results to callback URLs with retry

---

## Phase 6: Internationalization (i18n)

**Goal:** Agents work naturally across languages and locales.

### 6A. Locale System

- **New** `src/i18n/locale-manager.ts` — manages locale-specific system prompts and tool descriptions
- **New** `src/i18n/locales/en.json`, `ja.json`, `zh-CN.json`, `ko.json` — translation maps for SDK-internal strings

```typescript
const agent = createChatAgent({ locale: 'ja-JP' })
// System prompt automatically in Japanese, tool descriptions localized
```

### 6B. Locale-Aware Tools

- Extend `ToolContext` with `locale` field so tools can format responses appropriately (dates, numbers, currencies)
- Thread locale through `AgentRunner` → `ToolExecutor` → tool execution

### 6C. Character Encoding

- Verify UTF-8/multibyte handling across all adapters (should already work)
- Token counting awareness for CJK scripts in context management

---

## Phase 7: Production Hardening + Examples

**Goal:** Production-ready with great onboarding.

- Structured logging throughout (pluggable logger interface)
- Error taxonomy: network errors vs tool errors vs LLM errors vs queue errors
- Graceful shutdown: drain queue, finish in-flight requests, stop cron jobs
- Health endpoint helper for container orchestration (Kubernetes readiness/liveness)

### Examples

- `examples/05-vllm-quickstart.ts` — chat agent on vLLM
- `examples/06-custom-tools.ts` — tool packs + middleware
- `examples/07-cron-worker.ts` — scheduled agent job
- `examples/08-i18n-agent.ts` — multi-language agent
- `examples/09-queued-agents.ts` — queue config + monitoring

---

## Build Order

```
Phase 1 (vLLM + rebrand)       <- Start here, immediate value
  |
Phase 2 (presets + DX)          <- Devs can start using it
  |
Phase 3 (tool packs)        \
                              >-- Can be parallelized
Phase 4 (request queuing)   /
  |
Phase 5 (cron scheduler)       <- Depends on queue (Phase 4)
  |
Phase 6 (i18n)                  <- Can start anytime after Phase 2
  |
Phase 7 (production hardening)  <- Final polish
```

## Key Architectural Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| vLLM adapter approach | Extend OpenAI adapter via shared `openai-compat.ts` | vLLM is OpenAI-compatible; avoids code duplication |
| Request queue placement | Transparent wrapper around `LLMAdapter` | Agents are unaware of queuing; zero code changes for consumers |
| Queue implementation | Priority queue + semaphore + token bucket | Handles concurrency, rate limits, and fairness in one layer |
| Config management | Env vars > config file > constructor (merge) | Flexible for different deployment contexts |
| Cron library | Lightweight internal parser (or `cron-parser` dep) | Avoids heavy dependencies |
| i18n approach | JSON locale files + template system | Simple, no heavy framework needed |
| Tool middleware | Function composition (decorator pattern) | Familiar, zero-dependency, composable |
| Presets | Factory functions returning standard `Agent` | No new class hierarchies, just opinionated config |
