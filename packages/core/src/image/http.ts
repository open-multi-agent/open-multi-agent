/**
 * @fileoverview HTTP plumbing shared by the built-in image adapters.
 */

import { EgressPolicyError, ImageModelError } from '../errors.js'
import { createEgressFetch } from '../llm/egress.js'
import type { EgressPolicy } from '../types.js'
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

/** The `{ error: { code, message } }` shape both built-in providers use. */
export interface ProviderErrorBody {
  readonly code?: string
  readonly type?: string
  readonly message?: string
}

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
  return { code: pick('code'), type: pick('type'), message: pick('message') }
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
  isContentPolicy: (body: ProviderErrorBody) => boolean,
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
  if (status === 408) return new ImageModelError('timeout', message, true, options)
  if (status >= 500) return new ImageModelError('api_error', message, true, options)
  if (isContentPolicy(body)) return new ImageModelError('content_policy', message, false, options)
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
  isContentPolicy: (body: ProviderErrorBody) => boolean,
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
