import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AgentRunner, TOOL_PRESETS } from '../src/agent/runner.js'
import { ToolRegistry, defineTool } from '../src/tool/framework.js'
import { ToolExecutor } from '../src/tool/executor.js'
import { z } from 'zod'
import type { LLMAdapter, LLMResponse, LLMToolDef } from '../src/types.js'

// ---------------------------------------------------------------------------
// Mock adapter
// ---------------------------------------------------------------------------

const mockAdapter: LLMAdapter = {
  name: 'mock',
  async chat() {
    return {
      id: 'mock-1',
      content: [{ type: 'text', text: 'response' }],
      model: 'mock-model',
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 20 },
    } satisfies LLMResponse
  },
  async *stream() {
    // Not used in these tests
  },
}

// ---------------------------------------------------------------------------
// Test tools
// ---------------------------------------------------------------------------

function createTestTools() {
  const registry = new ToolRegistry()

  // Register test tools that match our presets
  registry.register(defineTool({
    name: 'file_read',
    description: 'Read file',
    inputSchema: z.object({ path: z.string() }),
    execute: async () => ({ data: 'content', isError: false }),
  }))

  registry.register(defineTool({
    name: 'file_write',
    description: 'Write file',
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    execute: async () => ({ data: 'ok', isError: false }),
  }))

  registry.register(defineTool({
    name: 'file_edit',
    description: 'Edit file',
    inputSchema: z.object({ path: z.string(), oldString: z.string(), newString: z.string() }),
    execute: async () => ({ data: 'ok', isError: false }),
  }))

  registry.register(defineTool({
    name: 'grep',
    description: 'Search text',
    inputSchema: z.object({ pattern: z.string(), path: z.string() }),
    execute: async () => ({ data: 'matches', isError: false }),
  }))

  registry.register(defineTool({
    name: 'glob',
    description: 'List paths',
    inputSchema: z.object({ path: z.string().optional() }),
    execute: async () => ({ data: 'paths', isError: false }),
  }))

  registry.register(defineTool({
    name: 'bash',
    description: 'Run shell command',
    inputSchema: z.object({ command: z.string() }),
    execute: async () => ({ data: 'output', isError: false }),
  }))

  // Extra tool not in any preset
  registry.register(defineTool({
    name: 'custom_tool',
    description: 'Custom tool',
    inputSchema: z.object({ input: z.string() }),
    execute: async () => ({ data: 'custom', isError: false }),
  }), { runtimeAdded: true })

  return registry
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Tool filtering', () => {
  const registry = createTestTools()
  const executor = new ToolExecutor(registry)

  describe('TOOL_PRESETS', () => {
    it('readonly preset has correct tools', () => {
      expect(TOOL_PRESETS.readonly).toEqual(['file_read', 'grep', 'glob'])
    })

    it('readwrite preset has correct tools', () => {
      expect(TOOL_PRESETS.readwrite).toEqual(['file_read', 'file_write', 'file_edit', 'grep', 'glob'])
    })

    it('full preset has correct tools', () => {
      expect(TOOL_PRESETS.full).toEqual(['file_read', 'file_write', 'file_edit', 'grep', 'glob', 'bash'])
    })
  })

  describe('resolveTools - no filtering', () => {
    it('returns all tools when no filters are set', () => {
      const runner = new AgentRunner(mockAdapter, registry, executor, {
        model: 'test-model',
      })

      const tools = (runner as any).resolveTools() as LLMToolDef[]
      const toolNames = tools.map((t: LLMToolDef) => t.name).sort()

      expect(toolNames).toEqual([
        'bash',
        'custom_tool',
        'file_edit',
        'file_read',
        'file_write',
        'glob',
        'grep',
      ])
    })
  })

  describe('resolveTools - preset filtering', () => {
    it('readonly preset filters correctly', () => {
      const runner = new AgentRunner(mockAdapter, registry, executor, {
        model: 'test-model',
        toolPreset: 'readonly',
      })

      const tools = (runner as any).resolveTools() as LLMToolDef[]
      const toolNames = tools.map((t: LLMToolDef) => t.name).sort()

      expect(toolNames).toEqual(['custom_tool', 'file_read', 'glob', 'grep'])
    })

    it('readwrite preset filters correctly', () => {
      const runner = new AgentRunner(mockAdapter, registry, executor, {
        model: 'test-model',
        toolPreset: 'readwrite',
      })

      const tools = (runner as any).resolveTools() as LLMToolDef[]
      const toolNames = tools.map((t: LLMToolDef) => t.name).sort()

      expect(toolNames).toEqual([
        'custom_tool',
        'file_edit',
        'file_read',
        'file_write',
        'glob',
        'grep',
      ])
    })

    it('full preset filters correctly', () => {
      const runner = new AgentRunner(mockAdapter, registry, executor, {
        model: 'test-model',
        toolPreset: 'full',
      })

      const tools = (runner as any).resolveTools() as LLMToolDef[]
      const toolNames = tools.map((t: LLMToolDef) => t.name).sort()

      expect(toolNames).toEqual([
        'bash',
        'custom_tool',
        'file_edit',
        'file_read',
        'file_write',
        'glob',
        'grep',
      ])
    })
  })

  describe('resolveTools - allowlist filtering', () => {
    it('allowlist filters correctly', () => {
      const runner = new AgentRunner(mockAdapter, registry, executor, {
        model: 'test-model',
        allowedTools: ['file_read', 'bash'],
      })

      const tools = (runner as any).resolveTools() as LLMToolDef[]
      const toolNames = tools.map((t: LLMToolDef) => t.name).sort()

      expect(toolNames).toEqual(['bash', 'custom_tool', 'file_read'])
    })

    it('empty allowlist returns no tools', () => {
      const runner = new AgentRunner(mockAdapter, registry, executor, {
        model: 'test-model',
        allowedTools: [],
      })

      const tools = (runner as any).resolveTools()
      expect((tools as LLMToolDef[]).map(t => t.name)).toEqual(['custom_tool'])
    })
  })

  describe('resolveTools - denylist filtering', () => {
    it('denylist filters correctly', () => {
      const runner = new AgentRunner(mockAdapter, registry, executor, {
        model: 'test-model',
        disallowedTools: ['bash', 'custom_tool'],
      })

      const tools = (runner as any).resolveTools() as LLMToolDef[]
      const toolNames = tools.map((t: LLMToolDef) => t.name).sort()

      // custom_tool is runtime-added but disallowedTools still blocks it
      expect(toolNames).toEqual([
        'file_edit',
        'file_read',
        'file_write',
        'glob',
        'grep',
      ])
    })

    it('empty denylist returns all tools', () => {
      const runner = new AgentRunner(mockAdapter, registry, executor, {
        model: 'test-model',
        disallowedTools: [],
      })

      const tools = (runner as any).resolveTools()
      expect(tools).toHaveLength(7) // All registered tools
    })
  })

  describe('resolveTools - combined filtering (preset + allowlist + denylist)', () => {
    it('preset + allowlist + denylist work together', () => {
      // Start with readwrite preset: ['file_read', 'file_write', 'file_edit', 'grep', 'glob']
      // Then allowlist: intersect with ['file_read', 'file_write', 'grep'] = ['file_read', 'file_write', 'grep']
      // Then denylist: subtract ['file_write'] = ['file_read', 'grep']
      const runner = new AgentRunner(mockAdapter, registry, executor, {
        model: 'test-model',
        toolPreset: 'readwrite',
        allowedTools: ['file_read', 'file_write', 'grep'],
        disallowedTools: ['file_write'],
      })

      const tools = (runner as any).resolveTools() as LLMToolDef[]
      const toolNames = tools.map((t: LLMToolDef) => t.name).sort()

      expect(toolNames).toEqual(['custom_tool', 'file_read', 'grep'])
    })

    it('preset filters first, then allowlist intersects, then denylist subtracts', () => {
      // Start with readonly preset: ['file_read', 'grep', 'glob']
      // Allowlist intersect with ['file_read', 'bash']: ['file_read']
      // Denylist subtract ['file_read']: []
      const runner = new AgentRunner(mockAdapter, registry, executor, {
        model: 'test-model',
        toolPreset: 'readonly',
        allowedTools: ['file_read', 'bash'],
        disallowedTools: ['file_read'],
      })

      const tools = (runner as any).resolveTools()
      expect((tools as LLMToolDef[]).map(t => t.name)).toEqual(['custom_tool'])
    })
  })

  describe('resolveTools - custom tool behavior', () => {
    it('always includes custom tools regardless of filtering', () => {
      const runner = new AgentRunner(mockAdapter, registry, executor, {
        model: 'test-model',
        toolPreset: 'readonly',
        allowedTools: ['file_read'],
        disallowedTools: ['file_read', 'bash', 'grep'],
      })

      const tools = (runner as any).resolveTools() as LLMToolDef[]
      const toolNames = tools.map((t: LLMToolDef) => t.name).sort()

      expect(toolNames).toEqual(['custom_tool'])
    })

    it('runtime-added tools are blocked by disallowedTools', () => {
      const runtimeBuiltinNamedRegistry = new ToolRegistry()
      runtimeBuiltinNamedRegistry.register(defineTool({
        name: 'file_read',
        description: 'Runtime override',
        inputSchema: z.object({ path: z.string() }),
        execute: async () => ({ data: 'runtime', isError: false }),
      }), { runtimeAdded: true })

      const runtimeBuiltinNamedRunner = new AgentRunner(
        mockAdapter,
        runtimeBuiltinNamedRegistry,
        new ToolExecutor(runtimeBuiltinNamedRegistry),
        {
          model: 'test-model',
          disallowedTools: ['file_read'],
        },
      )

      const tools = (runtimeBuiltinNamedRunner as any).resolveTools() as LLMToolDef[]
      expect(tools.map(t => t.name)).toEqual([])
    })
  })

  describe('resolveTools - validation warnings', () => {
    let consoleWarnSpy: any

    beforeEach(() => {
      consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    })

    afterEach(() => {
      consoleWarnSpy.mockRestore()
    })

    it('warns when tool appears in both allowedTools and disallowedTools', () => {
      const runner = new AgentRunner(mockAdapter, registry, executor, {
        model: 'test-model',
        allowedTools: ['file_read', 'bash'],
        disallowedTools: ['bash', 'grep'],
      })

      ;(runner as any).resolveTools()

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('tools ["bash"] appear in both allowedTools and disallowedTools')
      )
    })

    it('warns when both toolPreset and allowedTools are set', () => {
      const runner = new AgentRunner(mockAdapter, registry, executor, {
        model: 'test-model',
        toolPreset: 'readonly',
        allowedTools: ['file_read', 'bash'],
      })

      ;(runner as any).resolveTools()

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('both toolPreset and allowedTools are set')
      )
    })

    it('does not warn when no overlap between allowedTools and disallowedTools', () => {
      const runner = new AgentRunner(mockAdapter, registry, executor, {
        model: 'test-model',
        allowedTools: ['file_read'],
        disallowedTools: ['bash'],
      })

      ;(runner as any).resolveTools()

      expect(consoleWarnSpy).not.toHaveBeenCalled()
    })
  })
})

