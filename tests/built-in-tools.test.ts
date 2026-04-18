import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { fileReadTool } from '../src/tool/built-in/file-read.js'
import { fileWriteTool } from '../src/tool/built-in/file-write.js'
import { fileEditTool } from '../src/tool/built-in/file-edit.js'
import { bashTool } from '../src/tool/built-in/bash.js'
import { globTool } from '../src/tool/built-in/glob.js'
import { grepTool } from '../src/tool/built-in/grep.js'
import {
  registerBuiltInTools,
  BUILT_IN_TOOLS,
  delegateToAgentTool,
} from '../src/tool/built-in/index.js'
import { ToolRegistry } from '../src/tool/framework.js'
import { InMemoryStore } from '../src/memory/store.js'
import type { AgentRunResult, ToolUseContext } from '../src/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultContext: ToolUseContext = {
  agent: { name: 'test-agent', role: 'tester', model: 'test' },
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'oma-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

// ===========================================================================
// registerBuiltInTools
// ===========================================================================

describe('registerBuiltInTools', () => {
  it('registers all 6 built-in tools', () => {
    const registry = new ToolRegistry()
    registerBuiltInTools(registry)

    expect(registry.get('bash')).toBeDefined()
    expect(registry.get('file_read')).toBeDefined()
    expect(registry.get('file_write')).toBeDefined()
    expect(registry.get('file_edit')).toBeDefined()
    expect(registry.get('grep')).toBeDefined()
    expect(registry.get('glob')).toBeDefined()
    expect(registry.get('delegate_to_agent')).toBeUndefined()
  })

  it('registers delegate_to_agent when includeDelegateTool is set', () => {
    const registry = new ToolRegistry()
    registerBuiltInTools(registry, { includeDelegateTool: true })
    expect(registry.get('delegate_to_agent')).toBeDefined()
  })

  it('BUILT_IN_TOOLS has correct length', () => {
    expect(BUILT_IN_TOOLS).toHaveLength(6)
  })
})

// ===========================================================================
// file_read
// ===========================================================================

describe('file_read', () => {
  it('reads a file with line numbers', async () => {
    const filePath = join(tmpDir, 'test.txt')
    await writeFile(filePath, 'line one\nline two\nline three\n')

    const result = await fileReadTool.execute({ path: filePath }, defaultContext)

    expect(result.isError).toBe(false)
    expect(result.data).toContain('1\tline one')
    expect(result.data).toContain('2\tline two')
    expect(result.data).toContain('3\tline three')
  })

  it('reads a slice with offset and limit', async () => {
    const filePath = join(tmpDir, 'test.txt')
    await writeFile(filePath, 'a\nb\nc\nd\ne\n')

    const result = await fileReadTool.execute(
      { path: filePath, offset: 2, limit: 2 },
      defaultContext,
    )

    expect(result.isError).toBe(false)
    expect(result.data).toContain('2\tb')
    expect(result.data).toContain('3\tc')
    expect(result.data).not.toContain('1\ta')
  })

  it('errors on non-existent file', async () => {
    const result = await fileReadTool.execute(
      { path: join(tmpDir, 'nope.txt') },
      defaultContext,
    )

    expect(result.isError).toBe(true)
    expect(result.data).toContain('Could not read file')
  })

  it('errors when offset is beyond end of file', async () => {
    const filePath = join(tmpDir, 'short.txt')
    await writeFile(filePath, 'one line\n')

    const result = await fileReadTool.execute(
      { path: filePath, offset: 100 },
      defaultContext,
    )

    expect(result.isError).toBe(true)
    expect(result.data).toContain('beyond the end')
  })

  it('shows truncation note when not reading entire file', async () => {
    const filePath = join(tmpDir, 'multi.txt')
    await writeFile(filePath, 'a\nb\nc\nd\ne\n')

    const result = await fileReadTool.execute(
      { path: filePath, limit: 2 },
      defaultContext,
    )

    expect(result.data).toContain('showing lines')
  })
})

// ===========================================================================
// file_write
// ===========================================================================

