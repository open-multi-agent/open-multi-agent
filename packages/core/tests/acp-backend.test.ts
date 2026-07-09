/**
 * Tests for the ACP agent backend (`src/agent/acp-backend.ts`).
 *
 * The unit tests wire the backend to an in-process fake ACP *agent* built with
 * the SDK's `agent()` helper (via the backend's `connect` test seam), so no
 * subprocess or real coding CLI is needed. One integration test spawns a real
 * subprocess (`fixtures/fake-acp-agent.mjs`) through the public `Agent` API to
 * exercise the full spawn → stdio JSON-RPC → RunResult path.
 */
import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { agent, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { AgentApp, AgentRequestHandlersByMethod } from '@agentclientprotocol/sdk'

import { AcpBackend } from '../src/agent/acp-backend.js'
import { Agent } from '../src/agent/agent.js'
import { ToolRegistry } from '../src/tool/framework.js'
import { ToolExecutor } from '../src/tool/executor.js'
import type { AcpPermissionPolicy, LLMMessage } from '../src/types.js'

type PromptHandler = AgentRequestHandlersByMethod['session/prompt']

function userMsg(text: string): LLMMessage {
  return { role: 'user', content: [{ type: 'text', text }] }
}

/** Build a fake ACP agent whose prompt turn is driven by `promptHandler`. */
function fakeAgent(promptHandler: PromptHandler): AgentApp {
  return agent({ name: 'fake' })
    .onRequest('initialize', () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }))
    .onRequest('session/new', () => ({ sessionId: 'test-session' }))
    .onRequest('session/prompt', promptHandler)
}

/** An {@link AcpBackend} connected in-process to `fake` (no subprocess). */
function backendFor(fake: AgentApp, permission?: AcpPermissionPolicy): AcpBackend {
  return new AcpBackend({
    command: 'unused',
    agentName: 'fake',
    ...(permission ? { permission } : {}),
    connect: (clientApp) => {
      const connection = clientApp.connect(fake)
      return {
        connection,
        dispose: () => {
          try {
            connection.close()
          } catch {
            // best-effort
          }
        },
      }
    },
  })
}

