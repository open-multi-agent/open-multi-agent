# Image generation and editing

`runImage()` makes one image generation or edit call across an ordered chain
of image models. It retries retryable failures on the same model, moves to the
next model on anything else, checks each returned image, and records every
provider call it made. Everything runs on OMA's own `ImageModelAdapter`
interface and plain `fetch`; no third-party SDK is involved.

```ts
import {
  OpenAIImageAdapter,
  SeedreamImageAdapter,
  runImage,
} from '@open-multi-agent/core'

const result = await runImage({
  chain: [
    new OpenAIImageAdapter({ model: 'gpt-image-1' }),
    new SeedreamImageAdapter({ model: 'doubao-seedream-4-0-250828' }),
  ],
  request: {
    prompt: 'Replace the chair with the one in the second image',
    images: [
      { data: roomPng, mediaType: 'image/png' },
      { data: chairJpeg, mediaType: 'image/jpeg' },
    ],
  },
  validate: output =>
    output.width >= 1024 ? { ok: true } : { ok: false, reason: 'too small' },
  onAttempt: record => attemptLog.push(record),
})

if (result.status === 'succeeded') {
  await storage.put(result.output.data, result.output.mediaType)
}
```

`runImage()` is a standalone function. It does not run inside an agent and does
not register a tool; call it from application code, from a custom tool, or from
a task's own code. Images do not flow between tasks as task output.

## Request

| Field | Meaning |
|---|---|
| `prompt` | The instruction. |
| `images` | Optional. Without images the call is text-to-image. With images it is an edit: `images[0]` is the image being edited and the rest are references. |
| `mask` | Optional edit mask. An adapter that cannot use a mask fails the call instead of ignoring it. |
| `size` | Optional output size in the provider's own format, for example `1024x1024` or `2k`. |

Adapters never drop input silently. A request with more images than an
adapter's `maxInputImages`, or a mask the provider does not accept, fails that
attempt as a non-retryable `invalid_request` and the chain moves on.

## Retry and fallback

For each model in `chain`, in order:

1. Call the adapter with a deadline of `attemptTimeoutMs` (default 180000).
2. On success, read the format and dimensions from the returned bytes, then
   run `validate` if one is set. Bytes that are not a PNG, JPEG, or WebP image
   count as a retryable `invalid_output` failure.
3. On a retryable failure, wait and try the same model again, up to
   `maxRetriesPerModel` retries (default 2). The wait is a jittered exponential
   backoff from `backoffBaseMs` (default 2000), and at least the provider's
   Retry-After.
4. On a non-retryable failure, a Retry-After longer than `maxRetryAfterMs`
   (default 60000), or exhausted retries, move to the next model.

When every model fails, `runImage()` resolves with `status: 'failed'` and the
last error; it does not throw. It rejects only for invalid options or when the
caller's `signal` aborts, in which case no further model is tried.

Adapters must not resubmit a generation internally. Every billable provider
call is one attempt, so the attempt records show the real number of calls and
their cost. An adapter for an asynchronous provider may retry a status poll or
the result download of a task it already submitted, since that costs nothing
and a resubmit would pay for a second task.

When the attempt deadline fires, `runImage()` aborts the adapter's signal with
a `DOMException` named `TimeoutError`, the same convention as
`AbortSignal.timeout()`; a caller cancellation carries the caller's own
reason. `runImage()` normally records a deadline as a retryable `timeout`. An
adapter can make it final by throwing a non-retryable `ImageModelError`, and
`runImage()` keeps that verdict and moves to the next model. The Black Forest
Labs adapter does this once its task is submitted, so an outage past the
deadline never pays for a second task.

## Error types

Adapters throw `ImageModelError` with a normalized `type` and a `retryable`
flag. The built-in adapters classify responses as follows:

