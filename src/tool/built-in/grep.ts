/**
 * Built-in grep tool.
 *
 * Searches for a regex pattern in files.  Prefers the `rg` (ripgrep) binary
 * when available for performance; falls back to a pure Node.js recursive
 * implementation using the standard `fs` module so the tool works in
 * environments without ripgrep installed.
 */

import { spawn } from 'child_process'
import { readFile, stat } from 'fs/promises'
import { relative } from 'path'
import { z } from 'zod'
import type { ToolResult } from '../../types.js'
import { defineTool } from '../framework.js'
import { collectFiles } from './fs-walk.js'
import { defaultWorkspaceDir, resolvePathWithinCwd } from './path-safety.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_RESULTS = 100

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const grepTool = defineTool({
  name: 'grep',
  description:
    'Search for a regular-expression pattern in one or more files. ' +
    'Returns matching lines with their file paths and 1-based line numbers. ' +
    'Use the `glob` parameter to restrict the search to specific file types ' +
    '(e.g. "*.ts"). ' +
    'To list matching file paths without reading contents, use the `glob` tool. ' +
    'Results are capped by `maxResults` to keep the response manageable.',

  inputSchema: z.object({
    pattern: z
      .string()
      .describe('Regular expression pattern to search for in file contents.'),
    path: z
      .string()
      .optional()
      .describe(
        'Absolute directory or file path to search in. ' +
          'Defaults to the tool working directory.',
      ),
    glob: z
      .string()
      .optional()
      .describe(
        'Glob pattern to filter which files are searched ' +
          '(e.g. "*.ts", "**/*.json"). ' +
          'Only used when `path` is a directory.',
      ),
    maxResults: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        `Maximum number of matching lines to return. ` +
          `Defaults to ${DEFAULT_MAX_RESULTS}.`,
      ),
  }),

  execute: async (input, context) => {
    const requestedPath = input.path ?? context.cwd ?? defaultWorkspaceDir()
    const safePath = await resolvePathWithinCwd(requestedPath, context)
    if (!safePath.ok) {
      return { data: safePath.error, isError: true }
    }

    const searchPath = safePath.path
    const maxResults = input.maxResults ?? DEFAULT_MAX_RESULTS

    // Compile the regex once and surface bad patterns immediately.
    let regex: RegExp
    try {
      regex = new RegExp(input.pattern)
    } catch {
      return {
        data: `Invalid regular expression: "${input.pattern}"`,
        isError: true,
      }
    }

    // Attempt ripgrep first.
    const rgAvailable = await isRipgrepAvailable()
    if (rgAvailable) {
      return runRipgrep(input.pattern, searchPath, {
        glob: input.glob,
        maxResults,
        root: safePath.root,
        signal: context.abortSignal,
      })
    }

    // Fallback: pure Node.js recursive search.
    return runNodeSearch(regex, searchPath, {
      glob: input.glob,
      maxResults,
      root: safePath.root,
      signal: context.abortSignal,
    })
  },
})

// ---------------------------------------------------------------------------
// ripgrep path
// ---------------------------------------------------------------------------

interface SearchOptions {
  glob?: string
  maxResults: number
  root: string
  signal: AbortSignal | undefined
}

async function runRipgrep(
  pattern: string,
  searchPath: string,
  options: SearchOptions,
): Promise<ToolResult> {
  const args = [
    '--line-number',
    '--no-heading',
    '--color=never',
    `--max-count=${options.maxResults}`,
  ]
  if (options.glob !== undefined) {
    args.push('--glob', options.glob)
  }
  const targetPath = relative(options.root, searchPath) || '.'
  args.push('--', pattern, targetPath)

  return new Promise<ToolResult>((resolve) => {
    const chunks: Buffer[] = []
    const errChunks: Buffer[] = []

    const child = spawn('rg', args, { cwd: options.root, stdio: ['ignore', 'pipe', 'pipe'] })

    child.stdout.on('data', (d: Buffer) => chunks.push(d))
    child.stderr.on('data', (d: Buffer) => errChunks.push(d))

    const onAbort = (): void => { child.kill('SIGKILL') }
    if (options.signal !== undefined) {
      options.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.on('close', (code: number | null) => {
      if (options.signal !== undefined) {
        options.signal.removeEventListener('abort', onAbort)
      }
      const output = Buffer.concat(chunks).toString('utf8').trimEnd()

      // rg exit code 1 = no matches (not an error)
      if (code !== 0 && code !== 1) {
        const errMsg = Buffer.concat(errChunks).toString('utf8').trim()
        resolve({
          data: `ripgrep failed (exit ${code}): ${errMsg}`,
          isError: true,
        })
        return
      }

      if (output.length === 0) {
        resolve({ data: 'No matches found.', isError: false })
        return
      }

      const lines = output.split('\n')
      resolve({
        data: lines.join('\n'),
        isError: false,
      })
    })

    child.on('error', () => {
      if (options.signal !== undefined) {
        options.signal.removeEventListener('abort', onAbort)
      }
      // Caller will see an error result — the tool won't retry with Node search
      // since this branch is only reachable after we confirmed rg is available.
      resolve({
        data: 'ripgrep process error — run may be retried with the Node.js fallback.',
        isError: true,
      })
    })
  })
}

// ---------------------------------------------------------------------------
// Node.js fallback search
// ---------------------------------------------------------------------------

interface MatchLine {
  file: string
  lineNumber: number
  text: string
}

async function runNodeSearch(
  regex: RegExp,
  searchPath: string,
  options: SearchOptions,
): Promise<ToolResult> {
  // Collect files
  let files: string[]
  try {
    const info = await stat(searchPath)
    if (info.isFile()) {
      files = [searchPath]
    } else {
      files = await collectFiles(searchPath, options.glob, options.signal)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return {
      data: `Cannot access path "${searchPath}": ${message}`,
      isError: true,
    }
  }

  const matches: MatchLine[] = []

  for (const file of files) {
    if (options.signal?.aborted === true) break
    if (matches.length >= options.maxResults) break

    let fileContent: string
    try {
      fileContent = (await readFile(file)).toString('utf8')
    } catch {
      // Skip unreadable files (binary, permission denied, etc.)
      continue
    }

    const lines = fileContent.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= options.maxResults) break
      // Reset lastIndex for global regexes
      regex.lastIndex = 0
      if (regex.test(lines[i])) {
        matches.push({
          file: relative(options.root, file) || file,
          lineNumber: i + 1,
          text: lines[i],
        })
      }
    }
  }

  if (matches.length === 0) {
    return { data: 'No matches found.', isError: false }
  }

  const formatted = matches
    .map((m) => `${m.file}:${m.lineNumber}:${m.text}`)
    .join('\n')

  const truncationNote =
    matches.length >= options.maxResults
      ? `\n\n(results capped at ${options.maxResults}; use maxResults to raise the limit)`
      : ''

  return {
    data: formatted + truncationNote,
    isError: false,
  }
}

// ---------------------------------------------------------------------------
// ripgrep availability check (cached per process)
// ---------------------------------------------------------------------------

let rgAvailableCache: boolean | undefined

async function isRipgrepAvailable(): Promise<boolean> {
  if (rgAvailableCache !== undefined) return rgAvailableCache

  rgAvailableCache = await new Promise<boolean>((resolve) => {
    const child = spawn('rg', ['--version'], { stdio: 'ignore' })
    child.on('close', (code) => resolve(code === 0))
    child.on('error', () => resolve(false))
  })

  return rgAvailableCache
}
