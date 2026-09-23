/**
 * @fileoverview Image adapter for Black Forest Labs (FLUX).
 *
 * BFL is asynchronous: `POST /{model}` returns a task ID and a `polling_url`,
 * the adapter polls until the task leaves `Pending`, then downloads the image
 * from the pre-signed `result.sample` URL without credentials. Input images
 * go in `input_image`, `input_image_2`, and so on, as raw base64.
 *
 * A moderated task is reported through the poll status (`Request Moderated`
 * or `Content Moderated`), not an HTTP error. The adapter treats both as a
 * non-retryable `content_policy` failure at once, rather than polling on
 * until the attempt deadline.
 *
 * Once a task is submitted, transient failures while polling or downloading
 * are retried inside the same attempt, so a retry never pays for a second
 * task. Only the submit counts as the provider call runImage retries.
 */

import { ImageModelError } from '../errors.js'
import type { EgressPolicy } from '../types.js'
import { abortableDelay } from '../utils/abort.js'
import {
  assertNoReservedOptions,
  detectedMediaType,
  downloadImage,
  imageFetch,
  joinUrl,
  sendImageRequest,
} from './http.js'
import { sniffImage } from './sniff.js'
import type {
  ImageCallOptions,
  ImageModelAdapter,
  ImageModelOutput,
  ImageRequest,
} from './types.js'

const DEFAULT_BASE_URL = 'https://api.bfl.ai/v1'
const DEFAULT_POLL_INTERVAL_MS = 500
/** Matches the runImage default, for a direct call that sets no cap. */
const DEFAULT_MAX_RETRY_AFTER_MS = 60_000
const MODERATED_STATUSES = new Set(['Request Moderated', 'Content Moderated'])
const FAILED_STATUSES = new Set(['Error', 'Failed'])

/** A failure that says nothing about the task and is worth repeating in place. */
function isTransient(error: unknown): error is ImageModelError {
  if (!(error instanceof ImageModelError) || !error.retryable) return false
  if (error.type === 'rate_limit' || error.type === 'network' || error.type === 'timeout') return true
  return error.type === 'api_error' && (error.status ?? 0) >= 500
}

/** Whether an abort reason is a deadline (runImage and AbortSignal.timeout both use TimeoutError). */
function isDeadlineReason(reason: unknown): boolean {
  return reason instanceof Error && reason.name === 'TimeoutError'
}

