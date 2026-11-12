import { describe, expect, it, vi } from 'vitest'

import { AgentRunner } from '../src/agent/runner.js'
import { ImageModelError } from '../src/errors.js'
import { createImageTool } from '../src/image/tool.js'
import type { ImageInput, ImageModelAdapter, ImageModelOutput, ImageRequest } from '../src/image/types.js'
import { ToolExecutor } from '../src/tool/executor.js'
import { ToolRegistry } from '../src/tool/framework.js'
import type { LLMAdapter, LLMMessage, ToolResultBlock, ToolUseContext } from '../src/types.js'
import { jpegHeader, pngHeader } from './helpers/image-bytes.js'

const context: ToolUseContext = {
  agent: { name: 'tester', role: 'test', model: 'test-model' },
}

type Step = ImageModelOutput | Error

/** An adapter that plays back one scripted step per call and records requests. */
function scripted(model: string, steps: Step[]) {
  const calls: ImageRequest[] = []
  const signals: AbortSignal[] = []
  const adapter: ImageModelAdapter = {
    provider: 'fake',
    model,
    async generate(request, options) {
      calls.push(request)
      signals.push(options.signal)
      const step = steps.shift()
      if (step === undefined) throw new Error(`${model}: no scripted step left`)
      if (step instanceof Error) throw step
      return step
    },
  }
  return { adapter, calls, signals }
}

const png = (width = 64, height = 32): ImageModelOutput => ({
  data: pngHeader(width, height),
  mediaType: 'image/png',
  params: {},
})

function executorFor(tool: ReturnType<typeof createImageTool>) {
  const registry = new ToolRegistry()
  registry.register(tool)
  return { registry, executor: new ToolExecutor(registry) }
}

