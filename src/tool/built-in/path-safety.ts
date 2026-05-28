import { mkdir, realpath } from 'fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
import type { ToolUseContext } from '../../types.js'

/**
 * Subdirectory name used as the default sandbox root, relative to
 * `process.cwd()`. Narrower than `process.cwd()` so a freshly configured
 * agent cannot, by default, read or write the user's project source,
 * `.env`, or `.git/` simply because the host happened to launch from the
 * repo root.
 *
 * Override per-orchestrator with `OrchestratorConfig.defaultCwd`, or
 * per-agent with `AgentConfig.cwd`. Pass `null` to disable the sandbox.
 */
export const DEFAULT_WORKSPACE_DIRNAME = '.agent-workspace'

/**
 * Resolve the default sandbox root: `<process.cwd()>/.agent-workspace`.
 * Callers that want the legacy "entire current working directory"
 * behaviour can pass `process.cwd()` explicitly to `defaultCwd` / `cwd`.
 */
export function defaultWorkspaceDir(): string {
  return resolve(process.cwd(), DEFAULT_WORKSPACE_DIRNAME)
}

export type SafePathResult =
  | { ok: true; path: string; root: string }
  | { ok: false; error: string }

export async function resolvePathWithinCwd(
  inputPath: string,
  context: ToolUseContext,
  options: { ensureRoot?: boolean } = {},
): Promise<SafePathResult> {
  // Sandbox explicitly disabled. Return the input path verbatim so the
  // tool behaves as if no sandbox were in place.
  if (context.cwd === null) {
    return { ok: true, path: inputPath, root: '/' }
  }

  if (!isAbsolute(inputPath)) {
    return {
      ok: false,
      error:
        `Path "${inputPath}" must be absolute. ` +
        'Built-in filesystem tools require absolute paths.',
    }
  }

  const root = resolve(context.cwd ?? process.cwd())
  let realRoot: string
  try {
    realRoot = await realpath(root)
  } catch (err) {
    if (!options.ensureRoot) {
      // Read-only callers (file_read, file_edit, grep, glob) treat a
      // missing sandbox root as an error rather than silently creating
      // it. Only file_write opts in via `ensureRoot: true` so that the
      // very first write to a fresh workspace works without manual
      // mkdir.
      const message = err instanceof Error ? err.message : 'Unknown error'
      return {
        ok: false,
        error: `Could not resolve working directory "${root}": ${message}`,
      }
    }
    try {
      await mkdir(root, { recursive: true })
      realRoot = await realpath(root)
    } catch (mkdirErr) {
      const message = mkdirErr instanceof Error ? mkdirErr.message : 'Unknown error'
      return {
        ok: false,
        error: `Could not create or resolve working directory "${root}": ${message}`,
      }
    }
  }

  const candidate = resolve(inputPath)
  if (!isWithin(candidate, root)) {
    return outsideRoot(candidate, realRoot)
  }

  // Resolve symlinks all the way through the candidate. For paths that do
  // not yet exist (e.g. `file_write` creating a new file), resolve the
  // longest existing prefix and re-attach the non-existent suffix.
  const realCandidate = await realpathTolerant(candidate)

  if (!isWithin(realCandidate, realRoot)) {
    return outsideRoot(candidate, realRoot)
  }

  // Return the symlink-resolved path so callers hand a symlink-free path to
  // fs APIs. This closes the TOCTOU window where a symlink within the
  // candidate could be swapped between this check and the actual fs call.
  return { ok: true, path: realCandidate, root: realRoot }
}

function isWithin(candidate: string, root: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

async function realpathTolerant(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    const parent = dirname(path)
    if (parent === path) return path
    const realParent = await realpathTolerant(parent)
    return join(realParent, basename(path))
  }
}

function outsideRoot(candidate: string, root: string): SafePathResult {
  return {
    ok: false,
    error:
      `Path "${candidate}" is outside the agent's working directory "${root}". ` +
      'Built-in filesystem tools are sandboxed to this directory; ' +
      'set OrchestratorConfig.defaultCwd / AgentConfig.cwd to widen it, ' +
      'or AgentConfig.cwd: null to disable the sandbox.',
  }
}