describe('file_write', () => {
  it('creates a new file', async () => {
    const filePath = join(tmpDir, 'new-file.txt')

    const result = await fileWriteTool.execute(
      { path: filePath, content: 'hello world' },
      defaultContext,
    )

    expect(result.isError).toBe(false)
    expect(result.data).toContain('Created')
    const content = await readFile(filePath, 'utf8')
    expect(content).toBe('hello world')
  })

  it('overwrites an existing file', async () => {
    const filePath = join(tmpDir, 'existing.txt')
    await writeFile(filePath, 'old content')

    const result = await fileWriteTool.execute(
      { path: filePath, content: 'new content' },
      defaultContext,
    )

    expect(result.isError).toBe(false)
    expect(result.data).toContain('Updated')
    const content = await readFile(filePath, 'utf8')
    expect(content).toBe('new content')
  })

  it('creates parent directories', async () => {
    const filePath = join(tmpDir, 'deep', 'nested', 'file.txt')

    const result = await fileWriteTool.execute(
      { path: filePath, content: 'deep file' },
      defaultContext,
    )

    expect(result.isError).toBe(false)
    const content = await readFile(filePath, 'utf8')
    expect(content).toBe('deep file')
  })

  it('reports line and byte counts', async () => {
    const filePath = join(tmpDir, 'counted.txt')

    const result = await fileWriteTool.execute(
      { path: filePath, content: 'line1\nline2\nline3' },
      defaultContext,
    )

    expect(result.data).toContain('3 lines')
  })
})

// ===========================================================================
// file_edit
// ===========================================================================

describe('file_edit', () => {
  it('replaces a unique string', async () => {
    const filePath = join(tmpDir, 'edit.txt')
    await writeFile(filePath, 'hello world\ngoodbye world\n')

    const result = await fileEditTool.execute(
      { path: filePath, old_string: 'hello', new_string: 'hi' },
      defaultContext,
    )

    expect(result.isError).toBe(false)
    expect(result.data).toContain('Replaced 1 occurrence')
    const content = await readFile(filePath, 'utf8')
    expect(content).toContain('hi world')
    expect(content).toContain('goodbye world')
  })

  it('errors when old_string not found', async () => {
    const filePath = join(tmpDir, 'edit.txt')
    await writeFile(filePath, 'hello world\n')

    const result = await fileEditTool.execute(
      { path: filePath, old_string: 'nonexistent', new_string: 'x' },
      defaultContext,
    )

    expect(result.isError).toBe(true)
    expect(result.data).toContain('not found')
  })

  it('errors on ambiguous match without replace_all', async () => {
    const filePath = join(tmpDir, 'edit.txt')
    await writeFile(filePath, 'foo bar foo\n')

    const result = await fileEditTool.execute(
      { path: filePath, old_string: 'foo', new_string: 'baz' },
      defaultContext,
    )

    expect(result.isError).toBe(true)
    expect(result.data).toContain('2 times')
  })

  it('replaces all when replace_all is true', async () => {
    const filePath = join(tmpDir, 'edit.txt')
    await writeFile(filePath, 'foo bar foo\n')

    const result = await fileEditTool.execute(
      { path: filePath, old_string: 'foo', new_string: 'baz', replace_all: true },
      defaultContext,
    )

    expect(result.isError).toBe(false)
    expect(result.data).toContain('Replaced 2 occurrences')
    const content = await readFile(filePath, 'utf8')
    expect(content).toBe('baz bar baz\n')
  })

  it('errors on non-existent file', async () => {
    const result = await fileEditTool.execute(
      { path: join(tmpDir, 'nope.txt'), old_string: 'x', new_string: 'y' },
      defaultContext,
    )

    expect(result.isError).toBe(true)
    expect(result.data).toContain('Could not read')
  })
})

// ===========================================================================
// bash
// ===========================================================================

describe('bash', () => {
  it('executes a simple command', async () => {
    const result = await bashTool.execute(
      { command: 'echo "hello bash"' },
      defaultContext,
    )

    expect(result.isError).toBe(false)
    expect(result.data).toContain('hello bash')
  })

  it('captures stderr on failed command', async () => {
    const result = await bashTool.execute(
      { command: 'ls /nonexistent/path/xyz 2>&1' },
      defaultContext,
    )

    expect(result.isError).toBe(true)
  })

  it('supports custom working directory', async () => {
    const result = await bashTool.execute(
      { command: 'pwd', cwd: tmpDir },
      defaultContext,
    )

    expect(result.isError).toBe(false)
    expect(result.data).toContain(tmpDir)
  })

  it('returns exit code for failing commands', async () => {
    const result = await bashTool.execute(
      { command: 'exit 42' },
      defaultContext,
    )

    expect(result.isError).toBe(true)
    expect(result.data).toContain('42')
  })

  it('handles commands with no output', async () => {
    const result = await bashTool.execute(
      { command: 'true' },
      defaultContext,
    )

    expect(result.isError).toBe(false)
    expect(result.data).toContain('command completed with no output')
  })
})

