import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { ToolRegistry, defineTool } from '../src/tool/framework.js'
import { ToolExecutor } from '../src/tool/executor.js'
import type { ToolUseContext } from '../src/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dummyContext: ToolUseContext = {
  agent: { name: 'test-agent', role: 'tester', model: 'test-model' },
}

function echoTool() {
  return defineTool({
    name: 'echo',
    description: 'Echoes the message.',
    inputSchema: z.object({ message: z.string() }),
    execute: async ({ message }) => ({ data: message, isError: false }),
  })
}

function failTool() {
  return defineTool({
    name: 'fail',
    description: 'Always throws.',
    inputSchema: z.object({}),
    execute: async () => {
      throw new Error('intentional failure')
    },
  })
}

function makeExecutor(...tools: ReturnType<typeof defineTool>[]) {
  const registry = new ToolRegistry()
  for (const t of tools) registry.register(t)
  return { executor: new ToolExecutor(registry), registry }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ToolExecutor', () => {
  // -------------------------------------------------------------------------
  // Single execution
  // -------------------------------------------------------------------------

  it('executes a tool and returns its result', async () => {
    const { executor } = makeExecutor(echoTool())
    const result = await executor.execute('echo', { message: 'hello' }, dummyContext)
    expect(result.data).toBe('hello')
    expect(result.isError).toBeFalsy()
  })

  it('returns an error result for an unknown tool', async () => {
    const { executor } = makeExecutor()
    const result = await executor.execute('ghost', {}, dummyContext)
    expect(result.isError).toBe(true)
    expect(result.data).toContain('not registered')
  })

  it('returns an error result when Zod validation fails', async () => {
    const { executor } = makeExecutor(echoTool())
    // 'message' is required but missing
    const result = await executor.execute('echo', {}, dummyContext)
    expect(result.isError).toBe(true)
    expect(result.data).toContain('Invalid input')
  })

  it('catches tool execution errors and returns them as error results', async () => {
    const { executor } = makeExecutor(failTool())
    const result = await executor.execute('fail', {}, dummyContext)
    expect(result.isError).toBe(true)
    expect(result.data).toContain('intentional failure')
  })

  it('returns an error result when aborted before execution', async () => {
    const { executor } = makeExecutor(echoTool())
    const controller = new AbortController()
    controller.abort()

    const result = await executor.execute(
      'echo',
      { message: 'hi' },
      { ...dummyContext, abortSignal: controller.signal },
    )
    expect(result.isError).toBe(true)
    expect(result.data).toContain('aborted')
  })

  // -------------------------------------------------------------------------
  // Batch execution
  // -------------------------------------------------------------------------

  it('executeBatch runs multiple tools and returns a map of results', async () => {
    const { executor } = makeExecutor(echoTool())
    const results = await executor.executeBatch(
      [
        { id: 'c1', name: 'echo', input: { message: 'a' } },
        { id: 'c2', name: 'echo', input: { message: 'b' } },
      ],
      dummyContext,
    )

    expect(results.size).toBe(2)
    expect(results.get('c1')!.data).toBe('a')
    expect(results.get('c2')!.data).toBe('b')
  })

  it('executeBatch isolates errors — one failure does not affect others', async () => {
    const { executor } = makeExecutor(echoTool(), failTool())
    const results = await executor.executeBatch(
      [
        { id: 'ok', name: 'echo', input: { message: 'fine' } },
        { id: 'bad', name: 'fail', input: {} },
      ],
      dummyContext,
    )

    expect(results.get('ok')!.isError).toBeFalsy()
    expect(results.get('bad')!.isError).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Concurrency control
  // -------------------------------------------------------------------------

  it('respects maxConcurrency limit', async () => {
    let peak = 0
    let running = 0

    const trackTool = defineTool({
      name: 'track',
      description: 'Tracks concurrency.',
      inputSchema: z.object({}),
      execute: async () => {
        running++
        peak = Math.max(peak, running)
        await new Promise((r) => setTimeout(r, 50))
        running--
        return { data: 'ok', isError: false }
      },
    })

    const registry = new ToolRegistry()
    registry.register(trackTool)
    const executor = new ToolExecutor(registry, { maxConcurrency: 2 })

    await executor.executeBatch(
      Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, name: 'track', input: {} })),
      dummyContext,
    )

    expect(peak).toBeLessThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// ToolRegistry
// ---------------------------------------------------------------------------

describe('ToolRegistry', () => {
  it('registers and retrieves a tool', () => {
    const registry = new ToolRegistry()
    registry.register(echoTool())
    expect(registry.get('echo')).toBeDefined()
    expect(registry.has('echo')).toBe(true)
  })

  it('throws on duplicate registration', () => {
    const registry = new ToolRegistry()
    registry.register(echoTool())
    expect(() => registry.register(echoTool())).toThrow('already registered')
  })

  it('unregister removes the tool', () => {
    const registry = new ToolRegistry()
    registry.register(echoTool())
    registry.unregister('echo')
    expect(registry.has('echo')).toBe(false)
  })

  it('toToolDefs produces JSON schema representations', () => {
    const registry = new ToolRegistry()
    registry.register(echoTool())
    const defs = registry.toToolDefs()
    expect(defs).toHaveLength(1)
    expect(defs[0].name).toBe('echo')
    expect(defs[0].inputSchema).toHaveProperty('properties')
  })
})