describe('createImageTool', () => {
  it('rejects invalid options at creation', () => {
    expect(() => createImageTool({ chain: [] })).toThrow('chain must not be empty')
    const { adapter } = scripted('a', [])
    expect(() => createImageTool({ chain: [adapter], name: ' ' })).toThrow('name must not be empty')
    expect(() => createImageTool({ chain: [adapter], maxInputImages: 0 })).toThrow('maxInputImages')
    expect(() => createImageTool({ chain: [adapter], sizes: [] as unknown as [string] })).toThrow('sizes')
  })

  it('exposes prompt and size only, unless resolveImage enables edits', () => {
    const { adapter } = scripted('a', [])
    const generateOnly = executorFor(createImageTool({ chain: [adapter] })).registry.toToolDefs()[0]!
    expect(generateOnly.name).toBe('generate_image')
    const generateSchema = generateOnly.inputSchema as { properties: Record<string, unknown>; required?: string[] }
    expect(Object.keys(generateSchema.properties).sort()).toEqual(['prompt', 'size'])
    expect(generateSchema.required).toEqual(['prompt'])

    const editing = executorFor(createImageTool({
      chain: [adapter],
      name: 'draw',
      sizes: ['1024x1024', '1536x1024'],
      resolveImage: () => undefined,
    })).registry.toToolDefs()[0]!
    expect(editing.name).toBe('draw')
    const editSchema = editing.inputSchema as { properties: Record<string, Record<string, unknown>> }
    expect(Object.keys(editSchema.properties).sort()).toEqual(['images', 'prompt', 'size'])
    expect(editSchema.properties['size']!['enum']).toEqual(['1024x1024', '1536x1024'])
    expect(editSchema.properties['images']!['type']).toBe('array')
  })

  it('returns the image to the model and its description as application data', async () => {
    const { adapter, calls } = scripted('m1', [png(640, 480)])
    const { executor } = executorFor(createImageTool({ chain: [adapter] }))

    const result = await executor.execute('generate_image', { prompt: 'a desk', size: '640x480' }, context)

    expect(result.isError).toBeFalsy()
    expect(calls).toEqual([{ prompt: 'a desk', size: '640x480' }])
    expect(result.data).toEqual({
      provider: 'fake',
      model: 'm1',
      mediaType: 'image/png',
      width: 640,
      height: 480,
      byteLength: pngHeader(640, 480).byteLength,
      attemptCount: 1,
    })
    expect(result.modelOutput).toEqual([
      { type: 'text', text: 'Generated a 640x480 image/png image with fake/m1.' },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: Buffer.from(pngHeader(640, 480)).toString('base64'),
        },
      },
    ])
  })

  it('rejects a size outside the configured list before calling a model', async () => {
    const { adapter, calls } = scripted('m1', [png()])
    const { executor } = executorFor(createImageTool({ chain: [adapter], sizes: ['1024x1024'] }))

    const result = await executor.execute('generate_image', { prompt: 'x', size: '9x9' }, context)

    expect(result.isError).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('rejects images when edits are not enabled', async () => {
    const { adapter, calls } = scripted('m1', [png()])
    const { executor } = executorFor(createImageTool({ chain: [adapter] }))

    // A model that believes it is editing gets an error, not a fresh image.
    const result = await executor.execute('generate_image', { prompt: 'x', images: ['a'] }, context)

    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('does not accept input images')
    expect(calls).toHaveLength(0)
  })

  it('keeps the reference from the model when it cannot pass it back', async () => {
    const { adapter } = scripted('m1', [png()])
    const { executor } = executorFor(createImageTool({ chain: [adapter], onImage: async () => 'img-1' }))

    const result = await executor.execute('generate_image', { prompt: 'x' }, context)

    expect(result.data).toMatchObject({ ref: 'img-1' })
    const parts = result.modelOutput as Array<{ type: string; text?: string }>
    expect(parts[0]!.text).not.toContain('img-1')
  })

  it('resolves image references into the edit request', async () => {
    const room: ImageInput = { data: pngHeader(10, 10), mediaType: 'image/png' }
    const chair: ImageInput = { data: jpegHeader(20, 20), mediaType: 'image/jpeg' }
    const store: Record<string, ImageInput> = { room, chair }
    const resolveImage = vi.fn((ref: string) => store[ref])
    const { adapter, calls } = scripted('m1', [png()])
    const { executor } = executorFor(createImageTool({ chain: [adapter], resolveImage }))

    const result = await executor.execute(
      'generate_image',
      { prompt: 'put the chair in the room', images: ['room', 'chair'] },
      { ...context, runId: 'run-1' },
    )

    expect(result.isError).toBeFalsy()
    expect(calls).toEqual([{ prompt: 'put the chair in the room', images: [room, chair] }])
    expect(resolveImage.mock.calls.map(call => call[0])).toEqual(['room', 'chair'])
    expect(resolveImage.mock.calls[0]![1]).toMatchObject({ runId: 'run-1' })
  })

  it('fails an unknown reference without calling a model', async () => {
    const { adapter, calls } = scripted('m1', [png()])
    const { executor } = executorFor(createImageTool({ chain: [adapter], resolveImage: () => undefined }))

    const result = await executor.execute('generate_image', { prompt: 'x', images: ['nope'] }, context)

    expect(result).toMatchObject({ isError: true })
    expect(result.data).toContain('Unknown image reference "nope"')
    expect(calls).toHaveLength(0)
  })

  it('caps the number of references', async () => {
    const { adapter, calls } = scripted('m1', [png()])
    const { executor } = executorFor(createImageTool({
      chain: [adapter],
      maxInputImages: 1,
      resolveImage: () => ({ data: pngHeader(1, 1), mediaType: 'image/png' }),
    }))

    const result = await executor.execute('generate_image', { prompt: 'x', images: ['a', 'b'] }, context)

    expect(result.isError).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('returns a failed chain as an error result and still reports every attempt', async () => {
    const { adapter } = scripted('m1', [new ImageModelError('content_policy', 'blocked', false)])
    const onAttempt = vi.fn()
    const { executor } = executorFor(createImageTool({ chain: [adapter], onAttempt }))

    const result = await executor.execute('generate_image', { prompt: 'x' }, context)

    expect(result).toEqual({
      data: 'Image generation failed (content_policy): blocked',
      isError: true,
    })
    expect(onAttempt).toHaveBeenCalledTimes(1)
    expect(onAttempt.mock.calls[0]![0]).toMatchObject({ status: 'failed', errorType: 'content_policy' })
  })

  it('passes runImage options through and falls back across the chain', async () => {
    const first = scripted('m1', [new ImageModelError('api_error', 'down', true), png()])
    const second = scripted('m2', [png(32, 32)])
    const validate = vi.fn(() => ({ ok: true as const }))
    const { executor } = executorFor(createImageTool({
      chain: [first.adapter, second.adapter],
      maxRetriesPerModel: 0,
      backoffBaseMs: 0,
      validate,
    }))

    const result = await executor.execute('generate_image', { prompt: 'x' }, context)

    expect(first.calls).toHaveLength(1)
    expect(second.calls).toHaveLength(1)
    expect(validate).toHaveBeenCalledTimes(1)
    expect(result.data).toMatchObject({ model: 'm2', attemptCount: 2 })
  })

  it('gives the full image to onImage and tells the model the returned reference', async () => {
    const { adapter } = scripted('m1', [png(100, 50)])
    const onImage = vi.fn(async () => 'img-7')
    const { executor } = executorFor(createImageTool({
      chain: [adapter],
      onImage,
      resolveImage: () => ({ data: pngHeader(1, 1), mediaType: 'image/png' }),
    }))

    const result = await executor.execute(
      'generate_image',
      { prompt: 'x', images: ['img-6'] },
      { ...context, toolCallId: 'call-9' },
    )

    expect(onImage).toHaveBeenCalledTimes(1)
    const [image, info] = onImage.mock.calls[0] as unknown as [
      { data: Uint8Array; width: number },
      { input: unknown; model: string; attempts: unknown[]; context: ToolUseContext },
    ]
    expect(image.data).toEqual(pngHeader(100, 50))
    expect(image.width).toBe(100)
    expect(info.input).toEqual({ prompt: 'x', images: ['img-6'] })
    expect(info.model).toBe('m1')
    expect(info.attempts).toHaveLength(1)
    expect(info.context.toolCallId).toBe('call-9')
    expect(result.data).toMatchObject({ ref: 'img-7' })
    const parts = result.modelOutput as Array<{ type: string; text?: string }>
    expect(parts[0]!.text).toContain('Its reference is "img-7".')
  })

  it('lets modelImage send a smaller copy or text only', async () => {
    const small: ImageInput = { data: jpegHeader(8, 8), mediaType: 'image/jpeg' }
    const downscaled = scripted('m1', [png(2048, 2048)])
    const downscaledResult = await executorFor(createImageTool({
      chain: [downscaled.adapter],
      modelImage: () => small,
    })).executor.execute('generate_image', { prompt: 'x' }, context)

    expect(downscaledResult.data).toMatchObject({ width: 2048, height: 2048 })
    expect(downscaledResult.modelOutput).toEqual([
      { type: 'text', text: 'Generated a 2048x2048 image/png image with fake/m1.' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from(small.data).toString('base64') },
      },
    ])

    const hidden = scripted('m1', [png()])
    const hiddenResult = await executorFor(createImageTool({
      chain: [hidden.adapter],
      modelImage: () => null,
    })).executor.execute('generate_image', { prompt: 'x' }, context)

    expect(hiddenResult.modelOutput).toEqual([
      {
        type: 'text',
        text: 'Generated a 64x32 image/png image with fake/m1. The image itself is not included in this result.',
      },
    ])
  })

  it('turns a throwing onImage into an error result', async () => {
    const { adapter } = scripted('m1', [png()])
    const { executor } = executorFor(createImageTool({
      chain: [adapter],
      onImage: () => { throw new Error('storage down') },
    }))

    const result = await executor.execute('generate_image', { prompt: 'x' }, context)

    expect(result.isError).toBe(true)
    expect(result.data).toContain('storage down')
  })

  it('forwards the tool call abort signal to the image call', async () => {
    const controller = new AbortController()
    const adapter: ImageModelAdapter = {
      provider: 'fake',
      model: 'slow',
      generate: (_request, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        controller.abort(new Error('run cancelled'))
      }),
    }
    const { executor } = executorFor(createImageTool({ chain: [adapter] }))

    const result = await executor.execute(
      'generate_image',
      { prompt: 'x' },
      { ...context, abortController: controller, abortSignal: controller.signal },
    )

    expect(result.isError).toBe(true)
    expect(result.data).toContain('run cancelled')
  })

  it('lets a model call the tool and see the image in its next turn', async () => {
    const { adapter: imageAdapter } = scripted('m1', [png(16, 16)])
    const registry = new ToolRegistry()
    registry.register(createImageTool({ chain: [imageAdapter] }))
    const calls: LLMMessage[][] = []
    let turn = 0
    const llm: LLMAdapter = {
      name: 'image-tool-test',
      async chat(messages) {
        calls.push(structuredClone(messages))
        turn++
        if (turn === 1) {
          return {
            id: 'tool-call',
            content: [{ type: 'tool_use', id: 'call-1', name: 'generate_image', input: { prompt: 'a cat' } }],
            model: 'test-model',
            stop_reason: 'tool_use',
            usage: { input_tokens: 1, output_tokens: 1 },
          }
        }
        return {
          id: 'final',
          content: [{ type: 'text', text: 'done' }],
          model: 'test-model',
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }
      },
      async *stream() { /* AgentRunner uses chat(). */ },
    }
    const runner = new AgentRunner(llm, registry, new ToolExecutor(registry), {
      model: 'test-model',
      allowedTools: ['generate_image'],
    })

    for await (const _event of runner.stream([{ role: 'user', content: [{ type: 'text', text: 'draw' }] }])) {
      // Drain the run.
    }

    expect(calls).toHaveLength(2)
    const toolResult = calls[1]!
      .flatMap(message => message.content)
      .find((block): block is ToolResultBlock => block.type === 'tool_result')
    expect(toolResult).toBeDefined()
    expect(toolResult!.is_error).toBeFalsy()
    expect(toolResult!.content).toEqual([
      { type: 'text', text: 'Generated a 16x16 image/png image with fake/m1.' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: Buffer.from(pngHeader(16, 16)).toString('base64') },
      },
    ])
  })
})
