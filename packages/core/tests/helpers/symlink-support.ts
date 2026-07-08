import { mkdtemp, rm, symlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * Whether this environment can create symlinks. On Windows, symlink creation
 * requires Developer Mode or an elevated process, so symlink-behaviour tests
 * must skip instead of erroring with EPERM.
 */
export async function detectSymlinkSupport(): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), 'oma-symlink-probe-'))
  try {
    await writeFile(join(dir, 'target.txt'), '')
    await symlink(join(dir, 'target.txt'), join(dir, 'link.txt'))
    return true
  } catch {
    return false
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