describe('AcpBackend (in-process fake agent)', () => {
  it('maps agent_message_chunk text and usage_update into a RunResult', async () => {
    const backend = backendFor(
      fakeAgent(async ({ params, client }) => {
        await client.notify('session/update', {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } },
        })
        await client.notify('session/update', {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } },
        })
        await client.notify('session/update', {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'usage_update', used: 1234, size: 200000 },
        })
        return { stopReason: 'end_turn' }
      }),
    )
    try {
      const result = await backend.run([userMsg('hi')])
      expect(result.output).toBe('Hello world')
      expect(result.tokenUsage).toEqual({ input_tokens: 1234, output_tokens: 0 })
      expect(result.turns).toBe(1)
      expect(result.budgetExceeded).toBeUndefined()
      expect(result.messages).toHaveLength(1)
      expect(result.messages[0]?.role).toBe('assistant')
    } finally {
      await backend.dispose()
    }
  })

  it('streams text deltas and ends with a done event carrying the RunResult', async () => {
    const backend = backendFor(
      fakeAgent(async ({ params, client }) => {
        await client.notify('session/update', {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } },
        })
        await client.notify('session/update', {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'b' } },
        })
        return { stopReason: 'end_turn' }
      }),
    )
    try {
      const deltas: string[] = []
      let done = false
      for await (const event of backend.stream([userMsg('hi')])) {
        if (event.type === 'text') deltas.push(event.data as string)
        else if (event.type === 'done') done = true
      }
      expect(deltas).toEqual(['a', 'b'])
      expect(done).toBe(true)
    } finally {
      await backend.dispose()
    }
  })

  it('records tool calls, carrying the title from tool_call to its completion', async () => {
    const backend = backendFor(
      fakeAgent(async ({ params, client }) => {
        await client.notify('session/update', {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 't1',
            title: 'Edit file',
            kind: 'edit',
            status: 'pending',
            rawInput: { path: 'a.ts' },
          },
        })
        await client.notify('session/update', {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 't1',
            status: 'completed',
            rawOutput: 'patched',
          },
        })
        return { stopReason: 'end_turn' }
      }),
    )
    try {
      const result = await backend.run([userMsg('edit a.ts')])
      expect(result.toolCalls).toHaveLength(1)
      expect(result.toolCalls[0]).toMatchObject({
        toolName: 'Edit file',
        input: { path: 'a.ts' },
        output: 'patched',
      })
    } finally {
      await backend.dispose()
    }
  })

  it('auto-approves permission requests by selecting an allow option', async () => {
    const backend = backendFor(fakeAgent(reportPermissionChoice))
    try {
      const result = await backend.run([userMsg('go')])
      expect(result.output).toBe('allow')
    } finally {
      await backend.dispose()
    }
  })

  it("rejects permission requests under the 'reject' policy", async () => {
    const backend = backendFor(fakeAgent(reportPermissionChoice), 'reject')
    try {
      const result = await backend.run([userMsg('go')])
      expect(result.output).toBe('reject')
    } finally {
      await backend.dispose()
    }
  })

  it('honors a custom permission function', async () => {
    const seen: string[] = []
    const policy: AcpPermissionPolicy = (req) => {
      seen.push(req.title)
      return false
    }
    const backend = backendFor(fakeAgent(reportPermissionChoice), policy)
    try {
      const result = await backend.run([userMsg('go')])
      expect(result.output).toBe('reject')
      expect(seen).toEqual(['Run cmd'])
    } finally {
      await backend.dispose()
    }
  })

  it('throws when the agent refuses the turn', async () => {
    const backend = backendFor(fakeAgent(async () => ({ stopReason: 'refusal' })))
    try {
      await expect(backend.run([userMsg('x')])).rejects.toThrow(/refused/i)
    } finally {
      await backend.dispose()
    }
  })

  it('flags budgetExceeded when the agent stops on max_tokens', async () => {
    const backend = backendFor(
      fakeAgent(async ({ params, client }) => {
        await client.notify('session/update', {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } },
        })
        return { stopReason: 'max_tokens' }
      }),
    )
    try {
      const result = await backend.run([userMsg('x')])
      expect(result.budgetExceeded).toBe(true)
      expect(result.output).toBe('partial')
    } finally {
      await backend.dispose()
    }
  })

  it('errors on an empty prompt', async () => {
    const backend = backendFor(fakeAgent(async () => ({ stopReason: 'end_turn' })))
    try {
      await expect(backend.run([])).rejects.toThrow(/empty prompt/i)
    } finally {
      await backend.dispose()
    }
  })
})

describe('AcpBackend via Agent (subprocess integration)', () => {
  it('runs a real ACP agent subprocess through Agent.run', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))
    const registry = new ToolRegistry()
    const executor = new ToolExecutor(registry)
    const agentInstance = new Agent(
      { name: 'coder', backend: { kind: 'acp', command: process.execPath, args: [fixture] } },
      registry,
      executor,
    )
    try {
      const result = await agentInstance.run('build the thing')
      expect(result.success).toBe(true)
      expect(result.output).toBe('done: build the thing')
      expect(result.tokenUsage.input_tokens).toBe(42)
    } finally {
      // Reach into the Agent's cached backend to tear the subprocess down.
      await (agentInstance as unknown as { backend?: AcpBackend }).backend?.dispose()
    }
  })
})

/**
 * Prompt handler that asks the client to approve a tool call, then reports the
 * selected option id (or `cancelled`) back as its assistant message.
 */
const reportPermissionChoice: PromptHandler = async ({ params, client }) => {
  const response = await client.request('session/request_permission', {
    sessionId: params.sessionId,
    toolCall: { toolCallId: 't1', title: 'Run cmd', kind: 'execute', status: 'pending' },
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
  })
  const chosen =
    response.outcome.outcome === 'selected' ? response.outcome.optionId : 'cancelled'
  await client.notify('session/update', {
    sessionId: params.sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chosen } },
  })
  return { stopReason: 'end_turn' }
}
