import { describe, expect, it, vi } from 'vitest'
import { ImageModelError, isRetryableError } from '../src/errors.js'
import { runImage } from '../src/image/run-image.js'
import { sniffImage } from '../src/image/sniff.js'
import type {
  ImageAttemptRecord,
  ImageCallOptions,
  ImageModelAdapter,
  ImageModelOutput,
  ImageRequest,
} from '../src/image/types.js'
import {
  jpegHeader,
  pngHeader,
  webpVp8Header,
  webpVp8lHeader,
  webpVp8xHeader,
} from './helpers/image-bytes.js'

type Step = ImageModelOutput | Error | ((options: ImageCallOptions) => Promise<ImageModelOutput>)

/** An adapter that plays back one scripted step per call. */
function scripted(model: string, steps: Step[]) {
  const calls: ImageRequest[] = []
  const adapter: ImageModelAdapter = {
    provider: 'fake',
    model,
    async generate(request, options) {
      calls.push(request)
      const step = steps.shift()
      if (step === undefined) throw new Error(`${model}: no scripted step left`)
      if (typeof step === 'function') return step(options)
      if (step instanceof Error) throw step
      return step
    },
  }
  return { adapter, calls }
}

const png = (width = 64, height = 32): ImageModelOutput => ({
  data: pngHeader(width, height),
  mediaType: 'image/png',
  params: { seed: 1 },
})

const retryable = (type: 'rate_limit' | 'api_error' | 'network' = 'api_error', retryAfterMs?: number) =>
  new ImageModelError(type, `${type} failure`, true, { retryAfterMs })

const fatal = () => new ImageModelError('content_policy', 'blocked', false)

const request: ImageRequest = { prompt: 'a desk' }

describe('sniffImage', () => {
  it('reads format and size from PNG, JPEG, and all three WebP variants', () => {
    expect(sniffImage(pngHeader(1024, 768))).toEqual({ mediaType: 'image/png', width: 1024, height: 768 })
    expect(sniffImage(jpegHeader(1920, 1080))).toEqual({ mediaType: 'image/jpeg', width: 1920, height: 1080 })
    expect(sniffImage(webpVp8xHeader(3000, 2000))).toEqual({ mediaType: 'image/webp', width: 3000, height: 2000 })
    expect(sniffImage(webpVp8Header(800, 600))).toEqual({ mediaType: 'image/webp', width: 800, height: 600 })
    expect(sniffImage(webpVp8lHeader(513, 257))).toEqual({ mediaType: 'image/webp', width: 513, height: 257 })
  })

  it('rejects non-images, truncated headers, and zero sizes', () => {
    expect(sniffImage(new TextEncoder().encode('{"error":"nope"}'))).toBeUndefined()
    expect(sniffImage(pngHeader(10, 10).subarray(0, 20))).toBeUndefined()
    expect(sniffImage(pngHeader(0, 10))).toBeUndefined()
    expect(sniffImage(new Uint8Array())).toBeUndefined()
  })
})

