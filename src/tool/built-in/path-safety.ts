import { realpath } from 'fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'path'
import type { ToolUseContext } from '../../types.js'

export type SafePathResult =
  | { ok: true; path: string; root: string }
  | { ok: false; error: string }

export async function resolvePathWithinCwd(
  inputPath: string,
  context: ToolUseContext,
): Promise<SafePathResult> {
  // Sandbox explicitly disabled. Return the input path verbatim so the
  // tool behaves as if no sandbox were in place.
  if (context.cwd === null) {
    return { ok: true, path: inputPath, root: '/' }
  }

  if (!isAbsolute(inputPath)) {
    return {
      ok: false,
      error: `Path "${inputPath}" must be absolute.`,
    }
  }

  const root = resolve(context.cwd ?? process.cwd())
  let realRoot: string
  try {
    realRoot = await realpath(root)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return {
      ok: false,
      error: `Could not resolve working directory "${root}": ${message}`,
    }
  }

  const candidate = resolve(inputPath)
  if (!isWithin(candidate, root)) {
    return outsideRoot(candidate, realRoot)
  }

  let realCandidate: string | undefined
  try {
    realCandidate = await realpath(candidate)
  } catch {
    realCandidate = await realExistingAncestor(candidate)
  }

  if (!isWithin(realCandidate, realRoot)) {
    return outsideRoot(candidate, realRoot)
  }

  return { ok: true, path: candidate, root: realRoot }
}

function isWithin(candidate: string, root: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

async function realExistingAncestor(path: string): Promise<string> {
  let current = dirname(path)
  while (true) {
    try {
      return await realpath(current)
    } catch {
      const parent = dirname(current)
      if (parent === current) {
        return current
      }
      current = parent
    }
  }
}

function outsideRoot(candidate: string, root: string): SafePathResult {
  return {
    ok: false,
    error: `Path "${candidate}" is outside allowed root "${root}".`,
  }
}
