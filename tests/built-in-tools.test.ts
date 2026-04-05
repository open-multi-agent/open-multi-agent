import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { fileReadTool } from '../src/tool/built-in/file-read.js'
import { fileWriteTool } from '../src/tool/built-in/file-write.js'
import { fileEditTool } from '../src/tool/built-in/file-edit.js'
import { bashTool } from '../src/tool/built-in/bash.js'
import { grepTool } from '../src/tool/built-in/grep.js'
import { registerBuiltInTools, BUILT_IN_TOOLS } from '../src/tool/built-in/index.js'
import { ToolRegistry } from '../src/tool/framework.js'
import type { ToolUseContext } from '../src/types.js'

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
  it('registers all 5 built-in tools', () => {
    const registry = new ToolRegistry()
    registerBuiltInTools(registry)

    expect(registry.get('bash')).toBeDefined()
    expect(registry.get('file_read')).toBeDefined()
    expect(registry.get('file_write')).toBeDefined()
    expect(registry.get('file_edit')).toBeDefined()
    expect(registry.get('grep')).toBeDefined()
  })

  it('BUILT_IN_TOOLS has correct length', () => {
    expect(BUILT_IN_TOOLS).toHaveLength(5)
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
