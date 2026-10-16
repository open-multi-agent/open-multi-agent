import { mkdir, readlink, realpath, stat } from 'fs/promises'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'path'
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

  const root = resolve(context.cwd ?? defaultWorkspaceDir())
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
  let realCandidate: string
  try {
    realCandidate = await realpathTolerant(candidate, { hops: 0 })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return { ok: false, error: `Could not resolve path "${candidate}": ${message}` }
  }

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

/**
 * Bound on symlinks followed by hand, matching Linux MAXSYMLINKS. Chains that
 * realpath walks itself are bounded by the kernel, which reports ELOOP.
 */
const MAX_SYMLINK_HOPS = 40
const TOO_MANY_SYMLINKS = 'Too many levels of symbolic links'

async function realpathTolerant(path: string, state: { hops: number }): Promise<string> {
  try {
    const real = await realpath(path)
    // Native realpath accepts a symlink whose target ends in a separator even
    // when that target is a file, which the kernel refuses to open. stat takes
    // the same lookup as open, so a failure here sends the path through the
    // manual resolution below.
    await stat(path)
    return real
  } catch (err) {
    // The kernel already refused this chain as too long or cyclic. Following
    // it by hand would accept a path that no fs call could open as given.
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error(TOO_MANY_SYMLINKS)
    }
    const parent = dirname(path)
    if (parent === path) return path
    const realParent = await realpathTolerant(parent, state)
    const joined = join(realParent, basename(path))

    // realpath also fails on a dangling symlink, which exists even though its
    // target does not. Writing to it creates the target, so follow the link
    // and resolve the target instead of treating the link as a new file.
    let target: string
    try {
      target = await readlink(joined)
    } catch {
      return joined
    }
    if (++state.hops > MAX_SYMLINK_HOPS) {
      throw new Error(TOO_MANY_SYMLINKS)
    }
    return resolveLinkTarget(realParent, target, state)
  }
}

const TARGET_SEPARATOR = sep === '\\' ? /[\\/]/ : /\//

/**
 * Resolve a symlink target the way the kernel does: one component at a time,
 * starting from the directory holding the link when the target is relative.
 * `path.resolve` would collapse `a/..` lexically, but when `a` is itself a
 * symlink the kernel steps out of the directory `a` points to instead.
 */
async function resolveLinkTarget(
  linkDir: string,
  target: string,
  state: { hops: number },
): Promise<string> {
  const targetRoot = parse(target).root
  const parts = target.slice(targetRoot.length).split(TARGET_SEPARATOR)
  let current = targetRoot === '' ? linkDir : targetRoot
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      // `current` is symlink-free, so its lexical parent is its real parent,
      // provided it exists. The kernel cannot step out of a missing directory.
      await requireDirectory(current, target)
      current = dirname(current)
      continue
    }
    current = await realpathTolerant(join(current, part), state)
  }
  // A trailing separator or `.` names a directory, so the kernel refuses to
  // open a file, or create one, through the link.
  const last = parts[parts.length - 1]
  if (last === '' || last === '.') {
    await requireDirectory(current, target)
  }
  return current
}

async function requireDirectory(path: string, target: string): Promise<void> {
  let isDirectory = false
  try {
    isDirectory = (await stat(path)).isDirectory()
  } catch {
    // Missing: rejected below.
  }
  if (!isDirectory) {
    throw new Error(`Symlink target "${target}" requires "${path}" to be an existing directory`)
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
