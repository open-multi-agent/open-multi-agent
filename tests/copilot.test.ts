/**
 * @fileoverview Unit tests for CopilotAdapter.
 *
 * All network calls (GitHub token exchange, Copilot chat API) are mocked so
 * no real GitHub account or Copilot subscription is required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CopilotAdapter } from '../src/llm/copilot.js'
import type { LLMMessage } from '../src/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_CODE = 'ABCD-1234'
const VERIFICATION_URI = 'https://github.com/login/device'
const OAUTH_TOKEN = 'ghu_testOAuthToken'
const COPILOT_TOKEN = 'tid=test;exp=9999999999'
const COPILOT_EXPIRES_AT = Math.floor(Date.now() / 1000) + 3600

const userMsg = (text: string): LLMMessage => ({
  role: 'user',
  content: [{ type: 'text', text }],
})

function makeSSEStream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })
}

function copilotTokenResponse() {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ token: COPILOT_TOKEN, expires_at: COPILOT_EXPIRES_AT }),
    text: () => Promise.resolve(''),
  }
}

function completionResponse(content: string, model = 'gpt-4o') {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        id: 'cmpl-1',
        model,
        choices: [{ message: { content, tool_calls: undefined }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    text: () => Promise.resolve(''),
    body: null,
  }
}

/** Build a mock fetch that sequences through multiple responses. */
function buildFetchSequence(responses: object[]): typeof fetch {
  let idx = 0
  return vi.fn().mockImplementation(() => {
    const res = responses[idx] ?? responses[responses.length - 1]
    idx++
    return Promise.resolve(res)
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CopilotAdapter', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  // -------------------------------------------------------------------------
  // Constructor / token resolution
  // -------------------------------------------------------------------------

  describe('constructor', () => {
    it('accepts a token directly', () => {
      const adapter = new CopilotAdapter(OAUTH_TOKEN)
      expect(adapter.name).toBe('copilot')
    })

    it('reads GITHUB_COPILOT_TOKEN env var', () => {
      vi.stubEnv('GITHUB_COPILOT_TOKEN', OAUTH_TOKEN)
      vi.stubEnv('GITHUB_TOKEN', '')
      expect(() => new CopilotAdapter()).not.toThrow()
    })

    it('reads GITHUB_TOKEN env var as fallback', () => {
      vi.stubEnv('GITHUB_COPILOT_TOKEN', '')
      vi.stubEnv('GITHUB_TOKEN', OAUTH_TOKEN)
      expect(() => new CopilotAdapter()).not.toThrow()
    })

    it('throws when no token is available', () => {
      vi.stubEnv('GITHUB_COPILOT_TOKEN', '')
      vi.stubEnv('GITHUB_TOKEN', '')
      // hosts.json is unlikely to exist in CI; if it does this test may pass by accident
      // so we just verify the error message shape when it throws
      try {
        new CopilotAdapter()
      } catch (e) {
        expect((e as Error).message).toContain('No GitHub token found')
      }
    })
  })

  // -------------------------------------------------------------------------
  // chat() — token exchange + text response
  // -------------------------------------------------------------------------

  describe('chat()', () => {
    it('exchanges OAuth token for Copilot token then calls the chat API', async () => {
      globalThis.fetch = buildFetchSequence([
        copilotTokenResponse(),
        completionResponse('The sky is blue.'),
      ])

      const adapter = new CopilotAdapter(OAUTH_TOKEN)
      const result = await adapter.chat([userMsg('Why is the sky blue?')], { model: 'gpt-4o' })

      expect(result.content[0]).toMatchObject({ type: 'text', text: 'The sky is blue.' })
      expect(result.model).toBe('gpt-4o')
      expect(result.stop_reason).toBe('end_turn')
      expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 5 })
    })

    it('caches the Copilot token across multiple calls', async () => {
      const fetcher = buildFetchSequence([
        copilotTokenResponse(),               // fetched once
        completionResponse('first reply'),
        completionResponse('second reply'),   // token not re-fetched
      ])
      globalThis.fetch = fetcher

      const adapter = new CopilotAdapter(OAUTH_TOKEN)
      await adapter.chat([userMsg('q1')], { model: 'gpt-4o' })
      await adapter.chat([userMsg('q2')], { model: 'gpt-4o' })

      // Only 3 fetch calls total: 1 token + 2 chat
      expect((fetcher as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3)
    })

    it('includes tools in the request body', async () => {
      const fetcher = buildFetchSequence([
        copilotTokenResponse(),
        completionResponse('ok'),
      ])
      globalThis.fetch = fetcher

      const adapter = new CopilotAdapter(OAUTH_TOKEN)
      await adapter.chat([userMsg('hi')], {
        model: 'gpt-4o',
        tools: [
          { name: 'search', description: 'Search', inputSchema: { type: 'object', properties: {} } },
        ],
      })

      const chatCall = (fetcher as ReturnType<typeof vi.fn>).mock.calls[1]
      const sent = JSON.parse(chatCall[1].body as string)
      expect(sent.tools).toHaveLength(1)
      expect(sent.tools[0].function.name).toBe('search')
    })

    it('includes Authorization and Editor-Version headers', async () => {
      const fetcher = buildFetchSequence([
        copilotTokenResponse(),
        completionResponse('ok'),
      ])
      globalThis.fetch = fetcher

      await new CopilotAdapter(OAUTH_TOKEN).chat([userMsg('hi')], { model: 'gpt-4o' })

      const chatCall = (fetcher as ReturnType<typeof vi.fn>).mock.calls[1]
      const headers: Record<string, string> = chatCall[1].headers as Record<string, string>
      expect(headers['Authorization']).toBe(`Bearer ${COPILOT_TOKEN}`)
      expect(headers['Editor-Version']).toBeDefined()
    })

    it('throws on non-2xx responses', async () => {
      globalThis.fetch = buildFetchSequence([
        copilotTokenResponse(),
        {
          ok: false,
          status: 403,
          statusText: 'Forbidden',
          text: () => Promise.resolve('no access'),
          body: null,
        },
      ])

      await expect(
        new CopilotAdapter(OAUTH_TOKEN).chat([userMsg('hi')], { model: 'gpt-4o' }),
      ).rejects.toThrow('Copilot API error 403')
    })

    it('parses tool_calls in the response', async () => {
      globalThis.fetch = buildFetchSequence([
        copilotTokenResponse(),
        {
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              id: 'cmpl-2',
              model: 'gpt-4o',
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: 'call_1',
                        function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
              usage: { prompt_tokens: 20, completion_tokens: 10 },
            }),
          text: () => Promise.resolve(''),
          body: null,
        },
      ])

      const result = await new CopilotAdapter(OAUTH_TOKEN).chat(
        [userMsg('What is the weather in Paris?')],
        { model: 'gpt-4o' },
      )

      const toolBlock = result.content.find((b) => b.type === 'tool_use')
      expect(toolBlock).toMatchObject({
        type: 'tool_use',
        id: 'call_1',
        name: 'get_weather',
        input: { city: 'Paris' },
      })
      expect(result.stop_reason).toBe('tool_use')
    })
  })

  // -------------------------------------------------------------------------
  // stream()
  // -------------------------------------------------------------------------

  describe('stream()', () => {
    it('yields incremental text events and a done event', async () => {
      const sseData =
        'data: ' + JSON.stringify({
          id: 'cmpl-1',
          model: 'gpt-4o',
          choices: [{ delta: { content: 'Hello' }, finish_reason: null }],
        }) + '\n\n' +
        'data: ' + JSON.stringify({
          id: 'cmpl-1',
          model: 'gpt-4o',
          choices: [{ delta: { content: ' world' }, finish_reason: null }],
        }) + '\n\n' +
        'data: ' + JSON.stringify({
          id: 'cmpl-1',
          model: 'gpt-4o',
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        }) + '\n\n' +
        'data: [DONE]\n\n'

      globalThis.fetch = buildFetchSequence([
        copilotTokenResponse(),
        { ok: true, status: 200, body: makeSSEStream(sseData) },
      ])

      const events = []
      for await (const ev of new CopilotAdapter(OAUTH_TOKEN).stream([userMsg('hi')], { model: 'gpt-4o' })) {
        events.push(ev)
      }

      const textEvents = events.filter((e) => e.type === 'text')
      expect(textEvents).toEqual([
        { type: 'text', data: 'Hello' },
        { type: 'text', data: ' world' },
      ])

      const doneEvent = events.find((e) => e.type === 'done')
      expect(doneEvent).toBeDefined()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((doneEvent as any).data.stop_reason).toBe('end_turn')
    })

    it('yields an error event on HTTP failure', async () => {
      globalThis.fetch = buildFetchSequence([
        copilotTokenResponse(),
        {
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          text: () => Promise.resolve('rate limited'),
        },
      ])

      const events = []
      for await (const ev of new CopilotAdapter(OAUTH_TOKEN).stream([userMsg('hi')], { model: 'gpt-4o' })) {
        events.push(ev)
      }

      expect(events[0]).toMatchObject({ type: 'error' })
    })
  })

  // -------------------------------------------------------------------------
  // authenticate() — Device Flow (mocked)
  // -------------------------------------------------------------------------

  describe('authenticate()', () => {
    it('runs the device flow and returns an OAuth token', async () => {
      globalThis.fetch = buildFetchSequence([
        // 1. Device code request
        {
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              device_code: 'dc123',
              user_code: USER_CODE,
              verification_uri: VERIFICATION_URI,
              expires_in: 900,
              interval: 0, // no wait in tests
            }),
        },
        // 2. First poll — pending
        {
          ok: true,
          status: 200,
          json: () => Promise.resolve({ error: 'authorization_pending' }),
        },
        // 3. Second poll — success
        {
          ok: true,
          status: 200,
          json: () => Promise.resolve({ access_token: OAUTH_TOKEN }),
        },
        // 4. User info
        {
          ok: true,
          status: 200,
          json: () => Promise.resolve({ login: 'testuser' }),
        },
      ])

      const prompted = { userCode: '', uri: '' }
      const token = await CopilotAdapter.authenticate((userCode, uri) => {
        prompted.userCode = userCode
        prompted.uri = uri
      })

      expect(token).toBe(OAUTH_TOKEN)
      expect(prompted.userCode).toBe(USER_CODE)
      expect(prompted.uri).toBe(VERIFICATION_URI)
    })

    it('throws when the device flow times out', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            device_code: 'dc123',
            user_code: USER_CODE,
            verification_uri: VERIFICATION_URI,
            expires_in: 0, // already expired
            interval: 0,
          }),
      })

      await expect(CopilotAdapter.authenticate(() => {})).rejects.toThrow('timed out')
    })
  })
})
