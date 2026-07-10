# External Agents (ACP)

OMA can orchestrate **external agents that run as local processes** alongside its
LLM-backed agents. The first supported kind is a coding agent driven over the
[Agent Client Protocol (ACP)](https://agentclientprotocol.com) — a JSON-RPC-over-stdio
standard implemented by Gemini CLI, Claude Code, Codex, and others.

An ACP agent is a first-class team member: it sits in the same task DAG, writes to
the same shared memory, cascades failure to its dependents, and counts against the
same token budget as any LLM agent. The motivating shape is a **hybrid team** — an
LLM planner decomposes the goal, an external coding agent writes the code, an LLM
reviewer audits the diff — all in one `runTeam` / `runTasks` call.

## Quick start

Declare an agent with `backend` instead of a model. Everything else about the team
is unchanged:

```typescript
import { OpenMultiAgent } from '@open-multi-agent/core'

const oma = new OpenMultiAgent({ defaultModel: 'claude-sonnet-4-6', defaultProvider: 'anthropic' })

const team = oma.createTeam('hybrid-dev', {
  name: 'hybrid-dev',
  agents: [
    { name: 'planner',  systemPrompt: 'Break the task into a short plan. Do not write code.' },
    {
      name: 'coder',
      systemPrompt: 'Writes and edits code by running an external coding CLI.',
      backend: {
        kind: 'acp',
        command: 'npx',
        args: ['-y', '@agentclientprotocol/claude-agent-acp'], // Claude Code over ACP
        cwd: process.cwd(),
      },
    },
    { name: 'reviewer', systemPrompt: 'Review the change and summarize risks. Do not edit files.' },
  ],
  sharedMemory: true,
})

const result = await oma.runTeam(team, 'Add a slugify() utility with tests, then review it.')
```

The coordinator routes the coding work to `coder` based on its roster description; the
ACP subprocess does the file edits; `reviewer` then reads the result from shared memory.

A runnable version is at
[`examples/integrations/external-agent-acp.ts`](../packages/core/examples/integrations/external-agent-acp.ts).

## Installation

ACP support requires the optional peer dependency, loaded lazily so it never affects
consumers that don't use it:

```bash
npm install @agentclientprotocol/sdk
```

You also need an ACP-speaking agent. Set the backend's `command` / `args` to launch
it — any ACP agent works. Common choices:

| Agent | `command` / `args` | Notes |
|-------|--------------------|-------|
| **Claude Code** | `npx -y @agentclientprotocol/claude-agent-acp` | Official [Claude Agent SDK adapter](https://github.com/agentclientprotocol/claude-agent-acp) (Claude Code has no native ACP). Auth via `ANTHROPIC_API_KEY`. |
| Gemini CLI | `gemini --acp` | Native ACP. Note: Google is reportedly retiring the free-tier Gemini CLI (and its `--experimental-acp` flag) — verify availability before relying on it. |
| Codex | `codex-acp` (or `codex --experimental-acp`) | Experimental ACP support. |

The example below uses Claude Code, which fits OMA's Anthropic-centric default and
needs only one key (`ANTHROPIC_API_KEY`) for the whole team.

## Configuration

`AgentConfig.backend` takes an `AgentBackendConfig` (a discriminated union; only
`kind: 'acp'` exists today):

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `kind` | `'acp'` | — | Backend discriminant. |
| `command` | `string` | — | Executable to spawn (`'npx'`, `'gemini'`, …). |
| `args` | `string[]` | `[]` | Arguments passed to `command`. |
| `env` | `Record<string,string>` | — | Extra env vars, merged over `process.env`. |
| `cwd` | `string` | `process.cwd()` | Directory the agent reads and edits. |
| `permission` | `'auto-approve' \| 'reject' \| fn` | `'auto-approve'` | How to answer permission prompts (below). |

When `backend` is set, the LLM-specific fields (`model`, `provider`, `adapter`,
sampling, `tools`, context strategy) do not apply — the external agent runs its own
loop, and `model` becomes optional. The agent's `systemPrompt` is the exception: it
still shapes the external agent because OMA — lacking any ACP system-prompt field —
prepends it to the agent's first prompt (once per session), on top of seeding the
coordinator's routing as it does for every agent.

### Permissions

ACP agents ask the client to approve sensitive tool calls (editing a file, running a
command). Because OMA runs agents autonomously inside a DAG, the default is
`'auto-approve'` (it picks the least-privilege `allow_once` when offered, otherwise
`allow_always`). Tighten it as needed:

```typescript
backend: {
  kind: 'acp',
  command: 'npx',
  args: ['-y', '@agentclientprotocol/claude-agent-acp'],
  // Reject everything…
  permission: 'reject',
  // …or decide per request.
  permission: (req) => req.kind !== 'delete' && !req.title.includes('rm -rf'),
}
```

The callback receives a minimal, SDK-agnostic `{ title, kind, optionKinds }` and returns
`true` to approve / `false` to reject.

> **Security.** Unlike OMA's filesystem-tool sandbox, an ACP agent accesses `cwd`
> directly — it is a local subprocess with your permissions. Scope `cwd` to a project
> you trust the agent with, and use `permission` to gate destructive actions.

## How it works

OMA takes the ACP **client** role. On the first run for an agent it spawns the
subprocess, frames its stdio as newline-delimited JSON-RPC, `initialize`s, and opens a
`session/new` in `cwd`. Each `agent.run(prompt)` then sends one `session/prompt` turn
and drains `session/update` notifications into a normal agent result:

| ACP update / stop | Maps to |
|-------------------|---------|
| `agent_message_chunk` (text) | streamed `text` deltas + the result's `output` |
| `tool_call` / `tool_call_update` | entries in `result.toolCalls` |
| `usage_update` (`used`) | `result.tokenUsage` (see caveat) |
| stop `end_turn` | success |
| stop `max_tokens` / `max_turn_requests` | success with `budgetExceeded` (stopped early) |
| stop `refusal` | task failure (cascades to dependents) |
| stop `cancelled` | returns partial output (from an abort) |

The seam is the `AgentBackend` interface (`run` + `stream`) that `AgentRunner` already
implements — so the pool, scheduler, task queue, shared memory, and budget accounting
treat an ACP agent exactly like an LLM agent, with no special cases.

### Token accounting caveat

ACP reports a single **context-token** figure (`usage_update.used` — "tokens
currently in context"), not an input/output split, and it is *cumulative* across a
session, not a per-turn delta. Because OMA reuses one session across an agent's
turns, it records each turn's usage as the **increment** since the previous reading
and stores it as `tokenUsage.input_tokens` (with `output_tokens: 0`) — so summing
across turns telescopes to the latest figure instead of double-counting. That total
aggregates into the run and honors `maxTokenBudget`. An agent that emits no
`usage_update` reports `{0, 0}` and is therefore **not** budget-gated — size the
budget on LLM agents, or bound the ACP agent with its own `--max-*` flags.

## Programmatic API

Most users only touch `backend`. To construct a backend directly, import from the
`@open-multi-agent/core/acp` subpath (this is where the optional peer is loaded):

```typescript
import { createAcpBackend } from '@open-multi-agent/core/acp'

const backend = createAcpBackend({ command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp'] })
const result = await backend.run([{ role: 'user', content: [{ type: 'text', text: 'refactor foo.ts' }] }])
await backend.dispose() // close the connection and kill the subprocess
```

## v1 scope

What this release does **not** do yet (open an issue with a real use case to pull any
of these forward):

- **Client role only.** OMA drives external agents; it does not expose OMA agents *as*
  an ACP agent to editors.
- **No `fs/*` proxying.** The agent does its own filesystem access within `cwd`; OMA
  does not yet proxy ACP file operations through its sandbox. Agents that require the
  client to serve files are not supported.
- **ACP only.** Bespoke per-CLI adapters and non-coding business-system CLIs are out of
  scope. ACP already covers the major coding agents.
- **No cost-based budgets.** Budgeting is token-based; `usage_update.cost` is ignored.
- **Subprocess lifetime.** An orchestrated ACP agent's subprocess lives until the
  process exits (there is no per-agent disposal hook in `runTeam` / `runTasks`).
  Use the programmatic API + `dispose()` when you need explicit teardown.
