/**
 * Shared recursive directory walk for built-in file tools.
 *
 * Used by {@link grepTool} and {@link globTool} so glob filtering and skip
 * rules stay consistent.
 */

import { lstat, readdir } from 'fs/promises'
import { join } from 'path'

/** Directories that are almost never useful to traverse for code search. */
export const SKIP_DIRS = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '.next',
  'dist',
  'build',
])

export interface CollectFilesOptions {
  /** When set, stop collecting once this many paths are gathered. */
  readonly maxFiles?: number
}

/**
 * Recursively walk `dir` and return file paths, honouring {@link SKIP_DIRS}
 * and an optional filename glob pattern.
 */
export async function collectFiles(
  dir: string,
  glob: string | undefined,
  signal: AbortSignal | undefined,
  options?: CollectFilesOptions,
): Promise<string[]> {
  const results: string[] = []
  await walk(dir, glob, results, signal, options?.maxFiles)
  return results
}

async function walk(
  dir: string,
  glob: string | undefined,
  results: string[],
  signal: AbortSignal | undefined,
  maxFiles: number | undefined,
): Promise<void> {
  if (signal?.aborted === true) return
  if (maxFiles !== undefined && results.length >= maxFiles) return

  let entryNames: string[]
  try {
    entryNames = await readdir(dir, { encoding: 'utf8' })
  } catch {
    return
  }

  for (const entryName of entryNames) {
    if (signal !== undefined && signal.aborted) return
    if (maxFiles !== undefined && results.length >= maxFiles) return

    const fullPath = join(dir, entryName)

    let entryInfo: Awaited<ReturnType<typeof lstat>>
    try {
      entryInfo = await lstat(fullPath)
    } catch {
      continue
    }

    if (entryInfo.isSymbolicLink()) {
      continue
    } else if (entryInfo.isDirectory()) {
      if (!SKIP_DIRS.has(entryName)) {
        await walk(fullPath, glob, results, signal, maxFiles)
      }
    } else if (entryInfo.isFile()) {
      if (glob === undefined || matchesGlob(entryName, glob)) {
        results.push(fullPath)
      }
    }
  }
}
/** 
 * Minimal glob match supporting `*.ext` and `**<pattern>` forms.
 * 
*/


export function matchesGlob(filename: string, glob: string): boolean {
  const pattern = glob.startsWith('**/') ? glob.slice(3) : glob
  const regexSource = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  const re = new RegExp(`^${regexSource}$`, 'i')
  return re.test(filename)
}