/** Keys that carry the request itself: the prompt and every input image field. */
function isReservedOption(key: string): boolean {
  return key === 'prompt' || key === 'image' || key === 'mask' || /^input_image(_\d+)?$/.test(key)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function isBflHttpsHost(url: URL): boolean {
  return url.protocol === 'https:' && (url.hostname === 'bfl.ai' || url.hostname.endsWith('.bfl.ai'))
}

/**
 * Whether the API key may be sent to a URL the API returned. The configured
 * origin always qualifies. BFL hands out polling URLs on sibling hosts (for
 * example `api.us1.bfl.ai`), so those qualify too, but only when the
 * configured base URL is itself a BFL host: behind a proxy the key belongs to
 * the proxy and must not follow a forwarded BFL URL.
 */
function mayCarryKey(url: string, baseURL: string): boolean {
  try {
    const target = new URL(url)
    const base = new URL(baseURL)
    if (target.origin === base.origin) return true
    return isBflHttpsHost(base) && isBflHttpsHost(target)
  } catch {
    return false
  }
}

function sizeFields(size: string | undefined): Record<string, number> {
  if (size === undefined) return {}
  const match = /^(\d+)x(\d+)$/.exec(size)
  if (match === null) {
    throw new ImageModelError(
      'invalid_request',
      `black-forest-labs size must be WIDTHxHEIGHT, got "${size}"; use providerOptions for aspect_ratio`,
      false,
      { provider: 'black-forest-labs' },
    )
  }
  return { width: Number(match[1]), height: Number(match[2]) }
}

export interface BlackForestLabsImageAdapterOptions {
  /** Model endpoint, for example `flux-2-pro` or `flux-kontext-pro`. */
  readonly model: string
  /** Defaults to `BFL_API_KEY`. */
  readonly apiKey?: string
  /** Defaults to the global BFL endpoint. */
  readonly baseURL?: string
  /**
   * Most input images to send. A request with more fails as `invalid_request`
   * before any network call. Unset means the endpoint enforces its own limit.
   */
  readonly maxInputImages?: number
  /** Delay between status polls, in ms. Default 500. */
  readonly pollIntervalMs?: number
  /**
   * Extra body fields sent with every call, for example `aspect_ratio`,
   * `output_format`, `safety_tolerance`, or `seed`. Values are sent as-is.
   * `width` and `height` here are defaults that `request.size` overrides.
   * Fields that carry the request itself (`prompt`, `image`, `mask`,
   * `input_image`, `input_image_2`, and so on) are rejected at construction.
   */
  readonly providerOptions?: Readonly<Record<string, unknown>>
  /**
   * Restrict outbound requests; see the egress policy docs. BFL polls and
   * delivers from hosts other than the API origin, so an allowlist has to
   * include those origins too.
   */
  readonly egressPolicy?: EgressPolicy
}

export class BlackForestLabsImageAdapter implements ImageModelAdapter {
  readonly provider = 'black-forest-labs'
  readonly model: string
  private readonly apiKey: string | undefined
  private readonly baseURL: string
  private readonly maxInputImages: number | undefined
  private readonly pollIntervalMs: number
  private readonly providerOptions: Readonly<Record<string, unknown>>
  private readonly fetchImpl: typeof globalThis.fetch

  constructor(options: BlackForestLabsImageAdapterOptions) {
    this.model = options.model
    this.apiKey = options.apiKey ?? process.env['BFL_API_KEY']
    this.baseURL = options.baseURL ?? DEFAULT_BASE_URL
    this.maxInputImages = options.maxInputImages
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.providerOptions = options.providerOptions ?? {}
    assertNoReservedOptions(this.provider, this.providerOptions, isReservedOption)
    this.fetchImpl = imageFetch(options.egressPolicy, this.provider)
  }

  private fail(type: 'invalid_request' | 'invalid_output' | 'api_error' | 'content_policy', message: string, retryable: boolean): ImageModelError {
    return new ImageModelError(type, `${this.provider} ${message}`, retryable, { provider: this.provider })
  }

  /**
   * A GET to a URL the API returned. The key goes only to BFL hosts, and a
   * keyed request refuses redirects so the key cannot follow one elsewhere.
   */
  private keyedGet(url: string, key: Record<string, string>): RequestInit {
    return mayCarryKey(url, this.baseURL)
      ? { method: 'GET', headers: key, redirect: 'error' }
      : { method: 'GET' }
  }

  /**
   * Run a status poll or the image download for a task that already exists.
   * A transient failure (rate limit, timeout, network, 5xx) is retried here
   * until the attempt deadline, waiting at least as long as a Retry-After,
   * because letting it reach runImage would resubmit and pay for a second
   * task. Anything else throws at once, including a 4xx on the download: an
   * expired delivery link cannot recover in place, so runImage decides.
   */
  private async untilSettled<T>(call: () => Promise<T>, signal: AbortSignal, maxRetryAfterMs: number): Promise<T> {
    for (;;) {
      try {
        return await call()
      } catch (error) {
        if (signal.aborted || !isTransient(error)) throw error
        // A wait longer than the caller allows ends the turn instead of
        // stalling it until the deadline.
        if ((error.retryAfterMs ?? 0) > maxRetryAfterMs) throw error
        await abortableDelay(Math.max(this.pollIntervalMs, error.retryAfterMs ?? 0), signal)
        if (signal.aborted) throw signal.reason
      }
    }
  }

  /** Poll a submitted task until it is ready, then download its image. */
  private async awaitResult(
    pollingUrl: string,
    key: Record<string, string>,
    signal: AbortSignal,
    maxRetryAfterMs: number,
  ): Promise<Uint8Array> {
    const noContentPolicyCode = () => false
    let sampleUrl: string | undefined
    while (sampleUrl === undefined) {
      const poll = asRecord(await this.untilSettled(() => sendImageRequest(
        this.fetchImpl,
        this.provider,
        pollingUrl,
        this.keyedGet(pollingUrl, key),
        signal,
        noContentPolicyCode,
      ), signal, maxRetryAfterMs))
      const rawStatus = poll?.['status'] ?? poll?.['state']
      const status = typeof rawStatus === 'string' ? rawStatus : undefined
      if (status === 'Ready') {
        const sample = asRecord(poll?.['result'])?.['sample']
        if (typeof sample !== 'string') throw this.fail('invalid_output', 'task is Ready but has no result.sample', true)
        sampleUrl = sample
      } else if (status !== undefined && MODERATED_STATUSES.has(status)) {
        throw this.fail('content_policy', `task ${status}`, false)
      } else if (status !== undefined && FAILED_STATUSES.has(status)) {
        throw this.fail('api_error', `task ${status}`, true)
      } else if (status === 'Task not found') {
        throw this.fail('invalid_output', 'task not found while polling', true)
      } else {
        // Pending, or a status this adapter does not know: keep waiting. The
        // attempt deadline in runImage bounds the loop through the signal.
        await abortableDelay(this.pollIntervalMs, signal)
        if (signal.aborted) throw signal.reason
      }
    }

    const finalSampleUrl = sampleUrl
    return this.untilSettled(() => downloadImage(
      this.fetchImpl,
      this.provider,
      finalSampleUrl,
      // Delivery URLs are pre-signed, so the download never carries the key.
      { method: 'GET' },
      signal,
    ), signal, maxRetryAfterMs)
  }

  async generate(request: ImageRequest, options: ImageCallOptions): Promise<ImageModelOutput> {
    const images = request.images ?? []
    if (request.mask !== undefined) {
      throw this.fail('invalid_request', 'adapter does not send a separate mask; describe the edit in the prompt instead', false)
    }
    if (this.maxInputImages !== undefined && images.length > this.maxInputImages) {
      throw this.fail('invalid_request', `accepts at most ${this.maxInputImages} input images, got ${images.length}`, false)
    }
    if (this.apiKey === undefined || this.apiKey === '') {
      throw this.fail('invalid_request', 'API key is not set', false)
    }
    const key = { 'x-key': this.apiKey }
    const noContentPolicyCode = () => false

    const dimensions = sizeFields(request.size)
    const inputFields: Record<string, string> = {}
    images.forEach((image, index) => {
      inputFields[index === 0 ? 'input_image' : `input_image_${index + 1}`] =
        Buffer.from(image.data).toString('base64')
    })
    const submitted = asRecord(await sendImageRequest(
      this.fetchImpl,
      this.provider,
      joinUrl(this.baseURL, this.model),
      {
        method: 'POST',
        headers: { ...key, 'Content-Type': 'application/json' },
        redirect: 'error',
        body: JSON.stringify({
          ...this.providerOptions,
          prompt: request.prompt,
          ...dimensions,
          ...inputFields,
        }),
      },
      options.signal,
      noContentPolicyCode,
    ))
    const taskId = typeof submitted?.['id'] === 'string' ? submitted['id'] : undefined
    const pollingUrl = typeof submitted?.['polling_url'] === 'string' ? submitted['polling_url'] : undefined

    // Built before polling so a failure after the submit still reports the
    // task and its cost, and with the same dimensions the request body sent.
    const params: Record<string, unknown> = {
      ...this.providerOptions,
      model: this.model,
      ...dimensions,
      inputImages: images.length,
      taskId,
    }
    for (const field of ['cost', 'input_mp', 'output_mp']) {
      if (typeof submitted?.[field] === 'number') params[field] = submitted[field]
    }

    // A 2xx submit may already have created and billed a task, so a submit
    // response the adapter cannot follow ends the turn like any later failure.
    if (pollingUrl === undefined) {
      throw new ImageModelError(
        'invalid_output',
        `${this.provider} submit response has no polling_url; not resubmitting the task`,
        false,
        { provider: this.provider, params },
      )
    }

    let data: Uint8Array
    try {
      data = await this.awaitResult(pollingUrl, key, options.signal, options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS)
    } catch (error) {
      if (options.signal.aborted) {
        // Only a deadline is final. A caller that cancelled gets its own
        // reason back, as with any other aborted call.
        if (!isDeadlineReason(options.signal.reason)) throw options.signal.reason
        throw new ImageModelError(
          'timeout',
          `${this.provider} task ${taskId ?? '(unknown)'} did not finish before the attempt deadline; not resubmitting it`,
          false,
          { provider: this.provider, params },
        )
      }
      // The task exists and may have been billed. Nothing after the submit may
      // make runImage retry this adapter, since a retry submits and pays for a
      // second task, so every failure from here ends this model's turn.
      if (error instanceof ImageModelError) {
        throw new ImageModelError(
          error.type,
          error.retryable ? `${error.message}; not resubmitting the task` : error.message,
          false,
          {
            provider: this.provider,
            status: error.status,
            retryAfterMs: error.retryAfterMs,
            providerCode: error.providerCode,
            params,
          },
        )
      }
      throw error
    }
    // A delivery URL can answer 200 with an error page. Checked here rather
    // than left to runImage, whose retry of an invalid output would resubmit.
    if (sniffImage(data) === undefined) {
      throw new ImageModelError(
        'invalid_output',
        `${this.provider} result download is not a PNG, JPEG, or WebP image; not resubmitting the task`,
        false,
        { provider: this.provider, params },
      )
    }
    return {
      data,
      mediaType: detectedMediaType(data, 'image/jpeg'),
      params,
    }
  }
}
