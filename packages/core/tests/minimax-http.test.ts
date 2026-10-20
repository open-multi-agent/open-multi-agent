import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAdapter } from '../src/llm/adapter.js'
import { OpenMultiAgent } from '../src/index.js'
import { isRetryableError } from '../src/errors.js'
import type { AgentConfig, ContentBlock, LLMChatOptions, LLMMessage, OrchestratorConfig } from '../src/types.js'
import { tsxCli } from './helpers/tsx-cli.js'

const flash = 'MiniMax-M3.1-Flash'
const messages: LLMMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }]
const requests: { url: string; body: Record<string, any> }[] = []
let toolResponse = false

// Keep the real SDK: only replace its HTTP transport, so assertions cover JSON serialization.
beforeEach(() => {
  requests.length = 0
  toolResponse = false
  vi.stubEnv('MINIMAX_BASE_URL', 'https://api.minimax.io/v1')
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init)
    const body = await request.json() as Record<string, any>
    requests.push({ url: request.url, body })
    if (body.stream) {
      const chunk = {
        id: 'fixture', model: body.model,
        choices: [{
          index: 0,
          delta: toolResponse ? {
            reasoning_content: 'Preserve this reasoning.',
            tool_calls: [{ index: 0, id: 'call_fixture', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
          } : { content: 'Hello' },
          finish_reason: toolResponse ? 'tool_calls' : 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    return Response.json({
      id: 'fixture', model: body.model,
      choices: [{
        index: 0,
        message: toolResponse ? {
          role: 'assistant', content: null, reasoning_content: 'Preserve this reasoning.',
          tool_calls: [{ id: 'call_fixture', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
        } : { role: 'assistant', content: 'Hello' },
        finish_reason: toolResponse ? 'tool_calls' : 'stop',
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    })
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

async function send(options: LLMChatOptions, stream = false, baseURL?: string) {
  const adapter = await createAdapter('minimax', 'fixture-key', baseURL)
  if (stream) {
    for await (const event of adapter.stream(messages, options)) {
      if (event.type === 'error') throw event.data
    }
  } else {
    await adapter.chat(messages, options)
  }
  return requests.at(-1)!
}

describe('MiniMax serialized HTTP requests', () => {
  it('runs the CLI-generated default through the orchestrator and real SDK', async () => {
    const cli = fileURLToPath(new URL('../src/cli/oma.ts', import.meta.url))
    const generated = JSON.parse(execFileSync(process.execPath, [tsxCli, cli, 'provider', 'template', 'minimax'], {
      encoding: 'utf8',
    })) as { agent: AgentConfig; orchestrator: OrchestratorConfig }
    expect(generated.agent.model).toBe(flash)
    expect(generated.orchestrator.defaultModel).toBe(flash)
    const oma = new OpenMultiAgent({ ...generated.orchestrator, defaultApiKey: 'fixture-key' })
    // Omitting the agent model exercises inheritance of the generated orchestrator default.
    const { model: _model, ...agent } = generated.agent
    const result = await oma.runAgent(agent, 'Hello')
    expect(result.success).toBe(true)
    expect(requests[0].url).toBe('https://api.minimax.io/v1/chat/completions')
    expect(requests[0].body.model).toBe(flash)
    for (const field of ['thinking', 'reasoning_effort', 'reasoning_split', 'service_tier']) {
      expect(requests[0].body).not.toHaveProperty(field)
    }
    for (const model of ['MiniMax-M3', 'MiniMax-M2.7', 'saved-custom-model']) {
      const saved = await oma.runAgent({ ...agent, model }, 'Hello')
      expect(saved.success).toBe(true)
      expect(requests.at(-1)!.body.model).toBe(model)
    }
  })

  it.each([false, true])('preserves regional, custom, and explicit model selection (stream=%s)', async (stream) => {
    for (const baseURL of ['https://api.minimax.io/v1', 'https://api.minimaxi.com/v1', 'https://proxy.example/v1']) {
      vi.stubEnv('MINIMAX_BASE_URL', baseURL)
      for (const model of [flash, 'MiniMax-M3', 'MiniMax-M2.7', 'saved-custom-model']) {
        const request = await send({ model }, stream)
        expect(request.url).toBe(`${baseURL}/chat/completions`)
        expect(request.body.model).toBe(model)
        expect(request.body.stream).toBe(stream)
      }
    }
    const request = await send({ model: 'saved-custom-model' }, stream, 'https://explicit.example/v1')
    expect(request.url).toBe('https://explicit.example/v1/chat/completions')
  })

  it.each([false, true])('serializes supported thinking and effort without changing explicit overrides (stream=%s)', async (stream) => {
    for (const effort of ['low', 'medium', 'high', 'max'] as const) {
      const { body } = await send({ model: flash, thinking: { enabled: true, effort } }, stream)
      expect(body.thinking).toEqual({ type: 'adaptive' })
      expect(body.reasoning_effort).toBe(effort)
    }
    const override = await send({
      model: flash, thinking: { enabled: false, effort: 'low' },
      extraBody: { thinking: { type: 'adaptive' }, reasoning_effort: 'xhigh' },
    }, stream)
    expect(override.body.thinking).toEqual({ type: 'adaptive' })
    expect(override.body.reasoning_effort).toBe('xhigh')
    for (const enabled of [false, true]) {
      const { body } = await send({ model: 'MiniMax-M3', thinking: { enabled, effort: 'max' } }, stream)
      expect(body.thinking).toEqual({ type: enabled ? 'adaptive' : 'disabled' })
      expect(body).not.toHaveProperty('reasoning_effort')
    }
    const before = requests.length
    const error = await send({ model: flash, thinking: { enabled: false } }, stream).catch(error => error)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('requires adaptive thinking')
    expect(isRetryableError(error)).toBe(false)
    expect(requests).toHaveLength(before)
  })

  it.each([false, true])('preserves Flash reasoning, tools, images and videos across a real SDK round trip (stream=%s)', async (stream) => {
    const adapter = await createAdapter('minimax', 'fixture-key')
    toolResponse = true
    let content: ContentBlock[] = []
    if (stream) {
      for await (const event of adapter.stream(messages, { model: flash })) {
        if (event.type === 'done') content = event.data.content
        if (event.type === 'error') throw event.data
      }
    } else {
      content = (await adapter.chat(messages, { model: flash })).content
    }
    toolResponse = false
    await adapter.chat([
      ...messages,
      { role: 'assistant', content: [...content, { type: 'reasoning', text: 'Foreign reasoning', provenance: 'foreign' }] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'call_fixture', content: 'Found it' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } },
        { type: 'video', source: { type: 'url', media_type: 'video/mp4', url: 'https://example.com/video.mp4' } },
      ] },
    ], { model: flash })
    const wire = requests[1].body.messages
    expect(wire[1].reasoning_content).toBe('Preserve this reasoning.')
    expect(wire[1].tool_calls[0].id).toBe('call_fixture')
    expect(wire[2]).toMatchObject({ role: 'tool', tool_call_id: 'call_fixture', content: 'Found it' })
    expect(wire[3].content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj' } },
      { type: 'video_url', video_url: { url: 'https://example.com/video.mp4' } },
    ])
    expect(JSON.stringify(wire)).not.toContain('Foreign reasoning')
  })

  it('retains legacy/custom request behavior and the shared adapter behavior', async () => {
    for (const model of ['MiniMax-M2.7', 'saved-custom-model']) {
      const { body } = await send({ model, thinking: { enabled: false, effort: 'max' }, extraBody: { custom: true } })
      expect(body).not.toHaveProperty('thinking')
      expect(body).not.toHaveProperty('reasoning_effort')
      expect(body.custom).toBe(true)
    }
    const adapter = await createAdapter('openai', 'fixture-key', 'https://other.example/v1')
    await adapter.chat(messages, { model: 'saved-other-model', thinking: { enabled: true, effort: 'max' } })
    expect(requests.at(-1)!.body.model).toBe('saved-other-model')
    expect(requests.at(-1)!.body).not.toHaveProperty('reasoning_effort')
  })
})
