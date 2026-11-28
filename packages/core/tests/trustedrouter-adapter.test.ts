import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock OpenAI constructor (must be hoisted for Vitest)
// ---------------------------------------------------------------------------
const { OpenAIMock, createCompletionMock } = vi.hoisted(() => {
  const createCompletionMock = vi.fn()
  const OpenAIMock = vi.fn(function () {
    return {
      chat: {
        completions: {
          create: createCompletionMock,
        },
      },
    }
  })
  return { OpenAIMock, createCompletionMock }
})

vi.mock('openai', () => ({
  default: OpenAIMock,
}))

import { TrustedRouterAdapter } from '../src/llm/trustedrouter.js'
import { createAdapter } from '../src/llm/adapter.js'

// ---------------------------------------------------------------------------
// TrustedRouterAdapter tests
// ---------------------------------------------------------------------------

describe('TrustedRouterAdapter', () => {
  beforeEach(() => {
    OpenAIMock.mockClear()
    createCompletionMock.mockReset()
  })

  it('has name "trustedrouter"', () => {
    const adapter = new TrustedRouterAdapter()
    expect(adapter.name).toBe('trustedrouter')
  })

  it('uses TRUSTEDROUTER_API_KEY by default', () => {
    const original = process.env['TRUSTEDROUTER_API_KEY']
    process.env['TRUSTEDROUTER_API_KEY'] = 'trustedrouter-test-key-123'

    try {
      new TrustedRouterAdapter()
      expect(OpenAIMock).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'trustedrouter-test-key-123',
          baseURL: 'https://api.trustedrouter.com/v1',
        }),
      )
    } finally {
      if (original === undefined) {
        delete process.env['TRUSTEDROUTER_API_KEY']
      } else {
        process.env['TRUSTEDROUTER_API_KEY'] = original
      }
    }
  })

  it('uses official TrustedRouter baseURL by default', () => {
    new TrustedRouterAdapter('some-key')
    expect(OpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'some-key',
        baseURL: 'https://api.trustedrouter.com/v1',
      }),
    )
  })

  it('allows overriding apiKey and baseURL', () => {
    new TrustedRouterAdapter('custom-key', 'https://custom.endpoint/v1')
    expect(OpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'custom-key',
        baseURL: 'https://custom.endpoint/v1',
      }),
    )
  })

  it('createAdapter("trustedrouter") returns TrustedRouterAdapter instance', async () => {
    const adapter = await createAdapter('trustedrouter')
    expect(adapter).toBeInstanceOf(TrustedRouterAdapter)
  })

  it.each([
    'deepseek/deepseek-v4-flash',
    'anthropic/claude-sonnet-4-6',
    'trustedrouter/auto',
    'trustedrouter/zdr',
    'trustedrouter/e2e',
    'nyte/auto',
  ])('forwards vendor/model IDs and routing preset %s unchanged', async (model) => {
    createCompletionMock.mockResolvedValue({
      id: 'chatcmpl-tr-1',
      object: 'chat.completion',
      created: 1700000000,
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'ok', refusal: null },
          finish_reason: 'stop',
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })

    const adapter = new TrustedRouterAdapter('test-key')
    const response = await adapter.chat(
      [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      { model },
    )

    expect(createCompletionMock).toHaveBeenCalledWith(
      expect.objectContaining({ model, stream: false }),
      expect.anything(),
    )
    expect(response.model).toBe(model)
  })

  it('enforces default egressPolicy origin https://api.trustedrouter.com', async () => {
    const allowed = await createAdapter(
      'trustedrouter',
      'test-key',
      undefined,
      undefined,
      { mode: 'allowlist', allowedOrigins: ['https://api.trustedrouter.com'] },
    )
    expect(allowed).toBeInstanceOf(TrustedRouterAdapter)
    expect(OpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'test-key',
        baseURL: 'https://api.trustedrouter.com/v1',
        fetch: expect.any(Function),
      }),
    )

    OpenAIMock.mockClear()
    await expect(
      createAdapter('trustedrouter', 'test-key', undefined, undefined, { mode: 'offline' }),
    ).rejects.toMatchObject({
      code: 'EGRESS_POLICY_DENIED',
      provider: 'trustedrouter',
      origin: 'https://api.trustedrouter.com',
    })
    expect(OpenAIMock).not.toHaveBeenCalled()
  })
})
