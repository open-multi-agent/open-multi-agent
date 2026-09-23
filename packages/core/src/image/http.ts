/**
 * @fileoverview HTTP plumbing shared by the built-in image adapters.
 */

import { EgressPolicyError, ImageModelError } from '../errors.js'
import { createEgressFetch } from '../llm/egress.js'
import type { EgressPolicy } from '../types.js'
import { sniffImage } from './sniff.js'
import type { ImageInput } from './types.js'

type FetchLike = typeof globalThis.fetch

/** Longest provider detail kept in an error message. */
const MAX_DETAIL_CHARS = 500

/** Resolve the fetch an adapter uses, wrapped by the egress policy when one is set. */
export function imageFetch(egressPolicy: EgressPolicy | undefined, provider: string): FetchLike {
  // Resolve globalThis.fetch per call so a fetch patched after construction is honored.
  const lateFetch: FetchLike = (input, init) => globalThis.fetch(input, init)
  return egressPolicy === undefined
    ? lateFetch
    : createEgressFetch(egressPolicy, provider, lateFetch)
}

/**
 * Reject `providerOptions` keys the adapter sets from the request or its own
 * options. Letting them through would let a stray option replace the prompt or
 * the input images without any error, so the conflict fails at construction.
 */
export function assertNoReservedOptions(
  provider: string,
  providerOptions: Readonly<Record<string, unknown>>,
  isReserved: (key: string) => boolean,
): void {
  const clashes = Object.keys(providerOptions).filter(isReserved)
  if (clashes.length > 0) {
    throw new TypeError(
      `${provider} providerOptions cannot set ${clashes.join(', ')}; the adapter sets ${clashes.length === 1 ? 'it' : 'them'} from the request or its own options`,
    )
  }
}

/**
 * The media type of returned image bytes, read from the bytes themselves.
 * Providers let callers pick the output format through `providerOptions`, so a
 * fixed declaration would be wrong for a direct adapter caller. `fallback` is
 * used only when the bytes are not a recognized image.
 */
export function detectedMediaType(bytes: Uint8Array, fallback: string): string {
  return sniffImage(bytes)?.mediaType ?? fallback
}

