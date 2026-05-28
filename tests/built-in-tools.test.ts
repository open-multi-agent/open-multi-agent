import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { access, mkdir, mkdtemp, rm, symlink, writeFile, readFile } from 'fs/promises'
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
import {
  DEFAULT_WORKSPACE_DIRNAME,
  defaultWorkspaceDir,
} from '../src/tool/built-in/path-safety.js'
import { ToolRegistry } from '../src/tool/framework.js'
import { InMemoryStore } from '../src/memory/store.js'
import type { AgentRunResult, ToolUseContext } from '../src/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string
let defaultContext: ToolUseContext

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'oma-test-'))
  defaultContext = {
    agent: { name: 'test-agent', role: 'tester', model: 'test' },
    cwd: tmpDir,
  }
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

  it('does not pass provider secrets from process.env into the shell', async () => {
    const original = process.env['OPENAI_API_KEY']
    process.env['OPENAI_API_KEY'] = 'sk-envsecretvalue1234567890'
    try {
      const result = await bashTool.execute(
        { command: 'printf "%s" "$OPENAI_API_KEY"' },
        defaultContext,
      )

      expect(result.isError).toBe(false)
      expect(result.data).not.toContain('sk-envsecretvalue1234567890')
    } finally {
      if (original === undefined) {
        delete process.env['OPENAI_API_KEY']
      } else {
        process.env['OPENAI_API_KEY'] = original
      }
    }
  })

  it('redacts sensitive-looking command output', async () => {
    const result = await bashTool.execute(
      { command: 'printf "OPENAI_API_KEY=sk-outputsecretvalue1234567890"' },
      defaultContext,
    )

    expect(result.isError).toBe(false)
    expect(result.data).toContain('[redacted]')
    expect(result.data).not.toContain('sk-outputsecretvalue1234567890')
  })

  it('kills background child processes on timeout', async () => {
    const marker = join(tmpDir, 'background-child.txt')

    const result = await bashTool.execute(
      {
        command: `(sleep 0.4; echo alive > ${shellQuote(marker)}) & sleep 5`,
        timeout: 100,
      },
      defaultContext,
    )

    expect(result.isError).toBe(true)
    expect(result.data).toContain('124')

    // The backgrounded child would have written the marker after 400 ms if it
    // had outlived the parent. Give it more than that and verify nothing was
    // written.
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(await fileExists(marker)).toBe(false)
  })
})

// ===========================================================================
// filesystem sandbox
// ===========================================================================

