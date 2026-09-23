import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImageModelError } from '../src/errors.js'
import { BlackForestLabsImageAdapter } from '../src/image/black-forest-labs.js'
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

  it('declares the media type of the returned bytes, not a fixed one', async () => {
    stubFetch(jsonResponse({ data: [{ b64_json: b64(jpegHeader(8, 8)) }] }))
    const jpeg = new OpenAIImageAdapter({ model: 'm', apiKey: 'k', providerOptions: { output_format: 'jpeg' } })
    const output = await jpeg.generate({ prompt: 'x' }, { signal })
    expect(output.mediaType).toBe('image/jpeg')
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

describe('BlackForestLabsImageAdapter', () => {
  const POLL = 'https://api.us1.bfl.ai/v1/get_result?id=task-1'
  const SAMPLE = 'https://delivery-us1.bfl.ai/results/task-1/sample.jpeg?sig=abc'
  const submitted = (pollingUrl = POLL) =>
    jsonResponse({ id: 'task-1', polling_url: pollingUrl, cost: 3, input_mp: 1, output_mp: 2 })
  const status = (value: string, extra: Record<string, unknown> = {}) => jsonResponse({ id: 'task-1', status: value, ...extra })
  const ready = () => status('Ready', { result: { sample: SAMPLE } })
  const imageResponse = (bytes = jpegHeader(1024, 768)) => new Response(bytes, { status: 200 })
  const adapter = () => new BlackForestLabsImageAdapter({
    model: 'flux-2-pro',
    apiKey: 'bfl-test',
    pollIntervalMs: 0,
    providerOptions: { output_format: 'jpeg', safety_tolerance: 2 },
  })
  const headersOf = (init: RequestInit | undefined) => (init?.headers ?? {}) as Record<string, string>

  it('submits, polls until Ready, and downloads the sample without the key', async () => {
    const first = pngHeader(4, 4)
    const fetchMock = stubFetch(submitted(), status('Pending'), ready(), imageResponse())

    const output = await adapter().generate(
      { prompt: 'replace the lamp', images: [input(first), input(jpegHeader(4, 4), 'image/jpeg')], size: '1024x768' },
      { signal },
    )

    const [submitUrl, submitInit] = fetchMock.mock.calls[0]!
    expect(submitUrl).toBe('https://api.bfl.ai/v1/flux-2-pro')
    expect(headersOf(submitInit)['x-key']).toBe('bfl-test')
    expect(submitInit?.redirect).toBe('error')
    const body = JSON.parse(String(submitInit?.body))
    expect(body).toMatchObject({
      prompt: 'replace the lamp',
      width: 1024,
      height: 768,
      input_image: b64(first),
      output_format: 'jpeg',
      safety_tolerance: 2,
    })
    expect(typeof body.input_image_2).toBe('string')
    expect(body).not.toHaveProperty('input_image_3')

    const [pollUrl, pollInit] = fetchMock.mock.calls[1]!
    expect(pollUrl).toBe(POLL)
    expect(headersOf(pollInit)['x-key']).toBe('bfl-test')
    expect(pollInit?.redirect).toBe('error')

    const [downloadUrl, downloadInit] = fetchMock.mock.calls[3]!
    expect(downloadUrl).toBe(SAMPLE)
    expect(headersOf(downloadInit)['x-key']).toBeUndefined()

    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(Buffer.from(output.data).equals(Buffer.from(jpegHeader(1024, 768)))).toBe(true)
    expect(output.params).toMatchObject({ model: 'flux-2-pro', inputImages: 2, taskId: 'task-1', cost: 3, input_mp: 1, output_mp: 2 })
  })

  it('rejects providerOptions that carry the prompt or input images, and treats width and height as defaults', async () => {
    for (const key of ['prompt', 'image', 'mask', 'input_image', 'input_image_2']) {
      expect(() => new BlackForestLabsImageAdapter({ model: 'm', apiKey: 'k', providerOptions: { [key]: 'x' } }))
        .toThrow(`black-forest-labs providerOptions cannot set ${key}`)
    }
    const fetchMock = stubFetch(submitted(), ready(), imageResponse(), submitted(), ready(), imageResponse())
    const custom = new BlackForestLabsImageAdapter({
      model: 'flux-2-pro',
      apiKey: 'k',
      pollIntervalMs: 0,
      providerOptions: { width: 800, height: 600 },
    })
    await custom.generate({ prompt: 'x' }, { signal })
    await custom.generate({ prompt: 'x', size: '1024x768' }, { signal })
    const bodies = [fetchMock.mock.calls[0]!, fetchMock.mock.calls[3]!].map(([, init]) => JSON.parse(String(init?.body)))
    expect(bodies[0]).toMatchObject({ width: 800, height: 600 })
    expect(bodies[1]).toMatchObject({ width: 1024, height: 768 })
  })

  it('declares the media type of the bytes it downloaded, whatever output_format asked for', async () => {
    stubFetch(submitted(), ready(), imageResponse(pngHeader(512, 512)))
    const png = new BlackForestLabsImageAdapter({
      model: 'flux-2-pro',
      apiKey: 'k',
      pollIntervalMs: 0,
      providerOptions: { output_format: 'png' },
    })
    const output = await png.generate({ prompt: 'x' }, { signal })
    expect(output.mediaType).toBe('image/png')
  })

  it('records the width and height actually sent when request.size overrides the defaults', async () => {
    stubFetch(submitted(), ready(), imageResponse())
    const custom = new BlackForestLabsImageAdapter({
      model: 'flux-2-pro',
      apiKey: 'k',
      pollIntervalMs: 0,
      providerOptions: { width: 800, height: 600 },
    })
    const output = await custom.generate({ prompt: 'x', size: '1024x768' }, { signal })
    expect(output.params).toMatchObject({ width: 1024, height: 768 })
    expect(output.params).not.toHaveProperty('size')
  })

  it('retries transient poll and download failures without submitting a second task', async () => {
    const fetchMock = stubFetch(
      submitted(),
      new Response('busy', { status: 503 }),
      new TypeError('fetch failed'),
      jsonResponse({ detail: 'slow down' }, 429, { 'Retry-After': '0' }),
      ready(),
      new Response('bad gateway', { status: 502 }),
      imageResponse(),
    )
    const output = await adapter().generate({ prompt: 'x' }, { signal })
    const submits = fetchMock.mock.calls.filter(([url]) => String(url) === 'https://api.bfl.ai/v1/flux-2-pro')
    expect(submits).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(7)
    expect(output.params).toMatchObject({ taskId: 'task-1' })
  })

  it('retries a rate-limited or timed-out download in place, honoring Retry-After', async () => {
    const fetchMock = stubFetch(
      submitted(),
      ready(),
      new Response('slow down', { status: 429, headers: { 'Retry-After': '0' } }),
      new Response('timeout', { status: 408 }),
      imageResponse(),
    )
    await adapter().generate({ prompt: 'x' }, { signal })
    const submits = fetchMock.mock.calls.filter(([url]) => String(url) === 'https://api.bfl.ai/v1/flux-2-pro')
    expect(submits).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it('still fails at once on a non-retryable poll error', async () => {
    const fetchMock = stubFetch(submitted(), jsonResponse({ detail: 'bad key' }, 401))
    const error = await failure(adapter().generate({ prompt: 'x' }, { signal }))
    expect(error).toMatchObject({ type: 'invalid_request', retryable: false, status: 401 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keeps polling through the in-progress Reasoning and Generating states', async () => {
    const fetchMock = stubFetch(submitted(), status('Reasoning'), status('Generating'), ready(), imageResponse())
    await adapter().generate({ prompt: 'x' }, { signal })
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it('reads the status from a state field too', async () => {
    const fetchMock = stubFetch(submitted(), jsonResponse({ state: 'Ready', result: { sample: SAMPLE } }), imageResponse())
    await adapter().generate({ prompt: 'x' }, { signal })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it.each(['Request Moderated', 'Content Moderated'])('stops at once with content_policy on %s', async moderated => {
    const fetchMock = stubFetch(submitted(), status('Pending'), status(moderated))
    const error = await failure(adapter().generate({ prompt: 'x' }, { signal }))
    expect(error).toMatchObject({ type: 'content_policy', retryable: false, provider: 'black-forest-labs' })
    expect(error.message).toContain(moderated)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('ends the turn without a resubmit on failed, lost, and sample-less tasks, keeping the task and cost', async () => {
    stubFetch(
      submitted(), status('Error'),
      submitted(), status('Task not found'),
      submitted(), status('Ready', { result: {} }),
    )
    const failed = await failure(adapter().generate({ prompt: 'x' }, { signal }))
    const lost = await failure(adapter().generate({ prompt: 'x' }, { signal }))
    const noSample = await failure(adapter().generate({ prompt: 'x' }, { signal }))
    expect(failed).toMatchObject({ type: 'api_error', retryable: false })
    expect(lost).toMatchObject({ type: 'invalid_output', retryable: false })
    expect(noSample).toMatchObject({ type: 'invalid_output', retryable: false })
    for (const error of [failed, lost, noSample]) {
      expect(error.params).toMatchObject({ taskId: 'task-1', cost: 3, input_mp: 1, output_mp: 2 })
    }
  })

  it('ends the turn instead of waiting out a Retry-After above the caller cap', async () => {
    const fetchMock = stubFetch(submitted(), jsonResponse({ detail: 'slow down' }, 429, { 'Retry-After': '30' }))
    const started = Date.now()
    const error = await failure(adapter().generate({ prompt: 'x' }, { signal, maxRetryAfterMs: 1_000 }))
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(error).toMatchObject({ type: 'rate_limit', retryable: false, retryAfterMs: 30_000 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('records the task and its cost on a failed runImage attempt after the submit', async () => {
    stubFetch(submitted(), status('Request Moderated'))
    const result = await runImage({
      chain: [new BlackForestLabsImageAdapter({ model: 'flux-2-pro', apiKey: 'k', pollIntervalMs: 0 })],
      request: { prompt: 'x' },
    })
    expect(result.attempts).toHaveLength(1)
    expect(result.attempts[0]).toMatchObject({
      status: 'failed',
      errorType: 'content_policy',
      params: { taskId: 'task-1', cost: 3 },
    })
  })

  it('does not send the key to a polling URL outside bfl.ai', async () => {
    const foreign = 'https://poll.example.com/get_result?id=task-1'
    const fetchMock = stubFetch(submitted(foreign), ready(), imageResponse())
    await adapter().generate({ prompt: 'x' }, { signal })
    const [pollUrl, pollInit] = fetchMock.mock.calls[1]!
    expect(pollUrl).toBe(foreign)
    expect(headersOf(pollInit)['x-key']).toBeUndefined()
  })

  it('ends the turn on a submit response without polling_url, and on a permanent download failure', async () => {
    stubFetch(jsonResponse({ id: 'task-1', cost: 3 }), submitted(), ready(), new Response('gone', { status: 404 }))
    const noPolling = await failure(adapter().generate({ prompt: 'x' }, { signal }))
    expect(noPolling).toMatchObject({ type: 'invalid_output', retryable: false })
    expect(noPolling.params).toMatchObject({ taskId: 'task-1', cost: 3 })
    const download = await failure(adapter().generate({ prompt: 'x' }, { signal }))
    expect(download).toMatchObject({ type: 'api_error', retryable: false, status: 404 })
    expect(download.message).toContain('not resubmitting')
  })

  it('ends the turn on a 200 download that is not an image, without letting runImage resubmit', async () => {
    const fetchMock = stubFetch(
      submitted(),
      ready(),
      new Response('<html>expired</html>', { status: 200 }),
    )
    const result = await runImage({
      chain: [new BlackForestLabsImageAdapter({ model: 'flux-2-pro', apiKey: 'k', pollIntervalMs: 0 })],
      request: { prompt: 'x' },
      backoffBaseMs: 0,
    })
    const submits = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/flux-2-pro'))
    expect(submits).toHaveLength(1)
    expect(result.status).toBe('failed')
    expect(result.attempts).toHaveLength(1)
    expect(result.attempts[0]).toMatchObject({
      status: 'failed',
      errorType: 'invalid_output',
      retryable: false,
      params: { taskId: 'task-1' },
    })
  })

  it('does not let runImage resubmit after a permanent download failure', async () => {
    const fetchMock = stubFetch(
      submitted(),
      ready(),
      new Response('expired', { status: 403 }),
      jsonResponse({ data: [{ b64_json: b64(jpegHeader(64, 64)) }] }),
    )
    const result = await runImage({
      chain: [
        new BlackForestLabsImageAdapter({ model: 'flux-2-pro', apiKey: 'k', pollIntervalMs: 0 }),
        new SeedreamImageAdapter({ model: 'doubao-seedream-4-0-250828', apiKey: 'k' }),
      ],
      request: { prompt: 'x' },
      backoffBaseMs: 0,
    })
    const submits = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/flux-2-pro'))
    expect(submits).toHaveLength(1)
    expect(result.status).toBe('succeeded')
    expect(result.attempts.map(r => [r.provider, r.status, r.retryable])).toEqual([
      ['black-forest-labs', 'failed', false],
      ['seedream', 'succeeded', undefined],
    ])
  })

  it('gives a direct caller its own abort reason after the submit, and a final timeout only for a deadline', async () => {
    const pending = () => vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/flux-2-pro') ? submitted() : status('Pending'),
    )
    vi.stubGlobal('fetch', pending())
    const controller = new AbortController()
    const reason = new Error('user cancelled')
    setTimeout(() => controller.abort(reason), 15)
    await expect(adapter().generate({ prompt: 'x' }, { signal: controller.signal })).rejects.toBe(reason)

    vi.stubGlobal('fetch', pending())
    const timedOut = await failure(adapter().generate({ prompt: 'x' }, { signal: AbortSignal.timeout(15) }))
    expect(timedOut).toMatchObject({ type: 'timeout', retryable: false })
  })

  it('refuses a mask and a size it cannot express, without calling the API', async () => {
    const fetchMock = stubFetch()
    const withMask = await failure(adapter().generate(
      { prompt: 'x', images: [input(pngHeader(4, 4))], mask: input(pngHeader(4, 4)) },
      { signal },
    ))
    const badSize = await failure(adapter().generate({ prompt: 'x', size: '2k' }, { signal }))
    expect(withMask).toMatchObject({ type: 'invalid_request', retryable: false })
    expect(badSize).toMatchObject({ type: 'invalid_request', retryable: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('checks the polling origin against the egress policy, not only the API origin', async () => {
    const fetchMock = stubFetch(submitted())
    const guarded = new BlackForestLabsImageAdapter({
      model: 'flux-2-pro',
      apiKey: 'k',
      pollIntervalMs: 0,
      egressPolicy: { mode: 'allowlist', allowedOrigins: ['https://api.bfl.ai'] },
    })
    const error = await failure(guarded.generate({ prompt: 'x' }, { signal }))
    expect(error).toMatchObject({ type: 'invalid_request', retryable: false })
    expect(error.message).toContain('https://api.us1.bfl.ai')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('treats a deadline after the submit as final, so runImage never resubmits the task', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/flux-2-pro') ? submitted() : status('Pending'),
    )
    vi.stubGlobal('fetch', fetchMock)
    const result = await runImage({
      chain: [new BlackForestLabsImageAdapter({ model: 'flux-2-pro', apiKey: 'k', pollIntervalMs: 5 })],
      request: { prompt: 'x' },
      attemptTimeoutMs: 40,
      backoffBaseMs: 0,
    })
    const submits = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/flux-2-pro'))
    expect(submits).toHaveLength(1)
    expect(result.status).toBe('failed')
    expect(result.attempts).toHaveLength(1)
    expect(result.attempts[0]).toMatchObject({ errorType: 'timeout', retryable: false })
    expect(result.attempts[0]!.errorMessage).toContain('task-1')
  })

  it('still retries a deadline reached before the submit completed', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const result = await runImage({
      chain: [new BlackForestLabsImageAdapter({ model: 'flux-2-pro', apiKey: 'k', pollIntervalMs: 5 })],
      request: { prompt: 'x' },
      attemptTimeoutMs: 20,
      maxRetriesPerModel: 1,
      backoffBaseMs: 0,
    })
    expect(result.attempts.map(r => [r.errorType, r.retryable])).toEqual([['timeout', true], ['timeout', true]])
  })

  it('sends the key to BFL sibling hosts only when the base URL is a BFL host', async () => {
    const fetchMock = stubFetch(submitted(), ready(), imageResponse())
    const proxied = new BlackForestLabsImageAdapter({
      model: 'flux-2-pro',
      apiKey: 'proxy-key',
      baseURL: 'https://bfl-proxy.example.com/v1',
      pollIntervalMs: 0,
    })
    await proxied.generate({ prompt: 'x' }, { signal })
    const [submitUrl, submitInit] = fetchMock.mock.calls[0]!
    expect(submitUrl).toBe('https://bfl-proxy.example.com/v1/flux-2-pro')
    expect(headersOf(submitInit)['x-key']).toBe('proxy-key')
    const [pollUrl, pollInit] = fetchMock.mock.calls[1]!
    expect(pollUrl).toBe(POLL)
    expect(headersOf(pollInit)['x-key']).toBeUndefined()
  })

  it('lets runImage move to the next model on a moderated task without retrying', async () => {
    stubFetch(
      submitted(),
      status('Request Moderated'),
      jsonResponse({ data: [{ b64_json: b64(jpegHeader(512, 512)) }] }),
    )
    const result = await runImage({
      chain: [
        new BlackForestLabsImageAdapter({ model: 'flux-2-pro', apiKey: 'k', pollIntervalMs: 0 }),
        new SeedreamImageAdapter({ model: 'doubao-seedream-4-0-250828', apiKey: 'k' }),
      ],
      request: { prompt: 'x' },
    })
    expect(result.status).toBe('succeeded')
    expect(result.attempts.map(r => [r.provider, r.status, r.errorType])).toEqual([
      ['black-forest-labs', 'failed', 'content_policy'],
      ['seedream', 'succeeded', undefined],
    ])
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
