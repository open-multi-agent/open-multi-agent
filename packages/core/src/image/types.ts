/**
 * @fileoverview Public types for image generation and editing.
 *
 * {@link ImageModelAdapter} is the only contract `runImage` depends on. The
 * built-in adapters implement it with plain `fetch`; applications can implement
 * it for any other provider.
 */

import type { ImageModelErrorType } from '../errors.js'

/** One image passed to a model, as raw bytes. */
export interface ImageInput {
  /** Raw image bytes. A Node `Buffer` is accepted. */
  readonly data: Uint8Array
  /** IANA media type, for example `image/png`. */
  readonly mediaType: string
}

/**
 * What to generate. With no `images` the call is text-to-image; with images it
 * is an edit, where `images[0]` is the image being edited and the rest are
 * references.
 */
export interface ImageRequest {
  readonly prompt: string
  readonly images?: readonly ImageInput[]
  /** Edit mask for providers that support one. Adapters that cannot use it fail the call. */
  readonly mask?: ImageInput
  /** Output size in the provider's own format, for example `1024x1024` or `2k`. */
  readonly size?: string
}

/** Per-call options `runImage` passes to an adapter. */
export interface ImageCallOptions {
  /** Aborts when the attempt times out or the caller cancels. Adapters must forward it to I/O. */
  readonly signal: AbortSignal
}

/** What an adapter returns for one successful call. */
export interface ImageModelOutput {
  readonly data: Uint8Array
  /** Media type the provider declared. `runImage` re-derives it from the bytes. */
  readonly mediaType: string
  /**
   * Loggable request parameters and provider usage for the attempt record.
   * Must not contain image bytes or credentials.
   */
  readonly params: Readonly<Record<string, unknown>>
}

/** A provider-neutral image model. */
export interface ImageModelAdapter {
  /** Provider name, for example `openai`. */
  readonly provider: string
  /** Provider model ID. */
  readonly model: string
  /**
   * Run one call. Failures should throw {@link ImageModelError}; anything else
   * is recorded as a non-retryable `api_error`. Must not retry internally, so
   * every provider call shows up as its own attempt.
   */
  generate(request: ImageRequest, options: ImageCallOptions): Promise<ImageModelOutput>
}

/** An output whose format and dimensions were read from the bytes. */
export interface ImageOutput {
  readonly data: Uint8Array
  /** Media type detected from the bytes, not the provider's declaration. */
  readonly mediaType: string
  readonly width: number
  readonly height: number
}

/** Verdict of {@link RunImageOptions.validate}. */
export type ImageValidationResult =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly reason: string
      /** Whether the same model may be tried again. Defaults to true. */
      readonly retryable?: boolean
    }

/** One provider call made by `runImage`, successful or not. */
export interface ImageAttemptRecord {
  /** 1-based position across the whole chain. */
  readonly attempt: number
  /** 1-based position within the current model. */
  readonly modelAttempt: number
  readonly provider: string
  readonly model: string
  /** Unix epoch ms when the call started. */
  readonly startMs: number
  readonly durationMs: number
  /**
   * `succeeded`: returned a usable image. `rejected`: returned an image that
   * `validate` refused. `failed`: no image.
   */
  readonly status: 'succeeded' | 'rejected' | 'failed'
  readonly errorType?: ImageModelErrorType
  readonly errorMessage?: string
  readonly retryable?: boolean
  /** Parameters and usage reported by the adapter. */
  readonly params?: Readonly<Record<string, unknown>>
  /** Format and size of the returned image, for succeeded and rejected attempts. */
  readonly output?: {
    readonly mediaType: string
    readonly width: number
    readonly height: number
    readonly byteLength: number
  }
  /** The image `validate` refused, kept so the caller can review it. */
  readonly rejectedOutput?: ImageOutput
}

export interface RunImageOptions {
  /** Models to try in order. Must not be empty. */
  readonly chain: readonly ImageModelAdapter[]
  readonly request: ImageRequest
  /** Retries per model after the first try. Default 2. */
  readonly maxRetriesPerModel?: number
  /** Base of the exponential backoff between retries, in ms. Default 2000. */
  readonly backoffBaseMs?: number
  /**
   * Longest Retry-After `runImage` will wait, in ms. A longer request moves on
   * to the next model instead of blocking. Default 60000.
   */
  readonly maxRetryAfterMs?: number
  /** Deadline for one provider call, in ms. Default 180000. */
  readonly attemptTimeoutMs?: number
  /**
   * Checks an image the provider returned. A refusal is recorded as a
   * `rejected` attempt with error type `invalid_output`.
   */
  readonly validate?: (
    output: ImageOutput,
    request: ImageRequest,
  ) => ImageValidationResult | Promise<ImageValidationResult>
  /**
   * Called after every attempt. It is not awaited, and a throw or rejection is
   * ignored, so a failing or stalled sink never changes or delays the call.
   */
  readonly onAttempt?: (record: ImageAttemptRecord) => void | Promise<void>
  /** Cancels the whole chain. `runImage` rejects with the signal's reason. */
  readonly signal?: AbortSignal
}

export type RunImageResult =
  | {
      readonly status: 'succeeded'
      readonly output: ImageOutput
      readonly provider: string
      readonly model: string
      readonly attempts: readonly ImageAttemptRecord[]
      readonly durationMs: number
    }
  | {
      readonly status: 'failed'
      /** The last failure in the chain. */
      readonly error: {
        readonly type: ImageModelErrorType
        readonly message: string
      }
      readonly attempts: readonly ImageAttemptRecord[]
      readonly durationMs: number
    }
