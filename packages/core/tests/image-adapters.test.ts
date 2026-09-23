import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImageModelError } from '../src/errors.js'
import { OpenAIImageAdapter } from '../src/image/openai.js'
import { OpenRouterImageAdapter } from '../src/image/openrouter.js'
import { runImage } from '../src/image/run-image.js'
import { SeedreamImageAdapter } from '../src/image/seedream.js'
import type { ImageRequest } from '../src/image/types.js'
import { jpegHeader, pngHeader } from './helpers/image-bytes.js'

const signal = new AbortController().signal
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

function stubFetch(...responses: Array<Response | Error>) {
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const next = responses.shift()
    if (next === undefined) throw new Error('unexpected fetch')
    if (next instanceof Error) throw next
    return next
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function failure(promise: Promise<unknown>): Promise<ImageModelError> {
  const error = await promise.then(() => undefined, (e: unknown) => e)
  expect(error).toBeInstanceOf(ImageModelError)
  return error as ImageModelError
}

const input = (bytes: Uint8Array, mediaType = 'image/png') => ({ data: bytes, mediaType })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OpenAIImageAdapter', () => {
  const adapter = () => new OpenAIImageAdapter({
    model: 'gpt-image-1',
    apiKey: 'sk-test',
    baseURL: 'https://api.example.com/v1/',
    providerOptions: { quality: 'high' },
  })

  it('sends text-to-image as JSON to /images/generations and returns the decoded bytes', async () => {
    const image = pngHeader(1024, 1024)
    const fetchMock = stubFetch(jsonResponse({ data: [{ b64_json: b64(image) }], usage: { total_tokens: 42 } }))

    const output = await adapter().generate({ prompt: 'a desk', size: '1024x1024' }, { signal })

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.example.com/v1/images/generations')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer sk-test')
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'gpt-image-1',
      prompt: 'a desk',
      n: 1,
      size: '1024x1024',
      quality: 'high',
    })
    expect(init?.signal).toBe(signal)
    expect(Buffer.from(output.data).equals(Buffer.from(image))).toBe(true)
    expect(output.params).toMatchObject({ model: 'gpt-image-1', inputImages: 0, quality: 'high', usage: { total_tokens: 42 } })
  })

  it('sends every input image and the mask as multipart to /images/edits', async () => {
    const fetchMock = stubFetch(jsonResponse({ data: [{ b64_json: b64(pngHeader(8, 8)) }] }))
    const request: ImageRequest = {
      prompt: 'swap the chair',
      images: [input(pngHeader(4, 4)), input(jpegHeader(4, 4), 'image/jpeg'), input(pngHeader(2, 2))],
      mask: input(pngHeader(4, 4)),
    }

    await adapter().generate(request, { signal })

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.example.com/v1/images/edits')
    const form = init?.body as FormData
    expect(form.get('model')).toBe('gpt-image-1')
    expect(form.get('prompt')).toBe('swap the chair')
    expect(form.get('quality')).toBe('high')
    const images = form.getAll('image[]') as File[]
    expect(images).toHaveLength(3)
    expect(images.map(f => [f.name, f.type])).toEqual([
      ['image-0.png', 'image/png'],
      ['image-1.jpg', 'image/jpeg'],
      ['image-2.png', 'image/png'],
    ])
    expect(form.get('mask')).toBeInstanceOf(Blob)
    expect((init?.headers as Record<string, string>)['Content-Type']).toBeUndefined()
  })

  it('uses the singular image field for one input image', async () => {
    const fetchMock = stubFetch(jsonResponse({ data: [{ b64_json: b64(pngHeader(8, 8)) }] }))
    await adapter().generate({ prompt: 'x', images: [input(pngHeader(4, 4))] }, { signal })
    const form = fetchMock.mock.calls[0]![1]?.body as FormData
    expect(form.getAll('image')).toHaveLength(1)
    expect(form.getAll('image[]')).toHaveLength(0)
  })

  it('rejects providerOptions that would replace adapter-set fields', () => {
    for (const key of ['model', 'prompt', 'n', 'image', 'image[]', 'mask']) {
      expect(() => new OpenAIImageAdapter({ model: 'm', apiKey: 'k', providerOptions: { [key]: 'x' } }))
        .toThrow(`openai providerOptions cannot set ${key}`)
    }
  })

  it('treats a size in providerOptions as a default that request.size overrides, without a duplicate field', async () => {
    const fetchMock = stubFetch(
      jsonResponse({ data: [{ b64_json: b64(pngHeader(8, 8)) }] }),
      jsonResponse({ data: [{ b64_json: b64(pngHeader(8, 8)) }] }),
    )
    const custom = new OpenAIImageAdapter({ model: 'm', apiKey: 'k', providerOptions: { size: '1024x1024' } })
    await custom.generate({ prompt: 'x', images: [input(pngHeader(4, 4))] }, { signal })
    await custom.generate({ prompt: 'x', images: [input(pngHeader(4, 4))], size: '1536x1024' }, { signal })
    const forms = fetchMock.mock.calls.map(([, init]) => init?.body as FormData)
    expect(forms[0]!.getAll('size')).toEqual(['1024x1024'])
    expect(forms[1]!.getAll('size')).toEqual(['1536x1024'])
  })

  it('refuses more images than maxInputImages without calling the API', async () => {
    const fetchMock = stubFetch()
    const limited = new OpenAIImageAdapter({ model: 'm', apiKey: 'k', maxInputImages: 1 })
    const error = await failure(limited.generate(
      { prompt: 'x', images: [input(pngHeader(1, 1)), input(pngHeader(1, 1))] },
      { signal },
    ))
    expect(error).toMatchObject({ type: 'invalid_request', retryable: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('classifies a moderation rejection as non-retryable content_policy', async () => {
    stubFetch(jsonResponse({ error: { code: 'moderation_blocked', message: 'Your request was rejected' } }, 400))
    const error = await failure(adapter().generate({ prompt: 'x' }, { signal }))
    expect(error).toMatchObject({
      type: 'content_policy',
      retryable: false,
      status: 400,
      providerCode: 'moderation_blocked',
      provider: 'openai',
    })
    expect(error.message).toContain('Your request was rejected')
  })

  it('classifies other 4xx responses as non-retryable invalid_request', async () => {
    stubFetch(jsonResponse({ error: { code: 'invalid_size', message: 'bad size' } }, 400))
    const error = await failure(adapter().generate({ prompt: 'x' }, { signal }))
    expect(error).toMatchObject({ type: 'invalid_request', retryable: false, providerCode: 'invalid_size' })
  })

  it('classifies 429 with Retry-After as a retryable rate_limit', async () => {
    stubFetch(jsonResponse({ error: { message: 'slow down' } }, 429, { 'Retry-After': '7' }))
    const error = await failure(adapter().generate({ prompt: 'x' }, { signal }))
    expect(error).toMatchObject({ type: 'rate_limit', retryable: true, retryAfterMs: 7_000 })
  })

  it('classifies 5xx as a retryable api_error and transport failures as retryable network', async () => {
    stubFetch(new Response('upstream down', { status: 503 }), new TypeError('fetch failed'))
    expect(await failure(adapter().generate({ prompt: 'x' }, { signal }))).toMatchObject({ type: 'api_error', retryable: true, status: 503 })
    expect(await failure(adapter().generate({ prompt: 'x' }, { signal }))).toMatchObject({ type: 'network', retryable: true })
  })

  it('fails when the response carries a URL instead of base64', async () => {
    stubFetch(jsonResponse({ data: [{ url: 'https://cdn.example.com/a.png' }] }))
    const error = await failure(adapter().generate({ prompt: 'x' }, { signal }))
    expect(error).toMatchObject({ type: 'invalid_output', retryable: false })
  })

  it('fails without a network call when the egress policy denies the endpoint', async () => {
    const fetchMock = stubFetch()
    const guarded = new OpenAIImageAdapter({
      model: 'm',
      apiKey: 'k',
      baseURL: 'https://api.example.com/v1',
      egressPolicy: { mode: 'allowlist', allowedOrigins: ['https://allowed.example.com'] },
    })
    const error = await failure(guarded.generate({ prompt: 'x' }, { signal }))
    expect(error).toMatchObject({ type: 'invalid_request', retryable: false })
    expect(error.message).toContain('Egress policy denied')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails as invalid_request when no API key is configured', async () => {
    const original = process.env['OPENAI_API_KEY']
    delete process.env['OPENAI_API_KEY']
    try {
      const error = await failure(new OpenAIImageAdapter({ model: 'm' }).generate({ prompt: 'x' }, { signal }))
      expect(error).toMatchObject({ type: 'invalid_request', retryable: false })
    } finally {
      if (original !== undefined) process.env['OPENAI_API_KEY'] = original
    }
  })
})

describe('SeedreamImageAdapter', () => {
  const adapter = () => new SeedreamImageAdapter({ model: 'seedream-4-0-250828', apiKey: 'ark-test' })

  it('sends input images as data URLs and always asks for base64 output', async () => {
    const fetchMock = stubFetch(jsonResponse({ data: [{ b64_json: b64(jpegHeader(2048, 1536)) }], usage: { generated_images: 1 } }))
    const first = pngHeader(4, 4)

    const output = await adapter().generate(
      { prompt: 'replace the table', images: [input(first), input(jpegHeader(4, 4), 'image/jpeg')], size: '2k' },
      { signal },
    )

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://ark.cn-beijing.volces.com/api/v3/images/generations')
    expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer ark-test')
    const body = JSON.parse(String(init?.body))
    expect(body).toMatchObject({
      model: 'seedream-4-0-250828',
      prompt: 'replace the table',
      size: '2k',
      watermark: false,
      response_format: 'b64_json',
    })
    expect(body.image).toHaveLength(2)
    expect(body.image[0]).toBe(`data:image/png;base64,${b64(first)}`)
    expect(body.image[1].startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(output.params).toMatchObject({ inputImages: 2, usage: { generated_images: 1 } })
  })

  it('sends a single input image as a string, not an array', async () => {
    const fetchMock = stubFetch(jsonResponse({ data: [{ b64_json: b64(jpegHeader(8, 8)) }] }))
    await adapter().generate({ prompt: 'x', images: [input(pngHeader(4, 4))] }, { signal })
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))
    expect(typeof body.image).toBe('string')
  })

  it('sends free providerOptions and rejects ones that would replace adapter-set fields', async () => {
    const fetchMock = stubFetch(jsonResponse({ data: [{ b64_json: b64(jpegHeader(8, 8)) }] }))
    await new SeedreamImageAdapter({ model: 'm', apiKey: 'k', providerOptions: { seed: 7 } }).generate({ prompt: 'x' }, { signal })
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toMatchObject({ seed: 7, response_format: 'b64_json' })

    for (const key of ['response_format', 'image', 'prompt', 'model']) {
      expect(() => new SeedreamImageAdapter({ model: 'm', apiKey: 'k', providerOptions: { [key]: 'x' } }))
        .toThrow(`seedream providerOptions cannot set ${key}`)
    }
  })

  it('treats size and watermark in providerOptions as defaults, with request.size taking precedence', async () => {
    const fetchMock = stubFetch(
      jsonResponse({ data: [{ b64_json: b64(jpegHeader(8, 8)) }] }),
      jsonResponse({ data: [{ b64_json: b64(jpegHeader(8, 8)) }] }),
    )
    const custom = new SeedreamImageAdapter({ model: 'm', apiKey: 'k', providerOptions: { size: '2k', watermark: true } })
    await custom.generate({ prompt: 'x' }, { signal })
    await custom.generate({ prompt: 'x', size: '4k' }, { signal })
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))
    expect(bodies[0]).toMatchObject({ size: '2k', watermark: true })
    expect(bodies[1]).toMatchObject({ size: '4k', watermark: true })
  })

  it('refuses a mask instead of dropping it', async () => {
    const fetchMock = stubFetch()
    const error = await failure(adapter().generate(
      { prompt: 'x', images: [input(pngHeader(4, 4))], mask: input(pngHeader(4, 4)) },
      { signal },
    ))
    expect(error).toMatchObject({ type: 'invalid_request', retryable: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('classifies a sensitive-content error response as content_policy', async () => {
    stubFetch(jsonResponse({ error: { code: 'OutputImageSensitiveContentDetected', message: 'blocked' } }, 400))
    const error = await failure(adapter().generate({ prompt: 'x' }, { signal }))
    expect(error).toMatchObject({ type: 'content_policy', retryable: false, providerCode: 'OutputImageSensitiveContentDetected' })
  })

  it('classifies a per-image error inside a 200 response', async () => {
    stubFetch(
      jsonResponse({ data: [{ error: { code: 'OutputImageSensitiveContentDetected', message: 'blocked' } }] }),
      jsonResponse({ data: [{ error: { code: 'InternalError', message: 'try again' } }] }),
    )
    expect(await failure(adapter().generate({ prompt: 'x' }, { signal }))).toMatchObject({ type: 'content_policy', retryable: false })
    expect(await failure(adapter().generate({ prompt: 'x' }, { signal }))).toMatchObject({ type: 'invalid_output', retryable: true, providerCode: 'InternalError' })
  })
})

describe('OpenRouterImageAdapter', () => {
  const adapter = () => new OpenRouterImageAdapter({
    model: 'openai/gpt-image-1',
    apiKey: 'or-test',
    providerOptions: { aspect_ratio: '4:3', provider: { order: ['openai'] } },
  })

  it('sends input images as input_references data URLs to /images', async () => {
    const first = pngHeader(4, 4)
    const fetchMock = stubFetch(jsonResponse({ data: [{ b64_json: b64(pngHeader(1024, 768)) }], usage: { total_tokens: 9 } }))

    const output = await adapter().generate(
      { prompt: 'swap the chair', images: [input(first), input(jpegHeader(4, 4), 'image/jpeg')], size: '1024x768' },
      { signal },
    )

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://openrouter.ai/api/v1/images')
    expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer or-test')
    const body = JSON.parse(String(init?.body))
    expect(body).toMatchObject({
      model: 'openai/gpt-image-1',
      prompt: 'swap the chair',
      n: 1,
      size: '1024x768',
      aspect_ratio: '4:3',
      provider: { order: ['openai'] },
    })
    expect(body.input_references).toEqual([
      { type: 'image_url', image_url: { url: `data:image/png;base64,${b64(first)}` } },
      { type: 'image_url', image_url: { url: expect.stringMatching(/^data:image\/jpeg;base64,/) } },
    ])
    expect(output.params).toMatchObject({ inputImages: 2, usage: { total_tokens: 9 } })
  })

  it('rejects providerOptions that would replace the prompt or the input images', () => {
    expect(() => new OpenRouterImageAdapter({
      model: 'm',
      apiKey: 'k',
      providerOptions: { input_references: [], prompt: 'other' },
    })).toThrow('openrouter providerOptions cannot set input_references, prompt')
  })

  it('treats a size in providerOptions as a default that request.size overrides', async () => {
    const fetchMock = stubFetch(
      jsonResponse({ data: [{ b64_json: b64(pngHeader(8, 8)) }] }),
      jsonResponse({ data: [{ b64_json: b64(pngHeader(8, 8)) }] }),
    )
    const custom = new OpenRouterImageAdapter({ model: 'm', apiKey: 'k', providerOptions: { size: '1024x1024' } })
    await custom.generate({ prompt: 'x' }, { signal })
    await custom.generate({ prompt: 'x', size: '1536x1024' }, { signal })
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))
    expect(bodies.map(body => body.size)).toEqual(['1024x1024', '1536x1024'])
  })

  it('omits input_references for text-to-image', async () => {
    const fetchMock = stubFetch(jsonResponse({ data: [{ b64_json: b64(pngHeader(8, 8)) }] }))
    await adapter().generate({ prompt: 'a desk' }, { signal })
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))
    expect(body).not.toHaveProperty('input_references')
  })

  it('refuses a mask instead of dropping it', async () => {
    const fetchMock = stubFetch()
    const error = await failure(adapter().generate(
      { prompt: 'x', images: [input(pngHeader(4, 4))], mask: input(pngHeader(4, 4)) },
      { signal },
    ))
    expect(error).toMatchObject({ type: 'invalid_request', retryable: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('classifies an OpenRouter moderation 403 as content_policy', async () => {
    stubFetch(jsonResponse({
      error: {
        code: 403,
        message: 'Your chosen model requires moderation and your input was flagged',
        metadata: { reasons: ['sexual'], flagged_input: 'x', provider_name: 'OpenAI', model_slug: 'openai/gpt-image-1' },
      },
    }, 403))
    const error = await failure(adapter().generate({ prompt: 'x' }, { signal }))
    expect(error).toMatchObject({ type: 'content_policy', retryable: false, status: 403, provider: 'openrouter' })
  })

  it('classifies an upstream rejection forwarded in metadata.raw as content_policy', async () => {
    stubFetch(
      jsonResponse({
        error: {
          code: 400,
          message: 'Provider returned error',
          metadata: { provider_name: 'OpenAI', raw: JSON.stringify({ error: { code: 'moderation_blocked', message: 'rejected' } }) },
        },
      }, 400),
      jsonResponse({
        error: {
          code: 400,
          message: 'Provider returned error',
          metadata: { provider_name: 'ByteDance', raw: { error: { code: 'OutputImageSensitiveContentDetected' } } },
        },
      }, 400),
    )
    expect(await failure(adapter().generate({ prompt: 'x' }, { signal }))).toMatchObject({ type: 'content_policy', retryable: false })
    expect(await failure(adapter().generate({ prompt: 'x' }, { signal }))).toMatchObject({ type: 'content_policy', retryable: false })
  })

  it('classifies an upstream rejection forwarded with a 5xx status as content_policy, not a retryable api_error', async () => {
    stubFetch(
      jsonResponse({
        error: {
          code: 502,
          message: 'Provider returned error',
          metadata: { provider_name: 'OpenAI', raw: JSON.stringify({ error: { code: 'moderation_blocked' } }) },
        },
      }, 502),
      jsonResponse({ error: { code: 502, message: 'Provider returned error', metadata: { provider_name: 'OpenAI' } } }, 502),
    )
    expect(await failure(adapter().generate({ prompt: 'x' }, { signal }))).toMatchObject({ type: 'content_policy', retryable: false, status: 502 })
    expect(await failure(adapter().generate({ prompt: 'x' }, { signal }))).toMatchObject({ type: 'api_error', retryable: true, status: 502 })
  })

  it('classifies an upstream rejection reported in metadata.provider_code as content_policy', async () => {
    stubFetch(jsonResponse({
      error: { code: 400, message: 'Provider returned error', metadata: { provider_name: 'OpenAI', provider_code: 'moderation_blocked' } },
    }, 400))
    const error = await failure(adapter().generate({ prompt: 'x' }, { signal }))
    expect(error).toMatchObject({ type: 'content_policy', retryable: false })
  })

  it('treats other 4xx, including a 403 without moderation metadata, as invalid_request', async () => {
    stubFetch(
      jsonResponse({ error: { code: 402, message: 'Insufficient credits' } }, 402),
      jsonResponse({ error: { code: 403, message: 'Key disabled' } }, 403),
      jsonResponse({ error: { code: 400, message: 'bad', metadata: { raw: 'not json' } } }, 400),
      jsonResponse({ error: { code: 400, message: 'bad', metadata: { provider_code: 'invalid_size' } } }, 400),
    )
    for (let i = 0; i < 4; i++) {
      expect(await failure(adapter().generate({ prompt: 'x' }, { signal }))).toMatchObject({ type: 'invalid_request', retryable: false })
    }
  })

  it('treats an empty data array as a retryable invalid_output', async () => {
    stubFetch(jsonResponse({ data: [] }))
    const error = await failure(adapter().generate({ prompt: 'x' }, { signal }))
    expect(error).toMatchObject({ type: 'invalid_output', retryable: true })
  })

  it('fails without a network call when the egress policy denies OpenRouter', async () => {
    const fetchMock = stubFetch()
    const guarded = new OpenRouterImageAdapter({
      model: 'm',
      apiKey: 'k',
      egressPolicy: { mode: 'allowlist', allowedOrigins: ['https://api.openai.com'] },
    })
    const error = await failure(guarded.generate({ prompt: 'x' }, { signal }))
    expect(error).toMatchObject({ type: 'invalid_request', retryable: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('runImage with the built-in adapters', () => {
  it('falls back from a moderated provider to the next one and records both calls', async () => {
    stubFetch(
      jsonResponse({ error: { code: 'moderation_blocked', message: 'no' } }, 400),
      jsonResponse({ data: [{ b64_json: b64(jpegHeader(1536, 1024)) }] }),
    )
    const result = await runImage({
      chain: [
        new OpenAIImageAdapter({ model: 'gpt-image-1', apiKey: 'k' }),
        new SeedreamImageAdapter({ model: 'seedream-4-0-250828', apiKey: 'k' }),
      ],
      request: { prompt: 'an office' },
    })

    expect(result.status).toBe('succeeded')
    if (result.status !== 'succeeded') return
    expect(result.provider).toBe('seedream')
    expect(result.output).toMatchObject({ mediaType: 'image/jpeg', width: 1536, height: 1024 })
    expect(result.attempts.map(r => [r.provider, r.status, r.errorType])).toEqual([
      ['openai', 'failed', 'content_policy'],
      ['seedream', 'succeeded', undefined],
    ])
  })
})