// ===========================================================================
// glob
// ===========================================================================

describe('glob', () => {
  it('lists files matching a pattern without reading contents', async () => {
    await writeFile(join(tmpDir, 'a.ts'), 'SECRET_CONTENT_SHOULD_NOT_APPEAR')
    await writeFile(join(tmpDir, 'b.md'), 'also secret')

    const result = await globTool.execute(
      { path: tmpDir, pattern: '*.ts' },
      defaultContext,
    )

    expect(result.isError).toBe(false)
    expect(result.data).toContain('.ts')
    expect(result.data).not.toContain('SECRET')
    expect(result.data).not.toContain('b.md')
  })

  it('lists all files when pattern is omitted', async () => {
    await writeFile(join(tmpDir, 'x.txt'), 'x')
    await writeFile(join(tmpDir, 'y.txt'), 'y')

    const result = await globTool.execute({ path: tmpDir }, defaultContext)

    expect(result.isError).toBe(false)
    expect(result.data).toContain('x.txt')
    expect(result.data).toContain('y.txt')
  })

  it('lists a single file when path is a file', async () => {
    const filePath = join(tmpDir, 'only.ts')
    await writeFile(filePath, 'body')

    const result = await globTool.execute({ path: filePath }, defaultContext)

    expect(result.isError).toBe(false)
    expect(result.data).toContain('only.ts')
  })

  it('returns no match when single file does not match pattern', async () => {
    const filePath = join(tmpDir, 'readme.md')
    await writeFile(filePath, '# doc')

    const result = await globTool.execute(
      { path: filePath, pattern: '*.ts' },
      defaultContext,
    )

    expect(result.isError).toBe(false)
    expect(result.data).toContain('No files matched')
  })

  it('recurses into subdirectories', async () => {
    const sub = join(tmpDir, 'nested')
    const { mkdir } = await import('fs/promises')
    await mkdir(sub, { recursive: true })
    await writeFile(join(sub, 'deep.ts'), '')

    const result = await globTool.execute(
      { path: tmpDir, pattern: '*.ts' },
      defaultContext,
    )

    expect(result.isError).toBe(false)
    expect(result.data).toContain('deep.ts')
  })

  it('errors on inaccessible path', async () => {
    const result = await globTool.execute(
      { path: '/nonexistent/path/xyz' },
      defaultContext,
    )

    expect(result.isError).toBe(true)
    expect(result.data).toContain('Cannot access path')
  })

  it('notes truncation when maxFiles is exceeded', async () => {
    for (let i = 0; i < 5; i++) {
      await writeFile(join(tmpDir, `f${i}.txt`), '')
    }

    const result = await globTool.execute(
      { path: tmpDir, pattern: '*.txt', maxFiles: 3 },
      defaultContext,
    )

    expect(result.isError).toBe(false)
    const lines = (result.data as string).split('\n').filter((l) => l.endsWith('.txt'))
    expect(lines).toHaveLength(3)
    expect(result.data).toContain('capped at 3')
  })
})

// ===========================================================================
// grep (Node.js fallback — tests do not depend on ripgrep availability)
// ===========================================================================

describe('grep', () => {
  it('finds matching lines in a file', async () => {
    const filePath = join(tmpDir, 'search.txt')
    await writeFile(filePath, 'apple\nbanana\napricot\ncherry\n')

    const result = await grepTool.execute(
      { pattern: 'ap', path: filePath },
      defaultContext,
    )

    expect(result.isError).toBe(false)
    expect(result.data).toContain('apple')
    expect(result.data).toContain('apricot')
    expect(result.data).not.toContain('cherry')
  })

  it('returns "No matches found" when nothing matches', async () => {
    const filePath = join(tmpDir, 'search.txt')
    await writeFile(filePath, 'hello world\n')

    const result = await grepTool.execute(
      { pattern: 'zzz', path: filePath },
      defaultContext,
    )

    expect(result.isError).toBe(false)
    expect(result.data).toContain('No matches found')
  })

  it('errors on invalid regex', async () => {
    const result = await grepTool.execute(
      { pattern: '[invalid', path: tmpDir },
      defaultContext,
    )

    expect(result.isError).toBe(true)
    expect(result.data).toContain('Invalid regular expression')
  })

  it('searches recursively in a directory', async () => {
    const subDir = join(tmpDir, 'sub')
    await writeFile(join(tmpDir, 'a.txt'), 'findme here\n')
    // Create subdir and file
    const { mkdir } = await import('fs/promises')
    await mkdir(subDir, { recursive: true })
    await writeFile(join(subDir, 'b.txt'), 'findme there\n')

    const result = await grepTool.execute(
      { pattern: 'findme', path: tmpDir },
      defaultContext,
    )

    expect(result.isError).toBe(false)
    expect(result.data).toContain('findme here')
    expect(result.data).toContain('findme there')
  })

  it('respects glob filter', async () => {
    await writeFile(join(tmpDir, 'code.ts'), 'const x = 1\n')
    await writeFile(join(tmpDir, 'readme.md'), 'const y = 2\n')

    const result = await grepTool.execute(
      { pattern: 'const', path: tmpDir, glob: '*.ts' },
      defaultContext,
    )

    expect(result.isError).toBe(false)
    expect(result.data).toContain('code.ts')
    expect(result.data).not.toContain('readme.md')
  })

  it('errors on inaccessible path', async () => {
    const result = await grepTool.execute(
      { pattern: 'test', path: '/nonexistent/path/xyz' },
      defaultContext,
    )

    expect(result.isError).toBe(true)
    // May hit ripgrep path or Node fallback — both report an error
    expect(result.data.toLowerCase()).toContain('no such file')
  })
})

