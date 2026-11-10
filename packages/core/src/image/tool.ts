/**
 * @fileoverview `createImageTool`: wraps {@link runImage} in a tool definition
 * so the model, rather than application code, decides when to generate or
 * edit an image.
 *
 * The model sends a prompt, an optional size, and, when the application allows
 * edits, short string references to input images. Raw bytes never pass
 * through tool input. The generated image goes back to the model as a rich
 * tool result, and the full-size bytes go to the application through
 * `onImage`, never through `ToolResult.data`.
 */

import { z } from 'zod'
import { defineTool } from '../tool/framework.js'
import type { ToolDefinition, ToolResultContentPart, ToolUseContext, ZodSchema } from '../types.js'
import { runImage } from './run-image.js'
import type {
  ImageAttemptRecord,
  ImageInput,
  ImageModelAdapter,
  ImageOutput,
  ImageRequest,
  RunImageOptions,
} from './types.js'

const DEFAULT_NAME = 'generate_image'
const DEFAULT_MAX_INPUT_IMAGES = 4

/** Input the model sends to an image tool. */
export interface ImageToolInput {
  readonly prompt: string
  readonly size?: string
  /** References to input images, resolved by {@link ImageToolOptions.resolveImage}. */
  readonly images?: readonly string[]
}

/** What the application receives in {@link ImageToolOptions.onImage}. */
export interface ImageToolOutputInfo {
  /** The request sent to `runImage`, without input image bytes. */
  readonly input: ImageToolInput
  readonly provider: string
  readonly model: string
  readonly attempts: readonly ImageAttemptRecord[]
  readonly durationMs: number
  /** The tool context of the call, for run, task, agent, and tool-call IDs. */
  readonly context: ToolUseContext
}

/**
 * Application-owned `ToolResult.data` of a successful call. It carries the
 * image's description, not its bytes, so it is safe to log or trace.
 */
export interface ImageToolData {
  readonly provider: string
  readonly model: string
  readonly mediaType: string
  readonly width: number
  readonly height: number
  readonly byteLength: number
  /** Number of provider calls `runImage` made, including failed ones. */
  readonly attemptCount: number
  /** The reference `onImage` returned, when it returned one. */
  readonly ref?: string
}

export interface ImageToolOptions
  extends Pick<
    RunImageOptions,
    | 'maxRetriesPerModel'
    | 'backoffBaseMs'
    | 'maxRetryAfterMs'
    | 'attemptTimeoutMs'
    | 'validate'
    | 'onAttempt'
  > {
  /** Image models to try in order, as in {@link runImage}. Must not be empty. */
  readonly chain: readonly ImageModelAdapter[]
  /** Tool name. Default `generate_image`. */
  readonly name?: string
  /** Tool description shown to the model. A default that fits the input schema is used when omitted. */
  readonly description?: string
  /**
   * Sizes the model may choose from, in the providers' own format. With a
   * list, `size` is limited to these values. Without one, `size` is any string
   * and is passed to the adapters unchanged.
   */
  readonly sizes?: readonly [string, ...string[]]
  /**
   * Turns a reference the model sent into image bytes. Setting it enables
   * edits: the input schema gains an `images` array of references, where the
   * first is the image to edit and the rest are references. Return
   * `undefined` for an unknown reference; the call then fails as a tool error
   * without calling any model. Without this option the tool generates only.
   */
  readonly resolveImage?: (
    ref: string,
    context: ToolUseContext,
  ) => ImageInput | undefined | Promise<ImageInput | undefined>
  /** Most references accepted in one call. Default 4. */
  readonly maxInputImages?: number
  /**
   * Receives every generated image at full size, for storage. It is awaited
   * before the tool returns. Return a string to give the image a reference:
   * the model is told it, and can pass it back in `images` to edit the image
   * later when `resolveImage` knows it.
   */
  readonly onImage?: (
    image: ImageOutput,
    info: ImageToolOutputInfo,
  ) => string | void | Promise<string | void>
  /**
   * Chooses what the model sees, for example a downscaled copy to save
   * context. Return the image to show, or `null` to send only the text
   * summary. By default the model sees the generated image unchanged.
   */
  readonly modelImage?: (image: ImageOutput) => ImageInput | null | Promise<ImageInput | null>
  /** Marks the tool as having real side effects. Default false. */
  readonly consequential?: boolean
}

function defaultDescription(edits: boolean): string {
  const base = 'Generate an image from a text prompt. Describe the image to create in `prompt`.'
  if (!edits) return base
  return `${base} To edit or combine existing images, list their references in \`images\`: `
    + 'the first is the image to edit and the rest are references. '
    + 'Use only references you were given.'
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`createImageTool: ${name} must be a positive integer`)
  }
}

function buildInputSchema(options: ImageToolOptions, maxInputImages: number) {
  const size = options.sizes !== undefined
    ? z.enum(options.sizes as [string, ...string[]])
      .describe('Output size. Omit to use the model default.')
    : z.string().min(1)
      .describe('Output size in the image provider\'s format, for example 1024x1024. Omit to use the model default.')
  const base = {
    prompt: z.string().min(1).describe('What to generate, or how to change the input images.'),
    size: size.optional(),
  }
  if (options.resolveImage === undefined) return z.object(base)
  return z.object({
    ...base,
    images: z.array(z.string().min(1)).min(1).max(maxInputImages)
      .describe('References to input images. The first is the image to edit; the rest are references.')
      .optional(),
  })
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
}

