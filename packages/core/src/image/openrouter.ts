/**
 * @fileoverview Image adapter for OpenRouter's image generation endpoint.
 *
 * `POST /images` (JSON) serves both text-to-image and edits: input images go
 * in `input_references` as data URLs. The response carries base64 images in
 * `data[].b64_json`, so the adapter never downloads from a second origin.
 * This is a different request shape from the OpenAI Images API, so it cannot
 * be reached with `OpenAIImageAdapter` and a changed `baseURL`.
 */

import { ImageModelError } from '../errors.js'
import type { EgressPolicy } from '../types.js'
import {
  assertNoReservedOptions,
  detectedMediaType,
  firstBase64Image,
  imageFetch,
  joinUrl,
  parseProviderErrorBody,
  sendImageRequest,
  toDataUrl,
  type ProviderErrorBody,
} from './http.js'
import { isOpenAIContentPolicyError } from './openai.js'
import { isSeedreamContentPolicyError } from './seedream.js'
import type {
  ImageCallOptions,
  ImageModelAdapter,
  ImageModelOutput,
  ImageRequest,
} from './types.js'

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'
const RESERVED_OPTIONS = new Set(['model', 'prompt', 'n', 'input_references'])

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * OpenRouter reports a safety rejection in two ways. Its own moderation
 * answers 403 with `error.metadata.reasons` or `flagged_input`. A rejection by
 * the upstream provider carries the provider's error code in
 * `error.metadata.provider_code` and its original body in
 * `error.metadata.raw`; both are checked against the upstream rules OMA
 * already knows.
 */
export function isOpenRouterContentPolicyError(body: ProviderErrorBody, status: number): boolean {
  const metadata = asRecord(body.error?.['metadata'])
  if (metadata === undefined) return false
  if (status === 403 && (metadata['reasons'] !== undefined || metadata['flagged_input'] !== undefined)) {
    return true
  }
  const providerCode = metadata['provider_code']
  if (typeof providerCode === 'string') {
    const upstreamCode = { code: providerCode }
    if (isOpenAIContentPolicyError(upstreamCode) || isSeedreamContentPolicyError(upstreamCode)) return true
  }
  const raw = metadata['raw']
  const upstream = typeof raw === 'string'
    ? parseProviderErrorBody(raw)
    : asRecord(raw) !== undefined
      ? parseProviderErrorBody(JSON.stringify(raw))
      : undefined
  if (upstream === undefined) return false
  return isOpenAIContentPolicyError(upstream) || isSeedreamContentPolicyError(upstream)
}

export interface OpenRouterImageAdapterOptions {
  /** OpenRouter model slug, for example `openai/gpt-image-1`. */
  readonly model: string
  /** Defaults to `OPENROUTER_API_KEY`. */
  readonly apiKey?: string
  /** Defaults to the public OpenRouter endpoint. */
  readonly baseURL?: string
  /**
   * Most input images to send. A request with more fails as `invalid_request`
   * before any network call. Unset means the endpoint enforces its own limit.
   */
  readonly maxInputImages?: number
  /**
   * Extra body fields sent with every call, for example `aspect_ratio`,
   * `seed`, or a `provider` routing object. Values are sent as-is. A `size`
   * here is a default that `request.size` overrides. Fields that carry the
   * request itself (`model`, `prompt`, `n`, `input_references`) are rejected
   * at construction.
   */
  readonly providerOptions?: Readonly<Record<string, unknown>>
  /** Restrict outbound requests; see the egress policy docs. */
  readonly egressPolicy?: EgressPolicy
}

export class OpenRouterImageAdapter implements ImageModelAdapter {
  readonly provider = 'openrouter'
  readonly model: string
  private readonly apiKey: string | undefined
  private readonly baseURL: string
  private readonly maxInputImages: number | undefined
  private readonly providerOptions: Readonly<Record<string, unknown>>
  private readonly fetchImpl: typeof globalThis.fetch

  constructor(options: OpenRouterImageAdapterOptions) {
    this.model = options.model
    this.apiKey = options.apiKey ?? process.env['OPENROUTER_API_KEY']
    this.baseURL = options.baseURL ?? DEFAULT_BASE_URL
    this.maxInputImages = options.maxInputImages
    this.providerOptions = options.providerOptions ?? {}
    assertNoReservedOptions(this.provider, this.providerOptions, key => RESERVED_OPTIONS.has(key))
    this.fetchImpl = imageFetch(options.egressPolicy, this.provider)
  }

  async generate(request: ImageRequest, options: ImageCallOptions): Promise<ImageModelOutput> {
    const images = request.images ?? []
    if (request.mask !== undefined) {
      throw new ImageModelError(
        'invalid_request',
        'openrouter does not accept a separate mask; describe the edit in the prompt instead',
        false,
        { provider: this.provider },
      )
    }
    if (this.maxInputImages !== undefined && images.length > this.maxInputImages) {
      throw new ImageModelError(
        'invalid_request',
        `openrouter accepts at most ${this.maxInputImages} input images, got ${images.length}`,
        false,
        { provider: this.provider },
      )
    }
    if (this.apiKey === undefined || this.apiKey === '') {
      throw new ImageModelError('invalid_request', 'openrouter API key is not set', false, { provider: this.provider })
    }

    const body = await sendImageRequest(
      this.fetchImpl,
      this.provider,
      joinUrl(this.baseURL, 'images'),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...this.providerOptions,
          model: this.model,
          prompt: request.prompt,
          n: 1,
          ...(request.size !== undefined ? { size: request.size } : {}),
          ...(images.length > 0
            ? {
                input_references: images.map(image => ({
                  type: 'image_url',
                  image_url: { url: toDataUrl(image) },
                })),
              }
            : {}),
        }),
      },
      options.signal,
      isOpenRouterContentPolicyError,
    )

    const { data } = firstBase64Image(this.provider, body)
    const usage = asRecord(body)?.['usage']
    const params: Record<string, unknown> = {
      ...this.providerOptions,
      model: this.model,
      ...(request.size !== undefined ? { size: request.size } : {}),
      inputImages: images.length,
    }
    return {
      data,
      mediaType: detectedMediaType(data, 'image/png'),
      params: usage === undefined ? params : { ...params, usage },
    }
  }
}