describe('filesystem sandbox', () => {
  it('rejects relative paths in file_read', async () => {
    const result = await fileReadTool.execute(
      { path: 'relative.txt' },
      defaultContext,
    )

    expect(result.isError).toBe(true)
    expect(result.data).toContain('must be absolute')
  })

  it('rejects file_write outside the sandbox root', async () => {
    const result = await fileWriteTool.execute(
      { path: join(tmpdir(), 'oma-outside-write.txt'), content: 'outside' },
      defaultContext,
    )

    expect(result.isError).toBe(true)
    expect(result.data).toContain("outside the agent's working directory")
  })

  it('rejects file_edit outside the sandbox root', async () => {
    const result = await fileEditTool.execute(
      {
        path: join(tmpdir(), 'oma-outside-edit.txt'),
        old_string: 'x',
        new_string: 'y',
      },
      defaultContext,
    )

    expect(result.isError).toBe(true)
    expect(result.data).toContain("outside the agent's working directory")
  })

  it('opts out when cwd is null (relative paths and arbitrary roots accepted)', async () => {
    const optOut: ToolUseContext = {
      agent: { name: 'test-agent', role: 'tester', model: 'test' },
      cwd: null,
    }

    // Relative path no longer rejected up front.
    const relResult = await fileReadTool.execute(
      { path: 'still-relative.txt' },
      optOut,
    )
    expect(relResult.data).not.toContain('must be absolute')

    // Absolute path outside any sandbox root is accepted (still fails because
    // the file does not exist, but with a fs error rather than a sandbox error).
    const absResult = await fileReadTool.execute(
      { path: join(tmpdir(), 'oma-opt-out-missing.txt') },
      optOut,
    )
    expect(absResult.data).not.toContain("outside the agent's working directory")
  })

  it('defaultWorkspaceDir resolves to <cwd>/.agent-workspace', () => {
    expect(DEFAULT_WORKSPACE_DIRNAME).toBe('.agent-workspace')
    expect(defaultWorkspaceDir()).toBe(join(process.cwd(), '.agent-workspace'))
  })

  it('auto-creates the sandbox root on first write when missing', async () => {
    // Point cwd at a path that does not yet exist. file_write should still
    // succeed because the sandbox layer mkdir -p's the root on first use.
    const freshRoot = join(tmpDir, 'fresh-workspace')
    const ctx: ToolUseContext = {
      agent: { name: 'test-agent', role: 'tester', model: 'test' },
      cwd: freshRoot,
    }

    expect(await fileExists(freshRoot)).toBe(false)

    const result = await fileWriteTool.execute(
      { path: join(freshRoot, 'hello.txt'), content: 'hi' },
      ctx,
    )

    expect(result.isError).toBe(false)
    expect(await fileExists(freshRoot)).toBe(true)
    expect(await readFile(join(freshRoot, 'hello.txt'), 'utf8')).toBe('hi')
  })

  it('default workspace root prevents reading parent-directory files (L2-b core benefit)', async () => {
    // Simulate the real default-cwd scenario: the agent's sandbox root is
    // a `.agent-workspace` subdirectory inside an enclosing project root.
    // Files in the enclosing root (e.g. .env, source files) must not be
    // reachable just because the host happened to launch from there.
    const projectRoot = await mkdtemp(join(tmpdir(), 'oma-project-'))
    try {
      await writeFile(join(projectRoot, '.env'), 'SECRET=do-not-leak')

      const workspaceRoot = join(projectRoot, DEFAULT_WORKSPACE_DIRNAME)
      const ctx: ToolUseContext = {
        agent: { name: 'test-agent', role: 'tester', model: 'test' },
        cwd: workspaceRoot,
      }

      const result = await fileReadTool.execute(
        { path: join(projectRoot, '.env') },
        ctx,
      )

      expect(result.isError).toBe(true)
      expect(result.data).toContain("outside the agent's working directory")
      expect(result.data).not.toContain('SECRET=do-not-leak')
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
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
    await mkdir(sub, { recursive: true })
    await writeFile(join(sub, 'deep.ts'), '')

    const result = await globTool.execute(
      { path: tmpDir, pattern: '*.ts' },
      defaultContext,
    )

    expect(result.isError).toBe(false)
    expect(result.data).toContain('deep.ts')
  })

  it('does not follow symlinked directories outside the sandbox root', async () => {
    const root = join(tmpDir, 'root')
    const outside = join(tmpDir, 'outside')
    await mkdir(root, { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(root, 'safe.ts'), 'safe')
    await writeFile(join(outside, 'secret.ts'), 'secret')
    await symlink(outside, join(root, 'linked-outside'))

    const result = await globTool.execute(
      { path: root, pattern: '*.ts' },
      {
        ...defaultContext,
        cwd: root,
      },
    )

    expect(result.isError).toBe(false)
    expect(result.data).toContain('safe.ts')
    expect(result.data).not.toContain('secret.ts')
    expect(result.data).not.toContain('linked-outside')
  })

  it('does not follow symlinks to files outside the sandbox root', async () => {
    const root = join(tmpDir, 'root')
    const outside = join(tmpDir, 'outside')
    await mkdir(root, { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(root, 'safe.ts'), 'safe')
    await writeFile(join(outside, 'secret.ts'), 'secret')
    await symlink(join(outside, 'secret.ts'), join(root, 'linked-secret.ts'))

    const result = await globTool.execute(
      { path: root, pattern: '*.ts' },
      {
        ...defaultContext,
        cwd: root,
      },
    )

    expect(result.isError).toBe(false)
    expect(result.data).toContain('safe.ts')
    expect(result.data).not.toContain('linked-secret.ts')
  })

  it('errors on inaccessible path', async () => {
    const result = await globTool.execute(
      { path: join(tmpDir, 'missing') },
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

  // Both branches must reject the symlink — ripgrep defaults to --no-follow,
  // and the Node.js fallback skips symlinks via lstat() in fs-walk.
  it('does not follow symlinked directories outside the sandbox root', async () => {
    const root = join(tmpDir, 'root')
    const outside = join(tmpDir, 'outside')
    await mkdir(root, { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(root, 'safe.ts'), 'needle inside\n')
    await writeFile(join(outside, 'secret.ts'), 'needle outside\n')
    await symlink(outside, join(root, 'linked-outside'))

    const result = await grepTool.execute(
      { pattern: 'needle', path: root },
      {
        ...defaultContext,
        cwd: root,
      },
    )

    expect(result.isError).toBe(false)
    expect(result.data).toContain('needle inside')
    expect(result.data).not.toContain('needle outside')
    expect(result.data).not.toContain('secret.ts')
    expect(result.data).not.toContain('linked-outside')
  })

  it('does not follow symlinks to files outside the sandbox root', async () => {
    const root = join(tmpDir, 'root')
    const outside = join(tmpDir, 'outside')
    await mkdir(root, { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(root, 'safe.ts'), 'needle inside\n')
    await writeFile(join(outside, 'secret.ts'), 'needle outside\n')
    await symlink(join(outside, 'secret.ts'), join(root, 'linked-secret.ts'))

    const result = await grepTool.execute(
      { pattern: 'needle', path: root },
      {
        ...defaultContext,
        cwd: root,
      },
    )

    expect(result.isError).toBe(false)
    expect(result.data).toContain('needle inside')
    expect(result.data).not.toContain('needle outside')
    expect(result.data).not.toContain('linked-secret.ts')
  })

  it('errors on inaccessible path', async () => {
    const result = await grepTool.execute(
      { pattern: 'test', path: join(tmpDir, 'missing') },
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