function errorResult(message: string) {
  return { data: message, isError: true as const }
}

/**
 * Create a tool that lets a model generate, and optionally edit, images
 * through {@link runImage}.
 *
 * Register it like any custom tool, for example in `AgentConfig.customTools`.
 * A failed generation or an unknown image reference returns an error
 * `ToolResult`, so the model can react. A throw from `resolveImage`,
 * `onImage`, or `modelImage` becomes an error result through the tool
 * executor, like any other tool. Cancelling the agent's run aborts the image
 * call.
 *
 * @example
 * ```ts
 * const imageTool = createImageTool({
 *   chain: [new OpenAIImageAdapter({ model: 'gpt-image-1' })],
 *   sizes: ['1024x1024', '1536x1024'],
 *   onImage: async image => storage.put(image.data, image.mediaType),
 * })
 * ```
 */
export function createImageTool(
  options: ImageToolOptions,
): ToolDefinition<ImageToolInput, ImageToolData | string> {
  if (options.chain.length === 0) throw new TypeError('createImageTool: chain must not be empty')
  const name = options.name ?? DEFAULT_NAME
  if (name.trim().length === 0) throw new TypeError('createImageTool: name must not be empty')
  if (options.sizes !== undefined && options.sizes.length === 0) {
    throw new TypeError('createImageTool: sizes must not be empty')
  }
  const maxInputImages = options.maxInputImages ?? DEFAULT_MAX_INPUT_IMAGES
  assertPositiveInteger(maxInputImages, 'maxInputImages')
  const chain = [...options.chain]
  const edits = options.resolveImage !== undefined

  return defineTool<ImageToolInput, ImageToolData | string>({
    name,
    description: options.description ?? defaultDescription(edits),
    inputSchema: buildInputSchema(options, maxInputImages) as unknown as ZodSchema<ImageToolInput>,
    ...(options.consequential !== undefined ? { consequential: options.consequential } : {}),
    async execute(input, context) {
      const refs = input.images ?? []
      const images: ImageInput[] = []
      if (refs.length > 0) {
        const resolveImage = options.resolveImage
        if (resolveImage === undefined) return errorResult('This tool does not accept input images.')
        for (const ref of refs) {
          const image = await resolveImage(ref, context)
          if (image === undefined) {
            return errorResult(`Unknown image reference "${ref}". Use only references you were given.`)
          }
          images.push(image)
        }
      }

      const request: ImageRequest = {
        prompt: input.prompt,
        ...(input.size !== undefined ? { size: input.size } : {}),
        ...(images.length > 0 ? { images } : {}),
      }
      const result = await runImage({
        chain,
        request,
        ...(options.maxRetriesPerModel !== undefined ? { maxRetriesPerModel: options.maxRetriesPerModel } : {}),
        ...(options.backoffBaseMs !== undefined ? { backoffBaseMs: options.backoffBaseMs } : {}),
        ...(options.maxRetryAfterMs !== undefined ? { maxRetryAfterMs: options.maxRetryAfterMs } : {}),
        ...(options.attemptTimeoutMs !== undefined ? { attemptTimeoutMs: options.attemptTimeoutMs } : {}),
        ...(options.validate !== undefined ? { validate: options.validate } : {}),
        ...(options.onAttempt !== undefined ? { onAttempt: options.onAttempt } : {}),
        ...(context.abortSignal !== undefined ? { signal: context.abortSignal } : {}),
      })

      if (result.status === 'failed') {
        return errorResult(`Image generation failed (${result.error.type}): ${result.error.message}`)
      }

      const { output } = result
      let ref: string | undefined
      if (options.onImage !== undefined) {
        const returned = await options.onImage(output, {
          input: {
            prompt: input.prompt,
            ...(input.size !== undefined ? { size: input.size } : {}),
            ...(refs.length > 0 ? { images: [...refs] } : {}),
          },
          provider: result.provider,
          model: result.model,
          attempts: result.attempts,
          durationMs: result.durationMs,
          context,
        })
        if (typeof returned === 'string' && returned.length > 0) ref = returned
      }

      const shown = options.modelImage === undefined
        ? output
        : await options.modelImage(output)

      let summary = `Generated a ${output.width}x${output.height} ${output.mediaType} image `
        + `with ${result.provider}/${result.model}.`
      if (ref !== undefined) summary += ` Its reference is "${ref}".`
      if (shown === null) summary += ' The image itself is not included in this result.'

      const modelOutput: ToolResultContentPart[] = [{ type: 'text', text: summary }]
      if (shown !== null) {
        modelOutput.push({
          type: 'image',
          source: { type: 'base64', media_type: shown.mediaType, data: base64(shown.data) },
        })
      }

      return {
        data: {
          provider: result.provider,
          model: result.model,
          mediaType: output.mediaType,
          width: output.width,
          height: output.height,
          byteLength: output.data.byteLength,
          attemptCount: result.attempts.length,
          ...(ref !== undefined ? { ref } : {}),
        },
        modelOutput,
      }
    },
  })
}