| Type | Built-in adapters raise it for | Retryable |
|---|---|---|
| `rate_limit` | HTTP 429, with `retryAfterMs` from Retry-After | Yes |
| `timeout` | HTTP 408, or the attempt deadline firing | Yes, unless the adapter marks it final (see [Retry and fallback](#retry-and-fallback)) |
| `api_error` | HTTP 5xx; any non-`ImageModelError` thrown by an adapter | 5xx yes, other no |
| `network` | A transport failure before a response | Yes |
| `content_policy` | The provider's own safety rejection code (see below) | No |
| `invalid_request` | Other 4xx, a missing API key, an egress policy denial, or input the adapter cannot use | No |
| `invalid_output` | A response without an image, bytes that are not an image, or a `validate` refusal | Usually yes |

Content-policy detection is per provider, because providers signal it
differently. The OpenAI adapter matches the error codes `moderation_blocked`
and `content_policy_violation`. The Seedream adapter matches Ark error codes
ending in `SensitiveContentDetected`, both in an error response and in a
per-image error inside a 200 response. The OpenRouter adapter matches a 403
carrying OpenRouter's moderation metadata (`reasons` or `flagged_input`), and
an upstream error whose code, in `error.metadata.provider_code` or in the
original body in `error.metadata.raw`, one of the two rules above recognizes.
These rules run before the timeout and 5xx rules, so a rejection a gateway
forwards with a 5xx status is not retried. The Black Forest Labs adapter
reports a task whose poll status is `Request Moderated` or
`Content Moderated` as soon as it sees it, instead of polling on until the
attempt deadline. Anything else lands in
`invalid_request`, which is also non-retryable, so an unrecognized rejection
still moves to the next model rather than being retried.

## Validation

`validate(output, request)` sees the decoded format, width, height, and bytes.
Return `{ ok: true }` to accept, or `{ ok: false, reason }` to refuse. A refusal
is recorded as a `rejected` attempt with type `invalid_output`, and the refused
image is kept on the record as `rejectedOutput` so it can be reviewed. Set
`retryable: false` on the refusal to skip the remaining retries of that model.
An exception thrown by `validate` propagates out of `runImage()`.

## Attempt records

`result.attempts` lists every provider call in order, and `onAttempt` receives
each record as soon as the attempt ends. A record carries the provider, model,
start time, duration, status (`succeeded`, `rejected`, or `failed`), error type
and message, the adapter's reported parameters and usage, and the output format
and size. A failed attempt carries parameters only when the adapter attached
them to its `ImageModelError` as `params`, for example the task ID and cost of
work the provider already accepted. Records never contain credentials; only
`rejectedOutput` carries image bytes.

`onAttempt` is not awaited, and a throw or rejection from it is ignored: a
failing or stalled log sink neither changes nor delays the result. Write each
record to durable storage from the callback if you need it to survive a crash;
`result.attempts` holds the same records once `runImage()` settles.

## Built-in adapters

| Adapter | Endpoint | Credentials | Notes |
|---|---|---|---|
| `OpenAIImageAdapter` | `POST /images/generations` without images, `POST /images/edits` (multipart) with images | `apiKey` or `OPENAI_API_KEY`; `baseURL` or `OPENAI_BASE_URL` | Reads `data[0].b64_json` and never downloads a returned URL, so it targets models that return base64, such as the `gpt-image` family. Works with OpenAI-compatible endpoints through `baseURL`. |
| `BlackForestLabsImageAdapter` | `POST /{model}` on Black Forest Labs, then the returned `polling_url`, then the `result.sample` URL | `apiKey` or `BFL_API_KEY` | Asynchronous: polls every `pollIntervalMs` (default 500) until the task is ready, bounded by the `runImage()` attempt deadline. Transient failures while polling or downloading are retried inside the same attempt, up to the caller's `maxRetryAfterMs`. Every other failure after the submit, including a failed or lost task, an expired result link, and the deadline, ends this model's turn as non-retryable, so a submitted task is never paid for twice; the failed attempt record keeps the task ID and reported cost. A caller that cancels a direct `generate()` call gets its own abort reason back. Sends input images as `input_image`, `input_image_2`, and so on, and `size` as `width` and `height` (other formats are refused; use `providerOptions.aspect_ratio`). The key goes to the configured origin and, only when `baseURL` is itself a BFL host, to other HTTPS hosts under `bfl.ai`, so a proxy's key never follows a forwarded BFL URL. Keyed requests refuse redirects, and the pre-signed image download carries no key. Rejects a mask. Not checked against live responses. |
| `OpenRouterImageAdapter` | `POST /images` on OpenRouter | `apiKey` or `OPENROUTER_API_KEY` | Sends input images as `input_references` data URLs and reads `data[0].b64_json`. OpenRouter's request shape differs from the OpenAI Images API, so `OpenAIImageAdapter` with an OpenRouter `baseURL` does not work. Rejects a mask. Its classification follows OpenRouter's documented error format and has not been checked against live responses. |
| `SeedreamImageAdapter` | `POST /images/generations` on Volcengine Ark | `apiKey` or `ARK_API_KEY` | Same endpoint and key as the Doubao text adapter. Sends input images as data URLs, always requests `b64_json`, and sets `watermark: false` unless configured. Rejects a mask. |

All built-in adapters accept `providerOptions` for extra body fields, such as
`quality` or `moderation` for OpenAI, `aspect_ratio` or a `provider` routing
object for OpenRouter, `seed` for Seedream, and `output_format` or
`safety_tolerance` for Black Forest Labs, and `maxInputImages` to fail
over-long requests before any network call. A `size` in `providerOptions`
(`width` and `height` for Black Forest Labs) is a default that `request.size`
overrides. A key that carries the request itself, such as `model`, `prompt`,
or the field that holds input images, is rejected with a `TypeError` when the
adapter is constructed, so an option can never silently replace the prompt or
the images.

All built-in adapters honor `egressPolicy` the same way the text adapters do:
every request is checked against the policy and redirects are rejected. Black
Forest Labs polls and delivers from hosts other than its API origin, so an
allowlist for it must also include the polling and delivery origins its
responses name. See [LLM egress policy](egress-policy.md).

## Writing an adapter

Implement `ImageModelAdapter`:

```ts
import { ImageModelError, type ImageModelAdapter } from '@open-multi-agent/core'

const myAdapter: ImageModelAdapter = {
  provider: 'my-provider',
  model: 'my-model',
  async generate(request, { signal }) {
    const response = await fetch(url, { method: 'POST', body, signal })
    if (response.status === 429) {
      throw new ImageModelError('rate_limit', 'slow down', true, {
        provider: 'my-provider',
        retryAfterMs: 5_000,
      })
    }
    return { data: bytes, mediaType: 'image/png', params: { model: 'my-model' } }
  },
}
```

Forward `signal` to every request so deadlines and cancellation stop the call.
Throw `ImageModelError` for every failure you can classify; anything else is
recorded as a non-retryable `api_error`. Fail rather than truncate when the
provider cannot use every input image, and do not resubmit a generation inside
the adapter. An adapter that waits internally should not wait longer than
`options.maxRetryAfterMs`, which `runImage()` sets to its own cap. Attach
`params` to an `ImageModelError` when the provider already accepted billable
work, so the failed attempt still shows it.

## What is not covered

- Cost: attempt records carry whatever usage the provider reports, but
  `runImage()` does not price images and they do not count against a run's
  token or cost budget.
- Trace spans: attempts are reported through `onAttempt` and
  `result.attempts`, not as `onTrace` spans.
- Storage: `runImage()` returns bytes. Where they go is up to the application.
