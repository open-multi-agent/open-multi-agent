import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ToolUseContext } from '../src/types.js'

// Fake `rg`: `--version` succeeds, a search prints two matching lines per
// file for five files, as `--max-count` (a per-file cap) really does.
const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('child_process', () => ({ spawn: spawnMock }))

function fakeRg(args: string[]): EventEmitter {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  setImmediate(() => {
    if (!args.includes('--version')) {
      const lines: string[] = []
      for (let f = 1; f <= 5; f++) {
        for (let n = 1; n <= 2; n++) lines.push(`f${f}.txt:${n}:hit`)
      }
      child.stdout.emit('data', Buffer.from(lines.join('\n') + '\n'))
    }
    child.emit('close', 0)
  })
  return child
}

const { grepTool } = await import('../src/tool/built-in/grep.js')

let tmpDir: string
let context: ToolUseContext

beforeEach(async () => {
  spawnMock.mockImplementation((_cmd: string, args: string[]) => fakeRg(args))
  tmpDir = await mkdtemp(join(tmpdir(), 'oma-grep-rg-'))
  context = { agent: { name: 'test-agent', role: 'tester', model: 'test' }, cwd: tmpDir }
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('grep (ripgrep path)', () => {
  it('caps the total number of matching lines at maxResults', async () => {
    const result = await grepTool.execute({ pattern: 'hit', path: tmpDir, maxResults: 3 }, context)

    expect(result.isError).toBe(false)
    const matchLines = result.data.split('\n').filter((line) => line.endsWith(':hit'))
    expect(matchLines).toEqual(['f1.txt:1:hit', 'f1.txt:2:hit', 'f2.txt:1:hit'])
    expect(result.data).toContain('results capped at 3')
  })

  it('leaves output below the cap unchanged', async () => {
    const result = await grepTool.execute({ pattern: 'hit', path: tmpDir, maxResults: 50 }, context)

    expect(result.data.split('\n')).toHaveLength(10)
    expect(result.data).not.toContain('results capped')
  })
})
