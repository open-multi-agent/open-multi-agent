/**
 * examples/integrations/with-run.pay/index.ts
 *
 * run.pay's Memory Store (one of five pay-per-call infrastructure services
 * on https://getrunpay.com) as a durable MemoryStore backend for OMA.
 *
 * Instead of the default in-process KV (lost on restart) or self-hosting
 * Redis/Postgres, teams can point `sharedMemoryStore` at run.pay: it's
 * billed per call via Stripe, requires no infrastructure to operate, and
 * persists across runs/restarts since it's backed by run.pay's own
 * PostgreSQL store.
 *
 * This also includes a generic `call_runpay_service` tool so an agent can
 * reach run.pay's other infra services on the same marketplace — Task
 * Scheduler, Idempotency Lock, Cost Calculator, Consensus Aggregator — or
 * any third-party service vendors publish there.
 *
 * Run it:
 *   export ANTHROPIC_API_KEY=sk-...
 *   export RUNPAY_AGENT_ID=my-oma-agent        # any stable string you choose
 *   npx tsx examples/integrations/with-run.pay/index.ts
 *
 * Before running, register the agent's wallet once (one-time per agent_id):
 *   curl -X POST https://runpay-backend-visibility-production.up.railway.app/api/agents/register \
 *     -H "Content-Type: application/json" \
 *     -d '{"agent_id":"my-oma-agent"}'
 *   # then attach a payment method via Stripe's SetupIntent — see
 *   # https://getrunpay.com/docs.html#agents for the full wallet flow.
 */

import { z } from 'zod'
import {
  OpenMultiAgent,
  defineTool,
  type AgentConfig,
  type MemoryStore,
} from '@open-multi-agent/core'

const RUNPAY_BASE_URL =
  process.env.RUNPAY_BASE_URL ??
  'https://runpay-backend-visibility-production.up.railway.app'
const RUNPAY_AGENT_ID = process.env.RUNPAY_AGENT_ID ?? 'oma-example-agent'

// run.pay marketplace service IDs (see /.well-known/mcp/server-card.json
// on the base URL above, or list_runpay_services below, for the current
// catalog). Memory Store's ID is stable on the live marketplace as of this
// writing, but you should always confirm against /api/marketplace before
// relying on it in production.
const RUNPAY_MEMORY_SERVICE_ID =
  process.env.RUNPAY_MEMORY_SERVICE_ID ?? 'bb6f8136-e13e-4554-9eb9-136a54e43eb4'

// ── run.pay-backed MemoryStore ──────────────────────────────────────────────
//
// Implements OMA's MemoryStore interface (get/set/list/delete/clear) on top
// of run.pay's pay-per-call Memory Store service. OMA namespaces keys as
// `<agentName>/<key>` before they reach this store, so no extra prefixing
// is needed here.
class RunPayMemoryStore implements MemoryStore {
  constructor(
    private serviceId: string,
    private agentId: string,
    private baseUrl: string = RUNPAY_BASE_URL,
  ) {
    if (!serviceId) {
      throw new Error(
        'RunPayMemoryStore requires the run.pay Memory Store service_id — ' +
          'set RUNPAY_MEMORY_SERVICE_ID or pass it explicitly.',
      )
    }
  }