describe('runImage', () => {
  it('returns the first usable image with dimensions read from the bytes', async () => {
    const { adapter } = scripted('a', [{ ...png(640, 480), mediaType: 'image/jpeg' }])
    const result = await runImage({ chain: [adapter], request })

    expect(result.status).toBe('succeeded')
    if (result.status !== 'succeeded') return
    expect(result.output).toMatchObject({ mediaType: 'image/png', width: 640, height: 480 })
    expect(result.model).toBe('a')
    expect(result.attempts).toHaveLength(1)
    expect(result.attempts[0]).toMatchObject({
      attempt: 1,
      modelAttempt: 1,
      status: 'succeeded',
      params: { seed: 1 },
      output: { mediaType: 'image/png', width: 640, height: 480, byteLength: 33 },
    })
  })

  it('retries a retryable failure on the same model, then falls back to the next', async () => {
    const a = scripted('a', [retryable(), retryable(), retryable()])
    const b = scripted('b', [png()])
    const result = await runImage({ chain: [a.adapter, b.adapter], request, backoffBaseMs: 0 })

    expect(result.status).toBe('succeeded')
    expect(a.calls).toHaveLength(3)
    expect(result.attempts.map(r => [r.model, r.modelAttempt, r.status])).toEqual([
      ['a', 1, 'failed'],
      ['a', 2, 'failed'],
      ['a', 3, 'failed'],
      ['b', 1, 'succeeded'],
    ])
    expect(result.attempts.map(r => r.attempt)).toEqual([1, 2, 3, 4])
  })

  it('moves to the next model at once on a non-retryable failure', async () => {
    const a = scripted('a', [fatal()])
    const b = scripted('b', [png()])
    const result = await runImage({ chain: [a.adapter, b.adapter], request, backoffBaseMs: 0 })

    expect(a.calls).toHaveLength(1)
    expect(result.attempts[0]).toMatchObject({ status: 'failed', errorType: 'content_policy', retryable: false })
    expect(result.status).toBe('succeeded')
  })

  it('records a validator refusal as rejected, keeps the refused image, and retries', async () => {
    const refused = png(10, 10)
    const a = scripted('a', [refused, png(20, 20)])
    const validate = vi.fn((output: { width: number }) =>
      output.width >= 20 ? { ok: true as const } : { ok: false as const, reason: 'too small' },
    )
    const result = await runImage({ chain: [a.adapter], request, validate, backoffBaseMs: 0 })

    expect(result.status).toBe('succeeded')
    expect(validate).toHaveBeenCalledTimes(2)
    const rejected = result.attempts[0]!
    expect(rejected).toMatchObject({
      status: 'rejected',
      errorType: 'invalid_output',
      errorMessage: 'Output rejected by validate: too small',
      retryable: true,
      output: { width: 10, height: 10 },
    })
    expect(rejected.rejectedOutput?.data).toBe(refused.data)
  })

  it('skips to the next model when the validator marks a refusal non-retryable', async () => {
    const a = scripted('a', [png(), png()])
    const b = scripted('b', [png()])
    const result = await runImage({
      chain: [a.adapter, b.adapter],
      request,
      validate: (_output, _request) => ({ ok: false, reason: 'wrong room', retryable: false }),
      backoffBaseMs: 0,
    })

    expect(a.calls).toHaveLength(1)
    expect(b.calls).toHaveLength(1)
    expect(result.status).toBe('failed')
  })

  it('treats bytes that are not an image as a retryable invalid_output', async () => {
    const a = scripted('a', [
      { data: new TextEncoder().encode('<html>'), mediaType: 'image/png', params: {} },
      png(),
    ])
    const result = await runImage({ chain: [a.adapter], request, backoffBaseMs: 0 })

    expect(result.attempts[0]).toMatchObject({ status: 'failed', errorType: 'invalid_output', retryable: true })
    expect(result.status).toBe('succeeded')
  })

  it('records a plain adapter exception as a non-retryable api_error', async () => {
    const a = scripted('a', [new Error('boom')])
    const b = scripted('b', [png()])
    const result = await runImage({ chain: [a.adapter, b.adapter], request })

    expect(result.attempts[0]).toMatchObject({ errorType: 'api_error', retryable: false })
    expect(result.attempts[0]!.errorMessage).toContain('boom')
    expect(a.calls).toHaveLength(1)
  })

  it('waits at least as long as Retry-After before retrying', async () => {
    const a = scripted('a', [retryable('rate_limit', 60), png()])
    const started = Date.now()
    const result = await runImage({ chain: [a.adapter], request, backoffBaseMs: 0 })

    expect(result.status).toBe('succeeded')
    expect(Date.now() - started).toBeGreaterThanOrEqual(55)
  })

  it('moves on instead of waiting when Retry-After exceeds maxRetryAfterMs', async () => {
    const a = scripted('a', [retryable('rate_limit', 10_000)])
    const b = scripted('b', [png()])
    const started = Date.now()
    const result = await runImage({
      chain: [a.adapter, b.adapter],
      request,
      maxRetryAfterMs: 1_000,
      backoffBaseMs: 0,
    })

    expect(a.calls).toHaveLength(1)
    expect(result.status).toBe('succeeded')
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('turns an attempt past its deadline into a retryable timeout', async () => {
    const hang = (options: ImageCallOptions) =>
      new Promise<ImageModelOutput>((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
      })
    const a = scripted('a', [hang, png()])
    const result = await runImage({ chain: [a.adapter], request, attemptTimeoutMs: 20, backoffBaseMs: 0 })

    expect(result.attempts[0]).toMatchObject({ status: 'failed', errorType: 'timeout', retryable: true })
    expect(result.status).toBe('succeeded')
  })

  it('rejects with the caller reason and stops the chain when the caller aborts', async () => {
    const controller = new AbortController()
    const reason = new Error('user cancelled')
    const hang = (options: ImageCallOptions) =>
      new Promise<ImageModelOutput>((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        setTimeout(() => controller.abort(reason), 5)
      })
    const a = scripted('a', [hang])
    const b = scripted('b', [png()])

    await expect(runImage({ chain: [a.adapter, b.adapter], request, signal: controller.signal })).rejects.toBe(reason)
    expect(b.calls).toHaveLength(0)
  })

  it('reports every attempt to onAttempt and ignores a sink that throws', async () => {
    const seen: ImageAttemptRecord[] = []
    const a = scripted('a', [retryable(), png()])
    const result = await runImage({
      chain: [a.adapter],
      request,
      backoffBaseMs: 0,
      onAttempt: record => {
        seen.push(record)
        throw new Error('sink down')
      },
    })

    expect(result.status).toBe('succeeded')
    expect(seen.map(r => r.status)).toEqual(['failed', 'succeeded'])
  })

  it('does not wait on an attempt sink that never settles or rejects', async () => {
    const a = scripted('a', [retryable(), png()])
    const b = scripted('b', [png()])
    const stalled = await runImage({
      chain: [a.adapter],
      request,
      backoffBaseMs: 0,
      onAttempt: () => new Promise<void>(() => {}),
    })
    const rejecting = await runImage({
      chain: [b.adapter],
      request,
      onAttempt: () => Promise.reject(new Error('exporter down')),
    })

    expect(stalled.status).toBe('succeeded')
    expect(stalled.attempts).toHaveLength(2)
    expect(rejecting.status).toBe('succeeded')
  })

  it('rejects with the caller reason when the caller aborts while validate is pending', async () => {
    const controller = new AbortController()
    const reason = new Error('user cancelled')
    const a = scripted('a', [png()])
    const validate = async () => {
      controller.abort(reason)
      return { ok: true as const }
    }

    await expect(runImage({ chain: [a.adapter], request, validate, signal: controller.signal })).rejects.toBe(reason)
  })

  it('removes its listener from a reused caller signal after each attempt', async () => {
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const a = scripted('a', [retryable(), png(), png(), png()])

    for (let i = 0; i < 3; i++) {
      await runImage({ chain: [a.adapter], request, backoffBaseMs: 0, signal: controller.signal })
    }

    const added = add.mock.calls.filter(([type]) => type === 'abort').map(([, listener]) => listener)
    const removed = remove.mock.calls.filter(([type]) => type === 'abort').map(([, listener]) => listener)
    expect(added.length).toBeGreaterThanOrEqual(4)
    expect(removed).toEqual(expect.arrayContaining(added))
  })

  it('returns the last failure when every model fails', async () => {
    const a = scripted('a', [retryable('network')])
    const b = scripted('b', [fatal()])
    const result = await runImage({ chain: [a.adapter, b.adapter], request, maxRetriesPerModel: 0 })

    expect(result).toMatchObject({
      status: 'failed',
      error: { type: 'content_policy', message: 'blocked' },
    })
    expect(result.attempts).toHaveLength(2)
  })

  it('rejects invalid options before calling any model', async () => {
    const a = scripted('a', [png()])
    await expect(runImage({ chain: [], request })).rejects.toThrow('chain must not be empty')
    await expect(runImage({ chain: [a.adapter], request, maxRetriesPerModel: 1.5 })).rejects.toThrow('maxRetriesPerModel')
    await expect(runImage({ chain: [a.adapter], request, attemptTimeoutMs: 0 })).rejects.toThrow('attemptTimeoutMs')
    expect(a.calls).toHaveLength(0)
  })

  it('exposes the adapter retry decision through isRetryableError', () => {
    expect(isRetryableError(retryable())).toBe(true)
    expect(isRetryableError(fatal())).toBe(false)
  })
})
