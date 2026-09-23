import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImageModelError } from '../src/errors.js'
import { OpenAIImageAdapter } from '../src/image/openai.js'
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

  it('does not let providerOptions switch the output to a URL', async () => {
    const fetchMock = stubFetch(jsonResponse({ data: [{ b64_json: b64(jpegHeader(8, 8)) }] }))
    const custom = new SeedreamImageAdapter({
      model: 'm',
      apiKey: 'k',
      providerOptions: { seed: 7, response_format: 'url' },
    })
    await custom.generate({ prompt: 'x' }, { signal })
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))
    expect(body).toMatchObject({ seed: 7, response_format: 'b64_json' })
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