/** Join a base URL and a path without doubling or dropping the slash. */
export function joinUrl(baseURL: string, path: string): string {
  return `${baseURL.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

export function toDataUrl(image: ImageInput): string {
  return `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`
}

/** File extension for a multipart upload name. */
export function extensionFor(mediaType: string): string {
  if (mediaType === 'image/jpeg') return 'jpg'
  if (mediaType === 'image/webp') return 'webp'
  return 'png'
}

/** Parse Retry-After (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null || value.trim() === '') return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : undefined
  const date = Date.parse(value)
  if (Number.isNaN(date)) return undefined
  return Math.max(0, date - now)
}

function truncate(value: string): string {
  return value.length > MAX_DETAIL_CHARS ? `${value.slice(0, MAX_DETAIL_CHARS)}…` : value
}

/** Fields read from the `{ error: { code, type, message } }` shape the built-in providers use. */
export interface ProviderErrorBody {
  readonly code?: string
  readonly type?: string
  readonly message?: string
  /** The whole `error` object (or body), for provider rules that need more fields. */
  readonly error?: Readonly<Record<string, unknown>>
}

/** An adapter's own rule for recognizing a safety rejection. */
export type ContentPolicyRule = (body: ProviderErrorBody, status: number) => boolean

export function parseProviderErrorBody(text: string): ProviderErrorBody {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object') return {}
  const record = parsed as Record<string, unknown>
  const inner = record['error'] !== null && typeof record['error'] === 'object'
    ? record['error'] as Record<string, unknown>
    : record
  const pick = (key: string): string | undefined => {
    const value = inner[key]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined
  }
  return { code: pick('code'), type: pick('type'), message: pick('message'), error: inner }
}

/**
 * Map a non-2xx response to an {@link ImageModelError}. `isContentPolicy` is
 * the adapter's own rule; there is no cross-provider marker list, because
 * each provider signals a rejection differently.
 */
export function classifyHttpError(
  provider: string,
  status: number,
  bodyText: string,
  retryAfterHeader: string | null,
  isContentPolicy: ContentPolicyRule,
): ImageModelError {
  const body = parseProviderErrorBody(bodyText)
  const detail = truncate(body.message ?? bodyText)
  const message = `${provider} returned HTTP ${status}${detail ? `: ${detail}` : ''}`
  const options = { provider, status, providerCode: body.code }
  if (status === 429) {
    return new ImageModelError('rate_limit', message, true, {
      ...options,
      retryAfterMs: parseRetryAfter(retryAfterHeader),
    })
  }
  // Checked before the retryable branches: a gateway can forward an upstream
  // safety rejection with a 5xx status, and retrying it cannot succeed.
  if (isContentPolicy(body, status)) return new ImageModelError('content_policy', message, false, options)
  if (status === 408) return new ImageModelError('timeout', message, true, options)
  if (status >= 500) return new ImageModelError('api_error', message, true, options)
  return new ImageModelError('invalid_request', message, false, options)
}

/**
 * Send one request. Aborts propagate unchanged so `runImage` can tell a
 * timeout from a caller cancellation; other transport failures become
 * retryable `network` errors.
 */
export async function sendImageRequest(
  fetchImpl: FetchLike,
  provider: string,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  isContentPolicy: ContentPolicyRule,
): Promise<unknown> {
  let response: Response
  let text: string
  try {
    response = await fetchImpl(url, { ...init, signal })
    text = await response.text()
  } catch (error) {
    if (signal.aborted) throw error
    if (error instanceof EgressPolicyError) {
      throw new ImageModelError('invalid_request', error.message, false, { provider })
    }
    throw new ImageModelError(
      'network',
      `${provider} request failed: ${error instanceof Error ? error.message : String(error)}`,
      true,
      { provider },
    )
  }
  if (!response.ok) {
    throw classifyHttpError(provider, response.status, text, response.headers.get('retry-after'), isContentPolicy)
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new ImageModelError(
      'invalid_output',
      `${provider} returned a non-JSON body: ${truncate(text)}`,
      true,
      { provider, status: response.status },
    )
  }
}

/**
 * Download raw image bytes, for providers that deliver output by URL. Error
 * handling matches {@link sendImageRequest}; any non-2xx status is a retryable
 * failure, since a delivery link that fails is not a verdict on the request.
 * 429 and 408 are typed `rate_limit` and `timeout`, the rest `api_error`.
 */
export async function downloadImage(
  fetchImpl: FetchLike,
  provider: string,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Uint8Array> {
  let response: Response
  let bytes: ArrayBuffer
  try {
    response = await fetchImpl(url, { ...init, signal })
    bytes = await response.arrayBuffer()
  } catch (error) {
    if (signal.aborted) throw error
    if (error instanceof EgressPolicyError) {
      throw new ImageModelError('invalid_request', error.message, false, { provider })
    }
    throw new ImageModelError(
      'network',
      `${provider} image download failed: ${error instanceof Error ? error.message : String(error)}`,
      true,
      { provider },
    )
  }
  if (!response.ok) {
    const message = `${provider} image download returned HTTP ${response.status}`
    const options = { provider, status: response.status }
    // Rate limits and timeouts keep their own types so a caller can tell them
    // from a dead link and retry the download in place.
    if (response.status === 429) {
      throw new ImageModelError('rate_limit', message, true, {
        ...options,
        retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
      })
    }
    if (response.status === 408) throw new ImageModelError('timeout', message, true, options)
    throw new ImageModelError('api_error', message, true, options)
  }
  return new Uint8Array(bytes)
}

/** Decode the first `b64_json` entry of an OpenAI-shaped `data` array. */
export function firstBase64Image(provider: string, body: unknown): { data: Uint8Array; item: Record<string, unknown> } {
  const data = body !== null && typeof body === 'object'
    ? (body as Record<string, unknown>)['data']
    : undefined
  const item = Array.isArray(data) ? data[0] : undefined
  if (item === null || typeof item !== 'object') {
    throw new ImageModelError('invalid_output', `${provider} response has no data[0]`, true, { provider })
  }
  const b64 = (item as Record<string, unknown>)['b64_json']
  if (typeof b64 !== 'string' || b64 === '') {
    throw new ImageModelError(
      'invalid_output',
      `${provider} response has no data[0].b64_json`,
      false,
      { provider },
    )
  }
  return { data: new Uint8Array(Buffer.from(b64, 'base64')), item: item as Record<string, unknown> }
}