// ===========================================================================
// delegate_to_agent
// ===========================================================================

const DELEGATE_OK: AgentRunResult = {
  success: true,
  output: 'research done',
  messages: [],
  tokenUsage: { input_tokens: 1, output_tokens: 2 },
  toolCalls: [],
}

describe('delegate_to_agent', () => {
  it('returns delegated agent output on success', async () => {
    const runDelegatedAgent = vi.fn().mockResolvedValue(DELEGATE_OK)
    const ctx: ToolUseContext = {
      agent: { name: 'alice', role: 'lead', model: 'test' },
      team: {
        name: 't',
        agents: ['alice', 'bob'],
        delegationDepth: 0,
        maxDelegationDepth: 3,
        delegationPool: { availableRunSlots: 2 },
        runDelegatedAgent,
      },
    }

    const result = await delegateToAgentTool.execute(
      { target_agent: 'bob', prompt: 'Summarize X.' },
      ctx,
    )

    expect(result.isError).toBe(false)
    expect(result.data).toBe('research done')
    expect(runDelegatedAgent).toHaveBeenCalledWith('bob', 'Summarize X.')
  })

  it('errors when delegation would form a cycle (A -> B -> A)', async () => {
    const ctx: ToolUseContext = {
      agent: { name: 'bob', role: 'worker', model: 'test' },
      team: {
        name: 't',
        agents: ['alice', 'bob'],
        delegationDepth: 1,
        maxDelegationDepth: 5,
        delegationChain: ['alice', 'bob'],
        delegationPool: { availableRunSlots: 2 },
        runDelegatedAgent: vi.fn().mockResolvedValue(DELEGATE_OK),
      },
    }

    const result = await delegateToAgentTool.execute(
      { target_agent: 'alice', prompt: 'loop back' },
      ctx,
    )

    expect(result.isError).toBe(true)
    expect(result.data).toMatch(/Delegation cycle detected: alice -> bob -> alice/)
    expect(ctx.team!.runDelegatedAgent).not.toHaveBeenCalled()
  })

  it('surfaces delegated run tokenUsage via ToolResult.metadata', async () => {
    const runDelegatedAgent = vi.fn().mockResolvedValue({
      success: true,
      output: 'answer',
      messages: [],
      tokenUsage: { input_tokens: 123, output_tokens: 45 },
      toolCalls: [],
    } satisfies AgentRunResult)
    const ctx: ToolUseContext = {
      agent: { name: 'alice', role: 'lead', model: 'test' },
      team: {
        name: 't',
        agents: ['alice', 'bob'],
        delegationPool: { availableRunSlots: 2 },
        runDelegatedAgent,
      },
    }

    const result = await delegateToAgentTool.execute(
      { target_agent: 'bob', prompt: 'Hi' },
      ctx,
    )

    expect(result.metadata?.tokenUsage).toEqual({ input_tokens: 123, output_tokens: 45 })
  })

  it('errors when delegation is not configured', async () => {
    const ctx: ToolUseContext = {
      agent: { name: 'alice', role: 'lead', model: 'test' },
      team: { name: 't', agents: ['alice', 'bob'] },
    }

    const result = await delegateToAgentTool.execute(
      { target_agent: 'bob', prompt: 'Hi' },
      ctx,
    )

    expect(result.isError).toBe(true)
    expect(result.data).toMatch(/only available during orchestrated team runs/i)
  })

  it('errors for unknown target agent', async () => {
    const ctx: ToolUseContext = {
      agent: { name: 'alice', role: 'lead', model: 'test' },
      team: {
        name: 't',
        agents: ['alice', 'bob'],
        runDelegatedAgent: vi.fn(),
        delegationPool: { availableRunSlots: 1 },
      },
    }

    const result = await delegateToAgentTool.execute(
      { target_agent: 'charlie', prompt: 'Hi' },
      ctx,
    )

    expect(result.isError).toBe(true)
    expect(result.data).toMatch(/Unknown agent/)
  })

  it('errors on self-delegation', async () => {
    const ctx: ToolUseContext = {
      agent: { name: 'alice', role: 'lead', model: 'test' },
      team: {
        name: 't',
        agents: ['alice', 'bob'],
        runDelegatedAgent: vi.fn(),
        delegationPool: { availableRunSlots: 1 },
      },
    }

    const result = await delegateToAgentTool.execute(
      { target_agent: 'alice', prompt: 'Hi' },
      ctx,
    )

    expect(result.isError).toBe(true)
    expect(result.data).toMatch(/yourself/)
  })

  it('errors when delegation depth limit is reached', async () => {
    const ctx: ToolUseContext = {
      agent: { name: 'alice', role: 'lead', model: 'test' },
      team: {
        name: 't',
        agents: ['alice', 'bob'],
        delegationDepth: 3,
        maxDelegationDepth: 3,
        runDelegatedAgent: vi.fn(),
        delegationPool: { availableRunSlots: 1 },
      },
    }

    const result = await delegateToAgentTool.execute(
      { target_agent: 'bob', prompt: 'Hi' },
      ctx,
    )

    expect(result.isError).toBe(true)
    expect(result.data).toMatch(/Maximum delegation depth/)
  })

  it('errors fast when pool has no free slots without calling runDelegatedAgent', async () => {
    const runDelegatedAgent = vi.fn()
    const ctx: ToolUseContext = {
      agent: { name: 'alice', role: 'lead', model: 'test' },
      team: {
        name: 't',
        agents: ['alice', 'bob'],
        delegationPool: { availableRunSlots: 0 },
        runDelegatedAgent,
      },
    }

    const result = await delegateToAgentTool.execute(
      { target_agent: 'bob', prompt: 'Hi' },
      ctx,
    )

    expect(result.isError).toBe(true)
    expect(result.data).toMatch(/no free concurrency slot/i)
    expect(runDelegatedAgent).not.toHaveBeenCalled()
  })

  it('writes unique SharedMemory audit keys for repeated delegations', async () => {
    const store = new InMemoryStore()
    const runDelegatedAgent = vi.fn().mockResolvedValue(DELEGATE_OK)
    const ctx: ToolUseContext = {
      agent: { name: 'alice', role: 'lead', model: 'test' },
      team: {
        name: 't',
        agents: ['alice', 'bob'],
        sharedMemory: store,
        delegationPool: { availableRunSlots: 2 },
        runDelegatedAgent,
      },
    }

    await delegateToAgentTool.execute({ target_agent: 'bob', prompt: 'a' }, ctx)
    await delegateToAgentTool.execute({ target_agent: 'bob', prompt: 'b' }, ctx)

    const keys = (await store.list()).map((e) => e.key)
    const delegationKeys = keys.filter((k) => k.includes('delegation:bob:'))
    expect(delegationKeys).toHaveLength(2)
    expect(delegationKeys[0]).not.toBe(delegationKeys[1])
  })

  it('returns isError when delegated run reports success false', async () => {
    const runDelegatedAgent = vi.fn().mockResolvedValue({
      success: false,
      output: 'delegated agent failed',
      messages: [],
      tokenUsage: { input_tokens: 0, output_tokens: 0 },
      toolCalls: [],
    } satisfies AgentRunResult)

    const ctx: ToolUseContext = {
      agent: { name: 'alice', role: 'lead', model: 'test' },
      team: {
        name: 't',
        agents: ['alice', 'bob'],
        delegationPool: { availableRunSlots: 1 },
        runDelegatedAgent,
      },
    }

    const result = await delegateToAgentTool.execute(
      { target_agent: 'bob', prompt: 'Hi' },
      ctx,
    )

    expect(result.isError).toBe(true)
    expect(result.data).toBe('delegated agent failed')
  })
})
