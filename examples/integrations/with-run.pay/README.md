# with-run.pay

[run.pay](https://getrunpay.com) is a Stripe-native marketplace offering
pay-per-call agent infrastructure: Memory Store, Task Scheduler,
Idempotency Lock, Cost Calculator, and Consensus Aggregator — plus
third-party vendor services. No self-hosting, no accounts, billed per call.

This example shows two ways to plug run.pay into OMA:

1. **`RunPayMemoryStore`** — a `MemoryStore` implementation backed by
   run.pay's Memory Store service, passed as `sharedMemoryStore` on
   `createTeam()`. Durable across restarts (it's backed by run.pay's own
   PostgreSQL store) without standing up Redis or Postgres yourself.
2. **`list_runpay_services` / `call_runpay_service`** — generic tools so an
   agent can reach run.pay's other infra services (Task Scheduler,
   Idempotency Lock, Cost Calculator, Consensus Aggregator) or any vendor
   service on the marketplace.

## Setup

1. Register an agent wallet (one-time, per `agent_id`):

   ```bash
   curl -X POST https://runpay-backend-visibility-production.up.railway.app/api/agents/register \
     -H "Content-Type: application/json" \
     -d '{"agent_id":"my-oma-agent"}'
   ```

   This returns a Stripe `client_secret`. Attach a payment method to it via
   Stripe's SetupIntent flow — see the [run.pay docs](https://getrunpay.com/docs.html#agents)
   for the full wallet setup (one-time per agent).

2. (Optional) The example defaults to run.pay's live Memory Store service ID.
   To confirm it's still current, or to find a different service:

   ```bash
   curl https://runpay-backend-visibility-production.up.railway.app/api/marketplace?search=memory
   ```

   Override it via `RUNPAY_MEMORY_SERVICE_ID` if needed.

3. Set environment variables:

   ```bash
   export ANTHROPIC_API_KEY=sk-...
   export RUNPAY_AGENT_ID=my-oma-agent
   # RUNPAY_MEMORY_SERVICE_ID is optional — defaults to the live Memory
   # Store service ID baked into the example
   ```

4. Run the example:

   ```bash
   npx tsx examples/integrations/with-run.pay/index.ts
   ```

## What it does

A two-agent team (`researcher`, `writer`) shares memory through
`RunPayMemoryStore` instead of OMA's default in-process KV. The researcher
writes a note to shared memory; the writer reads it back and summarizes it.
Each `get`/`set`/`list`/`delete` call is billed per use via Stripe and
persists in run.pay's backing store — so the memory survives even if this
process restarts, with no infrastructure to run yourself.

The researcher is also given `list_runpay_services` / `call_runpay_service`
so it can reach the rest of the marketplace (Task Scheduler, Idempotency
Lock, Cost Calculator, Consensus Aggregator, or third-party vendor APIs)
on demand.

## Notes

- This wraps run.pay's plain REST API rather than its MCP server, since
  run.pay's MCP endpoint (`/mcp`) is HTTP-based and `connectMCPTools()`
  currently targets stdio servers. Swap in `connectMCPTools()` once OMA
  supports remote/HTTP MCP transports if you'd rather use run.pay's hosted
  MCP manifest directly.
- `clear()` on `RunPayMemoryStore` deletes keys one by one — run.pay's
  Memory Store has no bulk-clear action by design (it's billed per call).
  Fine for examples/tests; avoid calling it on large namespaces in
  production.
- `RUNPAY_BASE_URL` can be overridden if you're running a local fork of
  the run.pay backend.
