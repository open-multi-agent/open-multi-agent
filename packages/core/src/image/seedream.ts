/**
 * @fileoverview Image adapter for Seedream on Volcengine Ark.
 *
 * One endpoint, `POST /images/generations` (JSON), serves both text-to-image
 * and edits: input images go in `image` as data URLs. Uses the same endpoint
 * and `ARK_API_KEY` as the Doubao text adapter. The adapter always asks for
 * `b64_json`, so it never downloads from a second origin.
 */

import { ImageModelError } from '../errors.js'
import type { EgressPolicy } from '../types.js'
import {
  assertNoReservedOptions,
  firstBase64Image,
  imageFetch,
  joinUrl,
  sendImageRequest,
  toDataUrl,
  type ProviderErrorBody,
} from './http.js'
import type {
  ImageCallOptions,
  ImageModelAdapter,
  ImageModelOutput,
  ImageRequest,
} from './types.js'

const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'
const RESERVED_OPTIONS = new Set(['model', 'prompt', 'image', 'response_format'])

/**
 * Ark reports safety rejections with codes such as
 * `InputTextSensitiveContentDetected` and `OutputImageSensitiveContentDetected`.
 */
export function isSeedreamContentPolicyError(body: ProviderErrorBody): boolean {
  return body.code !== undefined && body.code.endsWith('SensitiveContentDetected')
}

export interface SeedreamImageAdapterOptions {
  /** Model ID, for example `doubao-seedream-4-0-250828`. */
  readonly model: string
  /** Defaults to `ARK_API_KEY`. */
  readonly apiKey?: string
  /** Defaults to the Volcengine Ark endpoint used by the Doubao text adapter. */
  readonly baseURL?: string
  /**
   * Most input images to send. A request with more fails as `invalid_request`
   * before any network call. Unset means the endpoint enforces its own limit.
   */
  readonly maxInputImages?: number
  /** Ark adds a visible watermark unless this is false. Default false. */
  readonly watermark?: boolean
  /**
   * Extra body fields sent with every call, for example `seed`. Values are
   * sent as-is and override `watermark`; a `size` here is a default that
   * `request.size` overrides. Fields that carry the request itself or the
   * output format (`model`, `prompt`, `image`, `response_format`) are
   * rejected at construction.
   */
  readonly providerOptions?: Readonly<Record<string, unknown>>
  /** Restrict outbound requests; see the egress policy docs. */
  readonly egressPolicy?: EgressPolicy
}

export class SeedreamImageAdapter implements ImageModelAdapter {
  readonly provider = 'seedream'
  readonly model: string
  private readonly apiKey: string | undefined
  private readonly baseURL: string
  private readonly maxInputImages: number | undefined
  private readonly watermark: boolean
  private readonly providerOptions: Readonly<Record<string, unknown>>
  private readonly fetchImpl: typeof globalThis.fetch

  constructor(options: SeedreamImageAdapterOptions) {
    this.model = options.model
    this.apiKey = options.apiKey ?? process.env['ARK_API_KEY']
    this.baseURL = options.baseURL ?? DEFAULT_BASE_URL
    this.maxInputImages = options.maxInputImages
    this.watermark = options.watermark ?? false
    this.providerOptions = options.providerOptions ?? {}
    assertNoReservedOptions(this.provider, this.providerOptions, key => RESERVED_OPTIONS.has(key))
    this.fetchImpl = imageFetch(options.egressPolicy, this.provider)
  }

  async generate(request: ImageRequest, options: ImageCallOptions): Promise<ImageModelOutput> {
    const images = request.images ?? []
    if (request.mask !== undefined) {
      throw new ImageModelError(
        'invalid_request',
        'seedream does not accept a separate mask; describe the edit in the prompt instead',
        false,
        { provider: this.provider },
      )
    }
    if (this.maxInputImages !== undefined && images.length > this.maxInputImages) {
      throw new ImageModelError(
        'invalid_request',
        `seedream accepts at most ${this.maxInputImages} input images, got ${images.length}`,
        false,
        { provider: this.provider },
      )
    }
    if (this.apiKey === undefined || this.apiKey === '') {
      throw new ImageModelError('invalid_request', 'seedream API key is not set', false, { provider: this.provider })
    }

    const image = images.length === 0
      ? undefined
      : images.length === 1
        ? toDataUrl(images[0]!)
        : images.map(toDataUrl)
    const body = await sendImageRequest(
      this.fetchImpl,
      this.provider,
      joinUrl(this.baseURL, 'images/generations'),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          watermark: this.watermark,
          ...this.providerOptions,
          model: this.model,
          prompt: request.prompt,
          ...(image !== undefined ? { image } : {}),
          ...(request.size !== undefined ? { size: request.size } : {}),
          response_format: 'b64_json',
        }),
      },
      options.signal,
      isSeedreamContentPolicyError,
    )

    // Ark can answer 200 with a per-image error in data[0].
    const first = body !== null && typeof body === 'object'
      ? ((body as Record<string, unknown>)['data'] as unknown[] | undefined)?.[0]
      : undefined
    const itemError = first !== null && typeof first === 'object'
      ? (first as Record<string, unknown>)['error']
      : undefined
    if (itemError !== null && typeof itemError === 'object') {
      const code = (itemError as Record<string, unknown>)['code']
      const message = (itemError as Record<string, unknown>)['message']
      const parsed = { code: typeof code === 'string' ? code : undefined }
      const policy = isSeedreamContentPolicyError(parsed)
      throw new ImageModelError(
        policy ? 'content_policy' : 'invalid_output',
        `seedream image failed${typeof message === 'string' ? `: ${message}` : ''}`,
        !policy,
        { provider: this.provider, providerCode: parsed.code },
      )
    }

    const { data } = firstBase64Image(this.provider, body)
    const usage = body !== null && typeof body === 'object'
      ? (body as Record<string, unknown>)['usage']
      : undefined
    const params: Record<string, unknown> = {
      watermark: this.watermark,
      ...this.providerOptions,
      model: this.model,
      ...(request.size !== undefined ? { size: request.size } : {}),
      inputImages: images.length,
    }
    return {
      data,
      mediaType: 'image/jpeg',
      params: usage === undefined ? params : { ...params, usage },
    }
  }
}
