// Minimal ACP *agent* over stdio, used by the acp-backend integration test.
// Echoes the incoming prompt text back as an assistant message, reports a fixed
// token usage, then ends the turn. Hermetic: no network, no real model.
import { agent, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { Readable, Writable } from 'node:stream'

function firstText(prompt) {
  const blocks = Array.isArray(prompt) ? prompt : [prompt]
  const block = blocks.find((b) => b && b.type === 'text')
  return block ? block.text : ''
}

const app = agent({ name: 'fake-acp-agent' })
  .onRequest('initialize', () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: {},
  }))
  .onRequest('session/new', () => ({ sessionId: 'test-session' }))
  .onRequest('session/prompt', async ({ params, client }) => {
    await client.notify('session/update', {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `done: ${firstText(params.prompt)}` },
      },
    })
    await client.notify('session/update', {
      sessionId: params.sessionId,
      update: { sessionUpdate: 'usage_update', used: 42, size: 1000 },
    })
    return { stopReason: 'end_turn' }
  })

app.connect(
  ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin),
  ),
)
