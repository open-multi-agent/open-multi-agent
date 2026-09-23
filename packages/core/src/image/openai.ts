/**
 * @fileoverview Image adapter for the OpenAI Images API.
 *
 * Text-to-image goes to `POST /images/generations` (JSON); a request with
 * images goes to `POST /images/edits` (multipart). Works with OpenAI and with
 * OpenAI-compatible endpoints through `baseURL`. The adapter reads
 * `data[0].b64_json` and never downloads a returned URL, so it targets models
 * that return base64 (the `gpt-image` family).
 */

import { ImageModelError } from '../errors.js'
import type { EgressPolicy } from '../types.js'
import {
  assertNoReservedOptions,
  detectedMediaType,
  extensionFor,
  firstBase64Image,
  imageFetch,
  joinUrl,
  sendImageRequest,
  type ProviderErrorBody,
} from './http.js'
import type {
  ImageCallOptions,
  ImageModelAdapter,
  ImageModelOutput,
  ImageRequest,
} from './types.js'

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const RESERVED_OPTIONS = new Set(['model', 'prompt', 'n', 'image', 'image[]', 'mask'])

/**
 * Error codes the Images API uses for a safety rejection:
 * `moderation_blocked` for the gpt-image family and `content_policy_violation`
 * for DALL-E.
 */
const CONTENT_POLICY_CODES = new Set(['moderation_blocked', 'content_policy_violation'])

export function isOpenAIContentPolicyError(body: ProviderErrorBody): boolean {
  return (body.code !== undefined && CONTENT_POLICY_CODES.has(body.code)) ||
    (body.type !== undefined && CONTENT_POLICY_CODES.has(body.type))
}

export interface OpenAIImageAdapterOptions {
  /** Model ID, for example `gpt-image-1`. */
  readonly model: string
  /** Defaults to `OPENAI_API_KEY`. */
  readonly apiKey?: string
  /** Defaults to `OPENAI_BASE_URL`, then the public OpenAI endpoint. */
  readonly baseURL?: string
  /**
   * Most input images to send. A request with more fails as `invalid_request`
   * before any network call. Unset means the endpoint enforces its own limit.
   */
  readonly maxInputImages?: number
  /**
   * Extra body fields sent with every call, for example `quality`,
   * `background`, or `moderation`. Values are sent as-is. A `size` here is a
   * default that `request.size` overrides. Fields that carry the request itself
   * (`model`, `prompt`, `n`, `image`, `image[]`, `mask`) are rejected at
   * construction.
   */
  readonly providerOptions?: Readonly<Record<string, string | number | boolean>>
  /** Restrict outbound requests; see the egress policy docs. */
  readonly egressPolicy?: EgressPolicy
}

export class OpenAIImageAdapter implements ImageModelAdapter {
  readonly provider = 'openai'
  readonly model: string
  private readonly apiKey: string | undefined
  private readonly baseURL: string
  private readonly maxInputImages: number | undefined
  private readonly providerOptions: Readonly<Record<string, string | number | boolean>>
  private readonly fetchImpl: typeof globalThis.fetch

  constructor(options: OpenAIImageAdapterOptions) {
    this.model = options.model
    this.apiKey = options.apiKey ?? process.env['OPENAI_API_KEY']
    this.baseURL = options.baseURL ?? process.env['OPENAI_BASE_URL'] ?? DEFAULT_BASE_URL
    this.maxInputImages = options.maxInputImages
    this.providerOptions = options.providerOptions ?? {}
    assertNoReservedOptions(this.provider, this.providerOptions, key => RESERVED_OPTIONS.has(key))
    this.fetchImpl = imageFetch(options.egressPolicy, this.provider)
  }

  async generate(request: ImageRequest, options: ImageCallOptions): Promise<ImageModelOutput> {
    const images = request.images ?? []
    if (this.maxInputImages !== undefined && images.length > this.maxInputImages) {
      throw new ImageModelError(
        'invalid_request',
        `openai accepts at most ${this.maxInputImages} input images, got ${images.length}`,
        false,
        { provider: this.provider },
      )
    }
    if (request.mask !== undefined && images.length === 0) {
      throw new ImageModelError(
        'invalid_request',
        'openai needs an input image when a mask is given',
        false,
        { provider: this.provider },
      )
    }
    if (this.apiKey === undefined || this.apiKey === '') {
      throw new ImageModelError('invalid_request', 'openai API key is not set', false, { provider: this.provider })
    }

    const headers = { Authorization: `Bearer ${this.apiKey}` }
    const params: Record<string, unknown> = {
      ...this.providerOptions,
      model: this.model,
      ...(request.size !== undefined ? { size: request.size } : {}),
      inputImages: images.length,
      mask: request.mask !== undefined,
    }

    let body: unknown
    if (images.length === 0) {
      body = await sendImageRequest(
        this.fetchImpl,
        this.provider,
        joinUrl(this.baseURL, 'images/generations'),
        {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...this.providerOptions,
            model: this.model,
            prompt: request.prompt,
            n: 1,
            ...(request.size !== undefined ? { size: request.size } : {}),
          }),
        },
        options.signal,
        isOpenAIContentPolicyError,
      )
    } else {
      const form = new FormData()
      form.append('model', this.model)
      form.append('prompt', request.prompt)
      form.append('n', '1')
      if (request.size !== undefined) form.append('size', request.size)
      for (const [key, value] of Object.entries(this.providerOptions)) {
        // request.size, appended above, takes precedence over a default size.
        if (key === 'size' && request.size !== undefined) continue
        form.append(key, String(value))
      }
      const field = images.length > 1 ? 'image[]' : 'image'
      images.forEach((image, index) => {
        form.append(
          field,
          new Blob([image.data], { type: image.mediaType }),
          `image-${index}.${extensionFor(image.mediaType)}`,
        )
      })
      if (request.mask !== undefined) {
        form.append(
          'mask',
          new Blob([request.mask.data], { type: request.mask.mediaType }),
          `mask.${extensionFor(request.mask.mediaType)}`,
        )
      }
      body = await sendImageRequest(
        this.fetchImpl,
        this.provider,
        joinUrl(this.baseURL, 'images/edits'),
        { method: 'POST', headers, body: form },
        options.signal,
        isOpenAIContentPolicyError,
      )
    }

    const { data } = firstBase64Image(this.provider, body)
    const usage = body !== null && typeof body === 'object'
      ? (body as Record<string, unknown>)['usage']
      : undefined
    return {
      data,
      mediaType: detectedMediaType(data, 'image/png'),
      params: usage === undefined ? params : { ...params, usage },
    }
  }
}
