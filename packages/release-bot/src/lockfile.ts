import { readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'

/** A lockfile entry that installs a workspace package instead of linking it. */
export interface UnlinkedWorkspaceEntry {
  /** The lockfile `packages` key, which also names the dependent that pulled it in. */
  readonly path: string
  readonly name: string
  readonly version: string | null
  readonly resolved: string | null
  /** Where the workspace itself lives in the checkout. */
  readonly workspacePath: string
  readonly workspaceVersion: string | null
}

interface LockfileEntry {
  readonly name?: unknown
  readonly version?: unknown
  readonly resolved?: unknown
  readonly link?: unknown
}

const NODE_MODULES_SEGMENT = 'node_modules/'

/**
 * Find every lockfile entry that installs a workspace package from somewhere
 * other than its workspace.
 *
 * npm links each workspace into the root `node_modules`, so a workspace that
 * depends on a sibling resolves it from the checkout. When the sibling's version
 * leaves the dependent's declared range, npm does not fail: it nests a published
 * copy under the dependent instead. That copy then survives every later
 * `npm install` for as long as it still satisfies the range, even after the
 * workspace version moves back inside it. Release PR #637 planned core 2.0.0,
 * outside otel's `^1.11.0`, and got core 1.21.3 from the registry under
 * `packages/otel/node_modules`. Moving the plan back to 1.22.0 in #638 and
 * rerunning the lockfile step kept that copy, so otel's tests ran against
 * published 1.21.3 and `npm audit --omit=dev` reported that copy's zod 3.
 *
 * Workspaces are the entries whose key has no `node_modules/` segment. npm
 * records `name` on such an entry only when it differs from the folder name.
 */
export function findUnlinkedWorkspaceEntries(lockfile: unknown): readonly UnlinkedWorkspaceEntry[] {
  const packages = readPackages(lockfile)

  const workspaces = new Map<string, { readonly path: string; readonly version: string | null }>()
  for (const [path, entry] of Object.entries(packages)) {
    if (path === '' || path.includes(NODE_MODULES_SEGMENT)) continue
    const name = typeof entry.name === 'string' ? entry.name : posix.basename(path)
    workspaces.set(name, { path, version: stringOrNull(entry.version) })
  }

  const unlinked: UnlinkedWorkspaceEntry[] = []
  for (const [path, entry] of Object.entries(packages)) {
    const index = path.lastIndexOf(NODE_MODULES_SEGMENT)
    if (index === -1) continue
    const name = path.slice(index + NODE_MODULES_SEGMENT.length)
    const workspace = workspaces.get(name)
    if (!workspace) continue
    if (entry.link === true && entry.resolved === workspace.path) continue
    unlinked.push({
      path,
      name,
      version: stringOrNull(entry.version),
      resolved: stringOrNull(entry.resolved),
      workspacePath: workspace.path,
      workspaceVersion: workspace.version,
    })
  }
  return unlinked
}

export function assertWorkspacesLinked(lockfile: unknown): void {
  const unlinked = findUnlinkedWorkspaceEntries(lockfile)
  if (unlinked.length === 0) return
  const details = unlinked.map(entry =>
    `${entry.path}@${entry.version ?? 'unknown'} from ${entry.resolved ?? 'an unknown source'}`
    + ` (workspace ${entry.workspacePath} is ${entry.workspaceVersion ?? 'unversioned'})`,
  )
  throw new Error(
    `package-lock.json installs workspace packages instead of linking them: ${details.join('; ')}. `
    + 'The dependent\'s declared range does not accept the workspace version, or the lockfile '
    + 'kept a copy from an earlier resolution. Widen the range in a source change, or regenerate the '
    + 'lockfile from one that links the workspace.',
  )
}

export async function assertRepositoryWorkspacesLinked(repoRoot: string): Promise<void> {
  const lockfile = JSON.parse(await readFile(join(repoRoot, 'package-lock.json'), 'utf8')) as unknown
  assertWorkspacesLinked(lockfile)
}

function readPackages(lockfile: unknown): Readonly<Record<string, LockfileEntry>> {
  const packages = typeof lockfile === 'object' && lockfile !== null
    ? (lockfile as { packages?: unknown }).packages
    : undefined
  if (typeof packages !== 'object' || packages === null || Array.isArray(packages)) {
    throw new Error('package-lock.json has no "packages" map; workspace links cannot be verified.')
  }
  return packages as Record<string, LockfileEntry>
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}