  private async call(payload: Record<string, unknown>) {
    const res = await fetch(`${this.baseUrl}/api/call/${this.serviceId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: this.agentId, payload }),
    })
    const body = await res.json()
    if (!res.ok) {
      throw new Error(body.error ?? `run.pay call failed (HTTP ${res.status})`)
    }
    return body.result as Record<string, any>
  }

  async get(key: string): Promise<string | undefined> {
    const result = await this.call({ action: 'get', key })
    return result.found ? (result.value as string) : undefined
  }

  async set(key: string, value: string): Promise<void> {
    await this.call({ action: 'set', key, value })
  }

  async list(prefix?: string): Promise<string[]> {
    const result = await this.call({ action: 'list', prefix })
    return (result.keys as Array<{ key: string }>).map((k) => k.key)
  }

  async delete(key: string): Promise<void> {
    await this.call({ action: 'delete', key })
  }

  async clear(): Promise<void> {
    // run.pay's Memory Store has no bulk-clear action (by design — it's a
    // per-key paid service), so this clears by deleting each known key.
    // Fine for examples/tests; for production, prefer letting old keys
    // expire/get overwritten rather than clearing whole namespaces.
    const keys = await this.list()
    await Promise.all(keys.map((key) => this.delete(key)))
  }
}

// ── Generic tool: call any other run.pay service ────────────────────────────
const listRunpayServices = defineTool({
  name: 'list_runpay_services',
  description:
    'List services available for purchase on the run.pay marketplace ' +
    '(Task Scheduler, Idempotency Lock, Cost Calculator, Consensus ' +
    'Aggregator, and third-party vendor services). Optionally filter by ' +
    'category or free-text search.',
  inputSchema: z.object({
    category: z.string().optional(),
    search: z.string().optional(),
  }),
  execute: async ({ category, search }) => {
    const params = new URLSearchParams()
    if (category) params.set('category', category)
    if (search) params.set('search', search)

    const res = await fetch(`${RUNPAY_BASE_URL}/api/marketplace?${params}`)
    if (!res.ok) return { data: `run.pay returned ${res.status}`, isError: true }
    const { services, categories } = await res.json()
    return { data: JSON.stringify({ services, categories }, null, 2), isError: false }
  },
})

const callRunpayService = defineTool({
  name: 'call_runpay_service',
  description:
    'Call any run.pay service by ID and pay for it automatically via ' +
    'Stripe. Useful for Task Scheduler, Idempotency Lock, Cost Calculator, ' +
    'Consensus Aggregator, or any vendor service on the marketplace. ' +
    'Failed calls are refunded automatically by run.pay.',
  inputSchema: z.object({
    service_id: z.string(),
    payload: z.record(z.unknown()),
  }),
  execute: async ({ service_id, payload }) => {
    const res = await fetch(`${RUNPAY_BASE_URL}/api/call/${service_id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: RUNPAY_AGENT_ID, payload }),
    })
    const body = await res.json()
    return { data: JSON.stringify(body, null, 2), isError: !res.ok }
  },
})

// ── Agents ───────────────────────────────────────────────────────────────
const researcher: AgentConfig = {
  name: 'researcher',
  model: 'claude-sonnet-4-6',
  systemPrompt:
    'You research a topic and write durable notes to shared memory under ' +
    'a clear key (e.g. "research/<topic>") so other agents can build on ' +
    'your work in future runs.',
  tools: ['list_runpay_services', 'call_runpay_service'],
}

const writer: AgentConfig = {
  name: 'writer',
  model: 'claude-sonnet-4-6',
  systemPrompt:
    'You read prior research from shared memory and write a short summary ' +
    'based on it. Check shared memory before asking the user for context ' +
    'you might already have.',
  tools: [],
}

async function main() {
  const oma = new OpenMultiAgent({ defaultModel: 'claude-sonnet-4-6' })

  oma.registerTool(listRunpayServices)
  oma.registerTool(callRunpayService)

  const team = oma.createTeam('research-team', {
    name: 'research-team',
    agents: [researcher, writer],
    // Durable, billed-per-call shared memory instead of OMA's default
    // in-process KV — survives process restarts since it's backed by
    // run.pay's PostgreSQL store.
    sharedMemoryStore: new RunPayMemoryStore(
      RUNPAY_MEMORY_SERVICE_ID,
      RUNPAY_AGENT_ID,
    ),
  })

  const result = await oma.runTeam(
    team,
    'Research what open-multi-agent is, save a short note about it to ' +
      'shared memory, then have the writer summarize it in two sentences.',
  )

  console.log(`Success: ${result.success}`)
  console.log(result.output)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
